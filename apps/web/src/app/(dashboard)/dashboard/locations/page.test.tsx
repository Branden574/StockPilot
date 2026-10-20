// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Locations list (W-BK-12). Kept: the Active and Archived views
 * (`?view=archived` reads archived rows), New location for locations:manage
 * only, the three groups with their counts, each row's warehouse name, the
 * rows of other warehouses hidden when the warehouse picker is set, and the
 * tab title. Added by the redesign (PLAN rule 10): the h1 follows a Settings >
 * Navigation rename of the Locations sidebar entry, as the sidebar and the
 * crumb already do, and keeps "Locations" when there is no rename or the
 * lookup fails.
 */

const h = vi.hoisted(() => ({
  ctx: { organizationId: 'org-1', userId: 'u-1', role: 'manager', permissions: null } as Record<
    string,
    unknown
  >,
  list: vi.fn(),
  effectiveNavLabel: vi.fn(),
  warehouseFilter: null as string | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/locations',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      prefetch: _prefetch,
      scroll: _scroll,
      replace: _replace,
      ...rest
    }: {
      href: string;
      children: React.ReactNode;
      prefetch?: unknown;
      scroll?: unknown;
      replace?: unknown;
    }) => React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn(async () => h.ctx) }));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: (...args: unknown[]) => h.effectiveNavLabel(...args),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: vi.fn(async () => [
    { id: 'wh-north', name: 'North DC' },
    { id: 'wh-south', name: 'South DC' },
  ]),
}));
vi.mock('@/lib/warehouse-filter', () => ({
  getActiveWarehouseFilter: vi.fn(async () => h.warehouseFilter),
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: h.list })) },
}));
vi.mock('@/server/actions/locations', () => ({
  archiveLocationAction: vi.fn(),
  createLocationAction: vi.fn(),
  restoreLocationAction: vi.fn(),
  updateLocationAction: vi.fn(),
}));

import LocationsPage, { metadata } from './page';

const ROWS = [
  {
    id: 'loc-1',
    name: 'North DC Building',
    type: 'warehouse',
    kind: null,
    notes: null,
    warehouse_id: 'wh-north',
  },
  {
    id: 'loc-2',
    name: 'South DC Building',
    type: 'warehouse',
    kind: null,
    notes: null,
    warehouse_id: 'wh-south',
  },
  { id: 'loc-3', name: '12-A', type: null, kind: 'rack', notes: null, warehouse_id: 'wh-north' },
  {
    id: 'loc-4',
    name: 'Staging',
    type: null,
    kind: 'staging',
    notes: null,
    warehouse_id: 'wh-north',
  },
];

async function renderPage(view?: string) {
  render(await LocationsPage({ searchParams: Promise.resolve(view ? { view } : {}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ctx = { organizationId: 'org-1', userId: 'u-1', role: 'manager', permissions: null };
  h.warehouseFilter = null;
  h.list.mockResolvedValue(ROWS);
  h.effectiveNavLabel.mockImplementation(async (_href: string, fallback: string) => fallback);
});

describe('Locations page', () => {
  it('names the tab Locations (CONFLICTS D16)', () => {
    expect(metadata).toEqual({ title: 'Locations' });
  });

  it('draws the h1, the groups with their counts and each site with its warehouse', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Locations' })).toBeInTheDocument();
    expect(h.effectiveNavLabel).toHaveBeenCalledWith('/dashboard/locations', 'Locations');
    const groups = screen.getByRole('group', { name: 'Location groups' });
    expect(within(groups).getByRole('button', { name: /Sites/ })).toHaveTextContent('Sites2');
    expect(within(groups).getByRole('button', { name: /Racks & shelves/ })).toHaveTextContent(
      'Racks & shelves1',
    );
    expect(within(groups).getByRole('button', { name: /System/ })).toHaveTextContent('System1');
    const north = screen.getByRole('link', { name: 'North DC Building' }).closest('tr')!;
    expect(north).toHaveTextContent('North DC');
    expect(screen.getByRole('button', { name: /New location/ })).toBeInTheDocument();
    expect(h.list).toHaveBeenCalledWith({ includeArchived: false });
  });

  it('the h1 follows a Settings > Navigation rename of the sidebar entry (PLAN rule 10)', async () => {
    h.effectiveNavLabel.mockResolvedValue('Storage areas');
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Storage areas');
  });

  it('a failed lookup keeps "Locations" instead of failing the page', async () => {
    h.effectiveNavLabel.mockRejectedValue(new Error('org row unreadable'));
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Locations' })).toBeInTheDocument();
  });

  it('?view=archived reads the archived rows and offers no New location', async () => {
    await renderPage('archived');
    expect(h.list).toHaveBeenCalledWith({ includeArchived: true });
    expect(
      screen.getByText('Locations you archived. Restore one to bring it back into pick lists.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New location/ })).not.toBeInTheDocument();
  });

  it('a reader without locations:manage gets no New location', async () => {
    h.ctx = { organizationId: 'org-1', userId: 'u-2', role: 'viewer', permissions: null };
    await renderPage();
    expect(screen.queryByRole('button', { name: /New location/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'North DC Building' })).toBeInTheDocument();
  });

  it('with the warehouse picker set, the rows of other warehouses are hidden', async () => {
    h.warehouseFilter = 'wh-north';
    await renderPage();
    expect(screen.getByRole('link', { name: 'North DC Building' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'South DC Building' })).not.toBeInTheDocument();
  });
});
