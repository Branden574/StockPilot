import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import type { InventoryExportField } from '@/lib/exports/field-registry';
import type { ExportPdfLayout } from '@/lib/exports/pdf-layout';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

import { BrandedHeader } from './branding';
import { REPORT_CELL_PADDING_PT, REPORT_IMAGE_COL_GAP_PT } from './column-fit';
import { pdfStyles, PDF_COLORS } from './styles';

/**
 * The inventory / books EXPORT document.
 *
 * Why this is not report-table.tsx: that component is shared by seven live
 * report sections (/api/reports/[slug]/pdf), and everything this document needs
 * — variable page size and orientation, rows that grow with an image, repeated
 * headers, page numbers, a catalog card layout — would be a behaviour change
 * for all of them. This is a second DOCUMENT, not a second export pipeline: the
 * route, the row builder, the field registry and the column-fitting primitive
 * are all shared.
 */

export const EXPORT_PDF_EM_DASH = '—';

export interface InventoryExportPdfRow {
  /** Column key to already-formatted string. Never null, never undefined. */
  cells: Record<string, string>;
  imageUrl: string | null;
}

export interface InventoryExportCatalogOptions {
  columns: 1 | 2 | 3;
  /** Fields rendered as label/value lines inside each card, in order. */
  fields: readonly InventoryExportField[];
  itemTypeKind: 'book' | 'other';
}

export interface InventoryExportPdfProps {
  orgName: string;
  orgLogoUrl: string | null;
  title: string;
  subtitle: string;
  layout: ExportPdfLayout;
  rows: InventoryExportPdfRow[];
  repeatHeaders: boolean;
  pageNumbers: boolean;
  footerNote?: string;
  /** Set for the book catalog layout; null for the table layout. */
  catalog?: InventoryExportCatalogOptions | null;
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
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: PDF_COLORS.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    // The gutter. Without it two header labels render edge to edge — the
    // "ON HANDCATEGORY" defect.
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.line,
    borderBottomStyle: 'solid',
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  cell: {
    fontSize: 8.5,
    color: PDF_COLORS.ink,
    paddingHorizontal: REPORT_CELL_PADDING_PT,
  },
  cellRight: { textAlign: 'right' },
  cellCenter: { textAlign: 'center' },
  imageCell: {
    marginRight: REPORT_IMAGE_COL_GAP_PT,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    // contain, NOT cover: a book cover is portrait and cropping it to a square
    // cuts the title off. Aspect ratio is preserved inside the box.
    objectFit: 'contain',
    borderRadius: 2,
  },
  thumbPlaceholder: {
    backgroundColor: PDF_COLORS.bgSunk,
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: PDF_COLORS.line,
    borderStyle: 'solid',
  },
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

function alignStyle(align: 'left' | 'right' | 'center') {
  if (align === 'right') return styles.cellRight;
  if (align === 'center') return styles.cellCenter;
  return {};
}

/**
 * Format one source row into the strings the document prints.
 *
 * Blank -> em dash. A real 0 or false prints as itself: the export must not
 * turn "zero on hand" into "unknown".
 */
export function buildExportPdfRows(
  rows: readonly InventoryExportSourceRow[],
  // Unused today — cell formatting doesn't yet consult column width/wrap —
  // but part of the interface contract Task 10/13 build against (a future
  // per-column wrap decision would read it). Prefixed per this repo's
  // no-unused-vars convention (packages/config/eslint-preset.js) rather than
  // dropped from the signature.
  _layout: ExportPdfLayout,
  fields: readonly InventoryExportField[],
  opts: { showImages: boolean },
): InventoryExportPdfRow[] {
  const columnFields = fields.filter((f) => f.key !== 'image');
  return rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const field of columnFields) {
      const value = field.value(row);
      cells[field.key] =
        value === null || value === undefined || value === '' ? EXPORT_PDF_EM_DASH : String(value);
    }
    return {
      cells,
      imageUrl: opts.showImages ? (row.image?.thumbnailUrl ?? null) : null,
    };
  });
}

function TableHeader({ layout, fixed }: { layout: ExportPdfLayout; fixed: boolean }) {
  return (
    <View style={styles.headerRow} fixed={fixed}>
      {layout.imageColumnWidthPt > 0 ? (
        <View style={[styles.imageCell, { width: layout.imageColumnWidthPt }]} />
      ) : null}
      {layout.columns.map((col) => (
        <Text
          key={col.key}
          style={[
            styles.headerCell,
            { width: col.widthPt, flexGrow: 0, flexShrink: 0 },
            alignStyle(col.align),
          ]}
        >
          {col.label}
        </Text>
      ))}
    </View>
  );
}

function TableBody({ layout, rows }: { layout: ExportPdfLayout; rows: InventoryExportPdfRow[] }) {
  if (rows.length === 0) {
    return <Text style={styles.emptyState}>No items matched this export.</Text>;
  }
  return (
    <>
      {rows.map((row, idx) => (
        <View
          key={idx}
          // wrap={false} keeps a row whole: a cover image split across a page
          // break renders as two half-images.
          wrap={false}
          data-row
          style={[
            styles.row,
            { minHeight: layout.rowHeightPt, paddingVertical: layout.rowPaddingPt },
          ]}
        >
          {layout.imageColumnWidthPt > 0 ? (
            <View
              style={[
                styles.imageCell,
                { width: layout.imageColumnWidthPt, height: layout.imageBoxPt.heightPt },
              ]}
            >
              {row.imageUrl ? (
                // eslint-disable-next-line jsx-a11y/alt-text
                <Image
                  src={row.imageUrl}
                  style={[
                    styles.thumb,
                    { width: layout.imageBoxPt.widthPt, height: layout.imageBoxPt.heightPt },
                  ]}
                />
              ) : (
                <View
                  data-placeholder
                  style={[
                    styles.thumbPlaceholder,
                    { width: layout.imageBoxPt.widthPt, height: layout.imageBoxPt.heightPt },
                  ]}
                />
              )}
            </View>
          ) : null}
          {layout.columns.map((col) => (
            <Text
              key={col.key}
              style={[
                styles.cell,
                { width: col.widthPt, flexGrow: 0, flexShrink: 0 },
                alignStyle(col.align),
              ]}
            >
              {row.cells[col.key] ?? EXPORT_PDF_EM_DASH}
            </Text>
          ))}
        </View>
      ))}
    </>
  );
}

/** Replaced by the real card grid in the catalog task. */
function CatalogBody({
  layout,
  rows,
}: {
  layout: ExportPdfLayout;
  rows: InventoryExportPdfRow[];
  catalog: InventoryExportCatalogOptions;
}) {
  return (
    <View style={styles.table}>
      <TableHeader layout={layout} fixed={false} />
      <TableBody layout={layout} rows={rows} />
    </View>
  );
}

export function InventoryExportPdf({
  orgName,
  orgLogoUrl,
  title,
  subtitle,
  layout,
  rows,
  repeatHeaders,
  pageNumbers,
  footerNote,
  catalog,
}: InventoryExportPdfProps) {
  return (
    <Document>
      <Page
        // An explicit {width, height} rather than size="LETTER" + orientation:
        // the layout engine already resolved both, and passing the resolved
        // numbers means the geometry the fit test asserted is the geometry
        // react-pdf lays out.
        size={{ width: layout.pageWidthPt, height: layout.pageHeightPt }}
        style={pdfStyles.page}
      >
        <BrandedHeader
          orgName={orgName}
          orgLogoUrl={orgLogoUrl}
          title={title}
          subtitle={subtitle}
        />
        {catalog ? (
          // Called directly rather than used as `<CatalogBody .../>` JSX: no
          // actual React renderer runs in this repo's element-tree unit
          // tests (inventory-export-pdf.test.tsx walks the plain object
          // graph react-pdf would otherwise reconcile), so a JSX-tag usage
          // would leave CatalogBody's own View/Text output behind an opaque,
          // un-walked component reference. Calling it produces the identical
          // tree react-pdf renders either way — these are plain presentational
          // functions with no hooks or component identity to preserve.
          CatalogBody({ layout, rows, catalog })
        ) : (
          <View style={styles.table}>
            {TableHeader({ layout, fixed: repeatHeaders })}
            {TableBody({ layout, rows })}
          </View>
        )}
        {footerNote ? <Text style={styles.footerNote}>{footerNote}</Text> : null}
        {pageNumbers ? (
          <Text
            style={styles.pageNumber}
            fixed
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        ) : null}
      </Page>
    </Document>
  );
}
