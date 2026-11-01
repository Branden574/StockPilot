import { safeWidth, type FontName } from './helvetica-metrics';

/**
 * The characters a SKU, barcode or ISBN may be broken after. An identifier
 * reads in groups split by these, so a line that ends on one still reads as
 * the same value.
 */
const BREAK_AFTER = new Set(['-', '_', '/', '.', ':', ' ']);

/**
 * Lay an identifier out as lines that each fit `maxWidthPt` at `fontSizePt`,
 * joined with '\n'. A value that fits comes back unchanged, and the lines
 * always join back to the exact value: nothing is added, dropped or moved.
 *
 * Why react-pdf is not left to wrap it: @react-pdf/textkit breaks a word that
 * does not fit at an English hyphenation point and inserts a hyphen glyph
 * there (textkit breakLines, `insertGlyph(..., HYPHEN, line)`), so a long SKU
 * printed as "MATH-GRADE5-WORK-" / "BOOK-2026-ED2-XL", a hyphen the SKU does
 * not have. A word with no hyphenation point, such as a long run of digits,
 * is not broken at all and runs past its box. textkit treats '\n' as the end
 * of a paragraph, so a line broken here ends there with nothing inserted.
 *
 * Each line ends just after the identifier's own separator when one falls on
 * it, else between two characters. Widths come from safeWidth, which ignores
 * kerning, so a line measured to fit here also fits in the PDF.
 */
export function breakIdentifierLines(
  value: string,
  maxWidthPt: number,
  fontSizePt: number,
  font: FontName = 'Helvetica',
): string {
  if (safeWidth(value, font, fontSizePt) <= maxWidthPt) return value;
  // Code points, so a character outside the BMP is never split in two.
  const chars = Array.from(value);
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let used = 0;
    while (end < chars.length) {
      const w = safeWidth(chars[end]!, font, fontSizePt);
      // At least one character per line, so a box narrower than one glyph
      // still ends.
      if (end > start && used + w > maxWidthPt) break;
      used += w;
      end += 1;
    }
    if (end < chars.length) {
      // The last separator on the line, but never one the line starts with:
      // a line of only "-" reads as a lost character.
      for (let i = end; i > start + 1; i -= 1) {
        if (BREAK_AFTER.has(chars[i - 1]!)) {
          end = i;
          break;
        }
      }
    }
    lines.push(chars.slice(start, end).join(''));
    start = end;
  }
  return lines.join('\n');
}
