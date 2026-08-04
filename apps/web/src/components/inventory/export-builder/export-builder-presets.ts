import { getExportField, type InventoryExportFieldKey } from '@/lib/exports/field-registry';

import type { ExportBuilderOptions } from './export-builder-state';

/**
 * Export presets (Brief section 21).
 *
 * The eight built-ins are code constants. A user's OWN presets live in
 * localStorage, deliberately, and the reasoning is worth keeping next to the
 * code: the closest existing persistence is `saved_views`, whose `scope` column
 * carries a database CHECK constraint limited to ('inventory','books')
 * (supabase/migrations/0035_saved_views.sql:14) and whose state sanitizer is a
 * toolbar-filter whitelist with nowhere to put fields, order or format options.
 * Reusing it needs a migration, a new sanitizer and an RLS re-check — which the
 * brief explicitly does not require ("persist now ONLY if existing
 * user-preference infra supports cleanly, else dialog/browser storage +
 * document the future DB option"). The DB option is written up in the section
 * 31 report as the recommended next phase.
 *
 * Consequence to be honest about in the UI: personal presets are per browser,
 * not per account. The dialog says so.
 */

export const EXPORT_PRESETS_STORAGE_KEY = 'stockpilot.export-presets.v1';
const MAX_PERSONAL_PRESETS = 20;

export interface ExportPreset {
  id: string;
  name: string;
  /** 'any' = offered for both books and items exports. */
  itemTypeKind: 'book' | 'other' | 'any';
  fieldKeys: InventoryExportFieldKey[];
  options?: Partial<ExportBuilderOptions>;
  builtIn: boolean;
}

export const BUILT_IN_PRESETS: readonly ExportPreset[] = [
  {
    id: 'books-inventory',
    name: 'Books inventory',
    itemTypeKind: 'book',
    builtIn: true,
    fieldKeys: [
      'image',
      'name',
      'isbn',
      'sku',
      'author',
      'grade',
      'quantity_on_hand',
      'category',
      'rack',
      'crate',
      'primary_location',
      'status',
    ],
  },
  {
    id: 'books-with-covers',
    name: 'Books with covers',
    itemTypeKind: 'book',
    builtIn: true,
    fieldKeys: [
      'image',
      'name',
      'isbn',
      'author',
      'grade',
      'quantity_on_hand',
      'rack',
      'crate',
    ],
    options: { includeImages: true, imageSize: 'large' },
  },
  {
    id: 'books-isbn-list',
    name: 'Books ISBN list',
    itemTypeKind: 'book',
    builtIn: true,
    fieldKeys: ['name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand'],
    options: { includeImages: false },
  },
  {
    id: 'books-storage-list',
    name: 'Books storage list',
    itemTypeKind: 'book',
    builtIn: true,
    // The RAW parts, not the combined labels: a storage list is what someone
    // sorts and filters in a spreadsheet.
    fieldKeys: [
      'name',
      'isbn',
      'sku',
      'quantity_on_hand',
      'rack_number',
      'rack_row',
      'crate_color',
      'crate_number',
      'primary_location',
    ],
    options: { includeImages: false },
  },
  {
    id: 'inventory-overview',
    name: 'Inventory overview',
    itemTypeKind: 'other',
    builtIn: true,
    fieldKeys: [
      'name',
      'sku',
      'barcode',
      'quantity_on_hand',
      'category',
      'primary_location',
      'warehouse',
      'supplier',
      'charter',
      'status',
    ],
  },
  {
    id: 'inventory-valuation',
    name: 'Inventory valuation',
    itemTypeKind: 'other',
    builtIn: true,
    fieldKeys: [
      'name',
      'sku',
      'category',
      'quantity_on_hand',
      'unit_cost',
      'retail_price',
      'inventory_value',
    ],
    options: { xlsx: { freezeHeader: true, autoFilter: true, includeSummarySheet: true } },
  },
  {
    id: 'reorder-report',
    name: 'Reorder report',
    itemTypeKind: 'other',
    builtIn: true,
    fieldKeys: [
      'name',
      'sku',
      'supplier',
      'quantity_on_hand',
      'reorder_point',
      'reorder_quantity',
      'primary_location',
    ],
  },
  {
    id: 'custom',
    name: 'Custom',
    itemTypeKind: 'any',
    builtIn: true,
    // Deliberately empty: choosing Custom keeps whatever the user has built.
    fieldKeys: [],
  },
];

function readStorage(): unknown {
  try {
    const raw = window.localStorage.getItem(EXPORT_PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    // Corrupt JSON, disabled storage, private mode. A broken preset list must
    // never stop someone exporting.
    return [];
  }
}

function sanitize(raw: unknown): ExportPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const kind = r.itemTypeKind;
  if (kind !== 'book' && kind !== 'other' && kind !== 'any') return null;
  const keys = Array.isArray(r.fieldKeys) ? r.fieldKeys : [];
  const fieldKeys = keys.filter(
    (k): k is InventoryExportFieldKey => typeof k === 'string' && Boolean(getExportField(k)),
  );
  if (fieldKeys.length === 0) return null;
  return {
    id: r.id,
    name: r.name.slice(0, 60),
    itemTypeKind: kind,
    fieldKeys,
    builtIn: false,
  };
}

export function loadPersonalPresets(): ExportPreset[] {
  const raw = readStorage();
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitize)
    .filter((p): p is ExportPreset => p !== null)
    .slice(0, MAX_PERSONAL_PRESETS);
}

function write(presets: ExportPreset[]): ExportPreset[] {
  try {
    window.localStorage.setItem(EXPORT_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* quota or disabled storage — the in-memory list still works this session */
  }
  return presets;
}

export function savePersonalPreset(input: {
  name: string;
  itemTypeKind: 'book' | 'other';
  fieldKeys: InventoryExportFieldKey[];
}): ExportPreset[] {
  const name = input.name.trim().slice(0, 60);
  if (name.length === 0) return loadPersonalPresets();
  const existing = loadPersonalPresets();
  const match = existing.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.itemTypeKind === input.itemTypeKind,
  );
  const preset: ExportPreset = {
    id: match?.id ?? `personal-${Date.now().toString(36)}`,
    name,
    itemTypeKind: input.itemTypeKind,
    fieldKeys: [...input.fieldKeys],
    builtIn: false,
  };
  const next = match
    ? existing.map((p) => (p.id === match.id ? preset : p))
    : [...existing, preset].slice(-MAX_PERSONAL_PRESETS);
  return write(next);
}

export function deletePersonalPreset(id: string): ExportPreset[] {
  return write(loadPersonalPresets().filter((p) => p.id !== id));
}

export function presetsFor(itemTypeKind: 'book' | 'other'): ExportPreset[] {
  const builtIns = BUILT_IN_PRESETS.filter(
    (p) => p.itemTypeKind === 'any' || p.itemTypeKind === itemTypeKind,
  );
  const personal = loadPersonalPresets().filter(
    (p) => p.itemTypeKind === 'any' || p.itemTypeKind === itemTypeKind,
  );
  return [...builtIns, ...personal];
}
