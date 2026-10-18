import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MODULE_IDS,
  MODULE_REGISTRY,
  type NavSectionKey,
  type Role,
} from '@stockpilot/core';

import { navForRole } from './nav';
import { Sidebar } from './sidebar';

/**
 * The redesigned sidebar keeps the WHOLE role-aware navigation (CONFLICTS N1,
 * N2): every destination navForRole gives a person is a link in their sidebar,
 * under the registry's own sections, and nothing else (no "More" control, no
 * mockup groups). Sections fold away; Admin starts folded for admins; the
 * section holding the page on screen always shows its link.
 */

let currentPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/org-switcher', () => ({
  switchOrganizationAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));

const ALL_MODULES = Object.keys(MODULE_REGISTRY);

function props(role: Role, extra: Record<string, unknown> = {}) {
  return {
    organizationId: 'o1',
    organizationName: 'Acme Co',
    organizationLogoUrl: null,
    memberships: [{ id: 'o1', name: 'Acme Co', logoUrl: null, role }],
    userName: 'Test User',
    userRole: 'Role · Acme Co',
    role,
    ...extra,
  };
}

/** The hrefs of the nav's links, in order (the brand link sits outside the <nav>). */
function navHrefs(): string[] {
  return within(screen.getByRole('navigation'))
    .getAllByRole('link')
    .map((a) => a.getAttribute('href') ?? '');
}

function sectionButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

beforeEach(() => {
  currentPathname = '/dashboard';
});
afterEach(() => vi.clearAllMocks());

describe('every destination a role has is in its sidebar, and nothing more', () => {
  it.each(['owner', 'admin', 'manager', 'staff', 'viewer'] as const)(
    '%s, every module on: the links are exactly navForRole, in its order',
    (role) => {
      render(
        <Sidebar
          {...props(role, {
            enabledModules: ALL_MODULES,
            collapsedSections: [],
            onToggleSection: () => {},
          })}
        />,
      );
      const expected = navForRole(role, new Set(ALL_MODULES) as never).flatMap((s) =>
        s.items.map((i) => i.href),
      );
      expect(navHrefs()).toEqual(expected);
    },
  );

  // The defaults recorded in Stage 1 (shell 2.12): staff and viewers never get
  // the owner's navigation.
  it.each([
    ['owner', 35],
    ['admin', 35],
    ['manager', 26],
    ['staff', 21],
    ['viewer', 13],
  ] as const)('%s with the default modules gets %i links', (role, count) => {
    render(
      <Sidebar
        {...props(role, {
          enabledModules: [...DEFAULT_MODULE_IDS],
          collapsedSections: [],
          onToggleSection: () => {},
        })}
      />,
    );
    expect(navHrefs()).toHaveLength(count);
  });

  it('has no "More" control and none of the mockup groups', () => {
    render(<Sidebar {...props('owner', { collapsedSections: [], onToggleSection: () => {} })} />);
    expect(screen.queryByText(/^More$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull();
    for (const mockupGroup of ['Fulfillment', 'Devices', 'Mobile scanner']) {
      expect(screen.queryByText(mockupGroup)).toBeNull();
    }
  });

  it('keeps org renames and custom links, under the registry section keys', () => {
    render(
      <Sidebar
        {...props('admin', {
          collapsedSections: [],
          onToggleSection: () => {},
          navOverrides: {
            v: 1,
            labels: { '/dashboard/inventory': 'Ingredients' },
            custom: [
              {
                id: 'sop',
                label: 'Shop manual',
                href: 'https://example.com/manual',
                section: 'tools',
                iconName: 'BookOpen',
              },
            ],
          },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Ingredients' })).toHaveAttribute(
      'href',
      '/dashboard/inventory',
    );
    // The custom link's section is Tools (a key the phone shares), shown as such.
    expect(sectionButton('Tools')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Shop manual' })).toHaveAttribute(
      'href',
      'https://example.com/manual',
    );
  });

  it('draws no heading for a section whose items the org hid', () => {
    render(
      <Sidebar
        {...props('viewer', {
          collapsedSections: [],
          onToggleSection: () => {},
          navOverrides: {
            v: 1,
            hidden: ['/dashboard/notifications', '/dashboard/support', '/dashboard/settings'],
          },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Workspace' })).toBeNull();
    expect(sectionButton('Inventory')).toBeInTheDocument();
  });
});

describe('sections fold away', () => {
  it('each labelled section is a disclosure button that controls its list', () => {
    render(<Sidebar {...props('owner', { collapsedSections: [], onToggleSection: () => {} })} />);
    for (const label of ['Inventory', 'Workspace', 'Admin']) {
      const button = sectionButton(label);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      const list = document.getElementById(button.getAttribute('aria-controls') ?? '');
      expect(list).not.toBeNull();
      expect(within(list!).getAllByRole('link').length).toBeGreaterThan(0);
    }
    // Overview has no heading, so nothing to fold.
    expect(screen.getByRole('link', { name: /^Overview$/ })).toBeInTheDocument();
  });

  it('Admin starts folded for an admin; Inventory and Workspace start open', () => {
    render(<Sidebar {...props('admin')} />);
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Admin overview' })).toBeNull();
    expect(sectionButton('Inventory')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionButton('Workspace')).toHaveAttribute('aria-expanded', 'true');
  });

  it('a manager (Admin holds only the Audit log) starts with it open', () => {
    render(<Sidebar {...props('manager')} />);
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('on its own, a section folds and unfolds in place', () => {
    render(<Sidebar {...props('owner')} />);
    fireEvent.click(sectionButton('Inventory'));
    expect(sectionButton('Inventory')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /^Items$/ })).toBeNull();
    fireEvent.click(sectionButton('Inventory'));
    expect(sectionButton('Inventory')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /^Items$/ })).toBeInTheDocument();
  });

  it('inside the shell it reports the section key, open or closed, and shows what it is given', () => {
    const onToggleSection = vi.fn<(key: NavSectionKey, collapse: boolean) => void>();
    const view = render(
      <Sidebar {...props('owner', { collapsedSections: [], onToggleSection })} />,
    );
    fireEvent.click(sectionButton('Workspace'));
    expect(onToggleSection).toHaveBeenLastCalledWith('workspace', true);

    view.rerender(
      <Sidebar {...props('owner', { collapsedSections: ['workspace'], onToggleSection })} />,
    );
    expect(sectionButton('Workspace')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(sectionButton('Workspace'));
    expect(onToggleSection).toHaveBeenLastCalledWith('workspace', false);
  });

  it('the section holding the page on screen opens on arrival, and a fold by hand holds until the page changes', () => {
    currentPathname = '/dashboard/admin/bins';
    const onToggleSection = vi.fn();
    const view = render(
      <Sidebar {...props('admin', { collapsedSections: ['admin'], onToggleSection })} />,
    );
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Bins' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(sectionButton('Admin'));
    expect(onToggleSection).toHaveBeenLastCalledWith('admin', true);
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Bins' })).toBeNull();

    currentPathname = '/dashboard/admin/charters';
    view.rerender(
      <Sidebar {...props('admin', { collapsedSections: ['admin'], onToggleSection })} />,
    );
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Charters' })).toHaveAttribute('aria-current', 'page');
  });
});
