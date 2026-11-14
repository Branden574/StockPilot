import { describe, expect, it, vi } from 'vitest';

import { countSelection } from './use-count-selection';
import { setActiveOrg, useWorkspace } from './use-workspace';

/**
 * THE ITEMS PICKED FOR A COUNT BELONG TO ONE ACCOUNT IN ONE WORKSPACE
 * (S75, from B127).
 *
 * The Items and Books tabs' picks for a cycle count live in a module-level
 * store (use-count-selection.ts) that only Start and Clear emptied, so after
 * a sign-out and another account's sign-in on the same phone, Select showed
 * "N selected" and the review listed the earlier account's item names and
 * SKUs. use-workspace.ts now empties it whenever the signed-in account
 * changes (a sign-out included) and on a workspace switch. A token refresh
 * for the same account keeps it.
 *
 * The harness is use-workspace.saved-access.test.ts's: React replaced so
 * useWorkspace() runs its effects at once, everything else faked; the store
 * is the real one.
 */

type Published = { activeOrgId: string | null; loading: boolean; orgs: unknown[] };
const published = vi.hoisted(() => [] as Published[]);
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (v: unknown) => [
      v,
      (next: Published) => {
        published.push(next);
      },
    ],
    useEffect: (fn: () => unknown) => {
      fn();
    },
  };
});

const auth = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
const emitAuth = (id: string | null, event = id ? 'SIGNED_IN' : 'SIGNED_OUT') =>
  auth.listener?.(event, id ? { user: { id } } : null);
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
vi.mock('./use-effective-permissions', () => ({
  refreshEffectivePermissions: vi.fn(async () => {}),
}));
vi.mock('./warehouse-scope', () => ({ refreshWarehouseScope: vi.fn(async () => {}) }));
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn(async () => {}) }));
vi.mock('./use-cache-owner', () => ({ refreshCacheOwner: vi.fn(async () => {}) }));
vi.mock('./sync', () => ({
  syncNow: vi.fn(async () => {}),
  syncAfterRunning: vi.fn(async () => {}),
}));
vi.mock('./cycle-count-sync', () => ({ cycleCountSync: { forceSync: vi.fn(async () => {}) } }));
vi.mock('./supabase', () => {
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => ({
      data: [
        { role: 'staff', organization_id: 'org-a', organizations: { name: 'A' } },
        { role: 'staff', organization_id: 'org-b', organizations: { name: 'B' } },
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

const settled = async () => {
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

const pick = (id: string) => ({ id, sku: `SKU-${id}`, name: `Made-up ${id}`, itemType: 'product' });

emitAuth('u1'); // the first auth event only records who is signed in

describe('the picks for a count', () => {
  it('another account signs in: emptied', () => {
    countSelection.add([pick('i-1'), pick('i-2')]);
    emitAuth('u2');
    expect(countSelection.has('i-1')).toBe(false);
    expect(countSelection.has('i-2')).toBe(false);
  });

  it('a sign-out: emptied', () => {
    emitAuth('u1');
    countSelection.add([pick('i-3')]);
    emitAuth(null);
    expect(countSelection.has('i-3')).toBe(false);
  });

  it('a token refresh for the same account: kept', () => {
    emitAuth('u1');
    countSelection.add([pick('i-4')]);
    emitAuth('u1', 'TOKEN_REFRESHED');
    expect(countSelection.has('i-4')).toBe(true);
    countSelection.clear();
  });

  it('a workspace switch: emptied', async () => {
    auth.user = { id: 'u1' };
    store.set('workspace.savedOrg', JSON.stringify({ orgId: 'org-a', ownerId: 'u1' }));
    useWorkspace();
    await settled();
    expect(published.at(-1)?.activeOrgId).toBe('org-a');
    countSelection.add([pick('i-5')]);
    await setActiveOrg('org-b');
    expect(countSelection.has('i-5')).toBe(false);
  });
});
