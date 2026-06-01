/**
 * Per-org CUSTOM FIELD definitions for items.
 *
 * A definition describes one snake_case key stored inside
 * inventory_items.custom_fields: its type, label, whether it is required, and
 * (for selects) the allowed options. These are PURE types + a PURE validator —
 * no React, no platform imports — so they run identically on the client editor,
 * the server action, and the inventory service save path.
 *
 * `validateCustomFieldValue` is the AUTHORITATIVE per-value check. The item form
 * runs it for instant feedback; the inventory service re-runs it on save so a
 * crafted payload can never store a value that violates a definition.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox';

/** The allowed field types, as a runtime array (zod enums, type pickers). */
export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  'text',
  'number',
  'date',
  'select',
  'checkbox',
];

/** One option for a `select` custom field. */
export interface CustomFieldOption {
  value: string;
  label: string;
}

/**
 * A single per-org custom field definition. Mirrors the
 * `custom_field_definitions` table (migration 0159). `options` is the parsed
 * array of {value,label} for selects, otherwise null/undefined.
 */
export interface CustomFieldDefinition {
  id: string;
  organizationId: string;
  entity: 'item';
  /** snake_case key inside inventory_items.custom_fields. */
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: CustomFieldOption[] | null;
  required: boolean;
  sortOrder: number;
  archived: boolean;
}

export type CustomFieldValidationResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True for `null`, `undefined`, or an all-whitespace / empty string. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  return false;
}

/** A snake_case key: lowercase letters/digits in underscore-separated words. */
export function isSnakeCaseKey(key: unknown): key is string {
  return typeof key === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key);
}

// ---------------------------------------------------------------------------
// validateCustomFieldValue — pure, authoritative per-value validator
// ---------------------------------------------------------------------------

/**
 * Validate a single custom_fields value against its definition.
 *
 *  - required: a missing/empty value (null/undefined/blank string) is rejected
 *    ONLY when `def.required`. For checkbox, "required" means it must be `true`.
 *  - text:     must be a string.
 *  - number:   must be a finite number (or a finite numeric string).
 *  - date:     must parse as a date (ISO string or Date).
 *  - select:   value must equal one of def.options[].value.
 *  - checkbox: must be a boolean.
 *
 * An OPTIONAL field whose value is empty always passes (nothing to check).
 */
export function validateCustomFieldValue(
  def: CustomFieldDefinition,
  value: unknown,
): CustomFieldValidationResult {
  const label = def.label || def.fieldKey;

  // Checkbox is special: an absent value reads as `false`, which is a valid
  // boolean. A required checkbox must be explicitly true.
  if (def.fieldType === 'checkbox') {
    if (value === undefined || value === null) {
      if (def.required) return { ok: false, error: `${label} is required.` };
      return { ok: true };
    }
    if (typeof value !== 'boolean') {
      return { ok: false, error: `${label} must be true or false.` };
    }
    if (def.required && value !== true) {
      return { ok: false, error: `${label} is required.` };
    }
    return { ok: true };
  }

  // Every other type: empty is allowed unless required.
  if (isEmpty(value)) {
    if (def.required) return { ok: false, error: `${label} is required.` };
    return { ok: true };
  }

  switch (def.fieldType) {
    case 'text': {
      if (typeof value !== 'string') {
        return { ok: false, error: `${label} must be text.` };
      }
      return { ok: true };
    }
    case 'number': {
      const num =
        typeof value === 'number'
          ? value
          : typeof value === 'string'
            ? Number(value)
            : NaN;
      if (!Number.isFinite(num)) {
        return { ok: false, error: `${label} must be a number.` };
      }
      return { ok: true };
    }
    case 'date': {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime())
          ? { ok: false, error: `${label} must be a valid date.` }
          : { ok: true };
      }
      if (typeof value !== 'string') {
        return { ok: false, error: `${label} must be a valid date.` };
      }
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) {
        return { ok: false, error: `${label} must be a valid date.` };
      }
      return { ok: true };
    }
    case 'select': {
      if (typeof value !== 'string') {
        return { ok: false, error: `${label} must be one of the allowed options.` };
      }
      const options = Array.isArray(def.options) ? def.options : [];
      const match = options.some((o) => o && o.value === value);
      if (!match) {
        return { ok: false, error: `${label} must be one of the allowed options.` };
      }
      return { ok: true };
    }
    default: {
      // Exhaustive: an unknown type is a programming error, fail closed.
      return { ok: false, error: `${label} has an unsupported field type.` };
    }
  }
}

/**
 * Validate a whole custom_fields object against a set of definitions. Returns
 * the FIRST failing field's error (or ok). Only keys that have a definition are
 * checked — reserved/hardcoded keys (book_rack_number/size/author/...) and any
 * other stray keys are left untouched, so this never breaks existing data.
 */
export function validateCustomFields(
  definitions: CustomFieldDefinition[],
  values: Record<string, unknown> | null | undefined,
): CustomFieldValidationResult {
  const v = values ?? {};
  for (const def of definitions) {
    if (def.archived) continue;
    const result = validateCustomFieldValue(def, v[def.fieldKey]);
    if (!result.ok) return result;
  }
  return { ok: true };
}
