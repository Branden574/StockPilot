import { describe, expect, it, vi } from 'vitest';

import { accountScopedStorageKeys } from './account-eviction';
import {
  ACTIVE_ORG_OWNER_STORAGE_KEY,
  ACTIVE_ORG_STORAGE_KEY,
  readSavedWorkspace,
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
 */

describe('savedWorkspaceFor', () => {
  it('names the workspace this account saved', () => {
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: 'u1' }, 'u1')).toBe('org-a');
  });

  it("names none for another account's workspace: the server would refuse it", () => {
    expect(savedWorkspaceFor({ orgId: 'org-a', ownerId: 'u1' }, 'u2')).toBeNull();
  });

  it('names a workspace saved before owners were recorded, as every request did before', () => {
    // Naming none here would let the server answer for the default
    // organization while the screen shows the saved one.
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

describe('readSavedWorkspace', () => {
  it('reads the workspace and its owner, one getItem each', async () => {
    const values: Record<string, string> = {
      [ACTIVE_ORG_STORAGE_KEY]: 'org-a',
      [ACTIVE_ORG_OWNER_STORAGE_KEY]: 'u1',
    };
    const getItem = vi.fn(async (key: string) => values[key] ?? null);
    await expect(readSavedWorkspace({ getItem })).resolves.toEqual({
      orgId: 'org-a',
      ownerId: 'u1',
    });
    expect(getItem.mock.calls.map(([key]) => key).sort()).toEqual(
      [ACTIVE_ORG_OWNER_STORAGE_KEY, ACTIVE_ORG_STORAGE_KEY].sort(),
    );
  });

  it('reads an absent or empty key as nothing saved', async () => {
    await expect(readSavedWorkspace({ getItem: async () => null })).resolves.toEqual({
      orgId: null,
      ownerId: null,
    });
    await expect(readSavedWorkspace({ getItem: async () => '' })).resolves.toEqual({
      orgId: null,
      ownerId: null,
    });
  });

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

describe('the owner key', () => {
  it('sits under the workspace. prefix, so every sign-out and eviction that forgets the workspace forgets its owner', () => {
    expect(ACTIVE_ORG_OWNER_STORAGE_KEY).toBe('workspace.activeOrgUserId');
    expect(ACTIVE_ORG_STORAGE_KEY).toBe('workspace.activeOrgId');
    expect(
      accountScopedStorageKeys([ACTIVE_ORG_STORAGE_KEY, ACTIVE_ORG_OWNER_STORAGE_KEY]).sort(),
    ).toEqual([ACTIVE_ORG_STORAGE_KEY, ACTIVE_ORG_OWNER_STORAGE_KEY].sort());
  });
});
