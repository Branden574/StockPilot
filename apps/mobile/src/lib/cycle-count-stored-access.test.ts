import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenCallback } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';
import { countAnswerStillShown } from './count-access-refresh';

// count-read-failed.ts reaches drawer-nav, which maps icon names to lucide
// components; the native package does not load under node.
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/** What the screens say (screen-access.ts, pinned there). */
const CYCLE_COUNTS_NOT_AVAILABLE = 'Cycle counts are not available to you in this workspace.';
const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';
const SAVED_ACCESS_UNREADABLE =
  'What this phone saved about your access could not be read. Try again.';
type ScreenAccess = 'unknown' | 'unreadable' | 'not-synced' | 'allowed' | 'denied';

/**
 * THE COUNTS SAVED ON THIS PHONE ARE SHOWN ONLY TO A MEMBER WHO MAY SEE
 * CYCLE COUNTS.
 *
 * The phone keeps the open counts its sync downloaded, so a counter can work
 * offline. The Cycle counts list shows them offline, and under a failed read;
 * the count screen opens one from them, or reads it from the database. Both
 * now ask first whether this member may see cycle counts, by the side menu's
 * rule (screen-access.ts: the module on, and cycle_counts:read or
 * stock:adjust), decided once the saved permissions and modules are read. A
 * member who may not is told the counts are not available; until it is known,
 * nothing is read or claimed. And the list never puts the stored counts in
 * place of the server's refusal (a 403). A member who may see them keeps
 * every offline path exactly as before (the "allowed" cases below).
 *
 * The screens' own load functions are RUN here, compiled from their source
 * (screen-functions.ts).
 */

const LIST = 'app/(drawer)/(tabs)/cycle-counts.tsx';
const COUNT = 'app/cycle-count/[id].tsx';
const ORG = '0c000000-0000-0000-0000-0000000000c1';
const COUNT_ID = '0a000000-0000-0000-0000-0000000000a1';

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const DOWNLOADED = [{ id: COUNT_ID, status: 'in_progress', startedAt: '2026-11-01T00:00:00Z' }];

/** The list's own load, with the network and the device store stood in for. */
function listLoad(opts: {
  access: ScreenAccess;
  online: boolean;
  serverAnswer?: () => Promise<unknown>;
  fetchedHere?: typeof DOWNLOADED;
}) {
  const state = {
    downloaded: undefined as unknown,
    error: undefined as unknown,
    page: undefined as unknown,
  };
  const readDownloaded = vi.fn(async () => DOWNLOADED);
  const readDownloadedForAccount = vi.fn(async () => opts.fetchedHere ?? []);
  const listCycleCounts = vi.fn(opts.serverAnswer ?? (async () => ({ items: [], page: 1 })));
  const load = screenCallback<(view: unknown, o: { withSummary: boolean }) => Promise<void>>(
    LIST,
    'load',
    {
      Network: {
        getNetworkStateAsync: async () => ({
          isConnected: opts.online,
          isInternetReachable: opts.online,
        }),
      },
      guard: { current: createSequenceGuard() },
      inFlight: { current: null },
      orgRef: { current: ORG },
      requested: { current: null },
      storedAccessRef: { current: opts.access },
      needsAccessRef: { current: false },
      CYCLE_COUNTS_NOT_AVAILABLE,
      NOT_SYNCED_YET,
      SAVED_ACCESS_UNREADABLE,
      readDownloadedForAccount,
      ApiError: FakeApiError,
      setOffline: () => undefined,
      dirtyLineCounts: async () => new Map(),
      setPendingByCount: () => undefined,
      readDownloaded,
      setDownloaded: (v: unknown) => {
        state.downloaded = v;
      },
      setError: (v: unknown) => {
        state.error = v;
      },
      setPage: (v: unknown) => {
        state.page = v;
      },
      setBusy: () => undefined,
      setSummary: () => undefined,
      setView: () => undefined,
      listCycleCounts,
      isCurrentListAnswer: () => true,
    },
  );
  return { load, state, readDownloaded, readDownloadedForAccount };
}

const VIEW = { q: '', status: null, page: 1 };

describe('the Cycle counts list: downloaded counts only for a member who may see them', () => {
  it('offline, a member who may see cycle counts gets the downloaded counts, as before', async () => {
    const { load, state, readDownloaded } = listLoad({ access: 'allowed', online: false });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).toHaveBeenCalledTimes(1);
    expect(state.downloaded).toEqual(DOWNLOADED);
    expect(state.error).toBeNull();
  });

  it('offline, a member who may not is told so, and the device store is never read', async () => {
    const { load, state, readDownloaded } = listLoad({ access: 'denied', online: false });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).not.toHaveBeenCalled();
    expect(state.downloaded).toBeNull();
    expect(state.error).toBe(CYCLE_COUNTS_NOT_AVAILABLE);
  });

  it('offline, before it is known, nothing is read and nothing is claimed', async () => {
    const { load, state, readDownloaded } = listLoad({ access: 'unknown', online: false });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).not.toHaveBeenCalled();
    expect(state.downloaded).toBeNull();
    expect(state.error).toBeNull();
  });

  it.each(['forbidden', 'module_disabled'])(
    "the server's refusal (403 %s) is shown, never the downloaded counts in its place",
    async (code) => {
      const { load, state, readDownloaded } = listLoad({
        access: 'allowed',
        online: true,
        serverAnswer: async () => {
          throw new FakeApiError('You do not have access to cycle counts.', 403, code);
        },
      });
      await load(VIEW, { withSummary: true });
      expect(readDownloaded).not.toHaveBeenCalled();
      expect(state.downloaded).toBeNull();
      expect(state.error).toBe('You do not have access to cycle counts.');
    },
  );

  it('any other 403 is a failed read: the downloaded counts stay for a member who may see them', async () => {
    const { load, state, readDownloaded } = listLoad({
      access: 'allowed',
      online: true,
      serverAnswer: async () => {
        throw new FakeApiError('Confirm with your authenticator app.', 403, 'aal2_required');
      },
    });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).toHaveBeenCalledTimes(1);
    expect(state.downloaded).toEqual(DOWNLOADED);
    expect(state.error).toBe('Confirm with your authenticator app.');
  });

  it('not synced yet, offline: only counts this account fetched here; with none, said so', async () => {
    const none = listLoad({ access: 'not-synced', online: false });
    await none.load(VIEW, { withSummary: true });
    expect(none.readDownloaded).not.toHaveBeenCalled();
    expect(none.readDownloadedForAccount).toHaveBeenCalledTimes(1);
    expect(none.state.downloaded).toEqual([]);
    expect(none.state.error).toBe(NOT_SYNCED_YET);

    const mine = listLoad({ access: 'not-synced', online: false, fetchedHere: DOWNLOADED });
    await mine.load(VIEW, { withSummary: true });
    expect(mine.readDownloaded).not.toHaveBeenCalled();
    expect(mine.state.downloaded).toEqual(DOWNLOADED);
    expect(mine.state.error).toBeNull();
  });

  it('not synced yet, online: the server is asked; a failed read falls back to those counts only', async () => {
    const { load, state, readDownloaded, readDownloadedForAccount } = listLoad({
      access: 'not-synced',
      online: true,
      serverAnswer: async () => {
        throw new Error('Network request failed');
      },
    });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).not.toHaveBeenCalled();
    expect(readDownloadedForAccount).toHaveBeenCalledTimes(1);
    expect(state.downloaded).toEqual([]);
  });

  it('the saved access could not be read: said, nothing stored is read', async () => {
    const { load, state, readDownloaded, readDownloadedForAccount } = listLoad({
      access: 'unreadable',
      online: false,
    });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).not.toHaveBeenCalled();
    expect(readDownloadedForAccount).not.toHaveBeenCalled();
    expect(state.error).toBe(SAVED_ACCESS_UNREADABLE);
  });

  it('a failed read (no answer) still shows the downloaded counts to a member who may see them', async () => {
    const { load, state, readDownloaded } = listLoad({
      access: 'allowed',
      online: true,
      serverAnswer: async () => {
        throw new Error('Network request failed');
      },
    });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).toHaveBeenCalledTimes(1);
    expect(state.downloaded).toEqual(DOWNLOADED);
  });

  it('a failed read does not show them to a member who may not', async () => {
    const { load, state, readDownloaded } = listLoad({
      access: 'denied',
      online: true,
      serverAnswer: async () => {
        throw new Error('Network request failed');
      },
    });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).not.toHaveBeenCalled();
    expect(state.downloaded).toBeNull();
  });
});

/** The count screen's own loadOnce, with the stores stood in for. */
function countLoad(access: ScreenAccess, online: boolean, fetchedHere = false) {
  const calls: string[] = [];
  const cached = { header: { id: COUNT_ID }, lines: [] };
  const getCycleCount = vi.fn(async () => {
    calls.push('cache');
    return cached;
  });
  const from = vi.fn(() => {
    calls.push('database');
    throw new Error('not stood in for');
  });
  const state = {
    readError: undefined as unknown,
    emptyState: undefined as unknown,
    loading: true,
  };
  const hydrated: unknown[] = [];
  const countStoredForLiveAccount = vi.fn(async () => {
    calls.push('stamp');
    return fetchedHere;
  });
  const loadOnce = screenCallback<() => Promise<unknown>>(COUNT, 'loadOnce', {
    id: COUNT_ID,
    orgId: ORG,
    access,
    CYCLE_COUNTS_NOT_AVAILABLE,
    NOT_SYNCED_YET,
    SAVED_ACCESS_UNREADABLE,
    countStoredForLiveAccount,
    getCycleCount,
    hydrateFromSnapshot: (snap: unknown) => hydrated.push(snap),
    setLoading: (v: boolean) => {
      state.loading = v;
    },
    setReadError: (v: unknown) => {
      state.readError = v;
    },
    setEmptyState: (v: unknown) => {
      state.emptyState = v;
    },
    Network: {
      getNetworkStateAsync: async () => ({ isConnected: online, isInternetReachable: online }),
    },
    COUNT_UNREADABLE_ON_PHONE: 'This count could not be read on this phone.',
    cacheWriteScope: async () => ({}),
    supabase: { from },
    fetchAllCycleCountLines: async () => ({ data: [], error: null }),
    // The key the screen was loaded under, unchanged while this runs (the
    // change of key is count-screens-keyed.test.ts), and the workspace load
    // ended (no-workspace-screens.test.ts has it loading).
    lastLoadKey: { current: null },
    countAnswerStillShown,
    waitingForWorkspace: false,
    setLinked: () => undefined,
  });
  return { loadOnce, calls, state, hydrated, cached };
}

describe('the count screen: checked before the cache or the database is read', () => {
  it('a member who may not sees the not-available state; nothing is read', async () => {
    const { loadOnce, calls, state } = countLoad('denied', true);
    await loadOnce();
    expect(calls).toEqual([]);
    expect(state.readError).toBe(CYCLE_COUNTS_NOT_AVAILABLE);
    expect(state.emptyState).toBe('read-failed');
    expect(state.loading).toBe(false);
  });

  it('before it is known, nothing is read and the spinner stays', async () => {
    const { loadOnce, calls, state } = countLoad('unknown', false);
    await loadOnce();
    expect(calls).toEqual([]);
    expect(state.loading).toBe(true);
    expect(state.emptyState).toBeUndefined();
  });

  it('a read of the saved access that failed: said, with nothing read (Retry reads it again)', async () => {
    const { loadOnce, calls, state } = countLoad('unreadable', true);
    await loadOnce();
    expect(calls).toEqual([]);
    expect(state.readError).toBe(SAVED_ACCESS_UNREADABLE);
    expect(state.emptyState).toBe('read-failed');
    expect(state.loading).toBe(false);
  });

  it('not synced yet, offline: no stored count is read, unless this account fetched it here', async () => {
    const plain = countLoad('not-synced', false);
    await plain.loadOnce();
    expect(plain.calls).toEqual(['stamp']);
    expect(plain.hydrated).toEqual([]);
    expect(plain.state.readError).toBe(NOT_SYNCED_YET);
    expect(plain.state.emptyState).toBe('read-failed');

    const mine = countLoad('not-synced', false, true);
    await mine.loadOnce();
    expect(mine.calls).toEqual(['stamp', 'cache']);
    expect(mine.hydrated).toEqual([mine.cached]);
    expect(mine.state.emptyState).toBeUndefined();
  });

  it('not synced yet, online: the stored copy is skipped and the server is asked', async () => {
    const { loadOnce, calls } = countLoad('not-synced', true);
    await loadOnce().catch(() => undefined);
    expect(calls).toEqual(['stamp', 'database']);
  });

  it('offline, a member who may see cycle counts opens the copy saved on this phone, as before', async () => {
    const { loadOnce, calls, state, hydrated, cached } = countLoad('allowed', false);
    await loadOnce();
    expect(calls).toEqual(['cache']);
    expect(hydrated).toEqual([cached]);
    expect(state.loading).toBe(false);
    expect(state.emptyState).toBeUndefined();
  });
});

describe('the wiring: both screens ask the side menu rule, and act on a change', () => {
  const code = (file: string) =>
    readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it("the list reads its access from useDrawerEntryAccess('/cycle-counts') and loads again when it changes", () => {
    const list = code(LIST);
    expect(list).toContain("const storedAccess = useDrawerEntryAccess('/cycle-counts');");
    expect(list).toMatch(/storedAccessRef\.current = storedAccess;/);
    expect(list).toMatch(/\}, \[storedAccess, load\]\);/);
  });

  it('the count screen reads its access the same way, and loadOnce follows it', () => {
    const count = code(COUNT);
    expect(count).toContain("const access = useDrawerEntryAccess('/cycle-counts');");
    expect(count).toMatch(/\}, \[id, orgId, access, waitingForWorkspace\]\);/);
  });
});

describe('the count screen with no count to show: its words and its button', () => {
  it('denied: its own title and Back; not synced yet and unreadable: Retry; other failures as before', async () => {
    const { countReadFailedView } = await import('./count-read-failed');
    expect(countReadFailedView(CYCLE_COUNTS_NOT_AVAILABLE)).toEqual({
      title: 'Not available',
      catchingUpNote: false,
      action: 'back',
      rereadAccess: false,
    });
    expect(countReadFailedView(NOT_SYNCED_YET)).toMatchObject({
      title: 'Not synced yet',
      action: 'retry',
    });
    expect(countReadFailedView(SAVED_ACCESS_UNREADABLE)).toMatchObject({
      action: 'retry',
      rereadAccess: true,
    });
    expect(countReadFailedView('permission denied for table cycle_counts')).toEqual({
      title: 'Could not load this count',
      catchingUpNote: true,
      action: 'retry',
      rereadAccess: false,
    });
  });

  it('the screen draws them from countReadFailedView', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', COUNT), 'utf8');
    expect(src).toContain('const failedView = countReadFailedView(readError);');
    expect(src).toMatch(/\{failedView\.title\}/);
    expect(src).toMatch(/failedView\.action === 'back' \? 'Back' : 'Retry'/);
  });
});
