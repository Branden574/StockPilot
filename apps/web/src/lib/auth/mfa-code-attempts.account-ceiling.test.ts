import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The code budget has two buckets: one per account and client address
 * (10 per 15 minutes) and one per account across every address (20 per hour).
 * An attempt goes ahead only when both allow it, and either bucket failing to
 * answer refuses. The account-and-address bucket is asked first and counts
 * every attempt; the account bucket is asked only for an attempt the first one
 * allowed, so presses already refused at one address never spend the
 * account's ceiling.
 *
 * These run the real checkRateLimit (lib/rate-limit.ts) against an in-memory
 * model of the increment_rate_limit function (migration 0048): a fixed window
 * that starts at a key's first call, check-and-increment in one step, and no
 * increment once the key is at its limit.
 */

const { requestHeaders, clock, buckets, rpcCalls, failing } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  clock: { now: 0 },
  buckets: new Map<string, { count: number; startedAt: number; windowMs: number }>(),
  rpcCalls: [] as Array<{ p_key: string; p_limit: number; p_window_ms: number }>,
  failing: { prefix: null as string | null, how: 'error' as 'error' | 'throw' },
}));

function incrementRateLimit(args: { p_key: string; p_limit: number; p_window_ms: number }) {
  rpcCalls.push(args);
  if (failing.prefix && args.p_key.startsWith(failing.prefix)) {
    if (failing.how === 'throw') throw new Error('limiter unavailable');
    return { data: null, error: { message: 'limiter unavailable' } };
  }
  const answer = (allowed: boolean, count: number, endsAt: number) => ({
    data: [{ allowed, count, reset_at: new Date(endsAt).toISOString() }],
    error: null,
  });
  const bucket = buckets.get(args.p_key);
  if (!bucket || bucket.startedAt + bucket.windowMs <= clock.now) {
    buckets.set(args.p_key, { count: 1, startedAt: clock.now, windowMs: args.p_window_ms });
    return answer(true, 1, clock.now + args.p_window_ms);
  }
  const endsAt = bucket.startedAt + bucket.windowMs;
  if (bucket.count >= args.p_limit) return answer(false, bucket.count, endsAt);
  bucket.count += 1;
  return answer(true, bucket.count, endsAt);
}

vi.mock('next/headers', () => ({ headers: vi.fn(async () => requestHeaders.current) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(
      async (fn: string, args: { p_key: string; p_limit: number; p_window_ms: number }) => {
        if (fn !== 'increment_rate_limit') throw new Error(`unexpected rpc ${fn}`);
        return incrementRateLimit(args);
      },
    ),
  })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: vi.fn(async () => true) }));

import {
  MFA_CODE_ACCOUNT_LIMIT,
  MFA_CODE_ACCOUNT_WINDOW_MS,
  allowMfaCodeAttempt,
} from './mfa-code-attempts';

const MINUTE = 60_000;

function from(address: string) {
  requestHeaders.current = new Headers({ 'x-forwarded-for': address });
}

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  clock.now = Date.UTC(2026, 0, 5, 9, 0, 0);
  buckets.clear();
  rpcCalls.length = 0;
  failing.prefix = null;
  failing.how = 'error';
  // checkRateLimit warns when the limiter does not answer; keep the run quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the code budget has a ceiling per account across addresses', () => {
  it('is 20 attempts per hour, closed', () => {
    expect(MFA_CODE_ACCOUNT_LIMIT).toBe(20);
    expect(MFA_CODE_ACCOUNT_WINDOW_MS).toBe(60 * MINUTE);
  });

  it('past 20 attempts in an hour from a new address each time, the account is refused at every address until the hour is over', async () => {
    const start = clock.now;
    // One attempt every 3 minutes from a new address: no address bucket ever
    // fills, and the 20th lands at minute 57, inside the hour.
    for (let i = 1; i <= 20; i++) {
      clock.now = start + (i - 1) * 3 * MINUTE;
      from(`203.0.113.${i}`);
      expect(await allowMfaCodeAttempt('u1'), `attempt ${i}`).toBe(true);
    }

    clock.now = start + 58 * MINUTE;
    from('203.0.113.21');
    expect(await allowMfaCodeAttempt('u1')).toBe(false);
    from('198.51.100.9');
    expect(await allowMfaCodeAttempt('u1')).toBe(false);
    // The address of an earlier attempt that went ahead is refused too.
    from('203.0.113.1');
    expect(await allowMfaCodeAttempt('u1')).toBe(false);

    // Another account is not touched by this one's ceiling.
    from('203.0.113.22');
    expect(await allowMfaCodeAttempt('u2')).toBe(true);

    // The hour from the first attempt is over: the account may try again.
    clock.now = start + 60 * MINUTE;
    from('203.0.113.23');
    expect(await allowMfaCodeAttempt('u1')).toBe(true);
  });

  it('one person at one address keeps 10 attempts per 15 minutes', async () => {
    const start = clock.now;
    from('203.0.113.7');
    for (let i = 1; i <= 10; i++) {
      clock.now = start + (i - 1) * MINUTE;
      expect(await allowMfaCodeAttempt('u1'), `attempt ${i}`).toBe(true);
    }
    clock.now = start + 10 * MINUTE;
    expect(await allowMfaCodeAttempt('u1')).toBe(false);

    // 15 minutes after the first attempt the address bucket starts again, and
    // the account is still under its ceiling.
    clock.now = start + 15 * MINUTE;
    expect(await allowMfaCodeAttempt('u1')).toBe(true);
  });

  it('a few code checks at each of several sign-ins in an hour are never paused', async () => {
    const start = clock.now;
    from('203.0.113.7');
    // Six sign-ins, 10 minutes apart, three codes each: 18 in the hour.
    for (let signIn = 0; signIn < 6; signIn++) {
      for (let code = 0; code < 3; code++) {
        clock.now = start + signIn * 10 * MINUTE + code * 20_000;
        expect(await allowMfaCodeAttempt('u1'), `sign-in ${signIn + 1} code ${code + 1}`).toBe(
          true,
        );
      }
    }
  });

  it('an attempt the account-and-address bucket allows counts once in it, then once in the account bucket', async () => {
    from('203.0.113.7');

    expect(await allowMfaCodeAttempt('u1')).toBe(true);

    expect(rpcCalls).toEqual([
      { p_key: 'mfa-code:u1:203.0.113.7', p_limit: 10, p_window_ms: 15 * MINUTE },
      { p_key: 'mfa-code-account:u1', p_limit: 20, p_window_ms: 60 * MINUTE },
    ]);
    expect(buckets.get('mfa-code:u1:203.0.113.7')?.count).toBe(1);
    expect(buckets.get('mfa-code-account:u1')?.count).toBe(1);
  });

  it('30 presses from one address in 15 minutes leave the account ceiling at 10 used, so the account can still enter a code from another address', async () => {
    const start = clock.now;
    from('203.0.113.7');
    let allowed = 0;
    // One press every 25 seconds: the 30th lands at minute 12, inside the
    // address bucket's 15 minutes.
    for (let i = 0; i < 30; i++) {
      clock.now = start + i * 25_000;
      if (await allowMfaCodeAttempt('u1')) allowed += 1;
    }

    expect(allowed).toBe(10);
    expect(buckets.get('mfa-code:u1:203.0.113.7')?.count).toBe(10);
    // The 20 presses refused at that address never reached the account bucket.
    expect(buckets.get('mfa-code-account:u1')?.count).toBe(10);

    clock.now = start + 13 * MINUTE;
    from('198.51.100.9');
    expect(await allowMfaCodeAttempt('u1')).toBe(true);
    expect(buckets.get('mfa-code-account:u1')?.count).toBe(11);
  });

  it('a press the account-and-address bucket refuses never reaches the account bucket', async () => {
    from('203.0.113.7');
    for (let i = 0; i < 10; i++) await allowMfaCodeAttempt('u1');
    rpcCalls.length = 0;

    expect(await allowMfaCodeAttempt('u1')).toBe(false);

    expect(rpcCalls.map((c) => c.p_key)).toEqual(['mfa-code:u1:203.0.113.7']);
    expect(buckets.get('mfa-code:u1:203.0.113.7')?.count).toBe(10);
    expect(buckets.get('mfa-code-account:u1')?.count).toBe(10);
  });

  it('a press the account ceiling refuses is still counted at its address', async () => {
    const start = clock.now;
    for (let i = 1; i <= 20; i++) {
      clock.now = start + i * MINUTE;
      from(`203.0.113.${i}`);
      await allowMfaCodeAttempt('u1');
    }
    clock.now = start + 30 * MINUTE;
    from('198.51.100.9');
    rpcCalls.length = 0;

    expect(await allowMfaCodeAttempt('u1')).toBe(false);

    expect(rpcCalls.map((c) => c.p_key)).toEqual([
      'mfa-code:u1:198.51.100.9',
      'mfa-code-account:u1',
    ]);
    expect(buckets.get('mfa-code:u1:198.51.100.9')?.count).toBe(1);
    expect(buckets.get('mfa-code-account:u1')?.count).toBe(20);
  });

  it.each(['error', 'throw'] as const)(
    'the account bucket failing to answer (%s) refuses the attempt',
    async (how) => {
      failing.prefix = 'mfa-code-account:';
      failing.how = how;
      from('203.0.113.7');

      expect(await allowMfaCodeAttempt('u1')).toBe(false);
      // The account-and-address bucket answered and allowed it.
      expect(buckets.get('mfa-code:u1:203.0.113.7')?.count).toBe(1);
    },
  );

  it.each(['error', 'throw'] as const)(
    'the account-and-address bucket failing to answer (%s) refuses the attempt and leaves the account bucket alone',
    async (how) => {
      failing.prefix = 'mfa-code:';
      failing.how = how;
      from('203.0.113.7');

      expect(await allowMfaCodeAttempt('u1')).toBe(false);
      expect(rpcCalls.map((c) => c.p_key)).toEqual(['mfa-code:u1:203.0.113.7']);
      expect(buckets.has('mfa-code-account:u1')).toBe(false);
    },
  );
});
