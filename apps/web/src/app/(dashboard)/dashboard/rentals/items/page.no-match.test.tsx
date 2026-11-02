import { act, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rentals items with the REAL table (page.test.tsx stubs it): what a view that
 * a filter or a search leaves empty shows. Rentals items is always server mode.
 *
 * Integrator decision 1 (2026-10-20): the page's own message for a search that
 * matches nothing, "No rental items match your search" with "Clear search",
 * stays word for word. Batch D moved those views to the table so the filter bar
 * stays on screen; the words now show in the table's empty area, with the
 * search box, the filters and "Clear all filters" around them. A Category (or
 * any other narrowing) shows the table's general line, "No items match your
 * filters.", as before batch D the app showed right after the tick.
 */

const h = vi.hoisted(() => ({
  total: 0,
  params: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.params),
  usePathname: () => '/dashboard/rentals/items',
}));
vi.mock('next/link', () => ({
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
    prefetch?: boolean;
    scroll?: boolean;
    replace?: boolean;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt } = props as { src: string; alt?: string };
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ''} />;
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/saved-views', () => ({
  createSavedViewAction: vi.fn(),
  deleteSavedViewAction: vi.fn(),
  setActiveWarehouseAction: vi.fn(),
  toggleSavedViewShareAction: vi.fn(),
}));
vi.mock('@/lib/download-export', () => ({ downloadInventoryExport: vi.fn() }));
vi.mock('@/components/inventory/bulk-actions', () => ({ BulkActions: () => null }));
vi.mock('@/components/ui/image-hover-preview', () => ({
  ImageHoverPreview: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  prewarmPreviewImages: vi.fn(),
}));
vi.mock('@/lib/cycle-counts/use-count-selection', () => ({
  useCountSelection: (selector: (s: { add: () => void }) => unknown) => selector({ add: vi.fn() }),
}));
vi.mock('@/components/rentals/rentals-tabs', () => ({ RentalsTabs: () => null }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff',
    permissions: new Set(['items:create']),
  })),
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: {
    forCurrentUser: vi.fn(async () => ({
      list: vi.fn(async () => ({ items: [], total: h.total, elsewhereUnavailable: false })),
      reservedQuantityByItemIds: vi.fn(async () => new Map()),
    })),
  },
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: {
    forCurrentUser: vi.fn(async () => ({
      list: vi.fn(async () => [{ id: 'cat-apparel', name: 'Apparel', color: null }]),
    })),
  },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: {
    forCurrentUser: vi.fn(async () => ({ listForLookups: vi.fn(async () => []) })),
  },
}));
vi.mock('@/server/services/tags', () => ({
  TagsService: { forCurrentUser: vi.fn(async () => ({ list: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: {
    forCurrentUser: vi.fn(async () => ({
      primaryImagesWithThumbsForItems: vi.fn(async () => new Map()),
    })),
  },
}));
vi.mock('@/server/services/movements', () => ({ getItemTrends: vi.fn(async () => new Map()) }));

import RentalItemsPage from './page';

async function renderPage(params: Record<string, string>) {
  h.params = new URLSearchParams(params).toString();
  const page = await RentalItemsPage({ searchParams: Promise.resolve(params) });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(page);
  });
  return view;
}

beforeEach(() => {
  h.total = 0;
  h.params = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ items: [], total: 0 }) })),
  );
});

describe('Rentals items, a search that matches nothing (reloaded, pasted, any role)', () => {
  it('says "No rental items match your search" with "Clear search", under the search box, the filters and Clear all filters', async () => {
    const view = await renderPage({ q: 'tent' });
    const area = view.container.querySelector('[data-slot="state-panel"]') as HTMLElement;
    const panel = within(area);
    expect(
      panel.getByRole('heading', { level: 3, name: 'No rental items match your search' }),
    ).toBeInTheDocument();
    expect(area.querySelector('p')?.textContent).toBe(
      'Nothing matched "tent". Try a different name or SKU.',
    );
    expect(panel.getByRole('link', { name: 'Clear search' })).toHaveAttribute(
      'href',
      '/dashboard/rentals/items',
    );
    expect(screen.getByRole('textbox', { name: 'Search items' })).toHaveValue('tent');
    expect(screen.getByRole('button', { name: 'Filter by Category' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument();
    expect(screen.queryByText('No rental items yet')).toBeNull();
    expect(screen.queryByText('No items match your filters.')).toBeNull();
  });

  it('a Category with it: the general line, as when several narrow the list', async () => {
    const view = await renderPage({ q: 'tent', cat: 'cat-apparel' });
    const area = view.container.querySelector('[data-slot="state-panel"]') as HTMLElement;
    expect(area.textContent).toBe('No items match your filters.');
    expect(screen.queryByText('No rental items match your search')).toBeNull();
  });

  it('a Category alone: the general line and the ticked filter', async () => {
    await renderPage({ cat: 'cat-apparel' });
    expect(screen.getByText('No items match your filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter by Category' })).toHaveTextContent(
      /Category\s*1/,
    );
    expect(screen.queryByText('No rental items yet')).toBeNull();
  });
});
