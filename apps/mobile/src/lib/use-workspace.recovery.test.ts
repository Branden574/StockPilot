import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryWorkspace, setActiveOrg, useWorkspace } from './use-workspace';

// The same harness as use-workspace.hydrate.test.ts, in a file of its own: the
// workspace state is module-level, and that file leaves a load hanging on
// purpose ("an older hydrate that finishes clears loading even while a newer
// one hangs"), which would hold every retry below.
//
// vi.mock / vi.hoisted are hoisted above these imports by vitest's transform.
// React is replaced so calling useWorkspace() runs its effects at once (a
// mount); everything else use-workspace.ts reaches for is faked, so the real
// hydrate, retryWorkspace and setActiveOrg run under node.

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
  // The membership read answers with an error (offline: postgrest-js status 0).
  failMemberships: false,
  // The warehouse read answers with an error.
  failWarehouses: false,
  // Holds only the NEXT warehouse read.
  nextWarehouses: null as Promise<void> | null,
}));
vi.mock('./supabase', () => {
  const offline = { data: null, error: { message: 'TypeError: Network request failed' }, status: 0 };
  const members = {
    select: () => members,
    eq: () => members,
    not: async () =>
      gate.failMemberships
        ? offline
        : {
            data: [
              { role: 'staff', organization_id: 'org-a', organizations: { name: 'A' } },
              { role: 'staff', organization_id: 'org-b', organizations: { name: 'B' } },
            ],
            error: null,
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

const settled = async () => {
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

emitAuth('u1'); // the first auth event only records who is signed in

afterEach(() => {
  gate.failMemberships = false;
  gate.failWarehouses = false;
  gate.nextWarehouses = null;
  vi.restoreAllMocks();
});

// Review 2026-09-26: a warehouse read that failed inside an otherwise good
// load counted as "no warehouses". The saved warehouse was not in the empty
// list, so the active warehouse went null for the WHOLE APP and every list
// (and the cycle-count New picker) quietly widened to all warehouses. Mutation
// caught: loadWarehouses answering [] on an error.
describe('a failed warehouse read keeps the warehouses on screen', () => {
  it('the active warehouse and its list stay through a load whose warehouse read fails', async () => {
    await setActiveOrg('org-b');
    store.set('workspace.activeOrgId', 'org-b');
    store.set('workspace.activeWarehouseId.org-b', 'wh-1');
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({ activeOrgId: 'org-b', activeWarehouseId: 'wh-1', activeWarehouseName: 'Main' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.failWarehouses = true; // the next screen that mounts, on flaky Wi-Fi
    const before = published.length;
    useWorkspace();
    await settled();

    expect(published.at(-1)).toMatchObject({ activeOrgId: 'org-b', activeWarehouseId: 'wh-1', activeWarehouseName: 'Main' });
    expect(published.at(-1)?.warehouses.map((w) => w.id)).toEqual(['wh-1', 'wh-2']);
    expect(published.slice(before).some((s) => s.activeWarehouseId === null)).toBe(false);
    // The saved choice is untouched.
    expect(store.get('workspace.activeWarehouseId.org-b')).toBe('wh-1');
  });

  it('a successful read still applies what it finds', async () => {
    store.set('workspace.activeWarehouseId.org-b', 'wh-2');
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({ activeOrgId: 'org-b', activeWarehouseId: 'wh-2', activeWarehouseName: 'Annex' });
  });

  // The load read its warehouses without a bound, so a request that never
  // answered kept `loading` true for good. Mutation caught: the unbounded read.
  it('a warehouse read that never answers releases the load after 15 s, keeping what is shown', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      gate.nextWarehouses = new Promise<void>(() => {}); // a socket that never answers
      useWorkspace();
      await vi.advanceTimersByTimeAsync(14_000);
      expect(published.at(-1)?.loading).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(published.at(-1)).toMatchObject({ loading: false, activeOrgId: 'org-b', activeWarehouseId: 'wh-2' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Review 2026-09-26: a launch offline (or a failed first membership read after
// signing in) leaves no workspace, and nothing loaded it again until another
// screen mounted: a rental opened from a notification spun with nothing to tap
// after the connection came back. Mutation caught: no retryWorkspace.
describe('retryWorkspace: no workspace is not the end', () => {
  it('after a failed first read for this account, a retry loads the workspace', async () => {
    // A new account epoch (signed out and in): nothing on screen may be kept.
    emitAuth(null);
    emitAuth('u1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.failMemberships = true;
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({ activeOrgId: null, loading: false });

    // Still offline: the retry fails the same way, and loading ends.
    await retryWorkspace();
    expect(published.at(-1)).toMatchObject({ activeOrgId: null, loading: false });

    // Back online.
    gate.failMemberships = false;
    await retryWorkspace();
    expect(published.at(-1)?.loading).toBe(false);
    expect(published.at(-1)?.activeOrgId).not.toBeNull();
    expect(published.at(-1)?.orgs).toHaveLength(2);
  });

  it('does nothing while a workspace is shown', async () => {
    useWorkspace();
    await settled();
    expect(published.at(-1)?.activeOrgId).not.toBeNull();
    storage.getItem.mockClear();
    const before = published.length;
    await retryWorkspace();
    expect(published.length).toBe(before);
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it('does nothing with nobody signed in, and nothing for an account that has gone', async () => {
    emitAuth(null);
    emitAuth('u1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.failMemberships = true;
    useWorkspace();
    await settled();
    expect(published.at(-1)?.activeOrgId).toBeNull();
    gate.failMemberships = false;

    emitAuth(null); // signed out
    storage.getItem.mockClear();
    const before = published.length;
    await retryWorkspace();
    expect(published.length).toBe(before);
    expect(storage.getItem).not.toHaveBeenCalled();
    emitAuth('u1');
  });

  it('one load at a time: a retry while a load runs starts nothing new', async () => {
    emitAuth(null);
    emitAuth('u1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gate.failMemberships = true;
    useWorkspace();
    await settled();
    gate.failMemberships = false;

    // A retry, and a second one asked for while the first runs.
    const first = retryWorkspace();
    const second = retryWorkspace();
    expect(second).toBe(first);
    await first;
    expect(published.at(-1)?.activeOrgId).not.toBeNull();
  });
});

// useSync (the app root's sync loop) imports React Native, so its wiring is
// pinned by source text. Mutation caught: a useSync that never retried the
// workspace, which left a launch offline without one until another screen
// mounted online.
describe('useSync loads the workspace again when none is shown', () => {
  const src = readFileSync(path.join(__dirname, 'use-sync.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('on each sync tick and on every return to the foreground', () => {
    expect(src).toContain("import { retryWorkspace } from './use-workspace';");
    expect(src).toMatch(/setInterval\(\(\) => \{[\s\S]*?void syncNow\(\);\s*void retryWorkspace\(\);/);
    expect(src).toMatch(/if \(state === 'active'\) \{\s*void syncNow\(\);\s*void retryWorkspace\(\);/);
  });

  it('when the connection comes back (the rule sync.ts isOnline() applies), and stops listening on sign-out', () => {
    expect(src).toContain("import * as Network from 'expo-network';");
    expect(src).toContain("import { isOfflineState } from './exceptions-api';");
    expect(src).toMatch(
      /const netSub = Network\.addNetworkStateListener\(\(state\) => \{\s*if \(!cancelled && !isOfflineState\(state\)\) void retryWorkspace\(\);\s*\}\);/,
    );
    expect(src).toMatch(/return \(\) => \{[\s\S]*?netSub\.remove\(\);[\s\S]*?\};/);
  });
});
