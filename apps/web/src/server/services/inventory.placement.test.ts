import { describe, expect, it } from 'vitest';
import { derivePlacement } from './inventory';

describe('derivePlacement', () => {
  it('splits on-hand into placed + staged', () => {
    expect(derivePlacement(129, 90)).toEqual({
      staged_quantity: 90,
      unplaced_quantity: 0,
      placed_quantity: 39,
    });
  });
  it('clamps placed at 0 when staged exceeds on-hand (defensive)', () => {
    expect(derivePlacement(10, 15)).toEqual({
      staged_quantity: 15,
      unplaced_quantity: 0,
      placed_quantity: 0,
    });
  });
  it('treats missing staged as 0', () => {
    expect(derivePlacement(39, 0)).toEqual({
      staged_quantity: 0,
      unplaced_quantity: 0,
      placed_quantity: 39,
    });
  });
  it('subtracts unplaced from placed (stock sitting in the Unplaced bucket is NOT placed)', () => {
    // The Manchester-Chromebook case: 500 on hand, all in Unplaced → 0 placed.
    expect(derivePlacement(500, 0, 500)).toEqual({
      staged_quantity: 0,
      unplaced_quantity: 500,
      placed_quantity: 0,
    });
  });
  it('splits on-hand across placed + staged + unplaced simultaneously', () => {
    expect(derivePlacement(100, 30, 20)).toEqual({
      staged_quantity: 30,
      unplaced_quantity: 20,
      placed_quantity: 50,
    });
  });
  it('clamps placed at 0 when staged + unplaced exceed on-hand (defensive)', () => {
    expect(derivePlacement(10, 8, 5)).toEqual({
      staged_quantity: 8,
      unplaced_quantity: 5,
      placed_quantity: 0,
    });
  });
});
