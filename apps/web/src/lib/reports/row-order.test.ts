import { describe, expect, it } from 'vitest';

import {
  compareBundleActivity,
  compareCategoryRollups,
  compareCostHistoryRows,
  compareMovementTypes,
  compareWarehouseRollups,
  costHistoryRows,
  type CostHistoryRow,
} from './row-order';

/**
 * Report rows that tie on the report's figure must come out in one fixed
 * order, whatever order they arrive in (2026-09-29: two movement types at 3
 * swapped places between two CSVs of the same data, because the SQL groups
 * with no ORDER BY).
 *
 * Every case sorts EVERY permutation of its rows and requires the same
 * output, so a missing tie-breaker fails: the rows it should have ordered
 * keep their input order, which differs between permutations. Each fixture
 * is also built so that dropping one key lets the NEXT key pick a different
 * order than the expected one.
 */

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

/** Sorts every permutation of `rows`; each must equal `expected`. */
function expectOneOrder<T>(rows: readonly T[], cmp: (a: T, b: T) => number, expected: T[]) {
  for (const input of permutations(rows)) {
    expect([...input].sort(cmp)).toEqual(expected);
  }
}

describe('compareMovementTypes (Stock movements, by type)', () => {
  const add = { movementType: 'add', count: 7, totalQty: 70 };
  const initial = { movementType: 'initial', count: 3, totalQty: 90 };
  const bundle = { movementType: 'bundle_distribution', count: 3, totalQty: 12 };
  const adjust = { movementType: 'adjust', count: 1, totalQty: 1 };

  it('the production case: initial and bundle_distribution at 3 always come out the same way', () => {
    expectOneOrder([add, initial, bundle, adjust], compareMovementTypes, [add, bundle, initial, adjust]);
  });

  it('keeps the count first: most movements lead whatever the name', () => {
    const zz = { movementType: 'zz_last_by_name', count: 9, totalQty: 0 };
    expectOneOrder([add, zz, adjust], compareMovementTypes, [zz, add, adjust]);
  });

  it('a number in a code counts the way a reader counts (type_2 before type_10)', () => {
    // Today's codes are lowercase words, where the reader's order and the
    // exact order agree; a code with a number is where they part.
    const t10 = { movementType: 'type_10', count: 2, totalQty: 0 };
    const t2 = { movementType: 'type_2', count: 2, totalQty: 0 };
    expectOneOrder([t10, t2], compareMovementTypes, [t2, t10]);
  });

  it('two codes the collator calls equal ("a01", "a1") still have one order', () => {
    const a01 = { movementType: 'a01', count: 2, totalQty: 0 };
    const a1 = { movementType: 'a1', count: 2, totalQty: 0 };
    expectOneOrder([a1, a01], compareMovementTypes, [a01, a1]);
  });
});

describe('compareWarehouseRollups / compareCategoryRollups (Inventory valuation)', () => {
  it('ties on value break by name, then id; the value stays first', () => {
    const big = { warehouseId: 'w0', warehouseName: 'Zulu', value: 900, units: 1 };
    // Name order (Annex, Main) differs from id order (w1 Main, w9 Annex), so
    // without the name key the id would pick Main first.
    const annex = { warehouseId: 'w9', warehouseName: 'Annex', value: 100, units: 1 };
    const main2 = { warehouseId: 'w2', warehouseName: 'Main', value: 100, units: 2 };
    const main1 = { warehouseId: 'w1', warehouseName: 'Main', value: 100, units: 3 };
    const unassigned = { warehouseId: null, warehouseName: 'Unassigned', value: 100, units: 4 };
    expectOneOrder([annex, main2, big, unassigned, main1], compareWarehouseRollups, [
      big,
      annex,
      main1,
      main2,
      unassigned,
    ]);
  });

  it('categories: the same keys', () => {
    // Tools has the lowest id, so without the name key it would lead.
    const tools = { categoryId: 'c0', categoryName: 'Tools', value: 50, units: 1 };
    const books2 = { categoryId: 'c2', categoryName: 'Books', value: 50, units: 1 };
    const books1 = { categoryId: 'c1', categoryName: 'Books', value: 50, units: 1 };
    const none = { categoryId: null, categoryName: 'Uncategorized', value: 60, units: 1 };
    expectOneOrder([tools, books2, none, books1], compareCategoryRollups, [none, books1, books2, tools]);
  });
});

describe('compareBundleActivity (Bundle activity)', () => {
  const row = (bundleId: string, bundleName: string, bundleSku: string | null, kitsOut: number) => ({
    bundleId,
    bundleName,
    bundleSku,
    kitsOut,
    runs: 1,
    componentValueOut: 0,
    topWarehouseName: null,
    lastRunAt: null,
  });

  it('kits out first, then name, then SKU (numbers in numeric order), then id', () => {
    const most = row('k0', 'Zeta kit', 'Z-1', 40);
    // Name decides: Alpha before Beta although Beta's SKU and id sort first.
    const alpha = row('k3', 'Alpha kit', 'Z-9', 5);
    const beta = row('k1', 'Beta kit', 'A-1', 5);
    // Same name: the SKU decides, G-2 before G-10, although G-10's id is lower.
    const gamma2 = row('k9', 'Gamma kit', 'G-2', 5);
    const gamma10 = row('k2', 'Gamma kit', 'G-10', 5);
    // Same name and SKU: the id decides.
    const delta5 = row('k5', 'Delta kit', 'D-1', 5);
    const delta4 = row('k4', 'Delta kit', 'D-1', 5);
    expectOneOrder(
      [alpha, beta, gamma2, gamma10, delta5, delta4, most],
      compareBundleActivity,
      [most, alpha, beta, delta4, delta5, gamma2, gamma10],
    );
  });
});

describe('item cost history rows', () => {
  const row = (
    date: string,
    supplier: string,
    supplierId: string,
    source: CostHistoryRow['source'],
    unitCost: number,
  ): CostHistoryRow => ({ date, supplier, supplierId, source, unitCost });

  it('oldest first by the full timestamp, then supplier name, supplier id, source, unit cost', () => {
    // One day, two times: the time decides, not the supplier name.
    const zedMorning = row('2026-05-01T09:00:00+00:00', 'Zed Supply', 's1', 'purchase_order', 9);
    const acmeAfternoon = row('2026-05-01T15:00:00+00:00', 'Acme', 's2', 'purchase_order', 9);
    // Same instant: the name decides (Acme before Bolt, though Bolt's id is lower).
    const acmeNoon = row('2026-05-02T12:00:00+00:00', 'Acme', 's7', 'purchase_order', 5);
    const boltNoon = row('2026-05-02T12:00:00+00:00', 'Bolt', 's0', 'purchase_order', 5);
    // Same instant and name: the supplier id decides.
    const twinA = row('2026-05-03T12:00:00+00:00', 'Twin Co', 's3', 'purchase_order', 5);
    const twinB = row('2026-05-03T12:00:00+00:00', 'Twin Co', 's4', 'purchase_order', 5);
    // Same instant and supplier: the order before its receipt, although the
    // receipt's cost is lower.
    const po = row('2026-05-04T12:00:00+00:00', 'Acme', 's2', 'purchase_order', 8);
    const receipt = row('2026-05-04T12:00:00+00:00', 'Acme', 's2', 'receipt', 7);
    // Same everything but the cost: the lower cost first.
    const cheap = row('2026-05-05T12:00:00+00:00', 'Acme', 's2', 'receipt', 3);
    const dear = row('2026-05-05T12:00:00+00:00', 'Acme', 's2', 'receipt', 4);

    const expected = [zedMorning, acmeAfternoon, acmeNoon, boltNoon, twinA, twinB, po, receipt, cheap, dear];
    // 10 rows is 3.6M permutations; sort the forward, reversed and a few
    // rotated orders instead (each reorders every tied pair above).
    const inputs = [
      expected,
      [...expected].reverse(),
      ...[1, 3, 5, 7].map((k) => [...expected.slice(k), ...expected.slice(0, k)].reverse()),
    ];
    for (const input of inputs) {
      expect([...input].sort(compareCostHistoryRows)).toEqual(expected);
    }
  });

  it('costHistoryRows lists the same rows in the same order whatever the series order', () => {
    const acme = {
      supplierId: 's-acme',
      supplierName: 'Acme',
      points: [
        { date: '2026-05-01T15:00:00+00:00', unitCost: 10, source: 'purchase_order' as const },
        { date: '2026-05-03T12:00:00+00:00', unitCost: 11, source: 'purchase_order' as const },
        { date: '2026-05-03T12:00:00+00:00', unitCost: 11, source: 'receipt' as const },
      ],
    };
    const zed = {
      supplierId: 's-zed',
      supplierName: 'Zed Supply',
      points: [
        { date: '2026-05-01T09:00:00+00:00', unitCost: 12, source: 'receipt' as const },
        { date: '2026-05-03T12:00:00+00:00', unitCost: 9, source: 'purchase_order' as const },
      ],
    };
    const reversedPoints = (s: typeof acme | typeof zed) => ({ ...s, points: [...s.points].reverse() });

    const a = costHistoryRows([acme, zed]);
    const b = costHistoryRows([zed, acme]);
    const c = costHistoryRows([reversedPoints(zed), reversedPoints(acme)]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.map((r) => `${r.date.slice(0, 16)} ${r.supplier} ${r.source}`)).toEqual([
      // Zed's 09:00 price before Acme's 15:00 price on the same day: the
      // CSV and XLSX used to sort by the day alone and keep series order.
      '2026-05-01T09:00 Zed Supply receipt',
      '2026-05-01T15:00 Acme purchase_order',
      '2026-05-03T12:00 Acme purchase_order',
      '2026-05-03T12:00 Acme receipt',
      '2026-05-03T12:00 Zed Supply purchase_order',
    ]);
  });
});
