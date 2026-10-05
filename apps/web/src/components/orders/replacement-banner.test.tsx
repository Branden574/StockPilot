import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', async () => {
  const React = await import('react');
  return { default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement('a', { href }, children) };
});

import { ReplacementBanner } from './replacement-banner';

/**
 * The replacement order's banner (returns RX-2, plan 3.6.9): the RMA and the
 * original order, the gate in words, the release with its reason, the
 * driver's line, and where to change or cancel it. The RMA is a link only
 * for someone who can open it.
 */

const INFO = {
  returnId: 'rma-1',
  returnNumber: 'RMA-20261005-ABC123',
  returnStatus: 'approved',
  originalOrderId: 'orig',
  originalOrderNumber: 103,
  live: true,
  handedOver: false,
  exchangeStatus: 'waiting_for_return' as const,
  exchangeStatusLabel: 'Replacement reserved. Waiting for returned item',
  waitingForReturn: true,
  returnClosed: false,
  releasedEarly: false,
  release: null,
  returnReceived: false,
  returnedItems: [{ itemId: 'm', label: 'Walk New Hire Shirt, M', quantity: 1 }],
  revision: 1,
  canOpenReturn: true,
  canReleaseEarly: true,
  slipLine: 'Exchange replacement for RMA-20261005-ABC123 (returned item: Walk New Hire Shirt, M ×1, not yet received)',
  driverLine: 'Collect the returned item: Walk New Hire Shirt, M ×1 (RMA-20261005-ABC123)',
};

describe('ReplacementBanner', () => {
  it('names the RMA and the original order, and the gate while it holds', () => {
    render(<ReplacementBanner replacement={INFO} fulfillmentType="pickup" />);
    const title = screen.getByTestId('replacement-banner-title');
    expect(title.textContent).toBe('Exchange replacement for RMA-20261005-ABC123 · Original order SO-000103');
    expect(title.textContent).toBe(title.getAttribute('data-words'));
    expect(screen.getAllByRole('link', { name: 'RMA-20261005-ABC123' })[0]).toHaveAttribute('href', '/dashboard/returns/rma-1');
    expect(screen.getByRole('link', { name: 'SO-000103' })).toHaveAttribute('href', '/dashboard/orders/orig');
    expect(screen.getByText('Replacement reserved. Waiting for returned item (RMA-20261005-ABC123)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change or cancel in RMA-20261005-ABC123' })).toBeInTheDocument();
    // A pickup has no driver line.
    expect(screen.queryByText(/Collect the returned item/)).toBeNull();
  });

  it('released early: who and why; a delivery swap names what the driver collects', () => {
    render(
      <ReplacementBanner
        replacement={{
          ...INFO,
          waitingForReturn: false,
          releasedEarly: true,
          release: { byName: 'Dana', reason: 'Swap at delivery: the driver collects the returned item.', at: 't' },
        }}
        fulfillmentType="delivery"
      />,
    );
    expect(screen.queryByText(/Waiting for returned item/)).toBeNull();
    expect(screen.getByText('Released before the return by Dana: Swap at delivery: the driver collects the returned item.')).toBeInTheDocument();
    expect(screen.getByText('Collect the returned item: Walk New Hire Shirt, M ×1 (RMA-20261005-ABC123)')).toBeInTheDocument();
  });

  // Desk check F3: the RMA was cancelled while this order is still live.
  it('the RMA cancelled: says the replacement is not picked, never the waiting words', () => {
    render(
      <ReplacementBanner
        replacement={{ ...INFO, waitingForReturn: false, returnClosed: true, returnStatus: 'cancelled' }}
        fulfillmentType="pickup"
      />,
    );
    expect(screen.getByTestId('replacement-return-closed')).toHaveTextContent(
      "RMA-20261005-ABC123 was cancelled. This replacement isn't picked.",
    );
    expect(screen.queryByText(/Waiting for returned item/)).toBeNull();
  });

  // Desk check F9 (verifier): a replacement already handed over says how the
  // exchange ended, never that it waits, isn't picked, goes with the driver
  // or can be changed or cancelled (core's replacementBannerLines, the
  // phone's rule too).
  it('handed over: how the exchange ended, the release kept, nothing to wait for, collect, change or cancel', () => {
    render(
      <ReplacementBanner
        replacement={{
          ...INFO,
          handedOver: true,
          waitingForReturn: false,
          returnClosed: true,
          returnStatus: 'cancelled',
          exchangeStatus: 'handed_over_return_cancelled',
          exchangeStatusLabel: 'Part of the replacement handed over, the rest not sent; return cancelled',
          releasedEarly: true,
          release: { byName: 'Dana', reason: 'Swap at delivery: the driver collects the returned item.', at: 't' },
        }}
        fulfillmentType="delivery"
      />,
    );
    expect(screen.getByTestId('replacement-handed-over')).toHaveTextContent(
      'Part of the replacement handed over, the rest not sent; return cancelled',
    );
    expect(screen.getByText('Released before the return by Dana: Swap at delivery: the driver collects the returned item.')).toBeInTheDocument();
    expect(screen.queryByTestId('replacement-return-closed')).toBeNull();
    expect(screen.queryByText(/isn't picked/)).toBeNull();
    expect(screen.queryByText(/Waiting for returned item/)).toBeNull();
    expect(screen.queryByText(/Collect the returned item/)).toBeNull();
    expect(screen.queryByText(/Change or cancel/)).toBeNull();
    // The RMA is still one click away from the title.
    expect(screen.getByRole('link', { name: 'RMA-20261005-ABC123' })).toHaveAttribute('href', '/dashboard/returns/rma-1');
  });

  it('a member who cannot open the RMA reads its number without a link', () => {
    render(<ReplacementBanner replacement={{ ...INFO, canOpenReturn: false }} fulfillmentType="pickup" />);
    expect(screen.queryByRole('link', { name: 'RMA-20261005-ABC123' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Change or cancel/ })).toBeNull();
  });

  it('an ordinary order renders nothing', () => {
    const { container } = render(<ReplacementBanner replacement={null} fulfillmentType="pickup" />);
    expect(container.innerHTML).toBe('');
  });
});
