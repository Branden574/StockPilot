// @vitest-environment node
/**
 * docket B81 (integrator R3, 2026-11-02): the drain-outbox cron ran the export
 * drain first and the webhook, Slack and Teams drain last, under one run
 * deadline. An export drain that used the run's time left the deliveries
 * none: their retries waited tick after tick while the answer said
 * "attempted 0, delivered 0". The webhook drain now runs first, inside its own
 * share of the run, so it delivers whatever time the export drain then takes.
 * The real webhook drain runs here; only the network and the database answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

vi.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-cron-secret', QBO_ENV: 'sandbox' },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));
vi.mock('@/server/connectors', () => ({ CONNECTORS: {} }));

const runDrain = vi.hoisted(() => vi.fn());
vi.mock('@/server/connectors/drainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/connectors/drainer')>()),
  runDrain,
}));
vi.mock('@/server/services/platform/impersonation', () => ({
  sweepExpiredImpersonations: vi.fn(async () => undefined),
}));
vi.mock('@/server/connectors/quickbooks', () => ({ quickbooksConnector: { id: 'quickbooks' } }));
vi.mock('@/server/connectors/quickbooks/client', () => ({ QboClient: vi.fn() }));
vi.mock('@/server/connectors/quickbooks/valuation', () => ({
  maybePostMonthlyValuation: vi.fn(async () => undefined),
}));
vi.mock('@/server/connectors/secret-store', () => ({
  getConnectionSecret: vi.fn(),
  putConnectionSecret: vi.fn(),
}));

import { DRAIN_OUTBOX_DEADLINE_MS } from '@/server/connectors/drainer';

import { GET } from './route';

const START = new Date('2026-11-02T06:00:00.000Z');
const DUE = {
  id: 'd1',
  endpoint_id: 'e1',
  event_type: 'order.approved',
  payload: {},
  attempts: 1,
  max_attempts: 6,
};
const ENDPOINT = {
  id: 'e1',
  organization_id: 'org-1',
  type: 'slack',
  url: 'https://hooks.slack.com/services/x',
  secret: null,
};

function cronRequest() {
  return new Request('https://app.example.test/api/cron/drain-outbox', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/cron/drain-outbox: the webhook drain gets its share', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });

  it('when the export drain uses the whole run, the webhook drain still claims and delivers', async () => {
    const stub = makeSupabaseStub({
      'org_connections.select': { data: [], error: null },
      'integration_deliveries.select': { data: [DUE], error: null },
      'integration_endpoints.select': { data: [ENDPOINT], error: null },
      // The claim and the outcome both match their row.
      'integration_deliveries.update': { data: [{ id: 'd1' }], error: null },
      'integration_endpoints.update': { data: null, error: null },
    });
    adminHolder.client = stub.client;
    const slack = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', slack);
    // The export drain runs right up to the run's deadline.
    runDrain.mockImplementation(async () => {
      vi.setSystemTime(START.getTime() + DRAIN_OUTBOX_DEADLINE_MS);
      return { processed: 2, succeeded: 2, failed: 0, deadlettered: 0, skipped: 'deadline' };
    });

    const res = await GET(cronRequest());

    expect(res.status).toBe(200);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack.mock.calls[0]?.[0]).toBe(ENDPOINT.url);
    // The claim is the update that sets no status; it takes the second try.
    const claims = (stub.chainArgsAll.get('integration_deliveries.update') ?? [])
      .map((args) => args[0]?.[0] as { status?: string; attempts?: number } | undefined)
      .filter((patch) => patch?.status === undefined);
    expect(claims).toEqual([expect.objectContaining({ attempts: 2 })]);
    const body = (await res.json()) as { webhooks: unknown };
    expect(body.webhooks).toEqual({ attempted: 1, delivered: 1 });
  });
});

/**
 * docket B81 review (2026-11-02): the share starts deliveries for its first
 * 7 s only (WEBHOOK_DRAIN_SHARE_MS less CLAIM_LEASE_MS), and the route called
 * the drain once. Ten due deliveries to a host that hangs to the 8 s timeout,
 * at the head of the oldest-first queue, filled that window, so no other
 * organization's due alert started that tick, even with no export work at
 * all. Run last on main, the drain had 30 s of its own and delivered them.
 * The drain now takes back the time the exports and the valuation leave.
 */
describe('GET /api/cron/drain-outbox: the webhook drain takes back the time the exports leave', () => {
  /** A due delivery row as the table holds it. */
  type Row = typeof DUE & { status: string; next_attempt_at: string };
  const HANG = { ...ENDPOINT, id: 'e-hang', url: 'https://hooks.slack.com/services/hang' };
  const HEALTHY = {
    ...ENDPOINT,
    id: 'e-ok',
    organization_id: 'org-2',
    url: 'https://hooks.slack.com/services/ok',
  };

  /**
   * The integration_deliveries table answered the way PostgREST would: the
   * due read applies its own filters, order and limit, and an update writes
   * its patch to the rows its filters match and answers their ids. So a row
   * the share claimed is no longer due when the drain reads again.
   */
  function deliveriesTable(rows: Row[]) {
    const matches = (row: Row, call: MockCall) =>
      call.methods.every((method, i) => {
        const [col, value] = (call.args[i] ?? []) as [keyof Row, unknown];
        if (method === 'eq') return row[col] === value;
        if (method === 'in') return (value as unknown[]).includes(row[col]);
        return true;
      });
    return {
      'integration_deliveries.select': servedLikePostgrest(() => rows),
      'integration_deliveries.update': (call: MockCall) => {
        const patch = callArgs(call, 'update')?.[0] as Partial<Row>;
        const hit = rows.filter((row) => matches(row, call));
        for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ id: row.id })), error: null };
      },
    };
  }

  /** Ten due deliveries to the hanging host, the oldest, then ninety healthy ones. */
  function queue(): Row[] {
    const row = (i: number, endpointId: string): Row => ({
      ...DUE,
      id: `d${String(i).padStart(3, '0')}`,
      endpoint_id: endpointId,
      status: 'pending',
      next_attempt_at: new Date(START.getTime() - 60_000 + i).toISOString(),
    });
    return [
      ...Array.from({ length: 10 }, (_, i) => row(i, HANG.id)),
      ...Array.from({ length: 90 }, (_, i) => row(10 + i, HEALTHY.id)),
    ];
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /** One tick against `rows`; the hanging host answers 504 after 7.999 s, the
   *  healthy one 200 after 100 ms. Answers the cron's body and the count of
   *  deliveries the healthy host received. */
  async function tick(rows: Row[]) {
    const stub = makeSupabaseStub({
      'org_connections.select': { data: [], error: null },
      ...deliveriesTable(rows),
      'integration_endpoints.select': { data: [HANG, HEALTHY], error: null },
      'integration_endpoints.update': { data: null, error: null },
    });
    adminHolder.client = stub.client;
    let healthy = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const hangs = url === HANG.url;
        await new Promise((resolve) => setTimeout(resolve, hangs ? 7_999 : 100));
        if (!hangs) healthy += 1;
        return new Response('x', { status: hangs ? 504 : 200 });
      }),
    );
    const pending = GET(cronRequest());
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: unknown };
    const dueReads = stub.chainsAll.get('integration_deliveries.select')?.length ?? 0;
    return { body, healthy, dueReads };
  }

  it('with no export work, the deliveries behind ten that hang are delivered in the same tick', async () => {
    runDrain.mockResolvedValue({ processed: 0, succeeded: 0, failed: 0, deadlettered: 0 });
    const rows = queue();

    const { body, healthy, dueReads } = await tick(rows);

    expect(healthy).toBe(90);
    expect(body.webhooks).toEqual({ attempted: 100, delivered: 90 });
    expect(dueReads).toBe(2);
    // The ten that hung were tried once each and wait their backoff.
    expect(
      rows.filter((r) => r.endpoint_id === HANG.id).map((r) => [r.status, r.attempts]),
    ).toEqual(Array.from({ length: 10 }, () => ['pending', 2]));
    expect(warn).not.toHaveBeenCalled();
  });

  it('when the exports use the rest of the run, the drain reads nothing more and says what it left', async () => {
    runDrain.mockImplementation(async () => {
      vi.setSystemTime(START.getTime() + DRAIN_OUTBOX_DEADLINE_MS);
      return { processed: 2, succeeded: 2, failed: 0, deadlettered: 0, skipped: 'deadline' };
    });
    const rows = queue();

    const { body, healthy, dueReads } = await tick(rows);

    expect(healthy).toBe(0);
    expect(body.webhooks).toEqual({ attempted: 10, delivered: 0, skipped: 'deadline' });
    expect(dueReads).toBe(1);
    expect(rows.filter((r) => r.endpoint_id === HEALTHY.id).every((r) => r.attempts === 1)).toBe(
      true,
    );
    expect(warn.mock.calls).toEqual([
      [
        '[drain-outbox] stopped at the run deadline, the rest waits for the next tick: webhooks, exports',
      ],
    ]);
  });
});
