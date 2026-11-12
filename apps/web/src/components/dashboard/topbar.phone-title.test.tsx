import { render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * THE GLASS PHONE BAR'S PAGE TITLE (stage 3 fidelity check, small lane,
 * finding 2; Overview-Mobile, AppTopbar's .mob.h3). Under a rollout that
 * offers glass the bar carries one glass-only line of words: the current
 * page's name, the same words as the trail's last crumb (the org's renamed
 * nav label included). shell.css shows it at 760 px and under where the trail
 * is not on screen; Classic hides it (visibility.css), and under `off` it is
 * not rendered at all. The bar's classic markup is pinned by
 * shell.classic-parity.test.tsx.
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
vi.mock('@/server/actions/warehouse-filter', () => ({
  setWarehouseFilterAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));

import { Topbar } from './topbar';

afterEach(() => {
  vi.unstubAllEnvs();
  nav.pathname = '/dashboard/inventory';
});

function renderBar(navSections?: React.ComponentProps<typeof Topbar>['navSections']) {
  return render(
    <Topbar
      email="avery@example.test"
      fullName="Avery Example"
      avatarUrl={null}
      organizationName="Example Schools"
      userId="u1"
      organizationId="o1"
      navSections={navSections}
      warehouseFilter={{
        warehouses: [{ id: 'w1', name: 'Main Warehouse' }],
        activeId: null,
        warehouseLabel: 'Warehouse',
      }}
    />,
  );
}

const title = (root: ParentNode) => root.querySelector('[data-glass="tb-title"]');

describe('the glass phone bar’s page title', () => {
  it('under off: not rendered', () => {
    const { container } = renderBar();
    expect(title(container)).toBeNull();
  });

  it('under default: a glass-only line with the current page’s name, after the trail and before the tools', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const { container } = renderBar();
    const el = title(container)!;
    expect(el).not.toBeNull();
    expect(el.hasAttribute('data-glass-only')).toBe(true);
    const crumbs = [...container.querySelectorAll('[data-glass="crumbs"] > li')];
    expect(el.textContent).toBe(crumbs.at(-1)?.textContent?.replace(/^\//u, ''));
    // Words only: no control inside it, and no class that sets display.
    expect(el.querySelector('a, button, input')).toBeNull();
    expect(el.getAttribute('class')).toBeNull();
    const order = [...container.querySelector('header')!.children].map(
      (c) => c.getAttribute('data-glass') ?? c.getAttribute('data-slot'),
    );
    expect(order.indexOf('tb-title')).toBeGreaterThan(order.indexOf('topbar-trail'));
    expect(order.indexOf('tb-title')).toBeLessThan(order.indexOf('tb-tools'));
  });

  it('follows the page, as the trail does', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    nav.pathname = '/dashboard/books';
    const { container } = renderBar();
    expect(title(container)?.textContent).toBe('Books');
  });
});
