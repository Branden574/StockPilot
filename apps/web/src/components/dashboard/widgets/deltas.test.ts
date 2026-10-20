import { describe, expect, it } from 'vitest';

import { percentDelta, worseWhenUpDelta } from './deltas';

/**
 * The delta rules moved unchanged from the Overview page into one module that
 * the page (key stats) and the value card's island share. These pin them.
 */
describe('percentDelta (today against the first point)', () => {
  it('rounds to one decimal with a sign, up or down', () => {
    expect(percentDelta([100, 120, 104.2])).toEqual({ label: '+4.2%', direction: 'up' });
    expect(percentDelta([200, 150])).toEqual({ label: '-25.0%', direction: 'down' });
  });

  it('reads a near-zero start as "new", and two near-zero ends as flat', () => {
    expect(percentDelta([0.4, 500])).toEqual({ label: 'new', direction: 'up' });
    expect(percentDelta([0, 0.5])).toEqual({ label: '—', direction: 'flat' });
    expect(percentDelta([])).toEqual({ label: '—', direction: 'flat' });
  });

  it('calls a change under 0.05% flat', () => {
    expect(percentDelta([10_000, 10_004])).toEqual({ label: '—', direction: 'flat' });
  });

  it('caps a huge change at 999%+ in either direction', () => {
    expect(percentDelta([2, 500])).toEqual({ label: '+999%+', direction: 'up' });
    expect(percentDelta([2, -500])).toEqual({ label: '−999%+', direction: 'down' });
  });
});

describe('worseWhenUpDelta (low / out of stock: more is worse)', () => {
  it('prints the raw difference and inverts the direction', () => {
    expect(worseWhenUpDelta([3, 5, 8])).toEqual({ label: '+5', direction: 'down' });
    expect(worseWhenUpDelta([8, 2])).toEqual({ label: '-6', direction: 'up' });
    expect(worseWhenUpDelta([4, 4])).toEqual({ label: '—', direction: 'flat' });
  });
});
