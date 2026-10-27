import { describe, expect, it } from 'vitest';

import { ORDER_CATALOG_VISIBILITY_MAX_ITEMS } from '@stockpilot/core';

import {
  afterWrite,
  clearSelection,
  deselect,
  emptySelection,
  inScope,
  pageSelection,
  select,
  selectedIds,
  selectionScope,
  type SelectableRecord,
} from './selection';

const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0a000000-0000-4000-8000-00000000000b';
const USER = '6d80b722-1e44-4059-aa99-efd69718cb14';

const rec = (n: number, visible = true): SelectableRecord => ({
  id: `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Record ${n}`,
  identifier: `SKU-${n}`,
  visible,
});

describe('the Manage order items selection', () => {
  it('holds explicit ids only, with what the review lists for each', () => {
    const s = select(emptySelection(selectionScope(ORG_A, USER)), [rec(1), rec(2, false)]).state;
    expect(selectedIds(s)).toEqual([rec(1).id, rec(2).id]);
    expect(s.entries.get(rec(2).id)).toEqual({
      name: 'Record 2',
      identifier: 'SKU-2',
      visible: false,
    });
  });

  it('collapses a record selected twice', () => {
    let s = emptySelection(selectionScope(ORG_A, USER));
    s = select(s, [rec(1)]).state;
    s = select(s, [rec(1), rec(1)]).state;
    expect(selectedIds(s)).toEqual([rec(1).id]);
  });

  it('keeps records from other pages: the header box adds and removes this page only', () => {
    let s = select(emptySelection(selectionScope(ORG_A, USER)), [rec(90)]).state; // page 4
    const page = [rec(1), rec(2), rec(3)];
    expect(pageSelection(s, page)).toBe('none');
    s = select(s, page).state;
    expect(pageSelection(s, page)).toBe('all');
    s = deselect(s, [rec(2).id]);
    expect(pageSelection(s, page)).toBe('some');
    s = deselect(
      s,
      page.map((r) => r.id),
    );
    expect(selectedIds(s)).toEqual([rec(90).id]);
    expect(pageSelection(s, [])).toBe('none');
  });

  it(`stops at ${ORDER_CATALOG_VISIBILITY_MAX_ITEMS} and says so; nothing past the cap is added`, () => {
    const many = Array.from({ length: ORDER_CATALOG_VISIBILITY_MAX_ITEMS + 3 }, (_, i) =>
      rec(i + 1),
    );
    const r = select(emptySelection(selectionScope(ORG_A, USER)), many);
    expect(r.capped).toBe(true);
    expect(r.state.entries.size).toBe(ORDER_CATALOG_VISIBILITY_MAX_ITEMS);
    const again = select(r.state, [rec(9999)]);
    expect(again.capped).toBe(true);
    expect(again.state.entries.has(rec(9999).id)).toBe(false);
    // Re-selecting what is already in is not "past the cap".
    expect(select(r.state, [rec(1)]).capped).toBe(false);
  });

  it('clears on a change of organization or user (a workspace switch), never carrying ids across', () => {
    const s = select(emptySelection(selectionScope(ORG_A, USER)), [rec(1)]).state;
    expect(inScope(s, selectionScope(ORG_A, USER))).toBe(s);
    const switched = inScope(s, selectionScope(ORG_B, USER));
    expect(switched.entries.size).toBe(0);
    expect(switched.scope).toBe(selectionScope(ORG_B, USER));
    expect(inScope(s, selectionScope(ORG_A, 'another-user')).entries.size).toBe(0);
  });

  it('after a bulk write the selection is cleared; after one row, that row keeps its new state', () => {
    let s = select(emptySelection(selectionScope(ORG_A, USER)), [rec(1), rec(2)]).state;
    const bulk = afterWrite(s, { source: 'bulk', visible: false, ids: [rec(1).id, rec(2).id] });
    expect(bulk.entries.size).toBe(0);
    s = afterWrite(s, { source: 'row', visible: false, ids: [rec(2).id] });
    expect(s.entries.get(rec(2).id)?.visible).toBe(false);
    expect(s.entries.get(rec(1).id)?.visible).toBe(true);
    expect(clearSelection(s).entries.size).toBe(0);
  });
});
