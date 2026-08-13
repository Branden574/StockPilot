/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "IS THIS STORED RACK STILL TRUE?" — the SUMMARY-CARD question
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A DETAIL CARD is not a pick slip. A pick slip has one cell and must print the
 * single best answer, which is what `resolvePlacement` decides. A card has room
 * for the item's stored Rack and Crate summaries AND the live holdings side by
 * side, so it must hide a summary only when that summary is FALSE.
 *
 * The two questions were conflated once and it cost real rows. The web item
 * card and the native item screen both used `resolution.source === 'holdings'`
 * as their hide-it flag, which is TRUE for the SPLIT arm as well as the crate
 * arm — so a book split across two racks lost its Rack row AND its crate
 * summary ("Red 5"), rows that main had always shown, for stock whose label was
 * perfectly true. The same flag blanked the rack of a book in "Gray #BIN on
 * rack 43-B", where the summary "43-B" is exactly right.
 *
 * Every case below is a row one of those two screens renders. `walkTo`-style
 * label formatting is NOT retested here — it belongs to placement-resolution
 * .test.ts; this file pins only the refutation.
 */
import { describe, expect, it } from 'vitest';

import { locationNameSitsOnRack } from './book-storage';
import { holdingsContradictRack } from './placement-resolution';
import type { RackHoldingLike } from './rack-holdings';

const rack = (name: string, quantity = 4): RackHoldingLike => ({ name, quantity, kind: 'rack' });
const crate = (name: string, quantity = 5): RackHoldingLike => ({ name, quantity, kind: 'crate' });

describe('holdingsContradictRack — what actually refutes a stored rack label', () => {
  it('THE 0335 DEFECT: stock entirely inside a position-less crate refutes the rack', () => {
    // The item still carries book_rack_number 40 / row B because a
    // position-less put-away preserves the pair on purpose. No stock is on
    // 40-B any more, so the Rack row must stand down.
    expect(holdingsContradictRack('40-B', [crate('Gray #BIN')])).toBe(true);
  });

  it('THE REGRESSION: a split ACROSS RACKS does not refute a label naming one of them', () => {
    // a0ab90d4 hid the Rack row (and the Crate row beside it) here, because
    // resolvePlacement calls a split authoritative. Nothing is false: stock
    // really is on 39-B, and the breakdown beside the row names the rest.
    expect(holdingsContradictRack('39-B', [rack('39-B'), rack('5-A')])).toBe(false);
  });

  it('a split that names NEITHER of the racks it sits on DOES refute the label', () => {
    expect(holdingsContradictRack('39-B', [rack('5-A'), rack('2-C')])).toBe(true);
  });

  it('DO NOT OVER-CORRECT: a POSITIONED crate keeps the rack it sits on', () => {
    // The position travels inside the crate's own name, so "43-B" is true.
    expect(holdingsContradictRack('43-B', [crate('Gray #BIN on rack 43-B')])).toBe(false);
    // ...and a different rack in that suffix still refutes.
    expect(holdingsContradictRack('43-B', [crate('Gray #BIN on rack 41-C')])).toBe(true);
  });

  it('SHARPER THAN resolvePlacement: one holding, on a different rack, refutes', () => {
    // resolvePlacement lets a single RACK holding fall through on the
    // assumption that it and the label name the same shelf. A card holding the
    // holdings can check instead of assume.
    expect(holdingsContradictRack('39-B', [rack('5-A')])).toBe(true);
    expect(holdingsContradictRack('39-B', [rack('39-B')])).toBe(false);
  });

  it('ABSENCE OF EVIDENCE never refutes — a caller that fetched no holdings keeps its label', () => {
    expect(holdingsContradictRack('39-B', [])).toBe(false);
    expect(holdingsContradictRack('39-B', undefined)).toBe(false);
    expect(holdingsContradictRack('39-B', null)).toBe(false);
  });

  it('no label means nothing to refute', () => {
    expect(holdingsContradictRack(null, [crate('Gray #BIN')])).toBe(false);
    expect(holdingsContradictRack('   ', [crate('Gray #BIN')])).toBe(false);
  });

  it('tolerates the legacy rack SHAPE on either side (the 2026-07-23 incident)', () => {
    expect(holdingsContradictRack('22-B', [rack('22 - B')])).toBe(false);
    expect(holdingsContradictRack('22 - B', [rack('22-B')])).toBe(false);
    expect(holdingsContradictRack('22-b', [rack('22-B')])).toBe(false);
  });
});

describe('locationNameSitsOnRack — the one reader of the crate name suffix', () => {
  it('the location IS the rack', () => {
    expect(locationNameSitsOnRack('43-B', '43-B')).toBe(true);
    expect(locationNameSitsOnRack('43-C', '43-B')).toBe(false);
  });

  it('the location is a CRATE SITTING ON the rack', () => {
    expect(locationNameSitsOnRack('Gray #BIN on rack 43-B', '43-B')).toBe(true);
    expect(locationNameSitsOnRack('Blue #13 on rack 38-B', '38-B')).toBe(true);
    expect(locationNameSitsOnRack('Gray #BIN on rack 43-B', '43-C')).toBe(false);
  });

  it('a POSITION-LESS crate sits on no rack at all — the whole point of 0335', () => {
    expect(locationNameSitsOnRack('Gray #BIN', '43-B')).toBe(false);
    expect(locationNameSitsOnRack('Blue #Shelf', '38-A')).toBe(false);
  });

  it('reads the LAST suffix, so a crate number containing the words still resolves', () => {
    expect(locationNameSitsOnRack('Crate #on rack 9 on rack 43-B', '43-B')).toBe(true);
  });

  it('blank on either side is never a match', () => {
    expect(locationNameSitsOnRack('43-B', null)).toBe(false);
    expect(locationNameSitsOnRack(null, '43-B')).toBe(false);
    expect(locationNameSitsOnRack('  ', '43-B')).toBe(false);
  });
});
