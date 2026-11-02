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

import { makeSupabaseStub } from '@/test/supabase-mock';

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/cron/drain-outbox: the webhook drain gets its share', () => {
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

    const res = await GET(
      new Request('https://app.example.test/api/cron/drain-outbox', {
        headers: { authorization: 'Bearer test-cron-secret' },
      }),
    );

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
