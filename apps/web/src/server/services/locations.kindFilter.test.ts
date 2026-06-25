import { describe, expect, it } from 'vitest';
import { isUserFacingLocation } from './locations';

describe('isUserFacingLocation', () => {
  it('excludes staging and unplaced', () => {
    expect(isUserFacingLocation({ kind: 'staging' })).toBe(false);
    expect(isUserFacingLocation({ kind: 'unplaced' })).toBe(false);
  });
  it('keeps rack/crate/bin/null-kind', () => {
    for (const kind of ['rack', 'crate', 'bin', null]) {
      expect(isUserFacingLocation({ kind })).toBe(true);
    }
  });
});
