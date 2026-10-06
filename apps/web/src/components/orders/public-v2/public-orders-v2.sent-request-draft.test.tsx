import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ═══ A SENT REQUEST LEAVES NOTHING FOR THE NEXT PERSON ON THIS BROWSER ═══
//
// The public order link keeps its cart in this browser's localStorage under
// `order-draft:public:<warehouse>`, for anyone who opens the link here. After
// Send request the rail removed that draft and then emptied the basket with
// `clear`, which keeps the setup answers on purpose (it is the Clear all
// button). The cart's saver ran 250 ms later on that cart, which was not
// empty while it held notes or a delivery site, and wrote it back: the next
// person to open the link on that browser started with the last person's
// notes, Delivery and delivery site. A sent request now resets the cart, as
// Done does on the New order page, so nothing is written back.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/use-catalog-thumbnails', () => ({ useCatalogThumbnails: () => ({}) }));
vi.mock('next/image', () => ({ default: () => null }));

import { PublicOrdersV2 } from './public-orders-v2';
import type { PublicCatalogItem } from './types';

const WH = 'wh-1';
const KEY = `order-draft:public:${WH}`;
const NOTES = 'Room 12, for the spring concert';

const CABLE: PublicCatalogItem = {
  id: 'cable',
  displayName: 'HDMI Cable',
  publicDescription: null,
  itemType: null,
  categoryId: null,
  categoryLabel: null,
  imageUrl: null,
  lqip: null,
  availability: { kind: 'exact', count: 5 },
  maxQty: null,
};

function page() {
  return (
    <PublicOrdersV2
      token="tok-1"
      orgName="Demo Co"
      warehouses={[{ id: WH, name: 'Main DC' }]}
      initialWarehouseId={WH}
      items={[CABLE]}
      availabilityDisplay="exact"
      chartersForWarehouse={[{ id: 'site-1', name: 'Lincoln Elementary', code: null }]}
    />
  );
}

async function openLink() {
  await act(async () => {
    render(page());
  });
}

/** Wait out the cart's 250 ms save debounce. */
async function pastSaveDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

const saved = () => {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

const fulfillment = (mode: 'Pickup' | 'Delivery') =>
  within(screen.getByRole('radiogroup', { name: 'Fulfillment type' })).getByRole('button', {
    name: new RegExp(mode, 'i'),
  });

/** Everything a person fills in before Send request. */
async function composeRequest() {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'First Visitor' } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'first@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: /add to request/i }));
  fireEvent.click(fulfillment('Delivery'));
  fireEvent.click(screen.getByText('Deliver to'));
  fireEvent.click(within(screen.getByRole('dialog')).getByText('Lincoln Elementary'));
  fireEvent.click(screen.getByRole('button', { name: /notes/i }));
  fireEvent.change(screen.getByPlaceholderText(/Anything the team should know/), {
    target: { value: NOTES },
  });
  await pastSaveDebounce();
}

/** What the rail reads of the server's answer, read in microtasks only, so
 *  the act around Send request settles it before anything is checked. */
const answer = (ok: boolean, body: unknown) => ({ ok, json: async () => body }) as unknown as Response;

async function sendRequest() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));
  });
}

describe('the public order link after Send request', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(answer(true, { id: 'req-1', trackUrl: '/r/tok-1/track/req-1' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('keeps no draft once the request is sent, so the next visit on this browser starts blank', async () => {
    // A staff Orders draft for the same warehouse, on the same browser.
    const staffLegacy = JSON.stringify({ warehouseId: WH, lines: [{ itemId: 'x', quantity: 1 }] });
    const staffV2Key = `order-draft:v2:user-staff:${WH}`;
    localStorage.setItem(`order-draft:${WH}`, staffLegacy);
    localStorage.setItem(staffV2Key, staffLegacy);

    await openLink();
    await composeRequest();
    // While the request is being put together, the draft is saved as usual.
    expect(saved()).toMatchObject({
      lines: [{ itemId: 'cable', quantity: 1 }],
      fulfillmentType: 'delivery',
      charterId: 'site-1',
      notes: NOTES,
    });

    await sendRequest();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Check your inbox')).toBeInTheDocument();
    expect(saved()).toBeNull();

    // A full save debounce later, still nothing: the notes, Delivery and the
    // site are not written back.
    await pastSaveDebounce();
    expect(saved()).toBeNull();
    // The staff drafts are not this link's to touch.
    expect(localStorage.getItem(`order-draft:${WH}`)).toBe(staffLegacy);
    expect(localStorage.getItem(staffV2Key)).toBe(staffLegacy);

    // The next person opens the link on this browser.
    cleanup();
    await openLink();
    expect(fulfillment('Pickup').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Lincoln Elementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /notes/i }));
    expect(
      (screen.getByPlaceholderText(/Anything the team should know/) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(screen.getByRole('button', { name: /send request/i })).toBeDisabled();
  });

  it('keeps the draft when the request is refused, so it can be fixed and sent again', async () => {
    fetchMock.mockResolvedValue(answer(false, { message: 'This link is no longer active.' }));
    await openLink();
    await composeRequest();

    await sendRequest();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Check your inbox')).toBeNull();
    await pastSaveDebounce();
    expect(saved()).toMatchObject({
      lines: [{ itemId: 'cable', quantity: 1 }],
      charterId: 'site-1',
      notes: NOTES,
    });
  });
});
