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
 * Fonts are intentionally limited to the @react-pdf builtins (Helvetica,
 * Helvetica-Bold, Courier). Registering external fonts at request time
 * causes serverless cold-start font-fetch failures, so we keep the set
 * minimal and rely on size + weight for hierarchy instead.
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

export function formatDateForPdf(input: Date | string | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}
