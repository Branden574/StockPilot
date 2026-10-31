import { describe, expect, it } from 'vitest';

import {
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_INTERNAL_COPY,
  ORDER_ITEMS_INVALID_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_MODULE_DISABLED_COPY,
  type ActionResult,
  type OrderCatalogVisibilityWriteAnswer,
} from '@stockpilot/core';

import { writeOutcome } from './outcome';

const ORG = '0a000000-0000-4000-8000-00000000000a';
const OP = '0a000000-0000-4000-8000-0000000000f1';
const A = '0a000000-0000-4000-8000-0000000000a1';
const B = '0a000000-0000-4000-8000-0000000000a2';

const refused = (
  code: string,
  details?: Record<string, unknown>,
  message = 'server words',
): ActionResult<OrderCatalogVisibilityWriteAnswer> =>
  ({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }) as ActionResult<OrderCatalogVisibilityWriteAnswer>;

describe('writeOutcome: what the page does with an answer (decided by details.reason, never by message)', () => {
  it('saved: exactly what changed, never "all updated"', () => {
    const o = writeOutcome({
      ok: true,
      data: { organizationId: ORG, operationId: OP, visible: false, changed: [A], unchanged: [B] },
    });
    expect(o).toEqual({
      kind: 'saved',
      message: 'Hidden 1 item. 1 was already hidden.',
      visible: false,
      changed: [A],
      unchanged: [B],
    });
  });

  it('aal2_required: step up, then the same operation is sent again', () => {
    expect(writeOutcome(refused('forbidden', { reason: 'aal2_required' }))).toEqual({
      kind: 'step_up',
    });
  });

  it.each([
    ['forbidden', ORDER_ITEMS_FORBIDDEN_COPY],
    ['feature_disabled', ORDER_ITEMS_FEATURE_DISABLED_COPY],
    ['module_disabled', ORDER_ITEMS_MODULE_DISABLED_COPY],
  ])('%s is final: the page locks', (reason, words) => {
    const code = reason === 'module_disabled' ? 'module_disabled' : 'forbidden';
    expect(writeOutcome(refused(code, { reason }))).toEqual({ kind: 'locked', message: words });
  });

  it('items_unavailable: nothing changed; the named ids are deselected', () => {
    expect(
      writeOutcome(refused('conflict', { reason: 'items_unavailable', itemIds: [A, 7, B] })),
    ).toEqual({
      kind: 'unavailable',
      message: ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
      itemIds: [A, B],
    });
  });

  it('busy: nothing changed; Try again resends the same operation', () => {
    expect(
      writeOutcome(refused('conflict', { reason: 'busy', retryable: true, operationId: OP })),
    ).toEqual({
      kind: 'retry',
      message: ORDER_ITEMS_BUSY_COPY,
    });
  });

  it('rate limited: the server sentence, and the same operation later', () => {
    expect(
      writeOutcome(
        refused(
          'conflict',
          { reason: 'rate_limited', retryable: true },
          'Too many changes in a minute.',
        ),
      ),
    ).toEqual({ kind: 'retry', message: 'Too many changes in a minute.' });
  });

  it('an internal error is unconfirmed: reload, and a resend of the same operation is safe', () => {
    expect(writeOutcome(refused('internal_error', undefined, 'whatever'))).toEqual({
      kind: 'unconfirmed',
      message: ORDER_ITEMS_INTERNAL_COPY,
    });
  });

  it('mfa_required and invalid are said in core words and end the operation', () => {
    expect(writeOutcome(refused('forbidden', { reason: 'mfa_required' }))).toEqual({
      kind: 'failed',
      message: ORDER_ITEMS_MFA_REQUIRED_COPY,
    });
    expect(
      writeOutcome(refused('validation_error', { reason: 'invalid', field: 'itemIds' })),
    ).toEqual({
      kind: 'failed',
      message: ORDER_ITEMS_INVALID_COPY,
    });
  });

  it('never shows a refusal it does not know as success; database text is never passed through', () => {
    const o = writeOutcome(
      refused('conflict', { reason: 'something_new' }, 'relation "x" does not exist'),
    );
    expect(o).toEqual({ kind: 'unconfirmed', message: ORDER_ITEMS_INTERNAL_COPY });
  });

  it('a thrown call (no answer) is unconfirmed', () => {
    expect(writeOutcome(null)).toEqual({ kind: 'unconfirmed', message: ORDER_ITEMS_INTERNAL_COPY });
  });
});
