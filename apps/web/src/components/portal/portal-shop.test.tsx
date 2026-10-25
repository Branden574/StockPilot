import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

import { RETURNS_COPY, type RequesterReturnSheet } from '@stockpilot/core';

import { PortalShop } from './portal-shop';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

// The panel imports the server-action module; stub every action it
// references so the client component renders without pulling server deps.
const actions = vi.hoisted(() => ({
  submitPortalOrderAction: vi.fn(),
  requestPortalReturnAction: vi.fn(),
  portalReturnSheetAction: vi.fn(),
  portalReturnOptionsAction: vi.fn(),
}));
vi.mock('@/server/actions/portal', () => actions);

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
      returns: [
        {
          id: 'ret-1',
          status: 'requested',
          created_at: '2026-10-06T03:00:00.000Z',
          // Returns RX-3: the requester's tracking rides on each request.
          returnNumber: 'RMA-20261006-ABC123',
          exchangeStatus: 'none' as const,
          sentences: ['Return requested. The warehouse will review it.'],
          replacementOrderNumber: null,
          lines: [],
        },
      ],
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

// ── Returns RX-3: the customer's "Return or exchange" ───────────────────────

const ORDER_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const LINE_ID = '11111111-1111-4111-8111-111111111111';
const SIZE_L = '44444444-4444-4444-8444-444444444444';

function completedOrder(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    status: 'completed',
    created_at: '2026-10-06T18:30:00.000Z',
    total: 0,
    lines: [
      {
        orderRequestLineId: LINE_ID,
        itemId: 'i-1',
        name: 'New Hire Shirt - M',
        quantity: 1,
        unitPrice: 0,
        quantityFulfilled: 1,
        quantityReturned: 0,
        quantityPendingReturn: 0,
      },
    ],
    returns: [],
    ...over,
  };
}

const SHEET: RequesterReturnSheet = {
  orderNumber: 'SO-000103',
  requesterName: 'Acme School',
  exchangesEnabled: true,
  lines: [
    {
      orderRequestLineId: LINE_ID,
      name: 'New Hire Shirt',
      sizeLabel: 'Size M',
      photo: { url: 'https://signed.test/m.jpg', thumbUrl: 'https://signed.test/m-thumb.jpg' },
      quantityFulfilled: 1,
      quantityRemaining: 1,
    },
  ],
  tracking: [],
};

describe('PortalShop: Return or exchange (returns RX-3)', () => {
  beforeEach(() => {
    refresh.mockReset();
    for (const fn of Object.values(actions)) fn.mockReset();
    actions.portalReturnSheetAction.mockResolvedValue({ ok: true, data: SHEET });
    actions.portalReturnOptionsAction.mockResolvedValue({
      ok: true,
      data: {
        exchangesEnabled: true,
        lines: [
          {
            orderRequestLineId: LINE_ID,
            options: [{ itemId: SIZE_L, name: 'New Hire Shirt', sizeLabel: 'Size L', availability: 'not_in_stock', photo: null }],
          },
        ],
      },
    });
    actions.requestPortalReturnAction.mockResolvedValue({
      ok: true,
      data: { id: 'ret-9', status: 'requested', returnNumber: 'RMA-20261011-PRT001', replay: false },
    });
  });

  it('says Return or exchange on an order with something to return, and Request a return while exchanges are off', () => {
    const { rerender } = renderShop({ orders: [completedOrder()], returnsEnabled: true, exchangesEnabled: true });
    expect(screen.getByRole('button', { name: RETURNS_COPY.requesterReturnOrExchange })).toHaveAttribute('aria-expanded', 'false');
    rerender(<PortalShop catalog={[]} orders={[completedOrder()]} returnsEnabled exchangesEnabled={false} pricingMode="no_charge" />);
    expect(screen.getByRole('button', { name: 'Request a return' })).toBeInTheDocument();
  });

  it("opens the sheet for this order only, with its photos (the portal's first image surface), and sends an exchange through the portal actions", async () => {
    const user = userEvent.setup();
    const { container } = renderShop({ orders: [completedOrder()], returnsEnabled: true, exchangesEnabled: true });
    const toggle = screen.getByRole('button', { name: RETURNS_COPY.requesterReturnOrExchange });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(actions.portalReturnSheetAction).toHaveBeenCalledWith(ORDER_ID);
    const sheet = await screen.findByRole('region', { name: RETURNS_COPY.requesterReturnOrExchange });
    expect(sheet).toHaveAttribute('id', toggle.getAttribute('aria-controls'));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://signed.test/m-thumb.jpg');

    await user.click(within(sheet).getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const sizes = await within(sheet).findByRole('radiogroup');
    expect(actions.portalReturnOptionsAction).toHaveBeenCalledTimes(1);
    expect(actions.portalReturnOptionsAction).toHaveBeenCalledWith(ORDER_ID);
    // Two-state availability (D6): never a count.
    expect(within(sizes).getByText(RETURNS_COPY.notInStock)).toBeInTheDocument();
    await user.click(within(sizes).getByRole('radio', { name: /Size L/ }));
    await user.click(within(sheet).getByRole('button', { name: 'Submit return request' }));

    expect(actions.requestPortalReturnAction).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      lines: [{ orderRequestLineId: LINE_ID, quantity: 1, exchange: { itemId: SIZE_L, quantity: 1 } }],
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const banner = await screen.findByRole('status');
    // RX-3 fix round 1 (desk check L1): one name for the same people on the
    // portal's form and banner ("the warehouse"), and the banner takes focus
    // once the form is gone (L5).
    expect(banner).toHaveTextContent(
      `${RETURNS_COPY.requesterReceivedExchangeRequest} Your reference is RMA-20261011-PRT001. The warehouse will review it and follow up.`,
    );
    await waitFor(() => expect(document.activeElement).toBe(banner));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: RETURNS_COPY.requesterReturnOrExchange })).toBeNull();
  });

  it("says the portal's refusal in the sheet and keeps it open", async () => {
    actions.requestPortalReturnAction.mockResolvedValue({
      ok: false,
      error: { code: 'validation_error', message: 'That is more than was handed over.', details: { reason: 'return_exceeds_fulfilled' } },
    });
    const user = userEvent.setup();
    renderShop({ orders: [completedOrder()], returnsEnabled: true, exchangesEnabled: true });
    await user.click(screen.getByRole('button', { name: RETURNS_COPY.requesterReturnOrExchange }));
    const sheet = await screen.findByRole('region', { name: RETURNS_COPY.requesterReturnOrExchange });
    await user.click(within(sheet).getByRole('button', { name: 'Submit return request' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('That is more than was handed over.');
    // Re-pinned on purpose (RX-3 fix round 1, M4 and F4): the refusal means the
    // sheet is behind, so the sheet is read again in place and the order list
    // refreshes its requests; the sheet stays open with the words.
    await waitFor(() => expect(actions.portalReturnSheetAction).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: RETURNS_COPY.requesterReturnOrExchange })).toBeInTheDocument();
  });

  it("lists the customer's own requests in the requester's words, with the replacement order, never a staff label", () => {
    renderShop({
      returnsEnabled: true,
      orders: [
        completedOrder({
          returns: [
            {
              id: 'ret-1',
              status: 'approved',
              created_at: '2026-10-07T18:00:00.000Z',
              returnNumber: 'RMA-20261007-XYZ789',
              exchangeStatus: 'waiting_for_return' as const,
              sentences: ['Replacement reserved. Waiting for your return.'],
              replacementOrderNumber: 'SO-000104',
              lines: [
                {
                  returning: { name: 'New Hire Shirt', sizeLabel: 'Size M', quantity: 1 },
                  exchange: { state: 'approved' as const, replacement: { name: 'New Hire Shirt', sizeLabel: 'Size L', quantity: 1 }, substituted: false },
                },
              ],
            },
          ],
        }),
      ],
    });
    const region = screen.getByRole('region', { name: RETURNS_COPY.requesterYourRequests });
    expect(within(region).getByText('RMA-20261007-XYZ789')).toBeInTheDocument();
    expect(within(region).getByText('Replacement reserved. Waiting for your return.')).toBeInTheDocument();
    expect(within(region).getByText('New Hire Shirt, L ×1')).toBeInTheDocument();
    expect(within(region).getByText('SO-000104')).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/awaiting drop-off|pending approval|staging|\brack\b|disposition/i);
  });
});

// B32: "Your orders" listed the customer's 50 newest orders and said nothing
// past them, and a history that could not be read showed "No orders yet".
describe('PortalShop — Your orders, as far as they go', () => {
  function orderNo(i: number) {
    return {
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      status: 'submitted',
      created_at: '2026-10-01T15:00:00.000Z',
      total: 0,
      lines: [],
      returns: [],
    };
  }
  const fifty = Array.from({ length: 50 }, (_, i) => orderNo(i));

  it('more orders than listed: says how many of how many', () => {
    renderShop({ orders: fifty, ordersTotal: 1_234 });
    expect(
      screen.getByText(
        'Showing your 50 most recent orders of 1,234. Your supplier can find older ones.',
      ),
    ).toBeInTheDocument();
  });

  it('every order listed (or no count): says nothing more', () => {
    renderShop({ orders: fifty, ordersTotal: 50 });
    expect(screen.queryByText(/most recent orders of/)).not.toBeInTheDocument();
    renderShop({ orders: fifty, ordersTotal: null });
    expect(screen.queryByText(/most recent orders of/)).not.toBeInTheDocument();
  });

  // Mutation caught: the empty state shown for a read that failed.
  it('a history that could not be read says so, never "No orders yet"', () => {
    renderShop({ orders: [], ordersTotal: null, ordersFailed: true });
    expect(
      screen.getByText('Your orders could not be loaded. Reload the page to try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No orders yet/)).not.toBeInTheDocument();
  });
});
