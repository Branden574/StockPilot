/**
 * F2-2 on the phone: the hold beside a line add or raise, and "Hold available
 * stock". What must hold:
 *   • a hold the server tried is always said, a failure most of all ("Added.
 *     Stock was not held for it; use Hold available stock."), never dropped;
 *   • no hold tried (an older server, a lowering, a non-approver) says
 *     nothing;
 *   • an answer the phone cannot read is a failure, never a guessed number;
 *   • a refused hold says the server's sentence, never raw text or a code;
 *   • the button's rule is core's (shouldOfferHoldStock, the web strip's).
 */
import {
  HOLD_FAILED_COPY,
  HOLD_MODULE_OFF_COPY,
  HOLD_NO_WAREHOUSE_ACCESS_COPY,
  HOLD_NOT_APPLICABLE_COPY,
  HOLD_NOT_APPROVER_COPY,
  HOLD_ORDER_NOT_FOUND_COPY,
  HoldResultShapeError,
  shouldOfferHoldStock,
  type OrderReadinessAssessment,
} from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';
import {
  describeHoldError,
  HOLD_REFUSED_TITLE,
  holdTopUpNotice,
  parseHoldOutcome,
  withHoldNotice,
} from './order-hold';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const ADDED_FAILED = 'Added. Stock was not held for it; use Hold available stock.';
const RAISED_FAILED = 'Changed. Stock was not held for the extra units; use Hold available stock.';

describe('parseHoldOutcome: the hold beside an add or a raise', () => {
  it('no hold tried (absent, null: an older server, a lowering, a non-approver) is null', () => {
    expect(parseHoldOutcome(undefined)).toBeNull();
    expect(parseHoldOutcome(null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a hold that answered is read with core’s parser (numeric strings too)', () => {
    expect(
      parseHoldOutcome({
        ok: true,
        held: [{ itemId: 'i1', added: '8.0000' }],
        stillShort: [{ itemId: 'i2', quantity: 6 }],
        hiddenHeldItems: 1,
        hiddenShortItems: 0,
      }),
    ).toEqual({
      ok: true,
      held: [{ itemId: 'i1', added: 8 }],
      stillShort: [{ itemId: 'i2', quantity: 6 }],
      hiddenHeldItems: 1,
      hiddenShortItems: 0,
    });
  });

  it('a failure keeps the server’s reason and sentence', () => {
    expect(
      parseHoldOutcome({ ok: false, reason: 'forbidden', message: HOLD_NO_WAREHOUSE_ACCESS_COPY }),
    ).toEqual({ ok: false, reason: 'forbidden', message: HOLD_NO_WAREHOUSE_ACCESS_COPY });
    expect(parseHoldOutcome({ ok: false, reason: 'busy', message: 'x' })).toMatchObject({
      reason: 'busy',
    });
  });

  // Mutation caught: passing an unknown reason (the MFA gate's
  // 'aal2_required') or an empty message through.
  it('an unknown reason is "failed", and a missing message is core’s', () => {
    expect(parseHoldOutcome({ ok: false, reason: 'aal2_required', message: '' })).toEqual({
      ok: false,
      reason: 'failed',
      message: HOLD_FAILED_COPY,
    });
  });

  // Mutation caught: treating an unreadable answer as "nothing to say" (the
  // line was added, and nobody would be told its stock was not held).
  it.each([
    ['a string', 'held'],
    ['a list', []],
    ['no ok flag', { held: [], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 }],
    [
      'ok with a bad number',
      { ok: true, held: [{ itemId: 'i1', added: 'lots' }], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 },
    ],
    ['ok with no lists', { ok: true }],
    // A missing count of items the editor cannot see is never read as none.
    ['ok with no hidden counts', { ok: true, held: [], stillShort: [] }],
  ])('an answer it cannot read (%s) is a failure, never a guessed number', (_label, raw) => {
    expect(parseHoldOutcome(raw)).toEqual({
      ok: false,
      reason: 'failed',
      message: HOLD_FAILED_COPY,
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe('holdTopUpNotice: the sentence the confirmation ends with', () => {
  it('a failed hold after an add says so, in core’s words, and points to the button', () => {
    expect(
      holdTopUpNotice({ ok: false, reason: 'failed', message: HOLD_FAILED_COPY }, 'added'),
    ).toBe(ADDED_FAILED);
    expect(
      holdTopUpNotice({ ok: false, reason: 'failed', message: HOLD_FAILED_COPY }, 'raised'),
    ).toBe(RAISED_FAILED);
  });

  it('a refusal adds its reason, so the person knows whether the button will help', () => {
    expect(
      holdTopUpNotice(
        { ok: false, reason: 'forbidden', message: HOLD_NO_WAREHOUSE_ACCESS_COPY },
        'added',
      ),
    ).toBe(`${ADDED_FAILED} ${HOLD_NO_WAREHOUSE_ACCESS_COPY}`);
  });

  it('a hold that answered says what it held and what it could not', () => {
    expect(
      holdTopUpNotice(
        {
          ok: true,
          held: [{ itemId: 'i1', added: 8 }],
          stillShort: [{ itemId: 'i2', quantity: 1 }],
          hiddenHeldItems: 0,
          hiddenShortItems: 0,
        },
        'added',
      ),
    ).toBe('Held 8 units for this order. 1 unit could not be held: there is no free stock for it.');
  });

  it('an item the editor cannot see is counted, never given numbers', () => {
    expect(
      holdTopUpNotice(
        { ok: true, held: [], stillShort: [], hiddenHeldItems: 1, hiddenShortItems: 1 },
        'raised',
      ),
    ).toBe(
      "Stock was held for 1 item that isn't visible to you. 1 item that isn't visible to you could not be fully held.",
    );
  });

  it('nothing tried, or nothing held and nothing short: nothing said', () => {
    expect(holdTopUpNotice(null, 'added')).toBeNull();
    expect(holdTopUpNotice(undefined, 'raised')).toBeNull();
    expect(
      holdTopUpNotice({ ok: true, held: [], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 }, 'added'),
    ).toBeNull();
  });

  it('rides as its own paragraph, and leaves the message alone when there is none', () => {
    expect(withHoldNotice('Added 1 new line.', ADDED_FAILED)).toBe(
      `Added 1 new line.\n\n${ADDED_FAILED}`,
    );
    expect(withHoldNotice('Added 1 new line.', null)).toBe('Added 1 new line.');
  });

  it('never the recorded-quantity jargon, a percentage or a promise', () => {
    const words = [
      ADDED_FAILED,
      RAISED_FAILED,
      HOLD_REFUSED_TITLE,
      holdTopUpNotice(
        { ok: true, held: [{ itemId: 'a', added: 2 }], stillShort: [], hiddenHeldItems: 0, hiddenShortItems: 0 },
        'added',
      ),
    ].join(' ');
    expect(words).not.toMatch(/\bbook\b|%|guarantee|verified/i);
  });
});

/** api()'s error, as the screen receives it (ApiError: message, status, code). */
function apiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status, code });
}

describe('describeHoldError: a refused or failed "Hold available stock"', () => {
  it('uses the server’s own sentence for every refusal', () => {
    expect(describeHoldError(apiError(403, HOLD_NOT_APPROVER_COPY, 'forbidden'))).toBe(
      HOLD_NOT_APPROVER_COPY,
    );
    expect(describeHoldError(apiError(403, HOLD_NO_WAREHOUSE_ACCESS_COPY, 'forbidden'))).toBe(
      HOLD_NO_WAREHOUSE_ACCESS_COPY,
    );
    expect(describeHoldError(apiError(409, HOLD_NOT_APPLICABLE_COPY, 'conflict'))).toBe(
      HOLD_NOT_APPLICABLE_COPY,
    );
  });

  it('words a bare code, never shows it', () => {
    expect(describeHoldError(apiError(500, 'internal_error', 'internal_error'))).toBe(
      HOLD_FAILED_COPY,
    );
    expect(describeHoldError(apiError(403, 'module_disabled', 'module_disabled'))).toBe(
      HOLD_MODULE_OFF_COPY,
    );
    expect(describeHoldError(apiError(404, 'not_found', 'not_found'))).toBe(
      HOLD_ORDER_NOT_FOUND_COPY,
    );
    expect(describeHoldError(apiError(409, 'conflict', 'conflict'))).toBe(HOLD_NOT_APPLICABLE_COPY);
    expect(describeHoldError(apiError(403, 'forbidden', 'forbidden'))).toBe(HOLD_NOT_APPROVER_COPY);
    // A server that does not know hold_stock yet refuses the body (zod text).
    expect(
      describeHoldError(
        apiError(400, "Invalid option: expected one of 'approve'|'deny'", 'validation_error'),
      ),
    ).toBe(HOLD_FAILED_COPY);
    expect(describeHoldError(apiError(429, 'rate_limited', 'rate_limited'))).toBe(
      'Too many requests. Wait a moment and try again.',
    );
    expect(describeHoldError(apiError(401, 'unauthenticated', 'unauthenticated'))).toMatch(
      /session has expired/,
    );
  });

  it('no answer at all is the phone’s connection sentence (never the network layer’s text)', () => {
    expect(
      describeHoldError(new Error('fetch failed: UnexpectedException: Could not connect')),
    ).toBe(CONNECTION_FAILURE_COPY);
    expect(describeHoldError(new Error(REQUEST_TIMED_OUT_COPY))).toBe(REQUEST_TIMED_OUT_COPY);
  });

  it('an answer it could not read: stock could not be held (pressing again is safe)', () => {
    expect(describeHoldError(new HoldResultShapeError('held is not a list'))).toBe(
      HOLD_FAILED_COPY,
    );
  });
});

describe('the button’s rule is core’s (the web strip’s own)', () => {
  const lines = (states: ('held' | 'partly_held' | 'not_held' | null)[]) =>
    states.map((state, i) => ({
      lineId: `l${i}`,
      hold: state === null ? null : { state, held: state === 'not_held' ? 0 : 5, of: 10 },
    }));
  const assessment = (status: string, holdStates: ('held' | 'partly_held' | 'not_held' | null)[]) =>
    ({
      phase: 'to_pick',
      linesCapped: false,
      holdAnnotated: true,
      order: { status },
      lines: lines(holdStates),
    }) as unknown as OrderReadinessAssessment;

  it('approvers, at a hold status, when a line is not or partly held', () => {
    expect(
      shouldOfferHoldStock({
        assessment: assessment('approved', ['held', 'not_held']),
        canApproveOrders: true,
      }),
    ).toBe(true);
    expect(
      shouldOfferHoldStock({
        assessment: assessment('picking_in_progress', ['partly_held']),
        canApproveOrders: true,
      }),
    ).toBe(true);
    expect(
      shouldOfferHoldStock({
        assessment: assessment('approved', ['held', 'held']),
        canApproveOrders: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferHoldStock({
        assessment: assessment('approved', ['not_held']),
        canApproveOrders: false,
      }),
    ).toBe(false);
    expect(shouldOfferHoldStock({ assessment: null, canApproveOrders: true })).toBe(false);
  });
});
