import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import { PAPER_SIZE_PT } from '@/lib/exports/pdf-layout';
import {
  EXPORTABLE_ORDER_STATUSES,
  ORDER_EXPORT_HEADERS,
  orderExportCells,
  type OrderExportHeader,
} from '@/lib/orders/export';
import type { OrderExportRow } from '@/server/services/order-requests';

import { BrandedHeader } from './branding';
import {
  fitColumnWidths,
  REPORT_BODY_FONT_SIZE_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_PAGE_PADDING_PT,
  REPORT_ROW_PADDING_PT,
  type FitColumn,
} from './column-fit';
import { safeWidth } from './helvetica-metrics';
import { pdfStyles, PDF_COLORS } from './styles';

/**
 * The order-history EXPORT document — the PDF twin of GET /api/orders/
 * export.csv. Same columns, same order, same header labels, same cell
 * formatting (lib/orders/export.ts is the single source for all of that);
 * this module only decides geometry and typography.
 *
 * Column sizing note: computeExportPdfLayout (lib/exports/pdf-layout.ts) is
 * NOT reused here because its input shape doesn't fit — it consumes
 * `InventoryExportField[]` whose `key` is the closed InventoryExportFieldKey
 * union and whose `value()` takes an InventoryExportSourceRow, neither of
 * which an order column can satisfy without lying to the type system. What IS
 * shared is everything beneath it: the same `fitColumnWidths` allocator, the
 * same REPORT_* typographic constants, the same Helvetica metric table and
 * the same PAPER_SIZE_PT geometry — imported, not copied.
 *
 * No image column anywhere in this document: the order history is pure
 * tabular data, so the WebP-in-react-pdf landmine (WebP thumbnails render
 * blank in @react-pdf) does not apply here.
 */

/**
 * Landscape LEGAL, fixed. 14 columns is past the house readability threshold
 * for Letter (TOO_MANY_COLUMNS_THRESHOLD = 12, whose own remedy text says
 * "use Legal paper"), and the measured header floors below sum past
 * Letter-landscape's 704pt content width — Legal-landscape's 920pt is the
 * smallest standard page where every column clears its floor.
 */
export const ORDERS_PDF_PAGE_PT = PAPER_SIZE_PT.legal.landscape;
export const ORDERS_PDF_CONTENT_WIDTH_PT =
  ORDERS_PDF_PAGE_PT.widthPt - REPORT_PAGE_PADDING_PT * 2 - REPORT_ROW_PADDING_PT * 2;

export const ORDERS_PDF_EM_DASH = '—';

/** Same size the inventory export document uses for its table headings. */
const HEADER_FONT_SIZE_PT = 8;

/** A column never renders narrower than its own heading. */
function headerFloorPt(label: string): number {
  return (
    Math.ceil(safeWidth(label, 'Helvetica-Bold', HEADER_FONT_SIZE_PT)) +
    REPORT_CELL_PADDING_PT * 2 +
    1
  );
}

function valueFloorPt(value: string): number {
  return (
    Math.ceil(safeWidth(value, 'Helvetica', REPORT_BODY_FONT_SIZE_PT)) +
    REPORT_CELL_PADDING_PT * 2 +
    1
  );
}

/** Widest status token the export can print (single-line status cells). */
const STATUS_FLOOR_PT = Math.max(
  ...[...EXPORTABLE_ORDER_STATUSES].map((s) => valueFloorPt(s)),
);

/**
 * One shared width for the three timestamp columns, so created/approved/
 * completed render identically instead of at whatever uneven widths the
 * surplus allocator happens to deal them. Sized to the widest UNBREAKABLE
 * fragment of the CSV's exact ISO format ("01T00:00:00.000Z" — react-pdf
 * line-breaks at the hyphens), so a full timestamp wraps into two clean
 * lines and can never paint over the neighbouring column.
 */
const DATE_COLUMN_PT = Math.max(
  valueFloorPt('01T00:00:00.000Z'),
  headerFloorPt('created_at'),
  headerFloorPt('approved_at'),
  headerFloorPt('completed_at'),
);

interface OrdersPdfColumnSpec {
  key: OrderExportHeader;
  align: 'left' | 'right';
  /** Relative share of surplus width (fitColumnWidths weight). */
  weight: number;
  minWidthPt: number;
  maxWidthPt?: number;
}

/** Numeric columns right-aligned, everything else left — same convention as
 *  the inventory registry's align rules. */
const COLUMN_SPECS: readonly OrdersPdfColumnSpec[] = ORDER_EXPORT_HEADERS.map(
  (key): OrdersPdfColumnSpec => {
    const header = headerFloorPt(key);
    switch (key) {
      case 'order_number':
        return { key, align: 'left', weight: 0.3, minWidthPt: header, maxWidthPt: header + 8 };
      case 'requester':
        return { key, align: 'left', weight: 1.2, minWidthPt: header };
      case 'requester_email':
        return { key, align: 'left', weight: 1.6, minWidthPt: header };
      case 'charter_destination':
        return { key, align: 'left', weight: 1.4, minWidthPt: header };
      case 'warehouse':
        return { key, align: 'left', weight: 0.9, minWidthPt: header };
      case 'status':
        // Single-line statuses: floor at the widest real status token.
        return { key, align: 'left', weight: 0.4, minWidthPt: Math.max(header, STATUS_FLOOR_PT) };
      case 'fulfillment_type':
      case 'source':
        return { key, align: 'left', weight: 0.3, minWidthPt: header, maxWidthPt: header + 12 };
      case 'line_count':
      case 'total_quantity':
      case 'total_cost':
        return { key, align: 'right', weight: 0.2, minWidthPt: header, maxWidthPt: header + 12 };
      case 'created_at':
      case 'approved_at':
      case 'completed_at':
        // Fixed and identical for all three (min == max): the ISO value
        // wraps at its hyphens into two lines inside DATE_COLUMN_PT.
        return { key, align: 'left', weight: 0, minWidthPt: DATE_COLUMN_PT, maxWidthPt: DATE_COLUMN_PT };
    }
  },
);

export interface OrdersPdfColumn {
  key: OrderExportHeader;
  /** The CSV header string, verbatim — format parity over prettiness. */
  label: string;
  align: 'left' | 'right';
  widthPt: number;
}

export function computeOrdersExportPdfColumns(): OrdersPdfColumn[] {
  const fit: FitColumn[] = COLUMN_SPECS.map((s) => ({
    key: s.key,
    width: s.weight,
    minWidth: s.minWidthPt,
    maxWidth: s.maxWidthPt,
  }));
  const widths = fitColumnWidths(fit, ORDERS_PDF_CONTENT_WIDTH_PT);
  return COLUMN_SPECS.map((s, i) => ({
    key: s.key,
    label: s.key,
    align: s.align,
    widthPt: widths[i] ?? 0,
  }));
}

/**
 * Cells the document prints, already formatted by the shared cell formatter.
 * Blank -> em dash (the house PDF blank convention — the CSV leaves the cell
 * empty, which in a printed table reads as a missing cell rather than a
 * deliberately-empty one). A real 0 prints as itself.
 */
export function buildOrdersExportPdfRows(
  rows: readonly OrderExportRow[],
): Array<Record<OrderExportHeader, string>> {
  return rows.map((row) => {
    const cells = orderExportCells(row);
    const out = {} as Record<OrderExportHeader, string>;
    for (const key of ORDER_EXPORT_HEADERS) {
      const value = cells[key];
      out[key] =
        value === null || value === undefined || value === ''
          ? ORDERS_PDF_EM_DASH
          : String(value);
    }
    return out;
  });
}

const styles = StyleSheet.create({
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
    fontSize: HEADER_FONT_SIZE_PT,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    // No textTransform/letterSpacing here, unlike the inventory document's
    // headings: these labels are the CSV's snake_case column names verbatim
    // (an unbreakable token each), and uppercase + tracking pushes their
    // measured sum past even Legal-landscape's content width — the
    // "ON HANDCATEGORY" header-collision defect all over again.
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.line,
    borderBottomStyle: 'solid',
    paddingHorizontal: 4,
    paddingVertical: 3,
    alignItems: 'center',
  },
  cell: {
    fontSize: REPORT_BODY_FONT_SIZE_PT,
    color: PDF_COLORS.ink,
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  cellRight: { textAlign: 'right' },
  emptyState: {
    fontSize: 9,
    color: PDF_COLORS.ink4,
    paddingVertical: 12,
  },
  footerNote: {
    marginTop: 8,
    fontSize: 8,
    color: PDF_COLORS.ink3,
    fontStyle: 'italic',
  },
  pageNumber: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    textAlign: 'center',
    fontSize: 8,
    color: PDF_COLORS.ink4,
  },
});

export interface OrdersExportPdfProps {
  orgName: string;
  orgLogoUrl: string | null;
  /** "Order requests — <view label>" — composed by the route. */
  title: string;
  subtitle: string;
  rows: Array<Record<OrderExportHeader, string>>;
  /** Truncation sentinel, when the row cap was hit. */
  footerNote?: string;
}

export function OrdersExportPdf({
  orgName,
  orgLogoUrl,
  title,
  subtitle,
  rows,
  footerNote,
}: OrdersExportPdfProps) {
  const columns = computeOrdersExportPdfColumns();
  return (
    <Document>
      <Page
        size={{ width: ORDERS_PDF_PAGE_PT.widthPt, height: ORDERS_PDF_PAGE_PT.heightPt }}
        style={pdfStyles.page}
      >
        <BrandedHeader
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          title={title}
          subtitle={subtitle}
        />
        <View style={styles.table}>
          <View style={styles.headerRow} fixed>
            {columns.map((col) => (
              <Text
                key={col.key}
                style={[
                  styles.headerCell,
                  { width: col.widthPt, flexGrow: 0, flexShrink: 0 },
                  col.align === 'right' ? styles.cellRight : {},
                ]}
              >
                {col.label}
              </Text>
            ))}
          </View>
          {rows.length === 0 ? (
            <Text style={styles.emptyState}>No order requests in this view.</Text>
          ) : (
            rows.map((row, idx) => (
              // wrap={false} keeps a row whole across page breaks.
              <View key={idx} wrap={false} style={styles.row}>
                {columns.map((col) => (
                  <Text
                    key={col.key}
                    style={[
                      styles.cell,
                      { width: col.widthPt, flexGrow: 0, flexShrink: 0 },
                      col.align === 'right' ? styles.cellRight : {},
                    ]}
                  >
                    {row[col.key]}
                  </Text>
                ))}
              </View>
            ))
          )}
        </View>
        {footerNote ? <Text style={styles.footerNote}>{footerNote}</Text> : null}
        <Text
          style={styles.pageNumber}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
        />
      </Page>
    </Document>
  );
}
