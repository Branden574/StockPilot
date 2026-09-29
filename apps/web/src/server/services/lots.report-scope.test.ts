import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { LotsService } from './lots';

/**
 * Security invariant (2026-09-29): the two lot REPORTS show only lots of
 * items the reader can read.
 *
 * receipt_line_lots, receipt_lines, receipts and lot_pick_events are readable
 * by every member (their policies test org membership only); the item is
 * what carries warehouse and category scope. The reports embedded the item
 * with a LEFT join, so for a warehouse- or category-scoped reader PostgREST
 * returned the lot anyway with a null item: Aging & expiry listed another
 * warehouse's lot number, expiry and remaining quantity as item "—", and
 * Recall / lot trace listed its receipt number and the SO numbers of the
 * orders that used it. The report reads now inner-join the item (the row
 * goes when row level security hides the item) and drop any row whose item
 * still comes back null. Picking's FEFO suggestions are not a report and
 * keep the left join.
 */

const ORG = 'org-test';
const READABLE = 'item-readable';
const HIDDEN = 'item-hidden';

const withLotSerial = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'lot_serial']);

function lotRow(itemId: string, lot: string, qty: number, item: { name: string; sku: string } | null) {
  return {
    lot_number: lot,
    expiration_date: '2026-10-20',
    qty_base: qty,
    created_at: '2026-09-01T00:00:00Z',
    receipt_lines: {
      item_id: itemId,
      receipts: { organization_id: ORG, receipt_number: `RC-${lot}`, status: 'posted' },
      // PostgREST's answer for an embed that row level security hides: null.
      inventory_items: item ? { ...item, shelf_life_days: null } : null,
    },
  };
}

function stub() {
  return makeSupabaseStub({
    'receipt_line_lots.select': {
      data: [
        lotRow(READABLE, 'LOT-A', 5, { name: 'Readable Cable', sku: 'CABLE-1' }),
        lotRow(HIDDEN, 'LOT-B', 7, null),
      ],
      error: null,
    },
    'lot_pick_events.select': {
      data: [
        { item_id: READABLE, lot_number: 'LOT-A', qty: 1, order_request_id: 'o1', picked_at: '2026-09-02T00:00:00Z', picked_by: null, order_request: { order_number: 11 }, item: { id: READABLE } },
        { item_id: HIDDEN, lot_number: 'LOT-B', qty: 2, order_request_id: 'o2', picked_at: '2026-09-03T00:00:00Z', picked_by: null, order_request: { order_number: 12 }, item: null },
      ],
      error: null,
    },
  });
}

function svcFor(s: ReturnType<typeof stub>) {
  return new LotsService(
    makeServiceContext(s.client, { organizationId: ORG, role: 'viewer', permissions: new Set(['reports:read']), enabledModules: withLotSerial() }),
  );
}

function selects(s: ReturnType<typeof stub>, key: string): string[] {
  return (s.chainArgsAll.get(key) ?? []).map((args) => String(args[0]?.[0] ?? ''));
}

describe('lot reports show only lots of items the reader can read', () => {
  it('Aging & expiry drops a lot whose item the reader cannot read', async () => {
    const s = stub();
    const rows = await svcFor(s).agingReport();
    expect(rows.map((r) => r.lotNumber)).toEqual(['LOT-A']);
    expect(rows[0]).toMatchObject({ itemId: READABLE, itemName: 'Readable Cable', sku: 'CABLE-1', remaining: 4 });
    expect(rows.some((r) => r.itemName === '—')).toBe(false);
  });

  it('Aging & expiry asks PostgREST for an inner join on the item', async () => {
    const s = stub();
    await svcFor(s).agingReport();
    const lotSelects = selects(s, 'receipt_line_lots.select');
    expect(lotSelects.length).toBeGreaterThan(0);
    for (const sel of lotSelects) expect(sel.replace(/\s+/g, ' ')).toMatch(/inventory_items:item_id!inner \(/);
  });

  it('Recall / lot trace drops the receipt and the pick of an item the reader cannot read', async () => {
    const s = stub();
    const trace = await svcFor(s).traceLot('LOT');
    expect(trace.receipts.map((r) => r.receiptNumber)).toEqual(['RC-LOT-A']);
    expect(trace.receipts[0]).toMatchObject({ itemId: READABLE, itemName: 'Readable Cable', qty: 5 });
    expect(trace.picks.map((p) => p.orderNumber)).toEqual([11]);
  });

  it('Recall / lot trace inner-joins the item on both reads', async () => {
    const s = stub();
    await svcFor(s).traceLot('LOT');
    const [lotSel] = selects(s, 'receipt_line_lots.select');
    const [pickSel] = selects(s, 'lot_pick_events.select');
    expect(lotSel!.replace(/\s+/g, ' ')).toMatch(/inventory_items:item_id!inner \(/);
    expect(pickSel!.replace(/\s+/g, ' ')).toMatch(/item:inventory_items!item_id!inner \(/);
  });

  it("picking's FEFO suggestions are not a report and keep every lot (unchanged)", async () => {
    const s = stub();
    const fefo = await svcFor(s).getFefoSuggestionsByItems([READABLE, HIDDEN]);
    expect(Object.keys(fefo).sort()).toEqual([HIDDEN, READABLE].sort());
    for (const sel of selects(s, 'receipt_line_lots.select')) expect(sel).not.toMatch(/!inner \( name, sku/);
  });
});
