/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NATIVE ITEM SCREEN'S LOCATION CARD — the rows, as rows
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rules are pure and tested in @stockpilot/core (placement-resolution
 * .test.ts, holdings-contradict-rack.test.ts). What is tested HERE is the thing
 * core cannot see: what this screen HANDS the rules, and therefore which rows a
 * picker actually gets.
 *
 * That gap had teeth. The screen passed its DISPLAY label — "38 · A", built
 * with a middle dot since 42cacb9b — into `holdingsContradictRack`, which
 * canonicalises through `parseRackLabel` (a LAST-DASH split). "38 · A" has no
 * dash, so it canonicalised to "38 · a" and could never equal a holding named
 * "38-A". The predicate answered "contradicted" for essentially every item with
 * a rack or crate holding: a non-book whose stock sat exactly on 38-A lost its
 * entire location card, and a book correctly in "Gray #BIN on rack 43-B" lost
 * the very RACK row the change had been written to restore.
 *
 * Every rule involved was already green in core. Only a test that asserts on
 * the ROW LIST can catch a caller feeding the right rule the wrong string,
 * which is why this file exists and why the logic was moved out of the screen
 * (screens cannot be loaded under vitest — they import native modules).
 */
import type { RackHoldingLike } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { buildPlacementRows, type PlacementRowsInput } from './placement-rows';

const rack = (name: string, quantity = 4): RackHoldingLike => ({ name, quantity, kind: 'rack' });
const crate = (name: string, quantity = 5): RackHoldingLike => ({ name, quantity, kind: 'crate' });

/** Everything absent — each test turns on only the fields it is about. */
const BLANK: PlacementRowsInput = {
  itemType: 'product',
  warehouseName: null,
  charterName: null,
  locationName: null,
  rackNumber: null,
  rackRow: null,
  legacyRackLabel: null,
  crateColor: null,
  crateNumber: null,
  grade: null,
  binLocation: null,
  holdings: [],
};

const rowsFor = (over: Partial<PlacementRowsInput>) => buildPlacementRows({ ...BLANK, ...over });
const labelsOf = (over: Partial<PlacementRowsInput>) => rowsFor(over).map((r) => r.label);
const valueOf = (over: Partial<PlacementRowsInput>, label: string) =>
  rowsFor(over).find((r) => r.label === label)?.value ?? null;

describe('THE REGRESSION — a display separator is not a rack label', () => {
  it('a NON-BOOK on a plain rack keeps its RACK row (the whole card used to vanish)', () => {
    // Stock is on 38-A. The item remembers 38/A. Nothing is stale, nothing is
    // split, and there is no bin_location to fall back to — so if the RACK row
    // stands down, this item has no location card at all.
    const rows = rowsFor({
      itemType: 'product',
      rackNumber: '38',
      rackRow: 'A',
      holdings: [rack('38-A')],
    });
    expect(rows).toEqual([{ label: 'RACK', value: '38 · A' }]);
  });

  it('a BOOK in a POSITIONED crate keeps its RACK row — the row the fix was for', () => {
    // After a correct 0336 sync the pair (43, B) agrees with the holding: the
    // crate is ON 43-B, and its position travels inside its own name.
    const over = {
      itemType: 'book',
      rackNumber: '43',
      rackRow: 'B',
      crateColor: 'gray',
      crateNumber: 'BIN',
      holdings: [crate('Gray #BIN on rack 43-B')],
    };
    expect(labelsOf(over)).toEqual(['IN CRATE', 'RACK', 'CRATE']);
    expect(valueOf(over, 'RACK')).toBe('43 · B');
  });

  it('a DEPARTED rack still stands down — stock only in a position-less crate', () => {
    // The 0335 hazard: the pair survives a put-away that moved every unit into
    // a crate sitting on no rack. 40-B is now false and must not print.
    const over = {
      itemType: 'book',
      rackNumber: '40',
      rackRow: 'B',
      crateColor: 'gray',
      crateNumber: 'BIN',
      holdings: [crate('Gray #BIN')],
    };
    expect(labelsOf(over)).toEqual(['IN CRATE', 'CRATE']);
    expect(valueOf(over, 'IN CRATE')).toContain('Gray #BIN');
  });

  it('the DISPLAY spelling has no vote — the comparison reads the pair', () => {
    // Same pair, same holding, and the rendered value still carries the middle
    // dot: the row survives BECAUSE the compared value is derived from
    // (number, row), not from what is shown. A future change to the separator
    // must not be able to hide this row again.
    const over = { rackNumber: '38', rackRow: 'A', holdings: [rack('38-A')] };
    expect(valueOf(over, 'RACK')).toBe('38 · A');
    expect(valueOf(over, 'RACK')).not.toContain('-');
    expect(labelsOf(over)).toContain('RACK');
  });

  it('tolerates the legacy free-text label, and the legacy SHAPE inside it', () => {
    // Older imports stamped one value instead of the pair. It is already in the
    // canonical alphabet, so it decomposes the same way — including the
    // 2026-07-23 spaced shape.
    expect(labelsOf({ legacyRackLabel: '38-A', holdings: [rack('38-A')] })).toEqual(['RACK']);
    expect(labelsOf({ legacyRackLabel: '22 - B', holdings: [rack('22-B')] })).toEqual(['RACK']);
    expect(labelsOf({ legacyRackLabel: '38-A', holdings: [rack('5-C')] })).toEqual([]);
  });
});

describe('a SPLIT is not a contradiction — the rows a0ab90d4 blanked', () => {
  it('a book split across two racks keeps RACK, CRATE and the split row', () => {
    const over = {
      itemType: 'book',
      rackNumber: '39',
      rackRow: 'B',
      crateColor: 'red',
      crateNumber: '5',
      holdings: [rack('39-B'), rack('5-A')],
    };
    expect(labelsOf(over)).toEqual(['SPLIT STOCK', 'RACK', 'CRATE']);
    expect(valueOf(over, 'RACK')).toBe('39 · B');
    expect(valueOf(over, 'CRATE')).toBe('Red 5');
  });

  it('a split that names NEITHER rack does refute the summary', () => {
    expect(
      labelsOf({ rackNumber: '39', rackRow: 'B', holdings: [rack('5-A'), rack('2-C')] }),
    ).toEqual(['SPLIT STOCK']);
  });

  it('the CRATE row is refuted by nothing here, even when the rack is', () => {
    expect(
      labelsOf({
        itemType: 'book',
        rackNumber: '40',
        rackRow: 'B',
        crateColor: 'blue',
        crateNumber: '13',
        holdings: [crate('Gray #BIN')],
      }),
    ).toContain('CRATE');
  });
});

describe('the rest of the card is unchanged', () => {
  it('leads with warehouse, charter and site, in that order', () => {
    expect(
      labelsOf({
        warehouseName: 'DC4',
        charterName: 'Generic',
        locationName: 'DC4 Floor',
        rackNumber: '38',
        rackRow: 'A',
      }),
    ).toEqual(['WAREHOUSE', 'CHARTER', 'LOCATION', 'RACK']);
  });

  it('shows BIN only when no rack stands and no holdings row already named the place', () => {
    // A standing rack suppresses it (one physical spot, one label)...
    expect(
      labelsOf({ itemType: 'book', rackNumber: '38', rackRow: 'A', binLocation: 'Bay 3' }),
    ).toEqual(['RACK']);
    // ...so does a holdings row...
    expect(
      labelsOf({ itemType: 'book', binLocation: 'Bay 3', holdings: [crate('Gray #BIN')] }),
    ).toEqual(['IN CRATE']);
    // ...and with neither, it is the only thing left that knows anything.
    expect(labelsOf({ itemType: 'book', binLocation: 'Bay 3' })).toEqual(['BIN']);
    // Non-books call the same free-text field RACK, as they always have.
    expect(labelsOf({ itemType: 'product', binLocation: 'Bay 3' })).toEqual(['RACK']);
  });

  it('CRATE and GRADE are book-only', () => {
    const storage = { crateColor: 'red', crateNumber: '5', grade: 'K' };
    expect(labelsOf({ ...storage, itemType: 'book' })).toEqual(['CRATE', 'GRADE']);
    expect(labelsOf({ ...storage, itemType: 'product' })).toEqual([]);
  });

  it('carries the crate swatch hex alongside the label', () => {
    const row = rowsFor({ itemType: 'book', crateColor: 'red', crateNumber: '5' })[0];
    expect(row).toEqual({ label: 'CRATE', value: 'Red 5', dot: '#ef4444' });
  });

  it('an unknown crate color still names the crate — it just has no swatch', () => {
    expect(rowsFor({ itemType: 'book', crateColor: 'chartreuse', crateNumber: '5' })[0]).toEqual({
      label: 'CRATE',
      value: 'chartreuse 5',
      dot: null,
    });
  });

  it('knows nothing means no card', () => {
    expect(rowsFor({})).toEqual([]);
  });
});

describe('malformed data fails toward showing, never toward hiding', () => {
  it('a row with no number cannot be canonicalised, so it refutes nothing', () => {
    // formatRackPosition refuses to invent the rack "A" from a bare row, which
    // leaves an empty key — and an empty key never refutes. The row still
    // renders what the item remembers rather than silently disappearing.
    expect(rowsFor({ rackRow: 'A', holdings: [rack('5-C')] })).toEqual([
      { label: 'RACK', value: 'A' },
    ]);
  });

  it('holdings that were never fetched refute nothing (absence of evidence)', () => {
    expect(labelsOf({ rackNumber: '38', rackRow: 'A', holdings: [] })).toEqual(['RACK']);
  });

  it('a whole label parked in the number field still decomposes', () => {
    expect(valueOf({ rackNumber: '38-A', holdings: [rack('38-A')] }, 'RACK')).toBe('38-A');
    expect(labelsOf({ rackNumber: '38-A', holdings: [rack('5-C')] })).toEqual([]);
  });
});
