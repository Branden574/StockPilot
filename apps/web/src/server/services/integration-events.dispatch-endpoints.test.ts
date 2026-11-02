/**
 * dispatchEvent reads the organization's endpoints for an event, inserts one
 * pending delivery per endpoint, and lets the cron retry those rows. It
 * returned on `error || !endpoints || endpoints.length === 0`, so a failed
 * read and an answer that is not a list (postgrest-js resolves an empty body
 * with data null, docket S27) both read as "no endpoints": the event's
 * webhooks were never queued, the cron never saw them (it retries only rows
 * that exist), and nothing was reported. A failed delivery insert was dropped
 * the same way. Each is reported under integration-events.dispatch (S27).
 *
 * docket B82: a brief failure still lost the event. Both steps are now tried
 * three times in all, DISPATCH_RETRY_DELAYS_MS apart, on any failure: a read
 * changes nothing, and the delivery ids are chosen before the first try and
 * inserted with ON CONFLICT (id) DO NOTHING, so a repeated insert cannot queue
 * a delivery twice. Only the third failure is reported, with the organization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() =>
  vi.fn(
    async (
      _error: unknown,
      _context: { tag: string; organizationId?: string | null; extra?: Record<string, unknown> },
    ) => {},
  ),
);
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { NOT_A_LIST } from '@/test/postgrest-answers';
import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

import { DISPATCH_RETRY_DELAYS_MS, dispatchEvent } from './integration-events';

const ENDPOINT = {
  id: 'ep-1',
  organization_id: 'org-1',
  type: 'webhook',
  url: 'https://hooks.example.com/stockpilot',
  secret: null,
};

/** A gateway's 502 or 504 with an empty body, as postgrest-js resolves it. */
const emptyGatewayAnswer = (status: number, statusText: string) =>
  ({ data: null, error: { message: '', code: '' }, status, statusText }) as unknown as QueryResult;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Answers each call with the next answer; the last one repeats. */
function inTurn(...answers: QueryResult[]): () => QueryResult {
  let call = 0;
  return () => answers[Math.min(call++, answers.length - 1)]!;
}

beforeEach(() => {
  reportError.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** One dispatch of order.approved whose endpoint read answers `endpoints`.
 *  The delivery insert answers no rows by default, so no attempt is made. */
async function dispatchWith(
  endpoints: QueryResult | (() => QueryResult),
  insert: QueryResult | ((call: MockCall) => QueryResult) = { data: [], error: null },
) {
  const stub = makeSupabaseStub({
    'integration_endpoints.select': endpoints,
    'integration_deliveries.insert': insert,
  });
  adminHolder.client = stub.client;
  const done = dispatchEvent('org-1', 'order.approved', { orderId: 'order-1' });
  // Run the waits between tries.
  await vi.runAllTimersAsync();
  await done;
  const dispatchReports = reportError.mock.calls.filter(
    ([, context]) => context.tag === 'integration-events.dispatch',
  );
  return { stub, dispatchReports };
}

const EXPECTED_REPORT_CONTEXT = {
  tag: 'integration-events.dispatch',
  organizationId: 'org-1',
  extra: { eventType: 'order.approved' },
};

describe('dispatchEvent: the endpoint read', () => {
  it('queues one delivery per listed endpoint (unchanged)', async () => {
    const { stub, dispatchReports } = await dispatchWith({ data: [ENDPOINT], error: null });
    const inserted = stub.chainArgsAll.get('integration_deliveries.insert')?.[0]?.[0]?.[0];
    expect(inserted).toEqual([
      expect.objectContaining({
        organization_id: 'org-1',
        endpoint_id: 'ep-1',
        event_type: 'order.approved',
        status: 'pending',
      }),
    ]);
    expect(dispatchReports).toEqual([]);
  });

  it('with no endpoints for the event, queues nothing and reports nothing (unchanged)', async () => {
    const { stub, dispatchReports } = await dispatchWith({ data: [], error: null });
    expect(stub.chainsAll.get('integration_deliveries.insert') ?? []).toHaveLength(0);
    expect(dispatchReports).toEqual([]);
  });

  it('waits 1 s and then 3 s between tries: three tries in all', () => {
    expect(DISPATCH_RETRY_DELAYS_MS).toEqual([1_000, 3_000]);
  });

  it('a read that fails twice and then answers queues the delivery, and nothing is reported', async () => {
    const { stub, dispatchReports } = await dispatchWith(
      inTurn(emptyGatewayAnswer(502, 'Bad Gateway'), emptyGatewayAnswer(502, 'Bad Gateway'), {
        data: [ENDPOINT],
        error: null,
      }),
    );
    expect(stub.chainsAll.get('integration_endpoints.select')).toHaveLength(3);
    const upserts = stub.chainArgsAll.get('integration_deliveries.insert') ?? [];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.[0]?.[0]).toEqual([expect.objectContaining({ endpoint_id: 'ep-1' })]);
    expect(dispatchReports).toEqual([]);
  });

  it('a read that fails three times queues nothing and is reported once, with the organization', async () => {
    const { stub, dispatchReports } = await dispatchWith(emptyGatewayAnswer(502, 'Bad Gateway'));
    expect(stub.chainsAll.get('integration_endpoints.select')).toHaveLength(3);
    expect(stub.chainsAll.get('integration_deliveries.insert') ?? []).toHaveLength(0);
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      'integration_endpoints select: HTTP 502 Bad Gateway (empty error message)',
    );
    expect(dispatchReports[0]?.[1]).toEqual(EXPECTED_REPORT_CONTEXT);
  });

  it('a statement timeout is tried three times, queues nothing and is reported, never read as "no endpoints"', async () => {
    const { stub, dispatchReports } = await dispatchWith({
      data: null,
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    });
    expect(stub.chainsAll.get('integration_endpoints.select')).toHaveLength(3);
    expect(stub.chainsAll.get('integration_deliveries.insert') ?? []).toHaveLength(0);
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      'integration_endpoints select: canceling statement due to statement timeout',
    );
    expect(dispatchReports[0]?.[1]).toEqual(EXPECTED_REPORT_CONTEXT);
  });

  it.each(NOT_A_LIST)(
    '%s is tried three times, queues nothing and is reported',
    async (_shape, answer) => {
      const { stub, dispatchReports } = await dispatchWith(answer as QueryResult);
      expect(stub.chainsAll.get('integration_endpoints.select')).toHaveLength(3);
      expect(stub.chainsAll.get('integration_deliveries.insert') ?? []).toHaveLength(0);
      expect(dispatchReports).toHaveLength(1);
      expect((dispatchReports[0]?.[0] as Error).message).toBe(
        `integration_endpoints answered no list (status ${answer.status})`,
      );
      expect(dispatchReports[0]?.[1]).toEqual(EXPECTED_REPORT_CONTEXT);
    },
  );
});

describe('dispatchEvent: the delivery insert', () => {
  const DELIVERY = {
    endpoint_id: 'ep-1',
    event_type: 'order.approved',
    payload: { orderId: 'order-1' },
    attempts: 0,
    max_attempts: 6,
  };

  it('an insert that fails once is tried again with the same ids, and the delivery is attempted', async () => {
    let tries = 0;
    const { stub, dispatchReports } = await dispatchWith(
      { data: [ENDPOINT], error: null },
      (call) => {
        tries += 1;
        if (tries === 1) return emptyGatewayAnswer(504, 'Gateway Timeout');
        // The rows this try inserted, with the ids it chose, as PostgREST answers.
        const sent = call.args[0]?.[0] as Array<{ id: string }>;
        return { data: sent.map((row) => ({ ...DELIVERY, id: row.id })), error: null };
      },
    );
    const upserts = stub.chainArgsAll.get('integration_deliveries.insert') ?? [];
    expect(upserts).toHaveLength(2);
    expect(stub.chainsAll.get('integration_deliveries.insert')?.[0]?.[0]).toBe('upsert');
    const [first, second] = upserts.map(
      (args) => args[0] as [Array<{ id: string }>, Record<string, unknown>],
    );
    expect(first![1]).toEqual({ onConflict: 'id', ignoreDuplicates: true });
    expect(second![1]).toEqual({ onConflict: 'id', ignoreDuplicates: true });
    expect(first![0][0]!.id).toMatch(UUID);
    expect(second![0].map((r) => r.id)).toEqual(first![0].map((r) => r.id));
    // The immediate attempt claims the row the second try inserted.
    const claims = stub.chainArgsAll.get('integration_deliveries.update') ?? [];
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContainEqual(['id', first![0][0]!.id]);
    expect(dispatchReports).toEqual([]);
  });

  it('an insert refused three times is tried three times with the same ids, and reported with the organization', async () => {
    const { stub, dispatchReports } = await dispatchWith(
      { data: [ENDPOINT], error: null },
      {
        data: null,
        error: {
          message:
            'insert or update on table "integration_deliveries" violates foreign key constraint',
          code: '23503',
        },
      },
    );
    const upserts = stub.chainArgsAll.get('integration_deliveries.insert') ?? [];
    expect(upserts).toHaveLength(3);
    const ids = upserts.map((args) => (args[0]?.[0] as Array<{ id: string }>)[0]!.id);
    expect(new Set(ids).size).toBe(1);
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      'integration_deliveries insert: insert or update on table "integration_deliveries" violates foreign key constraint',
    );
    expect(dispatchReports[0]?.[1]).toEqual(EXPECTED_REPORT_CONTEXT);
  });

  it('a failed delivery insert is tried three times and reported, never dropped in silence', async () => {
    const { stub, dispatchReports } = await dispatchWith(
      { data: [ENDPOINT], error: null },
      { data: null, error: { message: 'canceling statement due to statement timeout' } },
    );
    expect(stub.chainsAll.get('integration_deliveries.insert')).toHaveLength(3);
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      'integration_deliveries insert: canceling statement due to statement timeout',
    );
    expect(dispatchReports[0]?.[1]).toEqual(EXPECTED_REPORT_CONTEXT);
  });

  it('an insert answered with an empty body is tried again, never read as "nothing queued"', async () => {
    // postgrest-js resolves an empty body as data null with no error (S27): the
    // rows may or may not be there, and a repeat with the same ids is safe.
    let tries = 0;
    const { stub, dispatchReports } = await dispatchWith(
      { data: [ENDPOINT], error: null },
      (call) => {
        tries += 1;
        if (tries === 1) return { data: null, error: null, status: 200 } as unknown as QueryResult;
        const sent = call.args[0]?.[0] as Array<{ id: string }>;
        return { data: sent.map((row) => ({ ...DELIVERY, id: row.id })), error: null };
      },
    );
    expect(stub.chainsAll.get('integration_deliveries.insert')).toHaveLength(2);
    // The second try inserted the row, so its immediate attempt is made.
    expect(stub.chainsAll.get('integration_deliveries.update') ?? []).toHaveLength(1);
    expect(dispatchReports).toEqual([]);
  });

  it('a row a retry found already there is left to the cron: nothing is attempted twice', async () => {
    // The first try committed but its answer was lost; the retry inserts
    // nothing (ON CONFLICT DO NOTHING returns no rows) and so attempts nothing.
    const { stub, dispatchReports } = await dispatchWith(
      { data: [ENDPOINT], error: null },
      inTurn(emptyGatewayAnswer(504, 'Gateway Timeout'), { data: [], error: null }),
    );
    expect(stub.chainsAll.get('integration_deliveries.insert')).toHaveLength(2);
    expect(stub.chainsAll.get('integration_deliveries.update') ?? []).toHaveLength(0);
    expect(dispatchReports).toEqual([]);
  });
});
