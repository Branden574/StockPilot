import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import { screenCallback } from './__fixtures__/screen-functions';

// drawer-nav maps icon names to lucide components; irrelevant here. The
// network client is never reached (offline).
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));
vi.mock('./api', () => ({ api: vi.fn() }));

/**
 * A COUNT LINK OPENED OFFLINE READS ONLY A COUNT THE SIGNED-IN ACCOUNT STORED
 * (S75).
 *
 * The cache, its saved access and a stored count are recorded as another
 * account's (cache-owner.ts) until the signed-in account's first pull resets
 * them. Offline, no pull runs. The access is computed from what the real store
 * answers (db.ts on node:sqlite) for the signed-in account, and the count
 * screen's own loadOnce runs with the real stores: the access is 'not-synced',
 * and nothing stored is read or shown.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null }, error: null }) } },
  readDeviceAuthSession: async () => ({ present: true, userId: 'u-b' }),
}));
const live = vi.hoisted(() => ({ userId: 'u-a' }));
vi.mock('./session-scope', () => ({
  outboxWriteScope: async () => ({ orgId: 'org-a', userId: live.userId }),
  liveOutboxScope: async () => ({ orgId: 'org-a', userId: live.userId }),
}));

const COUNT = 'app/cycle-count/[id].tsx';
const NOT_SYNCED_YET =
  'This phone has not finished syncing this workspace yet. Check your connection and try again.';

let raw: DatabaseSync;

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  await (await import('./db')).getDb();
  // The cache as account u-a left it: its own fetched count and saved access.
  live.userId = 'u-a';
  raw.prepare("insert into meta (key, value) values ('cache_user_id', 'u-a')").run();
  const cache = await import('./cycle-count-cache');
  expect(
    await cache.cacheCycleCount(
      {
        id: 'cc-a',
        organizationId: 'org-a',
        warehouseId: null,
        warehouseName: null,
        status: 'in_progress',
        startedAt: '2026-11-01T08:00:00.000Z',
      },
      [
        {
          id: 'l-a',
          itemId: 'i-a',
          itemName: 'Made-up item',
          itemSku: 'SKU-A',
          itemBarcode: null,
          expected: 4,
          counted: 2,
          updatedAt: null,
        },
      ],
      await cache.cacheWriteScope(),
    ),
  ).toBe(true);
  raw
    .prepare("insert into meta (key, value) values ('effective_permissions', ?)")
    .run(JSON.stringify(['cycle_counts:read', 'stock:adjust']));
  raw
    .prepare("insert into meta (key, value) values ('enabled_modules', ?)")
    .run(JSON.stringify(['cycle_counts']));
  // u-b is signed in; its first pull has not run.
  live.userId = 'u-b';
});

describe('a count link opened offline reads only a count the signed-in account stored', () => {
  it('a count stored under another account: not synced yet, and nothing of it is read or shown', async () => {
    const db = await import('./db');
    const { readPersistedPermissions } = await import('./use-effective-permissions');
    const { readPersistedEnabledModules } = await import('./enabled-modules');
    const { drawerEntryAccess } = await import('./screen-access');
    const cache = await import('./cycle-count-cache');

    const permissions = await readPersistedPermissions();
    const modules = await readPersistedEnabledModules();
    const access = drawerEntryAccess('/cycle-counts', {
      saved: { permissions: permissions ?? undefined, answered: true },
      modules: { modules: modules!, answered: 'saved' },
      owner: { ownerId: await db.getCacheOwner(), answered: true },
      liveUserId: 'u-b',
      role: 'staff',
      roleLoading: false,
    });
    // The saved set would allow it; it is recorded as another account's.
    expect(access).toBe('not-synced');

    const getCycleCount = vi.fn(cache.getCycleCount);
    const hydrated: unknown[] = [];
    const state = { readError: undefined as unknown, emptyState: undefined as unknown };
    const loadOnce = screenCallback<() => Promise<unknown>>(COUNT, 'loadOnce', {
      id: 'cc-a',
      orgId: 'org-a',
      access,
      CYCLE_COUNTS_NOT_AVAILABLE: 'not used',
      NOT_SYNCED_YET,
      SAVED_ACCESS_UNREADABLE: 'not used',
      countStoredForLiveAccount: cache.countStoredForLiveAccount,
      getCycleCount,
      hydrateFromSnapshot: (snap: unknown) => hydrated.push(snap),
      setLoading: () => undefined,
      setReadError: (v: unknown) => {
        state.readError = v;
      },
      setEmptyState: (v: unknown) => {
        state.emptyState = v;
      },
      Network: {
        getNetworkStateAsync: async () => ({ isConnected: false, isInternetReachable: false }),
      },
      COUNT_UNREADABLE_ON_PHONE: 'not used',
      cacheWriteScope: cache.cacheWriteScope,
      supabase: {},
      fetchAllCycleCountLines: async () => ({ data: [], error: null }),
    });
    await loadOnce();
    expect(getCycleCount).not.toHaveBeenCalled();
    expect(hydrated).toEqual([]);
    expect(state.readError).toBe(NOT_SYNCED_YET);
    expect(state.emptyState).toBe('read-failed');
  });
});
