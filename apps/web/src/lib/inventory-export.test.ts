import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
const categoriesList = vi.fn();
const locationsList = vi.fn();
const suppliersList = vi.fn();
const warehousesList = vi.fn();
const chartersList = vi.fn();

vi.mock('@/server/services/inventory', () => ({
  InventoryService: vi.fn().mockImplementation(() => ({ list: listMock })),
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: vi.fn().mockImplementation(() => ({ list: categoriesList })),
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: vi.fn().mockImplementation(() => ({ list: locationsList })),
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: vi.fn().mockImplementation(() => ({ list: suppliersList })),
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: vi.fn().mockImplementation(() => ({ list: warehousesList })),
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: vi.fn().mockImplementation(() => ({ list: chartersList })),
}));

import { InventoryService } from '@/server/services/inventory';
import { CategoriesService } from '@/server/services/categories';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { ChartersService } from '@/server/services/charters';
import {
  buildInventoryExportRows,
  buildInventoryExportSourceRows,
  INVENTORY_EXPORT_HEADERS,
} from './inventory-export';

const ctx = {} as never;

const sampleItem = {
  id: 'i1',
  name: 'Lenovo 300e',
  sku: 'SP-1',
  barcode: 'BC1',
  item_type: 'product',
  status: 'active',
  quantity_on_hand: 100,
  reorder_point: 5,
  reorder_quantity: 25,
  unit_cost: 10,
  retail_price: 20,
  category_id: 'c1',
  primary_location_id: 'l1',
  supplier_id: 's1',
  warehouse_id: 'w1',
  charter_id: 'ch1',
  tracking_type: 'none',
  custom_fields: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(InventoryService).mockImplementation(() => ({ list: listMock }) as never);
  vi.mocked(CategoriesService).mockImplementation(() => ({ list: categoriesList }) as never);
  vi.mocked(LocationsService).mockImplementation(() => ({ list: locationsList }) as never);
  vi.mocked(SuppliersService).mockImplementation(() => ({ list: suppliersList }) as never);
  vi.mocked(WarehousesService).mockImplementation(() => ({ list: warehousesList }) as never);
  vi.mocked(ChartersService).mockImplementation(() => ({ list: chartersList }) as never);
  listMock.mockReset();
  categoriesList.mockReset();
  locationsList.mockReset();
  suppliersList.mockReset();
  warehousesList.mockReset();
  chartersList.mockReset();
  listMock.mockResolvedValue({ items: [sampleItem], total: 1 });
  categoriesList.mockResolvedValue([{ id: 'c1', name: 'Electronics' }]);
  locationsList.mockResolvedValue([{ id: 'l1', name: 'DC4' }]);
  suppliersList.mockResolvedValue([{ id: 's1', name: 'Acme' }]);
  warehousesList.mockResolvedValue([{ id: 'w1', name: 'North WH' }]);
  chartersList.mockResolvedValue([{ id: 'ch1', name: 'Visalia' }]);
});

describe('buildInventoryExportRows', () => {
  it('maps a row with the canonical headers and resolved lookup names', async () => {
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.headers).toEqual([...INVENTORY_EXPORT_HEADERS]);
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0]!;
    expect(r.name).toBe('Lenovo 300e');
    expect(r.category).toBe('Electronics');
    expect(r.primary_location).toBe('DC4');
    expect(r.supplier).toBe('Acme');
    expect(r.warehouse).toBe('North WH');
    expect(r.charter).toBe('Visalia');
    expect(res.total).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it('FAILS CLOSED when a lookup throws — the export still returns the row, that column blank', async () => {
    suppliersList.mockRejectedValueOnce(new Error('module_disabled: suppliers'));
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows).toHaveLength(1);
    const r = res.rows[0]!;
    expect(r.supplier).toBe(''); // blanked, not a crash
    expect(r.category).toBe('Electronics'); // others unaffected
  });

  it('passes ids through for scope=selected', async () => {
    await buildInventoryExportRows(ctx, { scope: 'selected', itemType: 'all', ids: ['i1', 'i2'] });
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ ids: ['i1', 'i2'] }));
  });

  it("scope=selected uses expected:'any' so explicitly-selected flagged rows are NOT dropped (mig 0277)", async () => {
    await buildInventoryExportRows(ctx, { scope: 'selected', itemType: 'all', ids: ['i1'] });
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['i1'], status: 'all', expected: 'any' }),
    );
  });

  it('scope=filtered forwards the page\'s ?expected=1 (the Expected chip view) and spans lifecycles', async () => {
    await buildInventoryExportRows(ctx, {
      scope: 'filtered',
      itemType: 'product',
      filters: { expected: true },
    });
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: true, status: 'all' }),
    );
  });

  it('scope=filtered WITHOUT expected keeps the default exclusion (expected:false) and the given status', async () => {
    await buildInventoryExportRows(ctx, {
      scope: 'filtered',
      itemType: 'product',
      filters: { status: 'archived' },
    });
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ expected: false, status: 'archived' }),
    );
  });

  it('marks truncated when total exceeds returned rows', async () => {
    listMock.mockResolvedValueOnce({ items: [sampleItem], total: 99999 });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.truncated).toBe(true);
  });

  it('renders a NULL charter as "Generic", matching the inventory list page', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, charter_id: null }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.charter).toBe('Generic');
  });

  it('leaves the charter blank when the id is set but the lookup failed closed', async () => {
    chartersList.mockRejectedValueOnce(new Error('module_disabled: charters'));
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.charter).toBe('');
  });

  it('derives a book ISBN from the barcode', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, item_type: 'book', barcode: '9780262033848' }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'book' });
    expect(res.rows[0]!.isbn).toBe('9780262033848');
  });

  it('falls back through the legacy custom_fields ISBN keys, in order', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          ...sampleItem,
          item_type: 'book',
          barcode: null,
          custom_fields: { isbn13: '9780262033848', isbn10: '0262033844' },
        },
      ],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'book' });
    expect(res.rows[0]!.isbn).toBe('9780262033848');
  });

  it('never puts an ISBN on a non-book row', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, item_type: 'product', barcode: '012345678905' }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'product' });
    expect(res.rows[0]!.isbn).toBe('');
    expect(res.rows[0]!.barcode).toBe('012345678905');
  });

  it('keeps a leading-zero ISBN as a string — never a number', async () => {
    listMock.mockResolvedValueOnce({
      items: [{ ...sampleItem, item_type: 'book', barcode: '0262033844' }],
      total: 1,
    });
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'book' });
    expect(res.rows[0]!.isbn).toBe('0262033844');
    expect(typeof res.rows[0]!.isbn).toBe('string');
  });
});

describe('buildInventoryExportSourceRows', () => {
  it('returns a typed source row with resolved lookups and combined storage labels', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          ...sampleItem,
          item_type: 'book',
          barcode: '9780262033848',
          custom_fields: {
            author: 'Cormen',
            book_grade: 'College',
            book_rack_number: '38',
            book_rack_row: 'A',
            book_crate_color: 'blue',
            book_crate_number: '12',
          },
        },
      ],
      total: 1,
    });
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'book' });
    const r = res.rows[0]!;
    expect(r.id).toBe('i1');
    expect(r.itemType).toBe('book');
    expect(r.isbn).toBe('9780262033848');
    expect(r.author).toBe('Cormen');
    expect(r.grade).toBe('College');
    expect(r.rackNumber).toBe('38');
    expect(r.rackRow).toBe('A');
    expect(r.rackLabel).toBe('38-A');
    expect(r.crateColor).toBe('blue');
    expect(r.crateNumber).toBe('12');
    expect(r.crateLabel).toBe('Blue 12');
    expect(r.category).toBe('Electronics');
    expect(r.charter).toBe('Visalia');
    expect(res.slug).toBe('books');
  });

  it('carries a non-zero reorder quantity through from the service row, same as reorder point ' +
    '(it must never be silently defaulted to 0 — that was the export-builder bug)', async () => {
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    const r = res.rows[0]!;
    expect(r.reorderPoint).toBe(5);
    expect(r.reorderQuantity).toBe(25);
  });

  it('never populates image data — that is the caller\'s explicit opt-in', async () => {
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.image).toBeNull();
  });

  it('says Generic for a null charter, exactly like the flat row builder', async () => {
    listMock.mockResolvedValueOnce({ items: [{ ...sampleItem, charter_id: null }], total: 1 });
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.rows[0]!.charter).toBe('Generic');
  });

  it('emits empty strings rather than null or undefined for every text field', async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          ...sampleItem,
          barcode: null,
          category_id: null,
          primary_location_id: null,
          supplier_id: null,
          warehouse_id: null,
          custom_fields: null,
        },
      ],
      total: 1,
    });
    const res = await buildInventoryExportSourceRows(ctx, { scope: 'all', itemType: 'all' });
    const r = res.rows[0]!;
    for (const key of [
      'barcode',
      'category',
      'primaryLocation',
      'supplier',
      'warehouse',
      'author',
      'isbn',
      'grade',
      'rackNumber',
      'rackRow',
      'crateColor',
      'crateNumber',
      'rackLabel',
      'crateLabel',
    ] as const) {
      expect(r[key], `${key} was ${String(r[key])}`).toBe('');
    }
  });

  it('keeps the flat legacy row builder byte-compatible with what it returned before', async () => {
    // R1: /api/inventory/export.csv and its consumers must not move.
    const res = await buildInventoryExportRows(ctx, { scope: 'all', itemType: 'all' });
    expect(res.headers).toEqual([...INVENTORY_EXPORT_HEADERS]);
    expect(Object.keys(res.rows[0]!).sort()).toEqual([...INVENTORY_EXPORT_HEADERS].sort());
  });

  it('uses the same list() arguments as the flat builder for every scope', async () => {
    await buildInventoryExportSourceRows(ctx, {
      scope: 'selected',
      itemType: 'all',
      ids: ['i1'],
    });
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['i1'], status: 'all', expected: 'any' }),
    );
  });
});
