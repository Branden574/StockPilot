import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenCallback } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';

/** What the screens say (screen-access.ts CYCLE_COUNTS_NOT_AVAILABLE, pinned there). */
const CYCLE_COUNTS_NOT_AVAILABLE = 'Cycle counts are not available to you in this workspace.';
type ScreenAccess = 'unknown' | 'allowed' | 'denied';

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
}) {
  const state = {
    downloaded: undefined as unknown,
    error: undefined as unknown,
    page: undefined as unknown,
  };
  const readDownloaded = vi.fn(async () => DOWNLOADED);
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
  return { load, state, readDownloaded };
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

  it("the server's refusal (403) is shown, never the downloaded counts in its place", async () => {
    const { load, state, readDownloaded } = listLoad({
      access: 'allowed',
      online: true,
      serverAnswer: async () => {
        throw new FakeApiError('You do not have access to cycle counts.', 403);
      },
    });
    await load(VIEW, { withSummary: true });
    expect(readDownloaded).not.toHaveBeenCalled();
    expect(state.downloaded).toBeNull();
    expect(state.error).toBe('You do not have access to cycle counts.');
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
function countLoad(access: ScreenAccess, online: boolean) {
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
  const loadOnce = screenCallback<() => Promise<unknown>>(COUNT, 'loadOnce', {
    id: COUNT_ID,
    orgId: ORG,
    access,
    CYCLE_COUNTS_NOT_AVAILABLE,
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
    expect(count).toMatch(/\}, \[id, orgId, access\]\);/);
  });
});
