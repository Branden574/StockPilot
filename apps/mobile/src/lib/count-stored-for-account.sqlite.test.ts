import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import { CYCLE_COUNT_HEADER_UPSERT_SQL } from './cycle-count-snapshot-sql';

/**
 * WHICH STORED COUNT A SCREEN MAY SHOW BEFORE THIS WORKSPACE HAS SYNCED (S75).
 *
 * While a member's access is 'not-synced' (screen-access.ts), nothing stored
 * on the phone is read for them, except a count the server itself returned
 * to THIS account in THIS workspace: the count screen's own fetch, stored by
 * cacheCycleCount. What proves it, on the row:
 *   - `cached_at` is set: only cacheCycleCount writes it (a pull's upsert,
 *     CYCLE_COUNT_HEADER_UPSERT_SQL, never does, so a pull's row, a pull
 *     stopped half way included, has none);
 *   - `organization_id` is the workspace on screen: cacheCycleCount writes
 *     the fetched count's workspace, and stores only the active one's;
 *   - `last_synced_at` is not UNCONFIRMED_ROW_STAMP: an adopted cache's rows
 *     can be anyone's (db.ts markCacheUnconfirmed);
 *   - the cache is recorded as the signed-in account's (meta
 *     `cache_user_id`): cacheCycleCount never stores into a cache recorded
 *     as another account's, and a cache left by another account is not this
 *     member's until its reset.
 * Against the real schema (db.ts ensureSchema on node:sqlite).
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null }, error: null }) } },
  readDeviceAuthSession: async () => ({ present: true, userId: 'u1' }),
}));
const live = vi.hoisted(() => ({ userId: 'u1' as string | null, orgId: 'org-a' as string | null }));
vi.mock('./session-scope', () => ({
  outboxWriteScope: async () => ({ orgId: live.orgId, userId: live.userId }),
  liveOutboxScope: async () => ({ orgId: live.orgId, userId: live.userId }),
}));

type Cache = typeof import('./cycle-count-cache');
let raw: DatabaseSync;
let cache: Cache;

const header = (id: string) => ({
  id,
  organizationId: 'org-a',
  warehouseId: null,
  warehouseName: null,
  status: 'in_progress',
  startedAt: '2026-11-01T08:00:00.000Z',
});
const setOwner = (userId: string) =>
  raw.prepare("insert or replace into meta (key, value) values ('cache_user_id', ?)").run(userId);

beforeEach(async () => {
  live.userId = 'u1';
  live.orgId = 'org-a';
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  cache = await import('./cycle-count-cache');
  await (await import('./db')).getDb();
  setOwner('u1');
  // Fetched by this account in this workspace (the count screen's own store).
  expect(await cache.cacheCycleCount(header('c-fetched'), [], await cache.cacheWriteScope())).toBe(
    true,
  );
  // Sent by a pull: no cached_at, no workspace on the row.
  raw
    .prepare(CYCLE_COUNT_HEADER_UPSERT_SQL)
    .run('c-pulled', 'in_progress', null, '2026-11-01T08:00:00.000Z', null, null, null, 1000);
  // Fetched, then the cache was adopted (marked unconfirmed).
  expect(await cache.cacheCycleCount(header('c-adopted'), [], await cache.cacheWriteScope())).toBe(
    true,
  );
  raw.prepare("update cycle_counts set last_synced_at = 0 where id = 'c-adopted'").run();
  // Another workspace's count.
  raw
    .prepare(
      `insert into cycle_counts (id, organization_id, status, started_at, last_synced_at, cached_at)
       values ('c-other-org', 'org-b', 'in_progress', '2026-11-01T08:00:00.000Z', 1000, 1000)`,
    )
    .run();
});

describe('countStoredForLiveAccount', () => {
  it('only the count this account fetched in this workspace', async () => {
    expect(await cache.countStoredForLiveAccount('c-fetched')).toBe(true);
    expect(await cache.countStoredForLiveAccount('c-pulled')).toBe(false);
    expect(await cache.countStoredForLiveAccount('c-adopted')).toBe(false);
    expect(await cache.countStoredForLiveAccount('c-other-org')).toBe(false);
    expect(await cache.countStoredForLiveAccount('c-missing')).toBe(false);
  });

  it("never in a cache recorded as another account's, or as nobody's", async () => {
    setOwner('u2');
    expect(await cache.countStoredForLiveAccount('c-fetched')).toBe(false);
    raw.prepare("delete from meta where key = 'cache_user_id'").run();
    expect(await cache.countStoredForLiveAccount('c-fetched')).toBe(false);
  });

  it('never for another signed-in account, or with no workspace saved', async () => {
    live.userId = 'u2';
    expect(await cache.countStoredForLiveAccount('c-fetched')).toBe(false);
    live.userId = 'u1';
    live.orgId = 'org-b';
    expect(await cache.countStoredForLiveAccount('c-fetched')).toBe(false);
    live.orgId = null;
    expect(await cache.countStoredForLiveAccount('c-fetched')).toBe(false);
  });
});

describe('listCountsStoredForLiveAccount', () => {
  it('lists only those counts', async () => {
    expect((await cache.listCountsStoredForLiveAccount()).map((c) => c.id)).toEqual(['c-fetched']);
    setOwner('u2');
    expect(await cache.listCountsStoredForLiveAccount()).toEqual([]);
  });
});
