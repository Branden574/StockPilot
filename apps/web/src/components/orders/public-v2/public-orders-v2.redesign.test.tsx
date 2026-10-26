import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

/**
 * The public order page's storefront (/r/<token>) after the redesign
 * (P5.1 step B, on the P4.B2 storefront): it shows public fields only, its
 * panels keep their words, and its pickers, dialog and success panel say
 * where the person is to a screen reader and a keyboard.
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/use-catalog-thumbnails', () => ({
  useCatalogPages: () => ({ urls: {}, lqip: {}, descriptions: {} }),
}));
vi.mock('next/image', () => ({ default: () => null }));

import { PublicOrdersV2 } from './public-orders-v2';
import type { PublicCatalogItem } from './types';

// ── Public fields only ─────────────────────────────────────────────────────

/** Values that live on an internal item and must never reach this page. */
const INTERNAL = {
  sku: 'SKU-INTERNAL-7731',
  unitCost: 987.65,
  unitPrice: 54.32,
  binLocation: 'RACK 9-Q SHELF 4',
  locationName: 'Back Room Cage',
  reservedQuantity: 4242,
  reorderPoint: 3131,
  internalNotes: 'internal note: never public',
  description: 'internal description: never public',
  supplierName: 'Wholesale Secret Supplier',
  charterName: 'Charter Secret Academy',
  createdByName: 'Morgan Staffmember',
};

function item(over: Partial<PublicCatalogItem> & { id: string }): PublicCatalogItem {
  return {
    displayName: `Item ${over.id}`,
    publicDescription: null,
    categoryId: null,
    categoryLabel: null,
    imageUrl: null,
    lqip: null,
    availability: { kind: 'exact', count: 20 },
    maxQty: null,
    ...over,
  };
}

const PENCILS = item({
  id: 'pencils',
  displayName: 'Colored Pencils 24-Pack',
  publicDescription: 'Bright colours for every classroom.',
  categoryId: 'art',
  categoryLabel: 'Art',
  availability: { kind: 'exact', count: 12 },
  maxQty: 40,
});
const SCISSORS = item({
  id: 'scissors',
  displayName: 'Safety Scissors',
  categoryId: 'supplies',
  categoryLabel: 'Supplies',
  availability: { kind: 'exact', count: 3 },
});
const GLUE = item({
  id: 'glue',
  displayName: 'Glitter Glue',
  categoryId: 'art',
  categoryLabel: 'Art',
  availability: { kind: 'exact', count: 0 },
});

const WAREHOUSES = [
  { id: 'wh-n', name: 'North DC' },
  { id: 'wh-s', name: 'South DC' },
];

function page(
  props: Partial<React.ComponentProps<typeof PublicOrdersV2>> = {},
): React.ReactElement {
  return (
    <PublicOrdersV2
      token="tok-1"
      orgName="Lincoln Unified"
      warehouses={WAREHOUSES}
      initialWarehouseId="wh-n"
      items={[PENCILS, SCISSORS, GLUE]}
      availabilityDisplay="exact"
      chartersForWarehouse={[{ id: 'site-1', name: 'Harbor Academy', code: 'HA' }]}
      {...props}
    />
  );
}

async function open(props?: Partial<React.ComponentProps<typeof PublicOrdersV2>>) {
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(page(props));
  });
  return utils;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('public fields only', () => {
  it('the item schema has no field for cost, price, SKU, location, reserved stock or a charter', () => {
    expectTypeOf<keyof PublicCatalogItem>().toEqualTypeOf<
      | 'id'
      | 'displayName'
      | 'publicDescription'
      | 'categoryId'
      | 'categoryLabel'
      | 'imageUrl'
      | 'lqip'
      | 'availability'
      | 'maxQty'
    >();
  });

  it('draws only the public fields, even when an item object carries internal ones', async () => {
    // Smuggle every internal field onto the items, as a careless loader would.
    const leaky = [PENCILS, SCISSORS].map(
      (it) => ({ ...it, ...INTERNAL }) as unknown as PublicCatalogItem,
    );
    const { container } = await open({ items: leaky });

    // The card and the cart line (after Add to request) draw public words.
    fireEvent.click(screen.getAllByRole('button', { name: /Add to request/ })[0]!);
    expect(screen.getByText('Colored Pencils 24-Pack', { selector: '.sf-card-nm' })).toBeTruthy();
    expect(screen.getByText('Bright colours for every classroom.')).toBeInTheDocument();

    const html = container.innerHTML;
    for (const [field, value] of Object.entries(INTERNAL)) {
      expect(html, field).not.toContain(String(value));
    }
  });

  it('says availability in the link mode words only: exact counts with the public threshold, buckets, or nothing', async () => {
    const first = await open();
    expect(screen.getByText('12 avail')).toBeInTheDocument();
    expect(screen.getByText('Low · 3 left')).toBeInTheDocument();
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
    expect(screen.getAllByText('Limit 40 per request').length).toBeGreaterThan(0);
    first.unmount();

    const second = await open({
      availabilityDisplay: 'bucket',
      items: [
        { ...PENCILS, availability: { kind: 'bucket', level: 'in_stock' } },
        { ...SCISSORS, availability: { kind: 'bucket', level: 'low_stock' } },
        { ...GLUE, availability: { kind: 'bucket', level: 'out_of_stock' } },
      ],
    });
    expect(screen.getByText('In stock')).toBeInTheDocument();
    expect(screen.getByText('Limited')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\d+ avail/)).toBeNull();
    second.unmount();

    const { container } = await open({
      availabilityDisplay: 'none',
      items: [{ ...PENCILS, availability: { kind: 'none' } }],
    });
    expect(container.querySelector('.sf-avail')).toBeNull();
    // No stock signal, so no Availability filter either.
    expect(screen.queryByRole('button', { name: /Availability/ })).toBeNull();
  });
});

// ── The panels' words ───────────────────────────────────────────────────────

describe('the panels keep their words', () => {
  it('an empty catalog is the shared empty panel, announced, with its sentence', async () => {
    const { container } = await open({ items: [] });
    const panel = container.querySelector('[data-slot="state-panel"]') as HTMLElement;
    expect(panel.getAttribute('data-state-kind')).toBe('empty');
    expect(panel).toHaveAttribute('role', 'status');
    expect(
      within(panel).getByRole('heading', { level: 2, name: 'No items available' }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      'There are currently no items available through this request form. Please contact your organization for assistance.',
    );
    // With more than one location the setup bar stays, so another can be chosen.
    expect(screen.getByText('Location')).toBeInTheDocument();
  });

  it('a search with no match is the shared no-match panel, and its button clears the search', async () => {
    const { container } = await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search catalog' }), {
      target: { value: 'zebra' },
    });
    const panel = container.querySelector('[data-slot="state-panel"]') as HTMLElement;
    expect(panel.getAttribute('data-state-kind')).toBe('no-match');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe(
      'Nothing matches “zebra”',
    );
    expect(panel).toHaveTextContent('Try a different name or category — or clear your filters.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear search & filters' }));
    expect(screen.getByRole('textbox', { name: 'Search catalog' })).toHaveValue('');
    expect(container.querySelector('[data-slot="state-panel"]')).toBeNull();
  });

  it('with only filters on, says nothing matches those filters', async () => {
    const { container } = await open({
      items: [PENCILS],
    });
    fireEvent.click(screen.getByRole('button', { name: /Availability/ }));
    fireEvent.click(screen.getByRole('button', { name: /Out of stock/ }));
    const panel = container.querySelector('[data-slot="state-panel"]') as HTMLElement;
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe(
      'Nothing matches those filters',
    );
  });

  it('the success panel says Check your inbox with the Request ID, the email, the org and the track link, and takes focus', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'req-77', trackUrl: '/r/track?id=req-77&t=x' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await open();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Pat Rivera' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'pat@example.test' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Add to request/ })[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send request/ }));
    });

    const panel = screen.getByRole('status', { name: '' });
    expect(within(panel).getByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(within(panel).getByText('Request ID: req-77')).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "We've emailed pat@example.test a link to confirm this order request. Once you click the link, Lincoln Unified's team will review it — until then, the request stays on hold and is not visible to anyone else.",
    );
    expect(panel).toHaveTextContent(
      "Didn't get it? Check your spam folder, or try again with a different email address. The confirmation link expires in 24 hours.",
    );
    expect(within(panel).getByRole('link', { name: 'Track this order' })).toHaveAttribute(
      'href',
      '/r/track?id=req-77&t=x',
    );
    // The rail that had focus is gone; the panel has it now.
    expect(document.activeElement).toBe(panel);
  });
});

// ── Switch location? ─────────────────────────────────────────────────────────

describe('Switch location?', () => {
  async function askToSwitch() {
    await open();
    fireEvent.click(screen.getAllByRole('button', { name: /Add to request/ })[0]!);
    const cell = screen.getByText('Location').closest('[role="button"]') as HTMLElement;
    fireEvent.click(cell);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /South DC/ }));
    return cell;
  }

  it('asks before a switch empties the cart, in its own words, with Cancel holding focus', async () => {
    await askToSwitch();
    const dialog = screen.getByRole('dialog', { name: 'Switch location?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Switch location?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Your cart has items in it. Switching locations will clear them so the new location's catalog can load.",
    );
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Switch and clear cart' }),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('keeps Tab inside, and Escape is Cancel: the cart stays and focus goes back to Location', async () => {
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);
    const cell = await askToSwitch();
    const dialog = screen.getByRole('dialog', { name: 'Switch location?' });
    const go = within(dialog).getByRole('button', { name: 'Switch and clear cart' });
    const close = within(dialog).getByRole('button', { name: 'Close' });

    go.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(go);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Switch location?' })).toBeNull();
    expect(document.activeElement).toBe(cell);
    expect(assign).not.toHaveBeenCalled();
    // The cart still holds the item.
    expect(screen.getByText('Total units').nextElementSibling?.textContent).toBe('1');
  });

  it('Switch and clear cart reloads the page on the chosen location (?w=)', async () => {
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);
    await askToSwitch();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and clear cart' }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(new URL(String(assign.mock.calls[0]![0])).searchParams.get('w')).toBe('wh-s');
  });
});

// ── The chosen one, said to a screen reader (as on New order) ───────────────

describe('pickers say which one is chosen', () => {
  it('category pills, the Availability options and the sort options carry aria-pressed', async () => {
    await open();
    const all = screen.getByRole('button', { name: /^All/ });
    const art = screen.getByRole('button', { name: /^Art/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(art).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(art);
    expect(art).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: /Availability/ }));
    const inStock = screen.getByRole('button', { name: /In stock/ });
    expect(inStock).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(inStock);
    expect(inStock).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Name · A–Z/ }));
    const sortMenu = screen.getAllByRole('dialog').at(-1)!;
    expect(within(sortMenu).getByRole('button', { name: 'Name · A–Z' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(sortMenu).getByRole('button', { name: 'Most available' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('the Location and Deliver to pickers mark the chosen location and site', async () => {
    await open();
    fireEvent.click(screen.getByText('Location').closest('[role="button"]') as HTMLElement);
    const locations = screen.getByRole('dialog');
    expect(within(locations).getByRole('button', { name: /North DC/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(locations).getByRole('button', { name: /South DC/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Fulfillment type' })).getByRole('button', {
        name: /Delivery/,
      }),
    );
    fireEvent.click(screen.getByText('Deliver to'));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Harbor Academy/ }),
    );
    fireEvent.click(screen.getByText('Deliver to'));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Harbor Academy/ }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
