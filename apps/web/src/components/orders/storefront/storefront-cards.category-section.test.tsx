import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CategorySection } from './storefront-cards';

// The category header had an "Add full kit" button for any category whose name
// matched /new hire/i: one of every in-stock item of the category, which in DC4
// was 18 lines, 13 of them polo sizes, where the kit people order is 4 lines.
// Kits now come from Bundles (storefront-kit-card.tsx); the header only folds
// and links to the whole category (owner decision 7, 2026-09-27).
describe('CategorySection', () => {
  it('a "New Hire" category header has no kit button, only fold and View all', () => {
    render(
      <CategorySection
        name="New Hire"
        itemCount={19}
        open
        onToggle={vi.fn()}
        shownCount={4}
        onViewAll={vi.fn()}
        icon={null}
      >
        <div />
      </CategorySection>,
    );
    expect(screen.queryByText(/full kit/i)).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Collapse New Hire',
      'View all 19 ',
    ]);
  });
});
