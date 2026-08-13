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

  // ═══ A CRATE SITS ON A RACK ═══
  //
  // This block used to contain ONE case — "crate → label is the location name,
  // no rack_* keys" — asserting p_rack_number: null for every crate. That
  // assertion pinned the defect: inventory_set_rack (0068) DELETES the rack
  // keys when both are null, so a book put away into crate 13 came out
  // recorded in "Blue 13" with an EMPTY rack column. It is replaced by the two
  // cases below, which distinguish a crate that states a rack from one that
  // states nothing.

  it('a POSITIONED crate stamps the rack it sits on, and its own name as the label', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: '38',
      rackRow: 'b',
      name: 'Blue #13 on rack 38-B',
      crateColor: 'blue',
      crateNumber: '13',
    });
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_rack_number: '38',
      p_rack_row: 'B',
      p_bin_location: 'Blue #13 on rack 38-B',
    });
  });

  it('a positioned crate DECOMPOSES a composite pair, exactly as a rack does', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: '43-B',
      rackRow: null,
      name: 'Gray #BIN on rack 43-B',
    });
    expect(stub.rpcCalls[0]!.args).toMatchObject({ p_rack_number: '43', p_rack_row: 'B' });
  });

  it('a crate with NO position writes NOTHING — it never clears the rack keys', async () => {
    // The destination asserts nothing about a rack, and a PARTIAL put-away
    // leaves the rest of the stock on the rack the operator never mentioned —
    // so clearing would publish "on no rack" about a book that is. Production
    // holds this shape: blue "Blue Shelf", 5 books, rack NULL.
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: 'Blue #Shelf',
      crateColor: 'blue',
      crateNumber: 'Shelf',
    });
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(false);
  });

  it('a crate carrying only a ROW is still position-less — no write', async () => {
    // A row does not name a rack, so it cannot be stamped as one.
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: 'B',
      name: 'Blue #4',
    });
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(false);
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
