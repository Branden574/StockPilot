import { describe, expect, it } from 'vitest';

import {
  CYCLE_COUNT_LOADING_COPY,
  cycleCountHeaderView,
  cycleCountIsOpen,
} from './cycle-count-header';

/**
 * The count screen's header before the count is known (simulator walk
 * 2026-09-27). Opening a POSTED count from the verification card's headline
 * first showed "Cycle count / Reference unavailable / No single warehouse ·
 * 0/0 counted" with a Reassign button for 1 to 2 seconds, then CC-000001
 * with 4/4 counted: unknown facts shown as if they were true, and an open
 * count's action on a closed one. Until the count is known the header says
 * it is loading, states nothing about the count, and offers nothing that
 * only an open count has.
 */

const header = (o: Partial<Parameters<typeof cycleCountHeaderView>[0] & object> = {}) => ({
  countNumber: 1,
  warehouseId: 'wh-1',
  warehouseName: 'QA Main DC',
  status: 'completed',
  ...o,
});

describe('cycleCountHeaderView', () => {
  it('while the count is loading: says so and states no facts about it', () => {
    const v = cycleCountHeaderView(null, {
      loading: true,
      scope: null,
      countedCount: 0,
      lineTotal: 0,
    });
    expect(v).toEqual({ kind: 'loading', text: CYCLE_COUNT_LOADING_COPY });
    expect(CYCLE_COUNT_LOADING_COPY).toBe('Loading this count...');
    expect(JSON.stringify(v)).not.toMatch(/Reference unavailable|No single warehouse|counted/);
  });

  it('a read that ended with no count: still no made-up facts', () => {
    expect(
      cycleCountHeaderView(null, { loading: false, scope: null, countedCount: 0, lineTotal: 0 }),
    ).toEqual({ kind: 'unknown' });
  });

  it('a known count: its reference, place and progress, as before', () => {
    expect(
      cycleCountHeaderView(header(), {
        loading: false,
        scope: 'warehouse',
        countedCount: 4,
        lineTotal: 4,
      }),
    ).toEqual({
      kind: 'known',
      reference: 'CC-000001',
      place: 'QA Main DC',
      progress: '4/4 counted',
    });
    // From the phone's cache before the scope is read: the header's own place.
    expect(
      cycleCountHeaderView(header({ warehouseId: null, warehouseName: null, countNumber: null }), {
        loading: true,
        scope: null,
        countedCount: 0,
        lineTotal: 3,
      }),
    ).toEqual({
      kind: 'known',
      reference: null,
      place: 'No single warehouse',
      progress: '0/3 counted',
    });
    expect(
      cycleCountHeaderView(header({ warehouseId: null, warehouseName: null }), {
        loading: false,
        scope: 'selection',
        countedCount: 1,
        lineTotal: 2,
      }),
    ).toMatchObject({ place: 'Selected items' });
  });
});

describe('cycleCountIsOpen', () => {
  it('only a count known to be in progress is open; a count still loading is not', () => {
    expect(cycleCountIsOpen(null)).toBe(false);
    expect(cycleCountIsOpen(header({ status: 'in_progress' }))).toBe(true);
    expect(cycleCountIsOpen(header({ status: 'completed' }))).toBe(false);
    expect(cycleCountIsOpen(header({ status: 'canceled' }))).toBe(false);
  });
});
