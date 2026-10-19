// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import LocationLoading from '@/app/(dashboard)/dashboard/locations/[id]/loading';
import LocationsLoading from '@/app/(dashboard)/dashboard/locations/loading';
import WarehousesLoading from '@/app/(dashboard)/dashboard/warehouses/loading';

/**
 * The route skeletons of the Locations list, a location's page and a
 * warehouse's page, each drawn in its page's final shape (redesign W-BK-12 to
 * W-BK-14). A skeleton is busy, says what is loading to a screen reader, and
 * draws grey bars only: no words or figures a reader could take for data.
 */
describe('route skeletons for locations and warehouses', () => {
  it.each([
    ['locations/loading.tsx', LocationsLoading, 'locations-page-skeleton', 'Loading locations'],
    [
      'locations/[id]/loading.tsx',
      LocationLoading,
      'location-page-skeleton',
      'Loading this location',
    ],
    [
      'warehouses/loading.tsx',
      WarehousesLoading,
      'warehouse-page-skeleton',
      'Loading this warehouse',
    ],
  ] as const)('%s draws its page-shaped skeleton', (_file, Loading, testId, label) => {
    render(<Loading />);
    const root = screen.getByTestId(testId);
    expect(root).toHaveAttribute('aria-busy', 'true');
    // The page box every redesigned page uses.
    expect(root.className).toContain('max-w-[1320px]');
    // The only text is the screen-reader label: no words or numbers to
    // misread as data.
    expect(root.textContent).toBe(label);
    expect(screen.getByText(label)).toHaveClass('sr-only');
  });

  it('the Locations skeleton draws the three group tabs and six table rows', () => {
    render(<LocationsLoading />);
    expect(screen.getByTestId('locations-skeleton-groups').children).toHaveLength(3);
    expect(screen.getAllByTestId('locations-skeleton-row')).toHaveLength(6);
  });

  it('the warehouse skeleton draws the four-figure strip and its three cards', () => {
    render(<WarehousesLoading />);
    expect(screen.getAllByTestId('warehouse-skeleton-stat')).toHaveLength(4);
    expect(screen.getAllByTestId('warehouse-skeleton-card')).toHaveLength(3);
  });
});
