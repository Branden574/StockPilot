import { describe, expect, it } from 'vitest';

import {
  CONTEXT_UNAVAILABLE_COPY,
  CONTEXT_UNAVAILABLE_REASON,
  REFUSED_BEFORE_WRITE_REASONS,
  contextUnavailableBody,
  isRefusedBeforeAnyWrite,
} from './context-unavailable';

/**
 * The one answer the phone may read as "nothing was written" (docket S26).
 *
 * Its routes take no idempotency key, so a phone that reads some OTHER answer
 * this way sends the same stock adjustment or rental checkout twice. The
 * predicate therefore accepts only the exact answer the API context gate
 * sends (status, code, both flags and a reviewed reason) and nothing that
 * merely looks like it.
 */

/** What the phone's api() makes of an answer: an ApiError's status, code and details. */
function answered(status: number, body: { error?: unknown; message?: unknown; details?: unknown }) {
  return Object.assign(new Error(String(body.message ?? body.error ?? '')), {
    name: 'ApiError',
    status,
    code: body.error,
    details: body.details,
  });
}

const BODY = contextUnavailableBody();

describe('contextUnavailableBody', () => {
  it('is the check_failed code with the reason and both flags, and a sentence that says nothing changed', () => {
    expect(BODY).toEqual({
      error: 'check_failed',
      message: CONTEXT_UNAVAILABLE_COPY,
      details: { reason: CONTEXT_UNAVAILABLE_REASON, retryable: true, nothingWritten: true },
    });
    expect(CONTEXT_UNAVAILABLE_REASON).toBe('context_unavailable');
    expect(CONTEXT_UNAVAILABLE_COPY).toBe(
      'Your access could not be checked just now, so nothing was changed. Try again in a moment.',
    );
  });

  it('a fresh body every call, so no caller can change the next one', () => {
    expect(contextUnavailableBody()).not.toBe(contextUnavailableBody());
    expect(contextUnavailableBody()).toEqual(BODY);
  });

  it('the reviewed reasons are exactly the one the gate sends', () => {
    expect([...REFUSED_BEFORE_WRITE_REASONS]).toEqual(['context_unavailable']);
  });
});

describe('isRefusedBeforeAnyWrite', () => {
  it("accepts exactly the gate's answer: 503, its code and its details", () => {
    expect(isRefusedBeforeAnyWrite({ status: 503, code: BODY.error, details: BODY.details })).toBe(
      true,
    );
    // The same answer as the phone's api() throws it.
    expect(isRefusedBeforeAnyWrite(answered(503, BODY))).toBe(true);
  });

  it.each([500, 502, 504, 200, 400, 429])('rejects the same body with %i', (status) => {
    expect(isRefusedBeforeAnyWrite({ status, code: BODY.error, details: BODY.details })).toBe(
      false,
    );
    expect(isRefusedBeforeAnyWrite(answered(status, BODY))).toBe(false);
  });

  it('rejects a 503 with another code, or none', () => {
    for (const code of ['busy', 'internal_error', undefined, '', 'CHECK_FAILED']) {
      expect(
        isRefusedBeforeAnyWrite({ status: 503, code, details: BODY.details }),
        String(code),
      ).toBe(false);
    }
  });

  // Account delete's and the warehouse-access 503 (S16) send check_failed with
  // no details: a check could not answer, which says nothing about writes.
  it('rejects check_failed without the details (the other check_failed answers)', () => {
    expect(isRefusedBeforeAnyWrite({ status: 503, code: 'check_failed' })).toBe(false);
    expect(
      isRefusedBeforeAnyWrite(
        answered(503, {
          error: 'check_failed',
          message:
            "Your warehouse access couldn't be checked just now, so nothing was changed. Try again.",
        }),
      ),
    ).toBe(false);
    expect(isRefusedBeforeAnyWrite({ status: 503, code: 'check_failed', details: null })).toBe(
      false,
    );
    expect(
      isRefusedBeforeAnyWrite({
        status: 503,
        code: 'check_failed',
        details: 'context_unavailable',
      }),
    ).toBe(false);
  });

  it.each([
    ['missing', { reason: 'context_unavailable', retryable: true }],
    ['false', { reason: 'context_unavailable', retryable: true, nothingWritten: false }],
    [
      "the string 'true'",
      { reason: 'context_unavailable', retryable: true, nothingWritten: 'true' },
    ],
    ['1', { reason: 'context_unavailable', retryable: true, nothingWritten: 1 }],
  ])('rejects nothingWritten %s', (_label, details) => {
    expect(isRefusedBeforeAnyWrite({ status: 503, code: 'check_failed', details })).toBe(false);
  });

  it('rejects retryable false or missing', () => {
    for (const retryable of [false, undefined, 'true']) {
      expect(
        isRefusedBeforeAnyWrite({
          status: 503,
          code: 'check_failed',
          details: { reason: 'context_unavailable', retryable, nothingWritten: true },
        }),
      ).toBe(false);
    }
  });

  it('rejects any reason that is not on the reviewed list', () => {
    for (const reason of [
      'warehouse_access_unreadable',
      'busy',
      '',
      undefined,
      'CONTEXT_UNAVAILABLE',
    ]) {
      expect(
        isRefusedBeforeAnyWrite({
          status: 503,
          code: 'check_failed',
          details: { reason, retryable: true, nothingWritten: true },
        }),
      ).toBe(false);
    }
  });

  it('never reads the message: a plain Error carrying the sentence is not the marker', () => {
    expect(isRefusedBeforeAnyWrite(new Error(CONTEXT_UNAVAILABLE_COPY))).toBe(false);
    expect(
      isRefusedBeforeAnyWrite(
        Object.assign(new Error(CONTEXT_UNAVAILABLE_COPY), { status: 503, code: 'check_failed' }),
      ),
    ).toBe(false);
  });

  it('rejects null, undefined, strings and numbers', () => {
    for (const v of [null, undefined, '', 'check_failed', JSON.stringify(BODY), 503, true]) {
      expect(isRefusedBeforeAnyWrite(v)).toBe(false);
    }
  });

  it('a status that is a string is not a status', () => {
    expect(
      isRefusedBeforeAnyWrite({ status: '503', code: BODY.error, details: BODY.details }),
    ).toBe(false);
  });
});
