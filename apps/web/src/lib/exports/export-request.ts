import { z } from 'zod';

import type { Permission } from '@stockpilot/core';

import {
  defaultFieldKeysFor,
  getExportField,
  IDENTIFYING_FIELD_KEYS,
  type InventoryExportField,
  type InventoryExportFieldKey,
} from './field-registry';

/**
 * The export request contract (Brief section 16) and the SERVER-side field
 * resolver (Brief section 25).
 *
 * The schema is shared by the browser (which builds the request) and the route
 * (which re-parses it). The resolver runs ONLY on the server: a client can post
 * any JSON it likes, so the authoritative answer to "which fields are in this
 * file" is computed here from the registry, never taken on trust.
 */

/** A 30-column PDF is already unreadable; a 30-column CSV is plenty. */
export const INVENTORY_EXPORT_MAX_FIELDS = 30;

const filtersSchema = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'archived', 'discontinued', 'all']).optional(),
  stock: z.enum(['low', 'out']).nullable().optional(),
  // Mig 0277: true = the page's Expected chip view — export ONLY items
  // awaiting their first receipt (matching the visible rows).
  expected: z.boolean().optional(),
  sort: z.string().optional(),
  categoryIds: z.array(z.string()).optional(),
  locationIds: z.array(z.string()).optional(),
  charterIds: z.array(z.string()).optional(),
}).strict();

const pdfOptionsSchema = z
  .object({
    layout: z.enum(['table', 'catalog']).default('table'),
    catalogColumns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
    // Letter and Legal only. A4 is deliberately absent: the brief allows it
    // "only if it fits requirements", and no StockPilot org prints A4 today.
    paperSize: z.enum(['letter', 'legal']).default('letter'),
    density: z.enum(['compact', 'comfortable', 'image-friendly']).default('comfortable'),
    repeatHeaders: z.boolean().default(true),
    pageNumbers: z.boolean().default(true),
    wrapText: z.boolean().default(true),
  })
  .strict()
  .default({});

const xlsxOptionsSchema = z
  .object({
    freezeHeader: z.boolean().default(true),
    autoFilter: z.boolean().default(true),
    includeSummarySheet: z.boolean().default(false),
  })
  .strict()
  .default({});

const optionsSchema = z
  .object({
    includeImages: z.boolean().default(false),
    imageMode: z.enum(['embedded', 'url', 'both']).default('embedded'),
    imageSize: z.enum(['small', 'medium', 'large']).default('medium'),
    /** Drives the descriptive filename only. Sanitized before use. */
    presetName: z.string().max(60).optional(),
    pdf: pdfOptionsSchema,
    xlsx: xlsxOptionsSchema,
  })
  .strict()
  .default({});

export const inventoryExportRequestSchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  scope: z.enum(['selected', 'filtered', 'all']),
  itemType: z.enum(['product', 'book', 'asset', 'consumable', 'all']).default('all'),
  ids: z.array(z.string().uuid()).max(10_000).optional(),
  filters: filtersSchema.optional(),
  /** Absent = use the registry defaults for this item type. */
  fields: z.array(z.string()).min(1).max(INVENTORY_EXPORT_MAX_FIELDS).optional(),
  options: optionsSchema,
}).strict();

export type InventoryExportRequestParsed = z.output<typeof inventoryExportRequestSchema>;
export type InventoryExportOptions = InventoryExportRequestParsed['options'];
export type InventoryExportItemType = InventoryExportRequestParsed['itemType'];
export type InventoryExportFormat = InventoryExportRequestParsed['format'];

export function exportItemTypeKind(itemType: InventoryExportItemType): 'book' | 'other' {
  return itemType === 'book' ? 'book' : 'other';
}

export interface ResolveExportFieldsInput {
  fields?: readonly string[];
  itemType: InventoryExportItemType;
  format: InventoryExportFormat;
  options: InventoryExportOptions;
  can: (permission: Permission) => boolean;
  /**
   * Test-only seam. The registry has no permission-bearing field today (no
   * cost-visibility permission exists in this codebase — owner decision open),
   * so the enforcement path would otherwise be unreachable and would rot. Never
   * pass this from production code.
   */
  permissionOverrides?: Partial<Record<InventoryExportFieldKey, Permission>>;
}

export type ResolveExportFieldsResult =
  | { ok: true; fields: InventoryExportField[]; imagesRequested: boolean }
  | { ok: false; status: 400 | 403; message: string };

const fail = (status: 400 | 403, message: string): ResolveExportFieldsResult => ({
  ok: false,
  status,
  message,
});

/**
 * Turn a (possibly hostile) requested field list into the authoritative,
 * ordered field objects the formatters use — or a refusal.
 *
 * Order is preserved exactly as requested: the user's column order IS the
 * output order, in all three formats.
 */
export function resolveExportFields(input: ResolveExportFieldsInput): ResolveExportFieldsResult {
  const kind = exportItemTypeKind(input.itemType);
  const requested =
    input.fields && input.fields.length > 0 ? [...input.fields] : defaultFieldKeysFor(kind);

  const seen = new Set<string>();
  const resolved: InventoryExportField[] = [];
  for (const key of requested) {
    if (seen.has(key)) {
      return fail(400, `Duplicate field in this export: ${key}.`);
    }
    seen.add(key);

    const field = getExportField(key);
    if (!field) {
      return fail(400, `Unknown export field: ${key}.`);
    }
    // Book-only fields are offered for book exports and for the everything
    // export (which can contain books); never for product/asset/consumable.
    if (field.appliesTo === 'book' && !(input.itemType === 'book' || input.itemType === 'all')) {
      return fail(400, `${field.label} is only available on book exports.`);
    }
    const supported =
      input.format === 'csv'
        ? field.csvSupported
        : input.format === 'xlsx'
          ? field.xlsxSupported
          : field.pdfSupported;
    if (!supported) {
      return fail(400, `${field.label} is not available in ${input.format.toUpperCase()} exports.`);
    }
    const permission = input.permissionOverrides?.[field.key] ?? field.permission;
    if (permission && !input.can(permission)) {
      return fail(403, `You do not have permission to export ${field.label}.`);
    }
    resolved.push(field);
  }

  if (!resolved.some((f) => IDENTIFYING_FIELD_KEYS.includes(f.key))) {
    return fail(
      400,
      'Include at least one identifying field: Name, SKU, ISBN or Barcode.',
    );
  }

  const imagesRequested = resolved.some((f) => f.key === 'image');
  const { includeImages, imageMode } = input.options;

  if (includeImages && !imagesRequested) {
    return fail(400, 'Select the Image field to include images in this export.');
  }
  if (imagesRequested && input.format === 'csv' && imageMode !== 'url') {
    return fail(
      400,
      'CSV files cannot contain images. Choose Image URL, or export to Excel or PDF.',
    );
  }
  if (imagesRequested && input.format === 'pdf' && imageMode === 'both') {
    return fail(400, 'PDF exports embed images; Both is an Excel-only option.');
  }
  if (input.options.pdf.layout === 'catalog') {
    if (input.format !== 'pdf') {
      return fail(400, 'The book catalog layout is only available for PDF exports.');
    }
    if (input.itemType !== 'book') {
      return fail(400, 'The book catalog layout is only available for book exports.');
    }
  }

  return { ok: true, fields: resolved, imagesRequested };
}
