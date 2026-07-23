import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { InventoryService } from './inventory';

// ---------------------------------------------------------------------------
// itemMovementHistory() answers the owner's 2026-07-22 question ("who moved
// them, when, where, why") by rendering the ledger AS IT IS. It must NOT infer
// a single winning source — the two attempts that did were reverted for
// regressing stagedWorklist. The rows below are the owner's REAL data for SKU
// SP-0WK2L-LY1 (org 63c13e64…), pulled from prod, so these tests pin the exact
// story the screen has to tell.
// ---------------------------------------------------------------------------

const ITEM = '5f3538ee-3fe8-4fe6-aecb-b88cde7e1c3a';
const WH = 'eab527b5-f68d-4d0b-b997-a853328bfa07';
const STAGING_LOC = 'de9684f7-3cbe-4f9f-9afd-93b5837607fb';
const RACK_37B = '28092906-ece8-4400-9e1c-50bcb2fa5237';

// Real receipt ids from the owner's case.
const R_POSTED = '0bbed45a-857b-468c-ada4-353f31aff1a8';
const R_REVERSED = 'e729bb07-cdba-45b4-9c9b-b76e8f5279de';
const R_REVERSAL = 'bf5cb04c-ed29-4c97-aa49-34cfc0745590';

const ANDREW = { id: '161bffb1-4e97-47a4-b9d3-c8e0e3b8640f', full_name: 'Andrew Rosas', email: 'arosas@cvwest.org' };
const PETER = { id: '6c6fbde6-291b-4af7-9484-29468553a434', full_name: 'Peter Pete', email: 'pmathis@cvsouth.org' };

const ITEM_ROW = {
  id: ITEM,
  name: 'Science Dimensions Earth & Space Science',
  sku: 'SP-0WK2L-LY1',
  warehouse_id: WH,
  deleted_at: null,
};

/** Movement rows shaped exactly as PostgREST returns them (numeric columns
 *  arrive as strings from Postgres NUMERIC, actor as an embedded object). */
const REAL_MOVEMENTS: Array<Record<string, unknown>> = [
  {
    id: '981911f8-97b5-4091-a484-bfca06777e88',
    created_at: '2026-07-22T22:21:44.373907Z',
    movement_type: 'transfer',
    quantity_change: '0.0000',
    previous_quantity: '54.0000',
    new_quantity: '54.0000',
    moved_quantity: '10',
    from_location_id: STAGING_LOC,
    to_location_id: RACK_37B,
    reason: null,
    notes: null,
    user_id: ANDREW.id,
    actor: ANDREW,
  },
  {
    id: '27381ab0-a335-40bc-a975-0c32a0cf6c3f',
    created_at: '2026-07-22T22:20:53.602234Z',
    movement_type: 'remove',
    quantity_change: '-10.0000',
    previous_quantity: '64.0000',
    new_quantity: '54.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: 'added incorrectly ',
    notes: null,
    user_id: ANDREW.id,
    actor: ANDREW,
  },
  {
    id: '5543d8c2-f58d-4ad4-bec6-0516e28ad931',
    created_at: '2026-07-22T21:13:46.343836Z',
    movement_type: 'add',
    quantity_change: '10.0000',
    previous_quantity: '54.0000',
    new_quantity: '64.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: 'Adding new stock into inventory. ',
    notes: null,
    user_id: PETER.id,
    actor: PETER,
  },
  {
    id: '9be2a106-3342-41fc-a1df-3274876339c2',
    created_at: '2026-07-22T17:56:00.525970Z',
    movement_type: 'receive_po',
    quantity_change: '20.0000',
    previous_quantity: '34.0000',
    new_quantity: '54.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: STAGING_LOC,
    reason: 'PO CVW-002201',
    notes: R_POSTED,
    user_id: ANDREW.id,
    actor: ANDREW,
  },
  {
    id: '65db542e-0236-405b-a392-aa5563ae5901',
    created_at: '2026-06-24T22:32:17.415490Z',
    movement_type: 'correction',
    quantity_change: '-90.0000',
    previous_quantity: '129.0000',
    new_quantity: '39.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: 'receipt_reversal',
    notes: R_REVERSAL,
    user_id: ANDREW.id,
    actor: ANDREW,
  },
  {
    id: 'e2989d99-b97a-4903-ae72-42636f0ae7b7',
    created_at: '2026-06-24T21:41:23.484364Z',
    movement_type: 'receive_po',
    quantity_change: '90.0000',
    previous_quantity: '39.0000',
    new_quantity: '129.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: 'receipt_line',
    notes: R_REVERSED,
    user_id: ANDREW.id,
    actor: ANDREW,
  },
  {
    id: 'aea94f7c-32fc-4fe6-89cd-9d1275e2fad4',
    created_at: '2026-05-06T22:22:09.151744Z',
    movement_type: 'initial',
    quantity_change: '1.0000',
    previous_quantity: '0.0000',
    new_quantity: '1.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: null,
    notes: null,
    // A system/trigger write: no user_id, no embedded actor.
    user_id: null,
    actor: null,
  },
];

const REAL_RECEIPTS = [
  {
    id: R_POSTED,
    receipt_number: 'R-20260722-175600-e56648',
    status: 'posted',
    reversed_receipt_id: null,
    reversal_reason: null,
    purchase_orders: { po_number: 'CVW-002201', status: 'received' },
  },
  {
    id: R_REVERSED,
    receipt_number: 'R-20260624-214123-168444',
    status: 'reversed',
    reversed_receipt_id: null,
    reversal_reason: null,
    purchase_orders: { po_number: 'CVW-002202', status: 'cancelled' },
  },
  {
    id: R_REVERSAL,
    receipt_number: 'R-20260624-214123-168444-REV',
    status: 'reversal',
    reversed_receipt_id: R_REVERSED,
    reversal_reason: 'Wrong rack entered',
    purchase_orders: { po_number: 'CVW-002202', status: 'cancelled' },
  },
];

const REAL_LOCATIONS = [
  { id: STAGING_LOC, name: 'Staging' },
  { id: RACK_37B, name: '37-B' },
];

function stubFor(
  movements: Array<Record<string, unknown>> = REAL_MOVEMENTS,
  overrides: Record<string, unknown> = {},
) {
  return makeSupabaseStub({
    'inventory_items.select': { data: [ITEM_ROW], error: null },
    // Manager-or-above access path reads warehouses for readableIds.
    'warehouses.select': { data: [{ id: WH }], error: null },
    'stock_movements.select': { data: movements, error: null, count: movements.length },
    'locations.select': { data: REAL_LOCATIONS, error: null },
    'receipts.select': { data: REAL_RECEIPTS, error: null },
    ...overrides,
  });
}

function svcFor(stub: ReturnType<typeof makeSupabaseStub>) {
  return new InventoryService(makeServiceContext(stub.client, { organizationId: 'org-test' }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('InventoryService.itemMovementHistory — the owner’s real SP-0WK2L-LY1 story', () => {
  it('returns the movements newest-first with who/when/what/where/why on each', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });

    expect(page.itemSku).toBe('SP-0WK2L-LY1');
    expect(page.rows.map((r) => r.id)).toEqual(REAL_MOVEMENTS.map((m) => m.id));

    // The manual add the colleague made, and the manager's reversal of it.
    const add = page.rows.find((r) => r.movementType === 'add')!;
    expect(add.actorName).toBe('Peter Pete');
    expect(add.actorEmail).toBe('pmathis@cvsouth.org');
    expect(add.quantityChange).toBe(10);
    expect(add.previousQuantity).toBe(54);
    expect(add.newQuantity).toBe(64);
    expect(add.note).toBe('Adding new stock into inventory.');
    expect(add.at).toBe('2026-07-22T21:13:46.343836Z');

    const removal = page.rows.find((r) => r.movementType === 'remove')!;
    expect(removal.actorName).toBe('Andrew Rosas');
    expect(removal.quantityChange).toBe(-10);
    expect(removal.note).toBe('added incorrectly');
  });

  it('resolves location NAMES, not ids, on both sides of a transfer', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const transfer = page.rows.find((r) => r.movementType === 'transfer')!;
    expect(transfer.fromLocationName).toBe('Staging');
    expect(transfer.toLocationName).toBe('37-B');
    // quantity_change is ALWAYS 0 for a transfer; the physical qty is separate.
    expect(transfer.quantityChange).toBe(0);
    expect(transfer.movedQuantity).toBe(10);
  });

  it('carries receipt number + status and PO number + status for a posted receipt', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const received = page.rows.find((r) => r.id === '9be2a106-3342-41fc-a1df-3274876339c2')!;
    expect(received.receiptNumber).toBe('R-20260722-175600-e56648');
    expect(received.receiptStatus).toBe('posted');
    expect(received.poNumber).toBe('CVW-002201');
    expect(received.poStatus).toBe('received');
    expect(received.toLocationName).toBe('Staging');
    expect(received.reversal).toBeNull();
  });

  it('links the received-then-reversed pair in BOTH directions (rule 3)', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const original = page.rows.find((r) => r.id === 'e2989d99-b97a-4903-ae72-42636f0ae7b7')!;
    const undo = page.rows.find((r) => r.id === '65db542e-0236-405b-a392-aa5563ae5901')!;

    expect(original.reversal).toEqual({
      role: 'reversed',
      counterpartMovementId: undo.id,
      counterpartReceiptNumber: 'R-20260624-214123-168444-REV',
    });
    expect(original.reversalReason).toBe('Wrong rack entered');

    expect(undo.reversal).toEqual({
      role: 'reversal',
      counterpartMovementId: original.id,
      counterpartReceiptNumber: 'R-20260624-214123-168444',
    });
    expect(undo.reversalReason).toBe('Wrong rack entered');

    // The pair nets to zero — that is what makes it readable as a pair.
    expect(original.quantityChange + undo.quantityChange).toBe(0);
  });

  it('renders no actor for a system/trigger write (rule 5)', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const opening = page.rows.find((r) => r.movementType === 'initial')!;
    expect(opening.actorName).toBeNull();
    expect(opening.actorEmail).toBeNull();
  });
});

describe('InventoryService.itemMovementHistory — rule 2: no internal tokens, no UUIDs', () => {
  it("never promotes 'receipt_line' / 'receipt_reversal' or the receipt uuid into note", async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    for (const r of page.rows) {
      expect(r.note).not.toBe('receipt_line');
      expect(r.note).not.toBe('receipt_reversal');
      if (r.note !== null) expect(r.note).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
    expect(page.rows.find((r) => r.id === 'e2989d99-b97a-4903-ae72-42636f0ae7b7')!.note).toBeNull();
    expect(page.rows.find((r) => r.id === '65db542e-0236-405b-a392-aa5563ae5901')!.note).toBeNull();
  });

  it("never promotes the machine-composed 'PO {number}' reason into note", async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const received = page.rows.find((r) => r.id === '9be2a106-3342-41fc-a1df-3274876339c2')!;
    expect(received.note).toBeNull();
    // …but the PO is still stated, structurally.
    expect(received.poNumber).toBe('CVW-002201');
  });
});

describe('InventoryService.itemMovementHistory — rule 1: return rows are not customer returns', () => {
  it("hands a cancel_order_request 'return' row over as-is, with the record's own reason", async () => {
    const cancelRestock = {
      id: 'ret-1',
      created_at: '2026-07-10T20:17:56.097094Z',
      movement_type: 'return',
      quantity_change: '50.0000',
      previous_quantity: '10.0000',
      new_quantity: '60.0000',
      moved_quantity: null,
      from_location_id: null,
      to_location_id: null,
      // cancel_order_request writes exactly this.
      reason: 'Order cancelled (order_request 1d265b37-4b5c-49bb-bc12-07b0ad270cff)',
      notes: null,
      user_id: ANDREW.id,
      actor: ANDREW,
    };
    const page = await svcFor(stubFor([cancelRestock])).itemMovementHistory({ itemId: ITEM });
    const row = page.rows[0]!;
    expect(row.movementType).toBe('return');
    // The reason survives as prose, minus the raw order_request uuid.
    expect(row.note).toBe('Order cancelled');
    // Nothing anywhere on the row asserts a customer.
    expect(JSON.stringify(row).toLowerCase()).not.toContain('customer');
  });
});

describe('InventoryService.itemMovementHistory — pagination', () => {
  it('over-fetches exactly one row past the window to decide hasMore', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      ...REAL_MOVEMENTS[0]!,
      id: `m-${i}`,
    }));
    const stub = stubFor(many, {
      'stock_movements.select': { data: many, error: null, count: 214 },
    });
    const page = await svcFor(stub).itemMovementHistory({ itemId: ITEM });

    expect(page.limit).toBe(50);
    expect(page.rows).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    // The exact total comes from a head count, so the surface never has to
    // guess how much history exists.
    expect(page.total).toBe(214);
  });

  it('reports hasMore=false when the window is not full', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    expect(page.hasMore).toBe(false);
    expect(page.rows).toHaveLength(REAL_MOVEMENTS.length);
  });

  it('offsets the range so "ask for more" reads the NEXT window, newest-first', async () => {
    const stub = stubFor();
    await svcFor(stub).itemMovementHistory({ itemId: ITEM, limit: 25, offset: 50 });
    const chain = stub.chainsAll.get('stock_movements.select')!;
    const args = stub.chainArgsAll.get('stock_movements.select')!;
    // chain[0] is the head count; chain[1] is the windowed page fetch.
    const pageChain = chain[1]!;
    const pageArgs = args[1]!;
    const rangeIdx = pageChain.indexOf('range');
    expect(pageArgs[rangeIdx]).toEqual([50, 75]);
    // A deterministic secondary sort is REQUIRED: without it the same row can
    // land on two pages or none (two of the owner's movements share created_at
    // to the microsecond).
    const orderArgs = pageChain
      .map((m, i) => (m === 'order' ? pageArgs[i] : null))
      .filter(Boolean);
    expect(orderArgs).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('does NOT rely on an implicit server cap: a >1000 window keeps paging', async () => {
    // The stub returns a FULL 1000-row page on the first call and a short page
    // on the second — fetchAllRows must ask twice rather than stopping at the
    // PostgREST max_rows ceiling (the defect that got attempt #1 reverted).
    const full = Array.from({ length: 1000 }, (_, i) => ({ ...REAL_MOVEMENTS[0]!, id: `a-${i}` }));
    const rest = Array.from({ length: 200 }, (_, i) => ({ ...REAL_MOVEMENTS[0]!, id: `b-${i}` }));
    let call = 0;
    const stub = stubFor(REAL_MOVEMENTS, {
      'stock_movements.select': () => {
        call += 1;
        // call 1 = head count, calls 2+ = the paged window.
        if (call === 1) return { data: [], error: null, count: 5000 };
        return { data: call === 2 ? full : rest, error: null, count: 5000 };
      },
    });
    const page = await svcFor(stub).itemMovementHistory({ itemId: ITEM, limit: 1200 });
    expect(page.rows).toHaveLength(1200);
    expect(page.hasMore).toBe(false);
    // Head count + two windows.
    expect(stub.chainsAll.get('stock_movements.select')).toHaveLength(3);
  });

  it('clamps a hostile limit rather than letting a caller ask for the whole ledger', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM, limit: 999_999 });
    expect(page.limit).toBe(2000);
  });
});

describe('InventoryService.itemMovementHistory — batching and access', () => {
  it('resolves actors, locations and receipts in ONE query each, never per movement', async () => {
    const stub = stubFor();
    await svcFor(stub).itemMovementHistory({ itemId: ITEM });
    // Actors come from the user_profiles EMBED on the movement select — no
    // separate user_profiles query at all.
    expect(stub.fromCalls.filter((t) => t === 'user_profiles')).toHaveLength(0);
    expect(stub.fromCalls.filter((t) => t === 'locations')).toHaveLength(1);
    expect(stub.fromCalls.filter((t) => t === 'receipts')).toHaveLength(1);
    // 7 movements, 2 distinct locations, 3 distinct receipts — still 1 each.
    expect(stub.fromCalls.filter((t) => t === 'stock_movements')).toHaveLength(2);
  });

  it('404s an item that is missing or soft-deleted', async () => {
    const missing = stubFor(REAL_MOVEMENTS, { 'inventory_items.select': { data: [], error: null } });
    await expect(svcFor(missing).itemMovementHistory({ itemId: ITEM })).rejects.toMatchObject({
      code: 'not_found',
    });

    const deleted = stubFor(REAL_MOVEMENTS, {
      'inventory_items.select': { data: [{ ...ITEM_ROW, deleted_at: '2026-07-01T00:00:00Z' }], error: null },
    });
    await expect(svcFor(deleted).itemMovementHistory({ itemId: ITEM })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses an item in a warehouse the caller cannot read', async () => {
    const stub = stubFor(REAL_MOVEMENTS, {
      'inventory_items.select': { data: [{ ...ITEM_ROW, warehouse_id: 'other-wh' }], error: null },
      'user_warehouse_assignments.select': { data: [], error: null },
    });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { role: 'staff', organizationId: 'org-test' }),
    );
    await expect(svc.itemMovementHistory({ itemId: ITEM })).rejects.toThrow(/warehouse/i);
  });

  it('still returns the movements when the location lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = stubFor(REAL_MOVEMENTS, {
      'locations.select': { data: null, error: { message: 'boom' } },
    });
    const page = await svcFor(stub).itemMovementHistory({ itemId: ITEM });
    expect(page.rows).toHaveLength(REAL_MOVEMENTS.length);
    // Degrades to no route rather than leaking a raw location uuid.
    expect(page.rows.find((r) => r.movementType === 'transfer')!.fromLocationName).toBeNull();
  });

  it('still returns the movements when the receipt/PO lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = stubFor(REAL_MOVEMENTS, {
      'receipts.select': { data: null, error: { message: 'boom' } },
    });
    const page = await svcFor(stub).itemMovementHistory({ itemId: ITEM });
    expect(page.rows).toHaveLength(REAL_MOVEMENTS.length);
    const received = page.rows.find((r) => r.id === '9be2a106-3342-41fc-a1df-3274876339c2')!;
    expect(received.receiptNumber).toBeNull();
    expect(received.poNumber).toBeNull();
    expect(received.note).toBeNull();
  });
});
