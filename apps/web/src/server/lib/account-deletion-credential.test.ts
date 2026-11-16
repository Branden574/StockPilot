// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How a deletion is confirmed (server/lib/account-deletion-credential): an
 * account with an authenticator needs aal2; an account with none needs its
 * password or the code emailed to its current address, each with its own
 * limit, and neither is ever reported.
 */

const { sendEmail, verifyPassword, checkRateLimit, reportError } = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_m: { to: string; subject: string; html: string; text: string }) => ({
    ok: true as boolean,
    id: 'email-1' as string | undefined,
  })),
  verifyPassword: vi.fn(
    async (
      _email: string,
      _password: string,
    ): Promise<
      { ok: true } | { ok: false; reason: 'invalid_password' | 'internal_error'; message: string }
    > => ({ ok: true }),
  ),
  checkRateLimit: vi.fn(
    async (_key: string, _limit: number, _windowMs: number, _mode?: string) => ({
      allowed: true,
      count: 1,
      resetAt: 0,
    }),
  ),
  reportError: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/env', () => ({
  env: {
    SUPABASE_SERVICE_ROLE_KEY: 'example-service-key-for-tests',
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
  },
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: verifyPassword }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  ACCOUNT_DELETE_CREDENTIAL_LIMIT,
  ACCOUNT_DELETE_CREDENTIAL_WINDOW_MS,
  confirmDeletionCredential,
  deletionCredentialStillHeld,
  deletionCredentialSupplied,
  sendDeletionCode,
} from './account-deletion-credential';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'person@example.test';
const PASSWORD = 'example-password-1';

const world = {
  factors: [] as Array<{ status: string }>,
  factorsError: null as null | { message: string; status?: number; code?: string },
  email: EMAIL as string | null,
  newEmail: null as string | null,
  /** The profile's (sanitised) name, and the auth user's own metadata name. */
  profileName: null as string | null,
  metadataName: null as string | null,
};

const admin = {
  auth: {
    admin: {
      mfa: {
        listFactors: vi.fn(async (_a: { userId: string }) =>
          world.factorsError
            ? { data: null, error: world.factorsError }
            : { data: { factors: world.factors }, error: null },
        ),
      },
      getUserById: vi.fn(async (id: string) => ({
        data: {
          user: {
            id,
            email: world.email,
            new_email: world.newEmail,
            user_metadata: world.metadataName ? { full_name: world.metadataName } : {},
          },
        },
        error: null,
      })),
    },
  },
  // The profile row, read by the account id for the greeting.
  from: (table: string) => {
    if (table !== 'user_profiles') throw new Error(`unexpected table ${table}`);
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: { full_name: world.profileName }, error: null }),
    };
    return builder;
  },
} as never;

const aal = (level: 'aal1' | 'aal2' | null) => async () => level;

beforeEach(() => {
  vi.clearAllMocks();
  world.factors = [];
  world.factorsError = null;
  world.email = EMAIL;
  world.newEmail = null;
  world.profileName = null;
  world.metadataName = null;
  sendEmail.mockImplementation(async () => ({ ok: true, id: 'email-1' }));
  verifyPassword.mockImplementation(async () => ({ ok: true }));
  checkRateLimit.mockImplementation(async () => ({ allowed: true, count: 1, resetAt: 0 }));
});

function confirm(
  input: Record<string, unknown>,
  level: 'aal1' | 'aal2' | null = 'aal1',
  userId = USER,
  now?: Date,
) {
  return confirmDeletionCredential({
    admin,
    userId,
    email: world.email,
    readLevel: aal(level),
    input,
    now,
  });
}

/** The code the last email carried (the test reads the email, as the person does). */
function codeFromLastEmail(): string {
  const text = sendEmail.mock.calls.at(-1)?.[0]?.text ?? '';
  const m = text.match(/\n([0-9]{6})\n/);
  if (!m) throw new Error('no code in the email');
  return m[1]!;
}

function noSecretReported(...secrets: string[]) {
  const reported = JSON.stringify(reportError.mock.calls.map((c) => [String(c[0]), c[1]]));
  for (const secret of secrets) expect(reported).not.toContain(secret);
}

describe('an account with a verified authenticator', () => {
  beforeEach(() => {
    world.factors = [{ status: 'verified' }];
  });

  it('at aal2: confirmed by the authenticator, no password checked, no limit spent', async () => {
    expect(await confirm({}, 'aal2')).toEqual({ ok: true, by: 'authenticator' });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('at aal1: the code is owed, even with a correct password', async () => {
    expect(await confirm({ password: PASSWORD }, 'aal1')).toEqual({
      ok: false,
      kind: 'aal2_required',
    });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('a level that cannot be read is not aal2', async () => {
    const r = await confirmDeletionCredential({
      admin,
      userId: USER,
      email: EMAIL,
      readLevel: async () => {
        throw new Error('unreadable');
      },
      input: {},
    });
    expect(r).toEqual({ ok: false, kind: 'aal2_required' });
  });

  it('an unverified factor does not count as one', async () => {
    world.factors = [{ status: 'unverified' }];
    expect(await confirm({}, 'aal2')).toEqual({ ok: false, kind: 'credential_required' });
  });
});

describe('an account with no verified authenticator', () => {
  it('nothing sent: a password or a code is required, whatever level the session claims', async () => {
    expect(await confirm({}, 'aal1')).toEqual({ ok: false, kind: 'credential_required' });
    expect(await confirm({}, 'aal2')).toEqual({ ok: false, kind: 'credential_required' });
  });

  it('the factors are read by the account id, never from the session', async () => {
    await confirm({ password: PASSWORD });
    expect(
      (admin as { auth: { admin: { mfa: { listFactors: ReturnType<typeof vi.fn> } } } }).auth.admin
        .mfa.listFactors,
    ).toHaveBeenCalledWith({ userId: USER });
  });

  it('the right password: confirmed, checked against the current address, one try counted first', async () => {
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: true, by: 'password' });
    expect(verifyPassword).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(checkRateLimit).toHaveBeenCalledWith(
      `account-delete-password:${USER}`,
      ACCOUNT_DELETE_CREDENTIAL_LIMIT,
      ACCOUNT_DELETE_CREDENTIAL_WINDOW_MS,
      'closed',
    );
    expect(checkRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      verifyPassword.mock.invocationCallOrder[0]!,
    );
  });

  it('a wrong password: refused plainly, and the password is never reported', async () => {
    verifyPassword.mockImplementation(async () => ({
      ok: false,
      reason: 'invalid_password',
      message: 'Password is incorrect.',
    }));
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: false, kind: 'password_refused' });
    noSecretReported(PASSWORD);
  });

  it('a password check that could not run: try again, not "wrong password"', async () => {
    verifyPassword.mockImplementation(async () => ({
      ok: false,
      reason: 'internal_error',
      message: 'Could not verify your current password. Please try again.',
    }));
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: false, kind: 'check_failed' });
  });

  it('the password limit reached: refused before any check', async () => {
    checkRateLimit.mockImplementation(async () => ({ allowed: false, count: 6, resetAt: 0 }));
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: false, kind: 'rate_limited' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('no current address: the password is refused without a check', async () => {
    world.email = null;
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: false, kind: 'password_refused' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('factors that cannot be read: fails closed', async () => {
    world.factorsError = { message: 'unavailable', status: 503 };
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: false, kind: 'check_failed' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('no such account: gone', async () => {
    world.factorsError = { message: 'User not found', status: 404, code: 'user_not_found' };
    expect(await confirm({ password: PASSWORD })).toEqual({ ok: false, kind: 'gone' });
  });
});

describe('the emailed code', () => {
  it('is sent to the current address only, never to a pending new one, and the answer holds no code', async () => {
    world.newEmail = 'pending-new@example.test';
    const sent = await sendDeletionCode({ admin, userId: USER });
    expect(sent.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0].to).toBe(EMAIL);
    const code = codeFromLastEmail();
    expect(JSON.stringify(sent)).not.toContain(code);
    expect(sendEmail.mock.calls[0]![0].subject).not.toContain(code);
    expect(checkRateLimit).toHaveBeenCalledWith(
      `account-delete-code-send:${USER}`,
      ACCOUNT_DELETE_CREDENTIAL_LIMIT,
      ACCOUNT_DELETE_CREDENTIAL_WINDOW_MS,
      'closed',
    );
  });

  it('the right code with its challenge: confirmed, one try counted on its own limit', async () => {
    const sent = await sendDeletionCode({ admin, userId: USER });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    checkRateLimit.mockClear();
    expect(await confirm({ code, challenge: sent.challenge })).toEqual({
      ok: true,
      by: 'emailed_code',
    });
    expect(checkRateLimit).toHaveBeenCalledWith(
      `account-delete-code-check:${USER}`,
      ACCOUNT_DELETE_CREDENTIAL_LIMIT,
      ACCOUNT_DELETE_CREDENTIAL_WINDOW_MS,
      'closed',
    );
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('a wrong code: refused plainly, and neither code nor challenge is reported', async () => {
    const sent = await sendDeletionCode({ admin, userId: USER });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    const wrong = code === '000000' ? '000001' : '000000';
    expect(await confirm({ code: wrong, challenge: sent.challenge })).toEqual({
      ok: false,
      kind: 'code_refused',
    });
    noSecretReported(code, sent.challenge);
  });

  it('an expired code: refused, the same answer as a wrong one', async () => {
    const sentAt = new Date('2026-11-15T12:00:00Z');
    const sent = await sendDeletionCode({ admin, userId: USER, now: sentAt });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    const later = new Date(sentAt.getTime() + 10 * 60_000 + 1000);
    expect(await confirm({ code, challenge: sent.challenge }, 'aal1', USER, later)).toEqual({
      ok: false,
      kind: 'code_refused',
    });
    const inTime = new Date(sentAt.getTime() + 9 * 60_000);
    expect(await confirm({ code, challenge: sent.challenge }, 'aal1', USER, inTime)).toEqual({
      ok: true,
      by: 'emailed_code',
    });
  });

  it("another account's code and challenge: refused for this account", async () => {
    const sent = await sendDeletionCode({ admin, userId: OTHER_USER });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    expect(await confirm({ code, challenge: sent.challenge }, 'aal1', USER)).toEqual({
      ok: false,
      kind: 'code_refused',
    });
  });

  it('a code sent before the address changed: refused', async () => {
    const sent = await sendDeletionCode({ admin, userId: USER });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    world.email = 'changed@example.test';
    expect(await confirm({ code, challenge: sent.challenge })).toEqual({
      ok: false,
      kind: 'code_refused',
    });
  });

  it('a code without its challenge, or a challenge without a code: refused', async () => {
    expect(await confirm({ code: '123456' })).toEqual({ ok: false, kind: 'code_refused' });
    expect(await confirm({ challenge: 'v1.x' })).toEqual({ ok: false, kind: 'code_refused' });
  });

  it('the code-check limit reached: refused before any check', async () => {
    const sent = await sendDeletionCode({ admin, userId: USER });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    checkRateLimit.mockImplementation(async () => ({ allowed: false, count: 6, resetAt: 0 }));
    expect(await confirm({ code, challenge: sent.challenge })).toEqual({
      ok: false,
      kind: 'rate_limited',
    });
  });

  it('the send limit reached: nothing sent', async () => {
    checkRateLimit.mockImplementation(async () => ({ allowed: false, count: 6, resetAt: 0 }));
    expect(await sendDeletionCode({ admin, userId: USER })).toEqual({
      ok: false,
      kind: 'rate_limited',
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('an account with an authenticator is not offered a code: nothing sent, no limit spent', async () => {
    world.factors = [{ status: 'verified' }];
    expect(await sendDeletionCode({ admin, userId: USER })).toEqual({
      ok: false,
      kind: 'not_offered',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('an email the service did not accept: answered as a sent code, reported without the code or the address', async () => {
    sendEmail.mockImplementation(async () => ({ ok: false, id: undefined }));
    const sent = await sendDeletionCode({ admin, userId: USER });
    expect(sent.ok).toBe(true);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'account.delete.code_send_failed',
      level: 'warning',
    });
    noSecretReported(codeFromLastEmail(), EMAIL);
  });

  it('a deployment with no email key (nothing sent): answered as a sent code, reported', async () => {
    sendEmail.mockImplementation(async () => ({ ok: true, id: 'dryrun' }));
    const sent = await sendDeletionCode({ admin, userId: USER });
    expect(sent.ok).toBe(true);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'account.delete.code_send_failed',
      level: 'warning',
    });
    noSecretReported(codeFromLastEmail(), EMAIL);
  });

  it('a sent email is not reported', async () => {
    await sendDeletionCode({ admin, userId: USER });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("greets with the first word of the profile's name, never the auth user's metadata name", async () => {
    world.profileName = 'Pat Example';
    world.metadataName = 'https://elsewhere.example.test';
    await sendDeletionCode({ admin, userId: USER });
    const text = sendEmail.mock.calls.at(-1)![0].html;
    expect(text).toContain('Hi Pat ');
    expect(text).not.toContain('elsewhere.example.test');
  });

  it('no profile name: no name in the greeting, and still not the metadata name', async () => {
    world.metadataName = 'Someone';
    await sendDeletionCode({ admin, userId: USER });
    const html = sendEmail.mock.calls.at(-1)![0].html;
    expect(html).not.toContain('Someone');
    expect(html).toContain('Hi —');
  });

  it('no current address: nothing sent', async () => {
    world.email = null;
    expect(await sendDeletionCode({ admin, userId: USER })).toEqual({
      ok: false,
      kind: 'send_failed',
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a code for an account with an authenticator is no way around it', async () => {
    const sent = await sendDeletionCode({ admin, userId: USER });
    if (!sent.ok) throw new Error('not sent');
    const code = codeFromLastEmail();
    world.factors = [{ status: 'verified' }];
    expect(await confirm({ code, challenge: sent.challenge }, 'aal1')).toEqual({
      ok: false,
      kind: 'aal2_required',
    });
  });
});

describe('deletionCredentialSupplied', () => {
  it('reads the shape only', () => {
    expect(deletionCredentialSupplied({})).toBeNull();
    expect(deletionCredentialSupplied({ password: '' })).toBeNull();
    expect(deletionCredentialSupplied({ password: 12345 })).toBeNull();
    expect(deletionCredentialSupplied({ password: 'x' })).toBe('password');
    expect(deletionCredentialSupplied({ code: '123456' })).toBe('code');
    expect(deletionCredentialSupplied({ challenge: 'v1.x' })).toBe('code');
  });
});

describe('deletionCredentialStillHeld (the last check before the delete)', () => {
  // How the request was confirmed, and the session's level, as named values.
  const TYPED = 'password' as const;
  const EMAILED = 'emailed_code' as const;
  const AUTHENTICATOR = 'authenticator' as const;
  const AAL1 = 'aal1' as const;
  const AAL2 = 'aal2' as const;
  const held = (
    confirmedBy: 'authenticator' | 'password' | 'emailed_code' | null,
    level: 'aal1' | 'aal2',
    allow = false,
  ) =>
    deletionCredentialStillHeld({
      admin,
      userId: USER,
      readLevel: aal(level),
      confirmedBy,
      allowUnconfirmedWithoutFactor: allow,
    });

  it('confirmed by the authenticator, and the factors are gone by now: a password or a code is required', async () => {
    world.factors = [];
    expect(await held(AUTHENTICATOR, AAL2)).toEqual({ ok: false, kind: 'credential_required' });
  });

  it('confirmed by the password, and a factor was added since: the code is owed', async () => {
    world.factors = [{ status: 'verified' }];
    expect(await held(TYPED, AAL1)).toEqual({ ok: false, kind: 'aal2_required' });
    expect(await held(TYPED, AAL2)).toEqual({ ok: true });
  });

  it('confirmed by the password or the code, still no factor: held', async () => {
    expect(await held(TYPED, AAL1)).toEqual({ ok: true });
    expect(await held(EMAILED, AAL1)).toEqual({ ok: true });
  });

  it('no confirmation: held only where the caller allows it', async () => {
    expect(await held(null, AAL1)).toEqual({ ok: false, kind: 'credential_required' });
    expect(await held(null, AAL1, true)).toEqual({ ok: true });
  });

  it('factors that cannot be read: fails closed', async () => {
    world.factorsError = { message: 'unavailable', status: 503 };
    expect(await held(TYPED, AAL1)).toEqual({ ok: false, kind: 'check_failed' });
  });
});
