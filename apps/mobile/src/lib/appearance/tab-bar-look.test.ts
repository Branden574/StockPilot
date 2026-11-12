import { describe, expect, it } from 'vitest';

import { AA_TEXT, contrast } from '../../components/ui/__fixtures__/contrast';
import { GLASS_TOKENS } from './glass-tokens.generated';
import type { GlassMaterial } from './material';
import { glassTabBarLook } from './tab-bar';
import { themeValueFor } from './theme-value';

/**
 * LG-1. Over the Scan camera the Liquid Glass tab capsule drew near-black in
 * Day (the system glass goes dark over dark content) while its icons and
 * labels kept the Day ink, #101412: 1.0:1, invisible (walk shots W8/00, 01,
 * 03, 04). Over the camera the bar now takes the Night look and, on the glass
 * material, the Night sheet fill inside the capsule, so the words read
 * whichever form the glass takes.
 */

/** 'rgba(r,g,b,a)' over an opaque '#rrggbb', as '#rrggbb'. */
function over(top: string, under: string): string {
  const m = /^rgba\(([^)]*)\)$/.exec(top.trim());
  if (!m) throw new Error(`not an rgba() colour: ${top}`);
  const [r, g, b, a] = m[1]!.split(',').map((x) => Number(x.trim())) as [
    number,
    number,
    number,
    number,
  ];
  const base = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  return `#${[r, g, b]
    .map((v, i) =>
      Math.round(v * a + base[i]! * (1 - a))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const theme = (mode: 'light' | 'dark', material: GlassMaterial = 'glass') =>
  themeValueFor('liquid-glass', mode, material, material !== 'opaque');

describe('the glass tab bar look', () => {
  it('away from the camera it is the theme, Day and Night, as walked', () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = theme(mode);
      expect(glassTabBarLook(t, false)).toEqual({
        scheme: mode,
        ink: t.c.ink,
        accentText: t.g!.accentText,
        accent: t.g!.accent,
        onAccent: t.g!.onAccent,
        cameraFill: null,
      });
    }
    expect(glassTabBarLook(theme('light'), false).ink).toBe(GLASS_TOKENS.day.ink);
  });

  it('over the camera in Day it is the Night look with the Night sheet fill', () => {
    expect(glassTabBarLook(theme('light'), true)).toEqual({
      scheme: 'dark',
      ink: GLASS_TOKENS.night.ink,
      accentText: GLASS_TOKENS.night.accentText,
      accent: GLASS_TOKENS.night.accent,
      onAccent: GLASS_TOKENS.night.onAccent,
      cameraFill: GLASS_TOKENS.night.glassStrong,
    });
  });

  it('over the camera in Night it keeps the Night look and gains the fill', () => {
    const look = glassTabBarLook(theme('dark'), true);
    expect(look.scheme).toBe('dark');
    expect(look.ink).toBe(GLASS_TOKENS.night.ink);
    expect(look.cameraFill).toBe(GLASS_TOKENS.night.glassStrong);
  });

  it('the words read at 4.5:1 on the fill over the darkest and the brightest ground', () => {
    const { ink, cameraFill } = glassTabBarLook(theme('light'), true);
    // A black viewfinder, and a camera pointed at a white sheet with the glass gone fully clear.
    for (const ground of ['#000000', '#ffffff']) {
      expect(contrast(ink, over(cameraFill!, ground)), ground).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // What Day drew before: its own ink on the capsule the walk measured, rgb(19,19,19).
    expect(contrast(GLASS_TOKENS.day.ink, '#131313')).toBeLessThan(1.1);
  });

  it('the solid and opaque bars need no fill: Night ink on the Night solid bar', () => {
    for (const material of ['blur', 'opaque'] as const) {
      const look = glassTabBarLook(theme('light', material), true);
      expect(look.scheme, material).toBe('dark');
      expect(look.cameraFill, material).toBeNull();
      expect(look.ink, material).toBe(
        material === 'opaque' ? GLASS_TOKENS.nightOpaque.ink : GLASS_TOKENS.night.ink,
      );
    }
  });
});
