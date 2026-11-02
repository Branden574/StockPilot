/**
 * docket B81: the drain-outbox cron runs the connector drain, the monthly
 * valuation and the webhook drain one after another under maxDuration 60, and
 * no stage knew how much time the run had left. A run the platform ended in
 * the middle of an export left it 'pending' for a blind re-send at the next
 * tick. The route now gives every stage one deadline, DRAIN_OUTBOX_DEADLINE_MS
 * after it starts; the webhook drain runs first, inside its own share of the
 * run (integrator R3), and again with the time the other stages leave when its
 * share left due deliveries (review); a stage that left work for the next tick
 * says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret', QBO_ENV: 'sandbox' },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

const CONNECTORS = vi.hoisted(() => ({ quickbooks: { id: 'quickbooks' } }));
vi.mock('@/server/connectors', () => ({ CONNECTORS }));

const { runDrain, enabledIntegrationOrgIds } = vi.hoisted(() => ({
  runDrain: vi.fn(),
  enabledIntegrationOrgIds: vi.fn(),
}));
vi.mock('@/server/connectors/drainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/connectors/drainer')>()),
  runDrain,
  enabledIntegrationOrgIds,
}));

const drainIntegrationDeliveries = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/integration-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/integration-events')>()),
  drainIntegrationDeliveries,
}));
const sweepExpiredImpersonations = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/server/services/platform/impersonation', () => ({ sweepExpiredImpersonations }));
const refreshAuth = vi.hoisted(() =>
  vi.fn(async () => ({
    accessToken: 'a2',
    refreshToken: 'r2',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })),
);
vi.mock('@/server/connectors/quickbooks', () => ({
  quickbooksConnector: { id: 'quickbooks', refreshAuth },
}));
vi.mock('@/server/connectors/quickbooks/client', () => ({ QboClient: vi.fn() }));
const maybePostMonthlyValuation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/server/connectors/quickbooks/valuation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/connectors/quickbooks/valuation')>()),
  maybePostMonthlyValuation,
}));
const getConnectionSecret = vi.hoisted(() =>
  vi.fn(async () => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })),
);
vi.mock('@/server/connectors/secret-store', () => ({
  getConnectionSecret,
  putConnectionSecret: vi.fn(async () => 'secret-1'),
}));

import { CONNECTOR_START_RESERVE_MS, DRAIN_OUTBOX_DEADLINE_MS } from '@/server/connectors/drainer';
import { WEBHOOK_DRAIN_SHARE_MS } from '@/server/services/integration-events';

import { GET } from './route';

const START = new Date('2026-11-01T12:00:00.000Z');
const EMPTY_DRAIN = { processed: 0, succeeded: 0, failed: 0, deadlettered: 0 };

function cronRequest() {
  return new Request('https://app.example.test/api/cron/drain-outbox', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

/** An admin client with an active QuickBooks connection for each `settings`
 *  given (one with none set by default), in organizations whose integrations
 *  module is on. */
function adminWithQuickBooksConnections(...settingsList: Array<Record<string, unknown>>) {
  const conns = (settingsList.length > 0 ? settingsList : [{}]).map((settings, i) => ({
    id: `conn-${i + 1}`,
    organization_id: `org-${i + 1}`,
    provider_id: 'quickbooks',
    status: 'active',
    secret_id: `secret-${i + 1}`,
    external_account_id: `realm-${i + 1}`,
    settings,
  }));
  const stub = makeSupabaseStub({ 'org_connections.select': { data: conns, error: null } });
  adminHolder.client = stub.client;
  enabledIntegrationOrgIds.mockResolvedValue(new Set(conns.map((c) => c.organization_id)));
  return stub;
}

/** An admin client with one active QuickBooks connection that has no settings. */
function adminWithOneQuickBooksConnection() {
  return adminWithQuickBooksConnections();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  runDrain.mockResolvedValue(EMPTY_DRAIN);
  drainIntegrationDeliveries.mockResolvedValue({ attempted: 0, delivered: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/cron/drain-outbox: one deadline for the whole run', () => {
  it('drains the webhooks first inside their share of the run, then the exports to the deadline 50 s after the start', async () => {
    const stub = adminWithOneQuickBooksConnection();

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(DRAIN_OUTBOX_DEADLINE_MS).toBe(50_000);
    expect(WEBHOOK_DRAIN_SHARE_MS).toBe(20_000);
    expect(drainIntegrationDeliveries).toHaveBeenCalledTimes(1);
    expect(drainIntegrationDeliveries).toHaveBeenCalledWith(stub.client, START, undefined, {
      deadlineAt: START.getTime() + WEBHOOK_DRAIN_SHARE_MS,
    });
    expect(runDrain).toHaveBeenCalledTimes(1);
    expect(runDrain).toHaveBeenCalledWith(stub.client, CONNECTORS, START, {
      deadlineAt: START.getTime() + DRAIN_OUTBOX_DEADLINE_MS,
    });
    expect(drainIntegrationDeliveries.mock.invocationCallOrder[0]).toBeLessThan(
      runDrain.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('the monthly valuation starts no connection once less than the reserve is left', async () => {
    adminWithOneQuickBooksConnection();
    // The connector drain used 26 s: 24 s are left, under the 25 s reserve.
    runDrain.mockImplementation(async () => {
      vi.setSystemTime(START.getTime() + 26_000);
      return EMPTY_DRAIN;
    });

    await GET(cronRequest());

    expect(CONNECTOR_START_RESERVE_MS).toBe(25_000);
    expect(maybePostMonthlyValuation).not.toHaveBeenCalled();
  });

  it('the monthly valuation runs when the reserve is left (unchanged)', async () => {
    adminWithOneQuickBooksConnection();
    // The connector drain used 20 s: 30 s are left.
    runDrain.mockImplementation(async () => {
      vi.setSystemTime(START.getTime() + 20_000);
      return EMPTY_DRAIN;
    });

    await GET(cronRequest());

    expect(maybePostMonthlyValuation).toHaveBeenCalledTimes(1);
  });
});

/**
 * Integrator R3: a stage the deadline cut short answered like a stage with
 * nothing to do ({ attempted: 0, delivered: 0 }), and the valuation not at
 * all, so a run that left work behind looked like an empty success.
 */
describe('GET /api/cron/drain-outbox: work left for the next tick is said', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('each stage the deadline cut short answers skipped: deadline, and one warn line names them', async () => {
    // A connection with no settings still has this month's work: it records
    // that its accounts are not set.
    const stub = adminWithOneQuickBooksConnection();
    // Its share and the time left after the other stages both end with due
    // deliveries unstarted.
    drainIntegrationDeliveries
      .mockResolvedValueOnce({ attempted: 4, delivered: 4, skipped: 'deadline' })
      .mockResolvedValueOnce({ attempted: 3, delivered: 2, skipped: 'deadline' });
    // The export drain stops at its reserve: 24 s are left for the valuation.
    runDrain.mockImplementation(async () => {
      vi.setSystemTime(START.getTime() + 26_000);
      return { processed: 3, succeeded: 3, failed: 0, deadlettered: 0, skipped: 'deadline' };
    });

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      processed: 3,
      succeeded: 3,
      failed: 0,
      deadlettered: 0,
      skipped: 'deadline',
      webhooks: { attempted: 7, delivered: 6, skipped: 'deadline' },
      valuation: { skipped: 'deadline' },
    });
    expect(drainIntegrationDeliveries).toHaveBeenNthCalledWith(2, stub.client, START, undefined, {
      deadlineAt: START.getTime() + DRAIN_OUTBOX_DEADLINE_MS,
    });
    expect(maybePostMonthlyValuation).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [
        '[drain-outbox] stopped at the run deadline, the rest waits for the next tick: webhooks, exports, valuation',
      ],
    ]);
  });

  /**
   * docket B81 review (2026-11-02): the share starts deliveries for 7 s only,
   * and the route called the drain once, so a slow host at the head of the
   * queue kept every other due alert waiting even when the exports had
   * nothing to do. Run last on main, the drain had 30 s of its own.
   */
  it('when its share left due deliveries, the webhook drain runs again after the other stages, to the run deadline, and adds its counts', async () => {
    const stub = adminWithOneQuickBooksConnection();
    drainIntegrationDeliveries
      .mockResolvedValueOnce({ attempted: 10, delivered: 0, skipped: 'deadline' })
      .mockResolvedValueOnce({ attempted: 90, delivered: 90 });

    const res = await GET(cronRequest());

    expect(await res.json()).toEqual({
      ...EMPTY_DRAIN,
      webhooks: { attempted: 100, delivered: 90 },
    });
    expect(drainIntegrationDeliveries).toHaveBeenCalledTimes(2);
    expect(drainIntegrationDeliveries).toHaveBeenNthCalledWith(2, stub.client, START, undefined, {
      deadlineAt: START.getTime() + DRAIN_OUTBOX_DEADLINE_MS,
    });
    // After the exports, the valuation and the impersonation sweep: the sweep
    // never waits on deliveries.
    const second = drainIntegrationDeliveries.mock.invocationCallOrder[1] ?? 0;
    expect(runDrain.mock.invocationCallOrder[0]).toBeLessThan(second);
    expect(maybePostMonthlyValuation.mock.invocationCallOrder[0]).toBeLessThan(second);
    expect(sweepExpiredImpersonations.mock.invocationCallOrder[0]).toBeLessThan(second);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a run with time to spare answers no skip and logs no warn line', async () => {
    adminWithOneQuickBooksConnection();

    const res = await GET(cronRequest());

    expect(await res.json()).toEqual({ ...EMPTY_DRAIN, webhooks: { attempted: 0, delivered: 0 } });
    expect(maybePostMonthlyValuation).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * docket B81 review (2026-11-02): the valuation checked the time before it
 * knew whether a connection had anything to do, so on any tick whose earlier
 * stages ran past 25 s it answered valuation: { skipped: 'deadline' } and
 * named the valuation in the warn line, though a connection that already
 * posted this month (most ticks, since it posts once a month) had nothing
 * waiting for the next tick.
 */
describe('GET /api/cron/drain-outbox: the valuation is named only when work was left', () => {
  const ACCOUNTS = { inventoryAsset: 'acct-asset', valuationOffset: 'acct-offset' };
  const POSTED_THIS_MONTH = { accountIds: ACCOUNTS, lastValuationMonth: '2026-11' };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The export drain used 26 s and finished: 24 s are left, under the reserve.
    runDrain.mockImplementation(async () => {
      vi.setSystemTime(START.getTime() + 26_000);
      return EMPTY_DRAIN;
    });
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('a late tick names no valuation when the connection already posted this month', async () => {
    adminWithQuickBooksConnections(POSTED_THIS_MONTH);

    const res = await GET(cronRequest());

    expect(await res.json()).toEqual({ ...EMPTY_DRAIN, webhooks: { attempted: 0, delivered: 0 } });
    expect(maybePostMonthlyValuation).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a late tick names no valuation for a connection without accounts whose reason is already recorded', async () => {
    adminWithQuickBooksConnections({
      lastValuationSkipReason:
        'Inventory valuation skipped: inventoryAsset/valuationOffset account not configured',
    });

    const res = await GET(cronRequest());

    expect(await res.json()).toEqual({ ...EMPTY_DRAIN, webhooks: { attempted: 0, delivered: 0 } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a late tick still names the valuation when a connection it left has this month to post (unchanged)', async () => {
    // The first connection is done for the month; the second last posted in October.
    adminWithQuickBooksConnections(POSTED_THIS_MONTH, {
      accountIds: ACCOUNTS,
      lastValuationMonth: '2026-10',
    });

    const res = await GET(cronRequest());

    expect(await res.json()).toEqual({
      ...EMPTY_DRAIN,
      webhooks: { attempted: 0, delivered: 0 },
      valuation: { skipped: 'deadline' },
    });
    expect(maybePostMonthlyValuation).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      ['[drain-outbox] stopped at the run deadline, the rest waits for the next tick: valuation'],
    ]);
  });

  it('with the reserve left, a connection that already posted this month is still visited and its token refreshed near expiry (unchanged)', async () => {
    runDrain.mockResolvedValue(EMPTY_DRAIN);
    adminWithQuickBooksConnections(POSTED_THIS_MONTH);
    // The access token expires in a minute. This pass is the only one that
    // refreshes the token of a connection with nothing to export, so what is
    // due decides only what a late tick reports, never which connection is
    // visited.
    getConnectionSecret.mockResolvedValueOnce({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(START.getTime() + 60_000).toISOString(),
    });

    await GET(cronRequest());

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(maybePostMonthlyValuation).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
