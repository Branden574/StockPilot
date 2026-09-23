import { describe, expect, it } from 'vitest';

/**
 * Reports keep their id lists under the URL limits.
 *
 * - The supplier scorecard's PO-line read batches its PO ids 100 at a time
 *   (it was 200, past the local gateway's ~8 KB limit once the rest of the
 *   URL is added) and pages each batch.
 * - inventoryValuation({ withLocations: true }) returns each row's bin label
 *   and primary location name from the SAME paged stream, so the snapshot PDF
 *   no longer needs a second `.in()` over every item in the org.
 */

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ReportsService } from './reports';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

describe('ReportsService.supplierScorecard with 250 POs', () => {
  it('reads PO lines in batches of at most 100 and sums lines from the last batch', async () => {
    const pos = Array.from({ length: 250 }, (_, i) => ({
      id: uuid(i, 'p'),
      supplier_id: 'sup-1',
      status: 'received',
      ordered_at: '2026-09-01T00:00:00Z',
      expected_at: null,
      received_at: '2026-09-02T00:00:00Z',
      total: 10,
      created_at: '2026-09-01T00:00:00Z',
      supplier: { name: 'Acme' },
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'purchase_orders.select': { data: pos, error: null },
      'purchase_order_items.select': (call) => {
        const list = inList(call, 'purchase_order_id');
        lists.push(list);
        // POs 200..249 (the last batch) were received in full, the rest half,
        // so the fill rate below only comes out right if every batch was read.
        return {
          data: list.map((purchase_order_id) => ({
            id: `l-${purchase_order_id}`,
            purchase_order_id,
            quantity_ordered: 2,
            quantity_received: Number(purchase_order_id.slice(-12)) >= 200 ? 2 : 1,
          })),
          error: null,
        };
      },
    });
    const out = await new ReportsService(
      makeServiceContext(stub.client) as never,
    ).supplierScorecard();
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    // (200 x 1 + 50 x 2) received of 250 x 2 ordered = 0.6; without the last
    // batch it would read 0.5.
    expect(out.rows.find((r) => r.supplierName === 'Acme')?.fillRate).toBeCloseTo(0.6);
  });
});

describe('ReportsService.inventoryValuation withLocations', () => {
  function stubWith(items: unknown[]) {
    return makeSupabaseStub({
      'vw_inventory_valuation_by_warehouse.select': { data: [], error: null },
      'vw_inventory_valuation_by_category.select': { data: [], error: null },
      'inventory_items.select': { data: items, error: null },
    });
  }
  const item = {
    id: 'i1',
    sku: 'S1',
    name: 'Item',
    quantity_on_hand: 2,
    unit_cost: 3,
    warehouse: { name: 'DC4' },
    category: null,
    bin_location: '41-C',
    location: { name: 'Main floor' },
  };

  it('returns the bin label and primary location from the same stream, with no id-list read', async () => {
    const stub = stubWith([item]);
    const out = await new ReportsService(
      makeServiceContext(stub.client) as never,
    ).inventoryValuation({ withLocations: true });
    expect(out.rows[0]).toMatchObject({ binLocation: '41-C', primaryLocationName: 'Main floor' });
    const selectArg = String(stub.chainArgs.get('inventory_items.select')?.[0]?.[0]);
    expect(selectArg).toContain('location:locations!primary_location_id');
    expect(stub.chains.get('inventory_items.select')).not.toContain('in');
  });

  it('leaves the default report unchanged (no location embed, no location fields)', async () => {
    const stub = stubWith([item]);
    const out = await new ReportsService(
      makeServiceContext(stub.client) as never,
    ).inventoryValuation();
    expect(out.rows[0]).not.toHaveProperty('binLocation');
    const selectArg = String(stub.chainArgs.get('inventory_items.select')?.[0]?.[0]);
    expect(selectArg).not.toContain('primary_location_id');
  });
});
