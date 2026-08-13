import { describe, expect, it } from 'vitest';

import type { DestinationOption } from './destination-option';
import {
  destinationCrate,
  destinationLabel,
  destinationPhrase,
  destinationPosition,
  destinationRackLabel,
  isCrateChoice,
  newDestinationProblem,
  newDestinationReady,
  type ChosenDestination,
} from './placement-destination';

/**
 * This module shipped with NO test file and names no snake_case rack key, so
 * neither arm of the rack-shape recurrence guard could see it. It is also the
 * thing that decides what a CONFIRMATION says a placement will create — the
 * exact string the operator is agreeing to — so an edit that composed a name by
 * hand instead of delegating to `deriveLocationName` would have sailed through.
 *
 * The guard now lists it as a NAME_COMPOSER (delegation + no hand-built shape);
 * these are the behavioural half.
 */

function option(over: Partial<DestinationOption> = {}): DestinationOption {
  return {
    id: 'loc-1',
    name: '22-B',
    kind: 'rack',
    rackNumber: '22',
    rackRow: 'B',
    crateColor: null,
    crateNumber: null,
    ...over,
  };
}

/**
 * An EXISTING crate row. Position-less by default, because that is what every
 * crate in production is today — the `rack_number` / `rack_row` columns are on
 * the row (0188) but no writer filled them for a crate until crates could sit
 * on racks.
 */
function crateOption(over: Partial<DestinationOption> = {}): DestinationOption {
  return option({
    kind: 'crate',
    name: 'Blue #4',
    rackNumber: null,
    rackRow: null,
    crateColor: 'blue',
    crateNumber: '4',
    ...over,
  });
}

/** The inline "+ New crate" fields, position-less unless a case says otherwise. */
function newCrate(over: Partial<Extract<ChosenDestination, { mode: 'new-crate' }>> = {}) {
  return {
    mode: 'new-crate' as const,
    crateColor: '',
    crateNumber: '',
    rackNumber: '',
    rackRow: '',
    ...over,
  };
}

describe('destinationLabel — the string the confirmation shows IS the name created', () => {
  it('an existing destination is named by its own row', () => {
    expect(destinationLabel({ mode: 'existing', option: option({ name: 'Blue #4' }) })).toBe(
      'Blue #4',
    );
  });

  it('a new rack goes through the shared derivation, row and all', () => {
    expect(destinationLabel({ mode: 'new-rack', rackNumber: 'A1', rackRow: 'Row 3' })).toBe(
      'A1-Row 3',
    );
  });

  it('a WHOLE label typed into the number box still names the rack it decomposes to', () => {
    // The 2026-07-23 shape. Hand-composing `${number}-${row}` here would render
    // "22-B-" for this input and drift from the columns the server stores.
    expect(destinationLabel({ mode: 'new-rack', rackNumber: '22-B', rackRow: '' })).toBe('22-B');
  });

  it('a new crate uses the "#"-style DEDUPE KEY, not the summary spelling', () => {
    // "Blue #42" is what migration 0270's unique index matches on. "Blue 42"
    // (formatCrateLabel) is the human summary and must never be used here.
    expect(destinationLabel(newCrate({ crateColor: 'blue', crateNumber: '42' }))).toBe('Blue #42');
  });

  it('a NUMBER-ONLY crate is still a crate, and is named as one', () => {
    expect(destinationLabel(newCrate({ crateNumber: '9' }))).toBe('Crate #9');
  });

  it('an incomplete crate names NOTHING rather than guessing', () => {
    // A colour with no number is not a crate identity. The dialogs gate submit
    // on the number, so this is the belt to that braces.
    expect(destinationLabel(newCrate({ crateColor: 'blue' }))).toBe('');
  });

  it('a POSITIONED crate is named with the rack it sits on', () => {
    // The confirmation string IS the created name IS migration 0270's dedupe
    // key. Dropping the position here would name one crate and create another
    // — the 2026-07-23 divergence — and would merge the five real "gray BIN"
    // bins into one row.
    expect(
      destinationLabel(newCrate({ crateColor: 'blue', crateNumber: '13', rackNumber: '38', rackRow: 'B' })),
    ).toBe('Blue #13 on rack 38-B');
    expect(
      destinationLabel(newCrate({ crateColor: 'gray', crateNumber: 'BIN', rackNumber: '41', rackRow: 'C' })),
    ).toBe('Gray #BIN on rack 41-C');
  });

  it('a whole rack label typed into the crate form decomposes before naming', () => {
    expect(destinationLabel(newCrate({ crateNumber: '13', rackNumber: '38-B' }))).toBe(
      'Crate #13 on rack 38-B',
    );
  });
});

/**
 * THE READINESS GATE — pinned against `destinationLabel`, by construction.
 *
 * The three web dialogs each carried their own hand-rolled version of this
 * predicate ("is `crateNumber` non-empty?") and it drifted from the planner
 * inside the commit that gave a crate its rack pair: crate 13 plus a "Row" with
 * no "On rack" number satisfied every one of them, `planNewLocation` refused the
 * pair, `destinationLabel` returned '' and the confirmation rendered
 *
 *   "Create new crate ? does not exist in Main Warehouse yet. Continuing
 *    creates it and moves 10 units into it."
 *
 * So the invariant worth pinning is not "these fields are non-empty" — it is
 * READY IFF THERE IS A NAME. That is the one property whose violation produces
 * an unnameable confirmation, and it is checked against `destinationLabel` for
 * every row rather than asserted separately, because two independent lists are
 * exactly how a gate and a namer come apart.
 */
describe('newDestinationReady — ready IFF the planner can name it', () => {
  const cases: Array<[string, ChosenDestination, boolean]> = [
    ['an untouched rack form', { mode: 'new-rack', rackNumber: '', rackRow: '' }, false],
    ['a rack with a number', { mode: 'new-rack', rackNumber: 'A1', rackRow: '' }, true],
    // A row alone names no position, on a rack or on a crate.
    ['a rack ROW with no number', { mode: 'new-rack', rackNumber: '', rackRow: 'Row 3' }, false],
    ['an untouched crate form', newCrate(), false],
    ['a colour with no number', newCrate({ crateColor: 'blue' }), false],
    ['a number-only crate', newCrate({ crateNumber: '9' }), true],
    // THE DEFECT. Both halves of the position, or neither.
    ['a crate whose Row has no "On rack" number', newCrate({ crateNumber: '13', rackRow: 'B' }), false],
    ['that same crate once the rack number arrives', newCrate({ crateNumber: '13', rackNumber: '38', rackRow: 'B' }), true],
    ['a crate on a rack, no row', newCrate({ crateNumber: '13', rackNumber: '38' }), true],
    // Whitespace is the operator's, not a field value.
    ['a crate number of only spaces', newCrate({ crateNumber: '   ' }), false],
    ['an EXISTING destination — it plans nothing to be incomplete about', { mode: 'existing', option: option() }, true],
  ];

  it.each(cases)('%s → %s', (_name, dest, expected) => {
    expect(newDestinationReady(dest)).toBe(expected);
    // The gate and the namer, checked against each other on the same input:
    // ready must mean "there is a label to confirm", and an existing row always
    // has one.
    if (dest.mode !== 'existing') {
      expect(destinationLabel(dest).length > 0).toBe(expected);
    }
  });
});

describe('newDestinationProblem — the planner’s own words, and silence before they apply', () => {
  it('says nothing about a form nobody has typed into yet', () => {
    // All four boxes empty plans as `rack_needs_number`; shouting that at an
    // untouched crate form is noise. Submit is gated regardless.
    expect(newDestinationProblem({ mode: 'new-rack', rackNumber: '', rackRow: '' })).toBeNull();
    expect(newDestinationProblem(newCrate())).toBeNull();
    expect(newDestinationReady(newCrate())).toBe(false);
  });

  it('names the MISSING half of a crate position — the defect, in words', () => {
    expect(newDestinationProblem(newCrate({ crateNumber: '13', rackRow: 'B' }))).toBe(
      'Give the rack a number.',
    );
  });

  it('says a colour is not a crate identity', () => {
    expect(newDestinationProblem(newCrate({ crateColor: 'blue' }))).toBe(
      'Give the crate a number — a color on its own does not name a crate.',
    );
  });

  it('says nothing once the fields name something', () => {
    expect(newDestinationProblem(newCrate({ crateNumber: '13', rackNumber: '38', rackRow: 'B' }))).toBeNull();
    expect(newDestinationProblem({ mode: 'new-rack', rackNumber: '22-B', rackRow: '' })).toBeNull();
    expect(newDestinationProblem({ mode: 'existing', option: option() })).toBeNull();
  });
});

describe('destinationPosition — one accessor for BOTH kinds', () => {
  it('a rack answers with its own pair', () => {
    expect(destinationRackLabel({ mode: 'existing', option: option() })).toBe('22-B');
    expect(destinationRackLabel({ mode: 'new-rack', rackNumber: '22-B', rackRow: '' })).toBe('22-B');
  });

  it('a crate answers with the rack it SITS ON', () => {
    expect(
      destinationRackLabel(newCrate({ crateNumber: '13', rackNumber: '38', rackRow: 'B' })),
    ).toBe('38-B');
    expect(
      destinationRackLabel({
        mode: 'existing',
        option: crateOption({ rackNumber: '43', rackRow: 'B', crateColor: 'gray', crateNumber: 'BIN' }),
      }),
    ).toBe('43-B');
  });

  it('a crate on NO rack answers with nothing (production: "Blue Shelf")', () => {
    expect(destinationRackLabel(newCrate({ crateNumber: 'Blue Shelf' }))).toBe('');
    expect(destinationRackLabel({ mode: 'existing', option: crateOption() })).toBe('');
    expect(destinationPosition({ mode: 'existing', option: crateOption() })).toEqual({
      rackNumber: null,
      rackRow: null,
    });
  });
});

describe('destinationCrate — the `next` side of the comparison', () => {
  it('a RACK answers (null, null): a book on a rack is in no crate', () => {
    expect(destinationCrate({ mode: 'new-rack', rackNumber: 'A1', rackRow: '' })).toEqual({
      color: null,
      number: null,
    });
    expect(destinationCrate({ mode: 'existing', option: option() })).toEqual({
      color: null,
      number: null,
    });
  });

  it('an EXISTING crate answers with the columns the location row carries', () => {
    expect(destinationCrate({ mode: 'existing', option: crateOption() })).toEqual({
      color: 'blue',
      number: '4',
    });
  });

  it('blank crate fields normalise to null, not ""', () => {
    expect(destinationCrate(newCrate({ crateColor: '  ', crateNumber: ' 4 ' }))).toEqual({
      color: null,
      number: '4',
    });
  });

  it('the POSITION is not folded into the crate pair — they stay two facts', () => {
    // The crate comparison is crate-only; the rack is its own sentence
    // (describeRackChange). Merging them would interrogate an operator about a
    // crate that did not change.
    expect(
      destinationCrate(newCrate({ crateColor: 'gray', crateNumber: 'BIN', rackNumber: '43', rackRow: 'B' })),
    ).toEqual({ color: 'gray', number: 'BIN' });
  });
});

describe('isCrateChoice', () => {
  it('reads an existing destination from its kind, never from its name', () => {
    expect(isCrateChoice({ mode: 'existing', option: option({ kind: 'crate' }) })).toBe(true);
    expect(isCrateChoice({ mode: 'existing', option: option({ kind: 'rack' }) })).toBe(false);
  });

  it('a new-crate branch is a crate even with no colour', () => {
    expect(isCrateChoice(newCrate({ crateNumber: '9' }))).toBe(true);
  });

  it('a crate ON a rack is still a CRATE — the rack does not demote it', () => {
    expect(isCrateChoice(newCrate({ crateNumber: '9', rackNumber: 'A1' }))).toBe(true);
  });
});

describe('destinationPhrase — reads as English in a success sentence', () => {
  const cases: Array<[ChosenDestination, string]> = [
    [newCrate({ crateColor: 'blue', crateNumber: '42' }), 'into Blue crate 42'],
    [newCrate({ crateNumber: '9' }), 'into crate 9'],
    [{ mode: 'new-rack', rackNumber: 'A1', rackRow: 'Row 3' }, 'onto rack A1-Row 3'],
    [{ mode: 'existing', option: option() }, 'onto rack 22-B'],
    [{ mode: 'existing', option: crateOption() }, 'into Blue crate 4'],
    // The whole truth, in the sentence a picker reads after a successful place.
    [
      newCrate({ crateColor: 'blue', crateNumber: '13', rackNumber: '38', rackRow: 'B' }),
      'into Blue crate 13 on rack 38-B',
    ],
    [
      { mode: 'existing', option: crateOption({ crateColor: 'gray', crateNumber: 'BIN', name: 'Gray #BIN on rack 43-B', rackNumber: '43', rackRow: 'B' }) },
      'into Gray crate BIN on rack 43-B',
    ],
  ];
  it.each(cases)('%o → %s', (dest, expected) => {
    expect(destinationPhrase(dest)).toBe(expected);
  });

  it('a legacy crate row carrying NO columns falls back to its own name', () => {
    expect(
      destinationPhrase({
        mode: 'existing',
        option: crateOption({ name: 'Old Crate', crateColor: null, crateNumber: null }),
      }),
    ).toBe('into Old Crate');
  });
});
