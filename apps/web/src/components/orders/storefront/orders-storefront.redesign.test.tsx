import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AisleSummary, CatalogItem, StorefrontCharter } from '../v2/types';

// ═══ THE REDESIGNED HEAD AND AVAILABILITY FILTER (P4.B2) ═══
//
// The New order page's head is the shared PageHeader now (DESIGN-SPEC 6.1):
// one h1, the back link, the Tour trigger and the flow indicator (the tour's
// `[aria-label="Order progress"]` target) in the header's actions. The
// Availability options draw the shared checkbox picture and say their state
// with aria-pressed: before, the ticked state was a picture only. Every other
// choice on the page (Ship from, For, Deliver to, Sort, the view and the
// category pills) says which option is chosen with aria-pressed too, so a
// screen reader hears the state the tick or the filled pill shows.

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
import { StorefrontPageSkeleton } from './storefront-skeleton';

function item(
  id: string,
  name: string,
  onHand: number,
  category: { id: string; name: string } | null = null,
): CatalogItem {
  return {
    id,
    sku: id.toUpperCase(),
    name,
    warehouseId: 'wh-1',
    quantityOnHand: onHand,
    reservedQuantity: 0,
    itemType: null,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
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

interface PageOptions {
  warehouses?: Array<{ id: string; name: string }>;
  items?: CatalogItem[];
  aisles?: AisleSummary[];
  charters?: StorefrontCharter[];
}

async function openPage(opts: PageOptions = {}) {
  await act(async () => {
    render(
      <OrdersStorefront
        warehouses={opts.warehouses ?? [{ id: 'wh-1', name: 'Main DC' }]}
        warehouseId="wh-1"
        catalogPromise={settled<StorefrontCatalogData>({
          items: opts.items ?? [
            item('chair', 'Folding Chair', 12),
            item('cone', 'Traffic Cone', 0),
          ],
          aisles: opts.aisles ?? [],
        })}
        frequentlyOrderedPromise={settled([])}
        kitsPromise={settled({ status: 'ok' as const, kits: [] })}
        kitsEnabled={false}
        chartersForWarehouse={opts.charters ?? []}
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

// The cart draft (Pickup or Delivery, the chosen site) is kept in this
// browser's storage per account and warehouse: start every test from none.
beforeEach(() => {
  window.localStorage.clear();
});

function pressed(el: HTMLElement): string | null {
  return el.getAttribute('aria-pressed');
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

  // storefront.css draws the bar two by two (below 1024 px) and one per line
  // (below 640 px) only as `.sf-page > .sf-setup`, counting four cells, so
  // the public order page's three-cell bar is left alone: the page's bar must
  // stay the frame's own child with four cells, for Pickup and for Delivery.
  it('keeps the setup bar a direct child of the page frame, with four cells', async () => {
    await openPage({
      charters: [{ id: 'ch-1', name: 'Alder Academy', code: 'AA', address: null }],
    });
    const cells = () => document.querySelector('.sf-page > .sf-setup')?.children ?? [];
    expect([...cells()].map((c) => c.className)).toEqual([
      'sf-setup-cell',
      'sf-setup-cell',
      'sf-seg-wrap',
      'sf-setup-cell static',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }));
    expect([...cells()].map((c) => c.className)).toEqual([
      'sf-setup-cell',
      'sf-setup-cell',
      'sf-seg-wrap',
      'sf-setup-cell',
    ]);
  });

  it('draws the loading frame with the same four-cell bar', () => {
    render(<StorefrontPageSkeleton />);
    const bar = document.querySelector('.sf-page > .sf-setup');
    expect(bar?.children).toHaveLength(4);
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

describe('every other choice says which option is chosen with aria-pressed', () => {
  it('Sort: the chosen order is pressed, and the mark moves when another is picked', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: /Name · A–Z/ }));
    let menu = screen.getByRole('dialog');
    expect(pressed(within(menu).getByRole('button', { name: 'Name · A–Z' }))).toBe('true');
    for (const other of ['Name · Z–A', 'Most available', 'Least available', 'Most ordered here']) {
      expect(pressed(within(menu).getByRole('button', { name: other })), other).toBe('false');
    }

    fireEvent.click(within(menu).getByRole('button', { name: 'Most available' }));
    // Picking closes the menu and the trigger names the new order.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Most available/ }));
    menu = screen.getByRole('dialog');
    expect(pressed(within(menu).getByRole('button', { name: 'Most available' }))).toBe('true');
    expect(pressed(within(menu).getByRole('button', { name: 'Name · A–Z' }))).toBe('false');
  });

  it('View: Grid is pressed at first, Compact once it is picked, and back', async () => {
    await openPage();
    expect(pressed(screen.getByRole('button', { name: 'Grid view' }))).toBe('true');
    expect(pressed(screen.getByRole('button', { name: 'Compact view' }))).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    expect(pressed(screen.getByRole('button', { name: 'Compact view' }))).toBe('true');
    expect(pressed(screen.getByRole('button', { name: 'Grid view' }))).toBe('false');
    // The compact rows are drawn, the out-of-stock one still marked for its style.
    const out = document.querySelector('.sf-row[data-out="true"]');
    expect(out?.textContent).toContain('Traffic Cone');

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(pressed(screen.getByRole('button', { name: 'Grid view' }))).toBe('true');
    expect(pressed(screen.getByRole('button', { name: 'Compact view' }))).toBe('false');
  });

  it('Category pills: All is pressed at first; a category when picked, and All again when it is picked a second time', async () => {
    const seating = { id: 'cat-seat', name: 'Seating' };
    const safety = { id: 'cat-safe', name: 'Safety' };
    await openPage({
      items: [item('chair', 'Folding Chair', 12, seating), item('cone', 'Traffic Cone', 0, safety)],
      aisles: [
        { id: seating.id, name: seating.name, itemCount: 1 },
        { id: safety.id, name: safety.name, itemCount: 1 },
      ],
    });
    const pills = () => within(document.querySelector('.sf-pills') as HTMLElement);
    expect(pressed(pills().getByRole('button', { name: /^All/ }))).toBe('true');
    expect(pressed(pills().getByRole('button', { name: /Seating/ }))).toBe('false');
    expect(pressed(pills().getByRole('button', { name: /Safety/ }))).toBe('false');

    fireEvent.click(pills().getByRole('button', { name: /Seating/ }));
    expect(pressed(pills().getByRole('button', { name: /Seating/ }))).toBe('true');
    expect(pressed(pills().getByRole('button', { name: /^All/ }))).toBe('false');
    expect(pressed(pills().getByRole('button', { name: /Safety/ }))).toBe('false');

    fireEvent.click(pills().getByRole('button', { name: /Seating/ }));
    expect(pressed(pills().getByRole('button', { name: /^All/ }))).toBe('true');
    expect(pressed(pills().getByRole('button', { name: /Seating/ }))).toBe('false');
  });

  it('Ship from and For: the warehouse in use and Myself are pressed', async () => {
    await openPage({
      warehouses: [
        { id: 'wh-1', name: 'Main DC' },
        { id: 'wh-2', name: 'North Yard' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /^Ship from/ }));
    let menu = screen.getByRole('dialog');
    expect(pressed(within(menu).getByRole('button', { name: 'Main DC' }))).toBe('true');
    expect(pressed(within(menu).getByRole('button', { name: 'North Yard' }))).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /^Ship from/ }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^For/ }));
    menu = screen.getByRole('dialog');
    expect(pressed(within(menu).getByRole('button', { name: /Myself/ }))).toBe('true');
  });

  it('Deliver to: no site is pressed until one is chosen, then that one is', async () => {
    await openPage({
      charters: [
        { id: 'ch-1', name: 'Alder Academy', code: 'AA', address: null },
        { id: 'ch-2', name: 'Birch School', code: null, address: null },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }));
    fireEvent.click(screen.getByRole('button', { name: /^Deliver to/ }));
    let menu = screen.getByRole('dialog');
    expect(pressed(within(menu).getByRole('button', { name: /Alder Academy/ }))).toBe('false');
    expect(pressed(within(menu).getByRole('button', { name: /Birch School/ }))).toBe('false');

    fireEvent.click(within(menu).getByRole('button', { name: /Birch School/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Deliver to/ }));
    menu = screen.getByRole('dialog');
    expect(pressed(within(menu).getByRole('button', { name: /Birch School/ }))).toBe('true');
    expect(pressed(within(menu).getByRole('button', { name: /Alder Academy/ }))).toBe('false');
  });
});
