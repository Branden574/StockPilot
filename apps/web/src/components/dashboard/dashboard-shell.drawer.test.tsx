import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

/**
 * WHERE FOCUS LANDS WHEN THE PHONE DRAWER OPENS (review of 2026-10-18).
 *
 * Radix focuses the first control in a dialog that is not a link. Before the
 * redesign that was the organization switcher for someone in more than one
 * organization, and Close for everyone else (the common case): measured on the
 * frozen 36cb9b619 build, Enter on the toggle at 390px put focus on Close, and
 * Tab then went to StockPilot, Overview, Items. The redesigned sidebar's
 * section headings are buttons, so Radix's own pick became the first of them
 * (Inventory), mid-nav, where Enter folds the section. The shell now puts
 * focus where it was. This file runs the REAL Sheet and the REAL Sidebar; the
 * rest of the shell's heavy children are stubbed as in dashboard-shell.test.tsx.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
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
vi.mock('@/lib/analytics', () => ({ identify: vi.fn() }));
vi.mock('@/components/dashboard/command-palette-launcher', () => ({
  CommandPaletteLauncher: () => null,
}));
vi.mock('@/components/dashboard/edge-swipe-opener', () => ({ EdgeSwipeOpener: () => null }));
vi.mock('@/components/dashboard/nav-progress-bar', () => ({ NavProgressBar: () => null }));
vi.mock('@/components/updates/update-center', () => ({ UpdateCenter: () => null }));
vi.mock('@/components/dashboard/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/dashboard/user-menu', () => ({ UserMenu: () => null }));
vi.mock('@/components/dashboard/warehouse-filter-picker', () => ({
  WarehouseFilterPicker: () => null,
}));
vi.mock('@/components/theme/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/dashboard/keyboard-shortcuts', () => ({
  KeyboardShortcutsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  openKeyboardShortcutsOverlay: vi.fn(),
}));
vi.mock('@/components/orders/order-status-config-provider', () => ({
  OrderStatusConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DashboardShell } from './dashboard-shell';

const ONE_ORG = [{ id: 'o1', name: 'Org', logoUrl: null, role: 'owner' }];
const TWO_ORGS = [...ONE_ORG, { id: 'o2', name: 'Second Org', logoUrl: null, role: 'staff' }];

function shell(memberships: typeof ONE_ORG) {
  return (
    <DashboardShell
      email="a@b.com"
      fullName="Test User"
      avatarUrl={null}
      userId="u1"
      organizationId="o1"
      organizationName="Org"
      memberships={memberships}
      userName="Test User"
      userRole="Owner · Org"
      role="owner"
      enabledModules={[...DEFAULT_MODULE_IDS]}
      navOverrides={null}
      orderStatusConfig={null}
      isPlatformAdmin={false}
    >
      body
    </DashboardShell>
  );
}

/** A phone-width window: the sidebar toggle opens the drawer. */
function phoneViewport() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) =>
      ({
        matches: false,
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
  return screen.findByRole('dialog', { name: 'Dashboard navigation' });
}

afterEach(() => vi.restoreAllMocks());

describe('the phone drawer opens with focus where it was before the redesign', () => {
  it('someone in one organization lands on Close, not on the first section heading', async () => {
    phoneViewport();
    render(shell(ONE_ORG));
    const drawer = await openDrawer();
    // The control Radix would otherwise pick is there, open.
    expect(within(drawer).getByRole('button', { name: 'Inventory' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const close = within(drawer).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it('someone in more than one organization lands on the organization switcher, as before', async () => {
    phoneViewport();
    render(shell(TWO_ORGS));
    const drawer = await openDrawer();
    const switcher = within(drawer).getByRole('button', { name: 'Switch organization' });
    await waitFor(() => expect(document.activeElement).toBe(switcher));
  });

  it('Close still closes the drawer', async () => {
    phoneViewport();
    render(shell(ONE_ORG));
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Dashboard navigation' })).toBeNull(),
    );
  });
});
