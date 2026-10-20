import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings layout (W-ST-01a): the grouped sub-nav on every settings page
 * except the hub, from the hub's own gate table, with no data read of its own
 * and nothing that holds the page (or settings/loading.tsx) back.
 */

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' },
}));
const pathHolder = vi.hoisted(() => ({ current: '/dashboard/settings/profile' }));

const requireOrgContext = vi.hoisted(() =>
  vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    organizationName: 'Org',
    role: ctxHolder.current.role,
  })),
);
vi.mock('@/lib/auth/session', () => ({ requireOrgContext }));

const moduleAccess = vi.hoisted(() => ({ current: { enabled: true, canManage: true } }));
const checkModuleAccess = vi.hoisted(() =>
  vi.fn(async (moduleId: string) => {
    if (moduleId !== 'maintenance_requests') throw new Error(`unexpected module ${moduleId}`);
    return moduleAccess.current;
  }),
);
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess }));

// Any Supabase client made while the layout renders is a new read: it must not happen.
const createClient = vi.hoisted(() => vi.fn());
const createAdminClient = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/server', () => ({ createClient }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));

const prefetch = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => pathHolder.current,
  useRouter: () => ({ prefetch, push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import SettingsLayout from './layout';

type El = React.ReactElement<Record<string, unknown>>;

/** The layout's own tree, then the sub-nav its Suspense'd slot resolves to. */
async function resolveLayout(children: React.ReactNode = <h1>Profile</h1>) {
  const frame = SettingsLayout({ children }) as El;
  const suspense = frame.props.nav as El;
  expect(suspense.type).toBe(React.Suspense);
  const slot = suspense.props.children as El;
  const slotFn = slot.type as (props: unknown) => Promise<El>;
  const subNav = await slotFn(slot.props);
  return { frame, subNav };
}

async function renderLayout(children?: React.ReactNode) {
  const { frame, subNav } = await resolveLayout(children);
  const Frame = frame.type as React.ComponentType<{
    nav: React.ReactNode;
    children: React.ReactNode;
  }>;
  return render(<Frame nav={subNav}>{frame.props.children as React.ReactNode}</Frame>);
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.current = { role: 'owner' };
  pathHolder.current = '/dashboard/settings/profile';
  moduleAccess.current = { enabled: true, canManage: true };
});

describe('settings layout', () => {
  it('is synchronous, so settings/loading.tsx is never held back behind it', () => {
    const result = SettingsLayout({ children: null });
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('makes no data read of its own: only the request-cached context and module set', async () => {
    await resolveLayout();
    expect(requireOrgContext).toHaveBeenCalledTimes(1);
    expect(checkModuleAccess).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    const source = readFileSync(path.join(__dirname, 'layout.tsx'), 'utf8');
    expect(source).not.toMatch(/supabase|\.from\(|\.rpc\(|fetch\(/);
  });

  it('renders the page inside the frame with the sub-nav, and keeps one h1', async () => {
    await renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).queryAllByRole('heading')).toHaveLength(0);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Security' })).not.toHaveAttribute('aria-current');
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('draws no sub-nav on the hub, which is the grouped index itself', async () => {
    pathHolder.current = '/dashboard/settings';
    await renderLayout(<h1>Settings</h1>);
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
  });

  it('marks Integrations current on the Sage 50 migration it leads to', async () => {
    pathHolder.current = '/dashboard/settings/migrate/sage50';
    await renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers a staff member only the destinations the hub offers them', async () => {
    ctxHolder.current = { role: 'staff' };
    await renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/dashboard/settings',
      '/dashboard/settings/profile',
      '/dashboard/settings/security',
      '/dashboard/settings/notifications',
      '/dashboard/settings/organization',
      '/dashboard/settings/roles',
    ]);
  });

  it('hides Maintenance requests while the module is off, even for the owner', async () => {
    moduleAccess.current = { enabled: false, canManage: true };
    await renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).queryByRole('link', { name: 'Maintenance requests' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Email routing' })).toBeInTheDocument();
  });
});
