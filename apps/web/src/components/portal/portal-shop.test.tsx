import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PortalShop } from './portal-shop';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// The panel imports the server-action module; stub every action it
// references so the client component renders without pulling server deps.
vi.mock('@/server/actions/portal', () => ({
  submitPortalOrderAction: vi.fn(),
  requestPortalReturnAction: vi.fn(),
}));

const ITEM = {
  itemId: 'i-1',
  name: 'Composition Notebook',
  sku: 'NB-001',
  imageUrl: null,
  quantityAvailable: 28,
  // PortalCatalogItem still carries inStock (portal.ts is out of scope for
  // this task) — the component itself no longer reads it.
  inStock: true,
};

function renderShop(over: Partial<React.ComponentProps<typeof PortalShop>>) {
  return render(
    <PortalShop catalog={[]} orders={[]} returnsEnabled={false} pricingMode="no_charge" {...over} />,
  );
}

describe('PortalShop — no_charge', () => {
  it('renders no price, and does not crash on a null unitPrice', () => {
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    expect(screen.getByText('Composition Notebook')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('shows the real available quantity instead of an in-stock badge', () => {
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    expect(screen.getByText(/28/)).toBeInTheDocument();
    expect(screen.queryByText(/Backorder/i)).not.toBeInTheDocument();
  });

  it('renders no cart total once an item is added', async () => {
    const user = userEvent.setup();
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    await user.click(screen.getByRole('button', { name: /Add one Composition Notebook/i }));
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('the empty state does not blame pricing', () => {
    renderShop({ catalog: [] });
    expect(screen.queryByText(/priced/i)).not.toBeInTheDocument();
  });
});

describe('PortalShop — priced', () => {
  it('renders the price for a priced item', () => {
    renderShop({ pricingMode: 'priced', catalog: [{ ...ITEM, unitPrice: 12.5, quotable: false }] });
    expect(screen.getByText('$12.50')).toBeInTheDocument();
  });

  it('offers a quote instead of a price for an unpriced item, and still allows ordering', () => {
    renderShop({ pricingMode: 'priced', catalog: [{ ...ITEM, unitPrice: null, quotable: true }] });
    expect(screen.getByText(/Request quote/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add one Composition Notebook/i })).toBeEnabled();
  });
});
