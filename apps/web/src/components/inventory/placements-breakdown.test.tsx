import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlacementsBreakdown } from './placements-breakdown';

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
});
