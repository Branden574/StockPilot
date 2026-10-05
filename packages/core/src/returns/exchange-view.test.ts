import { describe, expect, it } from 'vitest';

import { EXCHANGE_STATUSES } from './exchange-status';
import {
  approvalPreviewLines,
  exchangeCandidateRows,
  exchangeRail,
  parseExchangeCandidates,
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
