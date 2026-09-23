/**
 * The drain marks a due delivery 'dead' ("endpoint removed") when its endpoint
 * is not in the endpoint read. That read ignored its error, so one failed read
 * (a timeout, a pooler error) looked like every endpoint had been deleted and
 * permanently killed up to 100 deliveries for live endpoints, with nothing
 * logged. A failed read must leave the rows pending for the next tick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { makeSupabaseStub } from '@/test/supabase-mock';

import { drainIntegrationDeliveries } from './integration-events';

const DUE_ROWS = [
  {
    id: 'd1',
    endpoint_id: 'e1',
    event_type: 'order.approved',
    payload: {},
    attempts: 0,
    max_attempts: 6,
  },
  {
    id: 'd2',
    endpoint_id: 'e2',
    event_type: 'order.approved',
    payload: {},
    attempts: 1,
    max_attempts: 6,
  },
];

beforeEach(() => {
  reportError.mockClear();
});

describe('drainIntegrationDeliveries — endpoint read', () => {
  it('a failed endpoint read marks nothing dead, sends nothing, and is reported', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const stub = makeSupabaseStub({
      'integration_deliveries.select': { data: DUE_ROWS, error: null },
      'integration_endpoints.select': {
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      },
      'integration_deliveries.update': { data: [], error: null },
    });

    const summary = await drainIntegrationDeliveries(stub.client, new Date('2026-09-23T12:00:00Z'));

    expect(stub.chainsAll.get('integration_deliveries.update') ?? []).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary).toEqual({ attempted: 0, delivered: 0 });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'integration-events.drain' }),
    );
  });

  it('still marks a delivery dead when the read succeeds and its endpoint is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    const stub = makeSupabaseStub({
      'integration_deliveries.select': { data: [DUE_ROWS[1]], error: null },
      'integration_endpoints.select': { data: [], error: null },
      'integration_deliveries.update': { data: [], error: null },
    });

    await drainIntegrationDeliveries(stub.client, new Date('2026-09-23T12:00:00Z'));

    const updates = stub.chainArgsAll.get('integration_deliveries.update') ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]?.[0]).toEqual({ status: 'dead', error: 'endpoint removed' });
  });
});
