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

  // 0371: a staff member or viewer sees holdings only in their own warehouses.
  // Placed stock elsewhere is ONE entry: a count and how many places, never a
  // per-location quantity, and never a remove target.
  it('adds one "placed in other warehouses" entry after the visible racks', () => {
    render(
      <PlacementsBreakdown
        placements={[{ locationId: 'a', name: '22-B', kind: 'rack', quantity: 12 }]}
        itemId="item-1"
        itemName="Persepolis"
        canRemoveStock
        elsewhere={{ quantity: 7, locationCount: 1 }}
      />,
    );
    expect(screen.getByTestId('placements-elsewhere')).toHaveTextContent(
      '7 placed in other warehouses (1 location)',
    );
    // Only the visible rack can be written off from here.
    expect(screen.getAllByRole('button', { name: /Remove stock from/i })).toHaveLength(1);
  });

  it('renders the entry alone when none of the placed stock is the viewer\'s', () => {
    render(
      <PlacementsBreakdown
        placements={[{ locationId: 'u', name: 'Unplaced', kind: 'unplaced', quantity: 20 }]}
        elsewhere={{ quantity: 7, locationCount: 2 }}
      />,
    );
    expect(screen.getByText('7 placed in other warehouses (2 locations)')).toBeInTheDocument();
  });

  it('renders nothing extra when nothing is elsewhere (managers, or a 0 count)', () => {
    const { container } = render(
      <PlacementsBreakdown placements={[]} elsewhere={{ quantity: 0, locationCount: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
