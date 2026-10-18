import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pathnameRef, sidebarRenders, realProgressBar, lastProps } = vi.hoisted(() => ({
  pathnameRef: { value: '/dashboard' },
  sidebarRenders: { count: 0 },
  // The props the stubbed Sidebar and UserMenu were last rendered with.
  lastProps: {
    sidebar: null as null | Record<string, unknown>,
    userMenu: null as null | Record<string, unknown>,
  },
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
  Sidebar: (props: Record<string, unknown>) => {
    sidebarRenders.count += 1;
    lastProps.sidebar = props;
    return <div data-testid="desktop-sidebar" />;
  },
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetTitle: () => null,
  SheetClose: () => null,
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
vi.mock('@/components/dashboard/user-menu', () => ({
  UserMenu: (props: Record<string, unknown>) => {
    lastProps.userMenu = props;
    return null;
  },
}));
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
  document.cookie = 'sp_density=; path=/; max-age=0';
  document.cookie = 'sp_nav_collapsed=; path=/; max-age=0';
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

/**
 * The redesign's shell root (PLAN P2.3): the .sp-shell type scope and the
 * per-viewer density, plus the collapsed nav sections the two sidebars share.
 */
describe('DashboardShell type scope, density and nav sections', () => {
  function shellRoot(): HTMLElement {
    const root = document.querySelector<HTMLElement>('.sp-shell');
    if (!root) throw new Error('no .sp-shell root');
    return root;
  }

  it('the root carries .sp-shell and the comfortable density by default', () => {
    setViewport(true);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(shellRoot()).toHaveAttribute('data-density', 'comfortable');
    // The root holds the whole frame: sidebar, header and the one main.
    expect(shellRoot().querySelector('main#main-content')).not.toBeNull();
    expect(shellRoot().querySelector('header')).not.toBeNull();
  });

  it('starts from the density the layout read, and a change from the account menu applies and persists', () => {
    setViewport(true);
    render(
      <DashboardShell {...baseProps} initialDensity="compact">
        body
      </DashboardShell>,
    );
    expect(shellRoot()).toHaveAttribute('data-density', 'compact');
    expect(lastProps.userMenu?.density).toBe('compact');

    act(() => {
      (lastProps.userMenu?.onDensityChange as (d: string) => void)('comfortable');
    });
    expect(shellRoot()).toHaveAttribute('data-density', 'comfortable');
    expect(document.cookie).not.toContain('sp_density=compact');

    act(() => {
      (lastProps.userMenu?.onDensityChange as (d: string) => void)('compact');
    });
    expect(shellRoot()).toHaveAttribute('data-density', 'compact');
    expect(document.cookie).toContain('sp_density=compact');
  });

  it('hands the sidebar the role default (Admin folded for an owner) until the viewer chooses', () => {
    setViewport(true);
    render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(lastProps.sidebar?.collapsedSections).toEqual(['admin']);

    act(() => {
      (lastProps.sidebar?.onToggleSection as (k: string, c: boolean) => void)('admin', false);
    });
    expect(lastProps.sidebar?.collapsedSections).toEqual([]);
    expect(document.cookie).toContain('sp_nav_collapsed=');
    expect(document.cookie).not.toContain('sp_nav_collapsed=admin');

    act(() => {
      (lastProps.sidebar?.onToggleSection as (k: string, c: boolean) => void)('inventory', true);
    });
    expect(lastProps.sidebar?.collapsedSections).toEqual(['inventory']);
    expect(document.cookie).toContain('sp_nav_collapsed=inventory');
  });

  it("starts from the viewer's saved sections when the layout read them", () => {
    setViewport(true);
    render(
      <DashboardShell {...baseProps} initialCollapsedSections={['workspace']}>
        body
      </DashboardShell>,
    );
    expect(lastProps.sidebar?.collapsedSections).toEqual(['workspace']);
  });
});

/**
 * The page lock (body fixed, html 100% tall, so only <main> scrolls) is undone
 * when the dashboard unmounts. It used to put back the whole <html> class and
 * style attributes it saw at mount, so a theme chosen in the dashboard was
 * reverted on the way out (sign out after switching to Light: the landing page
 * came up Dark). Only what the lock itself changed is put back now.
 */
describe('DashboardShell page lock', () => {
  it('locks the body while mounted', () => {
    setViewport(true);
    document.body.className = 'min-h-screen bg-background';
    const view = render(<DashboardShell {...baseProps}>body</DashboardShell>);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.height).toBe('100%');
    expect(document.body.classList.contains('min-h-screen')).toBe(false);
    view.unmount();
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.height).toBe('');
    expect(document.body.classList.contains('min-h-screen')).toBe(true);
    document.body.className = '';
  });

  it('leaving the dashboard keeps the theme chosen while it was open', () => {
    setViewport(true);
    const html = document.documentElement;
    html.className = 'font-vars dark';
    const view = render(<DashboardShell {...baseProps}>body</DashboardShell>);
    // The person picks Light in the account menu: next-themes rewrites the
    // class and writes other inline styles on <html> as it goes.
    html.className = 'font-vars light';
    html.style.setProperty('--theme-probe', 'light');
    view.unmount();
    expect(html.className).toBe('font-vars light');
    expect(html.style.getPropertyValue('--theme-probe')).toBe('light');
    expect(html.style.height).toBe('');
    html.className = '';
    html.removeAttribute('style');
  });
});
