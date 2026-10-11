import {
  forbiddenRequesterKeys,
  parseReturnBody,
  RETURN_EXCHANGE_NOTE_MAX,
  RETURNS_COPY,
  type RequesterExchangeOptionsAnswer,
  type RequesterReturnSheet,
  type RequesterTrackingReturn,
} from '@stockpilot/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { OrderReturnView } from './order-returns';
import {
  buildRequesterReturnBody,
  chooseRequesterOption,
  draftHasSelection,
  draftWantsSizes,
  forgetRequesterDraft,
  forgetRequesterDrafts,
  newRequesterDraft,
  openRequesterDraft,
  parseRequesterExchangeOptions,
  parseRequesterReturnCreated,
  parseRequesterReturnSheet,
  recallRequesterDraft,
  reconcileDraftWithOptions,
  reconcileRequesterDraft,
  rememberRequesterDraft,
  REQUESTER_DRAFTS_MAX,
  requesterButtonShown,
  requesterExchangesOn,
  requesterLineAvailability,
  requesterLineExchangeView,
  requesterLineLabel,
  requesterLoadedSheet,
  requesterPhotoUrl,
  requesterReplacementQuantity,
  requesterRequestDate,
  requesterEntryWords,
  requesterReplacementQuantityOf,
  requesterReturnGate,
  requesterOrderReturns,
  requesterSentMessage,
  requesterSentTitle,
  requesterTrackingCard,
  setRequesterMode,
  setRequesterNote,
  setRequesterNotes,
  setRequesterReplacementQuantity,
  stepRequesterQuantity,
  toggleRequesterReason,
  restartRequesterDraft,
  type RequesterOptionsState,
} from './requester-returns';
import { rewriteWebPath } from './web-path-rewrite';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const L3 = '33333333-3333-4333-8333-333333333333';
const ITEM_M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_L = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_XL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORDER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const PHOTO = { url: 'https://x.supabase.co/storage/v1/object/sign/item-images/a.jpg?token=1', thumbUrl: 'https://x.supabase.co/t.jpg?token=2' };

/** What GET /api/v1/orders/[id]/return-request answers (with the route's echoes). */
function rawSheet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: 'org-1',
    orderId: ORDER,
    orderNumber: 'SO-000103',
    requesterName: 'Pat Lee',
    exchangesEnabled: true,
    lines: [
      { orderRequestLineId: L1, name: 'Walk Exchange Tee', sizeLabel: 'Size M', photo: PHOTO, quantityFulfilled: 2, quantityRemaining: 2 },
      { orderRequestLineId: L2, name: 'Walk Cap', sizeLabel: null, photo: null, quantityFulfilled: 1, quantityRemaining: 1 },
    ],
    tracking: [],
    ...over,
  };
}

function sheetOf(over: Record<string, unknown> = {}): RequesterReturnSheet {
  const s = parseRequesterReturnSheet(rawSheet(over));
  if (!s) throw new Error('fixture did not parse');
  return s;
}

const OPTIONS: RequesterExchangeOptionsAnswer = {
  exchangesEnabled: true,
  lines: [
    {
      orderRequestLineId: L1,
      options: [
        { itemId: ITEM_L, name: 'Walk Exchange Tee', sizeLabel: 'Size L', availability: 'available', photo: PHOTO },
        { itemId: ITEM_XL, name: 'Walk Exchange Tee', sizeLabel: 'Size XL', availability: 'not_in_stock', photo: null },
      ],
    },
  ],
};
const READY: RequesterOptionsState = { state: 'ready', answer: OPTIONS };

afterEach(() => forgetRequesterDrafts());

describe('reading the sheet (GET .../return-request)', () => {
  it("reads core's sheet field by field and keeps nothing else (no echoed organization or order id)", () => {
    const sheet = parseRequesterReturnSheet(rawSheet());
    expect(sheet).toEqual({
      orderNumber: 'SO-000103',
      requesterName: 'Pat Lee',
      exchangesEnabled: true,
      lines: [
        { orderRequestLineId: L1, name: 'Walk Exchange Tee', sizeLabel: 'Size M', photo: PHOTO, quantityFulfilled: 2, quantityRemaining: 2 },
        { orderRequestLineId: L2, name: 'Walk Cap', sizeLabel: null, photo: null, quantityFulfilled: 1, quantityRemaining: 1 },
      ],
      tracking: [],
    });
  });

  it('drops any key a requester may not see, so nothing the screens draw can carry one (brief 28, 32)', () => {
    const sheet = parseRequesterReturnSheet(
      rawSheet({
        warehouseId: 'wh',
        lines: [
          {
            orderRequestLineId: L1,
            name: 'Walk Exchange Tee',
            sizeLabel: 'Size M',
            photo: { ...PHOTO, storagePath: 'org/item/a.jpg' },
            quantityFulfilled: 2,
            quantityRemaining: 2,
            itemSku: 'WET-M',
            unitCost: 9.5,
            locationId: 'rack',
            disposition: 'restock',
          },
        ],
        tracking: [
          {
            returnNumber: 'RMA-1',
            createdAt: '2026-10-11T18:00:00.000Z',
            returnStatus: 'approved',
            exchangeStatus: 'waiting_for_return',
            sentences: ['Return approved. Bring or send the item back as arranged with the warehouse.'],
            replacementOrderNumber: 'SO-000104',
            notes: 'staff note',
            approvedByName: 'Dana',
            lines: [
              {
                returning: { name: 'Walk Exchange Tee', sizeLabel: 'Size M', quantity: 1, sku: 'WET-M' },
                exchange: { state: 'approved', replacement: { name: 'Walk Exchange Tee', sizeLabel: 'Size L', quantity: 1, free: 3 }, substituted: false, reason: 'x' },
              },
            ],
          },
        ],
      }),
    );
    expect(sheet).not.toBeNull();
    expect(forbiddenRequesterKeys(sheet)).toEqual([]);
    expect(JSON.stringify(sheet)).not.toMatch(/WET-M|9\.5|\brack\b|restock|staff note|Dana|storagePath/);
  });

  it('offers only lines that can still come back, once each, with whole quantities and lower-case ids', () => {
    const sheet = parseRequesterReturnSheet(
      rawSheet({
        lines: [
          { orderRequestLineId: L1.toUpperCase(), name: 'A', quantityFulfilled: '3', quantityRemaining: '2.7' },
          { orderRequestLineId: L1, name: 'A again', quantityFulfilled: 3, quantityRemaining: 2 },
          { orderRequestLineId: L2, name: 'Nothing left', quantityFulfilled: 1, quantityRemaining: 0 },
          { orderRequestLineId: L3, name: 'Negative', quantityFulfilled: 1, quantityRemaining: -1 },
          { orderRequestLineId: 'not-a-uuid', name: 'Bad id', quantityFulfilled: 1, quantityRemaining: 1 },
          null,
          'x',
        ],
      }),
    );
    expect(sheet?.lines).toEqual([
      { orderRequestLineId: L1, name: 'A', sizeLabel: null, photo: null, quantityFulfilled: 3, quantityRemaining: 2 },
    ]);
  });

  it('draws only a web address as a photo, and a nameless line reads "Item"', () => {
    const sheet = parseRequesterReturnSheet(
      rawSheet({
        lines: [
          { orderRequestLineId: L1, name: '  ', photo: { url: 'javascript:alert(1)', thumbUrl: null }, quantityFulfilled: 1, quantityRemaining: 1 },
          { orderRequestLineId: L2, name: 'B', photo: { url: 'http://127.0.0.1:54321/a.jpg', thumbUrl: 'file:///etc/passwd' }, quantityFulfilled: 1, quantityRemaining: 1 },
        ],
      }),
    );
    expect(sheet?.lines[0]).toMatchObject({ name: 'Item', photo: null });
    expect(sheet?.lines[1]?.photo).toEqual({ url: 'http://127.0.0.1:54321/a.jpg', thumbUrl: null });
  });

  it("reads the requester's own requests: the server's sentences as they came, each line's exchange", () => {
    const sheet = parseRequesterReturnSheet(
      rawSheet({
        tracking: [
          {
            returnNumber: 'RMA-2',
            createdAt: '2026-10-11T18:00:00.000Z',
            returnStatus: 'requested',
            exchangeStatus: 'requested',
            sentences: ['Exchange requested. The warehouse will review it.', 7, ''],
            replacementOrderNumber: null,
            lines: [
              { returning: { name: 'Walk Exchange Tee', sizeLabel: 'Size M', quantity: 1 }, exchange: { state: 'requested', replacement: null, substituted: false } },
              { returning: { name: 'Walk Cap', sizeLabel: null, quantity: 1 }, exchange: null },
              { returning: { name: 'Walk Sock', sizeLabel: null, quantity: 1 }, exchange: { state: 'teleported', replacement: null } },
              { returning: null },
            ],
          },
          { returnNumber: 'RMA-3', returnStatus: 'requested' },
          { returnNumber: 'RMA-4', createdAt: '2026-10-11T19:00:00.000Z', returnStatus: 'requested', exchangeStatus: 'nonsense', sentences: [], lines: [] },
        ],
      }),
    );
    expect(sheet?.tracking).toHaveLength(2);
    expect(sheet?.tracking[0]).toEqual({
      returnNumber: 'RMA-2',
      createdAt: '2026-10-11T18:00:00.000Z',
      returnStatus: 'requested',
      exchangeStatus: 'requested',
      sentences: ['Exchange requested. The warehouse will review it.'],
      replacementOrderNumber: null,
      lines: [
        { returning: { name: 'Walk Exchange Tee', sizeLabel: 'Size M', quantity: 1 }, exchange: { state: 'requested', replacement: null, substituted: false } },
        { returning: { name: 'Walk Cap', sizeLabel: null, quantity: 1 }, exchange: null },
        // An exchange state from a newer server is not drawn as one.
        { returning: { name: 'Walk Sock', sizeLabel: null, quantity: 1 }, exchange: null },
      ],
    });
    expect(sheet?.tracking[1]?.exchangeStatus).toBe('none');
  });

  it('is null for anything that is not that answer (an older server, a proxy page)', () => {
    expect(parseRequesterReturnSheet(null)).toBeNull();
    expect(parseRequesterReturnSheet('<html>')).toBeNull();
    expect(parseRequesterReturnSheet([])).toBeNull();
    expect(parseRequesterReturnSheet({ lines: [] })).toBeNull();
    expect(parseRequesterReturnSheet({ tracking: [] })).toBeNull();
    // The switch is on only when the server says so, exactly.
    expect(parseRequesterReturnSheet(rawSheet({ exchangesEnabled: 'true' }))?.exchangesEnabled).toBe(false);
  });
});

describe('reading the sizes (POST .../return-request/options)', () => {
  it("keeps the server's order, two states of availability, and nothing else (D6: never a count)", () => {
    const answer = parseRequesterExchangeOptions({
      organizationId: 'org',
      orderId: ORDER,
      exchangesEnabled: true,
      lines: [
        {
          orderRequestLineId: L1,
          options: [
            { itemId: ITEM_L, name: 'Walk Exchange Tee', sizeLabel: 'Size L', availability: 'available', photo: PHOTO, free: 14, sku: 'WET-L' },
            { itemId: ITEM_XL, name: 'Walk Exchange Tee', sizeLabel: 'Size XL', availability: 'something new', photo: null },
            { itemId: ITEM_L, name: 'dupe', availability: 'available' },
            { itemId: 'nope', name: 'bad id' },
          ],
        },
        { orderRequestLineId: L2, options: [] },
        { orderRequestLineId: L1, options: [{ itemId: ITEM_M, name: 'second copy of the line' }] },
      ],
    });
    expect(answer).toEqual({
      exchangesEnabled: true,
      lines: [
        {
          orderRequestLineId: L1,
          options: [
            { itemId: ITEM_L, name: 'Walk Exchange Tee', sizeLabel: 'Size L', availability: 'available', photo: PHOTO },
            { itemId: ITEM_XL, name: 'Walk Exchange Tee', sizeLabel: 'Size XL', availability: 'not_in_stock', photo: null },
          ],
        },
      ],
    });
    expect(forbiddenRequesterKeys(answer)).toEqual([]);
  });

  it('is null for anything else; exchanges are on only when the server says so', () => {
    expect(parseRequesterExchangeOptions(null)).toBeNull();
    expect(parseRequesterExchangeOptions({ exchangesEnabled: true })).toBeNull();
    expect(parseRequesterExchangeOptions({ exchangesEnabled: 1, lines: [] })).toEqual({ exchangesEnabled: false, lines: [] });
  });

  it("reads the request's answer: its id, its number and whether it was a replay", () => {
    expect(parseRequesterReturnCreated({ id: L3, returnNumber: 'RMA-9', replay: true, extra: 1 })).toEqual({ id: L3, returnNumber: 'RMA-9', replay: true });
    expect(parseRequesterReturnCreated({ id: L3 })).toEqual({ id: L3, returnNumber: null, replay: false });
    expect(parseRequesterReturnCreated({ returnNumber: 'RMA-9' })).toBeNull();
    expect(parseRequesterReturnCreated(null)).toBeNull();
  });
});

describe('who is offered "Return or exchange" (the web order page\'s rule)', () => {
  const own = {
    orderStatus: 'completed',
    requesterUserId: 'u1',
    viewerUserId: 'u1',
    viewerCanManageReturns: false,
    returnsModuleOn: true,
    fulfilledTotal: 2,
  };

  it('the requester of their own handed-over order, Returns on, something handed over', () => {
    expect(requesterReturnGate(own)).toBe(true);
    expect(requesterReturnGate({ ...own, orderStatus: 'delivered' })).toBe(true);
  });

  it('never another member, never a returns manager (they get Create return: never two buttons), never Returns off', () => {
    expect(requesterReturnGate({ ...own, viewerUserId: 'u2' })).toBe(false);
    expect(requesterReturnGate({ ...own, viewerUserId: null })).toBe(false);
    expect(requesterReturnGate({ ...own, requesterUserId: null, viewerUserId: null })).toBe(false);
    expect(requesterReturnGate({ ...own, viewerCanManageReturns: true })).toBe(false);
    expect(requesterReturnGate({ ...own, returnsModuleOn: false })).toBe(false);
  });

  it('never an order that cannot come back, or one with nothing handed over', () => {
    for (const status of ['pending_approval', 'approved', 'picking_complete', 'staged_for_pickup', 'in_transit', 'backordered', 'cancelled', 'denied', null]) {
      expect(requesterReturnGate({ ...own, orderStatus: status }), String(status)).toBe(false);
    }
    expect(requesterReturnGate({ ...own, fulfilledTotal: 0 })).toBe(false);
    expect(requesterReturnGate({ ...own, fulfilledTotal: Number.NaN })).toBe(false);
  });

  it("the button: the server's sheet decides once it answered; before that, the phone's own lines", () => {
    const sheet = sheetOf();
    const empty = sheetOf({ lines: [] });
    expect(requesterButtonShown({ gate: true, load: { state: 'ready', sheet }, phoneReturnable: 0 })).toBe(true);
    expect(requesterButtonShown({ gate: true, load: { state: 'ready', sheet: empty }, phoneReturnable: 3 })).toBe(false);
    // Still reading, read failed after an answer: the last answer decides.
    expect(requesterButtonShown({ gate: true, load: { state: 'loading', sheet: empty }, phoneReturnable: 3 })).toBe(false);
    expect(requesterButtonShown({ gate: true, load: { state: 'failed', sheet, message: 'x' }, phoneReturnable: 0 })).toBe(true);
    // Nothing answered yet (not asked, offline, or failing): the phone's own lines.
    expect(requesterButtonShown({ gate: true, load: { state: 'off' }, phoneReturnable: 1 })).toBe(true);
    expect(requesterButtonShown({ gate: true, load: { state: 'loading', sheet: null }, phoneReturnable: 1 })).toBe(true);
    expect(requesterButtonShown({ gate: true, load: { state: 'failed', sheet: null, message: 'x' }, phoneReturnable: 0 })).toBe(false);
    expect(requesterButtonShown({ gate: false, load: { state: 'ready', sheet }, phoneReturnable: 1 })).toBe(false);
  });

  // RX-3 merge: the web's link, token page and portal say "Request a return"
  // while the exchange kill switch holds exchanges back; the phone's button
  // and sheet title always said "Return or exchange".
  it('the button and the sheet title: Return or exchange, or Request a return while the server says exchanges are off', () => {
    const sheet = sheetOf();
    const off = sheetOf({ exchangesEnabled: false });
    expect(requesterEntryWords({ state: 'ready', sheet })).toBe('Return or exchange');
    expect(requesterEntryWords({ state: 'ready', sheet: off })).toBe('Request a return');
    expect(requesterEntryWords({ state: 'failed', sheet: off, message: 'x' })).toBe('Request a return');
    // Before the server answered: the words the button offers today.
    expect(requesterEntryWords({ state: 'off' })).toBe('Return or exchange');
    expect(requesterEntryWords({ state: 'loading', sheet: null })).toBe('Return or exchange');
  });

  it('never once the server said the order is a closed door, whatever the phone counts', () => {
    expect(requesterButtonShown({ gate: true, load: { state: 'closed' }, phoneReturnable: 2 })).toBe(false);
  });

  it('the sheet the screen may draw: the latest answer, kept while a read runs or after one failed', () => {
    const sheet = sheetOf();
    expect(requesterLoadedSheet({ state: 'ready', sheet })).toBe(sheet);
    expect(requesterLoadedSheet({ state: 'loading', sheet })).toBe(sheet);
    expect(requesterLoadedSheet({ state: 'failed', sheet, message: 'x' })).toBe(sheet);
    expect(requesterLoadedSheet({ state: 'off' })).toBeNull();
    expect(requesterLoadedSheet({ state: 'closed' })).toBeNull();
  });
});

describe("the order screen's returns, as the requester reads them", () => {
  const rma = (returnNumber: string | null, id: string): OrderReturnView => ({
    id,
    returnNumber,
    status: 'requested',
    reasonCode: null,
    notes: 'requester words',
    createdAt: '2026-10-11T18:00:00.000Z',
    closedAt: null,
    lines: [],
  });
  const tracked = (returnNumber: string | null): RequesterTrackingReturn => ({
    returnNumber,
    createdAt: '2026-10-11T18:00:00.000Z',
    returnStatus: 'requested',
    exchangeStatus: 'none',
    sentences: ['Return requested. The warehouse will review it.'],
    replacementOrderNumber: null,
    lines: [],
  });

  it('each own request once, as its tracking card; a return staff made on the order keeps its card (D15)', () => {
    const view = requesterOrderReturns({
      returns: [rma('RMA-1', 'r1'), rma('RMA-STAFF', 'r2')],
      tracking: [tracked('RMA-1')],
      requesterGate: true,
      canReadReturns: false,
    });
    expect(view.tracking.map((t) => t.returnNumber)).toEqual(['RMA-1']);
    expect(view.orderReturns.map((r) => r.id)).toEqual(['r2']);
  });

  // Re-pinned on purpose (RX-3 fix round 1, desk check M2): a requester who
  // can read returns (not manage) got no tracking on the phone while the web
  // showed it. One core rule now: the tracking for the requester gate, and
  // the order's card (which opens the RMA for them) kept.
  it("a requester with returns:read gets the tracking and keeps the order's card, as on the web", () => {
    const returns = [rma('RMA-1', 'r1')];
    const view = requesterOrderReturns({ returns, tracking: [tracked('RMA-1')], requesterGate: true, canReadReturns: true });
    expect(view.tracking.map((t) => t.returnNumber)).toEqual(['RMA-1']);
    expect(view.orderReturns).toEqual(returns);
  });

  it("without the tracking, or outside the requester gate, every return keeps the order's card", () => {
    const returns = [rma('RMA-1', 'r1')];
    expect(requesterOrderReturns({ returns, tracking: null, requesterGate: true, canReadReturns: false })).toEqual({ orderReturns: returns, tracking: [] });
    expect(requesterOrderReturns({ returns, tracking: [tracked('RMA-1')], requesterGate: false, canReadReturns: false })).toEqual({
      orderReturns: returns,
      tracking: [],
    });
  });

  it('a return with no number is never hidden (it cannot be matched)', () => {
    const view = requesterOrderReturns({ returns: [rma(null, 'r1')], tracking: [tracked(null)], requesterGate: true, canReadReturns: false });
    expect(view.orderReturns.map((r) => r.id)).toEqual(['r1']);
    expect(view.tracking).toHaveLength(1);
  });
});

describe('the draft', () => {
  const sheet = sheetOf();
  const m = sheet.lines[0]!;

  it('starts with nothing coming back and every line a return only, under the key it was given', () => {
    const d = newRequesterDraft(sheet.lines, KEY);
    expect(d).toEqual({
      key: KEY,
      lines: {
        [L1]: { quantity: 0, mode: 'return', itemId: null, note: '', replacementQuantity: null },
        [L2]: { quantity: 0, mode: 'return', itemId: null, note: '', replacementQuantity: null },
      },
      reasonCode: null,
      notes: '',
    });
    expect(draftHasSelection(d)).toBe(false);
    expect(draftWantsSizes(d)).toBe(false);
    expect(newRequesterDraft(sheet.lines).key).toMatch(/^[0-9a-f-]{36}$/);
  });

  // RX-3 merge: the web form starts the ONLY returnable line at what can come
  // back (the RX-2 staff create sheet's rule, web and phone); the phone's
  // requester sheet started every line at 0.
  it('an order with ONE line that can come back starts it at what is left; with several, nothing is chosen', () => {
    const one = sheetOf({
      lines: [
        { orderRequestLineId: L1, name: 'Walk Exchange Tee', sizeLabel: 'Size M', quantityFulfilled: 3, quantityRemaining: 2 },
        { orderRequestLineId: L2, name: 'Nothing left', quantityFulfilled: 1, quantityRemaining: 0 },
      ],
    });
    // (The sheet's parser drops a line with nothing left; the rule counts only lines that can come back.)
    expect(one.lines.map((l) => l.orderRequestLineId)).toEqual([L1]);
    const d = newRequesterDraft(one.lines, KEY);
    expect(d.lines[L1]).toEqual({ quantity: 2, mode: 'return', itemId: null, note: '', replacementQuantity: null });
    expect(draftHasSelection(d)).toBe(true);
    const withSpent = newRequesterDraft(
      [
        { orderRequestLineId: L1, quantityRemaining: 2 },
        { orderRequestLineId: L2, quantityRemaining: 0 },
      ],
      KEY,
    );
    expect(withSpent.lines[L1]!.quantity).toBe(2);
    expect(withSpent.lines[L2]!.quantity).toBe(0);
    // A new draft opened on the sheet follows the same rule.
    expect(openRequesterDraft({ scope: null, orderId: ORDER, sheet: one, mintKey: () => KEY }).lines[L1]!.quantity).toBe(2);
    expect(draftHasSelection(newRequesterDraft(sheet.lines, KEY))).toBe(false);
  });

  it('steps a whole number from 0 to what can come back', () => {
    let d = newRequesterDraft(sheet.lines, KEY);
    d = stepRequesterQuantity(d, m, -1);
    expect(d.lines[L1]!.quantity).toBe(0);
    d = stepRequesterQuantity(stepRequesterQuantity(stepRequesterQuantity(d, m, 1), m, 1), m, 1);
    expect(d.lines[L1]!.quantity).toBe(2);
    expect(draftHasSelection(d)).toBe(true);
  });

  it('Exchange, a size, back to Return only and back again keeps the size; a note is kept per line', () => {
    let d = stepRequesterQuantity(newRequesterDraft(sheet.lines, KEY), m, 1);
    d = setRequesterMode(d, L1, 'exchange');
    expect(draftWantsSizes(d)).toBe(true);
    d = chooseRequesterOption(d, L1, ITEM_L);
    d = setRequesterMode(d, L1, 'return');
    expect(d.lines[L1]).toEqual({ quantity: 1, mode: 'return', itemId: ITEM_L, note: '', replacementQuantity: null });
    expect(draftWantsSizes(d)).toBe(false);
    d = setRequesterMode(d, L1, 'exchange');
    expect(d.lines[L1]!.itemId).toBe(ITEM_L);
    d = setRequesterNote(d, L2, 'A blue one');
    expect(d.lines[L2]!.note).toBe('A blue one');
    // An exchange with nothing coming back asks for no sizes.
    expect(draftWantsSizes(stepRequesterQuantity(d, m, -1))).toBe(false);
  });

  // Re-pinned on purpose (RX-3 fix round 1, F3): a conflict starts the draft
  // over (nothing chosen, a new key), never a new key on the same choices.
  it('the reason toggles (optional), the notes are kept as typed, a conflict starts over with a new key and nothing chosen', () => {
    let d = newRequesterDraft(sheet.lines, KEY);
    d = toggleRequesterReason(d, 'damaged');
    expect(d.reasonCode).toBe('damaged');
    expect(toggleRequesterReason(d, 'damaged').reasonCode).toBeNull();
    expect(toggleRequesterReason(d, 'other').reasonCode).toBe('other');
    expect(setRequesterNotes(d, ' hi ').notes).toBe(' hi ');
    d = stepRequesterQuantity(d, m, 1);
    const fresh = restartRequesterDraft(setRequesterNotes(d, 'kept'));
    expect(fresh.key).not.toBe(KEY);
    expect(Object.values(fresh.lines).every((l) => l.quantity === 0 && l.mode === 'return' && l.itemId === null)).toBe(true);
    expect(fresh.reasonCode).toBe('damaged');
    expect(fresh.notes).toBe('kept');
  });

  it('checked against the sheet as it is now: lines gone are dropped, quantities fit, the key is kept', () => {
    let d = newRequesterDraft(sheet.lines, KEY);
    d = stepRequesterQuantity(stepRequesterQuantity(d, m, 1), m, 1);
    d = chooseRequesterOption(d, L1, ITEM_L);
    d = stepRequesterQuantity(d, sheet.lines[1]!, 1);
    const now = sheetOf({
      lines: [
        { orderRequestLineId: L1, name: 'Walk Exchange Tee', sizeLabel: 'Size M', quantityFulfilled: 2, quantityRemaining: 1 },
        { orderRequestLineId: L3, name: 'New line', quantityFulfilled: 1, quantityRemaining: 1 },
      ],
    });
    const r = reconcileRequesterDraft(d, now);
    expect(r.key).toBe(KEY);
    expect(r.lines).toEqual({
      [L1]: { quantity: 1, mode: 'exchange', itemId: ITEM_L, note: '', replacementQuantity: null },
      [L3]: { quantity: 0, mode: 'return', itemId: null, note: '', replacementQuantity: null },
    });
    // Exchanges off: every line a return only (what the sheet then shows).
    expect(reconcileRequesterDraft(d, { ...now, exchangesEnabled: false }).lines[L1]!.mode).toBe('return');
  });

  it('checked against the sizes: a size no longer offered is unchosen; exchanges turned off, a return only', () => {
    let d = stepRequesterQuantity(newRequesterDraft(sheet.lines, KEY), m, 1);
    d = chooseRequesterOption(d, L1, ITEM_M);
    expect(reconcileDraftWithOptions(d, OPTIONS).lines[L1]).toEqual({ quantity: 1, mode: 'exchange', itemId: null, note: '', replacementQuantity: null });
    const kept = chooseRequesterOption(d, L1, ITEM_L);
    expect(reconcileDraftWithOptions(kept, OPTIONS).lines[L1]!.itemId).toBe(ITEM_L);
    expect(reconcileDraftWithOptions(kept, { exchangesEnabled: false, lines: [] }).lines[L1]!.mode).toBe('return');
  });
});

describe('the draft in memory (per account, organization and order; never on the device)', () => {
  const sheet = sheetOf();
  const me = { userId: 'u1', orgId: 'o1' };

  it('opens on the remembered draft, checked against the sheet, its key kept; else a new key', () => {
    let minted = 0;
    const mint = () => {
      minted += 1;
      return KEY;
    };
    const first = openRequesterDraft({ scope: me, orderId: ORDER, sheet, mintKey: mint });
    expect(first.key).toBe(KEY);
    expect(minted).toBe(1);
    const chosen = stepRequesterQuantity({ ...first, key: 'kept-key' }, sheet.lines[0]!, 1);
    rememberRequesterDraft(me, ORDER, chosen);
    const again = openRequesterDraft({ scope: me, orderId: ORDER, sheet, mintKey: mint });
    expect(minted).toBe(1);
    expect(again.key).toBe('kept-key');
    expect(again.lines[L1]!.quantity).toBe(1);
  });

  it('another account, another organization or another order never sees it; a sent request forgets it', () => {
    const d = newRequesterDraft(sheet.lines, KEY);
    rememberRequesterDraft(me, ORDER, d);
    expect(recallRequesterDraft(me, ORDER)).toBe(d);
    expect(recallRequesterDraft({ userId: 'u2', orgId: 'o1' }, ORDER)).toBeNull();
    expect(recallRequesterDraft({ userId: 'u1', orgId: 'o2' }, ORDER)).toBeNull();
    expect(recallRequesterDraft(me, L1)).toBeNull();
    expect(recallRequesterDraft(null, ORDER)).toBeNull();
    forgetRequesterDraft(me, ORDER);
    expect(recallRequesterDraft(me, ORDER)).toBeNull();
    // No scope (signed out): nothing is kept.
    rememberRequesterDraft(null, ORDER, d);
    expect(recallRequesterDraft(me, ORDER)).toBeNull();
  });

  it(`keeps at most ${REQUESTER_DRAFTS_MAX} drafts, the oldest forgotten first`, () => {
    for (let i = 0; i <= REQUESTER_DRAFTS_MAX; i += 1) rememberRequesterDraft(me, `order-${i}`, newRequesterDraft([], `k${i}`));
    expect(recallRequesterDraft(me, 'order-0')).toBeNull();
    expect(recallRequesterDraft(me, 'order-1')?.key).toBe('k1');
    expect(recallRequesterDraft(me, `order-${REQUESTER_DRAFTS_MAX}`)?.key).toBe(`k${REQUESTER_DRAFTS_MAX}`);
  });
});

describe("a line's REPLACEMENT once Exchange is chosen", () => {
  it('its sizes as radio rows: the name and size, the availability word, the photo (thumbnail first), never a SKU', () => {
    const view = requesterLineExchangeView(READY, L1, true);
    expect(view).toEqual({
      kind: 'options',
      rows: [
        {
          itemId: ITEM_L,
          label: 'Walk Exchange Tee, L',
          availability: 'Available',
          available: true,
          photoUrl: PHOTO.thumbUrl,
          accessibilityLabel: 'Walk Exchange Tee, L. Available',
        },
        {
          itemId: ITEM_XL,
          label: 'Walk Exchange Tee, XL',
          availability: 'Not in stock right now',
          available: false,
          photoUrl: null,
          accessibilityLabel: 'Walk Exchange Tee, XL. Not in stock right now',
        },
      ],
    });
  });

  it('a line with no other size: the warehouse reviews it (with a note)', () => {
    expect(requesterLineExchangeView(READY, L2, true)).toEqual({ kind: 'review' });
  });

  it('where the sizes are: loading, offline (never asked), failed with its words', () => {
    expect(requesterLineExchangeView({ state: 'idle' }, L1, true)).toEqual({ kind: 'loading' });
    expect(requesterLineExchangeView({ state: 'loading' }, L1, true)).toEqual({ kind: 'loading' });
    expect(requesterLineExchangeView({ state: 'idle' }, L1, false)).toEqual({ kind: 'offline' });
    expect(requesterLineExchangeView({ state: 'failed', message: RETURNS_COPY.requesterOptionsUnavailable }, L1, true)).toEqual({
      kind: 'failed',
      message: "Couldn't load the other sizes. Try again.",
    });
  });

  it('exchanges are offered while the sheet says so and no sizes answer since said they were turned off', () => {
    const sheet = sheetOf();
    expect(requesterExchangesOn(sheet, { state: 'idle' })).toBe(true);
    expect(requesterExchangesOn(sheet, READY)).toBe(true);
    expect(requesterExchangesOn(sheet, { state: 'ready', answer: { exchangesEnabled: false, lines: [] } })).toBe(false);
    expect(requesterExchangesOn({ exchangesEnabled: false }, READY)).toBe(false);
  });

  it("the photo: the stored thumbnail, else the master, else none (the screen's empty box)", () => {
    expect(requesterPhotoUrl(PHOTO)).toBe(PHOTO.thumbUrl);
    expect(requesterPhotoUrl({ url: PHOTO.url, thumbUrl: null })).toBe(PHOTO.url);
    expect(requesterPhotoUrl(null)).toBeNull();
  });
});

describe('the request (POST .../return-request)', () => {
  const sheet = sheetOf();
  const m = sheet.lines[0]!;
  const cap = sheet.lines[1]!;
  const base = () => newRequesterDraft(sheet.lines, KEY);
  const build = (draft = base(), options: RequesterOptionsState = READY, exchangesOn = true) =>
    buildRequesterReturnBody({ sheet, draft, options, exchangesOn });

  it('asks for at least one line', () => {
    expect(build()).toEqual({ ok: false, error: 'Pick at least one item to return.' });
  });

  it('a return only: the line and its quantity, the key the sheet opened with, nothing else', () => {
    const d = toggleRequesterReason(setRequesterNotes(stepRequesterQuantity(base(), m, 1), '  It is too small.  '), 'wrong_item');
    const r = build(d);
    expect(r).toEqual({
      ok: true,
      exchange: false,
      body: { reasonCode: 'wrong_item', notes: 'It is too small.', lines: [{ orderRequestLineId: L1, quantity: 1 }], idempotencyKey: KEY },
    });
  });

  it('an exchange for a size: that size, the quantity the line sends back (brief 4)', () => {
    let d = stepRequesterQuantity(stepRequesterQuantity(base(), m, 1), m, 1);
    d = chooseRequesterOption(d, L1, ITEM_L);
    expect(build(d)).toEqual({
      ok: true,
      exchange: true,
      body: { lines: [{ orderRequestLineId: L1, quantity: 2, exchange: { itemId: ITEM_L, quantity: 2 } }], idempotencyKey: KEY },
    });
  });

  // RX-3 merge: the web lets the requester ask for fewer replacements than
  // they send back (brief 4: never more); the phone always sent the return
  // quantity.
  it('the replacement quantity follows the return quantity until chosen, from 1 to the return quantity (brief 4)', () => {
    let d = chooseRequesterOption(stepRequesterQuantity(stepRequesterQuantity(base(), m, 1), m, 1), L1, ITEM_L);
    expect(requesterReplacementQuantityOf(d.lines[L1]!)).toBe(2);
    d = setRequesterReplacementQuantity(d, L1, 1);
    expect(requesterReplacementQuantityOf(d.lines[L1]!)).toBe(1);
    expect(build(d)).toEqual({
      ok: true,
      exchange: true,
      body: { lines: [{ orderRequestLineId: L1, quantity: 2, exchange: { itemId: ITEM_L, quantity: 1 } }], idempotencyKey: KEY },
    });
    // Never above what goes back, never below 1, whole numbers only.
    expect(setRequesterReplacementQuantity(d, L1, 5).lines[L1]!.replacementQuantity).toBe(2);
    expect(setRequesterReplacementQuantity(d, L1, 0).lines[L1]!.replacementQuantity).toBe(1);
    expect(setRequesterReplacementQuantity(d, L1, 1.7).lines[L1]!.replacementQuantity).toBe(1);
    // Sending fewer back lowers the replacement with it.
    const fewer = stepRequesterQuantity(setRequesterReplacementQuantity(d, L1, 2), m, -1);
    expect(requesterReplacementQuantityOf(fewer.lines[L1]!)).toBe(1);
    const sent = build(fewer);
    expect(sent.ok && sent.body.lines[0]!.exchange).toEqual({ itemId: ITEM_L, quantity: 1 });
  });

  it('an exchange asks for one of the line\'s own sizes (never anything else: brief 6, 32)', () => {
    const d = setRequesterMode(stepRequesterQuantity(base(), m, 1), L1, 'exchange');
    expect(build(d)).toEqual({ ok: false, error: 'Choose a size for Walk Exchange Tee, M.' });
    expect(build(chooseRequesterOption(d, L1, ITEM_M))).toEqual({ ok: false, error: 'Choose a size for Walk Exchange Tee, M.' });
  });

  it('a line with no other size: the warehouse reviews it, with a note of up to 500 characters', () => {
    const d = setRequesterMode(stepRequesterQuantity(base(), cap, 1), L2, 'exchange');
    expect(build(d)).toEqual({ ok: false, error: 'Tell the warehouse what you need for Walk Cap.' });
    expect(build(setRequesterNote(d, L2, ' A navy one '))).toEqual({
      ok: true,
      exchange: true,
      body: { lines: [{ orderRequestLineId: L2, quantity: 1, exchange: { note: 'A navy one', quantity: 1 } }], idempotencyKey: KEY },
    });
    expect(build(setRequesterNote(d, L2, 'x'.repeat(RETURN_EXCHANGE_NOTE_MAX + 1)))).toEqual({ ok: false, error: 'At most 500 characters.' });
  });

  it('nothing about an exchange is sent before its sizes arrive', () => {
    const d = chooseRequesterOption(stepRequesterQuantity(base(), m, 1), L1, ITEM_L);
    for (const options of [{ state: 'failed', message: 'x' }, { state: 'loading' }, { state: 'idle' }] as RequesterOptionsState[]) {
      expect(build(d, options)).toEqual({ ok: false, error: "Couldn't load the other sizes. Try again." });
    }
  });

  it('while exchanges are off every line is a return only (the sheet shows it so first)', () => {
    const d = chooseRequesterOption(stepRequesterQuantity(base(), m, 1), L1, ITEM_L);
    expect(build(d, READY, false)).toEqual({
      ok: true,
      exchange: false,
      body: { lines: [{ orderRequestLineId: L1, quantity: 1 }], idempotencyKey: KEY },
    });
  });

  it('never more than can come back, and the notes within 2,000 characters', () => {
    const over = { ...base(), lines: { ...base().lines, [L1]: { quantity: 3, mode: 'return' as const, itemId: null, note: '', replacementQuantity: null } } };
    expect(build(over)).toEqual({ ok: false, error: 'Only 2 of "Walk Exchange Tee, M" can still be returned.' });
    expect(build(setRequesterNotes(stepRequesterQuantity(base(), m, 1), 'x'.repeat(2001)))).toEqual({ ok: false, error: 'At most 2000 characters.' });
  });

  it("every body passes core's requester schema, and carries only what the requester may ask for", () => {
    let d = stepRequesterQuantity(base(), m, 2);
    d = chooseRequesterOption(d, L1, ITEM_XL);
    d = setRequesterNote(setRequesterMode(stepRequesterQuantity(d, cap, 1), L2, 'exchange'), L2, 'navy');
    const r = build(d);
    if (!r.ok) throw new Error(r.error);
    expect(parseReturnBody('requester', r.body).ok).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(['idempotencyKey', 'lines']);
    for (const line of r.body.lines) {
      expect(Object.keys(line).every((k) => ['orderRequestLineId', 'quantity', 'exchange'].includes(k))).toBe(true);
      expect(Object.keys(line.exchange ?? {}).every((k) => ['itemId', 'note', 'quantity'].includes(k))).toBe(true);
    }
  });

  it("the alert after the server answered, in core's words", () => {
    expect(requesterSentTitle(true)).toBe('We received your exchange request.');
    expect(requesterSentTitle(false)).toBe('We received your return request.');
    // RX-3 merge: the web's "Your reference is RMA-…." (the phone showed the bare number).
    expect(requesterSentMessage('RMA-20261011-ABC123')).toBe('Your reference is RMA-20261011-ABC123.');
    expect(requesterSentMessage(null)).toBeUndefined();
  });
});

describe("the requester's own requests (brief 28)", () => {
  const request: RequesterTrackingReturn = {
    returnNumber: 'RMA-20261011-ABC123',
    createdAt: '2026-10-11T18:00:00.000Z',
    returnStatus: 'approved',
    exchangeStatus: 'waiting_for_return',
    sentences: [
      'Return approved. Bring or send the item back as arranged with the warehouse.',
      'Replacement reserved. Waiting for your return.',
    ],
    replacementOrderNumber: 'SO-000104',
    lines: [
      {
        returning: { name: 'Walk Exchange Tee', sizeLabel: 'Size M', quantity: 1 },
        exchange: { state: 'approved', replacement: { name: 'Walk Exchange Tee', sizeLabel: 'Size XL', quantity: 1 }, substituted: true },
      },
      { returning: { name: 'Walk Cap', sizeLabel: null, quantity: 2 }, exchange: { state: 'requested', replacement: null, substituted: false } },
      { returning: { name: 'Walk Sock', sizeLabel: null, quantity: 1 }, exchange: null },
    ],
  };

  it("reads as the token page's card: number and date, each line both ways, the sentences, the replacement order", () => {
    const v = requesterTrackingCard(request, { timeZone: 'America/Los_Angeles' });
    expect(v.title).toBe('RMA-20261011-ABC123');
    expect(v.date).toBe('Oct 11, 2026');
    expect(v.sentences).toEqual(request.sentences);
    expect(v.lines).toEqual([
      { key: '0', returning: 'Walk Exchange Tee, M ×1', replacement: 'Walk Exchange Tee, XL ×1', state: 'Approved', changed: 'Changed by the warehouse' },
      { key: '1', returning: 'Walk Cap ×2', replacement: 'Warehouse will review', state: 'Requested', changed: null },
      { key: '2', returning: 'Walk Sock ×1', replacement: null, state: null, changed: null },
    ]);
    expect(v.replacementOrder).toBe('Replacement order: SO-000104');
  });

  // Re-pinned on purpose (RX-3 fix round 1, desk check L2): the screen shows
  // the title, the sentences, the lines, then the SO (requester-tracking-card
  // .tsx), and VoiceOver read the sentences last.
  it('is one VoiceOver label with the same words in the order the screen shows them', () => {
    expect(requesterTrackingCard(request, { timeZone: 'UTC' }).accessibilityLabel).toBe(
      'RMA-20261011-ABC123, Oct 11, 2026. Return approved. Bring or send the item back as arranged with the warehouse. Replacement reserved. Waiting for your return. Returning: Walk Exchange Tee, M ×1. Replacement: Walk Exchange Tee, XL ×1, Approved, Changed by the warehouse. Returning: Walk Cap ×2. Replacement: Warehouse will review, Requested. Returning: Walk Sock ×1. Replacement order: SO-000104.',
    );
  });

  // RX-3 fix round 1 (desk check M3): a note-only request the warehouse
  // declined read "Warehouse will review · Declined".
  it('a declined or cancelled note-only request reads "A different replacement", never "Warehouse will review"', () => {
    for (const state of ['declined', 'cancelled'] as const) {
      const v = requesterTrackingCard({
        ...request,
        lines: [{ returning: { name: 'Walk Cap', sizeLabel: null, quantity: 1 }, exchange: { state, replacement: null, substituted: false } }],
      });
      expect(v.lines[0]?.replacement, state).toBe('A different replacement');
      expect(v.accessibilityLabel, state).not.toContain('Warehouse will review');
    }
  });

  it('never names a rack, Staging, a disposition, a cost, a note, a reason or a staff member', () => {
    const v = requesterTrackingCard(request);
    // ("Changed by the warehouse" is core's words for a substitution; no
    // person is ever named.)
    expect(JSON.stringify(v)).not.toMatch(/\b(rack|staging|restock|scrap|disposition|cost|notes?|reasons?)\b/i);
  });

  it('a request with no number still has a title; an unreadable date passes through', () => {
    expect(requesterTrackingCard({ ...request, returnNumber: null }).title).toBe('Return request');
    expect(requesterRequestDate('soon')).toBe('soon');
  });
});

describe("the sheet's line words", () => {
  it('the name and size, what can come back, and the replacement quantity', () => {
    const sheet = sheetOf();
    expect(requesterLineLabel(sheet.lines[0]!)).toBe('Walk Exchange Tee, M');
    expect(requesterLineLabel(sheet.lines[1]!)).toBe('Walk Cap');
    expect(requesterLineAvailability(sheet.lines[0]!)).toBe('2 of 2 returnable');
    expect(requesterReplacementQuantity(2)).toBe('Qty requested: 2');
  });
});

describe('the requester notifications open the order on the phone (feedback_notification_routes_must_map)', () => {
  it("RX-3's exchange_request_received and exchange_declined link /dashboard/orders/<order>, which opens the order screen", () => {
    expect(rewriteWebPath(`/dashboard/orders/${ORDER}`)).toBe(`/order/${ORDER}`);
  });
});
