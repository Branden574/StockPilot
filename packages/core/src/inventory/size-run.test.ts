import { describe, expect, it } from 'vitest';

import {
  extractSize,
  groupBySizeRun,
  hasSizeSuffix,
  sizeRunStyleKey,
  stripSizeSuffix,
  stripSkuSuffix,
  type SizeRunEntryMeta,
} from './size-run';

describe('hasSizeSuffix', () => {
  it('matches a dash-separated trailing size', () => {
    expect(hasSizeSuffix('L4L - Pink Shirt - XL')).toBe(true);
    expect(hasSizeSuffix('L4L - Pink Shirt - L')).toBe(true);
  });

  it('matches numeric-prefixed sizes (2XL/3XL/…) — the gap the old parser missed', () => {
    expect(hasSizeSuffix('L4L - Pink Shirt - 2XL')).toBe(true);
    expect(hasSizeSuffix('Tee - 3XL')).toBe(true);
    expect(hasSizeSuffix('Tee - 5XL')).toBe(true);
  });

  it('matches a space-separated trailing size', () => {
    expect(hasSizeSuffix("L4L Grey Quarter Zip Men's XXL")).toBe(true);
    expect(hasSizeSuffix('Widget 2XL')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasSizeSuffix('pink shirt - xl')).toBe(true);
    expect(hasSizeSuffix('pink shirt - 2xl')).toBe(true);
  });

  it('does NOT match a base name with no size', () => {
    expect(hasSizeSuffix('L4L - Pink Shirt')).toBe(false);
    expect(hasSizeSuffix('L4L')).toBe(false);
  });

  it('does NOT match a size letter embedded mid-word (needs a real separator)', () => {
    expect(hasSizeSuffix('Class')).toBe(false); // trailing "s" is not a separated size
    expect(hasSizeSuffix('Small')).toBe(false);
  });
});

describe('stripSizeSuffix', () => {
  it('strips the trailing size, leaving the base name', () => {
    expect(stripSizeSuffix('L4L - Pink Shirt - XL')).toBe('L4L - Pink Shirt');
    expect(stripSizeSuffix('L4L - Pink Shirt - 2XL')).toBe('L4L - Pink Shirt');
    expect(stripSizeSuffix('L4L - Pink Shirt - L')).toBe('L4L - Pink Shirt');
    expect(stripSizeSuffix("L4L Grey Quarter Zip Men's XXL")).toBe("L4L Grey Quarter Zip Men's");
  });

  it('returns the (trimmed) original when there is no size suffix', () => {
    expect(stripSizeSuffix('L4L - Pink Shirt')).toBe('L4L - Pink Shirt');
    expect(stripSizeSuffix('  Widget  ')).toBe('Widget');
  });
});

describe('extractSize', () => {
  it('returns the uppercased size token', () => {
    expect(extractSize('L4L - Pink Shirt - XL')).toBe('XL');
    expect(extractSize('L4L - Pink Shirt - 2XL')).toBe('2XL');
    expect(extractSize('pink shirt - xl')).toBe('XL');
  });

  it('returns null when there is no size', () => {
    expect(extractSize('L4L - Pink Shirt')).toBeNull();
  });
});

describe('sizeRunStyleKey', () => {
  it('is a case- and whitespace-normalized base — same run groups regardless of size casing', () => {
    const a = sizeRunStyleKey('L4L - Pink Shirt - L');
    const b = sizeRunStyleKey('L4L - Pink Shirt - XL');
    const c = sizeRunStyleKey('l4l - pink shirt - 2XL');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('differs for genuinely different products', () => {
    expect(sizeRunStyleKey('Pink Shirt - L')).not.toBe(sizeRunStyleKey('Blue Shirt - L'));
  });

  it('is null for an item with no size suffix (never groups)', () => {
    expect(sizeRunStyleKey('L4L - Pink Shirt')).toBeNull();
    expect(sizeRunStyleKey('Random Widget')).toBeNull();
  });
});

describe('stripSkuSuffix (backward-compat with Add-more-sizes)', () => {
  it('strips a size suffix from the SKU only when the NAME looks sized', () => {
    expect(stripSkuSuffix('SP-ABC-XL', 'Tee - XL')).toBe('SP-ABC');
    expect(stripSkuSuffix('SP-ABC-2XL', 'Tee - 2XL')).toBe('SP-ABC');
  });

  it('leaves a random SKU alone when the name is NOT sized', () => {
    expect(stripSkuSuffix('SP-OKX68-UAL', 'Widget')).toBe('SP-OKX68-UAL');
  });

  it('returns null for a null sku', () => {
    expect(stripSkuSuffix(null, 'Tee - XL')).toBeNull();
  });
});

describe('groupBySizeRun', () => {
  interface Row {
    id: string;
    name: string;
    qty: number;
    groupable?: boolean;
  }
  const meta = (r: Row): SizeRunEntryMeta => ({
    key: r.id,
    name: r.name,
    quantity: r.qty,
    groupable: r.groupable ?? true,
  });

  it("collapses the owner's Pink Shirt run into one group totaling 18", () => {
    const rows: Row[] = [
      { id: 'l', name: 'L4L - Pink Shirt - L', qty: 6 },
      { id: 'xl', name: 'L4L - Pink Shirt - XL', qty: 6 },
      { id: '2xl', name: 'L4L - Pink Shirt - 2XL', qty: 6 },
    ];
    const out = groupBySizeRun(rows, meta);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('size-run');
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.total).toBe(18);
    expect(out[0].group.sizeCount).toBe(3);
    expect(out[0].group.baseName).toBe('L4L - Pink Shirt');
    expect(out[0].group.members.map((m) => m.id)).toEqual(['l', 'xl', '2xl']);
  });

  it('does NOT group a lone sized item (needs 2+ sharing a base)', () => {
    const out = groupBySizeRun([{ id: 'a', name: 'Solo Tee - XL', qty: 3 }], meta);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('single');
  });

  it('leaves un-sized items ungrouped and pulls a run to its first member', () => {
    const rows: Row[] = [
      { id: 'l', name: 'Pink Shirt - L', qty: 5 },
      { id: 'w', name: 'Random Widget', qty: 9 },
      { id: 'xl', name: 'Pink Shirt - XL', qty: 7 },
    ];
    const out = groupBySizeRun(rows, meta);
    expect(out.map((e) => e.kind)).toEqual(['size-run', 'single']);
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.total).toBe(12);
    expect(out[0].group.members.map((m) => m.id)).toEqual(['l', 'xl']);
    if (out[1]?.kind !== 'single') throw new Error('expected single');
    expect(out[1].entry.id).toBe('w');
  });

  it('keeps two different runs separate', () => {
    const rows: Row[] = [
      { id: 'pl', name: 'Pink Shirt - L', qty: 1 },
      { id: 'bl', name: 'Blue Shirt - L', qty: 2 },
      { id: 'px', name: 'Pink Shirt - XL', qty: 3 },
      { id: 'bx', name: 'Blue Shirt - XL', qty: 4 },
    ];
    const out = groupBySizeRun(rows, meta);
    expect(out).toHaveLength(2);
    if (out[0]?.kind !== 'size-run' || out[1]?.kind !== 'size-run') throw new Error('two runs');
    expect(out[0].group.baseName).toBe('Pink Shirt');
    expect(out[0].group.total).toBe(4);
    expect(out[1].group.baseName).toBe('Blue Shirt');
    expect(out[1].group.total).toBe(6);
  });

  it('never folds a non-groupable entry (e.g. a multi-placement SKU header) into a run', () => {
    const rows: Row[] = [
      { id: 'l', name: 'Pink Shirt - L', qty: 5 },
      { id: 'xl', name: 'Pink Shirt - XL', qty: 5, groupable: false },
    ];
    const out = groupBySizeRun(rows, meta);
    // Only one sized+groupable member → no run; both stay single.
    expect(out.map((e) => e.kind)).toEqual(['single', 'single']);
  });

  it('reports groupId null and countingUnit null for a legacy name-keyed run', () => {
    const out = groupBySizeRun(
      [
        { id: 'l', name: 'Pink Shirt - L', qty: 1 },
        { id: 'xl', name: 'Pink Shirt - XL', qty: 1 },
      ],
      meta,
    );
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.groupId).toBeNull();
    expect(out[0].group.countingUnit).toBeNull();
  });
});

describe('groupBySizeRun — stored group_id is the only signal when present', () => {
  interface GRow {
    id: string;
    name: string;
    qty: number;
    groupId?: string | null;
    variantSize?: string | null;
    countingUnit?: string | null;
  }
  const gmeta = (r: GRow): SizeRunEntryMeta => ({
    key: r.id,
    name: r.name,
    quantity: r.qty,
    groupable: true,
    groupId: r.groupId ?? null,
    variantSize: r.variantSize ?? null,
    countingUnit: r.countingUnit ?? null,
  });

  it('groups two items with the SAME groupId but unrelated names (a rename cannot break a family)', () => {
    const rows: GRow[] = [
      { id: 'a', name: 'Nike Pegasus 41', qty: 4, groupId: 'grp-1', variantSize: '9' },
      { id: 'b', name: 'Totally Different Label', qty: 6, groupId: 'grp-1', variantSize: '10' },
    ];
    const out = groupBySizeRun(rows, gmeta);
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.styleKey).toBe('group:grp-1');
    expect(out[0].group.groupId).toBe('grp-1');
    expect(out[0].group.total).toBe(10);
    expect(out[0].group.sizeCount).toBe(2);
  });

  it('does NOT group a same-base name pair carrying DIFFERENT groupIds (a name cannot forge a family)', () => {
    const rows: GRow[] = [
      { id: 'a', name: 'Pink Shirt - L', qty: 1, groupId: 'grp-1', variantSize: 'L' },
      { id: 'b', name: 'Pink Shirt - XL', qty: 1, groupId: 'grp-2', variantSize: 'XL' },
    ];
    const out = groupBySizeRun(rows, gmeta);
    expect(out.map((e) => e.kind)).toEqual(['single', 'single']);
  });

  it('never lets a grouped item fall back into a name-keyed run with its ungrouped lookalikes', () => {
    const rows: GRow[] = [
      { id: 'g', name: 'Pink Shirt - L', qty: 1, groupId: 'grp-1', variantSize: 'L' },
      { id: 'u1', name: 'Pink Shirt - XL', qty: 2 },
      { id: 'u2', name: 'Pink Shirt - 2XL', qty: 3 },
    ];
    const out = groupBySizeRun(rows, gmeta);
    // The grouped item is alone in its group → single. The two ungrouped
    // lookalikes still collapse on the legacy heuristic.
    expect(out.map((e) => e.kind)).toEqual(['single', 'size-run']);
    if (out[1]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[1].group.members.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  // REGRESSION FOR MIGRATION 0303. The backfill puts every historical sized
  // item into a state no test covered before: variantSize SET, groupId still
  // NULL. That state is the whole owner decision — grouping is opt-in, so the
  // display heuristic has to keep carrying these families until a human links
  // them in the review tool. If the backfill's new column quietly became a
  // grouping signal, every ungrouped run in every org would change shape on
  // deploy, which is exactly the silent re-identification the decision forbids.
  it('still collapses a BACKFILLED-but-ungrouped family on the name heuristic', () => {
    const rows: GRow[] = [
      { id: 'a', name: 'Pink Shirt - L', qty: 1, groupId: null, variantSize: 'L' },
      { id: 'b', name: 'Pink Shirt - XL', qty: 2, groupId: null, variantSize: 'XL' },
      { id: 'c', name: 'Pink Shirt - 2XL', qty: 3, groupId: null, variantSize: '2XL' },
    ];
    const out = groupBySizeRun(rows, gmeta);
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    // Keyed on the NAME, not on the freshly backfilled size.
    expect(out[0].group.styleKey).toBe('pink shirt');
    expect(out[0].group.groupId).toBeNull();
    expect(out[0].group.total).toBe(6);
    expect(out[0].group.sizeCount).toBe(3);
    // Arrival order, byte-identically to before the backfill: a name-keyed run
    // is never re-sorted on the strength of a parsed token.
    expect(out[0].group.members.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not fold two DIFFERENT ungrouped styles together just because both now carry a size', () => {
    const rows: GRow[] = [
      { id: 'a', name: 'Pink Shirt - L', qty: 1, groupId: null, variantSize: 'L' },
      { id: 'b', name: 'Blue Hoodie - L', qty: 1, groupId: null, variantSize: 'L' },
    ];
    expect(groupBySizeRun(rows, gmeta).map((e) => e.kind)).toEqual(['single', 'single']);
  });

  it('size-orders a group-keyed run (10 after 9, XL after L) whatever order the rows arrive in', () => {
    const numeric = groupBySizeRun(
      [
        { id: 'ten', name: 'Peg', qty: 1, groupId: 'g', variantSize: '10' },
        { id: 'nine', name: 'Peg', qty: 1, groupId: 'g', variantSize: '9' },
        { id: 'elevenhalf', name: 'Peg', qty: 1, groupId: 'g', variantSize: '11.5' },
      ] satisfies GRow[],
      gmeta,
    );
    if (numeric[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(numeric[0].group.members.map((m) => m.id)).toEqual(['nine', 'ten', 'elevenhalf']);

    const alpha = groupBySizeRun(
      [
        { id: 'xl', name: 'Tee', qty: 1, groupId: 'g', variantSize: 'XL' },
        { id: 's', name: 'Tee', qty: 1, groupId: 'g', variantSize: 'S' },
        { id: 'l', name: 'Tee', qty: 1, groupId: 'g', variantSize: 'L' },
      ] satisfies GRow[],
      gmeta,
    );
    if (alpha[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(alpha[0].group.members.map((m) => m.id)).toEqual(['s', 'l', 'xl']);
  });

  it('carries the counting unit onto the header so it can say "pairs" not just a number', () => {
    const out = groupBySizeRun(
      [
        { id: 'a', name: 'Peg', qty: 20, groupId: 'g', variantSize: '9', countingUnit: 'pair' },
        { id: 'b', name: 'Peg', qty: 32, groupId: 'g', variantSize: '10', countingUnit: 'pair' },
      ] satisfies GRow[],
      gmeta,
    );
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.countingUnit).toBe('pair');
    expect(out[0].group.total).toBe(52);
  });

  it('groups a run of stored variants that carry NO size suffix in their names at all', () => {
    // The exact case the name regex can never serve: real sports variants are
    // named "Nike Pegasus 41" three times over and differ only by variant_size.
    const rows: GRow[] = [
      { id: 'a', name: 'Nike Pegasus 41', qty: 2, groupId: 'g', variantSize: '9' },
      { id: 'b', name: 'Nike Pegasus 41', qty: 3, groupId: 'g', variantSize: '10' },
      { id: 'c', name: 'Nike Pegasus 41', qty: 4, groupId: 'g', variantSize: '11' },
    ];
    const out = groupBySizeRun(rows, gmeta);
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.baseName).toBe('Nike Pegasus 41');
    expect(out[0].group.total).toBe(9);
  });

  it('leaves the legacy path untouched when every groupId is null', () => {
    // Same rows as the ungrouped suite above, run through the group-aware meta:
    // identical output, so an org that has opted nothing in sees no change.
    const rows: GRow[] = [
      { id: 'l', name: 'L4L - Pink Shirt - L', qty: 6 },
      { id: 'xl', name: 'L4L - Pink Shirt - XL', qty: 6 },
      { id: '2xl', name: 'L4L - Pink Shirt - 2XL', qty: 6 },
    ];
    const out = groupBySizeRun(rows, gmeta);
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.styleKey).toBe('l4l - pink shirt');
    expect(out[0].group.total).toBe(18);
    // Arrival order preserved — NOT re-sorted by a parsed token.
    expect(out[0].group.members.map((m) => m.id)).toEqual(['l', 'xl', '2xl']);
  });

  it('keeps a name-keyed run in ARRIVAL order even when its parsed sizes are backwards', () => {
    const rows: GRow[] = [
      { id: '2xl', name: 'Tee - 2XL', qty: 1 },
      { id: 's', name: 'Tee - S', qty: 1 },
    ];
    const out = groupBySizeRun(rows, gmeta);
    if (out[0]?.kind !== 'size-run') throw new Error('expected size-run');
    expect(out[0].group.members.map((m) => m.id)).toEqual(['2xl', 's']);
  });
});
