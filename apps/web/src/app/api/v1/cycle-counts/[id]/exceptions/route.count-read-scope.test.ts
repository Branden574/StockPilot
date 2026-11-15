import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';
import { RECOUNT_FACTS_NOT_YET } from '@/test/recount-facts';

/**
 * GET /api/v1/cycle-counts/[id]/exceptions answers for a count the caller
 * reads, by the one count read rule (lib/auth/count-read-scope.ts), the rule
 * the count list, the count page and sheet and the phone's sync apply
 * (server/services/cycle-counts.read-scope.test.ts):
 *
 *   - managers and above, and members with every warehouse: every count;
 *   - anyone else: a count in a warehouse they can read, and a count with no
 *     warehouse only when it is assigned to them;
 *   - a member with no readable warehouse: none.
 *
 * A count the rule does not show answers 404 in the words of a count that
 * does not exist, and none of its linked exceptions or lines is read. The
 * route runs here over the real service (ExceptionOccurrencesService
 * .listForCount) and a stubbed database client.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    getWarehouseAccess: vi.fn(),
    assertWarehouseAccess: vi.fn(async () => undefined),
  };
});

import { withApiContext } from '@/lib/auth/api-context';
import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { GET } from './route';

const ORG = 'org-1';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOMEONE_ELSE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OCC = '11111111-1111-4111-8111-111111111111';

const occurrence = {
  id: OCC,
  organization_id: ORG,
  occurrence_number: 42,
  rule: 'count_variance',
  item_id: 'item-1',
  location_id: null,
  warehouse_id: 'wh-a',
  facts: { itemName: 'Sample item', expected: 10, counted: 11, variance: 1, countNumber: 24 },
  condition_since: '2026-09-20T10:00:00Z',
  first_seen_at: '2026-09-24T15:00:00Z',
  last_seen_at: '2026-09-24T18:00:00Z',
  acknowledged_at: null,
  acknowledged_by: null,
  recount_cycle_count_id: CC,
  resolved_at: null,
  resolved_reason: null,
  previous_occurrence_id: null,
  recurrence_index: 0,
  item: { name: 'Sample item', sku: 'SAMPLE-1' },
  location: null,
  recount: { id: CC, count_number: 31, status: 'completed', completed_at: '2026-09-25T09:00:00Z' },
  acknowledger: null,
};

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

/** One GET of the route for a count with this header (null: no such count). */
async function getFor(
  role: Role,
  header: { warehouse_id: string | null; assigned_to: string | null } | null,
) {
  const stub = makeSupabaseStub({
    ...RECOUNT_FACTS_NOT_YET,
    'exception_sync_state.select.maybeSingle': {
      data: {
        tracking_started_at: '2026-09-24T15:00:00Z',
        last_evaluated_at: '2026-09-24T18:00:00Z',
        last_synced_at: '2026-09-24T18:00:02Z',
        complete_rules: ['count_variance'],
        failed_rules: [],
        truncated_rules: [],
      },
      error: null,
    },
    'cycle_counts.select.maybeSingle': {
      data: header ? { id: CC, count_number: 31, status: 'completed', ...header } : null,
      error: null,
    },
    'exception_occurrence_events.select': {
      data: [{ id: 'e1', occurrence_id: OCC }],
      error: null,
    },
    'exception_occurrences.select': servedLikePostgrest([occurrence]),
    'cycle_count_lines.select': servedLikePostgrest([
      {
        id: 'l1',
        cycle_count_id: CC,
        item_id: 'item-1',
        counted_quantity: 11,
        expected_quantity: 10,
        counted_location_id: null,
        counted_location: null,
      },
    ]),
  });
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: ORG,
    userId: ME,
    role,
    mfaRequired: false,
    mfaSatisfied: true,
    supabase: stub.client,
  } as never);
  const res = await GET(
    new Request(`https://t.local/api/v1/cycle-counts/${CC}/exceptions`, {
      headers: { authorization: 'Bearer t' },
    }) as never,
    { params: Promise.resolve({ id: CC }) },
  );
  return { res, body: (await res.json()) as Record<string, unknown>, stub };
}

function limitedTo(readable: string[], writable: string[] = readable) {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: readable,
    writableIds: writable,
    hasAllAccess: false,
    primaryWarehouseId: readable[0] ?? null,
  });
}

const NOT_FOUND = { error: 'not_found', message: 'Cycle count not found.' };

/** A 404 in the words of a count that does not exist, with nothing of the count read past its header. */
function expectNotFound(got: Awaited<ReturnType<typeof getFor>>) {
  expect(got.res.status).toBe(404);
  expect(got.body).toEqual(NOT_FOUND);
  expect(got.stub.fromCalls).not.toContain('exception_occurrences');
  expect(got.stub.fromCalls).not.toContain('cycle_count_lines');
}

/** The count's linked exception, with its line. */
function expectLinkedException(got: Awaited<ReturnType<typeof getFor>>) {
  expect(got.res.status).toBe(200);
  expect(got.body).toMatchObject({ organizationId: ORG, cycleCountId: CC, reference: 'CC-000031' });
  expect(got.body.exceptions).toMatchObject([
    { occurrence: { id: OCC }, line: { id: 'l1', countedQuantity: 11, expectedQuantity: 10 } },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  limitedTo(['wh-a']);
});

describe('a member limited to some warehouses', () => {
  it('a count in a warehouse they can read: 200 with its linked exceptions', async () => {
    expectLinkedException(await getFor('staff', { warehouse_id: 'wh-a', assigned_to: null }));
  });

  it('a read-only member, a count in a warehouse they can read: 200', async () => {
    limitedTo(['wh-a'], []);
    expectLinkedException(await getFor('viewer', { warehouse_id: 'wh-a', assigned_to: null }));
  });

  it('a count in another warehouse: 404, and no linked exception or line is read', async () => {
    expectNotFound(await getFor('staff', { warehouse_id: 'wh-b', assigned_to: null }));
  });

  it('a count in another warehouse that is assigned to them: 404', async () => {
    expectNotFound(await getFor('staff', { warehouse_id: 'wh-b', assigned_to: ME }));
  });

  it('a count with no warehouse that is assigned to them: 200', async () => {
    expectLinkedException(await getFor('staff', { warehouse_id: null, assigned_to: ME }));
  });

  it('a count with no warehouse that is assigned to someone else: 404', async () => {
    expectNotFound(await getFor('staff', { warehouse_id: null, assigned_to: SOMEONE_ELSE }));
  });

  it('a count with no warehouse that is assigned to nobody: 404', async () => {
    expectNotFound(await getFor('staff', { warehouse_id: null, assigned_to: null }));
  });

  it('a member with no readable warehouse: 404 for every count, their own assignment included', async () => {
    limitedTo([]);
    expectNotFound(await getFor('staff', { warehouse_id: null, assigned_to: ME }));
    expectNotFound(await getFor('staff', { warehouse_id: 'wh-a', assigned_to: null }));
  });

  it('answers a count it does not show exactly as a count that does not exist', async () => {
    const hidden = await getFor('staff', { warehouse_id: 'wh-b', assigned_to: null });
    const missing = await getFor('staff', null);
    expect(hidden.res.status).toBe(missing.res.status);
    expect(hidden.body).toEqual(missing.body);
    expect(missing.body).toEqual(NOT_FOUND);
  });

  it('warehouse access that could not be read: a 500 to try again, never the exceptions and never 404', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
      unreadable: true,
    });
    const got = await getFor('staff', { warehouse_id: 'wh-a', assigned_to: ME });
    expect(got.res.status).toBe(500);
    expect(got.body).not.toHaveProperty('exceptions');
    expect(got.stub.fromCalls).not.toContain('exception_occurrences');
    expect(got.stub.fromCalls).not.toContain('cycle_count_lines');
  });
});

describe('members who see every warehouse', () => {
  const HEADERS = [
    { warehouse_id: 'wh-b', assigned_to: null },
    { warehouse_id: null, assigned_to: null },
    { warehouse_id: null, assigned_to: SOMEONE_ELSE },
  ];

  it.each(['owner', 'admin', 'manager'] as const)(
    '%s: 200 for every count, by role, whatever a warehouse access read answers',
    async (role) => {
      // The service reads warehouse access for its own act gate; here that
      // read answers "one warehouse", which the count rule does not ask a
      // manager for.
      limitedTo(['wh-a']);
      for (const header of HEADERS) expectLinkedException(await getFor(role, header));
    },
  );

  it('a staff member with every warehouse: 200 for every count', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: ['wh-a'],
      writableIds: ['wh-a'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-a',
    });
    for (const header of HEADERS) expectLinkedException(await getFor('staff', header));
  });

  it('the count header is read with its warehouse and its assignee', async () => {
    const { stub } = await getFor('manager', { warehouse_id: 'wh-a', assigned_to: null });
    const select = String(stub.chainArgsAll.get('cycle_counts.select')?.[0]?.[0]?.[0]);
    expect(select).toContain('warehouse_id');
    expect(select).toContain('assigned_to');
  });
});
