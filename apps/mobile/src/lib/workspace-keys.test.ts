import { describe, expect, it, vi } from 'vitest';

import { accountScopedStorageKeys } from './account-eviction';
import {
  LEGACY_ACTIVE_ORG_STORAGE_KEY,
  SAVED_WORKSPACE_STORAGE_KEY,
  ownSavedWorkspace,
  readOlderBuildWorkspaceSince,
  readSavedWorkspace,
  saveWorkspace,
  savedWorkspaceFor,
} from './workspace-keys';

/**
 * WHOSE SAVED WORKSPACE IS THIS? (docket B10: the 401 burst after sign-in)
 *
 * The saved workspace named no account. Three exits keep it on purpose for
 * the person coming back (the biometric and MFA fallbacks, among them "Use a
 * different account", and a session the server ended), so when a DIFFERENT
 * account signed in next, its first requests (/me/seen, /me/announcements,
 * /mobile/snapshot, about a second after sign-in, before the workspace load
 * saved this account's choice) named an organization it does not belong to,
 * and the server refused each with a 401. The saved workspace now records the
 * account that saved it, and only that account's requests name it.
 *
 * Integrator decision 3: the workspace and its owner are ONE value under one
 * key, written in one setItem, never a workspace without its owner. The first
 * version wrote two keys one after the other, and a switch with no account
 * known removed the owner, which left a record every account trusted.
 */

/** A storage stand-in over a Map, with each call recorded. */
function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const value = (orgId: string, ownerId: string) => JSON.stringify({ orgId, ownerId });

describe('savedWorkspaceFor: the workspace a request names (and the workspace load starts from)', () => {
  it('names the workspace this account saved', () => {
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: 'u1' }, 'u1')).toBe('org-a');
  });

  it("names none for another account's workspace: the server would refuse it", () => {
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: 'u1' }, 'u2')).toBeNull();
  });

  it('names a workspace saved by an older build (no owner), as every request did before', () => {
    // Naming none here would let the server answer for the default
    // organization while the screen shows the saved one. The server checks
    // membership on every request, so naming it is safe.
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: null }, 'u1')).toBe('org-a');
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: null }, null)).toBe('org-a');
  });

  it('names none with nobody signed in once it has an owner', () => {
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: 'u1' }, null)).toBeNull();
  });

  it('names none when nothing is saved', () => {
    expect(savedWorkspaceFor({ orgId: null, ownerId: 'u1' }, 'u1')).toBeNull();
    expect(savedWorkspaceFor({ orgId: null, ownerId: null }, 'u1')).toBeNull();
  });
});

describe('ownSavedWorkspace: the workspace queued work may carry (integrator decision 3)', () => {
  it('only the workspace this very account saved', () => {
    expect(ownSavedWorkspace({ orgId: 'org-a', ownerId: 'u1' }, 'u1')).toBe('org-a');
  });

  it("never another account's, nor an older build's that names no owner", () => {
    expect(ownSavedWorkspace({ orgId: 'org-a', ownerId: 'u1' }, 'u2')).toBeNull();
    expect(ownSavedWorkspace({ orgId: 'org-a', ownerId: null }, 'u1')).toBeNull();
  });

  it('none with nobody named, and none when nothing is saved', () => {
    expect(ownSavedWorkspace({ orgId: 'org-a', ownerId: 'u1' }, null)).toBeNull();
    expect(ownSavedWorkspace({ orgId: 'org-a', ownerId: null }, null)).toBeNull();
    expect(ownSavedWorkspace({ orgId: null, ownerId: 'u1' }, 'u1')).toBeNull();
  });
});

describe('readSavedWorkspace', () => {
  it('reads the workspace and its owner from the one value, with one getItem', async () => {
    const storage = memory({ [SAVED_WORKSPACE_STORAGE_KEY]: value('org-a', 'u1') });
    await expect(readSavedWorkspace(storage)).resolves.toEqual({ orgId: 'org-a', ownerId: 'u1' });
    expect(storage.getItem.mock.calls).toEqual([[SAVED_WORKSPACE_STORAGE_KEY]]);
  });

  it("reads an older build's single key, with no owner, only while the one value is absent", async () => {
    const upgraded = memory({ [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-b' });
    await expect(readSavedWorkspace(upgraded)).resolves.toEqual({ orgId: 'org-b', ownerId: null });

    // Both present (the older key's removal failed): the one value wins.
    const both = memory({
      [SAVED_WORKSPACE_STORAGE_KEY]: value('org-a', 'u1'),
      [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-b',
    });
    await expect(readSavedWorkspace(both)).resolves.toEqual({ orgId: 'org-a', ownerId: 'u1' });
  });

  it('reads nothing saved when neither key holds a workspace', async () => {
    await expect(readSavedWorkspace(memory())).resolves.toEqual({ orgId: null, ownerId: null });
    await expect(
      readSavedWorkspace(memory({ [LEGACY_ACTIVE_ORG_STORAGE_KEY]: '' })),
    ).resolves.toEqual({ orgId: null, ownerId: null });
  });

  it.each([
    ['not JSON', 'org-a'],
    ['no owner', JSON.stringify({ orgId: 'org-a' })],
    ['an empty owner', JSON.stringify({ orgId: 'org-a', ownerId: '' })],
    ['no workspace', JSON.stringify({ ownerId: 'u1' })],
    ['an empty workspace', JSON.stringify({ orgId: '', ownerId: 'u1' })],
    ['values that are not text', JSON.stringify({ orgId: 7, ownerId: ['u1'] })],
    ['null', 'null'],
  ])(
    'a value this build never writes (%s) reads as nothing saved, never as the older key',
    async (_what, stored) => {
      const storage = memory({
        [SAVED_WORKSPACE_STORAGE_KEY]: stored,
        [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-b',
      });
      await expect(readSavedWorkspace(storage)).resolves.toEqual({ orgId: null, ownerId: null });
    },
  );

  it('lets a storage fault through to its caller, which decides', async () => {
    const fault = new Error('storage unavailable');
    await expect(
      readSavedWorkspace({
        getItem: async () => {
          throw fault;
        },
      }),
    ).rejects.toBe(fault);
  });
});

/**
 * AFTER A ROLLED-BACK PHONE UPDATE (docket B10 review). The older app reads and
 * writes only the older key, which this build removes whenever it saves its own
 * value, and its pulls fill the cache with that workspace. The older key beside
 * this build's value was therefore written since by an older build.
 */
describe('readOlderBuildWorkspaceSince: the workspace an older build saved after this build did', () => {
  it("answers the older key's workspace while this build's value is saved too", async () => {
    const storage = memory({
      [SAVED_WORKSPACE_STORAGE_KEY]: value('org-b', 'u1'),
      [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-a',
    });
    await expect(readOlderBuildWorkspaceSince(storage)).resolves.toBe('org-a');
  });

  it("answers none for the older key alone: that is today's phones' saved workspace, read as the upgrade fallback", async () => {
    const storage = memory({ [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-a' });
    await expect(readOlderBuildWorkspaceSince(storage)).resolves.toBeNull();
    await expect(readSavedWorkspace(storage)).resolves.toEqual({ orgId: 'org-a', ownerId: null });
  });

  it("answers none with only this build's value saved, an empty older key, or nothing", async () => {
    const own = memory({ [SAVED_WORKSPACE_STORAGE_KEY]: value('org-b', 'u1') });
    await expect(readOlderBuildWorkspaceSince(own)).resolves.toBeNull();
    const empty = memory({
      [SAVED_WORKSPACE_STORAGE_KEY]: value('org-b', 'u1'),
      [LEGACY_ACTIVE_ORG_STORAGE_KEY]: '',
    });
    await expect(readOlderBuildWorkspaceSince(empty)).resolves.toBeNull();
    await expect(readOlderBuildWorkspaceSince(memory())).resolves.toBeNull();
  });

  it('is never what a request names or queued work carries: those read the one value first', async () => {
    const storage = memory({
      [SAVED_WORKSPACE_STORAGE_KEY]: value('org-b', 'u1'),
      [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-a',
    });
    const saved = await readSavedWorkspace(storage);
    expect(savedWorkspaceFor(saved, 'u1')).toBe('org-b');
    expect(ownSavedWorkspace(saved, 'u1')).toBe('org-b');
  });
});

describe('saveWorkspace: the workspace and its owner in one write', () => {
  it('writes ONE value holding both, then clears the older build key', async () => {
    const storage = memory({ [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-b' });
    await saveWorkspace(storage, 'org-a', 'u1');
    expect(storage.setItem.mock.calls).toEqual([
      [SAVED_WORKSPACE_STORAGE_KEY, value('org-a', 'u1')],
    ]);
    expect(storage.removeItem.mock.calls).toEqual([[LEGACY_ACTIVE_ORG_STORAGE_KEY]]);
    expect([...storage.store.keys()]).toEqual([SAVED_WORKSPACE_STORAGE_KEY]);
    await expect(readSavedWorkspace(storage)).resolves.toEqual({ orgId: 'org-a', ownerId: 'u1' });
  });

  it('never saves a workspace without its owner, nor an owner without a workspace', async () => {
    const storage = memory({ [SAVED_WORKSPACE_STORAGE_KEY]: value('org-a', 'u1') });
    await expect(saveWorkspace(storage, 'org-b', '')).rejects.toThrow();
    await expect(saveWorkspace(storage, '', 'u1')).rejects.toThrow();
    // @ts-expect-error the owner is required: a workspace is saved only with the account that chose it
    await expect(saveWorkspace(storage, 'org-b', null)).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    await expect(readSavedWorkspace(storage)).resolves.toEqual({ orgId: 'org-a', ownerId: 'u1' });
  });

  it('a failed write throws and leaves the previous record as it was, the older key included', async () => {
    const owned = memory({ [SAVED_WORKSPACE_STORAGE_KEY]: value('org-a', 'u1') });
    owned.setItem.mockRejectedValueOnce(new Error('database or disk is full'));
    await expect(saveWorkspace(owned, 'org-b', 'u1')).rejects.toThrow('database or disk is full');
    await expect(readSavedWorkspace(owned)).resolves.toEqual({ orgId: 'org-a', ownerId: 'u1' });

    const older = memory({ [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-c' });
    older.setItem.mockRejectedValueOnce(new Error('database or disk is full'));
    await expect(saveWorkspace(older, 'org-b', 'u1')).rejects.toThrow();
    expect(older.removeItem).not.toHaveBeenCalled();
    await expect(readSavedWorkspace(older)).resolves.toEqual({ orgId: 'org-c', ownerId: null });
  });

  it('a failed clear of the older key still saves: the one value is read first', async () => {
    const storage = memory({ [LEGACY_ACTIVE_ORG_STORAGE_KEY]: 'org-c' });
    storage.removeItem.mockRejectedValueOnce(new Error('storage unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(saveWorkspace(storage, 'org-a', 'u1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await expect(readSavedWorkspace(storage)).resolves.toEqual({ orgId: 'org-a', ownerId: 'u1' });
  });
});

describe('the keys', () => {
  it('sit under the workspace. prefix, so every sign-out and eviction that forgets the workspace forgets it whole', () => {
    expect(SAVED_WORKSPACE_STORAGE_KEY).toBe('workspace.savedOrg');
    expect(LEGACY_ACTIVE_ORG_STORAGE_KEY).toBe('workspace.activeOrgId');
    expect(
      accountScopedStorageKeys([SAVED_WORKSPACE_STORAGE_KEY, LEGACY_ACTIVE_ORG_STORAGE_KEY]).sort(),
    ).toEqual([LEGACY_ACTIVE_ORG_STORAGE_KEY, SAVED_WORKSPACE_STORAGE_KEY].sort());
  });
});
