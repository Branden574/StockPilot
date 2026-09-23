import { describe, expect, it } from 'vitest';

import {
  MAX_PAGE_NUMBER,
  formatListFooter,
  pageRowRange,
  parsePageParam,
  toListPage,
  totalPagesFor,
} from './list-page';

const NOUN = { one: 'cycle count', other: 'cycle counts' };

function footer(total: number, page: number, pageSize = 25): string {
  const p = toListPage(new Array(Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize))).fill(0), {
    page,
    pageSize,
    total,
  });
  return formatListFooter({ ...p, itemCount: p.items.length }, NOUN);
}

describe('parsePageParam', () => {
  it('reads a plain positive page', () => {
    expect(parsePageParam('2')).toBe(2);
    expect(parsePageParam(3)).toBe(3);
    expect(parsePageParam(['4', '9'])).toBe(4);
    expect(parsePageParam(' 5 ')).toBe(5);
  });

  it('falls back to page 1 for anything unreadable', () => {
    for (const bad of [undefined, null, '', '0', '-1', '1.5', 'abc', '2abc', '1e3', '٣', {}, [], NaN, 0, -4]) {
      expect(parsePageParam(bad)).toBe(1);
    }
  });

  it('caps absurd pages at the last page instead of doing unbounded arithmetic', () => {
    expect(parsePageParam('999999999')).toBe(MAX_PAGE_NUMBER);
    expect(parsePageParam('9999999999')).toBe(MAX_PAGE_NUMBER);
    expect(parsePageParam('99999999999999999999')).toBe(MAX_PAGE_NUMBER);
    expect(parsePageParam('0000000000002')).toBe(2);
    expect(parsePageParam('000')).toBe(1);
  });
});

describe('pageRowRange', () => {
  it('maps 1-based pages to Supabase inclusive ranges', () => {
    expect(pageRowRange(1, 25)).toEqual({ from: 0, to: 24 });
    expect(pageRowRange(2, 25)).toEqual({ from: 25, to: 49 });
    expect(pageRowRange(3, 25)).toEqual({ from: 50, to: 74 });
  });
});

describe('toListPage', () => {
  it.each([
    // total, page, totalPages, hasPrevious, hasNext
    [0, 1, 1, false, false],
    [1, 1, 1, false, false],
    [24, 1, 1, false, false],
    [25, 1, 1, false, false],
    [26, 1, 2, false, true],
    [26, 2, 2, true, false],
    [50, 2, 2, true, false],
    [51, 2, 3, true, true],
    [51, 3, 3, true, false],
    [137, 2, 6, true, true],
    [137, 6, 6, true, false],
  ])('total %i on page %i -> %i pages, previous %s, next %s', (total, page, pages, prev, next) => {
    const p = toListPage([], { page, pageSize: 25, total });
    expect(p.totalPages).toBe(pages);
    expect(p.page).toBe(page);
    expect(p.hasPrevious).toBe(prev);
    expect(p.hasNext).toBe(next);
  });

  it('never reports a page past the last one', () => {
    expect(toListPage([], { page: 9, pageSize: 25, total: 30 }).page).toBe(2);
    expect(toListPage([], { page: 9, pageSize: 25, total: 0 }).page).toBe(1);
  });

  it('computes total pages from the size', () => {
    expect(totalPagesFor(137, 25)).toBe(6);
    expect(totalPagesFor(0, 25)).toBe(1);
  });
});

describe('formatListFooter', () => {
  it('matches the specified wording', () => {
    expect(footer(137, 2)).toBe('Showing 26–50 of 137 cycle counts · Page 2 of 6');
  });

  it.each([
    [0, 1, 'Showing 0 cycle counts'],
    [1, 1, 'Showing 1–1 of 1 cycle count · Page 1 of 1'],
    [24, 1, 'Showing 1–24 of 24 cycle counts · Page 1 of 1'],
    [25, 1, 'Showing 1–25 of 25 cycle counts · Page 1 of 1'],
    [26, 1, 'Showing 1–25 of 26 cycle counts · Page 1 of 2'],
    [26, 2, 'Showing 26–26 of 26 cycle counts · Page 2 of 2'],
    [50, 2, 'Showing 26–50 of 50 cycle counts · Page 2 of 2'],
    [51, 3, 'Showing 51–51 of 51 cycle counts · Page 3 of 3'],
    [137, 6, 'Showing 126–137 of 137 cycle counts · Page 6 of 6'],
  ])('total %i, page %i', (total, page, text) => {
    expect(footer(total, page)).toBe(text);
  });

  it('groups thousands', () => {
    expect(footer(12345, 2)).toBe('Showing 26–50 of 12,345 cycle counts · Page 2 of 494');
  });
});
