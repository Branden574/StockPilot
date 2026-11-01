/**
 * dispatchEvent reads the organization's endpoints for an event, inserts one
 * pending delivery per endpoint, and lets the cron retry those rows. It
 * returned on `error || !endpoints || endpoints.length === 0`, so a failed
 * read and an answer that is not a list (postgrest-js resolves an empty body
 * with data null, docket S27) both read as "no endpoints": the event's
 * webhooks were never queued, the cron never saw them (it retries only rows
 * that exist), and nothing was reported. A failed delivery insert was dropped
 * the same way. Each is reported now under integration-events.dispatch.
 * Whether such an event should be retried is a separate follow-up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() =>
  vi.fn(async (_error: unknown, _context: { tag: string; extra?: Record<string, unknown> }) => {}),
);
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));

import { NOT_A_LIST } from '@/test/postgrest-answers';
import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { dispatchEvent } from './integration-events';

const ENDPOINT = {
  id: 'ep-1',
  organization_id: 'org-1',
  type: 'webhook',
  url: 'https://hooks.example.com/stockpilot',
  secret: null,
};

beforeEach(() => {
  reportError.mockClear();
});

/** One dispatch of order.approved whose endpoint read answers `endpoints`.
 *  The delivery insert answers no rows by default, so no attempt is made. */
async function dispatchWith(
  endpoints: QueryResult,
  insert: QueryResult = { data: [], error: null },
) {
  const stub = makeSupabaseStub({
    'integration_endpoints.select': endpoints,
    'integration_deliveries.insert': insert,
  });
  adminHolder.client = stub.client;
  await dispatchEvent('org-1', 'order.approved', { orderId: 'order-1' });
  const dispatchReports = reportError.mock.calls.filter(
    ([, context]) => context.tag === 'integration-events.dispatch',
  );
  return { stub, dispatchReports };
}

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

  it('a failed read queues nothing and is reported, never read as "no endpoints"', async () => {
    const { stub, dispatchReports } = await dispatchWith({
      data: null,
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    });
    expect(stub.chainsAll.get('integration_deliveries.insert') ?? []).toHaveLength(0);
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      'integration_endpoints select: canceling statement due to statement timeout',
    );
    expect(dispatchReports[0]?.[1]).toEqual({
      tag: 'integration-events.dispatch',
      extra: { eventType: 'order.approved' },
    });
  });

  it.each(NOT_A_LIST)('%s queues nothing and is reported', async (_shape, answer) => {
    const { stub, dispatchReports } = await dispatchWith(answer as QueryResult);
    expect(stub.chainsAll.get('integration_deliveries.insert') ?? []).toHaveLength(0);
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      `integration_endpoints answered no list (status ${answer.status})`,
    );
  });

  it('a failed delivery insert is reported, never dropped in silence', async () => {
    const { dispatchReports } = await dispatchWith(
      { data: [ENDPOINT], error: null },
      { data: null, error: { message: 'canceling statement due to statement timeout' } },
    );
    expect(dispatchReports).toHaveLength(1);
    expect((dispatchReports[0]?.[0] as Error).message).toBe(
      'integration_deliveries insert: canceling statement due to statement timeout',
    );
  });
});
