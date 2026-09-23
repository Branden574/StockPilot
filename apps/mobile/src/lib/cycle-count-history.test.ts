import { beforeEach, describe, expect, it } from 'vitest';

import type { CachedCycleCountHeader } from './cycle-count-cache';
import {
  cycleCountListPath,
  forgetListViews,
  INITIAL_LIST_VIEW,
  isCurrentListAnswer,
  recallListView,
  rememberListView,
  searchDownloadedCounts,
} from './cycle-count-history';

function cached(n: number, extra: Partial<CachedCycleCountHeader> = {}): CachedCycleCountHeader {
  return {
    id: `c-${String(n).padStart(3, '0')}`,
    organizationId: 'org-1',
    warehouseId: 'wh-1',
    warehouseName: 'North DC',
    status: 'in_progress',
    startedAt: `2026-09-${String(n).padStart(2, '0')}T12:00:00Z`,
    postedAt: null,
    assignedTo: null,
    countNumber: n,
    notes: null,
    cachedAt: 1,
    ...extra,
  };
}

describe('cycleCountListPath', () => {
  it('encodes the view the server pages and searches', () => {
    expect(cycleCountListPath({ q: 'a&b', status: 'canceled', page: 3 })).toBe(
      '/api/v1/cycle-counts?q=a%26b&status=canceled&page=3',
    );
    expect(cycleCountListPath(INITIAL_LIST_VIEW, { summary: true })).toBe('/api/v1/cycle-counts?summary=1');
  });
});

describe('isCurrentListAnswer', () => {
  it('accepts only the newest answer for the active workspace', () => {
    expect(isCurrentListAnswer({ organizationId: 'org-1' }, 'org-1', true)).toBe(true);
    expect(isCurrentListAnswer({ organizationId: 'org-1' }, 'org-1', false)).toBe(false);
    expect(isCurrentListAnswer({ organizationId: 'org-1' }, 'org-2', true)).toBe(false);
    expect(isCurrentListAnswer({ organizationId: 'org-1' }, null, true)).toBe(false);
  });
});

describe('searchDownloadedCounts (offline)', () => {
  const rows = [
    cached(3, { notes: 'Aisle 4 recount' }),
    cached(42, { warehouseName: 'South DC' }),
    cached(7, { countNumber: null, notes: 'no number yet' }),
    cached(5, { status: 'completed' }),
  ];

  it('finds a count by any form of its reference, exactly', () => {
    for (const q of ['CC-000042', 'cc-42', '000042', '42']) {
      expect(searchDownloadedCounts(rows, { q, status: null }).map((r) => r.countNumber)).toEqual([42]);
    }
    expect(searchDownloadedCounts(rows, { q: '4', status: null })).toEqual([]);
  });

  it('matches notes and warehouse names case-insensitively', () => {
    expect(searchDownloadedCounts(rows, { q: 'aisle', status: null }).map((r) => r.countNumber)).toEqual([3]);
    expect(searchDownloadedCounts(rows, { q: 'south', status: null }).map((r) => r.countNumber)).toEqual([42]);
  });

  it('never matches a count without a number to a reference search', () => {
    expect(searchDownloadedCounts(rows, { q: '7', status: null })).toEqual([]);
  });

  it('keeps the real cached status and filters by it', () => {
    expect(searchDownloadedCounts(rows, { q: '', status: 'completed' }).map((r) => r.countNumber)).toEqual([5]);
    expect(searchDownloadedCounts(rows, { q: '', status: 'in_progress' }).map((r) => r.status)).toEqual([
      'in_progress',
      'in_progress',
      'in_progress',
    ]);
  });

  it('orders newest first, the uuid breaking ties, like the server', () => {
    const tied = [
      cached(1, { id: 'c-a', startedAt: '2026-09-01T12:00:00Z' }),
      cached(2, { id: 'c-b', startedAt: '2026-09-01T12:00:00Z' }),
      cached(3, { id: 'c-c', startedAt: '2026-09-02T12:00:00Z' }),
    ];
    expect(searchDownloadedCounts(tied, { q: '', status: null }).map((r) => r.id)).toEqual(['c-c', 'c-b', 'c-a']);
  });

  it('does not change the list it was given (a view is never written back)', () => {
    const copy = rows.map((r) => ({ ...r }));
    searchDownloadedCounts(rows, { q: 'aisle', status: null });
    expect(rows).toEqual(copy);
  });
});

describe('list view memory', () => {
  beforeEach(() => forgetListViews());

  it('restores the last view for the same workspace, and starts clean for another', () => {
    rememberListView('org-1', { q: 'CC-42', status: 'completed', page: 3 });
    expect(recallListView('org-1')).toEqual({ q: 'CC-42', status: 'completed', page: 3 });
    expect(recallListView('org-2')).toEqual(INITIAL_LIST_VIEW);
    expect(recallListView(null)).toEqual(INITIAL_LIST_VIEW);
  });
});
