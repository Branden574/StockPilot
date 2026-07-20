import { describe, expect, it } from 'vitest';

import {
  COUNT_PICKER_PAGE_SIZE,
  countPickerPlan,
  mergeRows,
  pickFromRow,
  searchWordGroups,
} from './count-picker';
import { listStatusPredicate } from './expected-items';

describe('countPickerPlan — embedded cycle-count picker query plan', () => {
  it('the Inventory tab lists everything BUT books; the Books tab lists books only', () => {
    // The exact item_type split the two list tabs use — mixing them was
    // the bug the tabs' split fixed, so the picker must not reintroduce it.
    expect(countPickerPlan('product', '', 0).itemType).toEqual({ op: 'neq', value: 'book' });
    expect(countPickerPlan('book', '', 0).itemType).toEqual({ op: 'eq', value: 'book' });
  });

  it('both tabs carry the tabs\' DEFAULT visibility: active + not awaiting first receipt', () => {
    // Locked to listStatusPredicate('all') — the same function the
    // Items/Books tabs derive their default view from — so the picker
    // cannot drift: no archived items, no mig-0277 phantoms (you cannot
    // count stock that never arrived).
    const defaultPred = listStatusPredicate('all');
    for (const tab of ['product', 'book'] as const) {
      const plan = countPickerPlan(tab, '', 0);
      expect(plan.awaitingFirstReceipt).toBe(defaultPred.awaitingFirstReceipt);
      expect(plan.lifecycle).toBe(defaultPred.lifecycle);
      expect(plan.awaitingFirstReceipt).toBe(false);
      expect(plan.lifecycle).toBe('active');
    }
  });

  it('pages 50 at a time from the given offset (SerialsCard load-more convention)', () => {
    expect(COUNT_PICKER_PAGE_SIZE).toBe(50);
    expect(countPickerPlan('product', '', 0).range).toEqual({ from: 0, to: 49 });
    expect(countPickerPlan('product', '', 50).range).toEqual({ from: 50, to: 99 });
  });
});

describe('searchWordGroups — the Items tab\'s word-AND ilike pattern', () => {
  it('builds one name/sku/barcode group per word so every word must match somewhere', () => {
    // "purple shirt" must find "L4L Purple T-Shirt": two AND-ed groups,
    // each spanning all three columns.
    expect(searchWordGroups('purple shirt')).toEqual([
      'name.ilike."%purple%",sku.ilike."%purple%",barcode.ilike."%purple%"',
      'name.ilike."%shirt%",sku.ilike."%shirt%",barcode.ilike."%shirt%"',
    ]);
  });

  it('an empty or whitespace-only query produces no groups (browse mode)', () => {
    expect(searchWordGroups('')).toEqual([]);
    expect(searchWordGroups('   ')).toEqual([]);
  });

  it('double-quotes values so PostgREST-reserved chars in titles/ISBNs stay literal', () => {
    // Commas, parens and dots corrupt an unquoted or-expression; quotes
    // and backslashes inside the value must themselves be escaped.
    expect(searchWordGroups('978-0.14(x)')).toEqual([
      'name.ilike."%978-0.14(x)%",sku.ilike."%978-0.14(x)%",barcode.ilike."%978-0.14(x)%"',
    ]);
    expect(searchWordGroups('say"hi')).toEqual([
      'name.ilike."%say\\"hi%",sku.ilike."%say\\"hi%",barcode.ilike."%say\\"hi%"',
    ]);
  });
});

describe('pickFromRow — checked row → shared count-selection store payload', () => {
  it('trusts the ROW\'s item_type over the active tab (web-parity)', () => {
    // A book surfacing outside the Books tab must still group under
    // BOOKS on the review list.
    expect(pickFromRow({ id: 'a', sku: 'BK-1', name: 'Dune', item_type: 'book' })).toEqual({
      id: 'a',
      sku: 'BK-1',
      name: 'Dune',
      itemType: 'book',
    });
    expect(
      pickFromRow({ id: 'b', sku: 'SKU-1', name: 'Widget', item_type: 'product' }).itemType,
    ).toBe('product');
    // Anything not-book normalizes to 'product' — matches the tabs'
    // toggle payloads so both entry paths write identical picks.
    expect(
      pickFromRow({ id: 'c', sku: 'SKU-2', name: 'Gadget', item_type: 'equipment' }).itemType,
    ).toBe('product');
  });
});

describe('mergeRows — load-more page append', () => {
  it('appends new rows and drops ids already loaded (offset pages can shift)', () => {
    const prev = [{ id: 'a' }, { id: 'b' }];
    expect(mergeRows(prev, [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  it('keeps the FIRST-loaded copy of a duplicated row (no visual jump)', () => {
    const prev = [{ id: 'a', name: 'old' }];
    const merged = mergeRows(prev, [{ id: 'a', name: 'new' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ id: 'a', name: 'old' });
  });
});
