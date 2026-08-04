import { describe, expect, it } from 'vitest';

import {
  availableFieldsFor,
  builderSummaryParts,
  initialExportBuilderState,
  moveField,
  restoreDefaults,
  scopeSummary,
  setFormat,
  setOptions,
  toExportRequest,
  toggleField,
  validateExportBuilder,
} from './export-builder-state';

describe('initialExportBuilderState', () => {
  it('starts a books export on the Books defaults with covers on', () => {
    const s = initialExportBuilderState('book');
    expect(s.fieldKeys[0]).toBe('image');
    expect(s.fieldKeys).toContain('isbn');
    expect(s.options.includeImages).toBe(true);
    expect(s.format).toBe('pdf');
  });

  it('starts an items export with no image field and images off', () => {
    const s = initialExportBuilderState('other');
    expect(s.fieldKeys).not.toContain('image');
    expect(s.options.includeImages).toBe(false);
  });
});

describe('toggleField', () => {
  it('removes a selected field and re-adds it in canonical position, not at the end', () => {
    let s = initialExportBuilderState('book');
    s = toggleField(s, 'isbn');
    expect(s.fieldKeys).not.toContain('isbn');
    s = toggleField(s, 'isbn');
    // Canonical order puts ISBN before author and after sku's registry slot;
    // what matters is that it did NOT land last.
    expect(s.fieldKeys.at(-1)).not.toBe('isbn');
  });

  it('turns includeImages on and off with the image field', () => {
    let s = initialExportBuilderState('other');
    s = toggleField(s, 'image');
    expect(s.options.includeImages).toBe(true);
    s = toggleField(s, 'image');
    expect(s.options.includeImages).toBe(false);
  });
});

describe('moveField', () => {
  it('moves a field up, down, to the top and to the bottom', () => {
    let s = initialExportBuilderState('other');
    const original = [...s.fieldKeys];
    s = moveField(s, original[2]!, 'up');
    expect(s.fieldKeys[1]).toBe(original[2]);
    s = moveField(s, original[2]!, 'top');
    expect(s.fieldKeys[0]).toBe(original[2]);
    s = moveField(s, original[2]!, 'bottom');
    expect(s.fieldKeys.at(-1)).toBe(original[2]);
    s = moveField(s, original[2]!, 'up');
    expect(s.fieldKeys.at(-2)).toBe(original[2]);
  });

  it('is a no-op at the ends and for a field that is not selected', () => {
    const s = initialExportBuilderState('other');
    expect(moveField(s, s.fieldKeys[0]!, 'up').fieldKeys).toEqual(s.fieldKeys);
    expect(moveField(s, s.fieldKeys.at(-1)!, 'down').fieldKeys).toEqual(s.fieldKeys);
    expect(moveField(s, 'created_at', 'up').fieldKeys).toEqual(s.fieldKeys);
  });
});

// The brief's own test file imports `restoreDefaults` but never exercises
// it — an unused import that fails this repo's `noUnusedLocals` typecheck.
// This is the ONE place Task 14's dialog calls it ("Restore recommended
// defaults"), so it earns real, literal-pinned coverage rather than a
// deleted import.
describe('restoreDefaults', () => {
  it('puts fields and options back to the registry defaults but keeps the current format', () => {
    let s = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    s = toggleField(s, 'isbn');
    s = setOptions(s, { imageSize: 'large' });
    expect(s.fieldKeys).not.toContain('isbn');

    const restored = restoreDefaults(s, 'book');
    expect(restored.format).toBe('csv');
    expect(restored.fieldKeys[0]).toBe('image');
    expect(restored.fieldKeys).toContain('isbn');
    expect(restored.options.imageSize).toBe('medium');
    // Still on CSV, so the image mode stays coerced to URL, not reset to
    // embedded — "defaults" means the registry selection, not the format.
    expect(restored.options.imageMode).toBe('url');
  });

  it('restoring an items export drops back to items defaults with images off', () => {
    const s = toggleField(initialExportBuilderState('other'), 'image');
    expect(s.options.includeImages).toBe(true);

    const restored = restoreDefaults(s, 'other');
    expect(restored.fieldKeys).not.toContain('image');
    expect(restored.options.includeImages).toBe(false);
  });
});

describe('setFormat', () => {
  it('switching to CSV forces the image mode to URL', () => {
    const s = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    expect(s.options.imageMode).toBe('url');
  });

  it('switching back to PDF restores embedded images', () => {
    let s = setFormat(initialExportBuilderState('book'), 'csv', 'book');
    s = setFormat(s, 'pdf', 'book');
    expect(s.options.imageMode).toBe('embedded');
  });

  it('drops the catalog layout when the format is no longer PDF', () => {
    let s = setOptions(initialExportBuilderState('book'), { pdf: { layout: 'catalog' } });
    s = setFormat(s, 'xlsx', 'book');
    expect(s.options.pdf.layout).toBe('table');
  });
});

describe('validateExportBuilder', () => {
  it('accepts the defaults', () => {
    expect(validateExportBuilder(initialExportBuilderState('book')).ok).toBe(true);
  });

  it('refuses an empty selection', () => {
    const s = { ...initialExportBuilderState('book'), fieldKeys: [] };
    const res = validateExportBuilder(s);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('at least one');
  });

  it('refuses a selection with no identifying field, naming the four that count', () => {
    const s = { ...initialExportBuilderState('book'), fieldKeys: ['quantity_on_hand' as const] };
    const res = validateExportBuilder(s);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('Name');
    expect(res.message).toContain('SKU');
    expect(res.message).toContain('ISBN');
    expect(res.message).toContain('Barcode');
  });
});

describe('availableFieldsFor', () => {
  it('hides book-only fields from an items export', () => {
    const keys = availableFieldsFor('other', 'csv').map((f) => f.key);
    expect(keys).not.toContain('isbn');
    expect(keys).toContain('name');
  });

  it('offers book fields on a books export', () => {
    expect(availableFieldsFor('book', 'pdf').map((f) => f.key)).toContain('isbn');
  });
});

describe('scopeSummary', () => {
  it('matches the brief copy for each scope', () => {
    expect(scopeSummary({ scope: 'filtered', count: 111, itemTypeKind: 'book' })).toBe(
      'Exporting: 111 filtered books',
    );
    expect(scopeSummary({ scope: 'selected', count: 12, itemTypeKind: 'other' })).toBe(
      'Exporting: 12 selected items',
    );
    expect(scopeSummary({ scope: 'all', count: null, itemTypeKind: 'other' })).toBe(
      'Exporting: All active inventory items',
    );
    expect(scopeSummary({ scope: 'all', count: null, itemTypeKind: 'book' })).toBe(
      'Exporting: All active books',
    );
  });

  it('singularizes one record and omits an unknown count', () => {
    expect(scopeSummary({ scope: 'selected', count: 1, itemTypeKind: 'book' })).toBe(
      'Exporting: 1 selected book',
    );
    expect(scopeSummary({ scope: 'filtered', count: null, itemTypeKind: 'book' })).toBe(
      'Exporting: the filtered books',
    );
  });
});

describe('builderSummaryParts', () => {
  it('reports count, field count, images and the labelled page estimate', () => {
    const parts = builderSummaryParts({
      state: initialExportBuilderState('book'),
      itemTypeKind: 'book',
      rowCount: 111,
    });
    expect(parts[0]).toBe('111 books');
    expect(parts).toContain('12 selected fields');
    expect(parts).toContain('Cover images included');
    expect(parts.some((p) => p.startsWith('Estimated '))).toBe(true);
    expect(parts.some((p) => p === 'Landscape Letter')).toBe(true);
  });

  it('says nothing about pages for a CSV', () => {
    const parts = builderSummaryParts({
      state: setFormat(initialExportBuilderState('book'), 'csv', 'book'),
      itemTypeKind: 'book',
      rowCount: 111,
    });
    expect(parts.some((p) => p.includes('PDF pages'))).toBe(false);
  });
});

describe('toExportRequest', () => {
  it('sends the fields in order plus the options, and nothing else', () => {
    const req = toExportRequest(initialExportBuilderState('book'), {
      scope: 'filtered',
      itemType: 'book',
      filters: { q: 'algebra' },
      presetName: 'Books inventory',
    });
    expect(req.format).toBe('pdf');
    expect(req.scope).toBe('filtered');
    expect(req.itemType).toBe('book');
    expect(req.fields?.[0]).toBe('image');
    expect(req.options?.presetName).toBe('Books inventory');
    expect(req.ids).toBeUndefined();
  });

  it('carries ids for a selected export and drops the filters', () => {
    const req = toExportRequest(initialExportBuilderState('other'), {
      scope: 'selected',
      itemType: 'all',
      ids: ['a', 'b'],
      filters: { q: 'ignored' },
    });
    expect(req.ids).toEqual(['a', 'b']);
    expect(req.filters).toBeUndefined();
  });
});
