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

import { NOT_A_LIST } from '@/test/postgrest-answers';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

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

  // docket S27: an answer with no error that is not a list (postgrest-js
  // resolves an empty body with data null) read as "every endpoint was
  // removed" too, and marked every due delivery dead.
  it.each(NOT_A_LIST)(
    '%s from the endpoint read marks nothing dead, sends nothing, and is reported',
    async (_shape, answer) => {
      const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const stub = makeSupabaseStub({
        'integration_deliveries.select': { data: DUE_ROWS, error: null },
        'integration_endpoints.select': answer,
        'integration_deliveries.update': { data: [], error: null },
      });

      const summary = await drainIntegrationDeliveries(
        stub.client,
        new Date('2026-09-23T12:00:00Z'),
      );

      expect(stub.chainsAll.get('integration_deliveries.update') ?? []).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(summary).toEqual({ attempted: 0, delivered: 0 });
      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, context] = reportError.mock.calls[0] as unknown as [Error, unknown];
      expect(err.message).toBe(`integration_endpoints answered no list (status ${answer.status})`);
      expect(context).toEqual({ tag: 'integration-events.drain' });
    },
  );

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

/**
 * docket B82: a gateway answering 502 with an empty body gives postgrest-js an
 * error whose message is the empty string, and the drain reported that empty
 * text: a log line with no cause and no status. The due-deliveries read also
 * ignored its error, and read an answer that is not a list as "nothing due",
 * reporting nothing at all.
 */
describe('drainIntegrationDeliveries — the reports say what failed', () => {
  const BAD_GATEWAY = {
    data: null,
    error: { message: '', code: '' },
    status: 502,
    statusText: 'Bad Gateway',
  } as unknown as QueryResult;

  async function drainReport(results: Record<string, QueryResult>) {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const stub = makeSupabaseStub({
      'integration_deliveries.update': { data: [], error: null },
      ...results,
    });
    const summary = await drainIntegrationDeliveries(stub.client, new Date('2026-09-23T12:00:00Z'));
    expect(summary).toEqual({ attempted: 0, delivered: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('integration_deliveries.update') ?? []).toHaveLength(0);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0] as unknown as [Error, unknown];
    expect(context).toEqual({ tag: 'integration-events.drain' });
    return err.message;
  }

  it('an endpoint read answered 502 with an empty body names the status', async () => {
    const message = await drainReport({
      'integration_deliveries.select': { data: DUE_ROWS, error: null },
      'integration_endpoints.select': BAD_GATEWAY,
    });
    expect(message).toBe(
      'integration_endpoints select: HTTP 502 Bad Gateway (empty error message)',
    );
  });

  it('a due read answered 502 with an empty body is reported, naming the status', async () => {
    const message = await drainReport({ 'integration_deliveries.select': BAD_GATEWAY });
    expect(message).toBe(
      'integration_deliveries select: HTTP 502 Bad Gateway (empty error message)',
    );
  });

  it.each(NOT_A_LIST)(
    '%s from the due read is reported, never read as "nothing due"',
    async (_shape, answer) => {
      const message = await drainReport({ 'integration_deliveries.select': answer as QueryResult });
      expect(message).toBe(`integration_deliveries answered no list (status ${answer.status})`);
    },
  );

  it('a due read with no rows due reports nothing (unchanged)', async () => {
    const stub = makeSupabaseStub({ 'integration_deliveries.select': { data: [], error: null } });
    const summary = await drainIntegrationDeliveries(stub.client, new Date('2026-09-23T12:00:00Z'));
    expect(summary).toEqual({ attempted: 0, delivered: 0 });
    expect(reportError).not.toHaveBeenCalled();
  });
});
