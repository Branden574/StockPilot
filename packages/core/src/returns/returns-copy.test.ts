import { describe, expect, it } from 'vitest';

import { EXCHANGE_STATUSES, EXCHANGE_STATUS_STAFF_LABELS, exchangeRequesterSentence, RETURN_LIST_FILTERS } from './exchange-status';
import { RESTOCK_PROBLEM_WORDS, RETURN_ERROR_WORDS } from './return-error-map';
import { RETURN_ACTION_LABELS } from './return-actions';
import {
  againstOrderLabel,
  alreadyClosedSentence,
  alreadyReceivedSentence,
  availableLabel,
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
