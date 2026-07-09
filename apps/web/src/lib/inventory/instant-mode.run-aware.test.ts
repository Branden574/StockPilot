import { describe, expect, it } from 'vitest';

import { runAwarePages } from './instant-mode';

/** Minimal row shape runAwarePages reads. */
function row(id: string, name: string) {
  return { id, name };
}

/** Assert no size run's members straddle two pages. */
function noRunSplit(pages: { id: string; name: string }[][]) {
  const seenBase = new Map<string, number>(); // base -> page index
  pages.forEach((page, pi) => {
    for (const r of page) {
      const base = r.name.replace(/\s*-\s*[0-9A-Za-z]+\s*$/, '').toLowerCase();
      const prev = seenBase.get(base);
      if (prev !== undefined && prev !== pi) {
        throw new Error(`run "${base}" split across pages ${prev} and ${pi}`);
      }
      seenBase.set(base, pi);
    }
  });
}

describe('runAwarePages', () => {
  it('keeps a size run whole even when a fixed slice would split it at the boundary', () => {
    // 28 filler items, then a 6-size run — a fixed 30-slice would put sizes
    // 1-2 on page 1 and 3-6 on page 2. Run-aware must keep all 6 together.
    const rows = [
      ...Array.from({ length: 28 }, (_, i) => row(`f${i}`, `Filler Item ${i}`)),
      row('r1', 'Brick Red Tee - S'),
      row('r2', 'Brick Red Tee - M'),
      row('r3', 'Brick Red Tee - L'),
      row('r4', 'Brick Red Tee - XL'),
      row('r5', 'Brick Red Tee - 2XL'),
      row('r6', 'Brick Red Tee - 3XL'),
    ];
    const pages = runAwarePages(rows, 30);
    noRunSplit(pages);
    // The 6-run is pushed whole to page 2 (28 + 6 = 34 > 30, so it doesn't fit
    // on page 1 without cutting → starts page 2).
    const runPage = pages.find((p) => p.some((r) => r.id === 'r1'));
    expect(runPage?.filter((r) => r.name.startsWith('Brick Red Tee'))).toHaveLength(6);
  });

  it('clusters run members scattered by the sort onto one page', () => {
    // Members interleaved with other items (as a last-updated sort would do).
    const rows = [
      row('a', 'Red Tee - S'),
      row('x', 'Something Else'),
      row('b', 'Red Tee - XL'),
      row('y', 'Another Thing'),
      row('c', 'Red Tee - 2XL'),
    ];
    const pages = runAwarePages(rows, 30);
    expect(pages).toHaveLength(1);
    noRunSplit(pages);
    // All three Red Tee sizes are contiguous at the first member's position.
    const idsOnPage = pages[0]!.map((r) => r.id);
    const redIdx = idsOnPage.indexOf('a');
    expect(idsOnPage.slice(redIdx, redIdx + 3)).toEqual(['a', 'b', 'c']);
  });

  it('behaves like plain chunking when there are no runs (each item alone)', () => {
    const rows = Array.from({ length: 65 }, (_, i) => row(`i${i}`, `Widget ${i}`));
    const pages = runAwarePages(rows, 30);
    expect(pages.map((p) => p.length)).toEqual([30, 30, 5]);
  });

  it('does not group a lone sized item (needs 2+ sharing a base)', () => {
    const rows = [
      row('solo', 'Solo Tee - XL'),
      ...Array.from({ length: 40 }, (_, i) => row(`w${i}`, `Widget ${i}`)),
    ];
    const pages = runAwarePages(rows, 30);
    // 41 singletons → 30 + 11.
    expect(pages.map((p) => p.length)).toEqual([30, 11]);
  });
});
