import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'sonner';

import {
  NEEDED_BY_IN_PAST_COPY,
  neededByLabel,
  neededByZoneNote,
  ORDER_CHECK_AND_FINISH_COPY,
  ORDER_ADD_WHILE_LOCKED_COPY,
  ORDER_DONT_SEND_COPY,
  ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY,
  ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY,
  ORDER_REFUSED_RESEND_SUFFIX_COPY,
  ORDER_SEE_MY_ORDERS_COPY,
  ORDER_UNCONFIRMED_BODY_COPY,
  ORDER_UNCONFIRMED_TITLE_COPY,
  ORDER_WITHDRAWN_COPY,
  orderAlreadyPlacedCopy,
  wallClockToInstant,
} from '@stockpilot/core';

import { orderDraftPrefixFor } from '../v2/cart-context';
import type { CatalogItem } from '../v2/types';

// ═══ ONE KEY PER SUBMISSION, SETTLED NEVER GUESSED (phone ordering PO-2) ═══
//
// The New order page with the REAL review dialog and cart: the first press of
// Submit mints a key and writes the pending record BEFORE the action is
// called; a lost answer keeps the review open on the unconfirmed panel with
// the cart locked; Check and finish resends the same body under the same key;
// Don't send it unlocks only on the withdraw's answer; a reload restores the
// lock and reads the status (none never unlocks); a refusal is an inline
// alert that names the items from the cart; and on a shared browser the next
// person never sees, nor sends, the last person's pending order (judge X-1).

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({ usePerfUseful: () => {} }));

const createOrderRequestAction = vi.fn();
const getOrderSubmissionAction = vi.fn();
const withdrawOrderSubmissionAction = vi.fn();
vi.mock('@/server/actions/order-requests', () => ({
  createOrderRequestAction: (...args: unknown[]) => createOrderRequestAction(...args),
  getOrderSubmissionAction: (...args: unknown[]) => getOrderSubmissionAction(...args),
  withdrawOrderSubmissionAction: (...args: unknown[]) => withdrawOrderSubmissionAction(...args),
}));

vi.mock('./storefront-cards', async (importOriginal) => {
  const real = await importOriginal<typeof import('./storefront-cards')>();
  return {
    ...real,
    ProductCard: ({ item, onAdd }: { item: CatalogItem; onAdd: (id: string) => void }) => (
      <button type="button" onClick={() => onAdd(item.id)}>
        Add {item.name}
      </button>
    ),
    CompactRow: () => null,
    CategorySection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
    FreqCarousel: () => null,
    SfPhoto: () => null,
    CharterTag: () => null,
  };
});

import { OrdersStorefront, type StorefrontCatalogData } from './orders-storefront';

const ORG = '0a000000-0000-4000-8000-000000000001';
const WH = '0a000000-0000-4000-8000-0000000000a1';
const USER_A = '6d80b722-1e44-4059-aa99-efd69718cb14';
const USER_B = '31d0a995-2701-4481-aed0-ed26130b6e6e';
const CHROME = '0a000000-0000-4000-8000-0000000000e1';
const CABLE = '0a000000-0000-4000-8000-0000000000e3';
const ZONE = 'America/Los_Angeles';

function item(id: string, name: string): CatalogItem {
  return {
    id,
    sku: name.toUpperCase(),
    name,
    warehouseId: WH,
    quantityOnHand: 20,
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
const ITEMS = [item(CHROME, 'Chromebook'), item(CABLE, 'HDMI Cable')];

function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status: string; value: T };
  p.status = 'fulfilled';
  p.value = value;
  return p;
}

function page(userId: string) {
  return (
    <OrdersStorefront
      warehouses={[{ id: WH, name: 'QA Main DC' }]}
      warehouseId={WH}
      catalogPromise={settled<StorefrontCatalogData>({ items: ITEMS, aisles: [] })}
      frequentlyOrderedPromise={settled([])}
      kitsPromise={settled({ status: 'ok' as const, kits: [] })}
      kitsEnabled={false}
      chartersForWarehouse={[]}
      canActOnBehalf
      viewerName="QA Manager"
      viewerEmail="manager@example.test"
      orgTimezone={ZONE}
      deliveryRecipients={null}
      viewerUserId={userId}
      organizationId={ORG}
      canApproveOrders
    />
  );
}

async function openPage(userId = USER_A) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(page(userId));
  });
  return view;
}

const pendingKey = (userId = USER_A) => `order-pending:v1:${userId}:${ORG}:${WH}`;
const pendingRecord = (userId = USER_A) => {
  const raw = localStorage.getItem(pendingKey(userId));
  return raw
    ? (JSON.parse(raw) as { key: string; sends: number; body: Record<string, unknown> })
    : null;
};
const draft = (userId = USER_A) => localStorage.getItem(`${orderDraftPrefixFor(userId)}${WH}`);

const ORDER = {
  id: 'ffffffff-0000-4000-8000-000000000007',
  orderNumber: 7,
  orderLabel: 'SO-000007',
  status: 'pending_approval',
  warehouseId: WH,
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 1,
  createdAt: '2026-10-04T10:00:00+00:00',
  requestedFor: { self: true },
};
const placedAnswer = (replay = false) => ({
  ok: true,
  data: { organizationId: ORG, result: { replay, order: ORDER } },
});

function review() {
  fireEvent.click(screen.getByRole('button', { name: /review order/i }));
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: /submit order request/i }));
}
const dialog = () => screen.getByRole('dialog', { name: 'Review order request' });

/** An action that never answers until released (a slow network). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  push.mockReset();
  createOrderRequestAction.mockReset();
  getOrderSubmissionAction.mockReset();
  withdrawOrderSubmissionAction.mockReset();
});
afterEach(() => localStorage.clear());

describe('the first send', () => {
  it('mints a key, writes the record BEFORE calling the action, and sends the wall-clock needed-by as the placer', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    fireEvent.change(screen.getByLabelText(/Needed by/), { target: { value: '2026-12-01T09:30' } });
    let recordAtCall: ReturnType<typeof pendingRecord> = null;
    createOrderRequestAction.mockImplementation(async () => {
      recordAtCall = pendingRecord();
      return placedAnswer();
    });
    review();
    // The review shows the needed-by in the organization's zone.
    const at = wallClockToInstant('2026-12-01T09:30', ZONE)!;
    expect(within(dialog()).getByText(neededByLabel(at, ZONE))).toBeInTheDocument();
    expect(within(dialog()).getByText(neededByZoneNote(ZONE))).toBeInTheDocument();
    await act(async () => submit());

    expect(createOrderRequestAction).toHaveBeenCalledTimes(1);
    const body = createOrderRequestAction.mock.calls[0]![0] as Record<string, unknown>;
    // The page names its organization (review round 1).
    expect(createOrderRequestAction.mock.calls[0]![1]).toEqual({ organizationId: ORG });
    expect(body).toMatchObject({
      placerUserId: USER_A,
      warehouseId: WH,
      fulfillmentType: 'pickup',
      deliveryCharterId: null,
      onBehalfOf: null,
      neededByLocal: '2026-12-01T09:30',
      lines: [{ itemId: CHROME, quantity: 1 }],
    });
    expect(String(body.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordAtCall).toMatchObject({
      key: body.idempotencyKey,
      sends: 1,
      state: 'possibly_sent',
    });
    // Placed: the record and the draft are gone, the success screen shows.
    expect(await screen.findByText('Order request submitted')).toBeInTheDocument();
    expect(pendingRecord()).toBeNull();
    expect(draft()).toBeNull();
  });

  it('a second tap while the first is out sends nothing more (the ref guard)', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    const out = deferred<unknown>();
    createOrderRequestAction.mockReturnValue(out.promise);
    review();
    act(() => {
      submit();
      submit();
    });
    expect(createOrderRequestAction).toHaveBeenCalledTimes(1);
    // While it is out the dialog cannot be closed, and the first send keeps
    // its own Submit button, waiting: nothing says "not confirmed" yet.
    expect(within(dialog()).getByRole('button', { name: 'Close review' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: /submit order request/i })).toBeDisabled();
    expect(within(dialog()).queryByText(ORDER_UNCONFIRMED_TITLE_COPY)).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY })).toBeNull();
    await act(async () => out.resolve(placedAnswer()));
  });
});

describe('a lost answer', () => {
  async function lose() {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    createOrderRequestAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    review();
    await act(async () => submit());
  }

  it('keeps the review open on the unconfirmed panel, with the cart locked and the record kept', async () => {
    await lose();
    const d = dialog();
    expect(within(d).getByText(ORDER_UNCONFIRMED_TITLE_COPY)).toBeInTheDocument();
    expect(within(d).getByText(ORDER_UNCONFIRMED_BODY_COPY)).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY })).toBeEnabled();
    expect(within(d).getByRole('button', { name: ORDER_DONT_SEND_COPY })).toBeEnabled();
    expect(within(d).getByRole('link', { name: ORDER_SEE_MY_ORDERS_COPY })).toHaveAttribute(
      'href',
      '/dashboard/orders',
    );
    expect(within(d).getByRole('button', { name: 'Close review' })).toBeDisabled();
    // The cart is locked: its controls wait.
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeDisabled();
    expect(screen.getByLabelText(/Needed by/)).toBeDisabled();
    expect(pendingRecord()).toMatchObject({ sends: 1 });
  });

  it('Check and finish sends the SAME body under the SAME key, counted before it leaves, and places once', async () => {
    await lose();
    const first = createOrderRequestAction.mock.calls[0]![0];
    let sendsAtCall = 0;
    createOrderRequestAction.mockImplementationOnce(async () => {
      sendsAtCall = pendingRecord()?.sends ?? 0;
      return placedAnswer(true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY }));
    });
    expect(createOrderRequestAction).toHaveBeenCalledTimes(2);
    expect(createOrderRequestAction.mock.calls[1]![0]).toEqual(first);
    expect(sendsAtCall).toBe(2);
    expect(await screen.findByText('This order request was already placed.')).toBeInTheDocument();
    expect(pendingRecord()).toBeNull();
  });

  it('while Check and finish is out the panel stays, every button waiting', async () => {
    await lose();
    const out = deferred<unknown>();
    createOrderRequestAction.mockReturnValueOnce(out.promise);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY }));
    });
    const d = dialog();
    expect(within(d).getByText(ORDER_UNCONFIRMED_TITLE_COPY)).toBeInTheDocument();
    expect(within(d).getByText(ORDER_UNCONFIRMED_BODY_COPY)).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY })).toBeDisabled();
    expect(within(d).getByRole('button', { name: ORDER_DONT_SEND_COPY })).toBeDisabled();
    expect(within(d).getByRole('button', { name: 'Close review' })).toBeDisabled();
    await act(async () => out.resolve(placedAnswer(true)));
    expect(createOrderRequestAction).toHaveBeenCalledTimes(2);
  });

  it('a reload restores the lock at once and reads the status; none never unlocks', async () => {
    await lose();
    const key = pendingRecord()!.key;
    getOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: ORG, outcome: 'none' },
    });
    cleanup();
    await openPage();
    await waitFor(() =>
      expect(getOrderSubmissionAction).toHaveBeenCalledWith({
        warehouseId: WH,
        key,
        organizationId: ORG,
        placerUserId: USER_A,
      }),
    );
    expect(within(dialog()).getByText(ORDER_UNCONFIRMED_TITLE_COPY)).toBeInTheDocument();
    // The locked cart shows exactly what was sent.
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeDisabled();
    expect(pendingRecord()?.key).toBe(key);
    expect(createOrderRequestAction).toHaveBeenCalledTimes(1);
  });

  it('a reload whose status read reports placed shows the order', async () => {
    await lose();
    getOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: ORG, outcome: 'placed', order: ORDER },
    });
    cleanup();
    await openPage();
    expect(await screen.findByText('Order request submitted')).toBeInTheDocument();
    expect(pendingRecord()).toBeNull();
  });

  it("Don't send it unlocks only on the withdraw's answer", async () => {
    await lose();
    const key = pendingRecord()!.key;
    const out = deferred<unknown>();
    withdrawOrderSubmissionAction.mockReturnValueOnce(out.promise);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_DONT_SEND_COPY }));
    });
    expect(withdrawOrderSubmissionAction).toHaveBeenCalledWith({
      warehouseId: WH,
      key,
      organizationId: ORG,
      placerUserId: USER_A,
    });
    // Out: still locked, every button waits.
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: ORDER_DONT_SEND_COPY })).toBeDisabled();
    await act(async () =>
      out.resolve({ ok: true, data: { organizationId: ORG, outcome: 'withdrawn' } }),
    );
    expect(within(dialog()).getByText(ORDER_WITHDRAWN_COPY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeEnabled();
    expect(pendingRecord()).toBeNull();
    // A new submit is a new key.
    createOrderRequestAction.mockResolvedValueOnce(placedAnswer());
    await act(async () => submit());
    expect(
      (createOrderRequestAction.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey,
    ).not.toBe(key);
  });

  it("Don't send it that finds the order placed shows it", async () => {
    await lose();
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: ORG, outcome: 'placed', order: ORDER },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_DONT_SEND_COPY }));
    });
    expect(
      await screen.findByText(orderAlreadyPlacedCopy({ orderNumber: 7, orderLabel: 'SO-000007' })),
    ).toBeInTheDocument();
  });

  it('a resend refused before the key (not recorded) stays locked and says the earlier send is unchecked', async () => {
    await lose();
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'x', details: { reason: 'permission' } },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY }));
    });
    expect(
      within(dialog()).getByText(
        new RegExp(ORDER_REFUSED_RESEND_SUFFIX_COPY.replace(/[.?]/g, '\\$&')),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeDisabled();
    expect(pendingRecord()).toMatchObject({ sends: 2 });
  });
});

describe('a refusal', () => {
  it('a recorded refusal is final: an inline alert naming the item from the cart, the line marked, the cart unlocked', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    fireEvent.click(screen.getByText('Add HDMI Cable'));
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'x',
        details: {
          reason: 'item_not_orderable',
          settled: true,
          replay: false,
          items: { [CABLE]: 'archived' },
        },
      },
    });
    review();
    await act(async () => submit());
    const alert = within(dialog()).getByRole('alert');
    expect(alert.textContent).toContain(
      "Some items can't be ordered from here anymore: HDMI Cable. Remove them to continue.",
    );
    expect(screen.getByText('This item was archived.')).toBeInTheDocument();
    expect(pendingRecord()).toBeNull();
    // Submit waits until the item is removed.
    await act(async () => submit());
    expect(within(dialog()).getByRole('alert').textContent).toContain(
      "Remove the items that can't be ordered.",
    );
    expect(createOrderRequestAction).toHaveBeenCalledTimes(1);
  });

  it('a refusal of the only send (not recorded) is final too: nothing was placed', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'x', details: { reason: 'permission' } },
    });
    review();
    await act(async () => submit());
    expect(within(dialog()).getByRole('alert').textContent).toContain(
      "Your account can't place orders. Ask an admin.",
    );
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeEnabled();
    expect(pendingRecord()).toBeNull();
  });
});

describe('a shared browser (judge X-1)', () => {
  it('the next person never sees, reads or sends the last person pending order or cart', async () => {
    // Person A loses an answer and closes the tab.
    await openPage(USER_A);
    fireEvent.click(screen.getByText('Add Chromebook'));
    createOrderRequestAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    review();
    await act(async () => submit());
    expect(pendingRecord(USER_A)).not.toBeNull();
    cleanup();
    createOrderRequestAction.mockClear();

    // Person B signs in on the same browser and opens the same warehouse.
    await openPage(USER_B);
    expect(screen.queryByText(ORDER_UNCONFIRMED_TITLE_COPY)).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove .* from cart/ })).toBeNull();
    expect(getOrderSubmissionAction).not.toHaveBeenCalled();
    expect(createOrderRequestAction).not.toHaveBeenCalled();
    // A's record is untouched (A can still settle it).
    expect(pendingRecord(USER_A)).not.toBeNull();
  });

  it("a record under this account's key whose body names another placer is dropped, never shown", async () => {
    localStorage.setItem(
      pendingKey(USER_B),
      JSON.stringify({
        key: 'eeeeeeee-0000-4000-8000-000000000001',
        state: 'possibly_sent',
        sends: 1,
        firstSentAt: '2026-10-04T10:00:00Z',
        body: { idempotencyKey: 'eeeeeeee-0000-4000-8000-000000000001', placerUserId: USER_A },
      }),
    );
    await openPage(USER_B);
    expect(screen.queryByText(ORDER_UNCONFIRMED_TITLE_COPY)).toBeNull();
    expect(getOrderSubmissionAction).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey(USER_B))).toBeNull();
  });
});

describe('review round 1', () => {
  async function lose() {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    createOrderRequestAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    review();
    await act(async () => submit());
  }

  it('a resend answered with a refusal recorded in ANOTHER organization keeps the cart locked and the record, and says to switch back', async () => {
    await lose();
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'not_found',
        message: 'x',
        details: {
          reason: 'warehouse_not_available',
          settled: true,
          replay: false,
          organizationId: '0a000000-0000-4000-8000-000000000099',
        },
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_CHECK_AND_FINISH_COPY }));
    });
    expect(within(dialog()).getByText(ORDER_ORGANIZATION_CHANGED_UNCONFIRMED_COPY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeDisabled();
    expect(pendingRecord()).toMatchObject({ sends: 2 });
  });

  it("Don't send it from a tab another account now answers for stays locked, keeps the record and says whose it is", async () => {
    await lose();
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'x', details: { reason: 'placer_mismatch', organizationId: ORG } },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_DONT_SEND_COPY }));
    });
    expect(within(dialog()).getByText(ORDER_PLACER_MISMATCH_UNCONFIRMED_COPY)).toBeInTheDocument();
    expect(within(dialog()).queryByText(ORDER_WITHDRAWN_COPY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Chromebook from cart' })).toBeDisabled();
    expect(pendingRecord()).not.toBeNull();
  });

  it('closing the review after a refusal clears the alert on reopen; the refused item stays marked and blocked', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    fireEvent.click(screen.getByText('Add HDMI Cable'));
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'x',
        details: { reason: 'item_not_orderable', settled: true, replay: false, items: { [CABLE]: 'archived' } },
      },
    });
    review();
    await act(async () => submit());
    expect(within(dialog()).getByRole('alert')).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close review' }));
    review();
    expect(within(dialog()).queryByRole('alert')).toBeNull();
    // The cart still marks the item, and Submit still waits for it.
    expect(screen.getByText('This item was archived.')).toBeInTheDocument();
    await act(async () => submit());
    expect(within(dialog()).getByRole('alert').textContent).toContain("Remove the items that can't be ordered.");
    expect(createOrderRequestAction).toHaveBeenCalledTimes(1);
  });

  it('a corrected needed-by: the old refusal is gone when the review reopens', async () => {
    await openPage();
    fireEvent.click(screen.getByText('Add Chromebook'));
    createOrderRequestAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_error', message: 'x', details: { reason: 'needed_by_past', settled: true, replay: false } },
    });
    review();
    await act(async () => submit());
    expect(within(dialog()).getByRole('alert').textContent).toContain(NEEDED_BY_IN_PAST_COPY);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close review' }));
    review();
    expect(within(dialog()).queryByText(NEEDED_BY_IN_PAST_COPY)).toBeNull();
  });

  it("closing after Don't send it clears the notice on reopen", async () => {
    await lose();
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: ORG, outcome: 'withdrawn' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_DONT_SEND_COPY }));
    });
    expect(within(dialog()).getByText(ORDER_WITHDRAWN_COPY)).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close review' }));
    review();
    expect(within(dialog()).queryByText(ORDER_WITHDRAWN_COPY)).toBeNull();
  });

  it('with no pending send the Start an order selection is added at once, once', async () => {
    sessionStorage.setItem('sp:order-prefill:v1', JSON.stringify({ warehouseId: WH, itemIds: [CABLE] }));
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    await openPage();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added 1 item to your cart.'));
    expect(screen.getByRole('button', { name: 'Remove HDMI Cable from cart' })).toBeEnabled();
    expect(sessionStorage.getItem('sp:order-prefill:v1')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('the Start an order selection waits while a restored send has the cart locked: refused in core words, kept, then added once the key settles', async () => {
    const key = 'eeeeeeee-0000-4000-8000-000000000042';
    localStorage.setItem(
      pendingKey(),
      JSON.stringify({
        key,
        state: 'possibly_sent',
        sends: 1,
        firstSentAt: '2026-10-04T10:00:00Z',
        body: {
          idempotencyKey: key,
          placerUserId: USER_A,
          warehouseId: WH,
          fulfillmentType: 'pickup',
          deliveryCharterId: null,
          onBehalfOf: null,
          notes: null,
          neededByLocal: null,
          lines: [{ itemId: CHROME, quantity: 1 }],
        },
      }),
    );
    sessionStorage.setItem('sp:order-prefill:v1', JSON.stringify({ warehouseId: WH, itemIds: [CABLE] }));
    getOrderSubmissionAction.mockResolvedValueOnce({ ok: true, data: { organizationId: ORG, outcome: 'none' } });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    await openPage();
    await waitFor(() => expect(getOrderSubmissionAction).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(ORDER_ADD_WHILE_LOCKED_COPY);
    expect(toast.success).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('sp:order-prefill:v1')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove HDMI Cable from cart' })).toBeNull();
    // Don't send it settles the key: the selection is added now, once.
    withdrawOrderSubmissionAction.mockResolvedValueOnce({
      ok: true,
      data: { organizationId: ORG, outcome: 'withdrawn' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ORDER_DONT_SEND_COPY }));
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added 1 item to your cart.'));
    expect(screen.getByRole('button', { name: 'Remove HDMI Cable from cart' })).toBeEnabled();
    expect(sessionStorage.getItem('sp:order-prefill:v1')).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    sessionStorage.clear();
  });
});
