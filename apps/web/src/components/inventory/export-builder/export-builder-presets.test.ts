import { beforeEach, describe, expect, it } from 'vitest';

import {
  BUILT_IN_PRESETS,
  deletePersonalPreset,
  EXPORT_PRESETS_STORAGE_KEY,
  loadPersonalPresets,
  presetsFor,
  savePersonalPreset,
} from './export-builder-presets';

beforeEach(() => {
  window.localStorage.clear();
});

describe('BUILT_IN_PRESETS', () => {
  it('ships the eight the brief names', () => {
    expect(BUILT_IN_PRESETS.map((p) => p.name)).toEqual([
      'Books inventory',
      'Books with covers',
      'Books ISBN list',
      'Books storage list',
      'Inventory overview',
      'Inventory valuation',
      'Reorder report',
      'Custom',
    ]);
  });

  it('gives Books ISBN list exactly the brief fields, in order', () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === 'books-isbn-list')!;
    expect(preset.fieldKeys).toEqual([
      'name',
      'isbn',
      'sku',
      'author',
      'grade',
      'quantity_on_hand',
    ]);
  });

  it('gives Books with covers the image first', () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === 'books-with-covers')!;
    expect(preset.fieldKeys).toEqual([
      'image',
      'name',
      'isbn',
      'author',
      'grade',
      'quantity_on_hand',
      'rack',
      'crate',
    ]);
  });

  it('gives Books storage list the RAW rack and crate parts, not the combined labels', () => {
    const preset = BUILT_IN_PRESETS.find((p) => p.id === 'books-storage-list')!;
    expect(preset.fieldKeys).toEqual([
      'name',
      'isbn',
      'sku',
      'quantity_on_hand',
      'rack_number',
      'rack_row',
      'crate_color',
      'crate_number',
      'primary_location',
    ]);
  });

  it('never puts a book-only field in an inventory preset', () => {
    for (const id of ['inventory-overview', 'inventory-valuation', 'reorder-report']) {
      const preset = BUILT_IN_PRESETS.find((p) => p.id === id)!;
      expect(preset.fieldKeys).not.toContain('isbn');
      expect(preset.fieldKeys).not.toContain('rack');
    }
  });
});

describe('presetsFor', () => {
  it('offers books presets only to books exports', () => {
    const ids = presetsFor('other').map((p) => p.id);
    expect(ids).not.toContain('books-isbn-list');
    expect(ids).toContain('inventory-overview');
    expect(presetsFor('book').map((p) => p.id)).toContain('books-isbn-list');
  });

  it('appends the user\'s own presets after the built-ins', () => {
    savePersonalPreset({
      name: 'My audit sheet',
      itemTypeKind: 'book',
      fieldKeys: ['name', 'isbn'],
    });
    const list = presetsFor('book');
    expect(list.at(-1)!.name).toBe('My audit sheet');
    expect(list.at(-1)!.builtIn).toBe(false);
  });
});

describe('personal presets in localStorage', () => {
  it('round-trips through storage under a versioned key', () => {
    savePersonalPreset({ name: 'Mine', itemTypeKind: 'book', fieldKeys: ['name', 'sku'] });
    expect(window.localStorage.getItem(EXPORT_PRESETS_STORAGE_KEY)).toContain('Mine');
    expect(loadPersonalPresets()).toHaveLength(1);
  });

  it('replaces a preset saved under an existing name rather than duplicating it', () => {
    savePersonalPreset({ name: 'Mine', itemTypeKind: 'book', fieldKeys: ['name'] });
    const after = savePersonalPreset({
      name: 'Mine',
      itemTypeKind: 'book',
      fieldKeys: ['name', 'isbn'],
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.fieldKeys).toEqual(['name', 'isbn']);
  });

  it('deletes by id', () => {
    const saved = savePersonalPreset({
      name: 'Mine',
      itemTypeKind: 'book',
      fieldKeys: ['name'],
    });
    expect(deletePersonalPreset(saved[0]!.id)).toHaveLength(0);
  });

  it('survives corrupt storage instead of throwing', () => {
    window.localStorage.setItem(EXPORT_PRESETS_STORAGE_KEY, '{not json');
    expect(loadPersonalPresets()).toEqual([]);
  });

  it('drops unknown field keys read back from storage', () => {
    window.localStorage.setItem(
      EXPORT_PRESETS_STORAGE_KEY,
      JSON.stringify([
        { id: 'p1', name: 'Tampered', itemTypeKind: 'book', fieldKeys: ['name', 'evil_field'] },
      ]),
    );
    expect(loadPersonalPresets()[0]!.fieldKeys).toEqual(['name']);
  });
});
