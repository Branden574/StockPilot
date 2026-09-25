import { describe, expect, it } from 'vitest';

import {
  itemMatchTier,
  normalizeItemSearch,
  rankItemMatches,
  type RankableItem,
} from './rank-item-matches';

function item(
  id: string,
  name: string,
  sku: string,
  over: Partial<RankableItem> = {},
): RankableItem {
  return { id, name, sku, barcode: null, model_number: null, ...over };
}

describe('itemMatchTier', () => {
  it('an SKU or barcode equal to the search is exact, in any case', () => {
    expect(itemMatchTier(item('a', 'Zebra pen', 'PEN-10'), 'pen-10')).toBe('exact');
    expect(
      itemMatchTier(item('a', 'Zebra pen', 'X', { barcode: '0123456789012' }), '0123456789012'),
    ).toBe('exact');
  });

  it('an extra exact code (the other ISBN form) is exact on the barcode', () => {
    const book = item('b', "Charlotte's Web", 'BK-1', { barcode: '014240733X' });
    expect(itemMatchTier(book, '9780142407332', ['9780142407332', '014240733x'])).toBe('exact');
  });

  it('name or SKU starting with the search is prefix', () => {
    expect(itemMatchTier(item('a', 'Pencil, No. 2', 'W-1'), 'pen')).toBe('prefix');
    expect(itemMatchTier(item('a', 'Graphite', 'PEN-10'), 'pen')).toBe('prefix');
  });

  it('a word inside the name starting with the search is word', () => {
    expect(itemMatchTier(item('a', 'Blue Pen', 'B-1'), 'pen')).toBe('word');
    expect(itemMatchTier(item('a', 'Kit (pen) red', 'B-1'), 'pen')).toBe('word');
  });

  it('a substring anywhere else is contains', () => {
    expect(itemMatchTier(item('a', 'Open-ended notebook', 'N-1'), 'pen')).toBe('contains');
    expect(itemMatchTier(item('a', 'Stapler', 'ST-PEN'), 'pen')).toBe('contains');
    expect(itemMatchTier(item('a', 'Stapler', 'S', { model_number: 'XPEN4' }), 'pen')).toBe(
      'contains',
    );
  });

  it('a row that matched only word by word is words', () => {
    expect(itemMatchTier(item('a', 'Pen, red', 'P-1'), 'red pen')).toBe('words');
  });

  it('normalizes case and inner whitespace', () => {
    expect(normalizeItemSearch('  Blue   PEN ')).toBe('blue pen');
    expect(itemMatchTier(item('a', 'Blue pen', 'X'), '  BLUE   pen')).toBe('prefix');
  });
});

describe('rankItemMatches', () => {
  it('orders exact, then prefix, then word, then contains, then words', () => {
    const rows = [
      item('1', 'Pen, red', 'R-1'),
      item('2', 'Open-ended notebook', 'N-1'),
      item('3', 'Blue Pen', 'B-1'),
      item('4', 'Pencil', 'W-1'),
      item('5', 'Zebra marker', 'PEN'),
      item('6', 'Red ink, pen refill', 'I-1'),
    ];
    const ranked = rankItemMatches(rows, 'pen');
    expect(ranked.map((r) => [r.id, r.match])).toEqual([
      ['5', 'exact'],
      ['1', 'prefix'],
      ['4', 'prefix'],
      ['3', 'word'],
      ['6', 'word'],
      ['2', 'contains'],
    ]);
  });

  it('a phrase match outranks rows that only have every word somewhere', () => {
    const rows = [
      item('1', 'Pen, red', 'P-1'),
      item('2', 'Red pen', 'P-2'),
      item('3', 'Bright red pens', 'P-3'),
    ];
    expect(rankItemMatches(rows, 'red pen').map((r) => [r.id, r.match])).toEqual([
      ['2', 'prefix'],
      ['3', 'word'],
      ['1', 'words'],
    ]);
  });

  it('within a tier sorts by name with numbers compared as numbers, then SKU, then id', () => {
    const rows = [
      item('c', 'Grade 10 reader', 'G-10'),
      item('a', 'Grade 2 reader', 'G-2B'),
      item('b', 'grade 2 reader', 'G-2A'),
      item('d', 'Grade 2 reader', 'G-2B'),
    ];
    expect(rankItemMatches(rows, 'grade').map((r) => r.id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('returns every row it was given, once', () => {
    const rows = [item('1', 'A', 'x'), item('2', 'B', 'y')];
    expect(
      rankItemMatches(rows, 'zzz')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['1', '2']);
  });
});
