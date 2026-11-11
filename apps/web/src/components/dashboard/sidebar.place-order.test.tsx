import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

/**
 * LIQUID GLASS: THE SIDEBAR'S TINTED "PLACE AN ORDER" (AppSidebar.dc.html
 * .sb-cta; IMPLEMENTATION-PLAN.md 8.5). A glass-only shortcut to the page the
 * Orders list's own "+ Place order" opens. It must:
 *  - not exist at all under the `off` rollout (R5: today's exact markup);
 *  - under opt-in and default, be a data-glass-only element (hidden in
 *    classic by visibility.css) right after the workspace switcher, and only
 *    for a viewer whose sidebar shows the registry's Orders entry: the Orders
 *    module on and `orders:request`, which /dashboard/orders/new checks too;
 *  - follow the org's nav overrides (Orders hidden there: no shortcut either),
 *    and never be stood in for by a custom link to the Orders list;
 *  - close the phone sheet like every other sidebar link;
 *  - be on the 8.5 allowlist.
 */

let pathname = '/dashboard/inventory';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: { href: string; children: React.ReactNode; prefetch?: boolean } & Record<string, unknown>) => (
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

import { Sidebar } from './sidebar';

afterEach(() => {
  vi.unstubAllEnvs();
  pathname = '/dashboard/inventory';
});

const BASE = {
  organizationId: 'o1',
  organizationName: 'Example Schools',
  organizationLogoUrl: null,
  memberships: [{ id: 'o1', name: 'Example Schools', logoUrl: null, role: 'admin' }],
  userName: 'Avery Example',
  userRole: 'Admin',
  role: 'admin' as const,
};

const cta = () => document.querySelector('a[href="/dashboard/orders/new"]');

describe('the sidebar’s Liquid Glass "Place an order"', () => {
  it('under off: not rendered at all, and no glass-only element', () => {
    render(<Sidebar {...BASE} />);
    expect(cta()).toBeNull();
    expect(document.querySelector('[data-glass-only]')).toBeNull();
  });

  for (const rollout of ['opt-in', 'default'] as const) {
    it(`under ${rollout}: a glass-only link to Place an order, after the workspace switcher and before the nav`, () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      render(<Sidebar {...BASE} />);
      const link = screen.getByRole('link', { name: 'Place an order' });
      expect(link).toHaveAttribute('href', '/dashboard/orders/new');
      expect(link).toHaveAttribute('data-glass-only', '');
      expect(link).toHaveAttribute('data-glass', 'sb-cta');
      // No classic class: in classic only visibility.css decides its display.
      expect(link.getAttribute('class')).toBeNull();
      const ws = document.querySelector('[data-glass="sb-ws"]')!;
      const nav = document.querySelector('nav[data-glass="sidebar-nav"]')!;
      expect(ws.nextElementSibling).toBe(link);
      expect(link.nextElementSibling).toBe(nav);
      // Its label keeps the rail's visually-hidden hook, so the name survives.
      expect(within(link).getByText('Place an order')).toHaveAttribute('data-glass', 'nav-label');
    });
  }

  it('follows the Orders entry’s gate: none with the Orders module off', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<Sidebar {...BASE} enabledModules={DEFAULT_MODULE_IDS.filter((m) => m !== 'orders')} />);
    expect(cta()).toBeNull();
    expect(document.querySelector('a[href="/dashboard/orders"]')).toBeNull();
  });

  it('follows the Orders entry’s gate: none without orders:request', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<Sidebar {...BASE} permissions={['inventory:read', 'cycle_counts:read']} />);
    expect(cta()).toBeNull();
  });

  it('shown with orders:request among the effective permissions', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<Sidebar {...BASE} permissions={['inventory:read', 'orders:request']} />);
    expect(cta()).not.toBeNull();
    expect(document.querySelector('a[href="/dashboard/orders"]')).not.toBeNull();
  });

  it('none when the org hid Orders from its nav', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<Sidebar {...BASE} navOverrides={{ v: 1, hidden: ['/dashboard/orders'] }} />);
    expect(document.querySelector('a[href="/dashboard/orders"]')).toBeNull();
    expect(cta()).toBeNull();
  });

  it('a custom link to the Orders list never stands in for the permission', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(
      <Sidebar
        {...BASE}
        permissions={['inventory:read']}
        navOverrides={{
          v: 1,
          custom: [
            {
              id: 'c1',
              label: 'My orders',
              href: '/dashboard/orders',
              section: 'fulfillment',
              iconName: 'ShoppingCart',
            },
          ],
        }}
      />,
    );
    expect(cta()).toBeNull();
  });

  it('closes the phone sheet like every sidebar link', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const onNavigate = vi.fn();
    render(<Sidebar {...BASE} onNavigate={onNavigate} />);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Place an order' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('is on the 8.5 allowlist as a duplicate of the Orders list’s own Place order', () => {
    const allowlist = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          'tests',
          'e2e',
          'appearance',
          'glass-only-allowlist.json',
        ),
        'utf8',
      ),
    ) as {
      entries: { id: string; source: string; selector: string; kind: string; gate: unknown }[];
    };
    const entry = allowlist.entries.find((e) => e.id === 'sidebar-place-an-order');
    expect(entry).toMatchObject({
      source: 'apps/web/src/components/dashboard/sidebar.tsx',
      selector: '[data-glass="sb-cta"]',
      kind: 'duplicate action',
    });
    expect(entry?.gate).toBeTruthy();
  });
});
