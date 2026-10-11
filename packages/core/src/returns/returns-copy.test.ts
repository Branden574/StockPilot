import { describe, expect, it } from 'vitest';

import { EXCHANGE_STATUSES, EXCHANGE_STATUS_STAFF_LABELS, exchangeRequesterSentence, RETURN_LIST_FILTERS } from './exchange-status';
import { mapReturnError, RESTOCK_PROBLEM_WORDS, RETURN_ERROR_WORDS } from './return-error-map';
import { RETURN_ACTION_LABELS } from './return-actions';
import {
  againstOrderLabel,
  alreadyClosedSentence,
  alreadyReceivedSentence,
  approvalOutcomeLine,
  approveReplacementSentence,
  availableLabel,
  cancelReturnReplacementSentence,
  changeOrCancelInRmaLabel,
  collectReturnedItemLine,
  createdAsReplacementLabel,
  earlierReplacementEntries,
  earlierReplacementsLine,
  exchangeReplacementBanner,
  itemQuantityLabel,
  openRmaLabel,
  originalExchangeLine,
  pickingWaitsSentence,
  PREPARE_FORBIDDEN_WORDS,
  prepareStepRefusalWords,
  prepareTakeLine,
  releasedBeforeReturnLine,
  releaseOutcomeLine,
  replacementBannerLines,
  replacementBannerViewerKind,
  replacementChangeOthersLine,
  replacementDriverLine,
  replacementLineSummary,
  replacementRmaLinkLabel,
  replacementShortLine,
  replacementCancelledLines,
  type ReplacementBannerInput,
  slipExchangeLine,
  stillWaitingLine,
  waitingForReturnLine,
  returnCancelledReplacementLine,
  choiceNeededSentence,
  qtyRequestedLabel,
  qtyReturningLabel,
  RETURNS_COPY,
  returnedToLabel,
  returnLineLabel,
  returnToOriginalRackLabel,
  returnToOriginalRacksLabel,
  shortLabel,
  staffNewRequestBody,
  upToLabel,
  whenProcessedSentence,
} from './returns-copy';

/** Every string the returns module can print, sampled with real values. */
function allStrings(): string[] {
  const out: string[] = [];
  for (const v of Object.values(RETURNS_COPY)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push((v as (x: never) => string)(3 as never), (v as (x: never) => string)('31-C' as never));
  }
  out.push(
    qtyReturningLabel(1),
    qtyRequestedLabel(1),
    availableLabel(14),
    shortLabel(0, 1),
    returnToOriginalRackLabel('31-C'),
    returnToOriginalRacksLabel('31-C ×1 · 32-A ×2'),
    upToLabel(3),
    returnedToLabel('31-C'),
    whenProcessedSentence({ kind: 'rack', rack: '31-C' }),
    whenProcessedSentence({ kind: 'staging' }),
    whenProcessedSentence({ kind: 'scrap' }),
    whenProcessedSentence({ kind: 'rack', rack: '31-C' }, 'New Hire Shirt, M'),
    whenProcessedSentence({ kind: 'choose', reason: 'Original rack is no longer available: 31-C (archived).' }, 'Cap'),
    choiceNeededSentence(null, RETURNS_COPY.destinationsUnavailable),
    alreadyReceivedSentence('Dana', '3:04 PM'),
    alreadyClosedSentence(null, null),
    staffNewRequestBody('Pat', 'RMA-20261005-ABC123', 103),
    againstOrderLabel(103, '0000'),
    itemQuantityLabel('New Hire Shirt, L', 1),
    exchangeReplacementBanner('RMA-20261005-ABC123', 100),
    waitingForReturnLine('RMA-20261005-ABC123'),
    waitingForReturnLine('RMA-20261005-ABC123', { exchangeStatus: 'unavailable' }),
    returnCancelledReplacementLine('RMA-20261005-ABC123'),
    releasedBeforeReturnLine('Dana', 'Swap at delivery: the driver collects the returned item.'),
    changeOrCancelInRmaLabel('RMA-20261005-ABC123'),
    openRmaLabel('RMA-20261005-ABC123'),
    ...replacementBannerLines(
      {
        returnNumber: 'RMA-20261005-ABC123',
        originalOrderNumber: 103,
        live: true,
        handedOver: false,
        waitingForReturn: true,
        returnClosed: true,
        releasedEarly: true,
        release: { byName: 'Dana', reason: 'Swap at delivery: the driver collects the returned item.' },
        exchangeStatusLabel: 'Replacement reserved. Waiting for returned item',
        driverLine: 'Collect the returned item: New Hire Shirt, M ×1 (RMA-20261005-ABC123)',
      },
      'delivery',
    ).map((l) => l.text),
    originalExchangeLine('Large ×1', 103, 'Waiting for returned item'),
    collectReturnedItemLine('New Hire Shirt, M ×1', 'RMA-20261005-ABC123'),
    slipExchangeLine('RMA-20261005-ABC123', 'New Hire Shirt, M ×1', false),
    prepareTakeLine('Large', 1, '12-B', 3),
    createdAsReplacementLabel('RMA-20261005-ABC123', 2),
    approveReplacementSentence('New Hire Shirt, L', 1, 0),
    approveReplacementSentence('New Hire Shirt, L', 2, 14),
    pickingWaitsSentence('New Hire Shirt, M', false),
    pickingWaitsSentence(null, true, true),
    replacementShortLine('Large', 0, 1),
    stillWaitingLine(15),
    stillWaitingLine(15, { held: 0 }),
    replacementChangeOthersLine('RMA-20261005-ABC123'),
    replacementLineSummary({ label: 'Walk Exchange Tee - XL', requested: 2, fulfilled: 1, held: 0, status: 'backordered' }),
    replacementLineSummary({ label: 'Walk Exchange Tee - L', requested: 1, fulfilled: 0, held: 0, status: 'staged_for_pickup' }),
    earlierReplacementsLine([{ orderId: 'o1', orderNumber: 12, status: 'cancelled' }]) ?? '',
    approvalOutcomeLine({ status: 'received', replacement: { orderNumber: 17, lines: [{ held: 1 }] } }),
    approvalOutcomeLine({ replacement: { orderNumber: 16, short: true } }),
    ...Object.values(PREPARE_FORBIDDEN_WORDS),
    prepareStepRefusalWords('unknown', { code: 'forbidden' }),
    cancelReturnReplacementSentence(12),
    cancelReturnReplacementSentence(null, { held: 0 }),
    ...Object.values(EXCHANGE_STATUS_STAFF_LABELS),
    ...EXCHANGE_STATUSES.map((s) => exchangeRequesterSentence(s) ?? ''),
    ...RETURN_LIST_FILTERS.map((f) => f.label),
    ...Object.values(RETURN_ERROR_WORDS),
    ...Object.values(RESTOCK_PROBLEM_WORDS),
    ...Object.values(RETURN_ACTION_LABELS),
  );
  return out;
}

describe('returns copy', () => {
  it('never says "book" for a recorded quantity, nor claims verified, inspected, certified or guaranteed', () => {
    const banned = /\bbooks?\b|verified|inspected|certif|guarantee/i;
    const hits = allStrings().filter((s) => banned.test(s));
    expect(hits).toEqual([]);
  });

  it('uses no emojis', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    expect(allStrings().filter((s) => emoji.test(s))).toEqual([]);
  });

  it('prints the plan section 6 sentences with their values', () => {
    expect(qtyReturningLabel(1)).toBe('Qty returning: 1');
    expect(availableLabel(14)).toBe('Available: 14');
    expect(shortLabel(0, 1)).toBe('Short: 0 available, 1 needed.');
    expect(returnToOriginalRackLabel('31-C')).toBe('Return to original rack: 31-C');
    expect(whenProcessedSentence({ kind: 'rack', rack: '31-C' })).toBe('When processed, the returned item goes back to 31-C.');
    expect(RETURNS_COPY.processToRackHint('31-C')).toBe('Put it back on 31-C now. StockPilot records it there when you tap this.');
    expect(RETURNS_COPY.waitingDays(1)).toBe('waiting 1 day');
    expect(RETURNS_COPY.waitingDays(9)).toBe('waiting 9 days');
    expect(alreadyClosedSentence('Dana', '3:04 PM')).toBe('Already closed by Dana at 3:04 PM.');
    expect(alreadyReceivedSentence(null, null)).toBe('Already marked received.');
  });

  it('never says stock comes back at receipt: it moves only when the return is processed (review)', () => {
    // Receive moves nothing (approve_return / receive_return never call the
    // ledger); only Process return does. The phone and web print these.
    const atReceipt = /(until|once|when|after)\s+(it|the item|the return)\s+(is|was)\s+(approved and\s+)?received\b(?!\s+and processed)/i;
    expect(allStrings().filter((s) => atReceipt.test(s))).toEqual([]);
    expect(RETURNS_COPY.approveNothingMoves).toBe('Nothing moves now. The returned item stays out until the return is processed.');
  });

  it('names the item in "what happens", and asks for a destination when none is valid (review)', () => {
    expect(whenProcessedSentence({ kind: 'rack', rack: '31-C' }, 'New Hire Shirt, M')).toBe('When processed, New Hire Shirt, M goes back to 31-C.');
    expect(whenProcessedSentence({ kind: 'staging' })).toBe('When processed, the returned item goes into Staging.');
    expect(whenProcessedSentence({ kind: 'choose', reason: 'The original locations changed.' }, 'Cap')).toBe(
      'Cap: The original locations changed. Choose a destination.',
    );
    expect(choiceNeededSentence('Cap', RETURNS_COPY.destinationsUnavailable)).toBe("Cap: Couldn't load where the returned item goes. Reload.");
    expect(returnLineLabel('New Hire Shirt', 'Size M')).toBe('New Hire Shirt, M');
    // A name that already carries the size is not repeated (browser walk).
    expect(returnLineLabel('Walk New Hire Shirt - 2XL', 'Size 2XL')).toBe('Walk New Hire Shirt - 2XL');
    expect(returnLineLabel('Medium Tee', 'Size M')).toBe('Medium Tee, M');
    expect(returnLineLabel(null, null)).toBe('Item');
  });

  // RX-3 (found by the requester tracking, web stage): an apostrophe-s is a
  // possessive, never the size S, so "Women's Polo" in size S kept no size
  // at all ("Women's Polo ×1" beside "Women's Polo, M ×1"). L4L's own
  // exchange items are the New Hire Men's and Women's Polos (plan RX-0).
  it("never reads a possessive's s as the size S (Women's, Men's, curly or straight)", () => {
    expect(returnLineLabel("Women's Polo", 'Size S')).toBe("Women's Polo, S");
    expect(returnLineLabel("New Hire Men's Polo", 'S')).toBe("New Hire Men's Polo, S");
    expect(returnLineLabel('Women’s Polo', 'Size S')).toBe('Women’s Polo, S');
    expect(returnLineLabel("Kids' Tee", 'Size S')).toBe("Kids' Tee, S");
    // A name that does carry the size still is not repeated.
    expect(returnLineLabel("Women's Polo S", 'Size S')).toBe("Women's Polo S");
    expect(returnLineLabel("Women's Polo - S", 'Size S')).toBe("Women's Polo - S");
    expect(returnLineLabel("Women's Polo (M)", 'Size M')).toBe("Women's Polo (M)");
  });

  it('RX-2: prints the plan section 6 replacement sentences', () => {
    expect(exchangeReplacementBanner('RMA-20261005-ABC123', 100)).toBe('Exchange replacement for RMA-20261005-ABC123 · Original order SO-000100');
    expect(waitingForReturnLine('RMA-1')).toBe('Replacement reserved. Waiting for returned item (RMA-1)');
    expect(returnCancelledReplacementLine('RMA-1')).toBe("RMA-1 was cancelled. This replacement isn't picked.");
    expect(returnCancelledReplacementLine(null)).toBe("Its return was cancelled. This replacement isn't picked.");
    expect(releasedBeforeReturnLine('Dana', 'Swap at delivery.')).toBe('Released before the return by Dana: Swap at delivery.');
    expect(releasedBeforeReturnLine(null, null)).toBe('Released before the return.');
    expect(originalExchangeLine('Large ×1', 103, 'Waiting for returned item')).toBe('Exchange: Large ×1 → SO-000103 (Waiting for returned item)');
    expect(collectReturnedItemLine('New Hire Shirt, Medium ×1', 'RMA-1')).toBe(
      'On delivery, the driver collects the returned item: New Hire Shirt, Medium ×1 (RMA-1).',
    );
    expect(slipExchangeLine('RMA-1', 'New Hire Shirt, Medium ×1', true)).toBe(
      'Exchange replacement for RMA-1 (returned item: New Hire Shirt, Medium ×1, received)',
    );
    expect(prepareTakeLine('Large', 1, '12-B', 3)).toBe('Take Large ×1 from 12-B (3 on hand)');
    expect(changeOrCancelInRmaLabel('RMA-1')).toBe('Change or cancel in RMA-1');
    // Fix round 1 (verification L6): never the internal revision number.
    expect(createdAsReplacementLabel('RMA-1', 2)).toBe('Created as exchange replacement for RMA-1 (after a change)');
    expect(createdAsReplacementLabel('RMA-1', 1)).toBe('Created as exchange replacement for RMA-1');
    expect(replacementShortLine('Large', 0, 1)).toBe('Large: 0 available, 1 needed.');
  });

  // The replacement order's banner (web and phone, one rule). Desk check
  // F9 (verifier): a replacement already handed over never says it waits,
  // isn't picked, goes with the driver or can be changed or cancelled; it
  // says how the exchange ended.
  it('RX-2: the replacement banner while in flight, and once handed over', () => {
    const STAFF = { canOpenRma: true, isRequester: false };
    const base: ReplacementBannerInput = {
      returnNumber: 'RMA-1',
      originalOrderNumber: 103,
      live: true,
      handedOver: false,
      waitingForReturn: true,
      returnClosed: false,
      releasedEarly: false,
      release: null,
      exchangeStatusLabel: 'Replacement reserved. Waiting for returned item',
      driverLine: 'On delivery, the driver collects the returned item: New Hire Shirt, M ×1 (RMA-1).',
    };
    // Still waiting for the return: nothing goes out yet, so no driver line
    // (review fix P10); the RMA link alone says where it changes (P9).
    expect(replacementBannerLines(base, 'delivery', STAFF)).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'gate', text: 'Replacement reserved. Waiting for returned item (RMA-1)' },
      { key: 'rma_link', text: 'Change or cancel in RMA-1' },
    ]);
    expect(replacementBannerLines(base, 'pickup', STAFF).map((l) => l.key)).toEqual(['title', 'gate', 'rma_link']);
    // The RMA cancelled under a replacement still in flight (desk check F3).
    expect(replacementBannerLines({ ...base, waitingForReturn: false, returnClosed: true }, 'pickup', STAFF)).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'closed', text: "RMA-1 was cancelled. This replacement isn't picked." },
      { key: 'rma_link', text: 'Change or cancel in RMA-1' },
    ]);
    expect(replacementRmaLinkLabel(base)).toBe('Change or cancel in RMA-1');

    // Handed over (completed), part never sent, then the RMA cancelled: how
    // the exchange ended, the early release kept as history, nothing else.
    const handed: ReplacementBannerInput = {
      ...base,
      handedOver: true,
      waitingForReturn: false,
      returnClosed: true,
      releasedEarly: true,
      release: { byName: 'Dana', reason: 'Swap at delivery: the driver collects the returned item.' },
      exchangeStatusLabel: 'Part of the replacement handed over, the rest not sent; return cancelled',
    };
    expect(replacementBannerLines(handed, 'delivery', STAFF)).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'handed_over', text: 'Part of the replacement handed over, the rest not sent; return cancelled' },
      { key: 'released', text: 'Released before the return by Dana: Swap at delivery: the driver collects the returned item.' },
    ]);
    expect(replacementBannerLines({ ...handed, releasedEarly: false, exchangeStatusLabel: 'Exchange completed' }, 'pickup', STAFF)).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'handed_over', text: 'Exchange completed' },
    ]);
    expect(replacementRmaLinkLabel(handed)).toBe('Open RMA-1');
    expect(openRmaLabel(null)).toBe('Open its RMA');

    // An earlier replacement (cancelled, not the live one): the title and
    // its early release only; an older server without handedOver keeps the
    // in-flight lines.
    expect(replacementBannerLines({ ...handed, live: false }, 'delivery', STAFF).map((l) => l.key)).toEqual(['title', 'released']);
    expect(replacementRmaLinkLabel({ ...handed, live: false })).toBe('Change or cancel in RMA-1');
    const { handedOver: _omit, ...older } = base;
    expect(replacementBannerLines(older, 'pickup', STAFF).map((l) => l.key)).toEqual(['title', 'gate', 'rma_link']);
  });

  // RX-2 review fix P9: each viewer is told what THEY can do about changing
  // or cancelling the replacement, never a sentence with no way to act.
  it('RX-2: the change line follows who is reading (review fix P9)', () => {
    const info: ReplacementBannerInput = {
      returnNumber: 'RMA-1',
      originalOrderNumber: 103,
      live: true,
      handedOver: false,
      waitingForReturn: false,
      returnClosed: false,
      releasedEarly: false,
      release: null,
      exchangeStatusLabel: 'Ready for picking',
      driverLine: null,
    };
    const change = (viewer: { canOpenRma: boolean; isRequester: boolean }) =>
      replacementBannerLines(info, 'pickup', viewer).filter((l) => l.key === 'change' || l.key === 'rma_link');
    // Someone who can open the RMA: only the link, no separate sentence.
    expect(change({ canOpenRma: true, isRequester: false })).toEqual([{ key: 'rma_link', text: 'Change or cancel in RMA-1' }]);
    expect(change({ canOpenRma: true, isRequester: true })).toEqual([{ key: 'rma_link', text: 'Change or cancel in RMA-1' }]);
    // The order's requester: who to ask.
    expect(change({ canOpenRma: false, isRequester: true })).toEqual([
      { key: 'change', text: 'To change or cancel this replacement, contact the warehouse.' },
    ]);
    // Anyone else (order staff without returns permissions): who can.
    expect(change({ canOpenRma: false, isRequester: false })).toEqual([
      { key: 'change', text: 'Only someone who manages returns can change or cancel this replacement (RMA-1).' },
    ]);
    for (const v of [true, false])
      for (const r of [true, false]) {
        const texts = replacementBannerLines(info, 'pickup', { canOpenRma: v, isRequester: r }).map((l) => l.text);
        expect(texts).not.toContain('Change or cancel this replacement from its RMA.');
      }
    expect(replacementBannerViewerKind({ canOpenRma: true, isRequester: true })).toBe('returns');
    expect(replacementBannerViewerKind({ canOpenRma: false, isRequester: true })).toBe('requester');
    expect(replacementBannerViewerKind({ canOpenRma: false, isRequester: false })).toBe('other');
    // Without a viewer, the info's own canOpenReturn decides (both servers send it).
    expect(replacementBannerLines({ ...info, canOpenReturn: true }, 'pickup').at(-1)).toEqual({ key: 'rma_link', text: 'Change or cancel in RMA-1' });
    // The order page's refusal for the requester says the same.
    expect(RETURN_ERROR_WORDS.replacementCancelViaReturnRequester).toBe('To change or cancel this replacement, contact the warehouse.');
    expect(mapReturnError({ hint: 'replacement_cancel_via_return' }).message).toBe('Change or cancel this replacement from its RMA.');
  });

  // RX-2 review fix P10: the driver's line only for a delivery that may leave
  // before the returned item arrives (released early, the RMA not received),
  // never as an instruction to the requester, and in one place.
  it('RX-2: the driver line only for an early-released delivery, never for the requester (review fix P10)', () => {
    const released: ReplacementBannerInput = {
      returnNumber: 'RMA-1',
      originalOrderNumber: 103,
      live: true,
      handedOver: false,
      waitingForReturn: false,
      returnClosed: false,
      releasedEarly: true,
      release: { byName: 'Dana', reason: null },
      returnReceived: false,
      exchangeStatusLabel: 'Out for delivery',
      driverLine: collectReturnedItemLine('Walk Exchange Tee - M ×1', 'RMA-1'),
    };
    const staff = { canOpenRma: true, isRequester: false };
    const driverWords = 'On delivery, the driver collects the returned item: Walk Exchange Tee - M ×1 (RMA-1).';
    const driver = (info: ReplacementBannerInput, ft: 'pickup' | 'delivery' | null, viewer: { canOpenRma: boolean; isRequester: boolean }) =>
      replacementBannerLines(info, ft, viewer).filter((l) => l.key === 'driver');
    expect(driver(released, 'delivery', staff)).toEqual([{ key: 'driver', text: driverWords }]);
    expect(driver(released, 'delivery', { canOpenRma: false, isRequester: false })).toEqual([{ key: 'driver', text: driverWords }]);
    expect(replacementDriverLine(released, 'delivery', staff)).toBe(driverWords);
    // Never for the requester.
    expect(driver(released, 'delivery', { canOpenRma: false, isRequester: true })).toEqual([]);
    expect(replacementDriverLine(released, 'delivery', { canOpenRma: false, isRequester: true })).toBeNull();
    // Not a delivery, not released early (still gated), or the return received: none.
    expect(driver(released, 'pickup', staff)).toEqual([]);
    expect(driver({ ...released, releasedEarly: false, waitingForReturn: true }, 'delivery', staff)).toEqual([]);
    expect(driver({ ...released, returnReceived: true }, 'delivery', staff)).toEqual([]);
    // Handed over: nothing left to collect.
    expect(driver({ ...released, handedOver: true }, 'delivery', staff)).toEqual([]);
  });

  // RX-2 review fix P5: a replacement approved on backorder holds nothing, so
  // its order never says "Replacement reserved".
  it('RX-2: the gate line says Not in stock yet when nothing is held (review fix P5)', () => {
    const notInStock = 'Not in stock yet. Picking also waits for the returned item (RMA-1).';
    const reserved = 'Replacement reserved. Waiting for returned item (RMA-1)';
    expect(waitingForReturnLine('RMA-1', { exchangeStatus: 'unavailable' })).toBe(notInStock);
    expect(waitingForReturnLine(null, { exchangeStatus: 'unavailable' })).toBe('Not in stock yet. Picking also waits for the returned item.');
    expect(waitingForReturnLine('RMA-1', { held: 0 })).toBe(notInStock);
    // "Replacement reserved" only when everything owed is held; part of it
    // held says so (re-pinned by fix round 1, verification L9).
    expect(waitingForReturnLine('RMA-1', { held: 1, exchangeStatus: 'unavailable' })).toBe(
      'Partly reserved; the rest is not in stock yet. Picking also waits for the returned item (RMA-1).',
    );
    expect(waitingForReturnLine('RMA-1', { exchangeStatus: 'waiting_for_return' })).toBe(reserved);
    expect(waitingForReturnLine('RMA-1')).toBe(reserved);
    // The banner's gate line follows the same rule.
    const info: ReplacementBannerInput = {
      returnNumber: 'RMA-1',
      originalOrderNumber: 103,
      live: true,
      handedOver: false,
      waitingForReturn: true,
      returnClosed: false,
      releasedEarly: false,
      release: null,
      exchangeStatusLabel: 'Replacement unavailable (backordered)',
      driverLine: null,
    };
    const gate = (over: Partial<ReplacementBannerInput>) =>
      replacementBannerLines({ ...info, ...over }, 'pickup').find((l) => l.key === 'gate')?.text;
    expect(gate({ exchangeStatus: 'unavailable' })).toBe(notInStock);
    expect(gate({ exchangeStatus: 'waiting_for_return' })).toBe(reserved);
    // Re-pinned by fix round 1 (verification L9): held in part says so.
    expect(gate({ exchangeStatus: 'unavailable', held: 1 })).toBe(
      'Partly reserved; the rest is not in stock yet. Picking also waits for the returned item (RMA-1).',
    );
  });

  // RX-2 review fix P19: a replacement line never reads "reserved 0" once it
  // was picked (nothing is reserved after the pick) or part was handed over.
  it('RX-2: the replacement line says picked, handed over or reserved (review fix P19)', () => {
    const line = { label: 'Walk Exchange Tee - L', requested: 1, fulfilled: 0, held: 1 };
    expect(replacementLineSummary({ ...line, status: 'approved' })).toBe('Walk Exchange Tee - L ×1 · reserved 1');
    for (const status of ['picking_complete', 'packing_slip_generated', 'staged_for_pickup', 'staged_for_delivery', 'in_transit']) {
      expect(replacementLineSummary({ ...line, held: 0, status }), status).toBe('Walk Exchange Tee - L ×1 · picked');
    }
    expect(
      replacementLineSummary({ label: 'Walk Exchange Tee - XL', requested: 2, fulfilled: 1, held: 0, status: 'backordered' }),
    ).toBe('Walk Exchange Tee - XL ×2 · handed over 1 · reserved 0');
    // Picked again after part was handed over.
    expect(
      replacementLineSummary({ label: 'Walk Exchange Tee - XL', requested: 2, fulfilled: 1, held: 0, status: 'staged_for_pickup' }),
    ).toBe('Walk Exchange Tee - XL ×2 · handed over 1 · picked');
    // All of it handed over: nothing left to reserve or pick.
    expect(replacementLineSummary({ ...line, fulfilled: 1, held: 0, status: 'completed' })).toBe('Walk Exchange Tee - L ×1 · handed over 1');
    // Today's words otherwise.
    expect(replacementLineSummary({ ...line, held: 0, status: 'approved' })).toBe('Walk Exchange Tee - L ×1 · reserved 0');
    expect(replacementLineSummary({ ...line, status: 'pick_slip_generated' })).toBe('Walk Exchange Tee - L ×1 · reserved 1');
  });

  // RX-2 review fix P22: earlier replacements in the order status words (web
  // and phone), never a raw status code.
  it('RX-2: lists earlier replacements with their order status words (review fix P22)', () => {
    const history = [
      { orderId: 'aaaaaaaa-1111', orderNumber: 12, status: 'cancelled' },
      { orderId: 'bbbbbbbb-2222', orderNumber: 15, status: 'cancelled' },
    ];
    expect(earlierReplacementsLine(history)).toBe('Earlier replacements: SO-000012 (cancelled), SO-000015 (cancelled)');
    expect(earlierReplacementsLine([])).toBeNull();
    expect(earlierReplacementEntries([{ orderId: 'cccccccc-3333', orderNumber: null, status: 'staged_for_pickup' }])).toEqual([
      { orderId: 'cccccccc-3333', orderLabel: 'CCCCCCCC', statusWords: 'staged (pickup)', text: 'CCCCCCCC (staged (pickup))' },
    ]);
    const words = earlierReplacementEntries(
      ['pick_slip_generated', 'picking_in_progress', 'staged_for_delivery', 'in_transit', 'completed', 'denied'].map((status, i) => ({
        orderId: `o${i}`,
        orderNumber: i + 1,
        status,
      })),
    ).map((e) => e.statusWords);
    expect(words).toEqual(['pick slip', 'picking', 'ready', 'in transit', 'delivered', 'denied']);
    expect(words.join(' ')).not.toContain('_');
    // An organization's own status words, as typed.
    expect(earlierReplacementsLine(history.slice(0, 1), { statusLabels: { cancelled: 'Voided' } })).toBe('Earlier replacements: SO-000012 (Voided)');
    // An unknown status: the order alone, never the raw code.
    expect(earlierReplacementsLine([{ orderId: 'o9', orderNumber: 9, status: 'some_new_status' }])).toBe('Earlier replacements: SO-000009');
  });

  // RX-2 review fix P23: an exchange approval says what it created, never
  // only "Return approved." (web and phone, from the approval's answer).
  it('RX-2: the approval outcome names the replacement order it created (review fix P23)', () => {
    expect(approvalOutcomeLine({ status: 'approved', replacement: { orderNumber: 12, short: false, lines: [{ held: 1 }] } })).toBe(
      'Approved. Replacement order SO-000012 created and 1 reserved.',
    );
    expect(approvalOutcomeLine({ status: 'approved', replacement: { orderNumber: 16, short: true, lines: [{ held: 0 }] } })).toBe(
      'Approved. Replacement order SO-000016 is on backorder.',
    );
    expect(
      approvalOutcomeLine({ status: 'received', replacement: { orderNumber: 17, short: false, lines: [{ held: 1 }] } }, { receiveNow: true }),
    ).toBe('Approved and received. Replacement order SO-000017 created and 1 reserved.');
    expect(approvalOutcomeLine({ replacement: { orderNumber: 18, lines: [{ held: 1 }, { held: 2 }] } })).toBe(
      'Approved. Replacement order SO-000018 created and 3 reserved.',
    );
    // A return only (or every exchange declined): as before.
    expect(approvalOutcomeLine({ status: 'approved', replacement: null })).toBe('Return approved.');
    expect(approvalOutcomeLine({ status: 'received' }, { receiveNow: true })).toBe('Approved and received.');
    expect(approvalOutcomeLine({ status: 'received' })).toBe('Approved and received.');
  });

  // RX-2 review fix P24: a prepare step refused for a permission never shows
  // the permission key ("Missing permission: items:update").
  it('RX-2: a refused Get replacement ready step says which permission is missing in words (review fix P24)', () => {
    expect(PREPARE_FORBIDDEN_WORDS).toEqual({
      pick_slip: "You don't have permission to make its pick slip.",
      claim: "You don't have permission to pick this replacement.",
      pick: "You don't have permission to pick this replacement.",
      packing_slips: "You don't have permission to make its packing slips.",
      stage: "You don't have permission to stage it.",
    });
    expect(prepareStepRefusalWords('pick', { code: 'forbidden', message: 'Missing permission: items:update' })).toBe(
      "You don't have permission to pick this replacement.",
    );
    expect(prepareStepRefusalWords('pick_slip', { code: 'forbidden', message: 'Missing permission: orders:approve' })).toBe(
      "You don't have permission to make its pick slip.",
    );
    expect(prepareStepRefusalWords('stage', { code: 'forbidden', message: 'Missing permission: orders:approve' })).toBe(
      "You don't have permission to stage it.",
    );
    // Any other refusal keeps its own (already plain) words.
    expect(prepareStepRefusalWords('pick_slip', { code: 'conflict', message: 'Waiting for the returned item.' })).toBe(
      'Waiting for the returned item.',
    );
    expect(prepareStepRefusalWords('pick', { code: 'conflict', message: null })).toBe('Stopped before the next step.');
    for (const step of Object.keys(PREPARE_FORBIDDEN_WORDS)) {
      expect(prepareStepRefusalWords(step, { code: 'forbidden', message: 'Missing permission: items:update' })).not.toMatch(/:/);
    }
  });

  // RX-2 review fixes P18 and P27: the staff words under Get replacement
  // ready (nothing prints) and the Add-a-replacement card's undo.
  it('RX-2: Get replacement ready says what it does (nothing prints) and the undo reads as an action (review fixes P18, P27)', () => {
    expect(RETURNS_COPY.getReplacementReadyHelp).toBe(
      'Makes the pick slip, records the pick, makes the packing slips and stages it. Take the item from the rack shown first. Stops before the signature.',
    );
    expect(RETURNS_COPY.getReplacementReadyHelp).not.toMatch(/print/i);
    expect(RETURNS_COPY.keepAsReturnOnly).toBe('Keep as return only');
  });

  it('RX-2: words an early release the same on the web and the phone', () => {
    expect(releaseOutcomeLine({ changed: true })).toBe('Released for picking.');
    expect(releaseOutcomeLine({ changed: false, notNeeded: true })).toBe('The return was already received.');
    expect(releaseOutcomeLine({ changed: false, notNeeded: false })).toBe('Already released.');
    expect(releaseOutcomeLine({})).toBe('Already released.');
  });

  it('builds the staff push body from what exists, joined by a middle dot', () => {
    expect(staffNewRequestBody('Pat Lee', 'RMA-20261005-ABC123', 103)).toBe('Pat Lee · RMA-20261005-ABC123 · SO-000103');
    expect(staffNewRequestBody(null, 'RMA-1', null)).toBe('RMA-1');
  });

  // RX-2 review fixes P14, P15 and P28: the requester's in-app messages say
  // to bring the item back (the replacement waits for it), what Close as
  // return only means for them, and that the warehouse added the replacement.
  it('RX-2: the requester hears to bring the item back, a return-only close, and a replacement the warehouse added (review fixes P14, P15, P28)', () => {
    expect(RETURNS_COPY.requesterExchangeApprovedReserved).toBe(
      'Your replacement is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
    );
    expect(RETURNS_COPY.requesterExchangeApprovedShort).toBe(
      'Your replacement is not in stock yet. The warehouse will follow up. Bring or send the returned item back as arranged with the warehouse.',
    );
    expect(RETURNS_COPY.requesterReplacementClosedReturnOnly).toBe('No replacement will be sent. Your return goes on as a return only.');
    // Fix round 1 (verification M2): the added replacement waits for the
    // returned item too, so the requester is told to bring or send it back.
    expect(RETURNS_COPY.requesterReturnApprovedReplacementAdded).toBe(
      'Your return was approved. The warehouse added a replacement for you, and it is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
    );
    expect(RETURNS_COPY.requesterReturnApprovedReplacementAddedShort).toBe(
      'Your return was approved. The warehouse added a replacement for you; it is not in stock yet, and the warehouse will follow up. Bring or send the returned item back as arranged with the warehouse.',
    );
  });

  it('keeps the requester sentences free of racks, Staging, dispositions and staff', () => {
    const requester = [
      ...EXCHANGE_STATUSES.map((s) => exchangeRequesterSentence(s) ?? ''),
      RETURNS_COPY.requesterReceivedReturnRequest,
      RETURNS_COPY.requesterReturnApproved,
      RETURNS_COPY.requesterItemReceived,
      RETURNS_COPY.requesterReturnDeclined,
      RETURNS_COPY.requesterReturnCancelled,
      RETURNS_COPY.requesterExchangeApprovedReserved,
      RETURNS_COPY.requesterExchangeApprovedShort,
      RETURNS_COPY.requesterReplacementClosedReturnOnly,
      RETURNS_COPY.requesterReturnApprovedReplacementAdded,
      RETURNS_COPY.requesterReturnApprovedReplacementAddedShort,
      RETURNS_COPY.replacementChangeContactWarehouse,
      // RX-3: the requester's tracking and sheet words.
      RETURNS_COPY.requesterExchangeDeclined,
      RETURNS_COPY.requesterTrackRequested,
      RETURNS_COPY.requesterTrackApproved,
      RETURNS_COPY.requesterTrackReceived,
      RETURNS_COPY.requesterTrackClosed,
      RETURNS_COPY.requesterTrackDenied,
      RETURNS_COPY.requesterTrackCancelled,
      RETURNS_COPY.requesterReturnOrExchange,
      RETURNS_COPY.requesterYourRequests,
      RETURNS_COPY.requesterOptionsUnavailable,
      RETURNS_COPY.available,
      RETURNS_COPY.notInStock,
      RETURNS_COPY.warehouseReview,
      RETURNS_COPY.warehouseReviewNote,
      RETURNS_COPY.exchangeRequester,
    ];
    expect(requester.filter((s) => /rack|staging|scrap|restock|on hand|cost|supplier/i.test(s))).toEqual([]);
  });
});

// RX-2 fix round 1 (independent verification 2026-10-11).
describe('RX-2 fix round 1 words', () => {
  it('after Cancel replacement, says what to do with what was picked or sent (verification V1)', () => {
    expect(replacementCancelledLines({ changed: true, drawn: false, inTransit: false })).toEqual(['Replacement cancelled.']);
    expect(replacementCancelledLines({ changed: true, drawn: true, inTransit: false })).toEqual([
      'Replacement cancelled.',
      RETURNS_COPY.cancelDrawnReplacement,
    ]);
    expect(replacementCancelledLines({ changed: true, drawn: true, inTransit: true })).toEqual([
      'Replacement cancelled.',
      RETURNS_COPY.cancelDrawnReplacement,
      RETURNS_COPY.cancelInTransit,
    ]);
    // Nothing was live: nothing was cancelled.
    expect(replacementCancelledLines({ changed: false, drawn: false, inTransit: false })).toEqual([RETURNS_COPY.replacementNothingToCancel]);
  });

  it('the banner offers change or cancel only to a viewer who may do both (verification L5)', () => {
    const info: ReplacementBannerInput = {
      returnNumber: 'RMA-1',
      originalOrderNumber: 3,
      live: true,
      handedOver: false,
      waitingForReturn: false,
      releasedEarly: false,
      release: null,
      exchangeStatusLabel: 'Ready to pick',
      driverLine: null,
      canOpenReturn: true,
    };
    const link = (i: ReplacementBannerInput) => replacementBannerLines(i, 'pickup').find((l) => l.key === 'rma_link')?.text;
    expect(link({ ...info, canChangeReplacement: true })).toBe('Change or cancel in RMA-1');
    expect(link({ ...info, canChangeReplacement: false })).toBe('Open RMA-1');
    // An older server says nothing: the words stay as they were.
    expect(link(info)).toBe('Change or cancel in RMA-1');
    expect(replacementRmaLinkLabel({ ...info, canChangeReplacement: false })).toBe('Open RMA-1');
    expect(replacementRmaLinkLabel({ ...info, canChangeReplacement: true })).toBe('Change or cancel in RMA-1');
  });
});
