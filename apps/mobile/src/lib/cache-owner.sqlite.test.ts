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
}));

const image = vi.hoisted(() => ({ clearMemoryCache: vi.fn(), clearDiskCache: vi.fn() }));
vi.mock('expo-image', () => ({ Image: image }));

vi.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({
    isConnected: device.online,
    isInternetReachable: device.online,
  }),
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

/** The snapshot the server answers for an account in a workspace. */
function snapshotFor(userId: string, orgId: string | null) {
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
  api: vi.fn(async (_path: string, opts: { asUserId?: string } = {}) => {
    if (!device.online || device.snapshotFails) throw new TypeError('Network request failed');
    // api.ts refuses a request whose session changed since it was asked for.
    if (opts.asUserId !== device.userId || !device.userId) throw new Error('session changed');
    return snapshotFor(device.userId, device.storage.get('workspace.activeOrgId') ?? null);
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
 *  and counts its line. */
async function countOnThePhone(countId: string): Promise<void> {
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
  );
  expect(await m.counts.updateLocalLine(`${countId}-l1`, 5)).not.toBeNull();
}

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

describe('the record changes only once the photos are gone', SLOW, () => {
  const ACCOUNT_EXITS: Record<string, () => Promise<void>> = {
    // auth-context.tsx signOut, once the session is gone (photo-links-wiring.test.ts pins it).
    'a sign-out': () => m.photoWipe.wipeWithPhotoCaches(m.db.wipeForSignOut),
    // use-account-gate.ts, a confirmed disable (pinned there too).
    'an account eviction': () => m.photoWipe.wipeWithPhotoCaches(() => m.db.wipeForEviction(A)),
  };

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
