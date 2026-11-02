import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { orderCancelWords } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// B51 (owner decision a.22): the order page worked out which kind of cancel
// the viewer had (core orderCancelOffer) and then rendered the button with
// the requester's words for everyone: an approver read "Cancel request" and
// nothing about picked or delivered items. The button now takes the kind and
// whether anything was delivered, and every word comes from core
// orderCancelWords, the phone's words, so the two apps cannot drift again.
// Each case below compares with orderCancelWords' own output.
// ---------------------------------------------------------------------------

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({ cancelOrderRequestAction: vi.fn() }));

import { toast } from 'sonner';

import { cancelOrderRequestAction } from '@/server/actions/order-requests';

import { CancelOrderButton } from './cancel-order-button';

const ORDER = '11111111-1111-4111-8111-111111111111';
const DELIVERED = 'Already-delivered items are NOT restocked';

beforeEach(() => {
  vi.clearAllMocks();
});

async function openConfirm(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  return screen.findByRole('dialog');
}

describe('CancelOrderButton words (B51)', () => {
  it("the requester's own pending order: Cancel request, in the words it had", async () => {
    const w = orderCancelWords('requester', {
      status: 'pending_approval',
      anythingDelivered: false,
    });
    render(
      <CancelOrderButton
        orderId={ORDER}
        status="pending_approval"
        offer="requester"
        anythingDelivered={false}
      />,
    );
    const dialog = await openConfirm(w.label);
    expect(w.label).toBe('Cancel request');
    expect(within(dialog).getByText(w.title)).toBeInTheDocument();
    expect(w.title).toBe('Cancel this order request?');
    expect(within(dialog).getByText(w.body)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: w.confirmLabel })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: w.keepLabel })).toBeInTheDocument();
    expect(w.keepLabel).toBe('Keep request');
  });

  it('an approver on an approved order: Cancel order, what happens to held and picked stock, Keep order', async () => {
    const w = orderCancelWords('approver', { status: 'approved', anythingDelivered: false });
    render(
      <CancelOrderButton
        orderId={ORDER}
        status="approved"
        offer="approver"
        anythingDelivered={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
    const dialog = await openConfirm('Cancel order');
    expect(within(dialog).getByText('Cancel this order?')).toBeInTheDocument();
    expect(within(dialog).getByText(w.body)).toBeInTheDocument();
    expect(w.body).toContain('Anything already picked goes back into stock.');
    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep order' })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(DELIVERED);
    expect(dialog).not.toHaveTextContent('Cancel this order request?');
  });

  it('an approver on a backordered order with items delivered: the voided body', async () => {
    const w = orderCancelWords('approver', { status: 'backordered', anythingDelivered: true });
    render(
      <CancelOrderButton orderId={ORDER} status="backordered" offer="approver" anythingDelivered />,
    );
    const dialog = await openConfirm('Cancel order');
    expect(within(dialog).getByText(w.body)).toBeInTheDocument();
    expect(w.body).toBe(
      'The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released.',
    );
  });

  it('an approver on a resumed backorder (items delivered, back in picking): the delivered sentence', async () => {
    const w = orderCancelWords('approver', {
      status: 'pick_slip_generated',
      anythingDelivered: true,
    });
    render(
      <CancelOrderButton
        orderId={ORDER}
        status="pick_slip_generated"
        offer="approver"
        anythingDelivered
      />,
    );
    const dialog = await openConfirm('Cancel order');
    expect(within(dialog).getByText(w.body)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(DELIVERED);
  });

  it('an approver on a backordered order with nothing delivered: no delivered sentence', async () => {
    const w = orderCancelWords('approver', { status: 'backordered', anythingDelivered: false });
    render(
      <CancelOrderButton
        orderId={ORDER}
        status="backordered"
        offer="approver"
        anythingDelivered={false}
      />,
    );
    const dialog = await openConfirm('Cancel order');
    expect(within(dialog).getByText(w.body)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(DELIVERED);
  });

  it('confirming sends the reason, and the toast follows the kind', async () => {
    vi.mocked(cancelOrderRequestAction).mockResolvedValue({ ok: true, data: undefined } as never);

    render(
      <CancelOrderButton
        orderId={ORDER}
        status="approved"
        offer="approver"
        anythingDelivered={false}
      />,
    );
    let dialog = await openConfirm('Cancel order');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'Ordered twice' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        orderCancelWords('approver', { status: 'approved', anythingDelivered: false }).done,
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Order cancelled.');
    expect(cancelOrderRequestAction).toHaveBeenCalledWith({ id: ORDER, reason: 'Ordered twice' });
    expect(refresh).toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(cancelOrderRequestAction).mockResolvedValue({ ok: true, data: undefined } as never);
    cleanup();
    render(
      <CancelOrderButton
        orderId={ORDER}
        status="pending_approval"
        offer="requester"
        anythingDelivered={false}
      />,
    );
    dialog = await openConfirm('Cancel request');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Order request cancelled.'));
    expect(cancelOrderRequestAction).toHaveBeenCalledWith({ id: ORDER, reason: undefined });
  });

  it('a closed order offers nothing', () => {
    for (const status of ['completed', 'denied', 'cancelled'] as const) {
      const { container } = render(
        <CancelOrderButton orderId={ORDER} status={status} offer="approver" anythingDelivered />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  // Mutation caught: a word copied into the component again (the drift that
  // let the web and the phone disagree, pattern 26).
  it('holds no words of its own: every word is orderCancelWords', () => {
    const source = readFileSync(path.resolve(__dirname, 'cancel-order-button.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(source).toContain('orderCancelWords(');
    for (const literal of [
      'Cancel this order',
      'Already-delivered',
      'Cancel request',
      'Cancel order',
      'Keep request',
      'Keep order',
      'Order request cancelled.',
      'Order cancelled.',
      'stock reservations',
    ]) {
      expect(source, literal).not.toContain(literal);
    }
  });
});
