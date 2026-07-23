import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ItemHistoryDialog } from './item-history-dialog';

import type { ItemHistoryMovement, ItemHistoryPage } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// The rows below are the OWNER'S REAL PROD LEDGER for SKU SP-0WK2L-LY1 (org
// 63c13e64-…), shaped exactly as InventoryService.itemMovementHistory() returns
// them. The incident these tests protect: nobody could tell from any screen who
// added 10 units, who took 10 back, or which of the receive_po rows had been
// reversed — the staging list showed an em dash for everything that did not
// arrive on a PO, and the controller had to rebuild the story in SQL.
// ---------------------------------------------------------------------------

function movement(over: Partial<ItemHistoryMovement>): ItemHistoryMovement {
  return {
    id: 'mv-x',
    at: '2026-07-22T21:16:28.910Z',
    movementType: 'add',
    quantityChange: 0,
    movedQuantity: null,
    previousQuantity: 0,
    newQuantity: 0,
    actorName: null,
    actorEmail: null,
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
    ...over,
  };
}

/** 2026-07-22 17:56 UTC — the posted receipt on PO CVW-002201. */
const POSTED_RECEIPT = movement({
  id: 'mv-posted',
  at: '2026-07-22T17:56:00.525Z',
  movementType: 'receive_po',
  quantityChange: 20,
  previousQuantity: 34,
  newQuantity: 54,
  actorName: 'Andrew Rosas',
  toLocationName: 'Staging',
  // reason was the machine string 'PO CVW-002201' → the service already
  // dropped it, so `note` is null here.
  receiptNumber: 'R-20260722-175600-e56648',
  receiptStatus: 'posted',
  poNumber: 'CVW-002201',
  poStatus: 'received',
});

/** 2026-07-22 16:20 UTC — received, then undone 27 minutes later. */
const REVERSED_RECEIPT = movement({
  id: 'mv-received-then-reversed',
  at: '2026-07-22T16:20:27.889Z',
  movementType: 'receive_po',
  quantityChange: 20,
  previousQuantity: 0,
  newQuantity: 20,
  actorName: 'Andrew Rosas',
  toLocationName: 'Staging',
  receiptNumber: 'R-20260722-162027-e33333',
  receiptStatus: 'reversed',
  poNumber: 'CVW-002201',
  poStatus: 'cancelled',
  reversalReason: 'wrong input',
  reversal: {
    role: 'reversed',
    counterpartMovementId: 'mv-the-reversal',
    counterpartReceiptNumber: 'R-20260722-162027-e33333-REV',
  },
});

/** The other half of that pair — reason on the row is the token
 *  'receipt_reversal', which must never reach the screen. */
const THE_REVERSAL = movement({
  id: 'mv-the-reversal',
  at: '2026-07-22T16:47:37.604Z',
  movementType: 'correction',
  quantityChange: -20,
  previousQuantity: 20,
  newQuantity: 0,
  actorName: 'Andrew Rosas',
  receiptNumber: 'R-20260722-162027-e33333-REV',
  receiptStatus: 'reversal',
  poNumber: 'CVW-002201',
  poStatus: 'cancelled',
  reversalReason: 'wrong input',
  reversal: {
    role: 'reversal',
    counterpartMovementId: 'mv-received-then-reversed',
    counterpartReceiptNumber: 'R-20260722-162027-e33333',
  },
});

/** The manual add the colleague made, and the manager's reversal of it. */
const MANUAL_ADD = movement({
  id: 'mv-manual-add',
  at: '2026-07-22T21:16:28.910Z',
  movementType: 'add',
  quantityChange: 10,
  previousQuantity: 134,
  newQuantity: 144,
  actorName: 'Peter Pete',
  note: 'Adding new stock into inventory.',
});

const MANUAL_REMOVE = movement({
  id: 'mv-manual-remove',
  at: '2026-07-22T21:42:19.250Z',
  movementType: 'remove',
  quantityChange: -10,
  previousQuantity: 144,
  newQuantity: 134,
  actorName: 'Andrew Rosas',
  note: 'incorrectly moved inventory',
});

/** 2026-07-06 order pick. movement_type='transfer' but with a REAL -5 delta —
 *  the case that would vanish if the UI copied the activity feed's assumption
 *  that transfers are always net-zero. */
const ORDER_PICK = movement({
  id: 'mv-order-pick',
  at: '2026-07-06T22:21:08.621Z',
  movementType: 'transfer',
  quantityChange: -5,
  previousQuantity: 139,
  newQuantity: 134,
  actorName: 'Daniel Hernandez',
  note: 'Order pick',
});

/** 2026-06-25 opening count whose reason is the internal token
 *  'duplicate_initial_count'. */
const DUPLICATE_INITIAL = movement({
  id: 'mv-duplicate-initial',
  at: '2026-06-25T04:51:08.134Z',
  movementType: 'initial',
  quantityChange: 49,
  previousQuantity: 0,
  newQuantity: 49,
  actorName: 'Andrew Rosas',
  toLocationName: 'DC4',
});

/** Not from this SKU: a trigger-written row (no auth.uid) and an
 *  internally-cancelled order pick, which `cancel_order_request` records as
 *  movement_type='return'. Both pin truthfulness rules that this SKU happens
 *  not to exercise. */
const SYSTEM_WRITE = movement({
  id: 'mv-system',
  at: '2026-07-20T09:00:00.000Z',
  movementType: 'adjust',
  quantityChange: -1,
  previousQuantity: 50,
  newQuantity: 49,
  actorName: null,
});

const CANCELLED_PICK_RESTOCK = movement({
  id: 'mv-return',
  at: '2026-07-19T09:00:00.000Z',
  movementType: 'return',
  quantityChange: 3,
  previousQuantity: 47,
  newQuantity: 50,
  actorName: 'Peter Pete',
  note: 'Order cancelled',
});

function page(rows: ItemHistoryMovement[], over: Partial<ItemHistoryPage> = {}): ItemHistoryPage {
  return {
    itemId: 'item-1',
    itemName: 'Science Dimensions Earth & Space Science',
    itemSku: 'SP-0WK2L-LY1',
    rows,
    total: rows.length,
    limit: 50,
    offset: 0,
    hasMore: false,
    ...over,
  };
}

/** The three real inventory_items rows that share SKU SP-0WK2L-LY1 in the
 *  owner's org, as /api/v1/items/lookup?code=SP-0WK2L-LY1 answers them. The
 *  owner's incident spans the first two; the dialog used to show one of them
 *  under a header claiming it was showing everything. */
const SKU_RECORDS = [
  { id: 'item-1', sku: 'SP-0WK2L-LY1', placementLabel: '42-B', quantityOnHand: 144 },
  { id: 'item-sibling-37b', sku: 'SP-0WK2L-LY1', placementLabel: '37-B', quantityOnHand: 46 },
  { id: 'item-sibling-archived', sku: 'SP-0WK2L-LY1', placementLabel: null, quantityOnHand: 0 },
];

/**
 * The dialog now makes TWO kinds of request — the history window, and the
 * one-code lookup that tells it which OTHER records share this SKU — so the
 * mock routes on URL instead of on call order. `historyMock` still holds the
 * history calls alone, so the ordering assertions below keep their meaning.
 */
const historyMock = vi.fn();
const lookupMock = vi.fn();
const fetchMock = vi.fn((url: string) =>
  url.startsWith('/api/v1/items/lookup') ? lookupMock(url) : historyMock(url),
);

beforeEach(() => {
  fetchMock.mockClear();
  historyMock.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue({ ok: true, json: async () => ({ matches: SKU_RECORDS }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okOnce(body: ItemHistoryPage) {
  historyMock.mockResolvedValueOnce({ ok: true, json: async () => body });
}

/** No sibling records: this SKU is a single item record. */
function soleRecord() {
  lookupMock.mockResolvedValue({
    ok: true,
    json: async () => ({ matches: [SKU_RECORDS[0]] }),
  });
}

function renderDialog() {
  return render(
    <ItemHistoryDialog
      itemId="item-1"
      itemName="Science Dimensions Earth & Space Science"
      itemSku="SP-0WK2L-LY1"
      trigger={<button type="button">History</button>}
    />,
  );
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'History' }));
}

describe('ItemHistoryDialog', () => {
  it('does not fetch until the dialog is opened, then reads the shared history route', async () => {
    const user = userEvent.setup();
    okOnce(page([POSTED_RECEIPT]));
    renderDialog();

    expect(fetchMock).not.toHaveBeenCalled();

    await open(user);

    await waitFor(() => expect(historyMock).toHaveBeenCalledTimes(1));
    expect(historyMock.mock.calls[0]?.[0]).toBe('/api/v1/items/item-1/history?limit=50&offset=0');
  });

  it('tells the whole story of the posted receipt: who, when, how many, where and which PO', async () => {
    const user = userEvent.setup();
    okOnce(page([POSTED_RECEIPT]));
    renderDialog();
    await open(user);

    const row = await screen.findByTestId('history-row-mv-posted');
    expect(within(row).getByText('Stock received')).toBeInTheDocument();
    expect(within(row).getByText('+20')).toBeInTheDocument();
    expect(within(row).getByText('34 -> 54 on hand')).toBeInTheDocument();
    expect(within(row).getByText('Andrew Rosas')).toBeInTheDocument();
    expect(within(row).getByText('-> Staging')).toBeInTheDocument();
    // The PO status is stated even though the receipt posted cleanly — the
    // owner's real case has stock received against a PO later cancelled.
    expect(
      within(row).getByText('Receipt R-20260722-175600-e56648 - PO CVW-002201 (received)'),
    ).toBeInTheDocument();
    // Rule 4: the raw ISO instant is carried on <time>; the visible absolute
    // date comes from <LocalDateTime>, i.e. the VIEWER's timezone.
    expect(within(row).getByRole('time')).toHaveAttribute(
      'dateTime',
      '2026-07-22T17:56:00.525Z',
    );
  });

  it('marks BOTH halves of a received-then-reversed pair and links them', async () => {
    const user = userEvent.setup();
    okOnce(page([THE_REVERSAL, REVERSED_RECEIPT]));
    renderDialog();
    await open(user);

    const reversal = await screen.findByTestId('history-row-mv-the-reversal');
    expect(
      within(reversal).getByText('Reverses R-20260722-162027-e33333: wrong input'),
    ).toBeInTheDocument();

    const original = screen.getByTestId('history-row-mv-received-then-reversed');
    expect(
      within(original).getByText('Reversed later by R-20260722-162027-e33333-REV: wrong input'),
    ).toBeInTheDocument();

    // Jumping from one half highlights the other, so 20 in and 20 out are
    // legible as one event rather than two unrelated receipts.
    await user.click(within(reversal).getByRole('button', { name: 'Show the other half' }));
    expect(screen.getByTestId('history-row-mv-received-then-reversed').className).toContain(
      'ring-warning/40',
    );
  });

  it('never renders an internal token, a raw uuid or a machine-composed reason as a note', async () => {
    const user = userEvent.setup();
    okOnce(page([POSTED_RECEIPT, THE_REVERSAL, DUPLICATE_INITIAL]));
    renderDialog();
    await open(user);

    await screen.findByTestId('history-row-mv-posted');
    for (const token of ['receipt_line', 'receipt_reversal', 'duplicate_initial_count']) {
      expect(screen.queryByText(new RegExp(token))).not.toBeInTheDocument();
    }
    // The bare 'PO CVW-002201' reason must not come back as quoted prose; the
    // PO belongs in the structured source line only.
    expect(screen.queryByText('“PO CVW-002201”')).not.toBeInTheDocument();
    // The opening count still renders, with its destination, minus the token.
    const initial = screen.getByTestId('history-row-mv-duplicate-initial');
    expect(within(initial).getByText('Opening count')).toBeInTheDocument();
    expect(within(initial).getByText('-> DC4')).toBeInTheDocument();
  });

  it('shows the manual add and its reversal with the operator’s own words and different people', async () => {
    const user = userEvent.setup();
    okOnce(page([MANUAL_REMOVE, MANUAL_ADD]));
    renderDialog();
    await open(user);

    const add = await screen.findByTestId('history-row-mv-manual-add');
    expect(within(add).getByText('Stock added')).toBeInTheDocument();
    expect(within(add).getByText('+10')).toBeInTheDocument();
    expect(within(add).getByText('Peter Pete')).toBeInTheDocument();
    expect(within(add).getByText('“Adding new stock into inventory.”')).toBeInTheDocument();

    const remove = screen.getByTestId('history-row-mv-manual-remove');
    expect(within(remove).getByText('Stock removed')).toBeInTheDocument();
    expect(within(remove).getByText('-10')).toBeInTheDocument();
    expect(within(remove).getByText('Andrew Rosas')).toBeInTheDocument();
    expect(within(remove).getByText('“incorrectly moved inventory”')).toBeInTheDocument();
  });

  it('shows the units on an order pick even though its movement_type is transfer', async () => {
    const user = userEvent.setup();
    okOnce(page([ORDER_PICK]));
    renderDialog();
    await open(user);

    const pick = await screen.findByTestId('history-row-mv-order-pick');
    // Regression guard: keying the number off movementType === 'transfer'
    // would hide five units leaving the building.
    expect(within(pick).getByText('-5')).toBeInTheDocument();
    expect(within(pick).getByText('139 -> 134 on hand')).toBeInTheDocument();
    expect(within(pick).getByText('“Order pick”')).toBeInTheDocument();
  });

  it('does not claim a customer returned anything, and does not dress a system write as a person', async () => {
    const user = userEvent.setup();
    okOnce(page([SYSTEM_WRITE, CANCELLED_PICK_RESTOCK]));
    renderDialog();
    await open(user);

    const ret = await screen.findByTestId('history-row-mv-return');
    expect(within(ret).getByText('Returned to stock')).toBeInTheDocument();
    expect(within(ret).queryByText(/customer/i)).not.toBeInTheDocument();

    const sys = screen.getByTestId('history-row-mv-system');
    expect(within(sys).getByText('No recorded user')).toBeInTheDocument();
    expect(within(sys).queryByText(/^System$/)).not.toBeInTheDocument();
  });

  it('pages with an explicit offset when the service says there is more', async () => {
    const user = userEvent.setup();
    okOnce(page([POSTED_RECEIPT], { total: 2, hasMore: true }));
    renderDialog();
    await open(user);

    await screen.findByTestId('history-row-mv-posted');
    expect(screen.getByText('1')).toBeInTheDocument(); // "Showing 1 of 2"

    okOnce(page([ORDER_PICK], { total: 2, hasMore: false, offset: 1 }));
    await user.click(screen.getByRole('button', { name: 'Load older movements' }));

    await waitFor(() => expect(screen.getByTestId('history-row-mv-order-pick')).toBeInTheDocument());
    expect(historyMock.mock.calls[1]?.[0]).toBe('/api/v1/items/item-1/history?limit=50&offset=1');
    // The first page is still there — paging appends, it does not replace.
    expect(screen.getByTestId('history-row-mv-posted')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load older movements' }),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // D2, REWRITTEN — not weakened, and the reason matters.
  //
  // The history is per ITEM RECORD. Under Model B one SKU is legitimately
  // several records; in the owner's org SP-0WK2L-LY1 is three. The original
  // header claimed "Every recorded movement for {name} {sku}", which is false
  // wherever a SKU has more than one record — and the owner's own incident
  // spans two of them.
  //
  // Two attempts to fix that by NAMING the record each introduced a fresh
  // falsehood, which is why these tests no longer assert a descriptor:
  //   - naming it by rack calls a record whose bin_location is empty "the no
  //     rack recorded record", while its stock is genuinely on a shelf;
  //   - two records can share a bin_location, so "the {rack} record" is a false
  //     definite description and two sibling buttons render identically.
  // Every descriptor available on this screen is either ambiguous or sometimes
  // wrong, so the header now asserts only what is certain: these rows are ONE
  // record's ledger, and here is how many records exist. Navigation between
  // records went with it — a button that cannot be labelled truthfully should
  // not be offered.
  // -------------------------------------------------------------------------
  it('claims only that these rows are ONE record, never which one', async () => {
    const user = userEvent.setup();
    okOnce(page([MANUAL_ADD]));
    renderDialog();
    await open(user);

    const description = await screen.findByText(/One item record/);
    // The original false claim, verbatim.
    expect(description.textContent).not.toMatch(
      /Every recorded movement for\s+Science Dimensions Earth & Space Science\s+SP-0WK2L-LY1/,
    );
    // And no descriptor, because none of them is reliably true.
    expect(description).not.toHaveTextContent('no rack recorded');
    expect(description).not.toHaveTextContent('record of');
  });

  it('discloses how many records share the SKU without describing them', async () => {
    const user = userEvent.setup();
    okOnce(page([MANUAL_ADD]));
    renderDialog();
    await open(user);

    const description = await screen.findByText(/One item record/);
    await waitFor(() => expect(description).toHaveTextContent('This SKU has 3 records'));
    expect(description).toHaveTextContent('the others are not included');
    // No record is offered as a destination, because it cannot be labelled
    // truthfully — see the block comment above.
    expect(screen.queryByRole('button', { name: /on hand/ })).not.toBeInTheDocument();
  });

  it('says nothing about other records when the SKU really is one record', async () => {
    const user = userEvent.setup();
    soleRecord();
    okOnce(page([MANUAL_ADD]));
    renderDialog();
    await open(user);

    await screen.findByTestId('history-row-mv-manual-add');
    expect(screen.queryByText(/This SKU has/)).not.toBeInTheDocument();
  });

  it('claims nothing about other records when the lookup itself failed', async () => {
    const user = userEvent.setup();
    lookupMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'internal_error' }) });
    okOnce(page([MANUAL_ADD]));
    renderDialog();
    await open(user);

    // The history still renders; the header simply says less rather than
    // something it cannot support.
    await screen.findByTestId('history-row-mv-manual-add');
    expect(screen.queryByText(/This SKU has/)).not.toBeInTheDocument();
    expect(screen.getByText(/One item record/)).toBeInTheDocument();
  });

  // M2. The window is newest-first and live, so a movement written while the
  // dialog is open shifts every later row down one and page 2 re-delivers the
  // last row of page 1. The native sheet already de-duplicates by id.
  it('does not show the same movement twice when a row shifts between pages', async () => {
    const user = userEvent.setup();
    okOnce(page([MANUAL_REMOVE, MANUAL_ADD], { total: 3, hasMore: true }));
    renderDialog();
    await open(user);
    await screen.findByTestId('history-row-mv-manual-add');

    // Page 2 re-delivers MANUAL_ADD (pushed down by a newer write) plus a row
    // the reader has not seen.
    okOnce(page([MANUAL_ADD, ORDER_PICK], { total: 3, hasMore: false, offset: 2 }));
    await user.click(screen.getByRole('button', { name: 'Load older movements' }));

    await waitFor(() =>
      expect(screen.getByTestId('history-row-mv-order-pick')).toBeInTheDocument(),
    );
    // One row, not two: a repeated receipt reads as stock arriving twice.
    expect(screen.getAllByTestId('history-row-mv-manual-add')).toHaveLength(1);
    expect(screen.getAllByText('“Adding new stock into inventory.”')).toHaveLength(1);
  });

  it('explains a refusal instead of showing an empty history', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'forbidden' }),
    });
    renderDialog();
    await open(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have access to this item’s warehouse.');
    expect(screen.queryByText(/No stock movements recorded/)).not.toBeInTheDocument();
  });

  it('says so plainly when an item genuinely has no movements', async () => {
    const user = userEvent.setup();
    okOnce(page([]));
    renderDialog();
    await open(user);

    expect(
      await screen.findByText('No stock movements recorded for this item yet.'),
    ).toBeInTheDocument();
  });
});
