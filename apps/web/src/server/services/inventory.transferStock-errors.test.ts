import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * transferStock mapped EVERY `transfer_stock` RPC error to
 * ServiceError('internal_error'), so a permission or state error reached the
 * user as a 500 "An internal error occurred" / "Something went wrong" — and
 * the mobile client RETRIES a 500. The RPC (0327) raises named classes:
 * quantity_must_be_positive (22023), same_location (22023), item_not_found /
 * item_deleted (P0002), forbidden (42501), insufficient_stock (P0001).
 *
 * Pattern #28(b): enumerate the RPC's `raise exception` strings and map each
 * one, specific before general.
 *
 * insufficient_stock deliberately stays internal_error — three callers
 * (transferStockAction, placeStockAction, the /api/v1 transfer route) each
 * rescue it by substring to print their OWN copy ("Can't transfer…", "Can't
 * place…", "Can't move…"). Flattening that into one service-level message is
 * a cross-file change; see the notes on this unit.
 */
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

const INPUT = {
  itemId: '11111111-1111-1111-1111-111111111111',
  fromLocationId: 'loc-a',
  toLocationId: 'loc-b',
  quantity: 1,
};

function svcWithRpcError(error: { message: string; code?: string }) {
  const stub = makeSupabaseStub({ 'rpc:transfer_stock': { data: null, error } });
  return new InventoryService(makeServiceContext(stub.client));
}

describe('InventoryService.transferStock — RPC error classes', () => {
  it.each([
    ['forbidden', '42501', 'forbidden'],
    ['item_deleted', 'P0002', 'not_found'],
    ['item_not_found', 'P0002', 'not_found'],
    ['same_location', '22023', 'validation_error'],
    ['quantity_must_be_positive', '22023', 'validation_error'],
  ])('maps a %s RPC failure (%s) to ServiceError code %s', async (message, code, expected) => {
    const svc = svcWithRpcError({ message, code });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({ code: expected });
  });

  it('still wraps an UNRECOGNISED RPC failure as internal_error', async () => {
    const svc = svcWithRpcError({ message: 'deadlock detected', code: '40P01' });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('leaves insufficient_stock on internal_error so each caller keeps its own copy', async () => {
    const svc = svcWithRpcError({ message: 'insufficient_stock', code: 'P0001' });
    await expect(svc.transferStock(INPUT)).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringContaining('insufficient_stock'),
    });
  });

  it('refuses a same-location transfer BEFORE the round-trip to the RPC', async () => {
    const stub = makeSupabaseStub({ 'rpc:transfer_stock': { data: null, error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await expect(
      svc.transferStock({ ...INPUT, toLocationId: INPUT.fromLocationId }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
  });
});
