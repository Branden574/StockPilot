import { describe, expect, it, vi } from 'vitest';

import { endAccountEpoch } from './account-epoch';
import { setActiveOrg, useWorkspace } from './use-workspace';

// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform.
// React is replaced so calling useWorkspace() runs its effects at once (a
// mount); everything else use-workspace.ts reaches for is faked, so the real
// hydrate and setActiveOrg run under node.

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
  // The listener use-workspace.ts registers with supabase.auth at import.
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
vi.mock('./sync', () => ({ syncNow: vi.fn(async () => {}) }));

// The membership read can be held open to overlap a switch.
const gate = vi.hoisted(() => ({
  memberships: Promise.resolve() as Promise<void>,
  // Holds only the NEXT warehouse read.
  nextWarehouses: null as Promise<void> | null,
}));
vi.mock('./supabase', () => {
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => {
      await gate.memberships;
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
  // u1's default is A, u2's is C.
  let profileId = '';
  const profiles = {
    select: () => profiles,
    eq: (_col: string, id: string) => {
      profileId = id;
      return profiles;
    },
    maybeSingle: async () => ({
      data: { default_organization_id: profileId === 'u2' ? 'org-c' : 'org-a' },
      error: null,
    }),
  };
  const warehouses = {
    select: () => warehouses,
    eq: () => warehouses,
    order: async () => {
      const held = gate.nextWarehouses;
      gate.nextWarehouses = null;
      if (held) await held;
      return { data: [], error: null };
    },
  };
  return {
    supabase: {
      from: (t: string) => (t === 'organization_members' ? members : t === 'user_profiles' ? profiles : warehouses),
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
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

emitAuth('u1'); // the first auth event only records who is signed in

describe('hydrate and workspace switches agree on the workspace', () => {
  it('a switch made while hydrate reads memberships stands: the screen shows the switched workspace', async () => {
    store.set('workspace.activeOrgId', 'org-a');
    useWorkspace(); // first mount
    await settled();
    expect(published.at(-1)?.activeOrgId).toBe('org-a');

    // Another screen mounts (or the token refreshes): a hydrate whose
    // membership read is slow. The person switches to B meanwhile.
    const release = holdMemberships();
    useWorkspace();
    await setActiveOrg('org-b');
    expect(store.get('workspace.activeOrgId')).toBe('org-b');
    release();
    await settled();

    // The screen and every request (the stored workspace) agree on B.
    expect(published.at(-1)?.activeOrgId).toBe('org-b');
    expect(store.get('workspace.activeOrgId')).toBe('org-b');
    // And tapping A really switches back.
    await setActiveOrg('org-a');
    expect(store.get('workspace.activeOrgId')).toBe('org-a');
    expect(published.at(-1)?.activeOrgId).toBe('org-a');
  });

  it('with nothing saved yet, a switch during the reads is not overwritten by the default', async () => {
    store.delete('workspace.activeOrgId'); // fresh sign-in; the profile default is org-a
    const release = holdMemberships();
    useWorkspace();
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith('workspace.activeOrgId'));
    await setActiveOrg('org-b');
    release();
    await settled();
    expect(store.get('workspace.activeOrgId')).toBe('org-b');
    expect(published.at(-1)?.activeOrgId).toBe('org-b');
  });

  it('a switch made while hydrate reads warehouses stands as well', async () => {
    await setActiveOrg('org-a'); // start from A, whatever the previous test left
    store.set('workspace.activeOrgId', 'org-a');
    let release!: () => void;
    gate.nextWarehouses = new Promise<void>((resolve) => {
      release = resolve;
    });
    useWorkspace(); // hydrate decides A and reads A's warehouses (held)
    await vi.waitFor(() => expect(gate.nextWarehouses).toBeNull());
    await setActiveOrg('org-b'); // the switch does not wait for the hydrate
    expect(published.at(-1)?.activeOrgId).toBe('org-b');
    release();
    await settled();
    expect(published.at(-1)?.activeOrgId).toBe('org-b');
    expect(store.get('workspace.activeOrgId')).toBe('org-b');
  });

  it('an older hydrate that finishes clears loading even while a newer one hangs', async () => {
    const releaseFirst = holdMemberships();
    useWorkspace(); // older hydrate, reads held
    const firstGate = gate.memberships;
    gate.memberships = new Promise<void>(() => {}); // the newer hydrate's read never answers
    useWorkspace();
    gate.memberships = firstGate;
    releaseFirst();
    await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
    gate.memberships = Promise.resolve();
  });

  it('an eviction during a hydrate does not save a workspace back', async () => {
    store.set('workspace.activeOrgId', 'org-b'); // a valid saved choice, read at the start
    const release = holdMemberships();
    useWorkspace();
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith('workspace.activeOrgId'));
    // Account eviction clears the account-scoped keys while the reads are out.
    store.delete('workspace.activeOrgId');
    storage.setItem.mockClear();
    release();
    await settled();
    expect(storage.setItem.mock.calls.filter(([k]) => k === 'workspace.activeOrgId')).toEqual([]);
    expect(store.has('workspace.activeOrgId')).toBe(false);
  });

  it('a failed save still shows the workspace and clears loading', async () => {
    store.delete('workspace.activeOrgId');
    storage.setItem.mockImplementationOnce(async () => {
      throw new Error('database or disk is full');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: 'org-a' });
    expect(published.at(-1)?.orgs).toHaveLength(3);
    warn.mockRestore();
  });

  it('a token refresh (same user) does not cancel a load', async () => {
    await setActiveOrg('org-b');
    store.set('workspace.activeOrgId', 'org-b');
    const release = holdMemberships();
    useWorkspace();
    emitAuth('u1'); // TOKEN_REFRESHED: a new session object, the same user
    release();
    await settled();
    expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: 'org-b' });
  });
});

describe('workspace work for an account that is gone saves and shows nothing', () => {
  it('a load in flight across an account eviction saves no workspace back', async () => {
    store.delete('workspace.activeOrgId'); // nothing saved yet: the load would save the default
    const release = holdMemberships();
    useWorkspace();
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith('workspace.activeOrgId'));
    endAccountEpoch(); // the eviction's clearAccountStorage, before it removes the keys
    storage.setItem.mockClear();
    const before = published.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(published.length).toBe(before);
  });

  it("the previous user's load landing after the next user's saves and shows nothing", async () => {
    auth.user = { id: 'u1' };
    store.delete('workspace.activeOrgId');
    // u1's load waits on its membership read.
    let releaseU1!: () => void;
    gate.memberships = new Promise<void>((resolve) => {
      releaseU1 = resolve;
    });
    useWorkspace();
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith('workspace.activeOrgId'));
    gate.memberships = Promise.resolve();
    // u1 signs out and u2 signs in; u2's load runs to the end.
    emitAuth(null);
    emitAuth('u2');
    auth.user = { id: 'u2' };
    useWorkspace();
    await settled();
    expect(store.get('workspace.activeOrgId')).toBe('org-c');
    expect(published.at(-1)?.activeOrgId).toBe('org-c');
    // Now u1's stale load lands.
    releaseU1();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get('workspace.activeOrgId')).toBe('org-c');
    expect(published.at(-1)?.activeOrgId).toBe('org-c');
    emitAuth(null);
    emitAuth('u1');
    auth.user = { id: 'u1' };
  });

  it('a switch still queued at sign-out never runs', async () => {
    await setActiveOrg('org-a');
    let releaseSlow!: () => void;
    gate.nextWarehouses = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = setActiveOrg('org-b'); // held in its warehouse read
    await vi.waitFor(() => expect(gate.nextWarehouses).toBeNull());
    const queued = setActiveOrg('org-c'); // tapped before the sign-out, waiting its turn
    emitAuth(null); // sign-out
    storage.setItem.mockClear();
    releaseSlow();
    await Promise.all([slow, queued]);
    expect(storage.setItem.mock.calls.filter(([k]) => k === 'workspace.activeOrgId')).toEqual([]);
    emitAuth('u1');
  });
});
