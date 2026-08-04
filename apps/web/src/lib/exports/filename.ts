/**
 * ONE descriptive, safe export filename (Brief section 22).
 *
 * Two other builders already exist and stay where they are: csvFilename() in
 * lib/csv.ts serves the legacy GET .csv routes, and the export route used to
 * inline its own `${slug}-${scope}-${date}.${ext}`. This replaces the inlined
 * one for the builder's downloads and is the only place preset names — the one
 * user-controlled component of the name — are sanitized.
 *
 * SECURITY: the result is interpolated into a Content-Disposition header. A
 * newline or a double quote there is a header-injection primitive, and a slash
 * is a path traversal in some download managers, so the sanitizer is an
 * allow-list of [a-z0-9-] rather than a deny-list.
 */

export function sanitizeFilenameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export interface ExportFilenameInput {
  slug: 'books' | 'inventory';
  scope: 'selected' | 'filtered' | 'all';
  format: 'csv' | 'xlsx' | 'pdf';
  /** The chosen preset's name, when it is not the ad-hoc "Custom" one. */
  presetName?: string | null;
  /** Row count, used for the selected-scope name. */
  count?: number;
  now?: Date;
}

export function buildExportFilename(input: ExportFilenameInput): string {
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const preset = input.presetName ? sanitizeFilenameSegment(input.presetName) : '';

  if (preset) {
    // "Books with covers" -> books-with-covers-2026-08-03.xlsx. The preset
    // names already begin with Books / Inventory, so the slug is not repeated.
    return `${preset}-${date}.${input.format}`;
  }

  if (input.scope === 'selected' && typeof input.count === 'number' && input.count > 0) {
    const noun = input.count === 1 ? 'item' : 'items';
    return `${input.slug}-selected-${input.count}-${noun}-${date}.${input.format}`;
  }

  return `${input.slug}-${input.scope}-${date}.${input.format}`;
}
