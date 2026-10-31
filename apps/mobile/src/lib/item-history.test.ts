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
 * The fixtures below model the owner's 2026-07-22 report for one SKU, shaped
 * exactly as GET /api/v1/items/[id]/history answers them. The people, ids,
 * item, notes, receipt and PO numbers are synthetic; the times and quantities
 * keep the incident's shape. They tell the incident's story: two manual adds
 * by two different people minutes apart, a removal reasoned "moved to the
 * wrong rack", a posted receipt on PO DEMO-002201, a received-then-reversed
 * pair on a cancelled PO, an order pick recorded as a transfer with a real
 * negative delta, an opening count and a duplicate_initial_count.
 *
 * What is asserted is the WHOLE rendered sentence for each, because the bar the
 * owner set is "could I have answered my own question from this screen" — not
 * "does the parser return an object".
 */

/** Movements on the 144-on-hand record (item a0000016…), newest first. */
const INCIDENT_ROWS = [
  {
    id: '60000012-0000-4000-8000-000000000012',
    at: '2026-07-22T23:15:20.420364+00:00',
    movementType: 'adjust',
    quantityChange: 10,
    movedQuantity: null,
    previousQuantity: 134,
    newQuantity: 144,
    actorName: 'Pat Tester',
    actorEmail: 'ptester@school.test',
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
    id: '3000000a-0000-4000-8000-00000000000a',
    at: '2026-07-22T22:20:11.38873+00:00',
    movementType: 'transfer',
    quantityChange: 0,
    movedQuantity: 10,
    previousQuantity: 134,
    newQuantity: 134,
    actorName: 'Jordan Stone',
    actorEmail: 'jstone@site1.test',
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
    id: 'd000001a-0000-4000-8000-00000000001a',
    at: '2026-07-22T21:42:19.250842+00:00',
    movementType: 'remove',
    quantityChange: -10,
    movedQuantity: null,
    previousQuantity: 144,
    newQuantity: 134,
    actorName: 'Jordan Stone',
    actorEmail: 'jstone@site1.test',
    fromLocationName: null,
    toLocationName: null,
    note: 'moved to the wrong rack',
    receiptNumber: null,
    receiptStatus: null,
    poNumber: null,
    poStatus: null,
    reversalReason: null,
    reversal: null,
  },
  {
    id: '10000002-0000-4000-8000-000000000002',
    at: '2026-07-22T21:16:28.910114+00:00',
    movementType: 'add',
    quantityChange: 10,
    movedQuantity: null,
    previousQuantity: 134,
    newQuantity: 144,
    actorName: 'Pat Tester',
    actorEmail: 'ptester@school.test',
    fromLocationName: null,
    toLocationName: null,
    note: 'Added new stock to the shelf.',
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
    id: '5000000e-0000-4000-8000-00000000000e',
    at: '2026-07-06T22:21:08.621573+00:00',
    movementType: 'transfer',
    quantityChange: -5,
    movedQuantity: null,
    previousQuantity: 139,
    newQuantity: 134,
    actorName: 'Devon Keller',
    actorEmail: 'dkeller@site1.test',
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
    id: '20000006-0000-4000-8000-000000000006',
    at: '2026-07-01T18:46:27.040704+00:00',
    movementType: 'transfer',
    quantityChange: 0,
    movedQuantity: null,
    previousQuantity: 139,
    newQuantity: 139,
    actorName: 'Carsten Hartley Fowler',
    actorEmail: 'owner@example.com',
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
    id: '20000005-0000-4000-8000-000000000005',
    at: '2026-07-01T17:12:33.730822+00:00',
    movementType: 'add',
    quantityChange: 90,
    movedQuantity: null,
    previousQuantity: 49,
    newQuantity: 139,
    actorName: 'Pat Tester',
    actorEmail: 'ptester@school.test',
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
    id: '4000000b-0000-4000-8000-00000000000b',
    at: '2026-06-25T04:51:08.134623+00:00',
    movementType: 'initial',
    quantityChange: 49,
    movedQuantity: null,
    previousQuantity: 0,
    newQuantity: 49,
    actorName: 'Jordan Stone',
    actorEmail: 'jstone@site1.test',
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

/** Receiving movements on the 46-on-hand record (item 50000010…). */
const INCIDENT_RECEIPT_ROWS = [
  {
    // The posted receipt. Note the PO is 'received' but the SAME PO number
    // appears below on rows that were reversed — status has to be stated.
    id: '90000015-0000-4000-8000-000000000015',
    at: '2026-07-22T17:56:00.52597+00:00',
    movementType: 'receive_po',
    quantityChange: 20,
    movedQuantity: null,
    previousQuantity: 34,
    newQuantity: 54,
    actorName: 'Jordan Stone',
    actorEmail: 'jstone@site1.test',
    fromLocationName: null,
    toLocationName: 'Staging',
    note: null,
    receiptNumber: 'R-20260722-175600-0a0a01',
    receiptStatus: 'posted',
    poNumber: 'DEMO-002201',
    poStatus: 'received',
    reversalReason: null,
    reversal: null,
  },
  {
    id: '60000011-0000-4000-8000-000000000011',
    at: '2026-06-24T22:42:28.314144+00:00',
    movementType: 'correction',
    quantityChange: -90,
    movedQuantity: null,
    previousQuantity: 129,
    newQuantity: 39,
    actorName: 'Carsten Hartley Fowler',
    actorEmail: 'owner@example.com',
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: 'R-20260624-224111-0b0b02-REV',
    receiptStatus: 'reversal',
    poNumber: 'PO-1700000000101',
    poStatus: 'cancelled',
    reversalReason: 'Wrong rack entered (testing)',
    // status='reversal' → this movement IS the undo.
    reversal: {
      role: 'reversal' as const,
      counterpartMovementId: '20000009-0000-4000-8000-000000000009',
      counterpartReceiptNumber: 'R-20260624-224111-0b0b02',
    },
  },
  {
    id: '20000009-0000-4000-8000-000000000009',
    at: '2026-06-24T22:41:11.339279+00:00',
    movementType: 'receive_po',
    quantityChange: 90,
    movedQuantity: null,
    previousQuantity: 39,
    newQuantity: 129,
    actorName: 'Carsten Hartley Fowler',
    actorEmail: 'owner@example.com',
    fromLocationName: null,
    toLocationName: null,
    note: null,
    receiptNumber: 'R-20260624-224111-0b0b02',
    receiptStatus: 'reversed',
    poNumber: 'PO-1700000000101',
    poStatus: 'cancelled',
    reversalReason: 'Wrong rack entered (testing)',
    reversal: {
      role: 'reversed' as const,
      counterpartMovementId: '60000011-0000-4000-8000-000000000011',
      counterpartReceiptNumber: 'R-20260624-224111-0b0b02-REV',
    },
  },
] as const;

function pageOf(rows: readonly unknown[], extra: Record<string, unknown> = {}) {
  return {
    itemId: 'a0000016-0000-4000-8000-000000000016',
    itemName: 'Exploring Earth & Space Science: Level 8',
    itemSku: 'SP-0DEM2-BK1',
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
    expect(itemHistoryPath('a0000016-0000-4000-8000-000000000016')).toBe(
      '/api/v1/items/a0000016-0000-4000-8000-000000000016/history?limit=50&offset=0',
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
  it('reads the payload verbatim', () => {
    const page = parseItemHistoryPage(pageOf(INCIDENT_ROWS, { total: 24, hasMore: true }));
    expect(page.itemSku).toBe('SP-0DEM2-BK1');
    expect(page.rows).toHaveLength(INCIDENT_ROWS.length);
    expect(page.total).toBe(24);
    expect(page.hasMore).toBe(true);
    expect(page.rows[0]?.actorName).toBe('Pat Tester');
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
        { ...INCIDENT_ROWS[0] },
        { ...INCIDENT_ROWS[1], id: null },
        { ...INCIDENT_ROWS[2], at: '' },
        'not-a-row',
      ]),
    );
    expect(page.rows.map((r) => r.id)).toEqual(['60000012-0000-4000-8000-000000000012']);
  });

  it('never lets a missing count under-report the rows it is showing', () => {
    // A payload without `total` must not make the sheet claim fewer movements
    // than are already on screen.
    const page = parseItemHistoryPage(pageOf(INCIDENT_ROWS, { total: undefined }));
    expect(page.total).toBe(INCIDENT_ROWS.length);
    const lying = parseItemHistoryPage(pageOf(INCIDENT_ROWS, { total: 2 }));
    expect(lying.total).toBe(INCIDENT_ROWS.length);
  });

  it('only believes hasMore when the server actually said it', () => {
    expect(parseItemHistoryPage(pageOf(INCIDENT_ROWS, { hasMore: 'yes' })).hasMore).toBe(false);
    expect(parseItemHistoryPage(pageOf(INCIDENT_ROWS, { hasMore: 1 })).hasMore).toBe(false);
    expect(parseItemHistoryPage(pageOf(INCIDENT_ROWS, { hasMore: true })).hasMore).toBe(true);
  });

  it('drops a reversal marker whose role it does not understand', () => {
    // Marking a movement as half of a reversal pair on the strength of a string
    // we cannot interpret would be a guess — exactly what this rebuild removed.
    const page = parseItemHistoryPage(
      pageOf([
        { ...INCIDENT_RECEIPT_ROWS[2], reversal: { role: 'maybe', counterpartReceiptNumber: 'R-1' } },
      ]),
    );
    expect(page.rows[0]?.reversal).toBeNull();
  });

  it('keeps an absent actor absent', () => {
    const page = parseItemHistoryPage(
      pageOf([{ ...INCIDENT_ROWS[0], actorName: null, actorEmail: null }]),
    );
    expect(page.rows[0]?.actorName).toBeNull();
    expect(page.rows[0]?.actorEmail).toBeNull();
    expect(formatHistoryMovement(page.rows[0]!).actorLabel).toBeNull();
  });
});

describe('paging', () => {
  it('starts the next window past the rows actually delivered', () => {
    const page = parseItemHistoryPage(pageOf(INCIDENT_ROWS, { offset: 50, hasMore: true }));
    expect(nextHistoryOffset(page)).toBe(50 + INCIDENT_ROWS.length);
  });

  it('never tells the same movement twice when a write shifts the window', () => {
    // Newest-first paging: a movement written between page 1 and page 2 pushes
    // every later row down one, so page 2 re-delivers page 1's last row. Told
    // twice, a receipt reads as stock that arrived twice.
    const first = parseItemHistoryPage(pageOf(INCIDENT_ROWS.slice(0, 4))).rows;
    const second = parseItemHistoryPage(pageOf(INCIDENT_ROWS.slice(3))).rows;
    const merged = appendHistoryMovements(first, second);
    expect(merged.map((m) => m.id)).toEqual(INCIDENT_ROWS.map((m) => m.id));
    expect(new Set(merged.map((m) => m.id)).size).toBe(merged.length);
  });

  it('preserves the order rows arrived in', () => {
    const rows = parseItemHistoryPage(pageOf(INCIDENT_ROWS)).rows;
    expect(appendHistoryMovements([], rows).map((m) => m.at)).toEqual(
      INCIDENT_ROWS.map((m) => m.at),
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

describe('the owner’s reported history, as the sheet renders it', () => {
  const rows = parseItemHistoryPage(pageOf(INCIDENT_ROWS)).rows.map(formatHistoryMovement);
  const receipts = parseItemHistoryPage(pageOf(INCIDENT_RECEIPT_ROWS)).rows.map(formatHistoryMovement);

  it('names the two manual adds, three minutes apart, and who made each', () => {
    const add = rows[3]!;
    expect(add.title).toBe('Stock added');
    expect(add.deltaLabel).toBe('+10');
    expect(add.onHandLabel).toBe('134 -> 144 on hand');
    expect(add.actorLabel).toBe('Pat Tester');
    expect(add.actorEmailLabel).toBe('ptester@school.test');
    expect(add.noteLabel).toBe('Added new stock to the shelf.');
    expect(add.tone).toBe('pos');
  });

  it('names the manager who reversed one of them, and quotes his reason', () => {
    const removal = rows[2]!;
    expect(removal.title).toBe('Stock removed');
    expect(removal.deltaLabel).toBe('-10');
    expect(removal.actorLabel).toBe('Jordan Stone');
    expect(removal.noteLabel).toBe('moved to the wrong rack');
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
    expect(pick.actorLabel).toBe('Devon Keller');
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
      'Receipt R-20260722-175600-0a0a01 - PO DEMO-002201 (received)',
    );
    expect(posted.routeLabel).toBe('-> Staging');
    expect(posted.reversalLabel).toBeNull();
    // reason was the machine-composed 'PO DEMO-002201' — the number is already
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
      'Reversed later by R-20260624-224111-0b0b02-REV: Wrong rack entered (testing)',
    );
    expect(undo.reversalLabel).toBe(
      'Reverses R-20260624-224111-0b0b02: Wrong rack entered (testing)',
    );
    expect(received.tone).toBe('warn');
    expect(undo.tone).toBe('warn');
    expect(received.sourceLabel).toBe(
      'Receipt R-20260624-224111-0b0b02 (reversed) - PO PO-1700000000101 (cancelled)',
    );
  });

  it('never says a customer returned anything', () => {
    // cancel_order_request writes movement_type='return' for an internally
    // cancelled pick, so the title must state only what the record supports.
    const cancelled = formatHistoryMovement(
      parseItemHistoryPage(
        pageOf([
          {
            ...INCIDENT_ROWS[0],
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
