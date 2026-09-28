import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import {
  BOOK_REPORT_EMPTY,
  BOOK_REPORT_HOW_COUNTED,
  BOOK_REPORT_METRICS,
  BOOK_REPORT_TITLE,
  bookReportRowBadges,
  copiesRequestedText,
  entriesCountText,
  formatBookReportIdentityLine,
  formatReportDate,
  formatReportDateTime,
  formatReportQuantity,
  ordersCountText,
  bookReportUnitLabel,
  type BookReportRow,
} from '@stockpilot/core';

import { REPORT_CELL_PADDING_PT } from './column-fit';
import { pdfStyles, PDF_COLORS } from './styles';

/**
 * The Book Order Totals PDF (Letter portrait).
 *
 * Its own document on the inventory-export patterns (a header row that
 * repeats on every page, rows that never split, "Page N of M", covers in a
 * portrait box with objectFit contain so a title is never cropped), because
 * ReportTablePdf has no repeated header, no page numbers and crops its
 * images square, and it is shared by every live report. The shared styles
 * and Helvetica metrics are reused.
 *
 * Every row and total is printed. Covers are bounded (the route embeds at
 * most BOOK_REPORT_PDF_COVER_CAP, downscaled); a missing cover is a
 * placeholder and the disclosure says how many and why.
 */

export const BOOK_PDF_PAGE_PT = { width: 612, height: 792 } as const;
const PAGE_PADDING_PT = 40;
export const BOOK_PDF_CONTENT_WIDTH_PT = BOOK_PDF_PAGE_PT.width - PAGE_PADDING_PT * 2;
/** Horizontal padding inside a table row (both sides). */
export const BOOK_PDF_ROW_PADDING_PT = 4;
/** The cover box: portrait 2:3, contain. */
export const BOOK_PDF_COVER_BOX_PT = { width: 36, height: 54 } as const;
export const BOOK_PDF_HEADER_FONT_SIZE_PT = 8;
export const BOOK_PDF_HEADER_LETTER_SPACING_PT = 0.4;
/** Longest title printed in full; longer ones are cut with an ellipsis so a
 *  row stays within about three lines. */
export const BOOK_PDF_TITLE_MAX_CHARS = 160;

export interface BookPdfColumn {
  key: 'cover' | 'book' | 'copies' | 'orders' | 'latest';
  label: string;
  widthPt: number;
  align: 'left' | 'right';
}

/** The table's columns for a document with or without covers. The Book
 *  column takes whatever the fixed columns leave. */
export function bookPdfColumns(photos: boolean): BookPdfColumn[] {
  const fixed: BookPdfColumn[] = [
    { key: 'copies', label: 'Copies requested', widthPt: 104, align: 'right' },
    { key: 'orders', label: 'Orders', widthPt: 56, align: 'right' },
    { key: 'latest', label: 'Latest order', widthPt: 84, align: 'left' },
  ];
  const cover: BookPdfColumn = { key: 'cover', label: '', widthPt: 44, align: 'left' };
  const used = fixed.reduce((sum, c) => sum + c.widthPt, 0) + (photos ? cover.widthPt : 0);
  const book: BookPdfColumn = {
    key: 'book',
    label: 'Book',
    widthPt: BOOK_PDF_CONTENT_WIDTH_PT - BOOK_PDF_ROW_PADDING_PT * 2 - used,
    align: 'left',
  };
  return photos ? [cover, book, ...fixed] : [book, ...fixed];
}

export interface BookPdfRow {
  row: BookReportRow;
  /** A data: URI (downscaled JPEG/PNG), or null for the placeholder. */
  cover: string | null;
}

export interface BookOrderTotalsPdfProps {
  orgName: string;
  /** A data: URI fetched by the route, or null (the name alone is shown). */
  orgLogo: string | null;
  generatedAtLocal: string;
  timeZone: string;
  /** Scope lines, already worded (range, status, warehouse, ...). */
  scopeLines: string[];
  summary: { copies: string; entries: number; orders: number };
  /** Extra summary lines (the other-unit disclosure). */
  summaryNotes: string[];
  /** The cover disclosure ("Covers shown for ..." / "Exported without covers."). */
  coverNote: string;
  photos: boolean;
  rows: BookPdfRow[];
}

const styles = StyleSheet.create({
  scopeLine: { fontSize: 8.5, color: PDF_COLORS.ink2, marginBottom: 2 },
  summaryBox: {
    flexDirection: 'row',
    marginTop: 10,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.lineStrong,
    borderStyle: 'solid',
    borderRadius: 3,
  },
  metric: { flexGrow: 1, flexBasis: 0, padding: 8 },
  metricDivider: {
    borderLeftWidth: 0.5,
    borderLeftColor: PDF_COLORS.line,
    borderLeftStyle: 'solid',
  },
  metricLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  metricValue: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.ink, marginTop: 3 },
  metricDefinition: { fontSize: 7, color: PDF_COLORS.ink3, marginTop: 3 },
  note: { fontSize: 8, color: PDF_COLORS.ink3, marginBottom: 2 },
  table: {
    marginTop: 8,
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
    paddingHorizontal: BOOK_PDF_ROW_PADDING_PT,
  },
  headerCell: {
    fontSize: BOOK_PDF_HEADER_FONT_SIZE_PT,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: BOOK_PDF_HEADER_LETTER_SPACING_PT,
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.line,
    borderBottomStyle: 'solid',
    paddingHorizontal: BOOK_PDF_ROW_PADDING_PT,
    paddingVertical: 4,
    alignItems: 'center',
    minHeight: BOOK_PDF_COVER_BOX_PT.height + 8,
  },
  cell: { fontSize: 8.5, color: PDF_COLORS.ink, paddingHorizontal: REPORT_CELL_PADDING_PT },
  cellRight: { textAlign: 'right' },
  bookTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.ink },
  bookMeta: { fontSize: 7.5, color: PDF_COLORS.ink3, marginTop: 2 },
  badge: { fontSize: 7, color: PDF_COLORS.ink2, marginTop: 2, fontFamily: 'Helvetica-Bold' },
  unitNote: {
    fontSize: 7,
    color: PDF_COLORS.ink3,
    textAlign: 'right',
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  coverCell: { alignItems: 'center', justifyContent: 'center' },
  cover: { objectFit: 'contain' },
  coverPlaceholder: {
    backgroundColor: PDF_COLORS.bgSunk,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.line,
    borderStyle: 'solid',
    borderRadius: 2,
  },
  empty: { fontSize: 9, color: PDF_COLORS.ink4, paddingVertical: 12 },
  grandTotal: { marginTop: 10, fontSize: 10, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.ink },
  howTitle: { marginTop: 16, fontSize: 9, fontFamily: 'Helvetica-Bold', color: PDF_COLORS.ink },
  howItem: { fontSize: 7.5, color: PDF_COLORS.ink2, marginTop: 2 },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: PAGE_PADDING_PT,
    right: PAGE_PADDING_PT,
    textAlign: 'center',
    fontSize: 7.5,
    color: PDF_COLORS.ink4,
  },
});

/** A title cut to BOOK_PDF_TITLE_MAX_CHARS with an ellipsis. */
export function pdfTitle(name: string): string {
  const s = name.trim();
  return s.length <= BOOK_PDF_TITLE_MAX_CHARS
    ? s
    : `${s.slice(0, BOOK_PDF_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

function TableHeader({ columns }: { columns: BookPdfColumn[] }) {
  return (
    <View style={styles.headerRow} fixed>
      {columns.map((c) => (
        <Text
          key={c.key}
          style={[
            styles.headerCell,
            { width: c.widthPt },
            c.align === 'right' ? styles.cellRight : {},
          ]}
        >
          {c.label}
        </Text>
      ))}
    </View>
  );
}

function BookRow({ item, columns }: { item: BookPdfRow; columns: BookPdfColumn[] }) {
  const { row } = item;
  const badges = bookReportRowBadges(row);
  const identity = formatBookReportIdentityLine(row);
  return (
    <View style={styles.row} wrap={false} data-row>
      {columns.map((c) => {
        switch (c.key) {
          case 'cover':
            return (
              <View key={c.key} style={[styles.coverCell, { width: c.widthPt }]}>
                {item.cover ? (
                  // eslint-disable-next-line jsx-a11y/alt-text
                  <Image
                    src={item.cover}
                    style={[
                      styles.cover,
                      { width: BOOK_PDF_COVER_BOX_PT.width, height: BOOK_PDF_COVER_BOX_PT.height },
                    ]}
                  />
                ) : (
                  <View
                    data-placeholder
                    style={[
                      styles.coverPlaceholder,
                      { width: BOOK_PDF_COVER_BOX_PT.width, height: BOOK_PDF_COVER_BOX_PT.height },
                    ]}
                  />
                )}
              </View>
            );
          case 'book':
            return (
              <View
                key={c.key}
                style={{ width: c.widthPt, paddingHorizontal: REPORT_CELL_PADDING_PT }}
              >
                <Text style={styles.bookTitle}>{pdfTitle(row.name)}</Text>
                {identity ? <Text style={styles.bookMeta}>{identity}</Text> : null}
                {badges.length > 0 ? <Text style={styles.badge}>{badges.join(' · ')}</Text> : null}
              </View>
            );
          case 'copies':
            return (
              <View key={c.key} style={{ width: c.widthPt }}>
                <Text style={[styles.cell, styles.cellRight]}>
                  {formatReportQuantity(row.copies)}
                </Text>
                {row.countsAsCopies ? null : (
                  <Text style={styles.unitNote}>{bookReportUnitLabel(row.unit)}</Text>
                )}
              </View>
            );
          case 'orders':
            return (
              <Text key={c.key} style={[styles.cell, styles.cellRight, { width: c.widthPt }]}>
                {row.orders.toLocaleString('en-US')}
              </Text>
            );
          case 'latest':
            return (
              <Text key={c.key} style={[styles.cell, { width: c.widthPt }]}>
                {formatReportDate(row.latestOrderDate)}
              </Text>
            );
        }
      })}
    </View>
  );
}

export function BookOrderTotalsPdf(props: BookOrderTotalsPdfProps) {
  const columns = bookPdfColumns(props.photos);
  const generated = formatReportDateTime(props.generatedAtLocal);
  const metrics = [
    {
      key: 'copies',
      ...BOOK_REPORT_METRICS.copies,
      value: copiesRequestedText(props.summary.copies),
    },
    {
      key: 'entries',
      ...BOOK_REPORT_METRICS.entries,
      value: props.summary.entries.toLocaleString('en-US'),
    },
    {
      key: 'orders',
      ...BOOK_REPORT_METRICS.orders,
      value: props.summary.orders.toLocaleString('en-US'),
    },
  ];
  return (
    <Document title={BOOK_REPORT_TITLE}>
      <Page
        size={{ width: BOOK_PDF_PAGE_PT.width, height: BOOK_PDF_PAGE_PT.height }}
        style={pdfStyles.page}
      >
        <View style={pdfStyles.headerWrap}>
          <View style={pdfStyles.headerLeft}>
            {props.orgLogo ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={props.orgLogo} style={pdfStyles.headerLogo} />
            ) : null}
            <View>
              <Text style={pdfStyles.headerOrgName}>{props.orgName}</Text>
              <Text style={pdfStyles.headerOrgMeta}>StockPilot</Text>
            </View>
          </View>
          <View style={pdfStyles.headerRight}>
            <Text style={pdfStyles.headerTitle}>{BOOK_REPORT_TITLE}</Text>
            <Text style={pdfStyles.headerSubtitle}>{`Generated ${generated}`}</Text>
            <Text style={pdfStyles.headerSubtitle}>{props.timeZone}</Text>
          </View>
        </View>

        {props.scopeLines.map((line, i) => (
          <Text key={`scope-${i}`} style={styles.scopeLine}>
            {line}
          </Text>
        ))}

        <View style={styles.summaryBox} wrap={false}>
          {metrics.map((m, i) => (
            <View
              key={m.key}
              style={i === 0 ? [styles.metric] : [styles.metric, styles.metricDivider]}
            >
              <Text style={styles.metricLabel}>{m.label}</Text>
              <Text style={styles.metricValue}>{m.value}</Text>
              <Text style={styles.metricDefinition}>{m.definition}</Text>
            </View>
          ))}
        </View>
        {props.summaryNotes.map((line, i) => (
          <Text key={`sn-${i}`} style={styles.note}>
            {line}
          </Text>
        ))}
        <Text style={styles.note}>{props.coverNote}</Text>

        <View style={styles.table}>
          {TableHeader({ columns })}
          {props.rows.length === 0 ? (
            <Text style={styles.empty}>{BOOK_REPORT_EMPTY}</Text>
          ) : (
            props.rows.map((item) => (
              <View key={item.row.itemId}>{BookRow({ item, columns })}</View>
            ))
          )}
        </View>

        <Text style={styles.grandTotal} wrap={false}>
          {`Grand total: ${copiesRequestedText(props.summary.copies)} in ${ordersCountText(props.summary.orders)} · ${entriesCountText(props.summary.entries)}.`}
        </Text>

        <Text style={styles.howTitle}>How this is counted</Text>
        {BOOK_REPORT_HOW_COUNTED.map((line, i) => (
          <Text key={`how-${i}`} style={styles.howItem}>
            {`• ${line}`}
          </Text>
        ))}

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${BOOK_REPORT_TITLE} · Generated ${generated} · Page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
