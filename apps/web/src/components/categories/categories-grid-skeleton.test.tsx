// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CategoriesLoading from '@/app/(dashboard)/dashboard/categories/loading';

import { CategoriesGridSkeleton } from './categories-grid-skeleton';

/**
 * The Categories skeletons (W-BK-10): the route's whole-page skeleton and the
 * card grid the page streams behind its header. Both are busy or inside a
 * busy region, name what is loading for a screen reader, and draw grey bars
 * only (no words or figures).
 */
describe('Categories skeletons', () => {
  it('categories/loading.tsx draws the header shape and the card grid', () => {
    render(<CategoriesLoading />);
    const root = screen.getByTestId('categories-page-skeleton');
    expect(root.className).toContain('max-w-[1320px]');
    expect(root.textContent).toBe('Loading categories');
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('the streamed grid skeleton is busy and holds six cards by default', () => {
    const { container } = render(<CategoriesGridSkeleton />);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading categories')).toHaveClass('sr-only');
    // The label, then one card per placeholder.
    expect(grid.children).toHaveLength(7);
  });
});
