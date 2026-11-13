import { describe, expect, it, vi } from 'vitest';

import { setActiveOrg, useWorkspace } from './use-workspace';

/**
 * A WORKSPACE IS SHOWN ONLY AFTER THE SAVED PERMISSIONS AND WAREHOUSE SCOPE
 * WERE READ AGAIN (B124).
 *
 * A switch, and the load's repair, delete the previous workspace's cached
 * rows together with its saved permissions, modules and warehouse scope
 * (db.ts deleteOrgData). The screens hold the saved permissions and scope in
 * memory and read them again only when told (db.ts states this duty), and
 * nothing told them: for seconds, or for good offline, Orders narrowed and
 * every saved-permission gate decided by the previous workspace's set. Now
 * both are told right after the wipe, and the new workspace is shown once
 * they have read again.
 *
 * The harness is use-workspace.hydrate.test.ts's: React replaced so
 * useWorkspace() runs its effects at once, everything else faked.
 */

type Published = { activeOrgId: string | null; loading: boolean; orgs: unknown[] };
const published = vi.hoisted(() => [] as Published[]);
// What happened, in order: the cache wipe, the re-reads, a workspace shown.
const events = vi.hoisted(() => [] as string[]);
const lastShown = vi.hoisted(() => ({ org: null as string | null }));
vi.mock('react', () => ({
  useState: (v: unknown) => [
    v,
    (next: Published) => {
      published.push(next);
      if (next.activeOrgId && next.activeOrgId !== lastShown.org) {
        lastShown.org = next.activeOrgId;
        events.push(`shown ${next.activeOrgId}`);
      }
    },
  ],
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
vi.mock('./db', () => ({
  deleteOrgData: vi.fn(async () => {
    events.push('wipe');
  }),
}));
// The saved permissions and warehouse scope: each re-read is held until the
// test lets it answer, so the test can see what waits for it.
const reread = vi.hoisted(() => ({ hold: Promise.resolve() as Promise<void> }));
vi.mock('./use-effective-permissions', () => ({
  refreshEffectivePermissions: vi.fn(async () => {
    events.push('permissions re-read asked');
    await reread.hold;
    events.push('permissions re-read');
  }),
}));
vi.mock('./warehouse-scope', () => ({
  refreshWarehouseScope: vi.fn(async () => {
    events.push('scope re-read asked');
    await reread.hold;
    events.push('scope re-read');
  }),
}));
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn() }));
vi.mock('./sync', () => ({
  syncNow: vi.fn(async () => {}),
  syncAfterRunning: vi.fn(async () => {}),
}));
vi.mock('./cycle-count-sync', () => ({ cycleCountSync: { forceSync: vi.fn(async () => {}) } }));

// The membership read can be held open to overlap a switch.
const gate = vi.hoisted(() => ({
  memberships: Promise.resolve() as Promise<void>,
  // The membership read answers with an error (offline: postgrest-js status 0).
  failMemberships: false,
  // Holds only the NEXT warehouse read.
  nextWarehouses: null as Promise<void> | null,
}));
vi.mock('./supabase', () => {
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => {
      await gate.memberships;
      if (gate.failMemberships) {
        return { data: null, error: { message: 'TypeError: Network request failed' }, status: 0 };
      }
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

// Re-pinned by docket B10 (integrator decision 3; these read and wrote the
// older single key, 'workspace.activeOrgId'): the saved workspace is one
// value, the workspace and the account that chose it, under
// 'workspace.savedOrg' (workspace-keys.ts).
const SAVED = 'workspace.savedOrg';
/** Save a workspace as this build does: with the account that chose it. */
const saveAs = (orgId: string, ownerId = 'u1') =>
  store.set(SAVED, JSON.stringify({ orgId, ownerId }));
emitAuth('u1'); // the first auth event only records who is signed in

const holdRereads = () => {
  let release!: () => void;
  reread.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    release();
    reread.hold = Promise.resolve();
  };
};

describe('the saved permissions and scope are read again before a workspace is shown', () => {
  it('a switch: wipe, both re-reads answered, then the new workspace', async () => {
    saveAs('org-a');
    useWorkspace();
    await settled();
    expect(published.at(-1)?.activeOrgId).toBe('org-a');

    events.length = 0;
    const release = holdRereads();
    const switching = setActiveOrg('org-b');
    await vi.waitFor(() => expect(events).toContain('scope re-read asked'));
    // Not shown while the re-reads have not answered.
    expect(events).not.toContain('shown org-b');
    release();
    await switching;
    expect(events).toEqual([
      'wipe',
      'permissions re-read asked',
      'scope re-read asked',
      'permissions re-read',
      'scope re-read',
      'shown org-b',
    ]);
  });

  it("the load's repair (another account's workspace was saved): the same order", async () => {
    // Another account left its workspace saved; this account's default is A.
    saveAs('org-c', 'u9');
    lastShown.org = null;
    events.length = 0;
    useWorkspace();
    await settled();
    const wipe = events.indexOf('wipe');
    const shown = events.indexOf('shown org-a');
    expect(wipe).toBeGreaterThan(-1);
    expect(events.indexOf('permissions re-read')).toBeGreaterThan(wipe);
    expect(events.indexOf('scope re-read')).toBeGreaterThan(wipe);
    expect(shown).toBeGreaterThan(events.indexOf('permissions re-read'));
    expect(shown).toBeGreaterThan(events.indexOf('scope re-read'));
  });
});
