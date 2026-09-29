import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSource } from './__fixtures__/jsx-touch-audit';
import { orderItemsEyebrow } from './order-items-eyebrow';

/**
 * THE ORDER SCREEN'S ITEMS EYEBROW (walk P1, found in passing on the F2-3
 * walk, the same on main): a one-unit order said "ITEMS · 1 LINE · 1 UNITS".
 * The lines were already singular for one; the units now are too.
 */
describe('orderItemsEyebrow', () => {
  it('one line and one unit: both singular', () => {
    expect(orderItemsEyebrow(1, 1)).toBe('ITEMS · 1 LINE · 1 UNIT');
  });

  it('more than one: plural, as before', () => {
    expect(orderItemsEyebrow(2, 5)).toBe('ITEMS · 2 LINES · 5 UNITS');
    expect(orderItemsEyebrow(1, 12)).toBe('ITEMS · 1 LINE · 12 UNITS');
    expect(orderItemsEyebrow(3, 1)).toBe('ITEMS · 3 LINES · 1 UNIT');
  });

  it('none, or a part of a unit: plural, the number as it was', () => {
    expect(orderItemsEyebrow(0, 0)).toBe('ITEMS · 0 LINES · 0 UNITS');
    expect(orderItemsEyebrow(1, 1.5)).toBe('ITEMS · 1 LINE · 1.5 UNITS');
  });

  // Mutation caught: the screen keeping its own template string.
  it('the order screen uses it', () => {
    const screen = readSource(path.resolve(__dirname, '../../app/order/[id].tsx'));
    expect(screen).toMatch(
      /<Eyebrow>\{orderItemsEyebrow\(order\.lines\.length, totalRequested\)\}<\/Eyebrow>/,
    );
    expect(screen).not.toMatch(/\} UNITS`/);
  });
});
