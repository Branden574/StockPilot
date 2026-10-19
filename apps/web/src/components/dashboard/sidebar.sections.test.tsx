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
 * mockup groups the app has no pages for). Sections fold away; Admin starts
 * folded for admins; the section holding the page on screen always shows its
 * link.
 *
 * OWNER DECISION 2026-10-19 (it replaces N2's "no regrouping"): the sections
 * follow the Claude design's sub-categories. Fulfillment, Purchasing and
 * Insights split out of Inventory and Workspace in the registry itself, with
 * saved org orders carried over in core, so they are real sections here.
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

/** The section headers of the nav, top to bottom (Overview has none). */
function sectionHeaders(): string[] {
  return within(screen.getByRole('navigation'))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '');
}

/** The links under one section header, top to bottom. */
function linksUnder(label: string): string[] {
  const list = document.getElementById(sectionButton(label).getAttribute('aria-controls') ?? '');
  return within(list!)
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');
}

/** A link's text without its badge (AI Assistant's Beta, Briefing's New). */
function withoutBadge(text: string): string {
  return text.replace(/(Beta|New)$/, '');
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

  // 'Fulfillment' left this list on the owner's decision of 2026-10-19: it is
  // a real section now. The design's Devices group and its Mobile scanner
  // entry stay out (the app has no such page).
  it('has no "More" control and none of the mockup groups the app has no pages for', () => {
    render(<Sidebar {...props('owner', { collapsedSections: [], onToggleSection: () => {} })} />);
    expect(screen.queryByText(/^More$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull();
    for (const mockupGroup of ['Devices', 'Mobile scanner']) {
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

/**
 * OWNER DECISION 2026-10-19: the headers each role sees, in order, and the
 * links under the three new ones. An empty section draws no header.
 */
describe('the sub-categories, per role', () => {
  const NEW_HEADERS = ['Inventory', 'Fulfillment', 'Purchasing', 'Insights', 'Workspace'];

  it.each([
    ['owner', [...NEW_HEADERS, 'Admin']],
    ['admin', [...NEW_HEADERS, 'Admin']],
    // A manager's Admin holds the Audit log alone.
    ['manager', [...NEW_HEADERS, 'Admin']],
    ['staff', NEW_HEADERS],
    // A viewer reads no reports and uses no AI, so no Insights.
    ['viewer', ['Inventory', 'Fulfillment', 'Purchasing', 'Workspace']],
  ] as const)('%s, every module on: the headers, in order', (role, headers) => {
    render(
      <Sidebar
        {...props(role, {
          enabledModules: ALL_MODULES,
          collapsedSections: [],
          onToggleSection: () => {},
        })}
      />,
    );
    expect(sectionHeaders()).toEqual(headers);
  });

  it('owner, every module on: the links under Fulfillment, Purchasing and Insights', () => {
    render(
      <Sidebar
        {...props('owner', {
          enabledModules: ALL_MODULES,
          collapsedSections: [],
          onToggleSection: () => {},
        })}
      />,
    );
    // Owner-approved preview order 2026-10-19 (the links kept the order they
    // had in Inventory and Workspace until then).
    expect(linksUnder('Fulfillment')).toEqual(['Orders', 'Returns', 'Rentals', 'Bundles']);
    expect(linksUnder('Purchasing')).toEqual([
      'Purchase orders',
      'Recurring POs',
      'Reorder Planning',
      'PO imports',
      'Suppliers',
    ]);
    // The badges are part of each link's text.
    expect(linksUnder('Insights').map(withoutBadge)).toEqual([
      'Reports',
      'Briefing',
      'AI Assistant',
    ]);
    expect(linksUnder('Inventory')).not.toContain('Orders');
    expect(linksUnder('Workspace').some((t) => t.startsWith('AI Assistant'))).toBe(false);
  });

  /**
   * OWNER DECISION 2026-10-19: the owner approved the "Five groups" preview,
   * which lists the links inside each group in this order. With nothing saved
   * by the org, each role's sidebar draws them so, leaving out only the links
   * the role cannot open.
   */
  const PREVIEW_INVENTORY = [
    'Items',
    'Books',
    'Product groups',
    'Staging',
    'Exceptions',
    'Cycle counts',
    'Movements',
    'Locations',
    'Categories',
    'Tags',
    'Procedures',
  ];
  const PREVIEW_FULFILLMENT = ['Orders', 'Returns', 'Rentals', 'Bundles'];
  const PREVIEW_PURCHASING = [
    'Purchase orders',
    'Recurring POs',
    'Reorder Planning',
    'PO imports',
    'Suppliers',
  ];
  const PREVIEW_INSIGHTS = ['Reports', 'Briefing', 'AI Assistant'];

  it.each<[Role, Record<string, string[]>]>([
    [
      'admin',
      {
        Inventory: PREVIEW_INVENTORY,
        Fulfillment: PREVIEW_FULFILLMENT,
        Purchasing: PREVIEW_PURCHASING,
        Insights: PREVIEW_INSIGHTS,
        Workspace: [
          'Schedule',
          'Notifications',
          'Team',
          'Accounts',
          'Support',
          'Settings',
          'Maintenance',
          'Zendesk',
        ],
        Admin: [
          'Admin overview',
          'Charters',
          'Warehouses',
          'Bins',
          'Users',
          'Vendor mappings',
          'UoM conversions',
          'Reconciliation',
          'Audit log',
        ],
      },
    ],
    [
      'manager',
      {
        Inventory: PREVIEW_INVENTORY,
        Fulfillment: PREVIEW_FULFILLMENT,
        Purchasing: PREVIEW_PURCHASING,
        Insights: PREVIEW_INSIGHTS,
        Workspace: [
          'Schedule',
          'Notifications',
          'Accounts',
          'Support',
          'Settings',
          'Maintenance',
          'Zendesk',
        ],
        Admin: ['Audit log'],
      },
    ],
    [
      'staff',
      {
        Inventory: [
          'Items',
          'Books',
          'Staging',
          'Exceptions',
          'Cycle counts',
          'Locations',
          'Categories',
          'Tags',
          'Procedures',
        ],
        Fulfillment: ['Orders', 'Rentals', 'Bundles'],
        Purchasing: ['Purchase orders', 'Suppliers'],
        Insights: PREVIEW_INSIGHTS,
        Workspace: ['Notifications', 'Support', 'Settings', 'Maintenance', 'Zendesk'],
      },
    ],
    [
      'viewer',
      {
        Inventory: ['Items', 'Books', 'Staging', 'Exceptions', 'Locations', 'Categories'],
        Fulfillment: ['Orders'],
        Purchasing: ['Purchase orders', 'Suppliers'],
        Workspace: ['Notifications', 'Support', 'Settings', 'Maintenance', 'Zendesk'],
      },
    ],
  ])(
    '%s, every module on: the links inside each section, in the owner-approved preview order',
    (role, expected) => {
      render(
        <Sidebar
          {...props(role, {
            enabledModules: ALL_MODULES,
            collapsedSections: [],
            onToggleSection: () => {},
          })}
        />,
      );
      expect(sectionHeaders()).toEqual(Object.keys(expected));
      for (const [header, links] of Object.entries(expected)) {
        expect(linksUnder(header).map(withoutBadge), header).toEqual(links);
      }
    },
  );

  it.each<[Role, string[]]>([
    ['owner', ['Inventory', 'Insights', 'Workspace', 'Admin']],
    ['staff', ['Inventory', 'Insights', 'Workspace']],
    ['viewer', ['Inventory', 'Workspace']],
  ])(
    '%s with only the core modules: no Fulfillment or Purchasing header, Insights holds Reports',
    (role, headers) => {
      render(
        <Sidebar
          {...props(role, { enabledModules: [], collapsedSections: [], onToggleSection: () => {} })}
        />,
      );
      expect(sectionHeaders()).toEqual(headers);
      if (headers.includes('Insights')) expect(linksUnder('Insights')).toEqual(['Reports']);
    },
  );

  it("an org's order saved before the regroup carries over: Orders first in Fulfillment, Items first in Inventory", () => {
    render(
      <Sidebar
        {...props('admin', {
          collapsedSections: [],
          onToggleSection: () => {},
          navOverrides: {
            v: 1,
            order: { inventory: ['/dashboard/orders', '/dashboard/inventory'] },
            labels: { '/dashboard/orders': 'Sales orders' },
          },
        })}
      />,
    );
    expect(linksUnder('Fulfillment')).toEqual(['Sales orders', 'Rentals', 'Bundles']);
    expect(linksUnder('Inventory')[0]).toBe('Items');
    // The links the saved list does not name follow in the default order:
    // the owner-approved preview order 2026-10-19, Books right after Items.
    expect(linksUnder('Inventory').slice(0, 3)).toEqual(['Items', 'Books', 'Staging']);
  });

  it('a custom link saved under a new section is drawn there', () => {
    render(
      <Sidebar
        {...props('viewer', {
          collapsedSections: [],
          onToggleSection: () => {},
          navOverrides: {
            v: 1,
            custom: [
              {
                id: 'bi',
                label: 'Board pack',
                href: 'https://bi.example.com',
                section: 'insights',
                iconName: 'BarChart3',
              },
            ],
          },
        })}
      />,
    );
    expect(sectionHeaders()).toEqual([
      'Inventory',
      'Fulfillment',
      'Purchasing',
      'Insights',
      'Workspace',
    ]);
    expect(linksUnder('Insights')).toEqual(['Board pack']);
  });

  it('a new section folds by its own key, and starts open', () => {
    const onToggleSection = vi.fn<(key: NavSectionKey, collapse: boolean) => void>();
    const view = render(
      <Sidebar {...props('owner', { collapsedSections: [], onToggleSection })} />,
    );
    for (const label of ['Fulfillment', 'Purchasing', 'Insights']) {
      expect(sectionButton(label)).toHaveAttribute('aria-expanded', 'true');
    }
    fireEvent.click(sectionButton('Purchasing'));
    expect(onToggleSection).toHaveBeenLastCalledWith('purchasing', true);
    view.rerender(
      <Sidebar {...props('owner', { collapsedSections: ['purchasing'], onToggleSection })} />,
    );
    expect(sectionButton('Purchasing')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Suppliers' })).toBeNull();
    // Inventory and Fulfillment stay as they were.
    expect(sectionButton('Fulfillment')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Orders' })).toBeInTheDocument();
  });
});

describe('sections fold away', () => {
  it('each labelled section is a disclosure button that controls its list', () => {
    render(<Sidebar {...props('owner', { collapsedSections: [], onToggleSection: () => {} })} />);
    for (const label of [
      'Inventory',
      'Fulfillment',
      'Purchasing',
      'Insights',
      'Workspace',
      'Admin',
    ]) {
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

  // Review of 2026-10-18: the hold outlived the visit. Fold Admin on Bins, go
  // to Items, come back to Bins (Back, a crumb, the palette): Admin stayed
  // folded and the page's own link was hidden, while arriving on any other
  // Admin page opened it.
  it('a fold by hand ends with the visit: coming back to the same page opens its section again', () => {
    currentPathname = '/dashboard/admin/bins';
    const onToggleSection = vi.fn();
    const sidebar = () => (
      <Sidebar {...props('admin', { collapsedSections: ['admin'], onToggleSection })} />
    );
    const view = render(sidebar());
    fireEvent.click(sectionButton('Admin'));
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'false');

    currentPathname = '/dashboard/inventory';
    view.rerender(sidebar());
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'false');

    currentPathname = '/dashboard/admin/bins';
    view.rerender(sidebar());
    expect(sectionButton('Admin')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Bins' })).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * Arriving on a page whose link sits below (or above) what the nav shows, the
 * nav scrolls just enough to show it, a third of the way down, so the sidebar
 * always says where you are. A link already in view is left where it is. The
 * test DOM has no layout, so the nav's box and the active link's box are given.
 */
describe('the nav scrolls to show the link of the page on screen', () => {
  const NAV = { top: 100, height: 400 }; // the nav shows 100 to 500
  let linkTop = 0;

  const box = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.tagName === 'NAV') return box(NAV.top, NAV.height);
      if (this.getAttribute('aria-current') === 'page') return box(linkTop, 32);
      return box(0, 0);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const at = (path: string, top: number) => {
    currentPathname = path;
    linkTop = top;
    return <Sidebar {...props('admin', { collapsedSections: [], onToggleSection: () => {} })} />;
  };

  // Mutation caught: the scroll made unconditional (the nav jumps on every
  // page change), or either edge check dropped.
  it('scrolls only when the link is outside the nav, and only the nav', () => {
    const view = render(at('/dashboard/admin/bins', 300)); // in view
    const nav = screen.getByRole('navigation');
    expect(nav.scrollTop).toBe(0);

    view.rerender(at('/dashboard/admin/charters', 700)); // below the nav
    expect(nav.scrollTop).toBeCloseTo(700 - NAV.top - NAV.height / 3);

    let before = nav.scrollTop;
    view.rerender(at('/dashboard/admin/bins', 20)); // above the nav
    expect(nav.scrollTop).toBeCloseTo(before + (20 - NAV.top - NAV.height / 3));

    before = nav.scrollTop;
    view.rerender(at('/dashboard/admin/charters', 480)); // cut off at the bottom edge
    expect(nav.scrollTop).toBeCloseTo(before + (480 - NAV.top - NAV.height / 3));

    before = nav.scrollTop;
    view.rerender(at('/dashboard/admin/bins', 250)); // in view again
    expect(nav.scrollTop).toBe(before);

    // The page itself is never moved.
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('does nothing on a page with no link in the nav', () => {
    render(at('/dashboard/whats-new', 700));
    expect(screen.getByRole('navigation').scrollTop).toBe(0);
  });
});
