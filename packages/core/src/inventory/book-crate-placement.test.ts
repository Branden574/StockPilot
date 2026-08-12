import { describe, expect, it } from 'vitest';

import {
  compareBookCratePlacement,
  isCrateDestination,
  normalizeCrateColor,
  normalizeCrateNumber,
} from './book-crate-placement';

/** Terse constructor so each case reads as current → next. */
function cmp(
  currentColor: string | null,
  currentNumber: string | null,
  nextColor: string | null,
  nextNumber: string | null,
) {
  return compareBookCratePlacement({ currentColor, currentNumber, nextColor, nextNumber });
}

describe('normalizeCrateColor', () => {
  it('resolves a known color to its CRATE_COLORS slug, case-insensitively', () => {
    expect(normalizeCrateColor('blue')).toBe('blue');
    expect(normalizeCrateColor('BLUE')).toBe('blue');
    expect(normalizeCrateColor('  Blue  ')).toBe('blue');
  });
  it('keeps an UNKNOWN color as lower-cased text (never discards it)', () => {
    expect(normalizeCrateColor('Taupe')).toBe('taupe');
  });
  it('empty / whitespace / nullish → null', () => {
    expect(normalizeCrateColor('')).toBeNull();
    expect(normalizeCrateColor('   ')).toBeNull();
    expect(normalizeCrateColor(null)).toBeNull();
    expect(normalizeCrateColor(undefined)).toBeNull();
  });
});

describe('normalizeCrateNumber (FREE TEXT — never range-validated)', () => {
  it('trims and lower-cases', () => {
    expect(normalizeCrateNumber(' 4 ')).toBe('4');
    expect(normalizeCrateNumber('BIN')).toBe('bin');
  });
  it('accepts the real production values verbatim — 0, 16, "Bin", "Blue Shelf"', () => {
    // Live data: crate numbers 0 and 1..16 plus the free text below. A
    // 1..9 enum would REJECT every one of these.
    expect(normalizeCrateNumber('0')).toBe('0');
    expect(normalizeCrateNumber('16')).toBe('16');
    expect(normalizeCrateNumber('Blue Shelf')).toBe('blue shelf');
  });
  it('empty / whitespace / nullish → null', () => {
    expect(normalizeCrateNumber('')).toBeNull();
    expect(normalizeCrateNumber('  ')).toBeNull();
    expect(normalizeCrateNumber(null)).toBeNull();
  });
});

describe('compareBookCratePlacement — SAME crate is never a change', () => {
  it('identical color + number', () => {
    const r = cmp('blue', '4', 'blue', '4');
    expect(r).toMatchObject({ changed: false, colorChanged: false, numberChanged: false });
    expect(r.currentLabel).toBe('Blue 4');
    expect(r.nextLabel).toBe('Blue 4');
  });
  it('differing CASE is the same crate ("blue" vs "BLUE")', () => {
    expect(cmp('blue', '4', 'BLUE', '4').changed).toBe(false);
  });
  it('surrounding WHITESPACE is the same crate (" 4 " vs "4")', () => {
    expect(cmp('blue', ' 4 ', 'blue', '4').changed).toBe(false);
  });
  it('the real prod free text "Bin" vs "BIN" is the SAME crate', () => {
    const r = cmp('blue', 'Bin', 'blue', 'BIN');
    expect(r.changed).toBe(false);
    // Labels keep the RAW casing each side actually stores.
    expect(r.currentLabel).toBe('Blue Bin');
    expect(r.nextLabel).toBe('Blue BIN');
  });
  it('"Blue Shelf" compares to itself', () => {
    expect(cmp('blue', 'Blue Shelf', 'blue', 'blue shelf').changed).toBe(false);
  });
  it('an UNKNOWN color compares to itself (not collapsed to "no color")', () => {
    expect(cmp('taupe', '4', 'Taupe', '4').changed).toBe(false);
  });
});

describe('compareBookCratePlacement — genuine overwrites', () => {
  it('number changed', () => {
    const r = cmp('blue', '4', 'blue', '7');
    expect(r).toMatchObject({ changed: true, colorChanged: false, numberChanged: true });
    expect(r.currentLabel).toBe('Blue 4');
    expect(r.nextLabel).toBe('Blue 7');
  });
  it('color changed', () => {
    const r = cmp('blue', '4', 'green', '4');
    expect(r).toMatchObject({ changed: true, colorChanged: true, numberChanged: false });
  });
  it('BOTH changed — the "client says Blue 4, DB says Green 2" shape', () => {
    const r = cmp('green', '2', 'blue', '4');
    expect(r).toMatchObject({ changed: true, colorChanged: true, numberChanged: true });
    expect(r.currentLabel).toBe('Green 2');
    expect(r.nextLabel).toBe('Blue 4');
  });
  it('an unknown color changing to a known one is a change', () => {
    expect(cmp('taupe', '4', 'blue', '4').colorChanged).toBe(true);
  });
});

describe('compareBookCratePlacement — first assignment needs no confirmation', () => {
  it('no current crate at all → changed false, isFirstAssignment true', () => {
    const r = cmp(null, null, 'blue', '4');
    expect(r).toMatchObject({
      changed: false,
      colorChanged: false,
      numberChanged: false,
      isFirstAssignment: true,
    });
    expect(r.currentLabel).toBeNull();
    expect(r.nextLabel).toBe('Blue 4');
  });
  it('empty strings count as no crate (the DB stores "" from a cleared form field)', () => {
    expect(cmp('', '', 'blue', '4')).toMatchObject({ changed: false, isFirstAssignment: true });
  });
  it('placing an uncrated book onto a RACK is a no-op, not a change', () => {
    expect(cmp(null, null, null, null)).toMatchObject({
      changed: false,
      isFirstAssignment: true,
      currentLabel: null,
      nextLabel: null,
    });
  });
});

describe('compareBookCratePlacement — PARTIAL current data', () => {
  it('FILLING a missing color is not a change (number known, color unknown)', () => {
    const r = cmp(null, '4', 'blue', '4');
    expect(r).toMatchObject({ changed: false, colorChanged: false, numberChanged: false });
    // Not a first assignment — a crate number IS already recorded.
    expect(r.isFirstAssignment).toBe(false);
    expect(r.currentLabel).toBe('4');
  });
  it('FILLING a missing number is not a change (color known, number unknown)', () => {
    expect(cmp('blue', null, 'blue', '4')).toMatchObject({
      changed: false,
      numberChanged: false,
      isFirstAssignment: false,
    });
  });
  it('but changing the KNOWN half of partial data IS a change', () => {
    expect(cmp(null, '4', 'blue', '7')).toMatchObject({ changed: true, numberChanged: true });
    expect(cmp('blue', null, 'green', '7')).toMatchObject({ changed: true, colorChanged: true });
  });
});

describe('compareBookCratePlacement — CLEARING a recorded crate', () => {
  it('a crated book placed on a RACK clears the summary — and that IS a change', () => {
    // The owner rule: a rack destination clears the crate summary, because a
    // stale "Blue 4" would send a picker to the wrong bin. Erasing a recorded
    // value is destructive, so it goes through the same confirmation gate.
    const r = cmp('blue', '4', null, null);
    expect(r).toMatchObject({ changed: true, colorChanged: true, numberChanged: true });
    expect(r.currentLabel).toBe('Blue 4');
    expect(r.nextLabel).toBeNull();
    expect(r.isFirstAssignment).toBe(false);
  });
  it('moving into a COLORLESS crate of the same number drops only the color', () => {
    const r = cmp('blue', '4', null, '4');
    expect(r).toMatchObject({ changed: true, colorChanged: true, numberChanged: false });
    expect(r.nextLabel).toBe('4');
  });
});

describe('isCrateDestination — a NUMBER alone is a crate', () => {
  it('color only', () => {
    expect(isCrateDestination({ crateColor: 'blue' })).toBe(true);
  });
  it('NUMBER ONLY — the bug: this used to resolve to kind "rack"', () => {
    expect(isCrateDestination({ crateNumber: '4' })).toBe(true);
    expect(isCrateDestination({ crateColor: null, crateNumber: '4' })).toBe(true);
    expect(isCrateDestination({ crateColor: '', crateNumber: '4' })).toBe(true);
  });
  it('both', () => {
    expect(isCrateDestination({ crateColor: 'blue', crateNumber: '4' })).toBe(true);
  });
  it('neither (a plain rack) — and whitespace is not a crate', () => {
    expect(isCrateDestination({})).toBe(false);
    expect(isCrateDestination({ crateColor: null, crateNumber: null })).toBe(false);
    expect(isCrateDestination({ crateColor: '  ', crateNumber: '  ' })).toBe(false);
  });
});
