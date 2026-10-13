import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getWorkspaceSnapshot, setActiveOrg, useWorkspaceSnapshot } from './use-workspace';

// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform.
// React is replaced so useWorkspaceSnapshot() can be called as a function: the
// fake useSyncExternalStore records the subscribe it is handed and answers
// the snapshot. Everything else use-workspace.ts reaches for is faked, as in
// use-workspace.switch.test.ts, so the real setActiveOrg runs under node.

const react = vi.hoisted(() => ({
  subscribe: null as null | ((onChange: () => void) => () => void),
  hydratingHooks: 0,
}));
vi.mock('react', () => ({
  useSyncExternalStore: (
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => {
    react.subscribe = subscribe;
    return getSnapshot();
  },
  // useWorkspace's own hooks: counted, so a snapshot read that hydrated
  // through them would show.
  useState: (v: unknown) => {
    react.hydratingHooks += 1;
    return [v, () => {}];
  },
  useEffect: () => {
    react.hydratingHooks += 1;
  },
}));

vi.mock('./auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
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
const reads = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock('./supabase', () => {
  const query = {
    select: () => query,
    eq: () => query,
    not: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    order: async () => ({ data: [{ id: 'w1', name: 'Main', status: 'active' }], error: null }),
  };
  return {
    supabase: {
      from: (t: string) => {
        reads.tables.push(t);
        return query;
      },
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    },
  };
});

/**
 * The notification host needs to know which workspace is on screen without
 * LOADING it: useWorkspace() hydrates on every mount (three reads) and
 * publishes loading:true to every screen while it does.
 */
describe('useWorkspaceSnapshot reads the published workspace without loading it', () => {
  beforeEach(() => {
    reads.tables.length = 0;
    react.hydratingHooks = 0;
  });

  it('subscribes to what is published, with no read and no loading:true', () => {
    const heard = vi.fn();
    const before = getWorkspaceSnapshot();
    const snapshot = useWorkspaceSnapshot();
    expect(snapshot).toBe(before);
    expect(react.subscribe).toBeTypeOf('function');
    const off = react.subscribe!(heard);
    expect(reads.tables).toEqual([]);
    expect(react.hydratingHooks).toBe(0);
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  it('hears every publish, and getWorkspaceSnapshot() answers the latest after a switch', async () => {
    useWorkspaceSnapshot();
    const heard = vi.fn();
    const off = react.subscribe!(heard);
    await setActiveOrg('org-b');
    expect(heard).toHaveBeenCalled();
    expect(getWorkspaceSnapshot()).toMatchObject({
      activeOrgId: 'org-b',
      warehouses: [{ id: 'w1', name: 'Main' }],
    });
    expect(useWorkspaceSnapshot()).toBe(getWorkspaceSnapshot());
    // The switch read warehouses only; the snapshot itself read nothing.
    expect(reads.tables).toEqual(['warehouses']);

    off();
    heard.mockClear();
    await setActiveOrg('org-c');
    expect(heard).not.toHaveBeenCalled();
    expect(getWorkspaceSnapshot().activeOrgId).toBe('org-c');
  });
});
