import { beforeEach, describe, expect, it, vi } from 'vitest';

import { savedWorkspaceIn, storedWorkspaceEntries } from './__fixtures__/saved-workspace';
import { OutboxWorkspaceLoadingError, outboxSendDecision } from './outbox-scope';
import { liveOutboxScope, outboxWriteScope } from './session-scope';
import { setActiveOrg, useWorkspace } from './use-workspace';
import {
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
 * so a queued row held for want of this account's workspace goes at once. And
 * today's phones, which hold only the older single key, upgrade through the
 * first workspace load (the last block).
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

vi.mock('./supabase', () => {
  // u1 is a member of A, B and C; its default is A.
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => ({
      data: [
        { role: 'staff', organization_id: 'org-a', organizations: { name: 'A' } },
        { role: 'staff', organization_id: 'org-b', organizations: { name: 'B' } },
        { role: 'staff', organization_id: 'org-c', organizations: { name: 'C' } },
      ],
      error: null,
    }),
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
  storage.setItem.mockClear();
  storage.removeItem.mockClear();
  drains.syncAfterRunning.mockClear();
  drains.forceSync.mockClear();
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

describe('the workspace and its owner are saved as one value, in one write (integrator decision 3)', () => {
  it('the load: one setItem holding both, and the older key cleared', async () => {
    put({ orgId: 'org-b', ownerId: 'u-previous' });
    useWorkspace();
    await settled();
    expect(storage.setItem.mock.calls).toEqual([
      [SAVED_WORKSPACE_STORAGE_KEY, value('org-a', 'u1')],
    ]);
    expect([...store.keys()]).toEqual([SAVED_WORKSPACE_STORAGE_KEY]);
  });

  it('a switch: one setItem holding both, with the signed-in account as the owner', async () => {
    put({ orgId: 'org-a', ownerId: 'u1' });
    useWorkspace();
    await settled();
    expect(shown()).toBe('org-a');
    storage.setItem.mockClear();
    await setActiveOrg('org-c');
    expect(storage.setItem.mock.calls).toEqual([
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
    storage.setItem.mockRejectedValueOnce(new Error('database or disk is full'));

    await expect(setActiveOrg('org-c')).rejects.toThrow('database or disk is full');
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
