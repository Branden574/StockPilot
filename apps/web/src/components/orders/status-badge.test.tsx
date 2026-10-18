// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { badgeVariants } from '@/components/ui/badge';
import type { OrderRequestStatus } from '@/server/services/order-requests';

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

// The redesign (P2.4, DESIGN-SPEC 6.10): the badge keeps every word and maps
// the org's colour onto the six Badge tones through the existing variant
// names. The tone is read from the live Badge recipe (classes all six tones
// share are ignored), so restyling the recipe cannot break the check.
const TONES = ['default', 'secondary', 'destructive', 'success', 'warning', 'outline'] as const;
function toneOf(el: Element): string {
  const own = new Set(el.className.split(/\s+/));
  const recipes = TONES.map((t) => badgeVariants({ variant: t }).split(/\s+/));
  const shared = recipes.reduce((a, r) => a.filter((c) => r.includes(c)));
  return TONES.filter((_, i) => recipes[i]!.every((c) => shared.includes(c) || own.has(c))).join(
    '|',
  );
}

describe('OrderStatusBadge: the 14 statuses, their words and tones', () => {
  // Pinned literally (not read back from core) so a renamed word or a
  // recoloured status fails here.
  const canonical: Array<[OrderRequestStatus, string, string]> = [
    ['pending_confirmation', 'Awaiting confirmation', 'outline'],
    ['pending_approval', 'Pending', 'warning'],
    ['approved', 'Approved', 'default'],
    ['pick_slip_generated', 'Pick slip', 'secondary'],
    ['picking_in_progress', 'Picking', 'secondary'],
    ['picking_complete', 'Picked', 'secondary'],
    ['packing_slip_generated', 'Packaging', 'secondary'],
    ['staged_for_pickup', 'Staged (pickup)', 'secondary'],
    ['staged_for_delivery', 'Ready', 'secondary'],
    ['in_transit', 'In transit', 'secondary'],
    ['backordered', 'Backordered', 'warning'],
    ['completed', 'Delivered', 'success'],
    ['denied', 'Denied', 'destructive'],
    ['cancelled', 'Cancelled', 'outline'],
  ];

  it.each(canonical)('%s reads "%s" on the %s tone', (status, word, tone) => {
    render(<OrderStatusBadge status={status} fulfillmentType="delivery" />);
    expect(toneOf(screen.getByText(word))).toBe(tone);
  });

  it('a completed pickup reads "Handed over" on the success tone', () => {
    render(<OrderStatusBadge status="completed" fulfillmentType="pickup" />);
    expect(toneOf(screen.getByText('Handed over'))).toBe('success');
  });

  it("an organization's own word and colour are kept", () => {
    render(
      <OrderStatusConfigProvider
        config={{ pending_approval: { label: 'Waiting on Sam', color: 'destructive' } }}
      >
        <OrderStatusBadge status="pending_approval" />
      </OrderStatusConfigProvider>,
    );
    expect(toneOf(screen.getByText('Waiting on Sam'))).toBe('destructive');
  });

  it('a status this build does not know shows its raw value on the outline tone', () => {
    render(<OrderStatusBadge status={'on_the_moon' as OrderRequestStatus} />);
    expect(toneOf(screen.getByText('on_the_moon'))).toBe('outline');
  });
});
