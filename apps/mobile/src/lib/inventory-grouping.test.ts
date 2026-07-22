import { describe, expect, it } from 'vitest';

import { stockPill, stockPillFor } from './expected-items';
import {
  buildGroupUnits,
  buildGroupedRows,
  firstCoverBySku,
  type GroupableItem,
  type GroupedRow,
} from './inventory-grouping';

const item = (o: Partial<GroupableItem> & { id: string }): GroupableItem => ({
  name: o.name ?? 'Item',
  sku: o.sku ?? 'SKU',
  quantity_on_hand: o.quantity_on_hand ?? 0,
  reorder_point: o.reorder_point ?? 0,
  status: o.status ?? 'active',
  charter_id: o.charter_id ?? null,
  primary_location_id: o.primary_location_id ?? null,
  awaiting_first_receipt: o.awaiting_first_receipt ?? false,
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

  // REWRITTEN (was: "carries the FIRST placement's reorder point"). That
  // encoded the defect — the threshold came from ONE placement while the
  // quantity it was compared against was the SUM, so the badge could read
  // healthier than every row beneath it. Web already sums (groupReorderPoint
  // in inventory-table.tsx); the two platforms must not disagree about what a
  // badge means.
  it('SUMS the placements\' reorder points, so threshold and quantity share a scale', () => {
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'SP-EPOMX-QAN', quantity_on_hand: 385, reorder_point: 40 }),
        item({ id: 'b', sku: 'SP-EPOMX-QAN', quantity_on_hand: 100, reorder_point: 5 }),
      ],
      NONE,
    );
    expect(skuHeader(rows).reorderPoint).toBe(45);
  });

  it('can never badge a group healthier than a UNANIMOUS reading of its rows', () => {
    // 4 placements of 3 against a reorder point of 10 each: every row is LOW.
    // With the first placement's threshold the header compared 12 > 10 and
    // badged OK over four rows all badging LOW.
    const placements = ['a', 'b', 'c', 'd'].map((id) =>
      item({ id, sku: 'LOW-EVERYWHERE', quantity_on_hand: 3, reorder_point: 10 }),
    );
    const header = skuHeader(buildGroupedRows(placements, NONE));
    expect(header.total).toBe(12);
    expect(header.reorderPoint).toBe(40);
    // Both screens badge the header from exactly these two numbers through the
    // shared ladder, so assert the pill itself — header and rows must agree.
    expect(
      stockPill({
        expected: header.expected,
        lifecycle: header.status,
        quantity: header.total,
        reorderPoint: header.reorderPoint,
      }).label,
    ).toBe('LOW');
    expect(placements.every((p) => stockPillFor(p).label === 'LOW')).toBe(true);
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

  it('keeps size-run grouping ON by default (Items list must not regress)', () => {
    // The option is OMITTED — inventory.tsx never passes it, so the default
    // has to stay the pre-existing behavior.
    const rows = buildGroupedRows(
      [
        item({ id: 's', sku: 'SHIRT-L', name: 'Shirt - L', quantity_on_hand: 3 }),
        item({ id: 'm', sku: 'SHIRT-XL', name: 'Shirt - XL', quantity_on_hand: 4 }),
        item({ id: 'l', sku: 'SHIRT-2XL', name: 'Shirt - 2XL', quantity_on_hand: 2 }),
      ],
      NONE,
    );
    expect(rows.map((r) => r.kind)).toEqual(['header']);
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

describe('buildGroupedRows — enableSizeRuns:false (Books list)', () => {
  const BOOKS = {
    expandedSizeRuns: new Set<string>(),
    expandedSkuGroups: new Set<string>(),
    enableSizeRuns: false,
  } as const;

  it('leaves a size-run trio as three plain rows (a book is never sized)', () => {
    // Distinct SKUs whose names end in size tokens — the Items list WOULD
    // collapse these into one style header. Books must not.
    const rows = buildGroupedRows(
      [
        item({ id: 's', sku: 'SHIRT-L', name: 'Shirt - L', quantity_on_hand: 3 }),
        item({ id: 'm', sku: 'SHIRT-XL', name: 'Shirt - XL', quantity_on_hand: 4 }),
        item({ id: 'l', sku: 'SHIRT-2XL', name: 'Shirt - 2XL', quantity_on_hand: 2 }),
      ],
      BOOKS,
    );
    expect(rows.map((r) => r.kind)).toEqual(['row', 'row', 'row']);
    expect(rows.some((r) => r.kind === 'header')).toBe(false);
  });

  it('still collapses same-SKU book placements into ONE header with the summed total', () => {
    // "Into Algebra 1" (sp-8n8lr-8nd) — 3 rows on L4L North Region today.
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'sp-8n8lr-8nd', name: 'Into Algebra 1', quantity_on_hand: 4, reorder_point: 2 }),
        item({ id: 'b', sku: 'sp-8n8lr-8nd', name: 'Into Algebra 1', quantity_on_hand: 6 }),
        item({ id: 'c', sku: 'sp-8n8lr-8nd', name: 'Into Algebra 1', quantity_on_hand: 2, status: 'discontinued' }),
      ],
      BOOKS,
    );
    expect(rows).toHaveLength(1);
    const header = skuHeader(rows);
    expect(header.total).toBe(12);
    expect(header.placementCount).toBe(3);
    expect(header.reorderPoint).toBe(2);
    // Conservative rollup: a discontinued placement can never hide behind a
    // healthy collapsed badge.
    expect(header.status).toBe('discontinued');
  });

  it('expands book placements with their own rack labels', () => {
    const rows = buildGroupedRows(
      [
        item({ id: 'a', sku: 'SP-THV69-MG8', name: 'Persepolis', quantity_on_hand: 5 }),
        item({ id: 'b', sku: 'SP-THV69-MG8', name: 'Persepolis', quantity_on_hand: 7 }),
      ],
      {
        expandedSizeRuns: new Set<string>(),
        expandedSkuGroups: new Set(['SP-THV69-MG8']),
        placementLabelFor: (it) => (it.id === 'a' ? '38-A' : '12-B'),
        enableSizeRuns: false,
      },
    );
    expect(rows.map((r) => r.kind)).toEqual(['sku-header', 'row', 'row']);
    const [, r1, r2] = rows as Extract<GroupedRow<GroupableItem>, { kind: 'row' }>[];
    expect(r1.placementLabel).toBe('38-A');
    expect(r2.placementLabel).toBe('12-B');
  });

  it('leaves a single-placement book SKU as a plain row (no chevron header)', () => {
    const rows = buildGroupedRows(
      [item({ id: 'solo', sku: 'SP-ONE-BOOK', name: 'Solo Title', quantity_on_hand: 9 })],
      BOOKS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('row');
  });
});

describe('buildGroupedRows — a collapsed total is exact, because the group is never split', () => {
  const BOOKS = {
    expandedSizeRuns: new Set<string>(),
    expandedSkuGroups: new Set<string>(),
    enableSizeRuns: false,
  } as const;

  /**
   * REWRITTEN, and the superseded behaviour is named so it is not re-added.
   *
   * This block used to pin the `datasetIsPaged` + `familyCounts` machinery: the
   * lists fetched one 50-row page, a SKU's placements could land on two of
   * them, and a second per-SKU count read decided which headers had to wear a
   * "≥N" / "N placements shown" marker. The owner rejected the RESULT, rightly
   * — a title split across a page boundary is exactly the confusion grouping
   * exists to remove, and marking the split is not the same as not splitting.
   *
   * The lists now fetch the whole filtered set and paginate over GROUPS
   * (buildGroupUnits → paginateGroups, lib/inventory-paging.ts), so a family is
   * always whole on one page and every header total is exact by construction.
   * The only surviving marker is the honest overflow case: a filtered set
   * larger than PostgREST's row cap, where the rows really are a prefix.
   */
  const twoPlacements = [
    item({ id: 'a', sku: 'SP-THV69-MG8', name: 'Persepolis', quantity_on_hand: 5 }),
    item({ id: 'b', sku: 'SP-THV69-MG8', name: 'Persepolis', quantity_on_hand: 7 }),
  ];

  it('marks nothing partial by default (books)', () => {
    const header = skuHeader(buildGroupedRows(twoPlacements, BOOKS));
    expect(header.total).toBe(12);
    expect(header.partial).toBe(false);
  });

  it('marks nothing partial by default (items)', () => {
    const header = skuHeader(buildGroupedRows(twoPlacements, NONE));
    expect(header.total).toBe(12);
    expect(header.partial).toBe(false);
  });

  it('marks the header when — and only when — the caller says its read was CAPPED', () => {
    // Not "the list is paginated": that was true of every org past one page and
    // stamped the marker on headers that were demonstrably complete. Truncation
    // is a property of the READ, and at current volumes it never happens.
    expect(skuHeader(buildGroupedRows(twoPlacements, BOOKS)).partial).toBe(false);
    expect(
      skuHeader(buildGroupedRows(twoPlacements, { ...BOOKS, datasetIsTruncated: true })).partial,
    ).toBe(true);
  });

  it('marks on the ITEMS surface too (shared code, same rule)', () => {
    const header = skuHeader(buildGroupedRows(twoPlacements, { ...NONE, datasetIsTruncated: true }));
    expect(header.partial).toBe(true);
  });

  // REWRITTEN (was: `skuFullTotals`, a per-SKU cross-page figure handed in
  // beside the rows). That mechanism let a header report 31 over two rows
  // summing to 12 — a header that could not be reconciled with the rows it
  // expanded to, and which still rendered on EVERY page the SKU touched, each
  // one claiming the same full total. A header is a summary of its own
  // children and never borrows a figure from a wider scope.
  it('always reports the sum of the rows it expands to, never a figure from elsewhere', () => {
    const header = skuHeader(
      buildGroupedRows(twoPlacements, { ...BOOKS, datasetIsTruncated: true }),
    );
    expect(header.total).toBe(5 + 7);
    expect(header.placementCount).toBe(2);
  });

  it('rolls lifecycle up from the rows present', () => {
    const header = skuHeader(
      buildGroupedRows(
        [
          item({ id: 'a', sku: 'SP-THV69-MG8', quantity_on_hand: 5 }),
          item({ id: 'b', sku: 'SP-THV69-MG8', quantity_on_hand: 7, status: 'discontinued' }),
        ],
        BOOKS,
      ),
    );
    expect(header.status).toBe('discontinued');
    expect(header.partial).toBe(false);
  });
});

describe('buildGroupUnits — the unit of pagination is what renders as one card', () => {
  it('puts every placement of a SKU in ONE unit', () => {
    const units = buildGroupUnits(
      [
        item({ id: 'a', sku: 'ALG1' }),
        item({ id: 'z', sku: 'SOLO' }),
        item({ id: 'b', sku: 'ALG1' }),
        item({ id: 'c', sku: 'ALG1' }),
      ],
      { enableSizeRuns: false },
    );
    expect(units.map((u) => u.map((r) => r.id))).toEqual([['a', 'b', 'c'], ['z']]);
  });

  it('puts a whole size run in ONE unit (items only)', () => {
    const rows = [
      item({ id: 's1', sku: 'SH-S', name: 'L4L - Pink Shirt - S' }),
      item({ id: 'other', sku: 'X1', name: 'Stapler' }),
      item({ id: 's2', sku: 'SH-L', name: 'L4L - Pink Shirt - L' }),
      item({ id: 's3', sku: 'SH-XL', name: 'L4L - Pink Shirt - XL' }),
    ];
    expect(buildGroupUnits(rows).map((u) => u.map((r) => r.id))).toEqual([
      ['s1', 's2', 's3'],
      ['other'],
    ]);
    // Books opt out of the size-run pass, so each stays its own unit.
    expect(buildGroupUnits(rows, { enableSizeRuns: false }).map((u) => u.length)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('never folds a multi-placement SKU header into a size run', () => {
    // The header's own children already expand; web gates it the same way.
    const units = buildGroupUnits([
      item({ id: 'a', sku: 'SH-L', name: 'L4L - Pink Shirt - L' }),
      item({ id: 'b', sku: 'SH-L', name: 'L4L - Pink Shirt - L' }),
      item({ id: 'c', sku: 'SH-XL', name: 'L4L - Pink Shirt - XL' }),
    ]);
    expect(units.map((u) => u.map((r) => r.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('accounts for every row exactly once', () => {
    const rows = [
      item({ id: 'a', sku: 'ALG1' }),
      item({ id: 'b', sku: 'ALG1' }),
      item({ id: 'c', sku: '' }),
      item({ id: 'd', sku: '' }),
      item({ id: 'e', sku: 'SOLO' }),
    ];
    const flat = buildGroupUnits(rows).flat();
    expect(flat).toHaveLength(rows.length);
    expect(new Set(flat.map((r) => r.id)).size).toBe(rows.length);
  });

  it('groups a page of units exactly as it grouped the whole set', () => {
    // THE INVARIANT that makes group-paging safe: the renderer re-runs the
    // grouping on a page, so the pager and the renderer must agree about what
    // a group is. They share both passes, so slicing units and regrouping the
    // slice reproduces the same units.
    const rows = [
      item({ id: 'a', sku: 'ALG1' }),
      item({ id: 'z', sku: 'SOLO' }),
      item({ id: 'b', sku: 'ALG1' }),
    ];
    const units = buildGroupUnits(rows, { enableSizeRuns: false });
    for (const unit of units) {
      expect(buildGroupUnits(unit, { enableSizeRuns: false })).toHaveLength(1);
    }
    const pageItems = units.flat();
    expect(buildGroupUnits(pageItems, { enableSizeRuns: false })).toEqual(units);
  });
});

describe('buildGroupedRows — the EXPECTED pill comes from the rows, not the view', () => {
  const BOOKS = {
    expandedSizeRuns: new Set<string>(),
    expandedSkuGroups: new Set<string>(),
    enableSizeRuns: false,
  } as const;

  it('flags the header expected only when EVERY placement is awaiting first receipt', () => {
    const header = skuHeader(
      buildGroupedRows(
        [
          item({ id: 'a', sku: 'PO-BOOK', quantity_on_hand: 0, awaiting_first_receipt: true }),
          item({ id: 'b', sku: 'PO-BOOK', quantity_on_hand: 0, awaiting_first_receipt: true }),
        ],
        BOOKS,
      ),
    );
    expect(header.expected).toBe(true);
  });

  it('does NOT flag a header expected when its rows are ordinary stock', () => {
    // The failing case: the screen has just switched to the Expected view, so
    // view state says "expected" while the rows on screen are still the
    // PREVIOUS view's (250ms debounce + fetch). A view-derived pill would
    // badge these EXPECTED while every child row reads OUT / OK.
    const header = skuHeader(
      buildGroupedRows(
        [
          item({ id: 'a', sku: 'PLAIN', quantity_on_hand: 4 }),
          item({ id: 'b', sku: 'PLAIN', quantity_on_hand: 6 }),
        ],
        BOOKS,
      ),
    );
    expect(header.expected).toBe(false);
  });

  it('does NOT flag a MIXED group expected (a row that contradicts it exists)', () => {
    const header = skuHeader(
      buildGroupedRows(
        [
          item({ id: 'a', sku: 'MIX', quantity_on_hand: 0, awaiting_first_receipt: true }),
          item({ id: 'b', sku: 'MIX', quantity_on_hand: 6 }),
        ],
        BOOKS,
      ),
    );
    expect(header.expected).toBe(false);
  });
});

describe('firstCoverBySku — collapsed header thumbnail', () => {
  it('falls back to the first NON-NULL cover across the group', () => {
    // Covers hang off item_images per inventory_item, so a PO-created sibling
    // placement is routinely born without one and can sort first.
    const m = firstCoverBySku([
      { sku: 'BOOK-1', imageUrl: null },
      { sku: 'BOOK-1', imageUrl: 'https://signed/cover.jpg' },
    ]);
    expect(m.get('BOOK-1')).toBe('https://signed/cover.jpg');
  });

  it('keeps the FIRST cover when several placements have one', () => {
    const m = firstCoverBySku([
      { sku: 'BOOK-1', imageUrl: 'https://signed/a.jpg' },
      { sku: 'BOOK-1', imageUrl: 'https://signed/b.jpg' },
    ]);
    expect(m.get('BOOK-1')).toBe('https://signed/a.jpg');
  });

  it('maps a genuinely coverless SKU to null (placeholder icon), still present', () => {
    const m = firstCoverBySku([
      { sku: 'BOOK-1', imageUrl: null },
      { sku: 'BOOK-1', imageUrl: null },
    ]);
    expect(m.has('BOOK-1')).toBe(true);
    expect(m.get('BOOK-1')).toBeNull();
  });

  it('keeps SKUs independent', () => {
    const m = firstCoverBySku([
      { sku: 'A', imageUrl: null },
      { sku: 'B', imageUrl: 'https://signed/b.jpg' },
      { sku: 'A', imageUrl: 'https://signed/a.jpg' },
    ]);
    expect(m.get('A')).toBe('https://signed/a.jpg');
    expect(m.get('B')).toBe('https://signed/b.jpg');
  });
});
