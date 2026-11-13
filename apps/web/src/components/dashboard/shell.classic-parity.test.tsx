import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicMarkup, glassOnlyElements } from '@/test/classic-parity';

/**
 * CLASSIC PARITY OF THE DASHBOARD SHELL (Liquid Glass stage 3, items lane;
 * IMPLEMENTATION-PLAN.md 4.6 and 4.7 item 3). The glass shell (AppSidebar,
 * AppTopbar, the phone navigation sheet) is drawn from inert hooks on today's
 * markup plus a few glass-only elements. This renders the sidebar, the top bar
 * and the warehouse menu with fixed data and compares their markup, with every
 * inert hook stripped, to the files under __parity__ that were written from
 * the markup before the stage 3 hooks went in. So any change to classic
 * output (a class, an attribute, an element, the order) fails here.
 *
 * Under the `off` rollout (unset, as in every unit test) no glass-only element
 * is rendered at all; under `default` they are rendered (hidden in classic by
 * visibility.css) and the stripped markup is still the same file.
 */

const { nav } = vi.hoisted(() => ({ nav: { pathname: '/dashboard/inventory' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/supabase/realtime-auth', () => ({ ensureRealtimeAuth: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ reset: vi.fn(), identify: vi.fn() }));
vi.mock('@/server/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/server/actions/org-switcher', () => ({
  switchOrganizationAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));
vi.mock('@/server/actions/warehouse-filter', () => ({
  setWarehouseFilterAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));

import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

afterEach(() => {
  vi.unstubAllEnvs();
  nav.pathname = '/dashboard/inventory';
});

const ADMIN = {
  organizationId: 'o1',
  organizationName: 'Example Schools',
  organizationLogoUrl: null,
  memberships: [
    { id: 'o1', name: 'Example Schools', logoUrl: null, role: 'admin' },
    { id: 'o2', name: 'Second Example Org', logoUrl: null, role: 'staff' },
  ],
  userName: 'Avery Example',
  userRole: 'Admin',
  role: 'admin' as const,
  collapsedSections: ['admin'] as const,
};

const STAFF = {
  organizationId: 'o1',
  organizationName: 'Example Schools',
  organizationLogoUrl: null,
  memberships: [{ id: 'o1', name: 'Example Schools', logoUrl: null, role: 'staff' }],
  userName: 'Sam Example',
  userRole: 'Staff · Main Warehouse',
  role: 'staff' as const,
};

function renderTopbar() {
  return render(
    <Topbar
      email="avery@example.test"
      fullName="Avery Example"
      avatarUrl={null}
      organizationName="Example Schools"
      userId="u1"
      organizationId="o1"
      warehouseFilter={{
        warehouses: [
          { id: 'w1', name: 'Main Warehouse' },
          { id: 'w2', name: 'North Building' },
        ],
        activeId: null,
        warehouseLabel: 'Warehouse',
      }}
    />,
  );
}

type Case = [name: string, draw: () => Promise<Element>];

const CASES: Case[] = [
  [
    'sidebar-admin',
    async () =>
      render(
        <Sidebar
          {...ADMIN}
          collapsedSections={[...ADMIN.collapsedSections]}
          onToggleSection={() => {}}
        />,
      ).container,
  ],
  ['sidebar-staff-single-org', async () => render(<Sidebar {...STAFF} />).container],
  ['topbar', async () => renderTopbar().container],
  [
    'topbar-warehouse-menu-open',
    async () => {
      renderTopbar();
      const user = userEvent.setup();
      await act(async () => {
        await user.click(document.querySelector('button[aria-label^="Filter by"]')!);
      });
      return document.body;
    },
  ],
];

describe('the inert hooks the glass shell reads', () => {
  it('a word in a count’s place (Beta, New) carries the pill tone, which glass draws as the board’s .nav-pill', () => {
    const { container } = render(
      <Sidebar
        {...ADMIN}
        collapsedSections={[...ADMIN.collapsedSections]}
        onToggleSection={() => {}}
      />,
    );
    const badges = [...container.querySelectorAll('[data-glass="nav-ct"]')];
    const words = badges.filter((b) => /^[A-Za-z]/u.test(b.textContent ?? ''));
    expect(words.map((b) => b.textContent).sort()).toEqual(['Beta', 'New']);
    for (const b of words) expect(b.getAttribute('data-glass-tone')).toBe('pill');
  });
});

describe('classic parity of the dashboard shell', () => {
  for (const [name, draw] of CASES) {
    it(`${name}: the off rollout renders no glass-only element and today's markup`, async () => {
      const root = await draw();
      expect(glassOnlyElements(root)).toEqual([]);
      await expect(classicMarkup(root)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });

    it(`${name}: the default rollout's markup, inert hooks and glass-only elements stripped, is the same`, async () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
      const root = await draw();
      await expect(classicMarkup(root)).toMatchFileSnapshot(`./__parity__/${name}.html`);
    });
  }
});
