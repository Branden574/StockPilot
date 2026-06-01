import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_TYPES,
  isSnakeCaseKey,
  validateCustomFields,
  validateCustomFieldValue,
  type CustomFieldDefinition,
  type CustomFieldType,
} from './custom-fields';

function def(
  fieldType: CustomFieldType,
  partial: Partial<CustomFieldDefinition> = {},
): CustomFieldDefinition {
  return {
    id: 'def-1',
    organizationId: 'org-1',
    entity: 'item',
    fieldKey: 'warranty_months',
    label: 'Warranty (months)',
    fieldType,
    options: null,
    required: false,
    sortOrder: 0,
    archived: false,
    ...partial,
  };
}

describe('CUSTOM_FIELD_TYPES', () => {
  it('lists the five supported types', () => {
    expect([...CUSTOM_FIELD_TYPES].sort()).toEqual(
      ['checkbox', 'date', 'number', 'select', 'text'].sort(),
    );
  });
});

describe('isSnakeCaseKey', () => {
  it('accepts snake_case keys', () => {
    expect(isSnakeCaseKey('color')).toBe(true);
    expect(isSnakeCaseKey('warranty_months')).toBe(true);
    expect(isSnakeCaseKey('a1_b2_c3')).toBe(true);
  });
  it('rejects non-snake_case', () => {
    expect(isSnakeCaseKey('Color')).toBe(false);
    expect(isSnakeCaseKey('warrantyMonths')).toBe(false);
    expect(isSnakeCaseKey('_leading')).toBe(false);
    expect(isSnakeCaseKey('trailing_')).toBe(false);
    expect(isSnakeCaseKey('double__underscore')).toBe(false);
    expect(isSnakeCaseKey('1starts_with_digit')).toBe(false);
    expect(isSnakeCaseKey('has space')).toBe(false);
    expect(isSnakeCaseKey('')).toBe(false);
    expect(isSnakeCaseKey(42)).toBe(false);
    expect(isSnakeCaseKey(null)).toBe(false);
  });
});

describe('validateCustomFieldValue — required', () => {
  it('rejects empty value when required (text)', () => {
    expect(validateCustomFieldValue(def('text', { required: true }), '')).toEqual({
      ok: false,
      error: 'Warranty (months) is required.',
    });
    expect(validateCustomFieldValue(def('text', { required: true }), '   ')).toMatchObject({
      ok: false,
    });
    expect(validateCustomFieldValue(def('text', { required: true }), null)).toMatchObject({
      ok: false,
    });
    expect(validateCustomFieldValue(def('text', { required: true }), undefined)).toMatchObject({
      ok: false,
    });
  });
  it('passes empty value when optional', () => {
    expect(validateCustomFieldValue(def('text'), '')).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('number'), undefined)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('date'), null)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('select', { options: [] }), '')).toEqual({ ok: true });
  });
});

describe('validateCustomFieldValue — text', () => {
  it('accepts strings', () => {
    expect(validateCustomFieldValue(def('text'), 'hello')).toEqual({ ok: true });
  });
  it('rejects non-strings', () => {
    expect(validateCustomFieldValue(def('text'), 123)).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('text'), true)).toMatchObject({ ok: false });
  });
});

describe('validateCustomFieldValue — number', () => {
  it('accepts finite numbers and numeric strings', () => {
    expect(validateCustomFieldValue(def('number'), 42)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('number'), 0)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('number'), -3.14)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('number'), '12.5')).toEqual({ ok: true });
  });
  it('rejects NaN/Infinity/non-numeric strings', () => {
    expect(validateCustomFieldValue(def('number'), 'abc')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('number'), Number.POSITIVE_INFINITY)).toMatchObject({
      ok: false,
    });
    expect(validateCustomFieldValue(def('number'), NaN)).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('number'), {})).toMatchObject({ ok: false });
  });
});

describe('validateCustomFieldValue — date', () => {
  it('accepts ISO strings and Date objects', () => {
    expect(validateCustomFieldValue(def('date'), '2026-06-01')).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('date'), '2026-06-01T12:00:00Z')).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('date'), new Date())).toEqual({ ok: true });
  });
  it('rejects unparseable dates', () => {
    expect(validateCustomFieldValue(def('date'), 'not-a-date')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('date'), new Date('nope'))).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('date'), 12345)).toMatchObject({ ok: false });
  });
});

describe('validateCustomFieldValue — select', () => {
  const selectDef = def('select', {
    fieldKey: 'color',
    label: 'Color',
    options: [
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
    ],
  });
  it('accepts a value present in options', () => {
    expect(validateCustomFieldValue(selectDef, 'red')).toEqual({ ok: true });
    expect(validateCustomFieldValue(selectDef, 'blue')).toEqual({ ok: true });
  });
  it('rejects a value not in options', () => {
    expect(validateCustomFieldValue(selectDef, 'green')).toEqual({
      ok: false,
      error: 'Color must be one of the allowed options.',
    });
  });
  it('rejects non-string and missing-options cases', () => {
    expect(validateCustomFieldValue(selectDef, 5)).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('select', { options: null }), 'x')).toMatchObject({
      ok: false,
    });
  });
});

describe('validateCustomFieldValue — checkbox', () => {
  it('accepts booleans', () => {
    expect(validateCustomFieldValue(def('checkbox'), true)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('checkbox'), false)).toEqual({ ok: true });
  });
  it('treats absent as valid when optional', () => {
    expect(validateCustomFieldValue(def('checkbox'), undefined)).toEqual({ ok: true });
    expect(validateCustomFieldValue(def('checkbox'), null)).toEqual({ ok: true });
  });
  it('requires explicit true when required', () => {
    expect(validateCustomFieldValue(def('checkbox', { required: true }), true)).toEqual({
      ok: true,
    });
    expect(validateCustomFieldValue(def('checkbox', { required: true }), false)).toMatchObject({
      ok: false,
    });
    expect(
      validateCustomFieldValue(def('checkbox', { required: true }), undefined),
    ).toMatchObject({ ok: false });
  });
  it('rejects non-boolean values', () => {
    expect(validateCustomFieldValue(def('checkbox'), 'true')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('checkbox'), 1)).toMatchObject({ ok: false });
  });
});

describe('validateCustomFields — whole object', () => {
  const defs: CustomFieldDefinition[] = [
    def('text', { fieldKey: 'material', label: 'Material', required: true }),
    def('number', { fieldKey: 'weight', label: 'Weight' }),
    def('select', {
      fieldKey: 'color',
      label: 'Color',
      options: [{ value: 'red', label: 'Red' }],
    }),
  ];

  it('passes when all defined fields are valid', () => {
    expect(
      validateCustomFields(defs, { material: 'steel', weight: 5, color: 'red' }),
    ).toEqual({ ok: true });
  });

  it('returns the first failing field', () => {
    expect(validateCustomFields(defs, { weight: 'heavy' })).toMatchObject({ ok: false });
  });

  it('ignores reserved/undefined keys', () => {
    expect(
      validateCustomFields(defs, {
        material: 'steel',
        book_rack_number: '12',
        size: 'L',
        author: 'someone',
        stray_key: 'whatever',
      }),
    ).toEqual({ ok: true });
  });

  it('skips archived definitions', () => {
    const withArchived = [
      ...defs,
      def('text', { fieldKey: 'old', label: 'Old', required: true, archived: true }),
    ];
    expect(
      validateCustomFields(withArchived, { material: 'steel', color: 'red' }),
    ).toEqual({ ok: true });
  });

  it('handles null/undefined values object', () => {
    expect(validateCustomFields([def('text', { fieldKey: 'x', label: 'X' })], null)).toEqual({
      ok: true,
    });
    expect(
      validateCustomFields([def('text', { fieldKey: 'x', label: 'X', required: true })], undefined),
    ).toMatchObject({ ok: false });
  });
});
