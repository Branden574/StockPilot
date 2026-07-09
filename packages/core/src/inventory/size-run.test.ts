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
});
