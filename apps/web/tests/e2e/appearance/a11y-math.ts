/**
 * The arithmetic behind the stage 5 accessibility and fidelity checks
 * (IMPLEMENTATION-PLAN.md 8.1-2, 8.3; plans/REVISION-DEFAULT.md R11). Pure, so
 * src/test/stage5-a11y-math.test.ts proves it without a browser; the lab
 * specs (a11y-contrast, a11y-keyboard, fidelity-geometry) feed it what the
 * browser measured.
 *
 *  - WCAG 2.2 relative luminance and contrast ratio, and the worst ratio of a
 *    text colour over every pixel sampled behind its box (8.3 "contrast over
 *    composed glass": body 4.5:1, large text 3:1, field edges and focus 3:1).
 *  - CSS colour parsing (what getComputedStyle returns: rgb(), rgba(), the
 *    color(srgb ...) form, #hex) and source-over compositing of a translucent
 *    colour on what lies under it.
 *  - CIEDE2000 (8.1-2: opaque surface colours within delta E 1 of the board).
 *  - The glass focus ring per variant (8.3-2: Day #0B7A5C 2 px, Night #56D6A9
 *    2 px, contrast 3 px #101412 / #FFFFFF, 2 px offset; fields use the halo)
 *    and the check of one element's computed ring against it.
 */

export type Rgb = readonly [number, number, number];
export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const clamp255 = (n: number) => Math.min(255, Math.max(0, n));

/** One sRGB channel (0..255) to linear light, WCAG 2.2's definition. */
export function channelToLinear(c: number): number {
  const s = clamp255(c) / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque sRGB colour. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG contrast ratio of two opaque colours (1..21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over: `top` (possibly translucent) painted on an opaque `under`. */
export function composite(top: Rgba, under: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, top.a));
  return [
    top.r * a + under[0] * (1 - a),
    top.g * a + under[1] * (1 - a),
    top.b * a + under[2] * (1 - a),
  ];
}

/**
 * Parses a computed CSS colour. Returns null for what is not a colour value
 * (`none`, `currentcolor`, a gradient), so a caller never compares garbage.
 */
export function parseCssColor(raw: string): Rgba | null {
  const text = raw.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a = 'f'] = h.split('');
      return {
        r: parseInt(r! + r!, 16),
        g: parseInt(g! + g!, 16),
        b: parseInt(b! + b!, 16),
        a: parseInt(a + a, 16) / 255,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/u.exec(text);
  if (fn) {
    const parts = fn[1]!
      .replace(/\//gu, ' ')
      .split(/[\s,]+/u)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha = (p: string | undefined) =>
      p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
    const out = {
      r: channel(parts[0]!),
      g: channel(parts[1]!),
      b: channel(parts[2]!),
      a: alpha(parts[3]),
    };
    return [out.r, out.g, out.b, out.a].some(Number.isNaN) ? null : out;
  }
  // Chromium returns color(srgb r g b / a) for colours mixed with color-mix().
  const srgb = /^color\(srgb ([^)]*)\)$/u.exec(text);
  if (srgb) {
    const parts = srgb[1]!.replace(/\//gu, ' ').split(/\s+/u).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0]! * 255, g: parts[1]! * 255, b: parts[2]! * 255, a: parts[3] ?? 1 };
  }
  return null;
}

/** WCAG "large text": at least 24 px, or at least 18.66 px (14 pt) and bold (700+). */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

/** The ratio a text run needs (R11: body 4.5, large 3). */
export function requiredTextRatio(fontSizePx: number, fontWeight: number): number {
  return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
}

/** Non-text (field edges, focus indicators, control boundaries): 3:1. */
export const NON_TEXT_RATIO = 3;

/**
 * The worst contrast of a text colour over the pixels sampled behind it.
 * `text` may be translucent: it is composited over each pixel first, as the
 * browser draws it. Null when no pixel was sampled.
 */
export function worstContrast(text: Rgba, behind: Iterable<Rgb>): number | null {
  let worst: number | null = null;
  for (const px of behind) {
    const ratio = contrastRatio(composite(text, px), px);
    if (worst === null || ratio < worst) worst = ratio;
  }
  return worst;
}

/**
 * R11 worst-case crops: of the pixels behind a pane, the darkest and the
 * lightest `fraction` (by luminance). Returns both sets (each at least one
 * pixel when any pixel exists).
 */
export function extremeCrops(
  pixels: readonly Rgb[],
  fraction = 0.1,
): { dark: Rgb[]; light: Rgb[] } {
  if (pixels.length === 0) return { dark: [], light: [] };
  const sorted = [...pixels].sort((a, b) => relativeLuminance(a) - relativeLuminance(b));
  const n = Math.max(1, Math.floor(sorted.length * fraction));
  return { dark: sorted.slice(0, n), light: sorted.slice(sorted.length - n) };
}

// ── CIEDE2000 ────────────────────────────────────────────────────────────

/** sRGB (0..255) to CIE L*a*b* (D65). */
export function rgbToLab([r, g, b]: Rgb): [number, number, number] {
  const R = channelToLinear(r);
  const G = channelToLinear(g);
  const B = channelToLinear(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference of two L*a*b* colours (kL = kC = kH = 1). */
export function deltaE00(
  [L1, a1, b1]: readonly [number, number, number],
  [L2, a2, b2]: readonly [number, number, number],
): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (bb: number, ap: number) => {
    if (bb === 0 && ap === 0) return 0;
    const h = Math.atan2(bb, ap) / rad;
    return h >= 0 ? h : h + 360;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** delta E 2000 of two sRGB colours. */
export function deltaE00Rgb(a: Rgb, b: Rgb): number {
  return deltaE00(rgbToLab(a), rgbToLab(b));
}

// ── The glass focus ring (8.3-2) ─────────────────────────────────────────

export type RingVariant = 'day' | 'night' | 'contrast-day' | 'contrast-night';

export interface ExpectedRing {
  color: Rgb;
  widthPx: number;
  offsetPx: number;
}

/** tokens.generated.css: --lg-focus and --lg-focus-w per variant; primitives.css: offset 2 px. */
export const FOCUS_RING: Record<RingVariant, ExpectedRing> = {
  day: { color: [0x0b, 0x7a, 0x5c], widthPx: 2, offsetPx: 2 },
  night: { color: [0x56, 0xd6, 0xa9], widthPx: 2, offsetPx: 2 },
  'contrast-day': { color: [0x10, 0x14, 0x12], widthPx: 3, offsetPx: 2 },
  'contrast-night': { color: [0xff, 0xff, 0xff], widthPx: 3, offsetPx: 2 },
};

/** What getComputedStyle reports for a focused element. */
export interface ComputedRing {
  outlineStyle: string;
  outlineColor: string;
  outlineWidth: string;
  outlineOffset: string;
  boxShadow: string;
}

/**
 * Problems with one focused element's ring (empty: it is the variant's ring).
 *  - `outline`: the ring is an outline of the variant's colour and width; the
 *    offset is 2 px, or minus the width for a control drawn inside a clipping
 *    track (a segment: `inset` true).
 *  - `halo`: a field (input or select) shows the 3 px halo box-shadow instead
 *    and no outline.
 * Colours compare within delta E 1 (the browser may round a channel).
 */
export function ringProblems(
  computed: ComputedRing,
  variant: RingVariant,
  kind: 'outline' | 'inset' | 'halo',
): string[] {
  const want = FOCUS_RING[variant];
  const problems: string[] = [];
  if (kind === 'halo') {
    if (!/\b3px\b/u.test(computed.boxShadow) || computed.boxShadow === 'none')
      problems.push(`a field shows no 3 px halo (box-shadow ${computed.boxShadow})`);
    return problems;
  }
  if (computed.outlineStyle === 'none' || parseFloat(computed.outlineWidth) === 0) {
    problems.push(`no outline (style ${computed.outlineStyle}, width ${computed.outlineWidth})`);
    return problems;
  }
  const color = parseCssColor(computed.outlineColor);
  if (color === null) problems.push(`outline colour ${computed.outlineColor} is not a colour`);
  else {
    const d = deltaE00Rgb([color.r, color.g, color.b], want.color);
    if (d >= 1 || color.a < 0.99)
      problems.push(`outline colour ${computed.outlineColor}, want rgb(${want.color.join(', ')})`);
  }
  const width = parseFloat(computed.outlineWidth);
  if (Math.abs(width - want.widthPx) > 0.01)
    problems.push(`outline width ${computed.outlineWidth}, want ${want.widthPx}px`);
  const offset = parseFloat(computed.outlineOffset);
  const wantOffset = kind === 'inset' ? -want.widthPx : want.offsetPx;
  if (Math.abs(offset - wantOffset) > 0.01)
    problems.push(`outline offset ${computed.outlineOffset}, want ${wantOffset}px`);
  return problems;
}
