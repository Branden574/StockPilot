import { describe, expect, it } from 'vitest';

import {
  composeDisplayList,
  countItemRowsByDisplayGroup,
  countUnclaimedItemRowsBySku,
  displayGroupChips,
  formedDisplayGroups,
  indexDisplayGroupMemberships,
  makeDisplayUnitKeyer,
  type DisplayListEntry,
} from './display-units';
import { DISPLAY_UNITS_PARITY_FIXTURE } from './display-units.fixture';
import { groupBySizeRun } from './size-run';
import { sizeRunStyleKey } from './size-run';

// An item-level row (the phone, Books, and runAwarePages hold these).
interface ItemRow {
  id: string;
  name: string;
  sku: string;
  group_id?: string | null;
  display_group_id?: string | null;
  variant_size?: string | null;
  quantity_on_hand: number;
}
// A placement-level row (the web Items list: one row per rack of a record).
interface PlacementRowT {
  rowKey: string;
  itemId: string;
  name: string;
  sku: string;
  group_id?: string | null;
  display_group_id?: string | null;
  variant_size?: string | null;
  quantity_on_hand: number;
  line_quantity: number;
}

const item = (id: string, sku: string, name: string, over: Partial<ItemRow> = {}): ItemRow => ({
  id,
  sku,
  name,
  quantity_on_hand: 1,
  ...over,
});

const itemAccess = {
  itemIdOf: (r: ItemRow) => r.id,
  skuOf: (r: ItemRow) => r.sku,
  displayGroupOf: (r: ItemRow) => r.display_group_id ?? null,
};
const runMeta = (r: {
  name: string;
  quantity_on_hand: number;
  group_id?: string | null;
  variant_size?: string | null;
}) => ({
  name: r.name,
  quantity: r.quantity_on_hand,
  groupId: r.group_id ?? null,
  variantSize: r.variant_size ?? null,
});
const NO_EXPANSION = {
  explicit: new Set<string>(),
  skus: new Set<string>(),
  runs: new Set<string>(),
};

/** The units a key assignment makes, in first-seen order, as id lists. */
function unitsOf<T extends { id: string }>(
  rows: readonly T[],
  keyOf: (r: T) => string | null,
): string[][] {
  const out: string[][] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) {
      out.push([r.id]);
      continue;
    }
    let i = at.get(k);
    if (i === undefined) {
      i = out.length;
      at.set(k, i);
      out.push([]);
    }
    out[i]!.push(r.id);
  }
  return out;
}

/** The top-level cards a composed list renders, as the record ids under each. */
function cardsOf<R>(list: DisplayListEntry<R>[], idOf: (r: R) => string): string[][] {
  const out: string[][] = [];
  for (const e of list) {
    if (e.kind === 'row') {
      if (!e.nested) out.push([idOf(e.row)]);
      continue;
    }
    const rows = e.kind === 'run' ? e.run.members : e.rows;
    out.push([...new Set(rows.map(idOf))]);
  }
  return out;
}

describe('the display unit keyer (E > K > R > single)', () => {
  it('an explicit group with two present records beats their own SKUs and size runs', () => {
    const rows = [
      item('a', 'X', 'Tee - S', { display_group_id: 'g1' }),
      item('b', 'X', 'Tee - S'),
      item('c', 'Y', 'Tee - M', { display_group_id: 'g1' }),
      item('d', 'Z', 'Tee - L'),
    ];
    const key = makeDisplayUnitKeyer(rows, { sizeRuns: true });
    expect(rows.map(key)).toEqual([
      'grp:g1',
      `run:${sizeRunStyleKey('Tee - S')}`,
      'grp:g1',
      `run:${sizeRunStyleKey('Tee - L')}`,
    ]);
    // b is the only unclaimed record of SKU X, so no SKU family forms; b and
    // d are the unclaimed tees, so they run together. The claimed a and c
    // never join a SKU family or a run.
  });

  it('a group with ONE present record does not form: the record falls back to its SKU family, its run or nothing', () => {
    const rows = [
      item('a', 'X', 'Tee - S', { display_group_id: 'g1' }),
      item('b', 'X', 'Tee - S'),
      item('c', 'Y', 'Tee - M'),
    ];
    const key = makeDisplayUnitKeyer(rows, { sizeRuns: true });
    expect(rows.map(key)).toEqual(['sku:X', 'sku:X', null]);
    expect(formedDisplayGroups(rows, itemAccess).size).toBe(0);
  });

  it('two rack rows of ONE record are one record: a group needs two distinct records', () => {
    const rows: PlacementRowT[] = [
      {
        rowKey: 'a:1',
        itemId: 'a',
        name: 'Pad',
        sku: 'P',
        display_group_id: 'g1',
        quantity_on_hand: 5,
        line_quantity: 2,
      },
      {
        rowKey: 'a:2',
        itemId: 'a',
        name: 'Pad',
        sku: 'P',
        display_group_id: 'g1',
        quantity_on_hand: 5,
        line_quantity: 3,
      },
    ];
    const formed = formedDisplayGroups(rows, {
      itemIdOf: (r) => r.itemId,
      skuOf: (r) => r.sku,
      displayGroupOf: (r) => r.display_group_id ?? null,
    });
    expect(formed.size).toBe(0);
  });

  it('keys a SKU on the RAW string (" X" and "X" are different SKUs, as the display and the 0234 index treat them)', () => {
    const rows = [item('a', 'X', 'One'), item('b', ' X', 'Two'), item('c', 'X', 'Three')];
    const key = makeDisplayUnitKeyer(rows, { sizeRuns: false });
    expect(rows.map(key)).toEqual(['sku:X', null, 'sku:X']);
  });

  it('never forms a SKU family on a blank SKU', () => {
    const rows = [item('a', '', 'One'), item('b', '  ', 'Two')];
    expect(rows.map(makeDisplayUnitKeyer(rows, { sizeRuns: false }))).toEqual([null, null]);
  });

  it('size runs use the stored family first, then the name, only when runs are on (never for Books)', () => {
    const rows = [
      item('a', 'A1', 'Limits Tee - XS', { group_id: 'fam' }),
      item('b', 'B1', 'Limits Tee - S', { group_id: 'fam' }),
      item('c', 'C1', 'Hoodie - M'),
      item('d', 'D1', 'Hoodie - L'),
    ];
    expect(rows.map(makeDisplayUnitKeyer(rows, { sizeRuns: true }))).toEqual([
      'run:group:fam',
      'run:group:fam',
      `run:${sizeRunStyleKey('Hoodie - M')}`,
      `run:${sizeRunStyleKey('Hoodie - L')}`,
    ]);
    expect(rows.map(makeDisplayUnitKeyer(rows, { sizeRuns: false }))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('XS stays its own record inside an explicit group of a family: the group claims the records, never merges them', () => {
    const rows = [
      item('xs', 'T-XS', 'Limits Tee - XS', {
        group_id: 'fam',
        variant_size: 'XS',
        display_group_id: 'g',
      }),
      item('s', 'T-S', 'Limits Tee - S', {
        group_id: 'fam',
        variant_size: 'S',
        display_group_id: 'g',
      }),
      item('m', 'T-M', 'Limits Tee - M', { group_id: 'fam', variant_size: 'M' }),
    ];
    const list = composeDisplayList(rows, {
      ...itemAccess,
      runMetaOf: runMeta,
      sizeOf: (r) => r.variant_size ?? null,
      expanded: { ...NO_EXPANSION, explicit: new Set(['g']) },
    });
    const header = list[0]!;
    expect(header.kind).toBe('explicit');
    expect(list.filter((e) => e.kind === 'row').map((e) => (e as { row: ItemRow }).row.id)).toEqual(
      ['xs', 's', 'm'],
    );
    // M is alone in its family here, so it renders as a plain row.
    expect(list.map((e) => e.kind)).toEqual(['explicit', 'row', 'row', 'row']);
  });
});

describe('the split detectors over the whole set', () => {
  it('counts a SKU only over records its explicit group does not claim (no false "partial" on a partly grouped SKU)', () => {
    const rows = [
      item('a', 'X', 'One', { display_group_id: 'g' }),
      item('b', 'Y', 'Two', { display_group_id: 'g' }),
      item('c', 'X', 'Three'),
      item('d', 'X', 'Four'),
    ];
    expect([...countUnclaimedItemRowsBySku(rows)]).toEqual([['X', 2]]);
    expect([...countItemRowsByDisplayGroup(rows)]).toEqual([['g', 2]]);
  });

  it('a group that does not form claims nothing', () => {
    const rows = [item('a', 'X', 'One', { display_group_id: 'g' }), item('b', 'X', 'Two')];
    expect([...countUnclaimedItemRowsBySku(rows)]).toEqual([['X', 2]]);
    expect(countItemRowsByDisplayGroup(rows).size).toBe(0);
  });
});

describe('chips', () => {
  it('names the group of a record shown alone, and offers a group to an unclaimed record of the same SKU', () => {
    const rows = [
      item('a', 'X', 'One', { display_group_id: 'g' }),
      item('b', 'Y', 'Two', { display_group_id: 'g' }),
      item('c', 'X', 'Three'),
      item('d', 'Q', 'Four', { display_group_id: 'h' }),
    ];
    const chips = displayGroupChips(rows, itemAccess);
    expect(chips.get('c')).toEqual({ kind: 'same-sku', groupId: 'g' });
    expect(chips.get('d')).toEqual({ kind: 'in-group', groupId: 'h' });
    expect(chips.has('a')).toBe(false);
  });
});

// People review P2: "records that share a SKU still show together
// automatically" is not true once a group takes some of a SKU's records.
// What IS true (and what the words now say): records in a group show under
// its header; records in NO group that share a SKU still show together; a
// record sharing a SKU with grouped records is marked Same SKU.
describe('a SKU split by a group (the words GROUP_COPY.skuNote describe, P2)', () => {
  it('a record left outside its SKU is NOT shown with the grouped records of that SKU; it carries the Same SKU chip', () => {
    const rows = [
      item('a', 'X', 'Tee', { display_group_id: 'g' }),
      item('b', 'X', 'Tee', { display_group_id: 'g' }),
      item('c', 'X', 'Tee'),
    ];
    const list = composeDisplayList(rows, { ...itemAccess, expanded: NO_EXPANSION });
    expect(list.map((e) => (e.kind === 'row' ? `row:${e.row.id}` : e.kind))).toEqual([
      'explicit',
      'row:c',
    ]);
    expect(displayGroupChips(rows, itemAccess).get('c')).toEqual({
      kind: 'same-sku',
      groupId: 'g',
    });
  });

  it('records in no group that share a SKU still show together, each marked Same SKU', () => {
    const rows = [
      item('a', 'X', 'Tee', { display_group_id: 'g' }),
      item('b', 'Y', 'Tee', { display_group_id: 'g' }),
      item('c', 'X', 'Tee'),
      item('d', 'X', 'Tee'),
    ];
    const list = composeDisplayList(rows, { ...itemAccess, expanded: NO_EXPANSION });
    expect(
      list.map((e) => (e.kind === 'sku' ? `sku:${e.rows.map((r) => r.id).join('')}` : e.kind)),
    ).toEqual(['explicit', 'sku:cd']);
    const chips = displayGroupChips(rows, itemAccess);
    expect(chips.get('c')).toEqual({ kind: 'same-sku', groupId: 'g' });
    expect(chips.get('d')).toEqual({ kind: 'same-sku', groupId: 'g' });
  });
});

describe('composeDisplayList (the one render composition, web and phone)', () => {
  it('renders every row exactly once, collapsed or expanded', () => {
    const rows = [
      item('a', 'X', 'Tee - S', { display_group_id: 'g' }),
      item('b', 'Y', 'Tee - M', { display_group_id: 'g' }),
      item('c', 'Z', 'Hoodie - M'),
      item('d', 'W', 'Hoodie - L'),
      item('e', 'V', 'Plain'),
      item('f', 'V', 'Plain'),
    ];
    for (const expanded of [
      NO_EXPANSION,
      {
        explicit: new Set(['g']),
        skus: new Set(['V']),
        runs: new Set([sizeRunStyleKey('Hoodie - M')!]),
      },
    ]) {
      const list = composeDisplayList(rows, { ...itemAccess, runMetaOf: runMeta, expanded });
      const cards = cardsOf(list, (r) => r.id)
        .flat()
        .sort();
      expect(cards).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    }
  });

  it('REGRESSION (V3): expanding a SKU header never pulls its rows into a size run elsewhere', () => {
    // A and B share SKU X ("Tee - S", two racks); C "Tee - M", D "Tee - L".
    const rows: PlacementRowT[] = [
      {
        rowKey: 'A',
        itemId: 'A',
        name: 'Tee - S',
        sku: 'X',
        quantity_on_hand: 4,
        line_quantity: 4,
      },
      {
        rowKey: 'B',
        itemId: 'B',
        name: 'Tee - S',
        sku: 'X',
        quantity_on_hand: 4,
        line_quantity: 4,
      },
      {
        rowKey: 'C',
        itemId: 'C',
        name: 'Tee - M',
        sku: 'Y',
        quantity_on_hand: 2,
        line_quantity: 2,
      },
      {
        rowKey: 'D',
        itemId: 'D',
        name: 'Tee - L',
        sku: 'Z',
        quantity_on_hand: 4,
        line_quantity: 4,
      },
    ];
    const access = {
      itemIdOf: (r: PlacementRowT) => r.itemId,
      skuOf: (r: PlacementRowT) => r.sku,
      displayGroupOf: (r: PlacementRowT) => r.display_group_id ?? null,
      runMetaOf: runMeta,
    };
    const shape = (expandedSkus: Set<string>) =>
      composeDisplayList(rows, {
        ...access,
        expanded: { ...NO_EXPANSION, skus: expandedSkus },
      }).map((e) =>
        e.kind === 'run'
          ? `RUN ${e.run.total} [${e.run.members.map((m) => m.rowKey).join(',')}]`
          : e.kind === 'sku'
            ? `SKU ${e.sku}`
            : e.kind === 'row'
              ? `${e.nested ? '  ' : ''}${e.row.rowKey}`
              : 'E',
      );
    expect(shape(new Set())).toEqual(['SKU X', 'RUN 6 [C,D]']);
    expect(shape(new Set(['X']))).toEqual(['SKU X', '  A', '  B', 'RUN 6 [C,D]']);
  });

  it('places a group at its first member and keeps the rest of the order', () => {
    const rows = [
      item('p', 'P', 'Plain'),
      item('a', 'X', 'One', { display_group_id: 'g' }),
      item('q', 'Q', 'Plain two'),
      item('b', 'Y', 'Two', { display_group_id: 'g' }),
    ];
    const list = composeDisplayList(rows, { ...itemAccess, expanded: NO_EXPANSION });
    expect(cardsOf(list, (r) => r.id)).toEqual([['p'], ['a', 'b'], ['q']]);
  });

  it('orders a group by stored size when every member has one, else by arrival; Books never parse a size', () => {
    const rows = [
      item('l', 'L1', 'Tee - L', { display_group_id: 'g', variant_size: 'L' }),
      item('xs', 'X1', 'Tee - XS', { display_group_id: 'g', variant_size: 'XS' }),
      item('m', 'M1', 'Tee - M', { display_group_id: 'g', variant_size: 'M' }),
    ];
    const sized = composeDisplayList(rows, {
      ...itemAccess,
      sizeOf: (r) => r.variant_size ?? null,
      expanded: NO_EXPANSION,
    });
    expect((sized[0] as { rows: ItemRow[] }).rows.map((r) => r.id)).toEqual(['xs', 'm', 'l']);
    const books = composeDisplayList(rows, { ...itemAccess, expanded: NO_EXPANSION });
    expect((books[0] as { rows: ItemRow[] }).rows.map((r) => r.id)).toEqual(['l', 'xs', 'm']);
  });

  it('two books with one title and different ISBNs stay two records under one header (no size runs, no merge)', () => {
    const rows = [
      item('e1', 'B-1', 'Earth Science', { display_group_id: 'g' }),
      item('e2', 'B-2', 'Earth Science', { display_group_id: 'g' }),
    ];
    const list = composeDisplayList(rows, {
      ...itemAccess,
      expanded: { ...NO_EXPANSION, explicit: new Set(['g']) },
    });
    expect(list.map((e) => e.kind)).toEqual(['explicit', 'row', 'row']);
  });
});

describe('membership index (the list loaders read memberships, not columns)', () => {
  it('maps record -> {id, name, version}, accepting an embedded group as an object or an array', () => {
    const idx = indexDisplayGroupMemberships([
      { item_id: 'a', group_id: 'g', item_display_groups: { id: 'g', name: 'Polo', version: 2 } },
      { item_id: 'b', group_id: 'g', item_display_groups: [{ id: 'g', name: 'Polo', version: 2 }] },
      { item_id: 'c', group_id: 'h', item_display_groups: null },
    ]);
    expect(idx.get('a')).toEqual({ id: 'g', name: 'Polo', version: 2 });
    expect(idx.get('b')).toEqual({ id: 'g', name: 'Polo', version: 2 });
    // The name read failed or is hidden: the key still rides on the row.
    expect(idx.get('c')).toEqual({ id: 'h', name: null, version: null });
  });
});

// ── Properties ──────────────────────────────────────────────────────────────

/** A small deterministic generator (no Math.random: reproducible). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function randomItems(seed: number, withGroups: boolean): ItemRow[] {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 14);
  const names = [
    'Tee - S',
    'Tee - M',
    'Tee - L',
    'Hoodie - XS',
    'Hoodie - XL',
    'Plain',
    'Book',
    'Cap',
  ];
  const skus = ['A', 'B', 'C', 'D', '', 'E'];
  const groups = withGroups ? [null, null, 'g1', 'g2'] : [null];
  const fams = [null, null, null, 'f1'];
  return Array.from({ length: n }, (_, i) =>
    item(`i${i}`, pick(r, skus), pick(r, names), {
      display_group_id: pick(r, groups),
      group_id: pick(r, fams),
      quantity_on_hand: Math.floor(r() * 5),
    }),
  );
}

/** Today's runAwarePages unit key (instant-mode.ts before Group selected),
 *  on raw SKUs: the P3 reference. */
function legacyKeyer(rows: readonly ItemRow[], sizeRuns: boolean): (r: ItemRow) => string | null {
  const runKeyOf = (r: ItemRow) => (r.group_id ? `group:${r.group_id}` : sizeRunStyleKey(r.name));
  const runCounts = new Map<string, number>();
  const skuCounts = new Map<string, number>();
  for (const r of rows) {
    if (sizeRuns) {
      const k = runKeyOf(r);
      if (k) runCounts.set(k, (runCounts.get(k) ?? 0) + 1);
    }
    if (r.sku.trim()) skuCounts.set(r.sku, (skuCounts.get(r.sku) ?? 0) + 1);
  }
  return (r) => {
    if (r.sku.trim() && (skuCounts.get(r.sku) ?? 0) >= 2) return `sku:${r.sku}`;
    if (!sizeRuns) return null;
    const k = runKeyOf(r);
    if (k && (runCounts.get(k) ?? 0) >= 2) return `run:${k}`;
    return null;
  };
}

describe('properties (deterministic random fixtures)', () => {
  it('P1: the keyer and the render composition make the SAME item-level units', () => {
    let cases = 0;
    for (let seed = 1; seed <= 2500; seed++) {
      for (const sizeRuns of [true, false]) {
        const rows = randomItems(seed, true);
        const units = unitsOf(rows, makeDisplayUnitKeyer(rows, { sizeRuns }));
        const list = composeDisplayList(rows, {
          ...itemAccess,
          ...(sizeRuns ? { runMetaOf: runMeta } : {}),
          expanded: NO_EXPANSION,
        });
        expect(
          cardsOf(list, (r) => r.id)
            .map((c) => [...c].sort())
            .sort(),
        ).toEqual(units.map((u) => [...u].sort()).sort());
        cases++;
      }
    }
    expect(cases).toBe(5000);
  });

  it('P2: on placement rows every row renders exactly once, and every card stays inside one item-level unit', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const items = randomItems(seed, true);
      const r = rng(seed * 7);
      const rows: PlacementRowT[] = items.flatMap((it) => {
        const racks = 1 + Math.floor(r() * 3);
        return Array.from({ length: racks }, (_, k) => ({
          rowKey: `${it.id}:${k}`,
          itemId: it.id,
          name: it.name,
          sku: it.sku,
          group_id: it.group_id,
          display_group_id: it.display_group_id,
          quantity_on_hand: it.quantity_on_hand,
          line_quantity: 1,
        }));
      });
      const unitOf = new Map<string, string>();
      const key = makeDisplayUnitKeyer(items, { sizeRuns: true });
      for (const it of items) unitOf.set(it.id, key(it) ?? `single:${it.id}`);
      const access = {
        itemIdOf: (p: PlacementRowT) => p.itemId,
        skuOf: (p: PlacementRowT) => p.sku,
        displayGroupOf: (p: PlacementRowT) => p.display_group_id ?? null,
        runMetaOf: runMeta,
      };
      const everything = {
        explicit: new Set(['g1', 'g2']),
        skus: new Set(['A', 'B', 'C', 'D', 'E']),
        runs: new Set(
          items
            .map((i) => (i.group_id ? `group:${i.group_id}` : sizeRunStyleKey(i.name)))
            .filter((k): k is string => !!k),
        ),
      };
      for (const expanded of [NO_EXPANSION, everything]) {
        const list = composeDisplayList(rows, { ...access, expanded });
        // Exactly once: collapsed cards cover every row; expanded rows are the
        // cards' own rows, never a second copy elsewhere.
        const top = list.flatMap((e) =>
          e.kind === 'row'
            ? e.nested
              ? []
              : [e.row.rowKey]
            : (e.kind === 'run' ? e.run.members : e.rows).map((m) => m.rowKey),
        );
        expect([...top].sort()).toEqual(rows.map((p) => p.rowKey).sort());
        for (const e of list) {
          if (e.kind === 'row') continue;
          const members = e.kind === 'run' ? e.run.members : e.rows;
          expect(new Set(members.map((m) => unitOf.get(m.itemId))).size).toBe(1);
        }
        if (expanded === everything) {
          const nested = list
            .filter((e) => e.kind === 'row' && e.nested)
            .map((e) => (e as { row: PlacementRowT }).row.rowKey);
          const inCards = list.flatMap((e) =>
            e.kind === 'row'
              ? []
              : (e.kind === 'run' ? e.run.members : e.rows).map((m) => m.rowKey),
          );
          expect([...nested].sort()).toEqual([...inCards].sort());
        }
      }
    }
  });

  it("P3: with no explicit groups the units are exactly today's", () => {
    // The partition is compared, not the key strings: today's keyer counted a
    // run over rows already in a SKU family, so it could key a run of ONE
    // free row ("run:x", a unit of one) where the new keyer says single. The
    // units, and so the pages, are the same.
    for (let seed = 1; seed <= 3000; seed++) {
      for (const sizeRuns of [true, false]) {
        const rows = randomItems(seed, false);
        expect(unitsOf(rows, makeDisplayUnitKeyer(rows, { sizeRuns }))).toEqual(
          unitsOf(rows, legacyKeyer(rows, sizeRuns)),
        );
      }
    }
  });

  it('totals: a size run inside the composition counts each record once (never once per rack row)', () => {
    const rows: PlacementRowT[] = [
      {
        rowKey: 'm:1',
        itemId: 'm',
        name: 'Tee - M',
        sku: 'M',
        quantity_on_hand: 10,
        line_quantity: 4,
      },
      {
        rowKey: 'l:1',
        itemId: 'l',
        name: 'Tee - L',
        sku: 'L',
        quantity_on_hand: 7,
        line_quantity: 7,
      },
    ];
    const list = composeDisplayList(rows, {
      itemIdOf: (r) => r.itemId,
      skuOf: (r) => r.sku,
      displayGroupOf: () => null,
      runMetaOf: runMeta,
      expanded: NO_EXPANSION,
    });
    const first = list[0]!;
    expect(first.kind === 'run' && first.run.total).toBe(17);
    // Same answer as calling the size-run pass directly on the item rows.
    expect(
      groupBySizeRun(rows, (r) => ({
        key: r.rowKey,
        unitKey: r.itemId,
        groupable: true,
        ...runMeta(r),
      }))[0],
    ).toMatchObject({ kind: 'size-run', group: { total: 17 } });
  });
});

describe('the shared parity fixture (core, web and phone run it)', () => {
  it('every case lists the item-level units the keyer must make', () => {
    for (const c of DISPLAY_UNITS_PARITY_FIXTURE) {
      const units = unitsOf(c.rows, makeDisplayUnitKeyer(c.rows, { sizeRuns: c.sizeRuns }));
      expect({ name: c.name, units }).toEqual({ name: c.name, units: c.units });
    }
  });
});
