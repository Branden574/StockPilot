import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The assistant itself (DeliveryRequestAction) is a recording stub: its own
 * behavior — window.open ordering, the opener-severing, the mailto: one-shot,
 * the clipboard chain — is covered by delivery-request-action.test.tsx and is
 * REUSED verbatim by this wrapper, never reimplemented. What this file pins
 * is the wrapper's one job: hand that component the exact
 * `DeliveryRequestInput` shape the storefront success dialog passes, from the
 * flattened RSC-serializable props the order detail page can actually send.
 */
const actionSpy = vi.hoisted(() => vi.fn());
const actionRecipientsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/orders/storefront/delivery-request-action', () => ({
  __esModule: true,
  default: ({ input, recipients }: { input: unknown; recipients: unknown }) => {
    actionSpy(input);
    actionRecipientsSpy(recipients);
    return null;
  },
}));

import { SendDeliveryRequestButton } from './send-delivery-request-button';

// Per-org routing (migration 0337): the page resolves the recipients and this
// wrapper only threads them through. A deliberately NON-compiled pair proves
// the pass-through is the value handed in, not a constant.
const TEST_ROUTING = {
  to: 'intake@other-tenant.invalid',
  cc: 'copy@other-tenant.invalid',
  toName: 'Other Intake',
};

const baseProps = {
  recipients: TEST_ROUTING,
  orderId: 'f3d77cda-68aa-43a3-bb6b-09fce21291e4',
  orderNumber: 61,
  warehouseName: 'DC4',
  destination: {
    id: 'c1',
    name: 'CVW Clovis',
    code: 'CVW-CLO',
    address: { line1: '1 Main St', city: 'Clovis' },
  },
  requestedFor: 'Doua Vang',
  requesterEmail: 'doua@example.org',
  neededBy: '2026-08-20T17:00:00.000Z',
  orgTimezone: 'America/Los_Angeles',
  notes: 'Front office, ask for Doua',
  lines: [
    { itemId: 'i1', quantity: 3, name: 'Google Chrome Book', sku: 'SP-BVK31-LH9' },
    { itemId: 'i2', quantity: 1, name: 'Charger', sku: 'SP-CHRG-1' },
  ],
};

describe('SendDeliveryRequestButton', () => {
  it('renders the trigger, and does not mount the assistant until opened', () => {
    render(<SendDeliveryRequestButton {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /send delivery request/i }),
    ).toBeInTheDocument();
    expect(actionSpy).not.toHaveBeenCalled();
  });

  it('mounts the assistant with the exact DeliveryRequestInput the storefront dialog passes — fulfillmentType pinned to delivery, lines/itemMap rebuilt from the flattened props', async () => {
    render(<SendDeliveryRequestButton {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /send delivery request/i }));

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(actionSpy).toHaveBeenCalledWith({
      orderId: 'f3d77cda-68aa-43a3-bb6b-09fce21291e4',
      orderNumber: 61,
      fulfillmentType: 'delivery',
      warehouseName: 'DC4',
      destination: {
        id: 'c1',
        name: 'CVW Clovis',
        code: 'CVW-CLO',
        address: { line1: '1 Main St', city: 'Clovis' },
      },
      requestedFor: 'Doua Vang',
      requesterEmail: 'doua@example.org',
      neededByLocal: '2026-08-20T17:00:00.000Z',
      orgTimezone: 'America/Los_Angeles',
      notes: 'Front office, ask for Doua',
      lines: [
        { itemId: 'i1', quantity: 3 },
        { itemId: 'i2', quantity: 1 },
      ],
      itemMap: new Map([
        ['i1', { name: 'Google Chrome Book', sku: 'SP-BVK31-LH9' }],
        ['i2', { name: 'Charger', sku: 'SP-CHRG-1' }],
      ]),
    });
    // The routing rides through UNCHANGED — the wrapper never substitutes a
    // constant for the value the page resolved.
    expect(actionRecipientsSpy).toHaveBeenCalledWith(TEST_ROUTING);
  });

  it('scopes the assistant under .sp-storefront so its sf-* classes resolve', () => {
    const { baseElement } = render(<SendDeliveryRequestButton {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /send delivery request/i }));
    // The dialog portals to body, so search from the document root.
    expect(baseElement.querySelector('.sp-storefront')).not.toBeNull();
  });
});
