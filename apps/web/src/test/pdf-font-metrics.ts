/**
 * Adobe Core-14 AFM design widths (units per 1000 em) for the glyph subset the
 * StockPilot PDFs can emit, read out of the bundled @react-pdf/pdfkit@5.1.1
 * metrics. Lifted verbatim from lib/pdf/table-fit.test.ts, which pinned the
 * purchase-order tables; a second suite (report-table-fit.test.ts) now needs
 * the same table, so it lives here rather than being copied.
 *
 * To regenerate:
 *   node --input-type=module -e "const { default: D } = await import(
 *     './node_modules/.pnpm/@react-pdf+pdfkit@5.1.1/node_modules/@react-pdf/pdfkit/lib/pdfkit.js');
 *     const d = new D({size:'LETTER'}); d.font('Helvetica').fontSize(1000);
 *     console.log(d.widthOfString('A'));"
 *
 * (@react-pdf/pdfkit is a transitive dependency and is not resolvable from
 * apps/web under pnpm's strict node_modules, so it cannot be imported here.)
 *
 * This model deliberately ignores AFM kern pairs, which pdfkit does apply.
 * Kerning only ever makes a string NARROWER, so every width computed here is an
 * upper bound on what the layout engine produces. That biases each assertion
 * toward failing rather than silently passing, which is the right direction for
 * a fit check.
 */

export const HELVETICA: Readonly<Record<string, number>> = {
  ' ': 278, '!': 278, '#': 556, $: 556, '%': 889, '&': 667, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278,
  '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, '[': 278, ']': 278, _: 556,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '…': 1000, '—': 1000,
};

export const HELVETICA_BOLD: Readonly<Record<string, number>> = {
  ' ': 278, '!': 333, '#': 556, $: 556, '%': 889, '&': 722, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 333, ';': 333,
  '<': 584, '=': 584, '>': 584, '?': 611, '@': 975, '[': 333, ']': 333, _: 556,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '…': 1000, '—': 1000,
};

/** Courier is monospaced: every glyph is 600/1000 em, including the ellipsis. */
export const COURIER_ADVANCE = 600;

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

export function advance(char: string, font: FontName): number {
  if (font === 'Courier') return COURIER_ADVANCE;
  const table = font === 'Helvetica' ? HELVETICA : HELVETICA_BOLD;
  const w = table[char];
  // Fail loudly rather than treat an unknown glyph as zero-width: a silent 0
  // would under-measure the content and let a real overflow pass the suite.
  if (w === undefined) {
    throw new Error(
      `No ${font} advance width recorded for ${JSON.stringify(char)}. ` +
        'Add it to the metric table in src/test/pdf-font-metrics.ts before asserting against it.',
    );
  }
  return w;
}

/** Width of `text` in points, at `sizePt`, ignoring kerning (upper bound). */
export function width(text: string, font: FontName, sizePt: number): number {
  let total = 0;
  for (const char of text) total += advance(char, font);
  return (total / 1000) * sizePt;
}
