import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY, type RequesterReturnSheet } from '@stockpilot/core';

const actions = vi.hoisted(() => ({
  submitPortalOrderAction: vi.fn(),
  requestPortalReturnAction: vi.fn(),
  portalReturnSheetAction: vi.fn(),
  portalReturnOptionsAction: vi.fn(),
}));
vi.mock('@/server/actions/portal', () => actions);

import { PortalReturnSheet } from './portal-return-sheet';

const ORDER_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

const SHEET: RequesterReturnSheet = {
  orderNumber: 'SO-000103',
  requesterName: null,
  exchangesEnabled: false,
  lines: [
    {
      orderRequestLineId: '11111111-1111-4111-8111-111111111111',
      name: 'Composition Notebook',
      sizeLabel: null,
      photo: null,
      quantityFulfilled: 2,
      quantityRemaining: 2,
    },
  ],
  tracking: [],
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe('PortalReturnSheet (returns RX-3)', () => {
  it('says it is loading, then shows the form for the order it was opened for', async () => {
    let resolve: (v: unknown) => void = () => {};
    actions.portalReturnSheetAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<PortalReturnSheet orderId={ORDER_ID} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the return form…');
    resolve({ ok: true, data: SHEET });
    // Exchanges switched off: the sheet is a return request, as before RX-3.
    expect(await screen.findByRole('region', { name: 'Request a return' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: RETURNS_COPY.exchangeRequester })).toBeNull();
    expect(actions.portalReturnSheetAction).toHaveBeenCalledWith(ORDER_ID);
  });

  it("says why the form couldn't load, offers Try again and Cancel, and loads again only when asked", async () => {
    actions.portalReturnSheetAction.mockResolvedValueOnce({ ok: false, error: { code: 'not_found', message: 'This order could not be found.' } });
    actions.portalReturnSheetAction.mockResolvedValueOnce({ ok: true, data: { ...SHEET, exchangesEnabled: true } });
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<PortalReturnSheet orderId={ORDER_ID} onDone={vi.fn()} onCancel={onCancel} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This order could not be found.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: RETURNS_COPY.requesterReturnOrExchange })).toBeInTheDocument();
    expect(actions.portalReturnSheetAction).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown load as one that failed', async () => {
    actions.portalReturnSheetAction.mockRejectedValueOnce(new Error('boom'));
    render(<PortalReturnSheet orderId={ORDER_ID} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The return form could not be loaded. Please try again.');
  });

  it('says when nothing on the order can come back now, with a way out', async () => {
    actions.portalReturnSheetAction.mockResolvedValueOnce({ ok: true, data: { ...SHEET, lines: [] } });
    const onCancel = vi.fn();
    render(<PortalReturnSheet orderId={ORDER_ID} onDone={vi.fn()} onCancel={onCancel} />);
    // RX-3 merge: core's one sentence, the phone's too.
    expect(await screen.findByText('Nothing left to return on this order.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('sends a return through the portal action with the order, and reports it', async () => {
    actions.portalReturnSheetAction.mockResolvedValueOnce({ ok: true, data: SHEET });
    actions.requestPortalReturnAction.mockResolvedValueOnce({
      ok: true,
      data: { id: 'ret', status: 'requested', returnNumber: 'RMA-1', replay: true },
    });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<PortalReturnSheet orderId={ORDER_ID} onDone={onDone} onCancel={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Submit return request' }));
    expect(actions.requestPortalReturnAction).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, lines: [{ orderRequestLineId: SHEET.lines[0]!.orderRequestLineId, quantity: 2 }] }),
    );
    expect(onDone).toHaveBeenCalledWith({ returnNumber: 'RMA-1', replay: true, hasExchange: false });
  });
});
