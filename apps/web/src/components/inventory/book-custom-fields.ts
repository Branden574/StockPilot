/**
 * Compose the `custom_fields` jsonb for a BOOK when the edit form saves.
 *
 * The form owns a fixed set of reserved book keys (author + rack/crate/grade).
 * We strip ALL of them from the existing custom_fields first, then re-add only
 * the ones that still have a value. That is what makes *clearing* a field on
 * edit actually remove it: a plain spread-merge only ever ADDS keys, so a
 * previously-set value (e.g. `book_crate_color: 'red'`) would otherwise stick
 * forever even after the user switches the dropdown to "No crate".
 *
 * Generic per-org custom fields are handled the same way via their def keys —
 * dropped up front, then re-added from the current form values.
 *
 * Keys the form does NOT own (e.g. size, isbn) are preserved untouched.
 */
import { normalizeRackFields } from '@stockpilot/core';

export const BOOK_FORM_RESERVED_KEYS = [
  'author',
  'book_rack_number',
  'book_rack_row',
  'book_crate_color',
  'book_crate_number',
  'book_grade',
] as const;

export interface ComposeBookCustomFieldsParams {
  existing: Record<string, unknown> | null | undefined;
  /** fieldKeys of the org's generic custom-field definitions (dropped + re-added). */
  customFieldDefKeys: string[];
  /** current generic custom-field values from the form. */
  customFieldValues: Record<string, unknown>;
  author: string;
  rackNumber: string;
  rackRow: string;
  crateColor: string;
  crateNumber: string;
  grade: string;
}

export function composeBookCustomFields(
  params: ComposeBookCustomFieldsParams,
): Record<string, unknown> {
  const base = { ...(params.existing ?? {}) } as Record<string, unknown>;
  // Strip every form-owned key so emptying an input clears the stored value.
  for (const key of BOOK_FORM_RESERVED_KEYS) delete base[key];
  for (const key of params.customFieldDefKeys) delete base[key];

  // DECOMPOSE: the rack-number input is free text, so a user who types the
  // whole label ("38-A") off the shelf must still be stored as ("38","A") —
  // the shape the Books rack filter reads. Storing the composite is what made
  // eight items invisible to their own rack on 2026-07-23.
  const rack = normalizeRackFields({ number: params.rackNumber, row: params.rackRow });
  const num = rack.number;
  const row = num ? (rack.row ?? '').toUpperCase() : '';
  const author = params.author.trim();
  const crateNumber = params.crateNumber.trim();

  return {
    ...base,
    ...params.customFieldValues,
    ...(author ? { author } : {}),
    ...(num ? { book_rack_number: num } : {}),
    ...(row ? { book_rack_row: row } : {}),
    ...(params.crateColor ? { book_crate_color: params.crateColor } : {}),
    ...(crateNumber ? { book_crate_number: crateNumber } : {}),
    ...(params.grade ? { book_grade: params.grade } : {}),
  };
}
