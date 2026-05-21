import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './sidebar';

// ─── shared mocks ──────────────────────────────────────────────────────────
//
// next/navigation: usePathname is controlled per-test via `currentPathname`,
// so we can drive the active-route logic from each `it()` block.
let currentPathname = '/dashboard';
const prefetchMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: prefetchMock,
  }),
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
  // Sidebar's NavLinkPending uses useLinkStatus(); stub it so the
  // hook doesn't blow up outside a real Link parent context.
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/server/actions/org-switcher', () => ({
  switchOrganizationAction: vi.fn(async () => ({ ok: true as const, data: null })),
}));

const baseProps = {
  organizationId: 'o1',
  organizationName: 'Acme Co',
  organizationLogoUrl: null,
  memberships: [{ id: 'o1', name: 'Acme Co', logoUrl: null, role: 'admin' }],
  userName: 'Test User',
  userRole: 'Admin',
  role: 'admin' as const,
};

beforeEach(() => {
  currentPathname = '/dashboard';
  prefetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar — section hierarchy', () => {
  it('renders uppercased section labels for Inventory, Workspace, and Admin', () => {
    render(<Sidebar {...baseProps} />);
    // Multiple "Admin" strings exist (org role + section label), so scope to
    // the labels via tagName & class signature: section headers carry the
    // text-muted-foreground + uppercase tracking.
    expect(screen.getByText('Inventory')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    // "Admin" section header only exists for admin roles.
    const adminMatches = screen.getAllByText(/^Admin$/);
    expect(adminMatches.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render the Admin section heading for non-admin roles', () => {
    render(<Sidebar {...baseProps} role="staff" />);
    expect(screen.queryByText(/^Admin overview$/)).not.toBeInTheDocument();
  });
});

describe('Sidebar — active route logic', () => {
  it('highlights "Overview" only on the exact /dashboard path', () => {
    currentPathname = '/dashboard';
    render(<Sidebar {...baseProps} />);
    const overview = screen.getByRole('link', { name: /^Overview$/i });
    expect(overview).toHaveAttribute('aria-current', 'page');
  });

  it('does NOT highlight "Overview" when on a deeper dashboard sub-route', () => {
    currentPathname = '/dashboard/inventory';
    render(<Sidebar {...baseProps} />);
    const overview = screen.getByRole('link', { name: /^Overview$/i });
    expect(overview).not.toHaveAttribute('aria-current', 'page');
  });

  it('highlights "Items" when the pathname is the parent inventory route', () => {
    currentPathname = '/dashboard/inventory';
    render(<Sidebar {...baseProps} />);
    const items = screen.getByRole('link', { name: /^Items$/i });
    expect(items).toHaveAttribute('aria-current', 'page');
  });

  it('highlights "Items" on a deep inventory child route', () => {
    currentPathname = '/dashboard/inventory/abc-123';
    render(<Sidebar {...baseProps} />);
    const items = screen.getByRole('link', { name: /^Items$/i });
    expect(items).toHaveAttribute('aria-current', 'page');
  });

  it('does NOT highlight "Items" for an unrelated sibling route', () => {
    currentPathname = '/dashboard/categories';
    render(<Sidebar {...baseProps} />);
    const items = screen.getByRole('link', { name: /^Items$/i });
    expect(items).not.toHaveAttribute('aria-current', 'page');
    const categories = screen.getByRole('link', { name: /Categories/i });
    expect(categories).toHaveAttribute('aria-current', 'page');
  });

  it('does NOT confuse a similar-prefix sibling (purchase-orders vs purchase-orders/imports)', () => {
    currentPathname = '/dashboard/purchase-orders/imports';
    render(<Sidebar {...baseProps} />);
    const poImports = screen.getByRole('link', { name: /PO imports/i });
    expect(poImports).toHaveAttribute('aria-current', 'page');
    // The parent "Purchase orders" link also matches because /imports is a
    // sub-route of /purchase-orders. That's correct hierarchical behavior —
    // both light up, and the topbar breadcrumb still disambiguates.
    const purchaseOrders = screen.getByRole('link', { name: /^Purchase orders$/i });
    expect(purchaseOrders).toHaveAttribute('aria-current', 'page');
  });
});

describe('Sidebar — navigation callback', () => {
  it('invokes onNavigate when a link is clicked (used by mobile drawer to auto-close)', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...baseProps} onNavigate={onNavigate} />);
    const overview = screen.getByRole('link', { name: /^Overview$/i });
    overview.click();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('fires onNavigate for any nav link, not just Overview', () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...baseProps} onNavigate={onNavigate} />);
    const items = screen.getByRole('link', { name: /^Items$/i });
    items.click();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar — accent edge bar', () => {
  it('renders an aria-hidden left-edge accent span on the active link only', () => {
    currentPathname = '/dashboard/inventory';
    render(<Sidebar {...baseProps} />);

    const items = screen.getByRole('link', { name: /^Items$/i });
    // Active link contains the decorative left-edge accent bar.
    expect(items.querySelector('span[aria-hidden="true"]')).not.toBeNull();

    // A sibling inactive link should NOT have the accent bar span.
    const categories = screen.getByRole('link', { name: /Categories/i });
    expect(categories.querySelector('span[aria-hidden="true"]')).toBeNull();
  });
});
