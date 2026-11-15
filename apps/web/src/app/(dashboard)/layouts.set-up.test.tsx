// @vitest-environment node
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dashboard's two shared layouts, the dashboard layout and the settings
 * layout, render for a member who must set up an authenticator first, on a
 * page open before set-up and on one that is not: neither throws a redirect.
 * A page under each does redirect, to the security page.
 *
 * Why it matters: a layout that throws a redirect to a page under itself, when
 * it is rendered for a client-side navigation (the landing after sign-in, an
 * organization switch), is kept by the browser and replayed on the way to the
 * target, so the page stays blank. The browser part cannot run here; this pins
 * the server side of it (and authenticator-set-up.guard.test.ts pins that no
 * layout asks requireOrgContext() or redirects under itself).
 *
 * The REAL session loader, gates and layouts; only the network is faked
 * (test/step-up-session-fixture.ts) and the shell's client components are not
 * rendered (the layout's answer is a React element tree).
 */

vi.mock('next/headers', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    headers: async () => f.fixtureHeaders(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  };
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  unstable_rethrow: () => {},
}));
vi.mock('@/lib/supabase/server', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    createClient: async () => {
      const client = f.fixtureClient();
      return {
        ...client,
        // The warehouse list the dashboard layout reads for the top bar, and a
        // staff member's warehouse assignments.
        from: (table: string) => {
          const rows: Record<string, unknown> = {
            warehouses: [{ id: 'wh-1', name: 'Main' }],
            user_warehouse_assignments: [{ warehouse_id: 'wh-1', is_primary: true }],
            organization_members: { all_warehouses: false },
          };
          if (!(table in rows)) return client.from(table);
          f.world.calls.push(`from:${table}`);
          const answer = { data: rows[table], error: null };
          const builder: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'neq', 'in', 'is', 'order']) builder[m] = () => builder;
          builder.maybeSingle = async () => answer;
          builder.then = (res: (v: unknown) => unknown) => res(answer);
          return builder;
        },
      };
    },
  };
});
vi.mock('@/lib/error-reporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/error-reporter')>()),
  reportError: vi.fn(async () => {}),
}));

import { resetWorld, world } from '@/test/step-up-session-fixture';

import SettingsLayout from './dashboard/settings/layout';
import DashboardLayout from './layout';

const SET_UP = 'REDIRECT:/dashboard/settings/security?enroll=1';
const OPEN = '/dashboard/settings/security';
const CLOSED = '/dashboard/settings/integrations';

type AnyElement = ReactElement<Record<string, unknown>>;

function findByTypeName(node: unknown, name: string): AnyElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTypeName(child, name);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as AnyElement;
  const type = el.type as { name?: string } | string | undefined;
  if (typeof type === 'function' && (type as { name?: string }).name === name) return el;
  return (
    findByTypeName(el.props?.children, name) ??
    findByTypeName(el.props?.nav, name) ??
    findByTypeName(el.props?.fallback, name)
  );
}

function PageBelow() {
  return null;
}

/** The settings layout and the navigation it renders (its own server component). */
async function settingsLayoutAndNav() {
  const tree = SettingsLayout({ children: <PageBelow /> });
  const slot = findByTypeName(tree, 'SettingsNavSlot');
  expect(slot, 'the settings navigation is rendered').not.toBeNull();
  const nav = await (slot!.type as () => Promise<unknown>)();
  return { tree, nav };
}

beforeEach(() => {
  resetWorld();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe.each([
  ['an owner, Required for admins', 'admins_required', 'owner'],
  ['a Super Admin, Required for admins', 'admins_required', 'admin'],
  ['a staff member, Required for everyone', 'all_required', 'staff'],
] as const)('%s with no authenticator', (_label, policy, role) => {
  beforeEach(() => {
    world.policy = policy;
    world.role = role;
  });

  it.each([OPEN, CLOSED, '/dashboard', null])(
    'the dashboard layout renders the page with the banner on %s, never a redirect',
    async (path) => {
      world.pathname = path;
      const tree = await DashboardLayout({ children: <PageBelow /> });
      expect(findByTypeName(tree, 'PageBelow')).not.toBeNull();
      expect(findByTypeName(tree, 'MfaRequiredBanner')).not.toBeNull();
      expect(findByTypeName(tree, 'AuthenticatorSetUpPanel')).toBeNull();
    },
  );

  it.each([OPEN, CLOSED])(
    'the settings layout and its navigation render on %s, never a redirect',
    async (path) => {
      world.pathname = path;
      const { tree, nav } = await settingsLayoutAndNav();
      expect(findByTypeName(tree, 'PageBelow')).not.toBeNull();
      expect(nav).toBeTruthy();
    },
  );

  it('a page under the dashboard layout redirects to set-up, before it reads anything', async () => {
    world.pathname = '/dashboard';
    const { default: Overview } = await import('./dashboard/page');
    world.calls = [];
    await expect(Overview()).rejects.toThrow(SET_UP);
    expect(world.calls.filter((c) => c.startsWith('from:'))).toEqual([]);
  });

  it('a page under the settings layout redirects to set-up, before it reads anything', async () => {
    world.pathname = CLOSED;
    const { default: Integrations } = await import('./dashboard/settings/integrations/page');
    world.calls = [];
    await expect(Integrations()).rejects.toThrow(SET_UP);
    expect(world.calls.filter((c) => c.startsWith('from:'))).toEqual([]);
  });
});

describe('control: a Manager under Required for admins', () => {
  it('the layouts render with no banner', async () => {
    world.policy = 'admins_required';
    world.role = 'manager';
    world.pathname = CLOSED;
    const tree = await DashboardLayout({ children: <PageBelow /> });
    expect(findByTypeName(tree, 'PageBelow')).not.toBeNull();
    expect(findByTypeName(tree, 'MfaRequiredBanner')).toBeNull();
    const { nav } = await settingsLayoutAndNav();
    expect(nav).toBeTruthy();
  });
});
