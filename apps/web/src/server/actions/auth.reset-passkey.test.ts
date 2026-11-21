import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SoftAuthenticator } from '@/test/fixtures/soft-authenticator';
import { world } from '@/test/passkey-world';

/**
 * Stage 5: the password reset's second step for a passkey holder (plan 2.6 A
 * and B with purpose `password_reset`, 3.1 #4, 3.2 j). The reset is a path
 * where the person has NOT typed their password: a holder of the emailed link
 * alone must not get past the second step.
 *
 * The real completePasswordResetAction, the real passkey module and the REAL
 * @simplewebauthn/server, fed by a software authenticator; Supabase Auth and
 * the database are the fakes of test/passkey-world.ts.
 *
 *   - The reset offers the passkey only when it can serve now (decision A's
 *     USE level: a site, the bridge key, the kill switch on; and the account's
 *     bridge serving, judged as the second-step page judges it). Otherwise it
 *     is the reset of stage 2, exactly: the code of an app, or for a
 *     bridge-only account the plain words, and a passkey answer sent anyway is
 *     never read.
 *   - The ceremony is started only on a session an emailed link opened within
 *     the hour (the link's `amr`), for purpose `password_reset`, and its answer
 *     is spent only inside completePasswordResetAction (rule 20): bound to the
 *     account, THIS session, this purpose and this browser's cookie,
 *     user-verified, by one of the account's own passkeys.
 *   - The bridge raises THIS link session to aal2, then the password is set
 *     and every session of the account ends (global), the raised one included.
 *   - The reset never finishes a removal and never repairs a bridge: its start
 *     writes one challenge and nothing else.
 */

vi.mock('@/lib/env', async () => ({ env: (await import('@/test/passkey-world')).world.env }));
vi.mock('@/lib/supabase/admin', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return { createAdminClient: () => w.admin };
});
vi.mock('@/lib/supabase/server', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return { createClient: async () => w.cookieClient };
});
vi.mock('next/headers', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return { cookies: async () => w.cookieStore, headers: async () => w.requestHeaders };
});
vi.mock('next/navigation', async (importOriginal) => ({
  unstable_rethrow: (await importOriginal<typeof import('next/navigation')>()).unstable_rethrow,
  redirect: vi.fn(),
}));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/auth/account-status', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return {
    loadAccountStatus: vi.fn(async () => w.accountStatus),
    noteDisabledAccountBlocked: vi.fn(),
  };
});
vi.mock('@/lib/rate-limit', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return { checkRateLimit: vi.fn(async () => ({ allowed: w.limiterAllows })) };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => true),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: 'org-1', role: 'admin' })),
}));
vi.mock('@/server/services/lib/defer', () => ({
  defer: (fn: () => Promise<unknown>) => void fn(),
  keepAlive: () => undefined,
}));
vi.mock('@/server/security/events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
vi.mock('@/server/security/passkey-emails', () => ({
  sendPasskeyAddedEmail: vi.fn(async () => undefined),
  sendPasskeyRemovedEmail: vi.fn(),
}));
vi.mock('@/server/services/sessions', () => ({
  listMySessionIds: vi.fn(async () => []),
  broadcastEndedSessions: vi.fn(async () => undefined),
}));
vi.mock('@/lib/supabase/access-token-client', () => ({
  createAccessTokenClient: () => ({ rpc: vi.fn(async () => ({ data: null, error: null })) }),
}));
vi.mock('@/lib/auth/mfa-code-attempts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/mfa-code-attempts')>()),
  checkMfaCode: vi.fn(),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/auth/platform-admin', () => ({ isPlatformAdmin: () => false }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: vi.fn() }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastToChannel: vi.fn(async () => undefined) }));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/server/security/account-events', () => ({
  recordSignInBlocked: vi.fn(),
  recordAccountCodeBlocked: vi.fn(),
}));

const { checkMfaCode } = await import('@/lib/auth/mfa-code-attempts');
const { emitAuthAudit } = await import('@/server/services/auth-audit');
const { reportError } = await import('@/lib/error-reporter');
const { checkRateLimit } = await import('@/lib/rate-limit');
const pk = await import('@/server/security/passkeys');
const { startPasswordResetPasskeyAction, finishSecondStepAction } = await import('./passkeys');
const { completePasswordResetAction } = await import('./auth');

const NEW_VALUE = 'Sample-new-value-9';
const PASSWORDS = { password: NEW_VALUE, confirmPassword: NEW_VALUE };
const SAMPLE_PASSWORD = 'sample-password-not-real';

const PASSKEY_ASK = 'Confirm with your passkey to finish resetting your password.';
const PASSKEY_OR_CODE_ASK =
  'Confirm with your passkey, or enter the 6-digit code from your authenticator app, to finish resetting your password.';
const RESET_CODE_ASK =
  'Enter the 6-digit code from your authenticator app to finish resetting your password.';
const RESET_BRIDGE_ONLY =
  "A password reset isn't available for this account yet. Ask your organization's owner or StockPilot support for help.";
const RESET_NEEDS_LINK =
  'A new password can be set here only within an hour of opening the link in your email. Choose Forgot? on the sign-in page to get a new link. If you are signed in, use Change password in Settings → Security.';
const RESET_LINK_GONE =
  'That link has expired or was already used. Choose Forgot? on the sign-in page to get a new link by email.';

/** A member whose only second step is a healthy passkey (S6), added with the password. */
async function passkeyOnlyMember(email = 'member@example.test') {
  const userId = world.addAccount(email);
  world.signIn(userId, 'aal1');
  const soft = new SoftAuthenticator();
  const start = await pk.startAddPasskey({
    proof: { kind: 'password', password: SAMPLE_PASSWORD },
  });
  if (!start.ok) throw new Error(`start add refused: ${start.reason}`);
  const added = await pk.finishAddPasskey({
    challengeId: start.challengeId,
    response: soft.create(start.optionsJSON as never),
    name: 'Work laptop',
  });
  if (!added.ok) throw new Error(`add refused: ${added.reason}`);
  return { userId, soft };
}

/** The member opens the emailed reset link: a fresh session, aal1, the link's `amr`. */
function openLink(userId: string, ageS = 60) {
  const session = world.openResetLink(userId, ageS);
  world.calls.setSession = 0;
  world.calls.fns.length = 0;
  world.calls.auth.length = 0;
  return session;
}

type StartAnswer = Awaited<ReturnType<typeof startPasswordResetPasskeyAction>>;
function optionsOf(start: StartAnswer) {
  if (!start.ok || start.data.kind !== 'options')
    throw new Error(`no options: ${JSON.stringify(start)}`);
  return {
    challengeId: start.data.challengeId,
    options: start.data.optionsJSON as { challenge: string; rpId?: string },
  };
}

/** The reset's ceremony: the start, the device's answer, then the reset with it. */
async function resetWithPasskey(
  soft: SoftAuthenticator,
  knobs: Parameters<SoftAuthenticator['get']>[2] = {},
) {
  const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
  return completePasswordResetAction({
    ...PASSWORDS,
    passkeyAnswer: { challengeId, response: soft.get(options, undefined, knobs) },
  });
}

const fnNames = () => world.calls.fns.map((c) => c.name);
const verifyCalls = () => world.calls.auth.filter((c) => /\/verify$/.test(c.path));
const claimsNow = () => (world.cookieToken ? world.claimsOf(world.cookieToken) : null);

beforeEach(() => {
  world.reset();
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  vi.stubGlobal('fetch', world.fetch);
  vi.clearAllMocks();
  vi.mocked(emitAuthAudit).mockImplementation(async () => true);
  vi.mocked(checkRateLimit).mockImplementation(
    async () => ({ allowed: world.limiterAllows }) as Awaited<ReturnType<typeof checkRateLimit>>,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('S6, a member whose only second step is a passkey', () => {
  it('a press with no answer asks for the passkey: no code box, nothing written, no password set', async () => {
    const { userId } = await passkeyOnlyMember();
    openLink(userId);
    const res = await completePasswordResetAction(PASSWORDS);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: PASSKEY_ASK,
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    expect(fnNames()).not.toContain('issue_passkey_challenge');
    expect(world.calls.passwordSets).toEqual([]);
  });

  it('the passkey raises THIS link session to aal2, the password is set, then every session of the account ends', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    const link = openLink(userId);
    const elsewhere = world.signIn(userId, 'aal2');
    world.cookieToken = world.signToken(link);

    const res = await resetWithPasskey(soft);

    expect(res).toEqual({ ok: true, data: { next: '/signin?reset=success' } });
    expect(world.calls.passwordSets).toEqual([userId]);
    // The bridge was answered as the link session, which was written once.
    expect(world.calls.setSession).toBe(1);
    expect(verifyCalls()).toHaveLength(1);
    expect(world.claimsOf(verifyCalls()[0]!.token)).toMatchObject({ session_id: link.id });
    // Every session of the account ended, the raised one and the other device's.
    expect(world.calls.cookieSignOut).toEqual(['global']);
    expect(world.sessions.has(link.id)).toBe(false);
    expect(world.sessions.has(elsewhere.id)).toBe(false);
  });

  it('the raise row and the passkey.used row name the reset and this session; passkey.used has no organization', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    const link = openLink(userId);
    vi.mocked(emitAuthAudit).mockClear();
    await resetWithPasskey(soft);
    const rows = vi.mocked(emitAuthAudit).mock.calls.map((c) => c[0]);
    const raise = rows.find((r) => r.event === 'passkey.bridge_raise')!;
    expect(raise.extra).toMatchObject({ session_id: link.id, purpose: 'password_reset' });
    const used = rows.find((r) => r.event === 'passkey.used')!;
    expect(used).toMatchObject({
      userId,
      organizationId: null,
      extra: { purpose: 'password_reset', session_id: link.id, raise_id: raise.extra!.raise_id },
    });
    expect(JSON.stringify(used)).not.toContain(world.passkeys[0]!.credential_id);
    // The raise row is written before the bridge is answered.
    const raiseAt = vi.mocked(emitAuthAudit).mock.invocationCallOrder[rows.indexOf(raise)]!;
    expect(raiseAt).toBeLessThan(
      vi.mocked(emitAuthAudit).mock.invocationCallOrder[rows.indexOf(used)]!,
    );
  });

  it('the answer is spent by the reset: the same answer again, with the same browser cookie, is refused', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    const link = openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    const response = soft.get(options);
    const browserCookies = new Map(world.cookies);
    const first = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response },
    });
    expect(first.ok).toBe(true);
    expect(world.challenges.find((c) => c.id === challengeId)!.used_at).not.toBeNull();
    // The same link session at aal1 again, and the binding cookie put back:
    // only the spent challenge stands in the way.
    const again = { ...link, aal: 'aal1' as const };
    world.sessions.set(link.id, again);
    world.cookieToken = world.signToken(again);
    world.cookies = browserCookies;
    world.calls.fns.length = 0;
    const replay = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response },
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.message).toBe('That request expired. Try again.');
    expect(fnNames()).toContain('take_passkey_challenge');
    expect(world.calls.passwordSets).toEqual([userId]);
  });
});

describe('a member with an authenticator app and a passkey', () => {
  async function bothMember() {
    const { userId, soft } = await passkeyOnlyMember('both@example.test');
    const app = world.addApp(userId);
    return { userId, soft, app };
  }

  it('a press with no answer offers both: the passkey, or the code of the app', async () => {
    const { userId } = await bothMember();
    openLink(userId);
    const res = await completePasswordResetAction(PASSWORDS);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: PASSKEY_OR_CODE_ASK,
        details: { reason: 'aal2_required', method: 'both' },
      },
    });
  });

  it('a typed code is checked against the app, never the bridge, whatever the order', async () => {
    const { userId, app } = await bothMember();
    // The app first, then the bridge first (the order flips with use, B7).
    for (const order of ['app-first', 'bridge-first']) {
      const appRow = world.factors.find((f) => f.id === app.id)!;
      const rest = world.factors.filter((f) => f.id !== app.id);
      world.factors.splice(
        0,
        world.factors.length,
        ...(order === 'app-first' ? [appRow, ...rest] : [...rest, appRow]),
      );
      expect(world.factors.findIndex((f) => f.id === app.id)).toBe(
        order === 'app-first' ? 0 : world.factors.length - 1,
      );
      openLink(userId);
      vi.mocked(checkMfaCode).mockReset();
      vi.mocked(checkMfaCode).mockResolvedValue({ kind: 'refused', outcome: 'refused' } as never);
      await completePasswordResetAction({ ...PASSWORDS, totpCode: '123456' });
      expect(vi.mocked(checkMfaCode).mock.calls.map((c) => c[1].factorId)).toEqual([app.id]);
    }
  });

  it('the passkey works for a member with both', async () => {
    const { userId, soft } = await bothMember();
    openLink(userId);
    const res = await resetWithPasskey(soft);
    expect(res).toEqual({ ok: true, data: { next: '/signin?reset=success' } });
    expect(world.calls.passwordSets).toEqual([userId]);
    expect(checkMfaCode).not.toHaveBeenCalled();
  });
});

describe('a holder of the emailed link alone', () => {
  it('can start the ceremony (one challenge for this session and purpose) but gets nowhere without the passkey', async () => {
    const { userId } = await passkeyOnlyMember();
    const link = openLink(userId);
    const start = await startPasswordResetPasskeyAction();
    expect(start.ok).toBe(true);
    // One challenge, of the reset, bound to this link session; nothing else written.
    expect(world.challenges.filter((c) => c.used_at === null)).toEqual([
      expect.objectContaining({ user_id: userId, session_id: link.id, purpose: 'password_reset' }),
    ]);
    expect(fnNames()).toEqual(['passkey_add_allowed', 'issue_passkey_challenge']);
    expect(world.calls.deleteFactor).toEqual([]);
    // A made-up answer is refused; no password set; the session stays aal1.
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId: optionsOf(start).challengeId, response: { id: 'x' } },
    });
    expect(res.ok).toBe(false);
    expect(world.calls.passwordSets).toEqual([]);
    expect(claimsNow()).toMatchObject({ session_id: link.id, aal: 'aal1' });
  });

  it('another account’s passkey is not this account’s: refused, no password set', async () => {
    const { userId } = await passkeyOnlyMember('one@example.test');
    const other = await passkeyOnlyMember('two@example.test');
    openLink(userId);
    const res = await resetWithPasskey(other.soft);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'This passkey is not one of yours. Try another one.',
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    expect(world.calls.passwordSets).toEqual([]);
  });

  it('the start and the answer count against the passkey limits of the code page: once spent, no challenge, no password', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    const response = soft.get(options);
    const keys: string[] = [];
    vi.mocked(checkRateLimit).mockImplementation(async (key: string) => {
      keys.push(key);
      return { allowed: !key.startsWith('passkey-') } as Awaited<ReturnType<typeof checkRateLimit>>;
    });
    world.calls.fns.length = 0;
    const start = await startPasswordResetPasskeyAction();
    expect(start).toEqual({
      ok: false,
      error: { code: 'rate_limited', message: pk.PASSKEY_WORDS.tooMany },
    });
    expect(keys.some((k) => k.startsWith(`passkey-start:${userId}:`))).toBe(true);
    expect(fnNames()).not.toContain('issue_passkey_challenge');
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response },
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'rate_limited',
        message: pk.PASSKEY_WORDS.tooMany,
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    expect(keys.some((k) => k.startsWith(`passkey-finish:${userId}:`))).toBe(true);
    expect(fnNames()).not.toContain('take_passkey_challenge');
    expect(world.calls.passwordSets).toEqual([]);
  });

  it('an answer that did not check it was the person (no user verification) is refused', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    openLink(userId);
    const res = await resetWithPasskey(soft, { uv: false });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.error.message).toBe(
        'Your device did not check it was you. Try again and use your face, fingerprint or device PIN.',
      );
    expect(world.calls.passwordSets).toEqual([]);
    expect(verifyCalls()).toEqual([]);
  });
});

describe('the ceremony is bound to the reset (rule 20: the purpose is the action’s own)', () => {
  it('a sign-in session (the password, no link) cannot start it, and cannot use it', async () => {
    const { userId } = await passkeyOnlyMember();
    world.signIn(userId, 'aal1');
    world.calls.fns.length = 0;
    const start = await startPasswordResetPasskeyAction();
    expect(start).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message:
          'This works only within an hour of opening the link in your email. Choose Forgot? on the sign-in page to get a new link.',
      },
    });
    expect(fnNames()).toEqual([]);
    const res = await completePasswordResetAction(PASSWORDS);
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: RESET_NEEDS_LINK } });
  });

  it('a link opened more than an hour ago cannot start it', async () => {
    const { userId } = await passkeyOnlyMember();
    openLink(userId, 61 * 60);
    const start = await startPasswordResetPasskeyAction();
    expect(start.ok).toBe(false);
    expect(fnNames()).toEqual([]);
  });

  it('a second-step challenge (the code page’s) is refused by the reset', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    const link = openLink(userId);
    const s = await pk.startSecondStep();
    if (!s.ok || s.start.kind !== 'options') throw new Error('no second-step options');
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: {
        challengeId: s.start.challengeId,
        response: soft.get(s.start.optionsJSON as never),
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe('That request expired. Try again.');
    expect(world.calls.passwordSets).toEqual([]);
    expect(claimsNow()).toMatchObject({ session_id: link.id, aal: 'aal1' });
  });

  it('the reset’s challenge is refused by the code page’s finish', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    const link = openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    const res = await finishSecondStepAction({ challengeId, response: soft.get(options) });
    expect(res).toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'That request expired. Try again.' },
    });
    expect(claimsNow()).toMatchObject({ session_id: link.id, aal: 'aal1' });
  });

  it('a challenge of another link session is refused (bound to this session)', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    const response = soft.get(options);
    openLink(userId);
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response },
    });
    expect(res.ok).toBe(false);
    expect(world.calls.passwordSets).toEqual([]);
  });

  it('an answer from another browser (no binding cookie) is refused', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    world.cookies.clear();
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response: soft.get(options) },
    });
    expect(res.ok).toBe(false);
    expect(world.calls.passwordSets).toEqual([]);
  });

  it('the reset’s answer is read only inside completePasswordResetAction', () => {
    const SRC = path.resolve(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'node_modules') walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    const users = files
      .filter((f) => /\banswerResetPasskey\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
      .sort();
    expect(users).toEqual(['server/actions/auth.ts', 'server/security/passkeys.ts']);
    // The start action takes nothing that could name a purpose.
    expect(startPasswordResetPasskeyAction.length).toBe(0);
  });
});

describe('the reset never finishes a removal and never repairs a bridge', () => {
  it('S13 (a removal the member started, its factor left): stage 2’s answer, and the start deletes nothing', async () => {
    const { userId } = await passkeyOnlyMember();
    // The member removed the passkey; its bridge factor was left (S13).
    world.passkeys[0]!.removed_at = new Date(Date.now() + 1000).toISOString();
    world.passkeys[0]!.removed_reason = 'member';
    world.bridges.delete(userId);
    openLink(userId);
    const res = await completePasswordResetAction(PASSWORDS);
    // Stage 2 treats a reserved-name factor that no record names like an app
    // (by id only, review finding 5), so it asks for a code; the passkey is
    // not offered (the reset never finishes a removal: the code page does).
    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: RESET_CODE_ASK, details: { reason: 'aal2_required' } },
    });
    const start = await startPasswordResetPasskeyAction();
    expect(start).toEqual({
      ok: false,
      error: { code: 'validation_error', message: 'This account has no passkey.' },
    });
    expect(world.calls.deleteFactor).toEqual([]);
    expect(fnNames()).not.toContain('passkey_drop_bridge');
  });

  it('S9 (the bridge secret does not open): stage 2’s words, reported, no repair', async () => {
    const { userId } = await passkeyOnlyMember();
    world.bridges.get(userId)!.secret_ciphertext = 'AAAA';
    openLink(userId);
    const res = await completePasswordResetAction(PASSWORDS);
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: RESET_BRIDGE_ONLY } });
    expect(vi.mocked(reportError).mock.calls.map((c) => c[1]?.tag)).toContain(
      'passkeys.bridge_unopenable',
    );
    expect(fnNames()).not.toContain('passkey_replace_bridge');
  });
});

describe('dark: with passkeys not usable (decision A), the reset is stage 2’s, exactly', () => {
  const CLOSED: Array<[string, () => void]> = [
    ['the kill switch off', () => void (world.addAllowed = 'kill_switch_off')],
    ['no bridge key', () => void (world.env.PASSKEY_BRIDGE_KEY_V1 = '')],
    [
      'no site (a preview)',
      () => void ((process.env.VERCEL = '1'), (process.env.VERCEL_ENV = 'preview')),
    ],
    ['the switches unreadable', () => void world.knobs.failFns.push('passkey_add_allowed')],
  ];

  describe.each(CLOSED)('%s', (_name, close) => {
    it('a bridge-only account gets the plain words, with or without a passkey answer; the answer is never read', async () => {
      const { userId, soft } = await passkeyOnlyMember();
      openLink(userId);
      // A ceremony started while passkeys were usable, answered after they closed.
      const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
      const response = soft.get(options);
      close();
      world.calls.fns.length = 0;
      world.calls.auth.length = 0;
      for (const input of [PASSWORDS, { ...PASSWORDS, passkeyAnswer: { challengeId, response } }]) {
        const res = await completePasswordResetAction(input);
        expect(res).toEqual({
          ok: false,
          error: { code: 'forbidden', message: RESET_BRIDGE_ONLY },
        });
      }
      expect(fnNames()).not.toContain('take_passkey_challenge');
      expect(verifyCalls()).toEqual([]);
      expect(world.calls.passwordSets).toEqual([]);
    });

    it('a member with an app gets the code box of stage 2, never the passkey; an answer sent anyway is never read', async () => {
      const { userId, soft } = await passkeyOnlyMember();
      world.addApp(userId);
      openLink(userId);
      const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
      const response = soft.get(options);
      close();
      world.calls.fns.length = 0;
      world.calls.auth.length = 0;
      for (const input of [PASSWORDS, { ...PASSWORDS, passkeyAnswer: { challengeId, response } }]) {
        const res = await completePasswordResetAction(input);
        expect(res).toEqual({
          ok: false,
          error: {
            code: 'forbidden',
            message: RESET_CODE_ASK,
            details: { reason: 'aal2_required' },
          },
        });
      }
      expect(fnNames()).not.toContain('take_passkey_challenge');
      expect(verifyCalls()).toEqual([]);
      expect(world.calls.passwordSets).toEqual([]);
    });
  });

  it('an organization that turned passkeys off later does not take an existing holder’s reset away (USE level)', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    openLink(userId);
    world.addAllowed = 'organization_off';
    const res = await resetWithPasskey(soft);
    expect(res).toEqual({ ok: true, data: { next: '/signin?reset=success' } });
  });

  it('an account with no reserved-name factor causes no passkey read at all', async () => {
    const userId = world.addAccount('plain@example.test');
    world.addApp(userId);
    openLink(userId);
    const res = await completePasswordResetAction(PASSWORDS);
    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: RESET_CODE_ASK, details: { reason: 'aal2_required' } },
    });
    expect(fnNames()).toEqual([]);
    expect(world.calls.reads).toEqual([]);
  });
});

describe('the reset’s own words: none sends the person to a sign-in or a code page they do not have', () => {
  const CANT_USE =
    "Your passkey can't be used to reset your password right now. Ask your organization's owner or StockPilot support for help.";
  const CANT_USE_APP =
    "Your passkey can't be used right now. Enter the 6-digit code from your authenticator app.";

  it('the link’s words are the reset action’s own', () => {
    expect(pk.PASSKEY_WORDS.resetLinkGone).toBe(RESET_LINK_GONE);
  });

  it('a start with no session left: the link’s words, not “sign in again”', async () => {
    const { userId } = await passkeyOnlyMember();
    openLink(userId);
    world.cookieToken = null;
    const start = await startPasswordResetPasskeyAction();
    expect(start).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: RESET_LINK_GONE },
    });
  });

  it('a start after the kill switch went off: no recovery code is offered', async () => {
    const { userId } = await passkeyOnlyMember();
    openLink(userId);
    world.addAllowed = 'kill_switch_off';
    const start = await startPasswordResetPasskeyAction();
    expect(start).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message:
          "Passkeys are turned off right now. Try again later, or ask your organization's owner or StockPilot support for help.",
      },
    });
  });

  /**
   * The account's passkey stops serving during the press, after the reset
   * offered it and once the answer's challenge is spent: `change` runs right
   * after take_passkey_challenge.
   */
  async function answerWhileTheAccountChanges(change: (userId: string) => void, withApp = false) {
    const { userId, soft } = await passkeyOnlyMember();
    if (withApp) world.addApp(userId);
    const link = openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    const response = soft.get(options);
    const rpc = world.admin.rpc;
    const spy = vi.spyOn(world.admin, 'rpc').mockImplementation(async (name, args) => {
      const out = await rpc(name, args);
      if (name === 'take_passkey_challenge') change(userId);
      return out;
    });
    vi.mocked(reportError).mockClear();
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response },
    });
    spy.mockRestore();
    expect(world.calls.passwordSets).toEqual([]);
    expect(verifyCalls()).toEqual([]);
    expect(fnNames()).not.toContain('passkey_replace_bridge');
    expect(claimsNow()).toMatchObject({ session_id: link.id, aal: 'aal1' });
    return res;
  }

  it('the bridge factor is gone at Auth: the reset’s words, reported for the reset, no repair', async () => {
    const res = await answerWhileTheAccountChanges((userId) => {
      const bridgeId = world.bridges.get(userId)!.factor_id;
      world.factors = world.factors.filter((f) => f.id !== bridgeId);
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: CANT_USE,
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    expect(
      vi.mocked(reportError).mock.calls.map((c) => [c[1]?.tag, c[1]?.extra?.site]),
    ).toContainEqual(['passkeys.bridge_factor_missing', 'password_reset']);
  });

  it('the bridge secret does not open: the reset’s words, reported for the reset', async () => {
    const res = await answerWhileTheAccountChanges((userId) => {
      world.bridges.get(userId)!.secret_ciphertext = 'AAAA';
    });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: CANT_USE,
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    expect(
      vi.mocked(reportError).mock.calls.map((c) => [c[1]?.tag, c[1]?.extra?.site]),
    ).toContainEqual(['passkeys.bridge_unopenable', 'password_reset']);
  });

  it('with an authenticator app too, the words point to its code', async () => {
    const res = await answerWhileTheAccountChanges((userId) => {
      world.bridges.get(userId)!.secret_ciphertext = 'AAAA';
    }, true);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: CANT_USE_APP,
        details: { reason: 'aal2_required', method: 'both' },
      },
    });
  });
});

describe('after the raise', () => {
  it('a bridge answer Auth refuses: no password set, the session stays aal1', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    const link = openLink(userId);
    world.knobs.verifyError = 'over_request_rate_limit';
    const res = await resetWithPasskey(soft);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Busy right now. Wait a minute and try again.',
        details: { reason: 'aal2_required', method: 'passkey' },
      },
    });
    expect(world.calls.passwordSets).toEqual([]);
    expect(claimsNow()).toMatchObject({ session_id: link.id, aal: 'aal1' });
  });

  describe('the session changes between the reset’s own check and the answer’s read', () => {
    /**
     * The answer reads the session once more (with the reset's own client).
     * The read it makes is the one right after those of a press with no
     * answer, counted first; at that read the cookie holds `next`.
     */
    async function pressWhileTheSessionBecomes(next: (userId: string) => string | null) {
      const { userId, soft } = await passkeyOnlyMember();
      openLink(userId);
      const linkToken = world.cookieToken;
      const nextToken = next(userId);
      world.cookieToken = linkToken;
      const getSession = world.cookieClient.auth.getSession;
      let reads = 0;
      const spy = vi.spyOn(world.cookieClient.auth, 'getSession').mockImplementation(async () => {
        reads += 1;
        return getSession();
      });
      await completePasswordResetAction(PASSWORDS);
      const readsBeforeTheAnswer = reads;
      const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
      const response = soft.get(options);
      reads = 0;
      spy.mockImplementation(async () => {
        reads += 1;
        if (reads === readsBeforeTheAnswer + 1) world.cookieToken = nextToken;
        return getSession();
      });
      world.calls.fns.length = 0;
      world.calls.cookieSignOut.length = 0;
      const res = await completePasswordResetAction({
        ...PASSWORDS,
        passkeyAnswer: { challengeId, response },
      });
      spy.mockRestore();
      // Exactly one read more than a press with no answer: the answer's own.
      expect(reads).toBe(readsBeforeTheAnswer + 1);
      expect(fnNames()).not.toContain('take_passkey_challenge');
      expect(verifyCalls()).toEqual([]);
      expect(world.calls.passwordSets).toEqual([]);
      return res;
    }

    it('another account’s session: signed out here, the link’s words, the answer never read', async () => {
      const res = await pressWhileTheSessionBecomes(() => {
        const other = world.addAccount('other@example.test');
        return world.signToken(world.openResetLink(other));
      });
      expect(res).toEqual({
        ok: false,
        error: { code: 'unauthenticated', message: RESET_LINK_GONE },
      });
      expect(world.calls.cookieSignOut).toEqual(['local']);
    });

    it('the session ended: the link’s words', async () => {
      const res = await pressWhileTheSessionBecomes(() => null);
      expect(res).toEqual({
        ok: false,
        error: { code: 'unauthenticated', message: RESET_LINK_GONE },
      });
      expect(world.calls.cookieSignOut).toEqual([]);
    });

    it('the same account, but a session no emailed link opened: the reset’s own words', async () => {
      let signInToken: string | null = null;
      const res = await pressWhileTheSessionBecomes((userId) => {
        signInToken = world.signToken(world.signIn(userId, 'aal1'));
        return signInToken;
      });
      expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: RESET_NEEDS_LINK } });
      expect(world.calls.cookieSignOut).toEqual([]);
      expect(world.cookieToken).toBe(signInToken);
    });
  });

  it('the press is for the account the link session holds: another account’s session never reads this account’s answer', async () => {
    const { userId, soft } = await passkeyOnlyMember();
    openLink(userId);
    const { challengeId, options } = optionsOf(await startPasswordResetPasskeyAction());
    const response = soft.get(options);
    // The press is for this account; the cookie now holds another account's link session.
    const other = world.addAccount('other@example.test');
    world.addApp(other);
    world.openResetLink(other);
    const res = await completePasswordResetAction({
      ...PASSWORDS,
      passkeyAnswer: { challengeId, response },
    });
    // The other account's reset asks for its own app's code; this account's answer is not read.
    expect(res.ok).toBe(false);
    expect(fnNames()).not.toContain('take_passkey_challenge');
    expect(world.calls.passwordSets).toEqual([]);
  });
});
