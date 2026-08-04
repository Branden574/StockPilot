import {
  fitColumnWidths,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_PAGE_PADDING_PT,
  REPORT_ROW_PADDING_PT,
  type FitColumn,
} from '@/lib/pdf/column-fit';

import { fieldHeading, type InventoryExportField } from './field-registry';

/**
 * PDF geometry for the export builder (Brief sections 11 and 13).
 *
 * Pure and client-safe: the dialog calls this to show the column-count warning
 * and the page estimate BEFORE generating anything, and the route calls the
 * same function to lay the document out. One implementation, so what the user
 * was warned about is what they get.
 *
 * The column-fitting order the brief specifies is followed literally:
 *   available width -> margins -> image column reserve -> field minimum widths
 *   -> weighted allocation of the surplus -> wrap long text -> warn when wide.
 */

export type PaperSize = 'letter' | 'legal';
export type PdfOrientation = 'portrait' | 'landscape';
export type PdfDensity = 'compact' | 'comfortable' | 'image-friendly';
export type ExportImageSize = 'small' | 'medium' | 'large';

export const PAPER_SIZE_PT: Record<
  PaperSize,
  Record<PdfOrientation, { widthPt: number; heightPt: number }>
> = {
  letter: {
    portrait: { widthPt: 612, heightPt: 792 },
    landscape: { widthPt: 792, heightPt: 612 },
  },
  legal: {
    portrait: { widthPt: 612, heightPt: 1008 },
    landscape: { widthPt: 1008, heightPt: 612 },
  },
};

/**
 * Image cell width and the row height it forces, per size tier. The row heights
 * are the brief's section 3.4 ranges (Small 24-28, Medium 38-44, Large 54-64)
 * at their upper bound, so a portrait book cover has real vertical room.
 */
export const IMAGE_CELL_PT: Record<ExportImageSize, { widthPt: number; rowHeightPt: number }> = {
  small: { widthPt: 22, rowHeightPt: 28 },
  medium: { widthPt: 34, rowHeightPt: 44 },
  large: { widthPt: 48, rowHeightPt: 64 },
};

export const DENSITY_PT: Record<PdfDensity, { rowPaddingPt: number; minRowHeightPt: number }> = {
  compact: { rowPaddingPt: 2, minRowHeightPt: 16 },
  comfortable: { rowPaddingPt: 4, minRowHeightPt: 20 },
  'image-friendly': { rowPaddingPt: 6, minRowHeightPt: 26 },
};

/** Vertical space the branded header block plus the table header row occupy. */
const HEADER_BLOCK_PT = 92;
const TABLE_HEADER_ROW_PT = 18;

/** Above this many columns a table stops being readable at 8.5pt. */
export const TOO_MANY_COLUMNS_THRESHOLD = 12;

/** Brief section 13, verbatim, with the real count substituted. */
export function tooManyColumnsWarning(count: number): string {
  return `This PDF contains ${count} columns and may be difficult to read. Remove fields, use Legal paper, or export to Excel for the complete dataset.`;
}

export interface ExportPdfColumn {
  key: string;
  label: string;
  align: 'left' | 'right' | 'center';
  widthPt: number;
  wrap: boolean;
}

export interface ExportPdfLayout {
  orientation: PdfOrientation;
  paperSize: PaperSize;
  pageWidthPt: number;
  pageHeightPt: number;
  /** Inner row width: page width minus page padding minus row padding. */
  contentWidthPt: number;
  /** 0 when images are off. */
  imageColumnWidthPt: number;
  /** The box an image is drawn into, objectFit contain. */
  imageBoxPt: { widthPt: number; heightPt: number };
  rowHeightPt: number;
  rowPaddingPt: number;
  columns: ExportPdfColumn[];
  warnings: string[];
  /** True when the minimums had to be scaled down to fit. Still renders. */
  overflow: boolean;
  estimatedRowsPerPage: number;
}

export interface ComputeExportPdfLayoutInput {
  fields: readonly InventoryExportField[];
  itemTypeKind: 'book' | 'other';
  includeImages: boolean;
  imageSize: ExportImageSize;
  orientation: 'auto' | PdfOrientation;
  paperSize: PaperSize;
  density: PdfDensity;
  wrapText: boolean;
  layout: 'table' | 'catalog';
  catalogColumns: 1 | 2 | 3;
}

function contentWidthFor(paperSize: PaperSize, orientation: PdfOrientation): number {
  return (
    PAPER_SIZE_PT[paperSize][orientation].widthPt -
    REPORT_PAGE_PADDING_PT * 2 -
    REPORT_ROW_PADDING_PT * 2
  );
}

/**
 * Auto orientation. Deliberately explainable rather than clever:
 *   - catalog: 1 or 2 cards across fit portrait; 3 need landscape
 *   - table:   portrait only when every column's MINIMUM fits in portrait AND
 *              there are at most five columns; anything wider goes landscape,
 *              because portrait plus six columns is where headers start
 *              colliding
 */
function autoOrientation(
  input: ComputeExportPdfLayoutInput,
  requiredWidthPt: number,
): PdfOrientation {
  if (input.layout === 'catalog') {
    return input.catalogColumns >= 3 ? 'landscape' : 'portrait';
  }
  const columnCount = input.fields.filter((f) => f.key !== 'image').length;
  const portraitFits = requiredWidthPt <= contentWidthFor(input.paperSize, 'portrait');
  return portraitFits && columnCount <= 5 ? 'portrait' : 'landscape';
}

export function computeExportPdfLayout(input: ComputeExportPdfLayoutInput): ExportPdfLayout {
  const showImages = input.includeImages && input.fields.some((f) => f.key === 'image');
  const tableFields = input.fields.filter((f) => f.key !== 'image');

  const imageColumnWidthPt = showImages ? IMAGE_CELL_PT[input.imageSize].widthPt : 0;
  const imageReservePt = showImages ? imageColumnWidthPt + REPORT_IMAGE_COL_GAP_PT : 0;
  const requiredWidthPt =
    tableFields.reduce((sum, f) => sum + f.pdfMinWidth, 0) + imageReservePt;

  const orientation =
    input.orientation === 'auto' ? autoOrientation(input, requiredWidthPt) : input.orientation;
  const page = PAPER_SIZE_PT[input.paperSize][orientation];
  const contentWidthPt = contentWidthFor(input.paperSize, orientation);

  const fitInput: FitColumn[] = tableFields.map((f) => ({
    key: f.key,
    width: f.pdfWidth,
    minWidth: f.pdfMinWidth,
    maxWidth: f.pdfMaxWidth,
  }));
  const widths = fitColumnWidths(fitInput, Math.max(0, contentWidthPt - imageReservePt));

  const columns: ExportPdfColumn[] = tableFields.map((f, i) => ({
    key: f.key,
    label: fieldHeading(f, { format: 'pdf', itemType: input.itemTypeKind }),
    align: f.align,
    widthPt: widths[i] ?? 0,
    // wrapText off means every column truncates EXCEPT the ones whose own
    // definition forbids it (ISBN, SKU, barcode) — those stay unwrapped and
    // untruncated, which their minimum width guarantees.
    wrap: input.wrapText ? f.wrap : false,
  }));

  const density = DENSITY_PT[input.density];
  const rowHeightPt = showImages
    ? Math.max(IMAGE_CELL_PT[input.imageSize].rowHeightPt, density.minRowHeightPt)
    : density.minRowHeightPt;
  const imageBoxHeightPt = Math.max(8, rowHeightPt - density.rowPaddingPt * 2);

  const usableHeightPt =
    page.heightPt - REPORT_PAGE_PADDING_PT * 2 - HEADER_BLOCK_PT - TABLE_HEADER_ROW_PT;
  const estimatedRowsPerPage = Math.max(1, Math.floor(usableHeightPt / rowHeightPt));

  const overflow = requiredWidthPt > contentWidthPt;
  const warnings: string[] = [];
  if (columns.length >= TOO_MANY_COLUMNS_THRESHOLD) {
    warnings.push(tooManyColumnsWarning(columns.length));
  }
  if (overflow) {
    warnings.push(
      'Some columns are narrower than their contents need. Remove fields, switch to Legal paper, or use landscape orientation.',
    );
  }

  return {
    orientation,
    paperSize: input.paperSize,
    pageWidthPt: page.widthPt,
    pageHeightPt: page.heightPt,
    contentWidthPt,
    imageColumnWidthPt,
    imageBoxPt: { widthPt: imageColumnWidthPt, heightPt: imageBoxHeightPt },
    rowHeightPt,
    rowPaddingPt: density.rowPaddingPt,
    columns,
    warnings,
    overflow,
    estimatedRowsPerPage,
  };
}

/**
 * Page-count RANGE for the dialog's summary. A range, not a number, because
 * wrapped titles and page-break avoidance make the true count unknowable
 * without rendering — and the brief requires estimates to be labelled as such.
 */
export function estimateExportPdfPages(
  layout: ExportPdfLayout,
  rowCount: number,
  opts: { catalogColumns?: number } = {},
): { min: number; max: number } {
  if (rowCount <= 0) return { min: 1, max: 1 };
  const perPage = Math.max(1, layout.estimatedRowsPerPage * (opts.catalogColumns ?? 1));
  const min = Math.max(1, Math.ceil(rowCount / perPage));
  // Wrapped titles and rows that refuse to split cost up to ~35% more pages.
  const max = Math.max(min, Math.ceil((rowCount * 1.35) / perPage));
  return { min, max };
}
