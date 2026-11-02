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

    // The first wave started inside the budget; nothing after it, and the
    // summary says rows were left for time (docket B81, integrator R3).
    expect(DRAIN_DELIVERY_CONCURRENCY * 10_000).toBeGreaterThanOrEqual(DRAIN_TIME_BUDGET_MS);
    expect(summary).toEqual({
      attempted: DRAIN_DELIVERY_CONCURRENCY,
      delivered: DRAIN_DELIVERY_CONCURRENCY,
      skipped: 'deadline',
    });
    expect(claims(s)).toBe(DRAIN_DELIVERY_CONCURRENCY);
  });
});

/**
 * docket B81: the drain-outbox cron runs the connector drain first, then the
 * monthly valuation, then this drain, under one maxDuration of 60 s, and this
 * drain measured its budget from its own start. It now also takes the cron
 * run's deadline: it starts no delivery with less than a claim lease left
 * (the 8 s timeout plus 5 s), so a delivery it starts ends before the
 * deadline, and with less than that left at the start it reads nothing.
 */
describe('drainIntegrationDeliveries under the cron run deadline', () => {
  it('with 12 s left it reads, claims and sends nothing, and says it was skipped', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const s = stub();
    const deadlineAt = 1_000_000;

    const summary = await drainIntegrationDeliveries(
      s.client,
      new Date('2026-09-23T12:00:00Z'),
      100,
      {
        clock: () => deadlineAt - 12_000,
        deadlineAt,
      },
    );

    expect(summary).toEqual({ attempted: 0, delivered: 0, skipped: 'deadline' });
    expect(s.fromCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with 14 s left it delivers', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const s = stub();
    const deadlineAt = 1_000_000;

    const summary = await drainIntegrationDeliveries(
      s.client,
      new Date('2026-09-23T12:00:00Z'),
      100,
      {
        clock: () => deadlineAt - 14_000,
        deadlineAt,
      },
    );

    expect(summary).toEqual({ attempted: 100, delivered: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it('starts no delivery once less than a claim lease is left', async () => {
    // 20 s left at the start; each POST takes 1 s of the clock.
    const deadlineAt = 1_000_000;
    let now = deadlineAt - 20_000;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        now += 1_000;
        return new Response('ok', { status: 200 });
      }),
    );
    // The time left when each delivery is claimed. The stub answers a claim as
    // it is made, right after the drain's own check, before anything awaits.
    const leftAtClaim: number[] = [];
    const s = makeSupabaseStub({
      'integration_deliveries.select': { data: DUE, error: null },
      'integration_endpoints.select': { data: [ENDPOINT], error: null },
      'integration_deliveries.update': (call: { args: unknown[][] }) => {
        const patch = call.args[0]?.[0] as { status?: string } | undefined;
        if (patch?.status === undefined) leftAtClaim.push(deadlineAt - now);
        return { data: [{ id: 'x' }], error: null };
      },
      'integration_endpoints.update': { data: null, error: null },
    });

    const summary = await drainIntegrationDeliveries(
      s.client,
      new Date('2026-09-23T12:00:00Z'),
      100,
      {
        clock: () => now,
        deadlineAt,
      },
    );

    expect(leftAtClaim.length).toBeGreaterThan(0);
    expect(summary.attempted).toBe(leftAtClaim.length);
    expect(summary.attempted).toBeLessThan(100);
    expect(Math.min(...leftAtClaim)).toBeGreaterThanOrEqual(13_000);
    expect(summary.skipped).toBe('deadline');
  });
});
