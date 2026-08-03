import { describe, expect, it } from 'vitest';

import type { Permission } from '@stockpilot/core';

import {
  exportItemTypeKind,
  INVENTORY_EXPORT_MAX_FIELDS,
  inventoryExportRequestSchema,
  resolveExportFields,
} from './export-request';

const allow = (_p: Permission) => true;
const deny = (_p: Permission) => false;

function parseOptions(raw: unknown = {}) {
  const parsed = inventoryExportRequestSchema.parse({
    format: 'pdf',
    scope: 'all',
    options: raw,
  });
  return parsed.options;
}

describe('inventoryExportRequestSchema', () => {
  it('still accepts the pre-builder request shape unchanged', () => {
    // The two existing popovers post exactly this. They must keep working
    // while the builder is being built (and the mobile-free API stays valid).
    const parsed = inventoryExportRequestSchema.parse({
      format: 'csv',
      scope: 'filtered',
      itemType: 'book',
      filters: { q: 'algebra', status: 'active', stock: null, expected: true, sort: 'name_asc' },
    });
    expect(parsed.fields).toBeUndefined();
    expect(parsed.options.includeImages).toBe(false);
  });

  it('defaults every option the brief specifies', () => {
    const o = parseOptions();
    expect(o.includeImages).toBe(false);
    expect(o.imageMode).toBe('embedded');
    expect(o.imageSize).toBe('medium');
    expect(o.pdf.layout).toBe('table');
    expect(o.pdf.catalogColumns).toBe(2);
    expect(o.pdf.orientation).toBe('auto');
    expect(o.pdf.paperSize).toBe('letter');
    expect(o.pdf.density).toBe('comfortable');
    expect(o.pdf.repeatHeaders).toBe(true);
    expect(o.pdf.pageNumbers).toBe(true);
    expect(o.pdf.wrapText).toBe(true);
    expect(o.xlsx.freezeHeader).toBe(true);
    expect(o.xlsx.autoFilter).toBe(true);
    expect(o.xlsx.includeSummarySheet).toBe(false);
  });

  it('rejects an empty field list and an over-long one', () => {
    const base = { format: 'csv', scope: 'all' } as const;
    expect(inventoryExportRequestSchema.safeParse({ ...base, fields: [] }).success).toBe(false);
    expect(
      inventoryExportRequestSchema.safeParse({
        ...base,
        fields: Array.from({ length: INVENTORY_EXPORT_MAX_FIELDS + 1 }, () => 'name'),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown paper size, layout or catalog column count', () => {
    for (const bad of [
      { pdf: { paperSize: 'a4' } },
      { pdf: { layout: 'grid' } },
      { pdf: { catalogColumns: 4 } },
      { imageSize: 'huge' },
      { imageMode: 'inline' },
    ]) {
      expect(
        inventoryExportRequestSchema.safeParse({ format: 'pdf', scope: 'all', options: bad })
          .success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe('resolveExportFields — defaults', () => {
  it('falls back to the Books defaults when the client sent no fields', () => {
    const res = resolveExportFields({
      itemType: 'book',
      format: 'pdf',
      options: parseOptions(),
      can: allow,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.map((f) => f.key)).toContain('isbn');
    expect(res.fields[0]!.key).toBe('image');
  });

  it('falls back to the Items defaults for a non-book export, with no book fields', () => {
    const res = resolveExportFields({
      itemType: 'product',
      format: 'csv',
      options: parseOptions(),
      can: allow,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const f of res.fields) expect(f.appliesTo).toBe('all');
  });
});

describe('resolveExportFields — rejections', () => {
  const base = { itemType: 'book' as const, format: 'csv' as const, can: allow };

  it('rejects an unknown field key', () => {
    const res = resolveExportFields({
      ...base,
      fields: ['name', 'sku', 'not_a_field'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message).toContain('not_a_field');
  });

  it('rejects a duplicate field key', () => {
    const res = resolveExportFields({
      ...base,
      fields: ['name', 'sku', 'name'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message.toLowerCase()).toContain('duplicate');
  });

  it('rejects a book-only field on a product export', () => {
    const res = resolveExportFields({
      ...base,
      itemType: 'product',
      fields: ['name', 'isbn'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('ALLOWS a book field when the export spans every item type', () => {
    const res = resolveExportFields({
      ...base,
      itemType: 'all',
      fields: ['name', 'isbn'],
      options: parseOptions(),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a field list with no identifying column', () => {
    const res = resolveExportFields({
      ...base,
      fields: ['quantity_on_hand', 'category'],
      options: parseOptions(),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message).toContain('Name');
  });

  it('403s a field whose permission the caller lacks — the client cannot post its way in', () => {
    // No cost permission exists today (owner decision open), so this is proved
    // with a synthetic gate to keep the enforcement path itself covered.
    const res = resolveExportFields({
      ...base,
      fields: ['name', 'unit_cost'],
      options: parseOptions(),
      can: deny,
      permissionOverrides: { unit_cost: 'items:export' },
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects images on a format that cannot carry them', () => {
    const res = resolveExportFields({
      ...base,
      format: 'csv',
      fields: ['name', 'image'],
      options: parseOptions({ includeImages: true, imageMode: 'embedded' }),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message).toContain('Image URL');
  });

  it('accepts a CSV image URL column', () => {
    const res = resolveExportFields({
      ...base,
      format: 'csv',
      fields: ['name', 'image'],
      options: parseOptions({ includeImages: true, imageMode: 'url' }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imagesRequested).toBe(true);
  });

  it('rejects includeImages when the image field was not selected', () => {
    const res = resolveExportFields({
      ...base,
      format: 'pdf',
      fields: ['name', 'sku'],
      options: parseOptions({ includeImages: true }),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('reports imagesRequested false when the image field is absent — no image work at all', () => {
    const res = resolveExportFields({
      ...base,
      format: 'csv',
      fields: ['name', 'sku'],
      options: parseOptions(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.imagesRequested).toBe(false);
  });

  it('rejects the catalog layout for a non-book export', () => {
    const res = resolveExportFields({
      ...base,
      itemType: 'product',
      format: 'pdf',
      fields: ['name', 'sku'],
      options: parseOptions({ pdf: { layout: 'catalog' } }),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (res.ok) return;
    expect(res.message.toLowerCase()).toContain('book');
  });
});

describe('resolveExportFields — order', () => {
  it('returns the fields in the EXACT order requested, not registry order', () => {
    const res = resolveExportFields({
      itemType: 'book',
      format: 'xlsx',
      fields: ['status', 'isbn', 'name'],
      options: parseOptions(),
      can: allow,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.map((f) => f.key)).toEqual(['status', 'isbn', 'name']);
  });
});

describe('exportItemTypeKind', () => {
  it('treats only book as book', () => {
    expect(exportItemTypeKind('book')).toBe('book');
    expect(exportItemTypeKind('all')).toBe('other');
    expect(exportItemTypeKind('product')).toBe('other');
  });
});
