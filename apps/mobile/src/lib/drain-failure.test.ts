import { describe, expect, it } from 'vitest';

import { ACCOUNT_DISABLED_REJECTION, classifyDrainFailure } from './drain-failure';

/**
 * The outbox verdict. Two classes are terminal — see drain-failure.ts:
 * a 401 on a KNOWN-disabled account, and a definitive refusal from our own
 * route (400/403/409/422, or a 404 carrying a JSON error code). Everything
 * transient stays retryable so real operator work is never discarded.
 */

describe('classifyDrainFailure — account disabled (original rule)', () => {
  it('rejects a 401 while the account is known disabled', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: true })).toBe('rejected');
  });

  it('keeps a 401 retryable when the account is NOT disabled — that is a token blip', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: false })).toBe('failed');
  });
});

describe('classifyDrainFailure — definitive refusals are terminal (SP-006 / SP-037)', () => {
  // Before this rule these rows were re-sent every 60 s forever, and one of
  // them blocked posting every count on the device ("Sync first").
  it.each([400, 403, 409, 422])('rejects a %i whether or not the account is disabled', (status) => {
    expect(classifyDrainFailure({ status }, { accountDisabled: false })).toBe('rejected');
    expect(classifyDrainFailure({ status }, { accountDisabled: true })).toBe('rejected');
  });

  it('rejects a 404 that carries a JSON error code — the route judged the resource', () => {
    expect(classifyDrainFailure({ status: 404, code: 'not_found' }, { accountDisabled: false })).toBe('rejected');
  });

  it('keeps a bare 404 retryable — a framework 404 (deploy skew, older binary) is not a verdict', () => {
    expect(classifyDrainFailure({ status: 404 }, { accountDisabled: false })).toBe('failed');
    expect(classifyDrainFailure({ status: 404, code: '' }, { accountDisabled: false })).toBe('failed');
  });
});

describe('classifyDrainFailure — transient failures stay retryable', () => {
  it.each([408, 429, 500, 502, 503])('keeps a %i retryable', (status) => {
    expect(classifyDrainFailure({ status }, { accountDisabled: true })).toBe('failed');
  });

  it('never rejects a network error or a timeout, even while disabled', () => {
    expect(classifyDrainFailure(new Error('Network request failed'), { accountDisabled: true })).toBe('failed');
    expect(
      classifyDrainFailure(new Error('Request timed out. Check your connection and try again.'), { accountDisabled: true }),
    ).toBe('failed');
  });

  it('tolerates null, undefined and non-object throws', () => {
    expect(classifyDrainFailure(null, { accountDisabled: true })).toBe('failed');
    expect(classifyDrainFailure(undefined, { accountDisabled: true })).toBe('failed');
    expect(classifyDrainFailure('401', { accountDisabled: true })).toBe('failed');
  });

  it('keys off the numeric status only — never a human sentence in the message', () => {
    // Several routes put prose in `error`, so `code` and `message` alone never
    // carry a PERMANENT verdict (the 404 rule requires a status AND a code).
    expect(
      classifyDrainFailure(
        { message: 'Your account has been disabled.', code: 'user_banned' },
        { accountDisabled: true },
      ),
    ).toBe('failed');
    expect(classifyDrainFailure({ status: '403' }, { accountDisabled: true })).toBe('failed');
  });
});

describe('the eviction reason', () => {
  it('carries a reason a person can act on, and never a reason only support could', () => {
    expect(ACCOUNT_DISABLED_REJECTION).toMatch(/not sent|never sent|was not/i);
    expect(ACCOUNT_DISABLED_REJECTION.length).toBeLessThanOrEqual(1000);
  });
});
