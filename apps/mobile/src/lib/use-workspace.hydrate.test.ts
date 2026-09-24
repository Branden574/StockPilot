import { describe, expect, it, vi } from 'vitest';

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

const auth = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
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

describe('hydrate and workspace switches agree on the workspace', () => {
  it('a hydrate whose reads overlap a switch applies after it: the screen shows the switched workspace', async () => {
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

  it('a switch made while hydrate reads warehouses waits for it, then applies', async () => {
    store.set('workspace.activeOrgId', 'org-a');
    let release!: () => void;
    gate.nextWarehouses = new Promise<void>((resolve) => {
      release = resolve;
    });
    useWorkspace(); // hydrate decides A and reads A's warehouses (held)
    await vi.waitFor(() => expect(gate.nextWarehouses).toBeNull());
    const toB = setActiveOrg('org-b');
    // Give the switch every chance to finish on its own; it must wait instead.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get('workspace.activeOrgId')).toBe('org-a');
    release();
    await toB;
    await settled();
    expect(published.at(-1)?.activeOrgId).toBe('org-b');
    expect(store.get('workspace.activeOrgId')).toBe('org-b');
  });

  it('a hydrate overtaken by a sign-out publishes nothing afterwards', async () => {
    const release = holdMemberships();
    useWorkspace(); // hydrate for u1, reads held open
    auth.user = null;
    useWorkspace(); // signed out: the empty workspace is published
    expect(published.at(-1)).toMatchObject({ activeOrgId: null, loading: false, orgs: [] });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(published.at(-1)).toMatchObject({ activeOrgId: null, orgs: [] });
    auth.user = { id: 'u1' };
  });
});
