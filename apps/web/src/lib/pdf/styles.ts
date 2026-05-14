import { StyleSheet } from '@react-pdf/renderer';

/**
 * Shared @react-pdf/renderer style sheet for the StockPilot branded
 * exports (purchase orders, cycle count sheets, inventory snapshots).
 *
 * Color cues come from the editorial palette in apps/web/src/app/globals.css
 *   --ed-ink   = #0e0f0d  (primary text)
 *   --ed-ink-3 = #5a5d56  (muted / metadata)
 *   --ed-ink-4 = #8b8e85  (secondary muted)
 *   --ed-line  = #e7e5dd  (hairline borders)
 *   --ed-line-strong = #d4d2c8 (table-row borders)
 *   accent     = #6cbfa3  (mint ~ oklch(0.74 0.12 165) approximation)
 *
 * # Fonts and Unicode glyph coverage
 *
 * Fonts are intentionally limited to the @react-pdf builtins (Helvetica,
 * Helvetica-Bold, Courier). Registering external fonts at request time
 * causes serverless cold-start font-fetch failures, so we keep the set
 * minimal and rely on size + weight for hierarchy instead.
 *
 * KNOWN LIMITATION (tracked in pdf-hunter C5): the built-in Helvetica /
 * Courier fonts cover Latin-1 + a small set of WinAnsi punctuation, but
 * they DO NOT contain CJK glyphs, Cyrillic, emoji, or many extended
 * Latin marks (most non-ASCII diacritics beyond á/é/í/ó/ú/ñ). Item names
 * containing those code points will render as missing-glyph boxes ("·"
 * in some viewers, blank in others). The fix is to register a
 * Unicode-capable fallback (e.g. Noto Sans) via Font.register, but that
 * requires shipping a TTF in the build artifact or fetching one on cold
 * start — both incur cost/risk we haven't budgeted for yet. Document
 * the limitation here so the next maintainer doesn't rediscover it.
 *
 * # Currency / timezone notes
 *
 * `formatCurrencyForPdf` defaults to USD because every StockPilot org
 * we ship to today bills in USD. When we introduce a per-org currency
 * column, plumb that through here.
 *
 * `formatDateForPdf` defaults to America/Los_Angeles (StockPilot's
 * operational base) so dates rendered in the PDF are stable regardless
 * of the serverless container's runtime tz, which on Vercel is UTC.
 * Pass an explicit `timeZone` to override per call.
 */
export const PDF_COLORS = {
  ink: '#0e0f0d',
  ink2: '#2a2c28',
  ink3: '#5a5d56',
  ink4: '#8b8e85',
  line: '#e7e5dd',
  lineStrong: '#d4d2c8',
  accent: '#6cbfa3',
  bgSunk: '#f4f3ee',
  white: '#ffffff',
} as const;

export const pdfStyles = StyleSheet.create({
  // Page-level
  page: {
    paddingTop: 40,
    paddingHorizontal: 40,
    paddingBottom: 56, // leaves room for the footer
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: PDF_COLORS.ink,
    backgroundColor: PDF_COLORS.white,
  },

  // Header block
  headerWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingBottom: 12,
    marginBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.lineStrong,
    borderBottomStyle: 'solid',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '60%',
  },
  headerLogo: {
    width: 36,
    height: 36,
    objectFit: 'contain',
  },
  headerOrgName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 13,
    color: PDF_COLORS.ink,
  },
  headerOrgMeta: {
    fontSize: 8,
    color: PDF_COLORS.ink3,
    marginTop: 2,
  },
  headerRight: {
    alignItems: 'flex-end',
    maxWidth: '40%',
  },
  headerTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: PDF_COLORS.ink,
    textAlign: 'right',
  },
  headerSubtitle: {
    fontSize: 9,
    color: PDF_COLORS.ink3,
    marginTop: 3,
    textAlign: 'right',
  },

  // Generic blocks
  section: { marginBottom: 14 },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    letterSpacing: 1.2,
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  twoCol: { flexDirection: 'row', gap: 24 },
  col: { flex: 1 },

  // Tables
  table: {
    width: '100%',
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.lineStrong,
    borderTopStyle: 'solid',
  },
  tHeadRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.bgSunk,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.lineStrong,
    borderBottomStyle: 'solid',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.line,
    borderBottomStyle: 'solid',
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  tCell: { fontSize: 9, color: PDF_COLORS.ink },
  tHeadCell: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  tCellMono: {
    fontFamily: 'Courier',
    fontSize: 8.5,
    color: PDF_COLORS.ink2,
  },
  tRight: { textAlign: 'right' },

  // Totals
  totalsWrap: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  totalsBox: {
    width: '45%',
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    fontSize: 9,
  },
  totalsRowFinal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.ink2,
    borderTopStyle: 'solid',
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
  },
  totalsLabel: { color: PDF_COLORS.ink3 },
  totalsValue: { fontFamily: 'Helvetica-Bold', color: PDF_COLORS.ink },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: PDF_COLORS.ink4,
    borderTopWidth: 0.5,
    borderTopColor: PDF_COLORS.line,
    borderTopStyle: 'solid',
    paddingTop: 6,
  },
  pageNumber: { color: PDF_COLORS.ink4 },

  // Misc text
  muted: { color: PDF_COLORS.ink3 },
  mono: { fontFamily: 'Courier' },
  small: { fontSize: 8 },
  bold: { fontFamily: 'Helvetica-Bold' },

  // Optional table-footer row — used for warehouse subtotals in the
  // inventory snapshot. Visually distinct (slightly heavier divider,
  // sunk background) so the eye stops on it at the bottom of a group.
  tFootRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.bgSunk,
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.lineStrong,
    borderTopStyle: 'solid',
    paddingVertical: 5,
    paddingHorizontal: 4,
  },

  // PO terms block (rendered above the signature lines, only when org
  // has a non-empty po_terms string).
  termsWrap: {
    marginTop: 22,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: PDF_COLORS.line,
    borderTopStyle: 'solid',
  },
  termsHeading: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    color: PDF_COLORS.ink,
    marginBottom: 4,
  },
  termsBody: {
    fontSize: 9,
    color: PDF_COLORS.ink3,
    lineHeight: 1.45,
  },

  // PO signature block (two side-by-side columns, rendered below either
  // the terms block or the totals box).
  signatureWrap: {
    marginTop: 26,
    flexDirection: 'row',
    gap: 32,
  },
  signatureCol: {
    flex: 1,
  },
  signatureCaption: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    letterSpacing: 0.6,
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    marginBottom: 22, // leaves room for a hand-signed pen stroke
  },
  signatureLine: {
    width: 180,
    borderBottomWidth: 0.7,
    borderBottomColor: PDF_COLORS.ink2,
    borderBottomStyle: 'solid',
  },
  signatureMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    width: 180,
  },
  signatureMeta: {
    fontSize: 8,
    color: PDF_COLORS.ink3,
  },

  // DRAFT watermark — rendered first in the page tree so it sits
  // beneath later siblings. `transform: rotate(...)` is supported in
  // @react-pdf/render 4.5.x. Letter page is 612x792pt; we span the
  // full width and rely on `textAlign: center` to keep the word over
  // the page midline.
  watermarkWrap: {
    position: 'absolute',
    top: '40%',
    left: 0,
    right: 0,
    alignItems: 'center',
    transform: 'rotate(-30deg)',
  },
  watermarkText: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 96,
    color: PDF_COLORS.ink,
    opacity: 0.1,
    textAlign: 'center',
    letterSpacing: 4,
  },
});

/**
 * Currency / number formatters used inside the PDFs. We import format.ts
 * helpers everywhere else, but mirroring them here keeps the PDF render
 * path locale-agnostic and avoids dragging client-only modules into the
 * server bundle.
 */
export function formatCurrencyForPdf(
  amount: number,
  currency = 'USD',
  locale = 'en-US',
): string {
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

export function formatNumberForPdf(value: number, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * Format a date for the PDF body.
 *
 * Defaults to the en-US locale + America/Los_Angeles tz so PDFs render
 * the same date regardless of where the serverless container is
 * scheduled (Vercel runs in UTC; that surfaced as "yesterday" dates
 * for late-night PT exports). Callers can pass an explicit timezone
 * once org-level tz settings ship.
 */
export function formatDateForPdf(
  input: Date | string | null | undefined,
  timeZone: string = 'America/Los_Angeles',
): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone,
  });
}
