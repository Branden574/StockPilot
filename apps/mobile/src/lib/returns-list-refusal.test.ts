import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { screenCallback, screenFunction, stateInitializer } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';

/**
 * THE RETURNS LIST'S REFUSAL ENDS EVERY READ ON ITS WAY (review of the S2
 * follow-up, the builder's note under F6).
 *
 * The list numbers its reads (the sequence guard), but its refusal (the
 * returns module off, or returns:read and returns:manage gone) took no
 * number: a first page or a further page read before the refusal could still
 * land its rows after it, and they showed again if the permission came back
 * before the next read did. Now the refusal takes a number from both guards.
 * The list's own `load` and `loadMore` run here, compiled from
 * app/(drawer)/returns.tsx (screen-functions).
 */

const LIST = 'app/(drawer)/returns.tsx';

interface Page {
  rows: { id: string }[];
  nextCursor: string | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The list's state and guards, and its load and loadMore built for one render. */
function returnsList() {
  const state = {
    rows: undefined as { id: string }[] | undefined,
    loading: true,
    refreshing: false,
    cursor: null as string | null,
  };
  const guard = stateInitializer<() => ReturnType<typeof createSequenceGuard>>(LIST, 'guard', {
    createSequenceGuard,
  })();
  const moreGuard = stateInitializer<() => ReturnType<typeof createSequenceGuard>>(
    LIST,
    'moreGuard',
    { createSequenceGuard },
  )();
  const setters = {
    setLoading: (v: boolean) => {
      state.loading = v;
    },
    setRefreshing: (v: boolean) => {
      state.refreshing = v;
    },
    setLoadError: () => undefined,
    setRows: (v: { id: string }[] | ((prev: { id: string }[]) => { id: string }[])) => {
      state.rows = typeof v === 'function' ? v(state.rows ?? []) : v;
    },
    setCursor: (v: string | null) => {
      state.cursor = v;
    },
    setAnswered: () => undefined,
    describeReturnError: () => 'The returns could not be read.',
    returnsQueryKey: screenFunction(LIST, 'returnsQueryKey', {}),
  };
  function render(canRead: boolean, listReturns: () => Promise<Page>) {
    const load = screenCallback<() => Promise<void>>(LIST, 'load', {
      ...setters,
      enabled: true,
      canRead,
      guard,
      moreGuard,
      listReturns,
      filter: 'all',
      q: '',
    });
    const loadMore = screenFunction<() => Promise<void>>(LIST, 'loadMore', {
      ...setters,
      cursor: state.cursor,
      loadingMore: false,
      loading: false,
      setLoadingMore: () => undefined,
      moreGuard,
      listReturns,
      filter: 'all',
      q: '',
    });
    return { load, loadMore };
  }
  return { state, render };
}

const refused = async (): Promise<Page> => {
  throw new Error('a refused list reads nothing');
};

describe('the Returns list after its permission or module goes', () => {
  it('a first page on its way shows nothing after the refusal (mutation: the refusal takes no number)', async () => {
    const list = returnsList();
    const page = deferred<Page>();
    const first = list.render(true, () => page.promise).load();
    await list.render(false, refused).load();
    expect(list.state.loading).toBe(false);
    page.resolve({ rows: [{ id: 'rma-1' }], nextCursor: null });
    await first;
    expect(list.state.rows).toBeUndefined();
  });

  it('a further page on its way adds nothing after the refusal (mutation: the refusal leaves the page guard alone)', async () => {
    const list = returnsList();
    await list.render(true, async () => ({ rows: [{ id: 'rma-1' }], nextCursor: 'c1' })).load();
    expect(list.state.rows).toEqual([{ id: 'rma-1' }]);
    const more = deferred<Page>();
    const pending = list.render(true, () => more.promise).loadMore();
    await list.render(false, refused).load();
    more.resolve({ rows: [{ id: 'rma-2' }], nextCursor: null });
    await pending;
    expect(list.state.rows).toEqual([{ id: 'rma-1' }]);
  });

  it('a read made after the permission comes back shows as before', async () => {
    const list = returnsList();
    await list.render(false, refused).load();
    await list.render(true, async () => ({ rows: [{ id: 'rma-3' }], nextCursor: null })).load();
    expect(list.state.rows).toEqual([{ id: 'rma-3' }]);
    expect(list.state.loading).toBe(false);
  });

  it('wiring: the refusal takes a number from both guards before it clears the spinners', () => {
    const code = readFileSync(path.resolve(__dirname, '../..', LIST), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(
      /if \(!enabled \|\| !canRead\) \{\s*guard\.next\(\);\s*moreGuard\.next\(\);\s*setLoading\(false\);\s*setRefreshing\(false\);\s*return;\s*\}/,
    );
  });
});
