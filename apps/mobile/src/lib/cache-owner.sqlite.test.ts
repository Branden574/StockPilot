import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';

/**
 * WHOSE PHOTOS: the record of whose cache this is (`cache_user_id`,
 * cache-owner.ts) through every wipe, run on the REAL code end to end: db.ts on
 * a real SQLite (node:sqlite behind the expo-sqlite stand-in, with its own
 * ensureSchema), sync.ts's pull and its cache-owner reset, photo-cache-wipe.ts
 * and the photo links in image-cache.ts, use-workspace.ts's switch and
 * workspace repair, offline-cache.ts's Clear, cycle-count-cache.ts and
 * session-scope.ts. Faked: the stored session, the network, AsyncStorage, the
 * server's answers, and expo-image's two caches (the photos drawn into each).
 *
 * THE DEFECT (B18 review, 2026-10-24). A workspace switch, the workspace
 * repair and Settings > Offline cache > Clear run deleteOrgData, which erased
 * the record and kept the photos. Until a pull landed and stamped it again (a
 * switch's pull is fire-and-forget and fails offline), the cache belonged to
 * nobody. A session that then ended without a wipe ("Use password instead",
 * "Use a different account", a session revoked elsewhere, an expired refresh
 * token) let the next account's first pull answer 'adopt' instead of 'reset',
 * and the previous account's photos stayed in expo-image's memory and disk
 * caches, and its photo links in memory. The repair can even run inside the
 * next account's own sign-in, before its first pull.
 *
 * AND A PULL THAT FOUND NO RECORD (B18 review of da5337b23). It adopted the
 * device as it was, photos included, and recorded nobody until a pull landed.
 * An account whose pulls kept failing (online, but the snapshot timing out on
 * weak Wi-Fi, a 500, a 429) was never recorded while it drew photos the Items
 * list, item detail and scan sign straight from storage, and cached the counts
 * it opened; after its session ended without a wipe, the next account adopted
 * them too. And the release before this one forgot the record at every wipe
 * and cleared the photos at none, so at the first launch of this one a phone
 * with no owner recorded can hold anyone's photos.
 *
 * AND A FAILED PHOTO CLEAR, AND THE ROWS AN ADOPT KEPT (B18 reviews of
 * 43256f0da). A photo clear that failed (expo-image answering false, or
 * rejecting) still recorded the account, so every later pull kept, and the
 * photos were never cleared. And a pull that found no record kept the rows, the
 * delta cursor and the persisted scope it found, although they can be another
 * account's (an older release's switch, repair and Clear erased the record
 * while rows cached after them stayed): the next account delta-pulled from
 * someone else's cursor, and their items, POs and counts were never swept. And
 * the count screen stored a count it had fetched without checking that the
 * cache and the account were still the ones it fetched for.
 *
 * AND NO RECORD AFTER A FAILED CLEAR (B18 review of 254fb9c72). Leaving the
 * record absent after a failed photo clear, so that the next pull cleared
 * again, left the live account's freshly pulled rows with no owner recorded.
 * After its session ended without a wipe, the next account's pull adopted
 * them instead of resetting them, and an adopt only marks the rows: offline,
 * that account read the previous account's items, purchase orders and counts.
 * And while the clear kept failing, every tick adopted again, forgetting the
 * account's own cursor, modules, permissions and warehouse scope and pulling
 * in full. Another account's unsent count released on a count this account
 * keeps but its pull does not return also stayed as a clean, counted line.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));

const A = 'u-a';
const B = 'u-b';
const C = 'u-c';
const PHOTO_A = 'org-1/item-a/master.webp';
const PHOTO_B = 'org-1/item-b/master.webp';

/** The phone and the server, as the code under test sees them. */
const device = vi.hoisted(() => ({
  /** The account whose session is stored here; null when none is. */
  userId: null as string | null,
  online: true,
  /** Online, but the snapshot request never answers (weak warehouse Wi-Fi). */
  snapshotFails: false,
  /** The connection drops right after the next membership read answers. */
  dropAfterMemberships: false,
  /** The next cache wipe's SQLite statements fail ("database is locked"). */
  failWipe: false,
  storage: new Map<string, string>(),
  memberships: {} as Record<string, string[]>,
  /** expo-image's caches: the storage paths of the photos drawn into each. */
  memory: new Set<string>(),
  disk: new Set<string>(),
  /** The photo disk clear never finishes: the app is closed during it. */
  holdDiskClear: false,
  /** Photo links the server signed. */
  signed: 0,
  authListener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
  /** Every snapshot request the pull sent, by path. */
  requests: [] as string[],
  /** Changes the server's answer for one test (what an account can see), or
   *  holds it on its way (holdNextAnswer). */
  answer: null as
    null | ((snap: SnapshotAnswer, userId: string) => SnapshotAnswer | Promise<SnapshotAnswer>),
}));

const image = vi.hoisted(() => ({ clearMemoryCache: vi.fn(), clearDiskCache: vi.fn() }));
vi.mock('expo-image', () => ({ Image: image }));

vi.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({
    isConnected: device.online,
    isInternetReachable: device.online,
  }),
}));

// The count outbox's drain (cycle-count-sync.ts) reads AppState only in
// start(), which nothing here calls: its forceSync() is run directly.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => device.storage.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      device.storage.set(k, v);
    },
    removeItem: async (k: string) => {
      device.storage.delete(k);
    },
  },
}));

/** An open count as the snapshot lists it. */
interface CountAnswer {
  id: string;
  status: string;
  warehouseId: string | null;
  startedAt: string;
  assignedTo: string | null;
  notes: string | null;
  lines: { id: string; itemId: string; expected: number; counted: number | null }[];
}

interface SnapshotAnswer {
  serverTime: string;
  enabledModules: string[];
  permissions: string[];
  warehouses: { id: string; name: string }[];
  items: {
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    quantityOnHand: number;
    unitCost: number;
    warehouseId: string | null;
    itemType: string;
  }[];
  openPOs: unknown[];
  openCycleCounts: CountAnswer[];
  bundles: unknown[];
  activeBundleIds?: string[];
}

/** The snapshot the server answers for an account in a workspace. */
function snapshotFor(userId: string, orgId: string | null): SnapshotAnswer {
  return {
    serverTime: '2026-10-24T12:00:00.000Z',
    enabledModules: [],
    permissions: [],
    warehouses: [{ id: `wh-${orgId}`, name: 'Main' }],
    items: [
      {
        id: `item-${userId}-${orgId}`,
        sku: `sku-${userId}`,
        name: 'Item',
        barcode: null,
        quantityOnHand: 1,
        unitCost: 0,
        warehouseId: `wh-${orgId}`,
        itemType: 'standard',
      },
    ],
    openPOs: [],
    openCycleCounts: [],
    bundles: [],
  };
}

vi.mock('./api', () => ({
  api: vi.fn(async (path: string, opts: { asUserId?: string } = {}) => {
    device.requests.push(path);
    if (!device.online || device.snapshotFails) throw new TypeError('Network request failed');
    // api.ts refuses a request whose session changed since it was asked for.
    if (opts.asUserId !== device.userId || !device.userId) throw new Error('session changed');
    const snap = snapshotFor(device.userId, device.storage.get('workspace.activeOrgId') ?? null);
    return device.answer ? device.answer(snap, device.userId) : snap;
  }),
}));

vi.mock('./supabase', () => {
  const offline = {
    data: null,
    error: { message: 'TypeError: Network request failed' },
    status: 0,
  };
  const link = (p: string) => `https://files.example/${p}?link=${++device.signed}`;
  const table = (name: string) => {
    const filters: Record<string, unknown> = {};
    const answer = async () => {
      if (!device.online) return offline;
      if (name === 'organization_members') {
        const ids = device.memberships[String(filters.user_id)] ?? [];
        if (device.dropAfterMemberships) {
          device.dropAfterMemberships = false;
          device.online = false;
        }
        return {
          data: ids.map((id) => ({
            role: 'staff',
            organization_id: id,
            organizations: { name: id },
          })),
          error: null,
        };
      }
      if (name === 'user_profiles') return { data: { default_organization_id: null }, error: null };
      return {
        data: [{ id: `wh-${String(filters.organization_id)}`, name: 'Main', status: 'active' }],
        error: null,
      };
    };
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      },
      not: answer,
      order: answer,
      maybeSingle: answer,
    };
    return query;
  };
  return {
    readDeviceAuthSession: async () => ({ present: device.userId !== null, userId: device.userId }),
    supabase: {
      from: table,
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: (cb: typeof device.authListener) => {
          device.authListener = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
      storage: {
        from: () => ({
          createSignedUrl: async (p: string) => ({ data: { signedUrl: link(p) }, error: null }),
          createSignedUrls: async (paths: string[]) => ({
            data: paths.map((p) => ({ path: p, signedUrl: link(p) })),
            error: null,
          }),
        }),
      },
    },
  };
});

/** The signed-in user the screens see (auth-context.tsx). */
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('./auth-context', () => ({ useAuth: () => ({ user: auth.user }) }));

/** What use-workspace.ts published, in order. React is replaced so a call to
 *  useWorkspace() runs its effects at once: a screen mounting. */
const published = vi.hoisted(() => [] as { loading: boolean; activeOrgId: string | null }[]);
vi.mock('react', () => ({
  useState: (v: unknown) => [v, (next: (typeof published)[number]) => published.push(next)],
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));

type Loaded = {
  db: typeof import('./db');
  sync: typeof import('./sync');
  ws: typeof import('./use-workspace');
  images: typeof import('./image-cache');
  offline: typeof import('./offline-cache');
  counts: typeof import('./cycle-count-cache');
  photoWipe: typeof import('./photo-cache-wipe');
  perms: typeof import('./use-effective-permissions');
  scope: typeof import('./warehouse-scope');
  /** The offline readers the scan, receive and item screens use. */
  reads: typeof import('./db-reads');
};

let raw: DatabaseSync;
let m: Loaded;

/** Start the app over the database already on the phone (`raw`). */
async function launch(): Promise<void> {
  vi.resetModules();
  const handle = nodeExpoDb(raw, {
    beforeCall: (sql) => {
      if (device.failWipe && sql.includes('delete from items;')) {
        device.failWipe = false;
        throw new Error('database is locked');
      }
    },
  });
  sqlite.open.mockReset().mockImplementation(async () => handle);
  m = {
    db: await import('./db'),
    sync: await import('./sync'),
    ws: await import('./use-workspace'),
    images: await import('./image-cache'),
    offline: await import('./offline-cache'),
    counts: await import('./cycle-count-cache'),
    photoWipe: await import('./photo-cache-wipe'),
    perms: await import('./use-effective-permissions'),
    scope: await import('./warehouse-scope'),
    reads: await import('./db-reads'),
  };
  await m.db.getDb();
  // The first auth event only records who is signed in (use-workspace.ts).
  device.authListener?.('INITIAL_SESSION', device.userId ? { user: { id: device.userId } } : null);
}

/** The app is closed and opened again: the database and the photo disk cache
 *  stay, the photo memory cache and the links held in memory are gone, and a
 *  disk clear that was still running never finishes. */
async function relaunch(): Promise<void> {
  device.memory.clear();
  device.holdDiskClear = false;
  await launch();
}

function signIn(userId: string): void {
  device.userId = userId;
  auth.user = { id: userId };
  device.authListener?.('SIGNED_IN', { user: { id: userId } });
}

/** "Use password instead", "Use a different account", a session revoked
 *  elsewhere, an expired refresh token: the session ends and nothing is wiped. */
function sessionEndsWithoutWipe(): void {
  device.userId = null;
  auth.user = null;
  device.authListener?.('SIGNED_OUT', null);
}

/** A screen draws a photo: its link is signed and held for the session, and
 *  expo-image keeps the picture in memory and on disk. */
async function viewPhoto(p: string): Promise<void> {
  await m.images.signItemImage(p);
  device.memory.add(p);
  device.disk.add(p);
}

/** Nothing of the photo is left: in neither image cache, and its link was
 *  forgotten (drawing it again asks the server to sign it). */
async function expectForgotten(p: string): Promise<void> {
  expect(device.memory.has(p), `${p} in the memory cache`).toBe(false);
  expect(device.disk.has(p), `${p} in the disk cache`).toBe(false);
  const asked = device.signed;
  await m.images.signItemImage(p);
  expect(device.signed, `${p}'s link was still held`).toBe(asked + 1);
}

/** The photo is still drawn from the caches, through the link already held. */
async function expectKept(p: string): Promise<void> {
  expect(device.memory.has(p), `${p} in the memory cache`).toBe(true);
  expect(device.disk.has(p), `${p} in the disk cache`).toBe(true);
  const asked = device.signed;
  await m.images.signItemImage(p);
  expect(device.signed, `${p} was signed again`).toBe(asked);
}

const owner = () =>
  (
    raw.prepare("select value from meta where key = 'cache_user_id'").get() as
      { value: string } | undefined
  )?.value ?? null;
const items = () =>
  (raw.prepare('select id from items order by id').all() as { id: string }[]).map((r) => r.id);
const ids = (sql: string) => (raw.prepare(sql).all() as { id: string }[]).map((r) => r.id);
const metaValue = (key: string) =>
  (raw.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined)
    ?.value ?? null;
/** The record that a photo clear at a reset or an adopt failed, and is still
 *  owed (cache-owner.ts): the account recorded with it, or null. */
const photoClearOwed = () => metaValue('cache_photos_pending');
/** One cached count line, as the count screen would read it. */
const line = (id: string) =>
  raw.prepare('select counted, local_dirty from cycle_count_lines where id = ?').get(id) as
    { counted: number | null; local_dirty: number } | undefined;
/** The outbox's record_count rows: whose, for which count, in what state. */
const queuedCounts = () =>
  raw
    .prepare(
      `select user_id, status, json_extract(payload_json, '$.cycleCountId') as count_id
         from pending_actions where kind = 'record_count' order by id`,
    )
    .all() as { user_id: string | null; status: string; count_id: string }[];
/** The same rows by line, each a count or a clear of the line's count. */
const queuedEdits = () =>
  raw
    .prepare(
      `select user_id, status, json_extract(payload_json, '$.lineId') as line_id,
              case when json_extract(payload_json, '$.clear') = 1 then 'clear' else 'count' end as edit
         from pending_actions where kind = 'record_count' order by id`,
    )
    .all() as { user_id: string | null; status: string; line_id: string; edit: string }[];

/** A photo is still in either of expo-image's caches. */
const stillCached = (p: string) => device.memory.has(p) || device.disk.has(p);

/** The ways a photo clear fails: expo-image answering false or rejecting.
 *  Each fails the NEXT call of that clear only. */
const PHOTO_CLEAR_FAILS: Record<string, () => void> = {
  'the disk clear answers false': () => {
    image.clearDiskCache.mockImplementationOnce(async () => false);
  },
  'the disk clear rejects': () => {
    image.clearDiskCache.mockImplementationOnce(async () => {
      throw new Error('disk busy');
    });
  },
  'the memory clear rejects': () => {
    image.clearMemoryCache.mockImplementationOnce(async () => {
      throw new Error('memory busy');
    });
  },
};

/** Generous: every statement on the stand-in database yields a macrotask, and
 *  a loaded runner stretches each one. Each test here runs a few pulls and
 *  wipes end to end, well under a second alone, but the full suite beside
 *  other suites can push one past vitest's 5 s default. */
const WAIT = { timeout: 10_000 };
const SLOW = { timeout: 30_000 };

/** A screen mounts and loads the workspace (use-workspace.ts hydrate). */
async function workspaceLoads(expectedOrgId: string): Promise<void> {
  m.ws.useWorkspace();
  await vi.waitFor(
    () => expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: expectedOrgId }),
    WAIT,
  );
}

/** Waits for the pull a switch, a repair or a wipe started in the background:
 *  this sync joins it, or runs the one chained after it. */
const backgroundPullsSettle = () => m.sync.syncNow();

/** A signs in to workspace org-1: its cache is pulled and recorded as its
 *  own, and a photo is drawn. */
async function aSignedInWithAPhoto(): Promise<void> {
  device.storage.set('workspace.activeOrgId', 'org-1');
  signIn(A);
  await m.sync.syncNow();
  expect(owner()).toBe(A);
  expect(items()).toEqual([`item-${A}-org-1`]);
  await viewPhoto(PHOTO_A);
  // Photo clears are counted from here: A's own first pull found no owner
  // recorded and cleared the (still empty) photo caches before recording A.
  image.clearMemoryCache.mockClear();
  image.clearDiskCache.mockClear();
}

/** The signed-in account opens a count online, so it can be counted offline
 *  (cycle-count-cache.ts: the one screen that caches rows outside the pull),
 *  and counts its line. The screen notes the cache and the account before it
 *  fetches (app/cycle-count/[id].tsx), and stores the count under that note. */
async function countOnThePhone(countId: string): Promise<void> {
  const fetchedUnder = await m.counts.cacheWriteScope();
  await m.counts.cacheCycleCount(
    {
      id: countId,
      organizationId: 'org-1',
      warehouseId: 'wh-org-1',
      warehouseName: 'Main',
      status: 'in_progress',
      startedAt: '2026-10-24T08:00:00.000Z',
    },
    [
      {
        id: `${countId}-l1`,
        itemId: 'item-x',
        itemName: 'X',
        itemSku: 'SKU-X',
        itemBarcode: null,
        expected: 4,
        counted: null,
        updatedAt: null,
      },
    ],
    fetchedUnder,
  );
  expect(await m.counts.updateLocalLine(`${countId}-l1`, 5)).not.toBeNull();
}

/** The signed-in account empties the box of a line with a saved count (RL1,
 *  B4a: app/cycle-count/[id].tsx clearLocalLine): the line is uncounted and
 *  unsynced, and a clear is queued in the count outbox in place of the
 *  count it queued for the line, if any (cycle-count-clear.ts). */
async function emptyTheBox(lineId: string): Promise<void> {
  expect(await m.counts.clearLocalLine(lineId)).not.toBeNull();
}

/** A count's header, as the count screen fetched it in workspace org-1. */
const countHeader = (id: string) => ({
  id,
  organizationId: 'org-1',
  warehouseId: 'wh-org-1',
  warehouseName: 'Main',
  status: 'in_progress',
  startedAt: '2026-10-24T08:00:00.000Z',
});
/** One of its lines as fetched, with the server's count. */
const fetchedLine = (id: string, counted: number | null) => ({
  id,
  itemId: 'item-x',
  itemName: 'X',
  itemSku: 'SKU-X',
  itemBarcode: null,
  expected: 4,
  counted,
  updatedAt: null,
});

/** The count outbox's drain, for the account signed in now (cycle-count-sync.ts
 *  forceSync: a tick, the foreground, a save on the count screen). */
async function countsDrain(): Promise<void> {
  const { cycleCountSync } = await import('./cycle-count-sync');
  await cycleCountSync.forceSync();
}

/** What a queued line edit is sent to: a count to the line's record route,
 *  a clear to its clear route (cycle-count-sync.ts sendRecordCount). */
const editPath = (edit: 'count' | 'clear', countId: string, lineId: string) =>
  `/api/v1/cycle-counts/${countId}/lines/${lineId}/${edit === 'clear' ? 'clear' : 'record'}`;

/** origin/main's clearOrgScopedTables (db.ts at 96901a1b5), verbatim. It was
 *  the SQLite part of every cache wipe of the release before this one (a
 *  sign-out, an eviction, a workspace switch, the workspace repair, Clear
 *  offline cache, the reset for another account), and none of them cleared the
 *  photos (its auth-context.tsx: `wipeCache: wipeForSignOut`): each forgot the
 *  record and kept them. */
const PREVIOUS_RELEASE_WIPE = `
    delete from items;
    delete from warehouses;
    delete from purchase_orders;
    delete from po_lines;
    delete from cycle_counts;
    delete from cycle_count_lines;
    delete from bundles;
    delete from bundle_components;
    delete from meta where key = 'last_synced_at';
    delete from meta where key = 'enabled_modules';
    delete from meta where key = 'effective_permissions';
    delete from meta where key = 'warehouse_scope';
    delete from meta where key = 'cache_user_id';
`;

/** Settings > Offline cache > Clear, with the same dependencies the screen
 *  passes (app/(drawer)/settings.tsx; pinned below). */
const clearOfflineCache = () =>
  m.offline.clearOfflineCache({
    isOnline: m.sync.isOnline,
    deleteOrgData: m.db.deleteOrgData,
    syncNow: m.sync.syncNow,
    refreshEffectivePermissions: m.perms.refreshEffectivePermissions,
    refreshWarehouseScope: m.scope.refreshWarehouseScope,
  });

/** The three wipes that clear the rows and keep the photos, run as A. */
const SAME_ACCOUNT_WIPES: Record<string, () => Promise<void>> = {
  'a workspace switch': async () => {
    await m.ws.setActiveOrg('org-2');
    await backgroundPullsSettle();
  },
  // A was removed from its saved workspace: the load picks another and clears
  // the cache (workspace-choice.ts resetCache).
  'the workspace repair': async () => {
    device.memberships[A] = ['org-3'];
    await workspaceLoads('org-3');
    await backgroundPullsSettle();
  },
  'Settings > Offline cache > Clear': async () => {
    expect(await clearOfflineCache()).toEqual({ ok: true });
  },
};

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  device.userId = null;
  device.online = true;
  device.snapshotFails = false;
  device.dropAfterMemberships = false;
  device.failWipe = false;
  device.storage = new Map();
  device.memberships = { [A]: ['org-1', 'org-2'], [B]: ['org-1'], [C]: ['org-1'] };
  device.memory = new Set();
  device.disk = new Set();
  device.holdDiskClear = false;
  device.signed = 0;
  device.authListener = null;
  device.requests = [];
  device.answer = null;
  auth.user = null;
  published.length = 0;
  image.clearMemoryCache.mockReset().mockImplementation(async () => {
    device.memory.clear();
    return true;
  });
  image.clearDiskCache.mockReset().mockImplementation(() =>
    device.holdDiskClear
      ? new Promise<boolean>(() => {})
      : Promise.resolve().then(() => {
          device.disk.clear();
          return true;
        }),
  );
  // Failed pulls and wipes are reported with console.warn, by design.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await launch();
}, SLOW.timeout);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a wipe that keeps the photos keeps the record of whose they are', SLOW, () => {
  const cases = Object.keys(SAME_ACCOUNT_WIPES).flatMap((wipe) =>
    (['online', 'offline'] as const).map((mode) => [wipe, mode] as const),
  );

  // Mutation caught: deleteOrgData (clearOrgScopedTables) forgetting the
  // record again.
  it.each(cases)(
    "%s whose pull never lands, then a session ended without a wipe: the next account's first pull (%s) clears the previous account's photos and links",
    async (wipe, mode) => {
      await aSignedInWithAPhoto();
      device.snapshotFails = true; // the wipe's own pull never lands
      await SAME_ACCOUNT_WIPES[wipe]!();
      device.snapshotFails = false;
      // The account is the same, so the record still names it.
      expect.soft(owner()).toBe(A);

      sessionEndsWithoutWipe();
      signIn(B);
      device.online = mode === 'online';
      await m.sync.syncNow(); // B's first pull

      await expectForgotten(PHOTO_A);
      expect(items().filter((id) => id.startsWith(`item-${A}`))).toEqual([]);
      expect(owner()).toBe(B);
    },
  );

  // The repair can run inside the next account's OWN sign-in: a fallback
  // sign-out keeps the saved workspace, and it is not one of B's. A record
  // re-stamped to the live account at that wipe would hand B A's photos.
  it.each(['online', 'offline'] as const)(
    "the repair run by the next account's own sign-in, before its first pull: that pull (%s) still clears the previous account's photos",
    async (mode) => {
      await aSignedInWithAPhoto();
      sessionEndsWithoutWipe(); // keeps workspace.activeOrgId = org-1
      device.memberships[B] = ['org-9'];
      signIn(B);
      device.dropAfterMemberships = mode === 'offline';
      await workspaceLoads('org-9'); // resetCache: deleteOrgData, then a forced pull
      await backgroundPullsSettle();

      expect(device.storage.get('workspace.activeOrgId')).toBe('org-9');
      await expectForgotten(PHOTO_A);
      expect(items().filter((id) => id.startsWith(`item-${A}`))).toEqual([]);
      expect(owner()).toBe(B);
    },
  );

  // Mutation caught: any of the three clearing the photos (option (b)), which
  // would drop every photo of every workspace at each switch.
  it.each(Object.keys(SAME_ACCOUNT_WIPES))(
    "%s keeps the same account's photos and links, and its next pull keeps them too",
    async (wipe) => {
      await aSignedInWithAPhoto();
      await SAME_ACCOUNT_WIPES[wipe]!();
      await m.sync.syncNow(); // the next 60 s tick

      expect(owner()).toBe(A);
      expect(items()).toHaveLength(1);
      expect(items()[0]).toMatch(new RegExp(`^item-${A}-`));
      expect(image.clearDiskCache).not.toHaveBeenCalled();
      await expectKept(PHOTO_A);
    },
  );
});

describe('the reset for another account', SLOW, () => {
  // Mutation caught: the reset leaving the previous owner recorded until a
  // pull lands. The owner check runs before the network check, so every
  // later tick reset again and wiped the count B had cached to work on.
  it("a pull that fails after the reset leaves the cache recorded as the new account's: its next pull keeps a count it cached since, and another account's pull still resets", async () => {
    await aSignedInWithAPhoto();
    sessionEndsWithoutWipe();
    signIn(B);
    device.snapshotFails = true; // weak Wi-Fi: the snapshot times out
    await m.sync.syncNow(); // B's first pull: the reset, then no answer
    device.snapshotFails = false;
    await expectForgotten(PHOTO_A);
    expect(items()).toEqual([]);
    expect.soft(owner()).toBe(B);

    // B opens a count online, so it can be counted offline, then counts.
    await countOnThePhone('cc-b');
    await viewPhoto(PHOTO_B);
    device.online = false;

    await m.sync.syncNow(); // the next tick, offline

    const count = await m.counts.getCycleCount('cc-b');
    expect(count?.lines).toEqual([
      expect.objectContaining({ id: 'cc-b-l1', counted: 5, localDirty: true }),
    ]);
    await expectKept(PHOTO_B);
    expect(owner()).toBe(B);

    // B's session ends without a wipe too: C's first pull clears B's things.
    sessionEndsWithoutWipe();
    signIn(C);
    await m.sync.syncNow();
    expect(await m.counts.getCycleCount('cc-b')).toBeNull();
    await expectForgotten(PHOTO_B);
    expect(owner()).toBe(C);
  });

  // Mutation caught: the new account recorded whether or not the wipe worked.
  it('a reset whose SQLite wipe fails leaves the previous account recorded: the next pull resets again rather than adopting', async () => {
    await aSignedInWithAPhoto();
    sessionEndsWithoutWipe();
    signIn(B);
    device.failWipe = true;
    await m.sync.syncNow(); // the reset's wipe throws; syncNow reports it

    expect(owner()).toBe(A);
    expect(items()).toEqual([`item-${A}-org-1`]);
    // The photos went anyway (photo-cache-wipe.ts).
    expect(device.disk.has(PHOTO_A)).toBe(false);

    await m.sync.syncNow(); // the next tick

    expect(image.clearDiskCache).toHaveBeenCalledTimes(2);
    expect(items()).toEqual([`item-${B}-org-1`]);
    expect(owner()).toBe(B);
    await expectForgotten(PHOTO_A);
  });
});

/** The next snapshot answer is held until `release()` is called: the request
 *  has left, with the bearer of the account signed in when it was sent (the
 *  api stand-in checks it there, as api.ts does), and its answer is still on
 *  its way (a slow snapshot on warehouse Wi-Fi; api.ts gives up after 20 s).
 *  `extra` replaces parts of that answer. */
function holdNextAnswer(extra: Partial<SnapshotAnswer> = {}): { release: () => void } {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = device.answer;
  device.answer = (snap) => {
    device.answer = previous;
    return arrived.then(() => ({ ...snap, ...extra }));
  };
  return { release: () => release() };
}

/** A warehouse, and an item in it, that only A's warehouse scope returns. */
const A_ONLY_WAREHOUSE = { id: 'wh-a-only', name: 'A only' };
const A_ONLY_ITEM = {
  id: 'item-a-only',
  sku: 'SKU-A-ONLY',
  name: 'A only',
  barcode: 'A-ONLY',
  quantityOnHand: 7,
  unitCost: 99,
  warehouseId: A_ONLY_WAREHOUSE.id,
  itemType: 'standard',
};

/** The app comes to the foreground as A, and the biometric lock shows: A's
 *  pull is sent with A's bearer, and its answer, which carries the warehouse
 *  and the item only A can read, is held. */
async function aPullIsOut(): Promise<{ held: { release: () => void }; aSync: Promise<void> }> {
  const held = holdNextAnswer({
    warehouses: [...snapshotFor(A, 'org-1').warehouses, A_ONLY_WAREHOUSE],
    items: [...snapshotFor(A, 'org-1').items, A_ONLY_ITEM],
  });
  const before = device.requests.length;
  const aSync = m.sync.syncNow();
  await vi.waitFor(() => expect(device.requests).toHaveLength(before + 1), WAIT);
  return { held, aSync };
}

describe("a session that ends while the previous account's pull is still out", SLOW, () => {
  // Mutation caught: syncNow joining a running sync on the cache generation
  // alone (B18 final review of d973727f6). A session that ends without a wipe
  // moves no generation, and B signing in to the same workspace runs no
  // repair, so B's first sync joined A's pull: A's answer was written and
  // recorded as A's, and B's reset waited for the next 60 s tick or
  // foreground while B read A's rows.
  it("B signs in while A's pull is out: once B's first sync is over, B reads none of A's rows, and A's photos are gone", async () => {
    await aSignedInWithAPhoto();
    const { held, aSync } = await aPullIsOut();
    // "Use password instead": the session ends with no wipe, B signs in, and
    // useSync runs B's first sync (use-sync.ts, on the user change).
    sessionEndsWithoutWipe();
    signIn(B);
    const bFirst = m.sync.syncNow();
    held.release(); // A's answer arrives
    await Promise.all([aSync, bFirst]);

    expect(owner()).toBe(B);
    expect(items()).toEqual([`item-${B}-org-1`]);
    // What B's screens read from the phone: a kit's component items, with on
    // hand and unit cost, and the warehouse pickers.
    expect(await m.reads.getItemById(A_ONLY_ITEM.id)).toBeNull();
    expect((await m.reads.listWarehouses()).map((w) => w.id)).toEqual(['wh-org-1']);
    await expectForgotten(PHOTO_A);
    // B's own pull, in full, once A's had settled.
    expect(device.requests.at(-1)).toBe('/api/v1/mobile/snapshot');
  });

  // Mutation caught: the same. B's first sync ended with the cache still
  // recorded as A's, so a count B opened in the next minute was stored there,
  // and A, signing in again before B's next tick, kept it (A's own pull keeps
  // A's cache): B's unsent number showed as A's own pending edit, which A
  // could post without (pendingCountFor answers 0 for B's entry).
  it("a count B opens after its first sync is B's alone: A, signing in again before B's next tick, does not find it, and B's entry stays held for B", async () => {
    await aSignedInWithAPhoto();
    const { held, aSync } = await aPullIsOut();
    sessionEndsWithoutWipe();
    signIn(B);
    const bFirst = m.sync.syncNow();
    held.release();
    await Promise.all([aSync, bFirst]);

    // In the next minute B opens a count online and counts a line.
    await countOnThePhone('cc-b');
    // B's session is revoked elsewhere (no wipe), and A signs in again.
    sessionEndsWithoutWipe();
    signIn(A);
    await m.sync.syncNow();

    expect(owner()).toBe(A);
    expect(await m.counts.getCycleCount('cc-b')).toBeNull();
    expect(await m.counts.listCachedCycleCounts()).toEqual([]);
    expect(await m.counts.pendingCountFor('cc-b')).toBe(0);
    // B's count is not lost: held for B, and sent when B signs in here again.
    expect(queuedCounts()).toEqual([{ user_id: B, status: 'pending', count_id: 'cc-b' }]);
  });

  // Mutation caught: the pull writing an answer whatever happened to the
  // account while its request was out (only a wipe stopped it).
  it("A's session ends while its pull is out: A's answer is not written, and A, signing in again, loses nothing", async () => {
    await aSignedInWithAPhoto();
    const cursor = String(metaValue('last_synced_at'));
    const { held, aSync } = await aPullIsOut();
    sessionEndsWithoutWipe();
    held.release();
    await aSync;

    expect(await m.reads.getItemById(A_ONLY_ITEM.id)).toBeNull();
    expect(items()).toEqual([`item-${A}-org-1`]);
    expect(metaValue('last_synced_at')).toBe(cursor);
    expect(owner()).toBe(A);

    signIn(A);
    await m.sync.syncNow();
    // A delta from the same cursor, on A's own cache, with A's photos kept.
    expect(device.requests.at(-1)).toBe(
      `/api/v1/mobile/snapshot?since=${encodeURIComponent(cursor)}`,
    );
    expect(owner()).toBe(A);
    expect(items()).toEqual([`item-${A}-org-1`]);
    await expectKept(PHOTO_A);
  });
});

/** The two ways an account leaves the device, each run as A once its session
 *  is gone. */
const ACCOUNT_EXITS: Record<string, () => Promise<unknown>> = {
  // auth-context.tsx signOut, once the session is gone (photo-links-wiring.test.ts pins it).
  'a sign-out': () => m.photoWipe.wipeWithPhotoCaches(m.db.wipeForSignOut),
  // use-account-gate.ts, a confirmed disable (pinned there too).
  'an account eviction': () => m.photoWipe.wipeWithPhotoCaches(() => m.db.wipeForEviction(A)),
};

describe('the record changes only once the photos are gone', SLOW, () => {
  // Mutation caught: the SQLite wipe (which forgets the record) run before the
  // photo wipe, as it was: an app closed while the disk clear ran left photos
  // with no owner recorded, and the next account adopted them.
  it.each(Object.keys(ACCOUNT_EXITS))(
    "%s the app is closed during, before the photo disk clear finished: the record still names the account, and the next account's first pull clears the photos",
    async (exit) => {
      await aSignedInWithAPhoto();
      device.userId = null; // the session is gone before the wipe runs
      auth.user = null;
      device.holdDiskClear = true;
      void ACCOUNT_EXITS[exit]!();
      await vi.waitFor(() => expect(image.clearDiskCache).toHaveBeenCalledTimes(1), WAIT);
      await new Promise((resolve) => setTimeout(resolve, 20));

      await relaunch();
      expect(device.disk.has(PHOTO_A)).toBe(true); // the clear never finished
      expect.soft(owner()).toBe(A);
      signIn(B);
      await m.sync.syncNow();

      expect(device.disk.has(PHOTO_A)).toBe(false);
      expect(owner()).toBe(B);
    },
  );

  // Mutation caught: the reset recording the new account before the photo
  // wipe finished.
  it('a reset the app is closed during, before the photo disk clear finished: the next launch resets again', async () => {
    await aSignedInWithAPhoto();
    sessionEndsWithoutWipe();
    signIn(B);
    device.holdDiskClear = true;
    void m.sync.syncNow();
    await vi.waitFor(() => expect(image.clearDiskCache).toHaveBeenCalledTimes(1), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await relaunch(); // B's session is still stored
    expect(device.disk.has(PHOTO_A)).toBe(true);
    expect.soft(owner()).toBe(A);
    await m.sync.syncNow();

    expect(device.disk.has(PHOTO_A)).toBe(false);
    expect(items()).toEqual([`item-${B}-org-1`]);
    expect(owner()).toBe(B);
  });

  // Mutation caught: a sign-out or an eviction that keeps the record. The next
  // account's first pull would then reset a cache already emptied, and wipe
  // whatever it had cached before that pull ran: here a count it opened (from
  // a notification, say) and counted before its first pull.
  it.each(Object.keys(ACCOUNT_EXITS))(
    '%s that finishes forgets the record: the next account adopts the emptied cache, keeping the count it counted before its first pull',
    async (exit) => {
      await aSignedInWithAPhoto();
      device.userId = null;
      auth.user = null;
      await ACCOUNT_EXITS[exit]!();
      expect(owner()).toBeNull();
      expect(items()).toEqual([]);
      await expectForgotten(PHOTO_A);

      signIn(B);
      await countOnThePhone('cc-b');
      await m.sync.syncNow();

      expect((await m.counts.getCycleCount('cc-b'))?.lines).toEqual([
        expect.objectContaining({ id: 'cc-b-l1', counted: 5, localDirty: true }),
      ]);
      expect(items()).toEqual([`item-${B}-org-1`]);
      expect(owner()).toBe(B);
    },
  );
});

describe('a pull that finds no owner recorded', SLOW, () => {
  /** How this release leaves a phone with no owner recorded. */
  const NO_OWNER: Record<string, () => Promise<void>> = {
    'after a finished sign-out': async () => {
      await aSignedInWithAPhoto();
      device.userId = null;
      auth.user = null;
      await m.photoWipe.wipeWithPhotoCaches(m.db.wipeForSignOut);
    },
    'on a fresh install': async () => {
      device.storage.set('workspace.activeOrgId', 'org-1');
    },
  };
  const modes = ['online', 'offline'] as const;

  // Mutation caught: the adopt recording nobody until a pull lands, as at
  // da5337b23.
  it.each(Object.keys(NO_OWNER).flatMap((start) => modes.map((mode) => [start, mode] as const)))(
    "%s, an account whose pulls never land is still recorded: after its session ends without a wipe, the next account's first pull (%s) clears the photos, links and count it left",
    async (start, mode) => {
      await NO_OWNER[start]!();
      expect(owner()).toBeNull();

      signIn(B);
      device.snapshotFails = true; // online, but the snapshot times out (weak warehouse Wi-Fi)
      await m.sync.syncNow(); // B's first pull: no owner recorded, then no answer
      expect.soft(owner()).toBe(B);
      // The Items list, item detail and scan sign photos straight from
      // storage, not from the snapshot, so B's photos load anyway, and a count
      // B opens is cached for offline counting.
      await viewPhoto(PHOTO_B);
      await countOnThePhone('cc-b');

      sessionEndsWithoutWipe();
      signIn(C);
      device.snapshotFails = false;
      device.online = mode === 'online';
      await m.sync.syncNow(); // C's first pull

      await expectForgotten(PHOTO_B);
      expect(await m.counts.getCycleCount('cc-b')).toBeNull();
      expect(owner()).toBe(C);
    },
  );

  /** How the release before this one left photos with no owner recorded. */
  const PREVIOUS_RELEASE_LEFT: Record<string, () => Promise<void>> = {
    // Its sign-out: the usual end of a shift on a shared phone.
    'its sign-out': async () => {
      device.userId = null;
      auth.user = null;
      raw.exec(PREVIOUS_RELEASE_WIPE);
      await relaunch(); // this release starts at the next cold start
    },
    // Its workspace switch whose pull never landed; then, on this release, a
    // session that ends without a wipe.
    'its workspace switch whose pull never landed': async () => {
      raw.exec(PREVIOUS_RELEASE_WIPE);
      await relaunch();
      sessionEndsWithoutWipe();
    },
  };

  // Mutation caught: an adopt that keeps the photos, as at da5337b23.
  it.each(
    Object.keys(PREVIOUS_RELEASE_LEFT).flatMap((left) =>
      modes.map((mode) => [left, mode] as const),
    ),
  )(
    "photos the previous release left with no owner recorded, after %s: the next account's first pull (%s) clears them",
    async (left, mode) => {
      await aSignedInWithAPhoto();
      await PREVIOUS_RELEASE_LEFT[left]!();
      expect(owner()).toBeNull();
      expect(device.disk.has(PHOTO_A)).toBe(true);

      signIn(B);
      device.online = mode === 'online';
      await m.sync.syncNow();

      expect(device.disk.has(PHOTO_A), "A's photo on disk for B").toBe(false);
      expect(image.clearMemoryCache).toHaveBeenCalledTimes(1);
      expect(owner()).toBe(B);
    },
  );

  // Mutation caught: the account recorded before the photo clear finished.
  it('an adopt the app is closed during, before the photo disk clear finished: no owner is recorded yet, and the next launch clears the photos again', async () => {
    await aSignedInWithAPhoto();
    await PREVIOUS_RELEASE_LEFT['its sign-out']!();
    signIn(B);
    device.holdDiskClear = true;
    void m.sync.syncNow();
    await vi.waitFor(() => expect(image.clearDiskCache).toHaveBeenCalledTimes(1), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await relaunch(); // B's session is still stored
    expect(device.disk.has(PHOTO_A)).toBe(true);
    expect.soft(owner()).toBeNull();
    await m.sync.syncNow();

    expect(device.disk.has(PHOTO_A)).toBe(false);
    expect(owner()).toBe(B);
  });

  // Mutation caught: an adopt that clears the photos and records nobody. Every
  // tick whose pull fails would adopt again and clear the account's own photos.
  it("the adopting account's photos are cleared once, before its first pull: what it draws after is kept through pulls that keep failing, online and offline", async () => {
    await NO_OWNER['on a fresh install']!();
    signIn(B);
    device.snapshotFails = true;
    await m.sync.syncNow(); // the adopt, then no answer
    await viewPhoto(PHOTO_B);
    await m.sync.syncNow(); // the next tick: no answer again
    device.online = false;
    await m.sync.syncNow(); // and offline

    await expectKept(PHOTO_B);
    expect(image.clearDiskCache.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

/** A's record is lost while its cache stays: an older release's switch,
 *  repair or Clear erased the record while rows cached after them stayed, or
 *  any later path that loses it. */
const recordLost = () => raw.exec("delete from meta where key = 'cache_user_id'");

describe('a photo clear that fails still records the account, with the clear owed', SLOW, () => {
  // Mutation caught: the adopt recording nobody after a clear that failed (as
  // at 254fb9c72; the next account then adopted this one's rows, below), or
  // recording the account with no clear owed (as at 43256f0da: every later
  // pull kept, and the photos were never cleared).
  it.each(Object.keys(PHOTO_CLEAR_FAILS))(
    'at a pull that finds no owner recorded, when %s: the account is recorded with the clear owed, the pull lands, and the next pull clears again',
    async (failure) => {
      await aSignedInWithAPhoto();
      recordLost();
      sessionEndsWithoutWipe();
      signIn(B);
      PHOTO_CLEAR_FAILS[failure]!();
      await m.sync.syncNow(); // B's first pull: the clear fails, the pull lands

      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBe(B);
      expect(stillCached(PHOTO_A)).toBe(true);
      expect(items()).toEqual([`item-${B}-org-1`]); // the pull was not skipped

      await m.sync.syncNow(); // the next tick: the clear owed is tried again

      await expectForgotten(PHOTO_A);
      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBeNull();
    },
  );

  // Mutation caught: the reset forgetting the record after a clear that
  // failed (as at 254fb9c72), recording the new account with no clear owed
  // (as at 43256f0da), or keeping the previous account's record, which would
  // reset again at every tick and wipe what B cached since.
  it.each(Object.keys(PHOTO_CLEAR_FAILS))(
    'at the reset for another account, when %s: the new account is recorded with the clear owed, and its next pull clears again without wiping its rows',
    async (failure) => {
      await aSignedInWithAPhoto();
      sessionEndsWithoutWipe();
      signIn(B);
      PHOTO_CLEAR_FAILS[failure]!();
      await m.sync.syncNow(); // B's first pull: the reset; its clear fails; the pull lands

      expect(items()).toEqual([`item-${B}-org-1`]);
      expect(stillCached(PHOTO_A)).toBe(true);
      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBe(B);

      // B counts on the phone, then the next tick runs offline: a reset would
      // empty the cache at once, offline too.
      await countOnThePhone('cc-b');
      device.online = false;
      await m.sync.syncNow();

      await expectForgotten(PHOTO_A);
      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBeNull();
      expect(items()).toEqual([`item-${B}-org-1`]);
      expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });
    },
  );

  // The exits forget the record whatever the clear did, and the next account
  // adopts and clears again. Its own clear failing too records it with the
  // clear owed: 43256f0da recorded it with nothing owed, 254fb9c72 recorded
  // nobody.
  it.each(
    Object.keys(ACCOUNT_EXITS).flatMap((exit) =>
      Object.keys(PHOTO_CLEAR_FAILS).map((failure) => [exit, failure] as const),
    ),
  )(
    "%s whose photo clear fails (%s) still forgets the record: the next account's pulls clear again until a clear works",
    async (exit, failure) => {
      await aSignedInWithAPhoto();
      device.userId = null; // the session is gone before the wipe runs
      auth.user = null;
      PHOTO_CLEAR_FAILS[failure]!();
      await ACCOUNT_EXITS[exit]!();

      expect(owner()).toBeNull();
      expect(photoClearOwed()).toBeNull();
      expect(items()).toEqual([]);
      expect(stillCached(PHOTO_A)).toBe(true);

      signIn(B);
      PHOTO_CLEAR_FAILS[failure]!(); // B's first pull: the clear fails again
      await m.sync.syncNow();
      expect(stillCached(PHOTO_A)).toBe(true);
      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBe(B);

      await m.sync.syncNow(); // the next tick: the clear works

      await expectForgotten(PHOTO_A);
      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBeNull();
    },
  );

  // A sign-out or an eviction takes the whole record with it: the next
  // account finds no owner recorded, adopts, and clears the photos itself.
  it.each(Object.keys(ACCOUNT_EXITS))(
    '%s of an account that still owes a photo clear forgets the clear owed together with the record',
    async (exit) => {
      await aSignedInWithAPhoto();
      recordLost();
      sessionEndsWithoutWipe();
      signIn(B);
      PHOTO_CLEAR_FAILS['the disk clear answers false']!();
      await m.sync.syncNow();
      expect(photoClearOwed()).toBe(B);

      device.userId = null;
      auth.user = null;
      await ACCOUNT_EXITS[exit]!();

      expect(owner()).toBeNull();
      expect(photoClearOwed()).toBeNull();
      await expectForgotten(PHOTO_A);
    },
  );

  // Mutation caught: a workspace switch, the repair or Clear (deleteOrgData)
  // forgetting the clear owed. The account is the same, so its pulls keep,
  // and photos an earlier account left would never be cleared.
  it.each(Object.keys(SAME_ACCOUNT_WIPES))(
    "a clear still owed outlives %s: the account's next pull still clears the photos it is owed for",
    async (wipe) => {
      // A photo an earlier account left with no owner recorded (an older
      // release's wipes), then A's first pull, whose clear fails.
      device.storage.set('workspace.activeOrgId', 'org-1');
      device.memory.add(PHOTO_B);
      device.disk.add(PHOTO_B);
      signIn(A);
      PHOTO_CLEAR_FAILS['the disk clear answers false']!();
      await m.sync.syncNow();
      expect(owner()).toBe(A);
      expect(photoClearOwed()).toBe(A);
      expect(device.disk.has(PHOTO_B)).toBe(true);

      await SAME_ACCOUNT_WIPES[wipe]!(); // its own pull runs after it
      await m.sync.syncNow();

      expect(device.disk.has(PHOTO_B), "an earlier account's photo on disk").toBe(false);
      expect(owner()).toBe(A);
      expect(photoClearOwed()).toBeNull();
    },
  );
});

/** How B's first pull came to clear the photos: each one clears them, and
 *  each is run with that clear failing (PHOTO_CLEAR_FAILS). */
const B_FIRST_PULLS: Record<string, () => Promise<void>> = {
  'the reset for another account': async () => {
    await aSignedInWithAPhoto();
    sessionEndsWithoutWipe();
  },
  'a pull that finds the record lost': async () => {
    await aSignedInWithAPhoto();
    recordLost();
    sessionEndsWithoutWipe();
  },
  'a pull that finds no record after a finished sign-out': async () => {
    await aSignedInWithAPhoto();
    device.userId = null;
    auth.user = null;
    await m.photoWipe.wipeWithPhotoCaches(m.db.wipeForSignOut);
  },
};

/** B's answer carries an open purchase order too, so the readers have one of
 *  B's to find. */
const B_PO = {
  id: 'po-b',
  poNumber: 'PO-B',
  status: 'ordered',
  expectedAt: null,
  warehouseId: 'wh-org-1',
  lines: [{ id: 'po-b-l1', itemId: `item-${B}-org-1`, qtyOrdered: 3, qtyReceived: 0, unitCost: 2 }],
};
const B_SCOPE = '{"hasAllAccess":false,"warehouseNames":["B only"]}';

describe('an account whose photo clear failed still owns its rows', SLOW, () => {
  const cases = Object.keys(B_FIRST_PULLS).flatMap((start) =>
    Object.keys(PHOTO_CLEAR_FAILS).map((failure) => [start, failure] as const),
  );

  // Mutation caught: a failed clear leaving the record absent (as at
  // 254fb9c72). C's pull then adopted: it only marked B's rows, recorded C
  // and stopped at the network check, so C read B's item (on hand and unit
  // cost), B's purchase order and B's count offline until a full pull landed.
  it.each(cases)(
    "%s whose clear fails (%s), then B's pull lands and B's session ends without a wipe: the next account's first pull, offline, leaves none of B's rows to read",
    async (start, failure) => {
      await B_FIRST_PULLS[start]!();
      device.answer = (snap, userId) => (userId === B ? { ...snap, openPOs: [B_PO] } : snap);
      signIn(B);
      PHOTO_CLEAR_FAILS[failure]!();
      await m.sync.syncNow(); // B's first pull: the clear fails, the pull lands
      expect(items()).toEqual([`item-${B}-org-1`]);
      expect((await m.reads.listOpenPos()).map((p) => p.id)).toEqual(['po-b']);
      await countOnThePhone('cc-b');
      await viewPhoto(PHOTO_B);

      sessionEndsWithoutWipe();
      signIn(C);
      device.online = false;
      await m.sync.syncNow(); // C's first pull, offline

      // What C's offline screens read (db-reads.ts, cycle-count-cache.ts).
      expect(await m.reads.findItemByCode(`sku-${B}`)).toBeNull();
      expect(await m.reads.getItemById(`item-${B}-org-1`)).toBeNull();
      expect(await m.reads.listOpenPos()).toEqual([]);
      expect(await m.reads.getPoLines('po-b')).toEqual([]);
      expect(await m.counts.getCycleCount('cc-b')).toBeNull();
      expect(await m.counts.listCachedCycleCounts()).toEqual([]);
      expect(items()).toEqual([]);
      await expectForgotten(PHOTO_A);
      await expectForgotten(PHOTO_B);
      expect(owner()).toBe(C);
      expect(photoClearOwed()).toBeNull();
      // B's unsent count is not lost: held for B in the outbox.
      expect(queuedCounts()).toEqual([{ user_id: B, status: 'pending', count_id: 'cc-b' }]);
    },
  );

  // Mutation caught: a pull that owes a clear adopting again (as at
  // 254fb9c72: every tick while the clear kept failing marked the account's
  // own rows, forgot its cursor, modules, permissions and warehouse scope, and
  // pulled in full), or one that never tries the clear again.
  it.each(cases)(
    "%s whose clear fails (%s), then keeps failing: each of B's next pulls tries the photo clear again, and only that, until one works",
    async (start, failure) => {
      await B_FIRST_PULLS[start]!();
      signIn(B);
      PHOTO_CLEAR_FAILS[failure]!();
      await m.sync.syncNow(); // B's first pull: the clear fails, the pull lands
      await countOnThePhone('cc-b');
      // B's own persisted values (B's answers here carry no scope).
      raw.exec(`insert or replace into meta (key, value) values ('warehouse_scope', '${B_SCOPE}')`);
      const countStamp = () =>
        (
          raw.prepare("select last_synced_at as s from cycle_counts where id = 'cc-b'").get() as {
            s: number;
          }
        ).s;
      const stamped = countStamp();
      const disk = () => image.clearDiskCache.mock.calls.length;
      const before = disk();

      PHOTO_CLEAR_FAILS[failure]!();
      await m.sync.syncNow(); // the next tick: the clear is tried again and fails again

      expect(disk()).toBe(before + 1);
      expect(owner()).toBe(B);
      expect(photoClearOwed()).toBe(B);
      // Nothing else: a delta from B's own cursor, B's count and scope kept,
      // nothing marked unconfirmed.
      expect(device.requests.at(-1)).toContain('?since=');
      expect(countStamp()).toBe(stamped);
      expect(metaValue('warehouse_scope')).toBe(B_SCOPE);
      expect(metaValue('effective_permissions')).toBe('[]');
      expect(metaValue('enabled_modules')).toBe('[]');
      expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });

      device.online = false;
      const cursor = metaValue('last_synced_at');
      await m.sync.syncNow(); // offline: the clear is tried again, and works

      await expectForgotten(PHOTO_A);
      expect(photoClearOwed()).toBeNull();
      expect(owner()).toBe(B);
      expect(metaValue('last_synced_at')).toBe(cursor);
      expect(metaValue('warehouse_scope')).toBe(B_SCOPE);
      expect(countStamp()).toBe(stamped);
      expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });

      device.online = true;
      const settled = disk();
      await m.sync.syncNow(); // nothing owed now: no clear, and still a delta
      expect(disk()).toBe(settled);
      expect(device.requests.at(-1)).toContain('?since=');
    },
  );

  // Mutation caught: the clear owed forgotten before the retry's clear has
  // answered. An app closed during that clear then never cleared again.
  it('a retry the app is closed during, before the photo disk clear finished: the clear is still owed, and the next launch tries again', async () => {
    await B_FIRST_PULLS['a pull that finds the record lost']!();
    signIn(B);
    PHOTO_CLEAR_FAILS['the disk clear answers false']!();
    await m.sync.syncNow(); // B's first pull: the clear fails
    expect(photoClearOwed()).toBe(B);

    device.holdDiskClear = true;
    void m.sync.syncNow(); // the retry, closed during its disk clear
    await vi.waitFor(() => expect(image.clearDiskCache).toHaveBeenCalledTimes(2), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await relaunch(); // B's session is still stored
    expect(device.disk.has(PHOTO_A)).toBe(true);
    expect.soft(photoClearOwed()).toBe(B);
    await m.sync.syncNow();

    expect(device.disk.has(PHOTO_A)).toBe(false);
    expect(photoClearOwed()).toBeNull();
    expect(owner()).toBe(B);
  });
});

const A_CURSOR = '2026-10-20T00:00:00.000Z';
const A_SCOPE = '{"hasAllAccess":false,"warehouseNames":["A only"]}';

/** A's cache with no owner recorded (recordLost): its item and the count it
 *  counted (an unsent entry in the outbox), a PO and a kit its pulls cached,
 *  the delta cursor on its timeline and its persisted scope, permissions and
 *  modules. Then its session ends without a wipe. With 'clear', A empties the
 *  box it counted, so its unsent entry is a clear of the line (RL1, B4a). */
async function aLeavesItsCacheWithNoOwner(lastEdit: 'count' | 'clear' = 'count'): Promise<void> {
  await aSignedInWithAPhoto();
  await countOnThePhone('cc-a');
  if (lastEdit === 'clear') await emptyTheBox('cc-a-l1');
  raw.exec(`
    insert into purchase_orders (id, po_number, status, warehouse_id, expected_at, last_synced_at)
      values ('po-a', 'PO-A', 'ordered', 'wh-a', null, 1);
    insert into po_lines (id, po_id, item_id, qty_ordered, qty_received, unit_cost)
      values ('po-a-l1', 'po-a', 'item-a-only', 3, 0, 0);
    insert into bundles (id, name, sku, preassembly_enabled, phantom_item_id, phantom_qty, phantom_warehouse_id, last_synced_at)
      values ('b-a', 'A kit', null, 0, null, 0, null, 1);
    insert into bundle_components (bundle_id, item_id, quantity, is_optional)
      values ('b-a', 'item-a-only', 1, 0);
    insert or replace into meta (key, value) values ('last_synced_at', '${A_CURSOR}');
    insert or replace into meta (key, value) values ('warehouse_scope', '${A_SCOPE}');
    insert or replace into meta (key, value) values ('effective_permissions', '["a:only"]');
    insert or replace into meta (key, value) values ('enabled_modules', '["a-only"]');
  `);
  recordLost();
  sessionEndsWithoutWipe();
}

/** An open count as the snapshot lists it, in A's and B's warehouse. */
const openCount = (id: string, lines: CountAnswer['lines'] = []): CountAnswer => ({
  id,
  status: 'in_progress',
  warehouseId: 'wh-org-1',
  startedAt: '2026-10-24T08:00:00.000Z',
  assignedTo: null,
  notes: null,
  lines,
});

/** What B's answer changes, for this test only. */
const bSees = (change: Partial<SnapshotAnswer>) => {
  device.answer = (snap, userId) => (userId === B ? { ...snap, ...change } : snap);
};

describe('a pull that finds no owner recorded trusts none of the rows it finds', SLOW, () => {
  // Mutations caught: the adopt keeping the cursor (a delta pull from A's
  // timeline sweeps nothing), keeping the persisted values, the PO sweep, and
  // a count kept for an unsent entry that is not this account's.
  it("another account's rows, cursor and scope: after the next account's first pull none of them is left, and the count it counted before that pull stays", async () => {
    await aLeavesItsCacheWithNoOwner();
    signIn(B);
    await countOnThePhone('cc-b'); // before B's first pull
    await m.sync.syncNow(); // B's first pull

    expect(device.requests.at(-1)).toBe('/api/v1/mobile/snapshot'); // in full, not from A's cursor
    expect(items()).toEqual([`item-${B}-org-1`]);
    expect(ids('select id from purchase_orders')).toEqual([]);
    expect(ids('select id from po_lines')).toEqual([]);
    expect(ids('select id from bundles')).toEqual([]);
    expect(raw.prepare('select count(*) as n from bundle_components').get()).toEqual({ n: 0 });
    // A's count, which B cannot see, is gone with its line; B's own stays,
    // with the count it has not sent yet.
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-b']);
    expect(ids("select id from cycle_count_lines where count_id = 'cc-a'")).toEqual([]);
    expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });
    expect((await m.counts.getCycleCount('cc-b'))?.lines).toEqual([
      expect.objectContaining({ id: 'cc-b-l1', counted: 5, localDirty: true }),
    ]);
    // The outbox is untouched: A's entry is held for A, B's is B's to send.
    expect(queuedCounts()).toEqual([
      { user_id: A, status: 'pending', count_id: 'cc-a' },
      { user_id: B, status: 'pending', count_id: 'cc-b' },
    ]);
    // The cursor and the persisted values are B's answer's, never A's.
    expect(metaValue('last_synced_at')).toBe('2026-10-24T12:00:00.000Z');
    expect(metaValue('warehouse_scope')).toBeNull();
    expect(metaValue('effective_permissions')).toBe('[]');
    expect(metaValue('enabled_modules')).toBe('[]');
    expect(owner()).toBe(B);
  });

  // Mutations caught: the adopt keeping the cursor or the persisted values.
  // Offline nothing is pulled, so they must go at the adopt itself, and the
  // next pull is in full although the cache is recorded as B's by then.
  it("offline, the adopt forgets the other account's cursor, scope, permissions and modules at once, and the next pull is in full", async () => {
    await aLeavesItsCacheWithNoOwner();
    signIn(B);
    await countOnThePhone('cc-b');
    device.online = false;
    await m.sync.syncNow(); // B's first pull, offline

    expect(metaValue('last_synced_at')).toBeNull();
    expect(metaValue('warehouse_scope')).toBeNull();
    expect(metaValue('effective_permissions')).toBeNull();
    expect(metaValue('enabled_modules')).toBeNull();
    expect(owner()).toBe(B);

    device.online = true;
    await m.sync.syncNow(); // the next tick

    expect(device.requests.at(-1)).toBe('/api/v1/mobile/snapshot');
    expect(items()).toEqual([`item-${B}-org-1`]);
    expect(ids('select id from purchase_orders')).toEqual([]);
    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-b']);
    expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });
  });

  // Mutation caught: the adopted counts swept only by the every-pull rule,
  // which stops at the snapshot's 50-count page.
  it("B's answer is a full page of 50 counts: A's count still goes, and B's own stays", async () => {
    await aLeavesItsCacheWithNoOwner();
    bSees({ openCycleCounts: Array.from({ length: 50 }, (_, i) => openCount(`cc-open-${i}`)) });
    signIn(B);
    await countOnThePhone('cc-b');
    await m.sync.syncNow();

    expect(ids("select id from cycle_counts where id in ('cc-a', 'cc-b') order by id")).toEqual([
      'cc-b',
    ]);
    expect(ids("select id from cycle_count_lines where count_id = 'cc-a'")).toEqual([]);
    expect(ids('select id from cycle_counts')).toHaveLength(51);
    expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });
  });

  // Mutations caught: the adopt leaving the items, or the kits, unmarked.
  // The full pull's own sweeps drop only rows stamped before the pull's own
  // time, and a phone whose clock ran ahead stamped A's rows after it.
  it("A's rows were stamped while the phone's clock ran ahead: B's first pull still drops them", async () => {
    await aLeavesItsCacheWithNoOwner();
    const ahead = Date.now() + 365 * 24 * 60 * 60 * 1000;
    raw.prepare('update items set last_synced_at = ?').run(ahead);
    raw.prepare('update bundles set last_synced_at = ?').run(ahead);
    signIn(B);
    await m.sync.syncNow();

    expect(items()).toEqual([`item-${B}-org-1`]);
    expect(ids('select id from bundles')).toEqual([]);
    expect(raw.prepare('select count(*) as n from bundle_components').get()).toEqual({ n: 0 });
  });

  // Mutation caught: the adopted kits swept only by the full pull's own
  // sweeps, which keep every kit the org's active list names and, without
  // the list, stop at a page of 1000 kits.
  it.each([
    ['naming it in the active list', true],
    ['with no active list', false],
  ] as const)(
    "B's answer is a full page of 1000 kits, %s: A's kit past the page goes, B's page stays",
    async (_case, withActiveList) => {
      await aLeavesItsCacheWithNoOwner();
      const page = Array.from({ length: 1000 }, (_, i) => ({
        id: `b-page-${String(i).padStart(4, '0')}`,
        name: 'Kit',
        sku: null,
        preassemblyEnabled: false,
        phantomItemId: null,
        phantomQty: 0,
        phantomWarehouseId: null,
        components: [{ itemId: `item-${B}-org-1`, quantity: 1, isOptional: false }],
      }));
      bSees({
        bundles: page,
        ...(withActiveList ? { activeBundleIds: [...page.map((k) => k.id), 'b-a'] } : {}),
      });
      signIn(B);
      await m.sync.syncNow();

      expect(ids("select id from bundles where id = 'b-a'")).toEqual([]);
      expect(
        raw.prepare("select count(*) as n from bundle_components where bundle_id = 'b-a'").get(),
      ).toEqual({ n: 0 });
      expect(raw.prepare('select count(*) as n from bundles').get()).toEqual({ n: 1000 });
      expect(raw.prepare('select count(*) as n from bundle_components').get()).toEqual({ n: 1000 });
    },
  );

  // Mutation caught: an adopted line's local edit kept when no entry of this
  // account's backs it. A's unsent count of 5 would show to B as B's own.
  it("a count B can see: A's unsent count on it gives way to the server's, and A's entry stays held for A", async () => {
    await aLeavesItsCacheWithNoOwner();
    bSees({
      openCycleCounts: [
        openCount('cc-a', [{ id: 'cc-a-l1', itemId: 'item-x', expected: 4, counted: 2 }]),
      ],
    });
    signIn(B);
    await countOnThePhone('cc-b');
    await m.sync.syncNow();

    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-a', 'cc-b']);
    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });
    expect(queuedCounts()).toEqual([
      { user_id: A, status: 'pending', count_id: 'cc-a' },
      { user_id: B, status: 'pending', count_id: 'cc-b' },
    ]);
  });

  // Mutation caught: the count screen's write confirming an adopted count
  // with the edit on it that no entry of B's backs still kept. Its header
  // write stamps the count with its own time, so the pull's release, which
  // reads the marks, never sees it again.
  it("B opens A's count on the count screen before any pull of B's lands: it shows the server's count, not A's unsent one", async () => {
    await aLeavesItsCacheWithNoOwner();
    signIn(B);
    await countOnThePhone('cc-b');
    device.snapshotFails = true;
    await m.sync.syncNow(); // B's first pull: the cache is adopted and marked, nothing lands
    expect(owner()).toBe(B);

    const fetchedUnder = await m.counts.cacheWriteScope();
    const header = (id: string) => ({
      id,
      organizationId: 'org-1',
      warehouseId: 'wh-org-1',
      warehouseName: 'Main',
      status: 'in_progress',
      startedAt: '2026-10-24T08:00:00.000Z',
    });
    const serverLine = (id: string, counted: number | null) => ({
      id,
      itemId: 'item-x',
      itemName: 'X',
      itemSku: 'SKU-X',
      itemBarcode: null,
      expected: 4,
      counted,
      updatedAt: null,
    });
    expect(
      await m.counts.cacheCycleCount(header('cc-a'), [serverLine('cc-a-l1', 2)], fetchedUnder),
    ).toBe(true);
    expect(
      await m.counts.cacheCycleCount(header('cc-b'), [serverLine('cc-b-l1', null)], fetchedUnder),
    ).toBe(true);

    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect((await m.counts.getCycleCount('cc-a'))?.lines).toEqual([
      expect.objectContaining({ id: 'cc-a-l1', counted: 2, localDirty: false }),
    ]);
    // B's own count keeps the count B has not sent yet.
    expect(line('cc-b-l1')).toEqual({ counted: 5, local_dirty: 1 });
    expect(queuedCounts()).toEqual([
      { user_id: A, status: 'pending', count_id: 'cc-a' },
      { user_id: B, status: 'pending', count_id: 'cc-b' },
    ]);
  });

  /** A second, clean line on A's count, which B then counts (B's own unsent
   *  entry on A's count). */
  const bCountsTheOtherLineOfAsCount = async () => {
    raw.exec(`insert into cycle_count_lines
        (id, count_id, item_id, item_name, item_sku, expected, counted, local_dirty)
      values ('cc-a-l2', 'cc-a', 'item-y', 'Y', 'SKU-Y', 3, null, 0)`);
    expect(await m.counts.updateLocalLine('cc-a-l2', 7)).not.toBeNull();
  };
  const bothEntriesHeld = () =>
    expect(queuedCounts()).toEqual([
      { user_id: A, status: 'pending', count_id: 'cc-a' },
      { user_id: B, status: 'pending', count_id: 'cc-a' },
    ]);

  // Mutation caught: the release leaving the released line's value, so A's
  // unsent 5 showed offline as the count recorded on the server (REVIEW-P2 of
  // 254fb9c72). The count stays for B's own entry, but B's pull does not
  // return it, so no server value replaces the line.
  it.each([
    ['lists no count', () => bSees({ openCycleCounts: [] })],
    [
      'is a full page of 50 other counts',
      () =>
        bSees({ openCycleCounts: Array.from({ length: 50 }, (_, i) => openCount(`cc-open-${i}`)) }),
    ],
  ] as const)(
    "B keeps A's count for its own unsent entry, and B's answer %s: A's released line shows no count, not A's unsent one",
    async (_case, answer) => {
      await aLeavesItsCacheWithNoOwner();
      answer();
      signIn(B);
      await bCountsTheOtherLineOfAsCount();
      await m.sync.syncNow(); // B's first pull: the adopt, in full, without cc-a

      expect(ids("select id from cycle_counts where id = 'cc-a'")).toEqual(['cc-a']);
      expect(line('cc-a-l1')).toEqual({ counted: null, local_dirty: 0 });
      expect(line('cc-a-l2')).toEqual({ counted: 7, local_dirty: 1 });
      const shown = (await m.counts.getCycleCount('cc-a'))?.lines
        .map((l) => [l.id, l.counted, l.localDirty])
        .sort();
      expect(shown).toEqual([
        ['cc-a-l1', null, false],
        ['cc-a-l2', 7, true],
      ]);
      bothEntriesHeld();
    },
  );

  // Mutation caught: the release matched to an entry by its count rather than
  // by its line (REVIEW-P3 of 254fb9c72): A's unsent edit would then stay as
  // B's own on any count B also counted. Every other case puts each account's
  // edits on counts of their own.
  it("a count both accounts counted, at B's pull: A's line gives way to the server's count, and B's own unsent count stays", async () => {
    await aLeavesItsCacheWithNoOwner();
    bSees({
      openCycleCounts: [
        openCount('cc-a', [
          { id: 'cc-a-l1', itemId: 'item-x', expected: 4, counted: 2 },
          { id: 'cc-a-l2', itemId: 'item-y', expected: 3, counted: null },
        ]),
      ],
    });
    signIn(B);
    await bCountsTheOtherLineOfAsCount();
    await m.sync.syncNow();

    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect(line('cc-a-l2')).toEqual({ counted: 7, local_dirty: 1 });
    bothEntriesHeld();
  });

  // The same, at the count screen's own release (one count, before its write).
  it("a count both accounts counted, opened on the count screen before any pull of B's lands: A's line shows the server's count, and B's own unsent count stays", async () => {
    await aLeavesItsCacheWithNoOwner();
    signIn(B);
    await bCountsTheOtherLineOfAsCount();
    device.snapshotFails = true;
    await m.sync.syncNow(); // B's first pull: the cache is adopted and marked, nothing lands

    const fetchedUnder = await m.counts.cacheWriteScope();
    const fetchedLine = (id: string, itemId: string, counted: number | null) => ({
      id,
      itemId,
      itemName: itemId,
      itemSku: itemId,
      itemBarcode: null,
      expected: 4,
      counted,
      updatedAt: null,
    });
    expect(
      await m.counts.cacheCycleCount(
        {
          id: 'cc-a',
          organizationId: 'org-1',
          warehouseId: 'wh-org-1',
          warehouseName: 'Main',
          status: 'in_progress',
          startedAt: '2026-10-24T08:00:00.000Z',
        },
        [fetchedLine('cc-a-l1', 'item-x', 2), fetchedLine('cc-a-l2', 'item-y', null)],
        fetchedUnder,
      ),
    ).toBe(true);

    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect(line('cc-a-l2')).toEqual({ counted: 7, local_dirty: 1 });
    bothEntriesHeld();
  });

  // Mutation caught: the full pull keeping the warehouse list when the
  // answer's is empty.
  it("B can read no warehouse: A's warehouses are not left on the phone", async () => {
    await aLeavesItsCacheWithNoOwner();
    expect(ids('select id from warehouses')).toEqual(['wh-org-1']);
    bSees({ warehouses: [], items: [], openCycleCounts: [] });
    signIn(B);
    await m.sync.syncNow();

    expect(ids('select id from warehouses')).toEqual([]);
    expect(items()).toEqual([]);
    expect(ids('select id from cycle_counts')).toEqual([]);
  });
});

describe(
  'a count the screen fetched is stored only for the cache and the account it was fetched for',
  SLOW,
  () => {
    /** The count screen's fetch, answered, stored under the note it took before
     *  sending it (app/cycle-count/[id].tsx). */
    const storeFetchedCount = (
      fetchedUnder: Awaited<ReturnType<typeof m.counts.cacheWriteScope>>,
      countId = 'cc-a',
    ) =>
      m.counts.cacheCycleCount(
        {
          id: countId,
          organizationId: 'org-1',
          warehouseId: 'wh-org-1',
          warehouseName: 'Main',
          status: 'in_progress',
          startedAt: '2026-10-24T08:00:00.000Z',
        },
        [
          {
            id: `${countId}-l1`,
            itemId: 'item-x',
            itemName: 'X',
            itemSku: 'SKU-X',
            itemBarcode: null,
            expected: 4,
            counted: null,
            updatedAt: null,
          },
        ],
        fetchedUnder,
      );
    const cachedCounts = () => ids('select id from cycle_counts order by id');

    // Mutation caught: no check at all (the cache generation and the account
    // both moved here).
    it("a fetch that lands after a sign-out's wipe is discarded: no count is left with no owner", async () => {
      await aSignedInWithAPhoto();
      const fetchedUnder = await m.counts.cacheWriteScope(); // the screen, before its fetch
      device.userId = null;
      auth.user = null;
      await m.photoWipe.wipeWithPhotoCaches(m.db.wipeForSignOut); // while the fetch is out

      expect(await storeFetchedCount(fetchedUnder)).toBe(false);
      expect(cachedCounts()).toEqual([]);
      expect(owner()).toBeNull();
    });

    // Mutation caught: no account check. Nothing is wiped when a session ends
    // this way, so the cache generation has not moved.
    it('a fetch that lands after the session ended without a wipe and another account signed in is discarded', async () => {
      await aSignedInWithAPhoto();
      const fetchedUnder = await m.counts.cacheWriteScope();
      sessionEndsWithoutWipe();
      signIn(B);

      expect(await storeFetchedCount(fetchedUnder)).toBe(false);
      expect(cachedCounts()).toEqual([]);
    });

    // Discarded by the cache-generation check and the workspace check alike.
    it('a fetch that lands after a workspace switch is discarded: it belongs to the workspace left', async () => {
      await aSignedInWithAPhoto();
      const fetchedUnder = await m.counts.cacheWriteScope();
      await m.ws.setActiveOrg('org-2'); // its wipe, while the fetch is out

      expect(await storeFetchedCount(fetchedUnder)).toBe(false);
      expect(cachedCounts()).toEqual([]);
      await backgroundPullsSettle();
    });

    // Mutation caught: no cache-generation check. The account and the
    // workspace are the same; only the wipe moved.
    it('a fetch that lands after Settings > Offline cache > Clear is discarded: the cache it was fetched for is gone', async () => {
      await aSignedInWithAPhoto();
      const fetchedUnder = await m.counts.cacheWriteScope();
      expect(await clearOfflineCache()).toEqual({ ok: true }); // while the fetch is out

      expect(await storeFetchedCount(fetchedUnder)).toBe(false);
      expect(cachedCounts()).toEqual([]);
    });

    // Mutation caught: no workspace check. A switch saves the new workspace and
    // wipes before the screen is shown it, so a note the screen takes in that
    // window, for the workspace it still shows, carries the moved generation.
    it('a fetch noted after a workspace switch had wiped, for the workspace still on screen, is discarded', async () => {
      await aSignedInWithAPhoto();
      await m.ws.setActiveOrg('org-2'); // saved and wiped
      const fetchedUnder = await m.counts.cacheWriteScope(); // the screen, still on org-1

      expect(await storeFetchedCount(fetchedUnder)).toBe(false);
      expect(cachedCounts()).toEqual([]);
      await backgroundPullsSettle();
    });

    it('the same account, with nothing wiped while the fetch was out: stored', async () => {
      await aSignedInWithAPhoto();
      const fetchedUnder = await m.counts.cacheWriteScope();

      expect(await storeFetchedCount(fetchedUnder)).toBe(true);
      expect(cachedCounts()).toEqual(['cc-a']);
    });

    // Mutation caught: no check of whose cache it is (B18 final review of
    // d973727f6). The cache is still recorded as A's, with A's rows, while
    // B's reset has not run: here its SQLite wipe failed (the next pull
    // resets again), and the same holds while B's first sync waits for a
    // pull of A's still out (below). A count stored then was A's to keep if
    // A signed in here again first, since A's own pull keeps A's cache: B's
    // unsent number showed as A's own pending edit.
    it("a fetch that lands while the cache is still recorded as another account's is discarded: that account, signing in again first, never finds it", async () => {
      await aSignedInWithAPhoto();
      sessionEndsWithoutWipe();
      signIn(B);
      device.failWipe = true;
      await m.sync.syncNow(); // B's reset: the SQLite wipe throws, A stays recorded
      expect.soft(owner()).toBe(A);

      const fetchedUnder = await m.counts.cacheWriteScope(); // B's count screen
      expect.soft(await storeFetchedCount(fetchedUnder, 'cc-b')).toBe(false);
      await m.counts.updateLocalLine('cc-b-l1', 5); // B counts what the screen shows
      // B's session is revoked elsewhere (no wipe), and A signs in again.
      sessionEndsWithoutWipe();
      signIn(A);
      await m.sync.syncNow();

      expect(owner()).toBe(A);
      expect(await m.counts.getCycleCount('cc-b')).toBeNull();
      expect(cachedCounts()).toEqual([]);
      expect(queuedCounts()).toEqual([]);
    });

    // The same rule while B's first sync waits for A's pull, which is still
    // out: B's reset runs only once that pull has settled.
    it("a fetch that lands while B's first sync still waits for A's pull is discarded, and B's reset then clears A's rows", async () => {
      await aSignedInWithAPhoto();
      const { held, aSync } = await aPullIsOut();
      sessionEndsWithoutWipe();
      signIn(B);
      const bFirst = m.sync.syncNow();

      const fetchedUnder = await m.counts.cacheWriteScope();
      expect(await storeFetchedCount(fetchedUnder, 'cc-b')).toBe(false);
      expect(cachedCounts()).toEqual([]);
      held.release();
      await Promise.all([aSync, bFirst]);

      expect(owner()).toBe(B);
      expect(items()).toEqual([`item-${B}-org-1`]);
      // The screen's second pass (app/cycle-count/[id].tsx) stores it now.
      expect(await storeFetchedCount(await m.counts.cacheWriteScope(), 'cc-b')).toBe(true);
      expect(cachedCounts()).toEqual(['cc-b']);
    });

    // The other half of the rule: with NO owner recorded, the write is
    // stored, and the adopting pull's own rules decide what of it stays (a
    // pull that finds no owner recorded trusts none of the rows, above).
    // Mutation caught: a missing record read as another account's.
    it('a fetch that lands while no owner is recorded is stored', async () => {
      await aSignedInWithAPhoto();
      recordLost();
      const fetchedUnder = await m.counts.cacheWriteScope();

      expect(await storeFetchedCount(fetchedUnder)).toBe(true);
      expect(cachedCounts()).toEqual(['cc-a']);
    });
  },
);

/*
 * A QUEUED CLEAR (the merge with RL1, main at 0132fbd25). An emptied count box
 * now clears the line's saved count (B4a): the line is uncounted and dirty,
 * and a record_count row that names no count is queued (cycle-count-clear.ts)
 * and sent to the line's clear route. Every rule above for an unsent count
 * holds for it, through the same statements (they read the dirty flag, the
 * entry's line and count, and its owner, never the number): another account's
 * clear is held for that account and never sent under the next one, gives
 * way at the next account's pull like its unsent count, and never shows as
 * the next account's own cleared line; the next account's own clear keeps
 * its count. And a clear, like a typed count, is not refused for the cache's
 * owner (the "Not in this pull request" window).
 */
describe('a queued clear follows the rules of a queued count', SLOW, () => {
  // Mutation caught: the count kept only for an entry that names a count
  // (B's clear is then no reason to keep B's count, and the clear on screen
  // goes with it).
  it("another account's clear on a count the next account cannot see goes with the count, and the next account's own clear keeps its count, shown as its unsynced clear", async () => {
    await aLeavesItsCacheWithNoOwner('clear');
    // A's count of the line was replaced by A's clear of it.
    expect(queuedEdits()).toEqual([
      { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
    ]);
    signIn(B);
    await countOnThePhone('cc-b');
    await emptyTheBox('cc-b-l1'); // before B's first pull
    await m.sync.syncNow(); // B's first pull: the adopt, in full

    expect(ids('select id from cycle_counts order by id')).toEqual(['cc-b']);
    expect(ids("select id from cycle_count_lines where count_id = 'cc-a'")).toEqual([]);
    expect(line('cc-b-l1')).toEqual({ counted: null, local_dirty: 1 });
    expect((await m.counts.getCycleCount('cc-b'))?.lines).toEqual([
      expect.objectContaining({ id: 'cc-b-l1', counted: null, localDirty: true }),
    ]);
    // Post waits for B's clear (Sync first), and only for B's.
    expect(await m.counts.pendingCountFor('cc-b')).toBe(1);
    expect(queuedEdits()).toEqual([
      { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
      { user_id: B, status: 'pending', line_id: 'cc-b-l1', edit: 'clear' },
    ]);
  });

  // Mutation caught: the keep rule keeping a count for a clear whoever queued
  // it. The case above cannot tell: its answer lists fewer than 50 counts, so
  // the every-pull sweep takes A's count once the release has cleaned its
  // line, whatever the keep rule says. A full page turns that sweep off, and
  // the keep rule alone decides (sync.ts "Unconfirmed rows").
  it("B's answer is a full page of 50 counts: the count another account's clear is on still goes, and the next account's own clear keeps its count", async () => {
    await aLeavesItsCacheWithNoOwner('clear');
    bSees({ openCycleCounts: Array.from({ length: 50 }, (_, i) => openCount(`cc-open-${i}`)) });
    signIn(B);
    await countOnThePhone('cc-b');
    await emptyTheBox('cc-b-l1'); // before B's first pull
    await m.sync.syncNow(); // B's first pull: the adopt, in full

    expect(ids("select id from cycle_counts where id in ('cc-a', 'cc-b') order by id")).toEqual([
      'cc-b',
    ]);
    expect(ids("select id from cycle_count_lines where count_id = 'cc-a'")).toEqual([]);
    expect(ids('select id from cycle_counts')).toHaveLength(51);
    expect(line('cc-b-l1')).toEqual({ counted: null, local_dirty: 1 });
    expect(await m.counts.pendingCountFor('cc-b')).toBe(1);
    expect(queuedEdits()).toEqual([
      { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
      { user_id: B, status: 'pending', line_id: 'cc-b-l1', edit: 'clear' },
    ]);
  });

  // Mutations caught: the release taking only a dirty line that holds a count
  // (A's clear then stays as B's own cleared line, which the pull's write
  // keeps), and Sync first counting another account's clear.
  it("a count the next account can see: the other account's clear on it gives way to the server's count, and stays held for that account", async () => {
    await aLeavesItsCacheWithNoOwner('clear');
    bSees({
      openCycleCounts: [
        openCount('cc-a', [{ id: 'cc-a-l1', itemId: 'item-x', expected: 4, counted: 2 }]),
      ],
    });
    signIn(B);
    await m.sync.syncNow();

    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect((await m.counts.getCycleCount('cc-a'))?.lines).toEqual([
      expect.objectContaining({ id: 'cc-a-l1', counted: 2, localDirty: false }),
    ]);
    expect(await m.counts.pendingCountFor('cc-a')).toBe(0);
    expect(queuedEdits()).toEqual([
      { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
    ]);
  });

  // Mutation caught: the same release, at the count screen's own write.
  it("the count screen stores the other account's count before any pull of the next account's lands: it shows the server's count, not that account's clear", async () => {
    await aLeavesItsCacheWithNoOwner('clear');
    signIn(B);
    device.snapshotFails = true;
    await m.sync.syncNow(); // B's first pull: the cache is adopted and marked, nothing lands
    expect(owner()).toBe(B);

    expect(
      await m.counts.cacheCycleCount(
        countHeader('cc-a'),
        [fetchedLine('cc-a-l1', 2)],
        await m.counts.cacheWriteScope(),
      ),
    ).toBe(true);

    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect(queuedEdits()).toEqual([
      { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
    ]);
  });

  // The same, on a count both accounts emptied a box of. Mutation caught: the
  // count screen's release taking a line the next account's own clear backs.
  // B's clear would then show as the server's count while it stays queued,
  // and Sync first and the drain would still count it and send it.
  it("a count both accounts emptied a box of, opened on the count screen before any pull of the next account's lands: the other account's clear gives way to the server's count, and the next account's own clear stays", async () => {
    await aLeavesItsCacheWithNoOwner('clear');
    signIn(B);
    // A second line of A's count, with the server's count of 3 on it, whose
    // box B empties.
    raw.exec(`insert into cycle_count_lines
        (id, count_id, item_id, item_name, item_sku, expected, counted, local_dirty)
      values ('cc-a-l2', 'cc-a', 'item-y', 'Y', 'SKU-Y', 3, 3, 0)`);
    await emptyTheBox('cc-a-l2');
    device.snapshotFails = true;
    await m.sync.syncNow(); // B's first pull: the cache is adopted and marked, nothing lands
    expect(owner()).toBe(B);

    expect(
      await m.counts.cacheCycleCount(
        countHeader('cc-a'),
        [fetchedLine('cc-a-l1', 2), { ...fetchedLine('cc-a-l2', 3), itemId: 'item-y' }],
        await m.counts.cacheWriteScope(),
      ),
    ).toBe(true);

    expect(line('cc-a-l1')).toEqual({ counted: 2, local_dirty: 0 });
    expect(line('cc-a-l2')).toEqual({ counted: null, local_dirty: 1 });
    const shown = (await m.counts.getCycleCount('cc-a'))?.lines
      .map((l) => [l.id, l.counted, l.localDirty])
      .sort();
    expect(shown).toEqual([
      ['cc-a-l1', 2, false],
      ['cc-a-l2', null, true],
    ]);
    // Post waits for B's clear (Sync first), and only for B's.
    expect(await m.counts.pendingCountFor('cc-a')).toBe(1);
    expect(queuedEdits()).toEqual([
      { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
      { user_id: B, status: 'pending', line_id: 'cc-a-l2', edit: 'clear' },
    ]);
  });

  // Mutations caught: the release taking only a dirty line that holds a
  // count, and (B's own clear) the count kept only for an entry naming one.
  it.each(['count', 'clear'] as const)(
    "the next account keeps the other account's count for its own unsent %s of another line, and its answer does not list the count: the other account's clear shows as not counted, never as the next account's cleared line",
    async (bEdit) => {
      await aLeavesItsCacheWithNoOwner('clear');
      bSees({ openCycleCounts: [] });
      signIn(B);
      // A second line of A's count, with the server's count of 3 on it.
      raw.exec(`insert into cycle_count_lines
          (id, count_id, item_id, item_name, item_sku, expected, counted, local_dirty)
        values ('cc-a-l2', 'cc-a', 'item-y', 'Y', 'SKU-Y', 3, 3, 0)`);
      if (bEdit === 'count') expect(await m.counts.updateLocalLine('cc-a-l2', 7)).not.toBeNull();
      else await emptyTheBox('cc-a-l2');
      await m.sync.syncNow(); // B's first pull: the adopt, in full, without cc-a

      expect(ids("select id from cycle_counts where id = 'cc-a'")).toEqual(['cc-a']);
      expect(line('cc-a-l1')).toEqual({ counted: null, local_dirty: 0 });
      expect(line('cc-a-l2')).toEqual({ counted: bEdit === 'count' ? 7 : null, local_dirty: 1 });
      const shown = (await m.counts.getCycleCount('cc-a'))?.lines
        .map((l) => [l.id, l.counted, l.localDirty])
        .sort();
      expect(shown).toEqual([
        ['cc-a-l1', null, false],
        ['cc-a-l2', bEdit === 'count' ? 7 : null, true],
      ]);
      expect(await m.counts.pendingCountFor('cc-a')).toBe(1);
      expect(queuedEdits()).toEqual([
        { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: 'clear' },
        { user_id: B, status: 'pending', line_id: 'cc-a-l2', edit: bEdit },
      ]);
    },
  );

  // The drain, end to end (cycle-count-sync.ts): it decides per row whose it
  // is (outbox-scope.ts outboxSendDecision). Mutation caught: a clear sent
  // whatever that decision says.
  it.each(['count', 'clear'] as const)(
    "another account's unsent %s is never sent under the next account, and is sent under its own once it signs in here again",
    async (aEdit) => {
      await aLeavesItsCacheWithNoOwner(aEdit);
      bSees({
        openCycleCounts: [
          openCount('cc-a', [{ id: 'cc-a-l1', itemId: 'item-x', expected: 4, counted: 2 }]),
        ],
      });
      signIn(B);
      await m.sync.syncNow(); // B's first pull
      // B's own clear on a count of its own, so B's drain has a row to send
      // (with none of its own it sends nothing at all).
      await countOnThePhone('cc-b');
      await emptyTheBox('cc-b-l1');
      await countsDrain();

      const aPath = editPath(aEdit, 'cc-a', 'cc-a-l1');
      expect(device.requests).toContain(editPath('clear', 'cc-b', 'cc-b-l1'));
      expect(device.requests).not.toContain(aPath);
      expect(queuedEdits()).toEqual([
        { user_id: A, status: 'pending', line_id: 'cc-a-l1', edit: aEdit },
      ]);

      // B's session ends without a wipe, and A signs in here again: A's pull
      // resets B's cache, and A's drain sends A's edit, as A.
      sessionEndsWithoutWipe();
      signIn(A);
      await m.sync.syncNow();
      await countsDrain();

      expect(device.requests.filter((p) => p === aPath)).toEqual([aPath]);
      expect(queuedEdits()).toEqual([]);
    },
  );

  // A clear is not refused where a typed count is not (pull request body,
  // "Not in this pull request"): while the next account's first sync still
  // waits for a pull of the previous account's, the count screen stores no
  // count it fetches, but an edit typed on a count the previous account
  // cached is saved. Both are queued as the typing account's, the reset wipes
  // the line, and its drain sends them. Mutation caught: clearLocalLine
  // refusing a clear while the cache is recorded as another account's.
  it.each(['count', 'clear'] as const)(
    "a %s typed while the next account's first sync waits for the previous account's pull is saved as the next account's, like a typed count, and sent under it after its reset",
    async (edit) => {
      await aSignedInWithAPhoto();
      // A opened a count online; the server has a count of 3 on its line.
      expect(
        await m.counts.cacheCycleCount(
          countHeader('cc-a'),
          [fetchedLine('cc-a-l1', 3)],
          await m.counts.cacheWriteScope(),
        ),
      ).toBe(true);
      const { held, aSync } = await aPullIsOut();
      sessionEndsWithoutWipe();
      signIn(B);
      const bFirst = m.sync.syncNow(); // waits for A's pull

      // B's count screen still shows A's cached count: B types a count of 6,
      // or empties the box.
      const saved =
        edit === 'count'
          ? await m.counts.updateLocalLine('cc-a-l1', 6)
          : await m.counts.clearLocalLine('cc-a-l1');
      expect(saved).not.toBeNull();
      expect(line('cc-a-l1')).toEqual({ counted: edit === 'count' ? 6 : null, local_dirty: 1 });
      expect(queuedEdits()).toEqual([{ user_id: B, status: 'pending', line_id: 'cc-a-l1', edit }]);

      held.release();
      await Promise.all([aSync, bFirst]);

      expect(owner()).toBe(B);
      expect(ids("select id from cycle_count_lines where count_id = 'cc-a'")).toEqual([]);
      expect(queuedEdits()).toEqual([{ user_id: B, status: 'pending', line_id: 'cc-a-l1', edit }]);
      await countsDrain();
      expect(device.requests).toContain(editPath(edit, 'cc-a', 'cc-a-l1'));
      expect(queuedEdits()).toEqual([]);
    },
  );
});

describe('Settings > Offline cache > Clear is the same-account wipe', SLOW, () => {
  // The screen's own dependencies, which the Clear rows above reproduce.
  it('passes db.ts deleteOrgData itself, so the record and the photos stay', () => {
    const settings = readFileSync(
      path.resolve(__dirname, '../../app/(drawer)/settings.tsx'),
      'utf8',
    );
    expect(settings).toContain("import { deleteOrgData } from '@/lib/db';");
    expect(settings.replace(/\s+/g, ' ')).toContain(
      'await clearOfflineCache({ isOnline, deleteOrgData, syncNow, refreshEffectivePermissions, refreshWarehouseScope, });',
    );
  });
});
