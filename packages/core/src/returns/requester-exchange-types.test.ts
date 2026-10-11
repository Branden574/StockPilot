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
import { RETURNS_COPY } from './returns-copy';

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
      ['cancelled', 'cancelled', ['Exchange request cancelled.']],
      ['denied', 'cancelled', ['Exchange request declined.']],
      ['approved', 'declined', ['Exchange declined. Your return was approved.']],
      ['received', 'declined', ['Return received.', 'Exchange declined. Your return was approved.']],
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
