import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The refusals assemble_bundle() and distribute_bundle() raise since 0365
 * (P0001, message = the code). Unmapped, each fell through to internal_error:
 * a 500 "An internal error occurred" that the phone retries and the web modal
 * cannot explain. Each must arrive as a validation_error with a sentence the
 * modal and the phone show verbatim.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(async () => undefined) }));

import { makeServiceContext } from '@/test/supabase-mock';

import {
  BUNDLE_COMPONENT_NOT_IN_WAREHOUSE,
  BUNDLE_COMPONENT_NOT_VISIBLE,
  BUNDLE_PHANTOM_DELETED,
  BundlesService,
} from './bundles';

const rpc = vi.fn();

function service() {
  return new BundlesService(makeServiceContext({ rpc }, { role: 'manager' }));
}

function raises(message: string, detail?: string) {
  rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001', detail } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BundlesService.assemble — 0365 refusals', () => {
  it.each([
    [
      'component_not_in_warehouse',
      "A component of this kit isn't stocked at this warehouse. Assemble the kit where its components are.",
      BUNDLE_COMPONENT_NOT_IN_WAREHOUSE,
    ],
    [
      'phantom_deleted',
      "This kit's stock item was deleted, so no more can be assembled.",
      BUNDLE_PHANTOM_DELETED,
    ],
    [
      'component_not_visible',
      "A component of this kit isn't in your inventory view, so the kit can't be built from it.",
      BUNDLE_COMPONENT_NOT_VISIBLE,
    ],
  ])('maps %s to a validation_error sentence', async (raised, sentence, constant) => {
    raises(raised, raised === 'component_not_in_warehouse' ? 'item-7' : undefined);
    await expect(service().assemble('b-1', 2, 'wh-1')).rejects.toMatchObject({
      code: 'validation_error',
      message: sentence,
    });
    expect(constant).toBe(sentence);
    expect(rpc).toHaveBeenCalledWith(
      'assemble_bundle',
      expect.objectContaining({ p_bundle_id: 'b-1', p_quantity: 2, p_warehouse_id: 'wh-1' }),
    );
  });

  it('still maps insufficient_stock and forbidden as before', async () => {
    raises('insufficient_stock', 'item-7');
    await expect(service().assemble('b-1', 2, 'wh-1')).rejects.toMatchObject({
      code: 'validation_error',
      message:
        'Not enough stock to assemble this many kits. Lower the quantity or top up the short components.',
    });
    rpc.mockResolvedValue({ data: null, error: { message: 'forbidden', code: '42501' } });
    await expect(service().assemble('b-1', 2, 'wh-1')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Permission denied',
    });
  });
});

describe('BundlesService.distribute — 0365 refusals', () => {
  it('maps component_not_visible to a validation_error sentence', async () => {
    raises('component_not_visible');
    await expect(
      service().distribute('b-1', { quantity: 3, warehouseId: 'wh-1' }),
    ).rejects.toMatchObject({ code: 'validation_error', message: BUNDLE_COMPONENT_NOT_VISIBLE });
    expect(rpc).toHaveBeenCalledWith(
      'distribute_bundle',
      expect.objectContaining({ p_bundle_id: 'b-1', p_quantity: 3, p_warehouse_id: 'wh-1' }),
    );
  });

  it('leaves an unknown error as internal_error', async () => {
    raises('something_else');
    await expect(
      service().distribute('b-1', { quantity: 3, warehouseId: 'wh-1' }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
