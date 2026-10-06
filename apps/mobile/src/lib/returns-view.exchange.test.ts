import { describe, expect, it } from 'vitest';

import type { MobileExchangeLine, MobileReplacement, MobileReturnExchange, MobileReturnWorkbench } from './returns-api';
import {
  NO_EXCHANGE,
  changeInRmaLabel,
  exchangeApprovalDecisions,
  exchangeForLine,
  exchangeItemLabel,
  exchangeReviewProblems,
  exchangeReviewStateFor,
  exchangeSheetConsequences,
  exchangeWhatHappens,
  orderExchangeChip,
  orderReplacementLines,
  prepareOutcomeMessage,
  replacementCardLabel,
  replacementPickBlocked,
  replacementOrderLines,
  replacementSideLines,
  returnRowExchange,
  shortSentences,
  workbenchActions,
  type MobileOrderReplacement,
} from './returns-view';

/**
 * The phone's exchange helpers (returns RX-2): the same rules as the web
 * (core availableReturnActions, approvalPreviewLines, the review decisions),
 * the REPLACEMENT side's words, the replacement order block, the prepare
 * words, the list's exchange words and the order screen's banner and chip.
 */

const L = { name: 'Walk New Hire Shirt', sku: 'NH-L', variant: 'Size L', deleted: false, imageUrl: null, thumbUrl: null };

function xline(over: Partial<MobileExchangeLine> = {}): MobileExchangeLine {
  return {
    id: 'x1',
    returnLineId: 'l1',
    status: 'requested',
    requestedItemId: 'item-l',
    requestedQuantity: 1,
    requestNote: null,
    requestedByKind: 'staff',
    requestedItem: L,
    requestedFree: 14,
    approvedItemId: null,
    approvedQuantity: null,
    approvedItem: null,
    approvedFree: null,
    changedByWarehouse: false,
    revision: 0,
    ...over,
  };
}

function exchange(over: Partial<MobileReturnExchange> = {}): MobileReturnExchange {
  return { ...NO_EXCHANGE, kind: 'exchange', status: 'requested', statusLabel: 'Exchange requested', lines: [xline()], createEnabled: true, ...over };
}

function wb(status: string, ex: MobileReturnExchange | undefined, viewer = { canManageReturns: true, canApproveOrders: true, canReadDecisions: true }): MobileReturnWorkbench {
  return {
    organizationId: 'o',
    return: {
      id: 'r1',
      returnNumber: 'RMA-1',
      status,
      source: 'internal',
      reasonCode: null,
      notes: null,
      denialReason: null,
      orderRequestId: 'o1',
      orderNumber: 103,
      warehouseId: null,
      warehouseName: null,
      requesterName: null,
      requesterEmail: null,
      createdAt: '',
      approvedAt: null,
      receivedAt: null,
      closedAt: null,
      deniedAt: null,
      requestedByName: null,
      approvedByName: null,
      receivedByName: null,
      closedByName: null,
      deniedByName: null,
    },
    revision: 0,
    planSeq: 0,
    createdOnCounter: false,
    destinationsUnavailable: false,
    lines: [
      {
        id: 'l1',
        orderRequestLineId: 'ol1',
        itemId: 'item-m',
        quantity: 1,
        disposition: 'restock',
        applied: false,
        item: { name: 'Walk New Hire Shirt', sku: 'NH-M', variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null },
        restock: {
          returnLineId: 'l1',
          itemId: 'item-m',
          quantity: 1,
          disposition: 'restock',
          applied: false,
          plan: null,
          case: 'single_source',
          notRecordedReason: null,
          sources: [{ locationId: 'r31', name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, cap: 1, valid: true, reason: null, writable: true }],
          offerOriginal: true,
          offerSourceIds: [],
          preselect: 'original',
        },
        legs: [],
        inboundState: 'Waiting',
      },
    ],
    chain: [],
    viewer,
    actions: { primary: null, secondary: [], readOnlyReason: null },
    ...(ex ? { exchange: ex } : {}),
  };
}

describe('the workbench actions with an exchange (core rows)', () => {
  const waiting = exchange({
    status: 'waiting_for_return',
    lines: [xline({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: L })],
    hasApprovedExchange: true,
    replacement: { orderId: 'repl', orderNumber: 104, status: 'approved', fulfillmentType: 'pickup', live: true, class: 'undrawn', owed: 1, held: 1, short: false, lines: [] },
  });

  it('waiting: receive, with release, change and cancel of the replacement', () => {
    const a = workbenchActions(wb('approved', waiting), { itemIsHere: false, online: true, busy: false });
    expect(a.primary).toBe('receive');
    expect(a.secondary).toEqual(['release_early', 'change_replacement', 'cancel_replacement', 'cancel']);
    expect(a.disabledReason).toBeNull();
  });

  it('offline: every action waits for a connection', () => {
    const a = workbenchActions(wb('approved', waiting), { itemIsHere: false, online: false, busy: false });
    expect(a.disabledReason).toBe('Needs a connection.');
  });

  it('without order approval the replacement actions go and the screen says why', () => {
    const a = workbenchActions(wb('approved', waiting, { canManageReturns: true, canApproveOrders: false, canReadDecisions: true }), {
      itemIsHere: false,
      online: true,
      busy: false,
    });
    expect(a.secondary).not.toContain('release_early');
    expect(a.readOnlyReason).toBe('Approving the replacement needs order approval permission.');
  });

  it('a server before RX-2 (no exchange half) reads as a plain return', () => {
    expect(workbenchActions(wb('requested', undefined), { itemIsHere: false, online: true, busy: false }).primary).toBe('approve');
    expect(NO_EXCHANGE.kind).toBe('return');
  });
});

describe('the approval review', () => {
  it('needs nothing for "as requested"; a change and a decline need their parts; adds need an item', () => {
    const w = wb('requested', exchange());
    expect(exchangeReviewProblems(w, {}, {})).toEqual([]);
    expect(exchangeReviewProblems(w, { x1: { kind: 'decline', reason: '' } }, {})).toEqual(['Reason for declining the exchange (required)']);
    expect(exchangeReviewProblems(w, {}, { l2: { itemId: null, quantity: 1 } })).toEqual(['Choose the replacement']);
    expect(exchangeApprovalDecisions(w, {}, { l2: { itemId: 'cap-l', quantity: 1 } })).toEqual([
      { action: 'approve', exchangeLineId: 'x1' },
      { action: 'add', returnLineId: 'l2', itemId: 'cap-l', quantity: 1 },
    ]);
  });

  // Review fix P1: a returns manager without order approval approves the
  // return with the exchange declined (the database asks for order approval
  // only to approve or add a replacement). The review starts at the decline,
  // asks its reason, refuses an approve choice before anything is sent, and
  // the decisions are always sent, so a refusal reads as it does on the web.
  it('a returns manager without order approval starts at the decline and sends it (review fix P1)', () => {
    const w = wb('requested', exchange(), { canManageReturns: true, canApproveOrders: false, canReadDecisions: true });
    expect(exchangeReviewStateFor(w, {}, 'x1')).toEqual({ kind: 'decline', reason: '' });
    expect(exchangeReviewProblems(w, {}, {})).toEqual(['Reason for declining the exchange (required)']);
    expect(exchangeReviewProblems(w, { x1: { kind: 'as_requested' } }, {})).toEqual([
      'Approving the replacement needs order approval permission.',
    ]);
    expect(exchangeApprovalDecisions(w, { x1: { kind: 'decline', reason: ' Out of season ' } }, {})).toEqual([
      { action: 'decline', exchangeLineId: 'x1', reason: 'Out of season' },
    ]);
    // Nothing is promised about a replacement they cannot approve.
    expect(exchangeWhatHappens(w, {}, {}, {}, false).map((l) => l.text)).toEqual([
      'Nothing moves now. The returned item stays out until the return is processed.',
      'When processed, Walk New Hire Shirt, M goes back to 31-C.',
    ]);
    // An approver still starts at "Approve as requested".
    expect(exchangeReviewStateFor(wb('requested', exchange()), {}, 'x1')).toEqual({ kind: 'as_requested' });
  });

  it('"What happens when you approve" names the replacement and the wait', () => {
    expect(exchangeWhatHappens(wb('requested', exchange()), {}, {}, {}, false).map((l) => l.text)).toEqual([
      'Nothing moves now. The returned item stays out until the return is processed.',
      'A replacement order is created for Walk New Hire Shirt, L ×1 and 1 is reserved.',
      'Picking waits until Walk New Hire Shirt, M is received.',
      'When processed, Walk New Hire Shirt, M goes back to 31-C.',
    ]);
  });

  it('a short refusal reads as the numbers', () => {
    const w = wb('requested', exchange());
    expect(shortSentences([{ itemId: 'item-l', needed: 1, available: 0 }], (id) => exchangeItemLabel(w, id))).toEqual([
      'Walk New Hire Shirt, L: 0 available, 1 needed.',
    ]);
  });
});

describe('the REPLACEMENT side and the replacement order', () => {
  it('says what was asked, how many and what is available', () => {
    expect(replacementSideLines(xline()).map((l) => l.text)).toEqual([
      'Requested: Walk New Hire Shirt, L',
      'Qty requested: 1',
      'Available: 14',
    ]);
    expect(replacementSideLines(xline({ requestedFree: 0 })).at(-1)).toEqual({ key: 'free', text: 'Short: 0 available, 1 needed.', tone: 'crit' });
    expect(exchangeForLine(wb('requested', exchange()), 'l1')?.id).toBe('x1');
  });

  // RX-2 simulator finding SIM-1: the card is ONE accessible element, so
  // VoiceOver reads only its label. The status pill (Approved, Declined,
  // Cancelled) was left out of it, and a declined line read like a pending
  // request. The label ends with the pill's words, as the RETURNING card's
  // label ends with its own pill.
  it('VoiceOver reads the card with its status, in the words of its pill', () => {
    expect(replacementCardLabel('Walk New Hire Shirt, M', xline())).toBe(
      'REPLACEMENT for Walk New Hire Shirt, M: Requested: Walk New Hire Shirt, L, Qty requested: 1, Available: 14, Requested',
    );
    const declined = xline({
      status: 'declined',
      approvedItemId: 'item-m',
      approvedQuantity: 1,
      approvedItem: { ...L, variant: 'Size M' },
      changedByWarehouse: true,
    });
    expect(replacementCardLabel('Walk New Hire Shirt, S', declined)).toBe(
      'REPLACEMENT for Walk New Hire Shirt, S: Requested: Walk New Hire Shirt, L, Approved: Walk New Hire Shirt, M (Changed by the warehouse), Qty requested: 1, Declined',
    );
    expect(replacementCardLabel('X', xline({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: L }))).toMatch(/, Approved$/);
    expect(replacementCardLabel('X', xline({ status: 'cancelled' }))).toMatch(/, Cancelled$/);
  });

  it('the replacement order block: SO, reserved per line, the take line, the release (reason only for readers)', () => {
    const ex = exchange({
      status: 'ready_to_pick',
      releasedEarly: true,
      release: { byName: 'Dana', reason: 'Swap at delivery: the driver collects the returned item.', at: 't' },
      replacement: {
        orderId: 'repl',
        orderNumber: 104,
        status: 'approved',
        fulfillmentType: 'delivery',
        live: true,
        class: 'undrawn',
        owed: 1,
        held: 1,
        short: false,
        lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'Walk New Hire Shirt, L', item: L, requested: 1, fulfilled: 0, held: 1, take: 'Take Walk New Hire Shirt, L ×1 from 12-B (3 on hand)' }],
      },
    });
    expect(replacementOrderLines({ exchange: ex }, true).map((l) => l.text)).toEqual([
      'Replacement order SO-000104',
      'Walk New Hire Shirt, L ×1 · reserved 1',
      'Take Walk New Hire Shirt, L ×1 from 12-B (3 on hand)',
      'Released before the return by Dana: Swap at delivery: the driver collects the returned item.',
    ]);
    expect(replacementOrderLines({ exchange: ex }, false).at(-1)!.text).toBe('Released before the return by Dana.');
    expect(replacementOrderLines({ exchange: exchange() }, true).map((l) => l.text)).toEqual([
      'No replacement order yet. One is created when the exchange is approved.',
    ]);
  });

  it('prepare: staged words, or the refusal', () => {
    expect(prepareOutcomeMessage({ ran: [{ step: 'stage', outcome: 'done' }], status: 'staged_for_pickup' })).toBe(
      'The replacement is staged. Hand it over on its order.',
    );
    expect(
      prepareOutcomeMessage({ ran: [{ step: 'pick_slip', outcome: 'refused', message: 'Waiting for the returned item.' }], status: 'approved' }),
    ).toBe('Waiting for the returned item.');
  });
});

// Review fix P2: the phone's four sheets that act on the replacement said
// nothing about it (Cancel return asked only for a reason while its
// replacement order was cancelled too). Each now says what happens, in core's
// words (exchangeActionConsequences), the web dialogs' words too.
describe('what each sheet says happens to the replacement (review fix P2)', () => {
  const live = (over: Partial<MobileReplacement> = {}) =>
    exchange({
      status: 'waiting_for_return',
      lines: [xline({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: L })],
      hasApprovedExchange: true,
      replacement: {
        orderId: 'repl',
        orderNumber: 104,
        status: 'approved',
        fulfillmentType: 'pickup',
        live: true,
        class: 'undrawn',
        owed: 1,
        held: 1,
        short: false,
        lines: [],
        ...over,
      },
    });
  const words = (mode: string, ex: MobileReturnExchange | undefined) => exchangeSheetConsequences(mode, { exchange: ex });

  it('Cancel return names the replacement it cancels too, and frees what it holds', () => {
    expect(words('cancel', live()).map((t) => t.text)).toEqual([
      'The return closes as cancelled. Its replacement order SO-000104 is cancelled too and the reserved items are freed.',
    ]);
    // On backorder (nothing held): nothing is said to be freed.
    expect(words('cancel', live({ held: 0, short: true })).map((t) => t.text)).toEqual([
      'The return closes as cancelled. Its replacement order SO-000104 is cancelled too.',
    ]);
  });

  it('Cancel return after a hand-over says what stays handed over', () => {
    const part = live({
      status: 'backordered',
      class: 'handed_over',
      owed: 1,
      held: 0,
      lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'Walk New Hire Shirt, L', item: L, requested: 2, fulfilled: 1, held: 0, take: null }],
    });
    expect(words('cancel', part).map((t) => t.text)).toEqual([
      'The return closes as cancelled. What was already handed over stays handed over; the rest of the replacement is never sent.',
    ]);
    expect(words('cancel', live({ status: 'completed', class: 'handed_over', owed: 0, held: 0 })).map((t) => t.text)).toEqual([
      'The return closes as cancelled. The replacement was already handed over and stays as it is.',
    ]);
  });

  it('Cancel return of a return only, or after the replacement was cancelled, says nothing about one', () => {
    expect(words('cancel', undefined)).toEqual([]);
    expect(words('cancel', live({ live: false, status: 'cancelled', class: 'none' }))).toEqual([]);
  });

  it('Cancel replacement keeps the picked and in-transit warnings first, then says what it does', () => {
    expect(words('cancel_replacement', live({ status: 'in_transit', class: 'drawn', held: 0 }))).toEqual([
      { key: 'drawn', text: 'The picked items go back to Staging on record. Put them in the staging area.' },
      { key: 'in_transit', text: 'Ask the driver to bring it back.' },
      {
        key: 'effect',
        text: 'The replacement order is cancelled. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
      },
    ]);
    expect(words('cancel_replacement', live())).toEqual([
      {
        key: 'effect',
        text: 'The replacement order is cancelled and its reserved items are freed. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
      },
    ]);
  });

  it('Change replacement and Issue a new replacement say what is created; other sheets say nothing', () => {
    expect(words('change_replacement', live()).map((t) => t.text)).toEqual([
      'The current replacement order is cancelled and a new one is created and reserved in the same step.',
    ]);
    expect(words('issue_replacement', live({ live: false, status: 'cancelled', class: 'none' })).map((t) => t.text)).toEqual([
      'A new replacement order is created and reserved.',
    ]);
    for (const mode of ['approve', 'process', 'destination', 'deny', 'release', 'close_as_return_only']) {
      expect(words(mode, live())).toEqual([]);
    }
  });
});

describe('the list and the order screen', () => {
  it('the returns list row names an exchange and its replacement', () => {
    const base = {
      id: 'r',
      returnNumber: 'RMA-1',
      status: 'approved',
      source: 'internal',
      reasonCode: null,
      orderRequestId: 'o',
      orderNumber: 103,
      requesterName: null,
      requesterEmail: null,
      createdAt: '',
      approvedAt: null,
      waitingDays: null,
      lineCount: 1,
      unitCount: 1,
      items: [],
      moreItems: 0,
    };
    expect(returnRowExchange({ ...base, type: 'return' })).toBeNull();
    expect(
      returnRowExchange({ ...base, type: 'exchange', exchangeStatusLabel: 'Replacement reserved. Waiting for returned item', replacementOrderNumber: 104 }),
    ).toBe('Exchange · Replacement reserved. Waiting for returned item · SO-000104');
  });

  it("the order screen's banner lines and the orders list chip", () => {
    const info: MobileOrderReplacement = {
      returnId: 'rma-1',
      returnNumber: 'RMA-1',
      returnStatus: 'approved',
      originalOrderId: 'orig',
      originalOrderNumber: 103,
      live: true,
      exchangeStatus: 'waiting_for_return',
      exchangeStatusLabel: 'x',
      waitingForReturn: true,
      releasedEarly: false,
      release: null,
      returnReceived: false,
      revision: 1,
      canOpenReturn: true,
      canReleaseEarly: true,
      slipLine: 's',
      driverLine: 'On delivery, the driver collects the returned item: Walk New Hire Shirt, M ×1 (RMA-1).',
    };
    // Re-pinned by returns RX-2 review fix (core fb895ae8, review P9 + P10;
    // the claim is kept: the banner's lines are core's rule, the web's too).
    // While the gate holds nothing has left yet, so there is no driver line;
    // and a reader who can open the RMA gets the RMA link itself, never the
    // sentence beside it ("Change or cancel this replacement from its RMA.
    // Change or cancel in RMA-1" read the same thing twice).
    expect(orderReplacementLines(info, 'delivery').map((l) => l.text)).toEqual([
      'Exchange replacement for RMA-1 · Original order SO-000103',
      'Replacement reserved. Waiting for returned item (RMA-1)',
      'Change or cancel in RMA-1',
    ]);
    // The driver's line is still there for a delivery released early whose
    // returned item is not in yet.
    expect(
      orderReplacementLines({ ...info, waitingForReturn: false, releasedEarly: true, release: { byName: 'Dana', reason: null, at: null } }, 'delivery').map(
        (l) => l.key,
      ),
    ).toEqual(['title', 'released', 'driver', 'rma_link']);
    expect(orderExchangeChip('rma-1', { replacementOrderId: 'o1', exchangeStatus: 'ready_to_pick' }, 'o1')).toBe('Exchange · Ready to pick');
    expect(orderExchangeChip('rma-1', { replacementOrderId: 'o2', exchangeStatus: 'ready_to_pick' }, 'o1')).toBe('Exchange');
    expect(orderExchangeChip(null, null, 'o1')).toBeNull();
    // Desk check F3: the RMA cancelled while this order is live: it says the
    // replacement is not picked, and the pick slip and Resume are blocked.
    const closed: MobileOrderReplacement = { ...info, waitingForReturn: false, returnClosed: true, returnStatus: 'cancelled' };
    // Re-pinned by returns RX-2 review fix (core fb895ae8): the RMA link, as above.
    expect(orderReplacementLines(closed, 'pickup').map((l) => l.key)).toEqual(['title', 'closed', 'rma_link']);
    expect(orderReplacementLines(closed, 'pickup')[1]!.text).toBe("RMA-1 was cancelled. This replacement isn't picked.");
    expect(replacementPickBlocked(closed)).toBe(true);
    expect(replacementPickBlocked(info)).toBe(true);
    expect(replacementPickBlocked({ ...info, waitingForReturn: false })).toBe(false);
    expect(replacementPickBlocked(null)).toBe(false);
    expect(changeInRmaLabel(info)).toBe('Change or cancel in RMA-1');
    // Desk check F9 (verifier): handed over (its order completed), part never
    // sent, then the RMA cancelled: the banner says how the exchange ended,
    // never the gate, "isn't picked", the driver's line or "Change or
    // cancel", and the link only opens the RMA (core's rule, the web's too).
    const handed: MobileOrderReplacement = {
      ...info,
      handedOver: true,
      waitingForReturn: false,
      returnClosed: true,
      returnStatus: 'cancelled',
      exchangeStatus: 'handed_over_return_cancelled',
      exchangeStatusLabel: 'Part of the replacement handed over, the rest not sent; return cancelled',
    };
    expect(orderReplacementLines(handed, 'delivery')).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'handed_over', text: 'Part of the replacement handed over, the rest not sent; return cancelled' },
    ]);
    expect(changeInRmaLabel(handed)).toBe('Open RMA-1');
  });
});
