import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHORTFALL_NO_SUPPLIER_COPY,
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_CONFLICT_COPY,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_NOTHING_LEFT_COPY,
  SHORTFALL_PO_NOT_SENT_COPY,
  SHORTFALL_SUPPLIER_UNKNOWN_COPY,
  shortfallPoView,
  type ShortfallPoResult,
  type ShortfallPoView,
} from '@stockpilot/core';

import type { ShortfallPoLoad, ShortfallPoOffer } from '@/lib/orders/shortfall-po';
import { orderReadinessFacts, readinessOk, visibleItemFacts } from '@/test/order-readiness-facts';

/**
 * F2-5: the web dialog that drafts POs for what an order is short. The two
 * server actions are recording stubs (the draft's mapping is pinned in
 * route.test.ts and order-readiness.shortfall-po.test.ts, the load's in
 * order-readiness.load-shortfall.test.ts). What this file pins is what the
 * dialog SHOWS (core's rows and words, the supplier names read on open), what
 * it SENDS (the chosen lines, and a key that belongs to one request: kept for
 * its retries, replaced on any edit, one call for a double press), and that a
 * refusal because the numbers moved KEEPS the person's choice and shows the new
 * most instead of lowering anything.
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/orders/x',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode } & Record<string, unknown>) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
const draftAction = vi.hoisted(() => vi.fn());
const loadAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/order-readiness', () => ({
  draftShortfallPosAction: (input: unknown) => draftAction(input),
  loadShortfallPoAction: (input: unknown) => loadAction(input),
}));

import { DraftShortfallPoButton } from './draft-shortfall-po-button';
import { DraftShortfallPoDialog } from './draft-shortfall-po-dialog';

const ORDER = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const C = 'cccccccc-0000-4000-8000-00000000000c';
const D = 'dddddddd-0000-4000-8000-00000000000d';
const K = 'eeeeeeee-0000-4000-8000-00000000000e';
const SUP1 = '00000000-0000-4000-8000-0000000000f1';
const SUP2 = '00000000-0000-4000-8000-0000000000f2';

type Json = Record<string, unknown>;

/** A: 10 owed, 2 on the shelf (8 to draft, supplier 1). B: 10 owed, a draft
 *  of 4 already (6 to draft, supplier 2). C: 5 owed, no supplier. D: 6 owed,
 *  an ordered PO for 6 (covered). K: a kit, short. */
function shortfallView(over: { a?: Json; b?: Json; c?: Json; d?: Json } = {}): ShortfallPoView {
  const facts = orderReadinessFacts(
    ORDER,
    'approved',
    [
      { lineId: 'L1', itemId: A, requested: 10 },
      { lineId: 'L2', itemId: B, requested: 10 },
      { lineId: 'L3', itemId: C, requested: 5 },
      { lineId: 'L4', itemId: D, requested: 6 },
      { lineId: 'L5', itemId: K, requested: 2 },
    ],
    [
      visibleItemFacts(A, { name: 'Pencils', sku: 'PEN-1', supplierId: SUP1, here: { rack: 2 }, ...over.a }),
      visibleItemFacts(B, {
        name: 'Notebooks',
        sku: 'NB-1',
        supplierId: SUP2,
        drafts: {
          rows: [{ poId: 'dpo-1', poNumber: 'PO-2026-0043', remaining: 4 }],
          hiddenRemaining: 0,
          truncated: false,
          truncatedRemaining: 0,
        },
        ...over.b,
      }),
      visibleItemFacts(C, { name: 'Erasers', sku: null, supplierId: null, ...over.c }),
      visibleItemFacts(D, {
        name: 'Rulers',
        sku: 'RUL-1',
        supplierId: SUP1,
        inbound: {
          rows: [{ poId: 'po-21', poNumber: 'PO-2026-0021', status: 'ordered', expectedAt: null, remaining: 6 }],
          hiddenRemaining: 0,
          truncated: false,
          truncatedRemaining: 0,
        },
        ...over.d,
      }),
      visibleItemFacts(K, { name: 'Starter kit', sku: 'KIT-1', supplierId: SUP1, isBundle: true }),
    ],
  );
  const r = readinessOk(facts);
  if (r.state !== 'ok') throw new Error('fixture');
  return shortfallPoView(r.assessment);
}

const NAMES = { [SUP1]: 'Acme Supply', [SUP2]: 'Paper Co' };

function offer(v: ShortfallPoView = shortfallView()): ShortfallPoOffer {
  return { orderId: ORDER, view: v, timeZone: 'America/Los_Angeles' };
}

function result(over: Partial<ShortfallPoResult> = {}): ShortfallPoResult {
  return {
    orderId: ORDER,
    orderNumber: 42,
    replay: false,
    created: [
      {
        purchaseOrderId: 'p0000000-0000-4000-8000-000000000001',
        poNumber: 'PO-2026-0050',
        supplierId: SUP1,
        lineCount: 1,
        units: 8,
        lines: [{ itemId: A, quantity: 8 }],
      },
      {
        purchaseOrderId: 'p0000000-0000-4000-8000-000000000002',
        poNumber: 'PO-2026-0051',
        supplierId: SUP2,
        lineCount: 1,
        units: 6,
        lines: [{ itemId: B, quantity: 6 }],
      },
      {
        purchaseOrderId: 'p0000000-0000-4000-8000-000000000003',
        poNumber: 'PO-2026-0052',
        supplierId: null,
        lineCount: 1,
        units: 5,
        lines: [{ itemId: C, quantity: 5 }],
      },
    ],
    ...over,
  };
}

/** A promise the test settles by hand. */
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
  routerRefresh.mockReset();
  draftAction.mockReset();
  loadAction.mockReset();
  for (const f of Object.values(toastMock)) f.mockReset();
  loadAction.mockResolvedValue({ view: null, supplierNames: NAMES } satisfies ShortfallPoLoad);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function openDialog(o: ShortfallPoOffer = offer()) {
  const utils = render(
    <>
      <DraftShortfallPoDialog offer={o} />
      <DraftShortfallPoButton orderId={o.orderId} />
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Draft PO for what is short' }));
  const dialog = screen.getByRole('dialog', { name: 'Draft a PO for what is short' });
  // The supplier names read on open.
  await waitFor(() => expect(loadAction).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(within(dialog).getAllByText('Acme Supply').length).toBeGreaterThan(0));
  return { ...utils, dialog };
}

const row = (itemId: string) =>
  screen.getAllByTestId('draft-shortfall-po-row').find((r) => r.getAttribute('data-item-id') === itemId)!;
const checkbox = (itemId: string) => within(row(itemId)).getByTestId('draft-shortfall-po-check') as HTMLInputElement;
const qty = (itemId: string) => within(row(itemId)).getByTestId('draft-shortfall-po-qty') as HTMLInputElement;
const submit = () => fireEvent.click(screen.getByTestId('draft-shortfall-po-submit'));
const sentLines = (call = -1) =>
  (draftAction.mock.calls.at(call)![0] as { lines: Array<{ itemId: string; quantity: number }> }).lines;
const sentKey = (call = -1) => (draftAction.mock.calls.at(call)![0] as { idempotencyKey: string }).idempotencyKey;

describe('DraftShortfallPoButton and the page-mounted dialog', () => {
  it('the button opens the dialog the page mounted once, and sends nothing by itself', async () => {
    const { dialog } = await openDialog();
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId('readiness-draft-shortfall-po')).toHaveAttribute('aria-haspopup', 'dialog');
    expect(loadAction).toHaveBeenCalledWith({ orderId: ORDER });
    expect(draftAction).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('with nothing offered and closed it renders nothing, and the button opens nothing', () => {
    render(
      <>
        <DraftShortfallPoDialog offer={null} />
        <DraftShortfallPoButton orderId={ORDER} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draft PO for what is short' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loadAction).not.toHaveBeenCalled();
  });

  it('an open dialog stays when the page stops offering (the refresh after drafting), with its answer', async () => {
    draftAction.mockResolvedValue({ ok: true, data: result() });
    const o = offer();
    const { rerender } = await openDialog(o);
    submit();
    await screen.findByTestId('draft-shortfall-po-result');
    rerender(
      <>
        <DraftShortfallPoDialog offer={null} />
        <DraftShortfallPoButton orderId={ORDER} />
      </>,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('draft-shortfall-po-created-row')).toHaveLength(3);
    fireEvent.click(screen.getByTestId('draft-shortfall-po-close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('DraftShortfallPoDialog: the rows, in core words', () => {
  it('each short item: ticked at its most when it may be drafted, with its supplier; covered and kit items say why and cannot be chosen', async () => {
    const { dialog } = await openDialog();
    const rows = within(dialog).getAllByTestId('draft-shortfall-po-row');
    // In the order of the item's first line.
    expect(rows.map((r) => r.getAttribute('data-item-id'))).toEqual([A, B, C, D, K]);
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['draftable', 'draftable', 'draftable', 'covered', 'kit']);

    expect(within(row(A)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(/^Short 8$/);
    expect(within(row(B)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(
      'Short 10 · already on order or draft 4',
    );
    expect([A, B, C].map((id) => [checkbox(id).checked, qty(id).value])).toEqual([
      [true, '8'],
      [true, '6'],
      [true, '5'],
    ]);
    // Supplier names from the read on open; the item with none says so.
    expect(within(row(A)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent('Acme Supply');
    expect(within(row(B)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent('Paper Co');
    expect(within(row(C)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent(SHORTFALL_NO_SUPPLIER_COPY);

    // Covered: unticked, cannot be chosen, and names what covers it.
    expect(checkbox(D).checked).toBe(false);
    expect(checkbox(D)).toBeDisabled();
    expect(within(row(D)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(
      'Already on PO-2026-0021 (6 still to arrive)',
    );
    expect(within(row(D)).queryByTestId('draft-shortfall-po-qty')).toBeNull();
    // A kit is never bought as a kit.
    expect(checkbox(K)).toBeDisabled();
    expect(within(row(K)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(
      'Kits are built from their components, so order the components instead.',
    );

    // The checkbox is named by the item and described by its numbers and supplier.
    expect(screen.getByRole('checkbox', { name: 'Pencils (PEN-1)' })).toHaveAccessibleDescription(
      'Short 8 Acme Supply',
    );
    expect(screen.getByRole('textbox', { name: 'Quantity Pencils (PEN-1)' })).toBe(qty(A));
    expect(within(dialog).getByTestId('draft-shortfall-po-checked-at')).toHaveTextContent(
      'Checked at 10:42 AM. Stock can change after this.',
    );
  });

  it('the footer counts the drafts the choice makes, one per supplier and one for the items with none, and says none is sent', async () => {
    await openDialog();
    const footer = () => screen.getByTestId('draft-shortfall-po-footer');
    expect(footer()).toHaveTextContent(
      `Creates 3 draft POs, one per supplier and one for the items with no supplier. ${SHORTFALL_PO_NOT_SENT_COPY}`,
    );
    fireEvent.click(checkbox(C));
    expect(footer()).toHaveTextContent(`Creates 2 draft POs, one per supplier. ${SHORTFALL_PO_NOT_SENT_COPY}`);
    fireEvent.click(checkbox(B));
    expect(footer()).toHaveTextContent(
      'Creates 1 draft PO. Drafts are not sent. Set its destination and order it on Purchase orders.',
    );
    fireEvent.click(checkbox(A));
    expect(footer()).toHaveTextContent('Choose at least one item to draft.');
    expect(screen.getByTestId('draft-shortfall-po-submit')).toBeDisabled();
    // Unticked, a quantity field keeps what it holds but cannot be edited.
    expect(qty(A)).toBeDisabled();
    expect(qty(A).value).toBe('8');
  });

  it('a supplier whose name could not be read says so; while it is read, nothing is claimed', async () => {
    const pending = deferred<ShortfallPoLoad>();
    loadAction.mockReturnValue(pending.promise);
    render(<DraftShortfallPoDialog offer={offer()} />);
    render(<DraftShortfallPoButton orderId={ORDER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draft PO for what is short' }));
    expect(within(row(A)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent('');
    expect(screen.getByTestId('draft-shortfall-po-rows')).toHaveAttribute('aria-busy', 'true');
    await act(async () => pending.resolve({ view: null, supplierNames: null }));
    expect(within(row(A)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent(SHORTFALL_SUPPLIER_UNKNOWN_COPY);
    expect(within(row(C)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent(SHORTFALL_NO_SUPPLIER_COPY);
    expect(screen.getByTestId('draft-shortfall-po-rows')).not.toHaveAttribute('aria-busy');
  });

  it('readiness read again on open replaces the rows and says so when what may be drafted changed', async () => {
    // Someone drafted 5 of A's 8 in between.
    const fresh = shortfallView({
      a: {
        drafts: {
          rows: [{ poId: 'dpo-9', poNumber: 'PO-2026-0049', remaining: 5 }],
          hiddenRemaining: 0,
          truncated: false,
          truncatedRemaining: 0,
        },
      },
    });
    loadAction.mockResolvedValue({ view: fresh, supplierNames: NAMES });
    await openDialog();
    await waitFor(() => expect(qty(A).value).toBe('3'));
    expect(within(row(A)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(
      'Short 8 · already on order or draft 5',
    );
    expect(screen.getByTestId('draft-shortfall-po-notice')).toHaveTextContent(SHORTFALL_PO_CHANGED_COPY);
  });

  it('what the person already changed is kept when the fresh read lands', async () => {
    const pending = deferred<ShortfallPoLoad>();
    loadAction.mockReturnValue(pending.promise);
    render(
      <>
        <DraftShortfallPoDialog offer={offer()} />
        <DraftShortfallPoButton orderId={ORDER} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draft PO for what is short' }));
    fireEvent.change(qty(A), { target: { value: '4' } });
    fireEvent.click(checkbox(C));
    await act(async () => pending.resolve({ view: shortfallView(), supplierNames: NAMES }));
    expect(qty(A).value).toBe('4');
    expect(checkbox(C).checked).toBe(false);
    expect(checkbox(B).checked).toBe(true);
  });
});

describe('DraftShortfallPoDialog: what it sends', () => {
  it('the chosen lines at the chosen quantities, in row order, with a key; then core\'s sentence and a link to each draft', async () => {
    draftAction.mockResolvedValue({ ok: true, data: result() });
    await openDialog();
    fireEvent.change(qty(B), { target: { value: '2.5' } });
    submit();
    await screen.findByTestId('draft-shortfall-po-result');

    expect(draftAction).toHaveBeenCalledTimes(1);
    expect(draftAction.mock.calls[0]![0]).toEqual({
      orderId: ORDER,
      lines: [
        { itemId: A, quantity: 8 },
        { itemId: B, quantity: 2.5 },
        { itemId: C, quantity: 5 },
      ],
      idempotencyKey: expect.any(String),
    });
    expect(sentKey().length).toBeGreaterThan(0);
    expect(sentKey().length).toBeLessThanOrEqual(200);

    // From the ANSWER, never from what was asked for.
    expect(screen.getByTestId('draft-shortfall-po-result')).toHaveTextContent(
      'Created 3 draft POs: PO-2026-0050, PO-2026-0051, PO-2026-0052. Drafts are not sent: set their destinations and order them on Purchase orders.',
    );
    const links = within(screen.getByTestId('draft-shortfall-po-created')).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['PO-2026-0050 · 1 line, 8 units', '/dashboard/purchase-orders/p0000000-0000-4000-8000-000000000001'],
      ['PO-2026-0051 · 1 line, 6 units', '/dashboard/purchase-orders/p0000000-0000-4000-8000-000000000002'],
      ['PO-2026-0052 · 1 line, 5 units', '/dashboard/purchase-orders/p0000000-0000-4000-8000-000000000003'],
    ]);
    const created = screen.getAllByTestId('draft-shortfall-po-created-row');
    expect(created[0]).toHaveTextContent('Acme Supply');
    expect(created[2]).toHaveTextContent(SHORTFALL_NO_SUPPLIER_COPY);
    // The page behind is read again (its strip now counts the drafts).
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
    // Nothing claims anything was sent to a supplier.
    expect(screen.getByRole('dialog').textContent).not.toMatch(/\bsent to\b|emailed|notified/i);
  });

  it('a double press sends ONE request', async () => {
    const pending = deferred<unknown>();
    draftAction.mockReturnValue(pending.promise);
    await openDialog();
    const button = screen.getByTestId('draft-shortfall-po-submit');
    // Two presses in the same tick, before React re-renders the button
    // disabled (a key held down, a fast double click).
    act(() => {
      button.click();
      button.click();
    });
    expect(draftAction).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    expect(draftAction).toHaveBeenCalledTimes(1);
    // Nothing can be changed, and the dialog cannot be dismissed, while it is on its way.
    expect(button).toBeDisabled();
    expect(checkbox(A)).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => pending.resolve({ ok: true, data: result() }));
    expect(draftAction).toHaveBeenCalledTimes(1);
  });

  it('pressing Draft again for the SAME request reuses its key (a lost answer, busy); any edit gets a new one', async () => {
    draftAction.mockRejectedValueOnce(new Error('network'));
    await openDialog();
    submit();
    // A lost answer: whether the drafts exist is unknown, said inline.
    expect(await screen.findByTestId('draft-shortfall-po-error')).toHaveTextContent(SHORTFALL_PO_FAILED_COPY);
    expect(screen.getByTestId('draft-shortfall-po-error')).toHaveAttribute('role', 'alert');
    const first = sentKey(0);

    draftAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: SHORTFALL_PO_BUSY_COPY, details: { reason: 'busy', retryable: true } },
    });
    submit();
    await waitFor(() => expect(draftAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(SHORTFALL_PO_BUSY_COPY)).toBeInTheDocument();
    expect(sentKey(1)).toBe(first);

    // An edit is another request: a new key.
    fireEvent.change(qty(A), { target: { value: '7' } });
    draftAction.mockResolvedValueOnce({ ok: true, data: result() });
    submit();
    await waitFor(() => expect(draftAction).toHaveBeenCalledTimes(3));
    expect(sentKey(2)).not.toBe(first);
    expect(sentLines(2)[0]).toEqual({ itemId: A, quantity: 7 });
  });

  it('an edit changed back to the same request still gets a new key (discarded on edit)', async () => {
    draftAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: SHORTFALL_PO_BUSY_COPY, details: { reason: 'busy', retryable: true } },
    });
    await openDialog();
    submit();
    await screen.findByText(SHORTFALL_PO_BUSY_COPY);
    fireEvent.click(checkbox(C));
    fireEvent.click(checkbox(C));
    draftAction.mockResolvedValueOnce({ ok: true, data: result() });
    submit();
    await waitFor(() => expect(draftAction).toHaveBeenCalledTimes(2));
    expect(sentLines(1)).toEqual(sentLines(0));
    expect(sentKey(1)).not.toBe(sentKey(0));
  });

  it('a key used for another request (idempotency_conflict) is dropped: the next press mints a new one', async () => {
    draftAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: SHORTFALL_PO_CONFLICT_COPY, details: { reason: 'idempotency_conflict' } },
    });
    await openDialog();
    submit();
    expect(await screen.findByTestId('draft-shortfall-po-error')).toHaveTextContent(SHORTFALL_PO_CONFLICT_COPY);
    draftAction.mockResolvedValueOnce({ ok: true, data: result() });
    submit();
    await waitFor(() => expect(draftAction).toHaveBeenCalledTimes(2));
    expect(sentKey(1)).not.toBe(sentKey(0));
    expect(sentLines(1)).toEqual(sentLines(0));
  });

  it('a quantity above the most, or not a number, is said under its field and nothing is sent', async () => {
    await openDialog();
    fireEvent.change(qty(A), { target: { value: '9' } });
    expect(within(row(A)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent('At most 8 can be drafted now.');
    expect(qty(A)).toHaveAttribute('aria-invalid', 'true');
    expect(qty(A)).toHaveAccessibleDescription('At most 8 can be drafted now.');
    fireEvent.change(qty(B), { target: { value: 'six' } });
    expect(within(row(B)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent('Enter a number.');
    fireEvent.change(qty(C), { target: { value: '0' } });
    expect(within(row(C)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent('Enter a quantity above 0.');
    submit();
    expect(draftAction).not.toHaveBeenCalled();
    // The person is taken to the first field to fix.
    expect(document.activeElement).toBe(qty(A));
    // An unticked row's field is not checked.
    fireEvent.click(checkbox(A));
    expect(within(row(A)).queryByTestId('draft-shortfall-po-problem')).toBeNull();
  });
});

describe('DraftShortfallPoDialog: when stock or POs changed (shortfall_changed)', () => {
  it('keeps the choice, shows the new most at once from the refusal, reads readiness again, and never lowers a quantity itself', async () => {
    draftAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: SHORTFALL_PO_CHANGED_COPY,
        details: { reason: 'shortfall_changed', current: { [A]: 3, [B]: 6, [C]: 0 } },
      },
    });
    // The read again: A 3 left (a draft of 5 elsewhere), C now fully on a draft.
    const pendingReload = deferred<ShortfallPoLoad>();
    await openDialog();
    loadAction.mockReturnValueOnce(pendingReload.promise);
    fireEvent.change(qty(B), { target: { value: '5' } });
    submit();

    // Said inline, in core's words.
    expect(await screen.findByTestId('draft-shortfall-po-error')).toHaveTextContent(SHORTFALL_PO_CHANGED_COPY);
    // At once, from the database's own numbers: the choice kept, the new most shown.
    expect(qty(A).value).toBe('8');
    expect(checkbox(A).checked).toBe(true);
    expect(within(row(A)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent('At most 3 can be drafted now.');
    expect(qty(B).value).toBe('5');
    expect(within(row(B)).queryByTestId('draft-shortfall-po-problem')).toBeNull();
    expect(within(row(C)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent(SHORTFALL_PO_NOTHING_LEFT_COPY);
    // Readiness read again, and the page behind.
    expect(loadAction).toHaveBeenCalledTimes(2);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    await act(async () =>
      pendingReload.resolve({
        view: shortfallView({
          a: {
            drafts: {
              rows: [{ poId: 'dpo-9', poNumber: 'PO-2026-0049', remaining: 5 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          },
          c: {
            drafts: {
              rows: [{ poId: 'dpo-8', poNumber: 'PO-2026-0048', remaining: 5 }],
              hiddenRemaining: 0,
              truncated: false,
              truncatedRemaining: 0,
            },
          },
        }),
        supplierNames: NAMES,
      }),
    );
    // Still the person's 8 (a problem to fix, never lowered silently), with the fresh words.
    expect(qty(A).value).toBe('8');
    expect(within(row(A)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(
      'Short 8 · already on order or draft 5',
    );
    expect(within(row(A)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent('At most 3 can be drafted now.');
    // C has nothing left: unticked, with what covers it now.
    expect(row(C).getAttribute('data-state')).toBe('covered');
    expect(checkbox(C).checked).toBe(false);
    expect(within(row(C)).getByTestId('draft-shortfall-po-detail')).toHaveTextContent(
      'Already on draft PO-2026-0048 (not ordered yet)',
    );
    expect(screen.getByTestId('draft-shortfall-po-error')).toHaveTextContent(SHORTFALL_PO_CHANGED_COPY);

    // Fixed by the person, the next press is a new request.
    fireEvent.change(qty(A), { target: { value: '3' } });
    draftAction.mockResolvedValueOnce({ ok: true, data: result() });
    submit();
    await waitFor(() => expect(draftAction).toHaveBeenCalledTimes(2));
    expect(sentLines(1)).toEqual([
      { itemId: A, quantity: 3 },
      { itemId: B, quantity: 5 },
    ]);
    expect(sentKey(1)).not.toBe(sentKey(0));
  });

  it('when the read again fails, the most from the refusal still holds', async () => {
    draftAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: SHORTFALL_PO_CHANGED_COPY,
        details: { reason: 'shortfall_changed', current: { [A]: 3, [B]: 6, [C]: 5 } },
      },
    });
    await openDialog();
    loadAction.mockResolvedValueOnce({ view: null, supplierNames: null });
    submit();
    await screen.findByTestId('draft-shortfall-po-error');
    await waitFor(() => expect(loadAction).toHaveBeenCalledTimes(2));
    expect(within(row(A)).getByTestId('draft-shortfall-po-problem')).toHaveTextContent('At most 3 can be drafted now.');
    // Names already read stay.
    expect(within(row(A)).getByTestId('draft-shortfall-po-supplier')).toHaveTextContent('Acme Supply');
    submit();
    expect(draftAction).toHaveBeenCalledTimes(1);
  });
});
