import { describe, expect, it } from 'vitest';

import { contextUnavailableBody } from '@stockpilot/core';

import {
  ACCOUNT_DISABLED_REJECTION,
  classifyDrainFailure,
  KEPT_ROW_MAX_BACKOFF_MS,
  keptForSetUpCheck,
  keptRowDue,
} from './drain-failure';

/**
 * The outbox verdict. Two classes are terminal — see drain-failure.ts:
 * a 401 on a KNOWN-disabled account, and a definitive refusal from our own
 * route (400/409/422, a 403 judged not about the authenticator, or a 404
 * carrying a JSON error code). Everything
 * transient stays retryable so real operator work is never discarded.
 */

describe('classifyDrainFailure — account disabled (original rule)', () => {
  it('rejects a 401 while the account is known disabled', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: true, setUp: 'clear' })).toBe('rejected');
  });

  it('keeps a 401 retryable when the account is NOT disabled — that is a token blip', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: false, setUp: 'clear' })).toBe('failed');
  });
});

describe('classifyDrainFailure — definitive refusals are terminal (SP-006 / SP-037)', () => {
  // Before this rule these rows were re-sent every 60 s forever, and one of
  // them blocked posting every count on the device ("Sync first").
  it.each([400, 403, 409, 422])('rejects a %i whether or not the account is disabled', (status) => {
    // A 403 here is one a check made after the refusal found no authenticator
    // set-up owed in the row's workspace (setUp 'clear'); see the next block.
    expect(classifyDrainFailure({ status }, { accountDisabled: false, setUp: 'clear' })).toBe('rejected');
    expect(classifyDrainFailure({ status }, { accountDisabled: true, setUp: 'clear' })).toBe('rejected');
  });

  it('rejects a 404 that carries a JSON error code — the route judged the resource', () => {
    expect(classifyDrainFailure({ status: 404, code: 'not_found' }, { accountDisabled: false, setUp: 'clear' })).toBe('rejected');
  });

  it('keeps a bare 404 retryable — a framework 404 (deploy skew, older binary) is not a verdict', () => {
    expect(classifyDrainFailure({ status: 404 }, { accountDisabled: false, setUp: 'clear' })).toBe('failed');
    expect(classifyDrainFailure({ status: 404, code: '' }, { accountDisabled: false, setUp: 'clear' })).toBe('failed');
  });
});

describe('classifyDrainFailure — transient failures stay retryable', () => {
  it.each([408, 429, 500, 502, 503])('keeps a %i retryable', (status) => {
    expect(classifyDrainFailure({ status }, { accountDisabled: true, setUp: 'clear' })).toBe('failed');
  });

  it('never rejects a network error or a timeout, even while disabled', () => {
    expect(classifyDrainFailure(new Error('Network request failed'), { accountDisabled: true, setUp: 'clear' })).toBe('failed');
    expect(
      classifyDrainFailure(new Error('Request timed out. Check your connection and try again.'), { accountDisabled: true, setUp: 'clear' }),
    ).toBe('failed');
  });

  it('tolerates null, undefined and non-object throws', () => {
    expect(classifyDrainFailure(null, { accountDisabled: true, setUp: 'clear' })).toBe('failed');
    expect(classifyDrainFailure(undefined, { accountDisabled: true, setUp: 'clear' })).toBe('failed');
    expect(classifyDrainFailure('401', { accountDisabled: true, setUp: 'clear' })).toBe('failed');
  });

  it('keys off the numeric status only — never a human sentence in the message', () => {
    // Several routes put prose in `error`, so `code` and `message` alone never
    // carry a PERMANENT verdict (the 404 rule requires a status AND a code).
    expect(
      classifyDrainFailure(
        { message: 'Your account has been disabled.', code: 'user_banned' },
        { accountDisabled: true, setUp: 'clear' },
      ),
    ).toBe('failed');
    expect(classifyDrainFailure({ status: '403' }, { accountDisabled: true, setUp: 'clear' })).toBe('failed');
  });
});

// Docket S26: the 503 the server marks as refused before any write is
// retryable here like every 5xx, on a live account and on a disabled one. The
// adjust_stock kind reads the mark itself (adjust-outbox.ts adjustDrainVerdict).
describe('classifyDrainFailure — the refusal marked as before any write', () => {
  it('is retryable, like every 5xx', () => {
    const body = contextUnavailableBody();
    const marker = { status: 503, code: body.error, details: body.details };
    expect(classifyDrainFailure(marker, { accountDisabled: false, setUp: 'clear' })).toBe('failed');
    expect(classifyDrainFailure(marker, { accountDisabled: true, setUp: 'clear' })).toBe('failed');
  });
});

/**
 * A 403 on a queued send is final only on positive evidence that it is not
 * about the authenticator: the refusal names another reason, or a check made
 * after the refusal read the row's workspace and found that this account owes
 * no authenticator set-up there (set-up-inputs.ts setUpAnswerAfterRefusal).
 * Every other 403 keeps the row: it is sent again once the account has an
 * authenticator, or judged again after the next check.
 */
describe('classifyDrainFailure: a 403 and the authenticator policy', () => {
  const SET_UP_SENTENCE =
    'Multi-factor authentication required. Enroll in MFA before performing this action.';
  /** Each 403 a queued send can meet, as api() throws it. */
  const shapes = {
    'set-up answer with details': {
      status: 403,
      code: 'forbidden',
      message: SET_UP_SENTENCE,
      details: { reason: 'mfa_required' },
    },
    'code answer with details': {
      status: 403,
      code: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      details: { reason: 'aal2_required' },
    },
    'set-up answer from a route that sends no details': {
      status: 403,
      code: 'forbidden',
      message: SET_UP_SENTENCE,
    },
    'set-up answer with the reason as the code': {
      status: 403,
      code: 'mfa_required',
      message: SET_UP_SENTENCE,
    },
    'code answer with the reason as the code': {
      status: 403,
      code: 'aal2_required',
      message: 'Re-authenticate with MFA before performing this action.',
    },
    'missing permission': { status: 403, code: 'forbidden', message: 'Missing permission: stock:adjust' },
    'another reason in details': {
      status: 403,
      code: 'forbidden',
      message: 'This count is assigned to someone else.',
      details: { reason: 'assigned_elsewhere' },
    },
    'a 403 with no JSON body': { status: 403, message: 'You do not have access to this.' },
    'module off, as the code, no details': {
      status: 403,
      code: 'module_disabled',
      message: 'Module not enabled for this organization: bundles',
    },
  } as const;

  const FINAL_AT_ONCE: readonly string[] = ['another reason in details', 'module off, as the code, no details'];

  it.each(
    Object.entries(shapes).filter(([name]) => !FINAL_AT_ONCE.includes(name)),
  )('%s: kept while the check is owed or unknown', (_name, err) => {
    for (const setUp of ['owed', 'unknown'] as const) {
      expect(classifyDrainFailure(err, { accountDisabled: false, setUp })).toBe('failed');
    }
  });

  it.each([
    'another reason in details',
    'module off, as the code, no details',
  ] as const)('%s: final whatever the check says', (name) => {
    for (const setUp of ['owed', 'unknown', 'clear'] as const) {
      expect(classifyDrainFailure(shapes[name], { accountDisabled: false, setUp })).toBe('rejected');
    }
  });

  it.each([
    'set-up answer with details',
    'code answer with details',
    'set-up answer with the reason as the code',
    'code answer with the reason as the code',
  ] as const)('%s: kept even when the check says clear', (name) => {
    // The server's own policy read can fail and hold the member to the
    // strictest policy, so its authenticator answer is never final here.
    expect(classifyDrainFailure(shapes[name], { accountDisabled: false, setUp: 'clear' })).toBe('failed');
    expect(classifyDrainFailure(shapes[name], { accountDisabled: true, setUp: 'clear' })).toBe('failed');
  });

  it.each([
    'set-up answer from a route that sends no details',
    'missing permission',
    'a 403 with no JSON body',
  ] as const)('%s: final once the check says clear', (name) => {
    expect(classifyDrainFailure(shapes[name], { accountDisabled: false, setUp: 'clear' })).toBe('rejected');
  });

  it('the other refusals are final whatever the check says', () => {
    for (const status of [400, 409, 422]) {
      for (const setUp of ['owed', 'unknown', 'clear'] as const) {
        expect(classifyDrainFailure({ status }, { accountDisabled: false, setUp })).toBe('rejected');
      }
    }
    for (const setUp of ['owed', 'unknown', 'clear'] as const) {
      expect(classifyDrainFailure({ status: 404, code: 'not_found' }, { accountDisabled: false, setUp })).toBe(
        'rejected',
      );
    }
  });

  it('a 401 is decided by the account rule, whatever the check says', () => {
    for (const setUp of ['owed', 'unknown', 'clear'] as const) {
      expect(classifyDrainFailure({ status: 401 }, { accountDisabled: false, setUp })).toBe('failed');
      expect(classifyDrainFailure({ status: 401 }, { accountDisabled: true, setUp })).toBe('rejected');
    }
  });

  it('keptForSetUpCheck names exactly the 403s that were kept', () => {
    expect(keptForSetUpCheck(shapes['missing permission'])).toBe(true);
    expect(keptForSetUpCheck(shapes['set-up answer with details'])).toBe(true);
    for (const other of [{ status: 401 }, { status: 400 }, { status: 500 }, { status: '403' }, null, new Error('x')]) {
      expect(keptForSetUpCheck(other)).toBe(false);
    }
  });
});

describe('keptRowDue: the backoff of a row kept for the authenticator check', () => {
  it('2^attempts seconds after the last attempt, at most 5 minutes', () => {
    expect(KEPT_ROW_MAX_BACKOFF_MS).toBe(5 * 60 * 1000);
    expect(keptRowDue(1, 10_000, 11_999)).toBe(false);
    expect(keptRowDue(1, 10_000, 12_000)).toBe(true);
    expect(keptRowDue(4, 10_000, 25_999)).toBe(false);
    expect(keptRowDue(4, 10_000, 26_000)).toBe(true);
    expect(keptRowDue(30, 10_000, 10_000 + KEPT_ROW_MAX_BACKOFF_MS - 1)).toBe(false);
    expect(keptRowDue(30, 10_000, 10_000 + KEPT_ROW_MAX_BACKOFF_MS)).toBe(true);
  });

  it('a row never attempted is due', () => {
    expect(keptRowDue(0, null, 0)).toBe(true);
    expect(keptRowDue(undefined, undefined, 0)).toBe(true);
  });
});

describe('the eviction reason', () => {
  it('carries a reason a person can act on, and never a reason only support could', () => {
    expect(ACCOUNT_DISABLED_REJECTION).toMatch(/not sent|never sent|was not/i);
    expect(ACCOUNT_DISABLED_REJECTION.length).toBeLessThanOrEqual(1000);
  });
});
