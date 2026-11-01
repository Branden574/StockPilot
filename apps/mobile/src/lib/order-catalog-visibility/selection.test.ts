import { describe, expect, it, vi } from 'vitest';

import { ORDER_CATALOG_VISIBILITY_MAX_ITEMS, ORDER_ITEMS_SELECTION_CAP_COPY } from '@stockpilot/core';

import {
  EMPTY_SELECTION,
  clearOrderCatalogSelection,
  createSelectionStore,
  manageScopeKey,
  orderCatalogSelection,
  type ManageScope,
  type SelectedRecord,
} from './selection';

const USER = '22222222-2222-4222-8222-222222222222';
const USER_2 = '66666666-6666-4666-8666-666666666666';
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '99999999-9999-4999-8999-999999999999';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SCOPE: ManageScope = { userId: USER, orgId: ORG, epoch: 1 };
const rec = (id: string, visible = true): SelectedRecord => ({ id, name: `Record ${id.slice(0, 4)}`, identifier: 'SKU-1', visible });
const PENDING = { json: '{}', body: { itemIds: [A], visible: false, operationId: '55555555-5555-4555-8555-555555555555' } };

function filled() {
  const s = createSelectionStore();
  s.bindScope(SCOPE);
  s.add(SCOPE, [rec(A), rec(B, false)]);
  s.setReviewOpen(SCOPE, true);
  s.setPending(SCOPE, PENDING);
  return s;
}

describe('the selection is explicit ids, kept across pages', () => {
  it('toggles, adds, removes and clears; ids are lower-cased and kept once', () => {
    const s = createSelectionStore();
    s.bindScope(SCOPE);
    expect(s.toggle(SCOPE, rec(A.toUpperCase()))).toBeNull();
    expect(s.forScope(SCOPE).records.map((r) => r.id)).toEqual([A]);
    expect(s.add(SCOPE, [rec(A), rec(B)])).toBeNull();
    expect(s.forScope(SCOPE).records.map((r) => r.id)).toEqual([A, B]);
    expect(s.forScope(SCOPE).ids.has(B)).toBe(true);
    s.toggle(SCOPE, rec(A));
    expect(s.forScope(SCOPE).records.map((r) => r.id)).toEqual([B]);
    s.remove(SCOPE, [B.toUpperCase()]);
    expect(s.forScope(SCOPE).records).toEqual([]);
  });

  it('refuses past the cap with core’s words, and adds nothing of a group that does not fit', () => {
    const s = createSelectionStore();
    s.bindScope(SCOPE);
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const many = Array.from({ length: ORDER_CATALOG_VISIBILITY_MAX_ITEMS - 1 }, (_, i) => rec(id(i)));
    expect(s.add(SCOPE, many)).toBeNull();
    expect(s.add(SCOPE, [rec(id(1000)), rec(id(1001))])).toBe(ORDER_ITEMS_SELECTION_CAP_COPY);
    expect(s.forScope(SCOPE).records).toHaveLength(ORDER_CATALOG_VISIBILITY_MAX_ITEMS - 1);
    // Already selected records do not count twice.
    expect(s.add(SCOPE, [rec(id(0)), rec(id(1000))])).toBeNull();
    expect(s.forScope(SCOPE).records).toHaveLength(ORDER_CATALOG_VISIBILITY_MAX_ITEMS);
    expect(s.toggle(SCOPE, rec(id(1001)))).toBe(ORDER_ITEMS_SELECTION_CAP_COPY);
    // Removing by toggle is always allowed at the cap.
    expect(s.toggle(SCOPE, rec(id(0)))).toBeNull();
    expect(s.forScope(SCOPE).records).toHaveLength(ORDER_CATALOG_VISIBILITY_MAX_ITEMS - 1);
  });

  it('a saved change updates the state of the selected records it named, and only those', () => {
    const s = filled();
    s.markVisible(SCOPE, [B.toUpperCase()], true);
    expect(s.forScope(SCOPE).records).toEqual([rec(A), rec(B, true)]);
  });

  it('notifies subscribers on a change only', () => {
    const s = createSelectionStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.bindScope(SCOPE);
    const after = fn.mock.calls.length;
    s.bindScope(SCOPE);
    s.remove(SCOPE, [A]);
    s.clear(SCOPE);
    expect(fn.mock.calls.length).toBe(after);
    s.toggle(SCOPE, rec(A));
    expect(fn.mock.calls.length).toBe(after + 1);
  });
});

describe('THE SCOPE RULE: another account, organization or account epoch starts empty (design 8.6)', () => {
  it.each([
    ['a workspace switch', { ...SCOPE, orgId: ORG_2 }],
    ['another account', { ...SCOPE, userId: USER_2 }],
    ['the same account after a sign-out (a new epoch)', { ...SCOPE, epoch: 2 }],
  ])('%s clears the selection, the review sheet and the kept operation', (_l, next) => {
    const s = filled();
    expect(s.forScope(SCOPE).records).toHaveLength(2);
    // Before the screen binds the new scope it already reads as empty for it.
    expect(s.forScope(next)).toEqual(EMPTY_SELECTION);
    s.bindScope(next);
    expect(s.getSnapshot()).toMatchObject({ scopeKey: manageScopeKey(next), records: [], reviewOpen: false, pending: null });
    // Going back does not bring the old records back.
    s.bindScope(SCOPE);
    expect(s.forScope(SCOPE).records).toEqual([]);
  });

  it('a call for a scope that is not the bound one changes nothing (a late callback after a switch)', () => {
    const s = filled();
    const other = { ...SCOPE, orgId: ORG_2 };
    expect(s.toggle(other, rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).toBeNull();
    s.add(other, [rec('cccccccc-cccc-4ccc-8ccc-cccccccccccc')]);
    s.remove(other, [A]);
    s.clear(other);
    s.setPending(other, null);
    s.setReviewOpen(other, false);
    s.markVisible(other, [A], false);
    expect(s.forScope(SCOPE)).toMatchObject({ records: [rec(A), rec(B, false)], reviewOpen: true, pending: PENDING });
  });

  it('the scope key names the account, the organization and the epoch, case-insensitively', () => {
    expect(manageScopeKey({ userId: USER.toUpperCase(), orgId: ORG, epoch: 3 })).toBe(manageScopeKey({ userId: USER, orgId: ORG.toUpperCase(), epoch: 3 }));
    expect(manageScopeKey(SCOPE)).not.toBe(manageScopeKey({ ...SCOPE, epoch: 2 }));
  });

  it('Clear empties the selection, the review sheet and the kept operation, keeping the scope', () => {
    const s = filled();
    s.clear(SCOPE);
    expect(s.forScope(SCOPE)).toMatchObject({ scopeKey: manageScopeKey(SCOPE), records: [], reviewOpen: false, pending: null });
  });

  it('sign-out (the storefront session closing) forgets everything, the scope included', () => {
    orderCatalogSelection.bindScope(SCOPE);
    orderCatalogSelection.add(SCOPE, [rec(A)]);
    orderCatalogSelection.setPending(SCOPE, PENDING);
    clearOrderCatalogSelection();
    expect(orderCatalogSelection.getSnapshot()).toEqual(EMPTY_SELECTION);
    expect(orderCatalogSelection.forScope(SCOPE)).toEqual(EMPTY_SELECTION);
  });
});
