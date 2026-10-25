import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setActiveOrg, useWorkspace } from './use-workspace';

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
 * The harness is use-workspace.hydrate.test.ts's: React runs effects at once,
 * and storage, the database and Supabase are faked so the real hydrate and
 * setActiveOrg run under node.
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
  };
});

const ORG = 'workspace.activeOrgId';
const OWNER = 'workspace.activeOrgUserId';

const settled = async () => {
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

/** The workspace the last load or switch put on screen. */
const shown = () => published.at(-1)?.activeOrgId;

auth.listener?.('SIGNED_IN', { user: { id: 'u1' } }); // records who is signed in

beforeEach(() => {
  store.clear();
  storage.setItem.mockClear();
});

describe("the workspace load uses only this account's saved workspace", () => {
  it("another account's saved workspace is not chosen, even one this account belongs to", async () => {
    store.set(ORG, 'org-b');
    store.set(OWNER, 'u-previous');
    // Before: B was chosen (u1 is a member) while the header named none and
    // the server answered for A, u1's default.
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-a');
    expect(store.get(ORG)).toBe('org-a');
    expect(store.get(OWNER)).toBe('u1');
  });

  it("a workspace saved by an older build (no owner) stays, and is recorded as this account's", async () => {
    store.set(ORG, 'org-b');
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-b');
    expect(store.get(ORG)).toBe('org-b');
    expect(store.get(OWNER)).toBe('u1');
  });

  it("this account's saved workspace stays, and nothing is written", async () => {
    store.set(ORG, 'org-c');
    store.set(OWNER, 'u1');
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-c');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("nothing saved: the default is chosen and saved as this account's", async () => {
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-a');
    expect(store.get(ORG)).toBe('org-a');
    expect(store.get(OWNER)).toBe('u1');
  });
});

describe('a switch records whose workspace it saved', () => {
  it('the switched workspace is saved with the signed-in account as its owner', async () => {
    store.set(ORG, 'org-a');
    store.set(OWNER, 'u1');
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-a');
    await setActiveOrg('org-c');
    expect(store.get(ORG)).toBe('org-c');
    expect(store.get(OWNER)).toBe('u1');
  });

  it("a switch over another account's leftover owner replaces it", async () => {
    store.set(ORG, 'org-a');
    store.set(OWNER, 'u1');
    useWorkspace(); // a mount: a workspace load for u1
    await settled();
    expect(shown()).toBe('org-a');
    store.set(OWNER, 'u-previous'); // left by an older build's switch, say
    await setActiveOrg('org-b');
    expect(store.get(OWNER)).toBe('u1');
  });
});
