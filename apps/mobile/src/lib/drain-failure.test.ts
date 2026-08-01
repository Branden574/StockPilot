import { describe, expect, it } from 'vitest';

import { ACCOUNT_DISABLED_REJECTION, classifyDrainFailure } from './drain-failure';

/**
 * A queued offline write that fails because the account was disabled must land
 * in a TERMINAL state. Both drains re-read 'pending' and 'failed' every tick
 * forever, so leaving it 'failed' means the device hammers the API and, far
 * worse, the write lands the moment the account is re-enabled — replaying
 * exactly the activity the disable existed to stop.
 */

describe('classifyDrainFailure', () => {
  it('rejects a 401 while the account is known disabled', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: true })).toBe('rejected');
  });

  it('keeps a 401 retryable when the account is NOT disabled — that is a token blip', () => {
    expect(classifyDrainFailure({ status: 401 }, { accountDisabled: false })).toBe('failed');
  });

  it('never rejects a 5xx or a network error, even while disabled', () => {
    expect(classifyDrainFailure({ status: 500 }, { accountDisabled: true })).toBe('failed');
    expect(
      classifyDrainFailure(new Error('Network request failed'), { accountDisabled: true }),
    ).toBe('failed');
  });

  it('leaves 403 retryable — a permission change is not an identity verdict', () => {
    expect(classifyDrainFailure({ status: 403 }, { accountDisabled: true })).toBe('failed');
  });

  it('tolerates a null error', () => {
    expect(classifyDrainFailure(null, { accountDisabled: true })).toBe('failed');
  });

  it('tolerates undefined and non-object throws', () => {
    expect(classifyDrainFailure(undefined, { accountDisabled: true })).toBe('failed');
    expect(classifyDrainFailure('401', { accountDisabled: true })).toBe('failed');
  });

  it('carries a reason a person can act on, and never a reason only support could', () => {
    // Written into last_error for rows rejected in bulk at eviction, where
    // there is no per-row server error to quote.
    expect(ACCOUNT_DISABLED_REJECTION).toMatch(/not sent|never sent|was not/i);
    expect(ACCOUNT_DISABLED_REJECTION.length).toBeLessThanOrEqual(1000);
  });

  it('keys off the numeric status only — never a human sentence in the message', () => {
    // Task 9 caveat: several routes put prose in `error`, so `code` and
    // `message` are not trustworthy signals for a PERMANENT verdict.
    expect(
      classifyDrainFailure(
        { message: 'Your account has been disabled.', code: 'user_banned' },
        { accountDisabled: true },
      ),
    ).toBe('failed');
  });
});
