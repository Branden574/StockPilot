import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyNavOverrides,
  MODULE_REGISTRY,
  resolveSurface,
  type ModuleId,
  type NavOverrides,
  type NavSectionKey,
} from '@stockpilot/core';

/**
 * Settings > Navigation after the owner's regroup of 2026-10-19 (sidebar
 * sub-categories): the editor shows the new sections, opens on the order the
 * sidebar draws (an order saved before the regroup carried over by core's
 * own rule), saves an order per new section, keeps hides and renames of the
 * links that moved, and lets a custom link go into any section.
 */

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/settings/navigation',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/server/actions/nav-settings', () => ({
  setNavOverridesAction: vi.fn(async (navOverrides: NavOverrides | null) => ({
    ok: true as const,
    data: { navOverrides },
  })),
}));

import { setNavOverridesAction } from '@/server/actions/nav-settings';

import { NavCustomizer } from './nav-customizer';

/** The admin's sidebar before the org's own changes, every module on. */
function adminSidebar() {
  const enabledModules = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);
  return resolveSurface('web_sidebar', { role: 'admin', enabledModules });
}

/** What the page hands the editor: the admin's sidebar, every module on. */
function baseSections() {
  return adminSidebar().map((sec) => ({
    section: sec.section,
    items: sec.items.map((it) => ({
      href: it.href,
      label: it.label,
      iconName: it.iconName,
      moduleId: it.moduleId,
    })),
  }));
}

/** Each section's panel title in the editor. */
const TITLES: Record<NavSectionKey, string> = {
  overview: 'Overview',
  inventory: 'Inventory',
  fulfillment: 'Fulfillment',
  purchasing: 'Purchasing',
  insights: 'Insights',
  workspace: 'Workspace',
  tools: 'Tools',
  admin: 'Admin',
};

/** An order saved from this editor before the regroup: whole sections. */
const OLD_ORDER = {
  inventory: [
    '/dashboard/orders',
    '/dashboard/purchase-orders',
    '/dashboard/inventory',
    '/dashboard/inventory/staging',
    '/dashboard/exceptions',
    '/dashboard/books',
    '/dashboard/product-groups',
    '/dashboard/categories',
    '/dashboard/tags',
    '/dashboard/locations',
    '/dashboard/movements',
    '/dashboard/rentals',
    '/dashboard/bundles',
    '/dashboard/returns',
    '/dashboard/cycle-counts',
    '/dashboard/procedures',
    '/dashboard/purchase-orders/recurring',
    '/dashboard/planning',
    '/dashboard/purchase-orders/imports',
    '/dashboard/suppliers',
    '/dashboard/reports',
  ],
  workspace: [
    '/dashboard/insights',
    '/dashboard/ai',
    '/dashboard/schedule',
    '/dashboard/notifications',
    '/dashboard/team',
    '/dashboard/support',
    '/dashboard/settings',
    '/dashboard/customers',
    '/dashboard/maintenance',
    '/dashboard/zendesk',
  ],
};

/** The section panels, top to bottom (the Add custom link panel last). */
function panelTitles(): string[] {
  return screen
    .getAllByRole('region')
    .map((r) => r.getAttribute('aria-labelledby') ?? '')
    .map((id) => document.getElementById(id)?.textContent ?? '');
}

/** The built-in links of one panel, in order, by their default names. */
function linksIn(title: string): string[] {
  return within(screen.getByRole('region', { name: title }))
    .queryAllByRole('textbox')
    .map((input) => (input.getAttribute('aria-label') ?? '').replace(/^Rename /, ''));
}

async function save(): Promise<NavOverrides | null> {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(setNavOverridesAction).toHaveBeenCalledTimes(1));
  return vi.mocked(setNavOverridesAction).mock.calls[0]![0];
}

afterEach(() => vi.clearAllMocks());

describe('Settings > Navigation shows the sections the sidebar has', () => {
  it('one panel per section, in the sidebar order, each with its links', () => {
    render(<NavCustomizer baseSections={baseSections()} initialOverrides={null} />);
    expect(panelTitles()).toEqual([
      'Overview',
      'Inventory',
      'Fulfillment',
      'Purchasing',
      'Insights',
      'Workspace',
      'Admin',
      'Add custom link',
    ]);
    // Owner-approved preview order 2026-10-19 (the links kept the order they
    // had in Inventory and Workspace until then).
    expect(linksIn('Inventory')).toEqual([
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
    ]);
    expect(linksIn('Fulfillment')).toEqual(['Orders', 'Returns', 'Rentals', 'Bundles']);
    expect(linksIn('Purchasing')).toEqual([
      'Purchase orders',
      'Recurring POs',
      'Reorder Planning',
      'PO imports',
      'Suppliers',
    ]);
    expect(linksIn('Insights')).toEqual(['Reports', 'Briefing', 'AI Assistant']);
    expect(linksIn('Workspace')).toEqual([
      'Schedule',
      'Notifications',
      'Team',
      'Accounts',
      'Support',
      'Settings',
      'Maintenance',
      'Zendesk',
    ]);
    expect(linksIn('Inventory')).not.toContain('Orders');
  });

  it('with nothing saved, saving without a change saves nothing (null)', async () => {
    render(<NavCustomizer baseSections={baseSections()} initialOverrides={null} />);
    expect(await save()).toBeNull();
  });
});

/**
 * The editor opens on the order the sidebar draws: with nothing saved, the
 * owner-approved preview order 2026-10-19; with a saved order, the sidebar's
 * own rule (the saved list first, the links it does not name after it in the
 * default order). An admin never sees one order here and another there.
 */
describe('the editor opens in the order the sidebar draws', () => {
  it.each<[string, NavOverrides | null]>([
    ['nothing saved', null],
    ['an order saved before the regroup', { v: 1, order: OLD_ORDER }],
    [
      'lists that name only a few links',
      {
        v: 1,
        order: {
          inventory: ['/dashboard/tags', '/dashboard/orders'],
          workspace: ['/dashboard/settings'],
          purchasing: ['/dashboard/suppliers'],
        },
      },
    ],
  ])('%s', (_name, overrides) => {
    render(<NavCustomizer baseSections={baseSections()} initialOverrides={overrides} />);
    const sidebar = applyNavOverrides(adminSidebar(), overrides);
    expect(panelTitles()).toEqual([...sidebar.map((s) => TITLES[s.section]), 'Add custom link']);
    for (const sec of sidebar) {
      expect(linksIn(TITLES[sec.section]), sec.section).toEqual(sec.items.map((i) => i.label));
    }
  });
});

describe('an order saved before the regroup', () => {
  it('opens as the sidebar draws it: each link keeps its place among its neighbours', () => {
    render(
      <NavCustomizer baseSections={baseSections()} initialOverrides={{ v: 1, order: OLD_ORDER }} />,
    );
    expect(linksIn('Inventory')).toEqual([
      'Items',
      'Staging',
      'Exceptions',
      'Books',
      'Product groups',
      'Categories',
      'Tags',
      'Locations',
      'Movements',
      'Cycle counts',
      'Procedures',
    ]);
    expect(linksIn('Fulfillment')).toEqual(['Orders', 'Rentals', 'Bundles', 'Returns']);
    expect(linksIn('Purchasing')).toEqual([
      'Purchase orders',
      'Recurring POs',
      'Reorder Planning',
      'PO imports',
      'Suppliers',
    ]);
    // Reports came from Inventory, drawn above Workspace; Briefing was saved
    // above AI Assistant there.
    expect(linksIn('Insights')).toEqual(['Reports', 'Briefing', 'AI Assistant']);
  });

  it('saving it untouched writes a list for each section not in its default order, Inventory naming only its own links', async () => {
    render(
      <NavCustomizer baseSections={baseSections()} initialOverrides={{ v: 1, order: OLD_ORDER }} />,
    );
    const saved = await save();
    expect(saved?.order).toEqual({
      inventory: [
        '/dashboard/inventory',
        '/dashboard/inventory/staging',
        '/dashboard/exceptions',
        '/dashboard/books',
        '/dashboard/product-groups',
        '/dashboard/categories',
        '/dashboard/tags',
        '/dashboard/locations',
        '/dashboard/movements',
        '/dashboard/cycle-counts',
        '/dashboard/procedures',
      ],
      fulfillment: [
        '/dashboard/orders',
        '/dashboard/rentals',
        '/dashboard/bundles',
        '/dashboard/returns',
      ],
      // Owner-approved preview order 2026-10-19: the default order now puts
      // Accounts above Support and Settings, where this org saved it below,
      // so Workspace keeps its list. Purchasing and Insights come out in
      // their default order (Briefing above AI Assistant, as saved here), so
      // they need no list: with none saved, each is drawn in default order.
      workspace: [
        '/dashboard/schedule',
        '/dashboard/notifications',
        '/dashboard/team',
        '/dashboard/support',
        '/dashboard/settings',
        '/dashboard/customers',
        '/dashboard/maintenance',
        '/dashboard/zendesk',
      ],
    });
    // And the sidebar then draws every section as the editor showed it.
    const shown = Object.fromEntries(
      baseSections().map((s) => [s.section, linksIn(TITLES[s.section])]),
    );
    for (const sec of applyNavOverrides(adminSidebar(), saved)) {
      expect(
        sec.items.map((i) => i.label),
        sec.section,
      ).toEqual(shown[sec.section]);
    }
  });

  // Owner-approved preview order 2026-10-19: Orders now leads Fulfillment,
  // so this moves Bundles up instead of Orders.
  it('a link moved in a new section saves that section in its new order', async () => {
    render(<NavCustomizer baseSections={baseSections()} initialOverrides={null} />);
    const fulfillment = within(screen.getByRole('region', { name: 'Fulfillment' }));
    expect(fulfillment.getByRole('button', { name: 'Move Orders up' })).toBeDisabled();
    fireEvent.click(fulfillment.getByRole('button', { name: 'Move Bundles up' }));
    fireEvent.click(fulfillment.getByRole('button', { name: 'Move Bundles up' }));
    expect(linksIn('Fulfillment')).toEqual(['Orders', 'Bundles', 'Returns', 'Rentals']);
    const saved = await save();
    expect(saved?.order).toEqual({
      fulfillment: [
        '/dashboard/orders',
        '/dashboard/bundles',
        '/dashboard/returns',
        '/dashboard/rentals',
      ],
    });
  });

  it('hides and renames of the links that moved still show, and save again', async () => {
    render(
      <NavCustomizer
        baseSections={baseSections()}
        initialOverrides={{
          v: 1,
          hidden: ['/dashboard/orders', '/dashboard/ai'],
          labels: { '/dashboard/purchase-orders': 'Buying', '/dashboard/reports': 'Analytics' },
          order: OLD_ORDER,
        }}
      />,
    );
    const fulfillment = within(screen.getByRole('region', { name: 'Fulfillment' }));
    expect(fulfillment.getByRole('button', { name: 'Show Orders' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Rename Purchase orders' })).toHaveValue('Buying');
    expect(screen.getByRole('textbox', { name: 'Rename Reports' })).toHaveValue('Analytics');
    // A hidden link keeps its place in the list.
    expect(linksIn('Fulfillment')[0]).toBe('Orders');

    const saved = await save();
    expect(saved?.hidden?.sort()).toEqual(['/dashboard/ai', '/dashboard/orders']);
    expect(saved?.labels).toEqual({
      '/dashboard/purchase-orders': 'Buying',
      '/dashboard/reports': 'Analytics',
    });
  });
});

describe('custom links go into any section', () => {
  it('the section choice lists every section, in the sidebar order', () => {
    render(<NavCustomizer baseSections={baseSections()} initialOverrides={null} />);
    const select = screen.getByLabelText('Section');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Overview',
      'Inventory',
      'Fulfillment',
      'Purchasing',
      'Insights',
      'Workspace',
      'Tools',
      'Admin',
    ]);
  });

  it('a link added to Insights shows in that panel and is saved under insights', async () => {
    render(<NavCustomizer baseSections={baseSections()} initialOverrides={null} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Board pack' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://bi.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'insights' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    const insights = within(screen.getByRole('region', { name: 'Insights' }));
    expect(insights.getByText('Board pack')).toBeInTheDocument();

    const saved = await save();
    expect(saved?.custom).toEqual([
      expect.objectContaining({
        label: 'Board pack',
        href: 'https://bi.example.com',
        section: 'insights',
      }),
    ]);
  });

  it('a custom link in a section with no built-in links gets its own panel, so it can be removed', () => {
    render(
      <NavCustomizer
        baseSections={baseSections().filter(
          (s) => s.section !== 'fulfillment' && s.section !== 'purchasing',
        )}
        initialOverrides={{
          v: 1,
          custom: [
            {
              id: 'old',
              label: 'Rush orders',
              href: '/dashboard/orders?status=rush',
              section: 'inventory',
              iconName: 'ShoppingCart',
            },
            {
              id: 'carrier',
              label: 'Carrier',
              href: 'https://carrier.example.com',
              section: 'fulfillment',
              iconName: 'Truck',
            },
            {
              id: 'wiki',
              label: 'Wiki',
              href: 'https://wiki.example.com',
              section: 'tools',
              iconName: 'BookOpen',
            },
          ],
        }}
      />,
    );
    // A link saved under Inventory before the regroup stays there.
    expect(
      within(screen.getByRole('region', { name: 'Inventory' })).getByText('Rush orders'),
    ).toBeInTheDocument();
    for (const [panel, label] of [
      ['Fulfillment', 'Carrier'],
      ['Tools', 'Wiki'],
    ] as const) {
      const region = within(screen.getByRole('region', { name: panel }));
      expect(region.getByText(label)).toBeInTheDocument();
      fireEvent.click(region.getByRole('button', { name: `Remove ${label}` }));
    }
    expect(screen.queryByRole('region', { name: 'Fulfillment' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Tools' })).toBeNull();
  });
});
