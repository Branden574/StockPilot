import { describe, expect, it } from 'vitest';

import { formatCrateLabel } from './book-storage';
import {
  compareBookCratePlacement,
  describeBookCrateChange,
  formatCrateColorLabel,
  formatCratePlacementLabel,
  isCrateDestination,
  normalizeCrateColor,
  normalizeCrateNumber,
  parseBookCrateChangeDetail,
  summarizeBookCrateChanges,
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

// ═══════════════════════════════════════════════════════════════════════════
// THE CONFIRMATION CONTRACT — what a client actually renders
// ═══════════════════════════════════════════════════════════════════════════

describe('formatCrateColorLabel', () => {
  it('renders a registry slug as its LABEL, and keeps an unknown color verbatim', () => {
    expect(formatCrateColorLabel('blue')).toBe('Blue');
    expect(formatCrateColorLabel(' BLUE ')).toBe('Blue');
    expect(formatCrateColorLabel('Taupe')).toBe('Taupe');
  });
  it('nothing recorded → null', () => {
    expect(formatCrateColorLabel(null)).toBeNull();
    expect(formatCrateColorLabel('   ')).toBeNull();
  });
});

describe('a color-only crate no longer yields a self-contradictory payload', () => {
  // THE BUG: `changed: true` carrying currentLabel null AND nextLabel null,
  // which renders as "recorded in no crate … will change to no crate" — the
  // gate firing on a change it could not describe. Crate data has been
  // hand-entered for years, so a color with no number is real data.
  it('a color with no number LABELS as its color, so the change is describable', () => {
    const r = cmp('blue', null, null, null);
    expect(r.changed).toBe(true);
    expect(r.currentLabel).toBe('Blue');
    expect(r.nextLabel).toBeNull();
  });
  it('an unknown color still labels — verbatim, as the user spelled it', () => {
    expect(cmp('Taupe', null, null, null).currentLabel).toBe('Taupe');
    expect(cmp('taupe', null, null, null).currentLabel).toBe('taupe');
  });
  it('the SUMMARY spelling is untouched — a number still drives that one', () => {
    expect(formatCrateLabel('blue', null)).toBeNull();
    expect(formatCratePlacementLabel('blue', '4')).toBe('Blue 4');
  });
});

describe('describeBookCrateChange', () => {
  const lines = (
    cc: string | null,
    cn: string | null,
    nc: string | null,
    nn: string | null,
  ) => describeBookCrateChange({ currentColor: cc, currentNumber: cn, nextColor: nc, nextNumber: nn });

  it('says NOTHING when nothing changes — the fast path stays fast', () => {
    expect(lines('blue', '4', 'blue', '4')).toEqual([]);
    expect(lines(null, null, 'blue', '4')).toEqual([]);
  });
  it('names the field, the old value and the new one', () => {
    expect(lines('blue', '4', 'red', '7')).toEqual([
      'Crate color will change from Blue to Red.',
      'Crate number will change from 4 to 7.',
    ]);
  });
  it('reports only the field that moved', () => {
    expect(lines('blue', '4', 'blue', '7')).toEqual(['Crate number will change from 4 to 7.']);
  });
  it('a RACK destination reads as an erasure, not as "to none"', () => {
    expect(lines('blue', '4', null, null)).toEqual([
      'Crate color Blue will be cleared.',
      'Crate number 4 will be cleared.',
    ]);
  });
  it('keeps free-text numbers verbatim ("Bin", "Blue Shelf")', () => {
    expect(lines(null, 'Bin', null, 'Blue Shelf')).toEqual([
      'Crate number will change from Bin to Blue Shelf.',
    ]);
  });
});

describe('parseBookCrateChangeDetail', () => {
  const valid = {
    reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
    items: [{ itemId: 'i-1', itemName: 'Persepolis', currentLabel: 'Blue 4', nextLabel: 'Red 7' }],
  };
  it('accepts the payload the gate throws', () => {
    expect(parseBookCrateChangeDetail(valid)).toEqual(valid);
  });
  it('normalises a missing label to null rather than undefined', () => {
    const d = parseBookCrateChangeDetail({
      reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
      items: [{ itemId: 'i-1', itemName: 'Persepolis' }],
    });
    expect(d!.items[0]).toEqual({
      itemId: 'i-1',
      itemName: 'Persepolis',
      currentLabel: null,
      nextLabel: null,
    });
  });
  it('refuses anything else — an empty "are you sure?" is worse than none', () => {
    expect(parseBookCrateChangeDetail(undefined)).toBeNull();
    expect(parseBookCrateChangeDetail(null)).toBeNull();
    expect(parseBookCrateChangeDetail({ reason: 'SOMETHING_ELSE', items: valid.items })).toBeNull();
    expect(parseBookCrateChangeDetail({ ...valid, items: [] })).toBeNull();
    expect(parseBookCrateChangeDetail({ ...valid, items: [{ itemName: 'no id' }] })).toBeNull();
  });
});

describe('summarizeBookCrateChanges', () => {
  const item = (id: string, currentLabel: string | null) => ({
    itemId: id,
    itemName: id,
    currentLabel,
    nextLabel: 'Red 7',
  });

  it('groups by the crate each title is recorded in TODAY — one warning, not N', () => {
    const s = summarizeBookCrateChanges([
      item('a', 'Blue 4'),
      item('b', 'Green 2'),
      item('c', 'Blue 4'),
      item('d', null),
      item('e', 'Blue 4'),
      item('f', 'Green 2'),
      item('g', 'Blue 4'),
      item('h', null),
    ]);
    expect(s.total).toBe(8);
    expect(s.nextLabel).toBe('Red 7');
    // Largest group first; "nothing recorded" always last.
    expect(s.groups).toEqual([
      { currentLabel: 'Blue 4', count: 4 },
      { currentLabel: 'Green 2', count: 2 },
      { currentLabel: null, count: 2 },
    ]);
  });
  it('ties break alphabetically so one selection always reads the same way', () => {
    const s = summarizeBookCrateChanges([item('a', 'Green 2'), item('b', 'Blue 4')]);
    expect(s.groups.map((g) => g.currentLabel)).toEqual(['Blue 4', 'Green 2']);
  });
  it('a rack destination summarises as no crate', () => {
    const s = summarizeBookCrateChanges([
      { itemId: 'a', itemName: 'a', currentLabel: 'Blue 4', nextLabel: null },
    ]);
    expect(s.nextLabel).toBeNull();
  });
});
