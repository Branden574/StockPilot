import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY } from '@stockpilot/core';

import {
  describeRequesterReturnError,
  getRequesterExchangeOptions,
  getRequesterReturnSheet,
  RequesterAnswerError,
  requesterDoorClosed,
  requesterDraftAfterRefusal,
  requesterRefusalRefreshes,
  sendRequesterReturn,
} from './requester-returns-api';
import { buildRequesterReturnBody, newRequesterDraft, reconcileRequesterDraft } from './requester-returns';

// ./api reaches for expo-constants, AsyncStorage and Supabase at import time.
const apiMock = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    code?: string;
    details?: unknown;
    constructor(message: string, status: number, code?: string, details?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }
  return { api: vi.fn(async (..._a: unknown[]) => ({}) as unknown), ApiError };
});
vi.mock('./api', () => apiMock);

const ORDER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LINE = '11111111-1111-4111-8111-111111111111';
const ITEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RET = '99999999-9999-4999-8999-999999999999';
const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const err = (status: number, message: string, code?: string, details?: unknown) =>
  new apiMock.ApiError(message, status, code, details);

beforeEach(() => apiMock.api.mockReset());

describe('the three member routes (own order, Bearer, no token anywhere)', () => {
  it('reads the sheet with a GET on the order, and parses it', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org',
      orderId: ORDER,
      orderNumber: 'SO-000103',
      requesterName: 'Pat',
      exchangesEnabled: true,
      lines: [{ orderRequestLineId: LINE, name: 'Tee', sizeLabel: 'Size M', photo: null, quantityFulfilled: 1, quantityRemaining: 1, sku: 'T-M' }],
      tracking: [],
    });
    const sheet = await getRequesterReturnSheet(ORDER);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/return-request`);
    expect(sheet).toEqual({
      orderNumber: 'SO-000103',
      requesterName: 'Pat',
      exchangesEnabled: true,
      lines: [{ orderRequestLineId: LINE, name: 'Tee', sizeLabel: 'Size M', photo: null, quantityFulfilled: 1, quantityRemaining: 1 }],
      tracking: [],
    });
  });

  it('asks for the sizes with a POST that sends NOTHING (no item, group, warehouse or quantity: no oracle)', async () => {
    apiMock.api.mockResolvedValueOnce({ organizationId: 'org', orderId: ORDER, exchangesEnabled: true, lines: [] });
    await getRequesterExchangeOptions(ORDER);
    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api.mock.calls[0]).toEqual([`/api/v1/orders/${ORDER}/return-request/options`, { method: 'POST' }]);
  });

  it('sends the request as built, and reads its answer', async () => {
    apiMock.api.mockResolvedValueOnce({ id: RET, returnNumber: 'RMA-9', replay: false });
    const body = { lines: [{ orderRequestLineId: LINE, quantity: 1, exchange: { itemId: ITEM, quantity: 1 } }], idempotencyKey: KEY };
    const answer = await sendRequesterReturn(ORDER, body);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/return-request`, { method: 'POST', body });
    expect(answer).toEqual({ id: RET, returnNumber: 'RMA-9', replay: false });
  });

  it('escapes the id into the path, and no path ever carries a token or a query', async () => {
    apiMock.api.mockResolvedValue({ lines: [], tracking: [] });
    await getRequesterReturnSheet('a/b?c');
    expect(apiMock.api).toHaveBeenLastCalledWith('/api/v1/orders/a%2Fb%3Fc/return-request');
    for (const call of apiMock.api.mock.calls) expect(String(call[0])).not.toMatch(/token|\?/i);
  });

  it('an answer that is not the route\'s shape is a failure, never an empty sheet', async () => {
    apiMock.api.mockResolvedValueOnce('<html>');
    await expect(getRequesterReturnSheet(ORDER)).rejects.toBeInstanceOf(RequesterAnswerError);
    apiMock.api.mockResolvedValueOnce({ exchangesEnabled: true });
    await expect(getRequesterExchangeOptions(ORDER)).rejects.toBeInstanceOf(RequesterAnswerError);
    apiMock.api.mockResolvedValueOnce({ returnNumber: 'RMA-9' });
    await expect(sendRequesterReturn(ORDER, { lines: [], idempotencyKey: KEY })).rejects.toBeInstanceOf(RequesterAnswerError);
  });
});

describe('the words for a refusal (by reason, never by message text)', () => {
  it("the server schema's own words for a body it refused", () => {
    const e = err(400, "A replacement can't be more than the quantity returned.", 'validation_error', { reason: 'return_invalid' });
    expect(describeRequesterReturnError(e)).toBe("A replacement can't be more than the quantity returned.");
  });

  it("core's words for the requester-tier refusals, whatever the message says", () => {
    expect(describeRequesterReturnError(err(400, 'whatever', 'validation_error', { reason: 'exchange_item_not_eligible' }))).toBe(
      "That item can't be used as a replacement.",
    );
    expect(describeRequesterReturnError(err(400, 'x', 'validation_error', { reason: 'return_exceeds_fulfilled' }))).toBe(
      'That is more than was handed over.',
    );
    expect(describeRequesterReturnError(err(400, 'x', 'validation_error', { reason: 'exchange_not_available' }))).toBe(
      'Exchanges are turned off right now. Request a return only.',
    );
    expect(
      describeRequesterReturnError(err(400, 'x', 'validation_error', { reason: 'exchange_already_sent', detail: { quantity: 2, available: 1 } })),
    ).toBe('Only 1 of these can still be exchanged; the rest already got a replacement on an earlier return.');
    expect(describeRequesterReturnError(err(409, 'x', 'conflict', { reason: 'idempotency_conflict' }))).toBe(
      'This request was already sent with different details. Reload and try again.',
    );
  });

  it("the one closed door, busy, signed out, too many, and no connection", () => {
    expect(describeRequesterReturnError(err(404, "This order isn't available.", 'not_found'))).toBe("This order isn't available.");
    expect(describeRequesterReturnError(err(409, 'Busy. Try again.', 'conflict', { reason: 'busy', retryable: true }))).toBe('Busy. Try again.');
    expect(describeRequesterReturnError(err(401, 'Sign in again.', 'unauthenticated'))).toBe('Sign in again.');
    expect(describeRequesterReturnError(err(429, 'Too many requests. Wait a while and try again.', 'rate_limited'))).toBe(
      'Too many requests. Wait a moment and try again.',
    );
    expect(describeRequesterReturnError(new TypeError('Network request failed'))).toBe(
      "Couldn't reach StockPilot. Check your connection and try again.",
    );
    expect(describeRequesterReturnError(new RequesterAnswerError())).toBe('Something went wrong. Try again.');
  });
});

describe('what a refusal means for the screen', () => {
  it('a closed door: signed out or disabled, the one 404, Returns off; never an MFA step-up or a fault', () => {
    expect(requesterDoorClosed(err(401, 'Sign in again.', 'unauthenticated'))).toBe(true);
    expect(requesterDoorClosed(err(404, "This order isn't available.", 'not_found'))).toBe(true);
    expect(requesterDoorClosed(err(403, 'Returns are turned off for this organization.', 'module_disabled'))).toBe(true);
    expect(requesterDoorClosed(err(403, 'Verify with your authenticator.', 'forbidden', { reason: 'aal2_required' }))).toBe(false);
    expect(requesterDoorClosed(err(500, 'Something went wrong. Try again.', 'internal_error'))).toBe(false);
    expect(requesterDoorClosed(err(429, 'Too many requests.', 'rate_limited'))).toBe(false);
    expect(requesterDoorClosed(new Error('offline'))).toBe(false);
  });

  it('the sheet is read again after a refusal that means it is behind (core requesterRefusalRecovery, the web form too)', () => {
    for (const reason of ['return_exceeds_fulfilled', 'exchange_already_sent', 'exchange_item_not_eligible', 'exchange_not_available', 'idempotency_conflict']) {
      expect(requesterRefusalRefreshes(err(400, 'x', 'validation_error', { reason })), reason).toBe(true);
    }
    expect(requesterRefusalRefreshes(err(404, 'x', 'not_found'))).toBe(true);
    expect(requesterRefusalRefreshes(err(409, 'Busy. Try again.', 'conflict', { reason: 'busy' }))).toBe(false);
    expect(requesterRefusalRefreshes(err(400, 'x', 'validation_error', { reason: 'return_invalid' }))).toBe(false);
    expect(requesterRefusalRefreshes(new Error('x'))).toBe(false);
  });
});

// RX-3 fix round 1 (desk check F3): the phone minted a new key on
// idempotency_conflict and kept the draft, so a lost answer could become two
// RMAs with no edit at all: fulfilled 3, draft 2, Send, the answer lost after
// RMA-A(2) committed; the re-read clamped the draft to the 1 left; Send got
// idempotency_conflict and a new key; Send again created RMA-B(1). Now the
// conflict starts the draft over with nothing chosen (core 'restart'), says
// the earlier request went through, and a press alone sends nothing.
describe('after idempotency_conflict, a press alone never sends a second request', () => {
  const sheet = (remaining: number) => ({
    exchangesEnabled: true,
    lines: [{ orderRequestLineId: LINE, name: 'Walk Cap', sizeLabel: null, photo: null, quantityFulfilled: 3, quantityRemaining: remaining }],
  });

  it('clamp, conflict, resend: the draft starts over, the words say why, and the body asks for a choice', () => {
    let draft = newRequesterDraft(sheet(3).lines, KEY);
    draft = { ...draft, lines: { [LINE]: { ...draft.lines[LINE]!, quantity: 2 } } };
    // The answer to the first send is lost; the re-read shows 1 left and clamps.
    draft = reconcileRequesterDraft(draft, sheet(1));
    expect(draft.lines[LINE]!.quantity).toBe(1);
    expect(draft.key).toBe(KEY);
    // The send with the same key and other details is refused.
    const after = requesterDraftAfterRefusal(draft, err(409, 'This request was already sent with different details. Reload and try again.', 'conflict', { reason: 'idempotency_conflict' }), () => 'new-key');
    expect(after.reload).toBe(true);
    expect(after.message).toBe(RETURNS_COPY.requesterEarlierRequestSent);
    expect(after.draft.key).toBe('new-key');
    expect(Object.values(after.draft.lines).every((l) => l.quantity === 0)).toBe(true);
    // The re-read after it keeps nothing chosen; pressing Send asks for a choice.
    const next = reconcileRequesterDraft(after.draft, sheet(1));
    const built = buildRequesterReturnBody({ sheet: sheet(1), draft: next, options: { state: 'idle' }, exchangesOn: true });
    expect(built).toMatchObject({ ok: false, error: RETURNS_COPY.requesterPickAtLeastOne });
  });

  it('a refusal that means the sheet is behind keeps the draft and the key (the refused transaction rolled its key row back)', () => {
    const draft = newRequesterDraft(sheet(3).lines, KEY);
    const refusal = err(400, 'Only 1 of "Walk Cap" can still be returned.', 'validation_error', { reason: 'return_exceeds_fulfilled' });
    const after = requesterDraftAfterRefusal(draft, refusal, () => 'new-key');
    expect(after).toMatchObject({ reload: true, message: describeRequesterReturnError(refusal) });
    expect(after.draft).toBe(draft);
  });

  it('busy keeps everything and reads nothing again: the same send under the same key is safe', () => {
    const draft = newRequesterDraft(sheet(3).lines, KEY);
    const after = requesterDraftAfterRefusal(draft, err(409, 'Busy. Try again.', 'conflict', { reason: 'busy' }), () => 'new-key');
    expect(after.reload).toBe(false);
    expect(after.draft).toBe(draft);
  });
});
