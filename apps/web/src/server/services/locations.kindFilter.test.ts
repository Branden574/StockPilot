import { describe, expect, it } from 'vitest';

import { isSiteLocation } from '@/lib/locations/groups';

import { isUserFacingLocation } from './locations';

describe('isUserFacingLocation', () => {
  it('excludes staging and unplaced', () => {
    expect(isUserFacingLocation({ kind: 'staging' })).toBe(false);
    expect(isUserFacingLocation({ kind: 'unplaced' })).toBe(false);
  });
  it('keeps rack/crate/bin/null-kind', () => {
    for (const kind of ['rack', 'crate', 'bin', null]) {
      expect(isUserFacingLocation({ kind })).toBe(true);
    }
  });
});

// The picker regression: `list({ excludeSystem })` (isUserFacingLocation) only
// drops staging/unplaced, so racks/shelves leaked into location pickers. The
// pickers now use `list({ sitesOnly })` (isSiteLocation), which is strictly
// tighter — a real site, never a placement.
describe('sitesOnly is stricter than excludeSystem', () => {
  it('drops racks/shelves that excludeSystem wrongly kept', () => {
    const rack = { type: 'shelf', kind: 'rack' };
    expect(isUserFacingLocation(rack)).toBe(true); // old picker filter → rack leaked (the bug)
    expect(isSiteLocation(rack)).toBe(false); // new picker filter → rack excluded
  });
  it('keeps real sites (warehouse/room/vehicle/job site)', () => {
    for (const type of ['warehouse', 'room', 'vehicle', 'jobsite']) {
      expect(isSiteLocation({ type, kind: null })).toBe(true);
    }
  });
});
