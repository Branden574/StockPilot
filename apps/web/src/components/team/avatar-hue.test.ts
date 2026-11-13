// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AVATAR_HUES, avatarHue } from './avatar-hue';

describe('avatarHue', () => {
  it('gives the same member the same hue every time', () => {
    const id = '0b6f6f1e-7a1d-4d43-9a43-3c2f1b6a9e10';
    expect(avatarHue(id)).toBe(avatarHue(id));
  });

  it('stays within the six board hues', () => {
    for (let n = 0; n < 500; n += 1) {
      const hue = avatarHue(`member-${n}`);
      expect(hue).toBeGreaterThanOrEqual(1);
      expect(hue).toBeLessThanOrEqual(AVATAR_HUES);
    }
    expect(avatarHue('')).toBe(1);
  });

  it('spreads members over every hue', () => {
    const seen = new Set<number>();
    for (let n = 0; n < 60; n += 1)
      seen.add(avatarHue(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
