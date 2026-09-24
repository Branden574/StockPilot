import { describe, expect, it } from 'vitest';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { ReportsService } from './reports';

/**
 * The reorder-forecast report (page, CSV, PDF, and the count its "Draft PO
 * from suggestions" button shows) lists every below-par reorder candidate:
 *
 * - UNCAPPED. It stopped at 5,000 rows with no notice, so a big catalog's
 *   report, export and totals silently left items out, while the draft
 *   action it mirrors read them all.
 * - With the shared reorder-candidate predicate, so a kit's pre-assembled
 *   stock is never reported as something to buy.
 */

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `item-${String(i).padStart(6, '0')}`,
  sku: `SKU-${i}`,
  name: `Item ${i}`,
  quantity_on_hand: 1,
  reorder_point: 4,
  reorder_quantity: 0,
  unit_cost: 2,
  warehouse_id: null,
  warehouse: null,
  organization_id: 'org-test',
  deleted_at: null,
  status: 'active',
  is_rental: false,
  is_bundle: false,
  ...over,
});

describe('ReportsService.reorderForecast', () => {
  it('reports all 5,500 below-par items (no 5,000 cap), with totals over all of them', async () => {
    const TOTAL = 5_500;
    const pages: Array<[number, number]> = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': (call: MockCall) => {
        const [from, to] = callArgs(call, 'range') as [number, number];
        pages.push([from, to]);
        const rows = [];
        for (let i = from; i <= Math.min(to, from + 999, TOTAL - 1); i += 1) rows.push(row(i));
        return { data: rows, error: null };
      },
    });
    const report = await new ReportsService(makeServiceContext(stub.client)).reorderForecast();

    expect(report.totalItems).toBe(TOTAL);
    expect(report.rows).toHaveLength(TOTAL);
    expect(report.rows.some((r) => r.itemId === `item-${String(TOTAL - 1).padStart(6, '0')}`)).toBe(true);
    // Each item: target max(0, 4) = 4, on hand 1, deficit 3 at $2.
    expect(report.totalDeficit).toBe(TOTAL * 3);
    expect(report.totalEstimatedCost).toBe(TOTAL * 6);
    // Six 1,000-row windows, the last one short: read to the end, not to a cap.
    expect(pages).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
      [4000, 4999],
      [5000, 5999],
    ]);
  });

  it('reads with the shared reorder-candidate predicate: a below-par kit is never on the report', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': servedLikePostgrest([
        row(1),
        row(2, { is_bundle: true, quantity_on_hand: 0 }),
        row(3, { is_rental: true }),
        row(4, { deleted_at: '2026-09-01T00:00:00Z' }),
        row(5, { status: 'archived' }),
        row(6, { reorder_point: 0, quantity_on_hand: 0 }),
      ]),
    });
    const report = await new ReportsService(makeServiceContext(stub.client)).reorderForecast();

    expect(report.rows.map((r) => r.itemId)).toEqual(['item-000001']);
    const methods = stub.chainsAll.get('inventory_items.select')![0]!;
    const args = stub.chainArgsAll.get('inventory_items.select')![0]!;
    const filters = methods.map((m, i) => [m, ...(args[i] ?? [])]);
    expect(filters).toContainEqual(['eq', 'is_bundle', false]);
    expect(filters).toContainEqual(['eq', 'is_rental', false]);
    expect(filters).toContainEqual(['gt', 'reorder_point', 0]);
  });
});
