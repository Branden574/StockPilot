import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

import type { CatalogItem } from '../v2/types';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). Place an order's
 * storefront: its Classic DOM in three states (the catalog with an empty
 * cart, the cart with three lines, and the review sheet open), normalised as
 * the classic proof normalises a page (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE Liquid Glass added the page-root hook.
 * Liquid Glass may add only inert hook attributes and glass-only elements;
 * with them stripped the storefront must render exactly the pinned DOM under
 * the `off` rollout (with no glass-only element at all) and under `default`.
 * Fix the change, never the snapshot.
 *
 * Synthetic data only (invented names, example.test addresses).
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: vi.fn(),
  getOrderSubmissionAction: vi.fn(),
  withdrawOrderSubmissionAction: vi.fn(),
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ usePerfUseful: () => {} }));

import { OrdersStorefront, type StorefrontCatalogData } from './orders-storefront';

const CATEGORIES = [
  { id: 'c1', name: 'Classroom supplies' },
  { id: 'c2', name: 'Furniture' },
];

function item(id: string, name: string, onHand: number, category: number): CatalogItem {
  return {
    id,
    sku: `SKU-${id.toUpperCase()}`,
    name,
    warehouseId: 'wh-1',
    quantityOnHand: onHand,
    reservedQuantity: 0,
    itemType: null,
    categoryId: CATEGORIES[category]!.id,
    categoryName: CATEGORIES[category]!.name,
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

const ITEMS = [
  item('a', 'Whiteboard Markers, 4-pack', 120, 0),
  item('b', 'Composition Notebook', 4, 0),
  item('c', 'Folding Chair', 36, 1),
  item('d', 'Student Desk', 0, 1),
];

/** A promise React's use() reads synchronously (already settled). */
function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  p.status = 'fulfilled';
  p.value = value;
  return p;
}

// The review's needed-by field has a min of "now": a fixed clock.
const NOW = new Date('2026-11-02T18:00:00Z');
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
});

interface States {
  browse: string;
  cart: string;
  review: string;
  /** classicStructure of the catalog, the cart and the review, in that order. */
  structure: string[];
  glassOnly: number;
}

async function renderUnder(rollout: 'off' | 'default'): Promise<States> {
  // One tree on the page at a time: the review is read from document.body.
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <OrdersStorefront
        warehouses={[
          { id: 'wh-1', name: 'Main Warehouse' },
          { id: 'wh-2', name: 'North Site' },
        ]}
        warehouseId="wh-1"
        catalogPromise={settled<StorefrontCatalogData>({ items: ITEMS, aisles: [] })}
        frequentlyOrderedPromise={settled([])}
        kitsPromise={settled({ status: 'ok' as const, kits: [] })}
        kitsEnabled={false}
        chartersForWarehouse={[]}
        canActOnBehalf={false}
        viewerName="Robin Example"
        viewerEmail="robin@example.test"
        orgTimezone="America/Los_Angeles"
        deliveryRecipients={null}
        viewerUserId="user-1"
        organizationId="org-1"
        canApproveOrders={false}
      />,
    );
  });
  const browse = classicDom(view.container);
  const browseStructure = classicStructure(view.container);
  for (const add of screen.getAllByRole('button', { name: /Add to cart/ }).slice(0, 3)) {
    await act(async () => {
      fireEvent.click(add);
    });
  }
  const cart = classicDom(view.container);
  const cartStructure = classicStructure(view.container);
  const reviewButton = view.container.querySelector('.sf-submit');
  if (!(reviewButton instanceof HTMLButtonElement)) throw new Error('no Review button');
  await act(async () => {
    fireEvent.click(reviewButton);
  });
  // The review sheet sits in the page (an in-tree overlay), so body holds it.
  const review = classicDom(document.body);
  const structure = [browseStructure, cartStructure, classicStructure(document.body)];
  const glassOnly = glassOnlyCount(document.body);
  cleanup();
  return { browse, cart, review, structure, glassOnly };
}

describe('Place an order storefront, Classic DOM', () => {
  it('the pinned Classic DOM of the catalog, the cart and the review, under off and under default', async () => {
    const off = await renderUnder('off');
    expect(off.glassOnly).toBe(0);
    const glass = await renderUnder('default');
    expect(glass.browse).toBe(off.browse);
    expect(glass.cart).toBe(off.cart);
    expect(glass.review).toBe(off.review);
    // No Classic element changes its place among its siblings (classicStructure).
    expect(glass.structure).toEqual(off.structure);
    await expect(off.browse).toMatchFileSnapshot('./__classic__/storefront.browse.txt');
    await expect(off.cart).toMatchFileSnapshot('./__classic__/storefront.cart.txt');
    await expect(off.review).toMatchFileSnapshot('./__classic__/storefront.review.txt');
  });
});
