// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OrderStatusConfigProvider } from './order-status-config-provider';
import { OrderStatusBadge } from './status-badge';

/**
 * Returns RX-3 PR stage, polish (c), from the RX-2 Demo Co walk: a completed
 * PICKUP order read "Delivered". The badge now takes the order's fulfilment:
 * a completed pickup reads "Handed over" (core orderStatusLabelForFulfillment,
 * the phone's rule), a delivery keeps "Delivered", and an organization's own
 * word for the status is kept as typed.
 */
describe('OrderStatusBadge for a completed order', () => {
  it('says Handed over for a pickup and Delivered for a delivery', () => {
    const { unmount } = render(<OrderStatusBadge status="completed" fulfillmentType="pickup" />);
    expect(screen.getByText('Handed over')).toBeInTheDocument();
    unmount();
    render(<OrderStatusBadge status="completed" fulfillmentType="delivery" />);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it("keeps an organization's own word for the completed status", () => {
    render(
      <OrderStatusConfigProvider config={{ completed: { label: 'Closed out' } }}>
        <OrderStatusBadge status="completed" fulfillmentType="pickup" />
      </OrderStatusConfigProvider>,
    );
    expect(screen.getByText('Closed out')).toBeInTheDocument();
  });

  it('the order page and the orders list pass the order fulfilment', () => {
    const app = resolve(__dirname, '../../app/(dashboard)/dashboard/orders');
    expect(readFileSync(resolve(app, '[id]/page.tsx'), 'utf8')).toContain(
      '<OrderStatusBadge status={request.status} fulfillmentType={request.fulfillment_type} />',
    );
    expect(readFileSync(resolve(app, 'page.tsx'), 'utf8')).toContain(
      '<OrderStatusBadge status={r.status} fulfillmentType={r.fulfillmentType} />',
    );
  });
});
