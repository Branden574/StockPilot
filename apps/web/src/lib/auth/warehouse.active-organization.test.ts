// Security invariant (listed in scripts/security-test.sh): a warehouse must
// belong to the active organization. assertWarehouseAccess refuses, for read
// and for write, a warehouse id that is not one of the active organization's
// own, whoever asks: an owner, an admin, a manager or an all-warehouses member
// as well as a member scoped to some warehouses. The refusal is the one a
// member outside the warehouse gets, word for word.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('requireOrgContext must not be reached: every call passes its ctx');
  }),
}));
const cookieRows: { rows: Array<{ id: string; name: string }>; failed: boolean } = {
  rows: [],
  failed: false,
};
vi.mock('@/lib/dashboard/request-cache', () => ({
  readWarehousesForRequest: vi.fn(async () => cookieRows),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('createClient must not be reached: every ctx carries its own client');
  }),
}));

import { assertWarehouseAccess, ForbiddenError } from './warehouse';

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

// Made-up ids only.
const ORG_A = '0000000a-0000-4000-8000-000000000000';
const ORG_B = '0000000b-0000-4000-8000-000000000000';
const WH_A1 = '0000000a-0000-4000-8000-0000000000a1';
const WH_A2 = '0000000a-0000-4000-8000-0000000000a2';
const WH_A_ARCHIVED = '0000000a-0000-4000-8000-0000000000a9';
const WH_B1 = '0000000b-0000-4000-8000-0000000000b1';
const WH_NOWHERE = '0000000c-0000-4000-8000-0000000000c1';
const USER = '0000000d-0000-4000-8000-000000000001';

/** Every warehouse the caller's client can see: a member of both A and B sees both. */
const WAREHOUSES = [
  { id: WH_A1, organization_id: ORG_A, name: 'A one', status: 'active' },
  { id: WH_A2, organization_id: ORG_A, name: 'A two', status: 'active' },
  { id: WH_A_ARCHIVED, organization_id: ORG_A, name: 'A old', status: 'archived' },
  { id: WH_B1, organization_id: ORG_B, name: 'B one', status: 'active' },
];

function stubFor(
  opts: {
    assignments?: Array<{ warehouse_id: string; is_primary: boolean; organization_id: string }>;
    allWarehouses?: boolean;
    warehouseReadFails?: boolean;
  } = {},
): SupabaseStub {
  return makeSupabaseStub({
    'warehouses.select': servedLikePostgrest(WAREHOUSES),
    ...(opts.warehouseReadFails
      ? { 'warehouses.select.maybeSingle': { data: null, error: { message: 'read failed' } } }
      : {}),
    'user_warehouse_assignments.select': servedLikePostgrest(
      (opts.assignments ?? []).map((a) => ({ ...a, user_id: USER })),
    ),
    'organization_members.select': {
      data: { all_warehouses: opts.allWarehouses === true },
      error: null,
    },
  });
}

/** A Bearer-style ctx: its own client, acting in organization A. */
function ctxFor(stub: SupabaseStub, role: Role, organizationId = ORG_A) {
  return { organizationId, userId: USER, role, supabase: stub.client };
}

async function refusal(p: Promise<void>): Promise<ForbiddenError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ForbiddenError);
  return e as ForbiddenError;
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieRows.rows = [];
  cookieRows.failed = false;
});

describe.each(['owner', 'admin', 'manager'] as const)(
  'a %s acting in organization A',
  (role) => {
    it.each(['read', 'write'] as const)(
      'is refused %s on a warehouse of organization B',
      async (op) => {
        const stub = stubFor();
        const e = await refusal(assertWarehouseAccess(WH_B1, op, ctxFor(stub, role)));
        expect(e.message).toBe(`User does not have ${op} access to warehouse ${WH_B1}.`);
        expect(e.accessUnreadable).toBe(false);
      },
    );

    it.each(['read', 'write'] as const)(
      'may %s a warehouse of organization A, with no read past the access list',
      async (op) => {
        const stub = stubFor();
        await expect(assertWarehouseAccess(WH_A1, op, ctxFor(stub, role))).resolves.toBeUndefined();
        await expect(assertWarehouseAccess(WH_A2, op, ctxFor(stub, role))).resolves.toBeUndefined();
        // Only getWarehouseAccess's own list read (one per ctx).
        for (const args of stub.chainArgsAll.get('warehouses.select') ?? []) {
          expect(args).toContainEqual(['organization_id', ORG_A]);
          expect(args).toContainEqual(['status', 'archived']);
        }
      },
    );

    it('may write an archived warehouse of organization A (read in A by id)', async () => {
      const stub = stubFor();
      await expect(
        assertWarehouseAccess(WH_A_ARCHIVED, 'write', ctxFor(stub, role)),
      ).resolves.toBeUndefined();
      const reads = stub.chainArgsAll.get('warehouses.select') ?? [];
      expect(reads.at(-1)).toEqual(
        expect.arrayContaining([
          ['organization_id', ORG_A],
          ['id', WH_A_ARCHIVED],
        ]),
      );
    });

    it('answers a warehouse that exists nowhere exactly as one of organization B', async () => {
      const stub = stubFor();
      const nowhere = await refusal(assertWarehouseAccess(WH_NOWHERE, 'write', ctxFor(stub, role)));
      const elsewhere = await refusal(assertWarehouseAccess(WH_B1, 'write', ctxFor(stub, role)));
      expect(nowhere.message.replace(WH_NOWHERE, '<id>')).toBe(
        elsewhere.message.replace(WH_B1, '<id>'),
      );
      expect(nowhere.accessUnreadable).toBe(elsewhere.accessUnreadable);
    });

    it('refuses, as could-not-check, when the warehouse read fails', async () => {
      const stub = stubFor({ warehouseReadFails: true });
      const e = await refusal(assertWarehouseAccess(WH_A_ARCHIVED, 'write', ctxFor(stub, role)));
      expect(e.accessUnreadable).toBe(true);
    });

    it('refuses an id that is not a UUID without reading it', async () => {
      const stub = stubFor();
      await refusal(assertWarehouseAccess('not-a-warehouse', 'write', ctxFor(stub, role)));
      for (const args of stub.chainArgsAll.get('warehouses.select') ?? []) {
        expect(args).not.toContainEqual(['id', 'not-a-warehouse']);
      }
    });
  },
);

describe('a manager on the request cookie session (the request-cached list)', () => {
  function cookieCtx(stub: SupabaseStub) {
    return {
      organizationId: ORG_A,
      userId: USER,
      role: 'manager' as const,
      supabase: stub.client,
      cookieClient: stub.client,
    };
  }

  it('is refused a warehouse of organization B and allowed one of A', async () => {
    cookieRows.rows = [
      { id: WH_A1, name: 'A one' },
      { id: WH_A2, name: 'A two' },
    ];
    const stub = stubFor();
    await refusal(assertWarehouseAccess(WH_B1, 'write', cookieCtx(stub)));
    await refusal(assertWarehouseAccess(WH_B1, 'read', cookieCtx(stub)));
    await expect(assertWarehouseAccess(WH_A1, 'write', cookieCtx(stub))).resolves.toBeUndefined();
  });

  it('with the list unreadable, still allows a warehouse of A and refuses one of B', async () => {
    cookieRows.failed = true;
    const stub = stubFor();
    await expect(assertWarehouseAccess(WH_A1, 'write', cookieCtx(stub))).resolves.toBeUndefined();
    const e = await refusal(assertWarehouseAccess(WH_B1, 'write', cookieCtx(stub)));
    expect(e.accessUnreadable).toBe(false);
  });
});

describe('an all-warehouses member (staff) acting in organization A', () => {
  const assignments = [
    { warehouse_id: WH_A1, is_primary: true, organization_id: ORG_A },
    { warehouse_id: WH_A2, is_primary: false, organization_id: ORG_A },
    // Their assignment in organization B is not organization A's.
    { warehouse_id: WH_B1, is_primary: true, organization_id: ORG_B },
  ];

  it.each(['read', 'write'] as const)('is refused %s on a warehouse of organization B', async (op) => {
    const stub = stubFor({ assignments, allWarehouses: true });
    const e = await refusal(assertWarehouseAccess(WH_B1, op, ctxFor(stub, 'staff')));
    expect(e.message).toBe(`User does not have ${op} access to warehouse ${WH_B1}.`);
  });

  it.each(['read', 'write'] as const)('may %s a warehouse of organization A', async (op) => {
    const stub = stubFor({ assignments, allWarehouses: true });
    await expect(assertWarehouseAccess(WH_A2, op, ctxFor(stub, 'staff'))).resolves.toBeUndefined();
  });

  it('an all-warehouses viewer reads A, is refused B, and writes nothing', async () => {
    const stub = stubFor({ assignments, allWarehouses: true });
    await expect(assertWarehouseAccess(WH_A1, 'read', ctxFor(stub, 'viewer'))).resolves.toBeUndefined();
    await refusal(assertWarehouseAccess(WH_B1, 'read', ctxFor(stub, 'viewer')));
    const e = await refusal(assertWarehouseAccess(WH_A1, 'write', ctxFor(stub, 'viewer')));
    expect(e.message).toBe('Read-only auditor cannot perform write operations.');
  });
});

describe('a member scoped to some warehouses (unchanged)', () => {
  const assignments = [{ warehouse_id: WH_A1, is_primary: true, organization_id: ORG_A }];

  it('writes the assigned warehouse and is refused the others of A and of B', async () => {
    const stub = stubFor({ assignments });
    await expect(assertWarehouseAccess(WH_A1, 'write', ctxFor(stub, 'staff'))).resolves.toBeUndefined();
    const other = await refusal(assertWarehouseAccess(WH_A2, 'write', ctxFor(stub, 'staff')));
    const elsewhere = await refusal(assertWarehouseAccess(WH_B1, 'write', ctxFor(stub, 'staff')));
    expect(other.message).toBe(`User does not have write access to warehouse ${WH_A2}.`);
    expect(elsewhere.message).toBe(`User does not have write access to warehouse ${WH_B1}.`);
    // No warehouse read for a scoped member: the assignments decide.
    expect(stub.chainArgsAll.get('warehouses.select') ?? []).toHaveLength(0);
  });
});
