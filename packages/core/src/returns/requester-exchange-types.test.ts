import { describe, expect, it } from 'vitest';

import {
  EXCHANGE_STATUSES,
  exchangeRequesterSentence,
  requesterReturnStatusSentence,
  requesterTrackingSentences,
  type ExchangeStatus,
} from './exchange-status';
import {
  orderRequesterOptions,
  REQUESTER_AVAILABILITY_WORDS,
  REQUESTER_EXCHANGE_LINE_KEYS,
  REQUESTER_EXCHANGE_OPTION_KEYS,
  REQUESTER_EXCHANGE_OPTIONS_ANSWER_KEYS,
  forbiddenRequesterKeys,
  isForbiddenRequesterKey,
  REQUESTER_PHOTO_KEYS,
  REQUESTER_RETURN_SHEET_KEYS,
  REQUESTER_RETURNABLE_LINE_KEYS,
  REQUESTER_TRACKING_EXCHANGE_KEYS,
  REQUESTER_TRACKING_ITEM_KEYS,
  REQUESTER_TRACKING_LINE_KEYS,
  REQUESTER_TRACKING_RETURN_KEYS,
  requesterAvailability,
  requesterRefusalRecovery,
  requesterReturnsView,
  requesterTrackingLineWords,
  type RequesterExchangeLine,
  type RequesterExchangeOption,
  type RequesterExchangeOptionsAnswer,
  type RequesterPhoto,
  type RequesterReturnableLine,
  type RequesterReturnSheet,
  type RequesterTrackingExchange,
  type RequesterTrackingItem,
  type RequesterTrackingLine,
  type RequesterTrackingReturn,
} from './requester-exchange-types';
import { requesterReplacementQuantityLabel, requesterSentWords, RETURNS_COPY } from './returns-copy';

/**
 * The requester's contract (returns RX-3, plan 3.9 and 3.10): the key lists
 * every server payload is pinned against, the two-state availability, the
 * size order of the options, and the tracking sentences.
 */

// Each key list names exactly its interface's keys: a key added to an
// interface without its list (or the other way round) fails to compile here.
const exact = <T>() => <K extends readonly (keyof T)[]>(keys: K & ([keyof T] extends [K[number]] ? unknown : never)) => keys;

describe('the requester payload keys', () => {
  it('each list is exactly its interface', () => {
    expect(exact<RequesterPhoto>()(REQUESTER_PHOTO_KEYS)).toEqual(['url', 'thumbUrl']);
    expect(exact<RequesterReturnableLine>()(REQUESTER_RETURNABLE_LINE_KEYS)).toHaveLength(6);
    expect(exact<RequesterExchangeOption>()(REQUESTER_EXCHANGE_OPTION_KEYS)).toHaveLength(5);
    expect(exact<RequesterExchangeLine>()(REQUESTER_EXCHANGE_LINE_KEYS)).toHaveLength(2);
    expect(exact<RequesterExchangeOptionsAnswer>()(REQUESTER_EXCHANGE_OPTIONS_ANSWER_KEYS)).toHaveLength(2);
    expect(exact<RequesterTrackingItem>()(REQUESTER_TRACKING_ITEM_KEYS)).toHaveLength(3);
    expect(exact<RequesterTrackingExchange>()(REQUESTER_TRACKING_EXCHANGE_KEYS)).toHaveLength(3);
    expect(exact<RequesterTrackingLine>()(REQUESTER_TRACKING_LINE_KEYS)).toHaveLength(2);
    expect(exact<RequesterTrackingReturn>()(REQUESTER_TRACKING_RETURN_KEYS)).toHaveLength(7);
    expect(exact<RequesterReturnSheet>()(REQUESTER_RETURN_SHEET_KEYS)).toHaveLength(5);
  });

  it('no key can carry a SKU, a cost, a location, a warehouse, a group, a stock count, a note, a reason or a person', () => {
    const all = [
      ...REQUESTER_PHOTO_KEYS,
      ...REQUESTER_RETURNABLE_LINE_KEYS,
      ...REQUESTER_EXCHANGE_OPTION_KEYS,
      ...REQUESTER_EXCHANGE_LINE_KEYS,
      ...REQUESTER_EXCHANGE_OPTIONS_ANSWER_KEYS,
      ...REQUESTER_TRACKING_ITEM_KEYS,
      ...REQUESTER_TRACKING_EXCHANGE_KEYS,
      ...REQUESTER_TRACKING_LINE_KEYS,
      ...REQUESTER_TRACKING_RETURN_KEYS,
      ...REQUESTER_RETURN_SHEET_KEYS,
    ];
    expect(all.filter((k) => isForbiddenRequesterKey(k))).toEqual([]);
  });

  it('the forbidden pattern catches the fields a staff payload carries', () => {
    for (const k of [
      'sku',
      'itemSku',
      'unitCost',
      'unit_price_at_request',
      'locationId',
      'rack',
      'binLocation',
      'staging',
      'disposition',
      'destination',
      'charterId',
      'warehouseId',
      'groupId',
      'variantKey',
      'quantityOnHand',
      'quantity_on_hand',
      'free',
      'held',
      'reserved',
      'requestNote',
      'notes',
      'reason',
      'supplierId',
      'staffName',
      'actorUserId',
      'approvedBy',
      'requesterEmail',
      'organizationId',
    ]) {
      expect(isForbiddenRequesterKey(k), k).toBe(true);
    }
    // Words that only contain a forbidden one are not refused.
    for (const k of ['tracking', 'binder', 'freely', 'heldover', 'groupsize']) {
      expect(isForbiddenRequesterKey(k), k).toBe(false);
    }
  });

  it('scans a whole payload, any depth', () => {
    expect(
      forbiddenRequesterKeys({
        lines: [{ orderRequestLineId: 'l1', options: [{ itemId: 'i1', free: 3, photo: { url: 'u', thumbUrl: null } }] }],
        tracking: [{ lines: [{ returning: { name: 'x', quantity: 1, binLocation: '31-C' } }] }],
        warehouseId: 'w',
      }),
    ).toEqual(['lines[0].options[0].free', 'tracking[0].lines[0].returning.binLocation', 'warehouseId']);
    expect(forbiddenRequesterKeys({ exchangesEnabled: true, lines: [] })).toEqual([]);
    expect(forbiddenRequesterKeys(null)).toEqual([]);
  });
});

describe('two-state availability (D6): the free count never leaves the server', () => {
  it('anything in stock now is available; nothing, a negative or an unreadable count is not', () => {
    expect(requesterAvailability(14)).toBe('available');
    expect(requesterAvailability(1)).toBe('available');
    expect(requesterAvailability('3')).toBe('available');
    expect(requesterAvailability(0.5)).toBe('available');
    for (const v of [0, -2, '0', '', ' ', null, undefined, Number.NaN, 'many', {}]) {
      expect(requesterAvailability(v)).toBe('not_in_stock');
    }
  });

  it('says it in the plan words', () => {
    expect(REQUESTER_AVAILABILITY_WORDS).toEqual({ available: 'Available', not_in_stock: 'Not in stock right now' });
  });
});

describe('option order: the stored size, never the name (brief 3)', () => {
  it('runs small to large, ties by name, unknown sizes last', () => {
    const rows = [
      { name: 'Shirt XL', size: 'XL' },
      { name: 'Shirt S', size: 'S' },
      { name: 'Shirt 2XL', size: '2XL' },
      { name: 'Shirt L (navy)', size: 'L' },
      { name: 'Shirt L', size: 'L' },
      { name: 'Shirt odd', size: null },
      { name: 'Shirt M', size: 'M' },
    ];
    expect(orderRequesterOptions(rows, (r) => r.size).map((r) => r.name)).toEqual([
      'Shirt S',
      'Shirt M',
      'Shirt L',
      'Shirt L (navy)',
      'Shirt XL',
      'Shirt 2XL',
      'Shirt odd',
    ]);
    // A name that says one size and a stored size that says another: the stored one wins.
    expect(orderRequesterOptions([{ name: 'Small', size: 'XL' }, { name: 'Large', size: 'S' }], (r) => r.size).map((r) => r.name)).toEqual([
      'Large',
      'Small',
    ]);
  });

  it('numeric runs order by number', () => {
    const rows = ['10', '9', '10.5', '8'].map((s) => ({ name: `Shoe ${s}`, size: s }));
    expect(orderRequesterOptions(rows, (r) => r.size).map((r) => r.size)).toEqual(['8', '9', '10', '10.5']);
  });
});

describe("the requester's tracking sentences (plan 3.10, brief 28)", () => {
  it("the return's own status in the requester's words", () => {
    expect(requesterReturnStatusSentence('requested')).toBe('Return requested. The warehouse will review it.');
    expect(requesterReturnStatusSentence('approved')).toBe('Return approved. Bring or send the item back as arranged with the warehouse.');
    expect(requesterReturnStatusSentence('received')).toBe('Return received.');
    expect(requesterReturnStatusSentence('closed')).toBe('Return complete.');
    expect(requesterReturnStatusSentence('denied')).toBe('Return request declined.');
    expect(requesterReturnStatusSentence('cancelled')).toBe('Return request cancelled.');
    expect(requesterReturnStatusSentence('archived')).toBeNull();
    expect(requesterReturnStatusSentence(null)).toBeNull();
  });

  it('a return only reads its own status', () => {
    expect(requesterTrackingSentences({ returnStatus: 'approved', exchangeStatus: 'none' })).toEqual([
      'Return approved. Bring or send the item back as arranged with the warehouse.',
    ]);
    expect(requesterTrackingSentences({ returnStatus: 'archived', exchangeStatus: 'none' })).toEqual([]);
  });

  it('brief 28: reserved and waiting, then received and ready for pickup', () => {
    expect(requesterTrackingSentences({ returnStatus: 'approved', exchangeStatus: 'waiting_for_return' })).toEqual([
      'Replacement reserved. Waiting for your return.',
    ]);
    expect(
      requesterTrackingSentences({ returnStatus: 'received', exchangeStatus: 'ready_for_pickup', replacementStatus: 'staged_for_pickup' }),
    ).toEqual(['Return received.', 'Replacement ready for pickup.']);
  });

  it('the return goes first unless the exchange sentence already says where it stands', () => {
    const cases: Array<[string, ExchangeStatus, string[]]> = [
      ['requested', 'requested', ['Exchange requested. The warehouse will review it.']],
      // Re-pinned on purpose (RX-3 fix round 1, desk check M1): a declined or
      // cancelled RMA says so for the return too, so a return-only line on the
      // same RMA never reads as still standing (plan 3.10: the return's status
      // is always shown beside the exchange's).
      ['cancelled', 'cancelled', ['Return request cancelled.', 'Exchange request cancelled.']],
      ['denied', 'cancelled', ['Return request declined.', 'Exchange request declined.']],
      // An exchange cancelled while the return stands keeps the return's words.
      [
        'approved',
        'cancelled',
        ['Return approved. Bring or send the item back as arranged with the warehouse.', 'Exchange request cancelled.'],
      ],
      ['approved', 'declined', ['Exchange declined. Your return was approved.']],
      // Re-pinned on purpose (desk check L7): once the return's own sentence
      // is shown, "Your return was approved." would repeat an older state.
      ['received', 'declined', ['Return received.', 'Exchange declined.']],
      ['closed', 'declined', ['Return complete.', 'Exchange declined.']],
      ['closed', 'completed', ['Exchange completed.']],
      ['received', 'ready_to_pick', ['Return received. Your replacement is being prepared.']],
      ['closed', 'ready_to_pick', ['Return received. Your replacement is being prepared.']],
      [
        'approved',
        'unavailable',
        [
          'Return approved. Bring or send the item back as arranged with the warehouse.',
          'Your replacement is not in stock yet. The warehouse will follow up.',
        ],
      ],
      ['received', 'in_progress', ['Return received.', 'Your replacement is being prepared.']],
      ['closed', 'out_for_delivery', ['Return complete.', 'Your replacement is on the way.']],
      [
        'approved',
        'handed_over_return_open',
        ['Return approved. Bring or send the item back as arranged with the warehouse.', 'Replacement handed over.'],
      ],
      ['cancelled', 'handed_over_return_cancelled', ['Return request cancelled.', 'Replacement handed over.']],
      ['received', 'partly_handed_over', ['Return received.', 'Part of your replacement was handed over. The rest will follow.']],
      ['received', 'replacement_cancelled', ['Return received.', 'Your replacement was cancelled. The warehouse will follow up.']],
    ];
    for (const [returnStatus, exchangeStatus, expected] of cases) {
      expect(requesterTrackingSentences({ returnStatus, exchangeStatus }), `${returnStatus} / ${exchangeStatus}`).toEqual(expected);
    }
  });

  it('released early, the returned item still out: never "Return received"', () => {
    expect(exchangeRequesterSentence('ready_to_pick', { returnStatus: 'approved' })).toBe('Your replacement is being prepared.');
    expect(exchangeRequesterSentence('ready_to_pick', { returnStatus: 'received' })).toBe(
      'Return received. Your replacement is being prepared.',
    );
    expect(requesterTrackingSentences({ returnStatus: 'approved', exchangeStatus: 'ready_to_pick' })).toEqual([
      'Return approved. Bring or send the item back as arranged with the warehouse.',
      'Your replacement is being prepared.',
    ]);
  });

  it('a replacement closed with part never sent says so beside the return', () => {
    expect(
      requesterTrackingSentences({ returnStatus: 'closed', exchangeStatus: 'completed', replacementStatus: 'completed', replacementOwed: 1 }),
    ).toEqual(['Return complete.', 'Part of your replacement was handed over. The rest will not be sent.']);
  });

  it('every pair of statuses gives at most two sentences, none naming a rack, Staging, a disposition, a stock count or a person', () => {
    const statuses = ['requested', 'approved', 'received', 'closed', 'denied', 'cancelled'];
    for (const r of statuses) {
      for (const x of EXCHANGE_STATUSES) {
        const out = requesterTrackingSentences({ returnStatus: r, exchangeStatus: x });
        expect(out.length).toBeLessThanOrEqual(2);
        for (const s of out) {
          expect(s).not.toMatch(/rack|staging|scrap|restock|disposition|on hand|on record|cost|supplier|\bbooks?\b/i);
        }
      }
    }
  });

  it('the exchange-declined title is the 3.10 requester sentence', () => {
    expect(RETURNS_COPY.requesterExchangeDeclined).toBe(exchangeRequesterSentence('declined'));
  });
});

describe("the order screen's returns as the order's requester reads them (one rule, web and phone)", () => {
  const rma = (returnNumber: string | null, id: string) => ({ id, returnNumber, notes: 'staff words' });
  const tracked = (returnNumber: string | null): RequesterTrackingReturn => ({
    returnNumber,
    createdAt: '2026-10-11T18:00:00.000Z',
    returnStatus: 'requested',
    exchangeStatus: 'none',
    sentences: ['Return requested. The warehouse will review it.'],
    replacementOrderNumber: null,
    lines: [],
  });

  it('a requester who cannot read returns sees each own request once, as tracking; a return staff made keeps its card (D15)', () => {
    const view = requesterReturnsView({
      returns: [rma('RMA-1', 'r1'), rma('RMA-STAFF', 'r2')],
      tracking: [tracked('RMA-1')],
      showTracking: true,
      viewerCanReadReturns: false,
    });
    expect(view.tracking.map((t) => t.returnNumber)).toEqual(['RMA-1']);
    expect(view.orderReturns.map((r) => r.id)).toEqual(['r2']);
  });

  it("a requester who can read returns (not manage) gets the tracking AND keeps the order's card, which opens the RMA", () => {
    const returns = [rma('RMA-1', 'r1')];
    const view = requesterReturnsView({ returns, tracking: [tracked('RMA-1')], showTracking: true, viewerCanReadReturns: true });
    expect(view.tracking.map((t) => t.returnNumber)).toEqual(['RMA-1']);
    expect(view.orderReturns).toEqual(returns);
  });

  it("no tracking (a returns manager, not their order, or the read failed): every return keeps the order's card", () => {
    const returns = [rma('RMA-1', 'r1')];
    expect(requesterReturnsView({ returns, tracking: null, showTracking: true, viewerCanReadReturns: false })).toEqual({
      orderReturns: returns,
      tracking: [],
    });
    expect(
      requesterReturnsView({ returns, tracking: [tracked('RMA-1')], showTracking: false, viewerCanReadReturns: false }),
    ).toEqual({ orderReturns: returns, tracking: [] });
  });

  it('a return with no number is never hidden (it cannot be matched)', () => {
    const view = requesterReturnsView({
      returns: [rma(null, 'r1')],
      tracking: [tracked(null)],
      showTracking: true,
      viewerCanReadReturns: false,
    });
    expect(view.orderReturns.map((r) => r.id)).toEqual(['r1']);
    expect(view.tracking).toHaveLength(1);
  });
});

describe("one tracking line's words (web and phone)", () => {
  const item = (name: string, sizeLabel: string | null, quantity = 1) => ({ name, sizeLabel, quantity });
  const line = (exchange: RequesterTrackingLine['exchange']): RequesterTrackingLine => ({
    returning: item("Women's Polo", 'M'),
    exchange,
  });

  it('a return only has no replacement and no state', () => {
    expect(requesterTrackingLineWords(line(null))).toEqual({
      returning: "Women's Polo, M ×1",
      replacement: null,
      state: null,
      changed: null,
    });
  });

  it('every line state is named, the same on both screens', () => {
    const states = (['requested', 'approved', 'declined', 'cancelled'] as const).map(
      (state) => requesterTrackingLineWords(line({ state, replacement: item("Women's Polo", 'L'), substituted: false })).state,
    );
    expect(states).toEqual(['Requested', 'Approved', 'Declined', 'Cancelled']);
  });

  it('the size asked for, and "Changed by the warehouse" when another was approved', () => {
    expect(
      requesterTrackingLineWords(line({ state: 'approved', replacement: item("Women's Polo", 'S'), substituted: true })),
    ).toMatchObject({ replacement: "Women's Polo, S ×1", changed: 'Changed by the warehouse' });
  });

  it('desk check M3: a note-only request reads "Warehouse will review" only while the warehouse is reviewing it', () => {
    expect(requesterTrackingLineWords(line({ state: 'requested', replacement: null, substituted: false })).replacement).toBe(
      'Warehouse will review',
    );
    for (const state of ['declined', 'cancelled'] as const) {
      const words = requesterTrackingLineWords(line({ state, replacement: null, substituted: false }));
      expect(words.replacement, state).toBe('A different replacement');
      expect(words.replacement, state).not.toMatch(/review/i);
    }
  });
});

// RX-3 fix round 1 (desk checks M4, F3, F4): what a requester form does after
// a refusal, one rule for the token page, the portal and the phone.
describe('a requester refusal: read the sheet again, or start over', () => {
  it('a refusal that means the form is behind reads the lines and sizes again and keeps the key (the refused transaction rolled back its key row)', () => {
    for (const reason of ['return_exceeds_fulfilled', 'exchange_already_sent', 'exchange_item_not_eligible', 'exchange_not_available']) {
      expect(requesterRefusalRecovery(reason), reason).toBe('reload');
    }
  });

  it('idempotency_conflict: the earlier send with this key went through, so the form starts over with nothing chosen and a new key', () => {
    expect(requesterRefusalRecovery('idempotency_conflict')).toBe('restart');
    expect(RETURNS_COPY.requesterEarlierRequestSent).toBe(
      'Your earlier request went through. It is listed under Your requests on this order. Choose again only for anything else to send back.',
    );
  });

  it('anything else changes nothing in the form', () => {
    for (const reason of [null, undefined, 'busy', 'return_invalid', 'module_disabled', 'unknown_reason']) {
      expect(requesterRefusalRecovery(reason), String(reason)).toBeNull();
    }
  });
});

// RX-3 fix round 1 (desk check L4): one set of words for the web form and
// the phone sheet where they had drifted.
describe('the requester sheet words both screens share', () => {
  it('the replacement quantity without a stepper reads "Quantity: N" (the phone said "Qty requested: N")', () => {
    expect(requesterReplacementQuantityLabel(1)).toBe('Quantity: 1');
    expect(requesterReplacementQuantityLabel(3)).toBe('Quantity: 3');
  });

  it('after a request: the reference, then that the warehouse reviews it', () => {
    expect(requesterSentWords('RMA-20261011-ABC123')).toBe('Your reference is RMA-20261011-ABC123. The warehouse will review it.');
    expect(requesterSentWords(null)).toBe('The warehouse will review it.');
  });
});
