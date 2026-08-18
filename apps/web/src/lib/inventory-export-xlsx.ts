import 'server-only';

import ExcelJS from 'exceljs';

import { escapeForSpreadsheet } from './csv';
import { fieldHeading, type InventoryExportField } from './exports/field-registry';
import type { EmbeddedImage } from './exports/export-images';
import type { ExportImageSize } from './exports/pdf-layout';
import type { InventoryExportSourceRow } from './exports/source-row';

/**
 * Render export rows to a real .xlsx workbook (exceljs), driven entirely by the
 * chosen fields and their registry metadata (Brief section 14).
 *
 * What changed from the original 47-line version: only the selected fields, in
 * the user's order, under friendly labels; a sheet named for what it contains;
 * per-type cell formats (text for identifiers, numbers right-aligned, currency,
 * dates); autofilter; sensible widths; wrapped long text; optional embedded
 * pictures with grown rows; an optional summary sheet. What did NOT change: the
 * formula-injection guard on every string cell, via the same escapeForSpreadsheet
 * the CSV path uses.
 */

export const XLSX_IMAGE_CELL: Record<
  ExportImageSize,
  { rowHeightPt: number; columnWidthChars: number; boxPx: { width: number; height: number } }
> = {
  small: { rowHeightPt: 42, columnWidthChars: 7, boxPx: { width: 40, height: 54 } },
  medium: { rowHeightPt: 66, columnWidthChars: 11, boxPx: { width: 64, height: 86 } },
  large: { rowHeightPt: 96, columnWidthChars: 15, boxPx: { width: 92, height: 124 } },
};

const CURRENCY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'yyyy-mm-dd';

export interface InventoryXlsxInput {
  fields: readonly InventoryExportField[];
  rows: readonly InventoryExportSourceRow[];
  itemTypeKind: 'book' | 'other';
  freezeHeader: boolean;
  autoFilter: boolean;
  includeSummarySheet: boolean;
  /** null when the image field was not selected — no image work happens. */
  imageMode: 'embedded' | 'url' | 'both' | null;
  imageSize: ExportImageSize;
  /** itemId to bytes, for embedded / both. Missing ids render blank. */
  images?: ReadonlyMap<string, EmbeddedImage>;
  /**
   * How many rows had an image URL but no bytes arrived (fetch failed, was
   * rate-limited, timed out, or the deadline passed). When > 0 the summary
   * sheet says so, so a blank picture cell reads as "not fetched" rather
   * than "no cover". Counts only; never a URL.
   */
  imagesSkipped?: number;
  /** How many rows had an image URL to fetch (the M in "N of M"). */
  imagesRequested?: number;
  /** Appended to the summary sheet when the row cap truncated the export. */
  truncatedNote?: string;
}

/** Summary-sheet metric label used when at least one picture could not be embedded. */
export const XLSX_IMAGES_NOT_EMBEDDED_METRIC = 'Images not embedded';

/** Summary-sheet note under that metric. Professional prose, no emojis. */
export function xlsxImagesNotEmbeddedNote(skipped: number, requested: number): string {
  return `${skipped} of ${requested} images could not be fetched and were left blank. Re-run the export to retry.`;
}

/**
 * Intrinsic pixel size of a PNG or JPEG, so an embedded picture can be scaled
 * to FIT its box instead of being stretched to it (Brief section 14: "images
 * inside rows, undistorted"). Returns null for anything unparseable, and the
 * caller then uses the box as-is.
 */
export function readImageDimensions(data: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR with width at 16 and height at 20 (BE32).
  if (
    data.length > 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the marker chain to the first SOF segment.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1]!;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = (data[offset + 5]! << 8) | data[offset + 6]!;
        const width = (data[offset + 7]! << 8) | data[offset + 8]!;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (length <= 0) return null;
      offset += 2 + length;
    }
  }
  return null;
}

function columnWidthFor(field: InventoryExportField, heading: string): number {
  if (field.cellType === 'number' || field.cellType === 'currency') return 14;
  if (field.cellType === 'date') return 16;
  if (field.wrap) return 40;
  return Math.min(Math.max(heading.length + 4, 14), 44);
}

/** Fit (w, h) inside the box, preserving aspect. */
function fitBox(
  intrinsic: { width: number; height: number } | null,
  box: { width: number; height: number },
): { width: number; height: number } {
  if (!intrinsic || intrinsic.width <= 0 || intrinsic.height <= 0) return box;
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height);
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  };
}

export async function toInventoryXlsx(input: InventoryXlsxInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'StockPilot';
  const ws = wb.addWorksheet(input.itemTypeKind === 'book' ? 'Books' : 'Inventory');

  const embedsPictures = input.imageMode === 'embedded' || input.imageMode === 'both';
  const imageSpec = XLSX_IMAGE_CELL[input.imageSize];

  // Column plan. In `both` mode the image field produces TWO columns: the
  // picture cell and a separate Image URL cell.
  type Plan = { field: InventoryExportField; heading: string; kind: 'value' | 'picture' | 'url' };
  const plan: Plan[] = [];
  for (const field of input.fields) {
    if (field.key === 'image') {
      if (input.imageMode === null) continue;
      if (embedsPictures) {
        plan.push({
          field,
          heading: fieldHeading(field, { format: 'xlsx', itemType: input.itemTypeKind }),
          kind: 'picture',
        });
      }
      if (input.imageMode === 'url' || input.imageMode === 'both') {
        plan.push({
          field,
          heading:
            input.imageMode === 'both'
              ? 'Image URL'
              : fieldHeading(field, { format: 'xlsx', itemType: input.itemTypeKind }),
          kind: 'url',
        });
      }
      continue;
    }
    plan.push({
      field,
      heading: fieldHeading(field, { format: 'xlsx', itemType: input.itemTypeKind }),
      kind: 'value',
    });
  }

  ws.columns = plan.map((p) => ({
    header: p.heading,
    key: `c${plan.indexOf(p)}`,
    width:
      p.kind === 'picture' ? imageSpec.columnWidthChars : columnWidthFor(p.field, p.heading),
  }));

  for (const row of input.rows) {
    const excelRow = ws.addRow(
      plan.map((p) => {
        if (p.kind === 'picture') return '';
        if (p.kind === 'url') return escapeForSpreadsheet(row.image?.thumbnailUrl ?? '');
        const value = p.field.value(row);
        if (value === null || value === undefined) return '';
        if (p.field.cellType === 'date') {
          const date = new Date(String(value));
          return Number.isNaN(date.getTime()) ? escapeForSpreadsheet(String(value)) : date;
        }
        if (typeof value === 'number') return value;
        return escapeForSpreadsheet(String(value));
      }),
    );

    plan.forEach((p, index) => {
      const cell = excelRow.getCell(index + 1);
      if (p.kind !== 'value') {
        if (p.kind === 'url') cell.numFmt = '@';
        return;
      }
      switch (p.field.cellType) {
        case 'text':
          // The identifier guarantee: an explicit text format is what stops
          // Excel turning 9780262033848 into 9.78026E+12 or eating a leading
          // zero off an ISBN-10.
          cell.numFmt = '@';
          break;
        case 'currency':
          cell.numFmt = CURRENCY_FORMAT;
          cell.alignment = { horizontal: 'right' };
          break;
        case 'number':
          cell.alignment = { horizontal: 'right' };
          break;
        case 'date':
          cell.numFmt = DATE_FORMAT;
          break;
      }
      if (p.field.wrap) {
        cell.alignment = { ...(cell.alignment ?? {}), wrapText: true, vertical: 'top' };
      }
    });

    if (embedsPictures) {
      excelRow.height = imageSpec.rowHeightPt;
      const image = input.images?.get(row.id);
      const pictureIndex = plan.findIndex((p) => p.kind === 'picture');
      if (image && pictureIndex >= 0) {
        const id = wb.addImage({
          buffer: Buffer.from(image.data) as unknown as ExcelJS.Buffer,
          extension: image.extension,
        });
        const size = fitBox(readImageDimensions(image.data), imageSpec.boxPx);
        ws.addImage(id, {
          // exceljs anchors are zero-based; the header occupies row 0.
          tl: { col: pictureIndex, row: excelRow.number - 1 },
          ext: size,
          editAs: 'oneCell',
        });
      }
    }
  }

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  if (input.freezeHeader) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  if (input.autoFilter && plan.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, input.rows.length + 1), column: plan.length },
    };
  }

  if (input.includeSummarySheet) {
    addSummarySheet(wb, input);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Optional summary sheet (Brief section 14).
 *
 * It reports ONLY on fields this export actually contains: value totals appear
 * only when a financial field was exported, so a summary can never surface a
 * number the sheet itself does not show.
 */
function addSummarySheet(wb: ExcelJS.Workbook, input: InventoryXlsxInput): void {
  const ws = wb.addWorksheet('Summary');
  ws.columns = [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'Value', key: 'value', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };

  const rows = input.rows;
  const units = rows.reduce((sum, r) => sum + r.quantityOnHand, 0);
  const add = (metric: string, value: string | number) => {
    ws.addRow({ metric, value });
  };

  if (input.itemTypeKind === 'book') {
    const withIsbn = rows.filter((r) => r.isbn.length > 0).length;
    const withCover = rows.filter((r) => r.image !== null).length;
    add('Total titles', rows.length);
    add('On-hand units', units);
    add('With ISBN', withIsbn);
    add('Missing ISBN', rows.length - withIsbn);
    add('With cover', withCover);
    add('Missing cover', rows.length - withCover);
  } else {
    add('Total records', rows.length);
    add('On-hand units', units);
  }

  const exportsFinancials = input.fields.some((f) => f.group === 'financial');
  if (exportsFinancials) {
    const value = rows.reduce((sum, r) => sum + (r.unitCost ?? 0) * r.quantityOnHand, 0);
    add('Inventory value', Math.round(value * 100) / 100);
    ws.getRow(ws.rowCount).getCell(2).numFmt = CURRENCY_FORMAT;
  }

  const tally = (label: string, pick: (r: InventoryExportSourceRow) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = pick(row) || 'Unassigned';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    ws.addRow({});
    const heading = ws.addRow({ metric: label, value: 'Count' });
    heading.font = { bold: true };
    for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      add(key, count);
    }
  };
  tally('Category totals', (r) => r.category);
  tally('Status totals', (r) => r.status);

  if ((input.imagesSkipped ?? 0) > 0) {
    const skipped = input.imagesSkipped!;
    const requested = Math.max(input.imagesRequested ?? skipped, skipped);
    ws.addRow({});
    add(XLSX_IMAGES_NOT_EMBEDDED_METRIC, skipped);
    ws.addRow({ metric: xlsxImagesNotEmbeddedNote(skipped, requested) });
  }

  if (input.truncatedNote) {
    ws.addRow({});
    ws.addRow({ metric: input.truncatedNote });
  }
}
