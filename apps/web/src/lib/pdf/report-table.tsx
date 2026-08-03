import { Document, Image, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
import {
  fitColumnWidths,
  LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_IMAGE_COL_WIDTH_PT,
} from './column-fit';
import { pdfStyles, PDF_COLORS } from './styles';

/**
 * Reusable report-table PDF renderer. All `/api/reports/[slug]/pdf`
 * routes feed their slug-specific data into this single component so
 * every report ends up with a consistent header, table style, and
 * pagination behavior.
 *
 * For per-item reports (inventory-valuation, reorder-forecast,
 * dead-stock, velocity-class, bundle-shortages, stock-movements'
 * top-movers section), each row can include a small thumbnail —
 * primary item image signed URL from ItemImagesService. Rows without
 * an image render an empty placeholder cell so column widths stay
 * consistent.
 *
 * Aggregate reports without item-level rows (supplier-scorecard,
 * shrinkage totals, bundle-activity) just omit the image column.
 */

export type ReportColumnAlign = 'left' | 'right' | 'center';

export interface ReportColumn {
  /** Key used to look up the cell value in each row. */
  key: string;
  /** Header label shown at the top of the column. */
  label: string;
  /** Default 'left'. Number columns should use 'right'. */
  align?: ReportColumnAlign;
  /** Relative weight. Decides how SURPLUS width is shared once every
   *  column's minWidth is satisfied. Default 1 for every unset column. */
  width?: number;
  /** Hard floor in POINTS. Without one, a low-weight column can be squeezed
   *  until its header overlaps its neighbour — which is exactly how the Books
   *  export shipped "ON HANDCATEGORY". Optional so the seven existing report
   *  sections keep their current behaviour untouched. */
  minWidth?: number;
  /** Ceiling in POINTS. A 3-digit quantity gains nothing from a 120pt box. */
  maxWidth?: number;
  /** Default true. False documents that the column carries an identifier
   *  (SKU, ISBN, barcode) that must never be broken across lines — enforced by
   *  giving it a minWidth wide enough for its worst case, since @react-pdf has
   *  no no-wrap flag. */
  wrap?: boolean;
}

export interface ReportRow {
  /** Map column.key → cell value. Numbers + strings render as text. */
  cells: Record<string, string | number | null | undefined>;
  /** Optional signed URL of the item's primary thumbnail. When set
   *  AND the section has imageColumn enabled, renders a 22pt-wide
   *  image cell on the LEFT of the row. */
  imageUrl?: string | null;
}

export interface ReportSection {
  /** Optional section title shown above the table. */
  title?: string;
  /** Optional one-line caption below the title. */
  caption?: string;
  /** Column definitions in left-to-right order. */
  columns: ReportColumn[];
  /** Data rows. */
  rows: ReportRow[];
  /** Show the image column? Default false. When true the renderer
   *  reserves a 22pt-wide cell at the LEFT for each row.imageUrl. */
  imageColumn?: boolean;
}

export interface ReportTablePdfProps {
  orgName: string;
  orgLogoUrl: string | null;
  /** Document title — e.g. "Inventory valuation". */
  title: string;
  /** Optional subtitle — e.g. "Last 30 days" / "as of 2026-05-18". */
  subtitle?: string;
  /** One or more sections. Most reports have one; stock-movements has two. */
  sections: ReportSection[];
  /** Footer note printed below the last section (e.g. row totals). */
  footerNote?: string;
  /** Inner row width in points. Defaults to the landscape-LETTER page this
   *  component renders (792 - 80 page padding - 8 row padding = 704). Exposed
   *  so a caller on a different page size can hand the allocator the truth. */
  contentWidthPt?: number;
}

// ── Styles ───────────────────────────────────────────────────────────

const IMAGE_COL_WIDTH = REPORT_IMAGE_COL_WIDTH_PT;

/** reportStyles.headerCell font size, exported so the fit test measures the
 *  same number the renderer uses instead of a copy that can drift. */
export const REPORT_HEADER_FONT_SIZE_PT = 8;
/** reportStyles.headerCell letterSpacing, same reason. */
export const REPORT_HEADER_LETTER_SPACING_PT = 0.4;

const reportStyles = StyleSheet.create({
  sectionWrap: {
    marginTop: 12,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink,
    marginBottom: 2,
  },
  sectionCaption: {
    fontSize: 8.5,
    color: PDF_COLORS.ink3,
    marginBottom: 6,
  },
  table: {
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.lineStrong,
    borderTopStyle: 'solid',
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: PDF_COLORS.bgSunk,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.lineStrong,
    borderBottomStyle: 'solid',
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  headerCell: {
    fontSize: REPORT_HEADER_FONT_SIZE_PT,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: REPORT_HEADER_LETTER_SPACING_PT,
    // THE HEADER COLLISION FIX. The body `cell` style has carried
    // paddingHorizontal: 3 since day one; the header cell had none, so two
    // adjacent header labels rendered edge to edge and "ON HAND" + "CATEGORY"
    // printed as "ON HANDCATEGORY". Matching the body padding gives every
    // header a 6pt gutter from its neighbour AND keeps header text aligned
    // with the body text underneath it.
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.line,
    borderBottomStyle: 'solid',
    paddingVertical: 4,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  cell: {
    fontSize: 8.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: 3,
  },
  cellRight: { textAlign: 'right' },
  cellCenter: { textAlign: 'center' },
  imageCell: {
    width: IMAGE_COL_WIDTH,
    marginRight: REPORT_IMAGE_COL_GAP_PT,
    flexShrink: 0,
  },
  thumb: {
    width: IMAGE_COL_WIDTH,
    height: IMAGE_COL_WIDTH,
    objectFit: 'cover',
    borderRadius: 2,
  },
  thumbPlaceholder: {
    width: IMAGE_COL_WIDTH,
    height: IMAGE_COL_WIDTH,
    backgroundColor: PDF_COLORS.bgSunk,
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.line,
    borderStyle: 'solid',
  },
  footerNote: {
    marginTop: 8,
    fontSize: 8,
    color: PDF_COLORS.ink3,
    fontStyle: 'italic',
  },
});

// ── Helpers ──────────────────────────────────────────────────────────

function alignStyle(align: ReportColumnAlign | undefined) {
  // Return an empty object rather than null so the consumer can spread
  // / pass to the Style array without tripping @react-pdf/renderer's
  // typed style schema (which doesn't accept null).
  if (align === 'right') return reportStyles.cellRight;
  if (align === 'center') return reportStyles.cellCenter;
  return {};
}

function renderCellValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

// ── Section ─────────────────────────────────────────────────────────

function SectionView({
  section,
  contentWidthPt,
}: {
  section: ReportSection;
  contentWidthPt: number;
}) {
  const showImages = !!section.imageColumn;
  // Explicit point widths, not flex ratios: yoga's ratio split has no floor, so
  // a low-weight column could be squeezed until its header overlapped the next
  // one. fitColumnWidths honours each column's minWidth and only shares the
  // surplus by weight. Columns with no minWidth (every existing report) get
  // exactly the proportional split they had before.
  const available =
    contentWidthPt - (showImages ? IMAGE_COL_WIDTH + REPORT_IMAGE_COL_GAP_PT : 0);
  const widths = fitColumnWidths(section.columns, available);

  return (
    <View style={reportStyles.sectionWrap}>
      {section.title ? <Text style={reportStyles.sectionTitle}>{section.title}</Text> : null}
      {section.caption ? <Text style={reportStyles.sectionCaption}>{section.caption}</Text> : null}

      <View style={reportStyles.table}>
        {/* Header row */}
        <View style={reportStyles.headerRow}>
          {showImages ? <View style={reportStyles.imageCell} /> : null}
          {section.columns.map((col, i) => (
            <Text
              key={col.key}
              style={[
                reportStyles.headerCell,
                { width: widths[i] ?? 0, flexGrow: 0, flexShrink: 0 },
                alignStyle(col.align),
              ]}
            >
              {col.label}
            </Text>
          ))}
        </View>

        {/* Body rows */}
        {section.rows.length === 0 ? (
          <View style={reportStyles.row}>
            <Text style={[reportStyles.cell, { flex: 1, color: PDF_COLORS.ink4 }]}>
              No data for this period.
            </Text>
          </View>
        ) : (
          section.rows.map((row, idx) => (
            <View key={idx} style={reportStyles.row} wrap={false}>
              {showImages ? (
                <View style={reportStyles.imageCell}>
                  {row.imageUrl ? (
                    // eslint-disable-next-line jsx-a11y/alt-text
                    <Image src={row.imageUrl} style={reportStyles.thumb} />
                  ) : (
                    <View style={reportStyles.thumbPlaceholder} />
                  )}
                </View>
              ) : null}
              {section.columns.map((col, i) => (
                <Text
                  key={col.key}
                  style={[
                    reportStyles.cell,
                    { width: widths[i] ?? 0, flexGrow: 0, flexShrink: 0 },
                    alignStyle(col.align),
                  ]}
                >
                  {renderCellValue(row.cells[col.key])}
                </Text>
              ))}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// ── Document ────────────────────────────────────────────────────────

export function ReportTablePdf({
  orgName,
  orgLogoUrl,
  title,
  subtitle,
  sections,
  footerNote,
  contentWidthPt = LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
}: ReportTablePdfProps) {
  return (
    <Document>
      <Page size="LETTER" style={pdfStyles.page} orientation="landscape">
        <BrandedHeader
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          title={title}
          subtitle={subtitle}
        />
        {sections.map((section, idx) => (
          <SectionView key={idx} section={section} contentWidthPt={contentWidthPt} />
        ))}
        {footerNote ? <Text style={reportStyles.footerNote}>{footerNote}</Text> : null}
      </Page>
    </Document>
  );
}
