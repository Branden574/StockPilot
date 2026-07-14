import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// stampPlacementBin composes the placement LABEL a put-away writes and hands it
// to the inventory_set_rack RPC — the SAME label the "Set rack" path writes, so
// bin_location tracks the rack after a Staging put-away (owner gap 2026-07-14).
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

function svcWith(rpc: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({ 'rpc:inventory_set_rack': rpc });
  return { svc: new InventoryService(makeServiceContext(stub.client)), stub };
}

describe('InventoryService.stampPlacementBin', () => {
  it('rack with a row → bin "num-row", row upper-cased', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'rack',
      rackNumber: '1',
      rackRow: 'a',
      name: '1-A',
    });
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_rack');
    expect(call!.args).toMatchObject({
      p_item_ids: ['item-1'],
      p_rack_number: '1',
      p_rack_row: 'A',
      p_bin_location: '1-A',
      p_scope: 'auto',
    });
  });

  it('rack with no row → bin is just the number', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'rack',
      rackNumber: 'Z9',
      rackRow: null,
      name: 'Z9',
    });
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_rack_number: 'Z9',
      p_rack_row: null,
      p_bin_location: 'Z9',
    });
  });

  it('crate → label is the location name, no rack_* keys', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: 'Blue Crate 3',
    });
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_rack_number: null,
      p_rack_row: null,
      p_bin_location: 'Blue Crate 3',
    });
  });

  it('no items → never calls the RPC', async () => {
    const { svc, stub } = svcWith({ data: 0, error: null });
    await svc.stampPlacementBin([], {
      kind: 'rack',
      rackNumber: '1',
      rackRow: 'A',
      name: '1-A',
    });
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(false);
  });

  it('is best-effort — an RPC error is swallowed, never thrown', async () => {
    const { svc } = svcWith({ data: null, error: { message: 'boom' } });
    await expect(
      svc.stampPlacementBin(['item-1'], {
        kind: 'rack',
        rackNumber: '1',
        rackRow: 'A',
        name: '1-A',
      }),
    ).resolves.toBeUndefined();
  });
});
