import { describe, expect, it } from 'vitest';

import { formatHistoryMovement } from '@stockpilot/core';

import {
  appendHistoryMovements,
  formatHistoryWhen,
  historyAmountLines,
  historyProgressLabel,
  ITEM_HISTORY_PAGE_SIZE,
  itemHistoryPath,
  nextHistoryOffset,
  parseItemHistoryPage,
} from './item-history';

/**
 * The pure half of the native item-history sheet.
 *
 * The fixtures below are the OWNER'S REAL ROWS for SKU SP-0WK2L-LY1 in org
 * 63c13e64-92a6-4ea4-9936-6a2c26a85b4a, pulled from production and shaped
 * exactly as GET /api/v1/items/[id]/history answers them. They are the incident
 * itself: two manual adds by two different people minutes apart, a removal
 * reasoned "incorrectly moved inventory", a posted receipt on PO CVW-002201, a
 * received-then-reversed pair on a cancelled PO, an order pick recorded as a
 * transfer with a real negative delta, an opening count and a
 * duplicate_initial_count.
 *
 * What is asserted is the WHOLE rendered sentence for each, because the bar the
 * owner set is "could I have answered my own question from this screen" — not
 * "does the parser return an object".
 */

/** Movements on the 144-on-hand record (item a010364d…), newest first. */
const REAL_ROWS = [
  {
    id: '694b11bd-d358-4ee7-82f9-5ddc7b37bb63',
    at: '2026-07-22T23:15:20.420364+00:00',
    movementType: 'adjust',
    quantityChange: 10,
    movedQuantity: null,
    previousQuantity: 134,
    newQuantity: 144,
    actorName: 'Peter Pete',
    actorEmail: 'pmathis@cvsouth.org',
    fromLocationName: null,
    toLocationName: null,
    note: 'Cycle count adjustment',
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    id: '3dfd0ea6-bdce-4154-9a55-06ce5c34a752',
    at: '2026-07-22T22:20:11.38873+00:00',
    movementType: 'transfer',
    quantityChange: 0,
    movedQuantity: 10,
    previousQuantity: 134,
    newQuantity: 134,
    actorName: 'Andrew Rosas',
    actorEmail: 'arosas@cvwest.org',
    fromLocationName: 'Staging',
    toLocationName: '42-B',
    note: null,
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    id: 'd4b40f88-44de-4635-9290-d7ebcfb839f3',
    at: '2026-07-22T21:42:19.250842+00:00',
    movementType: 'remove',
    quantityChange: -10,
    movedQuantity: null,
    previousQuantity: 144,
    newQuantity: 134,
    actorName: 'Andrew Rosas',
    actorEmail: 'arosas@cvwest.org',
    fromLocationName: null,
    toLocationName: null,
    note: 'incorrectly moved inventory',
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    id: '10950b2b-4918-41b6-bb85-6763e83d5c8b',
    at: '2026-07-22T21:16:28.910114+00:00',
    movementType: 'add',
    quantityChange: 10,
    movedQuantity: null,
    previousQuantity: 134,
    newQuantity: 144,
    actorName: 'Peter Pete',
    actorEmail: 'pmathis@cvsouth.org',
    fromLocationName: null,
    toLocationName: null,
    note: 'Adding new stock into inventory.',
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    // The order pick. movement_type='transfer' with a REAL negative delta and
    // no moved_quantity — five units left the building.
    id: '59926af5-bf29-4740-9bd1-657ed3bbfe1f',
    at: '2026-07-06T22:21:08.621573+00:00',
    movementType: 'transfer',
    quantityChange: -5,
    movedQuantity: null,
    previousQuantity: 139,
    newQuantity: 134,
    actorName: 'Daniel Hernandez',
    actorEmail: 'dahernandez@cvwest.org',
    fromLocationName: null,
    toLocationName: null,
    note: 'Order pick',
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    // Pre-0231 transfer: net zero AND no recorded moved_quantity.
    id: '25bfbf90-2755-4d86-b82f-30da1bf2c0e3',
    at: '2026-07-01T18:46:27.040704+00:00',
    movementType: 'transfer',
    quantityChange: 0,
    movedQuantity: null,
    previousQuantity: 139,
    newQuantity: 139,
    actorName: 'Branden Vincent Walker',
    actorEmail: 'branden574@gmail.com',
    fromLocationName: 'Staging',
    toLocationName: '42-B',
    note: 'Staging cleanup: stock mis-routed to Staging by the adjust bug, moved back to rack/Unplaced',
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    id: '248eb8a7-044c-4095-be2d-28de2fcc6899',
    at: '2026-07-01T17:12:33.730822+00:00',
    movementType: 'add',
    quantityChange: 90,
    movedQuantity: null,
    previousQuantity: 49,
    newQuantity: 139,
    actorName: 'Peter Pete',
    actorEmail: 'pmathis@cvsouth.org',
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    // reason='duplicate_initial_count' — machine-written, so no note at all.
    id: '4b0ea0e3-5d54-41da-9734-0cbd528f57fe',
    at: '2026-06-25T04:51:08.134623+00:00',
    movementType: 'initial',
    quantityChange: 49,
    movedQuantity: null,
    previousQuantity: 0,
    newQuantity: 49,
    actorName: 'Andrew Rosas',
    actorEmail: 'arosas@cvwest.org',
    fromLocationName: null,
    toLocationName: 'DC4',
    note: null,
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
] as const;

/** Receiving movements on the 46-on-hand record (item 5f3538ee…). */
const REAL_RECEIPT_ROWS = [
  {
    // The posted receipt. Note the PO is 'received' but the SAME PO number
    // appears below on rows that were reversed — status has to be stated.
    id: '9be2a106-3342-41fc-a1df-3274876339c2',
    at: '2026-07-22T17:56:00.52597+00:00',
    movementType: 'receive_po',
    quantityChange: 20,
    movedQuantity: null,
    previousQuantity: 34,
    newQuantity: 54,
    actorName: 'Andrew Rosas',
    actorEmail: 'arosas@cvwest.org',
    fromLocationName: null,
    toLocationName: 'Staging',
    note: null,
    receiptNumber: 'R-20260722-175600-e56648',
    receiptStatus: 'posted',
    poNumber: 'CVW-002201',
    poStatus: 'received',
    reversalReason: null,
    reversal: null,
  },
  {
    id: '65db542e-0236-405b-a392-aa5563ae5901',
    at: '2026-06-24T22:42:28.314144+00:00',
    movementType: 'correction',
    quantityChange: -90,
    movedQuantity: null,
    previousQuantity: 129,
    newQuantity: 39,
    actorName: 'Branden Vincent Walker',
    actorEmail: 'branden574@gmail.com',
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: 'R-20260624-224111-a00736-REV',
    receiptStatus: 'reversal',
    poNumber: 'PO-1782340858804',
    poStatus: 'cancelled',
    reversalReason: 'Wrong rack entered (testing)',
    // status='reversal' → this movement IS the undo.
    reversal: {
      role: 'reversal' as const,
      counterpartMovementId: '2b9baffa-ca00-4245-b7bd-0a53e695f6be',
      counterpartReceiptNumber: 'R-20260624-224111-a00736',
    },
  },
  {
    id: '2b9baffa-ca00-4245-b7bd-0a53e695f6be',
    at: '2026-06-24T22:41:11.339279+00:00',
    movementType: 'receive_po',
    quantityChange: 90,
    movedQuantity: null,
    previousQuantity: 39,
    newQuantity: 129,
    actorName: 'Branden Vincent Walker',
    actorEmail: 'branden574@gmail.com',
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: 'R-20260624-224111-a00736',
    receiptStatus: 'reversed',
    poNumber: 'PO-1782340858804',
    poStatus: 'cancelled',
    reversalReason: 'Wrong rack entered (testing)',
    reversal: {
      role: 'reversed' as const,
      counterpartMovementId: '65db542e-0236-405b-a392-aa5563ae5901',
      counterpartReceiptNumber: 'R-20260624-224111-a00736-REV',
    },
  },
] as const;

function pageOf(rows: readonly unknown[], extra: Record<string, unknown> = {}) {
  return {
    itemId: 'a010364d-1fbb-41d0-89ce-69292483f92f',
    itemName: 'Science Dimensions Earth & Space Science',
    itemSku: 'SP-0WK2L-LY1',
    rows,
    total: rows.length,
    limit: ITEM_HISTORY_PAGE_SIZE,
    offset: 0,
    hasMore: false,
    ...extra,
  };
}

describe('itemHistoryPath', () => {
  it('always states the window it wants', () => {
    expect(itemHistoryPath('a010364d-1fbb-41d0-89ce-69292483f92f')).toBe(
      '/api/v1/items/a010364d-1fbb-41d0-89ce-69292483f92f/history?limit=50&offset=0',
    );
    expect(itemHistoryPath('abc', { limit: 25, offset: 50 })).toBe(
      '/api/v1/items/abc/history?limit=25&offset=50',
    );
  });

  it('never emits a negative or fractional window', () => {
    expect(itemHistoryPath('abc', { limit: 0, offset: -10 })).toBe(
      '/api/v1/items/abc/history?limit=1&offset=0',
    );
    expect(itemHistoryPath('abc', { limit: 12.7, offset: 3.9 })).toBe(
      '/api/v1/items/abc/history?limit=12&offset=3',
    );
  });

  it('escapes the id rather than pasting it into the URL', () => {
    expect(itemHistoryPath('a b/c')).toContain('/api/v1/items/a%20b%2Fc/history');
  });
});

describe('parseItemHistoryPage', () => {
  it('reads the real payload verbatim', () => {
    const page = parseItemHistoryPage(pageOf(REAL_ROWS, { total: 24, hasMore: true }));
    expect(page.itemSku).toBe('SP-0WK2L-LY1');
    expect(page.rows).toHaveLength(REAL_ROWS.length);
    expect(page.total).toBe(24);
    expect(page.hasMore).toBe(true);
    expect(page.rows[0]?.actorName).toBe('Peter Pete');
    expect(page.rows[1]?.fromLocationName).toBe('Staging');
    expect(page.rows[1]?.movedQuantity).toBe(10);
  });

  it('fails soft on a garbage payload instead of throwing the sheet away', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      const page = parseItemHistoryPage(junk);
      expect(page.rows).toEqual([]);
      expect(page.total).toBe(0);
      expect(page.hasMore).toBe(false);
    }
  });

  it('drops only rows it could neither key nor place in time', () => {
    const page = parseItemHistoryPage(
      pageOf([
        { ...REAL_ROWS[0] },
        { ...REAL_ROWS[1], id: null },
        { ...REAL_ROWS[2], at: '' },
        'not-a-row',
      ]),
    );
    expect(page.rows.map((r) => r.id)).toEqual(['694b11bd-d358-4ee7-82f9-5ddc7b37bb63']);
  });

  it('never lets a missing count under-report the rows it is showing', () => {
    // A payload without `total` must not make the sheet claim fewer movements
    // than are already on screen.
    const page = parseItemHistoryPage(pageOf(REAL_ROWS, { total: undefined }));
    expect(page.total).toBe(REAL_ROWS.length);
    const lying = parseItemHistoryPage(pageOf(REAL_ROWS, { total: 2 }));
    expect(lying.total).toBe(REAL_ROWS.length);
  });

  it('only believes hasMore when the server actually said it', () => {
    expect(parseItemHistoryPage(pageOf(REAL_ROWS, { hasMore: 'yes' })).hasMore).toBe(false);
    expect(parseItemHistoryPage(pageOf(REAL_ROWS, { hasMore: 1 })).hasMore).toBe(false);
    expect(parseItemHistoryPage(pageOf(REAL_ROWS, { hasMore: true })).hasMore).toBe(true);
  });

  it('drops a reversal marker whose role it does not understand', () => {
    // Marking a movement as half of a reversal pair on the strength of a string
    // we cannot interpret would be a guess — exactly what this rebuild removed.
    const page = parseItemHistoryPage(
      pageOf([
        { ...REAL_RECEIPT_ROWS[2], reversal: { role: 'maybe', counterpartReceiptNumber: 'R-1' } },
      ]),
    );
    expect(page.rows[0]?.reversal).toBeNull();
  });

  it('keeps an absent actor absent', () => {
    const page = parseItemHistoryPage(
      pageOf([{ ...REAL_ROWS[0], actorName: null, actorEmail: null }]),
    );
    expect(page.rows[0]?.actorName).toBeNull();
    expect(page.rows[0]?.actorEmail).toBeNull();
    expect(formatHistoryMovement(page.rows[0]!).actorLabel).toBeNull();
  });
});

describe('paging', () => {
  it('starts the next window past the rows actually delivered', () => {
    const page = parseItemHistoryPage(pageOf(REAL_ROWS, { offset: 50, hasMore: true }));
    expect(nextHistoryOffset(page)).toBe(50 + REAL_ROWS.length);
  });

  it('never tells the same movement twice when a write shifts the window', () => {
    // Newest-first paging: a movement written between page 1 and page 2 pushes
    // every later row down one, so page 2 re-delivers page 1's last row. Told
    // twice, a receipt reads as stock that arrived twice.
    const first = parseItemHistoryPage(pageOf(REAL_ROWS.slice(0, 4))).rows;
    const second = parseItemHistoryPage(pageOf(REAL_ROWS.slice(3))).rows;
    const merged = appendHistoryMovements(first, second);
    expect(merged.map((m) => m.id)).toEqual(REAL_ROWS.map((m) => m.id));
    expect(new Set(merged.map((m) => m.id)).size).toBe(merged.length);
  });

  it('preserves the order rows arrived in', () => {
    const rows = parseItemHistoryPage(pageOf(REAL_ROWS)).rows;
    expect(appendHistoryMovements([], rows).map((m) => m.at)).toEqual(
      REAL_ROWS.map((m) => m.at),
    );
  });
});

describe('historyProgressLabel', () => {
  it('says how much is still unread while paging', () => {
    expect(historyProgressLabel(8, 24)).toBe('8 of 24 movements');
  });

  it('states the plain total once everything is on screen', () => {
    // "24 of 24" reads as though something is still missing.
    expect(historyProgressLabel(24, 24)).toBe('24 movements');
    expect(historyProgressLabel(1, 1)).toBe('1 movement');
    expect(historyProgressLabel(0, 0)).toBe('0 movements');
  });

  it('never claims fewer exist than are shown', () => {
    expect(historyProgressLabel(10, 3)).toBe('10 movements');
  });

  // D3. The sheet renders this counter as soon as `loading` clears — including
  // when the FIRST page failed, where rows and total are both 0. It used to
  // print "0 movements", asserting an empty ledger for an item whose ledger was
  // never read. The sheet's own ListEmptyComponent is commented against exactly
  // this conflation.
  it('does not claim an empty ledger when the first page never came back', () => {
    const label = historyProgressLabel(0, 0, true);
    expect(label).not.toBe('0 movements');
    expect(label).toBe('Movements not loaded');
  });

  // A LATER page failing is a different fact: the rows on screen were really
  // read, so their count is true and must survive.
  it('keeps the true count when a later page failed', () => {
    expect(historyProgressLabel(50, 214, true)).toBe('50 of 214 movements');
  });

  it('still states a genuinely empty ledger when the read SUCCEEDED', () => {
    expect(historyProgressLabel(0, 0, false)).toBe('0 movements');
    expect(historyProgressLabel(0, 0)).toBe('0 movements');
  });
});

describe('historyAmountLines', () => {
  it('shows the delta a receipt or an adjustment carries', () => {
    expect(historyAmountLines({ deltaLabel: '+20', movedLabel: null })).toEqual({
      primary: '+20',
      secondary: null,
    });
  });

  it('shows the moved quantity when a net-zero transfer is all there is', () => {
    expect(historyAmountLines({ deltaLabel: null, movedLabel: '10 moved' })).toEqual({
      primary: '10 moved',
      secondary: null,
    });
  });

  it('never drops one number in favour of the other', () => {
    // A row can carry both. Picking one with `??` is how a quantity silently
    // disappears from a ledger whose whole job is being complete.
    expect(historyAmountLines({ deltaLabel: '-5', movedLabel: '5 moved' })).toEqual({
      primary: '-5',
      secondary: '5 moved',
    });
  });

  it('says nothing when the row records no quantity at all', () => {
    // Pre-0231 transfers: net zero AND no moved_quantity. "0" would be a claim
    // the record does not support.
    expect(historyAmountLines({ deltaLabel: null, movedLabel: null })).toEqual({
      primary: null,
      secondary: null,
    });
  });
});

describe('formatHistoryWhen', () => {
  it('renders the absolute local date AND time, not a relative phrase', () => {
    const iso = '2026-07-22T21:42:19.250842+00:00';
    // Option-for-option identical to web's <LocalDateTime>
    // (apps/web/src/components/ui/local-datetime.tsx), so the browser and the
    // phone print the same instant the same way.
    expect(formatHistoryWhen(iso)).toBe(
      new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    // A clock time and a year are the two things the owner asked for.
    expect(formatHistoryWhen(iso)).toMatch(/:/);
    expect(formatHistoryWhen(iso)).toMatch(/\d{4}/);
  });

  it('renders NOTHING for a value that is not a date', () => {
    // "Invalid Date" on the screen that exists to answer "on what date and
    // time" would be worse than the em dash that started this.
    expect(formatHistoryWhen('')).toBeNull();
    expect(formatHistoryWhen('not-a-date')).toBeNull();
  });
});

describe('the owner’s real history, as the sheet renders it', () => {
  const rows = parseItemHistoryPage(pageOf(REAL_ROWS)).rows.map(formatHistoryMovement);
  const receipts = parseItemHistoryPage(pageOf(REAL_RECEIPT_ROWS)).rows.map(formatHistoryMovement);

  it('names the two manual adds, three minutes apart, and who made each', () => {
    const add = rows[3]!;
    expect(add.title).toBe('Stock added');
    expect(add.deltaLabel).toBe('+10');
    expect(add.onHandLabel).toBe('134 -> 144 on hand');
    expect(add.actorLabel).toBe('Peter Pete');
    expect(add.actorEmailLabel).toBe('pmathis@cvsouth.org');
    expect(add.noteLabel).toBe('Adding new stock into inventory.');
    expect(add.tone).toBe('pos');
  });

  it('names the manager who reversed one of them, and quotes his reason', () => {
    const removal = rows[2]!;
    expect(removal.title).toBe('Stock removed');
    expect(removal.deltaLabel).toBe('-10');
    expect(removal.actorLabel).toBe('Andrew Rosas');
    expect(removal.noteLabel).toBe('incorrectly moved inventory');
    expect(removal.onHandLabel).toBe('144 -> 134 on hand');
  });

  it('shows the put-away as a move between named places, not a quantity change', () => {
    const transfer = rows[1]!;
    expect(transfer.title).toBe('Stock transferred');
    expect(transfer.deltaLabel).toBeNull();
    expect(transfer.movedLabel).toBe('10 moved');
    expect(transfer.routeLabel).toBe('Staging -> 42-B');
    expect(transfer.tone).toBe('neutral');
  });

  it('shows the order pick’s five units leaving, even though it is a "transfer"', () => {
    // The activity feed assumes a transfer's quantity_change is always 0.
    // This row is movement_type='transfer' with quantity_change=-5 and no
    // moved_quantity; suppressing the number by TYPE would hide five units.
    const pick = rows[4]!;
    expect(pick.title).toBe('Stock transferred');
    expect(pick.deltaLabel).toBe('-5');
    expect(pick.movedLabel).toBeNull();
    expect(pick.noteLabel).toBe('Order pick');
    expect(pick.actorLabel).toBe('Daniel Hernandez');
    expect(pick.tone).toBe('neg');
  });

  it('shows nothing rather than a number for a pre-0231 transfer', () => {
    const legacy = rows[5]!;
    expect(legacy.deltaLabel).toBeNull();
    expect(legacy.movedLabel).toBeNull();
    expect(legacy.routeLabel).toBe('Staging -> 42-B');
    expect(legacy.noteLabel).toContain('Staging cleanup');
  });

  it('never renders an internal token as if a person had typed it', () => {
    // The opening count's reason is 'duplicate_initial_count'; the +90 add has
    // no reason at all. Both must show no note — not a token, not a uuid.
    expect(rows[7]!.title).toBe('Opening count');
    expect(rows[7]!.noteLabel).toBeNull();
    expect(rows[7]!.routeLabel).toBe('-> DC4');
    expect(rows[6]!.noteLabel).toBeNull();
  });

  it('states the posted receipt AND the PO status behind it', () => {
    const posted = receipts[0]!;
    expect(posted.title).toBe('Stock received');
    expect(posted.deltaLabel).toBe('+20');
    expect(posted.sourceLabel).toBe(
      'Receipt R-20260722-175600-e56648 - PO CVW-002201 (received)',
    );
    expect(posted.routeLabel).toBe('-> Staging');
    expect(posted.reversalLabel).toBeNull();
    // reason was the machine-composed 'PO CVW-002201' — the number is already
    // in sourceLabel, so it is not echoed as prose.
    expect(posted.noteLabel).toBeNull();
  });

  it('marks both halves of a received-then-reversed pair so they cannot be misread', () => {
    const undo = receipts[1]!;
    const received = receipts[2]!;
    expect(received.deltaLabel).toBe('+90');
    expect(undo.deltaLabel).toBe('-90');
    // Equal and opposite: without the link they read as 90 units that arrived
    // and 90 unrelated units that vanished.
    expect(received.reversalLabel).toBe(
      'Reversed later by R-20260624-224111-a00736-REV: Wrong rack entered (testing)',
    );
    expect(undo.reversalLabel).toBe(
      'Reverses R-20260624-224111-a00736: Wrong rack entered (testing)',
    );
    expect(received.tone).toBe('warn');
    expect(undo.tone).toBe('warn');
    expect(received.sourceLabel).toBe(
      'Receipt R-20260624-224111-a00736 (reversed) - PO PO-1782340858804 (cancelled)',
    );
  });

  it('never says a customer returned anything', () => {
    // cancel_order_request writes movement_type='return' for an internally
    // cancelled pick, so the title must state only what the record supports.
    const cancelled = formatHistoryMovement(
      parseItemHistoryPage(
        pageOf([
          {
            ...REAL_ROWS[0],
            movementType: 'return',
            note: 'Order cancelled',
          },
        ]),
      ).rows[0]!,
    );
    expect(cancelled.title).toBe('Returned to stock');
    expect(cancelled.title).not.toMatch(/customer/i);
    expect(cancelled.noteLabel).toBe('Order cancelled');
  });
});
