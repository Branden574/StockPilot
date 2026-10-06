import { describe, expect, it } from 'vitest';

import { EXCHANGE_STATUSES } from './exchange-status';
import {
  addReplacementDecision,
  approvalPreviewLines,
  exchangeCandidateRows,
  exchangeLineStatusLabel,
  exchangeRail,
  exchangeReviewDecision,
  exchangeReviewProblem,
  parseExchangeCandidates,
  replacementSiteOptions,
  type ExchangeCandidate,
  type RailStep,
} from './exchange-view';

const states = (steps: RailStep[]) => steps.map((s) => `${s.label}:${s.state}`).join(' > ');

describe('exchangeRail (plan RX-2: the outbound rail)', () => {
  const base = { returnStatus: 'approved', releasedEarly: false, fulfillmentType: 'pickup' as const };

  it('has no rail for a plain return', () => {
    expect(exchangeRail({ ...base, exchangeStatus: 'none' })).toEqual([]);
  });

  it('walks Requested, Reserved, Waiting for return, Picking, Ready for pickup, Handed over', () => {
    expect(states(exchangeRail({ ...base, returnStatus: 'requested', exchangeStatus: 'requested' }))).toBe(
      'Requested:current > Reserved:upcoming > Waiting for return:upcoming > Picking:upcoming > Ready for pickup:upcoming > Handed over:upcoming',
    );
    expect(states(exchangeRail({ ...base, exchangeStatus: 'waiting_for_return' }))).toBe(
      'Requested:done > Reserved:done > Waiting for return:current > Picking:upcoming > Ready for pickup:upcoming > Handed over:upcoming',
    );
    expect(states(exchangeRail({ ...base, returnStatus: 'received', exchangeStatus: 'ready_to_pick' }))).toBe(
      'Requested:done > Reserved:done > Return received:done > Picking:current > Ready for pickup:upcoming > Handed over:upcoming',
    );
    expect(states(exchangeRail({ ...base, returnStatus: 'closed', exchangeStatus: 'completed' }))).toBe(
      'Requested:done > Reserved:done > Return received:done > Picking:done > Ready for pickup:done > Handed over:done',
    );
  });

  it('says Not in stock, Released early, Out for delivery and Partly handed over where they apply', () => {
    expect(exchangeRail({ ...base, exchangeStatus: 'unavailable' })[1]).toEqual({ id: 'reserved', label: 'Not in stock', state: 'current' });
    expect(exchangeRail({ ...base, releasedEarly: true, exchangeStatus: 'ready_to_pick' })[2]).toEqual({
      id: 'gate',
      label: 'Released early',
      state: 'done',
    });
    expect(exchangeRail({ ...base, fulfillmentType: 'delivery', exchangeStatus: 'out_for_delivery' })[4]).toEqual({
      id: 'ready',
      label: 'Out for delivery',
      state: 'current',
    });
    expect(exchangeRail({ ...base, exchangeStatus: 'partly_handed_over' })[5]).toEqual({
      id: 'handed_over',
      label: 'Partly handed over',
      state: 'current',
    });
  });

  it('stops where the exchange stopped: declined, denied or a replacement cancel', () => {
    expect(exchangeRail({ ...base, exchangeStatus: 'declined' })[1]).toMatchObject({ label: 'Declined', state: 'stopped' });
    expect(exchangeRail({ ...base, returnStatus: 'denied', exchangeStatus: 'cancelled' })[1]).toMatchObject({
      label: 'Declined',
      state: 'stopped',
    });
    expect(exchangeRail({ ...base, exchangeStatus: 'replacement_cancelled' })[1]).toMatchObject({ label: 'Cancelled', state: 'stopped' });
  });

  it('draws a rail for every exchange status', () => {
    for (const s of EXCHANGE_STATUSES.filter((x) => x !== 'none')) {
      const rail = exchangeRail({ ...base, exchangeStatus: s });
      expect(rail).toHaveLength(6);
      expect(rail.filter((r) => r.state === 'current' || r.state === 'stopped').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('the replacement candidates', () => {
  const c = (over: Partial<ExchangeCandidate>): Record<string, unknown> => ({
    itemId: 'i',
    name: 'Walk New Hire Shirt',
    sku: 'S',
    variantSize: null,
    variantKey: null,
    groupId: 'g',
    sibling: true,
    isReturnedItem: false,
    onHand: 3,
    held: 0,
    free: 3,
    ...over,
  });

  it('parses the database answer defensively and drops rows without an item', () => {
    const a = parseExchangeCandidates({
      orderId: 'o',
      orderRequestLineId: 'l',
      returnedItemId: 'm',
      groupId: 'g',
      siblings: [c({ itemId: 'a', free: '2' as unknown as number }), { name: 'no id' }, 'junk'],
      matches: null,
    });
    expect(a.siblings.map((s) => [s.itemId, s.free])).toEqual([['a', 2]]);
    expect(a.matches).toEqual([]);
    expect(parseExchangeCandidates(null).siblings).toEqual([]);
  });

  it('puts siblings in size order (the items\' own sizes, never a name) and marks what is short for the quantity asked', () => {
    const a = parseExchangeCandidates({
      siblings: [
        c({ itemId: 'xl', variantSize: 'XL', free: 0 }),
        c({ itemId: 's', variantSize: 'S', free: 5 }),
        c({ itemId: 'l', variantSize: 'L', free: 1 }),
        c({ itemId: 'm', variantSize: 'M', free: 2, isReturnedItem: true }),
      ],
      matches: [c({ itemId: 'navy', sibling: false, groupId: null, free: 9 })],
    });
    const rows = exchangeCandidateRows(a, 2);
    expect(rows.siblings.map((r) => `${r.itemId}:${r.availability}`)).toEqual([
      's:Available: 5',
      'm:Available: 2',
      'l:Short: 1 available, 2 needed.',
      'xl:Short: 0 available, 2 needed.',
    ]);
    expect(rows.matches.map((r) => r.short)).toEqual([false]);
  });
});

describe('what happens when you approve', () => {
  it('nothing moves now; the replacement and its reservation; picking waits; where the returned item goes', () => {
    expect(
      approvalPreviewLines({
        lines: [{ returnedLabel: 'New Hire Shirt, M', destination: { kind: 'rack', rack: '31-C' } }],
        exchanges: [
          { returnedLabel: 'New Hire Shirt, M', decision: 'approve', replacementLabel: 'New Hire Shirt, L', quantity: 1, available: 14 },
        ],
        itemIsHere: false,
      }),
    ).toEqual([
      'Nothing moves now. The returned item stays out until the return is processed.',
      'A replacement order is created for New Hire Shirt, L ×1 and 1 is reserved.',
      'Picking waits until New Hire Shirt, M is received.',
      'When processed, New Hire Shirt, M goes back to 31-C.',
    ]);
  });

  it('says what is short, that picking can start at the counter, and nothing about a declined exchange', () => {
    expect(
      approvalPreviewLines({
        lines: [{ returnedLabel: 'Cap', destination: { kind: 'staging' } }],
        exchanges: [
          { returnedLabel: 'Cap', decision: 'approve', replacementLabel: 'Cap, L', quantity: 1, available: 0 },
          { returnedLabel: 'Hat', decision: 'decline', replacementLabel: 'Hat, L', quantity: 1, available: 3 },
        ],
        itemIsHere: true,
      }),
    ).toEqual([
      'Nothing moves now. The returned item stays out until the return is processed.',
      'A replacement order is created for Cap, L ×1; none is in stock right now (0 available, 1 needed).',
      'The returned item is here, so picking can start.',
      'When processed, Cap goes into Staging.',
    ]);
  });
});

describe('the approval review (web and phone)', () => {
  const line = { id: 'x1', requestedItemId: 'l', requestNote: null };

  it('as requested sends the line alone; a note-only request must be changed first', () => {
    expect(exchangeReviewProblem(line, { kind: 'as_requested' })).toBeNull();
    expect(exchangeReviewDecision(line, { kind: 'as_requested' })).toEqual({ action: 'approve', exchangeLineId: 'x1' });
    expect(exchangeReviewProblem({ ...line, requestedItemId: null, requestNote: 'L please' }, { kind: 'as_requested' })).toBe(
      'Choose the replacement: L please',
    );
  });

  it('a change needs an item, and a reason when it differs from the request', () => {
    const change = { kind: 'change' as const, itemId: null, label: null, free: null, quantity: 1, reason: '' };
    expect(exchangeReviewProblem(line, change)).toBe('Choose the replacement');
    expect(exchangeReviewProblem(line, { ...change, itemId: 'navy' })).toBe('Reason (required)');
    expect(exchangeReviewProblem(line, { ...change, itemId: 'l' })).toBeNull();
    expect(exchangeReviewDecision(line, { ...change, itemId: 'navy', reason: ' Out of L ' })).toEqual({
      action: 'approve',
      exchangeLineId: 'x1',
      itemId: 'navy',
      quantity: 1,
      reason: 'Out of L',
    });
  });

  it('a decline needs a reason; an add needs an item', () => {
    expect(exchangeReviewProblem(line, { kind: 'decline', reason: ' ' })).toBe('Reason for declining the exchange (required)');
    expect(exchangeReviewDecision(line, { kind: 'decline', reason: ' No stock ' })).toEqual({
      action: 'decline',
      exchangeLineId: 'x1',
      reason: 'No stock',
    });
    expect(addReplacementDecision('rl1', { itemId: null, quantity: 1 })).toBeNull();
    expect(addReplacementDecision('rl1', { itemId: 'l', quantity: 2 })).toEqual({ action: 'add', returnLineId: 'rl1', itemId: 'l', quantity: 2 });
  });
});

// Desk check F6: the original delivery site is not one the warehouse serves.
describe('replacementSiteOptions (web and phone)', () => {
  it('lists every served site by name as "Deliver to …", then "Pickup instead", with the request value each sends', () => {
    const options = replacementSiteOptions([
      { id: 's2', name: 'West Campus' },
      { id: 's1', name: 'East Campus' },
    ]);
    expect(options.map((o) => o.label)).toEqual(['Deliver to East Campus', 'Deliver to West Campus', 'Pickup instead']);
    expect(options[0]!.value).toEqual({ fulfillmentType: 'delivery', deliveryCharterId: 's1' });
    expect(options.at(-1)!.value).toEqual({ fulfillmentType: 'pickup', deliveryCharterId: null });
    expect(replacementSiteOptions(null).map((o) => o.key)).toEqual(['pickup']);
  });
});

// RX-2 simulator finding SIM-1: the REPLACEMENT card's status words come from
// one rule (the web pill, the phone pill and the phone card's VoiceOver label).
describe('exchangeLineStatusLabel (the REPLACEMENT card, web and phone)', () => {
  it('names each exchange line status the way the card shows it', () => {
    expect((['requested', 'approved', 'declined', 'cancelled'] as const).map(exchangeLineStatusLabel)).toEqual([
      'Requested',
      'Approved',
      'Declined',
      'Cancelled',
    ]);
  });
});
