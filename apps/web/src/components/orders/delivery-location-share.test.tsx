import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Redesign P4.B1: live delivery tracking is a titled card on the order page,
// with its sentence and its one toggle, whose words say what a press does.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/delivery-tracking', () => ({
  shareDeliveryLocationAction: vi.fn(async () => ({ ok: true, data: null })),
}));

import { DeliveryLocationShare } from './delivery-location-share';

const original = Object.getOwnPropertyDescriptor(navigator, 'geolocation');

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'geolocation', original);
  else delete (navigator as { geolocation?: unknown }).geolocation;
});

describe('DeliveryLocationShare — the redesigned card (P4.B1)', () => {
  it('shows the titled card and turns sharing on and off', async () => {
    const watchPosition = vi.fn(() => 7);
    const clearWatch = vi.fn();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { watchPosition, clearWatch },
    });
    const user = userEvent.setup();
    render(<DeliveryLocationShare orderId="order-1" />);
    const card = screen.getByTestId('delivery-location-share');
    expect(card).toHaveAttribute('data-slot', 'detail-section');
    expect(screen.getByRole('heading', { name: 'Live delivery tracking' })).toBeInTheDocument();
    expect(card).toHaveTextContent(
      'While on, the customer can see your location on a map until this delivery completes. Foreground only.',
    );
    await user.click(screen.getByRole('button', { name: 'Share my location' }));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));
    expect(clearWatch).toHaveBeenCalledWith(7);
    expect(screen.getByRole('button', { name: 'Share my location' })).toBeInTheDocument();
  });
});
