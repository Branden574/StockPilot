import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ModuleId, type Role } from '@stockpilot/core';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { handOverAllowed } from '@/server/lib/order-secrets';
import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));

import { ServiceError } from './context';
import { OrderRequestsService } from './order-requests';

/**
 * B72 part 1 (follow-up from B11 Part 1). The Overview's "N orders waiting
 * for signature" counted every staged and in-transit order in the
 * organization (awaitingSignatureCount) for every approver. Who can hand an
 * order over is one rule (server/lib/order-secrets handOverAllowed, the sign
 * route's member path and the order page's link): the order's assigned
 * driver; an approver of manager rank; any other approver only with write
 * access to the order's warehouse, and never a viewer. So:
 *
 *   - a viewer granted orders:approve was counted every order, though they
 *     can hand over only one they drive;
 *   - a staff approver limited to some warehouses was counted every
 *     warehouse's orders, though they can hand over only those in theirs (or
 *     one they drive).
 *
 * awaitingSignatureCount() now counts the orders handOverAllowed lets the
 * caller hand over. The expected numbers here come from handOverAllowed
 * itself, asked of each order with the caller's real warehouse access
 * (lib/auth/warehouse against the stub), and the stub answers the count by
 * the query's own filters, so a filter the count forgets is a wrong number.
 */

const ORG = 'org-test';
const ME = 'person-1';
const ORDERS = [
  { id: 'o1', status: 'staged_for_pickup', warehouse_id: 'wh-a', assigned_delivery_user_id: null },
  { id: 'o2', status: 'in_transit', warehouse_id: 'wh-a', assigned_delivery_user_id: 'other' },
  { id: 'o3', status: 'in_transit', warehouse_id: 'wh-b', assigned_delivery_user_id: ME },
  { id: 'o4', status: 'staged_for_pickup', warehouse_id: 'wh-b', assigned_delivery_user_id: null },
  { id: 'o5', status: 'in_transit', warehouse_id: 'wh-c', assigned_delivery_user_id: 'other' },
  { id: 'o6', status: 'staged_for_pickup', warehouse_id: null, assigned_delivery_user_id: ME },
  { id: 'o7', status: 'staged_for_pickup', warehouse_id: null, assigned_delivery_user_id: null },
  // Not waiting for a signature, or another organization's: never counted.
  { id: 'o8', status: 'picking_in_progress', warehouse_id: 'wh-a', assigned_delivery_user_id: ME },
  { id: 'o9', status: 'completed', warehouse_id: 'wh-a', assigned_delivery_user_id: null },
].map((o) => ({ ...o, organization_id: ORG }));
const ROWS = [
  ...ORDERS,
  {
    id: 'x1',
    organization_id: 'org-other',
    status: 'in_transit',
    warehouse_id: 'wh-a',
    assigned_delivery_user_id: ME,
  },
];
const WAITING_IN_ORG = ORDERS.filter((o) => ['staged_for_pickup', 'in_transit'].includes(o.status));

/**
 * PostgREST's `or=(a.eq.x,b.in.(y,z),c.not.is.null)`, for the three operators
 * the count uses: a row is kept when any part holds. Anything else throws, so
 * a filter the stub cannot read is never ignored.
 */
function orKeeps(filter: string, row: Record<string, unknown>): boolean {
  const parts = filter.match(/[a-z_]+\.(?:eq\.[^,()]+|in\.\([^)]*\)|not\.is\.null)/g) ?? [];
  if (parts.join(',') !== filter) throw new Error(`cannot evaluate .or(${filter})`);
  return parts.some((part) => {
    const [col, op] = part.split('.', 2) as [string, string];
    const rest = part.slice(col.length + op.length + 2);
    if (op === 'eq') return row[col] === rest;
    if (op === 'not') return (row[col] ?? null) !== null;
    return rest
      .slice(1, -1)
      .split(',')
      .includes(row[col] as string);
  });
}

/** A head count as PostgREST answers one: the query's own filters on ROWS. */
function counted(call: MockCall): QueryResult {
  const orAt = call.methods.indexOf('or');
  const rows = orAt === -1 ? ROWS : ROWS.filter((r) => orKeeps(call.args[orAt]![0] as string, r));
  const rest: MockCall = {
    ...call,
    methods: call.methods.filter((_, i) => i !== orAt),
    args: call.args.filter((_, i) => i !== orAt),
  };
  const { data } = servedLikePostgrest(rows)(rest);
  return { data: null, error: null, count: (data as unknown[]).length };
}

type Person = {
  label: string;
  role: Role;
  permissions: string[];
  /** Assigned warehouses (staff and viewers), or the read failing. */
  assignments?: string[] | 'unreadable';
  /** The 0280 all-warehouses membership flag. */
  allWarehouses?: boolean;
};

const APPROVER = ['orders:request', 'orders:approve'];

function stubFor(
  person: Person,
  results: Record<string, QueryResult | ((c: MockCall) => QueryResult)> = {},
) {
  const assignments: QueryResult =
    person.assignments === 'unreadable'
      ? {
          data: null,
          error: { message: 'canceling statement due to statement timeout', code: '57014' },
        }
      : {
          data: (person.assignments ?? []).map((id, i) => ({
            warehouse_id: id,
            is_primary: i === 0,
          })),
          error: null,
        };
  return makeSupabaseStub({
    'order_requests.select': counted,
    'user_warehouse_assignments.select': assignments,
    'organization_members.select.maybeSingle': {
      data: { all_warehouses: person.allWarehouses === true },
      error: null,
    },
    'warehouses.select': { data: [{ id: 'wh-a' }, { id: 'wh-b' }, { id: 'wh-c' }], error: null },
    ...results,
  });
}

function ctxFor(stub: ReturnType<typeof makeSupabaseStub>, person: Person) {
  return makeServiceContext(stub.client, {
    role: person.role,
    userId: ME,
    enabledModules: new Set<ModuleId>(['orders']),
    permissions: new Set(person.permissions),
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>, person: Person) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    ctxFor(stub, person),
  );
}

const PEOPLE: Person[] = [
  { label: 'owner', role: 'owner', permissions: APPROVER },
  { label: 'admin', role: 'admin', permissions: APPROVER },
  { label: 'manager', role: 'manager', permissions: APPROVER },
  {
    label: 'staff approver in one warehouse',
    role: 'staff',
    permissions: APPROVER,
    assignments: ['wh-a'],
  },
  {
    label: 'staff approver in two warehouses',
    role: 'staff',
    permissions: APPROVER,
    assignments: ['wh-a', 'wh-b'],
  },
  {
    label: 'staff approver with the all-warehouses flag',
    role: 'staff',
    permissions: APPROVER,
    assignments: ['wh-a'],
    allWarehouses: true,
  },
  {
    label: 'staff approver in no warehouse',
    role: 'staff',
    permissions: APPROVER,
    assignments: [],
  },
  {
    label: 'staff approver whose access could not be read',
    role: 'staff',
    permissions: APPROVER,
    assignments: 'unreadable',
  },
  {
    label: 'viewer granted orders:approve, in every warehouse',
    role: 'viewer',
    permissions: APPROVER,
    assignments: ['wh-a', 'wh-b', 'wh-c'],
    allWarehouses: true,
  },
  {
    label: 'manager whose orders:approve was revoked',
    role: 'manager',
    permissions: ['orders:request'],
  },
  {
    label: 'staff requester',
    role: 'staff',
    permissions: ['orders:request'],
    assignments: ['wh-a'],
  },
];

beforeEach(() => vi.clearAllMocks());

describe('awaitingSignatureCount: the waiting orders the caller could hand over (B72)', () => {
  it.each(PEOPLE.map((p) => [p.label, p] as const))(
    '%s: exactly the orders handOverAllowed lets them hand over',
    async (_label, person) => {
      const gateStub = stubFor(person);
      const gateCtx = ctxFor(gateStub, person);
      const access = await getWarehouseAccess(gateCtx);
      const expected = WAITING_IN_ORG.filter((o) => handOverAllowed(gateCtx, o, access));

      const stub = stubFor(person);
      expect(await svc(stub, person).awaitingSignatureCount()).toBe(expected.length);
    },
  );

  it('the people above cover every answer: all, some, only what they drive', async () => {
    const answers = new Set<number>();
    for (const person of PEOPLE) {
      answers.add(await svc(stubFor(person), person).awaitingSignatureCount());
    }
    // 7 (the organization's), 6 (every one with a warehouse, and o6 they
    // drive), 5 (wh-a, wh-b and o6), 4 (wh-a, o3 and o6) and 2 (o3 and o6, the
    // two they drive).
    expect([...answers].sort((a, b) => a - b)).toEqual([2, 4, 5, 6, 7]);
  });

  it("an owner, admin or manager counts the organization's, and no warehouse access is read", async () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      const person = PEOPLE.find((p) => p.label === role)!;
      const stub = stubFor(person);
      expect(await svc(stub, person).awaitingSignatureCount()).toBe(WAITING_IN_ORG.length);
      expect(stub.fromCalls).toEqual(['order_requests']);
    }
  });

  it('a viewer granted orders:approve counts only the orders they drive', async () => {
    const person = PEOPLE.find((p) => p.label.startsWith('viewer granted'))!;
    const stub = stubFor(person);
    expect(await svc(stub, person).awaitingSignatureCount()).toBe(2);
  });

  it('a failed count is an error, as before', async () => {
    const person = PEOPLE.find((p) => p.label === 'manager')!;
    const stub = stubFor(person, {
      'order_requests.select': { data: null, error: { message: 'boom' } },
    });
    await expect(svc(stub, person).awaitingSignatureCount()).rejects.toBeInstanceOf(ServiceError);
  });
});
