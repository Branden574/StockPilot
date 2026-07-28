import { describe, expect, it } from 'vitest';

import {
  buildSizeOrder,
  compareSizeValues,
  sortBySizeOrder,
  splitIntoSizeRuns,
} from './size-order';

describe('buildSizeOrder', () => {
  it('keys the lookup on the NORMALIZED value so a scale row and an item size agree', () => {
    const order = buildSizeOrder([
      { value: ' xl ', sortOrder: 50 },
      { value: '10.0', sortOrder: 3 },
    ]);
    expect(order.get('XL')).toBe(50);
    expect(order.get('10')).toBe(3);
  });

  it('admits the stored normalized form as a second key', () => {
    const order = buildSizeOrder([{ value: 'X-Large', normalized: 'XL', sortOrder: 7 }]);
    expect(order.get('X-LARGE')).toBe(7);
    expect(order.get('XL')).toBe(7);
  });

  it('ignores blank rows rather than mapping them to a rank', () => {
    const order = buildSizeOrder([{ value: '   ', sortOrder: 1 }]);
    expect(order.size).toBe(0);
  });

  it('keeps the FIRST sort_order when a scale repeats a normalized value', () => {
    const order = buildSizeOrder([
      { value: 'XL', sortOrder: 50 },
      { value: 'xl', sortOrder: 99 },
    ]);
    expect(order.get('XL')).toBe(50);
  });
});

describe('compareSizeValues — the scale drives the order', () => {
  const shoeScale = buildSizeOrder([
    { value: '9', sortOrder: 0 },
    { value: '9.5', sortOrder: 1 },
    { value: '10', sortOrder: 2 },
    { value: '10.5', sortOrder: 3 },
    { value: '11', sortOrder: 4 },
  ]);

  it('sorts 10 AFTER 9 even though "10" < "9" as a string', () => {
    expect(compareSizeValues('10', '9', shoeScale)).toBeGreaterThan(0);
    expect(['10', '9', '9.5'].sort((a, b) => compareSizeValues(a, b, shoeScale))).toEqual([
      '9',
      '9.5',
      '10',
    ]);
  });

  it('places a size the scale does not carry AFTER every size it does', () => {
    expect(compareSizeValues('13', '11', shoeScale)).toBeGreaterThan(0);
  });

  it('normalizes before looking a size up, so " 10.0 " hits the 10 row', () => {
    expect(compareSizeValues(' 10.0 ', '11', shoeScale)).toBeLessThan(0);
  });
});

describe('compareSizeValues — fallback when the category carries no scale', () => {
  it('sorts XL AFTER L rather than alphabetically', () => {
    expect(compareSizeValues('XL', 'L')).toBeGreaterThan(0);
    expect(['XL', 'S', 'L', 'M', 'XS'].sort((a, b) => compareSizeValues(a, b))).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
    ]);
  });

  it('sorts 10 after 9 numerically and keeps halves in place', () => {
    expect(['11', '9', '10.5', '10'].sort((a, b) => compareSizeValues(a, b))).toEqual([
      '9',
      '10',
      '10.5',
      '11',
    ]);
  });

  it('ranks 2XL and XXL together — a DISPLAY tie, never a merge', () => {
    // Equal rank means the two rows sit next to each other in the grid. They
    // are still two separate lines: nothing here merges identity (that is
    // deliberately Tasks 17/19 territory).
    expect(compareSizeValues('2XL', 'XXL')).toBe(0);
    expect(compareSizeValues('2XL', 'XL')).toBeGreaterThan(0);
    expect(compareSizeValues('3XL', '2XL')).toBeGreaterThan(0);
  });

  it('puts numeric sizes before alpha sizes so a mixed run is still deterministic', () => {
    expect(compareSizeValues('10', 'M')).toBeLessThan(0);
  });

  it('sorts an unrecognised size after everything known, then alphabetically', () => {
    expect(compareSizeValues('ONE SIZE', 'XL')).toBeGreaterThan(0);
    expect(compareSizeValues('ALPHA', 'BETA')).toBeLessThan(0);
  });

  it('sorts a missing size last and treats two missing sizes as equal', () => {
    expect(compareSizeValues(null, 'XS')).toBeGreaterThan(0);
    expect(compareSizeValues('', 'XS')).toBeGreaterThan(0);
    expect(compareSizeValues(null, undefined)).toBe(0);
  });
});

describe('sortBySizeOrder', () => {
  const lines = [
    { id: 'c', size: '11' },
    { id: 'a', size: '9' },
    { id: 'b', size: '10' },
  ];

  it('returns a NEW array ordered by size, leaving the input untouched', () => {
    const sorted = sortBySizeOrder(lines, (l) => l.size);
    expect(sorted.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(lines.map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });

  it('is stable for equal ranks — two rows of the same size keep input order', () => {
    const dupes = [
      { id: 'second', size: 'M' },
      { id: 'first', size: 'M' },
    ];
    expect(sortBySizeOrder(dupes, (l) => l.size).map((l) => l.id)).toEqual([
      'second',
      'first',
    ]);
  });

  it('honours a supplied scale order over the fallback ladder', () => {
    // A deliberately reversed scale: the scale WINS, proving the sort is not
    // quietly falling back to the natural ladder.
    const reversed = buildSizeOrder([
      { value: 'S', sortOrder: 3 },
      { value: 'M', sortOrder: 2 },
      { value: 'L', sortOrder: 1 },
    ]);
    const alpha = [{ id: 's', size: 'S' }, { id: 'm', size: 'M' }, { id: 'l', size: 'L' }];
    expect(sortBySizeOrder(alpha, (l) => l.size, reversed).map((l) => l.id)).toEqual([
      'l',
      'm',
      's',
    ]);
  });
});

describe('splitIntoSizeRuns', () => {
  const row = (id: string, groupId: string | null, variantSize: string | null) => ({
    id,
    groupId,
    variantSize,
  });

  it('collapses two or more rows of one group into a single run', () => {
    const blocks = splitIntoSizeRuns([
      row('a', 'g1', '9'),
      row('b', 'g1', '10'),
      row('c', 'g1', '11'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'run', groupId: 'g1' });
  });

  it('leaves a lone grouped row loose — one row is not a run', () => {
    const blocks = splitIntoSizeRuns([row('a', 'g1', 'M')]);
    expect(blocks[0]?.kind).toBe('loose');
  });

  it('leaves every ungrouped row loose, in order', () => {
    const blocks = splitIntoSizeRuns([row('a', null, null), row('b', null, null)]);
    expect(blocks.map((b) => b.kind)).toEqual(['loose', 'loose']);
    expect(blocks.flatMap((b) => b.lines.map((l) => l.id))).toEqual(['a', 'b']);
  });

  it('anchors a run where its FIRST row sat', () => {
    const blocks = splitIntoSizeRuns([
      row('x', null, null),
      row('a', 'g1', '9'),
      row('y', null, null),
      row('b', 'g1', '10'),
    ]);
    expect(blocks.map((b) => (b.kind === 'run' ? b.groupId : b.lines[0]?.id))).toEqual([
      'x',
      'g1',
      'y',
    ]);
  });

  it('sorts each run through the order the caller resolves for THAT group', () => {
    const g1 = buildSizeOrder([
      { value: '9', sortOrder: 0 },
      { value: '10', sortOrder: 1 },
    ]);
    const blocks = splitIntoSizeRuns(
      [row('b', 'g1', '10'), row('a', 'g1', '9')],
      (id) => (id === 'g1' ? g1 : null),
    );
    expect(blocks[0]?.lines.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the rows it was handed', () => {
    const rows = [row('b', 'g1', '10'), row('a', 'g1', '9')];
    splitIntoSizeRuns(rows);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
