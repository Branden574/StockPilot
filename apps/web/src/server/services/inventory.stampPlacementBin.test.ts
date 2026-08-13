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

function svcWith(
  rpc: { data: unknown; error: { message: string } | null },
  // The SECOND writer (migration 0335). A destination that states a rack
  // position goes through inventory_set_rack; a crate that states none goes
  // through inventory_set_bin_location, which writes the label ALONE because
  // inventory_set_rack deletes the rack pair when both rack args are null.
  binRpc: { data: unknown; error: { message: string } | null } = { data: 1, error: null },
) {
  const stub = makeSupabaseStub({
    'rpc:inventory_set_rack': rpc,
    'rpc:inventory_set_bin_location': binRpc,
  });
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

  // ═══ A POSITION-LESS CRATE: THE LABEL, AND ONLY THE LABEL ═══
  //
  // This case previously asserted `writes NOTHING — it never clears the rack
  // keys`, and that assertion PINNED a defect of its own. Leaving the rack pair
  // alone is right (a PARTIAL put-away leaves the rest of the stock on a rack
  // the operator never mentioned, and production's blue "Blue Shelf" books
  // legitimately have rack NULL). Skipping bin_location was not: EVERY crate in
  // production today is position-less, so writing nothing left the item labelled
  // with its PREVIOUS location — a book moved into "Gray #BIN" still reading
  // '40-B' on the pick slip, the packing slip, the count sheet, the snapshot
  // report and the mobile lookup. The two cases below pin BOTH halves.

  it('a crate with NO position writes its NAME as the label and leaves the rack pair alone', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: 'Blue #Shelf',
      crateColor: 'blue',
      crateNumber: 'Shelf',
    });
    // The pair: untouched. inventory_set_rack deletes it when both rack
    // arguments are null (0068), so the only safe thing is not to call it.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(false);
    // The label: written, through the narrow 0335 writer.
    const call = stub.rpcCalls.find((c) => c.name === 'inventory_set_bin_location');
    expect(call).toBeDefined();
    expect(call!.args).toEqual({ p_item_ids: ['item-1'], p_bin_location: 'Blue #Shelf' });
    // Literal-pinned argument LIST: a rack-shaped argument appearing here would
    // mean someone widened the label writer back into a rack writer.
    expect(Object.keys(call!.args as Record<string, unknown>).sort()).toEqual([
      'p_bin_location',
      'p_item_ids',
    ]);
  });

  it('a crate carrying only a ROW is still position-less — the label is written, the row is not', async () => {
    // A row does not name a rack, so it cannot be stamped as one.
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: 'B',
      name: 'Blue #4',
    });
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(false);
    expect(stub.rpcCalls.find((c) => c.name === 'inventory_set_bin_location')!.args).toEqual({
      p_item_ids: ['item-1'],
      p_bin_location: 'Blue #4',
    });
  });

  it('labels a NON-BOOK the same way — the label writer is item-type blind', async () => {
    // The worst case the early return created: inventory_set_book_storage (0334)
    // is `item_type = 'book'` only, so a Chromebook put away from staging into
    // "Blue Shelf" had NO record of that crate anywhere — not a summary, not a
    // label. The 0335 writer is scoped by id alone, so the same single call
    // covers books and non-books; nothing here may narrow it to books.
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['chromebook-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: 'Blue Shelf',
      crateColor: 'blue',
      crateNumber: 'Shelf',
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['inventory_set_bin_location']);
    expect(stub.rpcCalls[0]!.args).toEqual({
      p_item_ids: ['chromebook-1'],
      p_bin_location: 'Blue Shelf',
    });
    // Never a books-only SUMMARY writer, and never a scoped rack call. Both
    // names are pinned because the summary's writer changed: 0334 wrote the
    // crate pair, 0336 writes the crate pair AND the rack pair, and either one
    // reached from here would make a put-away's LABEL and the holdings-derived
    // SUMMARY the same call — which is exactly the coupling that forced one
    // unconditional answer about the rack pair for every destination.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_storage')).toBe(false);
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_book_placement')).toBe(false);
    expect(stub.rpcCalls[0]!.args).not.toHaveProperty('p_scope');
  });

  it('a POSITIONED crate does NOT use the label-only writer — it states a rack, so it writes one', async () => {
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: '38',
      rackRow: 'B',
      name: 'Blue #13 on rack 38-B',
    });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['inventory_set_rack']);
  });

  it('a nameless destination writes no label — "nothing to say" is not "clear it"', async () => {
    // inventory_set_bin_location honours a NULL by erasing the label the item
    // already carries, so a destination with no name must not reach it.
    const { svc, stub } = svcWith({ data: 1, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: '   ',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('the label stamp is best-effort — an RPC error is swallowed, never thrown', async () => {
    const { svc } = svcWith({ data: 1, error: null }, { data: null, error: { message: 'boom' } });
    await expect(
      svc.stampPlacementBin(['item-1'], {
        kind: 'crate',
        rackNumber: null,
        rackRow: null,
        name: 'Blue #Shelf',
      }),
    ).resolves.toBeUndefined();
  });

  it('warns when the label stamp matched NO rows — a write that fails open is not a write', async () => {
    // RLS filtering every row returns 0, not an error. Reporting nothing there
    // is how "the label is stale" becomes invisible.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc } = svcWith({ data: 1, error: null }, { data: 0, error: null });
    await svc.stampPlacementBin(['item-1'], {
      kind: 'crate',
      rackNumber: null,
      rackRow: null,
      name: 'Blue #Shelf',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched no rows'));
    warn.mockRestore();
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
