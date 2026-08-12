import { describe, expect, it } from 'vitest';

import type { DestinationOption } from './destination-option';
import {
  destinationCrate,
  destinationLabel,
  destinationPhrase,
  isCrateChoice,
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
    expect(destinationLabel({ mode: 'new-crate', crateColor: 'blue', crateNumber: '42' })).toBe(
      'Blue #42',
    );
  });

  it('a NUMBER-ONLY crate is still a crate, and is named as one', () => {
    expect(destinationLabel({ mode: 'new-crate', crateColor: '', crateNumber: '9' })).toBe(
      'Crate #9',
    );
  });

  it('an incomplete crate names NOTHING rather than guessing', () => {
    // A colour with no number is not a crate identity. The dialogs gate submit
    // on the number, so this is the belt to that braces.
    expect(destinationLabel({ mode: 'new-crate', crateColor: 'blue', crateNumber: '' })).toBe('');
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
    expect(
      destinationCrate({
        mode: 'existing',
        option: option({ kind: 'crate', name: 'Blue #4', crateColor: 'blue', crateNumber: '4' }),
      }),
    ).toEqual({ color: 'blue', number: '4' });
  });

  it('blank crate fields normalise to null, not ""', () => {
    expect(destinationCrate({ mode: 'new-crate', crateColor: '  ', crateNumber: ' 4 ' })).toEqual({
      color: null,
      number: '4',
    });
  });
});

describe('isCrateChoice', () => {
  it('reads an existing destination from its kind, never from its name', () => {
    expect(isCrateChoice({ mode: 'existing', option: option({ kind: 'crate' }) })).toBe(true);
    expect(isCrateChoice({ mode: 'existing', option: option({ kind: 'rack' }) })).toBe(false);
  });

  it('a new-crate branch is a crate even with no colour', () => {
    expect(isCrateChoice({ mode: 'new-crate', crateColor: '', crateNumber: '9' })).toBe(true);
  });
});

describe('destinationPhrase — reads as English in a success sentence', () => {
  const cases: Array<[ChosenDestination, string]> = [
    [{ mode: 'new-crate', crateColor: 'blue', crateNumber: '42' }, 'into Blue crate 42'],
    [{ mode: 'new-crate', crateColor: '', crateNumber: '9' }, 'into crate 9'],
    [{ mode: 'new-rack', rackNumber: 'A1', rackRow: 'Row 3' }, 'onto rack A1-Row 3'],
    [{ mode: 'existing', option: option() }, 'onto rack 22-B'],
    [
      {
        mode: 'existing',
        option: option({ kind: 'crate', name: 'Blue #4', crateColor: 'blue', crateNumber: '4' }),
      },
      'into Blue crate 4',
    ],
  ];
  it.each(cases)('%o → %s', (dest, expected) => {
    expect(destinationPhrase(dest)).toBe(expected);
  });

  it('a legacy crate row carrying NO columns falls back to its own name', () => {
    expect(
      destinationPhrase({
        mode: 'existing',
        option: option({ kind: 'crate', name: 'Old Crate', crateColor: null, crateNumber: null }),
      }),
    ).toBe('into Old Crate');
  });
});
