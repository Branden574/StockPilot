// @vitest-environment happy-dom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY, type RequesterReturnSheet } from '@stockpilot/core';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { MemberReturnDialog } from './member-return-dialog';

/**
 * RX-3 fix round 1 (desk checks L6, people and plan coverage): a member's
 * handed-over order with no return token (9 in production at 0395, in 2
 * organizations, counted read-only) had no Return or exchange on the web,
 * while the phone's member routes served it. The web order page now opens
 * the same requester form over the member routes (cookie): the order id in
 * the path, never a token, nothing cached.
 */

const ORDER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const LINE = '11111111-1111-4111-8111-111111111111';
const SIZE_L = '44444444-4444-4444-8444-444444444444';

const SHEET: RequesterReturnSheet = {
  orderNumber: 'SO-000103',
  requesterName: 'Pat Lee',
  exchangesEnabled: true,
  lines: [{ orderRequestLineId: LINE, name: 'New Hire Shirt', sizeLabel: 'Size M', photo: null, quantityFulfilled: 1, quantityRemaining: 1 }],
  tracking: [],
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  toast.success.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SHEET_URL = `/api/v1/orders/${ORDER}/return-request`;

describe('MemberReturnDialog (the requester form over the member routes)', () => {
  it('reads the sheet when opened, asks the sizes once by POST with no body, and sends the request to the member route', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { orderId: ORDER, ...SHEET }));
    fetchMock.mockResolvedValueOnce(
      json(200, {
        orderId: ORDER,
        exchangesEnabled: true,
        lines: [{ orderRequestLineId: LINE, options: [{ itemId: SIZE_L, name: 'New Hire Shirt', sizeLabel: 'Size L', availability: 'available', photo: null }] }],
      }),
    );
    fetchMock.mockResolvedValueOnce(json(200, { id: 'ret-1', returnNumber: 'RMA-20261011-MEM001', replay: false }));
    const user = userEvent.setup();
    render(<MemberReturnDialog orderId={ORDER} exchangesEnabled />);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: RETURNS_COPY.requesterReturnOrExchange }));
    const dialog = await screen.findByRole('dialog');
    expect(fetchMock.mock.calls[0]![0]).toBe(SHEET_URL);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).cache).toBe('no-store');

    await user.click(await within(dialog).findByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    await user.click(within(await within(dialog).findByRole('radiogroup')).getByRole('radio', { name: /Size L/ }));
    expect(fetchMock.mock.calls[1]![0]).toBe(`${SHEET_URL}/options`);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe('POST');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: RETURNS_COPY.requesterSubmit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[2]! as [string, RequestInit];
    expect(url).toBe(SHEET_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      lines: [{ orderRequestLineId: LINE, quantity: 1, exchange: { itemId: SIZE_L, quantity: 1 } }],
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // No token anywhere: the member's session is the credential.
    for (const c of fetchMock.mock.calls) expect(String(c[0])).not.toMatch(/token/i);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith(
      `${RETURNS_COPY.requesterReceivedExchangeRequest} ${RETURNS_COPY.requesterReference('RMA-20261011-MEM001')}`,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says the route's refusal when the sheet cannot be read, and offers Try again", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { error: 'not_found', message: "This order isn't available." }));
    fetchMock.mockResolvedValueOnce(json(200, { orderId: ORDER, ...SHEET }));
    const user = userEvent.setup();
    render(<MemberReturnDialog orderId={ORDER} exchangesEnabled />);
    await user.click(screen.getByRole('button', { name: RETURNS_COPY.requesterReturnOrExchange }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This order isn't available.");
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('New Hire Shirt')).toBeInTheDocument();
  });

  it('says Request a return while exchanges are switched off', () => {
    render(<MemberReturnDialog orderId={ORDER} exchangesEnabled={false} />);
    expect(screen.getByRole('button', { name: 'Request a return' })).toBeInTheDocument();
  });

  it('nothing left to return reads core words', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { orderId: ORDER, ...SHEET, lines: [] }));
    const user = userEvent.setup();
    render(<MemberReturnDialog orderId={ORDER} exchangesEnabled />);
    await user.click(screen.getByRole('button', { name: RETURNS_COPY.requesterReturnOrExchange }));
    expect(await screen.findByText(RETURNS_COPY.requesterNothingLeft)).toBeInTheDocument();
  });
});
