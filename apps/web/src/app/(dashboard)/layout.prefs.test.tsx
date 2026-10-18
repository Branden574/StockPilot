import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shell's per-viewer preferences are cookies the dashboard layout reads
 * (PLAN P2.3): the sections a viewer folded in the sidebar (sp_nav_collapsed),
 * the table density (sp_density) and the hidden sidebar (sp_sidebar_hidden).
 * Reading them on the server is what keeps the first paint right: no flash of
 * the wrong sidebar, and no database read for it.
 *
 * So these tests do what a hard load does: run the layout with the cookies
 * set, then render the shell it returns to HTML on the server, and read the
 * sidebar and the shell root out of that HTML.
 */

const jar = vi.hoisted(() => ({ cookies: {} as Record<string, string> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in jar.cookies ? { name, value: jar.cookies[name] as string } : undefined,
  }),
  headers: async () => new Headers({ 'x-pathname': '/dashboard/inventory' }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  usePathname: () => '/dashboard/inventory',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: { href: string; children: ReactNode; prefetch?: boolean } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

// The shell's live services and overlays render nothing on the server that
// these tests read; stubbed so the real shell and the real sidebar render.
vi.mock('@/components/dashboard/topbar', () => ({ Topbar: () => <header /> }));
vi.mock('@/components/updates/update-center', () => ({ UpdateCenter: () => null }));
vi.mock('@/components/dashboard/command-palette-launcher', () => ({
  CommandPaletteLauncher: () => null,
}));
vi.mock('@/components/dashboard/keyboard-shortcuts', () => ({
  KeyboardShortcutsProvider: () => null,
}));
vi.mock('@/components/dashboard/nav-progress-bar', () => ({ NavProgressBar: () => null }));
vi.mock('@/components/perf/image-diagnostics', () => ({ ImageDiagnostics: () => null }));
vi.mock('@/components/realtime/permissions-realtime', () => ({ PermissionsRealtime: () => null }));
vi.mock('@/components/realtime/session-revocation-listener', () => ({
  SessionRevocationListener: () => null,
}));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({ MfaRequiredBanner: () => null }));
vi.mock('@/server/actions/org-switcher', () => ({ switchOrganizationAction: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ identify: vi.fn() }));
vi.mock('@/lib/onboarding/tour-state-cache', () => ({ forgetTourState: vi.fn() }));

vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: async () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: async () => ({
    organizationId: 'org-1',
    organizationName: 'Org One',
    userId: 'u1',
    email: 'a@b.com',
    fullName: 'Ann Example',
    avatarUrl: null,
    role: 'owner',
    permissions: undefined,
  }),
  getSessionMemberships: async () => [
    { organizationId: 'org-1', name: 'Org One', logoUrl: null, role: 'owner' },
  ],
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: async () => ({
    mfa_policy: 'optional',
    logo_url: null,
    terminology: null,
    nav_overrides: null,
    order_status_config: null,
  }),
  getMfaFactorsForRequest: async () => [],
  getWarehousesForRequest: async () => [{ id: 'wh-1', name: 'Main' }],
  getModulesForRequest: async () => new Set<string>(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: async () => ({ hasAllAccess: true, readableIds: ['wh-1'] }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: async () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      throw new Error('the dashboard layout must not read a table for the shell preferences');
    },
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal2' },
          error: null,
        }),
      },
    },
  }),
}));

import DashboardLayout from './layout';

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
  return findByTypeName(el.props?.children, name);
}

/** The layout as a hard load runs it, then its shell rendered to HTML on the server. */
async function firstPaint(): Promise<{ shell: AnyElement; doc: Document }> {
  const tree = await DashboardLayout({ children: <p>page</p> });
  const shell = findByTypeName(tree, 'DashboardShell');
  if (!shell) throw new Error('the layout rendered no DashboardShell');
  const doc = new DOMParser().parseFromString(renderToStaticMarkup(shell), 'text/html');
  return { shell, doc };
}

function sectionButton(doc: Document, label: string): HTMLButtonElement | undefined {
  return [...doc.querySelectorAll<HTMLButtonElement>('#dashboard-sidebar nav button')].find(
    (b) => b.textContent?.trim() === label,
  );
}

function navHrefs(doc: Document): string[] {
  return [...doc.querySelectorAll('#dashboard-sidebar nav a')].map(
    (a) => a.getAttribute('href') ?? '',
  );
}

beforeEach(() => {
  jar.cookies = {};
});

describe('the first paint already has the viewer’s shell preferences', () => {
  it('no cookies: Admin folded for an owner, the rest open, comfortable rows', async () => {
    const { shell, doc } = await firstPaint();
    expect(shell.props).toMatchObject({
      initialCollapsedSections: null,
      initialDensity: 'comfortable',
    });

    expect(sectionButton(doc, 'Admin')?.getAttribute('aria-expanded')).toBe('false');
    expect(navHrefs(doc)).not.toContain('/dashboard/admin');
    expect(sectionButton(doc, 'Inventory')?.getAttribute('aria-expanded')).toBe('true');
    expect(sectionButton(doc, 'Workspace')?.getAttribute('aria-expanded')).toBe('true');
    expect(doc.querySelector('.sp-shell')?.getAttribute('data-density')).toBe('comfortable');
  });

  it('sp_nav_collapsed=workspace: Workspace folded, and Admin open because the viewer chose', async () => {
    jar.cookies = { sp_nav_collapsed: 'workspace' };
    const { shell, doc } = await firstPaint();
    expect(shell.props.initialCollapsedSections).toEqual(['workspace']);

    expect(sectionButton(doc, 'Workspace')?.getAttribute('aria-expanded')).toBe('false');
    expect(navHrefs(doc)).not.toContain('/dashboard/settings');
    expect(sectionButton(doc, 'Admin')?.getAttribute('aria-expanded')).toBe('true');
    expect(navHrefs(doc)).toContain('/dashboard/admin');
    // The page on screen (/dashboard/inventory) keeps its link marked.
    expect(
      doc.querySelector('#dashboard-sidebar a[aria-current="page"]')?.getAttribute('href'),
    ).toBe('/dashboard/inventory');
  });

  it('an empty sp_nav_collapsed is a choice too: every section open', async () => {
    jar.cookies = { sp_nav_collapsed: '' };
    const { doc } = await firstPaint();
    for (const label of ['Inventory', 'Workspace', 'Admin']) {
      expect(sectionButton(doc, label)?.getAttribute('aria-expanded'), label).toBe('true');
    }
    expect(navHrefs(doc)).toContain('/dashboard/admin');
  });

  it('a folded section that holds the page on screen still shows its link', async () => {
    jar.cookies = { sp_nav_collapsed: 'inventory.admin' };
    const { doc } = await firstPaint();
    expect(sectionButton(doc, 'Inventory')?.getAttribute('aria-expanded')).toBe('true');
    expect(navHrefs(doc)).toContain('/dashboard/inventory');
    expect(sectionButton(doc, 'Admin')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('sp_density=compact: the shell root says compact, so the tables pad by the compact row', async () => {
    jar.cookies = { sp_density: 'compact' };
    const { shell, doc } = await firstPaint();
    expect(shell.props.initialDensity).toBe('compact');
    expect(doc.querySelector('.sp-shell')?.getAttribute('data-density')).toBe('compact');
  });

  it('sp_sidebar_hidden=1: no desktop sidebar in the HTML at all', async () => {
    jar.cookies = { sp_sidebar_hidden: '1' };
    const { doc } = await firstPaint();
    expect(doc.querySelector('#dashboard-sidebar')).toBeNull();
    expect(doc.querySelector('main#main-content')).not.toBeNull();
  });
});
