import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryWorkspace, setActiveOrg, setActiveWarehouse, useWorkspace } from './use-workspace';

// The same harness as use-workspace.recovery.test.ts, in a file of its own:
// the workspace state is module-level, and these tests leave reads that never
// answer behind them on purpose.
//
// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform.
// React is replaced so calling useWorkspace() runs its effects at once (a
// mount); everything else use-workspace.ts reaches for is faked, so the real
// hydrate, retryWorkspace, setActiveOrg and setActiveWarehouse run under node.

type Published = {
  activeOrgId: string | null;
  loading: boolean;
  orgs: unknown[];
  warehouses: { id: string; name: string }[];
  activeWarehouseId: string | null;
  activeWarehouseName: string | null;
};
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
vi.mock('./sync', () => ({ syncNow: vi.fn(async () => {}) }));

const gate = vi.hoisted(() => ({
  // Every membership, profile or warehouse read waits on its promise while set.
  holdMemberships: null as Promise<void> | null,
  holdProfile: null as Promise<void> | null,
  holdWarehouses: null as Promise<void> | null,
  // The warehouse read answers with an error (offline: postgrest-js status 0).
  failWarehouses: false,
}));
vi.mock('./supabase', () => {
  const offline = {
    data: null,
    error: { message: 'TypeError: Network request failed' },
    status: 0,
  };
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => {
      if (gate.holdMemberships) await gate.holdMemberships;
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
    maybeSingle: async () => {
      if (gate.holdProfile) await gate.holdProfile;
      return { data: { default_organization_id: 'org-a' }, error: null };
    },
  };
  const warehouses = {
    select: () => warehouses,
    eq: () => warehouses,
    order: async () => {
      if (gate.holdWarehouses) await gate.holdWarehouses;
      if (gate.failWarehouses) return offline;
      return {
        data: [
          { id: 'wh-1', name: 'Main', status: 'active' },
          { id: 'wh-2', name: 'Annex', status: 'active' },
        ],
        error: null,
      };
    },
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

const NEVER = () => new Promise<void>(() => {}); // a socket that never answers

const settled = async () => {
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

/** The next launch, or the next sign-in: a new account epoch, so nothing
 *  already on screen is kept (hydrate keeps only this account's workspace). */
const relaunch = () => {
  emitAuth(null);
  emitAuth('u1');
};

const LABEL_B = 'workspace.activeWarehouseLabel.org-b';

emitAuth('u1'); // the first auth event only records who is signed in

afterEach(() => {
  gate.holdMemberships = null;
  gate.holdProfile = null;
  gate.holdWarehouses = null;
  gate.failWarehouses = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// B24: React Native's fetch has no timeout of its own, and the membership and
// default-organization reads had none either, so one request that never
// answered kept every screen on its spinner for good (the warehouse read was
// bounded to 15 s already). Mutation caught: the unbounded reads.
describe('the membership and default-organization reads are bounded', () => {
  it('a membership read that never answers releases a first load after 15 s, and a retry then loads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    gate.holdMemberships = NEVER();
    useWorkspace();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(published.at(-1)?.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    // A failed read: no workspace yet, said with Try again, never a spinner.
    expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: null });
    expect(console.warn).toHaveBeenCalledWith('[workspace] loadOrgs timed out');

    gate.holdMemberships = null;
    vi.useRealTimers();
    await retryWorkspace();
    expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: 'org-a' });
  });

  it('a default-organization read that never answers lets the load go on after 15 s, with the saved workspace', async () => {
    relaunch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.set('workspace.activeOrgId', 'org-b');
    vi.useFakeTimers();
    gate.holdProfile = NEVER();
    useWorkspace();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(published.at(-1)?.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: 'org-b' });
  });
});

// B24: on a slow first load the warehouse read timed out (or failed) with no
// warehouse list on screen to keep, the saved warehouse was not in the empty
// list, and the whole app quietly widened to All warehouses until something
// loaded the workspace again. The saved warehouse is now kept by the name
// saved with it, and the list is read again on the next retry. Mutation
// caught: `warehouses = read ?? []` on a read that did not answer.
describe('a slow first load keeps the saved warehouse', () => {
  it('a good load saves the chosen warehouse with its name', async () => {
    relaunch();
    store.set('workspace.activeOrgId', 'org-b');
    store.set('workspace.activeWarehouseId.org-b', 'wh-2');
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({
      activeOrgId: 'org-b',
      activeWarehouseId: 'wh-2',
      activeWarehouseName: 'Annex',
    });
    expect(JSON.parse(store.get(LABEL_B) ?? 'null')).toEqual({ id: 'wh-2', name: 'Annex' });
  });

  it('the next launch on a slow network shows the saved warehouse, by name, not All warehouses', async () => {
    relaunch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    gate.holdWarehouses = NEVER();
    const before = published.length;
    useWorkspace();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(published.at(-1)).toMatchObject({
      loading: false,
      activeOrgId: 'org-b',
      activeWarehouseId: 'wh-2',
      activeWarehouseName: 'Annex',
    });
    expect(published.at(-1)?.warehouses).toEqual([{ id: 'wh-2', name: 'Annex' }]);
    // Never All warehouses on the way.
    expect(
      published
        .slice(before)
        .some((s) => s.activeOrgId === 'org-b' && s.activeWarehouseId === null),
    ).toBe(false);
  });

  it('the next retry reads the list again, quietly (no spinner), and keeps the choice', async () => {
    gate.holdWarehouses = null;
    const before = published.length;
    await retryWorkspace();
    expect(published.at(-1)).toMatchObject({
      loading: false,
      activeOrgId: 'org-b',
      activeWarehouseId: 'wh-2',
      activeWarehouseName: 'Annex',
    });
    expect(published.at(-1)?.warehouses.map((w) => w.id)).toEqual(['wh-1', 'wh-2']);
    expect(published.slice(before).some((s) => s.loading)).toBe(false);

    // Read now: a retry has nothing to do.
    storage.getItem.mockClear();
    const after = published.length;
    await retryWorkspace();
    expect(published.length).toBe(after);
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('a name saved for another warehouse is not used: All warehouses as before, until the retry', async () => {
    store.set(LABEL_B, JSON.stringify({ id: 'wh-1', name: 'Main' }));
    relaunch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.failWarehouses = true;
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({
      activeOrgId: 'org-b',
      activeWarehouseId: null,
      activeWarehouseName: null,
    });
    expect(store.get('workspace.activeWarehouseId.org-b')).toBe('wh-2'); // untouched

    gate.failWarehouses = false;
    await retryWorkspace();
    expect(published.at(-1)).toMatchObject({
      activeWarehouseId: 'wh-2',
      activeWarehouseName: 'Annex',
    });
    expect(JSON.parse(store.get(LABEL_B) ?? 'null')).toEqual({ id: 'wh-2', name: 'Annex' });
  });

  it('choosing a warehouse saves its name with it; All warehouses clears both', async () => {
    await setActiveWarehouse('wh-1');
    expect(store.get('workspace.activeWarehouseId.org-b')).toBe('wh-1');
    expect(JSON.parse(store.get(LABEL_B) ?? 'null')).toEqual({ id: 'wh-1', name: 'Main' });
    await setActiveWarehouse(null);
    expect(store.has('workspace.activeWarehouseId.org-b')).toBe(false);
    expect(store.has(LABEL_B)).toBe(false);
  });

  it("a switch whose warehouse read fails keeps the new workspace's saved warehouse, and a retry reads its list", async () => {
    store.set('workspace.activeWarehouseId.org-a', 'wh-1');
    store.set('workspace.activeWarehouseLabel.org-a', JSON.stringify({ id: 'wh-1', name: 'Main' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.failWarehouses = true;
    await setActiveOrg('org-a');
    expect(published.at(-1)).toMatchObject({
      activeOrgId: 'org-a',
      activeWarehouseId: 'wh-1',
      activeWarehouseName: 'Main',
    });
    expect(published.at(-1)?.warehouses).toEqual([{ id: 'wh-1', name: 'Main' }]);

    gate.failWarehouses = false;
    await retryWorkspace();
    expect(published.at(-1)).toMatchObject({ activeOrgId: 'org-a', activeWarehouseId: 'wh-1' });
    expect(published.at(-1)?.warehouses.map((w) => w.id)).toEqual(['wh-1', 'wh-2']);
  });
});
