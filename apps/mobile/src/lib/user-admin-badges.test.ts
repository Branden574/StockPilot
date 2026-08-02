import { describe, expect, it } from 'vitest';

import { shouldShowDisabledBadge } from './user-admin-badges';

describe('shouldShowDisabledBadge', () => {
  it('is true when the profile carries a disabled_at timestamp', () => {
    expect(
      shouldShowDisabledBadge({ disabled_at: '2026-07-30T12:00:00.000Z' }),
    ).toBe(true);
  });

  it('is false when disabled_at is null', () => {
    expect(shouldShowDisabledBadge({ disabled_at: null })).toBe(false);
  });

  it('is false when the profile itself is null or undefined (invited, no profile yet)', () => {
    expect(shouldShowDisabledBadge(null)).toBe(false);
    expect(shouldShowDisabledBadge(undefined)).toBe(false);
  });
});
