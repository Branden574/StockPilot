import { describe, expect, it } from 'vitest';

import { EXCHANGE_STATUSES, EXCHANGE_STATUS_STAFF_LABELS, exchangeRequesterSentence, RETURN_LIST_FILTERS } from './exchange-status';
import { RESTOCK_PROBLEM_WORDS, RETURN_ERROR_WORDS } from './return-error-map';
import { RETURN_ACTION_LABELS } from './return-actions';
import {
  againstOrderLabel,
  alreadyClosedSentence,
  alreadyReceivedSentence,
  approveReplacementSentence,
  availableLabel,
  cancelReturnReplacementSentence,
  changeOrCancelInRmaLabel,
  collectReturnedItemLine,
  createdAsReplacementLabel,
  exchangeReplacementBanner,
  itemQuantityLabel,
  openRmaLabel,
  originalExchangeLine,
  pickingWaitsSentence,
  prepareTakeLine,
  releasedBeforeReturnLine,
  releaseOutcomeLine,
  replacementBannerLines,
  replacementRmaLinkLabel,
  replacementShortLine,
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

  it('RX-2: prints the plan section 6 replacement sentences', () => {
    expect(exchangeReplacementBanner('RMA-20261005-ABC123', 100)).toBe('Exchange replacement for RMA-20261005-ABC123 · Original order SO-000100');
    expect(waitingForReturnLine('RMA-1')).toBe('Replacement reserved. Waiting for returned item (RMA-1)');
    expect(returnCancelledReplacementLine('RMA-1')).toBe("RMA-1 was cancelled. This replacement isn't picked.");
    expect(returnCancelledReplacementLine(null)).toBe("Its return was cancelled. This replacement isn't picked.");
    expect(releasedBeforeReturnLine('Dana', 'Swap at delivery.')).toBe('Released before the return by Dana: Swap at delivery.');
    expect(releasedBeforeReturnLine(null, null)).toBe('Released before the return.');
    expect(originalExchangeLine('Large ×1', 103, 'Waiting for returned item')).toBe('Exchange: Large ×1 → SO-000103 (Waiting for returned item)');
    expect(collectReturnedItemLine('New Hire Shirt, Medium ×1', 'RMA-1')).toBe('Collect the returned item: New Hire Shirt, Medium ×1 (RMA-1)');
    expect(slipExchangeLine('RMA-1', 'New Hire Shirt, Medium ×1', true)).toBe(
      'Exchange replacement for RMA-1 (returned item: New Hire Shirt, Medium ×1, received)',
    );
    expect(prepareTakeLine('Large', 1, '12-B', 3)).toBe('Take Large ×1 from 12-B (3 on hand)');
    expect(changeOrCancelInRmaLabel('RMA-1')).toBe('Change or cancel in RMA-1');
    expect(createdAsReplacementLabel('RMA-1', 2)).toBe('Created as exchange replacement for RMA-1 (revision 2)');
    expect(createdAsReplacementLabel('RMA-1', 1)).toBe('Created as exchange replacement for RMA-1');
    expect(replacementShortLine('Large', 0, 1)).toBe('Large: 0 available, 1 needed.');
  });

  // The replacement order's banner (web and phone, one rule). Desk check
  // F9 (verifier): a replacement already handed over never says it waits,
  // isn't picked, goes with the driver or can be changed or cancelled; it
  // says how the exchange ended.
  it('RX-2: the replacement banner while in flight, and once handed over', () => {
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
      driverLine: 'Collect the returned item: New Hire Shirt, M ×1 (RMA-1)',
    };
    expect(replacementBannerLines(base, 'delivery')).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'gate', text: 'Replacement reserved. Waiting for returned item (RMA-1)' },
      { key: 'driver', text: 'Collect the returned item: New Hire Shirt, M ×1 (RMA-1)' },
      { key: 'change', text: 'Change or cancel this replacement from its RMA.' },
    ]);
    expect(replacementBannerLines(base, 'pickup').map((l) => l.key)).toEqual(['title', 'gate', 'change']);
    // The RMA cancelled under a replacement still in flight (desk check F3).
    expect(replacementBannerLines({ ...base, waitingForReturn: false, returnClosed: true }, 'pickup')).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'closed', text: "RMA-1 was cancelled. This replacement isn't picked." },
      { key: 'change', text: 'Change or cancel this replacement from its RMA.' },
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
    expect(replacementBannerLines(handed, 'delivery')).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'handed_over', text: 'Part of the replacement handed over, the rest not sent; return cancelled' },
      { key: 'released', text: 'Released before the return by Dana: Swap at delivery: the driver collects the returned item.' },
    ]);
    expect(replacementBannerLines({ ...handed, releasedEarly: false, exchangeStatusLabel: 'Exchange completed' }, 'pickup')).toEqual([
      { key: 'title', text: 'Exchange replacement for RMA-1 · Original order SO-000103' },
      { key: 'handed_over', text: 'Exchange completed' },
    ]);
    expect(replacementRmaLinkLabel(handed)).toBe('Open RMA-1');
    expect(openRmaLabel(null)).toBe('Open its RMA');

    // An earlier replacement (cancelled, not the live one): the title and
    // its early release only; an older server without handedOver keeps the
    // in-flight lines.
    expect(replacementBannerLines({ ...handed, live: false }, 'delivery').map((l) => l.key)).toEqual(['title', 'released']);
    expect(replacementRmaLinkLabel({ ...handed, live: false })).toBe('Change or cancel in RMA-1');
    const { handedOver: _omit, ...older } = base;
    expect(replacementBannerLines(older, 'pickup').map((l) => l.key)).toEqual(['title', 'gate', 'change']);
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

  it('keeps the requester sentences free of racks, Staging, dispositions and staff', () => {
    const requester = [
      ...EXCHANGE_STATUSES.map((s) => exchangeRequesterSentence(s) ?? ''),
      RETURNS_COPY.requesterReceivedReturnRequest,
      RETURNS_COPY.requesterReturnApproved,
      RETURNS_COPY.requesterItemReceived,
      RETURNS_COPY.requesterReturnDeclined,
      RETURNS_COPY.requesterReturnCancelled,
    ];
    expect(requester.filter((s) => /rack|staging|scrap|restock|on hand|cost|supplier/i.test(s))).toEqual([]);
  });
});
