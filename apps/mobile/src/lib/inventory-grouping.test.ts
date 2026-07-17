import { describe, expect, it } from 'vitest';

import { buildGroupedRows, type GroupableItem, type GroupedRow } from './inventory-grouping';

const item = (o: Partial<GroupableItem> & { id: string }): GroupableItem => ({
  name: o.name ?? 'Item',
  sku: o.sku ?? 'SKU',
  quantity_on_hand: o.quantity_on_hand ?? 0,
  reorder_point: o.reorder_point ?? 0,
  status: o.status ?? 'active',
  charter_id: o.charter_id ?? null,
  primary_location_id: o.primary_location_id ?? null,
  ...o,
});

const NONE = {
  expandedSizeRuns: new Set<string>(),
  expandedSkuGroups: new Set<string>(),
} as const;

const skuHeader = <T extends GroupableItem>(rows: GroupedRow<T>[]) =>
  rows.find((r) => r.kind === 'sku-header') as Extract<GroupedRow<T>, { kind: 'sku-header' }>;

describe('buildGroupedRows — Model B same-SKU collapse (web/mobile parity)', () => {
  // The exact bug from the field: Acer Chromebook 511 C737LT, SKU SP-EPOMX-QAN,
  // arrived as 4 placement rows (385/100/25/150) on mobile instead of one.
  it('collapses 4 same-SKU placements into ONE header row summing to 660', () => {
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'SP-EPOMX-QAN', name: 'Acer Chromebook 511 C737LT', quantity_on_hand: 385 }),
        item({ id: 'b', sku: 'SP-EPOMX-QAN', name: 'Acer Chromebook 511 C737LT', quantity_on_hand: 100 }),
        item({ id: 'c', sku: 'SP-EPOMX-QAN', name: 'Acer Chromebook 511 C737LT', quantity_on_hand: 25 }),
        item({ id: 'd', sku: 'SP-EPOMX-QAN', name: 'Acer Chromebook 511 C737LT', quantity_on_hand: 150 }),
      ],
      NONE,
    );

    // Collapsed by default → exactly one header, no placement rows visible.
    expect(rows).toHaveLength(1);
    const header = skuHeader(rows);
    expect(header.kind).toBe('sku-header');
    expect(header.sku).toBe('SP-EPOMX-QAN');
    expect(header.total).toBe(660);
    expect(header.placementCount).toBe(4);
    expect(header.key).toBe('sku:SP-EPOMX-QAN');
  });

  it('carries the FIRST placement\'s reorder point (matches web `first.reorder_point`)', () => {
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'SP-EPOMX-QAN', quantity_on_hand: 385, reorder_point: 40 }),
        item({ id: 'b', sku: 'SP-EPOMX-QAN', quantity_on_hand: 100, reorder_point: 5 }),
      ],
      NONE,
    );
    expect(skuHeader(rows).reorderPoint).toBe(40);
  });

  it('rolls up to the WORST status across placements (never masks archived/discontinued)', () => {
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'SP-EPOMX-QAN', quantity_on_hand: 385, status: 'active' }),
        item({ id: 'b', sku: 'SP-EPOMX-QAN', quantity_on_hand: 100, status: 'active' }),
        item({ id: 'c', sku: 'SP-EPOMX-QAN', quantity_on_hand: 25, status: 'discontinued' }),
        item({ id: 'd', sku: 'SP-EPOMX-QAN', quantity_on_hand: 150, status: 'archived' }),
      ],
      NONE,
    );
    expect(skuHeader(rows).status).toBe('discontinued');
  });

  it('expands to individual placement rows, each keeping its own id + qty + placement label', () => {
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'SP-EPOMX-QAN', quantity_on_hand: 385, charter_id: 'c1' }),
        item({ id: 'b', sku: 'SP-EPOMX-QAN', quantity_on_hand: 275, charter_id: 'c2' }),
      ],
      {
        expandedSizeRuns: new Set(),
        expandedSkuGroups: new Set(['SP-EPOMX-QAN']),
        placementLabelFor: (it) => (it.charter_id === 'c1' ? 'Program A' : 'Program B'),
      },
    );
    // header + 2 placement rows
    expect(rows.map((r) => r.kind)).toEqual(['sku-header', 'row', 'row']);
    const [, r1, r2] = rows as Extract<GroupedRow<GroupableItem>, { kind: 'row' }>[];
    expect(r1.item.id).toBe('a');
    expect(r1.item.quantity_on_hand).toBe(385);
    expect(r1.placementLabel).toBe('Program A');
    expect(r2.item.id).toBe('b');
    expect(r2.placementLabel).toBe('Program B');
  });

  it('leaves a single-placement SKU as a plain row (no header, byte-identical to before)', () => {
    const rows = buildGroupedRows([item({ id: 'a', sku: 'SOLO', quantity_on_hand: 12 })], NONE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('row');
  });

  it('never groups blank SKUs together (each blank SKU is its own plain row)', () => {
    const rows = buildGroupedRows(
      [item({ id: 'a', sku: '', quantity_on_hand: 1 }), item({ id: 'b', sku: '', quantity_on_hand: 2 })],
      NONE,
    );
    expect(rows.every((r) => r.kind === 'row')).toBe(true);
    expect(rows).toHaveLength(2);
  });
});

describe('buildGroupedRows — size-run × sku-group composition', () => {
  it('keeps apparel size-runs working for distinct SKUs alongside a SKU-group', () => {
    const rows = buildGroupedRows(
      [
        // A multi-placement SKU (collapses to a sku-header).
        item({ id: 'p1', sku: 'BOARD', name: 'Whiteboard', quantity_on_hand: 5 }),
        item({ id: 'p2', sku: 'BOARD', name: 'Whiteboard', quantity_on_hand: 7 }),
        // An apparel run — DIFFERENT SKUs per size (collapses to a size-run header).
        item({ id: 's', sku: 'SHIRT-S', name: 'Pink Shirt - S', quantity_on_hand: 3 }),
        item({ id: 'm', sku: 'SHIRT-M', name: 'Pink Shirt - M', quantity_on_hand: 4 }),
        item({ id: 'l', sku: 'SHIRT-L', name: 'Pink Shirt - L', quantity_on_hand: 2 }),
      ],
      NONE,
    );
    const kinds = rows.map((r) => r.kind);
    // One sku-header (Whiteboard) + one size-run header (Pink Shirt); both collapsed.
    expect(kinds).toEqual(['sku-header', 'header']);
    const sku = rows.find((r) => r.kind === 'sku-header') as Extract<GroupedRow<GroupableItem>, { kind: 'sku-header' }>;
    const run = rows.find((r) => r.kind === 'header') as Extract<GroupedRow<GroupableItem>, { kind: 'header' }>;
    expect(sku.total).toBe(12);
    expect(run.total).toBe(9);
    expect(run.sizeCount).toBe(3);
    // Keys don't collide across the two group types.
    expect(sku.key).toBe('sku:BOARD');
    expect(run.key).toBe('g:pink shirt');
  });

  it('does NOT fold a multi-placement SKU header into an apparel run that shares its base name', () => {
    // Same base name "Cap - L", but the SKU itself has 2 placements → it must
    // stay a sku-header, never a size-run member (groupable:false).
    const rows = buildGroupedRows(
      [
        item({ id: 'x', sku: 'CAP-L', name: 'Team Cap - L', quantity_on_hand: 4 }),
        item({ id: 'y', sku: 'CAP-L', name: 'Team Cap - L', quantity_on_hand: 6 }),
        item({ id: 'z', sku: 'CAP-M', name: 'Team Cap - M', quantity_on_hand: 8 }),
      ],
      NONE,
    );
    // CAP-L is a 2-placement SKU header; CAP-M is a lone size (no run) → plain row.
    expect(rows.map((r) => r.kind)).toEqual(['sku-header', 'row']);
  });
});
