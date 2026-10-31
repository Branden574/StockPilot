// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { hasArrayLongerThan } from './oversized-array';

describe('hasArrayLongerThan', () => {
  it('CONTROL: zod 3 still parses every element of an over-long array', () => {
    // Why the public routes call hasArrayLongerThan before safeParse
    // (GHSA-mrhx-c7xc-m3w5): `.max(100)` adds its too_big issue and then
    // zod checks all 1,000 elements anyway, one invalid_type issue each.
    // When this fails, zod stopped doing it and the stopgap can be reviewed.
    const result = z.array(z.string()).max(100).safeParse(new Array(1000).fill(0));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('too_big');
    expect(result.error?.issues).toHaveLength(1001);
  });

  it('passes an array at the limit and refuses one past it', () => {
    expect(hasArrayLongerThan(new Array(100).fill(0), 100)).toBe(false);
    expect(hasArrayLongerThan(new Array(101).fill(0), 100)).toBe(true);
  });

  it('finds an oversized array inside an object, at any depth', () => {
    expect(hasArrayLongerThan({ lines: new Array(101).fill({}) }, 100)).toBe(true);
    expect(hasArrayLongerThan({ a: { b: { c: new Array(101).fill(1) } } }, 100)).toBe(true);
  });

  it('finds an oversized array nested inside an element of an allowed array', () => {
    const lines = [
      { itemId: 'x', quantity: 1 },
      { itemId: 'y', notes: new Array(101).fill('n') },
    ];
    expect(hasArrayLongerThan({ lines }, 100)).toBe(true);
    expect(
      hasArrayLongerThan({ lines: [{ exchange: { note: new Array(101).fill('n') } }] }, 100),
    ).toBe(true);
    expect(hasArrayLongerThan([[new Array(101).fill(0)]], 100)).toBe(true);
  });

  it('passes a normal body, primitives and null', () => {
    const body = {
      token: 't',
      lines: [
        { itemId: 'a', quantity: 2, notes: null },
        { itemId: 'b', quantity: 1, exchange: { itemId: 'c', note: 'L please' } },
      ],
    };
    expect(hasArrayLongerThan(body, 100)).toBe(false);
    for (const v of [null, undefined, 0, 'x'.repeat(1000), true]) {
      expect(hasArrayLongerThan(v, 100)).toBe(false);
    }
  });

  it('refuses an oversized array without visiting any of its elements', () => {
    // An element read would throw: the length check has to come first.
    const trap = new Array(101).fill(0);
    Object.defineProperty(trap, 0, {
      get() {
        throw new Error('element visited');
      },
    });
    expect(hasArrayLongerThan({ lines: trap }, 100)).toBe(true);
  });

  it('walks a deeply nested body without overflowing the call stack', () => {
    // 100,000 levels, built the way JSON.parse would decode them.
    const deep = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`) as unknown;
    expect(hasArrayLongerThan(deep, 100)).toBe(false);
    const deepObject = JSON.parse(
      `${'{"a":'.repeat(100_000)}[${'0,'.repeat(100)}0]${'}'.repeat(100_000)}`,
    ) as unknown;
    expect(hasArrayLongerThan(deepObject, 100)).toBe(true);
  });
});
