import { describe, expect, it } from 'vitest';

import { isUuid } from './uuid';

/**
 * The shared uuid check (B63): a record id from a link, a query value or a
 * scanned code is checked against this before anything is read with it.
 * Any version and any case are accepted, as Postgres accepts them: the seed
 * and the fixtures use ids no RFC version allows.
 */
describe('isUuid', () => {
  it('accepts lower, upper and mixed case', () => {
    expect(isUuid('0a000000-0000-4000-8000-0000000000f1')).toBe(true);
    expect(isUuid('0A000000-0000-4000-8000-0000000000F1')).toBe(true);
    expect(isUuid('0a000000-0000-4000-8000-0000000000F1')).toBe(true);
  });

  it('accepts any version nibble, and the seed and fixture ids no version allows', () => {
    for (const version of ['0', '1', '4', '7', '9', 'f']) {
      expect(isUuid(`5eed0000-0000-${version}000-8000-000000000001`), version).toBe(true);
    }
    expect(isUuid('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuid('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
  });

  it('refuses text of the wrong length or shape', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    // 35 and 37 characters.
    expect(isUuid('00000000-0000-0000-0000-00000000001')).toBe(false);
    expect(isUuid('00000000-0000-0000-0000-0000000000011')).toBe(false);
    // 36 characters that are not a uuid: a misplaced hyphen, 36 hyphens,
    // 36 hex digits.
    expect(isUuid('0000-00000000-0000-0000-000000000000')).toBe(false);
    expect(isUuid('-'.repeat(36))).toBe(false);
    expect(isUuid('0'.repeat(36))).toBe(false);
    // 32 hex digits with no hyphens, braces, a urn prefix.
    expect(isUuid('00000000000000000000000000000001')).toBe(false);
    expect(isUuid('{00000000-0000-0000-0000-000000000001}')).toBe(false);
    expect(isUuid('urn:uuid:00000000-0000-0000-0000-000000000001')).toBe(false);
    // A letter that is not hex.
    expect(isUuid('g0000000-0000-0000-0000-000000000001')).toBe(false);
  });

  it('refuses a uuid with anything around it', () => {
    const id = '0a000000-0000-4000-8000-0000000000f1';
    expect(isUuid(` ${id}`)).toBe(false);
    expect(isUuid(`${id} `)).toBe(false);
    expect(isUuid(`${id}/`)).toBe(false);
    expect(isUuid(`${id}\n`)).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(['0a000000-0000-4000-8000-0000000000f1'])).toBe(false);
    expect(isUuid({ id: '0a000000-0000-4000-8000-0000000000f1' })).toBe(false);
  });
});
