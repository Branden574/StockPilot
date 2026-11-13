import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web's authenticator code checks (the sign-in code, the step-up and the
 * reset's code step) share one budget of code attempts per account and client
 * address, and write an mfa.code_refused row only for a code GoTrue judged
 * wrong: never the code, GoTrue's message or the factor id, and with no
 * organization, so the row is not shown to the organization's admins and never
 * counts as the person's own last action.
 */

const { requestHeaders, checkRateLimit, auditInsert, reportError } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  checkRateLimit: vi.fn(),
  auditInsert: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: vi.fn(async () => requestHeaders.current) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/server/services/audit', () => ({
  insertAuditRowReported: vi.fn(async (row: unknown) => {
    auditInsert(row);
    return true;
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { verifiedSessionAuth } from '@/test/verified-session-stub';

import {
  MFA_CODE_ACCOUNT_LIMIT,
  MFA_CODE_ACCOUNT_WINDOW_MS,
  MFA_CODE_ATTEMPT_LIMIT,
  MFA_CODE_ATTEMPT_WINDOW_MS,
  allowMfaCodeAttempt,
  checkMfaCode,
  recordRefusedMfaCode,
} from './mfa-code-attempts';

const WRONG_CODE = '135790';

beforeEach(() => {
  vi.clearAllMocks();
  requestHeaders.current = new Headers();
  checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A cookie client whose session verifies as `holder.sub` (u1 unless a test
 * changes it, for instance from inside the verify: a session that refreshed
 * into another account while GoTrue checked the code).
 */
function fakeClient(
  verifyError: unknown,
  holder: { sub: string; read?: 'answer' | 'error' } = { sub: 'u1' },
) {
  const challenge = vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null }));
  const verify = vi.fn(async () => ({ data: null, error: verifyError }));
  const signOut = vi.fn(async () => ({ error: null }));
  const reads: string[] = [];
  const client = {
    auth: {
      mfa: { challenge, verify },
      signOut,
      ...verifiedSessionAuth(
        () => ({ sub: holder.sub, aal: 'aal1', read: holder.read ?? 'answer' }),
        (call) => reads.push(call),
      ),
    },
  };
  return { client, challenge, verify, signOut, reads };
}

describe('allowMfaCodeAttempt — per account and client address, and per account', () => {
  it('on Vercel, keys on the account and the first forwarded address, 10 per 15 minutes, closed', async () => {
    vi.stubEnv('VERCEL', '1');
    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });

    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(true);

    expect(checkRateLimit).toHaveBeenCalledWith('mfa-code:u1:203.0.113.7', 10, 900000, 'closed');
    expect(MFA_CODE_ATTEMPT_LIMIT).toBe(10);
    expect(MFA_CODE_ATTEMPT_WINDOW_MS).toBe(15 * 60_000);
  });

  it('also spends the account’s own bucket, 20 per hour at any address, closed: each once', async () => {
    vi.stubEnv('VERCEL', '1');
    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7' });

    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(true);

    expect(checkRateLimit).toHaveBeenCalledTimes(2);
    expect(checkRateLimit).toHaveBeenCalledWith('mfa-code:u1:203.0.113.7', 10, 900000, 'closed');
    expect(checkRateLimit).toHaveBeenCalledWith('mfa-code-account:u1', 20, 3600000, 'closed');
    expect(MFA_CODE_ACCOUNT_LIMIT).toBe(20);
    expect(MFA_CODE_ACCOUNT_WINDOW_MS).toBe(60 * 60_000);
  });

  it('off Vercel, never trusts x-forwarded-for: x-real-ip, else unknown', async () => {
    vi.stubEnv('VERCEL', '');
    requestHeaders.current = new Headers({
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '198.51.100.8',
    });
    await allowMfaCodeAttempt('u1');
    expect(checkRateLimit).toHaveBeenCalledWith('mfa-code:u1:198.51.100.8', 10, 900000, 'closed');

    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    await allowMfaCodeAttempt('u1');
    expect(checkRateLimit).toHaveBeenCalledWith('mfa-code:u1:unknown', 10, 900000, 'closed');
  });

  it('a spent budget, or a limiter that cannot answer, refuses', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, count: 10, resetAt: 0 });
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
  });

  it.each([
    ['the account at this address', 'mfa-code:'],
    ['the account at every address', 'mfa-code-account:'],
  ])('goes ahead only when both allow it: %s spent alone refuses', async (_label, spent) => {
    checkRateLimit.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith(spent),
      count: 0,
      resetAt: 0,
    }));
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
  });

  it('a press the account-and-address bucket refuses never asks the account bucket', async () => {
    vi.stubEnv('VERCEL', '1');
    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    checkRateLimit.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith('mfa-code:'),
      count: 10,
      resetAt: 0,
    }));

    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);

    expect(checkRateLimit.mock.calls).toEqual([['mfa-code:u1:203.0.113.7', 10, 900000, 'closed']]);
  });

  it('asks the account bucket only once the account-and-address bucket has allowed the press', async () => {
    vi.stubEnv('VERCEL', '1');
    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    type Answer = { allowed: boolean; count: number; resetAt: number };
    let answerAtAddress: (answer: Answer) => void = () => {};
    checkRateLimit.mockImplementation((key: string) =>
      key.startsWith('mfa-code:')
        ? new Promise<Answer>((resolve) => {
            answerAtAddress = resolve;
          })
        : Promise.resolve({ allowed: true, count: 1, resetAt: 0 }),
    );

    const pending = allowMfaCodeAttempt('u1');
    // Let every queued step run: the address bucket has not answered yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkRateLimit.mock.calls.map((c) => c[0])).toEqual(['mfa-code:u1:203.0.113.7']);

    answerAtAddress({ allowed: true, count: 1, resetAt: 0 });
    await expect(pending).resolves.toBe(true);
    expect(checkRateLimit.mock.calls.map((c) => c[0])).toEqual([
      'mfa-code:u1:203.0.113.7',
      'mfa-code-account:u1',
    ]);
  });
});

describe('recordRefusedMfaCode', () => {
  it('writes one platform-only row naming the account, the path, the level and GoTrue’s code', async () => {
    requestHeaders.current = new Headers({
      'x-forwarded-for': '203.0.113.7',
      'user-agent': 'vitest-agent',
    });

    await recordRefusedMfaCode({
      userId: 'u1',
      path: 'challenge',
      sessionAal: 'aal1',
      gotrueCode: 'mfa_verification_failed',
    });

    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(auditInsert).toHaveBeenCalledWith({
      organization_id: null,
      user_id: 'u1',
      event: 'mfa.code_refused',
      ip: '203.0.113.7',
      user_agent: 'vitest-agent',
      metadata: {
        entity_type: 'user',
        entity_id: 'u1',
        warehouse_id: null,
        before: null,
        after: null,
        reason: null,
        path: 'challenge',
        session_aal: 'aal1',
        gotrue_code: 'mfa_verification_failed',
      },
    });
  });

  it('on the reset path, carries no session level', async () => {
    await recordRefusedMfaCode({
      userId: 'u1',
      path: 'password_reset',
      gotrueCode: 'mfa_verification_failed',
    });

    const row = auditInsert.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(row.metadata.path).toBe('password_reset');
    expect('session_aal' in row.metadata).toBe(false);
  });
});

describe('checkMfaCode', () => {
  const GOTRUE_WRONG_CODE = {
    name: 'AuthApiError',
    status: 422,
    code: 'mfa_verification_failed',
    message: 'Invalid TOTP code entered',
  };


  it('a refused code writes a row with neither the code, GoTrue’s message nor the factor id', async () => {
    const { client } = fakeClient(GOTRUE_WRONG_CODE);

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'factor-secret-id',
      code: WRONG_CODE,
      path: 'challenge',
      sessionAal: 'aal1',
    });

    expect(res).toEqual({ kind: 'verify_failed', outcome: 'refused' });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    const row = JSON.stringify(auditInsert.mock.calls[0]![0]);
    expect(row).not.toContain(WRONG_CODE);
    expect(row).not.toContain('Invalid TOTP code entered');
    expect(row).not.toContain('factor-secret-id');
    expect(row).not.toContain('challenge-1');
  });

  it.each([
    ['both buckets', ''],
    ['the account’s ceiling at every address alone', 'mfa-code-account:'],
  ])('a spent budget (%s) asks GoTrue nothing and writes nothing', async (_label, spent) => {
    checkRateLimit.mockImplementation(async (key: string) => ({
      allowed: !key.startsWith(spent),
      count: 10,
      resetAt: 0,
    }));
    const { client, challenge, verify } = fakeClient(null);

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'password_reset',
    });

    expect(res).toEqual({ kind: 'budget_spent' });
    expect(challenge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['no answer', { name: 'AuthRetryableFetchError', status: 503, message: 'x' }, 'no_answer'],
    [
      'a rate limit',
      { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit' },
      'limited',
    ],
    [
      'a gone session',
      { name: 'AuthSessionMissingError', status: 400, message: 'x' },
      'session_gone',
    ],
    ['an unknown answer', { name: 'AuthUnknownError', message: 'x' }, 'unchecked'],
  ])('a code GoTrue did not judge (%s) writes no row', async (_label, error, outcome) => {
    const { client } = fakeClient(error);

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'challenge',
      sessionAal: 'aal1',
    });

    expect(res).toEqual({ kind: 'verify_failed', outcome });
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('an unknown answer is reported with its name, code and status only', async () => {
    const { client } = fakeClient({
      name: 'AuthApiError',
      status: 400,
      code: 'something_new',
      message: 'GoTrue words',
    });

    await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'challenge',
      sessionAal: 'aal1',
    });

    expect(reportError).toHaveBeenCalledTimes(1);
    const [, report] = reportError.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(report).toEqual({
      tag: 'mfa.verify_unclassified',
      level: 'warning',
      extra: { name: 'AuthApiError', code: 'something_new', status: 400 },
    });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('GoTrue words');
  });
});

/**
 * The account a code press spends its budget on and names in its row is the
 * account GoTrue checked the code for (S78). After GoTrue's answer the
 * session is read again, held to that account (readVerifiedSessionClaimsOf):
 * a session that now holds another account is signed out here, the press
 * does not count as verified, and no row names the account it was checked for.
 */
describe('checkMfaCode — the answer counts only for the account the press was checked for', () => {
  const GOTRUE_WRONG_CODE = {
    name: 'AuthApiError',
    status: 422,
    code: 'mfa_verification_failed',
    message: 'Invalid TOTP code entered',
  };

  it('a code accepted while the session moved to another account is not verified, and this session is signed out', async () => {
    const holder = { sub: 'u1' };
    const { client, verify, signOut } = fakeClient(null, holder);
    verify.mockImplementation(async () => {
      holder.sub = 'u2';
      return { data: null, error: null };
    });

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'challenge',
      sessionAal: 'aal1',
    });

    expect(res).toEqual({ kind: 'account_changed' });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('a code refused while the session moved to another account writes no row for the account it was checked for', async () => {
    const holder = { sub: 'u1' };
    const { client, verify, signOut } = fakeClient(null, holder);
    verify.mockImplementation(async () => {
      holder.sub = 'u2';
      return { data: null, error: GOTRUE_WRONG_CODE };
    });

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'password_reset',
    });

    expect(res).toEqual({ kind: 'account_changed' });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(auditInsert).not.toHaveBeenCalled();
  });

  // S78: a read that cannot verify the session is not another account. The
  // answer is not counted (not verified, no row) and the session stays.
  it.each([
    ['accepted', null, 'challenge'],
    ['refused', GOTRUE_WRONG_CODE, 'password_reset'],
  ] as const)(
    'a code GoTrue %s while the session could not be verified is unconfirmed: no row, nobody signed out',
    async (_label, verifyError, path) => {
      const holder: { sub: string; read?: 'answer' | 'error' } = { sub: 'u1' };
      const { client, verify, signOut } = fakeClient(null, holder);
      verify.mockImplementation(async () => {
        holder.read = 'error';
        return { data: null, error: verifyError };
      });

      const res = await checkMfaCode(client as never, {
        userId: 'u1',
        factorId: 'f1',
        code: WRONG_CODE,
        path,
      });

      expect(res).toEqual({ kind: 'unconfirmed' });
      expect(signOut).not.toHaveBeenCalled();
      expect(auditInsert).not.toHaveBeenCalled();
    },
  );

  it('control: the same account throughout is verified, read again only after GoTrue answered', async () => {
    const { client, verify, signOut, reads } = fakeClient(null);
    let readsBeforeVerify = -1;
    verify.mockImplementation(async () => {
      readsBeforeVerify = reads.length;
      return { data: null, error: null };
    });

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'challenge',
      sessionAal: 'aal1',
    });

    expect(res).toEqual({ kind: 'verified' });
    expect(readsBeforeVerify).toBe(0);
    expect(reads).toEqual(['getSession', 'getClaims']);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('control: a refused code of the same account writes its one row', async () => {
    const { client, signOut } = fakeClient(GOTRUE_WRONG_CODE);

    const res = await checkMfaCode(client as never, {
      userId: 'u1',
      factorId: 'f1',
      code: WRONG_CODE,
      path: 'challenge',
      sessionAal: 'aal1',
    });

    expect(res).toEqual({ kind: 'verify_failed', outcome: 'refused' });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1' }));
    expect(signOut).not.toHaveBeenCalled();
  });
});

// The auth audit helpers write audit_logs rows with the service role for
// whatever event, account and organization they are handed. Exported from a
// 'use server' module they would be Server Actions: endpoints anyone could
// call to write Audit log rows.
describe('the auth audit helpers and the code-attempt module stay server code', () => {
  const WEB_SRC = path.resolve(__dirname, '../..');
  const read = (rel: string) => readFileSync(path.join(WEB_SRC, rel), 'utf8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const HELPERS = ['emitAuthAudit', 'resolveDefaultOrgAndRole'];

  it.each(['server/services/auth-audit.ts', 'lib/auth/mfa-code-attempts.ts'])(
    '%s starts with server-only and is never a server module',
    (file) => {
      const src = read(file);
      expect(src.trimStart().startsWith("import 'server-only';")).toBe(true);
      expect(code(src)).not.toMatch(/['"]use server['"]/);
    },
  );

  it('no server module under server/actions defines or re-exports the helpers', () => {
    const dir = path.join(WEB_SRC, 'server/actions');
    for (const file of readdirSync(dir).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    )) {
      const src = code(read(`server/actions/${file}`));
      if (!/^\s*['"]use server['"]/.test(src)) continue;
      for (const name of HELPERS) {
        expect(src, `${file} ${name}`).not.toMatch(new RegExp(`function ${name}\\b`));
        expect(src, `${file} ${name}`).not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`));
        expect(src, `${file} ${name}`).not.toMatch(
          new RegExp(`export\\s+(const|let|var)\\s+${name}\\b`),
        );
      }
    }
  });
});
