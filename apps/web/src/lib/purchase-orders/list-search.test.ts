import { describe, expect, it } from 'vitest';

import { poMatchesSearch, searchedPage } from './list-search';

/**
 * The purchase orders list's one search rule (small fixes slice 8): the
 * instant table, the server-paged Overdue view and the CSV export all search
 * with it, as the database's purchase_orders_page does for the other
 * server-paged views (ILIKE with %, _ and \ escaped: literal, any case).
 */
const NAMES: Record<string, string> = { 'sup-1': 'Acme Paper', 'sup-2': 'TechSource' };
const name = (id: string | null) => (id ? (NAMES[id] ?? '—') : '—');

describe('poMatchesSearch', () => {
  it('PO number or supplier name, any case, an empty query matching all', () => {
    const po = { po_number: 'PO-2026-0042', supplier_id: 'sup-2' };
    expect(poMatchesSearch(po, 'po-2026', name)).toBe(true);
    expect(poMatchesSearch(po, 'techSOURCE', name)).toBe(true);
    expect(poMatchesSearch(po, 'acme', name)).toBe(false);
    expect(poMatchesSearch(po, '   ', name)).toBe(true);
  });

  it('literal: % and _ are characters, as the database escapes them', () => {
    expect(poMatchesSearch({ po_number: 'SKU_001', supplier_id: null }, 'SKU_0', name)).toBe(true);
    expect(poMatchesSearch({ po_number: 'SKU-001', supplier_id: null }, 'SKU_0', name)).toBe(false);
    expect(poMatchesSearch({ po_number: 'PO-1', supplier_id: null }, '%', name)).toBe(false);
  });

  it('a purchase order with no supplier, or one the list does not name, reads "—"', () => {
    expect(poMatchesSearch({ po_number: 'PO-1', supplier_id: null }, '—', name)).toBe(true);
    expect(poMatchesSearch({ po_number: 'PO-1', supplier_id: 'sup-archived' }, '—', name)).toBe(
      true,
    );
  });
});

describe('searchedPage', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    po_number: `PO-${i + 1}`,
    supplier_id: 'sup-1',
  }));

  it('one page of the matches, and how many match in all', () => {
    expect(searchedPage(rows, { query: '', page: 2, perPage: 3, supplierName: name })).toEqual({
      rows: rows.slice(3, 6),
      total: 7,
    });
  });

  it('a page past the end is empty, with the true total', () => {
    expect(searchedPage(rows, { query: 'acme', page: 9, perPage: 3, supplierName: name })).toEqual({
      rows: [],
      total: 7,
    });
  });
});
