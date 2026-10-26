import { describe, expect, it, vi } from 'vitest';

import { endAccountEpoch } from './account-epoch';
import {
  getWorkspaceSnapshot,
  setActiveOrg,
  useWorkspace,
  workspaceShownForAccount,
} from './use-workspace';

// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform.
// As in use-workspace.hydrate.test.ts: React is replaced so calling
// useWorkspace() runs its effects at once (a screen mounting), and everything
// else use-workspace.ts reaches for is faked, so the real load and switch run
// under node.

vi.mock('react', () => ({
  useState: (v: unknown) => [v, () => {}],
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));

const auth = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  // The listener use-workspace.ts registers with supabase.auth at import.
  listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
const emitAuth = (id: string | null) =>
  auth.listener?.(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? { user: { id } } : null);
vi.mock('./auth-context', () => ({ useAuth: () => ({ user: auth.user }) }));

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  },
}));
vi.mock('./db', () => ({ deleteOrgData: vi.fn(async () => {}) }));
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn() }));
vi.mock('./sync', () => ({ syncNow: vi.fn(async () => {}) }));

// The membership read can be held open, as a slow connection holds it.
const gate = vi.hoisted(() => ({ memberships: Promise.resolve() as Promise<void> }));
const reads = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock('./supabase', () => {
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => {
      await gate.memberships;
      return {
        data: [
          { role: 'admin', organization_id: 'org-a', organizations: { name: 'A' } },
          { role: 'admin', organization_id: 'org-b', organizations: { name: 'B' } },
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
      from: (t: string) => {
        reads.tables.push(t);
        return t === 'organization_members'
          ? members
          : t === 'user_profiles'
            ? profiles
            : warehouses;
      },
      auth: {
        onAuthStateChange: (cb: typeof auth.listener) => {
          auth.listener = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    },
  };
});

const holdMemberships = () => {
  let release!: () => void;
  gate.memberships = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    release();
    gate.memberships = Promise.resolve();
  };
};
const settled = async () => {
  await vi.waitFor(() => expect(getWorkspaceSnapshot().loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

emitAuth('u1'); // the first auth event only records who is signed in

/**
 * Review 3 of the iPhone push tap (2026-10-13): a tapped order or return
 * waited, with nothing on screen, for ANY workspace load, and every screen
 * that mounts useWorkspace() (useOrg, useRole) starts one and publishes
 * loading:true. A reload keeps the workspace on screen, so the tap can decide
 * from it; only the first load for an account has nothing to show yet.
 * workspaceShownForAccount() tells the two apart, and never counts a
 * workspace chosen for an account that has since signed out or changed (the
 * same rule hydrate applies before it keeps a workspace through a failed read).
 */
describe('workspaceShownForAccount: a workspace chosen for the account signed in now is on screen', () => {
  it('a cold start: nothing is shown until the first load answers', async () => {
    expect(workspaceShownForAccount()).toBe(false);
    const release = holdMemberships();
    useWorkspace(); // the first screen mounts
    expect(getWorkspaceSnapshot().loading).toBe(true);
    expect(workspaceShownForAccount()).toBe(false);
    release();
    await settled();
    expect(getWorkspaceSnapshot().activeOrgId).toBe('org-a');
    expect(workspaceShownForAccount()).toBe(true);
  });

  it('a reload keeps it: loading is true again, and the workspace on screen still counts', async () => {
    const release = holdMemberships();
    useWorkspace(); // another screen mounts and loads the workspace again
    expect(getWorkspaceSnapshot()).toMatchObject({ loading: true, activeOrgId: 'org-a' });
    expect(workspaceShownForAccount()).toBe(true);
    release();
    await settled();
    expect(workspaceShownForAccount()).toBe(true);
  });

  it('a switch shows the workspace it chose', async () => {
    await setActiveOrg('org-b');
    expect(getWorkspaceSnapshot().activeOrgId).toBe('org-b');
    expect(workspaceShownForAccount()).toBe(true);
  });

  it('a change of account ends it at once, before any screen clears the workspace', async () => {
    emitAuth(null); // signed out: no screen has re-rendered yet
    expect(getWorkspaceSnapshot().activeOrgId).toBe('org-b');
    expect(workspaceShownForAccount()).toBe(false);
    emitAuth('u2'); // another account signs in
    auth.user = { id: 'u2' };
    expect(workspaceShownForAccount()).toBe(false);
    // Its first load: the previous account's workspace is still published,
    // and never counts for this one.
    const release = holdMemberships();
    useWorkspace();
    expect(getWorkspaceSnapshot()).toMatchObject({ loading: true, activeOrgId: 'org-b' });
    expect(workspaceShownForAccount()).toBe(false);
    release();
    await settled();
    expect(workspaceShownForAccount()).toBe(true);
  });

  it('a sign-out a screen sees clears it', async () => {
    emitAuth(null);
    auth.user = null;
    useWorkspace();
    expect(getWorkspaceSnapshot()).toMatchObject({ loading: false, activeOrgId: null });
    expect(workspaceShownForAccount()).toBe(false);
    emitAuth('u1');
    auth.user = { id: 'u1' };
    useWorkspace();
    await settled();
    expect(workspaceShownForAccount()).toBe(true);
  });

  it('an eviction (the account epoch ends directly) ends it', () => {
    expect(workspaceShownForAccount()).toBe(true);
    endAccountEpoch();
    expect(workspaceShownForAccount()).toBe(false);
  });

  it('only looks at what is published: it reads nothing and starts no load', () => {
    reads.tables.length = 0;
    const before = getWorkspaceSnapshot();
    workspaceShownForAccount();
    expect(reads.tables).toEqual([]);
    expect(getWorkspaceSnapshot()).toBe(before);
  });
});
