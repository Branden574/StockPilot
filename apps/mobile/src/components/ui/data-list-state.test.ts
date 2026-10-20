import { describe, expect, it } from 'vitest';

import { dataListEmptyKind, dataListReloadNote, type DataListFailure } from './data-list-state';

/**
 * DataListScreen's states besides its rows (redesign defect D25: the drawer
 * lists printed their "No X yet." copy when the read had failed). The screen
 * keys its panels on these; the "DataListScreen keeps loading, empty, failed
 * and offline apart" block in primitives-structure.test.ts pins that it does.
 */

const failure = (over: Partial<DataListFailure> = {}): DataListFailure => ({
  title: 'Could not load audit events.',
  body: 'Check your connection and pull down to try again.',
  ...over,
});

describe('dataListEmptyKind: which panel stands in for the rows when there are none', () => {
  it('the empty state only when the read succeeded', () => {
    expect(dataListEmptyKind(undefined)).toBe('empty');
    expect(dataListEmptyKind(null)).toBe('empty');
  });

  it('a failed read is never the empty state', () => {
    expect(dataListEmptyKind(failure())).toBe('failed');
    expect(dataListEmptyKind(failure({ offline: false }))).toBe('failed');
  });

  it('a read that failed for want of a connection says so apart from other failures', () => {
    expect(dataListEmptyKind(failure({ offline: true }))).toBe('offline');
  });
});

describe('dataListReloadNote: rows an earlier read left on screen when this one failed', () => {
  it('says nothing when the read succeeded', () => {
    expect(dataListReloadNote(null, 12)).toBeNull();
    expect(dataListReloadNote(undefined, 12)).toBeNull();
  });

  it('says nothing when there are no rows (the failed panel says it instead)', () => {
    expect(dataListReloadNote(failure({ reloadNote: 'Could not refresh.' }), 0)).toBeNull();
    expect(dataListReloadNote(failure(), 0)).toBeNull();
  });

  it("says the screen's own words above the rows, trimmed", () => {
    expect(
      dataListReloadNote(failure({ reloadNote: 'Could not refresh. Showing the last list.' }), 3),
    ).toBe('Could not refresh. Showing the last list.');
    expect(dataListReloadNote(failure({ reloadNote: '  Could not refresh.  ' }), 1)).toBe(
      'Could not refresh.',
    );
  });

  // Mutation caught (P2.5 review): with rows on screen, a failed read again
  // said nothing unless the screen also passed `reloadNote`, so the rows of
  // the last good read looked current (40 tags after a failed pull to
  // refresh). The Orders list always says so: lib/orders-list.ts
  // ordersListReloadNote (desk check F12).
  it("falls back to the failure's title, so a failed read again over rows is never silent", () => {
    expect(dataListReloadNote(failure(), 40)).toBe(failure().title);
    expect(dataListReloadNote(failure({ reloadNote: '' }), 3)).toBe(failure().title);
    expect(dataListReloadNote(failure({ reloadNote: '   ' }), 3)).toBe(failure().title);
    expect(dataListReloadNote(failure({ offline: true }), 1)).toBe(failure().title);
  });

  it('adds no words of its own: every line is one the screen gave, or nothing', () => {
    const titles = ['Could not load tags.', '  Could not load tags.  ', '   '];
    const notes = [undefined, '', '   ', 'Could not refresh.', '  Could not refresh.  '];
    for (const title of titles) {
      for (const reloadNote of notes) {
        for (const rows of [0, 1, 40]) {
          const said = dataListReloadNote(failure({ title, reloadNote }), rows);
          if (said === null) continue;
          const given = [title, reloadNote ?? ''].map((s) => s.trim()).filter(Boolean);
          expect(given, `${JSON.stringify({ title, reloadNote, rows })}`).toContain(said);
        }
      }
    }
    // A screen that gave no words at all gets none, not an empty line.
    expect(dataListReloadNote(failure({ title: '   ' }), 3)).toBeNull();
  });
});
