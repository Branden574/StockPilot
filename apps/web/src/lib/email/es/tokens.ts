/**
 * StockPilot email system — design tokens.
 *
 * Ported VERBATIM from the locked design package at
 * `docs/design/email-system/es-tokens.js` (light/dark palettes, status
 * pairs, font stacks, SPEC layout constants). Treat every value here as
 * normative — do not tune colors or spacing here; the design is signed
 * off as a package. If a value must change, it changes in the design
 * package first.
 */

// ── Status variants ─────────────────────────────────────────────────

export const ES_STATUS_VARIANTS = [
  'ok',
  'info',
  'warn',
  'err',
  'neutral',
  'purple',
  'sec',
] as const;
export type EsStatusVariant = (typeof ES_STATUS_VARIANTS)[number];

export interface EsStatusPair {
  fg: string;
  bg: string;
  /** Only the outlined `sec` variant carries a border color. */
  line?: string;
}

export interface EsTheme {
  name: 'light' | 'dark';
  /** Page background behind the letter. */
  desk: string;
  /** The letter / container background. */
  paper: string;
  /** Sunk panels: hero card, footer, table heads. */
  sunk: string;
  /** Raised panel (verbatim-message background in support). */
  raise: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  hair: string;
  hair2: string;
  btnBg: string;
  btnFg: string;
  status: Record<EsStatusVariant, EsStatusPair>;
}

// ── Palettes (verbatim from es-tokens.js) ───────────────────────────

export const ES_LIGHT: EsTheme = {
  name: 'light',
  desk: '#e8e5dd',
  paper: '#f6f4ef',
  sunk: '#eeece5',
  raise: '#fbfaf7',
  ink: '#0c0c0e',
  ink2: '#2a2a2c',
  ink3: '#5a5853',
  ink4: '#8b887f',
  hair: 'rgba(12,12,14,0.12)',
  hair2: 'rgba(12,12,14,0.22)',
  btnBg: '#0c0c0e',
  btnFg: '#f6f4ef',
  status: {
    ok: { fg: '#2f6a4a', bg: '#e6efe7' },
    info: { fg: '#3f5f78', bg: '#e4ebf0' },
    warn: { fg: '#7a5a1f', bg: '#f0e7d2' },
    err: { fg: '#8a3d33', bg: '#f2e1dc' },
    neutral: { fg: '#5a5853', bg: '#eae8e1' },
    purple: { fg: '#5b4a78', bg: '#eae4f1' },
    sec: { fg: '#0c0c0e', bg: 'transparent', line: 'rgba(12,12,14,0.35)' },
  },
};

export const ES_DARK: EsTheme = {
  name: 'dark',
  desk: '#060607',
  paper: '#161617',
  sunk: '#1e1e20',
  raise: '#1b1b1d',
  ink: '#f6f4ef',
  ink2: '#d5d2c9',
  ink3: '#a5a29a',
  ink4: '#7d7a72',
  hair: 'rgba(246,244,239,0.13)',
  hair2: 'rgba(246,244,239,0.26)',
  btnBg: '#f6f4ef',
  btnFg: '#0c0c0e',
  status: {
    ok: { fg: '#8cc7a1', bg: '#1c2b22' },
    info: { fg: '#93b4cc', bg: '#1b2530' },
    warn: { fg: '#d8b36c', bg: '#2d2413' },
    err: { fg: '#d9928a', bg: '#301c18' },
    neutral: { fg: '#a5a29a', bg: '#232322' },
    purple: { fg: '#b3a1d4', bg: '#262033' },
    sec: { fg: '#f6f4ef', bg: 'transparent', line: 'rgba(246,244,239,0.4)' },
  },
};

export const ES_THEMES = { light: ES_LIGHT, dark: ES_DARK } as const;

// ── Font stacks ─────────────────────────────────────────────────────
// Hierarchy must survive total webfont failure: Space Grotesk falls back
// to Helvetica/Arial, JetBrains Mono to Courier New, Tinos to Georgia.
//
// Two spellings exist in the design package: es-tokens.js declares the
// stacks with double quotes + spaces (mockup React styles), while the
// three normative archetype HTML files inline them with single quotes,
// no spaces, and (for mono) WITHOUT the "Courier New" fallback. The
// archetypes are normative for email markup, so components use the
// *_INLINE forms; the verbatim es-tokens values are kept alongside.
// FLAG: es-tokens.js:34 MONO includes '"Courier New"'; the archetypes'
// inline mono stack ("'JetBrains Mono',ui-monospace,monospace") drops it.

export const ES_F1 = '"Space Grotesk", Helvetica, Arial, sans-serif';
export const ES_MONO = '"JetBrains Mono", ui-monospace, "Courier New", monospace';
export const ES_SERIF = '"Tinos", Georgia, serif';

/** Archetype-inline font stacks — byte-exact with the reference markup. */
export const ES_F1_INLINE = "'Space Grotesk',Helvetica,Arial,sans-serif";
export const ES_MONO_INLINE = "'JetBrains Mono',ui-monospace,monospace";
export const ES_SERIF_INLINE = "'Tinos',Georgia,serif";

// ── Developer handoff constants (SPEC, verbatim) ────────────────────

export const ES_SPEC = {
  width: 600,
  mobileBp: 620,
  mobileWidth: 375,
  pad: {
    desktopX: 36,
    mobileX: 24,
    headerY: 20,
    heroTop: 36,
    section: 28,
    card: 18,
    footerY: 18,
    btnY: 13,
    btnX: 18,
    rowGap: 14,
  },
  radius: { btn: 6, card: 6, pill: 999, hero: 8, table: 6, icon: 8 },
  type: [
    ['Eyebrow', 'JetBrains Mono 500', '9–10px', '0.22em caps'],
    ['Hero headline', 'Space Grotesk 500', '32px / 1.1 (mobile 24px)', '-0.03em'],
    ['Headline serif turn', 'Tinos italic 400', 'inherits h1', 'used for the second line only'],
    ['Section heading', 'Space Grotesk 600', '16px / 1.25', '-0.01em'],
    ['Body', 'Space Grotesk 400', '14.5px / 1.55', '0'],
    ['Supporting', 'Space Grotesk 400', '12.5px / 1.55', 'ink-3'],
    ['Status pill', 'JetBrains Mono 600', '10px', '0.18em caps'],
    ['Button', 'Space Grotesk 500', '13.5px', '0'],
    ['Big operational number', 'Space Grotesk 600', '30px / 1', '-0.02em'],
    ['Order number', 'JetBrains Mono 400', '10–11px', '0.02em'],
    ['Date / time', 'Space Grotesk 400', '12.5px', 'ink-3'],
    ['Table heading', 'JetBrains Mono 500', '9px', '0.18em caps'],
    ['Table value', 'Space Grotesk 400', '12.5px / 1.4', '0'],
    ['Caption / legal', 'Space Grotesk 400', '11px / 1.6', 'ink-4'],
  ],
  btnH: 44,
  border: '1px solid hair',
  shadowNote:
    'No shadows inside email bodies — hairline borders only. Card shadow exists solely in mockup chrome.',
} as const;

// ── Hero image slot (from the archetypes / motion board) ────────────
// 1200×440 @2x assets render at 600×220; inside the 528px content column
// the <img> carries explicit width=528 height=194 so blocked-image
// clients reserve the exact height (528/600 * 220 ≈ 194).

export const ES_HERO_IMG_WIDTH = 528;
export const ES_HERO_IMG_HEIGHT = 194;

// ── Weight budget ───────────────────────────────────────────────────
// Gmail clips messages over ~102KB of HTML, hiding the unsubscribe
// footer — every family template must stay under this.

export const ES_MAX_HTML_BYTES = 102 * 1024;

// ── Asset origin ────────────────────────────────────────────────────
// Matches the existing `emailLogoImg` convention (lib/email/templates.tsx):
// a hard-coded absolute URL on the public production origin — email
// clients need absolute URLs and Google's image proxy caches per-URL, so
// we never derive this from a request-time env. ES assets are served
// from `apps/web/public/email/` → `https://stockpilotusa.com/email/...`.

export const ES_ASSET_BASE = 'https://stockpilotusa.com/email';

/**
 * Absolute URL for an es asset file (logo marks, motion GIFs).
 * `esAssetUrl('lock@2x.gif')` → `https://stockpilotusa.com/email/lock@2x.gif`.
 *
 * `version` appends `?v=N` — the same GoogleImageProxy cache-bust escape
 * hatch the legacy logo needed (the proxy caches failures per-URL; see
 * the `?v=2` note on EMAIL_LOGO_URL). Leave unset until an asset needs
 * a bust.
 */
export function esAssetUrl(file: string, version?: number): string {
  return `${ES_ASSET_BASE}/${file}${version ? `?v=${version}` : ''}`;
}
