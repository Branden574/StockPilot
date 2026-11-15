import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { boundedRecord } from './bounded-record';
import { formatLimit, maxChoices } from './request-limits';

/**
 * Security invariant: a keyed object in a request has an upper bound on its
 * keys, and one over it is refused before any key or value is validated.
 */

const ID_A = '0d4b8a52-6f1e-4c3a-9b7d-2e5f8a1c3d4e';
const ID_B = '7a9c1e3f-5b2d-4e6a-8c0f-1d3b5e7a9c2f';

describe('boundedRecord', () => {
  it('parses a keyed object within its bound like z.record', () => {
    const schema = boundedRecord(z.string().uuid(), z.string().trim().min(1), 2);
    expect(schema.parse({ [ID_A]: '  Red  ', [ID_B]: 'Blue' })).toEqual({
      [ID_A]: 'Red',
      [ID_B]: 'Blue',
    });
  });

  it('reports a bad key or value within the bound as z.record does', () => {
    const schema = boundedRecord(z.string().uuid(), z.enum(['all', 'none']), 5);
    const result = schema.safeParse({ 'not-an-id': 'all', [ID_A]: 'some' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(2);
  });

  it('refuses more keys than its bound with one issue, before validating any', () => {
    let checked = 0;
    const value = z.string().refine(() => {
      checked += 1;
      return false;
    });
    const schema = boundedRecord(z.string().uuid(), value, 3, 'Too many entries.');
    const input = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, 1]));

    const result = schema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({ code: 'custom', message: 'Too many entries.' });
    expect(checked).toBe(0);
  });

  it('has a plain default message', () => {
    const result = boundedRecord(z.string(), z.string(), 1).safeParse({ a: 'x', b: 'y' });
    expect(result.error?.issues[0]?.message).toBe('Send at most 1 entry.');
  });

  it('leaves a value that is not an object to z.record', () => {
    const result = boundedRecord(z.string(), z.string(), 1).safeParse('text');
    expect(result.error?.issues[0]?.code).toBe('invalid_type');
  });

  it('chains like any schema and keeps the record types', () => {
    const schema = z.object({
      names: boundedRecord(z.string(), z.string(), 10).optional(),
    });
    expect(schema.parse({})).toEqual({});
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<{
      names?: Record<string, string> | undefined;
    }>();
    expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<{
      names?: Record<string, string> | undefined;
    }>();
  });
});

describe('request limit helpers', () => {
  it('formats a limit for a message without Intl', () => {
    expect(formatLimit(1)).toBe('1');
    expect(formatLimit(500)).toBe('500');
    expect(formatLimit(10_000)).toBe('10,000');
    expect(formatLimit(100_000)).toBe('100,000');
  });

  it('allows ten times the size of a fixed set of choices', () => {
    expect(maxChoices(['a', 'b', 'c'])).toBe(30);
  });
});
