import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S25, INV-E5): every emailed confirmation link
 * carries `r`, the signed reference to the account it is for, and
 * /auth/confirm can check it and look that account up.
 *
 * confirmLinkUrl is the only code that writes an /auth/confirm link
 * (confirm-landing.test.ts holds every builder to it). Pinned here:
 *   - it writes the token hash, the type, the kept landing and `r`, and the
 *     email change gets no `next` (the route fixes that destination);
 *   - with no signing value, or a user id that is not a UUID, it writes no
 *     link at all, so a builder sends nothing rather than a link the page
 *     cannot name;
 *   - verifyConfirmRecipient checks `r` with the deployment's own key;
 *   - the account lookup never throws and gives up after five seconds:
 *     found (with any pending new address), gone (no account, no email, or
 *     disabled), or failed.
 * The signing value is a dull one under a neutral name, restored from a copy
 * (src/test/secret-shaped-fixtures.guard.test.ts); every id is synthetic.
 */

const envState = vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  return {
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT,
  };
});
vi.mock('@/lib/env', () => ({ env: envState }));
const INITIAL_ENV = { ...envState };

const getUserById = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById } } }),
}));

import { checkConfirmRecipient } from './confirm-recipient';
import {
  CONFIRM_RECIPIENT_LOOKUP_TIMEOUT_MS,
  confirmLinkUrl,
  EMAIL_CHANGE_REQUEST_SKEW_S,
  emailChangeRequestTimeMissing,
  lookUpConfirmRecipient,
  pendingEmailChangeFor,
  verifyConfirmRecipient,
} from './confirm-link';

/** Another deployment's service key, or this one's after a rotation. */
const ROTATED_INPUT = 'test-only-rotated-input';
const USER_A = '11111111-1111-4111-8111-111111111111';
const LINK_HASH = 'ab'.repeat(28);
const NOW = new Date('2026-10-31T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(envState, INITIAL_ENV);
});

afterEach(() => {
  vi.useRealTimers();
});

function parts(url: string) {
  const u = new URL(url);
  return {
    origin: u.origin,
    path: u.pathname,
    keys: [...u.searchParams.keys()],
    tokenHash: u.searchParams.get('token_hash'),
    type: u.searchParams.get('type'),
    next: u.searchParams.get('next'),
    r: u.searchParams.get('r'),
  };
}

describe('confirmLinkUrl', () => {
  it('writes the token hash, the type, the kept landing and r, for the account GoTrue named', () => {
    const url = confirmLinkUrl({
      type: 'recovery',
      tokenHash: LINK_HASH,
      userId: USER_A,
      next: '/reset/complete',
      now: NOW,
    });
    expect(url).not.toBeNull();
    const p = parts(url!);
    expect(p).toMatchObject({
      origin: 'https://app.example.com',
      path: '/auth/confirm',
      keys: ['token_hash', 'type', 'next', 'r'],
      tokenHash: LINK_HASH,
      type: 'recovery',
      next: '/reset/complete',
    });
    expect(url).toContain(
      `/auth/confirm?token_hash=${LINK_HASH}&type=recovery&next=%2Freset%2Fcomplete&r=v1.`,
    );
    expect(
      checkConfirmRecipient(envState.SUPABASE_SERVICE_ROLE_KEY, {
        type: 'recovery',
        tokenHash: LINK_HASH,
        r: p.r!,
        now: NOW,
      }),
    ).toEqual({ status: 'valid', userId: USER_A, issued: NOW.getTime() / 1000 });
  });

  it('signs each type with its own type', () => {
    for (const [type, next] of [
      ['invite', '/reset/complete'],
      ['invite', '/portal'],
      ['magiclink', '/portal'],
    ] as const) {
      const p = parts(
        confirmLinkUrl({ type, tokenHash: LINK_HASH, userId: USER_A, next, now: NOW })!,
      );
      expect(p.type).toBe(type);
      expect(p.next).toBe(next);
      expect(verifyConfirmRecipient({ type, tokenHash: LINK_HASH, r: p.r!, now: NOW }).status).toBe(
        'valid',
      );
      // Never valid for another type: a link cannot be relabelled.
      expect(
        verifyConfirmRecipient({ type: 'recovery', tokenHash: LINK_HASH, r: p.r!, now: NOW })
          .status,
      ).toBe('invalid');
    }
  });

  it('gives the email change no next: the route fixes where it lands', () => {
    const url = confirmLinkUrl({
      type: 'email_change',
      tokenHash: LINK_HASH,
      userId: USER_A,
      now: NOW,
    })!;
    const p = parts(url);
    expect(p.keys).toEqual(['token_hash', 'type', 'r']);
    expect(url).not.toContain('next=');
    expect(
      verifyConfirmRecipient({ type: 'email_change', tokenHash: LINK_HASH, r: p.r!, now: NOW }),
    ).toEqual({
      status: 'valid',
      userId: USER_A,
      issued: NOW.getTime() / 1000,
    });
  });

  it('dates r with the time it is built', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const p = parts(
      confirmLinkUrl({
        type: 'recovery',
        tokenHash: LINK_HASH,
        userId: USER_A,
        next: '/reset/complete',
      })!,
    );
    expect(p.r!.split('.')[2]).toBe(String(NOW.getTime() / 1000));
  });

  it('writes no link with no signing value, or for a user id that is not a UUID', () => {
    for (const userId of ['user-1', '', null, undefined]) {
      expect(
        confirmLinkUrl({
          type: 'recovery',
          tokenHash: LINK_HASH,
          userId,
          next: '/reset/complete',
          now: NOW,
        }),
        String(userId),
      ).toBeNull();
    }
    envState.SUPABASE_SERVICE_ROLE_KEY = '';
    expect(
      confirmLinkUrl({
        type: 'recovery',
        tokenHash: LINK_HASH,
        userId: USER_A,
        next: '/reset/complete',
        now: NOW,
      }),
    ).toBeNull();
    expect(
      confirmLinkUrl({ type: 'email_change', tokenHash: LINK_HASH, userId: USER_A, now: NOW }),
    ).toBeNull();
  });

  it('writes no link for a token hash outside the shape GoTrue gives', () => {
    const SHORT = 'short';
    expect(
      confirmLinkUrl({
        type: 'recovery',
        tokenHash: SHORT,
        userId: USER_A,
        next: '/reset/complete',
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe('verifyConfirmRecipient', () => {
  it("checks r with the deployment's key: none configured verifies nothing", () => {
    const p = parts(
      confirmLinkUrl({
        type: 'magiclink',
        tokenHash: LINK_HASH,
        userId: USER_A,
        next: '/portal',
        now: NOW,
      })!,
    );
    expect(
      verifyConfirmRecipient({ type: 'magiclink', tokenHash: LINK_HASH, r: p.r!, now: NOW }).status,
    ).toBe('valid');
    envState.SUPABASE_SERVICE_ROLE_KEY = ROTATED_INPUT;
    expect(
      verifyConfirmRecipient({ type: 'magiclink', tokenHash: LINK_HASH, r: p.r!, now: NOW }).status,
    ).toBe('invalid');
    envState.SUPABASE_SERVICE_ROLE_KEY = '';
    expect(
      verifyConfirmRecipient({ type: 'magiclink', tokenHash: LINK_HASH, r: p.r!, now: NOW }).status,
    ).toBe('invalid');
  });

  it('reads the clock when no time is given', () => {
    const p = parts(
      confirmLinkUrl({
        type: 'magiclink',
        tokenHash: LINK_HASH,
        userId: USER_A,
        next: '/portal',
        now: new Date(Date.now() - 2 * 60 * 60 * 1000),
      })!,
    );
    expect(verifyConfirmRecipient({ type: 'magiclink', tokenHash: LINK_HASH, r: p.r! })).toEqual({
      status: 'stale',
    });
  });
});

describe('lookUpConfirmRecipient', () => {
  const user = (fields: Record<string, unknown>) => ({
    data: { user: { id: USER_A, email: 'person@example.com', ...fields } },
    error: null,
  });

  it('found: the address, the new one an email change is waiting on, and when GoTrue recorded that request', async () => {
    getUserById.mockResolvedValueOnce(user({}));
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toEqual({
      kind: 'found',
      email: 'person@example.com',
      newEmail: null,
      emailChangeSentAt: null,
    });
    expect(getUserById).toHaveBeenCalledWith(USER_A);

    getUserById.mockResolvedValueOnce(
      user({ new_email: 'new@example.com', email_change_sent_at: '2026-10-31T11:58:30.25Z' }),
    );
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toEqual({
      kind: 'found',
      email: 'person@example.com',
      newEmail: 'new@example.com',
      emailChangeSentAt: Date.parse('2026-10-31T11:58:30.25Z'),
    });

    getUserById.mockResolvedValueOnce(
      user({
        new_email: '  ',
        banned_until: '2026-01-01T00:00:00Z',
        email_change_sent_at: 'not a time',
      }),
    );
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toEqual({
      kind: 'found',
      email: 'person@example.com',
      newEmail: null,
      emailChangeSentAt: null,
    });
  });

  it('found: a request time that is missing or cannot be read as a date is none', async () => {
    const unreadable: Array<[string, Record<string, unknown>]> = [
      ['absent', {}],
      ['null', { email_change_sent_at: null }],
      ['empty', { email_change_sent_at: '' }],
      ['blank', { email_change_sent_at: '   ' }],
      ['not a time', { email_change_sent_at: 'not a time' }],
      ['a bare number in a string', { email_change_sent_at: '0' }],
      ['a number', { email_change_sent_at: 0 }],
      ['milliseconds as a number', { email_change_sent_at: NOW.getTime() }],
      ['an object', { email_change_sent_at: {} }],
    ];
    for (const [label, fields] of unreadable) {
      getUserById.mockResolvedValueOnce(user({ new_email: 'new@example.com', ...fields }));
      await expect(lookUpConfirmRecipient(USER_A, NOW), label).resolves.toEqual({
        kind: 'found',
        email: 'person@example.com',
        newEmail: 'new@example.com',
        emailChangeSentAt: null,
      });
    }
    // GoTrue's own shapes are read as before.
    for (const sentAt of [
      '2026-10-31T11:58:30.25Z',
      '2026-10-31T11:58:30.25+00:00',
      '2026-10-31T11:58:30.123456Z',
      // Go drops a zero fraction, writes up to nine digits, and writes the
      // server's own offset when it is not UTC.
      '2026-10-31T11:58:30Z',
      '2026-10-31T11:58:30.123456789Z',
      '2026-10-31T04:58:30.123456-07:00',
    ]) {
      getUserById.mockResolvedValueOnce(
        user({ new_email: 'new@example.com', email_change_sent_at: sentAt }),
      );
      await expect(lookUpConfirmRecipient(USER_A, NOW), sentAt).resolves.toMatchObject({
        emailChangeSentAt: Date.parse(sentAt),
      });
    }
  });

  it('gone: GoTrue has no such account, it has no email, or it is disabled', async () => {
    getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 404, code: 'user_not_found', message: 'User not found' },
    });
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toEqual({ kind: 'gone' });

    for (const email of [null, undefined, '']) {
      getUserById.mockResolvedValueOnce(user({ email }));
      await expect(lookUpConfirmRecipient(USER_A, NOW), String(email)).resolves.toEqual({
        kind: 'gone',
      });
    }

    // A disabled account is banned in GoTrue (platform/account-status.ts).
    getUserById.mockResolvedValueOnce(user({ banned_until: '2126-01-01T00:00:00Z' }));
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toEqual({ kind: 'gone' });
  });

  it('failed: any other error, a missing user, or a throw (never thrown on)', async () => {
    getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 500, code: 'unexpected_failure', message: 'boom' },
    });
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toMatchObject({ kind: 'failed' });

    getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 404, code: 'not_found', message: 'route' },
    });
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toMatchObject({ kind: 'failed' });

    getUserById.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toMatchObject({ kind: 'failed' });

    getUserById.mockRejectedValueOnce(new Error('network'));
    await expect(lookUpConfirmRecipient(USER_A, NOW)).resolves.toMatchObject({ kind: 'failed' });
  });

  it('gives up after five seconds', async () => {
    vi.useFakeTimers();
    getUserById.mockReturnValueOnce(new Promise(() => {}));
    const pending = lookUpConfirmRecipient(USER_A, NOW);
    let settled: unknown = 'pending';
    void pending.then((v) => (settled = v));
    expect(CONFIRM_RECIPIENT_LOOKUP_TIMEOUT_MS).toBe(5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ kind: 'failed', reason: 'timeout' });
  });

  it('a lookup that answers in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    getUserById.mockResolvedValueOnce(user({}));
    await lookUpConfirmRecipient(USER_A, NOW);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('pendingEmailChangeFor (an email-change link GoTrue still holds)', () => {
  /** The link's issue time, in whole seconds. */
  const ISSUED = NOW.getTime() / 1000;
  const at = (seconds: number) => (ISSUED + seconds) * 1000;

  it('names the pending address while the change the link was built for is the latest', () => {
    expect(EMAIL_CHANGE_REQUEST_SKEW_S).toBe(5);
    // GoTrue stores the request before the link is signed: its time is
    // earlier, or later only by the clocks and the issue time's whole seconds.
    for (const sentAt of [at(-3), at(0), at(0.999), at(EMAIL_CHANGE_REQUEST_SKEW_S)]) {
      expect(
        pendingEmailChangeFor({ newEmail: 'new@example.com', emailChangeSentAt: sentAt }, ISSUED),
        String(sentAt),
      ).toBe('new@example.com');
    }
  });

  it('nothing pending (the change was completed or cancelled): no address', () => {
    for (const newEmail of [null, '']) {
      expect(pendingEmailChangeFor({ newEmail, emailChangeSentAt: at(0) }, ISSUED)).toBeNull();
      expect(pendingEmailChangeFor({ newEmail, emailChangeSentAt: null }, ISSUED)).toBeNull();
    }
  });

  it('a later request replaced the link (asked again to another address, or resent): no address', () => {
    for (const sentAt of [at(EMAIL_CHANGE_REQUEST_SKEW_S + 0.001), at(45), at(3600)]) {
      expect(
        pendingEmailChangeFor(
          { newEmail: 'corrected@example.com', emailChangeSentAt: sentAt },
          ISSUED,
        ),
        String(sentAt),
      ).toBeNull();
    }
  });

  it('a pending change without a recorded request time is not the live link: no address', () => {
    expect(
      pendingEmailChangeFor({ newEmail: 'new@example.com', emailChangeSentAt: null }, ISSUED),
    ).toBeNull();
    expect(
      emailChangeRequestTimeMissing({ newEmail: 'new@example.com', emailChangeSentAt: null }),
    ).toBe(true);
  });

  it('says the request time is missing only for a pending change without one', () => {
    for (const newEmail of [null, '']) {
      expect(emailChangeRequestTimeMissing({ newEmail, emailChangeSentAt: null })).toBe(false);
      expect(emailChangeRequestTimeMissing({ newEmail, emailChangeSentAt: at(0) })).toBe(false);
    }
    for (const sentAt of [at(-3), at(0), at(45), at(10 * 365 * 24 * 3600)]) {
      expect(
        emailChangeRequestTimeMissing({ newEmail: 'new@example.com', emailChangeSentAt: sentAt }),
      ).toBe(false);
    }
  });

  it('a request time far past the link is a later request: no address', () => {
    expect(
      pendingEmailChangeFor(
        { newEmail: 'new@example.com', emailChangeSentAt: at(10 * 365 * 24 * 3600) },
        ISSUED,
      ),
    ).toBeNull();
  });
});
