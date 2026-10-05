import { describe, expect, it } from 'vitest';

import type { MobileExchangeLine, MobileReturnExchange, MobileReturnWorkbench } from './returns-api';
import {
  NO_EXCHANGE,
  exchangeApprovalDecisions,
  exchangeForLine,
  exchangeItemLabel,
  exchangeReviewProblems,
  exchangeWhatHappens,
  orderExchangeChip,
  orderReplacementLines,
  prepareOutcomeMessage,
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
      driverLine: 'Collect the returned item: Walk New Hire Shirt, M ×1 (RMA-1)',
    };
    expect(orderReplacementLines(info, 'delivery').map((l) => l.text)).toEqual([
      'Exchange replacement for RMA-1 · Original order SO-000103',
      'Replacement reserved. Waiting for returned item (RMA-1)',
      'Collect the returned item: Walk New Hire Shirt, M ×1 (RMA-1)',
      'Change or cancel this replacement from its RMA.',
    ]);
    expect(orderExchangeChip('rma-1', { replacementOrderId: 'o1', exchangeStatus: 'ready_to_pick' }, 'o1')).toBe('Exchange · Ready to pick');
    expect(orderExchangeChip('rma-1', { replacementOrderId: 'o2', exchangeStatus: 'ready_to_pick' }, 'o1')).toBe('Exchange');
    expect(orderExchangeChip(null, null, 'o1')).toBeNull();
    // Desk check F3: the RMA cancelled while this order is live: it says the
    // replacement is not picked, and the pick slip and Resume are blocked.
    const closed: MobileOrderReplacement = { ...info, waitingForReturn: false, returnClosed: true, returnStatus: 'cancelled' };
    expect(orderReplacementLines(closed, 'pickup').map((l) => l.key)).toEqual(['title', 'closed', 'change']);
    expect(orderReplacementLines(closed, 'pickup')[1]!.text).toBe("RMA-1 was cancelled. This replacement isn't picked.");
    expect(replacementPickBlocked(closed)).toBe(true);
    expect(replacementPickBlocked(info)).toBe(true);
    expect(replacementPickBlocked({ ...info, waitingForReturn: false })).toBe(false);
    expect(replacementPickBlocked(null)).toBe(false);
  });
});
