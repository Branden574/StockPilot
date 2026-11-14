import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { effectCallback, screenCallback, screenFunction } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';

// count-read-failed.ts reaches drawer-nav, which maps icon names to lucide
// components; the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/** What the screens say (screen-access.ts, pinned there). */
const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';
type ScreenAccess = 'unknown' | 'unreadable' | 'not-synced' | 'allowed' | 'denied';

/**
 * WITH NO WORKSPACE KNOWN, A SCREEN SAYS SO; IT NEVER SPINS FOR GOOD.
 *
 * A first sign-in offline leaves the account with no workspace until the
 * membership read answers (use-workspace.ts). The Cycle counts tab returned
 * from its load before anything was set, so its spinner (nothing read, no
 * error) stayed until the member left the tab and came back, even after the
 * connection returned and a sync landed (lab walk row 2). Now:
 *   - the tab says the phone has not finished syncing, with Try again, and
 *     asks for the workspace again when online; a sync that lands runs its
 *     load again, and the workspace arriving loads the list in place;
 *   - the count screen, online with no workspace and no stored copy, says
 *     the same with its Retry;
 *   - Team and Accounts take the lists' own no-workspace state (tags.tsx):
 *     "Could not load your workspace.", and a pull loads it again;
 *   - Items and Books say it over the list instead of their skeleton;
 *   - the Scan tab answers a lookup with no workspace as a failed lookup,
 *     never "not in this workspace".
 *
 * The screens' own functions and effects are RUN here (screen-functions.ts).
 */

const LIST = 'app/(drawer)/(tabs)/cycle-counts.tsx';
const COUNT = 'app/cycle-count/[id].tsx';
const TEAM = 'app/(drawer)/team.tsx';
const CUSTOMERS = 'app/(drawer)/customers.tsx';
const ITEMS = 'app/(drawer)/(tabs)/inventory.tsx';
const BOOKS = 'app/(drawer)/(tabs)/books.tsx';
const SCAN = 'app/(drawer)/(tabs)/scan.tsx';
const ORG = '0c000000-0000-0000-0000-0000000000d1';
const COUNT_ID = '0a000000-0000-0000-0000-0000000000d2';
const VIEW = { q: '', status: null, page: 1 };

const flat = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

/** The tab's own load with no workspace known. */
function tabLoad(online: boolean) {
  const state = {
    page: null as unknown,
    downloaded: null as unknown,
    error: null as unknown,
    busy: false as unknown,
  };
  const listCycleCounts = vi.fn(async () => ({ items: [], page: 1 }));
  const readDownloaded = vi.fn(async () => []);
  const readDownloadedForAccount = vi.fn(async () => []);
  const retryWorkspace = vi.fn(async () => undefined);
  const needsAccessRef = { current: false };
  const load = screenCallback<(view: unknown, o: { withSummary: boolean }) => Promise<void>>(
    LIST,
    'load',
    {
      Network: {
        getNetworkStateAsync: async () => ({ isConnected: online, isInternetReachable: online }),
      },
      guard: { current: createSequenceGuard() },
      inFlight: { current: null },
      orgRef: { current: null },
      requested: { current: null },
      storedAccessRef: { current: 'not-synced' as ScreenAccess },
      needsAccessRef,
      CYCLE_COUNTS_NOT_AVAILABLE: 'Cycle counts are not available to you in this workspace.',
      NOT_SYNCED_YET,
      SAVED_ACCESS_UNREADABLE: 'What this phone saved about your access could not be read. Try again.',
      readDownloadedForAccount,
      readDownloaded,
      retryWorkspace,
      ApiError: Error,
      setOffline: () => undefined,
      dirtyLineCounts: async () => new Map(),
      setPendingByCount: () => undefined,
      setDownloaded: (v: unknown) => {
        state.downloaded = v;
      },
      setError: (v: unknown) => {
        state.error = v;
      },
      setPage: (v: unknown) => {
        state.page = v;
      },
      setBusy: (v: unknown) => {
        state.busy = v;
      },
      setSummary: () => undefined,
      setView: () => undefined,
      listCycleCounts,
      isCurrentListAnswer: () => true,
    },
  );
  return { load, state, listCycleCounts, readDownloaded, readDownloadedForAccount, retryWorkspace, needsAccessRef };
}

/** The tab's spinner: nothing read and nothing said (its render, pinned below). */
const spinning = (s: { page: unknown; downloaded: unknown; error: unknown }) =>
  !s.page && !s.downloaded && !s.error;

describe('the Cycle counts tab with no workspace known', () => {
  it('says the phone has not finished syncing, never a spinner that does not end; nothing is read', async () => {
    expect(flat(LIST)).toContain('{!page && !downloaded && !error ? ( <ActivityIndicator');
    for (const online of [false, true]) {
      const t = tabLoad(online);
      await t.load(VIEW, { withSummary: true });
      expect(t.state.error).toBe(NOT_SYNCED_YET);
      expect(spinning(t.state)).toBe(false);
      expect(t.state.busy).toBe(false);
      expect(t.listCycleCounts).not.toHaveBeenCalled();
      expect(t.readDownloaded).not.toHaveBeenCalled();
      expect(t.readDownloadedForAccount).not.toHaveBeenCalled();
    }
  });

  it('online, it asks for the workspace again; offline it does not', async () => {
    const on = tabLoad(true);
    await on.load(VIEW, { withSummary: true });
    expect(on.retryWorkspace).toHaveBeenCalledTimes(1);
    const off = tabLoad(false);
    await off.load(VIEW, { withSummary: true });
    expect(off.retryWorkspace).not.toHaveBeenCalled();
  });

  it('a sync that lands runs the load again, and the workspace arriving loads the list in place', async () => {
    const t = tabLoad(true);
    await t.load(VIEW, { withSummary: true });
    // The pull saved this member's access: the saved access changed.
    const reload = vi.fn();
    const afterSync = effectCallback<() => void>(LIST, 'lastStoredAccess.current = storedAccess', {
      lastStoredAccess: { current: 'not-synced' },
      storedAccess: 'allowed',
      needsAccessRef: t.needsAccessRef,
      load: reload,
      viewRef: { current: VIEW },
    });
    afterSync();
    expect(reload).toHaveBeenCalledWith(VIEW, { withSummary: true });

    // The workspace became known: its own view loads, the sentence goes.
    const errors: unknown[] = [];
    const loadNext = vi.fn();
    const arrived = effectCallback<() => void>(LIST, 'lastOrg.current = orgId', {
      lastOrg: { current: null },
      orgId: ORG,
      recallListView: () => VIEW,
      debounce: { current: { cancel: () => undefined } },
      setPage: () => undefined,
      setSummary: () => undefined,
      setDownloaded: () => undefined,
      setError: (v: unknown) => errors.push(v),
      setDraftQ: () => undefined,
      setView: () => undefined,
      load: loadNext,
    });
    arrived();
    expect(errors).toEqual([null]);
    expect(loadNext).toHaveBeenCalledWith(VIEW, { withSummary: true });
  });

  it('Try again and a pull ask for the workspace first, and Try again is offered offline too', async () => {
    const order: string[] = [];
    const deps = {
      orgRef: { current: null },
      storedAccessRef: { current: 'not-synced' },
      retrySavedAccess: async () => order.push('access'),
      retryWorkspace: async () => order.push('workspace'),
      load: async () => order.push('load'),
      setRefreshing: () => undefined,
      view: VIEW,
      viewRef: { current: VIEW },
      summary: null,
    };
    await screenFunction<() => Promise<void>>(LIST, 'tryAgain', deps)();
    expect(order).toEqual(['workspace', 'load']);
    order.length = 0;
    await screenFunction<() => Promise<void>>(LIST, 'refresh', deps)();
    expect(order).toEqual(['workspace', 'load']);
    // Offline, Try again is hidden only when a workspace is known (a pull
    // refreshes then); with none, it is the way to ask for it.
    expect(flat(LIST)).toContain('{offline && orgId ? null : (');
    expect(flat(LIST)).toContain('onPress={() => void tryAgain()}');
  });
});

describe('the count screen online with no workspace and no stored copy', () => {
  it('says the phone has not finished syncing, with its Retry, and asks for the workspace again', async () => {
    const state = { loading: true as unknown, readError: undefined as unknown, emptyState: undefined as unknown };
    const from = vi.fn(() => {
      throw new Error('not stood in for');
    });
    const retryWorkspace = vi.fn(async () => undefined);
    const loadOnce = screenCallback<() => Promise<unknown>>(COUNT, 'loadOnce', {
      id: COUNT_ID,
      orgId: null,
      access: 'not-synced',
      CYCLE_COUNTS_NOT_AVAILABLE: 'x',
      NOT_SYNCED_YET,
      SAVED_ACCESS_UNREADABLE: 'y',
      countStoredForLiveAccount: async () => false,
      getCycleCount: vi.fn(async () => null),
      hydrateFromSnapshot: () => undefined,
      setLoading: (v: unknown) => {
        state.loading = v;
      },
      setReadError: (v: unknown) => {
        state.readError = v;
      },
      setEmptyState: (v: unknown) => {
        state.emptyState = v;
      },
      Network: { getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }) },
      COUNT_UNREADABLE_ON_PHONE: 'z',
      cacheWriteScope: async () => ({}),
      retryWorkspace,
      supabase: { from },
      fetchAllCycleCountLines: async () => ({ data: [], error: null }),
    });
    await loadOnce();
    expect(state.loading).toBe(false);
    expect(state.readError).toBe(NOT_SYNCED_YET);
    expect(state.emptyState).toBe('read-failed');
    expect(retryWorkspace).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });
});

describe.each([
  ['Team', TEAM, 'const { orgId, loading: workspaceLoading } = useOrg();', 'const noWorkspace = !orgId && !workspaceLoading;'],
  [
    'Accounts',
    CUSTOMERS,
    'const { activeOrgId, loading: workspaceLoading } = useWorkspace();',
    'const noWorkspace = !activeOrgId && !workspaceLoading;',
  ],
] as const)('%s with no workspace known', (_label, file, hook, rule) => {
  it("the lists' own no-workspace state, and a pull that loads the workspace again", () => {
    const code = flat(file);
    expect(code).toContain(hook);
    expect(code).toContain(rule);
    expect(code).toContain("import { retryWorkspace");
    expect(code).toContain(
      'async function refresh() { setRefreshing(true); try { await (noWorkspace ? retryWorkspace() : load()); } finally { setRefreshing(false); } }',
    );
    expect(code).toContain("title: 'Could not load your workspace.', body: 'Check your connection and pull down to try again.',");
    expect(code).toContain('loading={!noWorkspace && loading}');
  });
});

describe.each([
  ['Items', ITEMS, 'const { activeOrgId, activeWarehouseId, loading: workspaceLoading } = useWorkspace();', 'ItemListSkeleton'],
  ['Books', BOOKS, 'const { activeOrgId: orgId, activeWarehouseId, loading: workspaceLoading } = useWorkspace();', 'BookListSkeleton'],
] as const)('%s with no workspace known', (_label, file, hook, skeleton) => {
  it('says so over the list instead of a skeleton that does not end, and a pull loads the workspace again', () => {
    const code = flat(file);
    expect(code).toContain(hook);
    expect(code).toContain('const noWorkspace = !orgId && !workspaceLoading;');
    expect(code).toContain(`{loading && !noWorkspace ? ( <${skeleton}`);
    expect(code).toContain('{noWorkspace ? ( <Body size={11.5} color={c.warnText} style={{ marginTop: 8 }}> {NO_WORKSPACE_LINE} </Body>');
    expect(code).toContain('if (noWorkspace) { setRefreshing(true); try { await retryWorkspace(); } finally { setRefreshing(false); } return; }');
    // No count is quoted, and the empty list is a list that did not load,
    // never "none": every place that asked whether the read failed asks this.
    expect(code).toContain('const listFailed = noWorkspace || loadError !== null;');
    expect(code).not.toMatch(/\{loadError !== null\s*\?/);
    expect(code).not.toMatch(/ListEmptyComponent=\{\s*loadError !== null/);
  });
});

describe('the Scan tab with no workspace known', () => {
  it('answers a lookup as failed (said as a failed lookup), never as not found', async () => {
    const deps = { orgId: null, supabase: {}, role: null };
    const byId = screenFunction<(id: string) => Promise<unknown>>(SCAN, 'loadItemById', deps);
    const byValue = screenFunction<(v: string) => Promise<unknown>>(SCAN, 'loadItemByValue', deps);
    await expect(byId('0b000000-0000-0000-0000-0000000000d3')).resolves.toBe('failed');
    await expect(byValue('9780000000000')).resolves.toBe('failed');
  });
});
