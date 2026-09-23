import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pathnameRef, sidebarRenders, realProgressBar } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' },
  sidebarRenders: { count: 0 },
  // The late-skeleton tests below run the REAL progress bar; the rest keep it stubbed.
  realProgressBar: { value: false },
}));

// Heavy / native-dependency children are stubbed so we can exercise the
// shell's own toggle wiring with the REAL Topbar + SidebarToggleButton.
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.value,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/analytics', () => ({ identify: vi.fn() }));
vi.mock('@/components/dashboard/sidebar', () => ({
  Sidebar: () => {
    sidebarRenders.count += 1;
    return <div data-testid="desktop-sidebar" />;
  },
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetTitle: () => null,
}));
vi.mock('@/components/dashboard/command-palette-launcher', () => ({
  CommandPaletteLauncher: () => null,
}));
vi.mock('@/components/dashboard/edge-swipe-opener', () => ({ EdgeSwipeOpener: () => null }));
vi.mock('@/components/dashboard/nav-progress-bar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nav-progress-bar')>();
  return {
    NavProgressBar: () => (realProgressBar.value ? <actual.NavProgressBar /> : null),
  };
});
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

import {
  recordRouterTransitionStart,
  resetRouterNavigationForTests,
} from '@/lib/navigation/router-navigation';

import { DashboardShell } from './dashboard-shell';

const baseProps = {
  email: 'a@b.com',
  fullName: 'Test User',
  avatarUrl: null,
  userId: 'u1',
  organizationId: 'o1',
  organizationName: 'Org',
  memberships: [],
  userName: 'Test User',
  userRole: 'Owner · Org',
  role: 'owner' as const,
  enabledModules: [] as string[],
  navOverrides: null,
  orderStatusConfig: null,
  isPlatformAdmin: false,
};

function setViewport(desktop: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) =>
      ({
        matches: desktop,
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

beforeEach(() => {
  document.cookie = 'sp_sidebar_hidden=; path=/; max-age=0';
});
afterEach(() => vi.restoreAllMocks());

describe('DashboardShell sidebar hide', () => {
  it('desktop: toggle hides the sidebar and persists the cookie', () => {
    setViewport(true);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));

    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument();
    expect(document.cookie).toContain('sp_sidebar_hidden=1');

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    expect(document.cookie).not.toContain('sp_sidebar_hidden=1');
  });

  it('desktop: Cmd/Ctrl+\\ toggles the sidebar', () => {
    setViewport(true);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument();
  });

  it('starts hidden when initialSidebarHidden is true', () => {
    setViewport(true);
    render(
      <DashboardShell {...baseProps} initialSidebarHidden>
        body
      </DashboardShell>,
    );
    expect(screen.queryByTestId('desktop-sidebar')).not.toBeInTheDocument();
  });

  it('mobile: the toggle does not hide the desktop sidebar or set the cookie', () => {
    setViewport(false);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    // Desktop sidebar is still rendered (CSS hides it at mobile width, not the DOM).
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.getByTestId('desktop-sidebar')).toBeInTheDocument();
    expect(document.cookie).not.toContain('sp_sidebar_hidden=1');
  });
});

/**
 * The late skeleton wired into the shell: the real progress bar and the real
 * PendingRouteFrame, driven by a router start (no click), as src/instrumentation-client.ts
 * reports one. The frame owns the pending state, so the rest of the shell
 * (sidebar, topbar) does not re-render while a navigation waits.
 */
describe('DashboardShell late skeleton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setViewport(true);
    resetRouterNavigationForTests();
    realProgressBar.value = true;
    pathnameRef.value = '/dashboard';
    window.history.replaceState(null, '', '/dashboard');
  });
  afterEach(() => {
    realProgressBar.value = false;
    pathnameRef.value = '/dashboard';
    vi.useRealTimers();
  });

  function page(): HTMLElement {
    // PendingRouteFrame's wrapper around the page: display:contents, or hidden.
    const el = screen.getByText('overview page').closest<HTMLElement>('.contents, .hidden');
    if (!el) throw new Error('no page wrapper');
    return el;
  }

  it('H1 a navigation still waiting at 400 ms shows the destination skeleton inside main, with the bar', () => {
    const view = render(
      <DashboardShell {...baseProps}>
        <p>overview page</p>
      </DashboardShell>,
    );
    act(() => {
      recordRouterTransitionStart('/dashboard/orders', 'push');
    });
    expect(document.querySelector('[class*="nav-progress-climb"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const skeleton = document.querySelector('main [data-pending-route-skeleton]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.querySelectorAll('[style*="grid-template-columns"]')).toHaveLength(8);
    expect(page().className).toBe('hidden');

    pathnameRef.value = '/dashboard/orders';
    view.rerender(
      <DashboardShell {...baseProps}>
        <p>orders page</p>
      </DashboardShell>,
    );
    expect(document.querySelector('[data-pending-route-skeleton]')).toBeNull();
    expect(screen.getByText('orders page')).toBeVisible();
  });

  it('H2 the sidebar does not re-render while a navigation waits (the frame owns that state)', () => {
    render(
      <DashboardShell {...baseProps}>
        <p>overview page</p>
      </DashboardShell>,
    );
    const before = sidebarRenders.count;
    act(() => {
      recordRouterTransitionStart('/dashboard/orders', 'push');
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.querySelector('[data-pending-route-skeleton]')).not.toBeNull();
    act(() => {
      recordRouterTransitionStart('/dashboard', 'push');
    });
    expect(document.querySelector('[data-pending-route-skeleton]')).toBeNull();
    expect(sidebarRenders.count).toBe(before);
  });
});
