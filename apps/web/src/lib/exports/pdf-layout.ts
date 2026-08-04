import {
  fitColumnWidths,
  REPORT_BODY_FONT_SIZE_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_PAGE_PADDING_PT,
  REPORT_ROW_PADDING_PT,
  type FitColumn,
} from '@/lib/pdf/column-fit';
import { safeWidth } from '@/lib/pdf/helvetica-metrics';

import { fieldHeading, type InventoryExportField } from './field-registry';
import type { InventoryExportSourceRow } from './source-row';

/**
 * PDF geometry for the export builder (Brief sections 11 and 13).
 *
 * Pure and client-safe: the dialog calls this to show the column-count warning
 * and the page estimate BEFORE generating anything, and the route calls the
 * same function to lay the document out. One implementation, so what the user
 * was warned about is what they get.
 *
 * The column-fitting order follows Brief section 13, with identifier columns
 * (ISBN, SKU, barcode — `field.identifier` in the registry) pulled out for
 * the reason the section names ("keep identifiers readable"): available
 * width -> margins -> image column reserve -> identifier columns' fixed
 * minimum widths reserved off the top -> weighted allocation of the
 * remainder across the wrappable columns (scaling down together if even
 * their minimums don't fit) -> wrap long text -> warn when too wide, naming
 * the columns that got squeezed. Identifiers are reserved BEFORE the
 * wrappable columns' allocation, not merely checked "readable" afterward as
 * the brief's prose order literally reads — `fitColumnWidths`' scale-down
 * has no concept of identifier vs. prose column, so anything fed through it
 * together shrinks together, which is exactly how ISBN used to get
 * truncated. Keeping identifiers out of that call is the only way to make
 * "never truncate ISBN" (section 11) actually hold once the overflow branch
 * engages.
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
  /** Identifier columns clip at their box edge as a last-resort safety net:
   *  their width is value-derived (see identifierValueMinimums) so clipping
   *  only ever engages past IDENTIFIER_RESERVE_CAP_PT, where the alternative
   *  is painting over the neighbouring column (the long-SKU overlap the
   *  2026-08-04 Demo walk photographed). */
  clip: boolean;
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
  /** When provided, identifier column widths are derived from the widest
   *  ACTUAL value in the export (capped), instead of the registry's fixed
   *  pdfMinWidth guess. The server route always passes the real rows. The
   *  dialog's client-side call estimates without rows — its warnings are
   *  advisory and the server's allocation is authoritative. */
  rows?: readonly InventoryExportSourceRow[];
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
 *
 * Brief section 11 lists this decision's inputs as "column count, images,
 * image size, title lengths, catalog mode." Two of those five get an honest
 * note here rather than silent, unexamined presence in `requiredWidthPt`:
 *
 * - Image size DOES feed `requiredWidthPt` (via `imageReservePt`, added by
 *   the caller before this runs) and so is genuinely read here — but for the
 *   CURRENT registry it never changes the outcome. The five heaviest
 *   non-image fields anywhere in EXPORT_FIELDS (name 90 + isbn 81 +
 *   inventory_value 68 + reorder_quantity 66 + any 62pt field) sum to at
 *   most ~367pt; even the largest image reserve (52pt, the `large` tier)
 *   only pushes that to ~419pt, still well under Letter-portrait's 524pt
 *   content width. No real <=5-column selection can make `portraitFits`
 *   true at one image size and false at another today. Left in because it
 *   is structurally correct (a wider image reserve genuinely is less width
 *   left for columns) and becomes load-bearing the moment a future field's
 *   `pdfMinWidth` grows or the 5-column carve-out is loosened — but it is
 *   not doing anything today, and treating it as load-bearing without
 *   saying so would hide that from the next person who touches this
 *   threshold.
 * - "Title lengths" has deliberately NOT been wired as a separate signal.
 *   This function only ever sees field SELECTION, never row data — it runs
 *   before any export is generated, so the dialog can preview a layout
 *   before a single row is fetched — so there is no actual title text here
 *   to measure. The one thing that stands in for "how much room does this
 *   selection's prose need" is each field's own `pdfMinWidth`, and `name`'s
 *   (90, the highest of any field) is already summed into `requiredWidthPt`
 *   above. A second "does the selection include a long-text field" boolean
 *   would either duplicate that same number — every wrap:true field
 *   (name/author/category/location/warehouse/charter/supplier) already
 *   contributes its own `pdfMinWidth` to the identical sum — or would need
 *   actual cell values this function structurally cannot see. Brief section
 *   11's "title lengths" is folded into the minimum-width sum already
 *   present, not a missing input.
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

interface ColumnAllocation {
  widthByKey: Map<string, number>;
  /** Keys whose final width fell below their own registry `pdfMinWidth` —
   *  the guarantee that width was derived to keep the header (and, for
   *  identifier columns, the worst-case value) readable. */
  offendingKeys: string[];
}

/**
 * Allocate `availableForFieldsPt` across `tableFields`, identifier columns
 * first (CRITICAL 2 fix).
 *
 * Identifier columns (`field.identifier` — ISBN, SKU, barcode today, read
 * off the registry rather than hardcoded here) reserve their true
 * `pdfMinWidth` off the top and never enter `fitColumnWidths`, so the
 * allocator's proportional scale-down — which has no concept of "this
 * column must never truncate" — can never touch them. Only in the
 * genuinely-unreadable case (identifiers alone wider than the available
 * width) do they shrink too, scaled down together exactly like
 * `fitColumnWidths`' own overflow branch; there is nothing more useful to
 * do with negative width, and Brief section 13 only requires blocking
 * "when nothing readable is possible" — this still returns positive widths.
 */
/** Widest identifier reservation we will ever make. Past this, a value is
 *  pathological (a barcode pasted with garbage) and the column clips instead
 *  of eating the whole page. 150pt fits a ~34-character SKU at cell size. */
export const IDENTIFIER_RESERVE_CAP_PT = 150;

/**
 * Per-identifier-column effective minimum width, derived from the widest
 * actual value in `rows` (measured with the same Helvetica advance-width
 * table the fit tests use, at the renderer's cell size) — never below the
 * registry's pdfMinWidth, never above IDENTIFIER_RESERVE_CAP_PT. This is the
 * long-SKU overlap fix: identifiers never wrap, and @react-pdf does not clip
 * overflow, so a value wider than the registry's fixed guess used to paint
 * across the neighbouring column. Sizing the column to the data removes the
 * overlap in every realistic case; the cap plus cell-level clipping (see
 * ExportPdfColumn.clip) bounds the pathological ones.
 */
function identifierValueMinimums(
  tableFields: readonly InventoryExportField[],
  rows: readonly InventoryExportSourceRow[] | undefined,
): Map<string, number> {
  const byKey = new Map<string, number>();
  if (!rows || rows.length === 0) return byKey;
  for (const f of tableFields) {
    if (f.identifier !== true) continue;
    let widest = 0;
    for (const row of rows) {
      const value = f.value(row);
      if (!value) continue;
      const w = safeWidth(String(value), 'Helvetica', REPORT_BODY_FONT_SIZE_PT);
      if (w > widest) widest = w;
    }
    if (widest <= 0) continue;
    const effective = Math.min(
      IDENTIFIER_RESERVE_CAP_PT,
      Math.max(f.pdfMinWidth, Math.ceil(widest) + REPORT_CELL_PADDING_PT * 2 + 1),
    );
    if (effective > f.pdfMinWidth) byKey.set(f.key, effective);
  }
  return byKey;
}

function allocateColumnWidths(
  tableFields: readonly InventoryExportField[],
  availableForFieldsPt: number,
  identifierMinByKey?: ReadonlyMap<string, number>,
): ColumnAllocation {
  const identifierFields = tableFields.filter((f) => f.identifier === true);
  const wrappableFields = tableFields.filter((f) => f.identifier !== true);
  const reserveFor = (f: InventoryExportField) =>
    identifierMinByKey?.get(f.key) ?? f.pdfMinWidth;
  const identifierReservePt = identifierFields.reduce((sum, f) => sum + reserveFor(f), 0);

  const widthByKey = new Map<string, number>();

  if (identifierReservePt > availableForFieldsPt) {
    const scale = availableForFieldsPt > 0 ? availableForFieldsPt / identifierReservePt : 0;
    for (const f of identifierFields) widthByKey.set(f.key, reserveFor(f) * scale);
    for (const f of wrappableFields) widthByKey.set(f.key, 0);
  } else {
    for (const f of identifierFields) widthByKey.set(f.key, reserveFor(f));
    const remainderPt = availableForFieldsPt - identifierReservePt;
    const fitInput: FitColumn[] = wrappableFields.map((f) => ({
      key: f.key,
      width: f.pdfWidth,
      minWidth: f.pdfMinWidth,
      maxWidth: f.pdfMaxWidth,
    }));
    const widths = fitColumnWidths(fitInput, remainderPt);
    wrappableFields.forEach((f, i) => widthByKey.set(f.key, widths[i] ?? 0));
  }

  const offendingKeys = tableFields
    .filter((f) => (widthByKey.get(f.key) ?? 0) < f.pdfMinWidth - 1e-6)
    .map((f) => f.key);

  return { widthByKey, offendingKeys };
}

/**
 * Whether `tableFields` clears every column's minimum (no offending keys) at
 * `orientation`/`paperSize`, used only to decide whether the overflow
 * warning can honestly recommend one of them (Brief section 13's remedies).
 */
function fieldsFitAt(
  tableFields: readonly InventoryExportField[],
  imageReservePt: number,
  paperSize: PaperSize,
  orientation: PdfOrientation,
  identifierMinByKey?: ReadonlyMap<string, number>,
): boolean {
  const availableForFieldsPt = Math.max(0, contentWidthFor(paperSize, orientation) - imageReservePt);
  return (
    allocateColumnWidths(tableFields, availableForFieldsPt, identifierMinByKey).offendingKeys
      .length === 0
  );
}

/**
 * Remedies from Brief section 13 ("switch to landscape, use Legal, remove
 * fields, or export to Excel") that would ACTUALLY fix this exact field
 * set — checked by trial allocation, not assumed. Landscape is only ever
 * offered as a remedy for a portrait overflow: landscape's content width is
 * never narrower than portrait's at the same paper size, so if landscape
 * still overflowed there would be nothing landscape could offer that
 * portrait couldn't. Legal is only offered when it is not already the
 * paper size in use, and only when it actually widens the relevant
 * dimension — Legal's PORTRAIT width equals Letter's (only the height
 * grows), so Legal is correctly never recommended for a portrait-width
 * overflow.
 */
function overflowRemedies(
  tableFields: readonly InventoryExportField[],
  imageReservePt: number,
  orientation: PdfOrientation,
  paperSize: PaperSize,
  identifierMinByKey?: ReadonlyMap<string, number>,
): string[] {
  const remedies: string[] = [];
  if (
    orientation === 'portrait' &&
    fieldsFitAt(tableFields, imageReservePt, paperSize, 'landscape', identifierMinByKey)
  ) {
    remedies.push('landscape orientation');
  }
  if (
    paperSize !== 'legal' &&
    fieldsFitAt(tableFields, imageReservePt, 'legal', orientation, identifierMinByKey)
  ) {
    remedies.push('Legal paper');
  }
  return remedies;
}

/**
 * The overflow warning, made actionable (Task 8 review, CRITICAL 1): names
 * the columns that actually got squeezed below their registry minimum —
 * never a generic "some columns" with nothing to point at — and, when the
 * SAME field set would clear every column in a different orientation or
 * paper size, says so, echoing Brief section 13's own remedies.
 */
function overflowWarning(offendingLabels: readonly string[], remedies: readonly string[]): string {
  const list = offendingLabels.join(', ');
  const verb = offendingLabels.length === 1 ? 'is' : 'are';
  const tail =
    remedies.length > 0
      ? `Switch to ${remedies.join(' or ')} to fit every column, or remove fields.`
      : 'Remove fields or export to Excel for the complete dataset.';
  return `${list} ${verb} narrower than readable at this size. ${tail}`;
}

export function computeExportPdfLayout(input: ComputeExportPdfLayoutInput): ExportPdfLayout {
  const showImages = input.includeImages && input.fields.some((f) => f.key === 'image');
  const tableFields = input.fields.filter((f) => f.key !== 'image');

  const imageColumnWidthPt = showImages ? IMAGE_CELL_PT[input.imageSize].widthPt : 0;
  const imageReservePt = showImages ? imageColumnWidthPt + REPORT_IMAGE_COL_GAP_PT : 0;
  const identifierMinByKey = identifierValueMinimums(tableFields, input.rows);
  const requiredWidthPt =
    tableFields.reduce(
      (sum, f) => sum + (identifierMinByKey.get(f.key) ?? f.pdfMinWidth),
      0,
    ) + imageReservePt;

  const orientation =
    input.orientation === 'auto' ? autoOrientation(input, requiredWidthPt) : input.orientation;
  const page = PAPER_SIZE_PT[input.paperSize][orientation];
  const contentWidthPt = contentWidthFor(input.paperSize, orientation);

  // CRITICAL 2 fix: identifier columns (ISBN, SKU, barcode) reserve their
  // fixed pdfMinWidth off the top, before the wrappable columns ever reach
  // fitColumnWidths, so the scale-down branch below can shrink the
  // wrappable columns without ever also shrinking an identifier.
  const availableForFieldsPt = Math.max(0, contentWidthPt - imageReservePt);
  const { widthByKey, offendingKeys } = allocateColumnWidths(
    tableFields,
    availableForFieldsPt,
    identifierMinByKey,
  );

  const columns: ExportPdfColumn[] = tableFields.map((f) => ({
    key: f.key,
    label: fieldHeading(f, { format: 'pdf', itemType: input.itemTypeKind }),
    align: f.align,
    widthPt: widthByKey.get(f.key) ?? 0,
    // wrapText off means every column truncates EXCEPT the ones whose own
    // definition forbids it (ISBN, SKU, barcode) — those stay unwrapped and
    // untruncated, which their (value-derived) minimum width guarantees.
    wrap: input.wrapText ? f.wrap : false,
    clip: f.identifier === true,
  }));

  const density = DENSITY_PT[input.density];
  const rowHeightPt = showImages
    ? Math.max(IMAGE_CELL_PT[input.imageSize].rowHeightPt, density.minRowHeightPt)
    : density.minRowHeightPt;
  const imageBoxHeightPt = Math.max(8, rowHeightPt - density.rowPaddingPt * 2);

  const usableHeightPt =
    page.heightPt - REPORT_PAGE_PADDING_PT * 2 - HEADER_BLOCK_PT - TABLE_HEADER_ROW_PT;
  const estimatedRowsPerPage = Math.max(1, Math.floor(usableHeightPt / rowHeightPt));

  // CRITICAL 1 fix: overflow is now derived from the REAL allocation (did
  // any column actually land below its own guaranteed-to-fit minimum),
  // never a coarse sum-vs-content-width proxy that can miss (or over-flag)
  // individual columns.
  const overflow = offendingKeys.length > 0;
  const warnings: string[] = [];
  if (columns.length >= TOO_MANY_COLUMNS_THRESHOLD) {
    warnings.push(tooManyColumnsWarning(columns.length));
  }
  if (overflow) {
    const offendingLabels = columns
      .filter((c) => offendingKeys.includes(c.key))
      .map((c) => c.label);
    const remedies = overflowRemedies(
      tableFields,
      imageReservePt,
      orientation,
      input.paperSize,
      identifierMinByKey,
    );
    warnings.push(overflowWarning(offendingLabels, remedies));
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
