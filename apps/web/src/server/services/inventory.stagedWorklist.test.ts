import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { deriveAgeDays, InventoryService, readStagingBarcode } from './inventory';

describe('deriveAgeDays', () => {
  it('returns whole days since the earliest staged movement', () => {
    const now = new Date('2026-06-25T00:00:00Z').getTime();
    expect(deriveAgeDays('2026-06-22T00:00:00Z', now)).toBe(3);
  });
  it('returns 0 for same-day', () => {
    const now = new Date('2026-06-25T06:00:00Z').getTime();
    expect(deriveAgeDays('2026-06-25T00:00:00Z', now)).toBe(0);
  });
  it('returns null when no received timestamp', () => {
    expect(deriveAgeDays(null, Date.now())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stagedWorklist backs the Staging "put-away" screen. It must surface BOTH
// not-yet-placed buckets — kind='staging' (PO receipts) and kind='unplaced'
// (on hand but never racked) — so unplaced stock has a path to be placed.
// PO source/age belongs only to staging rows; unplaced rows carry none.
// ---------------------------------------------------------------------------

const STAGING_ITEM = '11111111-1111-1111-1111-111111111111';
const UNPLACED_ITEM = '22222222-2222-2222-2222-222222222222';

describe('InventoryService.stagedWorklist', () => {
  it('returns staging AND unplaced holdings, tagging each with sourceKind', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          {
            item_id: STAGING_ITEM,
            location_id: 'stg-loc',
            quantity: 150,
            locations: { id: 'stg-loc', kind: 'staging', warehouse_id: 'wh-1' },
            inventory_items: {
              id: STAGING_ITEM,
              name: 'Acer Chromebook (Madera)',
              sku: 'SP-9U4BK-0EK',
              item_type: 'product',
              deleted_at: null,
            },
          },
          {
            item_id: UNPLACED_ITEM,
            location_id: 'unp-loc',
            quantity: 500,
            locations: { id: 'unp-loc', kind: 'unplaced', warehouse_id: 'wh-1' },
            inventory_items: {
              id: UNPLACED_ITEM,
              name: 'Acer Chromebook (Manchester)',
              sku: 'SP-EPOMX-QAN',
              item_type: 'product',
              deleted_at: null,
            },
          },
        ],
        error: null,
      },
      'stock_movements.select': {
        data: [
          {
            item_id: STAGING_ITEM,
            created_at: '2026-06-26T00:00:00Z',
            notes: 'receipt-1',
            movement_type: 'receive_po',
          },
          // A stray receive_po movement for the unplaced item must NOT attach a
          // source — the row is unplaced, not PO-staged.
          {
            item_id: UNPLACED_ITEM,
            created_at: '2026-06-20T00:00:00Z',
            notes: 'receipt-2',
            movement_type: 'receive_po',
          },
        ],
        error: null,
      },
      'receipts.select': {
        data: [
          {
            id: 'receipt-1',
            receipt_number: 'R-001',
            received_at: '2026-06-26T00:00:00Z',
            status: 'posted',
            purchase_orders: { po_number: 'CVSII-001841' },
          },
        ],
        error: null,
      },
    });

    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = await svc.stagedWorklist();

    const staging = rows.find((r) => r.itemId === STAGING_ITEM)!;
    const unplaced = rows.find((r) => r.itemId === UNPLACED_ITEM)!;

    // Staging row: PO-staged, carries its source PO + qty.
    expect(staging.sourceKind).toBe('staging');
    expect(staging.quantity).toBe(150);
    expect(staging.sourceLocationId).toBe('stg-loc');
    expect(staging.sourcePoNumber).toBe('CVSII-001841');
    expect(staging.receiptNumber).toBe('R-001');

    // Unplaced row: surfaced for placement, but NO PO source/receipt/age even
    // when a stray receive_po movement exists for that item.
    expect(unplaced.sourceKind).toBe('unplaced');
    expect(unplaced.quantity).toBe(500);
    expect(unplaced.sourceLocationId).toBe('unp-loc');
    expect(unplaced.sourcePoNumber).toBeNull();
    expect(unplaced.sourceReceiptId).toBeNull();
    expect(unplaced.receiptNumber).toBeNull();
    expect(unplaced.receivedAt).toBeNull();
    expect(unplaced.ageDays).toBeNull();
  });

  it('returns [] when nothing is staged or unplaced', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    expect(await svc.stagedWorklist()).toEqual([]);
  });

  it('keeps PO source on the staging row only when ONE item has BOTH a staging and an unplaced holding', async () => {
    // Same item id appears twice — once staging, once unplaced — AND it has a
    // real receive_po movement. The PO source/age must attach to the staging
    // row and NEVER bleed onto the unplaced row. Two rows out, keyed distinctly
    // by their source location (so the table renders both).
    const COMBINED_ITEM = '33333333-3333-3333-3333-333333333333';
    const stub = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          {
            item_id: COMBINED_ITEM,
            location_id: 'stg-c',
            quantity: 40,
            locations: { id: 'stg-c', kind: 'staging', warehouse_id: 'wh-1' },
            inventory_items: {
              id: COMBINED_ITEM,
              name: 'Combined Chromebook',
              sku: 'SP-COMBO-1',
              item_type: 'product',
              deleted_at: null,
            },
          },
          {
            item_id: COMBINED_ITEM,
            location_id: 'unp-c',
            quantity: 60,
            locations: { id: 'unp-c', kind: 'unplaced', warehouse_id: 'wh-1' },
            inventory_items: {
              id: COMBINED_ITEM,
              name: 'Combined Chromebook',
              sku: 'SP-COMBO-1',
              item_type: 'product',
              deleted_at: null,
            },
          },
        ],
        error: null,
      },
      'stock_movements.select': {
        data: [
          {
            item_id: COMBINED_ITEM,
            created_at: '2026-06-26T00:00:00Z',
            notes: 'receipt-c',
            movement_type: 'receive_po',
          },
        ],
        error: null,
      },
      'receipts.select': {
        data: [
          {
            id: 'receipt-c',
            receipt_number: 'R-COMBO',
            received_at: '2026-06-26T00:00:00Z',
            status: 'posted',
            purchase_orders: { po_number: 'CVW-COMBINED' },
          },
        ],
        error: null,
      },
    });

    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = await svc.stagedWorklist();

    expect(rows).toHaveLength(2);
    const stagingRow = rows.find((r) => r.sourceLocationId === 'stg-c')!;
    const unplacedRow = rows.find((r) => r.sourceLocationId === 'unp-c')!;

    // Staging row carries the PO source + age.
    expect(stagingRow.sourceKind).toBe('staging');
    expect(stagingRow.quantity).toBe(40);
    expect(stagingRow.sourcePoNumber).toBe('CVW-COMBINED');
    expect(stagingRow.receiptNumber).toBe('R-COMBO');

    // Unplaced row of the SAME item must NOT inherit the PO source.
    expect(unplacedRow.sourceKind).toBe('unplaced');
    expect(unplacedRow.quantity).toBe(60);
    expect(unplacedRow.sourcePoNumber).toBeNull();
    expect(unplacedRow.sourceReceiptId).toBeNull();
    expect(unplacedRow.receiptNumber).toBeNull();
    expect(unplacedRow.ageDays).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source attribution (owner report 2026-07-22, reproduced from the real rows).
//
// "Science Dimensions Earth & Space Science" had been received on 2026-06-24
// against CVW-002202 — a receipt later REVERSED, on a PO later CANCELLED — and
// received again on 2026-07-22 against CVW-002201. Its 20 staged units came
// from the July receipt, but the worklist took the item's EARLIEST receive_po
// movement with no regard for receipt status, so the Staging screen showed the
// June receipt: wrong PO, wrong receipt number, "4 weeks ago", and a false
// "27d Stale" badge on stock that had arrived minutes earlier.
// ---------------------------------------------------------------------------

const SCIENCE_ITEM = '33333333-3333-3333-3333-333333333333';

function scienceDimensionsStub(receipts: Array<Record<string, unknown>>) {
  return makeSupabaseStub({
    'item_stock_levels.select': {
      data: [
        {
          item_id: SCIENCE_ITEM,
          location_id: 'stg-loc',
          quantity: 20,
          locations: { id: 'stg-loc', kind: 'staging', warehouse_id: 'wh-1' },
          inventory_items: {
            id: SCIENCE_ITEM,
            name: 'Science Dimensions Earth & Space Science',
            sku: 'SP-0WK2L-LY1',
            item_type: 'book',
            deleted_at: null,
          },
        },
      ],
      error: null,
    },
    // Newest first — the service orders descending.
    'stock_movements.select': {
      data: [
        {
          item_id: SCIENCE_ITEM,
          created_at: '2026-07-22T17:56:00Z',
          notes: 'receipt-july',
          movement_type: 'receive_po',
        },
        {
          item_id: SCIENCE_ITEM,
          created_at: '2026-06-24T21:41:23Z',
          notes: 'receipt-june',
          movement_type: 'receive_po',
        },
      ],
      error: null,
    },
    'receipts.select': { data: receipts, error: null },
  });
}

const JUNE_RECEIPT = {
  id: 'receipt-june',
  receipt_number: 'R-20260624-214123-168444',
  received_at: '2026-06-24T21:41:23Z',
  status: 'reversed',
  purchase_orders: { po_number: 'CVW-002202' },
};
const JULY_RECEIPT = {
  id: 'receipt-july',
  receipt_number: 'R-20260722-175600-e56648',
  received_at: '2026-07-22T17:56:00Z',
  status: 'posted',
  purchase_orders: { po_number: 'CVW-002201' },
};

describe('InventoryService.stagedWorklist — which receipt staged this stock', () => {
  it('attributes staged stock to the most recent POSTED receipt, not the first ever', async () => {
    const svc = new InventoryService(
      makeServiceContext(scienceDimensionsStub([JUNE_RECEIPT, JULY_RECEIPT]).client),
    );
    const [row] = await svc.stagedWorklist();

    expect(row!.sourcePoNumber).toBe('CVW-002201');
    expect(row!.receiptNumber).toBe('R-20260722-175600-e56648');
    expect(row!.receivedAt).toBe('2026-07-22T17:56:00Z');
  });

  it('never attributes staged stock to a REVERSED receipt', async () => {
    // Reversing took that stock back out, so it cannot be what is sitting here.
    const svc = new InventoryService(
      makeServiceContext(scienceDimensionsStub([JUNE_RECEIPT]).client),
    );
    const [row] = await svc.stagedWorklist();

    expect(row!.sourcePoNumber).toBeNull();
    expect(row!.receiptNumber).toBeNull();
    expect(row!.sourceReceiptId).toBeNull();
    // No live receipt to date it from, so no age and therefore no Stale badge.
    expect(row!.ageDays).toBeNull();
  });

  it('still reads stale when the only posted receipt really is old', async () => {
    const svc = new InventoryService(
      makeServiceContext(
        scienceDimensionsStub([{ ...JUNE_RECEIPT, status: 'posted' }, { ...JULY_RECEIPT, status: 'reversed' }]).client,
      ),
    );
    const [row] = await svc.stagedWorklist();

    expect(row!.sourcePoNumber).toBe('CVW-002202');
    expect(row!.receivedAt).toBe('2026-06-24T21:41:23Z');
    expect(row!.ageDays).toBeGreaterThan(14);
  });
});

// ---------------------------------------------------------------------------
// bookStorage — a BOOK's current rack/crate summary on the worklist row, so the
// put-away dialog can say "currently in Blue 4" without a second round trip.
//
// The constraint that matters: it must ride on the query that ALREADY runs.
// `custom_fields` was added to the existing inventory_items embed; if anyone
// "fixes" this by fetching items separately, the no-extra-query test below
// fails — a per-row item lookup on a staging screen is an N+1.
// ---------------------------------------------------------------------------

const BOOK_ID = '44444444-4444-4444-4444-444444444444';
const WIDGET_ID = '55555555-5555-5555-5555-555555555555';

function crateWorklistStub(bookCustomFields: Record<string, unknown> | null) {
  return makeSupabaseStub({
    'item_stock_levels.select': {
      data: [
        {
          item_id: BOOK_ID,
          location_id: 'stg-loc',
          quantity: 12,
          locations: { id: 'stg-loc', kind: 'staging', warehouse_id: 'wh-1' },
          inventory_items: {
            id: BOOK_ID,
            name: 'Persepolis',
            sku: 'SP-BOOK-1',
            item_type: 'book',
            deleted_at: null,
            custom_fields: bookCustomFields,
          },
        },
        {
          item_id: WIDGET_ID,
          location_id: 'stg-loc',
          quantity: 3,
          locations: { id: 'stg-loc', kind: 'staging', warehouse_id: 'wh-1' },
          inventory_items: {
            id: WIDGET_ID,
            name: 'Acer Chromebook',
            sku: 'SP-WIDGET-1',
            item_type: 'product',
            deleted_at: null,
            // A non-book carrying the NEUTRAL rack keys. Reading book_* off it
            // would be wrong, and folding rack_* into bookStorage would be
            // worse — the two key families mean different things (mig 0068).
            custom_fields: { rack_number: '12', rack_row: 'C' },
          },
        },
      ],
      error: null,
    },
    'stock_movements.select': { data: [], error: null },
  });
}

describe('InventoryService.stagedWorklist — bookStorage', () => {
  it("exposes a BOOK row's crate + rack summary, and null for a non-book", async () => {
    const stub = crateWorklistStub({
      book_rack_number: '38',
      book_rack_row: 'A',
      book_crate_color: 'blue',
      book_crate_number: '4',
      author: 'Marjane Satrapi',
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = await svc.stagedWorklist();

    const book = rows.find((r) => r.itemId === BOOK_ID)!;
    expect(book.bookStorage).toEqual({
      rackNumber: '38',
      rackRow: 'A',
      crateColor: 'blue',
      crateNumber: '4',
      grade: null,
      rackLabel: '38-A',
      // The DISPLAY spelling ("Blue 4"), never the "Blue #4" location name.
      crateLabel: 'Blue 4',
    });

    const widget = rows.find((r) => r.itemId === WIDGET_ID)!;
    expect(widget.bookStorage).toBeNull();
  });

  it('gives a book with no crate recorded an all-null summary, not a missing field', async () => {
    const stub = crateWorklistStub({ author: 'Marjane Satrapi' });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const book = (await svc.stagedWorklist()).find((r) => r.itemId === BOOK_ID)!;

    expect(book.bookStorage).not.toBeNull();
    expect(book.bookStorage!.crateColor).toBeNull();
    expect(book.bookStorage!.crateNumber).toBeNull();
    expect(book.bookStorage!.crateLabel).toBeNull();
  });

  it('carries the real free-text production crate numbers ("Bin", "Blue Shelf")', async () => {
    const stub = crateWorklistStub({ book_crate_color: 'blue', book_crate_number: 'Bin' });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const book = (await svc.stagedWorklist()).find((r) => r.itemId === BOOK_ID)!;

    expect(book.bookStorage!.crateNumber).toBe('Bin');
    expect(book.bookStorage!.crateLabel).toBe('Blue Bin');
  });

  it('never ships the raw custom_fields blob to the client', async () => {
    // custom_fields also carries the org's own 0159 custom-field VALUES. It is
    // read to derive bookStorage and then dropped.
    const stub = crateWorklistStub({
      book_crate_color: 'blue',
      book_crate_number: '4',
      org_custom_donor_name: 'PTA 2024',
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const book = (await svc.stagedWorklist()).find((r) => r.itemId === BOOK_ID)!;

    expect(book).not.toHaveProperty('custom_fields');
    expect(JSON.stringify(book)).not.toContain('PTA 2024');
  });

  it('adds NO query: custom_fields rides the EXISTING inventory_items embed', async () => {
    const stub = crateWorklistStub({ book_crate_color: 'blue', book_crate_number: '4' });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.stagedWorklist();

    // Not one inventory_items read of its own — that would be an N+1 on a
    // screen that routinely lists hundreds of staged rows.
    expect(stub.fromCalls).not.toContain('inventory_items');
    // ...because the ONE levels query already asks for it.
    const levelsChains = stub.chainArgsAll.get('item_stock_levels.select')!;
    const projection = levelsChains[0]![0]![0] as string;
    expect(projection).toContain('inventory_items!inner(');
    expect(projection).toContain('custom_fields');
  });
});

// ---------------------------------------------------------------------------
// barcode / modelNumber — searchable identifiers for the staging table's
// client-side search box (a worker scans an ISBN into it). Same rule as
// bookStorage: two more columns on the ONE inventory_items embed, never a
// second query.
// ---------------------------------------------------------------------------

describe('InventoryService.stagedWorklist — searchable identifiers', () => {
  function identifierStub(items: Array<Record<string, unknown>>) {
    return makeSupabaseStub({
      'item_stock_levels.select': {
        data: items.map((inv, i) => ({
          item_id: inv.id,
          location_id: 'stg-loc',
          quantity: 1 + i,
          locations: { id: 'stg-loc', kind: 'staging', warehouse_id: 'wh-1' },
          inventory_items: { deleted_at: null, custom_fields: null, ...inv },
        })),
        error: null,
      },
      'stock_movements.select': { data: [], error: null },
    });
  }

  it('threads barcode and model_number onto the row', async () => {
    const stub = identifierStub([
      { id: BOOK_ID, name: 'Persepolis', sku: 'SP-BOOK-1', item_type: 'book', barcode: '9780375714573', model_number: null },
      { id: WIDGET_ID, name: 'Markers', sku: 'SP-WBM-12', item_type: 'product', barcode: null, model_number: 'EXPO-86001' },
    ]);
    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = await svc.stagedWorklist();
    expect(rows.find((r) => r.itemId === BOOK_ID)).toMatchObject({ barcode: '9780375714573', modelNumber: null });
    expect(rows.find((r) => r.itemId === WIDGET_ID)).toMatchObject({ barcode: null, modelNumber: 'EXPO-86001' });
  });

  it('asks the EXISTING embed for barcode + model_number — no inventory_items query of its own', async () => {
    const stub = identifierStub([
      { id: BOOK_ID, name: 'Persepolis', sku: 'SP-BOOK-1', item_type: 'book', barcode: '9780375714573', model_number: null },
    ]);
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.stagedWorklist();
    expect(stub.fromCalls).not.toContain('inventory_items');
    const projection = stub.chainArgsAll.get('item_stock_levels.select')![0]![0]![0] as string;
    const embed = projection.slice(projection.indexOf('inventory_items!inner('));
    expect(embed).toContain('barcode');
    expect(embed).toContain('model_number');
  });

  it('falls back to a legacy ISBN custom-field key when barcode is empty (same order as the export)', async () => {
    const stub = identifierStub([
      { id: BOOK_ID, name: 'Persepolis', sku: 'SP-BOOK-1', item_type: 'book', barcode: '  ', model_number: null, custom_fields: { isbn13: '9780375714573' } },
    ]);
    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = await svc.stagedWorklist();
    expect(rows[0]!.barcode).toBe('9780375714573');
  });
});

describe('readStagingBarcode', () => {
  it('prefers the barcode column, trimmed', () => {
    expect(readStagingBarcode({ barcode: ' 9780375714573 ', custom_fields: { isbn: 'other' } })).toBe('9780375714573');
  });
  it('falls back through isbn, isbn13, isbn10 in that order', () => {
    expect(readStagingBarcode({ barcode: null, custom_fields: { isbn13: 'B', isbn: 'A', isbn10: 'C' } })).toBe('A');
    expect(readStagingBarcode({ barcode: '', custom_fields: { isbn13: 'B', isbn10: 'C' } })).toBe('B');
    expect(readStagingBarcode({ barcode: undefined, custom_fields: { isbn10: 'C' } })).toBe('C');
  });
  it('is null when nothing is recorded, or when the ISBN key holds a non-string', () => {
    expect(readStagingBarcode({ barcode: null, custom_fields: null })).toBeNull();
    expect(readStagingBarcode({ barcode: null, custom_fields: { isbn: 12345 } })).toBeNull();
    expect(readStagingBarcode({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PostgREST clamps EVERY response to `[api] max_rows = 1000` with no error
// (pattern #3). stagedWorklist ran all three of its reads un-ranged and
// un-chunked, so:
//   • step 1 (item_stock_levels) silently HID staged holdings past row 1000 —
//     they never reach /dashboard/inventory/staging or the mobile Staging tab,
//     and Select-all places only what it can see;
//   • step 2 (receive_po movements, newest-first) dropped the OLDEST receipts,
//     i.e. exactly the rows the Stale badge exists for.
// The sibling itemMovementHistory doc already names this trap for the movement
// query; the worklist itself was left on the raw builder.
// ---------------------------------------------------------------------------
function stagedRow(i: number) {
  return {
    id: `lvl-${i}`,
    item_id: `filler-${i}`,
    location_id: `stg-${i}`,
    quantity: 1,
    locations: { id: `stg-${i}`, kind: 'staging', warehouse_id: 'wh-1' },
    inventory_items: {
      id: `filler-${i}`,
      name: `Filler ${i}`,
      sku: `SP-${i}`,
      item_type: 'product',
      deleted_at: null,
    },
  };
}

/** Page 1 fills the cap; page 2 carries the row under test. */
function pagedStub<T>(pageTwo: T[], pageOne: T[]) {
  let call = 0;
  return () => {
    call += 1;
    return call === 1 ? { data: pageOne, error: null } : { data: pageTwo, error: null };
  };
}

describe('InventoryService.stagedWorklist — the 1000-row PostgREST cap', () => {
  it('returns staged holdings past row 1000 instead of silently truncating the worklist', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': pagedStub(
        [
          {
            id: 'lvl-1001',
            item_id: STAGING_ITEM,
            location_id: 'stg-last',
            quantity: 4,
            locations: { id: 'stg-last', kind: 'staging', warehouse_id: 'wh-1' },
            inventory_items: {
              id: STAGING_ITEM,
              name: 'The invisible one',
              sku: 'SP-LAST',
              item_type: 'product',
              deleted_at: null,
            },
          },
        ],
        Array.from({ length: 1000 }, (_, i) => stagedRow(i)),
      ),
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const rows = await svc.stagedWorklist();

    expect(rows).toHaveLength(1001);
    expect(rows.some((r) => r.itemId === STAGING_ITEM)).toBe(true);
  });

  it("keeps the source PO/age of the OLDEST staged item when its receive_po movement falls past the cap", async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          {
            id: 'lvl-old',
            item_id: STAGING_ITEM,
            location_id: 'stg-loc',
            quantity: 20,
            locations: { id: 'stg-loc', kind: 'staging', warehouse_id: 'wh-1' },
            inventory_items: {
              id: STAGING_ITEM,
              name: 'Sat here since June',
              sku: 'SP-OLD',
              item_type: 'product',
              deleted_at: null,
            },
          },
        ],
        error: null,
      },
      // Newest-first: 1000 fresher movements for OTHER items fill page 1, so
      // the only movement that explains this item's stock is on page 2.
      'stock_movements.select': pagedStub(
        [
          {
            id: 'mv-1001',
            item_id: STAGING_ITEM,
            created_at: '2026-06-01T00:00:00Z',
            notes: 'receipt-old',
            movement_type: 'receive_po',
          },
        ],
        Array.from({ length: 1000 }, (_, i) => ({
          id: `mv-${i}`,
          item_id: `filler-${i}`,
          created_at: '2026-08-01T00:00:00Z',
          notes: `receipt-${i}`,
          movement_type: 'receive_po',
        })),
      ),
      'receipts.select': {
        data: [
          {
            id: 'receipt-old',
            receipt_number: 'R-OLD',
            received_at: '2026-06-01T00:00:00Z',
            status: 'posted',
            purchase_orders: { po_number: 'PO-OLD' },
          },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const row = (await svc.stagedWorklist()).find((r) => r.itemId === STAGING_ITEM)!;

    // Without paging, the stalest stock is exactly the stock that loses its
    // source — and with it the Stale badge and the Age=Stale filter.
    expect(row.sourcePoNumber).toBe('PO-OLD');
    expect(row.receiptNumber).toBe('R-OLD');
    expect(row.ageDays).not.toBeNull();
  });

  it('chunks the source-movement .in("item_id", …) so a big worklist is not truncated by id count', async () => {
    const levels = Array.from({ length: 501 }, (_, i) => stagedRow(i));
    const stub = makeSupabaseStub({
      'item_stock_levels.select': { data: levels, error: null },
      'stock_movements.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.stagedWorklist();

    const inArgs = (stub.chainArgsAll.get('stock_movements.select') ?? [])
      .flat()
      .filter((a) => a[0] === 'item_id' && Array.isArray(a[1]));
    expect(inArgs.length).toBeGreaterThan(0);
    for (const a of inArgs) expect((a[1] as string[]).length).toBeLessThanOrEqual(500);
    // 501 ids must have been split — one chunk would be the un-fixed shape.
    expect(inArgs.length).toBeGreaterThanOrEqual(2);
  });
});
