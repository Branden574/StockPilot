import { describe, it, expect } from 'vitest';

import {
  describeRackChange,
  formatRackLabel,
  formatRackPosition,
  hasRackPosition,
  isCompositeRackNumber,
  normalizeRackFields,
  parseRackLabel,
  rackOutcomeBasis,
} from './rack-label';

describe('parseRackLabel', () => {
  it('bare number has no row', () => {
    expect(parseRackLabel('22')).toEqual({ number: '22', row: null });
  });

  it('number-row splits on the dash', () => {
    expect(parseRackLabel('22-B')).toEqual({ number: '22', row: 'B' });
  });

  it('multi-dash splits on the LAST dash', () => {
    // A rack legitimately named "E2E-RACK" with row 1 — splitting on the FIRST
    // dash would turn it into E2E / RACK-1 and lose the rack.
    expect(parseRackLabel('E2E-RACK-1')).toEqual({ number: 'E2E-RACK', row: '1' });
  });

  it('no dash at all is all number', () => {
    expect(parseRackLabel('MEZZANINE')).toEqual({ number: 'MEZZANINE', row: null });
  });

  it('empty string yields an empty number and no row', () => {
    expect(parseRackLabel('')).toEqual({ number: '', row: null });
  });

  it('whitespace-only yields an empty number and no row', () => {
    expect(parseRackLabel('   ')).toEqual({ number: '', row: null });
  });

  it('trims surrounding whitespace on both halves', () => {
    expect(parseRackLabel('  22 - B  ')).toEqual({ number: '22', row: 'B' });
  });

  it('preserves a lowercase row verbatim (casing normalisation is the writer\'s job)', () => {
    // The read path filters with an exact eq against stored values, so
    // uppercasing here would stop matching any row stored lowercase.
    expect(parseRackLabel('22-b')).toEqual({ number: '22', row: 'b' });
  });

  it('handles a numeric row', () => {
    expect(parseRackLabel('22-3')).toEqual({ number: '22', row: '3' });
  });

  it('handles a multi-character row', () => {
    expect(parseRackLabel('22-AB12')).toEqual({ number: '22', row: 'AB12' });
  });

  it('ignores a trailing dash rather than inventing an empty row', () => {
    expect(parseRackLabel('22-')).toEqual({ number: '22', row: null });
  });

  it('ignores a leading dash', () => {
    expect(parseRackLabel('-22')).toEqual({ number: '22', row: null });
  });

  it('does not leave a stray dash in the number half of a doubled dash', () => {
    expect(parseRackLabel('22--B')).toEqual({ number: '22', row: 'B' });
  });

  it('accepts null/undefined', () => {
    expect(parseRackLabel(null)).toEqual({ number: '', row: null });
    expect(parseRackLabel(undefined)).toEqual({ number: '', row: null });
  });
});

describe('formatRackLabel', () => {
  it('joins number and row with a dash', () => {
    expect(formatRackLabel({ number: '22', row: 'B' })).toBe('22-B');
  });

  it('renders a number-only rack unchanged', () => {
    expect(formatRackLabel({ number: '22', row: null })).toBe('22');
    expect(formatRackLabel({ number: '22' })).toBe('22');
    expect(formatRackLabel({ number: '22', row: '  ' })).toBe('22');
  });

  it('renders nothing without a number', () => {
    expect(formatRackLabel({ number: '', row: 'B' })).toBe('');
    expect(formatRackLabel({ number: null, row: 'B' })).toBe('');
  });

  it('round-trips every parse (the label a user sees never changes)', () => {
    for (const label of ['22', '22-B', 'E2E-RACK-1', 'MEZZANINE', '22-3', '22-AB12']) {
      expect(formatRackLabel(parseRackLabel(label))).toBe(label);
    }
  });
});

describe('isCompositeRackNumber', () => {
  it('flags a whole label parked in the number column', () => {
    expect(isCompositeRackNumber('22-B')).toBe(true);
    expect(isCompositeRackNumber('100-A')).toBe(true);
    expect(isCompositeRackNumber('E2E-RACK-1')).toBe(true);
  });

  it('does not flag a legitimate bare number', () => {
    expect(isCompositeRackNumber('22')).toBe(false);
    expect(isCompositeRackNumber('Z9')).toBe(false);
    expect(isCompositeRackNumber('')).toBe(false);
    expect(isCompositeRackNumber(null)).toBe(false);
    expect(isCompositeRackNumber(undefined)).toBe(false);
  });
});

describe('normalizeRackFields', () => {
  it('splits a full label typed into the number field', () => {
    expect(normalizeRackFields({ number: '22-B' })).toEqual({ number: '22', row: 'B' });
    expect(normalizeRackFields({ number: '22-B', row: null })).toEqual({ number: '22', row: 'B' });
    expect(normalizeRackFields({ number: '22-B', row: '' })).toEqual({ number: '22', row: 'B' });
  });

  it('leaves an already-decomposed pair alone', () => {
    expect(normalizeRackFields({ number: '22', row: 'B' })).toEqual({ number: '22', row: 'B' });
  });

  it('trusts an explicit row over splitting a dashed rack name', () => {
    expect(normalizeRackFields({ number: 'E2E-RACK', row: '1' })).toEqual({
      number: 'E2E-RACK',
      row: '1',
    });
  });

  it('drops a duplicated row when the user typed the label AND picked the row', () => {
    expect(normalizeRackFields({ number: '22-B', row: 'B' })).toEqual({ number: '22', row: 'B' });
    expect(normalizeRackFields({ number: '22-b', row: 'B' })).toEqual({ number: '22', row: 'B' });
  });

  it('keeps a number-only rack number-only', () => {
    expect(normalizeRackFields({ number: '20' })).toEqual({ number: '20', row: null });
  });

  it('never returns a composite number', () => {
    for (const input of [
      { number: '22-B' },
      { number: '100-A', row: '' },
      { number: '3-C', row: null },
      { number: ' 22 - B ' },
    ]) {
      expect(isCompositeRackNumber(normalizeRackFields(input).number)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// A rack POSITION — the pair as every app surface spells it, and the ONE
// sentence a confirmation says when a placement moves it.
//
// This exists because a crate SITS ON a rack: a crate row carries the same pair
// as its position, so the position had to become a value that can be passed
// around whole instead of two fields one caller can drop.
// ---------------------------------------------------------------------------

describe('formatRackPosition', () => {
  it('joins the pair the one way a rack is ever shown', () => {
    expect(formatRackPosition({ rackNumber: '38', rackRow: 'B' })).toBe('38-B');
    expect(formatRackPosition({ rackNumber: '38' })).toBe('38');
  });

  it('decomposes a whole label parked in the number field', () => {
    // "38-B" typed into an "On rack" box, and the double-entry case.
    expect(formatRackPosition({ rackNumber: '38-B' })).toBe('38-B');
    expect(formatRackPosition({ rackNumber: '38-B', rackRow: 'B' })).toBe('38-B');
  });

  it('a row with no number names NOTHING — it never invents the rack "B"', () => {
    expect(formatRackPosition({ rackRow: 'B' })).toBe('');
    expect(formatRackPosition(null)).toBe('');
    expect(formatRackPosition(undefined)).toBe('');
    expect(hasRackPosition({ rackRow: 'B' })).toBe(false);
    expect(hasRackPosition({ rackNumber: '38', rackRow: 'B' })).toBe(true);
  });
});

describe('describeRackChange', () => {
  it('names both ends when the rack a book is recorded on moves', () => {
    expect(
      describeRackChange(
        { rackNumber: '40', rackRow: 'B' },
        { rackNumber: '38', rackRow: 'B' },
        'unknown',
      ),
    ).toBe('Rack will change from 40-B to 38-B.');
  });

  it('says nothing when the rack is unchanged (case-insensitively)', () => {
    expect(
      describeRackChange(
        { rackNumber: '38', rackRow: 'B' },
        { rackNumber: '38', rackRow: 'b' },
        'resolves-to-destination',
      ),
    ).toBeNull();
  });

  // ═══ REWRITTEN, DELIBERATELY ═══
  //
  // This block used to assert "NEVER promises a clear", on the reasoning that
  // the writer left the rack keys alone so any clear-promise would be a lie.
  // That reason went STALE: since the holdings-derivation and migration 0336,
  // syncBookCratePlacementInner derives BOTH pairs from the single location the
  // book's live stock resolves to, so a full move into a position-less crate
  // really does clear book_rack_number / book_rack_row. The owner walked it —
  // rack 38-A, 18 units in staging, placed into "Blue #Shelf" — and the
  // confirmation's silence cost him a rack he had typed by hand.
  //
  // The old assertion is therefore not weakened, it is re-aimed: silence is
  // still mandatory when the outcome is UNKNOWABLE, and is now a defect when the
  // caller has read the holdings and knows better.
  it('says nothing about a clear when the outcome is not knowable', () => {
    // Production really holds this shape: blue "Blue Shelf", 5 books, rack NULL.
    expect(describeRackChange({ rackNumber: '40', rackRow: 'B' }, null, 'unknown')).toBeNull();
    expect(
      describeRackChange({ rackNumber: '40', rackRow: 'B' }, { rackRow: 'B' }, 'unknown'),
    ).toBeNull();
  });

  it('SAYS THE CLEAR, naming what is lost, once the holdings have been read', () => {
    // The owner's exact case. A position-less destination plus "this move leaves
    // the destination as the only placement" is precisely the branch in which
    // the writer clears the pair, so the confirmation must state it.
    expect(
      describeRackChange({ rackNumber: '38', rackRow: 'A' }, null, 'resolves-to-destination'),
    ).toBe('Rack 38-A will be cleared.');
    expect(
      describeRackChange(
        { rackNumber: '38', rackRow: 'A' },
        { rackNumber: '', rackRow: null },
        'resolves-to-destination',
      ),
    ).toBe('Rack 38-A will be cleared.');
    // A number-only rack is named the way it is stored and displayed.
    expect(describeRackChange({ rackNumber: '22' }, null, 'resolves-to-destination')).toBe(
      'Rack 22 will be cleared.',
    );
  });

  it('a POSITIONED crate reads as a move, not a clear — a crate SITS ON a rack', () => {
    // The destination is a crate, but it states a position, so the pair becomes
    // that position rather than clearing. Same sentence as a plain rack, because
    // it is the same fact about the rack pair.
    expect(
      describeRackChange(
        { rackNumber: '38', rackRow: 'A' },
        { rackNumber: '22', rackRow: 'B' },
        'resolves-to-destination',
      ),
    ).toBe('Rack will change from 38-A to 22-B.');
  });

  it('filling a BLANK rack is not announced — nothing recorded is being replaced', () => {
    expect(
      describeRackChange(null, { rackNumber: '38', rackRow: 'B' }, 'resolves-to-destination'),
    ).toBeNull();
    // Nor is clearing a rack that was never recorded: there is nothing to lose.
    expect(describeRackChange(null, null, 'resolves-to-destination')).toBeNull();
  });
});

describe('rackOutcomeBasis — "we could not tell" never becomes "it will be cleared"', () => {
  it('only an explicit true earns the claim', () => {
    expect(rackOutcomeBasis(true)).toBe('resolves-to-destination');
  });

  it('false (a genuine split) and undefined (no prediction) both stay silent', () => {
    // undefined is the fail-closed shape: the gate could not describe this
    // item's move, so it still ASKS about the crate — but it must not assert
    // anything about the rack on the back of a read that never answered.
    expect(rackOutcomeBasis(false)).toBe('unknown');
    expect(rackOutcomeBasis(undefined)).toBe('unknown');
  });
});
