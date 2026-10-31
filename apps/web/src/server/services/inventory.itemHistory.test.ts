import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { InventoryService } from './inventory';

// ---------------------------------------------------------------------------
// itemMovementHistory() answers the owner's 2026-07-22 question ("who moved
// them, when, where, why") by rendering the ledger AS IT IS. It must NOT infer
// a single winning source — the two attempts that did were reverted for
// regressing stagedWorklist. The rows below model the owner's report for one
// SKU: the people, ids, item, notes, receipt and PO numbers are synthetic, and
// the times and quantities keep the incident's shape, so these tests pin the
// exact story the screen has to tell.
// ---------------------------------------------------------------------------

const ITEM = '50000010-0000-4000-8000-000000000010';
const WH = 'e000001e-0000-4000-8000-00000000001e';
const STAGING_LOC = 'd000001b-0000-4000-8000-00000000001b';
const RACK_37B = '20000008-0000-4000-8000-000000000008';

// Receipt ids for the owner's case (synthetic).
const R_POSTED = '00000001-0000-4000-8000-000000000001';
const R_REVERSED = 'e000001d-0000-4000-8000-00000000001d';
const R_REVERSAL = 'b0000019-0000-4000-8000-000000000019';

const JORDAN = { id: '10000003-0000-4000-8000-000000000003', full_name: 'Jordan Stone', email: 'jstone@site1.test' };
const PAT = { id: '60000013-0000-4000-8000-000000000013', full_name: 'Pat Tester', email: 'ptester@school.test' };

const ITEM_ROW = {
  id: ITEM,
  name: 'Exploring Earth & Space Science: Level 8',
  sku: 'SP-0DEM2-BK1',
  warehouse_id: WH,
  deleted_at: null,
};

/** Movement rows shaped exactly as PostgREST returns them (numeric columns
 *  arrive as strings from Postgres NUMERIC, actor as an embedded object). */
const INCIDENT_MOVEMENTS: Array<Record<string, unknown>> = [
  {
    id: '90000014-0000-4000-8000-000000000014',
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
    user_id: JORDAN.id,
    actor: JORDAN,
  },
  {
    id: '20000007-0000-4000-8000-000000000007',
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
    user_id: JORDAN.id,
    actor: JORDAN,
  },
  {
    id: '5000000d-0000-4000-8000-00000000000d',
    created_at: '2026-07-22T21:13:46.343836Z',
    movement_type: 'add',
    quantity_change: '10.0000',
    previous_quantity: '54.0000',
    new_quantity: '64.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: null,
    reason: 'Added new stock to the shelf. ',
    notes: null,
    user_id: PAT.id,
    actor: PAT,
  },
  {
    id: '90000015-0000-4000-8000-000000000015',
    created_at: '2026-07-22T17:56:00.525970Z',
    movement_type: 'receive_po',
    quantity_change: '20.0000',
    previous_quantity: '34.0000',
    new_quantity: '54.0000',
    moved_quantity: null,
    from_location_id: null,
    to_location_id: STAGING_LOC,
    reason: 'PO DEMO-002201',
    notes: R_POSTED,
    user_id: JORDAN.id,
    actor: JORDAN,
  },
  {
    id: '60000011-0000-4000-8000-000000000011',
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
    user_id: JORDAN.id,
    actor: JORDAN,
  },
  {
    id: 'e000001c-0000-4000-8000-00000000001c',
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
    user_id: JORDAN.id,
    actor: JORDAN,
  },
  {
    id: 'a0000017-0000-4000-8000-000000000017',
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

const INCIDENT_RECEIPTS = [
  {
    id: R_POSTED,
    receipt_number: 'R-20260722-175600-0a0a01',
    status: 'posted',
    reversed_receipt_id: null,
    reversal_reason: null,
    purchase_orders: { po_number: 'DEMO-002201', status: 'received' },
  },
  {
    id: R_REVERSED,
    receipt_number: 'R-20260624-214123-0c0c03',
    status: 'reversed',
    reversed_receipt_id: null,
    reversal_reason: null,
    purchase_orders: { po_number: 'DEMO-002202', status: 'cancelled' },
  },
  {
    id: R_REVERSAL,
    receipt_number: 'R-20260624-214123-0c0c03-REV',
    status: 'reversal',
    reversed_receipt_id: R_REVERSED,
    reversal_reason: 'Wrong rack entered',
    purchase_orders: { po_number: 'DEMO-002202', status: 'cancelled' },
  },
];

const INCIDENT_LOCATIONS = [
  { id: STAGING_LOC, name: 'Staging' },
  { id: RACK_37B, name: '37-B' },
];

function stubFor(
  movements: Array<Record<string, unknown>> = INCIDENT_MOVEMENTS,
  overrides: Record<string, unknown> = {},
) {
  return makeSupabaseStub({
    'inventory_items.select': { data: [ITEM_ROW], error: null },
    // Manager-or-above access path reads warehouses for readableIds.
    'warehouses.select': { data: [{ id: WH }], error: null },
    'stock_movements.select': { data: movements, error: null, count: movements.length },
    'locations.select': { data: INCIDENT_LOCATIONS, error: null },
    'receipts.select': { data: INCIDENT_RECEIPTS, error: null },
    ...overrides,
  });
}

function svcFor(stub: ReturnType<typeof makeSupabaseStub>) {
  return new InventoryService(makeServiceContext(stub.client, { organizationId: 'org-test' }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('InventoryService.itemMovementHistory — the owner’s SP-0DEM2-BK1 story', () => {
  it('returns the movements newest-first with who/when/what/where/why on each', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });

    expect(page.itemSku).toBe('SP-0DEM2-BK1');
    expect(page.rows.map((r) => r.id)).toEqual(INCIDENT_MOVEMENTS.map((m) => m.id));

    // The manual add the colleague made, and the manager's reversal of it.
    const add = page.rows.find((r) => r.movementType === 'add')!;
    expect(add.actorName).toBe('Pat Tester');
    expect(add.actorEmail).toBe('ptester@school.test');
    expect(add.quantityChange).toBe(10);
    expect(add.previousQuantity).toBe(54);
    expect(add.newQuantity).toBe(64);
    expect(add.note).toBe('Added new stock to the shelf.');
    expect(add.at).toBe('2026-07-22T21:13:46.343836Z');

    const removal = page.rows.find((r) => r.movementType === 'remove')!;
    expect(removal.actorName).toBe('Jordan Stone');
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
    const received = page.rows.find((r) => r.id === '90000015-0000-4000-8000-000000000015')!;
    expect(received.receiptNumber).toBe('R-20260722-175600-0a0a01');
    expect(received.receiptStatus).toBe('posted');
    expect(received.poNumber).toBe('DEMO-002201');
    expect(received.poStatus).toBe('received');
    expect(received.toLocationName).toBe('Staging');
    expect(received.reversal).toBeNull();
  });

  it('links the received-then-reversed pair in BOTH directions (rule 3)', async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const original = page.rows.find((r) => r.id === 'e000001c-0000-4000-8000-00000000001c')!;
    const undo = page.rows.find((r) => r.id === '60000011-0000-4000-8000-000000000011')!;

    expect(original.reversal).toEqual({
      role: 'reversed',
      counterpartMovementId: undo.id,
      counterpartReceiptNumber: 'R-20260624-214123-0c0c03-REV',
    });
    expect(original.reversalReason).toBe('Wrong rack entered');

    expect(undo.reversal).toEqual({
      role: 'reversal',
      counterpartMovementId: original.id,
      counterpartReceiptNumber: 'R-20260624-214123-0c0c03',
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

  // 0393: rule 5's one exception. A row whose marker records that its actor
  // deleted their account was written by a person: "Deleted user".
  it('names an actor who deleted their account "Deleted user" (the row is stamped), unlike a system write', async () => {
    const stamped = {
      ...INCIDENT_MOVEMENTS[0]!,
      id: 'del-1',
      user_id: null,
      actor: null,
      deleted_users: { user_id: '2026-11-04T00:00:00+00:00' },
    };
    const page = await svcFor(stubFor([stamped])).itemMovementHistory({ itemId: ITEM });
    expect(page.rows[0]!.actorName).toBe('Deleted user');
    expect(page.rows[0]!.actorEmail).toBeNull();
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
    expect(page.rows.find((r) => r.id === 'e000001c-0000-4000-8000-00000000001c')!.note).toBeNull();
    expect(page.rows.find((r) => r.id === '60000011-0000-4000-8000-000000000011')!.note).toBeNull();
  });

  it("never promotes the machine-composed 'PO {number}' reason into note", async () => {
    const page = await svcFor(stubFor()).itemMovementHistory({ itemId: ITEM });
    const received = page.rows.find((r) => r.id === '90000015-0000-4000-8000-000000000015')!;
    expect(received.note).toBeNull();
    // …but the PO is still stated, structurally.
    expect(received.poNumber).toBe('DEMO-002201');
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
      reason: 'Order cancelled (order_request 10000004-0000-4000-8000-000000000004)',
      notes: null,
      user_id: JORDAN.id,
      actor: JORDAN,
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
      ...INCIDENT_MOVEMENTS[0]!,
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
    expect(page.rows).toHaveLength(INCIDENT_MOVEMENTS.length);
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
    const full = Array.from({ length: 1000 }, (_, i) => ({ ...INCIDENT_MOVEMENTS[0]!, id: `a-${i}` }));
    const rest = Array.from({ length: 200 }, (_, i) => ({ ...INCIDENT_MOVEMENTS[0]!, id: `b-${i}` }));
    let call = 0;
    const stub = stubFor(INCIDENT_MOVEMENTS, {
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
    const missing = stubFor(INCIDENT_MOVEMENTS, { 'inventory_items.select': { data: [], error: null } });
    await expect(svcFor(missing).itemMovementHistory({ itemId: ITEM })).rejects.toMatchObject({
      code: 'not_found',
    });

    const deleted = stubFor(INCIDENT_MOVEMENTS, {
      'inventory_items.select': { data: [{ ...ITEM_ROW, deleted_at: '2026-07-01T00:00:00Z' }], error: null },
    });
    await expect(svcFor(deleted).itemMovementHistory({ itemId: ITEM })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses an item in a warehouse the caller cannot read', async () => {
    const stub = stubFor(INCIDENT_MOVEMENTS, {
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
    const stub = stubFor(INCIDENT_MOVEMENTS, {
      'locations.select': { data: null, error: { message: 'boom' } },
    });
    const page = await svcFor(stub).itemMovementHistory({ itemId: ITEM });
    expect(page.rows).toHaveLength(INCIDENT_MOVEMENTS.length);
    // Degrades to no route rather than leaking a raw location uuid.
    expect(page.rows.find((r) => r.movementType === 'transfer')!.fromLocationName).toBeNull();
  });

  it('still returns the movements when the receipt/PO lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = stubFor(INCIDENT_MOVEMENTS, {
      'receipts.select': { data: null, error: { message: 'boom' } },
    });
    const page = await svcFor(stub).itemMovementHistory({ itemId: ITEM });
    expect(page.rows).toHaveLength(INCIDENT_MOVEMENTS.length);
    const received = page.rows.find((r) => r.id === '90000015-0000-4000-8000-000000000015')!;
    expect(received.receiptNumber).toBeNull();
    expect(received.poNumber).toBeNull();
    expect(received.note).toBeNull();
  });
});
