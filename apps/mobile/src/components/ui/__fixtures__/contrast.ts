/**
 * TEST-ONLY WCAG 2.x contrast for the palette and the primitives' tone recipes
 * (lib/theme.test.ts, components/ui/tones.test.ts). Reads the two colour
 * notations the phone's tokens are written in: '#rrggbb' and
 * 'hsl(h, s%, l%)' (with or without commas). Translucent colours are not
 * accepted: their contrast depends on what is under them.
 */

/** '#rrggbb' or 'hsl(...)' to [r, g, b], each 0-255. */
export function rgbOf(colour: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const n = hex[1]!;
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as [number, number, number];
  }
  const hsl = /^hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i.exec(colour.trim());
  if (hsl) {
    const h = Number(hsl[1]);
    const s = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    };
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
  }
  throw new Error(`not an opaque #rrggbb or hsl() colour: ${colour}`);
}

/** The colour as '#rrggbb', so an hsl() token can be compared with a hex one. */
export function hexOf(colour: string): string {
  return `#${rgbOf(colour)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

function luminance(colour: string): number {
  const [r, g, b] = rgbOf(colour).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for body text. */
export const AA_TEXT = 4.5;
/** WCAG AA for large text and for UI marks (borders, fills, glyphs, knobs). */
export const AA_UI = 3;
