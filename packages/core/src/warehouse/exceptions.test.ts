import { describe, expect, it } from 'vitest';

import {
  countExceptions,
  EXCEPTION_RULES,
  groupExceptions,
  sortExceptions,
  type WarehouseException,
} from './exceptions';

const ex = (o: Partial<WarehouseException> & Pick<WarehouseException, 'rule' | 'key'>): WarehouseException => ({
  title: 'x',
  detail: 'y',
  href: null,
  ...o,
});

describe('sortExceptions', () => {
  it('puts critical above warning regardless of size', () => {
    const out = sortExceptions([
      ex({ rule: 'long_unplaced', key: 'a', units: 5000 }),
      ex({ rule: 'over_reserved', key: 'b', units: 1 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['b', 'a']);
  });

  it('ranks by UNITS before age within a severity', () => {
    // The judgement this encodes: age is the more emotive number and the wrong
    // one to lead with. One unit lost for 90 days must not outrank 200 units
    // lost yesterday, or the reader spends their attention on trivia.
    const out = sortExceptions([
      ex({ rule: 'long_unplaced', key: 'old-tiny', units: 1, ageDays: 90 }),
      ex({ rule: 'long_unplaced', key: 'new-big', units: 200, ageDays: 1 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['new-big', 'old-tiny']);
  });

  it('uses age only to break a tie on units', () => {
    const out = sortExceptions([
      ex({ rule: 'stale_staging', key: 'newer', units: 10, ageDays: 2 }),
      ex({ rule: 'stale_staging', key: 'older', units: 10, ageDays: 40 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['older', 'newer']);
  });

  it('is a TOTAL order, so the list cannot flicker between renders', () => {
    // Two rows identical on every ranked field must still have a stable
    // relative order; without the key tiebreak they can swap on re-sort and the
    // screen appears to shuffle by itself.
    const a = ex({ rule: 'stale_staging', key: 'aaa', units: 5, ageDays: 5 });
    const b = ex({ rule: 'stale_staging', key: 'bbb', units: 5, ageDays: 5 });
    expect(sortExceptions([a, b]).map((e) => e.key)).toEqual(['aaa', 'bbb']);
    expect(sortExceptions([b, a]).map((e) => e.key)).toEqual(['aaa', 'bbb']);
  });

  it('does not mutate its input', () => {
    const input = [ex({ rule: 'long_unplaced', key: 'a' }), ex({ rule: 'over_reserved', key: 'b' })];
    sortExceptions(input);
    expect(input.map((e) => e.key)).toEqual(['a', 'b']);
  });

  it('treats a missing unit count as zero rather than dropping the row', () => {
    const out = sortExceptions([
      ex({ rule: 'label_mismatch', key: 'no-units' }),
      ex({ rule: 'label_mismatch', key: 'has-units', units: 3 }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['has-units', 'no-units']);
  });
});

describe('groupExceptions', () => {
  it('groups by rule and omits rules with nothing to show', () => {
    const groups = groupExceptions([
      ex({ rule: 'stale_staging', key: 's1', units: 4 }),
      ex({ rule: 'over_reserved', key: 'o1', units: 9 }),
      ex({ rule: 'stale_staging', key: 's2', units: 7 }),
    ]);
    expect(groups.map((g) => g.meta.rule)).toEqual(['over_reserved', 'stale_staging']);
    expect(groups[1]!.items.map((i) => i.key)).toEqual(['s2', 's1']);
    // An empty screen must say "nothing is wrong", not list five empty headings.
    expect(groups.some((g) => g.items.length === 0)).toBe(false);
  });

  it('returns nothing at all when there are no exceptions', () => {
    expect(groupExceptions([])).toEqual([]);
  });
});

describe('countExceptions', () => {
  it('counts the total and the critical subset', () => {
    expect(
      countExceptions([
        ex({ rule: 'orphaned_stock', key: 'a' }),
        ex({ rule: 'stale_staging', key: 'b' }),
        ex({ rule: 'over_reserved', key: 'c' }),
      ]),
    ).toEqual({ total: 3, critical: 2 });
  });
});

describe('EXCEPTION_RULES', () => {
  it('every rule tells the reader what to DO', () => {
    // The rule this suite enforces: an exception a reader cannot act on is a
    // metric, and metrics belong in reports. A rule whose action is empty is
    // how this screen becomes a wall of noise nobody opens.
    for (const meta of Object.values(EXCEPTION_RULES)) {
      expect(meta.action.trim().length).toBeGreaterThan(20);
      expect(meta.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('is keyed consistently with its own rule field', () => {
    for (const [key, meta] of Object.entries(EXCEPTION_RULES)) expect(meta.rule).toBe(key);
  });
});
