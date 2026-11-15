import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/** A submission key: a v4 uuid, as core's mintOrderSubmissionKey makes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

/**
 * Place order after an answer that was not "placed".
 *
 * A REFUSAL THE SERVER ANSWERED says nothing was placed (a check that could
 * not be read is "Your access could not be checked. Please try again."): its
 * words are shown, the button comes back, the cart and the note stay, and
 * the next press sends the same order.
 *
 * A CALL THAT DID NOT COME BACK (the connection dropped, the server could
 * not answer) has an outcome the page cannot know: the order may have been
 * placed. The page says so, tells the customer to reload and check their
 * orders, offers Reload (a full page load, which reads the orders again),
 * and keeps Place order disabled until then, so a second press cannot send
 * the same cart. The cart and the note stay on screen, read-only.
 */
describe('PortalShop: Place order after a refusal or a call that failed', () => {
  async function shopWithOneInCart() {
    const user = userEvent.setup();
    renderShop({ catalog: [{ ...ITEM, unitPrice: null, quotable: false }] });
    await user.click(screen.getByRole('button', { name: /Add one Composition Notebook/i }));
    return user;
  }

  beforeEach(() => {
    actions.submitPortalOrderAction.mockReset();
    refresh.mockReset();
  });

  it('a refusal: its words are shown, the button is usable again, the cart is kept, and a second press places the order', async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: 'Your access could not be checked. Please try again.' },
    });
    const user = await shopWithOneInCart();
    const place = screen.getByRole('button', { name: 'Place order' });
    await user.click(place);
    expect(
      await screen.findByText('Your access could not be checked. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();

    actions.submitPortalOrderAction.mockResolvedValueOnce({ ok: true, data: { id: 'order-1' } });
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(actions.submitPortalOrderAction).toHaveBeenCalledTimes(2));
    // The same cart both times.
    expect(actions.submitPortalOrderAction.mock.calls[1]![0]).toEqual(
      actions.submitPortalOrderAction.mock.calls[0]![0],
    );
    expect(actions.submitPortalOrderAction.mock.calls[0]![0].lines).toEqual([
      { itemId: 'i-1', quantity: 1 },
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent('Order submitted');
  });

  it('a call that does not come back: the page says to press Place order again, keeps the cart as sent, and the second press sends the same cart under the same key', async () => {
    actions.submitPortalOrderAction.mockRejectedValueOnce(new Error('Failed to fetch'));
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const user = await shopWithOneInCart();
    await user.type(screen.getByLabelText('Notes for your supplier (optional)'), 'Leave at the desk');
    await user.click(screen.getByRole('button', { name: 'Place order' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "We couldn't confirm your order went through. Press Place order again to finish it. It won't be placed twice.",
    );
    expect(screen.queryByText('Failed to fetch')).toBeNull();

    // The cart and the note are still on screen, and can no longer be changed.
    expect(screen.getByText('1 units')).toBeInTheDocument();
    const note = screen.getByLabelText('Notes for your supplier (optional)');
    expect(note).toHaveValue('Leave at the desk');
    expect(note).toHaveAttribute('readonly');
    const addOne = screen.getByRole('button', { name: /Add one Composition Notebook/i });
    expect(addOne).toBeDisabled();
    fireEvent.click(addOne);
    expect(screen.getByText('1 units')).toBeInTheDocument();

    // The list is not read again behind the customer's back, and nothing claims success.
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/Order submitted/)).toBeNull();
    // Reload is still offered (a full page load), and not pressed for them.
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
    expect(reload).not.toHaveBeenCalled();
    reload.mockRestore();

    // The second press: the same cart, the same key. The server answers the
    // order the first press placed.
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'fedcba98-7654-4321-8abc-def012345678', replay: true },
    });
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(actions.submitPortalOrderAction).toHaveBeenCalledTimes(2));
    const [first, second] = actions.submitPortalOrderAction.mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
    expect(first).toEqual({
      lines: [{ itemId: 'i-1', quantity: 1 }],
      notes: 'Leave at the desk',
      idempotencyKey: expect.stringMatching(UUID),
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Reference: FEDCBA98');
    expect(screen.queryByRole('button', { name: 'Place order' })).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Reload is offered only after a call that did not come back, never after a refusal', async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_error', message: 'An item is no longer available.' },
    });
    const user = await shopWithOneInCart();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('An item is no longer available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Add one Composition Notebook/i })).toBeEnabled();
  });
});

describe('PortalShop: one key per cart submission', () => {
  const sent = () =>
    actions.submitPortalOrderAction.mock.calls.map((c) => c[0] as { idempotencyKey: string });

  beforeEach(() => {
    actions.submitPortalOrderAction.mockReset();
    refresh.mockReset();
  });

  async function shop() {
    const user = userEvent.setup();
    renderShop({
      catalog: [
        { ...ITEM, unitPrice: null, quotable: false },
        {
          ...ITEM,
          itemId: 'i-2',
          name: 'Pencil box',
          sku: 'PB-002',
          unitPrice: null,
          quotable: false,
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: /Add one Composition Notebook/i }));
    return user;
  }
  const refusal = {
    ok: false,
    error: { code: 'validation_error', message: 'Please check the cart.' },
  };

  it('the first press mints a key, and a resend of the same cart after a refusal sends the same key', async () => {
    actions.submitPortalOrderAction.mockResolvedValue(refusal);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByText('Please check the cart.');
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[0]!.idempotencyKey).toMatch(UUID);
    expect(sent()[1]!.idempotencyKey).toBe(sent()[0]!.idempotencyKey);
  });

  it('a changed cart or note is a new submission with a new key', async () => {
    actions.submitPortalOrderAction.mockResolvedValue(refusal);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByText('Please check the cart.');
    await user.click(screen.getByRole('button', { name: /Add one Pencil box/i }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    await user.type(screen.getByLabelText('Notes for your supplier (optional)'), 'Room 4');
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(3));
    // Back to the second cart and note: its own key again would be fine, but a
    // new one is too; what matters is no key is shared between two carts.
    const keys = sent().map((b) => b.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('after a confirmed order the next cart, even an identical one, gets a new key', async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'order-1', replay: false },
    });
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Order submitted');
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'order-2', replay: false },
    });
    await user.click(screen.getByRole('button', { name: /Add one Composition Notebook/i }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]!.idempotencyKey).toMatch(UUID);
    expect(sent()[1]!.idempotencyKey).not.toBe(sent()[0]!.idempotencyKey);
  });
});

/**
 * Each class of answer, as the service marks it (`details.outcome`):
 * unknown keeps the cart as sent with its key; refused frees it; an answer
 * with no outcome changes nothing else.
 */
describe('PortalShop: what each answer does to the cart', () => {
  const sent = () =>
    actions.submitPortalOrderAction.mock.calls.map(
      (c) => c[0] as { idempotencyKey: string; lines: unknown; notes?: string },
    );
  const UNKNOWN = {
    ok: false,
    error: {
      code: 'conflict',
      message:
        "We couldn't confirm your order went through. Press Place order again to finish it. It won't be placed twice.",
      details: { outcome: 'unknown', retryable: true },
    },
  };
  const REFUSED = {
    ok: false,
    error: {
      code: 'validation_error',
      message: 'One of the items is no longer available to order.',
      details: { outcome: 'refused' },
    },
  };
  const NO_OUTCOME = {
    ok: false,
    error: { code: 'validation_error', message: 'Order could not be submitted. Please try again.' },
  };

  beforeEach(() => {
    actions.submitPortalOrderAction.mockReset();
    refresh.mockReset();
  });

  async function shop() {
    const user = userEvent.setup();
    renderShop({
      catalog: [
        { ...ITEM, unitPrice: null, quotable: false },
        {
          ...ITEM,
          itemId: 'i-2',
          name: 'Pencil box',
          sku: 'PB-002',
          unitPrice: null,
          quotable: false,
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: /Add one Composition Notebook/i }));
    await user.type(screen.getByLabelText('Notes for your supplier (optional)'), 'Room 4');
    return user;
  }
  const addOne = () => screen.getByRole('button', { name: /Add one Composition Notebook/i });
  const note = () => screen.getByLabelText('Notes for your supplier (optional)');

  it('unknown (the database answer was lost): the cart is held as sent with its key, Place order and Reload are offered, and the next press sends the same cart and key', async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce(UNKNOWN);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm your order went through. Press Place order again to finish it. It won't be placed twice.",
    );
    expect(addOne()).toBeDisabled();
    expect(note()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();

    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'fedcba98-7654-4321-8abc-def012345678', replay: true },
    });
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual(sent()[0]);
    expect(sent()[0]).toMatchObject({
      notes: 'Room 4',
      idempotencyKey: expect.stringMatching(UUID),
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Reference: FEDCBA98');
  });

  it("refused (definite) on the first send: the words show and the cart stays the customer's to change", async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce(REFUSED);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(
      await screen.findByText('One of the items is no longer available to order.'),
    ).toBeInTheDocument();
    expect(addOne()).toBeEnabled();
    expect(note()).not.toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('refused (definite) on the resend after an unknown outcome: the cart is released, the refusal says to check the orders first, Reload stays, and a changed cart gets a new key', async () => {
    actions.submitPortalOrderAction.mockRejectedValueOnce(new Error('Failed to fetch'));
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByRole('alert');
    expect(addOne()).toBeDisabled();

    actions.submitPortalOrderAction.mockResolvedValueOnce(REFUSED);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(
      await screen.findByText(
        'One of the items is no longer available to order. Check your orders before placing it again.',
      ),
    ).toBeInTheDocument();
    expect(sent()[1]).toEqual(sent()[0]);
    // Released: the cart and the note can change again; an earlier send may
    // still have gone through, so Reload stays.
    expect(addOne()).toBeEnabled();
    expect(note()).not.toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();

    // The customer changes the cart: a new submission, a new key. Once an
    // order is confirmed, Reload is no longer offered.
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'order-2', replay: false },
    });
    await user.click(screen.getByRole('button', { name: /Add one Pencil box/i }));
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()[2]!.idempotencyKey).not.toBe(sent()[0]!.idempotencyKey);
    expect(await screen.findByRole('status')).toHaveTextContent('Order submitted');
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('a refusal after an unknown outcome that already says to check the orders is not repeated', async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce(UNKNOWN);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByRole('alert');
    const conflict =
      "This order can't be placed as it was sent. Reload the page and check your orders before placing it again.";
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: conflict, details: { outcome: 'refused' } },
    });
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(conflict);
    expect(screen.getByRole('alert').textContent).toBe(conflict);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it("unknown with the server's reload-and-check words (a database code it does not recognise): those words, the cart held, Reload, and Place order with the same key", async () => {
    const unrecognised =
      "We couldn't confirm this order. Reload the page and check your orders before placing it again.";
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: unrecognised,
        details: { outcome: 'unknown', retryable: true },
      },
    });
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(unrecognised);
    expect(screen.queryByText(/Press Place order again to finish it/)).toBeNull();
    expect(addOne()).toBeDisabled();
    expect(note()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();
    actions.submitPortalOrderAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'fedcba98-7654-4321-8abc-def012345678', replay: true },
    });
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual(sent()[0]);
  });

  it('no outcome (a read failed before anything was written) after an unknown outcome: the cart stays as sent with Reload', async () => {
    actions.submitPortalOrderAction.mockResolvedValueOnce(UNKNOWN);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByRole('alert');
    actions.submitPortalOrderAction.mockResolvedValueOnce(NO_OUTCOME);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    expect(
      await screen.findByText('Order could not be submitted. Please try again.'),
    ).toBeInTheDocument();
    expect(addOne()).toBeDisabled();
    expect(note()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // The next press still sends the same cart under the same key.
    actions.submitPortalOrderAction.mockResolvedValueOnce(NO_OUTCOME);
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()[2]).toEqual(sent()[0]);
  });

  it("no outcome on the first send: the cart stays the customer's to change, and the same cart keeps its key", async () => {
    actions.submitPortalOrderAction.mockResolvedValue(NO_OUTCOME);
    const user = await shop();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByText('Order could not be submitted. Please try again.');
    expect(addOne()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]!.idempotencyKey).toBe(sent()[0]!.idempotencyKey);
  });
});
