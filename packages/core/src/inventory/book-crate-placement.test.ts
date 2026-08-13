import { describe, expect, it } from 'vitest';

import { formatCrateLabel } from './book-storage';
import {
  bookCrateAcknowledgementIndex,
  bookCrateAcknowledgementsMatch,
  bookCrateFingerprint,
  bookCratePlacementWillSync,
  compareBookCratePlacement,
  describeBookCrateChange,
  describeBookCrateConflict,
  formatCrateColorLabel,
  formatCratePlacementLabel,
  isBookCrateChangeAcknowledged,
  isCrateDestination,
  normalizeCrateColor,
  normalizeCrateColorForWrite,
  normalizeCrateNumber,
  parseBookCrateChangeDetail,
  summarizeBookCrateChanges,
  toBookCrateAcknowledgement,
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
  const fp = bookCrateFingerprint('blue', '4');
  const valid = {
    reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
    items: [
      {
        itemId: 'i-1',
        itemName: 'Persepolis',
        currentLabel: 'Blue 4',
        nextLabel: 'Red 7',
        currentFingerprint: fp,
      },
    ],
  };
  it('accepts the payload the gate throws', () => {
    // rackLine is normalised in alongside the labels — see the next two cases
    // for why its ABSENCE must stay valid.
    expect(parseBookCrateChangeDetail(valid)).toEqual({
      ...valid,
      items: [{ ...valid.items[0], rackLine: null }],
    });
  });
  it('normalises a missing label to null rather than undefined', () => {
    const d = parseBookCrateChangeDetail({
      reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
      items: [{ itemId: 'i-1', itemName: 'Persepolis', currentFingerprint: fp }],
    });
    expect(d!.items[0]).toEqual({
      itemId: 'i-1',
      itemName: 'Persepolis',
      currentLabel: null,
      nextLabel: null,
      currentFingerprint: fp,
      rackLine: null,
    });
  });
  it('carries the RACK sentence through when the gate supplied one', () => {
    // The whole point of putting it on the payload: only the server has read
    // the holdings, so the client must receive the sentence rather than derive
    // one from a render-time snapshot.
    const d = parseBookCrateChangeDetail({
      ...valid,
      items: [{ ...valid.items[0], rackLine: 'Rack 38-A will be cleared.' }],
    });
    expect(d!.items[0]!.rackLine).toBe('Rack 38-A will be cleared.');
  });
  it('a MISSING or empty rack sentence is valid — never a reason to reject', () => {
    // Unlike the fingerprint, this line is disclosure and not a question. A
    // payload without one is still a complete, answerable crate confirmation;
    // rejecting it would strand the client on the plain error message for a
    // split move, an older server, or any placement the gate could not predict.
    expect(
      parseBookCrateChangeDetail({ ...valid, items: [{ ...valid.items[0], rackLine: '' }] })!
        .items[0]!.rackLine,
    ).toBeNull();
    expect(
      parseBookCrateChangeDetail({ ...valid, items: [{ ...valid.items[0], rackLine: 42 }] })!
        .items[0]!.rackLine,
    ).toBeNull();
  });
  it('refuses anything else — an empty "are you sure?" is worse than none', () => {
    expect(parseBookCrateChangeDetail(undefined)).toBeNull();
    expect(parseBookCrateChangeDetail(null)).toBeNull();
    expect(parseBookCrateChangeDetail({ reason: 'SOMETHING_ELSE', items: valid.items })).toBeNull();
    expect(parseBookCrateChangeDetail({ ...valid, items: [] })).toBeNull();
    expect(parseBookCrateChangeDetail({ ...valid, items: [{ itemName: 'no id' }] })).toBeNull();
  });
  it('refuses a line with NO fingerprint — it could never be acknowledged', () => {
    // A change line without one renders a "Continue placement" button whose
    // acknowledgement matches nothing, so the retry is refused forever. The
    // honest outcome is the plain error message, not an un-answerable dialog.
    expect(
      parseBookCrateChangeDetail({
        reason: 'BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION',
        items: [{ itemId: 'i-1', itemName: 'Persepolis', currentLabel: 'Blue 4' }],
      }),
    ).toBeNull();
    expect(
      parseBookCrateChangeDetail({ ...valid, items: [{ ...valid.items[0], currentFingerprint: '' }] }),
    ).toBeNull();
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
    const s = summarizeBookCrateChanges([{ currentLabel: 'Blue 4', nextLabel: null }]);
    expect(s.nextLabel).toBeNull();
  });

  it('DEDUPES the rack sentences — 200 books off one rack read as one line', () => {
    // Per-book on the wire, because each book has its own recorded rack and its
    // own sync prediction; repeated 200 times on screen it would bury the one
    // line that differs.
    const s = summarizeBookCrateChanges([
      { ...item('a', 'Blue 4'), rackLine: 'Rack 38-A will be cleared.' },
      { ...item('b', 'Blue 4'), rackLine: 'Rack 38-A will be cleared.' },
      { ...item('c', 'Green 2'), rackLine: 'Rack 22-B will be cleared.' },
      // A book the gate could not predict carries no sentence, and contributes
      // none — silence is the honest output, not a placeholder.
      { ...item('d', 'Green 2'), rackLine: null },
      item('e', null),
    ]);
    expect(s.rackLines).toEqual(['Rack 22-B will be cleared.', 'Rack 38-A will be cleared.']);
  });

  it('rack sentences are ORDERED, so one selection always reads the same way', () => {
    // Same reason the groups sort: the server may enumerate a batch in any
    // order, and a confirmation that reshuffles between attempts is unreadable.
    const forward = summarizeBookCrateChanges([
      { ...item('a', 'Blue 4'), rackLine: 'Rack will change from 40-B to 22-B.' },
      { ...item('b', 'Blue 4'), rackLine: 'Rack 38-A will be cleared.' },
    ]);
    const reversed = summarizeBookCrateChanges([
      { ...item('b', 'Blue 4'), rackLine: 'Rack 38-A will be cleared.' },
      { ...item('a', 'Blue 4'), rackLine: 'Rack will change from 40-B to 22-B.' },
    ]);
    expect(forward.rackLines).toEqual(reversed.rackLines);
    expect(forward.rackLines).toHaveLength(2);
  });

  it('no rack sentences at all is an EMPTY list, never undefined', () => {
    // The dialog renders on `.length > 0`; an undefined here would throw inside
    // a confirmation that is already interrupting someone.
    expect(summarizeBookCrateChanges([item('a', 'Blue 4')]).rackLines).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE LABEL INVARIANT
//
// `changed: true` must never be reported with two labels a human reads as the
// same string. At HEAD the gate label delegated to the SUMMARY spelling, which
// is case-SENSITIVE and drops an unrecognised color, so:
//
//   cmp('Blue','42', null,'42') → changed, currentLabel '42', nextLabel '42'
//   cmp('taupe','4', null,'4')  → changed, currentLabel  '4', nextLabel  '4'
//
// i.e. "Persepolis is recorded in 42. Placing it here will change that to 42."
// The natural response to that sentence is to click Continue, which silently
// erases the recorded color — worse than not asking at all.
// ═══════════════════════════════════════════════════════════════════════════

describe('formatCratePlacementLabel — the GATE spelling', () => {
  it('keeps a KNOWN color whatever its case (the case-sensitivity bug)', () => {
    expect(formatCratePlacementLabel('Blue', '42')).toBe('Blue 42');
    expect(formatCratePlacementLabel('BLUE', '42')).toBe('Blue 42');
    expect(formatCratePlacementLabel(' blue ', ' 42 ')).toBe('Blue 42');
  });
  it('keeps an UNRECOGNISED color verbatim instead of discarding it', () => {
    expect(formatCratePlacementLabel('taupe', '4')).toBe('taupe 4');
    expect(formatCratePlacementLabel('Taupe', '4')).toBe('Taupe 4');
  });
  it('renders the real production free text', () => {
    expect(formatCratePlacementLabel(null, 'Bin')).toBe('Bin');
    expect(formatCratePlacementLabel(null, 'BIN')).toBe('BIN');
    expect(formatCratePlacementLabel(null, 'Blue Shelf')).toBe('Blue Shelf');
    expect(formatCratePlacementLabel('blue', '0')).toBe('Blue 0');
  });
  it('color alone, number alone, nothing', () => {
    expect(formatCratePlacementLabel('blue', null)).toBe('Blue');
    expect(formatCratePlacementLabel(null, '42')).toBe('42');
    expect(formatCratePlacementLabel(null, null)).toBeNull();
    expect(formatCratePlacementLabel('  ', '  ')).toBeNull();
  });
  it('is NOT the summary spelling — that one still drops an unknown color', () => {
    // The split the previous fix claimed to make. Both spellings are load
    // bearing; re-merging them is what produced "42 → 42".
    expect(formatCrateLabel('taupe', '4')).toBe('4');
    expect(formatCratePlacementLabel('taupe', '4')).toBe('taupe 4');
  });

  // ── The crate's RACK, spoken in the same sentence ────────────────────────
  //
  // "gray BIN" names FIVE different bins in this warehouse (43-B, 43-C, 42-B,
  // 42-C, 41-C). A confirmation that stops at the crate sends a picker to the
  // wrong aisle, so the label carries the position when there is one.
  it('names the rack a crate sits on', () => {
    expect(formatCratePlacementLabel('blue', '13', { rackNumber: '38', rackRow: 'B' })).toBe(
      'Blue 13 on rack 38-B',
    );
    expect(formatCratePlacementLabel('gray', 'BIN', { rackNumber: '43', rackRow: 'C' })).toBe(
      'Gray BIN on rack 43-C',
    );
    expect(formatCratePlacementLabel(null, '1', { rackNumber: '39', rackRow: 'B' })).toBe(
      '1 on rack 39-B',
    );
  });

  it('says nothing extra when the crate is not on a rack (production: "Blue Shelf")', () => {
    expect(formatCratePlacementLabel(null, 'Blue Shelf', null)).toBe('Blue Shelf');
    expect(formatCratePlacementLabel('blue', '4', { rackRow: 'B' })).toBe('Blue 4');
    expect(formatCratePlacementLabel('blue', '4')).toBe('Blue 4');
  });

  it('a position never invents a label out of nothing', () => {
    // No crate = no sentence, however much position is passed alongside.
    expect(formatCratePlacementLabel(null, null, { rackNumber: '38', rackRow: 'B' })).toBeNull();
  });
});

describe('the crate comparison and the rack are SEPARATE — never one mushy predicate', () => {
  it('a rack-only move is NOT a crate change, so the gate stays silent', () => {
    // Same crate, different rack. `changed` decides whether a human is
    // interrogated; folding the rack in would interrogate them on every move.
    const c = compareBookCratePlacement({
      currentColor: 'gray',
      currentNumber: 'BIN',
      currentPosition: { rackNumber: '43', rackRow: 'B' },
      nextColor: 'gray',
      nextNumber: 'BIN',
      nextPosition: { rackNumber: '41', rackRow: 'C' },
    });
    expect(c.changed).toBe(false);
    expect(describeBookCrateChange({
      currentColor: 'gray',
      currentNumber: 'BIN',
      currentPosition: { rackNumber: '43', rackRow: 'B' },
      nextColor: 'gray',
      nextNumber: 'BIN',
      nextPosition: { rackNumber: '41', rackRow: 'C' },
    })).toEqual([]);
  });

  it('a real crate change SHOWS the rack on both sides', () => {
    const c = compareBookCratePlacement({
      currentColor: 'blue',
      currentNumber: '4',
      currentPosition: { rackNumber: '40', rackRow: 'B' },
      nextColor: 'blue',
      nextNumber: '13',
      nextPosition: { rackNumber: '38', rackRow: 'B' },
    });
    expect(c.changed).toBe(true);
    expect(c.currentLabel).toBe('Blue 4 on rack 40-B');
    expect(c.nextLabel).toBe('Blue 13 on rack 38-B');
  });

  it('the FINGERPRINT ignores the position — a shipped client stays answerable', () => {
    // An acknowledgement is (itemId, fingerprint). Folding the rack into the
    // fingerprint would invalidate every one a shipped client computes, and
    // would make a rack-only move refuse forever with nothing to acknowledge.
    expect(bookCrateFingerprint('blue', '4')).toBe(bookCrateFingerprint('blue', '4'));
    const withPos = describeBookCrateConflict({
      itemId: 'i1',
      itemName: 'Persepolis',
      currentColor: 'blue',
      currentNumber: '4',
      currentPosition: { rackNumber: '40', rackRow: 'B' },
      nextColor: 'green',
      nextNumber: '2',
      nextPosition: { rackNumber: '38', rackRow: 'B' },
    });
    expect(withPos!.currentFingerprint).toBe(bookCrateFingerprint('blue', '4'));
    expect(withPos!.currentLabel).toBe('Blue 4 on rack 40-B');
  });
});

describe('INVARIANT: changed ⇒ the two labels differ', () => {
  // Every value this org actually stores, crossed with itself. Colors include
  // the mixed case the Transfer dialog's free-text box can write, an unknown
  // color, and no color; numbers include the real free text "Bin"/"BIN"/"Blue
  // Shelf" and the real "0".
  const COLORS = [null, 'blue', 'Blue', 'BLUE', 'green', 'taupe', 'Taupe'];
  const NUMBERS = [null, '0', '4', '42', 'Bin', 'BIN', 'Blue Shelf'];

  it('holds across the whole colour × number × case matrix', () => {
    const offenders: string[] = [];
    let changedCount = 0;
    for (const cc of COLORS) {
      for (const cn of NUMBERS) {
        for (const nc of COLORS) {
          for (const nn of NUMBERS) {
            const r = cmp(cc, cn, nc, nn);
            if (!r.changed) continue;
            changedCount += 1;
            if (r.currentLabel === r.nextLabel) {
              offenders.push(`(${cc},${cn}) → (${nc},${nn}) both read "${r.currentLabel}"`);
            }
          }
        }
      }
    }
    // The matrix has to actually exercise the property, or an all-false run
    // would pass vacuously.
    expect(changedCount).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });

  it('the three cases the reviewer measured at HEAD', () => {
    // Each of these read "changed, but X → X" before the fix.
    const a = cmp('Blue', '42', null, '42');
    expect(a).toMatchObject({ changed: true, colorChanged: true });
    expect(a.currentLabel).toBe('Blue 42');
    expect(a.nextLabel).toBe('42');

    const b = cmp('Blue', '42', 'Green', '42');
    expect(b.changed).toBe(true);
    expect(b.currentLabel).toBe('Blue 42');
    expect(b.nextLabel).toBe('Green 42');

    const c = cmp('taupe', '4', null, '4');
    expect(c.changed).toBe(true);
    expect(c.currentLabel).toBe('taupe 4');
    expect(c.nextLabel).toBe('4');
  });

  it("'Blue' vs 'blue' is the SAME crate — no change to label at all", () => {
    expect(cmp('Blue', '42', 'blue', '42').changed).toBe(false);
    expect(cmp('BLUE', 'Bin', 'blue', 'BIN').changed).toBe(false);
  });
});

describe('normalizeCrateColorForWrite — mixed case never enters the DB', () => {
  it('canonicalises a known color to its slug', () => {
    expect(normalizeCrateColorForWrite('Blue')).toBe('blue');
    expect(normalizeCrateColorForWrite(' BLUE ')).toBe('blue');
    expect(normalizeCrateColorForWrite('blue')).toBe('blue');
  });
  it('keeps an unknown color verbatim — it is the only spelling anyone has', () => {
    expect(normalizeCrateColorForWrite('Taupe')).toBe('Taupe');
    expect(normalizeCrateColorForWrite(' Blue Shelf ')).toBe('Blue Shelf');
  });
  it('blank is null', () => {
    expect(normalizeCrateColorForWrite('')).toBeNull();
    expect(normalizeCrateColorForWrite('   ')).toBeNull();
    expect(normalizeCrateColorForWrite(null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SCOPED ACKNOWLEDGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('bookCrateFingerprint', () => {
  it('is stable across case and whitespace — the same crate fingerprints once', () => {
    expect(bookCrateFingerprint('Blue', ' 4 ')).toBe(bookCrateFingerprint('blue', '4'));
    expect(bookCrateFingerprint(null, 'Bin')).toBe(bookCrateFingerprint(null, 'BIN'));
  });
  it('distinguishes different crates', () => {
    expect(bookCrateFingerprint('blue', '4')).not.toBe(bookCrateFingerprint('red', '7'));
    expect(bookCrateFingerprint('blue', '4')).not.toBe(bookCrateFingerprint('blue', '42'));
    expect(bookCrateFingerprint(null, null)).not.toBe(bookCrateFingerprint('blue', null));
  });
  it('does not collide across the space-joined free text ("Blue Shelf")', () => {
    expect(bookCrateFingerprint('blue', 'shelf 2')).not.toBe(
      bookCrateFingerprint('blue shelf', '2'),
    );
  });
});

describe('describeBookCrateConflict — one constructor for both halves', () => {
  it('returns null when nothing changes', () => {
    expect(
      describeBookCrateConflict({
        itemId: 'i-1',
        itemName: 'Persepolis',
        currentColor: 'blue',
        currentNumber: '4',
        nextColor: 'BLUE',
        nextNumber: ' 4 ',
      }),
    ).toBeNull();
  });
  it('carries the fingerprint of the CURRENT crate it labelled', () => {
    const c = describeBookCrateConflict({
      itemId: 'i-1',
      itemName: 'Persepolis',
      currentColor: 'Blue',
      currentNumber: '4',
      nextColor: 'red',
      nextNumber: '7',
    })!;
    expect(c).toEqual({
      itemId: 'i-1',
      itemName: 'Persepolis',
      currentLabel: 'Blue 4',
      nextLabel: 'Red 7',
      currentFingerprint: bookCrateFingerprint('blue', '4'),
    });
  });
});

describe('an acknowledgement is SCOPED, not a blanket off-switch', () => {
  const shown = describeBookCrateConflict({
    itemId: 'i-1',
    itemName: 'Persepolis',
    currentColor: 'blue',
    currentNumber: '4',
    nextColor: null,
    nextNumber: null,
  })!;
  const ack = toBookCrateAcknowledgement([shown]);

  it('waives the change it was shown', () => {
    expect(isBookCrateChangeAcknowledged(bookCrateAcknowledgementIndex(ack), shown)).toBe(true);
  });

  it('does NOT waive the same book in a DIFFERENT crate — the stale-snapshot bug', () => {
    // Staging rendered "Blue 4"; someone re-crated the book to Red 7 from the
    // item screen. The acknowledgement names Blue 4, so it cannot answer for
    // Red 7 and the server must still refuse.
    const actual = describeBookCrateConflict({
      itemId: 'i-1',
      itemName: 'Persepolis',
      currentColor: 'red',
      currentNumber: '7',
      nextColor: null,
      nextNumber: null,
    })!;
    expect(isBookCrateChangeAcknowledged(bookCrateAcknowledgementIndex(ack), actual)).toBe(false);
  });

  it('does NOT waive a DIFFERENT book', () => {
    expect(
      isBookCrateChangeAcknowledged(bookCrateAcknowledgementIndex(ack), {
        ...shown,
        itemId: 'i-2',
      }),
    ).toBe(false);
  });

  it('an empty or absent acknowledgement waives nothing', () => {
    expect(isBookCrateChangeAcknowledged(bookCrateAcknowledgementIndex([]), shown)).toBe(false);
    expect(isBookCrateChangeAcknowledged(bookCrateAcknowledgementIndex(null), shown)).toBe(false);
  });

  it('a caller sending two fingerprints for one book only gets the first', () => {
    const index = bookCrateAcknowledgementIndex([
      { itemId: 'i-1', currentFingerprint: bookCrateFingerprint('green', '2') },
      { itemId: 'i-1', currentFingerprint: shown.currentFingerprint },
    ]);
    expect(isBookCrateChangeAcknowledged(index, shown)).toBe(false);
  });
});

describe('bookCrateAcknowledgementsMatch — re-ask only on NEW information', () => {
  const a = { itemId: 'i-1', currentFingerprint: bookCrateFingerprint('blue', '4') };
  const b = { itemId: 'i-2', currentFingerprint: bookCrateFingerprint('green', '2') };

  it('an identical payload is already answered (no loop)', () => {
    expect(bookCrateAcknowledgementsMatch([a, b], [b, a])).toBe(true);
  });
  it('a payload naming a crate we did not show is NEW — re-ask', () => {
    const stale = { itemId: 'i-1', currentFingerprint: bookCrateFingerprint('red', '7') };
    expect(bookCrateAcknowledgementsMatch([a], [stale])).toBe(false);
  });
  it('a payload naming an extra book is NEW — re-ask', () => {
    expect(bookCrateAcknowledgementsMatch([a], [a, b])).toBe(false);
  });
  it('nothing sent yet never counts as answered', () => {
    expect(bookCrateAcknowledgementsMatch(undefined, [a])).toBe(false);
    expect(bookCrateAcknowledgementsMatch([], [a])).toBe(false);
  });
});

describe('bookCratePlacementWillSync — do not ask about a write that cannot happen', () => {
  const base = { destinationLocationId: 'dest', fromLocationId: 'stg', quantity: 5 };

  it('no placed holdings yet → the destination becomes the only one, so it writes', () => {
    expect(bookCratePlacementWillSync({ ...base, placedHoldings: [] })).toBe(true);
  });
  it('already only in the destination → still writes', () => {
    expect(
      bookCratePlacementWillSync({
        ...base,
        placedHoldings: [{ locationId: 'dest', quantity: 3 }],
      }),
    ).toBe(true);
  });
  it('stock also on a Site (migration 0292 DC4) → SPLIT, the sync skips', () => {
    expect(
      bookCratePlacementWillSync({
        ...base,
        placedHoldings: [{ locationId: 'dc4', quantity: 405 }],
      }),
    ).toBe(false);
  });
  it('a source this placement fully drains is not a rival placement', () => {
    expect(
      bookCratePlacementWillSync({
        ...base,
        fromLocationId: 'rack-a',
        quantity: 5,
        placedHoldings: [{ locationId: 'rack-a', quantity: 5 }],
      }),
    ).toBe(true);
  });
  it('a PARTIAL draw from a placed source leaves it holding stock → still split', () => {
    expect(
      bookCratePlacementWillSync({
        ...base,
        fromLocationId: 'rack-a',
        quantity: 2,
        placedHoldings: [{ locationId: 'rack-a', quantity: 5 }],
      }),
    ).toBe(false);
  });
});
