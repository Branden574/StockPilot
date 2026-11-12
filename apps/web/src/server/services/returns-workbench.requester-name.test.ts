import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * B117 (owner, 2026-11-11): the Returns list shows the word "Staff" or
 * "Requester" where the person who asked should be named.
 *
 * An order a signed-in member places for themselves keeps the person in
 * `order_requests.requester_user_id` only: `requester_name` and
 * `requester_email` are NULL (migration 0391: both are written only for an
 * order placed on behalf of someone; core orders/requester-identity.ts states
 * the same). The Returns list and the return page read the two text columns
 * and never follow `requester_user_id` to the member's profile, so every
 * return against such an order has no name. The orders pages do follow it.
 *
 * THE RULE NOW (returns-workbench requesterLabelOf): the typed name; else the
 * profile name of the member the order was for (one batched read per page,
 * through the viewer's own row access); else the typed email; else "Deleted
 * user" when the order's requester deleted their account; else nothing, and
 * the screens then say how the return was opened, never a made-up name.
 *
 * Every name here is made up.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const access = vi.hoisted(() => ({ value: { hasAllAccess: true, writableIds: [] as string[], readableIds: [] as string[] } }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn(async () => access.value) }));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = vi.fn(async () => new Map());
  },
}));

import { buildReturnListPage, buildReturnWorkbench } from './returns-workbench';

const RET = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
/** The member who placed the order for themselves. */
const MEMBER = '66666666-6666-4666-8666-666666666666';
/** The staff member who opened the return on the member's behalf. */
const STAFF = '77777777-7777-4777-8777-777777777777';

const PROFILES = [
  { id: MEMBER, full_name: 'Robin Vale', email: 'robin.vale@example.com' },
  { id: STAFF, full_name: 'Dana Keeler', email: 'dana.keeler@example.com' },
];

function ctxFor(results: Record<string, unknown>) {
  const stub = makeSupabaseStub(results as never);
  return {
    stub,
    ctx: makeServiceContext(stub.client, { role: 'owner', enabledModules: new Set<ModuleId>(['returns', 'orders'] as ModuleId[]) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.value = { hasAllAccess: true, writableIds: [], readableIds: [] };
});

/** A `return_overview` row as the view answers it for a self-placed order. */
function overview(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
    return_number: `RMA-${i}`,
    status: 'requested',
    source: 'internal',
    reason_code: null,
    order_request_id: ORDER,
    order_number: 100 + i,
    // coalesce(r.requester_name, o.requester_name): both NULL for this order.
    requester_name: null,
    requester_email: null,
    // The view carries the order's requester (0396 line 3039).
    requester_user_id: MEMBER,
    requested_by: STAFF,
    deleted_users: null,
    created_at: `2026-11-0${i}T00:00:00Z`,
    approved_at: null,
    waiting_days: null,
    line_count: 0,
    unit_count: 0,
    lines: [],
    kind: 'return',
    ...over,
  };
}

/** The return page's header row, for the order given. */
function headerRow(order: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return {
    id: RET,
    return_number: 'RMA-20261109-ABC123',
    status: 'requested',
    source: 'internal',
    reason_code: null,
    notes: null,
    denial_reason: null,
    order_request_id: ORDER,
    requester_name: null,
    requester_email: null,
    requested_by: STAFF,
    approved_by: null,
    approved_at: null,
    received_by: null,
    received_at: null,
    closed_by: null,
    closed_at: null,
    denied_by: null,
    denied_at: null,
    deleted_users: null,
    created_at: '2026-11-09T00:00:00Z',
    order_request: order,
    lines: [],
    ...over,
  };
}

function orderRow(over: Record<string, unknown> = {}) {
  return {
    order_number: 140,
    warehouse_id: WH,
    requester_name: null,
    requester_email: null,
    requester_user_id: MEMBER,
    completed_at: '2026-11-01T00:00:00Z',
    signed_at: null,
    ...over,
  };
}

async function workbenchOf(header: Record<string, unknown>, profiles: unknown[] = PROFILES) {
  const { ctx, stub } = ctxFor({
    'returns.select': { data: [header], error: null },
    'rpc:return_restock_options': { data: { returnId: RET, status: 'requested', planSeq: 0, lines: [] }, error: null },
    'return_decisions.select': { data: [], error: null },
    'inventory_items.select': { data: [], error: null },
    'stock_movements.select': { data: [], error: null },
    'warehouses.select': { data: [{ id: WH, name: 'Main' }], error: null },
    'user_profiles.select': { data: profiles, error: null },
  });
  return { wb: await buildReturnWorkbench(ctx as never, RET), stub };
}

async function listOf(rows: unknown[], profiles: unknown[] = PROFILES) {
  const { ctx, stub } = ctxFor({
    'return_overview.select': { data: rows, error: null },
    'inventory_items.select': { data: [], error: null },
    'user_profiles.select': { data: profiles, error: null },
  });
  return { page: await buildReturnListPage(ctx as never, { filter: 'all' }), stub };
}

describe('B117: the Returns list names the person the order was for', () => {
  it('a return against a self-placed order names the member, whoever opened it', async () => {
    const { page, stub } = await listOf([
      // Opened by staff on the member's behalf: the list said "Staff".
      overview(1, { source: 'internal', requested_by: STAFF }),
      // Opened by the member from their own order: the list said "Requester".
      overview(2, { source: 'requester', requested_by: MEMBER }),
    ]);
    expect(page.rows.map((r) => r.requesterName ?? r.requesterEmail)).toEqual(['Robin Vale', 'Robin Vale']);
    // The view's own column is asked for, and the page's people are read once.
    expect(String(stub.chainArgs.get('return_overview.select')?.[0]?.[0] ?? '')).toContain('requester_user_id');
    expect(stub.fromCalls.filter((t) => t === 'user_profiles')).toHaveLength(1);
  });

  it('a member with no name on their profile is named by their profile email', async () => {
    const { page } = await listOf([overview(1)], [{ id: MEMBER, full_name: '  ', email: 'robin.vale@example.com' }]);
    expect(page.rows[0]).toMatchObject({ requesterName: 'robin.vale@example.com', requesterEmail: null });
  });

  it('a typed name (public link, or an order placed for someone) shows as typed, with no profile read', async () => {
    const { page, stub } = await listOf([
      // Public return link against a public-link order: no member anywhere.
      overview(1, { source: 'requester', requested_by: null, requester_user_id: null, requester_name: 'Sam Porter', requester_email: 'sam.porter@example.com' }),
      // Staff opened it against an order placed for someone: the typed name wins over any profile.
      overview(2, { requester_user_id: null, requester_name: 'Sam Porter' }),
      // Only an address was typed: it keeps showing as the address.
      overview(3, { requester_user_id: null, requester_email: 'sam.porter@example.com' }),
    ]);
    expect(page.rows.map((r) => [r.requesterName, r.requesterEmail])).toEqual([
      ['Sam Porter', 'sam.porter@example.com'],
      ['Sam Porter', null],
      [null, 'sam.porter@example.com'],
    ]);
    expect(stub.fromCalls).not.toContain('user_profiles');
  });

  it('an order whose requester deleted their account reads "Deleted user", even when staff opened the return', async () => {
    const { page } = await listOf([overview(1, { requester_user_id: null, requested_by: STAFF })]);
    expect(page.rows[0]).toMatchObject({ requesterName: 'Deleted user', requesterEmail: null });
  });

  it('never names the staff member who opened the return as the requester', async () => {
    // The member's profile is not readable by this viewer (or the read failed).
    const { page } = await listOf([overview(1, { requested_by: STAFF })], [PROFILES[1]]);
    expect(page.rows[0]).toMatchObject({ requesterName: null, requesterEmail: null });
  });

  it('an order the viewer cannot read has no requester, and is not called a deleted user', async () => {
    // The view left-joins the order: every order column comes back null.
    const { page } = await listOf([overview(1, { order_number: null, requester_user_id: null })]);
    expect(page.rows[0]).toMatchObject({ requesterName: null, requesterEmail: null });
  });
});

describe('B117: the return page names the person the order was for', () => {
  it('opened by staff against a self-placed order: the member, and the opener stays the staff member', async () => {
    const { wb, stub } = await workbenchOf(headerRow(orderRow()));
    expect(wb.return).toMatchObject({ requesterName: 'Robin Vale', requesterEmail: null, requestedByName: 'Dana Keeler' });
    expect(String(stub.chainArgs.get('returns.select')?.[0]?.[0] ?? '')).toMatch(/order_requests!order_request_id \([^)]*requester_user_id/);
    expect(stub.fromCalls.filter((t) => t === 'user_profiles')).toHaveLength(1);
  });

  it('opened by the member from their own order: the member', async () => {
    const { wb } = await workbenchOf(headerRow(orderRow(), { source: 'requester', requested_by: MEMBER }));
    expect(wb.return.requesterName).toBe('Robin Vale');
  });

  it('opened through the public link with a typed name: the typed name', async () => {
    const { wb } = await workbenchOf(
      headerRow(orderRow({ requester_user_id: null, requester_name: 'Sam Porter', requester_email: 'sam.porter@example.com' }), {
        source: 'requester',
        requested_by: null,
        requester_name: 'Sam Porter',
        requester_email: 'sam.porter@example.com',
      }),
    );
    expect(wb.return).toMatchObject({ requesterName: 'Sam Porter', requesterEmail: 'sam.porter@example.com' });
  });

  it('the order requester deleted their account: "Deleted user"', async () => {
    const { wb } = await workbenchOf(headerRow(orderRow({ requester_user_id: null })));
    expect(wb.return).toMatchObject({ requesterName: 'Deleted user', requesterEmail: null, requestedByName: 'Dana Keeler' });
  });

  it('no readable order, or an unreadable profile: no requester, never the opener', async () => {
    const none = await workbenchOf(headerRow(null));
    expect(none.wb.return).toMatchObject({ requesterName: null, requesterEmail: null });
    const hidden = await workbenchOf(headerRow(orderRow()), [PROFILES[1]]);
    expect(hidden.wb.return).toMatchObject({ requesterName: null, requesterEmail: null });
  });
});
