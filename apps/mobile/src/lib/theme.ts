/**
 * StockPilot Mobile — Design Tokens
 *
 * Warm-paper editorial palette, ported from the Claude Design handoff
 * (see /tmp/sp-design — mobile-tokens.css). Matches the web app's
 * design language: warm off-white, ink-black CTAs, mint accent only,
 * hairline borders, near-zero shadows. Dark mode mirrors the light
 * palette with the same hue logic inverted.
 *
 * Type pairing is loaded at runtime via expo-font in app/_layout.tsx:
 *   - Inter Tight (display)
 *   - Instrument Serif Italic (emphasis spans)
 *   - JetBrains Mono (eyebrows, SKUs, numerics)
 */

export type ThemeMode = 'light' | 'dark';

interface Palette {
  paper: string;
  paper2: string;
  card: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  ink5: string;
  hair: string;
}

const LIGHT: Palette = {
  paper: '#fafaf7',
  paper2: '#f3f1ea',
  card: '#ffffff',
  ink: '#0e0f0d',
  ink2: '#2a2c27',
  ink3: '#5d5e57',
  ink4: '#8b8c83',
  ink5: '#b5b5ac',
  hair: '#e7e5dd',
};

const DARK: Palette = {
  paper: '#0c0d0a',
  paper2: '#131410',
  card: '#15160f',
  ink: '#fafaf7',
  ink2: '#d9d8d2',
  ink3: '#9a988f',
  ink4: '#6b6a63',
  ink5: '#42423d',
  hair: '#1f201b',
};

export const ACCENT = {
  mint: 'hsl(165, 38%, 56%)',
  mintSoft: 'hsla(165, 38%, 56%, 0.14)',
  mintInk: 'hsl(165, 42%, 28%)',
  mintInkDark: 'hsl(165, 50%, 70%)',
  pipOrange: '#ff7a45',
  pipTeal: '#46c2ca',
  pipAmber: '#f5b042',
  warn: '#b97a1d',
  crit: '#b03a3a',
};

export function palette(mode: ThemeMode): Palette {
  return mode === 'dark' ? DARK : LIGHT;
}

export const FONT = {
  display: 'InterTight_500Medium',
  displayRegular: 'InterTight_400Regular',
  displaySemi: 'InterTight_600SemiBold',
  serifItalic: 'InstrumentSerif_400Regular_Italic',
  mono: 'JetBrainsMono_500Medium',
  monoRegular: 'JetBrainsMono_400Regular',
};

/**
 * Dynamic Type ceilings, in POINTS — the largest a given class of chrome is
 * allowed to render at, no matter how far the user has pushed
 * Settings → Accessibility → Larger Text (iOS goes to ~3.57x at AX5).
 *
 * Content text (Body, Mono, item names, SKUs, quantities) is NOT in this
 * table on purpose: it lives in ScrollViews and must scale all the way. Only
 * fixed-frame chrome opts in.
 */
export const TYPE_CEILING = {
  display: 48, // headings, call sites 18–40pt
  eyebrow: 16, // 11pt tracked uppercase mono section labels
  control: 22, // button + segmented-control labels, 13–15.5pt
  input: 24, // TextInput inside a bordered box
  chrome: 20, // pill / page-number / micro-marker labels, 9–13pt
};

/**
 * A cap is a CEILING IN POINTS, not a taste multiplier — a 34pt title and an
 * 11pt eyebrow need very different multipliers to land in the same physical
 * space. Never returns < 1, so a cap can only limit growth, never shrink.
 *
 * Mirrors Apple's own ramp, which caps Large Title 34→44pt (1.29x) while
 * letting Body 17→53pt (3.1x): the larger the base, the smaller the cap. We
 * use 48 rather than Apple's 44 because Inter Tight 500 at -0.028em tracking
 * is narrower than SF Pro.
 */
export const capTo = (size: number, ceiling: number) => Math.max(1, ceiling / size);

/**
 * Resolves a call site's `maxFontSizeMultiplier` against a primitive's policy
 * default.
 *
 * The override contract: pass a number to tighten or loosen the cap, pass `0`
 * — React Native's documented "no limit" sentinel — to opt out of capping
 * entirely, or pass `null` to inherit whatever the parent Text set. `0` is
 * falsy and `null` is nullish, so both `explicit || fallback` and
 * `explicit ?? fallback` would silently re-apply the very cap the call site
 * just disabled; only an explicit `undefined` check gets this right.
 */
export function resolveFontCap(
  explicit: number | null | undefined,
  policyDefault: number | null | undefined,
): number | null | undefined {
  return explicit === undefined ? policyDefault : explicit;
}

export const RADIUS = {
  tile: 8,
  card: 10,
  cardHero: 14,
  pill: 999,
};

export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const SHADOW = {
  card: {
    shadowColor: '#0e0f0d',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.04,
    shadowRadius: 34,
    elevation: 1,
  },
  sheet: {
    shadowColor: '#0e0f0d',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.08,
    shadowRadius: 40,
    elevation: 6,
  },
  fab: {
    shadowColor: '#0e0f0d',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
} as const;

/**
 * Legacy alias kept so existing screens that haven't been migrated yet
 * still compile. New code should import `palette()` + `ACCENT` directly
 * and not reach into `theme.*`. Maps the warm-paper light palette into
 * the original prop names so the dark-navy palette is fully retired.
 */
export const theme = {
  bg: LIGHT.paper,
  bgElevated: LIGHT.paper2,
  border: LIGHT.hair,
  text: LIGHT.ink,
  textMuted: LIGHT.ink3,
  primary: LIGHT.ink,
  primaryDark: LIGHT.ink2,
  success: ACCENT.mintInk,
  warning: ACCENT.warn,
  destructive: ACCENT.crit,
  card: LIGHT.card,
};

export const radius = { sm: 6, md: RADIUS.card, lg: RADIUS.cardHero, xl: 20 };
export const space = SPACE;
