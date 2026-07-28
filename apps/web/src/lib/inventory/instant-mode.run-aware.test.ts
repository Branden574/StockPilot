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

  // ── Model B SKU families (the "Lenovo Chromebooks don't group" bug) ──
  // One product = one SKU across several item rows (one per charter). The
  // family's rows can rank far apart under updated-DESC (live repro: rows at
  // positions 8/234/240/254), so no fixed page slice ever held 2+ of them
  // and the stranded member rendered flat, no arrow, partial on-hand.

  function skuRow(id: string, name: string, sku: string) {
    return { id, name, sku };
  }

  it('clusters a SKU family scattered across the sorted set onto one page', () => {
    const rows = [
      skuRow('l1', 'Lenovo 300e Yoga Chromebook', 'SP-G69UU-05H'),
      ...Array.from({ length: 50 }, (_, i) => skuRow(`f${i}`, `Filler ${i}`, `SKU-F${i}`)),
      skuRow('l2', 'Lenovo 300e Yoga Chromebook', 'SP-G69UU-05H'),
      ...Array.from({ length: 50 }, (_, i) => skuRow(`g${i}`, `More ${i}`, `SKU-G${i}`)),
      skuRow('l3', 'Lenovo 300e Yoga Chromebook', 'SP-G69UU-05H'),
      skuRow('l4', 'Lenovo 300e Yoga Chromebook', 'SP-G69UU-05H'),
    ];
    const pages = runAwarePages(rows, 30);
    // All four family members land on ONE page, at the first member's rank.
    const family = ['l1', 'l2', 'l3', 'l4'];
    const pagesWithFamily = pages.filter((p) => p.some((r) => family.includes(r.id)));
    expect(pagesWithFamily).toHaveLength(1);
    expect(pagesWithFamily[0]!.filter((r) => family.includes(r.id))).toHaveLength(4);
    // Anchored at the family's best-ranked position: page 1, contiguous.
    const ids = pages[0]!.map((r) => r.id);
    expect(ids.slice(0, 4)).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('SKU family beats size-run grouping when both apply', () => {
    // Same SKU on two rows whose names ALSO look like a size run with a third
    // row of a DIFFERENT sku — the sku pair must stay a unit; the odd-sku row
    // is not pulled into their unit by the name run.
    const rows = [
      skuRow('a', 'Vest - S', 'SKU-SAME'),
      ...Array.from({ length: 35 }, (_, i) => skuRow(`w${i}`, `Widget ${i}`, `W-${i}`)),
      skuRow('b', 'Vest - M', 'SKU-SAME'),
      skuRow('c', 'Vest - L', 'SKU-OTHER'),
    ];
    const pages = runAwarePages(rows, 30);
    const pageOfA = pages.findIndex((p) => p.some((r) => r.id === 'a'));
    const pageOfB = pages.findIndex((p) => p.some((r) => r.id === 'b'));
    expect(pageOfA).toBe(pageOfB); // same-SKU pair co-pages
  });

  it('blank SKUs never form a family', () => {
    const rows = [
      skuRow('x', 'Thing One', ''),
      skuRow('y', 'Thing Two', '  '),
      ...Array.from({ length: 3 }, (_, i) => skuRow(`z${i}`, `Item ${i}`, `Z-${i}`)),
    ];
    const pages = runAwarePages(rows, 30);
    expect(pages[0]).toHaveLength(5); // all singletons, order preserved
    expect(pages[0]!.map((r) => r.id)).toEqual(['x', 'y', 'z0', 'z1', 'z2']);
  });

  // ── Task 18: a STORED product group is the unit, ahead of the name regex ──
  // The renderer keys a size run on `group:${group_id}` first and only falls
  // back to the name (packages/core size-run.ts `runKey`). Pagination has to
  // cluster on the SAME key or it hands the renderer a page holding one lone
  // member of a family: no arrow, a flat row, and a header on another page
  // whose total is short by whatever it could not see.

  function groupRow(id: string, name: string, sku: string, groupId?: string) {
    return { id, name, sku, group_id: groupId ?? null };
  }

  it('keeps a group whose names do NOT match the size regex on one page', () => {
    // Shoe sizes: "Nike Pegasus 41" x2 differing only by variant_size. The
    // name regex reads apparel tokens (S/M/L/XL…) and can never see this
    // family, so before Task 18's key change a pageSize-2 slice cut it in
    // half — [p9, x1] / [x2, p10].
    const rows = [
      groupRow('p9', 'Nike Pegasus 41', 'PEG-9', 'grp-1'),
      groupRow('x1', 'Stapler', 'STP-1'),
      groupRow('x2', 'Kettle', 'KTL-1'),
      groupRow('p10', 'Nike Pegasus 41', 'PEG-10', 'grp-1'),
    ];
    const pages = runAwarePages(rows, 2);
    const pageOf = (id: string) => pages.findIndex((p) => p.some((r) => r.id === id));
    expect(pageOf('p9')).toBe(pageOf('p10'));
    // Clustered at the family's best-ranked position, exactly like a SKU family.
    expect(pages[0]!.map((r) => r.id)).toEqual(['p9', 'p10']);
    expect(pages[1]!.map((r) => r.id)).toEqual(['x1', 'x2']);
  });

  it('does not co-page two same-base names carrying DIFFERENT group ids', () => {
    // A name collision must never forge a family once identity is stored.
    const rows = [
      groupRow('a', 'Pink Shirt - L', 'A', 'grp-1'),
      groupRow('b', 'Pink Shirt - XL', 'B', 'grp-2'),
    ];
    const pages = runAwarePages(rows, 1);
    expect(pages.map((p) => p.map((r) => r.id))).toEqual([['a'], ['b']]);
  });

  it('a grouped row is never pulled into a name-keyed run of ungrouped rows', () => {
    const rows = [
      groupRow('g1', 'Pink Shirt - L', 'G1', 'grp-1'),
      groupRow('u1', 'Pink Shirt - XL', 'U1'),
      groupRow('u2', 'Pink Shirt - 2XL', 'U2'),
    ];
    const pages = runAwarePages(rows, 2);
    // The two UNGROUPED rows still form the legacy run; the grouped row is a
    // singleton of its own (its group has one member in this set).
    expect(pages.map((p) => p.map((r) => r.id))).toEqual([['g1'], ['u1', 'u2']]);
  });

  it('a lone member of a group stays a singleton (2+ still required)', () => {
    const rows = [
      groupRow('solo', 'Nike Pegasus 41', 'PEG-9', 'grp-1'),
      ...Array.from({ length: 4 }, (_, i) => groupRow(`w${i}`, `Widget ${i}`, `W-${i}`)),
    ];
    const pages = runAwarePages(rows, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
  });

  it('group clustering is OFF for books, exactly as the name heuristic is', () => {
    const rows = [
      groupRow('b1', 'Reader One', 'R-1', 'grp-1'),
      groupRow('f1', 'Filler', 'F-1'),
      groupRow('b2', 'Reader Two', 'R-2', 'grp-1'),
    ];
    const pages = runAwarePages(rows, 2, { sizeRuns: false });
    expect(pages.map((p) => p.map((r) => r.id))).toEqual([
      ['b1', 'f1'],
      ['b2'],
    ]);
  });
});
