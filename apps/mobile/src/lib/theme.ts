/**
 * StockPilot Mobile — Design Tokens
 *
 * Warm-paper editorial palette, mapped per mode onto the 2026-10 redesign
 * reference (the web's tokens, DESIGN-SPEC 2.1 / 2.5): warm off-white or
 * near-black paper, ink CTAs, a teal accent tuned per mode, hairline
 * borders, flat surfaces. Light and dark are two complete palettes with one
 * structure: only values change between modes, never layout or weight.
 *
 * The mode follows the device (use-theme.ts); there is no in-app override.
 *
 * Type pairing is loaded at runtime via expo-font in app/_layout.tsx:
 *   - Inter Tight (display and body)
 *   - Instrument Serif Italic (emphasis spans)
 *   - JetBrains Mono (eyebrows, SKUs, numerics)
 */

export type ThemeMode = 'light' | 'dark';

/**
 * One mode's colours. Every text token (ink, ink2, ink3, accent, warnText,
 * critText) is measured on every surface (paper, paper2, card, sunk) and each
 * tone on its own wash in theme.test.ts (WCAG AA, 4.5:1); the recipes the
 * shared primitives draw with are measured in components/ui/tones.test.ts.
 * The reference name each token maps to is in brackets.
 */
export interface Palette {
  /** Page background [--bg]. */
  paper: string;
  /** Quiet inset fill the screens use for panels and wells [light --sunk;
   *  dark keeps the elevated tone the phone has always used here, which is
   *  the card colour, so it does not show on a card in dark]. The shared
   *  primitives take `sunk` for recessed fills instead. */
  paper2: string;
  /** Elevated surface: cards, sheets, inputs [--elev]. */
  card: string;
  /** Recessed fill: segmented tracks, count inputs, neutral chips, the
   *  avatar [--sunk]. In dark it is darker than the page, in light a step
   *  below it, so it reads as "pressed in" in both modes. */
  sunk: string;
  /** Primary text, ink buttons [--ink]. */
  ink: string;
  /** Secondary text [--ink2]. */
  ink2: string;
  /** Muted text: sublines, meta, labels, eyebrows [--ink3]. */
  ink3: string;
  /** Disabled or decorative only: arrows, separators, glyphs [--ink4].
   *  3.0-3.7:1, so never informational text. */
  ink4: string;
  /** Faintest decoration (no reference twin; the web's --ed-ink-5). */
  ink5: string;
  /** Hairlines: card borders, row separators [--line]. */
  hair: string;
  /** Stronger border for interactive emphasis: secondary buttons, inputs,
   *  badges, chips, page buttons, meter tracks [--line2]. */
  hair2: string;
  /** Accent for fills AND text [--acc]: deep teal in light, mint in dark. */
  accent: string;
  /** Text and icons on an accent fill [--accInk]. */
  accentInk: string;
  /** Accent-tinted fill: ok pills, a selected range or row [--accWash]. */
  accentWash: string;
  /** Warning words and marks [--warn, light at 33% L for AA on its wash]. */
  warnText: string;
  /** Warning fill [--warnWash]. */
  warnWash: string;
  /** Refusal and error words and marks [--dan]. */
  critText: string;
  /** Refusal fill [--danWash]. */
  critWash: string;
}

const LIGHT: Palette = {
  paper: '#fafaf7',
  paper2: '#f4f3ee',
  card: '#ffffff',
  sunk: '#f4f3ee',
  ink: '#0e0f0d',
  ink2: '#2a2c28',
  ink3: '#5a5d56',
  ink4: '#8b8e85',
  ink5: '#b5b5ac',
  hair: '#e7e5dd',
  hair2: '#d4d2c8',
  accent: '#2f7463', // hsl(165 42% 32%)
  accentInk: '#ffffff',
  accentWash: '#e7f3f0', // hsl(165 35% 93%)
  warnText: '#975d11', // hsl(34 80% 33%)
  warnWash: '#f9eedc', // hsl(38 70% 92%)
  critText: '#bc4224', // hsl(12 68% 44%)
  critWash: '#fbede9', // hsl(12 70% 95%)
};

const DARK: Palette = {
  paper: '#0c0d0a',
  paper2: '#131410',
  card: '#131410',
  sunk: '#08090a',
  ink: '#f0efe8',
  ink2: '#d8d6cc',
  ink3: '#9a9b91',
  ink4: '#6a6b62',
  ink5: '#42423d',
  hair: '#1f201b',
  hair2: '#2a2b25',
  accent: '#7acdb8', // hsl(165 45% 64%)
  accentInk: '#07120e',
  accentWash: '#182a26', // hsl(165 28% 13%)
  warnText: '#e2b05a', // hsl(38 70% 62%)
  warnWash: '#292114', // hsl(38 35% 12%)
  critText: '#e87a5e', // hsl(12 75% 64%)
  critWash: '#2d1a16', // hsl(12 35% 13%)
};

/**
 * Mode-independent accents, kept exactly as they were for the screens that
 * still read them (lib/serials.ts pins `crit`). New code takes the per-mode
 * palette instead: `c.accent` for `mint`, `c.accentWash` for `mintSoft`,
 * `c.warnText` / `c.critText` for `warn` / `crit` (the single values here
 * fall under 4.5:1 as text in one mode or the other). `mintInk` and
 * `mintInkDark` stay the AA text twins for mint words on each mode's paper.
 */
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
  eyebrow: 16, // 11pt tracked uppercase mono SECTION labels
  label: 28, // 11pt FORM FIELD labels — see the note below
  control: 22, // button + segmented-control labels, 13–15.5pt
  input: 24, // TextInput inside a bordered box
  chrome: 20, // pill / page-number / micro-marker labels, 9–13pt
};

/**
 * Why `label` is nearly double `eyebrow` when both render the same 11pt
 * tracked uppercase mono line.
 *
 * A section eyebrow is a landmark: you read it once on the way past, and the
 * content under it says what the section is anyway. A FIELD label is the only
 * thing on screen that names the box you are typing into — and it sits
 * directly above a value that is deliberately left uncapped (plan §3: "All
 * Add-Item TextInputs … Only the *labels* are broken").
 *
 * The real sizes: Add-Item labels are 11pt, their inputs 15pt — a designed
 * 73% relationship. Pinned at the 16pt eyebrow ceiling while the input runs
 * free, that collapses to 16/35.3 = 45% at AX3 and 16/53.6 = 30% at AX5. The
 * smallest text on the form becomes the label, which is backwards.
 *
 * 28pt is the largest ceiling that still fits: the longest real field label,
 * "PRIMARY LOCATION", is 18 mono characters once Eyebrow's "— " prefix is
 * counted, each 0.6em wide plus 1.98pt of tracking (letterSpacing is applied
 * in unscaled points and does not grow), so 18 × (0.6S + 1.98) ≤ 362pt of
 * form column gives S ≤ 30. At 28 it lands at 338pt — one line — and anything
 * longer falls back on the two-line reflow Eyebrow already has.
 *
 * That restores the label to 79% of its input at AX3 and 52% at AX5, and
 * 28/11 = 2.55x is still tighter than Apple's own 11pt Caption2 → 36pt
 * (3.27x) at AX5.
 */

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
 *
 * LIGHT ONLY: a screen on this alias renders light in dark mode. Each
 * screen's owner moves it to `useTheme()`; the alias is deleted once the
 * last one has (redesign package P5.4).
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
