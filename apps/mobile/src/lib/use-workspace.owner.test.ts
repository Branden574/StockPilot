import { beforeEach, describe, expect, it, vi } from 'vitest';

import { savedWorkspaceIn, storedWorkspaceEntries } from './__fixtures__/saved-workspace';
import { deleteOrgData } from './db';
import { OutboxWorkspaceLoadingError, outboxSendDecision } from './outbox-scope';
import { liveOutboxScope, outboxWriteScope } from './session-scope';
import { setActiveOrg, useWorkspace } from './use-workspace';
import {
  CACHE_REPAIR_OWED_STORAGE_KEY,
  LEGACY_ACTIVE_ORG_STORAGE_KEY,
  SAVED_WORKSPACE_STORAGE_KEY,
  readSavedWorkspace,
  savedWorkspaceFor,
} from './workspace-keys';

/**
 * The workspace load and a switch record WHOSE saved workspace it is, and the
 * load chooses with the same owner check the request header uses (docket B10:
 * the 401 burst after sign-in; workspace-keys.ts savedWorkspaceFor).
 *
 * If the load still chose another account's saved workspace (this account is
 * a member of it too) while the first requests, which no longer name it, were
 * answered for this account's default, the screen and the snapshot pull would
 * be in two workspaces. So the load treats another account's saved workspace
 * as nothing saved, exactly as the header does, and saves its choice with this
 * account as the owner.
 *
 * Integrator decision 3: the workspace and its owner are saved as ONE value
 * in ONE write at both writers, never a workspace without its owner, and a
 * failed save is a failed switch. The load then asks both drains for a pass,
 * so a queued row held for want of this account's workspace goes at once (in
 * a load that also clears the cache, engine 1's pass is the forced full pull
 * it asks for anyway). And today's phones, which hold only the older single
 * key, upgrade through the first workspace load (the last block).
 *
 * The harness is use-workspace.hydrate.test.ts's: React runs effects at once,
 * and storage, the database and Supabase are faked so the real hydrate and
 * setActiveOrg run under node, with the real session-scope.ts reading the
 * same storage.
 */

type Published = { activeOrgId: string | null; loading: boolean; orgs: unknown[] };
const published = vi.hoisted(() => [] as Published[]);
vi.mock('react', () => ({
  useState: (v: unknown) => [v, (next: Published) => published.push(next)],
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));

const auth = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
const emitAuth = (id: string | null) =>
  auth.listener?.(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? { user: { id } } : null);
vi.mock('./auth-context', () => ({ useAuth: () => ({ user: auth.user }) }));

const store = vi.hoisted(() => new Map<string, string>());
const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (k: string) => store.get(k) ?? null),
  setItem: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
  removeItem: vi.fn(async (k: string) => {
    store.delete(k);
  }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('./db', () => ({ deleteOrgData: vi.fn(async () => {}) }));
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn() }));
const drains = vi.hoisted(() => ({
  syncNow: vi.fn(async () => {}),
  syncAfterRunning: vi.fn(async () => {}),
  forceSync: vi.fn(async () => {}),
}));
vi.mock('./sync', () => ({
  syncNow: drains.syncNow,
  syncAfterRunning: drains.syncAfterRunning,
}));
vi.mock('./cycle-count-sync', () => ({ cycleCountSync: { forceSync: drains.forceSync } }));

/** A membership read a test holds open (a slow connection), or none. */
const membershipRead = vi.hoisted(() => ({ gate: null as Promise<void> | null }));

vi.mock('./supabase', () => {
  // u1 is a member of A, B and C; its default is A.
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => {
      if (membershipRead.gate) await membershipRead.gate;
      return {
        data: [
          { role: 'staff', organization_id: 'org-a', organizations: { name: 'A' } },
          { role: 'staff', organization_id: 'org-b', organizations: { name: 'B' } },
          { role: 'staff', organization_id: 'org-c', organizations: { name: 'C' } },
        ],
        error: null,
      };
    },
  };
  const profiles = {
    select: () => profiles,
    eq: () => profiles,
    maybeSingle: async () => ({ data: { default_organization_id: 'org-a' }, error: null }),
  };
  const warehouses = {
    select: () => warehouses,
    eq: () => warehouses,
    order: async () => ({ data: [], error: null }),
  };
  return {
    supabase: {
      from: (t: string) =>
        t === 'organization_members' ? members : t === 'user_profiles' ? profiles : warehouses,
      auth: {
        onAuthStateChange: (cb: typeof auth.listener) => {
          auth.listener = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    },
    // The stored session, for session-scope.ts (the outbox's reader).
    readDeviceAuthSession: async () => ({
      present: auth.user !== null,
      userId: auth.user?.id ?? null,
    }),
  };
});

/** Put a saved workspace in storage as the build that saved it would (no owner: an older build). */
function put(saved: { orgId: string; ownerId: string | null }) {
  store.clear();
  for (const [key, item] of storedWorkspaceEntries(saved)) store.set(key, item);
}
/** The one value this build writes. */
const value = (orgId: string, ownerId: string) => JSON.stringify({ orgId, ownerId });

const settled = async () => {
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

/** The workspace the last load or switch put on screen. */
const shown = () => published.at(-1)?.activeOrgId;

emitAuth('u1'); // records who is signed in

beforeEach(() => {
  store.clear();
  // A write a test made fail (or left queued to fail) never reaches the next test.
  storage.setItem.mockReset().mockImplementation(async (k: string, v: string) => {
    store.set(k, v);
  });
  storage.removeItem.mockClear();
  drains.syncNow.mockClear();
  drains.syncAfterRunning.mockClear();
  drains.forceSync.mockClear();
  // A wipe a test holds and never sees asked for must not hold the next
  // test's switch (each test that holds one sets it again).
  vi.mocked(deleteOrgData)
    .mockReset()
    .mockImplementation(async () => {});
  membershipRead.gate = null;
});

describe("the workspace load uses only this account's saved workspace", () => {
  it("another account's saved workspace is not chosen, even one this account belongs to", async () => {
    put({ orgId: 'org-b', ownerId: 'u-previous' });
    // Before: B was chosen (u1 is a member) while the header named none and
    // the server answered for A, u1's default.
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-a');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
  });

  it("a workspace saved by an older build (no owner) stays, and is recorded as this account's", async () => {
    put({ orgId: 'org-b', ownerId: null });
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-b');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-b', ownerId: 'u1' });
  });

  it("this account's saved workspace stays, and nothing is written", async () => {
    put({ orgId: 'org-c', ownerId: 'u1' });
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-c');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("nothing saved: the default is chosen and saved as this account's", async () => {
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-a');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
  });
});

/**
 * WHICH WORKSPACE THE CACHE HOLDS is not the same question as which workspace
 * this account chooses (docket B10 review, 2026-10-30). Another account's saved
 * workspace is not this account's choice, but the cache was pulled for it: that
 * account's requests named it until this account signed in. Told nothing was
 * saved, the choice took the cache to be the workspace the server answers this
 * account for with no header (its default, or its one membership), so a load
 * that chose another workspace cleared nothing. The workspace was shown over
 * the previous account's rows, and stayed so until this account's own pull
 * reset them (cache-owner.ts), which waits behind a pull of the previous
 * account's still out, and clears the photos before the rows. Before B10 the
 * saved workspace was the cache's whoever saved it, and the load repaired.
 */
describe("another account's saved workspace is the one the cache holds", () => {
  it.each([
    ['in an organization this account is not in', 'org-z'],
    ['in one this account is also in, but does not choose', 'org-b'],
  ])(
    "another account's saved workspace %s: the load clears the cache before it shows its own choice, and pulls that in full",
    async (_where, previous) => {
      put({ orgId: previous, ownerId: 'u-previous' });
      let wipeDone!: () => void;
      vi.mocked(deleteOrgData).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            wipeDone = resolve;
          }),
      );
      useWorkspace(); // u1 signs in after the other account: its workspace load
      await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(published.at(-1)?.loading).toBe(true); // nothing shown over the old rows

      wipeDone();
      await settled();
      expect(shown()).toBe('org-a'); // u1's default
      expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
      expect(deleteOrgData).toHaveBeenCalledTimes(1);
      expect(drains.syncNow).toHaveBeenCalledWith(true);
    },
  );

  it("another account's saved workspace that this account chooses too: nothing is cleared (the account change is the cache owner reset's)", async () => {
    put({ orgId: 'org-a', ownerId: 'u-previous' }); // org-a is u1's default
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-a');
    expect(deleteOrgData).not.toHaveBeenCalled();
    expect(drains.syncNow).not.toHaveBeenCalled();
  });

  it("an older build's saved workspace (no owner) that this account chooses: nothing is cleared, as before", async () => {
    put({ orgId: 'org-b', ownerId: null });
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-b');
    expect(deleteOrgData).not.toHaveBeenCalled();
    expect(drains.syncNow).not.toHaveBeenCalled();
  });
});

describe('the workspace and its owner are saved as one value, in one write (integrator decision 3)', () => {
  // Re-pinned by round c10 (integrator decision cache_clear_order): this load
  // clears the cache (another account's workspace, not the one chosen), so the
  // repair owed is recorded first, and recorded done once the wipe has worked.
  // The saved workspace is still ONE setItem holding both.
  it('the load: one setItem holding both, and the older key cleared', async () => {
    put({ orgId: 'org-b', ownerId: 'u-previous' });
    useWorkspace();
    await settled();
    expect(storage.setItem.mock.calls).toEqual([
      [CACHE_REPAIR_OWED_STORAGE_KEY, expect.any(String)],
      [SAVED_WORKSPACE_STORAGE_KEY, value('org-a', 'u1')],
    ]);
    expect([...store.keys()]).toEqual([SAVED_WORKSPACE_STORAGE_KEY]);
  });

  // Re-pinned by round c10, as above: a switch clears the cache too.
  it('a switch: one setItem holding both, with the signed-in account as the owner', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-a');
    storage.setItem.mockClear();
    await setActiveOrg('org-c');
    expect(storage.setItem.mock.calls).toEqual([
      [CACHE_REPAIR_OWED_STORAGE_KEY, expect.any(String)],
      [SAVED_WORKSPACE_STORAGE_KEY, value('org-c', 'u1')],
    ]);
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-c', ownerId: 'u1' });
    expect(shown()).toBe('org-c');
  });

  it("a switch over another account's leftover record replaces it whole", async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    put({ orgId: 'org-a', ownerId: 'u-previous' }); // left by a failed save, say
    await setActiveOrg('org-b');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-b', ownerId: 'u1' });
  });

  it('a switch with no account known saves nothing and fails: the previous workspace stays on screen and in storage', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-a');
    storage.setItem.mockClear();
    storage.removeItem.mockClear();

    emitAuth(null); // nobody known (the first version removed the owner here)
    try {
      await expect(setActiveOrg('org-c')).rejects.toThrow();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
      expect(shown()).toBe('org-a');
    } finally {
      emitAuth('u1');
    }
  });

  it('a failed save is a failed switch: the previous pair stays in storage and on screen, and the next switch works', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    const before = published.length;
    // The save of the one value fails, whatever is written before it (since
    // round c10, the repair owed: a failure of that one has its own test).
    let failed = false;
    storage.setItem.mockImplementation(async (key: string, item: string) => {
      if (key === SAVED_WORKSPACE_STORAGE_KEY && !failed) {
        failed = true;
        throw new Error('database or disk is full');
      }
      store.set(key, item);
    });

    await expect(setActiveOrg('org-c')).rejects.toThrow('database or disk is full');
    expect(failed).toBe(true);
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
    expect(published.length).toBe(before); // nothing was shown
    expect(shown()).toBe('org-a');

    await setActiveOrg('org-c');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-c', ownerId: 'u1' });
    expect(shown()).toBe('org-c');
  });

  it('storage that takes one write and then fails cannot leave a workspace under another account (or none)', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    // A load whose save failed left another account's record (the first
    // version wrote the workspace, then its owner, in two writes).
    put({ orgId: 'org-a', ownerId: 'u-previous' });
    storage.setItem
      .mockImplementationOnce(async (k: string, v: string) => {
        store.set(k, v);
      })
      .mockRejectedValue(new Error('database or disk is full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await setActiveOrg('org-b').catch(() => undefined);
      // Whole or not at all: never org-b under the previous account's owner.
      expect([
        JSON.stringify({ orgId: 'org-b', ownerId: 'u1' }),
        JSON.stringify({ orgId: 'org-a', ownerId: 'u-previous' }),
      ]).toContain(JSON.stringify(savedWorkspaceIn(store)));
    } finally {
      warn.mockRestore();
      storage.setItem.mockReset().mockImplementation(async (k: string, v: string) => {
        store.set(k, v);
      });
    }
  });
});

describe("a load that saves this account's workspace sends the rows held for it", () => {
  it('asks both drains for a pass that starts after the save', async () => {
    put({ orgId: 'org-b', ownerId: null });
    useWorkspace();
    await settled();
    expect(drains.syncAfterRunning).toHaveBeenCalledTimes(1);
    expect(drains.forceSync).toHaveBeenCalledTimes(1);
    const saved = storage.setItem.mock.invocationCallOrder[0]!;
    expect(drains.syncAfterRunning.mock.invocationCallOrder[0]).toBeGreaterThan(saved);
    expect(drains.forceSync.mock.invocationCallOrder[0]).toBeGreaterThan(saved);
  });

  it('a load that finds its own workspace already saved held nothing, and asks for nothing', async () => {
    put({ orgId: 'org-c', ownerId: 'u1' });
    useWorkspace();
    await settled();
    expect(drains.syncAfterRunning).not.toHaveBeenCalled();
    expect(drains.forceSync).not.toHaveBeenCalled();
  });

  // The merge with #380 (SEC-A), then the B10 review. A load that also clears
  // the cache (the repair: here the saved workspace is one this account has
  // since left) asks for no pass while its wipe runs. Asked before it, as at
  // c2946c99f, a pass read whose cache this is (cache-owner.ts) and the delta
  // cursor with plain reads, which do not wait in the transaction queue,
  // while the wipe does: its owner check fell before or after the wipe by
  // timing, and the delta answer it fetched with the old cursor could be
  // discarded (sync.ts, the cursor check), for one when the wipe waited
  // behind another queued transaction. Its one pass of engine 1 is the
  // forced full pull it asks for once the workspace is shown, whose drain
  // sends the rows held for this account's workspace. Until the review it
  // also asked syncAfterRunning after the wipe: a second full pull of the
  // snapshot behind the first (the wipe forgets the cursor, and a forced
  // pull never joins one running).
  it('a load that also clears the cache asks for nothing while its wipe runs, then for one forced full pull and one count drain', async () => {
    put({ orgId: 'org-z', ownerId: 'u1' }); // this account's own, a workspace it has since left
    let wipeDone!: () => void;
    vi.mocked(deleteOrgData).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          wipeDone = resolve;
        }),
    );
    useWorkspace();
    await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(1));
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' }); // saved first
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drains.syncAfterRunning).not.toHaveBeenCalled();
    expect(drains.syncNow).not.toHaveBeenCalled();
    expect(drains.forceSync).not.toHaveBeenCalled();

    wipeDone();
    await settled();
    expect(shown()).toBe('org-a');
    expect(drains.syncAfterRunning).not.toHaveBeenCalled();
    expect(drains.syncNow.mock.calls).toEqual([[true]]);
    expect(drains.forceSync).toHaveBeenCalledTimes(1);
  });

  it('a save that fails asks for nothing: the rows stay held until a save works', async () => {
    put({ orgId: 'org-b', ownerId: null });
    storage.setItem.mockRejectedValueOnce(new Error('database or disk is full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useWorkspace();
    await settled();
    warn.mockRestore();
    expect(shown()).toBe('org-b'); // still shown, as before
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-b', ownerId: null });
    expect(drains.syncAfterRunning).not.toHaveBeenCalled();
    expect(drains.forceSync).not.toHaveBeenCalled();
  });
});

/**
 * AFTER A ROLLED-BACK PHONE UPDATE (docket B10 review). The older app reads and
 * writes only the older key, which this build removes whenever it saves, and
 * its pulls fill the cache with that workspace: a member of several workspaces
 * opens there in its default, say. Re-applied, this build reads its own value
 * first, still the one from before the rollback, and showed that workspace over
 * the other one's rows, which its delta pulls (from the older app's cursor)
 * never swept. The older key beside this build's value can only have been
 * written since by an older build (or left by a removal that failed, when the
 * reset below is merely once too many).
 */
describe('after a rolled-back phone update: the older key beside this build value', () => {
  it('naming another workspace: the load clears the cache once, keeps this build value and removes the older key', async () => {
    store.set(SAVED_WORKSPACE_STORAGE_KEY, value('org-b', 'u1')); // saved before the rollback
    store.set(LEGACY_ACTIVE_ORG_STORAGE_KEY, 'org-a'); // the older app's load saved u1's default
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-b');
    expect(deleteOrgData).toHaveBeenCalledTimes(1);
    expect(drains.syncNow.mock.calls).toEqual([[true]]);
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-b', ownerId: 'u1' });
    expect(store.has(LEGACY_ACTIVE_ORG_STORAGE_KEY)).toBe(false);

    // The next load finds the cache its own: nothing cleared, nothing written.
    vi.mocked(deleteOrgData).mockClear();
    drains.syncNow.mockClear();
    storage.setItem.mockClear();
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-b');
    expect(deleteOrgData).not.toHaveBeenCalled();
    expect(drains.syncNow).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('naming the workspace this build chooses: nothing is cleared, and the older key is removed', async () => {
    store.set(SAVED_WORKSPACE_STORAGE_KEY, value('org-b', 'u1'));
    store.set(LEGACY_ACTIVE_ORG_STORAGE_KEY, 'org-b');
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-b');
    expect(deleteOrgData).not.toHaveBeenCalled();
    expect(drains.syncNow).not.toHaveBeenCalled();
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-b', ownerId: 'u1' });
    expect(store.has(LEGACY_ACTIVE_ORG_STORAGE_KEY)).toBe(false);
  });
});

/**
 * A CACHE REPAIR THAT DID NOT FINISH IS STILL OWED (docket B10, integrator
 * decision cache_clear_order). Each signal the load repairs for is erased by
 * the load's own save, which runs before the wipe: another account's record and
 * this account's record of a workspace it has left are replaced, and the older
 * app's key is removed (workspace-keys.ts saveWorkspace). So when the wipe
 * failed (it only warned), or the app was closed while it waited its turn in
 * the transaction queue (db.ts withDbTransaction), the next load found no
 * signal and cleared nothing, and the other workspace's rows stayed: its
 * purchase orders for good, since no pull sweeps them (sync.ts). The repair is
 * now recorded as owed before the save, and recorded done only once a wipe has
 * worked.
 */
describe('a cache repair that did not finish is still owed', () => {
  /** The three repairs: the saved state each starts from, and the workspace chosen. */
  const REPAIR_KINDS: [string, () => void, string][] = [
    [
      'after a rolled-back phone update (the older key names another workspace)',
      () => {
        store.set(SAVED_WORKSPACE_STORAGE_KEY, value('org-b', 'u1')); // saved before the rollback
        store.set(LEGACY_ACTIVE_ORG_STORAGE_KEY, 'org-a'); // the older app's load since
      },
      'org-b',
    ],
    [
      "another account's saved workspace, not the one this account chooses",
      () => put({ orgId: 'org-z', ownerId: 'u-previous' }),
      'org-a',
    ],
    [
      "this account's saved workspace, which it has since left",
      () => put({ orgId: 'org-z', ownerId: 'u1' }),
      'org-a',
    ],
  ];

  const owed = () => store.has(CACHE_REPAIR_OWED_STORAGE_KEY);

  it.each(REPAIR_KINDS)(
    '%s: the wipe fails once, the next load clears the cache again, and a wipe that works settles the repair',
    async (_kind, seed, chosen) => {
      seed();
      vi.mocked(deleteOrgData).mockRejectedValueOnce(new Error('database is locked'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        useWorkspace(); // the repair load: its wipe fails
        await settled();
        expect(shown()).toBe(chosen);
        expect(deleteOrgData).toHaveBeenCalledTimes(1);
        // Its save replaced the signal (the record, or the older key): only
        // the repair owed is left to tell the next load.
        expect(savedWorkspaceIn(store)).toEqual({ orgId: chosen, ownerId: 'u1' });
        expect(store.has(LEGACY_ACTIVE_ORG_STORAGE_KEY)).toBe(false);
        expect.soft(owed()).toBe(true);

        drains.syncNow.mockClear();
        useWorkspace(); // the next load: a screen that opens, or the next launch
        await settled();
        expect(deleteOrgData).toHaveBeenCalledTimes(2);
        expect(drains.syncNow.mock.calls).toEqual([[true]]); // then a full pull
        expect(shown()).toBe(chosen);
        expect(owed()).toBe(false);

        useWorkspace(); // nothing is owed any more
        await settled();
        expect(deleteOrgData).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each(REPAIR_KINDS)(
    '%s: the app is closed while the wipe waits its turn, and the next launch clears the cache',
    async (_kind, seed, chosen) => {
      seed();
      // The wipe waits behind another transaction (a pull mid-write) and the
      // app is closed before it runs.
      vi.mocked(deleteOrgData).mockImplementationOnce(() => new Promise<void>(() => {}));
      useWorkspace();
      await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(1));
      expect(savedWorkspaceIn(store)).toEqual({ orgId: chosen, ownerId: 'u1' }); // the signal is gone
      expect.soft(owed()).toBe(true); // the repair owed is not

      useWorkspace(); // the next launch's load
      await settled();
      expect(deleteOrgData).toHaveBeenCalledTimes(2);
      expect(drains.syncNow).toHaveBeenCalledWith(true);
      expect(shown()).toBe(chosen);
      expect(owed()).toBe(false);
    },
  );

  // A load abandoned because the account changed while its wipe waited may
  // not record the repair done, even once that wipe has run: the next
  // account's load can have recorded a repair of its own meanwhile, which a
  // wipe asked for before that load's save does not cover. The next load
  // clears once more instead.
  it("the account changes while the repair's wipe waits: the abandoned load leaves the repair owed, and the next account's load clears the cache", async () => {
    put({ orgId: 'org-z', ownerId: 'u1' }); // this account's own, a workspace it has since left
    let wipeDone!: () => void;
    vi.mocked(deleteOrgData).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          wipeDone = resolve;
        }),
    );
    useWorkspace();
    await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(1));
    const before = published.length;
    emitAuth('u2'); // "Use a different account": u1's load is abandoned
    auth.user = { id: 'u2' };
    try {
      wipeDone(); // the wipe runs after all
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(published.length).toBe(before); // the abandoned load shows nothing
      expect.soft(owed()).toBe(true);

      useWorkspace(); // u2's load
      await settled();
      expect(deleteOrgData).toHaveBeenCalledTimes(2);
      expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u2' });
      expect(owed()).toBe(false);
    } finally {
      emitAuth('u1');
      auth.user = { id: 'u1' };
    }
  });

  // The record is one value for the device. A load records it done only while
  // its own record is the latest: one made since can stand for a save made
  // after this load's wipe was asked for (another load that read other
  // memberships and chose another workspace, say), which that wipe does not
  // cover. Here the later one's wipe fails, so the repair stays owed.
  it('two loads repair at once and the later record is not settled: the repair stays owed for the next load', async () => {
    put({ orgId: 'org-z', ownerId: 'u1' }); // this account's own, a workspace it has since left
    let firstWipeDone!: () => void;
    vi.mocked(deleteOrgData)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            firstWipeDone = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('database is locked'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useWorkspace(); // the first screen: records, saves, and its wipe waits
      await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(1));
      useWorkspace(); // a second screen: records again, and its wipe fails
      await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(2));
      firstWipeDone();
      await settled();
      expect(owed()).toBe(true);

      useWorkspace(); // the next load
      await settled();
      expect(deleteOrgData).toHaveBeenCalledTimes(3);
      expect(owed()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(REPAIR_KINDS)(
    '%s: the repair is recorded as owed before the save that replaces its signal, and done only after the wipe',
    async (_kind, seed) => {
      seed();
      useWorkspace();
      await settled();
      expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([
        CACHE_REPAIR_OWED_STORAGE_KEY,
        SAVED_WORKSPACE_STORAGE_KEY,
      ]);
      expect(storage.removeItem.mock.calls.at(-1)).toEqual([CACHE_REPAIR_OWED_STORAGE_KEY]);
      const wiped = vi.mocked(deleteOrgData).mock.invocationCallOrder[0]!;
      expect(storage.removeItem.mock.invocationCallOrder.at(-1)).toBeGreaterThan(wiped);
      expect(owed()).toBe(false);
    },
  );

  it('a repair that cannot be recorded keeps its signal: nothing is saved, the wipe still runs, and the next load repairs and saves', async () => {
    put({ orgId: 'org-z', ownerId: 'u1' }); // this account's own, a workspace it has since left
    // The first write fails if it is the repair owed (storage full), and is
    // made as usual if it is anything else.
    storage.setItem.mockImplementationOnce(async (key: string, item: string) => {
      if (key === CACHE_REPAIR_OWED_STORAGE_KEY) throw new Error('database or disk is full');
      store.set(key, item);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useWorkspace();
      await settled();
      expect(shown()).toBe('org-a'); // still shown, as when a save fails
      expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-z', ownerId: 'u1' }); // the signal stays
      expect(deleteOrgData).toHaveBeenCalledTimes(1);

      useWorkspace();
      await settled();
      expect(deleteOrgData).toHaveBeenCalledTimes(2);
      expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
      expect(owed()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  // The switch saves, then wipes, the same way (recurring pattern 26: the
  // sibling of the load's repair): its wipe only warned, and nothing told the
  // next load that the cache still held the previous workspace's rows.
  it('a switch whose wipe fails: the next load clears the cache the switch left', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-a');
    vi.mocked(deleteOrgData).mockRejectedValueOnce(new Error('database is locked'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await setActiveOrg('org-c');
      expect(shown()).toBe('org-c');
      expect(deleteOrgData).toHaveBeenCalledTimes(1);
      expect.soft(owed()).toBe(true);
      drains.syncNow.mockClear();

      useWorkspace(); // the next screen that opens
      await settled();
      expect(deleteOrgData).toHaveBeenCalledTimes(2);
      expect(drains.syncNow.mock.calls).toEqual([[true]]);
      expect(shown()).toBe('org-c');
      expect(owed()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a switch records the repair owed before its save, and done once its wipe has worked', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
    await setActiveOrg('org-b');
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([
      CACHE_REPAIR_OWED_STORAGE_KEY,
      SAVED_WORKSPACE_STORAGE_KEY,
    ]);
    expect(storage.removeItem.mock.calls.at(-1)).toEqual([CACHE_REPAIR_OWED_STORAGE_KEY]);
    expect(storage.removeItem.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      vi.mocked(deleteOrgData).mock.invocationCallOrder[0]!,
    );
    expect(owed()).toBe(false);
  });

  it('a switch whose repair owed cannot be recorded fails before it saves: the previous workspace stays on screen and in storage', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    const before = published.length;
    storage.setItem.mockImplementationOnce(async (key: string, item: string) => {
      if (key === CACHE_REPAIR_OWED_STORAGE_KEY) throw new Error('database or disk is full');
      store.set(key, item);
    });
    await expect(setActiveOrg('org-c')).rejects.toThrow('database or disk is full');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
    expect(deleteOrgData).not.toHaveBeenCalled();
    expect(published.length).toBe(before);
    expect(shown()).toBe('org-a');
  });

  /**
   * Writing the record is a wait of its own, so the load and the switch check
   * the account and the switches again once it is written, as after their
   * other waits (the review of round c10). In these tests a held write lands
   * in storage at once, as the native store applies writes in the order they
   * are asked for, while the code that waits for it goes on only when the test
   * releases it.
   */
  describe('the account and the switches are checked again once the record is written', () => {
    /** Hold the next `count` writes of the record (see above). */
    function holdRecordWrites(count: number) {
      const releases: (() => void)[] = [];
      const gates = Array.from(
        { length: count },
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
      let asked = 0;
      const write = storage.setItem.getMockImplementation()!;
      storage.setItem.mockImplementation(async (key: string, item: string) => {
        if (key !== CACHE_REPAIR_OWED_STORAGE_KEY || asked === count) return write(key, item);
        const gate = gates[asked]!;
        asked += 1;
        store.set(key, item);
        await gate;
      });
      return {
        asked: () => asked,
        release: (n: number) => releases[n]!(),
        releaseAll: () => releases.forEach((release) => release()),
      };
    }

    /** Hold the membership read (a slow connection) until the call returned is made. */
    function holdMembershipRead(): () => void {
      let release!: () => void;
      membershipRead.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        membershipRead.gate = null;
        release();
      };
    }

    const ACCOUNT_CHANGES: [string, string | null][] = [
      ['another account signs in', 'u2'],
      ['the account signs out', null],
    ];

    // Before the check, the load went on to save this account's choice for an
    // account that had left, and to wipe the cache.
    it.each(ACCOUNT_CHANGES)(
      'the load: %s while its record is written, and the load saves, wipes and shows nothing; the repair stays owed',
      async (_change, next) => {
        put({ orgId: 'org-z', ownerId: 'u1' }); // this account's own, a workspace it has since left
        const writes = holdRecordWrites(1);
        try {
          useWorkspace(); // u1's load records the repair, and waits for the write
          await vi.waitFor(() => expect(writes.asked()).toBe(1));
          const before = published.length;
          emitAuth(next);
          writes.release(0);
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-z', ownerId: 'u1' });
          expect(deleteOrgData).not.toHaveBeenCalled();
          expect(published.length).toBe(before);
          expect(owed()).toBe(true); // the next load clears the cache
        } finally {
          writes.releaseAll();
          emitAuth('u1');
        }
      },
    );

    // Before the check, the switch went on to save its workspace for the
    // account that had left, and to wipe the cache.
    it.each(ACCOUNT_CHANGES)(
      'a switch: %s while its record is written, and the switch saves, wipes and shows nothing',
      async (_change, next) => {
        put({ orgId: 'org-a', ownerId: 'u1' });
        useWorkspace();
        await settled();
        expect(shown()).toBe('org-a');
        const writes = holdRecordWrites(1);
        try {
          const switching = setActiveOrg('org-c');
          await vi.waitFor(() => expect(writes.asked()).toBe(1));
          const before = published.length;
          emitAuth(next);
          writes.release(0);
          await switching;
          expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
          expect(deleteOrgData).not.toHaveBeenCalled();
          expect(published.length).toBe(before);
          expect(shown()).toBe('org-a');
        } finally {
          writes.releaseAll();
          emitAuth('u1');
        }
      },
    );

    it.each(ACCOUNT_CHANGES)(
      "%s while a load's record and then a switch's are written: nothing is saved for the account that left, and nothing is shown",
      async (_change, next) => {
        put({ orgId: 'org-a', ownerId: 'u1' });
        useWorkspace();
        await settled();
        put({ orgId: 'org-z', ownerId: 'u1' }); // the next load repairs
        const writes = holdRecordWrites(2);
        try {
          useWorkspace(); // a screen opens: its load records the repair
          await vi.waitFor(() => expect(writes.asked()).toBe(1));
          const switching = setActiveOrg('org-c'); // the person picks C
          await vi.waitFor(() => expect(writes.asked()).toBe(2));
          const before = published.length;
          emitAuth(next);
          writes.release(0);
          writes.release(1);
          await switching;
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-z', ownerId: 'u1' });
          expect(deleteOrgData).not.toHaveBeenCalled();
          expect(published.length).toBe(before);
        } finally {
          writes.releaseAll();
          emitAuth('u1');
        }
      },
    );

    // The person picks another workspace while a screen's load is still
    // reading. The switch asks for its record first, so its write lands
    // first: the switch is counted and saves before the load's record is
    // written. Before the check, the load then saved its own choice after the
    // switch's: the screen showed the switch's workspace while every request
    // named the load's (integrator decision 3).
    it("a switch tapped while the load reads, whose record is written first: the switch's workspace stays saved and shown", async () => {
      put({ orgId: 'org-a', ownerId: 'u1' });
      useWorkspace();
      await settled();
      put({ orgId: 'org-z', ownerId: 'u1' }); // the next load repairs
      const writes = holdRecordWrites(2);
      const releaseMemberships = holdMembershipRead();
      try {
        useWorkspace(); // a screen opens: its load waits for the membership read
        const switching = setActiveOrg('org-c'); // the person picks C meanwhile
        await vi.waitFor(() => expect(writes.asked()).toBe(1)); // the switch's record
        releaseMemberships();
        await vi.waitFor(() => expect(writes.asked()).toBe(2)); // the load's record
        writes.release(0); // the switch's write lands first: it is counted, then saves
        await vi.waitFor(() =>
          expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-c', ownerId: 'u1' }),
        );
        writes.release(1); // then the load's
        await switching;
        await settled();
        expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-c', ownerId: 'u1' });
        expect(shown()).toBe('org-c');
      } finally {
        releaseMemberships();
        writes.releaseAll();
      }
    });

    // The other order: the load's record is asked for first, and the switch
    // runs to its end before the load goes on.
    it("a switch made while the load's record is written: the switch's workspace stays saved and shown", async () => {
      put({ orgId: 'org-a', ownerId: 'u1' });
      useWorkspace();
      await settled();
      put({ orgId: 'org-z', ownerId: 'u1' }); // the next load repairs
      const writes = holdRecordWrites(1);
      try {
        useWorkspace(); // a screen opens: its load records the repair, and waits for the write
        await vi.waitFor(() => expect(writes.asked()).toBe(1));
        await setActiveOrg('org-c'); // the person picks C meanwhile
        expect(shown()).toBe('org-c');
        writes.release(0); // the load goes on
        await settled();
        expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-c', ownerId: 'u1' });
        expect(shown()).toBe('org-c');
      } finally {
        writes.releaseAll();
      }
    });

    // A record is counted when its write is asked for, not when it lands
    // (repairsRecorded). A switch's record asked for while a load's wipe runs
    // lands before the load's removal, which is asked for later; the load's
    // wipe ran before the switch's save, so it does not cover it. Counted only
    // once its write had landed, the switch's record was not yet counted when
    // the load checked, so the load removed it, and the switch's failed wipe
    // was owed nowhere.
    it("a load's wipe that worked leaves the record a switch asked for meanwhile: the switch's wipe fails, and the repair stays owed", async () => {
      put({ orgId: 'org-a', ownerId: 'u1' });
      useWorkspace();
      await settled();
      put({ orgId: 'org-z', ownerId: 'u1' }); // the next load repairs
      let loadWipeDone!: () => void;
      vi.mocked(deleteOrgData)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              loadWipeDone = resolve;
            }),
        )
        .mockRejectedValueOnce(new Error('database is locked')); // the switch's wipe
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let writes: ReturnType<typeof holdRecordWrites> | undefined;
      try {
        useWorkspace(); // the load records, saves A, and its wipe waits its turn
        await vi.waitFor(() => expect(deleteOrgData).toHaveBeenCalledTimes(1));
        writes = holdRecordWrites(1);
        const switching = setActiveOrg('org-c'); // the switch asks for its record: it lands
        await vi.waitFor(() => expect(writes?.asked()).toBe(1));
        loadWipeDone(); // the load's wipe works
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(owed()).toBe(true); // the load left the switch's record
        writes.release(0); // the switch goes on: it saves C, and its wipe fails
        await switching;
        await settled();
        expect(shown()).toBe('org-c');
        expect(deleteOrgData).toHaveBeenCalledTimes(2);
        expect(owed()).toBe(true);

        useWorkspace(); // the next load clears the cache the switch left
        await settled();
        expect(deleteOrgData).toHaveBeenCalledTimes(3);
        expect(shown()).toBe('org-c');
        expect(owed()).toBe(false);
      } finally {
        writes?.releaseAll();
        warn.mockRestore();
      }
    });
  });
});

/**
 * TODAY'S PHONES. The phone ships only by an over-the-air update, and every
 * phone in the field holds only the older single key: the workspace with no
 * owner (the two-key form of the first version never shipped). Rows queued
 * there carry their own workspace, or none (queued before any was saved, or
 * by a build older than the outbox stamp, with no account either).
 *
 * After the update, until the first workspace load: requests still name the
 * saved workspace, as they did; a new queued change is refused with the
 * retryable sentence; a row with no workspace of its own waits; a row with
 * its own goes as before. The first load records this account as the owner
 * in one write and clears the older key, asks the drains for a pass, and from
 * then on everything is stamped with and sent under that workspace.
 */
describe("today's phones: the upgrade from the older single workspace key", () => {
  const legacyRow = { organizationId: null, userId: null }; // older than the outbox stamp
  const ownNoWorkspace = { organizationId: null, userId: 'u1' }; // queued before any was saved
  const ownInC = { organizationId: 'org-c', userId: 'u1' }; // queued in C by today's build

  it('before the first load nothing goes out under a workspace this account did not choose; after it, everything goes under its own', async () => {
    store.set(LEGACY_ACTIVE_ORG_STORAGE_KEY, 'org-b'); // what today's build saved

    // The moment after the update, before the workspace load.
    expect(savedWorkspaceFor(await readSavedWorkspace(storage), 'u1')).toBe('org-b'); // requests, as before
    await expect(outboxWriteScope()).rejects.toBeInstanceOf(OutboxWorkspaceLoadingError);
    const early = await liveOutboxScope();
    expect(outboxSendDecision(legacyRow, early)).toEqual({
      send: false,
      reason: 'workspace-loading',
    });
    expect(outboxSendDecision(ownNoWorkspace, early)).toEqual({
      send: false,
      reason: 'workspace-loading',
    });
    expect(outboxSendDecision(ownInC, early)).toEqual({
      send: true,
      orgId: 'org-c',
      userId: 'u1',
      adopt: false,
    });

    // The first workspace load of the new build.
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-b');
    expect(storage.setItem.mock.calls).toEqual([
      [SAVED_WORKSPACE_STORAGE_KEY, value('org-b', 'u1')],
    ]);
    expect(store.has(LEGACY_ACTIVE_ORG_STORAGE_KEY)).toBe(false);
    expect(drains.syncAfterRunning).toHaveBeenCalledTimes(1);
    expect(drains.forceSync).toHaveBeenCalledTimes(1);

    // From now on.
    expect(savedWorkspaceFor(await readSavedWorkspace(storage), 'u1')).toBe('org-b');
    await expect(outboxWriteScope()).resolves.toEqual({ orgId: 'org-b', userId: 'u1' });
    const after = await liveOutboxScope();
    expect(outboxSendDecision(legacyRow, after)).toEqual({
      send: true,
      orgId: 'org-b',
      userId: 'u1',
      adopt: true,
    });
    expect(outboxSendDecision(ownNoWorkspace, after)).toEqual({
      send: true,
      orgId: 'org-b',
      userId: 'u1',
      adopt: true,
    });
    expect(outboxSendDecision(ownInC, after)).toEqual({
      send: true,
      orgId: 'org-c',
      userId: 'u1',
      adopt: false,
    });
  });

  it("an older build's workspace this account is not a member of: the load saves this account's default, and only that is used", async () => {
    // Left by another account's fallback sign-out on today's build. The one
    // request burst this can still cause is owner question 3 in the PR.
    store.set(LEGACY_ACTIVE_ORG_STORAGE_KEY, 'org-z');
    await expect(outboxWriteScope()).rejects.toBeInstanceOf(OutboxWorkspaceLoadingError);
    expect(outboxSendDecision(legacyRow, await liveOutboxScope())).toEqual({
      send: false,
      reason: 'workspace-loading',
    });

    useWorkspace();
    await settled();
    expect(shown()).toBe('org-a');
    expect(savedWorkspaceIn(store)).toEqual({ orgId: 'org-a', ownerId: 'u1' });
    expect(store.has(LEGACY_ACTIVE_ORG_STORAGE_KEY)).toBe(false);
    await expect(outboxWriteScope()).resolves.toEqual({ orgId: 'org-a', userId: 'u1' });
    expect(outboxSendDecision(legacyRow, await liveOutboxScope())).toMatchObject({
      send: true,
      orgId: 'org-a',
    });
  });
});
