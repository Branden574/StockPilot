import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_MULTI_FILTER_STATE,
  multiFilterStatesEqual,
  readMultiFilterState,
  useInstantFilters,
} from './use-instant-filters';

const BASE = '/dashboard/inventory';

function setup(initialSearch = '') {
  const replace = vi.fn<(url: string) => void>();
  const hook = renderHook(
    ({ params }: { params: URLSearchParams }) =>
      useInstantFilters({ params, basePath: BASE, replace }),
    { initialProps: { params: new URLSearchParams(initialSearch) } },
  );
  return { replace, hook };
}

/** Parse the query string out of the URL handed to replace(). */
function searchOf(url: string): URLSearchParams {
  const [, qs = ''] = url.split('?');
  return new URLSearchParams(qs);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useInstantFilters — instant feedback + coalescing', () => {
  it('flips the visible state synchronously on the first click', () => {
    const { replace, hook } = setup();
    act(() => hook.result.current.setFilter('cat', ['a']));
    // Instant: the control shows the new state before ANY navigation.
    expect(hook.result.current.visible.cat).toEqual(new Set(['a']));
    expect(replace).not.toHaveBeenCalled();
  });

  it('coalesces rapid toggles into ONE navigation carrying the final set', () => {
    const { replace, hook } = setup('sort=name_asc&page=3');
    act(() => hook.result.current.setFilter('cat', ['a']));
    act(() => hook.result.current.setFilter('cat', ['a', 'b']));
    act(() => hook.result.current.setFilter('cat', ['a', 'b', 'c']));

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(replace).toHaveBeenCalledTimes(1);
    const qs = searchOf(replace.mock.calls[0]![0]);
    expect(new Set(qs.getAll('cat'))).toEqual(new Set(['a', 'b', 'c']));
    // Unrelated params survive; pagination resets for a changed filter set.
    expect(qs.get('sort')).toBe('name_asc');
    expect(qs.has('page')).toBe(false);
  });

  it('edits across DIFFERENT filter keys inside the window share one navigation', () => {
    const { replace, hook } = setup();
    act(() => hook.result.current.setFilter('cat', ['a']));
    act(() => hook.result.current.setFilter('loc', ['x']));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).toHaveBeenCalledTimes(1);
    const qs = searchOf(replace.mock.calls[0]![0]);
    expect(qs.getAll('cat')).toEqual(['a']);
    expect(qs.getAll('loc')).toEqual(['x']);
  });

  it('A→on→off flapping nets out to NO navigation and preserves ?page', () => {
    const { replace, hook } = setup('page=3');
    act(() => hook.result.current.setFilter('cat', ['a']));
    act(() => hook.result.current.setFilter('cat', []));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // The user ended where they started: navigating (and yanking them back
    // to page 1) would be wrong.
    expect(replace).not.toHaveBeenCalled();
    expect(hook.result.current.visible.cat).toEqual(new Set());
  });
});

describe('useInstantFilters — supersede + reconciliation', () => {
  it('does not snap back when an older navigation lands mid-edit, then mirrors the URL once settled', () => {
    const { replace, hook } = setup();

    // Commit #1: cat=a.
    act(() => hook.result.current.setFilter('cat', ['a']));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).toHaveBeenCalledTimes(1);

    // User keeps editing while #1's round-trip is in flight.
    act(() => hook.result.current.setFilter('loc', ['x']));

    // Navigation #1 lands (URL knows cat=a but NOT loc=x yet).
    hook.rerender({ params: new URLSearchParams('cat=a') });
    // NO snap-back: the control keeps showing the user's full intent.
    expect(hook.result.current.visible.cat).toEqual(new Set(['a']));
    expect(hook.result.current.visible.loc).toEqual(new Set(['x']));

    // Commit #2 carries the final combined state — last-click-wins.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(replace).toHaveBeenCalledTimes(2);
    const qs = searchOf(replace.mock.calls[1]![0]);
    expect(qs.getAll('cat')).toEqual(['a']);
    expect(qs.getAll('loc')).toEqual(['x']);

    // Final navigation lands → settled: visible state mirrors the URL.
    hook.rerender({ params: new URLSearchParams('cat=a&loc=x') });
    expect(hook.result.current.visible.cat).toEqual(new Set(['a']));
    expect(hook.result.current.visible.loc).toEqual(new Set(['x']));

    // Once settled, EXTERNAL URL changes (saved view, back button) drive
    // the controls again.
    hook.rerender({ params: new URLSearchParams('cat=zzz') });
    expect(hook.result.current.visible.cat).toEqual(new Set(['zzz']));
    expect(hook.result.current.visible.loc).toEqual(new Set());
  });

  it('keeps showing intent while its own navigation has not landed yet', () => {
    const { hook } = setup('page=2');
    act(() => hook.result.current.setFilter('charter', ['generic']));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Round-trip still in flight (params unchanged): intent wins.
    expect(hook.result.current.visible.charter).toEqual(new Set(['generic']));
    // Lands → mirrors.
    hook.rerender({ params: new URLSearchParams('charter=generic') });
    expect(hook.result.current.visible.charter).toEqual(new Set(['generic']));
    hook.rerender({ params: new URLSearchParams('') });
    expect(hook.result.current.visible.charter).toEqual(new Set());
  });
});

describe('useInstantFilters — navigate()', () => {
  it('folds un-flushed filter edits into the same immediate URL and cancels the debounce', () => {
    const { replace, hook } = setup('sort=updated_asc');
    act(() => hook.result.current.setFilter('cat', ['a']));
    // Sort change 200ms after a category click: ONE URL with both intents.
    act(() => hook.result.current.navigate((p) => p.set('sort', 'qty_desc')));
    expect(replace).toHaveBeenCalledTimes(1);
    const qs = searchOf(replace.mock.calls[0]![0]);
    expect(qs.getAll('cat')).toEqual(['a']);
    expect(qs.get('sort')).toBe('qty_desc');
    // The debounce timer was cancelled — no stale second navigation.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('clear-all (override + mutate) empties everything in one navigation, instantly visible', () => {
    const { replace, hook } = setup('cat=a&loc=b&charter=c&sort=name_asc&q=tape&page=2');
    act(() =>
      hook.result.current.navigate((p) => {
        p.delete('sort');
        p.delete('q');
      }, EMPTY_MULTI_FILTER_STATE),
    );
    // Instant visual clear…
    expect(hook.result.current.visible.cat).toEqual(new Set());
    expect(hook.result.current.visible.loc).toEqual(new Set());
    expect(hook.result.current.visible.charter).toEqual(new Set());
    // …and exactly one navigation to the bare base path.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(BASE);
  });
});

describe('pure helpers', () => {
  it('readMultiFilterState drops empty values', () => {
    const s = readMultiFilterState(new URLSearchParams('cat=a&cat=&loc=x'));
    expect(s).toEqual({ cat: ['a'], loc: ['x'], charter: [] });
  });

  it('multiFilterStatesEqual is order-insensitive and catches real differences', () => {
    expect(
      multiFilterStatesEqual(
        { cat: ['a', 'b'], loc: [], charter: [] },
        { cat: ['b', 'a'], loc: [], charter: [] },
      ),
    ).toBe(true);
    expect(
      multiFilterStatesEqual(
        { cat: ['a'], loc: [], charter: [] },
        { cat: ['a'], loc: ['x'], charter: [] },
      ),
    ).toBe(false);
    expect(
      multiFilterStatesEqual(
        { cat: ['a', 'a'], loc: [], charter: [] },
        { cat: ['a', 'b'], loc: [], charter: [] },
      ),
    ).toBe(false);
  });
});
