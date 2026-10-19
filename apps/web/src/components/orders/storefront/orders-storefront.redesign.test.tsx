import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogItem } from '../v2/types';

// ═══ THE REDESIGNED HEAD AND AVAILABILITY FILTER (P4.B2) ═══
//
// The New order page's head is the shared PageHeader now (DESIGN-SPEC 6.1):
// one h1, the back link, the Tour trigger and the flow indicator (the tour's
// `[aria-label="Order progress"]` target) in the header's actions. The
// Availability options draw the shared checkbox picture and say their state
// with aria-pressed: before, the ticked state was a picture only.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: vi.fn(),
  getOrderSubmissionAction: vi.fn(),
  withdrawOrderSubmissionAction: vi.fn(),
}));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: () => <button type="button">Tour</button>,
}));
vi.mock('@/components/perf/perf-useful', () => ({ usePerfUseful: () => {} }));
vi.mock('./storefront-cards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./storefront-cards')>();
  return {
    ...real,
    ProductCard: ({ item }: { item: CatalogItem }) => <div data-testid="card">{item.name}</div>,
    FreqCarousel: () => null,
    SfPhoto: () => null,
  };
});
vi.mock('./storefront-overlays', () => ({
  SfPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  QuickViewDrawer: () => null,
  ReviewModal: () => null,
}));

import { OrdersStorefront, type StorefrontCatalogData } from './orders-storefront';

function item(id: string, name: string, onHand: number): CatalogItem {
  return {
    id,
    sku: id.toUpperCase(),
    name,
    warehouseId: 'wh-1',
    quantityOnHand: onHand,
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
}

function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  p.status = 'fulfilled';
  p.value = value;
  return p;
}

async function openPage() {
  await act(async () => {
    render(
      <OrdersStorefront
        warehouses={[{ id: 'wh-1', name: 'Main DC' }]}
        warehouseId="wh-1"
        catalogPromise={settled<StorefrontCatalogData>({
          items: [item('chair', 'Folding Chair', 12), item('cone', 'Traffic Cone', 0)],
          aisles: [],
        })}
        frequentlyOrderedPromise={settled([])}
        kitsPromise={settled({ status: 'ok' as const, kits: [] })}
        kitsEnabled={false}
        chartersForWarehouse={[]}
        canActOnBehalf={false}
        viewerName="Staff Person"
        viewerEmail="staff@example.test"
        orgTimezone="America/Los_Angeles"
        deliveryRecipients={null}
        viewerUserId="user-1"
        organizationId="org-1"
        canApproveOrders={false}
      />,
    );
  });
}

describe('New order page head (the shared page header)', () => {
  it('has exactly one h1, the back link, the Tour trigger and the order progress in the header', async () => {
    await openPage();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings.map((h) => h.textContent)).toEqual(['Place an order']);

    const header = headings[0]!.closest('[data-slot="page-header"]') as HTMLElement;
    expect(header).not.toBeNull();
    const back = within(header).getByRole('link', { name: /Back to orders/ });
    expect(back.getAttribute('href')).toBe('/dashboard/orders');
    expect(
      within(header).getByText(
        'Browse available inventory, add items to your cart, and submit for approval.',
      ),
    ).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'Tour' })).toBeTruthy();
    // The tour's step 2 target stays inside the page.
    const progress = header.querySelector('[aria-label="Order progress"]');
    expect(progress?.textContent).toMatch(/Browse.*Cart.*Review.*Submit/);
  });

  it('keeps the setup bar the tour spotlights', async () => {
    await openPage();
    expect(document.querySelector('.sf-setup')).not.toBeNull();
    expect(screen.getByLabelText('Search catalog')).toBeTruthy();
  });
});

describe('Availability filter options', () => {
  it('say whether each is on with aria-pressed, and draw the shared checkbox', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: /Availability/ }));
    const menu = screen.getByRole('dialog');
    const inStock = within(menu).getByRole('button', { name: /In stock/ });
    expect(inStock.getAttribute('aria-pressed')).toBe('false');
    expect(inStock.querySelector('.sf-cb')).not.toBeNull();

    fireEvent.click(inStock);
    const again = within(screen.getByRole('dialog')).getByRole('button', { name: /In stock/ });
    expect(again.getAttribute('aria-pressed')).toBe('true');
    // The ticked box draws its tick; the others stay empty.
    expect(again.querySelector('.sf-cb > span')).not.toBeNull();
    const out = within(screen.getByRole('dialog')).getByRole('button', { name: /Out of stock/ });
    expect(out.getAttribute('aria-pressed')).toBe('false');
    expect(out.querySelector('.sf-cb > span')).toBeNull();
    // The filter still filters, and its chip still clears it.
    expect(screen.getByRole('button', { name: 'Remove In stock filter' })).toBeTruthy();
  });
});
