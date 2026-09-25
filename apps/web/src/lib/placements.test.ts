import { describe, expect, it } from 'vitest';

import {
  ELSEWHERE_PLACEMENT_KIND,
  elsewhereSuffix,
  isWritableDestination,
  placementSummary,
} from './placements';

// Stock in warehouses the viewer cannot see (0371): the pure pieces the item
// page, the lists and the transfer dialog share.

describe('placementSummary — the item page line', () => {
  const chrome = {
    status: 'some' as const,
    staged: 5,
    unplaced: 0,
    placed: 7,
    placedLocationIds: ['rack-annex'],
  };

  it("QA-CHROME, literally: '0 placed + 20 awaiting + 12 in other warehouses = 32'", () => {
    // get() folded the hidden buckets in: staged 5 (all hidden), unplaced 20.
    expect(
      placementSummary({ onHand: 32, stagedAll: 5, unplacedAll: 20, elsewhere: chrome }),
    ).toEqual({ kind: 'line', placed: 0, awaiting: 20, elsewhere: 12, onHand: 32 });
  });

  it('the terms always add up to on hand', () => {
    const line = placementSummary({ onHand: 50, stagedAll: 5, unplacedAll: 20, elsewhere: chrome });
    expect(line).toEqual({ kind: 'line', placed: 18, awaiting: 20, elsewhere: 12, onHand: 50 });
    if (line.kind === 'line') expect(line.placed + line.awaiting + line.elsewhere).toBe(line.onHand);
  });

  it('a line for stock elsewhere even when nothing here awaits put-away', () => {
    expect(
      placementSummary({
        onHand: 17,
        stagedAll: 0,
        unplacedAll: 0,
        elsewhere: { ...chrome, staged: 0, placed: 7 },
      }),
    ).toEqual({ kind: 'line', placed: 10, awaiting: 0, elsewhere: 7, onHand: 17 });
  });

  it('unchanged for a manager (nothing elsewhere): placed + awaiting = on hand', () => {
    expect(
      placementSummary({ onHand: 600, stagedAll: 100, unplacedAll: 0, elsewhere: { status: 'none' } }),
    ).toEqual({ kind: 'line', placed: 500, awaiting: 100, elsewhere: 0, onHand: 600 });
    expect(
      placementSummary({ onHand: 600, stagedAll: 0, unplacedAll: 0, elsewhere: undefined }),
    ).toEqual({ kind: 'none' });
  });

  it('UNAVAILABLE is never a sum: the page says it could not load the rest', () => {
    const res = placementSummary({
      onHand: 32,
      stagedAll: 0,
      unplacedAll: 20,
      elsewhere: { status: 'unavailable' },
    });
    expect(res.kind).toBe('unavailable');
    expect(res.kind === 'unavailable' && res.note).toMatch(/could not load stock in other warehouses/i);
  });
});

describe('elsewhereSuffix — the rack column', () => {
  it('+N in other warehouses, only when there is some', () => {
    expect(elsewhereSuffix({ elsewhere_quantity: 12 })).toBe('+12 in other warehouses');
    expect(elsewhereSuffix({ elsewhere_quantity: 0 })).toBeNull();
    expect(elsewhereSuffix({})).toBeNull();
  });

  it('the placement-row kind is its own word, never a location kind', () => {
    expect(['rack', 'crate', 'staging', 'unplaced', 'site', 'location']).not.toContain(
      ELSEWHERE_PLACEMENT_KIND,
    );
  });
});

describe('isWritableDestination — owner decision Q4', () => {
  it('unrestricted when there is no list (managers, all-warehouse members)', () => {
    expect(isWritableDestination({ warehouse_id: 'wh-annex' }, null)).toBe(true);
    expect(isWritableDestination({ warehouse_id: 'wh-annex' }, undefined)).toBe(true);
  });

  it('a scoped member: their warehouses and locations with no warehouse only', () => {
    const writable = ['wh-main'];
    expect(isWritableDestination({ warehouse_id: 'wh-main' }, writable)).toBe(true);
    expect(isWritableDestination({ warehouse_id: null }, writable)).toBe(true);
    expect(isWritableDestination({ warehouse_id: 'wh-annex' }, writable)).toBe(false);
  });

  it('an empty list (access unreadable) leaves only locations with no warehouse', () => {
    expect(isWritableDestination({ warehouse_id: 'wh-main' }, [])).toBe(false);
    expect(isWritableDestination({ warehouse_id: null }, [])).toBe(true);
  });
});
