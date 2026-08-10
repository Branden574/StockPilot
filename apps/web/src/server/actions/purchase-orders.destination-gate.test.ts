import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Permission } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => {}),
}));

// Keep the REAL gate helpers (assertPermission / assertModuleEnabled / ServiceError)
// but stub withContext so the test injects the caller's role + effective perms.
const { mockWithContext } = vi.hoisted(() => ({ mockWithContext: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, withContext: mockWithContext };
});

// Warehouse write-access passes by default; the permission gate runs first.
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => {}),
  ForbiddenError: class extends Error {},
}));

// LocationsService resolves an existing site for the warehouse by default (so a
// legitimate call never needs the create path in these gate tests).
const { mockList, mockCreate } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: class {
    list = mockList;
    create = mockCreate;
  },
}));

import { setPoDestinationWarehouseAction } from './purchase-orders';

const PO_ID = '11111111-1111-1111-1111-111111111111';
const WH_ID = '22222222-2222-2222-2222-222222222222';

function ctxWith(opts: {
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  permissions?: ReadonlySet<Permission>;
  enabledModules?: Set<ModuleId>;
}) {
  const stub = makeSupabaseStub({
    'warehouses.select': { data: { name: 'Main WH' }, error: null },
    'purchase_orders.update': { data: { id: PO_ID }, error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-1',
    role: opts.role,
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
    ...(opts.enabledModules ? { enabledModules: opts.enabledModules } : {}),
  });
  return { ctx, stub };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([{ id: 'loc-1', warehouse_id: WH_ID }]);
  mockCreate.mockResolvedValue({ id: 'loc-new' });
});

// MED-4: the action was ungated. The permission gate is the fix.
describe('setPoDestinationWarehouseAction — authorization gate', () => {
  it('403s when purchase_orders:manage is revoked, and never writes the PO', async () => {
    // Everything else is happy — only the permission is revoked. If the gate is
    // dropped this call SUCCEEDS, which is exactly what the assertion catches.
    const { ctx, stub } = ctxWith({ role: 'manager', permissions: new Set<Permission>([]) });
    mockWithContext.mockResolvedValueOnce(ctx);

    const res = await setPoDestinationWarehouseAction({ poId: PO_ID, warehouseId: WH_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('403s when the purchase_orders module is disabled', async () => {
    const { ctx, stub } = ctxWith({
      role: 'admin',
      enabledModules: new Set<ModuleId>(['inventory']),
    });
    mockWithContext.mockResolvedValueOnce(ctx);

    const res = await setPoDestinationWarehouseAction({ poId: PO_ID, warehouseId: WH_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('module_disabled');
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
  });

  it('re-points the PO for an authorized caller (existing site reused via LocationsService)', async () => {
    const { ctx, stub } = ctxWith({ role: 'manager' });
    mockWithContext.mockResolvedValueOnce(ctx);

    const res = await setPoDestinationWarehouseAction({ poId: PO_ID, warehouseId: WH_ID });

    expect(res.ok).toBe(true);
    expect(mockList).toHaveBeenCalledWith({ sitesOnly: true });
    expect(mockCreate).not.toHaveBeenCalled();
    const updatePayload = stub.chainArgs.get('purchase_orders.update')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(updatePayload.destination_location_id).toBe('loc-1');
  });

  it('fails closed (not_found) when the PO update matches zero rows', async () => {
    const stub = makeSupabaseStub({
      'warehouses.select': { data: { name: 'Main WH' }, error: null },
      // 0-row update: a foreign/deleted PO id or an RLS refusal.
      'purchase_orders.update': { data: null, error: null },
    });
    const ctx = makeServiceContext(stub.client, { organizationId: 'org-1', role: 'manager' });
    mockWithContext.mockResolvedValueOnce(ctx);

    const res = await setPoDestinationWarehouseAction({ poId: PO_ID, warehouseId: WH_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });
});
