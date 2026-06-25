import { describe, expect, it } from 'vitest';
import { derivePlacement } from './inventory';

describe('derivePlacement', () => {
  it('splits on-hand into placed + staged', () => {
    expect(derivePlacement(129, 90)).toEqual({ staged_quantity: 90, placed_quantity: 39 });
  });
  it('clamps placed at 0 when staged exceeds on-hand (defensive)', () => {
    expect(derivePlacement(10, 15)).toEqual({ staged_quantity: 15, placed_quantity: 0 });
  });
  it('treats missing staged as 0', () => {
    expect(derivePlacement(39, 0)).toEqual({ staged_quantity: 0, placed_quantity: 39 });
  });
});
