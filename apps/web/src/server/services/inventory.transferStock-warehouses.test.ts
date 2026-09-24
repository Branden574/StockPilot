import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * transfer_stock (0365) refuses a move below manager unless BOTH locations are
 * in warehouses the caller can write, raising a bare 42501 'forbidden' — the
 * same error its has_org_role(staff) floor raises. The service does not repeat
 * the check before the RPC (a location read plus the access list put serial
 * round trips in front of every staff transfer, bulk put-away included); it
 * tells the two refusals apart by role: a staff-or-above caller passed the
 * floor, so its 'forbidden' is the warehouse refusal and gets a sentence.
 *
 * The warehouse helpers are spied on, not stubbed out, so a test can prove the
 * transfer path never consults them.
 */
vi.mock('@/lib/auth/warehouse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/warehouse')>();
  return {
    ...actual,
    getWarehouseAccess: vi.fn(async () => ({
      readableIds: ['wh-a'],
      writableIds: ['wh-a'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-a',
    })),
    assertWarehouseAccess: vi.fn(actual.assertWarehouseAccess),
  };
});
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';
import { InventoryService, TRANSFER_WAREHOUSE_WRITE_REFUSED } from './inventory';

const INPUT = {
  itemId: '11111111-1111-1111-1111-111111111111',
  fromLocationId: 'loc-a',
  toLocationId: 'loc-b',
  quantity: 2,
};

const FORBIDDEN = { message: 'forbidden', code: '42501' };

function build(
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  rpc: { data: unknown; error: { message: string; code?: string } | null } = {
    data: { ok: true },
    error: null,
  },
) {
  const stub = makeSupabaseStub({ 'rpc:transfer_stock': rpc });
  // A viewer reaches the RPC only with stock:transfer granted by override.
  const permissions = role === 'viewer' ? new Set(['stock:transfer']) : undefined;
  const svc = new InventoryService(
    makeServiceContext(stub.client, { role, ...(permissions ? { permissions } : {}) }),
  );
  return { stub, svc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InventoryService.transferStock — warehouse write refusal comes from the RPC', () => {
  it('goes straight to the RPC for staff: no location read, no access-list read', async () => {
    const { stub, svc } = build('staff');
    await svc.transferStock(INPUT);
    expect(stub.fromCalls).not.toContain('locations');
    expect(getWarehouseAccess).not.toHaveBeenCalled();
    expect(assertWarehouseAccess).not.toHaveBeenCalled();
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_item_id: INPUT.itemId,
      p_from_location_id: 'loc-a',
      p_to_location_id: 'loc-b',
      p_quantity: 2,
    });
  });

  it("maps the RPC's 'forbidden' for staff to the warehouse sentence", async () => {
    const { stub, svc } = build('staff', { data: null, error: FORBIDDEN });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({
      code: 'forbidden',
      message: TRANSFER_WAREHOUSE_WRITE_REFUSED,
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
  });

  it("keeps 'Permission denied' for a viewer: that 'forbidden' is the org-role floor", async () => {
    const { stub, svc } = build('viewer', { data: null, error: FORBIDDEN });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Permission denied',
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
  });

  it.each(['manager', 'admin', 'owner'] as const)(
    'role %s goes straight to the RPC too, with no location read',
    async (role) => {
      const { stub, svc } = build(role);
      await svc.transferStock(INPUT);
      expect(stub.fromCalls).not.toContain('locations');
      expect(stub.rpcCalls.map((c) => c.name)).toEqual(['transfer_stock']);
    },
  );

  it('leaves the other RPC error mappings as they were', async () => {
    const cases: Array<[string, { code: string; message?: string; internalDetail?: string }]> = [
      ['same_location', { code: 'validation_error', message: 'Source and destination are the same location.' }],
      ['item_deleted', { code: 'not_found', message: 'That item has been archived or deleted.' }],
      ['item_not_found', { code: 'not_found', message: 'Item not found.' }],
      ['quantity_must_be_positive', { code: 'validation_error', message: 'Enter a quantity greater than zero.' }],
      // Kept internal_error on purpose: three callers rescue it by substring.
      ['insufficient_stock', { code: 'internal_error', internalDetail: 'insufficient_stock' }],
    ];
    for (const [raised, expected] of cases) {
      const { svc } = build('staff', { data: null, error: { message: raised } });
      await expect(svc.transferStock(INPUT)).rejects.toMatchObject(expected);
    }
  });
});
