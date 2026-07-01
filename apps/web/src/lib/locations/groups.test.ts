import { describe, expect, it } from 'vitest';

import {
  isRackShelfLocation,
  isSiteLocation,
  isSystemLocation,
  locationGroup,
} from './groups';

// Rows mirror the real data shapes seen in prod:
//   DC4 = {type:'warehouse', kind:null}; a room = {type:'room', kind:null};
//   racks = {type:'shelf', kind:'rack'} or {type:'shelf', kind:null};
//   a bin = {type:'bin', kind:null}; Staging/Unplaced = {type:'other', kind:...}.
const WAREHOUSE = { type: 'warehouse', kind: null };
const ROOM = { type: 'room', kind: null };
const VEHICLE = { type: 'vehicle', kind: null };
const JOBSITE = { type: 'jobsite', kind: null };
const RACK = { type: 'shelf', kind: 'rack' };
const SHELF = { type: 'shelf', kind: null };
const BIN = { type: 'bin', kind: null };
const CRATE = { type: 'other', kind: 'crate' };
const AREA = { type: 'other', kind: 'area' };
const STAGING = { type: 'other', kind: 'staging' };
const UNPLACED = { type: 'other', kind: 'unplaced' };

describe('location groups', () => {
  it('classifies sites (pickable stocking locations)', () => {
    for (const site of [WAREHOUSE, ROOM, VEHICLE, JOBSITE]) {
      expect(isSiteLocation(site)).toBe(true);
      expect(locationGroup(site)).toBe('site');
      expect(isRackShelfLocation(site)).toBe(false);
      expect(isSystemLocation(site)).toBe(false);
    }
  });

  it('classifies racks/shelves/bins/crates/areas as rack-shelf, NOT sites', () => {
    for (const placement of [RACK, SHELF, BIN, CRATE, AREA]) {
      expect(isSiteLocation(placement)).toBe(false);
      expect(isRackShelfLocation(placement)).toBe(true);
      expect(locationGroup(placement)).toBe('rack-shelf');
    }
  });

  it('classifies staging/unplaced as system, never a site or rack', () => {
    for (const sys of [STAGING, UNPLACED]) {
      expect(isSystemLocation(sys)).toBe(true);
      expect(isSiteLocation(sys)).toBe(false);
      expect(isRackShelfLocation(sys)).toBe(false);
      expect(locationGroup(sys)).toBe('system');
    }
  });

  it('the three groups partition every row (site is the catch-all)', () => {
    const rows = [WAREHOUSE, ROOM, VEHICLE, JOBSITE, RACK, SHELF, BIN, CRATE, AREA, STAGING, UNPLACED, { type: null, kind: null }, { type: 'other', kind: null }];
    for (const r of rows) {
      const groups = [isSiteLocation(r), isRackShelfLocation(r), isSystemLocation(r)].filter(Boolean);
      expect(groups).toHaveLength(1); // exactly one group
    }
    // a stray/unknown non-placement, non-system row falls into 'site'
    expect(locationGroup({ type: null, kind: null })).toBe('site');
    expect(locationGroup({ type: 'other', kind: null })).toBe('site');
  });
});
