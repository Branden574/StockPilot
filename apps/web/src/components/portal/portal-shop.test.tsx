import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

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

// The portal page server-renders the customer's orders and returns with
// their day (toLocaleDateString): the server's zone (UTC on Vercel) while it
// renders, the viewer's while the browser hydrates. An evening order in Los
// Angeles is the next day in UTC, so React threw error #418. The days are
// printed once the page has hydrated.
describe('PortalShop hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints the viewer's order and return days once hydrated, never the server's, with no hydration error", async () => {
    const t0 = Date.parse('2026-10-06T04:00:00.000Z');
    const order = {
      id: '0f1e2d3c-4b5a-4968-8776-655443322110',
      status: 'fulfilled',
      // 7:30 PM and 8 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
      created_at: '2026-10-06T02:30:00.000Z',
      total: 0,
      lines: [
        {
          orderRequestLineId: 'ol-1',
          itemId: 'i-1',
          name: 'Composition Notebook',
          quantity: 2,
          unitPrice: 0,
          quantityFulfilled: 2,
          quantityReturned: 0,
          quantityPendingReturn: 0,
        },
      ],
      returns: [{ id: 'ret-1', status: 'requested', created_at: '2026-10-06T03:00:00.000Z' }],
    };
    const run = await hydrateAcrossClockShift(
      () => (
        <PortalShop catalog={[]} orders={[order]} returnsEnabled={false} pricingMode="no_charge" />
      ),
      { serverNow: t0, browserNow: t0 + 60_000 },
    );
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).toContain('0F1E2D3C');
      expect(run.html).not.toContain('Oct 6, 2026');
      expect(within(run.container).getAllByText(/Oct 5, 2026/)).toHaveLength(2);
    } finally {
      run.unmount();
    }
  });
});
