import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY } from '@stockpilot/core';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { UNEXPECTED_ERROR_MESSAGE } from '@/server/lib/api-error-response';
import { ServiceError } from '@/server/services/context';

import {
  actionErrorResult,
  EMAIL_NOT_SENT_MESSAGE,
  RowFailures,
  NOT_SET_UP_MESSAGE,
  ROW_NOT_IMPORTED_MESSAGE,
  unexpectedActionError,
} from './action-error-result';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

/**
 * Security invariant (docket S31): a Server Action answers a failure it did
 * not expect with a fixed sentence, never the error's own text.
 *
 * A Server Action's returned result reaches the browser as it is, and the
 * actions' catches used to answer `e instanceof Error ? e.message : ...`:
 * Postgres text naming tables, columns and policies, a vendor's words, a
 * setting's name. None of those errors was reported, so the answer was the
 * only copy. Now the error goes to reportError with the action's tag, and the
 * person reads one sentence. A refusal the app wrote (a ServiceError other
 * than internal_error, ForbiddenError) keeps its words and its details.
 */

const reportMock = vi.mocked(reportError);

function thrownBy(fn: () => never): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

describe('actionErrorResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers the fixed sentence for an unexpected error, never its text, and reports it with the tag', () => {
    const e = new Error('relation "public.tags" does not exist');
    const res = actionErrorResult(e, 'actions.tags', { organizationId: 'org-1' });
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: UNEXPECTED_ERROR_MESSAGE },
    });
    expect(JSON.stringify(res)).not.toContain('relation');
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock).toHaveBeenCalledWith(e, { tag: 'actions.tags', organizationId: 'org-1' });
  });

  it('answers the fixed sentence for a thrown string or plain object, reported as an Error with its text', () => {
    const fromString = actionErrorResult('column "x" does not exist', 'actions.a');
    expect(fromString).toEqual({
      ok: false,
      error: { code: 'internal_error', message: UNEXPECTED_ERROR_MESSAGE },
    });
    // A supabase-js error thrown as it is: a plain object with a message.
    const fromObject = actionErrorResult(
      { message: 'permission denied for table tags', code: '42501' },
      'actions.b',
    );
    expect(fromObject).toEqual({
      ok: false,
      error: { code: 'internal_error', message: UNEXPECTED_ERROR_MESSAGE },
    });
    const reported = reportMock.mock.calls.map(([error]) => (error as Error).message);
    // C21's rule for a value that is not an Error: its message and code.
    expect(reported).toEqual([
      'column "x" does not exist',
      'permission denied for table tags (code 42501)',
    ]);
  });

  it('uses the sentence the caller chose', () => {
    const res = actionErrorResult(new Error('boom'), 'actions.digest.prefs', {
      message: 'Could not save your digest settings. Try again.',
    });
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Could not save your digest settings. Try again.' },
    });
  });

  it('rethrows Next control flow (redirect), never answers or reports it', () => {
    const r = thrownBy(() => redirect('/signin'));
    expect(() => actionErrorResult(r, 'actions.x')).toThrow();
    expect(() => unexpectedActionError(r, 'actions.x')).toThrow();
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('keeps a refusal the app wrote: same code, same words, its details (default all)', () => {
    const e = new ServiceError('conflict', 'A tag with that name already exists.', {
      reason: 'busy',
      retryable: true,
    });
    expect(actionErrorResult(e, 'actions.tags')).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: 'A tag with that name already exists.',
        details: { reason: 'busy', retryable: true },
      },
    });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("details 'reason' keeps only details.reason; 'none' keeps none", () => {
    const e = new ServiceError('forbidden', 'Confirm with your authenticator.', {
      reason: 'aal2_required',
      factorId: 'f-1',
    });
    expect(actionErrorResult(e, 'actions.email_routing', { details: 'reason' })).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Confirm with your authenticator.',
        details: { reason: 'aal2_required' },
      },
    });
    expect(
      actionErrorResult(new ServiceError('forbidden', 'No.', { other: 1 }), 'actions.x', {
        details: 'reason',
      }),
    ).toEqual({ ok: false, error: { code: 'forbidden', message: 'No.' } });
    expect(actionErrorResult(e, 'actions.x', { details: 'none' })).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Confirm with your authenticator.' },
    });
  });

  it('an internal ServiceError answers its generic words, drops its details and reports its internal detail', () => {
    const e = new ServiceError('internal_error', 'duplicate key value violates "tags_pkey"', {
      table: 'tags',
    });
    const res = actionErrorResult(e, 'actions.tags', { organizationId: 'org-1' });
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: e.message } });
    expect(JSON.stringify(res)).not.toContain('tags_pkey');
    expect(reportMock).toHaveBeenCalledWith(e, {
      tag: 'actions.tags',
      organizationId: 'org-1',
      extra: { detail: 'duplicate key value violates "tags_pkey"' },
    });
  });

  it("answers warehouse access the caller lacks as 'forbidden' with its words, unreported", () => {
    const e = new ForbiddenError('You do not have access to this warehouse.');
    expect(actionErrorResult(e, 'actions.x')).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'You do not have access to this warehouse.' },
    });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it("answers unreadable warehouse access as the order service's retryable conflict, reported as a warning", () => {
    const e = new ForbiddenError('could not read access', { accessUnreadable: true });
    expect(actionErrorResult(e, 'actions.order_requests')).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
        details: { reason: 'failed', retryable: true },
      },
    });
    expect(reportMock).toHaveBeenCalledWith(e, { tag: 'actions.order_requests', level: 'warning' });
  });

  it('answers the permission and account-status checks with their own fixed sentences, reported as warnings', () => {
    const permissions = new PermissionsUnavailableError();
    expect(actionErrorResult(permissions, 'actions.x')).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Your permissions could not be checked. Please try again.',
      },
    });
    const status = new AccountStatusUnavailableError();
    expect(actionErrorResult(status, 'actions.y')).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Account status could not be verified. Please try again.',
      },
    });
    expect(reportMock).toHaveBeenCalledWith(permissions, { tag: 'actions.x', level: 'warning' });
    expect(reportMock).toHaveBeenCalledWith(status, { tag: 'actions.y', level: 'warning' });
  });
});

describe('unexpectedActionError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers the fixed sentence even for a ServiceError, and reports it', () => {
    const e = new ServiceError('conflict', 'words');
    expect(
      unexpectedActionError(e, 'actions.x', { level: 'warning', extra: { step: 'a' } }),
    ).toEqual({
      ok: false,
      error: { code: 'internal_error', message: UNEXPECTED_ERROR_MESSAGE },
    });
    expect(reportMock).toHaveBeenCalledWith(e, {
      tag: 'actions.x',
      level: 'warning',
      extra: { step: 'a' },
    });
  });
});

describe('RowFailures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a refusal's words per row, says the fixed sentence otherwise, and reports once per run", () => {
    const rows = new RowFailures('actions.import.rows', { organizationId: 'org-1' });
    const first = new Error('null value in column "name" of relation "inventory_items"');
    expect(
      rows.message(new ServiceError('conflict', 'An item with that SKU already exists.')),
    ).toBe('An item with that SKU already exists.');
    expect(rows.message(first)).toBe(ROW_NOT_IMPORTED_MESSAGE);
    expect(rows.message(new TypeError('x is undefined'))).toBe(ROW_NOT_IMPORTED_MESSAGE);
    expect(rows.message(new ServiceError('internal_error', 'deadlock detected'))).toBe(
      ROW_NOT_IMPORTED_MESSAGE,
    );
    expect(reportMock).not.toHaveBeenCalled();
    rows.report();
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock).toHaveBeenCalledWith(first, {
      tag: 'actions.import.rows',
      organizationId: 'org-1',
      extra: { failed: 3 },
    });
  });

  it("says the caller's sentence for an unexpected failure when it gives one", () => {
    const rows = new RowFailures('po.drafts', {
      organizationId: 'org-1',
      message: 'Could not create the draft for this supplier.',
    });
    expect(rows.message(new Error('boom'))).toBe('Could not create the draft for this supplier.');
    rows.report();
    expect(reportMock).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'po.drafts',
      organizationId: 'org-1',
      extra: { failed: 1 },
    });
  });

  it('reports nothing when every failure was a refusal, and rethrows control flow', () => {
    const rows = new RowFailures('actions.import.rows');
    rows.message(new ServiceError('validation_error', 'Quantity must be a number.'));
    rows.report();
    expect(reportMock).not.toHaveBeenCalled();
    const r = thrownBy(() => redirect('/signin'));
    expect(() => rows.message(r)).toThrow();
  });
});

describe('the fixed sentences', () => {
  it('are the words people read', () => {
    expect(NOT_SET_UP_MESSAGE).toBe('This feature is not set up yet.');
    expect(EMAIL_NOT_SENT_MESSAGE).toBe('Could not send the email. Try again.');
    expect(ROW_NOT_IMPORTED_MESSAGE).toBe('Could not import this row.');
  });
});
