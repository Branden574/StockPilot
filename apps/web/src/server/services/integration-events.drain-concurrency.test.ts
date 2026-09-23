/**
 * The drain cron delivers up to 100 due webhooks per tick. It used to start
 * all of them at once (Promise.allSettled over the list): 100 claim UPDATEs to
 * PostgREST in the same moment, then 100 outbound POSTs, then up to 200
 * finalize UPDATEs as they came back, from one invocation. It now keeps
 * DRAIN_DELIVERY_CONCURRENCY in flight, and stops starting new deliveries once
 * DRAIN_TIME_BUDGET_MS has passed, so a backlog for an endpoint that hangs for
 * the full 8 s timeout cannot run the cron past its 60 s maxDuration. A row it
 * does not start is not claimed, so it stays pending for the next tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { makeSupabaseStub } from '@/test/supabase-mock';

import {
  DRAIN_DELIVERY_CONCURRENCY,
  DRAIN_TIME_BUDGET_MS,
  drainIntegrationDeliveries,
} from './integration-events';

const DUE = Array.from({ length: 100 }, (_, i) => ({
  id: `d${i}`,
  endpoint_id: 'e1',
  event_type: 'order.approved',
  payload: {},
  attempts: 0,
  max_attempts: 6,
}));
const ENDPOINT = {
  id: 'e1',
  organization_id: 'o1',
  type: 'slack',
  url: 'https://hooks.slack.com/services/x',
  secret: null,
};

function stub() {
  return makeSupabaseStub({
    'integration_deliveries.select': { data: DUE, error: null },
    'integration_endpoints.select': { data: [ENDPOINT], error: null },
    // Every claim and finalize matches its row.
    'integration_deliveries.update': { data: [{ id: 'x' }], error: null },
    'integration_endpoints.update': { data: null, error: null },
  });
}

const claims = (s: ReturnType<typeof stub>) =>
  (s.chainArgsAll.get('integration_deliveries.update') ?? []).filter(
    (args) => (args[0]?.[0] as { status?: string } | undefined)?.status === undefined,
  ).length;

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drainIntegrationDeliveries fan-out', () => {
  it(`keeps at most ${DRAIN_DELIVERY_CONCURRENCY} deliveries in flight and still delivers all 100`, async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return new Response('ok', { status: 200 });
      }),
    );
    const s = stub();

    const summary = await drainIntegrationDeliveries(s.client, new Date('2026-09-23T12:00:00Z'));

    expect(summary).toEqual({ attempted: 100, delivered: 100 });
    expect(peak).toBe(DRAIN_DELIVERY_CONCURRENCY);
    expect(claims(s)).toBe(100);
  });

  it('starts no new delivery after the time budget, and leaves those rows unclaimed', async () => {
    // A clock that jumps 10 s for every POST: the endpoint hangs to its timeout.
    let now = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        now += 10_000;
        return new Response('ok', { status: 200 });
      }),
    );
    const s = stub();

    const summary = await drainIntegrationDeliveries(
      s.client,
      new Date('2026-09-23T12:00:00Z'),
      100,
      { clock: () => now },
    );

    // The first wave started inside the budget; nothing after it.
    expect(DRAIN_DELIVERY_CONCURRENCY * 10_000).toBeGreaterThanOrEqual(DRAIN_TIME_BUDGET_MS);
    expect(summary).toEqual({
      attempted: DRAIN_DELIVERY_CONCURRENCY,
      delivered: DRAIN_DELIVERY_CONCURRENCY,
    });
    expect(claims(s)).toBe(DRAIN_DELIVERY_CONCURRENCY);
  });
});
