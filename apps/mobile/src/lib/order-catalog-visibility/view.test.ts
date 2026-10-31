import { describe, expect, it } from 'vitest';

import {
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_LOAD_FAILED_COPY,
  ORDER_ITEMS_NO_ACCESS_COPY,
  ORDER_ITEMS_OFFLINE_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  parseOrderCatalogManageQuery,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageRow,
} from '@stockpilot/core';

import { manageFailure } from './api';
import {
  manageActiveFilterCount,
  manageAnswerKey,
  manageListView,
  managePaging,
  manageRowDetail,
  manageRowHiddenSince,
  manageRowIdentifier,
  manageRowSpokenLabel,
  manageRowStatePill,
  offerRetry,
  pageBeyondEnd,
  pageSelectState,
  recordFromRow,
  rowsAfterWrite,
  savedOutcome,
} from './view';

const ORG = '11111111-1111-4111-8111-111111111111';
const WH = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OP = '55555555-5555-4555-8555-555555555555';

function row(over: Partial<OrderCatalogManageRow> = {}): OrderCatalogManageRow {
  return {
    id: A,
    name: 'New Hire Shirt',
    sku: 'NHS-XS',
    identifier: null,
    itemType: 'item',
    sizeOrEdition: 'XS',
    warehouseId: WH,
    warehouseName: 'North',
    categoryName: 'Apparel',
    familyId: null,
    familyName: null,
    expected: false,
    visible: true,
    hiddenSince: null,
    thumbUrl: null,
    ...over,
  };
}

function answer(over: Partial<OrderCatalogManageListAnswer> = {}): OrderCatalogManageListAnswer {
  return { organizationId: ORG, viewer: { canManage: true }, page: 1, pageSize: 25, total: 1, rows: [row()], ...over };
}

describe('a row’s words', () => {
  it('the state in core’s words: Shown in Orders (ok) or Hidden from Orders (warn)', () => {
    expect(manageRowStatePill(row())).toEqual({ label: ORDER_ITEMS_STATE_SHOWN_COPY, status: 'ok' });
    expect(manageRowStatePill(row({ visible: false }))).toEqual({ label: ORDER_ITEMS_STATE_HIDDEN_COPY, status: 'warn' });
  });

  it('"Hidden since <date>" only for a hidden record with a readable date', () => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    expect(manageRowHiddenSince(row({ visible: false, hiddenSince: '2026-10-26T12:00:00Z' }), fmt)).toBe('Hidden since 2026-10-26');
    expect(manageRowHiddenSince(row({ visible: true, hiddenSince: '2026-10-26T12:00:00Z' }), fmt)).toBeNull();
    expect(manageRowHiddenSince(row({ visible: false, hiddenSince: null }), fmt)).toBeNull();
    expect(manageRowHiddenSince(row({ visible: false, hiddenSince: 'not a date' }), fmt)).toBeNull();
  });

  it('the detail: the family (when it is not the name) and the size, or a book’s author', () => {
    expect(manageRowDetail(row({ familyName: 'New Hire Shirt' }))).toBe('XS');
    expect(manageRowDetail(row({ familyName: 'Onboarding apparel' }))).toBe('Onboarding apparel · XS');
    expect(manageRowDetail(row({ itemType: 'book', sizeOrEdition: 'A. Writer', name: 'Field Guide to Ponds' }))).toBe('A. Writer');
    expect(manageRowDetail(row({ sizeOrEdition: null, familyName: null }))).toBeNull();
  });

  it('the identifier: the SKU, then the barcode or ISBN when it is another value', () => {
    expect(manageRowIdentifier(row({ identifier: '9780000000002' }))).toBe('NHS-XS · 9780000000002');
    expect(manageRowIdentifier(row({ identifier: 'NHS-XS' }))).toBe('NHS-XS');
    expect(manageRowIdentifier(row({ sku: '', identifier: '9780000000002' }))).toBe('9780000000002');
    expect(manageRowIdentifier(row({ sku: '', identifier: null }))).toBe('');
  });

  it('the checkbox’s spoken name: the record, its size, identifier and warehouse, then its state', () => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    expect(manageRowSpokenLabel(row({ identifier: '123' }), fmt)).toBe('New Hire Shirt, XS, NHS-XS · 123, North, Shown in Orders');
    expect(
      manageRowSpokenLabel(row({ visible: false, expected: true, hiddenSince: '2026-10-26T12:00:00Z', warehouseName: null }), fmt),
    ).toBe('New Hire Shirt, XS, NHS-XS, Hidden from Orders, Expected, Hidden since 2026-10-26');
    expect(manageRowSpokenLabel(row({ name: '', sizeOrEdition: null }), fmt)).toBe('NHS-XS, North, Shown in Orders');
  });

  it('a selected record keeps its name, identifier and state, under a lower-cased id', () => {
    expect(recordFromRow(row({ id: A.toUpperCase(), identifier: '123', visible: false }))).toEqual({
      id: A,
      name: 'New Hire Shirt',
      identifier: 'NHS-XS · 123',
      visible: false,
    });
    expect(recordFromRow(row({ sku: '', identifier: null })).identifier).toBeNull();
  });
});

describe('paging over the full dataset (25 a page, total exact)', () => {
  it('the page count and the range describe what the page shows', () => {
    expect(managePaging(answer({ page: 2, total: 26, rows: [row()] }))).toEqual({ pageCount: 2, rangeStart: 26, rangeEnd: 26, total: 26 });
    expect(managePaging(answer({ page: 1, total: 1240, rows: Array.from({ length: 25 }, () => row()) }))).toEqual({
      pageCount: 50,
      rangeStart: 1,
      rangeEnd: 25,
      total: 1240,
    });
    expect(managePaging(answer({ total: 0, rows: [] }))).toEqual({ pageCount: 1, rangeStart: 0, rangeEnd: 0, total: 0 });
  });

  it('a page past the end (records hidden or removed since) goes to the last page; page 1 never moves', () => {
    expect(pageBeyondEnd(answer({ page: 9, total: 30, rows: [] }))).toBe(2);
    expect(pageBeyondEnd(answer({ page: 1, total: 0, rows: [] }))).toBeNull();
    expect(pageBeyondEnd(answer({ page: 2, total: 30, rows: [row()] }))).toBeNull();
  });

  it('the page checkbox: the current page’s rows only (ticked, clear or mixed)', () => {
    const rows = [row({ id: A }), row({ id: B })];
    expect(pageSelectState(rows, new Set())).toBe(false);
    expect(pageSelectState(rows, new Set([A]))).toBe('mixed');
    expect(pageSelectState(rows, new Set([A, B, C]))).toBe(true);
    expect(pageSelectState([], new Set([A]))).toBe(false);
    expect(pageSelectState([row({ id: A.toUpperCase() })], new Set([A]))).toBe(true);
  });

  it('counts the sheet’s filters (type, warehouse, category), and keys an answer by scope and query', () => {
    expect(manageActiveFilterCount(parseOrderCatalogManageQuery({}))).toBe(0);
    expect(manageActiveFilterCount(parseOrderCatalogManageQuery({ type: 'books', warehouseId: WH, visibility: 'hidden', q: 'x' }))).toBe(2);
    const q = parseOrderCatalogManageQuery({ visibility: 'hidden', page: '2' });
    expect(manageAnswerKey('scope-1', q)).not.toBe(manageAnswerKey('scope-2', q));
    expect(manageAnswerKey('scope-1', q)).not.toBe(manageAnswerKey('scope-1', { ...q, page: 3 }));
  });
});

describe('after a write: exactly what the answer says', () => {
  it('rows the answer names take its state; a newly hidden row’s date waits for the re-read', () => {
    const rows = [
      row({ id: A, visible: true }),
      row({ id: B, visible: false, hiddenSince: '2026-10-01T00:00:00Z' }),
      row({ id: C, visible: true }),
    ];
    const hidden = rowsAfterWrite(rows, { organizationId: ORG, operationId: OP, visible: false, changed: [A], unchanged: [B] });
    expect(hidden.map((r) => [r.id, r.visible, r.hiddenSince])).toEqual([
      [A, false, null],
      [B, false, '2026-10-01T00:00:00Z'],
      [C, true, null],
    ]);
    const shown = rowsAfterWrite(rows, { organizationId: ORG, operationId: OP, visible: true, changed: [B], unchanged: [] });
    expect(shown.find((r) => r.id === B)).toMatchObject({ visible: true, hiddenSince: null });
  });

  it('"Try again" (the same body) only for busy, a rate limit or no answer; never for a step-up or a refusal', () => {
    const f = (status: number, reason: string) =>
      manageFailure(Object.assign(new Error('x'), { status, code: 'x', details: { reason } }), 'write');
    expect(offerRetry(f(409, 'busy'))).toBe(true);
    expect(offerRetry(f(429, 'rate_limited'))).toBe(true);
    expect(offerRetry(manageFailure(new TypeError('Network request failed'), 'write'))).toBe(true);
    expect(offerRetry(f(403, 'aal2_required'))).toBe(false);
    expect(offerRetry(f(403, 'forbidden'))).toBe(false);
    expect(offerRetry(f(409, 'items_unavailable'))).toBe(false);
    expect(offerRetry(f(500, 'failed'))).toBe(false);
  });

  it('the saved words count what changed and what already was, never "all updated"', () => {
    expect(savedOutcome({ organizationId: ORG, operationId: OP, visible: false, changed: [A, B], unchanged: [C] })).toBe(
      'Hidden 2 items. 1 was already hidden.',
    );
    expect(savedOutcome({ organizationId: ORG, operationId: OP, visible: true, changed: [], unchanged: [A] })).toBe(
      'That item was already shown.',
    );
  });
});

describe('what the list shows', () => {
  const KEY = 'k1';
  const failed = (e: unknown) => manageFailure(e, 'read');
  const forbidden = Object.assign(new Error('x'), { status: 403, code: 'forbidden', details: { reason: 'forbidden' } });
  const switchOff = Object.assign(new Error('x'), { status: 403, code: 'forbidden', details: { reason: 'feature_disabled' } });

  it('loading until an answer for THIS key arrives; offline with nothing says so', () => {
    expect(manageListView(null, KEY, false)).toEqual({ kind: 'loading' });
    expect(manageListView({ key: 'other', answer: answer(), failure: null }, KEY, false)).toEqual({ kind: 'loading' });
    expect(manageListView(null, KEY, true)).toEqual({ kind: 'failed', message: ORDER_ITEMS_OFFLINE_COPY });
  });

  it('a failed read is never an empty list; the rows already shown stay, with a note', () => {
    expect(manageListView({ key: KEY, answer: null, failure: failed(new TypeError('x')) }, KEY, false)).toEqual({
      kind: 'failed',
      message: ORDER_ITEMS_LOAD_FAILED_COPY,
    });
    const a = answer();
    expect(manageListView({ key: KEY, answer: a, failure: failed(new TypeError('x')) }, KEY, false)).toEqual({
      kind: 'rows',
      answer: a,
      note: ORDER_ITEMS_LOAD_FAILED_COPY,
    });
    expect(manageListView({ key: KEY, answer: a, failure: null }, KEY, true)).toEqual({ kind: 'rows', answer: a, note: ORDER_ITEMS_OFFLINE_COPY });
  });

  it('no capability at open says so (not "not found"); the switch off says it in its words', () => {
    expect(manageListView({ key: KEY, answer: null, failure: failed(forbidden) }, KEY, false)).toEqual({
      kind: 'refused',
      message: ORDER_ITEMS_NO_ACCESS_COPY,
    });
    expect(manageListView({ key: KEY, answer: null, failure: failed(switchOff) }, KEY, false)).toEqual({
      kind: 'refused',
      message: ORDER_ITEMS_FEATURE_DISABLED_COPY,
    });
  });

  it('an empty answer is said for the filter that emptied it', () => {
    const q = (o: Record<string, string>) => parseOrderCatalogManageQuery(o);
    expect(manageListView({ key: KEY, answer: answer({ total: 0, rows: [] }), failure: null }, KEY, false, q({ visibility: 'hidden' }))).toEqual({
      kind: 'empty',
      message: 'No items are hidden from Orders.',
    });
    expect(manageListView({ key: KEY, answer: answer({ total: 0, rows: [] }), failure: null }, KEY, false, q({ q: 'zz' }))).toEqual({
      kind: 'empty',
      message: 'No items match your search.',
    });
  });
});
