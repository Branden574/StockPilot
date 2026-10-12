// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY, type RequesterExchangeOptionsAnswer, type RequesterReturnableLine } from '@stockpilot/core';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { RequesterReturnForm } from './requester-return-form';

// A placeholder for the return link's token: a valid v4 UUID with low entropy,
// so it never reads as a secret, and no other id in this file shares it.
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const LINE: RequesterReturnableLine = {
  orderRequestLineId: '11111111-1111-4111-8111-111111111111',
  name: 'New Hire Shirt',
  sizeLabel: 'Size M',
  photo: null,
  quantityFulfilled: 3,
  quantityRemaining: 3,
};
const SIZE_L = '44444444-4444-4444-8444-444444444444';
const ANSWER: RequesterExchangeOptionsAnswer = {
  exchangesEnabled: true,
  lines: [
    {
      orderRequestLineId: LINE.orderRequestLineId,
      options: [{ itemId: SIZE_L, name: 'New Hire Shirt', sizeLabel: 'Size L', availability: 'available', photo: null }],
    },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function calls(url: string): Array<{ init: RequestInit; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter((c) => c[0] === url)
    .map((c) => ({ init: c[1] as RequestInit, body: JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown> }));
}

function renderForm(over: Partial<React.ComponentProps<typeof RequesterReturnForm>> = {}) {
  return render(
    <RequesterReturnForm token={LINK_ID} lines={[LINE]} exchangesEnabled requesterName="Dana Smith" hasRequests={false} {...over} />,
  );
}

const submit = () => screen.getByRole('button', { name: 'Submit return request' });

describe('RequesterReturnForm idempotency key (returns RX-1 review, kept in RX-3)', () => {
  it('keeps one key for the form: a lost answer then an EDITED resend is the same request, never a second RMA', async () => {
    // The first answer is lost (the create may have committed); the requester
    // changes the quantity and sends again.
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    fetchMock.mockResolvedValueOnce(json(200, { id: 'r1', returnNumber: 'RMA-1', replay: true }));
    renderForm();
    fireEvent.click(submit());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Quantity to return for New Hire Shirt, M'), { target: { value: '2' } });
    fireEvent.click(submit());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [first, second] = calls('/api/v1/public/returns').map((c) => c.body.idempotencyKey);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });
});

describe('RequesterReturnForm (returns RX-3)', () => {
  it('asks for the sizes ONCE, by POST with the token in the body, never in the URL, and never cached', async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    await screen.findByRole('radiogroup', { name: /REPLACEMENT for New Hire Shirt, M/ });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.returnOnly }));
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const sizes = calls('/api/v1/public/returns/options');
    expect(sizes).toHaveLength(1);
    expect(sizes[0]!.init.method).toBe('POST');
    expect(sizes[0]!.init.cache).toBe('no-store');
    // Nothing but the token: no item, group, warehouse or quantity (no oracle).
    expect(sizes[0]!.body).toEqual({ token: LINK_ID });
    for (const c of fetchMock.mock.calls) expect(String(c[0])).not.toContain(LINK_ID);
  });

  it('sends the exchange with the token, the honeypot and the key, then confirms in the words for an exchange and refreshes the tracking', async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    fetchMock.mockResolvedValueOnce(json(200, { id: 'r1', returnNumber: 'RMA-20261011-ABC123', replay: false }));
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const group = await screen.findByRole('radiogroup');
    await user.click(within(group).getByRole('radio', { name: /Size L/ }));
    await user.click(submit());
    const sent = calls('/api/v1/public/returns');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.body).toEqual({
      token: LINK_ID,
      hp: '',
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lines: [{ orderRequestLineId: LINE.orderRequestLineId, quantity: 3, exchange: { itemId: SIZE_L, quantity: 3 } }],
    });
    const done = await screen.findByRole('status');
    expect(done).toHaveTextContent(RETURNS_COPY.requesterReceivedExchangeRequest);
    expect(done).toHaveTextContent('Thanks, Dana.');
    expect(done).toHaveTextContent('Your reference is RMA-20261011-ABC123.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('confirms a return only in the words for a return', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'r1', returnNumber: null, replay: false }));
    renderForm({ requesterName: null });
    await userEvent.setup().click(submit());
    const done = await screen.findByRole('status');
    expect(done).toHaveTextContent(RETURNS_COPY.requesterReceivedReturnRequest);
    expect(done).not.toHaveTextContent('Thanks');
    expect(done).not.toHaveTextContent('reference');
  });

  // Re-pinned on purpose (RX-3 fix round 1, desk checks M4 and F4): this
  // refusal means the page is behind (a size archived, hidden or no longer
  // the group's), so the page and the sizes are read again; a size still
  // offered stays chosen.
  it("says the server's refusal in the form, beside the button, reads the page and the sizes again, and keeps a size still offered", async () => {
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    fetchMock.mockResolvedValueOnce(
      json(400, {
        error: 'validation_error',
        message: "That item can't be used as a replacement.",
        details: { reason: 'exchange_item_not_eligible' },
      }),
    );
    fetchMock.mockResolvedValueOnce(json(200, ANSWER));
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    await user.click(within(await screen.findByRole('radiogroup')).getByRole('radio', { name: /Size L/ }));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent("That item can't be used as a replacement.");
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls('/api/v1/public/returns/options')).toHaveLength(2));
    expect(await screen.findByRole('radio', { name: /Size L/ })).toBeChecked();
  });

  it('sends whatever lands in the honeypot (the server answers a filled one with a fake success)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'ok' }));
    renderForm();
    fireEvent.change(document.getElementById('return-hp')!, { target: { value: 'spam' } });
    fireEvent.click(submit());
    await waitFor(() => expect(calls('/api/v1/public/returns')).toHaveLength(1));
    expect(calls('/api/v1/public/returns')[0]!.body.hp).toBe('spam');
  });

  it('offers no Exchange when exchanges are switched off', () => {
    renderForm({ exchangesEnabled: false });
    expect(screen.queryByRole('radio', { name: RETURNS_COPY.exchangeRequester })).toBeNull();
  });

  it('says nothing is left to return, pointing at the requests below when there are some', () => {
    const { rerender } = renderForm({ lines: [] });
    expect(screen.getByText('Nothing left to return')).toBeInTheDocument();
    expect(screen.getByText(/already been returned, or this order has no returnable items/)).toBeInTheDocument();
    rerender(<RequesterReturnForm token={LINK_ID} lines={[]} exchangesEnabled requesterName={null} hasRequests />);
    expect(screen.getByText(/already returned or in one of your requests below/)).toBeInTheDocument();
  });
});

// RX-3 fix round 1 (desk checks M4, F4 and L5).
describe('RequesterReturnForm after an answer', () => {
  it('a refusal that means the page is behind refreshes it, so the lines are read again (the form keeps its key)', async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { error: 'validation_error', message: 'Only 1 of "New Hire Shirt, M" can still be returned.', details: { reason: 'return_exceeds_fulfilled' } }),
    );
    renderForm();
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('Only 1 of "New Hire Shirt, M" can still be returned.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the confirmation heading once the request is in, so a screen reader hears it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'r1', returnNumber: 'RMA-1', replay: false }));
    renderForm();
    fireEvent.click(submit());
    const heading = await screen.findByRole('heading', { level: 2, name: RETURNS_COPY.requesterReceivedReturnRequest });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
