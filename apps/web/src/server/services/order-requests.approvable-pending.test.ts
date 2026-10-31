import { beforeEach, describe, expect, it, vi } from 'vitest';

import { can, type ModuleId, type Role } from '@stockpilot/core';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';
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
 * B11 Part 1, review (2026-10-31). The Overview's "N order requests awaiting
 * your approval" counted every pending request in the organization
 * (pendingCount) for every approver. approve() and deny() ask, after
 * orders:approve, write access to the request's warehouse
 * (requireWarehouseAccess 'write'), so:
 *
 *   - a staff approver assigned to some warehouses was counted requests in
 *     the others, each refused with "This order is in a warehouse you don't
 *     work in" when they tried, and with none in their own warehouses still
 *     got a card that led nowhere;
 *   - a viewer granted orders:approve can approve nothing (the app refuses
 *     every write for a viewer).
 *
 * approvablePendingCount() counts the pending requests the caller could act
 * on, by approve()'s own two gates. pendingCount() keeps counting the
 * organization's, for the Insights page and the daily briefing.
 *
 * These run the REAL warehouse helpers (lib/auth/warehouse) against the stub,
 * and the stub answers the count by the query's own filters
 * (servedLikePostgrest), so a filter the count forgets is a wrong number.
 */

const ORG = 'org-test';
const REQUESTS = [
  { id: 'o1', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-a' },
  { id: 'o2', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-a' },
  { id: 'o3', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-b' },
  { id: 'o4', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-b' },
  { id: 'o5', organization_id: ORG, status: 'pending_approval', warehouse_id: 'wh-c' },
  { id: 'o6', organization_id: ORG, status: 'approved', warehouse_id: 'wh-a' },
  { id: 'o7', organization_id: 'org-other', status: 'pending_approval', warehouse_id: 'wh-a' },
];
const PENDING_IN_ORG = REQUESTS.filter(
  (r) => r.organization_id === ORG && r.status === 'pending_approval',
);

/** A head count as PostgREST answers one: the query's own filters on REQUESTS. */
function counted(call: MockCall): QueryResult {
  const { data } = servedLikePostgrest(REQUESTS)(call);
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
    // An owner, admin or manager's warehouses list, should anything read it.
    'warehouses.select': { data: [{ id: 'wh-a' }, { id: 'wh-b' }, { id: 'wh-c' }], error: null },
    ...results,
  });
}

function ctxFor(stub: ReturnType<typeof makeSupabaseStub>, person: Person) {
  return makeServiceContext(stub.client, {
    role: person.role,
    userId: 'person-1',
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

describe('approvablePendingCount: the pending requests the caller could approve', () => {
  it.each(PEOPLE.map((p) => [p.label, p] as const))(
    '%s: exactly the pending requests approve() would let them act on',
    async (_label, person) => {
      // approve()'s own gates, asked of each pending request in turn: the
      // permission (assertPermission), then write access to the request's
      // warehouse (requireWarehouseAccess -> assertWarehouseAccess 'write').
      const gateStub = stubFor(person);
      const gateCtx = ctxFor(gateStub, person);
      const expected: string[] = [];
      for (const r of PENDING_IN_ORG) {
        if (!can(gateCtx, 'orders:approve')) break;
        const allowed = await assertWarehouseAccess(r.warehouse_id, 'write', gateCtx).then(
          () => true,
          () => false,
        );
        if (allowed) expected.push(r.id);
      }

      const stub = stubFor(person);
      expect(await svc(stub, person).approvablePendingCount()).toBe(expected.length);
    },
  );

  it('the people above cover every answer: all, some, none', async () => {
    const answers = new Set<number>();
    for (const person of PEOPLE) {
      answers.add(await svc(stubFor(person), person).approvablePendingCount());
    }
    // 5 (the organization's), 4 (wh-a and wh-b), 2 (wh-a) and 0.
    expect([...answers].sort((a, b) => a - b)).toEqual([0, 2, 4, 5]);
  });

  it("a staff approver in one warehouse counts that warehouse's requests only", async () => {
    const person = PEOPLE.find((p) => p.label === 'staff approver in one warehouse')!;
    const stub = stubFor(person);
    expect(await svc(stub, person).approvablePendingCount()).toBe(2);
    const methods = stub.chains.get('order_requests.select')!;
    const args = stub.chainArgs.get('order_requests.select')!;
    expect(methods.filter((m) => m === 'in')).toHaveLength(1);
    expect(args[methods.indexOf('in')]).toEqual(['warehouse_id', ['wh-a']]);
  });

  it("an owner, admin or manager counts the organization's, and no warehouse access is read", async () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      const person = PEOPLE.find((p) => p.label === role)!;
      const stub = stubFor(person);
      expect(await svc(stub, person).approvablePendingCount()).toBe(PENDING_IN_ORG.length);
      expect(stub.fromCalls).toEqual(['order_requests']);
    }
  });

  it('a viewer granted orders:approve, someone without it, and a staff approver with no warehouse: nothing is counted', async () => {
    for (const label of [
      'viewer granted orders:approve, in every warehouse',
      'manager whose orders:approve was revoked',
      'staff requester',
      'staff approver in no warehouse',
      'staff approver whose access could not be read',
    ]) {
      const person = PEOPLE.find((p) => p.label === label)!;
      const stub = stubFor(person);
      expect(await svc(stub, person).approvablePendingCount()).toBe(0);
      expect(stub.fromCalls).not.toContain('order_requests');
    }
  });

  it('a failed count is an error, as it is for pendingCount()', async () => {
    const person = PEOPLE.find((p) => p.label === 'manager')!;
    const stub = stubFor(person, {
      'order_requests.select': { data: null, error: { message: 'boom' } },
    });
    await expect(svc(stub, person).approvablePendingCount()).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('pendingCount is unchanged', () => {
  it('still counts every pending request in the organization, whoever asks (the Insights page and the daily briefing read it)', async () => {
    const person = PEOPLE.find((p) => p.label === 'staff approver in one warehouse')!;
    const stub = stubFor(person);
    expect(await svc(stub, person).pendingCount()).toBe(PENDING_IN_ORG.length);
    expect(stub.fromCalls).toEqual(['order_requests']);
  });
});
