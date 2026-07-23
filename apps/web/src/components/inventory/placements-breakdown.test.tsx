import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementsBreakdown } from './placements-breakdown';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/server/actions/inventory', () => ({
  removeStockFromLocationAction: vi.fn(),
}));

describe('PlacementsBreakdown', () => {
  it('shows placed locations only, excluding staging and unplaced', () => {
    render(
      <PlacementsBreakdown
        placements={[
          { locationId: 'a', name: 'Main Distribution Center', kind: null, quantity: 240 },
          { locationId: 's', name: 'Staging', kind: 'staging', quantity: 1 },
          { locationId: 'u', name: 'Unplaced', kind: 'unplaced', quantity: 3 },
        ]}
      />,
    );
    // Placed location renders...
    expect(screen.getByText('240')).toBeInTheDocument();
    expect(screen.getByText(/in Main Distribution Center/)).toBeInTheDocument();
    // ...but staging/unplaced are owned by the amber "awaiting put-away" line,
    // so they must NOT appear here (no "staged" badge, no "in Unplaced").
    expect(screen.queryByText(/staged/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/in Unplaced/i)).not.toBeInTheDocument();
  });

  it('renders nothing when all stock is staged/unplaced (no placed rows)', () => {
    const { container } = render(
      <PlacementsBreakdown
        placements={[
          { locationId: 's', name: 'Staging', kind: 'staging', quantity: 5 },
          { locationId: 'u', name: 'Unplaced', kind: 'unplaced', quantity: 2 },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no placements', () => {
    const { container } = render(<PlacementsBreakdown placements={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a per-rack remove control ONLY when canRemoveStock + item identity are supplied', () => {
    render(
      <PlacementsBreakdown
        placements={[
          { locationId: 'a', name: '22-B', kind: 'rack', quantity: 12 },
          { locationId: 'b', name: '30-C', kind: 'rack', quantity: 4 },
        ]}
        itemId="item-1"
        itemName="Persepolis"
        canRemoveStock
      />,
    );
    // One remove affordance per placed holding, each naming its own rack.
    expect(screen.getByRole('button', { name: /Remove stock from 22-B/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove stock from 30-C/i })).toBeInTheDocument();
  });

  it('hides the remove control when the viewer lacks stock:adjust (canRemoveStock unset)', () => {
    render(
      <PlacementsBreakdown
        placements={[{ locationId: 'a', name: '22-B', kind: 'rack', quantity: 12 }]}
        itemId="item-1"
        itemName="Persepolis"
      />,
    );
    expect(screen.queryByRole('button', { name: /Remove stock from/i })).not.toBeInTheDocument();
  });
});
