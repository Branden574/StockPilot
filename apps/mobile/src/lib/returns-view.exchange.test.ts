import { exchangeRail, type ExchangeReviewState } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import { FX_ITEM_A, fxFacts, fxItem, fxLine, fxResult } from './__fixtures__/readiness-facts';
import type { MobileExchangeLine, MobileReplacement, MobileReturnExchange, MobileReturnWorkbench } from './returns-api';
import {
  NO_EXCHANGE,
  actionHelp,
  actionLabel,
  cancelReplacementMessage,
  shortBackorderLabel,
  shownReplacementStatus,
  itemPhotoUrl,
  changeInRmaLabel,
  exchangeApprovalDecisions,
  exchangeForLine,
  exchangeItemLabel,
  exchangeRailText,
  exchangeReviewProblems,
  exchangeReviewStateFor,
  exchangeSheetConsequences,
  exchangeWhatHappens,
  orderExchangeChip,
  orderReplacementLines,
  prepareOutcomeMessage,
  replacementCardLabel,
  replacementCardStatus,
  replacementGateLine,
  replacementOrderHref,
  replacementPhotoUrl,
  replacementHeldNow,
  replacementPickBlocked,
  replacementOrderLines,
  replacementQuantityMax,
  replacementQuantityStepLabel,
  replacementSideLines,
  refusalRefreshesWorkbench,
  returnRowExchange,
  reviewsForShortChange,
  shortItemLabel,
  shortSentences,
  stepOutcomeMessage,
  stepReplacementQuantity,
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
    // Re-pinned by fix round 1 (verification L3): after the approval the words
    // say what needs order approval, the return cancel included.
    expect(a.readOnlyReason).toBe(
      'Changing, cancelling, releasing, preparing or issuing the replacement, and cancelling this return, need order approval permission.',
    );
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

  // RX-3 fix round 1 (desk check M3; RX-2 verify C-4): a note-only request
  // opened at "Approve as requested", which is off for it, and the pinned line
  // then read "Choose the replacement". It opens at Change replacement with
  // nothing chosen, at the quantity coming back.
  it('a note-only request opens at Change replacement for an approver, at the decline for a decline-only viewer', () => {
    const noteOnly = exchange({ lines: [xline({ requestedItemId: null, requestedItem: null, requestedFree: null, requestNote: 'A bigger one', requestedByKind: 'requester' })] });
    expect(exchangeReviewStateFor(wb('requested', noteOnly), {}, 'x1')).toEqual({
      kind: 'change',
      itemId: null,
      label: null,
      free: null,
      quantity: 1,
      reason: '',
    });
    expect(
      exchangeReviewStateFor(wb('requested', noteOnly, { canManageReturns: true, canApproveOrders: false, canReadDecisions: true }), {}, 'x1'),
    ).toEqual({ kind: 'decline', reason: '' });
  });

  // Review fix P7: after a short refusal the sheet offered only "Approve,
  // replacement on backorder" (the What's New says: that or Change
  // replacement). "Change replacement" switches each short line approved as
  // requested to Change replacement, its picker open with nothing chosen,
  // and names the lines to scroll to and focus, in screen order.
  it('a short refusal switches each short line to Change replacement (review fix P7)', () => {
    const XL = { ...L, sku: 'NH-XL', variant: 'Size XL' };
    const two = wb('requested', exchange({ lines: [xline(), xline({ id: 'x2', returnLineId: 'l2', requestedItemId: 'item-xl', requestedItem: XL })] }));
    two.lines.push({ ...two.lines[0]!, id: 'l2', orderRequestLineId: 'ol2', quantity: 2 });
    const detail = [{ itemId: 'item-xl', needed: 1, available: 0 }];
    expect(reviewsForShortChange(two, {}, detail, {})).toEqual({
      reviews: { x2: { kind: 'change', itemId: null, label: null, free: null, quantity: 1, reason: '' } },
      focusIds: ['x2'],
    });
    // A change already under way to a short item keeps its choice (its picker
    // is open) and is still the one to look at; a declined line is not short.
    const changing: Record<string, ExchangeReviewState> = {
      x1: { kind: 'decline', reason: 'No' },
      x2: { kind: 'change', itemId: 'item-xl', label: 'XL', free: 0, quantity: 1, reason: 'Fits' },
    };
    expect(reviewsForShortChange(two, changing, detail, {})).toEqual({ reviews: changing, focusIds: ['x2'] });
    // An added replacement that is short: its line is the one to look at.
    const plain = wb('requested', exchange({ lines: [] }));
    expect(reviewsForShortChange(plain, {}, [{ itemId: 'cap-l', needed: 1, available: 0 }], { l1: { itemId: 'cap-l', quantity: 1 } }).focusIds).toEqual([
      'l1',
    ]);
    // Without order approval nothing switches (Change is off for them).
    const declineOnly = wb('requested', exchange(), { canManageReturns: true, canApproveOrders: false, canReadDecisions: true });
    expect(reviewsForShortChange(declineOnly, {}, [{ itemId: 'item-l', needed: 1, available: 0 }], {})).toEqual({ reviews: {}, focusIds: [] });
    // A detail that cannot be read switches nothing.
    expect(reviewsForShortChange(two, {}, 'nonsense', {})).toEqual({ reviews: {}, focusIds: [] });
  });

  // Review fix P12: the phone could not change the replacement's quantity
  // (the web's QuantityField at the approval's Change replacement, Add a
  // replacement, and the Change and Issue dialogs). The stepper runs from 1
  // to the returned quantity of its line, as the web's field does; the server
  // refuses more and checks what the original line has left.
  it('the replacement quantity steps from 1 to the returned quantity (review fix P12)', () => {
    const w = wb('requested', exchange());
    w.lines[0] = { ...w.lines[0]!, quantity: 3 };
    expect(replacementQuantityMax(w, 'l1')).toBe(3);
    expect(replacementQuantityMax(w, 'missing')).toBe(1);
    expect(stepReplacementQuantity(1, 1, 3)).toBe(2);
    expect(stepReplacementQuantity(3, 1, 3)).toBe(3);
    expect(stepReplacementQuantity(1, -1, 3)).toBe(1);
    // A quantity above the cap (an older approval) comes back within it.
    expect(stepReplacementQuantity(5, -1, 3)).toBe(3);
    expect(stepReplacementQuantity(Number.NaN, 1, 3)).toBe(2);
    expect(replacementQuantityStepLabel(1, 'Walk Exchange Tee - M')).toBe('Increase the replacement quantity for Walk Exchange Tee - M');
    expect(replacementQuantityStepLabel(-1, 'Walk Exchange Tee - M')).toBe('Decrease the replacement quantity for Walk Exchange Tee - M');
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

  // Simulator fault F-C (2026-10-06, sim-RX2/shots-fix iphone-OFF-05,
  // ipad-P7-20): an item chosen in the review through Change replacement (or
  // Add a replacement) is not one of the exchange's own items, so a short
  // refusal named it "Item: 0 available, 1 needed." while the preview above
  // named it. The label comes from the review's own choice first.
  it('a short refusal names an item chosen through Change replacement or Add a replacement (simulator fault F-C)', () => {
    const w = wb('requested', exchange());
    const reviews = {
      x1: { kind: 'change' as const, itemId: 'item-xl', label: 'Walk New Hire Shirt, XL', free: 0, quantity: 1, reason: 'Out of L' },
    };
    const adds = { l9: { itemId: 'cap-l', label: 'Walk Cap, L', quantity: 1, free: 0 } };
    expect(
      shortSentences(
        [
          { itemId: 'item-xl', needed: 1, available: 0 },
          { itemId: 'cap-l', needed: 1, available: 0 },
          { itemId: 'item-l', needed: 1, available: 0 },
        ],
        (id) => shortItemLabel(w, reviews, adds, id),
      ),
    ).toEqual([
      'Walk New Hire Shirt, XL: 0 available, 1 needed.',
      'Walk Cap, L: 0 available, 1 needed.',
      'Walk New Hire Shirt, L: 0 available, 1 needed.',
    ]);
    expect(shortItemLabel(w, {}, {}, 'unknown')).toBe('Item');
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

  // Review fixes P19 and P22: after a pick the block read "· reserved 0"
  // (nothing is reserved once picked), and earlier replacements were listed
  // on the web only. Each line is core's replacementLineSummary, and the
  // earlier ones are core's earlierReplacementsLine (order status words).
  it('a picked replacement reads picked, a part hand-over both numbers; earlier replacements are listed (review fixes P19, P22)', () => {
    const block = (status: string, line: Partial<MobileReplacement['lines'][number]>, history: MobileReturnExchange['history'] = []) =>
      replacementOrderLines(
        {
          exchange: exchange({
            status: 'in_progress',
            history,
            replacement: {
              orderId: 'repl',
              orderNumber: 104,
              status,
              fulfillmentType: 'pickup',
              live: true,
              class: 'drawn',
              owed: 1,
              held: 0,
              short: false,
              lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'Walk New Hire Shirt, L', item: L, requested: 1, fulfilled: 0, held: 0, take: null, ...line }],
            },
          }),
        },
        true,
      ).map((t) => t.text);
    expect(block('picking_complete', {})[1]).toBe('Walk New Hire Shirt, L ×1 · picked');
    expect(block('staged_for_pickup', {})[1]).toBe('Walk New Hire Shirt, L ×1 · picked');
    expect(block('backordered', { requested: 2, fulfilled: 1 })[1]).toBe('Walk New Hire Shirt, L ×2 · handed over 1 · reserved 0');
    expect(block('completed', { fulfilled: 1 })[1]).toBe('Walk New Hire Shirt, L ×1 · handed over 1');
    expect(block('approved', { held: 1 })[1]).toBe('Walk New Hire Shirt, L ×1 · reserved 1');
    const earlier = block('approved', { held: 1 }, [
      { orderId: '0b000000-0000-0000-0000-000000000098', orderNumber: 98, status: 'cancelled' },
      { orderId: '0b000000-0000-0000-0000-000000000097', orderNumber: 97, status: 'staged_for_pickup' },
    ]);
    expect(earlier.at(-1)).toBe('Earlier replacements: SO-000098 (cancelled), SO-000097 (staged (pickup))');
    // Never a raw status code.
    expect(block('approved', {}, [{ orderId: '0b000000-0000-0000-0000-000000000096', orderNumber: 96, status: 'some_new_status' }]).at(-1)).toBe(
      'Earlier replacements: SO-000096',
    );
  });

  // Review fix P23: "Return approved." after approving an exchange said
  // nothing about the replacement order it created. The words are core's
  // approvalOutcomeLine, from the workbench the steps route answers.
  it('the approval outcome names the replacement order and what it reserved (review fix P23)', () => {
    const live = (over: Partial<MobileReplacement> = {}) =>
      exchange({
        status: 'waiting_for_return',
        lines: [xline({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: L })],
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
          lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'Walk New Hire Shirt, L', item: L, requested: 1, fulfilled: 0, held: 1, take: null }],
          ...over,
        },
      });
    const done = { step: 'approve' as const, outcome: 'done' as const };
    expect(stepOutcomeMessage(done, wb('approved', live()), false)).toBe('Approved. Replacement order SO-000104 created and 1 reserved.');
    expect(
      stepOutcomeMessage(
        done,
        wb('approved', live({ held: 0, short: true, lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'L', item: L, requested: 1, fulfilled: 0, held: 0, take: null }] })),
        false,
      ),
    ).toBe('Approved. Replacement order SO-000104 is on backorder.');
    expect(stepOutcomeMessage(done, wb('received', live()), true)).toBe('Approved and received. Replacement order SO-000104 created and 1 reserved.');
    // The exchange declined (no replacement order): the return's own words.
    expect(stepOutcomeMessage(done, wb('approved', exchange({ status: 'declined' })), false)).toBe('Return approved.');
    expect(stepOutcomeMessage({ step: 'approve', outcome: 'already' }, wb('approved', live()), false)).toBe('Already approved.');
  });

  // Review fix P18: "Get replacement ready" draws stock and stages the order
  // with no word on screen first. Its help (core's, which never says it
  // prints) is shown under it and is its VoiceOver hint.
  it('says what Get replacement ready does (review fix P18)', () => {
    expect(actionHelp('get_replacement_ready')).toBe(
      'Makes the pick slip, records the pick, makes the packing slips and stages it. Take the item from the rack shown first. Stops before the signature.',
    );
    expect(actionHelp('receive')).toBeNull();
    expect(actionHelp(null)).toBeNull();
  });

  // Review fix (0396, stock S2): an RMA cancel while its replacement is
  // picked or on its way is refused replacement_in_progress, a sign the
  // screen is behind the server, like return_changed. The workbench reloads
  // and says why instead of leaving the old actions up.
  it('a refusal that means the screen is behind reloads the workbench (review fix S2)', () => {
    // Returns RX-4 (0397): Close the rest finds nothing on backorder any more
    // (the rest was resumed or closed meanwhile): the screen is behind too.
    for (const reason of ['return_changed', 'invalid_status_transition', 'replacement_in_progress', 'replacement_not_backordered']) {
      expect(refusalRefreshesWorkbench(reason), reason).toBe(true);
    }
    for (const reason of ['reason_required', 'replacement_unavailable', 'replacement_site_not_available', 'exchange_already_sent', 'busy', null]) {
      expect(refusalRefreshesWorkbench(reason), String(reason)).toBe(false);
    }
  });

  // Returns RX-2 review (counter taps): Hand over opens the replacement's
  // order with the paper signature ready (?focus=sign); Open replacement
  // just opens it.
  it('Hand over opens the replacement order ready to sign; Open replacement just opens it', () => {
    expect(replacementOrderHref('o-104', 'hand_over')).toBe('/order/o-104?focus=sign');
    expect(replacementOrderHref('o-104', 'open_replacement')).toBe('/order/o-104');
  });

  // Review fix P11 (parity, brief 27 and 30): the phone showed no photo of
  // the replacement. The REPLACEMENT card shows the chosen item's photo (the
  // approved one, else the one asked for), the thumbnail first, as the
  // RETURNING card does; nothing for a note-only request.
  it("the replacement's photo: the approved item's, else the requested one's, thumbnail first (review fix P11)", () => {
    const pic = (thumbUrl: string | null, imageUrl: string | null) => ({ ...L, thumbUrl, imageUrl });
    expect(replacementPhotoUrl(xline({ requestedItem: pic('t-l', 'i-l') }))).toBe('t-l');
    expect(replacementPhotoUrl(xline({ requestedItem: pic(null, 'i-l') }))).toBe('i-l');
    expect(replacementPhotoUrl(xline({ requestedItem: pic('t-l', null), approvedItemId: 'item-m', approvedItem: pic('t-m', null) }))).toBe('t-m');
    expect(replacementPhotoUrl(xline({ requestedItemId: null, requestedItem: null, requestNote: 'A bigger one' }))).toBeNull();
    expect(itemPhotoUrl(null)).toBeNull();
    expect(itemPhotoUrl(pic(null, null))).toBeNull();
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

// Review fixes P4 and P21: after a declined or cancelled exchange the rail
// still read "next" for every later step (on screen nothing, but VoiceOver
// said "Waiting for return, next; Picking, next; ...") and the empty block
// promised "One is created when the exchange is approved.". The rail prints
// every step's state in core's words, VoiceOver reads core's one label, and
// the empty block says why there is no replacement order.
describe('the rail and the empty replacement block (review fixes P4 and P21)', () => {
  const declined = exchangeRail({ exchangeStatus: 'declined', returnStatus: 'approved', releasedEarly: false, fulfillmentType: null });

  it("prints each step with its state in core's words; after a stop nothing reads next", () => {
    expect(exchangeRailText(declined)).toBe(
      'Requested (done)  →  Declined (stopped)  →  Waiting for return (not reached)  →  Picking (not reached)  →  Ready for pickup (not reached)  →  Handed over (not reached)',
    );
    const cancelledReplacement = exchangeRail({
      exchangeStatus: 'replacement_cancelled',
      returnStatus: 'approved',
      releasedEarly: false,
      fulfillmentType: 'pickup',
    });
    expect(exchangeRailText(cancelledReplacement)).toContain('Waiting for return (not started)');
    // A replacement closed with part never sent ends "Partly handed over" (P21).
    const partly = exchangeRail({
      exchangeStatus: 'completed',
      returnStatus: 'closed',
      releasedEarly: false,
      fulfillmentType: 'pickup',
      replacementStatus: 'completed',
      replacementOwed: 1,
    });
    expect(exchangeRailText(partly)).toMatch(/Partly handed over \(stopped\)$/);
    // A live one still says what is next.
    const waiting = exchangeRail({ exchangeStatus: 'waiting_for_return', returnStatus: 'approved', releasedEarly: false, fulfillmentType: 'pickup' });
    expect(exchangeRailText(waiting)).toBe(
      'Requested (done)  →  Reserved (done)  →  Waiting for return (now)  →  Picking (next)  →  Ready for pickup (next)  →  Handed over (next)',
    );
    expect(exchangeRailText([])).toBe('');
  });

  it('the empty replacement block says why there is no replacement order', () => {
    const none = (status: MobileReturnExchange['status'], returnStatus = 'approved') =>
      replacementOrderLines({ exchange: exchange({ status, lines: [xline({ status: status === 'declined' ? 'declined' : 'cancelled' })] }), return: { status: returnStatus } }, true).map(
        (l) => l.text,
      );
    expect(none('declined')).toEqual(['No replacement order: the exchange was declined.']);
    expect(none('cancelled', 'cancelled')).toEqual(['No replacement order: the exchange was cancelled with the return.']);
    // A denied return's exchange reads declined, as its staff label does.
    expect(none('cancelled', 'denied')).toEqual(['No replacement order: the exchange was declined.']);
    expect(replacementOrderLines({ exchange: exchange(), return: { status: 'requested' } }, true).map((l) => l.text)).toEqual([
      'No replacement order yet. One is created when the exchange is approved.',
    ]);
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

// Review fixes P5, P9 and P10 on the order screen: the banner is read by
// someone (the RMA link for returns staff, who to ask for the requester, who
// can for anyone else), the driver's line shows only for an early-released
// delivery and never to the requester, and the gate says "Not in stock yet"
// when the replacement holds nothing (never "Replacement reserved").
describe("the replacement order's banner for who reads it, and its gate words (review fixes P5, P9, P10)", () => {
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
    canOpenReturn: false,
    canReleaseEarly: false,
    slipLine: 's',
    driverLine: 'On delivery, the driver collects the returned item: Walk New Hire Shirt, M ×1 (RMA-1).',
  };
  const keys = (lines: { key: string }[]) => lines.map((l) => l.key);

  it('the requester is told to contact the warehouse; anyone else, who can; returns staff get the RMA link', () => {
    expect(orderReplacementLines(info, 'pickup', { isRequester: true }).map((l) => l.text)).toEqual([
      'Exchange replacement for RMA-1 · Original order SO-000103',
      'Replacement reserved. Waiting for returned item (RMA-1)',
      'To change or cancel this replacement, contact the warehouse.',
    ]);
    expect(orderReplacementLines(info, 'pickup', { isRequester: false }).at(-1)).toEqual({
      key: 'change',
      text: 'Only someone who manages returns can change or cancel this replacement (RMA-1).',
    });
    // Returns staff who also asked for it read it as staff.
    expect(orderReplacementLines({ ...info, canOpenReturn: true }, 'pickup', { isRequester: true }).at(-1)).toEqual({
      key: 'rma_link',
      text: 'Change or cancel in RMA-1',
    });
  });

  it("the driver's line once, for an early-released delivery not yet returned, never to the requester", () => {
    const released: MobileOrderReplacement = {
      ...info,
      waitingForReturn: false,
      releasedEarly: true,
      release: { byName: 'Dana', reason: null, at: null },
    };
    expect(keys(orderReplacementLines(released, 'delivery', { isRequester: false }))).toEqual(['title', 'released', 'driver', 'change']);
    expect(keys(orderReplacementLines(released, 'delivery', { isRequester: true }))).not.toContain('driver');
    expect(keys(orderReplacementLines(released, 'pickup', { isRequester: false }))).not.toContain('driver');
    expect(keys(orderReplacementLines({ ...released, returnReceived: true }, 'delivery', { isRequester: false }))).not.toContain('driver');
    expect(keys(orderReplacementLines(info, 'delivery', { isRequester: false }))).not.toContain('driver');
  });

  it('the gate says Not in stock yet when nothing is held, in the banner and beside the release', () => {
    const notHeld = 'Not in stock yet. Picking also waits for the returned item (RMA-1).';
    expect(replacementGateLine(info, 0)).toBe(notHeld);
    expect(replacementGateLine(info, 1)).toBe('Replacement reserved. Waiting for returned item (RMA-1)');
    // Unknown holds: the exchange status decides (a backorder is unavailable).
    expect(replacementGateLine({ ...info, exchangeStatus: 'unavailable' }, null)).toBe(notHeld);
    expect(replacementGateLine(info, null)).toBe('Replacement reserved. Waiting for returned item (RMA-1)');
    expect(orderReplacementLines(info, 'pickup', { isRequester: false, held: 0 })[1]).toEqual({ key: 'gate', text: notHeld });
    // The server's number when it sends one.
    expect(orderReplacementLines({ ...info, held: 0 }, 'pickup', { isRequester: false })[1]!.text).toBe(notHeld);
  });

  it('what the replacement holds: the server number, else every owed line from readiness, else unknown', () => {
    const approved = (heldOwn: number, visible = true) =>
      fxResult(
        fxFacts({
          status: 'approved',
          lines: [fxLine('ol1', FX_ITEM_A, 1)],
          items: [visible ? fxItem(FX_ITEM_A, { heldOwn }) : { itemId: FX_ITEM_A, visible: false }],
        }),
      );
    expect(replacementHeldNow({ held: 2 }, approved(0))).toBe(2);
    expect(replacementHeldNow({}, approved(1))).toBe(1);
    expect(replacementHeldNow({ held: null }, approved(0))).toBe(0);
    // A line whose hold is unknown (the item hidden) leaves it unknown.
    expect(replacementHeldNow({}, approved(1, false))).toBeNull();
    expect(replacementHeldNow({}, { state: 'failed', message: 'x' })).toBeNull();
    expect(replacementHeldNow({}, null)).toBeNull();
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

// RX-2 fix round 1 (independent verification 2026-10-11).
describe('fix round 1 on the phone', () => {
  const live = exchange({
    status: 'waiting_for_return',
    lines: [xline({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: 1, approvedItem: L })],
    hasApprovedExchange: true,
    replacement: { orderId: 'repl', orderNumber: 104, status: 'approved', fulfillmentType: 'pickup', live: true, class: 'undrawn', owed: 1, held: 1, short: false, lines: [] },
  });

  // Verification V1: the cancel sends the status the sheet showed, and the
  // notice (an alert, announced) says what to do with what was picked or sent.
  it('Cancel replacement names the status it showed and says what happened', () => {
    expect(shownReplacementStatus(wb('approved', live))).toBe('approved');
    expect(shownReplacementStatus(wb('approved', exchange({ replacement: null })))).toBeNull();
    expect(shownReplacementStatus(wb('approved', undefined))).toBeNull();
    expect(cancelReplacementMessage({ changed: true, drawn: false, inTransit: false })).toBe('Replacement cancelled.');
    expect(cancelReplacementMessage({ changed: true, drawn: true, inTransit: true })).toBe(
      'Replacement cancelled. The picked items go back to Staging on record. Put them in the staging area. Ask the driver to bring it back.',
    );
    expect(cancelReplacementMessage({ changed: false, drawn: false, inTransit: false })).toBe('There is no replacement to cancel any more.');
  });

  // Verification L1: in Change replacement and Issue a new replacement a short
  // pick is named by its own row label, and the backorder button says what it does.
  it('names a short pick by its row label, and words the backorder button for the mode', () => {
    expect(shortItemLabel(wb('approved', live), {}, {}, 'item-2xl')).toBe('Item');
    expect(shortItemLabel(wb('approved', live), {}, {}, 'item-2xl', { x1: { itemId: 'item-2xl', label: 'Walk New Hire Shirt, 2XL' } })).toBe(
      'Walk New Hire Shirt, 2XL',
    );
    expect(shortBackorderLabel('approve')).toBe('Approve, replacement on backorder');
    expect(shortBackorderLabel('change_replacement')).toBe('Change, replacement on backorder');
    expect(shortBackorderLabel('issue_replacement')).toBe('Issue, replacement on backorder');
  });

  // Verification L3: a viewer who can only decline approves the return.
  it('a decline-only viewer reads "Approve return"', () => {
    expect(actionLabel('approve', { hasExchange: true, canApproveOrders: false })).toBe('Approve return');
    expect(actionLabel('approve', { hasExchange: true, canApproveOrders: true })).toBe('Approve return & exchange');
  });

  // Verification L5: the RMA link promises a change or cancel only to a
  // viewer who may make it (the server says so; an older one does not).
  it('the order banner\'s RMA link reads "Open RMA-…" for a viewer who cannot change or cancel', () => {
    const info = {
      returnId: 'r1',
      returnNumber: 'RMA-1',
      returnStatus: 'approved',
      originalOrderId: 'o1',
      originalOrderNumber: 103,
      live: true,
      handedOver: false,
      exchangeStatus: 'ready_to_pick',
      exchangeStatusLabel: 'Ready to pick',
      waitingForReturn: false,
      returnClosed: false,
      releasedEarly: false,
      release: null,
      returnReceived: true,
      revision: 1,
      canOpenReturn: true,
      canReleaseEarly: false,
      canChangeReplacement: false,
      slipLine: '',
      driverLine: null,
    };
    expect(orderReplacementLines(info, 'pickup').find((l) => l.key === 'rma_link')?.text).toBe('Open RMA-1');
    expect(changeInRmaLabel(info)).toBe('Open RMA-1');
    expect(changeInRmaLabel({ ...info, canChangeReplacement: true })).toBe('Change or cancel in RMA-1');
  });
});

// Returns RX-3 PR stage, polish (a), from the RX-2 Demo Co walk (iPad and
// iPhone): after the exchange completed the card read "Requested: Walk
// Exchange Tee L, Qty requested: 1, Approved". The line's stored status stays
// approved; the replacement block the workbench already sends says what was
// handed over, so the card says the outcome (core's rule, the web's too).
describe('the REPLACEMENT card once its replacement was handed over', () => {
  const approved = (qty: number) => xline({ status: 'approved', approvedItemId: 'item-l', approvedQuantity: qty, approvedItem: L });
  const repl = (status: string, requested: number, fulfilled: number): MobileReplacement => ({
    orderId: 'repl',
    orderNumber: 104,
    status,
    fulfillmentType: 'pickup',
    live: true,
    class: fulfilled > 0 ? 'handed_over' : 'undrawn',
    owed: requested - fulfilled,
    held: 0,
    short: false,
    lines: [{ orderLineId: 'ol9', itemId: 'item-l', label: 'Walk New Hire Shirt, L', item: L, requested, fulfilled, held: 0, take: null }],
  });

  it('says Handed over and how many once all of it was handed over, in the pill and in the VoiceOver label', () => {
    const r = repl('completed', 1, 1);
    expect(replacementCardStatus(approved(1), r)).toBe('Handed over');
    expect(replacementSideLines(approved(1), r).map((l) => l.text)).toEqual(['Requested: Walk New Hire Shirt, L', 'Qty handed over: 1']);
    expect(replacementCardLabel('Walk New Hire Shirt, M', approved(1), r)).toBe(
      'REPLACEMENT for Walk New Hire Shirt, M: Requested: Walk New Hire Shirt, L, Qty handed over: 1, Handed over',
    );
  });

  it('says Partly handed over while the rest is on backorder, and Not sent for an item closed with none handed over', () => {
    expect(replacementCardStatus(approved(2), repl('backordered', 2, 1))).toBe('Partly handed over');
    expect(replacementSideLines(approved(2), repl('backordered', 2, 1)).map((l) => l.text)).toContain('Qty requested: 2');
    expect(replacementCardStatus(approved(1), repl('completed', 1, 0))).toBe('Not sent');
  });

  it('keeps Approved while the replacement is still to be handed over, and for a cancelled replacement', () => {
    expect(replacementCardStatus(approved(1), repl('approved', 1, 0))).toBe('Approved');
    expect(replacementCardStatus(approved(1), { ...repl('cancelled', 1, 0), live: false })).toBe('Approved');
    expect(replacementCardStatus(approved(1), null)).toBe('Approved');
    expect(replacementCardStatus(xline({ status: 'declined' }), repl('completed', 1, 1))).toBe('Declined');
  });
});
