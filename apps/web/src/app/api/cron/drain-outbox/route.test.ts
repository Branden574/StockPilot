/**
 * docket B81: the drain-outbox cron runs the connector drain, the monthly
 * valuation and the webhook drain one after another under maxDuration 60, and
 * no stage knew how much time the run had left. A run the platform ended in
 * the middle of an export left it 'pending' for a blind re-send at the next
 * tick. The route now gives every stage one deadline, DRAIN_OUTBOX_DEADLINE_MS
 * after it starts.
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
vi.mock('@/server/services/integration-events', () => ({ drainIntegrationDeliveries }));
vi.mock('@/server/services/platform/impersonation', () => ({
  sweepExpiredImpersonations: vi.fn(async () => undefined),
}));
vi.mock('@/server/connectors/quickbooks', () => ({
  quickbooksConnector: { id: 'quickbooks', refreshAuth: vi.fn() },
}));
vi.mock('@/server/connectors/quickbooks/client', () => ({ QboClient: vi.fn() }));
const maybePostMonthlyValuation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/server/connectors/quickbooks/valuation', () => ({ maybePostMonthlyValuation }));
vi.mock('@/server/connectors/secret-store', () => ({
  getConnectionSecret: vi.fn(async () => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })),
  putConnectionSecret: vi.fn(async () => 'secret-1'),
}));

import { CONNECTOR_START_RESERVE_MS, DRAIN_OUTBOX_DEADLINE_MS } from '@/server/connectors/drainer';

import { GET } from './route';

const START = new Date('2026-11-01T12:00:00.000Z');
const EMPTY_DRAIN = { processed: 0, succeeded: 0, failed: 0, deadlettered: 0 };

function cronRequest() {
  return new Request('https://app.example.test/api/cron/drain-outbox', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

/** An admin client with one active QuickBooks connection in an organization
 *  whose integrations module is on. */
function adminWithOneQuickBooksConnection() {
  const stub = makeSupabaseStub({
    'org_connections.select': {
      data: [
        {
          id: 'conn-1',
          organization_id: 'org-1',
          provider_id: 'quickbooks',
          status: 'active',
          secret_id: 'secret-1',
          external_account_id: 'realm-1',
          settings: {},
        },
      ],
      error: null,
    },
  });
  adminHolder.client = stub.client;
  enabledIntegrationOrgIds.mockResolvedValue(new Set(['org-1']));
  return stub;
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
  it('hands the connector drain and the webhook drain the same deadline, 50 s after the start', async () => {
    const stub = adminWithOneQuickBooksConnection();

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(DRAIN_OUTBOX_DEADLINE_MS).toBe(50_000);
    const deadlineAt = START.getTime() + DRAIN_OUTBOX_DEADLINE_MS;
    expect(runDrain).toHaveBeenCalledTimes(1);
    expect(runDrain).toHaveBeenCalledWith(stub.client, CONNECTORS, START, { deadlineAt });
    expect(drainIntegrationDeliveries).toHaveBeenCalledTimes(1);
    expect(drainIntegrationDeliveries).toHaveBeenCalledWith(stub.client, START, undefined, {
      deadlineAt,
    });
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
