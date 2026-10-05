import { describe, expect, it, vi } from 'vitest';

import { loadOrgs, setActiveOrg, useOrderStatusMeta, useWorkspace } from './use-workspace';

/**
 * L83b: the phone read no `organizations.order_status_config`, so it showed
 * core's status words and colours where the web shows the organization's own
 * (Settings > Order statuses). The config now rides on the membership read the
 * workspace already makes (no extra request), the ACTIVE organization's config
 * is published with the workspace, and useOrderStatusMeta resolves it with
 * core's resolver for the Orders list, the order screen and the placed screen.
 *
 * Same harness as use-workspace.hydrate.test.ts: React is replaced so
 * useWorkspace() runs its effects at once, and useSyncExternalStore reads the
 * store's snapshot; everything else use-workspace.ts reaches for is faked.
 */

type Published = {
  activeOrgId: string | null;
  loading: boolean;
  orgs: unknown[];
  activeOrderStatusConfig?: unknown;
};
const published = vi.hoisted(() => [] as Published[]);
vi.mock('react', () => ({
  useState: (v: unknown) => [v, (next: Published) => published.push(next)],
  useEffect: (fn: () => unknown) => {
    fn();
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const auth = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
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

/** Org A renames two statuses; org B has no config at all. */
const CONFIG_A = {
  pending_approval: { label: 'Waiting for sign-off' },
  picking_in_progress: { label: 'Being picked', color: 'warning' },
};

const reads = vi.hoisted(() => ({ memberColumns: [] as string[] }));
vi.mock('./supabase', () => {
  const members = {
    select: (columns: string) => {
      reads.memberColumns.push(columns);
      return members;
    },
    eq: () => members,
    not: async () => ({
      data: [
        { role: 'staff', organization_id: 'org-a', organizations: { name: 'A', order_status_config: CONFIG_A } },
        { role: 'staff', organization_id: 'org-b', organizations: { name: 'B', order_status_config: null } },
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
      from: (t: string) => (t === 'organization_members' ? members : t === 'user_profiles' ? profiles : warehouses),
      auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
    },
  };
});

const settled = async () => {
  await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("the organization's order status words, with the workspace (L83b)", () => {
  it('reads each membership’s config in the ONE membership read, beside its name', async () => {
    const orgs = await loadOrgs('u1');
    expect(reads.memberColumns.at(-1)).toBe('role, organization_id, organizations:organization_id (name, order_status_config)');
    expect(orgs).toEqual([
      { id: 'org-a', name: 'A', role: 'staff', orderStatusConfig: CONFIG_A },
      { id: 'org-b', name: 'B', role: 'staff', orderStatusConfig: null },
    ]);
  });

  it("publishes the active organization's config, and the screens' hook resolves it", async () => {
    published.length = 0;
    useWorkspace();
    await settled();
    expect(published.at(-1)).toMatchObject({ activeOrgId: 'org-a', activeOrderStatusConfig: CONFIG_A });
    const meta = useOrderStatusMeta();
    expect(meta.pending_approval.label).toBe('Waiting for sign-off');
    expect(meta.picking_in_progress).toMatchObject({ label: 'Being picked', color: 'warning' });
    expect(meta.approved.label).toBe('Approved');
    // The same resolved map until the config changes, so a list does not
    // recompute it per row.
    expect(useOrderStatusMeta()).toBe(meta);
  });

  it("a switch publishes the new organization's config; none means core's words", async () => {
    await setActiveOrg('org-b');
    expect(published.at(-1)).toMatchObject({ activeOrgId: 'org-b' });
    expect(published.some((p) => p.activeOrgId === 'org-b' && p.activeOrderStatusConfig === null)).toBe(true);
    expect(useOrderStatusMeta().pending_approval.label).toBe('Pending');
    expect(useOrderStatusMeta().picking_in_progress.label).toBe('Picking');
  });

  it("signed out: no organization, so core's words", async () => {
    await setActiveOrg('org-a');
    expect(useOrderStatusMeta().picking_in_progress.label).toBe('Being picked');
    auth.user = null;
    useWorkspace();
    expect(published.at(-1)).toMatchObject({ activeOrgId: null, activeOrderStatusConfig: null });
    expect(useOrderStatusMeta().picking_in_progress.label).toBe('Picking');
  });
});
