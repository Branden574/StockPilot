import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  diffMetadataFields,
  humanizeFieldName,
  MetadataDiff,
  stringifyMetadataValue,
} from './metadata-diff';

describe('diffMetadataFields', () => {
  it('returns a row only for keys whose value actually differs', () => {
    const rows = diffMetadataFields(
      { name: 'Widget', sku: 'W-1', price: 10 },
      { name: 'Widget Pro', sku: 'W-1', price: 10 },
    );
    expect(rows).toEqual([{ field: 'name', before: 'Widget', after: 'Widget Pro' }]);
  });

  it('renders "—" for a field absent on the before side (creation-only events)', () => {
    const rows = diffMetadataFields(null, { name: 'New item' });
    expect(rows).toEqual([{ field: 'name', before: '—', after: 'New item' }]);
  });

  it('renders "—" for a field absent on the after side (deletion-only events)', () => {
    const rows = diffMetadataFields({ status: 'active' }, null);
    expect(rows).toEqual([{ field: 'status', before: 'active', after: '—' }]);
  });

  it('renders "—" for an explicit null value on either side', () => {
    const rows = diffMetadataFields({ role: null }, { role: 'manager' });
    expect(rows).toEqual([{ field: 'role', before: '—', after: 'manager' }]);
  });

  it('returns no rows when before and after are identical', () => {
    expect(diffMetadataFields({ name: 'Same' }, { name: 'Same' })).toEqual([]);
  });

  it('returns no rows when both sides are null/undefined', () => {
    expect(diffMetadataFields(null, null)).toEqual([]);
    expect(diffMetadataFields(undefined, undefined)).toEqual([]);
  });

  it('stringifies a nested object value sensibly instead of "[object Object]"', () => {
    const rows = diffMetadataFields(
      { changes: { a: 1 } },
      { changes: { a: 1, b: 2 } },
    );
    expect(rows).toEqual([
      { field: 'changes', before: '{"a":1}', after: '{"a":1,"b":2}' },
    ]);
  });

  it('stringifies an array of primitives as a comma-joined list', () => {
    const rows = diffMetadataFields(
      { charterIds: ['a', 'b'] },
      { charterIds: ['a', 'b', 'c'] },
    );
    expect(rows).toEqual([{ field: 'charterIds', before: 'a, b', after: 'a, b, c' }]);
  });

  it('stringifies an array of objects as JSON, not [object Object]', () => {
    const rows = diffMetadataFields(
      { lines: [] },
      { lines: [{ sku: 'A' }, { sku: 'B' }] },
    );
    expect(rows).toEqual([
      { field: 'lines', before: '(none)', after: '[{"sku":"A"},{"sku":"B"}]' },
    ]);
  });

  it('handles mismatched key sets between before and after (module.enabled shape)', () => {
    // Real shape from module-settings.ts: before={enabled:[...]}, after={changes:[...]}
    const rows = diffMetadataFields(
      { enabled: ['inventory'] },
      { changes: [{ moduleId: 'rentals', enabled: true }] },
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.field === 'enabled')).toEqual({
      field: 'enabled',
      before: 'inventory',
      after: '—',
    });
    expect(rows.find((r) => r.field === 'changes')).toEqual({
      field: 'changes',
      before: '—',
      after: '[{"moduleId":"rentals","enabled":true}]',
    });
  });

  it('falls back to a single "value" row when neither side is a keyed object', () => {
    expect(diffMetadataFields('archived', 'active')).toEqual([
      { field: 'value', before: 'archived', after: 'active' },
    ]);
  });

  it('never crashes on arbitrary/weird jsonb (arrays, empty objects, mixed types)', () => {
    expect(() => diffMetadataFields([1, 2, 3], { a: undefined })).not.toThrow();
    expect(() => diffMetadataFields({}, {})).not.toThrow();
    expect(() => diffMetadataFields(42, true)).not.toThrow();
  });
});

describe('stringifyMetadataValue', () => {
  it('renders "—" for null, undefined, and empty string', () => {
    expect(stringifyMetadataValue(null)).toBe('—');
    expect(stringifyMetadataValue(undefined)).toBe('—');
    expect(stringifyMetadataValue('')).toBe('—');
  });

  it('renders booleans and numbers as plain strings', () => {
    expect(stringifyMetadataValue(true)).toBe('true');
    expect(stringifyMetadataValue(0)).toBe('0');
  });
});

describe('humanizeFieldName', () => {
  it('converts snake_case to a capitalized phrase', () => {
    expect(humanizeFieldName('public_display_name')).toBe('Public display name');
  });

  it('converts camelCase to a capitalized phrase', () => {
    expect(humanizeFieldName('charterIds')).toBe('Charter ids');
  });

  it('uppercases known acronyms instead of title-casing them', () => {
    expect(humanizeFieldName('po_number')).toBe('PO number');
    expect(humanizeFieldName('sku')).toBe('SKU');
    expect(humanizeFieldName('poNumber')).toBe('PO number');
  });

  it('does not uppercase words that merely contain an acronym as a substring', () => {
    expect(humanizeFieldName('unit_of_measure')).toBe('Unit of measure');
    expect(humanizeFieldName('reorder_point')).toBe('Reorder point');
  });
});

describe('MetadataDiff', () => {
  it('renders a diff drawer with the differing fields when before/after are present', () => {
    render(
      <MetadataDiff
        metadata={{
          before: { role: 'staff' },
          after: { role: 'manager' },
        }}
      />,
    );
    expect(screen.getByText('Show 1 field change')).toBeInTheDocument();
    expect(screen.getByText('Role:')).toBeInTheDocument();
    expect(screen.getByText('staff')).toBeInTheDocument();
    expect(screen.getByText('manager')).toBeInTheDocument();
  });

  it('renders the changed_keys chip when there is no before/after diff', () => {
    render(
      <MetadataDiff
        metadata={{
          before: null,
          after: null,
          changed_keys: ['name', 'sku'],
        }}
      />,
    );
    expect(screen.getByText('Fields on the edit (exact changes not recorded for this entry): Name, SKU')).toBeInTheDocument();
  });

  it('prefers the before/after drawer over the changed_keys chip when both are present', () => {
    render(
      <MetadataDiff
        metadata={{
          before: { role: 'staff' },
          after: { role: 'manager' },
          changed_keys: ['role'],
        }}
      />,
    );
    expect(screen.getByText('Show 1 field change')).toBeInTheDocument();
    expect(screen.queryByText(/Fields on the edit/)).not.toBeInTheDocument();
  });

  it('renders nothing for an empty diff and no changed_keys', () => {
    const { container } = render(<MetadataDiff metadata={{ before: null, after: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when metadata itself is null', () => {
    const { container } = render(<MetadataDiff metadata={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('never crashes on arbitrary metadata shapes', () => {
    expect(() =>
      render(<MetadataDiff metadata={{ before: [1, 2], after: 'weird', changed_keys: 'not-an-array' }} />),
    ).not.toThrow();
  });
});
