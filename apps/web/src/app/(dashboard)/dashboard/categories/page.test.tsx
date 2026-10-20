// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Categories page (W-BK-10). Kept: the header paints at once (the Suspense
 * fallback draws the h1, the Active or Archived subline and the toggle) while
 * only the cards stream; `?view=archived` reads the archived rows; New
 * category for categories:manage, Set up Sports for the sports module plus
 * sports:manage, the Public / Internal only select for public_links:manage;
 * the tab title. Added by the redesign (PLAN rule 10): the h1 follows a
 * Settings > Navigation rename of the Categories sidebar entry, in the first
 * paint and in the streamed header alike, and keeps "Categories" when there
 * is no rename or the lookup fails.
 */

const h = vi.hoisted(() => ({
  ctx: { organizationId: 'org-1', userId: 'u-1', role: 'manager', permissions: null } as Record<
    string,
    unknown
  >,
  list: vi.fn(),
  effectiveNavLabel: vi.fn(),
  sportsEnabled: false,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/categories',
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
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: h.sportsEnabled, canManage: false })),
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: { forCurrentUser: vi.fn(async () => ({ list: h.list })) },
}));
vi.mock('@/server/actions/categories', () => ({
  archiveCategoryAction: vi.fn(),
  createCategoryAction: vi.fn(),
  restoreCategoryAction: vi.fn(),
  setupSportsCategoriesAction: vi.fn(),
  updateCategoryAction: vi.fn(),
}));
vi.mock('@/server/actions/item-visibility', () => ({
  setCategoryPublicVisibilityAction: vi.fn(),
}));

import CategoriesPage, { metadata } from './page';

const ROWS = [
  {
    id: 'cat-a',
    name: 'Apparel',
    description: 'Team wear',
    color: '#6366f1',
    supports_sizes: true,
    public_visibility: 'public',
    parent_id: null,
    tracking_mode: null,
    sports_subcategory_key: null,
    tracking_profile: null,
    default_unit_of_measure: null,
  },
];

type El = React.ReactElement<Record<string, unknown>>;

/**
 * The page's tree: the page box holding one Suspense whose fallback is the
 * first paint and whose child is the async section that streams the cards.
 */
async function page(view?: string) {
  const tree = (await CategoriesPage({
    searchParams: Promise.resolve(view ? { view } : {}),
  })) as El;
  const suspense = tree.props.children as El;
  const fallback = suspense.props.fallback as React.ReactElement;
  const section = suspense.props.children as El;
  const Section = section.type as (props: Record<string, unknown>) => Promise<React.ReactElement>;
  return { fallback, streamed: () => Section(section.props) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ctx = { organizationId: 'org-1', userId: 'u-1', role: 'manager', permissions: null };
  h.sportsEnabled = false;
  h.list.mockResolvedValue(ROWS);
  h.effectiveNavLabel.mockImplementation(async (_href: string, fallback: string) => fallback);
});

describe('Categories page', () => {
  it('names the tab Categories (CONFLICTS D16)', () => {
    expect(metadata).toEqual({ title: 'Categories' });
  });

  it('the first paint draws the header with the toggle before any category is read', async () => {
    const { fallback } = await page();
    render(fallback);
    expect(screen.getByRole('heading', { level: 1, name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByText('Group items so filters and reports stay tidy.')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'View filter' })).toBeInTheDocument();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.effectiveNavLabel).toHaveBeenCalledWith('/dashboard/categories', 'Categories');
  });

  it('the streamed header keeps New category for categories:manage and the cards', async () => {
    const { streamed } = await page();
    render(await streamed());
    expect(screen.getByRole('heading', { level: 1, name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New category/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apparel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up Sports/ })).not.toBeInTheDocument();
    expect(h.list).toHaveBeenCalledWith({ includeArchived: false });
  });

  it('the h1 follows a Settings > Navigation rename in the first paint and the streamed header (PLAN rule 10)', async () => {
    h.effectiveNavLabel.mockResolvedValue('Product types');
    const { fallback, streamed } = await page();
    const first = render(fallback);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Product types');
    first.unmount();
    render(await streamed());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Product types');
  });

  it('a failed lookup keeps "Categories" instead of failing the page', async () => {
    h.effectiveNavLabel.mockRejectedValue(new Error('org row unreadable'));
    const { fallback } = await page();
    render(fallback);
    expect(screen.getByRole('heading', { level: 1, name: 'Categories' })).toBeInTheDocument();
  });

  it('?view=archived: the archived subline and rows, Restore and no New category', async () => {
    const { fallback, streamed } = await page('archived');
    const first = render(fallback);
    expect(
      screen.getByText(
        'Categories you archived. Restore one to bring it back into filters and item forms.',
      ),
    ).toBeInTheDocument();
    first.unmount();
    render(await streamed());
    expect(h.list).toHaveBeenCalledWith({ includeArchived: true });
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New category/ })).not.toBeInTheDocument();
  });

  it('a viewer reads the cards with no New category, edit or Archive', async () => {
    h.ctx = { organizationId: 'org-1', userId: 'u-2', role: 'viewer', permissions: null };
    const { streamed } = await page();
    render(await streamed());
    expect(screen.getByText('Apparel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New category/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apparel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive Apparel' })).not.toBeInTheDocument();
  });

  it('Set up Sports needs the sports module and sports:manage', async () => {
    h.sportsEnabled = true;
    h.ctx = { organizationId: 'org-1', userId: 'u-1', role: 'admin', permissions: null };
    const { streamed } = await page();
    render(await streamed());
    expect(screen.getByRole('button', { name: /Set up Sports/ })).toBeInTheDocument();
  });
});
