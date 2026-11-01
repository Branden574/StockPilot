import { describe, expect, it } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { WarehouseChartersService } from './warehouse-charters';

/**
 * warehouse_charters links a warehouse to each charter (delivery site) it
 * serves. Its key is (warehouse_id, charter_id); it has no id column, and
 * archiving a charter keeps its links. Nothing caps the links, so four
 * warehouses that each serve 251 charters pass PostgREST's 1000-row max_rows.
 *
 * listPairs read every link of the organization in ONE read with no order and
 * no range: past 1000 links an arbitrary set dropped out, with no error, and
 * the item forms, Team's member Charters dialog and the warehouse page could
 * not offer those charters (B47). It now reads page by page, ordered by
 * warehouse and then charter.
 */

const ORG = 'org-test';
const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const W3 = '00000000-0000-4000-8000-0000000000a3';

const charterId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function links(warehouseId: string, from: number, n: number, organizationId = ORG) {
  return Array.from({ length: n }, (_, i) => ({
    organization_id: organizationId,
    warehouse_id: warehouseId,
    charter_id: charterId(from + i),
  }));
}

function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

describe('WarehouseChartersService.listPairs reads every page', () => {
  it('returns all 1500 links across three warehouses, in two pages ordered by warehouse then charter', async () => {
    // Stored out of key order, as a table with no ORDER BY may answer.
    const all = [...links(W3, 1000, 500), ...links(W1, 0, 500), ...links(W2, 500, 500)];
    const stub = makeSupabaseStub({
      'warehouse_charters.select': servedLikePostgrest([
        ...all,
        ...links(W1, 5000, 3, 'org-other'),
      ]),
    });

    const pairs = await new WarehouseChartersService(
      makeServiceContext(stub.client) as never,
    ).listPairs();

    expect(pairs).toHaveLength(1500);
    expect(new Set(pairs.map((p) => `${p.warehouse_id}/${p.charter_id}`)).size).toBe(1500);
    expect(pairs.map((p) => p.warehouse_id).filter((w, i, a) => i === 0 || a[i - 1] !== w)).toEqual(
      [W1, W2, W3],
    );
    expect(stub.chainsAll.get('warehouse_charters.select')).toHaveLength(2);
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'order').map((a) => a[0])).toEqual([
      'warehouse_id',
      'charter_id',
    ]);
    expect(pageArgs(stub, 'warehouse_charters.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'warehouse_charters.select', 1, 'range')).toEqual([[1000, 1999]]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'warehouse_charters.select', page, 'eq')).toContainEqual([
        'organization_id',
        ORG,
      ]);
    }
  });
});
