import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy / native-dependency children are stubbed so we can exercise the
// shell's own toggle wiring with the REAL Topbar + SidebarToggleButton.
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/analytics', () => ({ identify: vi.fn() }));
vi.mock('@/components/dashboard/sidebar', () => ({
  Sidebar: () => <div data-testid="desktop-sidebar" />,
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetTitle: () => null,
}));
vi.mock('@/components/dashboard/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/dashboard/edge-swipe-opener', () => ({ EdgeSwipeOpener: () => null }));
vi.mock('@/components/dashboard/nav-progress-bar', () => ({ NavProgressBar: () => null }));
vi.mock('@/components/version-notifier', () => ({ VersionNotifier: () => null }));
vi.mock('@/components/dashboard/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/dashboard/user-menu', () => ({ UserMenu: () => null }));
vi.mock('@/components/dashboard/warehouse-filter-picker', () => ({
  WarehouseFilterPicker: () => null,
}));
vi.mock('@/components/theme/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/dashboard/keyboard-shortcuts', () => ({
  KeyboardShortcutsProvider: () => null,
  openKeyboardShortcutsOverlay: vi.fn(),
}));
vi.mock('@/components/orders/order-status-config-provider', () => ({
  OrderStatusConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DashboardShell } from './dashboard-shell';

const baseProps = {
  email: 'a@b.com',
  fullName: 'Test User',
  avatarUrl: null,
  userId: 'u1',
  initialUnreadNotifications: 0,
  organizationId: 'o1',
  organizationName: 'Org',
  memberships: [],
  userName: 'Test User',
  userRole: 'Owner · Org',
  role: 'owner' as const,
  enabledModules: [] as string[],
  navOverrides: null,
  orderStatusConfig: null,
};

function setViewport(desktop: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) => ({ matches: desktop, media: q } as MediaQueryList),
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
