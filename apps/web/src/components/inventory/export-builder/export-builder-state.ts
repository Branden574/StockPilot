import type { InventoryExportRequest } from '@/lib/download-export';
import {
  defaultFieldKeysFor,
  EXPORT_FIELDS,
  getExportField,
  IDENTIFYING_FIELD_KEYS,
  type InventoryExportField,
  type InventoryExportFieldKey,
} from '@/lib/exports/field-registry';
import {
  computeExportPdfLayout,
  estimateExportPdfPages,
  type ExportImageSize,
  type PdfDensity,
  type PdfOrientation,
  type PaperSize,
} from '@/lib/exports/pdf-layout';

/**
 * Everything the export dialog knows how to do, as plain data transforms.
 *
 * No React, no DOM, no network — the same split the orders storefront uses
 * (storefront-logic.ts), for the same reason: field ordering, format switching
 * and validation are where the bugs live, and they are worth testing without a
 * render.
 */

export interface ExportBuilderOptions {
  includeImages: boolean;
  imageMode: 'embedded' | 'url' | 'both';
  imageSize: ExportImageSize;
  pdf: {
    layout: 'table' | 'catalog';
    catalogColumns: 1 | 2 | 3;
    orientation: 'auto' | PdfOrientation;
    paperSize: PaperSize;
    density: PdfDensity;
    repeatHeaders: boolean;
    pageNumbers: boolean;
    wrapText: boolean;
  };
  xlsx: {
    freezeHeader: boolean;
    autoFilter: boolean;
    includeSummarySheet: boolean;
  };
}

export interface ExportBuilderState {
  format: 'csv' | 'xlsx' | 'pdf';
  /** Selected fields, IN OUTPUT ORDER. This array is the contract. */
  fieldKeys: InventoryExportFieldKey[];
  /** Id of the preset this state came from, or 'custom' once edited. */
  presetId: string;
  options: ExportBuilderOptions;
}

export const CUSTOM_PRESET_ID = 'custom';

const CANONICAL_ORDER: InventoryExportFieldKey[] = EXPORT_FIELDS.map((f) => f.key);

function defaultOptions(itemTypeKind: 'book' | 'other'): ExportBuilderOptions {
  return {
    // Books default to covers ON; items default to images OFF (Brief 8 and 9).
    includeImages: itemTypeKind === 'book',
    imageMode: 'embedded',
    imageSize: 'medium',
    pdf: {
      layout: 'table',
      catalogColumns: 2,
      orientation: 'auto',
      paperSize: 'letter',
      density: 'comfortable',
      repeatHeaders: true,
      pageNumbers: true,
      wrapText: true,
    },
    xlsx: { freezeHeader: true, autoFilter: true, includeSummarySheet: false },
  };
}

export function initialExportBuilderState(itemTypeKind: 'book' | 'other'): ExportBuilderState {
  return {
    format: 'pdf',
    fieldKeys: defaultFieldKeysFor(itemTypeKind),
    presetId: itemTypeKind === 'book' ? 'books-inventory' : 'inventory-overview',
    options: defaultOptions(itemTypeKind),
  };
}

/** Deep-ish merge for the nested option groups. */
export function setOptions(
  state: ExportBuilderState,
  patch: {
    includeImages?: boolean;
    imageMode?: ExportBuilderOptions['imageMode'];
    imageSize?: ExportImageSize;
    pdf?: Partial<ExportBuilderOptions['pdf']>;
    xlsx?: Partial<ExportBuilderOptions['xlsx']>;
  },
): ExportBuilderState {
  return {
    ...state,
    presetId: CUSTOM_PRESET_ID,
    options: {
      ...state.options,
      ...(patch.includeImages !== undefined ? { includeImages: patch.includeImages } : {}),
      ...(patch.imageMode ? { imageMode: patch.imageMode } : {}),
      ...(patch.imageSize ? { imageSize: patch.imageSize } : {}),
      pdf: { ...state.options.pdf, ...(patch.pdf ?? {}) },
      xlsx: { ...state.options.xlsx, ...(patch.xlsx ?? {}) },
    },
  };
}

/**
 * Add or remove a field.
 *
 * Re-adding puts the field back in CANONICAL registry position rather than at
 * the end, so a user who unticks Category to look at something and re-ticks it
 * does not silently end up with a different column order than they started
 * with.
 */
export function toggleField(
  state: ExportBuilderState,
  key: InventoryExportFieldKey,
): ExportBuilderState {
  const selected = new Set(state.fieldKeys);
  let fieldKeys: InventoryExportFieldKey[];
  if (selected.has(key)) {
    fieldKeys = state.fieldKeys.filter((k) => k !== key);
  } else {
    selected.add(key);
    const canonicalRank = new Map(CANONICAL_ORDER.map((k, i) => [k, i]));
    const target = canonicalRank.get(key) ?? Number.MAX_SAFE_INTEGER;
    const index = state.fieldKeys.findIndex(
      (k) => (canonicalRank.get(k) ?? Number.MAX_SAFE_INTEGER) > target,
    );
    fieldKeys = [...state.fieldKeys];
    fieldKeys.splice(index === -1 ? fieldKeys.length : index, 0, key);
  }
  const next: ExportBuilderState = { ...state, fieldKeys, presetId: CUSTOM_PRESET_ID };
  // The image field IS the images toggle. Keeping the flag in lockstep is what
  // makes the server's "includeImages without the image field" rejection
  // unreachable from this UI.
  return { ...next, options: { ...next.options, includeImages: fieldKeys.includes('image') } };
}

export function moveField(
  state: ExportBuilderState,
  key: InventoryExportFieldKey,
  direction: 'up' | 'down' | 'top' | 'bottom',
): ExportBuilderState {
  const from = state.fieldKeys.indexOf(key);
  if (from === -1) return state;
  const to =
    direction === 'up'
      ? from - 1
      : direction === 'down'
        ? from + 1
        : direction === 'top'
          ? 0
          : state.fieldKeys.length - 1;
  if (to < 0 || to >= state.fieldKeys.length || to === from) return state;
  const fieldKeys = [...state.fieldKeys];
  fieldKeys.splice(from, 1);
  fieldKeys.splice(to, 0, key);
  return { ...state, fieldKeys, presetId: CUSTOM_PRESET_ID };
}

export function restoreDefaults(
  state: ExportBuilderState,
  itemTypeKind: 'book' | 'other',
): ExportBuilderState {
  const fresh = initialExportBuilderState(itemTypeKind);
  return setFormat({ ...fresh, format: state.format }, state.format, itemTypeKind);
}

/** Fields this item type and format can actually carry, in canonical order. */
export function availableFieldsFor(
  itemTypeKind: 'book' | 'other',
  format: 'csv' | 'xlsx' | 'pdf',
): InventoryExportField[] {
  return EXPORT_FIELDS.filter((f) => {
    if (f.appliesTo === 'book' && itemTypeKind !== 'book') return false;
    return format === 'csv' ? f.csvSupported : format === 'xlsx' ? f.xlsxSupported : f.pdfSupported;
  }).map((f) => f);
}

/**
 * Switch format, normalising anything the new format cannot express.
 *
 * CSV can only carry an image URL; PDF cannot do "both"; catalog is PDF-only.
 * Normalising here means the dialog can never build a request the server would
 * reject.
 */
export function setFormat(
  state: ExportBuilderState,
  format: 'csv' | 'xlsx' | 'pdf',
  itemTypeKind: 'book' | 'other',
): ExportBuilderState {
  const allowed = new Set(availableFieldsFor(itemTypeKind, format).map((f) => f.key));
  const fieldKeys = state.fieldKeys.filter((k) => allowed.has(k));
  const imageMode: ExportBuilderOptions['imageMode'] =
    format === 'csv' ? 'url' : format === 'pdf' ? 'embedded' : state.options.imageMode;
  return {
    ...state,
    format,
    fieldKeys,
    options: {
      ...state.options,
      includeImages: fieldKeys.includes('image'),
      imageMode: format === 'xlsx' && state.options.imageMode === 'url' ? 'url' : imageMode,
      pdf: {
        ...state.options.pdf,
        layout: format === 'pdf' ? state.options.pdf.layout : 'table',
      },
    },
  };
}

export function validateExportBuilder(
  state: ExportBuilderState,
): { ok: true } | { ok: false; message: string } {
  if (state.fieldKeys.length === 0) {
    return { ok: false, message: 'Choose at least one field to export.' };
  }
  if (!state.fieldKeys.some((k) => IDENTIFYING_FIELD_KEYS.includes(k))) {
    return {
      ok: false,
      message: 'Include at least one identifying field: Name, SKU, ISBN or Barcode.',
    };
  }
  return { ok: true };
}

function noun(itemTypeKind: 'book' | 'other', count: number): string {
  if (itemTypeKind === 'book') return count === 1 ? 'book' : 'books';
  return count === 1 ? 'item' : 'items';
}

/** Brief section 5's scope line. */
export function scopeSummary(input: {
  scope: 'selected' | 'filtered' | 'all';
  count: number | null;
  itemTypeKind: 'book' | 'other';
}): string {
  if (input.scope === 'all') {
    return input.itemTypeKind === 'book'
      ? 'Exporting: All active books'
      : 'Exporting: All active inventory items';
  }
  if (input.count === null) {
    return `Exporting: the ${input.scope} ${noun(input.itemTypeKind, 2)}`;
  }
  return `Exporting: ${input.count} ${input.scope} ${noun(input.itemTypeKind, input.count)}`;
}

/** Brief section 19's summary line, as parts the dialog joins with a middot. */
export function builderSummaryParts(input: {
  state: ExportBuilderState;
  itemTypeKind: 'book' | 'other';
  rowCount: number | null;
}): string[] {
  const { state, itemTypeKind, rowCount } = input;
  const parts: string[] = [];
  if (rowCount !== null) parts.push(`${rowCount} ${noun(itemTypeKind, rowCount)}`);
  parts.push(
    `${state.fieldKeys.length} selected field${state.fieldKeys.length === 1 ? '' : 's'}`,
  );
  if (state.options.includeImages) {
    parts.push(itemTypeKind === 'book' ? 'Cover images included' : 'Images included');
  }
  if (state.format === 'pdf') {
    const fields = state.fieldKeys
      .map((k) => getExportField(k))
      .filter((f): f is InventoryExportField => Boolean(f));
    const layout = computeExportPdfLayout({
      fields,
      itemTypeKind,
      includeImages: state.options.includeImages,
      imageSize: state.options.imageSize,
      orientation: state.options.pdf.orientation,
      paperSize: state.options.pdf.paperSize,
      density: state.options.pdf.density,
      wrapText: state.options.pdf.wrapText,
      layout: state.options.pdf.layout,
      catalogColumns: state.options.pdf.catalogColumns,
    });
    if (rowCount !== null) {
      const pages = estimateExportPdfPages(layout, rowCount, {
        catalogColumns:
          state.options.pdf.layout === 'catalog' ? state.options.pdf.catalogColumns : 1,
      });
      // "Estimated" is not decoration: page counts depend on wrapping we have
      // not measured, and the brief requires estimates to say so.
      parts.push(
        pages.min === pages.max
          ? `Estimated ${pages.min} PDF page${pages.min === 1 ? '' : 's'}`
          : `Estimated ${pages.min}-${pages.max} PDF pages`,
      );
    }
    const orientationLabel = layout.orientation === 'portrait' ? 'Portrait' : 'Landscape';
    const paperLabel = layout.paperSize === 'legal' ? 'Legal' : 'Letter';
    parts.push(`${orientationLabel} ${paperLabel}`);
  }
  return parts;
}

export function toExportRequest(
  state: ExportBuilderState,
  input: {
    scope: 'selected' | 'filtered' | 'all';
    itemType: 'product' | 'book' | 'asset' | 'consumable' | 'all';
    ids?: string[];
    filters?: InventoryExportRequest['filters'];
    presetName?: string | null;
  },
): InventoryExportRequest {
  return {
    format: state.format,
    scope: input.scope,
    itemType: input.itemType,
    ...(input.scope === 'selected' ? { ids: input.ids ?? [] } : {}),
    ...(input.scope === 'filtered' ? { filters: input.filters } : {}),
    fields: [...state.fieldKeys],
    options: {
      ...state.options,
      ...(input.presetName ? { presetName: input.presetName } : {}),
    },
  };
}
