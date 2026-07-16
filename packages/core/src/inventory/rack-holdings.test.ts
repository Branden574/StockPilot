import { describe, expect, it } from 'vitest';

import { formatRackHoldings, isSplitHoldings, type RackHoldingLike } from './rack-holdings';

describe('formatRackHoldings', () => {
  it('returns null for an empty list', () => {
    expect(formatRackHoldings([])).toBeNull();
  });

  it('formats a single holding as "name ×qty"', () => {
    expect(formatRackHoldings([{ name: '2-C', quantity: 20 }])).toBe('2-C ×20');
  });

  it('formats multiple holdings joined by " · ", sorted by name', () => {
    const holdings: RackHoldingLike[] = [
      { name: '5-A', quantity: 5 },
      { name: '2-C', quantity: 20 },
    ];
    expect(formatRackHoldings(holdings)).toBe('2-C ×20 · 5-A ×5');
  });

  it('sorts independent of input order (stable regardless of query order)', () => {
    const holdings: RackHoldingLike[] = [
      { name: 'Crate 9', quantity: 1 },
      { name: 'Crate 10', quantity: 2 },
      { name: 'Crate 2', quantity: 3 },
    ];
    // localeCompare, not numeric — matches the sort inventory-table already
    // applies to placed_racks, so the two surfaces never disagree on order.
    expect(formatRackHoldings(holdings)).toBe('Crate 10 ×2 · Crate 2 ×3 · Crate 9 ×1');
  });
});

describe('isSplitHoldings', () => {
  it('is false for zero holdings', () => {
    expect(isSplitHoldings([])).toBe(false);
  });

  it('is false for exactly one holding', () => {
    expect(isSplitHoldings([{ name: '2-C', quantity: 20 }])).toBe(false);
  });

  it('is true for more than one holding', () => {
    expect(
      isSplitHoldings([
        { name: '2-C', quantity: 20 },
        { name: '5-A', quantity: 5 },
      ]),
    ).toBe(true);
  });
});
