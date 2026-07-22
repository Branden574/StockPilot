import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { deriveAgeDays, InventoryService } from './inventory';

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
