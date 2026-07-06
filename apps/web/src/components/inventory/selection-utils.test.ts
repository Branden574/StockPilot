import { describe, expect, it } from 'vitest';

import {
  deselectPage,
  isPageFullySelected,
  isPagePartiallySelected,
  selectPage,
} from './selection-utils';

// Pins the live-org desync fix: `selected` persists across pages AND across
// realtime refreshes that reorder rows, so it routinely contains ids not on
// the visible page. Header state must be identity-based over VISIBLE ids —
// the old size-equality test showed unchecked-forever the moment one stale
// id entered the set (owner-reported on the write-busy org; invisible on
// the write-quiet demo org).

const page = ['a', 'b', 'c'];

describe('isPageFullySelected', () => {
  it('true when every visible id is selected — EVEN with stale off-page ids', () => {
    expect(isPageFullySelected(new Set(['a', 'b', 'c']), page)).toBe(true);
    // the exact desync scenario: 3 visible + 1 drifted-off-page id
    expect(isPageFullySelected(new Set(['a', 'b', 'c', 'stale']), page)).toBe(true);
  });
  it('false when any visible id is missing, and for empty pages', () => {
    expect(isPageFullySelected(new Set(['a', 'b']), page)).toBe(false);
    expect(isPageFullySelected(new Set(['a', 'b', 'c']), [])).toBe(false);
  });
});

describe('isPagePartiallySelected', () => {
  it('true only for some-but-not-all visible', () => {
    expect(isPagePartiallySelected(new Set(['a']), page)).toBe(true);
    expect(isPagePartiallySelected(new Set(['a', 'b', 'c']), page)).toBe(false);
    expect(isPagePartiallySelected(new Set(['x']), page)).toBe(false);
    expect(isPagePartiallySelected(new Set(), page)).toBe(false);
  });
});

describe('selectPage / deselectPage', () => {
  it('selectPage adds visible ids and preserves off-page selection', () => {
    const next = selectPage(new Set(['other-page-id']), page);
    expect([...next].sort()).toEqual(['a', 'b', 'c', 'other-page-id']);
  });
  it('deselectPage removes ONLY visible ids — cross-page selection survives', () => {
    const next = deselectPage(new Set(['a', 'b', 'c', 'other-page-id']), page);
    expect([...next]).toEqual(['other-page-id']);
  });
  it('round-trip: select-all then unselect-all returns to the prior set', () => {
    const start = new Set(['keep']);
    expect([...deselectPage(selectPage(start, page), page)]).toEqual(['keep']);
  });
});
