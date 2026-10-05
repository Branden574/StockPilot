import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bookDestination,
  fieldsFromDestination,
  type MoveDestination,
  type MoveHolding,
} from '../lib/move-stock-form';
import {
  destinationAllowedForSource,
  destinationKindsOrFilter,
  moveDestinationGroup,
  moveDestinationKinds,
  moveDestinationLabel,
  offeredDestinationOrder,
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

  // L121: stock waiting for put-away may also go back onto the warehouse's
  // Site; Unplaced stays withheld exactly as before.
  it('withholds Unplaced when the source pile is still waiting for put-away', () => {
    expect(moveDestinationKinds(STAGING, { fixedPutAway: false })).toEqual(['rack', 'crate', 'site']);
    expect(moveDestinationKinds(UNPLACED, { fixedPutAway: false })).toEqual(['rack', 'crate', 'site']);
  });

  it('withholds Unplaced in fixed put-away mode whatever the holding says', () => {
    expect(moveDestinationKinds(RACK, { fixedPutAway: true })).toEqual(['rack', 'crate', 'site']);
    expect(moveDestinationKinds(null, { fixedPutAway: true })).toEqual(['rack', 'crate', 'site']);
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
// L121 — PUT STAGED STOCK BACK ON A SITE.
//
// A cancelled pick restocks to Staging, and a warehouse whose stock sits on its
// Site (no racks) could not put it back from the phone: put-away offered racks
// and crates only. A Site has NO kind (kind NULL with a site-ish type; never
// backfill it), so the type decides: a NULL-kind row typed shelf/bin is a legacy
// placement, not a Site, and is not offered (it never was).
// ---------------------------------------------------------------------------

const SITE_DEST: MoveDestination = {
  id: 'site-mdc',
  name: 'Main Distribution Center',
  kind: null,
  type: 'warehouse',
  warehouseId: 'wh-1',
};
const ROOM_DEST: MoveDestination = { id: 'site-room', name: 'Back Room', kind: null, type: 'room', warehouseId: 'wh-1' };
const LEGACY_SHELF: MoveDestination = { id: 'shelf-3', name: 'Shelf 3', kind: null, type: 'shelf', warehouseId: 'wh-1' };

describe('the warehouse Site as a put-away destination (L121)', () => {
  it('classifies by kind first, then by type: a NULL-kind warehouse or room is a Site, a NULL-kind shelf is nothing offered', () => {
    expect(moveDestinationGroup(DESTS[0]!)).toBe('unplaced');
    expect(moveDestinationGroup(DESTS[1]!)).toBe('rack');
    expect(moveDestinationGroup(DESTS[2]!)).toBe('crate');
    expect(moveDestinationGroup(SITE_DEST)).toBe('site');
    expect(moveDestinationGroup(ROOM_DEST)).toBe('site');
    expect(moveDestinationGroup(LEGACY_SHELF)).toBeNull();
    expect(moveDestinationGroup({ kind: 'staging', type: 'warehouse' })).toBeNull();
    expect(moveDestinationGroup({ kind: 'area', type: null })).toBeNull();
  });

  it('put-away offers the Site beside racks and crates; never the legacy shelf', () => {
    const list = placementDestinationsForSource([...DESTS, SITE_DEST, ROOM_DEST, LEGACY_SHELF], STAGING, {
      fixedPutAway: true,
    });
    expect(list.map((d) => d.id)).toEqual(['rack-1', 'crate-1', 'site-mdc', 'site-room']);
  });

  it('free-form Move from a rack is NOT offered the Site (rack, crate, Unplaced, as before)', () => {
    const list = placementDestinationsForSource([...DESTS, SITE_DEST], RACK, { fixedPutAway: false });
    expect(list.map((d) => d.id)).toEqual(['unp-1', 'rack-1', 'crate-1']);
    expect(destinationAllowedForSource(SITE_DEST, RACK, { fixedPutAway: false })).toBe(false);
  });

  it('a Site pick left armed is dropped when the FROM chip moves to a rack', () => {
    expect(destinationAllowedForSource(SITE_DEST, STAGING, { fixedPutAway: false })).toBe(true);
    expect(destinationAllowedForSource(SITE_DEST, RACK, { fixedPutAway: false })).toBe(false);
  });

  it('the chip says a Site is one, so it never reads as a rack', () => {
    expect(moveDestinationLabel(SITE_DEST)).toBe('Main Distribution Center (site)');
    expect(moveDestinationLabel(ROOM_DEST)).toBe('Back Room (site)');
    expect(moveDestinationLabel(DESTS[1]!)).toBe('Rack 10-A');
    expect(moveDestinationLabel(DESTS[0]!)).toBe('Unplaced');
  });

  it('the destinations read asks for the NULL-kind rows a kind list can never return (pattern #23)', () => {
    expect(destinationKindsOrFilter(['rack', 'crate'])).toBe('kind.in.(rack,crate),kind.is.null');
    expect(destinationKindsOrFilter(['rack', 'crate', 'unplaced'])).toBe('kind.in.(rack,crate,unplaced),kind.is.null');
  });

  it('a BOOK tapping the Site chip blanks the four boxes and goes by id', () => {
    const fields = fieldsFromDestination(SITE_DEST);
    expect(fields).toEqual({ rackNumber: '', rackRow: '', crateColor: '', crateNumber: '' });
    expect(bookDestination(fields, SITE_DEST)).toEqual({ mode: 'existing', destination: SITE_DEST });
  });

  it('orders Unplaced first, then the Sites, then the racks and crates as read', () => {
    const ordered = offeredDestinationOrder([DESTS[1]!, LEGACY_SHELF, SITE_DEST, DESTS[2]!, DESTS[0]!, ROOM_DEST]);
    expect(ordered.map((d) => d.id)).toEqual(['unp-1', 'site-mdc', 'site-room', 'rack-1', 'crate-1']);
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

describe('move-stock-modal.tsx — L121 wiring (the Site)', () => {
  const at = modal.indexOf(".from('locations')");
  const destRead = modal.slice(at, modal.indexOf('setHoldings(hs);', at));

  it("reads the destinations with the NULL-kind rows and their type, never a bare .in('kind', …)", () => {
    expect(at, 'destinations read not found').toBeGreaterThan(-1);
    expect(destRead).toMatch(/\.or\(destinationKindsOrFilter\(destinationKinds\)\)/);
    expect(destRead).not.toMatch(/\.in\('kind'/);
    expect(destRead).toMatch(/\.select\('id, name, kind, type, warehouse_id/);
  });

  it('keeps only rows the shared classifier offers, in the shared order (offeredDestinationOrder does both)', () => {
    expect(destRead).toMatch(/ds = offeredDestinationOrder\(/);
    // The hand-rolled "Unplaced first" split it replaces is gone.
    expect(destRead).not.toMatch(/ds\.filter\(\(d\) => d\.kind === 'unplaced'\)/);
  });

  it('labels every destination chip through moveDestinationLabel', () => {
    const start = modal.indexOf('{destChoices.map((d) => (');
    expect(start, 'destination chips not found').toBeGreaterThan(-1);
    const chips = modal.slice(start, modal.indexOf('+ New rack…', start));
    expect(chips).toMatch(/label=\{moveDestinationLabel\(d\)\}/);
  });

  it('the heading names the Site when one is on screen', () => {
    expect(modal).toMatch(/const offersSite = destChoices\.some\(\(d\) => moveDestinationGroup\(d\) === 'site'\)/);
    expect(modal).toContain('TO RACK, CRATE, OR SITE');
  });
});
