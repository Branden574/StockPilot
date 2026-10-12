import { describe, expect, it } from 'vitest';

import { EXCHANGE_STATUSES } from './exchange-status';
import {
  addReplacementDecision,
  approvalPreviewLines,
  exchangeCandidateRows,
  exchangeLineStatusLabel,
  exchangeRail,
  exchangeRailAccessibilityLabel,
  exchangeReviewDecision,
  exchangeReviewHeaderLabel,
  exchangeReviewProblem,
  noReplacementLine,
  originalExchangeLineFor,
  parseExchangeCandidates,
  RAIL_STEP_STATE_WORDS,
  replacementCardQuantityLabel,
  replacementCardStatusLabel,
  replacementLineHandOver,
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

  // RX-2 review fix P4: after a stop nothing is "next". A declined or
  // cancelled exchange's later steps were never reached; after a replacement
  // cancel they have not started (a new replacement may still be issued).
  // Each later step reads its plain name (never "Return received" or
  // "Released early" for a step the replacement never reached).
  it('after a stop the later steps are not reached, or not started after a replacement cancel (review fix P4)', () => {
    expect(states(exchangeRail({ ...base, exchangeStatus: 'declined' }))).toBe(
      'Requested:done > Declined:stopped > Waiting for return:skipped > Picking:skipped > Ready for pickup:skipped > Handed over:skipped',
    );
    expect(states(exchangeRail({ ...base, returnStatus: 'received', exchangeStatus: 'declined' }))).toBe(
      'Requested:done > Declined:stopped > Waiting for return:skipped > Picking:skipped > Ready for pickup:skipped > Handed over:skipped',
    );
    expect(states(exchangeRail({ ...base, returnStatus: 'cancelled', exchangeStatus: 'cancelled', fulfillmentType: 'delivery' }))).toBe(
      'Requested:done > Cancelled:stopped > Waiting for return:skipped > Picking:skipped > Out for delivery:skipped > Handed over:skipped',
    );
    expect(states(exchangeRail({ ...base, returnStatus: 'denied', exchangeStatus: 'cancelled' }))).toBe(
      'Requested:done > Declined:stopped > Waiting for return:skipped > Picking:skipped > Ready for pickup:skipped > Handed over:skipped',
    );
    expect(
      states(exchangeRail({ ...base, returnStatus: 'received', releasedEarly: true, exchangeStatus: 'replacement_cancelled' })),
    ).toBe(
      'Requested:done > Cancelled:stopped > Waiting for return:not_started > Picking:not_started > Ready for pickup:not_started > Handed over:not_started',
    );
  });

  // RX-2 verification L12, carried to RX-3 and confirmed on the local stack in
  // the RX-3 test stage: after an approval reserved the replacement, Cancel
  // return leaves the view carrying the CANCELLED replacement (exchange
  // cancelled, replacement_status cancelled, its hold released but on record).
  // The replacement did reach Reserved and waited, so the rail keeps Reserved
  // done and stops at the gate. A cancel before any hold (cancelled before
  // approval, or a replacement that never held stock) keeps the stop at
  // Reserved; a declined exchange and a replacement cancel are unchanged.
  it('keeps Reserved done and stops at the gate when the RMA was cancelled after its replacement was reserved (L12)', () => {
    const cancelled = { ...base, returnStatus: 'cancelled', exchangeStatus: 'cancelled' as const, replacementStatus: 'cancelled', replacementOwed: 1 };
    expect(states(exchangeRail({ ...cancelled, replacementWasReserved: true }))).toBe(
      'Requested:done > Reserved:done > Cancelled:stopped > Picking:skipped > Ready for pickup:skipped > Handed over:skipped',
    );
    expect(exchangeRailAccessibilityLabel(exchangeRail({ ...cancelled, replacementWasReserved: true }))).toBe(
      'Replacement progress: Requested, done; Reserved, done; Cancelled, stopped; Picking, not reached; Ready for pickup, not reached; Handed over, not reached',
    );
    const atReserved =
      'Requested:done > Cancelled:stopped > Waiting for return:skipped > Picking:skipped > Ready for pickup:skipped > Handed over:skipped';
    expect(states(exchangeRail({ ...cancelled, replacementWasReserved: false }))).toBe(atReserved);
    expect(states(exchangeRail({ ...cancelled }))).toBe(atReserved);
    expect(states(exchangeRail({ ...base, returnStatus: 'cancelled', exchangeStatus: 'cancelled', replacementWasReserved: null }))).toBe(atReserved);
    expect(states(exchangeRail({ ...base, exchangeStatus: 'declined', replacementWasReserved: true }))).toBe(
      'Requested:done > Declined:stopped > Waiting for return:skipped > Picking:skipped > Ready for pickup:skipped > Handed over:skipped',
    );
    expect(states(exchangeRail({ ...base, exchangeStatus: 'replacement_cancelled', replacementWasReserved: true }))).toBe(
      'Requested:done > Cancelled:stopped > Waiting for return:not_started > Picking:not_started > Ready for pickup:not_started > Handed over:not_started',
    );
  });

  it('words every step state, and the rail as one accessible label (web and phone, review fix P4)', () => {
    expect(RAIL_STEP_STATE_WORDS).toEqual({
      done: 'done',
      current: 'now',
      upcoming: 'next',
      stopped: 'stopped',
      skipped: 'not reached',
      not_started: 'not started',
    });
    expect(exchangeRailAccessibilityLabel(exchangeRail({ ...base, exchangeStatus: 'declined' }))).toBe(
      'Replacement progress: Requested, done; Declined, stopped; Waiting for return, not reached; Picking, not reached; Ready for pickup, not reached; Handed over, not reached',
    );
    expect(exchangeRailAccessibilityLabel(exchangeRail({ ...base, exchangeStatus: 'replacement_cancelled' }))).toBe(
      'Replacement progress: Requested, done; Cancelled, stopped; Waiting for return, not started; Picking, not started; Ready for pickup, not started; Handed over, not started',
    );
    expect(exchangeRailAccessibilityLabel(exchangeRail({ ...base, exchangeStatus: 'waiting_for_return' }))).toBe(
      'Replacement progress: Requested, done; Reserved, done; Waiting for return, now; Picking, next; Ready for pickup, next; Handed over, next',
    );
    expect(exchangeRailAccessibilityLabel([])).toBe('');
  });

  // RX-2 review fix P21: a replacement closed with part never sent (closed as
  // delivered-partial, or its rest ended with the RMA) never reads "Handed
  // over · done".
  it('ends "Partly handed over", stopped, when part of the replacement was never sent (review fix P21)', () => {
    for (const exchangeStatus of ['completed', 'handed_over_return_open', 'handed_over_return_cancelled'] as const) {
      const rail = exchangeRail({
        ...base,
        returnStatus: exchangeStatus === 'handed_over_return_cancelled' ? 'cancelled' : 'closed',
        releasedEarly: true,
        exchangeStatus,
        replacementStatus: 'completed',
        replacementOwed: 1,
      });
      expect(rail.slice(0, 5).every((r) => r.state === 'done'), exchangeStatus).toBe(true);
      expect(rail[5], exchangeStatus).toEqual({ id: 'handed_over', label: 'Partly handed over', state: 'stopped' });
    }
    // Everything sent: handed over, done (and without the facts, as before).
    expect(exchangeRail({ ...base, returnStatus: 'closed', exchangeStatus: 'completed', replacementStatus: 'completed', replacementOwed: 0 })[5]).toEqual({
      id: 'handed_over',
      label: 'Handed over',
      state: 'done',
    });
    expect(exchangeRail({ ...base, returnStatus: 'closed', exchangeStatus: 'completed' })[5]).toMatchObject({ label: 'Handed over', state: 'done' });
    // Still on backorder (the rest will follow): current, as before.
    expect(exchangeRail({ ...base, exchangeStatus: 'partly_handed_over', replacementStatus: 'backordered', replacementOwed: 1 })[5]).toEqual({
      id: 'handed_over',
      label: 'Partly handed over',
      state: 'current',
    });
  });

  it('says why there is no replacement order: still requested, declined, or cancelled with the return (review fix P4)', () => {
    expect(noReplacementLine('requested')).toBe('No replacement order yet. One is created when the exchange is approved.');
    expect(noReplacementLine('declined')).toBe('No replacement order: the exchange was declined.');
    expect(noReplacementLine('cancelled', { returnStatus: 'cancelled' })).toBe('No replacement order: the exchange was cancelled with the return.');
    // A denied return's exchange reads declined, as its staff label does.
    expect(noReplacementLine('cancelled', { returnStatus: 'denied' })).toBe('No replacement order: the exchange was declined.');
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
      // RX-2 review fix P25: a plain Approve refuses a short replacement and
      // asks first, so the preview never promises the order.
      'Cap, L ×1 is not in stock right now (0 available, 1 needed). Approving asks first: put it on backorder or change the replacement.',
      'The returned item is here, so picking can start.',
      'When processed, Cap goes into Staging.',
    ]);
  });
});

describe('what happens when you approve a short replacement (review fix P25)', () => {
  it('says what is short and that approving asks first, for none and for some in stock', () => {
    const preview = (quantity: number, available: number) =>
      approvalPreviewLines({
        lines: [],
        exchanges: [{ returnedLabel: 'Walk Exchange Tee - M', decision: 'approve', replacementLabel: 'Walk Exchange Tee - 2XL', quantity, available }],
        itemIsHere: false,
      })[1];
    expect(preview(1, 0)).toBe(
      'Walk Exchange Tee - 2XL ×1 is not in stock right now (0 available, 1 needed). Approving asks first: put it on backorder or change the replacement.',
    );
    expect(preview(2, 1)).toBe(
      'Walk Exchange Tee - 2XL ×2 is short right now (1 available, 2 needed). Approving asks first: put it on backorder or change the replacement.',
    );
    // In stock: the order and its reservation, as before.
    expect(preview(2, 2)).toBe('A replacement order is created for Walk Exchange Tee - 2XL ×2 and 2 are reserved.');
  });
});

describe('the approval review (web and phone)', () => {
  const line = { id: 'x1', requestedItemId: 'l', requestNote: null };

  it('as requested sends the line alone; a note-only request must be changed first', () => {
    expect(exchangeReviewProblem(line, { kind: 'as_requested' })).toBeNull();
    expect(exchangeReviewDecision(line, { kind: 'as_requested' })).toEqual({ action: 'approve', exchangeLineId: 'x1' });
    // Re-pinned by returns RX-2 review fix (simulator fault F-A, 2026-10-06;
    // claim kept: a note-only request must be changed first): the problem
    // line no longer carries the requester's note (below).
    expect(exchangeReviewProblem({ ...line, requestedItemId: null, requestNote: 'L please' }, { kind: 'as_requested' })).toBe(
      'Choose the replacement',
    );
  });

  // Simulator fault F-A (2026-10-06, sim-RX2/shots-fix iphone-P11-30): the
  // problem line is pinned above the approval's button on the phone (and
  // shown beside it on the web), and a "warehouse will review" note may hold
  // 500 characters: inlined, it left the iPhone's AX5 sheet no body and its
  // Approve button off screen. The note shows in the review body; the problem
  // says what to do, in a few words, whatever the note.
  it('never puts the requester note in the problem line (it is pinned above the button)', () => {
    const note = 'Please send the next size up, the sleeves are short. '.repeat(9).trim();
    const problem = exchangeReviewProblem({ ...line, requestedItemId: null, requestNote: note }, { kind: 'as_requested' });
    expect(problem).toBe('Choose the replacement');
    expect(problem!.length).toBeLessThan(40);
    expect(exchangeReviewProblem({ ...line, requestedItemId: null, requestNote: null }, { kind: 'as_requested' })).toBe(
      'Choose the replacement',
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

  // RX-2 review fix P26: VoiceOver read the header's "→" as "right arrow".
  it('names the exchange in words for the header\'s accessible label (review fix P26)', () => {
    expect(exchangeReviewHeaderLabel('Walk Exchange Tee - M', 'Walk Exchange Tee - L')).toBe(
      'Walk Exchange Tee - M, exchange for Walk Exchange Tee - L',
    );
    // A note-only request: the warehouse picks the replacement.
    expect(exchangeReviewHeaderLabel('Walk Exchange Tee - M', null)).toBe('Walk Exchange Tee - M, exchange: Warehouse will review');
    expect(exchangeReviewHeaderLabel('Walk Exchange Tee - M', 'Walk Exchange Tee - L')).not.toMatch(/→/);
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

// Returns RX-3 PR stage, polish (a): the stored line status stays 'approved'
// after the hand-over (0396 has no later line status), so the card reads the
// outcome from the replacement order's own lines, which the workbench already
// sends. One rule for the web card and the phone card.
describe('the REPLACEMENT card after the hand-over (replacementLineHandOver and the card words)', () => {
  const line = (over: Partial<{ status: 'requested' | 'approved' | 'declined' | 'cancelled'; approvedItemId: string | null; approvedQuantity: number | null; requestedQuantity: number }> = {}) => ({
    status: 'approved' as const,
    approvedItemId: 'L',
    approvedQuantity: 1,
    requestedQuantity: 1,
    ...over,
  });
  const repl = (status: string, lines: Array<{ itemId: string; requested: number; fulfilled: number }>, live = true) => ({ live, status, lines });

  it('reads all, part or none sent from the replacement line of the approved item', () => {
    expect(replacementLineHandOver(line(), repl('completed', [{ itemId: 'L', requested: 1, fulfilled: 1 }]))).toBe('all');
    expect(replacementLineHandOver(line(), repl('backordered', [{ itemId: 'L', requested: 2, fulfilled: 1 }]))).toBe('part');
    expect(replacementLineHandOver(line(), repl('completed', [{ itemId: 'L', requested: 1, fulfilled: 0 }, { itemId: 'XL', requested: 1, fulfilled: 1 }]))).toBe('none_sent');
    // Still to be handed over, or nothing to read: no outcome.
    expect(replacementLineHandOver(line(), repl('staged_for_pickup', [{ itemId: 'L', requested: 1, fulfilled: 0 }]))).toBeNull();
    expect(replacementLineHandOver(line(), repl('cancelled', [{ itemId: 'L', requested: 1, fulfilled: 0 }], false))).toBeNull();
    // A replacement that is not live (cancelled or denied) is never read as handed over.
    expect(replacementLineHandOver(line(), repl('cancelled', [{ itemId: 'L', requested: 1, fulfilled: 1 }], false))).toBeNull();
    expect(replacementLineHandOver(line(), null)).toBeNull();
    expect(replacementLineHandOver(line({ approvedItemId: null }), repl('completed', [{ itemId: 'L', requested: 1, fulfilled: 1 }]))).toBeNull();
    expect(replacementLineHandOver(line(), repl('completed', [{ itemId: 'XL', requested: 1, fulfilled: 1 }]))).toBeNull();
    // Only an approved line has a replacement to read.
    for (const status of ['requested', 'declined', 'cancelled'] as const) {
      expect(replacementLineHandOver(line({ status }), repl('completed', [{ itemId: 'L', requested: 1, fulfilled: 1 }])), status).toBeNull();
    }
  });

  it('says Handed over with the quantity handed over, Partly handed over, Not sent, or the stored status', () => {
    const all = repl('completed', [{ itemId: 'L', requested: 2, fulfilled: 2 }]);
    expect(replacementCardStatusLabel(line({ approvedQuantity: 2 }), all)).toBe('Handed over');
    expect(replacementCardQuantityLabel(line({ approvedQuantity: 2 }), all)).toBe('Qty handed over: 2');
    const part = repl('backordered', [{ itemId: 'L', requested: 2, fulfilled: 1 }]);
    expect(replacementCardStatusLabel(line({ approvedQuantity: 2 }), part)).toBe('Partly handed over');
    // Two lines asking for the same item share one order line: the count per
    // line is not known, so the quantity asked for stays.
    expect(replacementCardQuantityLabel(line({ approvedQuantity: 2 }), part)).toBe('Qty requested: 2');
    expect(replacementCardStatusLabel(line(), repl('completed', [{ itemId: 'L', requested: 1, fulfilled: 0 }]))).toBe('Not sent');
    expect(replacementCardStatusLabel(line(), repl('approved', [{ itemId: 'L', requested: 1, fulfilled: 0 }]))).toBe('Approved');
    expect(replacementCardQuantityLabel(line({ approvedQuantity: null, requestedQuantity: 3 }), null)).toBe('Qty requested: 3');
    expect(replacementCardStatusLabel(line({ status: 'declined' }), all)).toBe('Declined');
  });
});

// Returns RX-3 PR stage, polish (d), from the RX-2 Demo Co walk: a cancelled
// RMA's card on the original order showed no exchange line at all (declined
// and cancelled lines were left out), so the order did not say an exchange
// had been asked for and ended. Each line now reads in its own words; the
// SO number only beside an approved line (a cancelled replacement is listed
// on its RMA).
describe('originalExchangeLineFor (the original order\'s returns section, web and phone)', () => {
  const base = { itemLabel: 'Walk Exchange Tee L', quantity: 1, replacementOrderNumber: 29 };
  it('an approved line names its replacement order and the exchange status', () => {
    expect(
      originalExchangeLineFor({ ...base, status: 'approved', exchangeStatus: 'waiting_for_return', statusWords: 'Replacement reserved. Waiting for returned item' }),
    ).toBe('Exchange: Walk Exchange Tee L ×1 → SO-000029 (Replacement reserved. Waiting for returned item)');
    expect(originalExchangeLineFor({ ...base, status: 'requested', exchangeStatus: 'requested', statusWords: 'Exchange requested' })).toBe(
      'Exchange: Walk Exchange Tee L ×1 (Exchange requested)',
    );
  });

  it('a cancelled or declined line says so, without the cancelled order\'s number', () => {
    expect(originalExchangeLineFor({ ...base, status: 'cancelled', exchangeStatus: 'cancelled', statusWords: 'Exchange cancelled' })).toBe(
      'Exchange: Walk Exchange Tee L ×1 (Exchange cancelled)',
    );
    expect(
      originalExchangeLineFor({
        ...base,
        status: 'cancelled',
        exchangeStatus: 'replacement_cancelled',
        statusWords: 'Replacement cancelled: issue a new one or close as return only',
      }),
    ).toBe('Exchange: Walk Exchange Tee L ×1 (Replacement cancelled: issue a new one or close as return only)');
    // A declined line beside an approved one never takes the RMA's words.
    expect(
      originalExchangeLineFor({ ...base, status: 'declined', exchangeStatus: 'waiting_for_return', statusWords: 'Replacement reserved. Waiting for returned item' }),
    ).toBe('Exchange: Walk Exchange Tee L ×1 (Exchange declined)');
    expect(
      originalExchangeLineFor({ ...base, status: 'cancelled', exchangeStatus: 'waiting_for_return', statusWords: 'Replacement reserved. Waiting for returned item' }),
    ).toBe('Exchange: Walk Exchange Tee L ×1 (Exchange cancelled)');
  });

  it('a request made with a note reads Warehouse will review while requested, A different replacement once it ended', () => {
    const note = { itemLabel: null, quantity: 1, replacementOrderNumber: null };
    expect(originalExchangeLineFor({ ...note, status: 'requested', exchangeStatus: 'requested', statusWords: 'Exchange requested' })).toBe(
      'Exchange: Warehouse will review (Exchange requested)',
    );
    expect(originalExchangeLineFor({ ...note, status: 'declined', exchangeStatus: 'declined', statusWords: 'Exchange declined' })).toBe(
      'Exchange: A different replacement (Exchange declined)',
    );
  });
});
