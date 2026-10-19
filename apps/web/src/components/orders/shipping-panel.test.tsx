import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Redesign P4.B1: the shipping card keeps its read rule (nothing at all for
// someone who may not buy when no label exists), its label and value rows
// (status, carrier and service, tracking link, carrier status, cost), the
// Download label link and the Buy shipping label dialog; a chosen rate now
// says it is chosen (aria-pressed), not only by its colour.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ShippingPanel } from './shipping-panel';

const ORDER = '11111111-1111-4111-8111-111111111111';

const PURCHASED = {
  id: 'ship-1',
  carrier: 'USPS',
  service: 'Priority',
  rate_cents: 845,
  currency: 'USD',
  tracking_code: '9400TEST',
  tracking_status: 'in_transit',
  tracking_url: 'https://track.test/9400TEST',
  label_url: 'https://labels.test/ship-1.pdf',
  status: 'in_transit',
};

function mockFetch(shipment: unknown, rates?: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/shipping/rates')) {
      return new Response(JSON.stringify(rates), { status: 200 });
    }
    return new Response(JSON.stringify({ shipment }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShippingPanel — the redesigned card (P4.B1)', () => {
  it('a bought label: label and value rows, the tracking link and Download label', async () => {
    mockFetch(PURCHASED);
    render(<ShippingPanel orderId={ORDER} canBuyLabel={false} charterSettingsHref="/x" />);
    const heading = await screen.findByRole('heading', { name: 'Shipping' });
    const card = heading.closest('section')!;
    expect(card).toHaveAttribute('data-slot', 'detail-section');
    expect(card).toHaveTextContent('Carrier label & tracking for this delivery.');
    const rows = Array.from(card.querySelectorAll('dl > div')).map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ]);
    expect(rows).toEqual([
      ['Status', 'In transit'],
      ['Carrier', 'USPS · Priority'],
      ['Tracking #', '9400TEST'],
      ['Carrier status', 'in transit'],
      ['Cost', '$8.45'],
    ]);
    expect(within(card).getByRole('link', { name: '9400TEST' })).toHaveAttribute(
      'href',
      'https://track.test/9400TEST',
    );
    expect(within(card).getByRole('link', { name: 'Download label' })).toHaveAttribute(
      'href',
      'https://labels.test/ship-1.pdf',
    );
    expect(screen.queryByRole('button', { name: 'Buy shipping label' })).toBeNull();
  });

  it('no label and the viewer may not buy one: nothing renders', async () => {
    const fetchMock = mockFetch(null);
    const { container } = render(
      <ShippingPanel orderId={ORDER} canBuyLabel={false} charterSettingsHref="/x" />,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('no label for someone who may buy: the sentence, Buy shipping label, and a chosen rate says so', async () => {
    mockFetch(null, {
      shipmentId: 's',
      easypostShipmentId: 'e',
      rates: [
        {
          id: 'r1',
          carrier: 'USPS',
          service: 'Ground',
          rate: '5.10',
          currency: 'USD',
          delivery_days: 3,
        },
        {
          id: 'r2',
          carrier: 'UPS',
          service: 'Next Day',
          rate: '22.00',
          currency: 'USD',
          delivery_days: 1,
        },
      ],
    });
    const user = userEvent.setup();
    render(<ShippingPanel orderId={ORDER} canBuyLabel charterSettingsHref="/x" />);
    expect(
      await screen.findByText(
        'No shipping label yet. Buy a label to generate tracking for this delivery.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Buy shipping label' }));
    const dialog = await screen.findByRole('dialog', { name: 'Buy shipping label' });
    for (const label of ['Weight (oz)', 'Length (in)', 'Width (in)', 'Height (in)']) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
    await user.click(within(dialog).getByRole('button', { name: 'Get rates' }));
    const ground = await within(dialog).findByRole('button', { name: /USPS · Ground/ });
    const nextDay = within(dialog).getByRole('button', { name: /UPS · Next Day/ });
    expect(ground).toHaveAttribute('aria-pressed', 'false');
    await user.click(nextDay);
    expect(nextDay).toHaveAttribute('aria-pressed', 'true');
    expect(ground).toHaveAttribute('aria-pressed', 'false');
    expect(within(dialog).getByRole('button', { name: 'Refresh rates' })).toBeInTheDocument();
  });
});
