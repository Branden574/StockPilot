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

import {
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

describe('allowMfaCodeAttempt — one budget per account and client address', () => {
  it('on Vercel, keys on the account and the first forwarded address, 10 per 15 minutes, closed', async () => {
    vi.stubEnv('VERCEL', '1');
    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });

    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(true);

    expect(checkRateLimit).toHaveBeenCalledWith('mfa-code:u1:203.0.113.7', 10, 900000, 'closed');
    expect(MFA_CODE_ATTEMPT_LIMIT).toBe(10);
    expect(MFA_CODE_ATTEMPT_WINDOW_MS).toBe(15 * 60_000);
  });

  it('off Vercel, never trusts x-forwarded-for: x-real-ip, else unknown', async () => {
    vi.stubEnv('VERCEL', '');
    requestHeaders.current = new Headers({
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '198.51.100.8',
    });
    await allowMfaCodeAttempt('u1');
    expect(checkRateLimit).toHaveBeenLastCalledWith(
      'mfa-code:u1:198.51.100.8',
      10,
      900000,
      'closed',
    );

    requestHeaders.current = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    await allowMfaCodeAttempt('u1');
    expect(checkRateLimit).toHaveBeenLastCalledWith('mfa-code:u1:unknown', 10, 900000, 'closed');
  });

  it('a spent budget, or a limiter that cannot answer, refuses', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, count: 10, resetAt: 0 });
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
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

  function fakeClient(verifyError: unknown) {
    const challenge = vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null }));
    const verify = vi.fn(async () => ({ data: null, error: verifyError }));
    return { client: { auth: { mfa: { challenge, verify } } }, challenge, verify };
  }

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

  it('a spent budget asks GoTrue nothing and writes nothing', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, count: 10, resetAt: 0 });
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
