import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/categories',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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

import { CategoriesManager } from './categories-manager';

/**
 * Task 12's acceptance line is "a Sports root with eight subcategories, each
 * showing its resolved mode and counting unit". The live verification found the
 * MODE rendered and the UNIT missing everywhere on the screen: a Shoes row read
 * `Shoes | Tracking: Quantity by variant | Public` with no "pairs" anywhere, and
 * the editor dialog exposes no counting-unit control either. The unit was
 * resolving correctly elsewhere (the item form's grouping preview reads
 * "Counting unit pairs"), so this is purely the categories screen not saying it.
 *
 * The unit resolves through the SAME fallback chain the server's
 * `resolveTrackingProfile` uses — own column, then the parent's, then the
 * subcategory profile's default — so the screen can never claim a unit the
 * server would not stamp.
 */
function row(over: Partial<Parameters<typeof CategoriesManager>[0]['initial'][number]> = {}) {
  return {
    id: 'cat-1',
    name: 'Shoes',
    description: null,
    color: null,
    supports_sizes: true,
    public_visibility: 'public' as const,
    parent_id: 'cat-sports-root',
    tracking_mode: null,
    sports_subcategory_key: 'shoes',
    tracking_profile: null,
    default_unit_of_measure: null,
    ...over,
  };
}

const SPORTS_ROOT = row({
  id: 'cat-sports-root',
  name: 'Sports',
  parent_id: null,
  sports_subcategory_key: null,
  supports_sizes: false,
});

function renderManager(rows: ReturnType<typeof row>[], sportsEnabled = true) {
  render(
    <CategoriesManager
      initial={rows}
      canManage={false}
      canManagePublicVisibility={false}
      sportsEnabled={sportsEnabled}
      canManageSports={false}
    />,
  );
}

describe('CategoriesManager — the resolved counting unit is rendered', () => {
  it('shows the subcategory profile default beside the tracking mode (pairs for Shoes)', () => {
    renderManager([SPORTS_ROOT, row()]);
    expect(screen.getByText(/Quantity by variant/)).toBeTruthy();
    expect(screen.getByText(/pairs/)).toBeTruthy();
  });

  it("prefers the category's own counting unit over the profile default", () => {
    renderManager([SPORTS_ROOT, row({ default_unit_of_measure: 'set' })]);
    expect(screen.getByText(/sets/)).toBeTruthy();
    expect(screen.queryByText(/pairs/)).toBeNull();
  });

  it("inherits the parent's counting unit when the child has none", () => {
    renderManager([
      row({
        id: 'cat-sports-root',
        name: 'Sports',
        parent_id: null,
        sports_subcategory_key: null,
        default_unit_of_measure: 'case',
      }),
      row({ sports_subcategory_key: null, tracking_mode: 'QUANTITY', default_unit_of_measure: null }),
    ]);
    expect(screen.getByText(/cases/)).toBeTruthy();
  });

  it("renders 'each' without pluralising it", () => {
    renderManager([SPORTS_ROOT, row({ sports_subcategory_key: 'jerseys' })]);
    expect(screen.getByText(/Numbered variant/)).toBeTruthy();
    expect(screen.getByText(/each/)).toBeTruthy();
  });

  it('a plain category still renders with no sports affordances at all (regression)', () => {
    renderManager(
      [row({ id: 'cat-plain', name: 'Electronics', parent_id: null, sports_subcategory_key: null })],
      true,
    );
    expect(screen.queryByText(/Tracking:/)).toBeNull();
    expect(screen.queryByText(/Counting unit/)).toBeNull();
  });

  it('renders nothing sports-related with the module off (regression)', () => {
    renderManager([SPORTS_ROOT, row()], false);
    expect(screen.queryByText(/Tracking:/)).toBeNull();
    expect(screen.queryByText(/Counting unit/)).toBeNull();
  });
});
