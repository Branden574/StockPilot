import { Document, Image, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import { BrandedHeader } from './branding';
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
  /** Relative width unit. Sums across columns and divides the available
   *  table width. Default 1 for every unset column. */
  width?: number;
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
}

// ── Styles ───────────────────────────────────────────────────────────

const IMAGE_COL_WIDTH = 22; // pt

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
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
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
    marginRight: 4,
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

function flexForColumn(col: ReportColumn): number {
  return col.width ?? 1;
}

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

function SectionView({ section }: { section: ReportSection }) {
  const showImages = !!section.imageColumn;
  const totalFlex = section.columns.reduce((sum, c) => sum + flexForColumn(c), 0);

  return (
    <View style={reportStyles.sectionWrap}>
      {section.title ? <Text style={reportStyles.sectionTitle}>{section.title}</Text> : null}
      {section.caption ? <Text style={reportStyles.sectionCaption}>{section.caption}</Text> : null}

      <View style={reportStyles.table}>
        {/* Header row */}
        <View style={reportStyles.headerRow}>
          {showImages ? <View style={reportStyles.imageCell} /> : null}
          {section.columns.map((col) => (
            <Text
              key={col.key}
              style={[
                reportStyles.headerCell,
                { flex: flexForColumn(col) / totalFlex },
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
              {section.columns.map((col) => (
                <Text
                  key={col.key}
                  style={[
                    reportStyles.cell,
                    { flex: flexForColumn(col) / totalFlex },
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
          <SectionView key={idx} section={section} />
        ))}
        {footerNote ? <Text style={reportStyles.footerNote}>{footerNote}</Text> : null}
      </Page>
    </Document>
  );
}
