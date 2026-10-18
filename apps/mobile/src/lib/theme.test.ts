import { describe, expect, it } from 'vitest';

import { TYPE_CEILING, capTo, resolveFontCap } from './theme';

/**
 * Dynamic Type policy primitives. These two functions decide how far every
 * piece of chrome in the app is allowed to grow, so they are the one part of
 * the Dynamic Type work that is pure enough to pin with unit tests (the rest
 * is component layout, verified by typecheck + the simulator pass).
 */
describe('capTo', () => {
  it('turns a point ceiling into the multiplier that lands exactly on it', () => {
    // The whole justification for a ceiling over a flat multiplier: a 34pt
    // title and an 11pt eyebrow need very different multipliers to end up in
    // the same physical space.
    expect(capTo(34, 48)).toBeCloseTo(1.4118, 4); // page-title convention
    expect(capTo(18, 48)).toBeCloseTo(2.6667, 4); // smallest Display call site
    expect(capTo(40, 48)).toBeCloseTo(1.2, 4); // largest Display call site
    expect(capTo(11, 16)).toBeCloseTo(1.4545, 4); // eyebrow
    expect(capTo(13, 22)).toBeCloseTo(1.6923, 4); // small button label
  });

  it('resolves each named ceiling against its real base size', () => {
    expect(capTo(11, TYPE_CEILING.eyebrow)).toBeCloseTo(16 / 11, 6);
    expect(capTo(13, TYPE_CEILING.control)).toBeCloseTo(22 / 13, 6);
    expect(capTo(15.5, TYPE_CEILING.control)).toBeCloseTo(22 / 15.5, 6);
    expect(capTo(16, TYPE_CEILING.input)).toBeCloseTo(24 / 16, 6);
    expect(capTo(10.5, TYPE_CEILING.chrome)).toBeCloseTo(20 / 10.5, 6);
    expect(capTo(34, TYPE_CEILING.display)).toBeCloseTo(48 / 34, 6);
  });

  it('never returns below 1 — a cap may limit growth, never shrink text', () => {
    // 56pt item-detail hero and the 48pt ceiling itself both already sit at or
    // past the ceiling; they must render at 1x, not at 0.86x.
    expect(capTo(56, TYPE_CEILING.display)).toBe(1);
    expect(capTo(48, TYPE_CEILING.display)).toBe(1);
    expect(capTo(100, TYPE_CEILING.chrome)).toBe(1);

    for (let size = 1; size <= 120; size += 0.5) {
      for (const ceiling of Object.values(TYPE_CEILING)) {
        expect(capTo(size, ceiling)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps every ceiling above the default body size so nothing shrinks by default', () => {
    for (const ceiling of Object.values(TYPE_CEILING)) {
      expect(ceiling).toBeGreaterThan(14.5);
    }
  });
});

/**
 * The `label` ceiling is the one entry in the table that exists for a purely
 * accessibility reason rather than a layout one, so its relationships to the
 * other ceilings are worth pinning: a later "tidy up, these two are the same
 * 11pt line" edit is exactly how the regression comes back.
 */
describe('TYPE_CEILING.label — form field labels', () => {
  it('is more generous than the section-header ceiling', () => {
    // Same 11pt tracked uppercase mono line, different job. A section eyebrow
    // is a landmark you read once; a field label is the only thing naming the
    // box being typed into.
    expect(TYPE_CEILING.label).toBeGreaterThan(TYPE_CEILING.eyebrow);
  });

  it('is never below the ceiling on the input it names', () => {
    // Otherwise the label is guaranteed to be the smaller of the pair at every
    // accessibility size — the defect this entry was added to fix.
    expect(TYPE_CEILING.label).toBeGreaterThanOrEqual(TYPE_CEILING.input);
  });

  it('lands an 11pt label on its ceiling, well past the eyebrow multiplier', () => {
    expect(capTo(11, TYPE_CEILING.label)).toBeCloseTo(28 / 11, 6);
    expect(capTo(11, TYPE_CEILING.label)).toBeGreaterThan(capTo(11, TYPE_CEILING.eyebrow));
  });

  it('keeps the longest real field label on one line of the form column', () => {
    // "PRIMARY LOCATION" is the longest label on Add Item; Eyebrow prefixes
    // "— ", so 18 JetBrains Mono characters at 0.6em advance plus 1.98pt of
    // tracking (letterSpacing is applied in UNSCALED points and does not grow
    // with fontScale). The form column is 402pt of screen less 20pt gutters.
    const width = (chars: number, size: number) => chars * (size * 0.6 + 11 * 0.18);
    expect(width(18, TYPE_CEILING.label)).toBeLessThanOrEqual(362);
    // And it is genuinely the largest ceiling that does: one point more and
    // the same label no longer fits.
    expect(width(18, TYPE_CEILING.label + 3)).toBeGreaterThan(362);
  });

  it('holds a field label above half the height of its uncapped 15pt input at AX5', () => {
    // Add-Item inputs are 15pt and stay uncapped by design (plan §3). At the
    // old eyebrow ceiling the label was 30% of its own input at AX5.
    const AX5 = 3.57;
    const inputPt = 15 * AX5;
    expect(TYPE_CEILING.eyebrow / inputPt).toBeLessThan(0.35); // the defect
    expect(TYPE_CEILING.label / inputPt).toBeGreaterThan(0.5); // the fix
  });
});

describe('resolveFontCap', () => {
  it('applies the policy default when a call site says nothing', () => {
    expect(resolveFontCap(undefined, 1.45)).toBe(1.45);
  });

  it('lets a call site tighten the cap', () => {
    expect(resolveFontCap(1.2, 1.45)).toBe(1.2);
  });

  it('lets a call site loosen the cap', () => {
    expect(resolveFontCap(3, 1.45)).toBe(3);
  });

  it('passes RN\'s 0 "no limit" sentinel through instead of re-applying the default', () => {
    // This is the whole reason the helper exists: `n || fallback` and
    // `Number(n) ? n : fallback` both silently swallow 0 and re-clamp the
    // text the call site just opted out of clamping.
    expect(resolveFontCap(0, 1.45)).toBe(0);
  });

  it("passes RN's null \"inherit from parent\" sentinel through as well", () => {
    // `explicit ?? policyDefault` would swallow this one.
    expect(resolveFontCap(null, 1.45)).toBeNull();
  });

  it('returns undefined for the uncapped primitives (Body, Mono)', () => {
    expect(resolveFontCap(undefined, undefined)).toBeUndefined();
    expect(resolveFontCap(0, undefined)).toBe(0);
    expect(resolveFontCap(2, undefined)).toBe(2);
  });
});

// PO-4 review: ink4 (about 3.3:1 on paper), ACCENT.warn (about 3.4:1 on
// paper) and ACCENT.crit in dark mode (about 3.1:1) fall short of WCAG AA's
// 4.5:1 for small text, and the storefront put its stock, honesty and refusal
// words in them. The text tokens below are measured here on every surface the
// storefront draws text on.
describe('text colours meet WCAG AA (4.5:1) on every surface, in both modes (PO-4 review)', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  it('warnText, critText and ink3 on paper, paper2 and card', async () => {
    const { palette } = await import('./theme');
    for (const mode of ['light', 'dark'] as const) {
      const p = palette(mode);
      for (const surface of [p.paper, p.paper2, p.card]) {
        for (const [name, text] of [['warnText', p.warnText], ['critText', p.critText], ['ink3', p.ink3]] as const) {
          expect(contrast(text, surface), `${mode} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
/**
 * THE REDESIGN PALETTE (2026-10, package P2.5). The phone's two palettes are
 * the redesign reference's tokens per mode (DESIGN-SPEC 2.1 and 2.5, the same
 * values the web's globals.css takes): pinned whole, so a later edit to a
 * colour is a deliberate one that updates this list, not a drift.
 */
describe('palette: each mode mapped onto the redesign reference (DESIGN-SPEC 2.5)', () => {
  it('light', async () => {
    const { palette } = await import('./theme');
    expect(palette('light')).toEqual({
      paper: '#fafaf7', // --bg
      paper2: '#f4f3ee', // --sunk (was #f3f1ea)
      card: '#ffffff', // --elev
      sunk: '#f4f3ee', // --sunk
      ink: '#0e0f0d', // --ink
      ink2: '#2a2c28', // --ink2
      ink3: '#5a5d56', // --ink3
      ink4: '#8b8e85', // --ink4
      ink5: '#b5b5ac', // no reference twin (the web's --ed-ink-5)
      hair: '#e7e5dd', // --line
      hair2: '#d4d2c8', // --line2, the stronger border
      accent: '#2f7463', // --acc
      accentInk: '#ffffff', // --accInk
      accentWash: '#e7f3f0', // --accWash
      warnText: '#975d11', // --warn at 33% L (DESIGN-SPEC 2.4)
      warnWash: '#f9eedc', // --warnWash
      critText: '#bc4224', // --dan
      critWash: '#fbede9', // --danWash
    });
  });

  it('dark', async () => {
    const { palette } = await import('./theme');
    expect(palette('dark')).toEqual({
      paper: '#0c0d0a', // --bg
      paper2: '#131410', // --elev, the inset tone the phone has always used here
      card: '#131410', // --elev (was #15160f)
      sunk: '#08090a', // --sunk: below the page in dark
      ink: '#f0efe8', // --ink (was #fafaf7)
      ink2: '#d8d6cc', // --ink2
      ink3: '#9a9b91', // --ink3
      ink4: '#6a6b62', // --ink4
      ink5: '#42423d', // no reference twin
      hair: '#1f201b', // --line
      hair2: '#2a2b25', // --line2, the stronger border
      accent: '#7acdb8', // --acc
      accentInk: '#07120e', // --accInk
      accentWash: '#182a26', // --accWash
      warnText: '#e2b05a', // --warn
      warnWash: '#292114', // --warnWash
      critText: '#e87a5e', // --dan
      critWash: '#2d1a16', // --danWash
    });
  });

  it('the accent, washes, warn and danger are the reference HSL values, per mode', async () => {
    const { palette } = await import('./theme');
    const { hexOf } = await import('../components/ui/__fixtures__/contrast');
    const light = palette('light');
    const dark = palette('dark');
    expect(light.accent).toBe(hexOf('hsl(165 42% 32%)'));
    expect(dark.accent).toBe(hexOf('hsl(165 45% 64%)'));
    expect(light.accentWash).toBe(hexOf('hsl(165 35% 93%)'));
    expect(dark.accentWash).toBe(hexOf('hsl(165 28% 13%)'));
    expect(light.warnText).toBe(hexOf('hsl(34 80% 33%)'));
    expect(dark.warnText).toBe(hexOf('hsl(38 70% 62%)'));
    expect(light.warnWash).toBe(hexOf('hsl(38 70% 92%)'));
    expect(dark.warnWash).toBe(hexOf('hsl(38 35% 12%)'));
    expect(light.critText).toBe(hexOf('hsl(12 68% 44%)'));
    expect(dark.critText).toBe(hexOf('hsl(12 75% 64%)'));
    expect(light.critWash).toBe(hexOf('hsl(12 70% 95%)'));
    expect(dark.critWash).toBe(hexOf('hsl(12 35% 13%)'));
  });

  it('hands back the same object for a mode, so memoised rows and style arrays stay stable', async () => {
    const { palette } = await import('./theme');
    expect(palette('light')).toBe(palette('light'));
    expect(palette('dark')).toBe(palette('dark'));
    expect(palette('light')).not.toBe(palette('dark'));
  });
});

describe('the redesign palette reads at AA in both modes', () => {
  const MODES = ['light', 'dark'] as const;
  const TEXT = ['ink', 'ink2', 'ink3', 'accent', 'warnText', 'critText'] as const;
  const SURFACES = ['paper', 'paper2', 'card', 'sunk'] as const;

  it('every text token on every surface (4.5:1)', async () => {
    const { palette } = await import('./theme');
    const { AA_TEXT, contrast } = await import('../components/ui/__fixtures__/contrast');
    for (const mode of MODES) {
      const p = palette(mode);
      for (const text of TEXT) {
        for (const surface of SURFACES) {
          expect(
            contrast(p[text], p[surface]),
            `${mode} ${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
  });

  it("each tone's words on its own wash, and the on-accent ink on the accent fill (4.5:1)", async () => {
    const { palette } = await import('./theme');
    const { AA_TEXT, contrast } = await import('../components/ui/__fixtures__/contrast');
    for (const mode of MODES) {
      const p = palette(mode);
      expect(
        contrast(p.accent, p.accentWash),
        `${mode} accent on accentWash`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(p.warnText, p.warnWash),
        `${mode} warnText on warnWash`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(p.critText, p.critWash),
        `${mode} critText on critWash`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(p.accentInk, p.accent), `${mode} accentInk on accent`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      // The ink button and the selected chip: paper (or card) words on ink.
      expect(contrast(p.paper, p.ink), `${mode} paper on ink`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(p.card, p.ink), `${mode} card on ink`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('ink4, the decoration ink (chevrons, separators, empty-state glyphs), still marks at 3:1 on paper and card', async () => {
    const { palette } = await import('./theme');
    const { AA_UI, contrast } = await import('../components/ui/__fixtures__/contrast');
    for (const mode of MODES) {
      const p = palette(mode);
      expect(contrast(p.ink4, p.paper), `${mode} ink4 on paper`).toBeGreaterThanOrEqual(AA_UI);
      expect(contrast(p.ink4, p.card), `${mode} ink4 on card`).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('the mode-independent mintInk twins stay AA text on their own mode', async () => {
    // The screens that still colour mint words with ACCENT read mintInk in
    // light and mintInkDark in dark (pill.tsx did, serials.ts and
    // order-line-readiness.tsx still do).
    const { ACCENT, palette } = await import('./theme');
    const { AA_TEXT, contrast } = await import('../components/ui/__fixtures__/contrast');
    for (const surface of SURFACES) {
      expect(
        contrast(ACCENT.mintInk, palette('light')[surface]),
        `mintInk on light ${surface}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(ACCENT.mintInkDark, palette('dark')[surface]),
        `mintInkDark on dark ${surface}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('exports other screens still read', () => {
  it('ACCENT keeps its mode-independent values (53 importers; lib/serials.ts pins crit)', async () => {
    const { ACCENT } = await import('./theme');
    expect(ACCENT).toEqual({
      mint: 'hsl(165, 38%, 56%)',
      mintSoft: 'hsla(165, 38%, 56%, 0.14)',
      mintInk: 'hsl(165, 42%, 28%)',
      mintInkDark: 'hsl(165, 50%, 70%)',
      pipOrange: '#ff7a45',
      pipTeal: '#46c2ca',
      pipAmber: '#f5b042',
      warn: '#b97a1d',
      crit: '#b03a3a',
    });
  });

  it('the legacy `theme` alias keeps every key, light only, until P5.4 removes it', async () => {
    // Light only by design: a screen still on it renders light in dark mode
    // until its owner moves it to useTheme().
    const { ACCENT, palette, theme } = await import('./theme');
    const light = palette('light');
    expect(theme).toEqual({
      bg: light.paper,
      bgElevated: light.paper2,
      border: light.hair,
      text: light.ink,
      textMuted: light.ink3,
      primary: light.ink,
      primaryDark: light.ink2,
      success: ACCENT.mintInk,
      warning: ACCENT.warn,
      destructive: ACCENT.crit,
      card: light.card,
    });
  });

  it('radius, space, RADIUS, SPACE and SHADOW are unchanged', async () => {
    const { RADIUS, SHADOW, SPACE, radius, space } = await import('./theme');
    expect(RADIUS).toEqual({ tile: 8, card: 10, cardHero: 14, pill: 999 });
    expect(SPACE).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 });
    expect(radius).toEqual({ sm: 6, md: 10, lg: 14, xl: 20 });
    expect(space).toBe(SPACE);
    expect(Object.keys(SHADOW)).toEqual(['card', 'sheet', 'fab']);
  });
});
