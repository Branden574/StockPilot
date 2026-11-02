import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a, review round s43ar): the factor list says
 * whose list it is, and a caller takes it only as the list of the member the
 * request validated. Every read of the cookie session loads it, and a load can
 * refresh it into another account (the cookie's own refresh token and
 * `expires_at`, which nothing signs): the list of an account with no factor
 * would read as "this member has no authenticator". The end-to-end cases, with
 * the real session reads, are in
 * team.transfer-refresh-swap.test.ts, context.factor-swap.test.ts and
 * (dashboard)/layout.refresh-swap.test.tsx.
 */

import { AuthSessionMissingError } from '@supabase/supabase-js';

import { SessionEndedError } from '@/lib/auth/session-ended';

import { factorsOf, readMfaFactorList } from './mfa-factors';

const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

function clientAnswering(answer: unknown) {
  return { auth: { getUser: vi.fn(async () => answer) } } as unknown as Parameters<
    typeof readMfaFactorList
  >[0];
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('readMfaFactorList', () => {
  it("lists the factors of the account GoTrue answered for, with that account's id", async () => {
    const list = await readMfaFactorList(
      clientAnswering({
        data: {
          user: {
            id: MEMBER,
            factors: [
              { id: 'f-1', factor_type: 'totp', status: 'verified' },
              { id: 'f-2', factor_type: 'totp', status: 'unverified' },
            ],
          },
        },
        error: null,
      }),
    );
    expect(list.userId).toBe(MEMBER);
    expect(list.factors.map((f) => f.status)).toEqual(['verified', 'unverified']);
  });

  it('an account with no factor lists none', async () => {
    await expect(
      readMfaFactorList(clientAnswering({ data: { user: { id: MEMBER } }, error: null })),
    ).resolves.toEqual({ userId: MEMBER, factors: [] });
  });

  it('a session that no longer exists is a SessionEndedError', async () => {
    await expect(
      readMfaFactorList(
        clientAnswering({ data: { user: null }, error: new AuthSessionMissingError() }),
      ),
    ).rejects.toBeInstanceOf(SessionEndedError);
  });

  it('any other failure throws: an unreadable list is never "no factors"', async () => {
    const err = await readMfaFactorList(
      clientAnswering({
        data: { user: null },
        error: { name: 'AuthRetryableFetchError', message: 'x', status: 0 },
      }),
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionEndedError);
    expect((err as Error).message).toBe('getMfaFactorsForRequest: AuthRetryableFetchError');
  });

  it('no user and no error throws as unreadable', async () => {
    await expect(
      readMfaFactorList(clientAnswering({ data: { user: null }, error: null })),
    ).rejects.toThrow('getMfaFactorsForRequest: unreadable');
  });
});

describe('factorsOf', () => {
  it("answers with the factors when the list is the member's own", () => {
    const factors = [{ status: 'verified' }];
    expect(factorsOf({ userId: MEMBER, factors }, MEMBER)).toBe(factors);
    expect(factorsOf({ userId: MEMBER, factors: [] }, MEMBER)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers null for another account's list, even an empty one, with one fixed log line and no ids", () => {
    expect(factorsOf({ userId: OTHER, factors: [] }, MEMBER)).toBeNull();
    expect(factorsOf({ userId: OTHER, factors: [{ status: 'verified' }] }, MEMBER)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call).toEqual([
        '[mfa-factors] the factor list is of another account than the one this request validated',
      ]);
    }
  });
});
