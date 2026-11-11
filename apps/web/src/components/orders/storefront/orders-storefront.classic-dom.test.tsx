import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cssRules, declaredFor, normaliseQuotes } from '@/styles/liquid-glass/glass-css';
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

/**
 * THE PHONE (Liquid Glass, fidelity lane phone; Order-New-Mobile.dc.html).
 * At 760 px and under, storefront.glass.css draws the steps on one line, the
 * order setup as one line (its four cells kept, in Classic's order, each with
 * its popover; the Pickup / Delivery segment as two icons whose words stay
 * the buttons' names) and the cart bar at the foot: the floating cart button
 * itself across the foot and the cart's own Review order button fixed at its
 * right, both only while the cart holds something. This renders the real
 * storefront and checks each rule lands on those nodes. Fails on a
 * stylesheet without the phone rules.
 */
describe('Liquid Glass phone: one-line setup and steps, the cart bar', () => {
  const rules = cssRules('storefront.glass.css');
  const globals = cssRules('globals.glass.css');
  const phone = (media: string[]) => media.includes('(max-width: 760px)');
  const declared = (el: Element, prop: string) => declaredFor(el, rules, prop, phone);

  it('lays the setup and the steps on one line and builds the bar from the cart button and Review order', async () => {
    cleanup();
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.documentElement.setAttribute('data-appearance', 'liquid-glass');
    try {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(
          <OrdersStorefront
            warehouses={[{ id: 'wh-1', name: 'Main Warehouse' }]}
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
      const root = view.container;
      // Steps on one line.
      expect(declared(root.querySelector('.sf-flow')!, 'flex-wrap')).toBe('nowrap');
      // The setup: its four parts in Classic's order, on the card's two
      // lines (Ship from and For, then Pick up at across both columns), the
      // segment at the right of both.
      const setup = root.querySelector('.sf-page > .sf-setup')!;
      expect(declared(setup, 'display')).toBe('grid');
      expect(declared(setup, 'grid-template-columns')).toBe('minmax(0, 1fr) minmax(0, 1fr) auto');
      const parts = [...setup.children];
      expect(parts.map((c) => c.className)).toEqual([
        'sf-setup-cell',
        'sf-setup-cell',
        'sf-seg-wrap',
        'sf-setup-cell static',
      ]);
      const [shipFrom, forCell, segWrap, pickUp] = parts as [Element, Element, Element, Element];
      for (const cell of [shipFrom, forCell, pickUp]) {
        expect(declared(cell, 'position')).toBe('static');
        expect(declared(cell, 'min-width')).toBe('0');
      }
      expect(declared(segWrap, 'grid-column')).toBe('3');
      expect(declared(segWrap, 'grid-row')).toBe('1 / span 2');
      expect(declared(pickUp, 'grid-column')).toBe('1 / span 2');
      expect(declared(pickUp, 'grid-row')).toBe('2');
      expect(declared(forCell, 'border-left')).toBe('1px solid var(--lg-line)');
      expect(declared(pickUp, 'border-top')).toBe('1px solid var(--lg-line)');
      // Each value wraps in its column with its chevron (never clipped:
      // text-overflow draws nothing on Classic's flex value).
      for (const vl of setup.querySelectorAll('.sf-setup-cell .vl')) {
        expect(declared(vl, 'display')).toBe('block');
        expect(declared(vl, 'white-space')).toBe('normal');
        expect(declared(vl, 'overflow')).toBe('visible');
      }
      expect(shipFrom.querySelector('.vl .icon svg')).not.toBeNull();
      for (const hidden of setup.querySelectorAll('.sf-setup-ic, .static .hint')) {
        expect(declared(hidden, 'display')).toBe('none');
      }
      // For's hint (yourself, or the on-behalf email) stays on the card.
      const forHint = forCell.querySelector('.hint')!;
      expect(forHint.textContent).toBe('Robin Example');
      expect(declared(forHint, 'display')).toBeUndefined();
      const seg = [...setup.querySelectorAll('.sf-seg button')];
      expect(seg.map((b) => b.textContent?.trim())).toEqual(['Pickup', 'Delivery']);
      for (const b of seg) {
        expect(declared(b, 'font-size')).toBe('0');
        expect(declared(b, 'width')).toBe('40px');
      }

      // Empty cart: no bar, Review order stays in the cart.
      const fab = () => root.querySelector('.sf-fab')!;
      const review = () => root.querySelector('.sf-cart-foot .sf-submit')!;
      expect(root.querySelectorAll('.sf-submit').length).toBe(1);
      expect(fab().getAttribute('data-show')).toBe('false');
      expect(declared(fab(), 'height')).toBeUndefined();
      expect(declared(review(), 'position')).toBeUndefined();
      // The toast dock (sonner's list, globals.glass.css) rises over the bar
      // only while the bar is up: the rule is pinned, and its :has() condition
      // is evaluated on the page (happy-dom matches a :not() inside :has()
      // wrongly, so the whole selector cannot be matched here).
      const BAR = ".sp-storefront:not(.sf-public) .sf-fab[data-show='true']";
      const lift = globals.find(
        (r) =>
          phone(r.media) &&
          r.selectors.some(
            (sel) =>
              normaliseQuotes(sel.replace(/\s+/g, ' ').replace(/\( | \)/g, (m) => m.trim())) ===
              `:root[data-appearance='liquid-glass']:has(${BAR}) ol[data-sonner-toaster][data-y-position='bottom']`,
          ),
      );
      expect(lift?.decls.bottom).toBe('calc(84px + var(--sp-update-card-offset, 0px))');
      expect(document.querySelector(BAR)).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: /Add to cart/ })[0]!);
      });
      expect(fab().getAttribute('data-show')).toBe('true');
      expect(declared(fab(), 'left')).toBe('12px');
      expect(declared(fab(), 'right')).toBe('12px');
      expect(declared(fab(), 'height')).toBe('60px');
      expect(declared(fab(), 'display')).toBe('flex');
      expect(declared(review(), 'position')).toBe('fixed');
      expect(declared(review(), 'z-index')).toBe('41');
      expect(declared(root.querySelector('.sf-page')!, 'padding-bottom')).toBe('108px');
      expect(document.querySelector(BAR)).toBe(fab());
    } finally {
      document.documentElement.removeAttribute('data-appearance');
      cleanup();
    }
  });
});
