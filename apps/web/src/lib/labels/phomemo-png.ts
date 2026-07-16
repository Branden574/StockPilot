// Pure (no DOM, no 'use client') helpers for the "Download PNG (Phomemo)"
// label action in components/inventory/barcode-display.tsx.
//
// Why this exists: the Phomemo M120's macOS driver misrotates thermal
// output, so the workaround is to skip the driver entirely — render the
// label at the EXACT pixel dimensions for the printer's native 203 DPI and
// let the owner print that PNG straight from the Phomemo app, which handles
// orientation correctly. Keeping the mm→px math and filename builder here
// (instead of inline in the client component) makes them unit-testable
// without a canvas/DOM environment.

/** Phomemo M120 native print resolution. */
export const PHOMEMO_DPI = 203;

const MM_PER_IN = 25.4;

/** Convert a millimeter dimension to whole device pixels at the given DPI. */
export function mmToPx(mm: number, dpi: number = PHOMEMO_DPI): number {
  return Math.round((mm / MM_PER_IN) * dpi);
}

export interface LabelPx {
  widthPx: number;
  heightPx: number;
}

/** Compute the exact pixel canvas size for a label of widthMm × heightMm. */
export function computeLabelPx(
  widthMm: number,
  heightMm: number,
  dpi: number = PHOMEMO_DPI,
): LabelPx {
  return { widthPx: mmToPx(widthMm, dpi), heightPx: mmToPx(heightMm, dpi) };
}

/** Human-readable "320×240 px @ 203 dpi" string for the sanity-check UI. */
export function formatLabelPx(px: LabelPx, dpi: number = PHOMEMO_DPI): string {
  return `${px.widthPx}×${px.heightPx} px @ ${dpi} dpi`;
}

/** Format a millimeter value for filenames/labels: whole numbers stay bare
 *  ("50"), fractional values keep one decimal ("30.5") — custom sizes are
 *  entered as whole mm in the UI but this stays safe if that ever changes. */
function formatMm(mm: number): string {
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1);
}

/** Strip anything that isn't filesystem/URL-safe from a SKU so it can't
 *  break the downloaded filename (path separators, quotes, etc.). Falls
 *  back to "label" if the SKU sanitizes away to nothing. */
function sanitizeForFilename(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'label';
}

export interface PhomemoFilenameParams {
  sku: string;
  widthMm: number;
  heightMm: number;
}

/** Build the download filename: label-{sku}-{W}x{H}mm-203dpi.png */
export function buildPhomemoFilename(
  { sku, widthMm, heightMm }: PhomemoFilenameParams,
  dpi: number = PHOMEMO_DPI,
): string {
  const safeSku = sanitizeForFilename(sku);
  return `label-${safeSku}-${formatMm(widthMm)}x${formatMm(heightMm)}mm-${dpi}dpi.png`;
}
