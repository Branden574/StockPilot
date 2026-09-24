import { describe, expect, it } from 'vitest';

import {
  availableAtWarehouse,
  computeDistributionPreview,
  defaultDistributeWarehouseId,
  drawableAtWarehouse,
  type BundleStockRow,
  type PreviewComponentInput,
} from './bundle-distribute-preview';

/**
 * The phone's Distribute preview must count the same stock distribute_bundle()
 * draws since 0365: a component only from an item in the chosen warehouse (or
 * with none) that is not deleted, and pre-assembled kits only when the kit's
 * phantom item is in the chosen warehouse (or has none) and is not deleted.
 *
 * THE BUG THIS GUARDS: the screen counted every component's on-hand and every
 * pre-assembled kit wherever they sat, so a kit handed out at warehouse B with
 * all its stock in warehouse A previewed as fully available, and the server
 * then refused it with insufficient_stock (or recorded a shortage the operator
 * was never warned about).
 */

const WH = 'wh-chosen';
const OTHER_WH = 'wh-other';

function comp(
  itemId: string,
  row: (Partial<BundleStockRow> & { quantityOnHand: number }) | null,
  opts: { perBundleQty?: number; isOptional?: boolean } = {},
): PreviewComponentInput {
  return {
    itemId,
    perBundleQty: opts.perBundleQty ?? 1,
    isOptional: opts.isOptional ?? false,
    item: row
      ? {
          name: `Item ${itemId}`,
          sku: `SKU-${itemId}`,
          quantityOnHand: row.quantityOnHand,
          warehouseId: row.warehouseId === undefined ? WH : row.warehouseId,
          deletedAt: row.deletedAt ?? null,
        }
      : null,
  };
}

function preview(
  components: PreviewComponentInput[],
  opts: { quantity?: number; warehouseId?: string | null; phantom?: BundleStockRow | null } = {},
) {
  const out = computeDistributionPreview({
    quantity: opts.quantity ?? 2,
    warehouseId: opts.warehouseId === undefined ? WH : opts.warehouseId,
    phantom: opts.phantom ?? null,
    components,
  });
  return out;
}

describe('computeDistributionPreview: components (0365)', () => {
  it('counts a component in the chosen warehouse', () => {
    const p = preview([comp('a', { quantityOnHand: 10, warehouseId: WH })], { quantity: 4 });
    expect(p?.components[0]).toMatchObject({ available: 10, needed: 4, drawnFromComponents: 4, shortage: 0 });
    expect(p?.hasShortage).toBe(false);
  });

  it('counts a component in ANOTHER warehouse as 0 available, so the run is short', () => {
    const p = preview([comp('a', { quantityOnHand: 50, warehouseId: OTHER_WH })], { quantity: 3 });
    expect(p?.components[0]).toMatchObject({ available: 0, needed: 3, drawnFromComponents: 0, shortage: 3 });
    expect(p?.hasShortage).toBe(true);
    expect(p?.totalShortageItems).toBe(1);
    expect(p?.totalShortageUnits).toBe(3);
  });

  it('counts a deleted component as 0 available, even in the chosen warehouse', () => {
    const p = preview(
      [comp('a', { quantityOnHand: 50, warehouseId: WH, deletedAt: '2026-09-20T00:00:00Z' })],
      { quantity: 2 },
    );
    expect(p?.components[0]).toMatchObject({ available: 0, shortage: 2 });
    expect(p?.hasShortage).toBe(true);
  });

  it('counts a component with no warehouse, like the RPC and the web preview', () => {
    const p = preview([comp('a', { quantityOnHand: 7, warehouseId: null })], { quantity: 2 });
    expect(p?.components[0]).toMatchObject({ available: 7, shortage: 0 });
  });

  it('counts a component the phone does not hold as 0 available', () => {
    const p = preview([comp('abcdef0123456789', null)], { quantity: 1 });
    expect(p?.components[0]).toMatchObject({
      available: 0,
      shortage: 1,
      itemName: 'abcdef01',
      itemSku: '',
    });
  });

  it('reads a negative on-hand as 0, like the RPC', () => {
    const p = preview([comp('a', { quantityOnHand: -5, warehouseId: WH })], { quantity: 1 });
    expect(p?.components[0]).toMatchObject({ available: 0, shortage: 1 });
  });

  it('shows a short OPTIONAL component without calling the run short', () => {
    const p = preview(
      [
        comp('req', { quantityOnHand: 10, warehouseId: WH }),
        comp('opt', { quantityOnHand: 10, warehouseId: OTHER_WH }, { isOptional: true }),
      ],
      { quantity: 2 },
    );
    expect(p?.components[1]).toMatchObject({ available: 0, shortage: 2, isOptional: true });
    expect(p?.hasShortage).toBe(false);
    expect(p?.totalShortageUnits).toBe(0);
  });

  it('multiplies the per-kit quantity', () => {
    const p = preview([comp('a', { quantityOnHand: 5, warehouseId: WH }, { perBundleQty: 3 })], {
      quantity: 2,
    });
    expect(p?.components[0]).toMatchObject({ needed: 6, available: 5, drawnFromComponents: 5, shortage: 1 });
  });
});

describe('computeDistributionPreview: pre-assembled kits (0365)', () => {
  const stocked = [comp('a', { quantityOnHand: 100, warehouseId: WH })];

  it('uses kits in the chosen warehouse first', () => {
    const p = preview(stocked, { quantity: 5, phantom: { quantityOnHand: 3, warehouseId: WH } });
    expect(p?.fromPhantom).toBe(3);
    expect(p?.fromComponents).toBe(2);
    expect(p?.components[0]?.needed).toBe(2);
  });

  it('counts kits boxed in ANOTHER warehouse as 0: every unit comes from components', () => {
    const p = preview(stocked, { quantity: 5, phantom: { quantityOnHand: 9, warehouseId: OTHER_WH } });
    expect(p?.fromPhantom).toBe(0);
    expect(p?.fromComponents).toBe(5);
    expect(p?.components[0]?.needed).toBe(5);
  });

  it('counts kits on a deleted kit item as 0', () => {
    const p = preview(stocked, {
      quantity: 5,
      phantom: { quantityOnHand: 9, warehouseId: WH, deletedAt: '2026-09-20T00:00:00Z' },
    });
    expect(p?.fromPhantom).toBe(0);
    expect(p?.fromComponents).toBe(5);
  });

  it('counts kits whose phantom has no warehouse', () => {
    const p = preview(stocked, { quantity: 5, phantom: { quantityOnHand: 2, warehouseId: null } });
    expect(p?.fromPhantom).toBe(2);
    expect(p?.fromComponents).toBe(3);
  });

  it('reads a negative kit count as 0', () => {
    const p = preview(stocked, { quantity: 2, phantom: { quantityOnHand: -4, warehouseId: WH } });
    expect(p?.fromPhantom).toBe(0);
    expect(p?.fromComponents).toBe(2);
  });
});

describe('computeDistributionPreview: the reviewed case, and the warehouse switch', () => {
  // A kit whose pre-assembled stock AND components all sit in warehouse A.
  const components = [
    comp('bag', { quantityOnHand: 40, warehouseId: OTHER_WH }),
    comp('pen', { quantityOnHand: 40, warehouseId: OTHER_WH }, { perBundleQty: 2 }),
  ];
  const phantom: BundleStockRow = { quantityOnHand: 5, warehouseId: OTHER_WH };

  it('handed out at warehouse B, it previews short instead of fully available', () => {
    const p = preview(components, { quantity: 2, warehouseId: WH, phantom });
    expect(p).toMatchObject({
      fromPhantom: 0,
      fromComponents: 2,
      hasShortage: true,
      totalShortageItems: 2,
      totalShortageUnits: 2 + 4,
    });
  });

  it('switching the warehouse to A recomputes to fully available from kits', () => {
    const p = preview(components, { quantity: 2, warehouseId: OTHER_WH, phantom });
    expect(p).toMatchObject({ fromPhantom: 2, fromComponents: 0, hasShortage: false });
  });
});

describe('computeDistributionPreview: nothing to preview', () => {
  it('returns null until a warehouse is chosen', () => {
    expect(preview([comp('a', { quantityOnHand: 1 })], { warehouseId: null })).toBeNull();
  });

  it('returns null for a quantity that is not a positive number', () => {
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(preview([comp('a', { quantityOnHand: 1 })], { quantity })).toBeNull();
    }
  });
});

describe('availableAtWarehouse / drawableAtWarehouse', () => {
  it('is the web rule: in the warehouse, or in none', () => {
    expect(drawableAtWarehouse(WH, WH)).toBe(true);
    expect(drawableAtWarehouse(null, WH)).toBe(true);
    expect(drawableAtWarehouse(undefined, WH)).toBe(true);
    expect(drawableAtWarehouse(OTHER_WH, WH)).toBe(false);
  });

  it('is 0 for a missing, deleted or elsewhere row and the on-hand otherwise', () => {
    expect(availableAtWarehouse(null, WH)).toBe(0);
    expect(availableAtWarehouse(undefined, WH)).toBe(0);
    expect(availableAtWarehouse({ quantityOnHand: 8, warehouseId: OTHER_WH }, WH)).toBe(0);
    expect(
      availableAtWarehouse({ quantityOnHand: 8, warehouseId: WH, deletedAt: '2026-09-01T00:00:00Z' }, WH),
    ).toBe(0);
    expect(availableAtWarehouse({ quantityOnHand: 8, warehouseId: WH }, WH)).toBe(8);
    expect(availableAtWarehouse({ quantityOnHand: 8, warehouseId: WH, deletedAt: null }, WH)).toBe(8);
  });
});

describe('defaultDistributeWarehouseId', () => {
  const offered = ['wh-1', 'wh-2', 'wh-3'];

  it('starts on the kit phantom warehouse when there is one', () => {
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: 'wh-2',
        componentWarehouseIds: ['wh-3', 'wh-3'],
        warehouseIds: offered,
      }),
    ).toBe('wh-2');
  });

  it('with no phantom, starts on the one warehouse every component sits in', () => {
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: null,
        componentWarehouseIds: ['wh-3', 'wh-3'],
        warehouseIds: offered,
      }),
    ).toBe('wh-3');
  });

  it('falls back to the first warehouse when the components are split', () => {
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: null,
        componentWarehouseIds: ['wh-2', 'wh-3'],
        warehouseIds: offered,
      }),
    ).toBe('wh-1');
  });

  it('falls back to the first warehouse when a component is not cached or has no warehouse', () => {
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: null,
        componentWarehouseIds: ['wh-3', undefined],
        warehouseIds: offered,
      }),
    ).toBe('wh-1');
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: null,
        componentWarehouseIds: ['wh-3', null],
        warehouseIds: offered,
      }),
    ).toBe('wh-1');
  });

  it('never preselects a warehouse the screen does not list', () => {
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: null,
        componentWarehouseIds: ['wh-9'],
        warehouseIds: offered,
      }),
    ).toBe('wh-1');
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: 'wh-9',
        componentWarehouseIds: ['wh-2'],
        warehouseIds: offered,
      }),
    ).toBe('wh-1');
  });

  it('is null when there are no warehouses', () => {
    expect(
      defaultDistributeWarehouseId({
        phantomWarehouseId: null,
        componentWarehouseIds: [],
        warehouseIds: [],
      }),
    ).toBeNull();
  });
});
