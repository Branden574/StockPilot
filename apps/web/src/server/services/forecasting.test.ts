import { describe, expect, it } from 'vitest';

import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { getItemVelocity } from './forecasting';

/**
 * getItemVelocity (behind the AI's predictRunout, getItemVelocity and
 * suggestReorderPoint tools) sums an item's outbound movements over the
 * window. PostgREST answers at most 1,000 rows per request, so the unpaged
 * read summed only the first 1,000 movements of a busy item: velocity too
 * low, days of cover too high, suggested reorder point too low, no signal.
 */

const ORG = 'org-test';
const ITEM = 'item-1';

/** `total` outbound movements of 2 units each, served by the query's own .range() window. */
function movementsStub(total: number) {
  const windows: Array<[number, number]> = [];
  const stub = makeSupabaseStub({
    'stock_movements.select': (call: MockCall) => {
      const range = callArgs(call, 'range') as [number, number] | undefined;
      // An unpaged read gets what PostgREST gives it: the first 1,000 rows.
      const [from, to] = range ?? [0, 999];
      windows.push([from, to]);
      const rows = [];
      for (let i = from; i <= Math.min(to, from + 999, total - 1); i += 1) {
        rows.push({ id: `m-${String(i).padStart(6, '0')}`, quantity_change: -2 });
      }
      return { data: rows, error: null };
    },
    'inventory_items.select': {
      data: { quantity_on_hand: 100, created_at: '2020-01-01T00:00:00.000Z' },
      error: null,
    },
  });
  return { stub, windows };
}

describe('getItemVelocity', () => {
  it('sums all 1,005 outbound movements, not the first 1,000', async () => {
    const { stub, windows } = movementsStub(1_005);

    const v = await getItemVelocity(stub.client, ORG, ITEM, 90);

    expect(v.unitsOutTotal).toBe(1_005 * 2);
    expect(v.unitsOutPerDay).toBeCloseTo((1_005 * 2) / 90, 10);
    expect(windows).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    // Paged in a stable order, for this item and org, outbound only.
    const methods = stub.chainsAll.get('stock_movements.select')![0]!;
    const args = stub.chainArgsAll.get('stock_movements.select')![0]!;
    const filters = methods.map((m, i) => [m, ...(args[i] ?? [])]);
    expect(filters).toContainEqual(['order', 'id', { ascending: true }]);
    expect(filters).toContainEqual(['eq', 'item_id', ITEM]);
    expect(filters).toContainEqual(['eq', 'organization_id', ORG]);
    expect(filters).toContainEqual(['lt', 'quantity_change', 0]);
  });

  it('a failed page throws (never a partial sum)', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'stock_movements.select': () => {
        n += 1;
        return n === 1
          ? { data: Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, quantity_change: -1 })), error: null }
          : { data: null, error: { message: 'statement timeout' } };
      },
      'inventory_items.select': {
        data: { quantity_on_hand: 1, created_at: '2020-01-01T00:00:00.000Z' },
        error: null,
      },
    });
    await expect(getItemVelocity(stub.client, ORG, ITEM, 90)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});
