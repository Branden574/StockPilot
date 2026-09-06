import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MoveDestination, MoveHolding } from '../lib/move-stock-form';
import {
  destinationAllowedForSource,
  moveDestinationKinds,
  placementDestinationsForSource,
} from './move-stock-destinations';

/**
 * SP-053. Free-form Move on the item screen listed EVERY holding as a source —
 * including the Staging and Unplaced buckets — while still offering the
 * per-warehouse Unplaced bucket as a DESTINATION. So "Staging · 40" → "Unplaced"
 * was a tap away on the phone: the receipt loses its "Received (staged)"
 * reading and lands in a bucket with no bin label, having been shelved nowhere.
 * Web cannot express that move at all (StockTransferDialog drops staging and
 * unplaced holdings from its source list entirely).
 *
 * The rule these pin: stock that is WAITING FOR PUT-AWAY (staging or unplaced)
 * goes onto a rack or a crate. Unplaced is a destination only for stock that is
 * already ON a placement — the 2026-07-23 rack 100-A repair path, which is the
 * reason Unplaced is offered at all and must keep working.
 */

const RACK: MoveHolding = {
  locationId: 'rack-1',
  name: 'Rack 10-A',
  kind: 'rack',
  quantity: 12,
  warehouseId: 'wh-1',
};
const STAGING: MoveHolding = {
  locationId: 'stg-1',
  name: 'Staging',
  kind: 'staging',
  quantity: 40,
  warehouseId: 'wh-1',
};
const UNPLACED: MoveHolding = {
  locationId: 'unp-1',
  name: 'Unplaced',
  kind: 'unplaced',
  quantity: 7,
  warehouseId: 'wh-1',
};

const DESTS: MoveDestination[] = [
  { id: 'unp-1', name: 'Unplaced', kind: 'unplaced', warehouseId: 'wh-1' },
  { id: 'rack-1', name: 'Rack 10-A', kind: 'rack', warehouseId: 'wh-1' },
  { id: 'crate-1', name: 'Crate Gray 6', kind: 'crate', warehouseId: 'wh-1' },
];

describe('moveDestinationKinds', () => {
  it('offers Unplaced when the source is a placement (the rack 100-A repair path)', () => {
    expect(moveDestinationKinds(RACK, { fixedPutAway: false })).toEqual([
      'rack',
      'crate',
      'unplaced',
    ]);
    expect(
      moveDestinationKinds({ ...RACK, kind: 'crate' }, { fixedPutAway: false }),
    ).toContain('unplaced');
  });

  it('withholds Unplaced when the source pile is still waiting for put-away', () => {
    expect(moveDestinationKinds(STAGING, { fixedPutAway: false })).toEqual(['rack', 'crate']);
    expect(moveDestinationKinds(UNPLACED, { fixedPutAway: false })).toEqual(['rack', 'crate']);
  });

  it('withholds Unplaced in fixed put-away mode whatever the holding says', () => {
    expect(moveDestinationKinds(RACK, { fixedPutAway: true })).toEqual(['rack', 'crate']);
    expect(moveDestinationKinds(null, { fixedPutAway: true })).toEqual(['rack', 'crate']);
  });

  it('is permissive before a source is chosen — the FROM chip decides, not the empty state', () => {
    expect(moveDestinationKinds(null, { fixedPutAway: false })).toContain('unplaced');
  });
});

describe('placementDestinationsForSource', () => {
  it('drops the Unplaced chip for a Staging source but keeps racks and crates', () => {
    const list = placementDestinationsForSource(DESTS, STAGING, { fixedPutAway: false });
    expect(list.map((d) => d.id)).toEqual(['rack-1', 'crate-1']);
  });

  it('drops the Unplaced chip for an Unplaced source (no self-move, no relabelling)', () => {
    const list = placementDestinationsForSource(DESTS, UNPLACED, { fixedPutAway: false });
    expect(list.some((d) => d.kind === 'unplaced')).toBe(false);
  });

  it('keeps the Unplaced chip for a rack source', () => {
    const list = placementDestinationsForSource(DESTS, RACK, { fixedPutAway: false });
    expect(list.map((d) => d.id)).toEqual(['unp-1', 'rack-1', 'crate-1']);
  });
});

describe('destinationAllowedForSource', () => {
  it('answers false for a stale Unplaced pick after the source flips to Staging', () => {
    expect(destinationAllowedForSource(DESTS[0], STAGING, { fixedPutAway: false })).toBe(false);
    expect(destinationAllowedForSource(DESTS[0], RACK, { fixedPutAway: false })).toBe(true);
  });

  it('never objects to a rack or crate', () => {
    expect(destinationAllowedForSource(DESTS[1], STAGING, { fixedPutAway: false })).toBe(true);
    expect(destinationAllowedForSource(DESTS[2], UNPLACED, { fixedPutAway: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WIRING PIN. The helper above is only worth anything if the sheet actually
// asks it. move-stock-modal.tsx is a .tsx under src/components/ that imports
// react-native and expo at module scope, so the mobile vitest config (node
// env, `src/**/*.test.ts`) cannot render it — read the real source and assert
// the property instead, the same idiom as bundle-distribute-wiring.test.ts.
// ---------------------------------------------------------------------------

const modal = readFileSync(path.join(__dirname, 'move-stock-modal.tsx'), 'utf8');

describe('move-stock-modal.tsx — SP-053 wiring', () => {
  it('routes the rendered destination chips through placementDestinationsForSource', () => {
    expect(modal).toMatch(/placementDestinationsForSource\(/);
    // The chips the user can tap are destChoices; the filter must sit on the
    // list that is RENDERED, not on some earlier copy.
    const at = modal.indexOf('const destChoices');
    expect(at, 'destChoices not found').toBeGreaterThan(-1);
    const decl = modal.slice(at, modal.indexOf(';\n', modal.indexOf('});', at)));
    expect(decl).toMatch(/placementDestinationsForSource/);
  });

  it('clears a stale destination when the FROM chip moves to a put-away pile', () => {
    const at = modal.indexOf('setChosenFromId(h.locationId)');
    expect(at, 'FROM chip handler not found').toBeGreaterThan(-1);
    const handler = modal.slice(at, at + 1800);
    expect(handler).toMatch(/destinationAllowedForSource/);
    expect(handler).toMatch(/setToId\(''\)/);
  });
});
