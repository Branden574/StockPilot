import { getExportField, type InventoryExportFieldKey } from './field-registry';

/**
 * The serialized config a SHARED export preset stores (export_presets.config,
 * migration 0338) and the sanitizer every reader runs.
 *
 * THE STORED CONFIG IS CLIENT-INFLUENCED DATA. The database enforces a shape
 * floor only (object + fieldKeys array); this module is the authoritative
 * validation, run server-side by the list action before a config ever reaches
 * the dialog, and run again by the save action so nothing unknown is written
 * in the first place.
 *
 * TWO RULES, DELIBERATELY DIFFERENT:
 *
 *   ON LOAD — unknown field ids are DROPPED, and reported in
 *   `droppedFieldKeys` so the dialog can show a visible note. The registry
 *   evolves; a preset saved against last year's registry must degrade into
 *   "this preset, minus the fields that no longer exist", never into an
 *   error.
 *
 *   ON SAVE — anything dropped is a REFUSAL (the save action rejects when
 *   droppedFieldKeys is non-empty). A live dialog can only produce known
 *   field keys, so a save containing unknown ones is a forged request, not
 *   drift.
 *
 * WHAT THIS MODULE NEVER DOES: permission filtering. It has no user context
 * on purpose. Field permissions are enforced in exactly one place —
 * resolveExportFields (export-request.ts), which POST /api/inventory/export
 * runs against the CURRENT user on every export. A preset's field list rides
 * the request's `fields` array into that same gate; there is no second gate
 * to drift from it. preset-config.test.ts pins both halves of that claim.
 *
 * NO 'server-only' and no Supabase imports — the dialog imports the types and
 * serializer in the browser; the actions import the parser on the server.
 */

export interface SharedExportPresetOptions {
  includeImages?: boolean;
  imageMode?: 'embedded' | 'url' | 'both';
  imageSize?: 'small' | 'medium' | 'large';
  pdf?: {
    layout?: 'table' | 'catalog';
    catalogColumns?: 1 | 2 | 3;
    orientation?: 'auto' | 'portrait' | 'landscape';
    paperSize?: 'letter' | 'legal';
    density?: 'compact' | 'comfortable' | 'image-friendly';
    repeatHeaders?: boolean;
    pageNumbers?: boolean;
    wrapText?: boolean;
  };
  xlsx?: {
    freezeHeader?: boolean;
    autoFilter?: boolean;
    includeSummarySheet?: boolean;
  };
}

export interface SharedExportPresetConfig {
  /** Which dialog offers this preset: the Books export or the Items export. */
  itemTypeKind: 'book' | 'other';
  /** Selected fields IN OUTPUT ORDER — the same contract as the builder. */
  fieldKeys: InventoryExportFieldKey[];
  format?: 'csv' | 'xlsx' | 'pdf';
  options?: SharedExportPresetOptions;
}

export interface ParsedSharedPresetConfig {
  config: SharedExportPresetConfig;
  /**
   * Field ids present in the stored config but unknown to the CURRENT
   * registry, in stored order. Non-empty = the dialog owes the user a note.
   */
  droppedFieldKeys: string[];
}

export type ParseSharedPresetResult =
  | ({ ok: true } & ParsedSharedPresetConfig)
  /** The config cannot be represented at all (out-of-band write): the row is
   *  still listable and deletable, just never applicable. */
  | { ok: false; reason: string };

const FORMATS = new Set(['csv', 'xlsx', 'pdf']);
const IMAGE_MODES = new Set(['embedded', 'url', 'both']);
const IMAGE_SIZES = new Set(['small', 'medium', 'large']);
const PDF_LAYOUTS = new Set(['table', 'catalog']);
const PDF_ORIENTATIONS = new Set(['auto', 'portrait', 'landscape']);
const PDF_PAPER_SIZES = new Set(['letter', 'legal']);
const PDF_DENSITIES = new Set(['compact', 'comfortable', 'image-friendly']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickEnum<T extends string>(v: unknown, allowed: Set<string>): T | undefined {
  return typeof v === 'string' && allowed.has(v) ? (v as T) : undefined;
}

function pickBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function sanitizeOptions(raw: unknown): SharedExportPresetOptions | undefined {
  if (!isRecord(raw)) return undefined;
  const out: SharedExportPresetOptions = {};
  const includeImages = pickBool(raw.includeImages);
  if (includeImages !== undefined) out.includeImages = includeImages;
  const imageMode = pickEnum<'embedded' | 'url' | 'both'>(raw.imageMode, IMAGE_MODES);
  if (imageMode) out.imageMode = imageMode;
  const imageSize = pickEnum<'small' | 'medium' | 'large'>(raw.imageSize, IMAGE_SIZES);
  if (imageSize) out.imageSize = imageSize;

  if (isRecord(raw.pdf)) {
    const pdf: NonNullable<SharedExportPresetOptions['pdf']> = {};
    const layout = pickEnum<'table' | 'catalog'>(raw.pdf.layout, PDF_LAYOUTS);
    if (layout) pdf.layout = layout;
    if (raw.pdf.catalogColumns === 1 || raw.pdf.catalogColumns === 2 || raw.pdf.catalogColumns === 3) {
      pdf.catalogColumns = raw.pdf.catalogColumns;
    }
    const orientation = pickEnum<'auto' | 'portrait' | 'landscape'>(
      raw.pdf.orientation,
      PDF_ORIENTATIONS,
    );
    if (orientation) pdf.orientation = orientation;
    const paperSize = pickEnum<'letter' | 'legal'>(raw.pdf.paperSize, PDF_PAPER_SIZES);
    if (paperSize) pdf.paperSize = paperSize;
    const density = pickEnum<'compact' | 'comfortable' | 'image-friendly'>(
      raw.pdf.density,
      PDF_DENSITIES,
    );
    if (density) pdf.density = density;
    for (const key of ['repeatHeaders', 'pageNumbers', 'wrapText'] as const) {
      const v = pickBool(raw.pdf[key]);
      if (v !== undefined) pdf[key] = v;
    }
    if (Object.keys(pdf).length > 0) out.pdf = pdf;
  }

  if (isRecord(raw.xlsx)) {
    const xlsx: NonNullable<SharedExportPresetOptions['xlsx']> = {};
    for (const key of ['freezeHeader', 'autoFilter', 'includeSummarySheet'] as const) {
      const v = pickBool(raw.xlsx[key]);
      if (v !== undefined) xlsx[key] = v;
    }
    if (Object.keys(xlsx).length > 0) out.xlsx = xlsx;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a stored preset config against the CURRENT field registry.
 *
 * Unknown field ids are dropped and reported — never an error (a preset must
 * not rot). Unknown option keys and invalid option values are silently
 * stripped: they cannot change what a later dialog does, so they earn no
 * note. Permission-bearing fields pass through UNTOUCHED — see the module
 * comment for where (and only where) permissions are enforced.
 */
export function parseSharedPresetConfig(raw: unknown): ParseSharedPresetResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'The stored preset is not a config object.' };
  }
  const kind = raw.itemTypeKind;
  if (kind !== 'book' && kind !== 'other') {
    return { ok: false, reason: 'The stored preset does not say which export it belongs to.' };
  }
  if (!Array.isArray(raw.fieldKeys)) {
    return { ok: false, reason: 'The stored preset has no field list.' };
  }

  const fieldKeys: InventoryExportFieldKey[] = [];
  const droppedFieldKeys: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.fieldKeys) {
    const key = typeof entry === 'string' ? entry : String(entry);
    if (seen.has(key)) continue; // duplicates collapse silently — same field, same column
    seen.add(key);
    if (typeof entry === 'string' && getExportField(entry)) {
      fieldKeys.push(entry as InventoryExportFieldKey);
    } else {
      droppedFieldKeys.push(key);
    }
  }

  const config: SharedExportPresetConfig = { itemTypeKind: kind, fieldKeys };
  const format = pickEnum<'csv' | 'xlsx' | 'pdf'>(raw.format, FORMATS);
  if (format) config.format = format;
  const options = sanitizeOptions(raw.options);
  if (options) config.options = options;

  return { ok: true, config, droppedFieldKeys };
}

/** Human note for a preset that lost fields to registry evolution. */
export function droppedFieldsNote(preset: { name: string; droppedFieldKeys: string[] }): string {
  const n = preset.droppedFieldKeys.length;
  return `"${preset.name}" references ${n} field${n === 1 ? '' : 's'} that no longer exist${n === 1 ? 's' : ''} and ${n === 1 ? 'was' : 'were'} skipped: ${preset.droppedFieldKeys.join(', ')}.`;
}
