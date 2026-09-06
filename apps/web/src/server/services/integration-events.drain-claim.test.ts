/**
 * Regression guard for SP-067 — the integration outbox had NO claim step.
 *
 * `dispatchEvent` inserts a pending delivery row (its `next_attempt_at` column
 * default is `now()`, migration 0169) and immediately POSTs it inside the same
 * request, with an 8s timeout. The every-10-min drain cron selects rows that
 * are still `status='pending' AND next_attempt_at <= now()` and POSTs them too.
 * With no UPDATE between the SELECT and the send, an in-flight immediate
 * attempt and a cron tick both delivered the SAME row — the org's Slack/Teams
 * channel got the message twice — and the late `finalize()` then wrote its own
 * stale `attempts` back over the winner's `success`, re-queuing a third send.
 *
 * These tests pin the fix: every send is preceded by a compare-and-set claim,
 * a lost claim means we do NOT send, and a finalize whose CAS matches nothing
 * must not rewrite the endpoint's last_status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { drainIntegrationDeliveries } from './integration-events';

const DUE_ROW = {
  id: 'd1',
  endpoint_id: 'e1',
  event_type: 'order.approved',
  payload: {},
  attempts: 0,
  max_attempts: 6,
};

const ENDPOINT = {
  id: 'e1',
  organization_id: 'o1',
  type: 'slack',
  url: 'https://hooks.slack.com/services/x',
  secret: null,
};

/** Ordered log of "what the service did", so we can assert claim-before-send. */
let sequence: string[] = [];

function stubWithDeliveryUpdates(updateResults: QueryResult[]) {
  let call = 0;
  return makeSupabaseStub({
    'integration_deliveries.select': { data: [DUE_ROW], error: null },
    'integration_endpoints.select': { data: [ENDPOINT], error: null },
    'integration_deliveries.update': () => {
      const idx = call++;
      sequence.push(idx === 0 ? 'claim' : 'finalize');
      return updateResults[idx] ?? { data: null, error: null };
    },
  });
}

beforeEach(() => {
  sequence = [];
  vi.restoreAllMocks();
});

describe('drainIntegrationDeliveries — claim before send (SP-067)', () => {
  it('claims the row with a status/attempts CAS BEFORE it POSTs anything', async () => {
    const fetchMock = vi.fn(async () => {
      sequence.push('fetch');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const stub = stubWithDeliveryUpdates([
      { data: [{ id: 'd1' }], error: null }, // claim wins
      { data: [{ id: 'd1' }], error: null }, // finalize matches
    ]);

    const summary = await drainIntegrationDeliveries(stub.client, new Date('2026-09-05T12:10:00Z'));

    // The claim must be the first thing that touches the row, and it must
    // happen before the outbound POST — otherwise a second worker can send
    // the same row while this one is mid-flight.
    expect(sequence[0]).toBe('claim');
    expect(sequence.indexOf('claim')).toBeLessThan(sequence.indexOf('fetch'));

    // …and the claim is a real compare-and-set, not a blind write.
    const claimChain = stub.chainsAll.get('integration_deliveries.update')?.[0] ?? [];
    const claimArgs = stub.chainArgsAll.get('integration_deliveries.update')?.[0] ?? [];
    const filters = claimChain
      .map((m, i) => [m, claimArgs[i]] as const)
      .filter(([m]) => m === 'eq')
      .map(([, a]) => (a as unknown[])[0]);
    expect(filters).toContain('status');
    expect(filters).toContain('attempts');
    // …and it reads the row back, so a 0-row claim is detectable at all —
    // a bare `.update().eq('id', …)` is fail-OPEN on 0 rows (pattern #2).
    // (`makeSupabaseStub` does not record `maybeSingle` in the chain; the
    // "does NOT send when the claim matches no row" case below is the real
    // proof that the result is inspected.)
    expect(claimChain).toContain('select');

    expect(summary).toEqual({ attempted: 1, delivered: 1 });
  });

  it('does NOT send when the claim matches no row (another worker won it)', async () => {
    const fetchMock = vi.fn(async () => {
      sequence.push('fetch');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 0 rows updated: the immediate attempt (or a parallel cron) already
    // claimed this delivery.
    const stub = stubWithDeliveryUpdates([{ data: [], error: null }]);

    const summary = await drainIntegrationDeliveries(stub.client, new Date('2026-09-05T12:10:00Z'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary).toEqual({ attempted: 0, delivered: 0 });
  });

  it('does not rewrite the endpoint last_status when the finalize CAS matches nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        sequence.push('fetch');
        return new Response('ok', { status: 200 });
      }),
    );

    const stub = stubWithDeliveryUpdates([
      { data: [{ id: 'd1' }], error: null }, // claim wins
      { data: [], error: null }, // finalize lost: the row moved on
    ]);

    await drainIntegrationDeliveries(stub.client, new Date('2026-09-05T12:10:00Z'));

    // A stale finalize must not stamp integration_endpoints.last_status either —
    // that is the visible half of the clobber.
    expect(stub.chainsAll.get('integration_endpoints.update') ?? []).toHaveLength(0);
  });
});
