import { describe, expect, it } from 'vitest';

import {
  RETURN_EXCHANGE_NOTE_MAX,
  RETURNS_COPY,
  returnSchemas,
  type RequesterExchangeOptionsAnswer,
  type RequesterReturnableLine,
} from '@stockpilot/core';

import {
  clampWhole,
  effectiveReplacementQuantity,
  initialRequesterDrafts,
  optionsForLine,
  readActionOptions,
  readActionSubmit,
  readPublicOptionsResponse,
  readPublicSubmitResponse,
  REQUESTER_REASON_OPTIONS,
  requesterLinesFromDrafts,
  type RequesterLineDraft,
  type RequesterOptionsState,
} from './requester-sheet';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const SIZE_L = '33333333-3333-4333-8333-333333333333';
const SIZE_XL = '44444444-4444-4444-8444-444444444444';

function line(id: string, name: string, over: Partial<RequesterReturnableLine> = {}): RequesterReturnableLine {
  return { orderRequestLineId: id, name, sizeLabel: 'Size M', photo: null, quantityFulfilled: 2, quantityRemaining: 2, ...over };
}

const SHIRT = line(L1, 'New Hire Shirt');
const NOTEBOOK = line(L2, 'Composition Notebook', { sizeLabel: null, quantityFulfilled: 3, quantityRemaining: 3 });

const ANSWER: RequesterExchangeOptionsAnswer = {
  exchangesEnabled: true,
  lines: [
    {
      orderRequestLineId: L1,
      options: [
        { itemId: SIZE_L, name: 'New Hire Shirt', sizeLabel: 'Size L', availability: 'available', photo: null },
        { itemId: SIZE_XL, name: 'New Hire Shirt', sizeLabel: 'Size XL', availability: 'not_in_stock', photo: null },
      ],
    },
  ],
};
const LOADED: RequesterOptionsState = { status: 'loaded', answer: ANSWER };

function draft(over: Partial<RequesterLineDraft> = {}): RequesterLineDraft {
  return { selected: true, quantity: 1, mode: 'return', itemId: null, replacementQuantity: null, note: '', ...over };
}

describe('initialRequesterDrafts', () => {
  it('starts the only returnable line ticked at what can come back, as the staff create sheet does', () => {
    const drafts = initialRequesterDrafts([SHIRT]);
    expect(drafts[L1]).toEqual(draft({ selected: true, quantity: 2 }));
  });

  it('starts nothing ticked when several lines can come back', () => {
    const drafts = initialRequesterDrafts([SHIRT, NOTEBOOK]);
    expect(drafts[L1]?.selected).toBe(false);
    expect(drafts[L2]?.selected).toBe(false);
    expect(drafts[L2]?.quantity).toBe(3);
  });

  it('never ticks a line with nothing left to return', () => {
    const drafts = initialRequesterDrafts([line(L1, 'Gone', { quantityRemaining: 0 }), NOTEBOOK]);
    expect(drafts[L1]?.selected).toBe(false);
    expect(drafts[L2]?.selected).toBe(true);
  });
});

describe('clampWhole and the replacement quantity', () => {
  it('keeps whole units inside the bounds', () => {
    expect(clampWhole('3', 1, 2)).toBe(2);
    expect(clampWhole('0', 1, 2)).toBe(1);
    expect(clampWhole('1.7', 1, 5)).toBe(1);
    expect(clampWhole('abc', 1, 5)).toBe(1);
    expect(clampWhole(4, 1, 5)).toBe(4);
  });

  it('defaults the replacement to the return quantity and never lets it pass it (brief 4)', () => {
    expect(effectiveReplacementQuantity(draft({ quantity: 2 }))).toBe(2);
    expect(effectiveReplacementQuantity(draft({ quantity: 2, replacementQuantity: 1 }))).toBe(1);
    expect(effectiveReplacementQuantity(draft({ quantity: 1, replacementQuantity: 2 }))).toBe(1);
  });
});

describe('optionsForLine', () => {
  it('knows nothing until the sizes are loaded', () => {
    expect(optionsForLine({ status: 'idle' }, L1)).toBeNull();
    expect(optionsForLine({ status: 'loading' }, L1)).toBeNull();
    expect(optionsForLine({ status: 'failed', message: 'x' }, L1)).toBeNull();
  });

  it("answers a line's sizes, or none (the warehouse reviews it) for a line the answer leaves out", () => {
    expect(optionsForLine(LOADED, L1)?.map((o) => o.itemId)).toEqual([SIZE_L, SIZE_XL]);
    expect(optionsForLine(LOADED, L2)).toEqual([]);
  });
});

describe('requesterLinesFromDrafts', () => {
  const ctx = { exchangesEnabled: true, options: LOADED };

  it('asks for at least one item', () => {
    const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ selected: false }) }, ctx);
    expect(out).toEqual({ ok: false, message: 'Pick at least one item to return.', lineId: null });
  });

  it('sends a return only as a line and a quantity, nothing else', () => {
    const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ quantity: 2 }) }, ctx);
    expect(out).toEqual({ ok: true, hasExchange: false, lines: [{ orderRequestLineId: L1, quantity: 2 }] });
  });

  it('sends a chosen size with the replacement quantity, capped by the return quantity', () => {
    const out = requesterLinesFromDrafts(
      [SHIRT],
      { [L1]: draft({ quantity: 2, mode: 'exchange', itemId: SIZE_L, replacementQuantity: 1 }) },
      ctx,
    );
    expect(out).toEqual({
      ok: true,
      hasExchange: true,
      lines: [{ orderRequestLineId: L1, quantity: 2, exchange: { itemId: SIZE_L, quantity: 1 } }],
    });
  });

  it('sends a line with no sizes as "warehouse will review" with the trimmed note', () => {
    const out = requesterLinesFromDrafts(
      [NOTEBOOK],
      { [L2]: draft({ quantity: 3, mode: 'exchange', note: '  Wide ruled please  ' }) },
      ctx,
    );
    expect(out).toEqual({
      ok: true,
      hasExchange: true,
      lines: [{ orderRequestLineId: L2, quantity: 3, exchange: { note: 'Wide ruled please', quantity: 3 } }],
    });
  });

  it('asks for a size when a line with sizes has none chosen, or one that is no longer offered', () => {
    for (const itemId of [null, '55555555-5555-4555-8555-555555555555']) {
      const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ mode: 'exchange', itemId }) }, ctx);
      expect(out).toEqual({ ok: false, message: 'Choose a size for New Hire Shirt, M.', lineId: L1 });
    }
  });

  it('asks what the warehouse should know when a line without sizes has no note', () => {
    const out = requesterLinesFromDrafts([NOTEBOOK], { [L2]: draft({ mode: 'exchange', note: '   ' }) }, ctx);
    expect(out).toEqual({ ok: false, message: 'Tell the warehouse what you need for Composition Notebook.', lineId: L2 });
  });

  it('refuses a note over 500 characters', () => {
    const out = requesterLinesFromDrafts(
      [NOTEBOOK],
      { [L2]: draft({ mode: 'exchange', note: 'x'.repeat(RETURN_EXCHANGE_NOTE_MAX + 1) }) },
      ctx,
    );
    expect(out).toEqual({ ok: false, message: `At most ${RETURN_EXCHANGE_NOTE_MAX} characters.`, lineId: L2 });
  });

  it('refuses an exchange while exchanges are switched off, in the kill switch words', () => {
    const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ mode: 'exchange', itemId: SIZE_L }) }, { ...ctx, exchangesEnabled: false });
    expect(out).toEqual({ ok: false, message: RETURNS_COPY.exchangeKillSwitch, lineId: L1 });
  });

  it('refuses an exchange when the loaded answer says exchanges are off', () => {
    const off: RequesterOptionsState = { status: 'loaded', answer: { exchangesEnabled: false, lines: [] } };
    const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ mode: 'exchange', itemId: SIZE_L }) }, { exchangesEnabled: true, options: off });
    expect(out).toEqual({ ok: false, message: RETURNS_COPY.exchangeKillSwitch, lineId: L1 });
  });

  it('refuses an exchange whose sizes could not be loaded, in the try-again words', () => {
    const failed: RequesterOptionsState = { status: 'failed', message: RETURNS_COPY.requesterOptionsUnavailable };
    const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ mode: 'exchange' }) }, { exchangesEnabled: true, options: failed });
    expect(out).toEqual({ ok: false, message: RETURNS_COPY.requesterOptionsUnavailable, lineId: L1 });
  });

  it('refuses a quantity outside what can come back (the inputs clamp, this is the backstop)', () => {
    for (const quantity of [0, 3, 1.5]) {
      const out = requesterLinesFromDrafts([SHIRT], { [L1]: draft({ quantity }) }, ctx);
      expect(out).toEqual({ ok: false, message: 'Check the items and quantities, then try again.', lineId: L1 });
    }
  });

  it("builds a body core's requester schema accepts, with nothing but what a requester may choose", () => {
    const out = requesterLinesFromDrafts(
      [SHIRT, NOTEBOOK],
      {
        [L1]: draft({ quantity: 2, mode: 'exchange', itemId: SIZE_XL }),
        [L2]: draft({ quantity: 1, mode: 'exchange', note: 'Wide ruled' }),
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const body = { reasonCode: 'damaged', lines: out.lines, idempotencyKey: '66666666-6666-4666-8666-666666666666' };
    expect(returnSchemas().requester.safeParse(body).success).toBe(true);
    // The exchange object is strict on the server: nothing else rides along.
    for (const l of out.lines) {
      expect(Object.keys(l).sort()).toEqual(l.exchange ? ['exchange', 'orderRequestLineId', 'quantity'] : ['orderRequestLineId', 'quantity']);
      for (const k of Object.keys(l.exchange ?? {})) expect(['itemId', 'note', 'quantity']).toContain(k);
    }
    // Never a disposition, a status, a warehouse, an organization, a location
    // or an order id (the server strips them; nothing here sends one).
    expect(JSON.stringify(body)).not.toMatch(/disposition|status|warehouse|organization|location|replacementOrder|approved/i);
  });
});

describe('the reason choices', () => {
  it("offer core's five reason codes, in the requester's words", () => {
    expect(REQUESTER_REASON_OPTIONS.map((r) => r.value).sort()).toEqual(['damaged', 'end_of_year', 'other', 'overage', 'wrong_item']);
    expect(REQUESTER_REASON_OPTIONS.find((r) => r.value === 'overage')?.label).toBe('Too many / overage');
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('readPublicOptionsResponse', () => {
  it('reads the answer', async () => {
    await expect(readPublicOptionsResponse(jsonResponse(200, ANSWER))).resolves.toEqual({ ok: true, answer: ANSWER });
  });

  it("passes the server's words through on a refusal", async () => {
    await expect(
      readPublicOptionsResponse(jsonResponse(404, { error: 'not_found', message: 'This return link is invalid or has expired.' })),
    ).resolves.toEqual({ ok: false, message: 'This return link is invalid or has expired.' });
  });

  it('says the sizes could not be loaded for an unreadable or malformed answer', async () => {
    await expect(readPublicOptionsResponse(new Response('<html>', { status: 502 }))).resolves.toEqual({
      ok: false,
      message: RETURNS_COPY.requesterOptionsUnavailable,
    });
    await expect(readPublicOptionsResponse(jsonResponse(200, { lines: 'nope' }))).resolves.toEqual({
      ok: false,
      message: RETURNS_COPY.requesterOptionsUnavailable,
    });
  });
});

describe('readPublicSubmitResponse', () => {
  it('reads the RMA number and whether it was a replay', async () => {
    await expect(readPublicSubmitResponse(jsonResponse(200, { id: 'r1', returnNumber: 'RMA-1', replay: true }))).resolves.toEqual({
      ok: true,
      returnNumber: 'RMA-1',
      replay: true,
    });
  });

  it("keeps the refusal's words and its reason", async () => {
    await expect(
      readPublicSubmitResponse(
        jsonResponse(400, {
          error: 'validation_error',
          message: "That item can't be used as a replacement.",
          details: { reason: 'exchange_item_not_eligible' },
        }),
      ),
    ).resolves.toEqual({ ok: false, message: "That item can't be used as a replacement.", reason: 'exchange_item_not_eligible' });
  });

  it('falls back to plain words when the answer has none', async () => {
    await expect(readPublicSubmitResponse(new Response('', { status: 500 }))).resolves.toEqual({
      ok: false,
      message: 'Could not submit your request. Try again.',
      reason: null,
    });
  });
});

describe('the portal actions as outcomes', () => {
  it('reads an options action result', () => {
    expect(readActionOptions({ ok: true, data: ANSWER })).toEqual({ ok: true, answer: ANSWER });
    expect(readActionOptions({ ok: false, error: { code: 'internal_error', message: RETURNS_COPY.requesterOptionsUnavailable } })).toEqual({
      ok: false,
      message: RETURNS_COPY.requesterOptionsUnavailable,
    });
  });

  it('reads a submit action result with its reason', () => {
    expect(readActionSubmit({ ok: true, data: { id: 'r', status: 'requested', returnNumber: 'RMA-2', replay: false } })).toEqual({
      ok: true,
      returnNumber: 'RMA-2',
      replay: false,
    });
    expect(
      readActionSubmit({
        ok: false,
        error: { code: 'validation_error', message: 'Exchanges are turned off right now. Request a return only.', details: { reason: 'exchange_not_available' } },
      }),
    ).toEqual({ ok: false, message: 'Exchanges are turned off right now. Request a return only.', reason: 'exchange_not_available' });
  });
});
