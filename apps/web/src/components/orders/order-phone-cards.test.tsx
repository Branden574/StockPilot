import { render, within } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrderRequestSummary } from '@/server/services/order-requests';

import { OrderPhoneCards } from './order-phone-cards';

/**
 * The Orders list's phone cards (Liquid Glass, Orders.dc.html at 760 px and
 * under). Glass-only and stateless: one link per row to the row's own order
 * page, every column's words, and nothing at all under the `off` rollout.
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => vi.unstubAllEnvs());

const NOW = Date.now();
function row(over: Partial<OrderRequestSummary> = {}): OrderRequestSummary {
  return {
    id: 'o1',
    orderNumber: 231,
    status: 'pending_approval',
    warehouseId: 'w1',
    warehouseName: 'North DC',
    requesterUserId: 'u-9',
    requesterEmail: 'pat@example.test',
    requesterName: 'Pat Lee',
    requesterOrgLabel: 'Ridge Academy',
    requesterDeleted: false,
    source: 'internal',
    lineCount: 3,
    totalQuantity: 8,
    notes: null,
    createdAt: new Date(NOW - 3 * 3600_000).toISOString(),
    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    approvedAt: null,
    deliveredAt: null,
    fulfillmentType: 'delivery',
    inTransitAt: null,
    assignedPickerId: 'p1',
    assignedPickerName: 'Luis Ortega',
    assignedDeliveryUserId: 'd1',
    assignedDeliveryUserName: 'Sam Reyes',
    replacementForReturnId: null,
    exchange: null,
    ...over,
  } as OrderRequestSummary;
}

describe('OrderPhoneCards', () => {
  it('renders nothing under the off rollout (Classic is today’s markup)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    const view = render(<OrderPhoneCards rows={[row()]} />);
    expect(view.container.innerHTML).toBe('');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '1');
    view.rerender(<OrderPhoneCards rows={[row()]} />);
    expect(view.container.innerHTML).toBe('');
  });

  it('renders nothing for no rows (the page shows its empty state)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    expect(render(<OrderPhoneCards rows={[]} />).container.innerHTML).toBe('');
  });

  it.each(['opt-in', 'default'] as const)(
    '%s: one glass-only list, named by the page title, with one link per row to its own order',
    (rollout) => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const view = render(<OrderPhoneCards rows={[row(), row({ id: 'o2', orderNumber: 232 })]} />);
      const list = view.container.querySelector('ul')!;
      expect(list).toHaveAttribute('data-glass-only');
      expect(list).toHaveAttribute('aria-labelledby', 'orders-title');
      const links = within(list).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        '/dashboard/orders/o1',
        '/dashboard/orders/o2',
      ]);
      // Only links: no button, field or other control.
      expect(list.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
    },
  );

  it('prints every column the table prints, so none is lost on a phone', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const view = render(
      <OrderPhoneCards
        rows={[
          row({
            source: 'public_link',
            replacementForReturnId: 'r1',
            exchange: { state: 'Waiting for return' } as OrderRequestSummary['exchange'],
          }),
        ]}
      />,
    );
    const card = view.getByRole('link');
    for (const words of [
      'SO-000231', // Order #
      'Pending', // Status
      'Exchange',
      'Waiting for return',
      'Pat Lee', // Requester
      'Ridge Academy',
      'Public',
      'North DC', // Warehouse
      'Delivery', // Type
      '3 lines', // Lines
      '8 units', // Total qty
      'Picker Luis Ortega', // Picker
      'Driver Sam Reyes', // Driver
      'Requested 3 hours ago', // Requested
      '5 minutes ago', // Last update
    ]) {
      expect(card).toHaveTextContent(words);
    }
  });

  it('says one line and one unit in the singular, and a dash for an unset picker', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const view = render(
      <OrderPhoneCards
        rows={[
          row({
            lineCount: 1,
            totalQuantity: 1,
            fulfillmentType: 'pickup',
            assignedPickerName: null,
          }),
        ]}
      />,
    );
    const card = view.getByRole('link');
    expect(card).toHaveTextContent('1 line · 1 unit');
    expect(card).toHaveTextContent('Pickup');
    expect(card).toHaveTextContent('Picker —');
  });
});
