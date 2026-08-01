import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// SfPhoto / CharterTag pull next/image and the catalog card styling, neither of
// which this file is about.
vi.mock('./storefront-cards', () => ({
  SfPhoto: () => <div data-testid="sf-photo" />,
  CharterTag: () => <div data-testid="sf-charter-tag" />,
  SfAddControl: () => <div data-testid="sf-add-control" />,
}));

import { ReviewModal } from './storefront-overlays';

const ITEM: CatalogItem = {
  id: 'i-1',
  sku: 'APP-POLO-W',
  name: "L4L Polo (Women's)",
  warehouseId: 'wh-1',
  quantityOnHand: 10,
  reservedQuantity: 0,
  itemType: null,
  categoryId: null,
  categoryName: null,
  charterId: null,
  charterName: null,
  charterCode: null,
  rackLabel: null,
  imageUrl: null,
  lqip: null,
  price: null,
  reorderPoint: 0,
};

function renderSuccess(overrides: Record<string, unknown> = {}) {
  const props = {
    stage: 'success' as const,
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([['i-1', ITEM]]),
    notes: 'Please stage these by Friday.',
    summary: {
      warehouseName: 'DC4',
      method: 'delivery' as const,
      deliverTo: 'CVW Clovis',
      requestedFor: 'Branden Vincent-Walker',
      requesterEmail: 'branden@cvwest.org',
      orgTimezone: 'America/Los_Angeles',
    },
    neededBy: '2026-08-05T09:00',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: { line1: '1295 Shaw Ave', city: 'Fresno', region: 'California', postalCode: '93612' },
    },
    orderUrlBase: 'https://app.stockpilotusa.com',
    submitting: false,
    submitted: { id: 'b3f1c2d4-1111-2222-3333-444455556666', orderNumber: 49, unitCount: 5 },
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    onViewOrder: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ReviewModal {...props} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ReviewModal success stage', () => {
  it('prints the CANONICAL order number, never a uuid-derived SO- handle', () => {
    renderSuccess();
    expect(screen.getByText('SO-000049 · DC4 · 5 units')).toBeInTheDocument();
  });

  it('renders the delivery-request action alongside View order and Done', () => {
    renderSuccess();
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View order/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Done$/i })).toBeInTheDocument();
  });

  it('renders the action for a PICKUP order too (owner decision D1)', () => {
    renderSuccess({
      summary: {
        warehouseName: 'DC4',
        method: 'pickup',
        deliverTo: 'DC4 will-call desk',
        requestedFor: 'Branden Vincent-Walker',
        requesterEmail: 'branden@cvwest.org',
        orgTimezone: 'America/Los_Angeles',
      },
      destination: null,
    });
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
  });

  it('never claims a ticket was created anywhere on the success screen', () => {
    const { container } = renderSuccess();
    const text = (container.textContent ?? '').toLowerCase();
    for (const claim of ['ticket created', 'ticket submitted', 'assigned to', 'email sent']) {
      expect(text).not.toContain(claim);
    }
  });

  it('the existing actions still work — R1', async () => {
    const user = userEvent.setup();
    const { props } = renderSuccess();

    await user.click(screen.getByRole('button', { name: /View order/i }));
    expect(props.onViewOrder).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all when stage is null', () => {
    const { container } = render(
      <ReviewModal
        stage={null}
        lines={[]}
        itemMap={new Map()}
        notes=""
        summary={{
          warehouseName: 'DC4',
          method: 'delivery',
          deliverTo: 'CVW Clovis',
          requestedFor: 'X',
          requesterEmail: null,
          orgTimezone: 'America/Los_Angeles',
        }}
        neededBy=""
        destination={null}
        orderUrlBase=""
        submitting={false}
        submitted={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onViewOrder={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
