import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/purchase-orders', () => ({
  setPoDestinationWarehouseAction: vi.fn(),
}));

import { PoSetDestination } from './po-set-destination';

/**
 * The destination banner keeps its three messages word for word, its
 * warehouse picker and Set destination, which waits for a pick.
 */

const WAREHOUSES = [{ id: 'wh-1', name: 'North DC' }];

describe('PoSetDestination', () => {
  it('with no warehouses at all, says where to make one', () => {
    const { container } = render(<PoSetDestination poId="po-1" warehouses={[]} />);
    expect(container.textContent).toBe(
      'This PO has no destination warehouse and no warehouses exist yet. Create one in Admin → Warehouses, then come back here.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('with no destination, asks for a warehouse so receiving can post', () => {
    const { container } = render(<PoSetDestination poId="po-1" warehouses={WAREHOUSES} />);
    expect(container.textContent).toContain(
      'No destination set. Pick a warehouse so receiving can post stock against this PO.',
    );
    expect(screen.getByRole('combobox')).toHaveTextContent('Pick warehouse');
    expect(screen.getByRole('button', { name: 'Set destination' })).toBeDisabled();
  });

  it('with a destination that has no warehouse, says why Receive is hidden', () => {
    const { container } = render(
      <PoSetDestination poId="po-1" warehouses={WAREHOUSES} hasUnreceivableDestination />,
    );
    expect(container.textContent).toContain(
      "This PO's destination isn't linked to a warehouse. Received stock has nowhere to go, so the Receive button is hidden. Pick a warehouse below to fix it.",
    );
  });
});
