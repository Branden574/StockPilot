import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SoftAuthenticator } from '@/test/fixtures/soft-authenticator';
import { CONSOLE_EMAIL, ORIGIN, world } from '@/test/passkey-world';

/**
 * The passkey server module against the REAL @simplewebauthn/server (never
 * mocked), fed by a software authenticator (test/fixtures). Supabase Auth and
 * the database are fakes at the client boundary (test/passkey-world.ts), so
 * what Auth itself does (the same session raised to aal2, other sessions
 * ending, enrol rules) is assumed here from the proofs and is the lab's to
 * prove. Each `rule N` block pins one numbered rule of plan 2.1.
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
vi.mock('@/lib/auth/account-status', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return { loadAccountStatus: vi.fn(async () => w.accountStatus) };
});
vi.mock('@/lib/rate-limit', async () => {
  const { world: w } = await import('@/test/passkey-world');
  return { checkRateLimit: vi.fn(async () => ({ allowed: w.limiterAllows })) };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => true),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: null, role: null })),
}));
vi.mock('@/server/services/lib/defer', () => ({
  defer: (fn: () => Promise<unknown>) => void fn(),
  keepAlive: () => undefined,
}));
vi.mock('./events', () => ({ recordSecurityEvent: vi.fn(async () => undefined) }));
vi.mock('./passkey-emails', () => ({
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
vi.mock('@/lib/auth/mfa-code-attempts', () => ({ checkMfaCode: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/auth/platform-admin', async () => {
  const { world: w } = await import('@/test/passkey-world');
  // The allowlist as the world's settings hold it now (a test may change it).
  return {
    isPlatformAdmin: (e: string | null | undefined) =>
      typeof e === 'string' &&
      (w.env.STOCKPILOT_PLATFORM_ADMIN_EMAILS ?? '')
        .split(',')
        .map((x) => x.trim())
        .includes(e),
  };
});

const { checkMfaCode } = await import('@/lib/auth/mfa-code-attempts');
const { checkRateLimit } = await import('@/lib/rate-limit');
const { reportError } = await import('@/lib/error-reporter');
const { emitAuthAudit } = await import('@/server/services/auth-audit');
const { recordSecurityEvent } = await import('./events');
const { sendPasskeyAddedEmail, sendPasskeyRemovedEmail } = await import('./passkey-emails');
const pk = await import('./passkeys');
const { LAST_METHOD_RETRY_WORDS, LAST_METHOD_WORDS } = await import('./second-step-methods');

const SAMPLE_PASSWORD = 'sample-password-not-real';

type Start = Awaited<ReturnType<typeof pk.startSecondStep>>;

function optionsOf(start: Start) {
  if (!start.ok || start.start.kind !== 'options')
    throw new Error(`no options: ${JSON.stringify(start)}`);
  return {
    challengeId: start.start.challengeId,
    options: start.start.optionsJSON as { challenge: string; rpId?: string },
  };
}

/** A member with no method adds a first passkey with the password (2.6 C, D). */
async function addFirstPasskey(soft: SoftAuthenticator, name = 'Work laptop') {
  const start = await pk.startAddPasskey({
    proof: { kind: 'password', password: SAMPLE_PASSWORD },
  });
  if (!start.ok) throw new Error(`start add refused: ${start.reason}`);
  const created = soft.create(start.optionsJSON as never);
  return pk.finishAddPasskey({ challengeId: start.challengeId, response: created, name });
}

/** A member signed in with the password, then the passkey (2.6 A, B). */
async function passkeyStep(
  soft: SoftAuthenticator,
  knobs: Parameters<SoftAuthenticator['get']>[2] = {},
) {
  const { challengeId, options } = optionsOf(await pk.startSecondStep());
  return pk.completeSecondStep({ challengeId, response: soft.get(options, undefined, knobs) });
}

/** A member with one healthy passkey, signed in again at aal1 (the second step owed). */
async function memberWithPasskey(email = 'member@example.test') {
  const userId = world.addAccount(email);
  world.signIn(userId, 'aal1');
  const soft = new SoftAuthenticator();
  const added = await addFirstPasskey(soft);
  if (!added.ok) throw new Error(`add refused: ${added.reason}`);
  const session = world.signIn(userId, 'aal1');
  return { userId, soft, session, passkeyId: added.passkeyId };
}

beforeEach(() => {
  world.reset();
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  vi.stubGlobal('fetch', world.fetch);
  vi.clearAllMocks();
  // Every audit row is written unless a test says otherwise.
  vi.mocked(emitAuthAudit).mockImplementation(async () => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the whole path with the real library', () => {
  it('a first passkey: added with the password, its bridge enrolled, stored and answered; this session is aal2', async () => {
    const userId = world.addAccount('first@example.test');
    const session = world.signIn(userId, 'aal1');
    const soft = new SoftAuthenticator();
    const added = await addFirstPasskey(soft);
    expect(added).toMatchObject({ ok: true, firstPasskey: true });
    const bridge = world.bridges.get(userId)!;
    const factor = world.factors.find((f) => f.id === bridge.factor_id)!;
    expect(factor.status).toBe('verified');
    expect(factor.friendly_name).toMatch(/^sp-passkey-bridge-[0-9a-f]{12}$/);
    expect(world.claimsOf(world.cookieToken!)).toMatchObject({
      sub: userId,
      session_id: session.id,
      aal: 'aal2',
    });
    expect(world.passkeys[0]).toMatchObject({
      user_id: userId,
      rp_id: 'localhost',
      name: 'Work laptop',
      backup_eligible: true,
    });
    expect(emitAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'passkey.added',
        extra: expect.objectContaining({ session_id: session.id, fmt: 'none' }),
      }),
    );
    expect(sendPasskeyAddedEmail).toHaveBeenCalledWith('first@example.test');
  });

  it('the second step: password, then the passkey raises THIS session to aal2 and writes passkey.used with its id', async () => {
    const { soft, session, userId } = await memberWithPasskey();
    world.calls.setSession = 0;
    const done = await passkeyStep(soft);
    expect(done).toEqual({ ok: true });
    expect(world.claimsOf(world.cookieToken!)).toMatchObject({
      sub: userId,
      session_id: session.id,
      aal: 'aal2',
    });
    expect(world.calls.setSession).toBe(1);
    expect(emitAuthAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'passkey.used',
        extra: expect.objectContaining({ session_id: session.id, purpose: 'second_step' }),
      }),
    );
    expect(world.passkeys[0]!.counter).toBe(1);
    expect(world.passkeys[0]!.last_used_at).not.toBeNull();
  });
});

describe('the gates (decision A): ADD needs all four conditions; USE the site, the key and the kill switch; MANAGE a site', () => {
  const factorsOf = (userId: string) => world.factors.filter((f) => f.user_id === userId);

  // ADD: each of the four conditions alone closes it (and a word this build
  // does not know, and a member in no organization).
  const addClosers: Array<[string, () => void]> = [
    ['the kill switch off', () => (world.addAllowed = 'kill_switch_off')],
    ['new passkeys off', () => (world.addAllowed = 'adds_off')],
    ['no bridge key', () => (world.env.PASSKEY_BRIDGE_KEY_V1 = '')],
    ['an organization of the member off', () => (world.addAllowed = 'organization_off')],
    ['the member in no organization', () => (world.addAllowed = 'no_membership')],
    ['a word the server does not know', () => (world.addAllowed = 'a_new_word')],
  ];
  for (const [label, close] of addClosers) {
    it(`ADD, ${label}: no Add offered, and every add action refuses, nothing stored`, async () => {
      const { userId } = await memberWithPasskey();
      world.signIn(userId, 'aal2');
      const key = world.env.PASSKEY_BRIDGE_KEY_V1 ?? '';
      close();
      try {
        const panel = await pk.passkeysPanelFor(userId);
        expect(panel?.canAdd).toBe(false);
        const refusals = [
          await pk.startConfirmAdd(),
          await pk.startAddPasskey({ proof: { kind: 'password', password: SAMPLE_PASSWORD } }),
          await pk.finishAddPasskey({ challengeId: crypto.randomUUID(), response: {}, name: 'x' }),
        ];
        for (const r of refusals) expect(r).toMatchObject({ ok: false, code: 'forbidden' });
        expect(world.passkeys).toHaveLength(1);
      } finally {
        world.env.PASSKEY_BRIDGE_KEY_V1 = key;
      }
    });
  }

  // USE: an organization switched off, new passkeys off, or no organization
  // never take an existing holder's second step away (answers Q1).
  const useStaysOpen: Array<[string, string]> = [
    ['new passkeys off', 'adds_off'],
    ['an organization of the member off', 'organization_off'],
    ['the member in no organization', 'no_membership'],
  ];
  for (const [label, word] of useStaysOpen) {
    it(`USE, ${label}: the holder still passes the second step; the panel lists, renames and removes, with no Add`, async () => {
      const { soft, userId, passkeyId } = await memberWithPasskey();
      world.addAllowed = word;
      expect(await pk.passkeyStepFor(userId, factorsOf(userId))).toBe('ready');
      expect(await passkeyStep(soft)).toEqual({ ok: true });
      expect(world.claimsOf(world.cookieToken!)).toMatchObject({ aal: 'aal2' });
      expect(await pk.passkeysPanelFor(userId)).toMatchObject({
        listOnly: null,
        canAdd: false,
        passkeys: [expect.objectContaining({ id: passkeyId })],
      });
      expect(await pk.renamePasskey({ passkeyId, name: 'Desk key' })).toEqual({ ok: true });
      expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
      expect(world.passkeys[0]!.removed_at).not.toBeNull();
    });
  }

  // USE closes with the kill switch, the key, or a word this build does not
  // know: no passkey step is offered or accepted. MANAGE stays: the holder
  // signed in with their app lists, renames and removes their passkeys.
  const useClosers: Array<[string, () => void, 'turned_off' | 'unavailable']> = [
    ['the kill switch off', () => (world.addAllowed = 'kill_switch_off'), 'turned_off'],
    ['no bridge key', () => (world.env.PASSKEY_BRIDGE_KEY_V1 = ''), 'unavailable'],
    ['a word the server does not know', () => (world.addAllowed = 'a_new_word'), 'unavailable'],
  ];
  for (const [label, close, notice] of useClosers) {
    it(`USE, ${label}: no passkey step; MANAGE: the list with Remove and one sentence, rename and remove still work`, async () => {
      const { userId, passkeyId } = await memberWithPasskey();
      const key = world.env.PASSKEY_BRIDGE_KEY_V1 ?? '';
      close();
      try {
        expect(await pk.passkeyStepFor(userId, factorsOf(userId))).toBe('none');
        const refusals = [
          await pk.startSecondStep(),
          await pk.completeSecondStep({ challengeId: crypto.randomUUID(), response: {} }),
          await pk.startFinishSetup(),
          await pk.finishPasskeySetup({ challengeId: crypto.randomUUID(), response: {} }),
        ];
        for (const r of refusals) expect(r).toMatchObject({ ok: false, code: 'forbidden' });
        // Signed in with the authenticator app (aal2), the member manages theirs.
        world.signIn(userId, 'aal2');
        expect(await pk.passkeysPanelFor(userId)).toMatchObject({
          listOnly: notice,
          canAdd: false,
          canFinish: false,
          passkeys: [expect.objectContaining({ id: passkeyId })],
        });
        const bridge = world.bridges.get(userId)!;
        expect(await pk.renamePasskey({ passkeyId, name: 'Old key' })).toEqual({ ok: true });
        expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
        expect(world.passkeys[0]!.removed_at).not.toBeNull();
        expect(world.bridges.has(userId)).toBe(false);
        expect(world.calls.deleteFactor).toContain(bridge.factor_id);
        // With nothing left to list, the panel is absent again.
        expect(await pk.passkeysPanelFor(userId)).toBeNull();
      } finally {
        world.env.PASSKEY_BRIDGE_KEY_V1 = key;
      }
    });
  }

  it('MANAGE still needs aal2, and a site: without one, rename and remove refuse', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.addAllowed = 'kill_switch_off';
    expect(await pk.removePasskey({ passkeyId })).toMatchObject({ ok: false, reason: 'aal2_required' });
    world.signIn(userId, 'aal2');
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    expect(await pk.removePasskey({ passkeyId })).toMatchObject({ ok: false, reason: 'gate_no_site' });
    expect(await pk.renamePasskey({ passkeyId, name: 'Other' })).toMatchObject({
      ok: false,
      reason: 'gate_no_site',
    });
    expect(world.passkeys[0]).toMatchObject({ removed_at: null, name: 'Work laptop' });
  });

  it('a disabled account or one without a profile sees no panel, even with passkeys', async () => {
    const { userId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    for (const word of ['disabled', 'no_profile']) {
      world.addAllowed = word;
      expect(await pk.passkeysPanelFor(userId)).toBeNull();
    }
  });

  it('with no site (a preview deployment) the database is not even asked', async () => {
    const userId = world.addAccount('preview@example.test');
    world.signIn(userId);
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    expect(await pk.passkeyGate(userId)).toEqual({ open: false, why: 'no_site' });
    expect(await pk.passkeyUseGate(userId)).toEqual({ open: false, why: 'no_site' });
    expect(await pk.passkeysPanelFor(userId)).toBeNull();
    expect(world.calls.fns).toEqual([]);
  });

  it('with no key the database is not asked either', async () => {
    const userId = world.addAccount('nokey@example.test');
    world.env.PASSKEY_BRIDGE_KEY_V1 = '';
    expect(await pk.passkeyGate(userId)).toEqual({ open: false, why: 'no_key' });
    expect(await pk.passkeyUseGate(userId)).toEqual({ open: false, why: 'no_key' });
    expect(world.calls.fns).toEqual([]);
  });

  it('the two levels read one word: USE open and ADD closed for an organization off', async () => {
    const userId = world.addAccount('levels@example.test');
    world.addAllowed = 'organization_off';
    expect(await pk.passkeyGate(userId)).toEqual({ open: false, why: 'organization_off' });
    expect(await pk.passkeyUseGate(userId)).toMatchObject({
      open: true,
      addOpen: false,
      addWhy: 'organization_off',
    });
    world.addAllowed = 'too_many';
    expect(await pk.passkeyGate(userId)).toMatchObject({ open: true, atLimit: true, addOpen: true });
  });

  it('the panel is absent for a member who cannot add and has no passkey, and present when every condition holds', async () => {
    const userId = world.addAccount('panel@example.test');
    world.signIn(userId, 'aal1');
    expect(await pk.passkeysPanelFor(userId)).toMatchObject({
      passkeys: [],
      proof: 'password',
      atLimit: false,
      listOnly: null,
      canAdd: true,
    });
    for (const word of ['organization_off', 'adds_off', 'no_membership', 'kill_switch_off']) {
      world.addAllowed = word;
      expect(await pk.passkeysPanelFor(userId)).toBeNull();
    }
  });
});

describe('decision A: Finish setup is a repair for an existing holder (USE) and an add for a passkey that never served (ADD)', () => {
  /** S2: the bridge row and its factor gone; the passkey row stays. */
  function breakBridge(userId: string) {
    const old = world.bridges.get(userId)!;
    world.bridges.delete(userId);
    world.factors = world.factors.filter((f) => f.id !== old.factor_id);
  }

  it('a passkey that never served: with an organization off, no Finish and the start refuses; with it on, Finish works', async () => {
    const { soft, userId } = await memberWithPasskey();
    breakBridge(userId);
    world.signIn(userId, 'aal2');
    world.addAllowed = 'organization_off';
    expect(await pk.passkeysPanelFor(userId)).toMatchObject({
      canFinish: false,
      passkeys: [expect.objectContaining({ unfinished: true })],
    });
    expect(await pk.startFinishSetup()).toMatchObject({
      ok: false,
      code: 'forbidden',
      reason: 'gate_organization_off',
    });
    world.addAllowed = 'ok';
    expect(await pk.passkeysPanelFor(userId)).toMatchObject({ canFinish: true });
    const { challengeId, options } = optionsOf(await pk.startFinishSetup());
    expect(await pk.finishPasskeySetup({ challengeId, response: soft.get(options) })).toEqual({
      ok: true,
    });
  });

  it('the finish reads the row it uses as it was BEFORE its own use: a never-served passkey stays an add', async () => {
    const { soft, userId } = await memberWithPasskey();
    breakBridge(userId);
    world.signIn(userId, 'aal2');
    const { challengeId, options } = optionsOf(await pk.startFinishSetup());
    world.addAllowed = 'organization_off';
    expect(await pk.finishPasskeySetup({ challengeId, response: soft.get(options) })).toMatchObject({
      ok: false,
      reason: 'gate_organization_off',
    });
    expect(world.bridges.has(userId)).toBe(false);
  });

  it('an existing holder (the passkey served before): Finish repairs with an organization off, or new passkeys off', async () => {
    const { soft, userId } = await memberWithPasskey();
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    breakBridge(userId);
    for (const word of ['organization_off', 'adds_off']) {
      world.addAllowed = word;
      expect(await pk.passkeysPanelFor(userId)).toMatchObject({ canFinish: true, canAdd: false });
    }
    const { challengeId, options } = optionsOf(await pk.startFinishSetup());
    expect(await pk.finishPasskeySetup({ challengeId, response: soft.get(options) })).toEqual({
      ok: true,
    });
    expect(world.bridges.has(userId)).toBe(true);
  });

  it('S9 (the secret cannot be opened) is a repair: Finish starts with an organization off', async () => {
    const { userId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    world.env.PASSKEY_BRIDGE_KEY_V1 = Buffer.alloc(32, 7).toString('base64');
    world.addAllowed = 'organization_off';
    expect(await pk.startFinishSetup()).toMatchObject({ ok: true, start: { kind: 'options' } });
  });
});

describe('rule 1: no module-level client, token or session', () => {
  for (const file of ['passkeys.ts', 'passkey-auth.ts', 'passkey-emails.ts']) {
    it(file, () => {
      const src = readFileSync(path.join(__dirname, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // Top-level statements only: lines that start at column 0.
      const topLevel = src.split('\n').filter((l) => /^(const|let|var) /.test(l));
      for (const line of topLevel) {
        expect(line, line).not.toMatch(
          /createAdminClient\(|createClient\(|createAccessTokenClient\(|readVerifiedSession|getSession|access_token|token\s*=/,
        );
      }
      expect(src).not.toMatch(/^let /m);
    });
  }
  it('the admin client is made inside each call (createAdminClient only inside functions)', () => {
    const src = readFileSync(path.join(__dirname, 'passkeys.ts'), 'utf8');
    for (const m of src.matchAll(/createAdminClient\(\)/g)) {
      const before = src.slice(0, m.index);
      const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
      expect(depth).toBeGreaterThan(0);
    }
  });
});

describe('rules 2 and 3: one verified token per action, the account is its subject', () => {
  it('a cookie that changes account between start and finish is refused (the challenge is the first account and session)', async () => {
    const a = await memberWithPasskey('a@example.test');
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    const answer = a.soft.get(options);
    const bind = new Map(world.cookies);
    const b = world.addAccount('b@example.test');
    world.signIn(b, 'aal1');
    for (const [k, v] of bind) world.cookies.set(k, v);
    const r = await pk.completeSecondStep({ challengeId, response: answer });
    expect(r).toMatchObject({ ok: false, message: pk.PASSKEY_WORDS.expired });
  });

  it('Auth answering for another account than the token is refused', async () => {
    const { userId } = await memberWithPasskey();
    world.knobs.authUserOtherAccount = true;
    expect(await pk.startSecondStep()).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(userId).toBeTruthy();
  });

  it('every Auth call is a plain fetch with the session token (never the cookie client)', async () => {
    const { session, soft } = await memberWithPasskey();
    world.calls.auth.length = 0;
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    expect(world.calls.auth.length).toBeGreaterThan(0);
    for (const c of world.calls.auth)
      expect(world.claimsOf(c.token)).toMatchObject({ session_id: session.id });
  });
});

describe('rule 4: the challenge is bound and spent first', () => {
  it('the same answer twice: the second is refused, the challenge was spent', async () => {
    const { soft } = await memberWithPasskey();
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    const answer = soft.get(options);
    const bind = new Map(world.cookies);
    expect(await pk.completeSecondStep({ challengeId, response: answer })).toEqual({ ok: true });
    for (const [k, v] of bind) world.cookies.set(k, v);
    expect(await pk.completeSecondStep({ challengeId, response: answer })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.expired,
    });
  });

  it('a refused answer gets no second try on the same challenge', async () => {
    const { soft } = await memberWithPasskey();
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    const bind = new Map(world.cookies);
    expect(
      await pk.completeSecondStep({
        challengeId,
        response: soft.get(options, undefined, { uv: false }),
      }),
    ).toMatchObject({ ok: false });
    for (const [k, v] of bind) world.cookies.set(k, v);
    expect(await pk.completeSecondStep({ challengeId, response: soft.get(options) })).toMatchObject(
      {
        ok: false,
        message: pk.PASSKEY_WORDS.expired,
      },
    );
  });

  it('rule 12: without the browser binding cookie, or with another value, the answer is refused', async () => {
    const { soft } = await memberWithPasskey();
    const first = optionsOf(await pk.startSecondStep());
    world.cookies.clear();
    expect(
      await pk.completeSecondStep({
        challengeId: first.challengeId,
        response: soft.get(first.options),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'no_binding',
    });
    const second = optionsOf(await pk.startSecondStep());
    world.cookies.set('sp_pk_bind', 'A'.repeat(43));
    expect(
      await pk.completeSecondStep({
        challengeId: second.challengeId,
        response: soft.get(second.options),
      }),
    ).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.expired,
    });
    expect(pk.bindCookieName({ rpId: 'stockpilotusa.com', origins: [] })).toBe('__Host-sp_pk_bind');
  });
});

describe('rule 5: the credential is ours and this account', () => {
  it("another account's passkey is not one of yours", async () => {
    const a = await memberWithPasskey('a5@example.test');
    const b = await memberWithPasskey('b5@example.test');
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    const r = await pk.completeSecondStep({ challengeId, response: a.soft.get(options) });
    expect(r).toMatchObject({ ok: false, message: pk.PASSKEY_WORDS.notYours });
    expect(b.userId).toBeTruthy();
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'passkey_refused' }),
      expect.anything(),
    );
  });

  it('a user handle of another account is refused', async () => {
    const { soft } = await memberWithPasskey();
    const r = await passkeyStep(soft, {
      userHandle: Buffer.from('someone-else').toString('base64url'),
    });
    expect(r).toMatchObject({ ok: false, reason: 'user_handle' });
  });

  it('a passkey removed after the prompt started is not one of yours', async () => {
    const { soft } = await memberWithPasskey();
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    world.passkeys[0]!.removed_at = new Date().toISOString();
    world.passkeys[0]!.removed_reason = 'member';
    expect(await pk.completeSecondStep({ challengeId, response: soft.get(options) })).toMatchObject(
      {
        ok: false,
        message: pk.PASSKEY_WORDS.notYours,
      },
    );
  });
});

describe('rule 6: the library decides with our settings, and the checks it leaves to us', () => {
  it('user verification off is refused (sign-in)', async () => {
    const { soft } = await memberWithPasskey();
    expect(await passkeyStep(soft, { uv: false })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.noUserVerification,
    });
  });

  it('user verification off is refused (registration)', async () => {
    const userId = world.addAccount('nouv@example.test');
    world.signIn(userId);
    const r = await addFirstPasskey(new SoftAuthenticator({ uv: false }));
    expect(r).toMatchObject({ ok: false, message: pk.PASSKEY_WORDS.noUserVerification });
    expect(world.passkeys).toEqual([]);
  });

  it('an answer from another origin is refused as another site, recorded as phishing', async () => {
    const { soft } = await memberWithPasskey();
    expect(await passkeyStep(soft, { origin: 'http://localhost:4000' })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.wrongSite,
    });
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'phishing', reason: 'passkey_wrong_site' }),
      expect.anything(),
    );
  });

  it('an answer for another RP ID is refused as another site', async () => {
    const { soft } = await memberWithPasskey();
    expect(await passkeyStep(soft, { rpId: 'example.test' })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.wrongSite,
    });
  });

  it('crossOrigin true is refused at sign-in and at registration (review 9.2)', async () => {
    const { soft } = await memberWithPasskey();
    expect(await passkeyStep(soft, { crossOrigin: true })).toMatchObject({
      ok: false,
      reason: 'wrong_site',
    });
    const other = world.addAccount('xo@example.test');
    world.signIn(other);
    const start = await pk.startAddPasskey({
      proof: { kind: 'password', password: SAMPLE_PASSWORD },
    });
    if (!start.ok) throw new Error('start');
    const created = new SoftAuthenticator().create(start.optionsJSON as never, {
      crossOrigin: true,
    });
    expect(
      await pk.finishAddPasskey({
        challengeId: start.challengeId,
        response: created,
        name: 'Frame',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'wrong_site',
    });
  });

  it('a changed backup-eligible flag is refused (review 9.3)', async () => {
    const { soft } = await memberWithPasskey();
    expect(await passkeyStep(soft, { be: false })).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('a counter that went back is refused and flagged', async () => {
    const { soft } = await memberWithPasskey();
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    world.signIn(world.passkeys[0]!.user_id, 'aal1');
    expect(await passkeyStep(soft, { signCount: 0 })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.counterWentBack,
    });
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'flagged', reason: 'passkey_counter_went_back' }),
      expect.anything(),
    );
  });

  it('the options pin our algorithms and user verification', async () => {
    const userId = world.addAccount('alg@example.test');
    world.signIn(userId);
    const start = await pk.startAddPasskey({
      proof: { kind: 'password', password: SAMPLE_PASSWORD },
    });
    if (!start.ok) throw new Error('start');
    const o = start.optionsJSON as {
      pubKeyCredParams: Array<{ alg: number }>;
      authenticatorSelection: Record<string, string>;
      user: { id: string };
    };
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual(pk.PASSKEY_ALGORITHMS);
    expect(o.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(Buffer.from(o.user.id, 'base64url').toString('utf8')).toBe(userId);
  });
});

describe('rule 7: the bridge is found by id, from our table', () => {
  it('another reserved-name factor of the account is never the one answered', async () => {
    const { soft, userId } = await memberWithPasskey();
    const bridgeId = world.bridges.get(userId)!.factor_id;
    world.factors.unshift({
      id: crypto.randomUUID(),
      user_id: userId,
      friendly_name: 'sp-passkey-bridge-aaaaaaaaaaaa',
      factor_type: 'totp',
      status: 'unverified',
      created_at: new Date().toISOString(),
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    });
    world.calls.auth.length = 0;
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    const answered = world.calls.auth.filter((c) => c.path.endsWith('/verify')).map((c) => c.path);
    expect(answered).toEqual([`/factors/${bridgeId}/verify`]);
  });
});

describe('rules 8 and 9: the same session, at aal2, cookies written once and read back', () => {
  it('a raised token of ANOTHER session is signed out and refused; no cookie is written', async () => {
    const { soft } = await memberWithPasskey();
    world.knobs.verifyAnswersOtherSession = true;
    world.calls.setSession = 0;
    const r = await passkeyStep(soft);
    expect(r).toMatchObject({ ok: false, reason: 'raised_other_session' });
    expect(world.calls.setSession).toBe(0);
    expect(world.calls.auth.some((c) => c.path === '/logout?scope=local')).toBe(true);
  });

  it('a tampered raised token (its signature fails) is refused; no cookie is written', async () => {
    const { soft } = await memberWithPasskey();
    world.knobs.verifyAnswersTampered = true;
    world.calls.setSession = 0;
    expect(await passkeyStep(soft)).toMatchObject({ ok: false, reason: 'raised_other_session' });
    expect(world.calls.setSession).toBe(0);
  });
});

describe('rule 10: local checks before any Auth call', () => {
  for (const [label, knobs] of [
    ['user verification off', { uv: false }],
    ['another origin', { origin: 'http://localhost:4000' }],
    ['a changed backup flag', { be: false }],
  ] as const) {
    it(`${label}: no Auth call at all`, async () => {
      const { soft } = await memberWithPasskey();
      const { challengeId, options } = optionsOf(await pk.startSecondStep());
      world.calls.auth.length = 0;
      const r = await pk.completeSecondStep({
        challengeId,
        response: soft.get(options, undefined, knobs),
      });
      expect(r.ok).toBe(false);
      expect(world.calls.auth).toEqual([]);
    });
  }
});

describe('rule 11: the secret and the code never leave answerBridge', () => {
  it('no report, audit row, event or answer carries a bridge secret', async () => {
    const { soft, userId } = await memberWithPasskey();
    const answers = [await passkeyStep(soft)];
    world.signIn(userId, 'aal1');
    world.knobs.verifyError = 'mfa_verification_failed';
    answers.push(await passkeyStep(soft));
    const secrets = world.factors.filter((f) => world.reserved(f)).map((f) => f.secret);
    const seen = JSON.stringify([
      answers,
      vi.mocked(reportError).mock.calls,
      vi.mocked(emitAuthAudit).mock.calls,
      vi.mocked(recordSecurityEvent).mock.calls,
    ]);
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) expect(seen).not.toContain(s);
    expect(seen).not.toContain(world.env.PASSKEY_BRIDGE_KEY_V1);
  });

  it('Auth refusing our own code: one retry with the next step, then an error report with no secret', async () => {
    const { soft } = await memberWithPasskey();
    world.knobs.verifyError = 'mfa_verification_failed';
    world.calls.auth.length = 0;
    expect(await passkeyStep(soft)).toMatchObject({ ok: false, reason: 'bridge_refused' });
    expect(world.calls.auth.filter((c) => c.path.endsWith('/verify'))).toHaveLength(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'passkeys.bridge_refused', level: 'error' }),
    );
  });
});

describe('rules 13 to 18', () => {
  it('rule 13: the kill switch thrown between start and finish, in one module instance, refuses the finish', async () => {
    const { soft } = await memberWithPasskey();
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    world.addAllowed = 'kill_switch_off';
    expect(await pk.completeSecondStep({ challengeId, response: soft.get(options) })).toMatchObject(
      {
        ok: false,
        message: pk.PASSKEY_WORDS.off,
      },
    );
  });

  it('rule 14: a platform console account cannot add a passkey', async () => {
    const userId = world.addAccount(CONSOLE_EMAIL);
    world.signIn(userId);
    expect(
      await pk.startAddPasskey({ proof: { kind: 'password', password: SAMPLE_PASSWORD } }),
    ).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.console,
    });
    expect(await pk.passkeysPanelFor(userId)).toBeNull();
  });

  it('rule 14 at the finish: an account on the console list by then is refused, nothing stored', async () => {
    const userId = world.addAccount('later-console@example.test');
    world.signIn(userId);
    const start = await pk.startAddPasskey({
      proof: { kind: 'password', password: SAMPLE_PASSWORD },
    });
    if (!start.ok) throw new Error(`start add refused: ${start.reason}`);
    const created = new SoftAuthenticator().create(start.optionsJSON as never);
    const list = world.env.STOCKPILOT_PLATFORM_ADMIN_EMAILS;
    world.env.STOCKPILOT_PLATFORM_ADMIN_EMAILS = `${list},later-console@example.test`;
    try {
      expect(
        await pk.finishAddPasskey({
          challengeId: start.challengeId,
          response: created,
          name: 'Desk',
        }),
      ).toMatchObject({ ok: false, message: pk.PASSKEY_WORDS.console });
    } finally {
      world.env.STOCKPILOT_PLATFORM_ADMIN_EMAILS = list ?? '';
    }
    expect(world.passkeys).toEqual([]);
    expect(world.bridges.has(userId)).toBe(false);
  });

  it('rule 15: a disabled account is refused before any limiter counts', async () => {
    const { userId } = await memberWithPasskey();
    world.accountStatus = 'disabled';
    vi.mocked(checkRateLimit).mockClear();
    expect(await pk.startSecondStep()).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.disabled,
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(userId).toBeTruthy();
  });

  it('rule 16: every Auth call is no-store with a time limit', async () => {
    const { soft } = await memberWithPasskey();
    await passkeyStep(soft);
    expect(world.calls.auth.length).toBeGreaterThan(0);
    for (const c of world.calls.auth) expect([c.cache, c.signal]).toEqual(['no-store', true]);
  });

  it('rule 17: a session without an id is refused at every start', async () => {
    const userId = world.addAccount('nosid@example.test');
    const s = world.signIn(userId);
    world.cookieToken = world.signToken({ ...s, id: '' });
    expect(await pk.startSecondStep()).toMatchObject({ ok: false, reason: 'no_session_id' });
    expect(
      await pk.startAddPasskey({ proof: { kind: 'password', password: SAMPLE_PASSWORD } }),
    ).toMatchObject({
      ok: false,
      reason: 'no_session_id',
    });
  });

  it('rule 18: a challenge whose site is not ours is refused', async () => {
    const { soft } = await memberWithPasskey();
    world.knobs.takeRpId = 'stockpilotusa.com';
    expect(await passkeyStep(soft)).toMatchObject({ ok: false, reason: 'challenge_other_site' });
  });

  it('the limiter: a refusal pauses the checks and is recorded', async () => {
    await memberWithPasskey();
    world.limiterAllows = false;
    expect(await pk.startSecondStep()).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'passkey_checks_paused' }),
      expect.anything(),
    );
    const keys = vi.mocked(checkRateLimit).mock.calls.map((c) => String(c[0]));
    expect(keys.some((k) => k.startsWith('passkey-start:'))).toBe(true);
  });
});

describe('rule 19 and the proof to add', () => {
  it('an account with a verified factor adds only from an aal2 session', async () => {
    const userId = world.addAccount('app@example.test');
    const app = world.addApp(userId);
    world.signIn(userId, 'aal1');
    expect(
      await pk.startAddPasskey({ proof: { kind: 'code', factorId: app.id, code: '123456' } }),
    ).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.stepUpFirst,
    });
    expect(checkMfaCode).not.toHaveBeenCalled();
  });

  it('an app holder proves with the app code (path add_passkey), never with the bridge id', async () => {
    const userId = world.addAccount('app2@example.test');
    const app = world.addApp(userId);
    world.signIn(userId, 'aal2');
    vi.mocked(checkMfaCode).mockResolvedValue({ kind: 'verified' } as never);
    const ok = await pk.startAddPasskey({
      proof: { kind: 'code', factorId: app.id, code: '123456' },
    });
    expect(ok.ok).toBe(true);
    expect(checkMfaCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ factorId: app.id, path: 'add_passkey' }),
    );
    // A password proof from an account that has an app is not enough.
    expect(
      await pk.startAddPasskey({ proof: { kind: 'password', password: SAMPLE_PASSWORD } }),
    ).toMatchObject({ ok: false, reason: 'proof' });
  });

  it('2.6 C.3a: no app and the phone app used in 30 days: I understand must be typed', async () => {
    const userId = world.addAccount('phone@example.test');
    world.signIn(userId);
    world.auditLogs.push({
      id: crypto.randomUUID(),
      user_id: userId,
      event: 'user.signed_in',
      metadata: { client: 'mobile', app_version: '1.4.0' },
      created_at: new Date().toISOString(),
    });
    const proof = { kind: 'password', password: SAMPLE_PASSWORD };
    expect(await pk.startAddPasskey({ proof })).toMatchObject({
      ok: false,
      reason: 'phone_confirmation',
    });
    expect(await pk.startAddPasskey({ proof, phoneConfirmation: 'yes' })).toMatchObject({
      ok: false,
      reason: 'phone_confirmation',
    });
    expect((await pk.startAddPasskey({ proof, phoneConfirmation: '  I Understand ' })).ok).toBe(
      true,
    );
    expect(await pk.passkeysPanelFor(userId)).toMatchObject({ phoneConfirmation: true });
  });
});

describe('rule 20: each action spends only its own purpose', () => {
  it('second_step refuses a challenge of every other purpose', async () => {
    const { soft } = await memberWithPasskey();
    for (const start of [pk.startConfirmAdd]) {
      const { challengeId, options } = optionsOf(await start());
      expect(
        await pk.completeSecondStep({ challengeId, response: soft.get(options) }),
      ).toMatchObject({
        ok: false,
        message: pk.PASSKEY_WORDS.expired,
      });
    }
  });

  it('confirm_add (inside startAddPasskey) refuses a second_step challenge', async () => {
    const { soft, userId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    const r = await pk.startAddPasskey({
      proof: { kind: 'passkey', challengeId, response: soft.get(options) },
    });
    expect(r).toMatchObject({ ok: false, message: pk.PASSKEY_WORDS.expired });
    const confirm = optionsOf(await pk.startConfirmAdd());
    const ok = await pk.startAddPasskey({
      proof: {
        kind: 'passkey',
        challengeId: confirm.challengeId,
        response: soft.get(confirm.options),
      },
    });
    expect(ok.ok).toBe(true);
  });

  it('register (finishAddPasskey) refuses a second_step challenge', async () => {
    const { soft, userId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    const r = await pk.finishAddPasskey({
      challengeId,
      response: soft.get(options),
      name: 'Second',
    });
    expect(r.ok).toBe(false);
    const purposes = world.calls.fns
      .filter((c) => c.name === 'take_passkey_challenge')
      .map((c) => c.args.p_purpose);
    expect(purposes.at(-1)).toBe('register');
  });

  it('finish_setup refuses a second_step challenge', async () => {
    const { soft } = await memberWithPasskey();
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    expect(await pk.finishPasskeySetup({ challengeId, response: soft.get(options) })).toMatchObject(
      {
        ok: false,
        message: pk.PASSKEY_WORDS.expired,
      },
    );
  });

  it('no exported action takes a purpose', () => {
    const src = readFileSync(path.join(__dirname, '../actions/passkeys.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/purpose/i);
  });
});

describe('rule 22: every failed use write refuses the sign-in, before any Auth call', () => {
  it('a use write that changes no row refuses with Try again and makes no Auth call', async () => {
    const { soft } = await memberWithPasskey();
    const { challengeId, options } = optionsOf(await pk.startSecondStep());
    world.knobs.useWriteFails = true;
    world.calls.auth.length = 0;
    expect(await pk.completeSecondStep({ challengeId, response: soft.get(options) })).toMatchObject(
      {
        ok: false,
        message: pk.PASSKEY_WORDS.tryAgain,
      },
    );
    expect(world.calls.auth).toEqual([]);
  });

  it('last_used_at is never earlier than the row was added', async () => {
    const { soft } = await memberWithPasskey();
    const future = new Date(Date.now() + 60_000).toISOString();
    world.passkeys[0]!.created_at = future;
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    expect(world.passkeys[0]!.last_used_at).toBe(future);
  });
});

describe('states: the server branches on the facts (2.7)', () => {
  it('S7 (a removal the member started, bridge row and its factor no newer): finished at sign-in, nothing owed', async () => {
    const { userId } = await memberWithPasskey();
    const bridge = world.bridges.get(userId)!;
    const later = new Date(Date.now() + 1000).toISOString();
    world.passkeys[0]!.removed_at = later;
    world.passkeys[0]!.removed_reason = 'member';
    const r = await pk.startSecondStep();
    expect(r).toMatchObject({ ok: true, start: { kind: 'removal_finished' } });
    expect(world.calls.deleteFactor).toContain(bridge.factor_id);
    expect(world.bridges.has(userId)).toBe(false);
  });

  it('S17 (a verified reserved factor newer than the removal): never finished, fail closed and reported', async () => {
    const { userId } = await memberWithPasskey();
    const bridge = world.bridges.get(userId)!;
    world.passkeys[0]!.removed_at = new Date(Date.now() - 60_000).toISOString();
    world.passkeys[0]!.removed_reason = 'member';
    const r = await pk.startSecondStep();
    expect(r.ok).toBe(false);
    expect(world.calls.deleteFactor).not.toContain(bridge.factor_id);
    expect(world.bridges.has(userId)).toBe(true);
    expect(
      await pk.passkeyStepFor(
        userId,
        world.factors.filter((f) => f.user_id === userId),
      ),
    ).toBe('none');
  });

  it('S8 (a bridge with no passkey row ever) fails closed', async () => {
    const { userId } = await memberWithPasskey();
    world.passkeys.length = 0;
    expect(await pk.startSecondStep()).toMatchObject({ ok: false });
    expect(world.bridges.has(userId)).toBe(true);
  });

  it('S9 (the secret cannot be opened: a lost key) fails closed with the recovery-code words', async () => {
    const { soft, userId } = await memberWithPasskey();
    world.env.PASSKEY_BRIDGE_KEY_V1 = Buffer.alloc(32, 7).toString('base64');
    expect(await pk.startSecondStep()).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.cantUse,
      reason: 'bridge_unopenable',
    });
    expect(soft).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  it('a newer key: the row is sealed again on use, by the same factor', async () => {
    const { soft, userId } = await memberWithPasskey();
    const before = world.bridges.get(userId)!;
    world.env.PASSKEY_BRIDGE_KEY_V2 = Buffer.alloc(32, 9).toString('base64');
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    const after = world.bridges.get(userId)!;
    expect(after.factor_id).toBe(before.factor_id);
    expect(after.key_version).toBe(2);
    expect(after.secret_ciphertext.startsWith('v2.')).toBe(true);
    world.env.PASSKEY_BRIDGE_KEY_V2 = '';
  });

  it('S2 (an active passkey, no bridge row): setup not finished; Finish enrols, answers, swaps', async () => {
    const { soft, userId } = await memberWithPasskey();
    const old = world.bridges.get(userId)!;
    world.bridges.delete(userId);
    world.factors = world.factors.filter((f) => f.id !== old.factor_id);
    expect(await pk.startSecondStep()).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.setupNotFinished,
    });
    expect(await pk.passkeysPanelFor(userId)).toMatchObject({
      passkeys: [expect.objectContaining({ unfinished: true })],
    });
    const { challengeId, options } = optionsOf(await pk.startFinishSetup());
    expect(await pk.finishPasskeySetup({ challengeId, response: soft.get(options) })).toEqual({
      ok: true,
    });
    const now = world.bridges.get(userId)!;
    expect(world.factors.find((f) => f.id === now.factor_id)?.status).toBe('verified');
    expect(emitAuthAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'passkey.bridge_repaired' }),
    );
  });
});

describe('10.4: the raise row is written before every bridge answer, and required', () => {
  const RAISE = 'passkey.bridge_raise';
  const verifies = () =>
    world.calls.auth.filter((c) => /\/factors\/[^/]+\/(challenge|verify)$/.test(c.path)).length;
  const raiseCalls = () =>
    vi
      .mocked(emitAuthAudit)
      .mock.calls.map((c) => c[0])
      .filter((a) => a.event === RAISE);

  /** The raise rows fail (false) or are written; Auth calls made before each raise row are counted. */
  function auditAnswers(raiseWritten: boolean) {
    const authCallsAtRaise: number[] = [];
    vi.mocked(emitAuthAudit).mockImplementation(async (a) => {
      if (a.event !== RAISE) return true;
      authCallsAtRaise.push(verifies());
      return raiseWritten;
    });
    return authCallsAtRaise;
  }

  it('second step: the raise row (session id, raise id) comes before any bridge call; passkey.used carries the same raise id', async () => {
    const { soft, session } = await memberWithPasskey();
    world.calls.auth.length = 0;
    vi.mocked(emitAuthAudit).mockClear();
    const atRaise = auditAnswers(true);
    expect(await passkeyStep(soft)).toEqual({ ok: true });
    expect(atRaise).toEqual([0]);
    const raise = raiseCalls()[0]!;
    expect(raise.extra).toMatchObject({ session_id: session.id, purpose: 'second_step' });
    expect(raise.extra!.raise_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(emitAuthAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'passkey.used',
        extra: expect.objectContaining({ raise_id: raise.extra!.raise_id }),
      }),
    );
  });

  it('each raise has its own raise id', async () => {
    const { soft, userId } = await memberWithPasskey();
    await passkeyStep(soft);
    world.signIn(userId, 'aal1');
    await passkeyStep(soft);
    const ids = raiseCalls().map((a) => a.extra!.raise_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(3); // the add, then two second steps
  });

  it('second step: a raise row not written refuses, the bridge is not answered, the session stays aal1', async () => {
    const { soft, session } = await memberWithPasskey();
    world.calls.auth.length = 0;
    auditAnswers(false);
    expect(await passkeyStep(soft)).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.couldNotFinish,
    });
    expect(verifies()).toBe(0);
    expect(world.sessions.get(session.id)!.aal).toBe('aal1');
    expect(vi.mocked(emitAuthAudit).mock.calls.map((c) => c[0].event)).not.toContain(
      'passkey.used',
    );
    expect(vi.mocked(reportError).mock.calls.map((c) => (c[1] as { tag?: string }).tag)).toContain(
      'passkeys.raise_row_unwritten',
    );
  });

  it('first passkey: a raise row not written is compensated like a failed answer (marked setup_failed, factor deleted, nothing answered)', async () => {
    const userId = world.addAccount('raise-add@example.test');
    const session = world.signIn(userId);
    auditAnswers(false);
    const r = await addFirstPasskey(new SoftAuthenticator());
    expect(r).toMatchObject({ ok: false });
    expect(verifies()).toBe(0);
    expect(world.passkeys[0]!.removed_reason).toBe('setup_failed');
    expect(world.bridges.has(userId)).toBe(false);
    expect(world.factors.filter((f) => f.user_id === userId)).toEqual([]);
    expect(world.sessions.get(session.id)!.aal).toBe('aal1');
  });

  it('finish setup: a raise row not written deletes the new factor and answers nothing', async () => {
    const { soft, userId } = await memberWithPasskey();
    const old = world.bridges.get(userId)!;
    world.bridges.delete(userId);
    world.factors = world.factors.filter((f) => f.id !== old.factor_id);
    const { challengeId, options } = optionsOf(await pk.startFinishSetup());
    world.calls.auth.length = 0;
    auditAnswers(false);
    expect(await pk.finishPasskeySetup({ challengeId, response: soft.get(options) })).toMatchObject(
      { ok: false },
    );
    expect(verifies()).toBe(0);
    expect(world.bridges.has(userId)).toBe(false);
    expect(world.factors.filter((f) => f.user_id === userId && world.reserved(f))).toEqual([]);
  });
});

describe('D.6: a failed answer after the store is compensated in the same request', () => {
  it('passkey_mark_removed(setup_failed), then the new factor deleted; never passkey_remove_all', async () => {
    const userId = world.addAccount('comp@example.test');
    world.signIn(userId);
    world.knobs.verifyError = 'over_request_rate_limit';
    const r = await addFirstPasskey(new SoftAuthenticator());
    expect(r).toMatchObject({ ok: false, message: pk.PASSKEY_WORDS.addNotFinished });
    const names = world.calls.fns.map((c) => c.name);
    expect(names).toContain('passkey_mark_removed');
    expect(names).not.toContain('passkey_remove_all');
    const mark = world.calls.fns.find((c) => c.name === 'passkey_mark_removed')!;
    expect(mark.args.p_reason).toBe('setup_failed');
    expect(world.bridges.has(userId)).toBe(false);
    expect(world.factors.filter((f) => f.user_id === userId)).toEqual([]);
    expect(world.passkeys[0]!.removed_reason).toBe('setup_failed');
  });

  it('another tab stored a bridge first (55000): the factor just enrolled is deleted, nothing of ours stored', async () => {
    const userId = world.addAccount('tabs@example.test');
    world.signIn(userId);
    const start = await pk.startAddPasskey({
      proof: { kind: 'password', password: SAMPLE_PASSWORD },
    });
    if (!start.ok) throw new Error('start');
    world.bridges.set(userId, {
      user_id: userId,
      factor_id: crypto.randomUUID(),
      secret_ciphertext: 'v1.x',
      key_version: 1,
      created_at: new Date().toISOString(),
    });
    // The other tab's row is in place, so this account no longer reads as "no bridge": refused before enrol.
    const r = await pk.finishAddPasskey({
      challengeId: start.challengeId,
      response: new SoftAuthenticator().create(start.optionsJSON as never),
      name: 'Tab',
    });
    expect(r.ok).toBe(false);
    expect(world.passkeys).toEqual([]);
  });
});

describe('E: removal', () => {
  it('needs aal2; marks the row removed, drops the bridge with the last one, deletes its factor, ends the other sessions', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    expect(await pk.removePasskey({ passkeyId })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.stepUpFirst,
    });
    world.signIn(userId, 'aal2');
    const bridge = world.bridges.get(userId)!;
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
    expect(world.passkeys[0]).toMatchObject({ removed_reason: 'member' });
    expect(world.bridges.has(userId)).toBe(false);
    expect(world.calls.deleteFactor).toContain(bridge.factor_id);
    expect(world.calls.auth.some((c) => c.path === '/logout?scope=others')).toBe(true);
    expect(emitAuthAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'passkey.removed' }),
    );
    expect(sendPasskeyRemovedEmail).toHaveBeenCalled();
  });

  function requiringOrg(userId: string, policy = 'all_required', role = 'member') {
    const org = crypto.randomUUID();
    world.organizations.push({ id: org, mfa_policy: policy });
    world.memberships.push({
      user_id: userId,
      organization_id: org,
      role,
      accepted_at: new Date().toISOString(),
      impersonation_expires_at: null,
    });
  }

  it('the last method under a policy that requires a second step is refused', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId);
    expect(await pk.removePasskey({ passkeyId })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.policyBlocksRemoval,
    });
    expect(world.passkeys[0]!.removed_at).toBeNull();
  });

  it('decision B: one rule and the same words as an authenticator app\'s removal', () => {
    expect(pk.PASSKEY_WORDS.policyBlocksRemoval).toBe(LAST_METHOD_WORDS);
  });

  it('decision B: an authenticator app beside it keeps a second step, so the passkey may go', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.addApp(userId);
    world.signIn(userId, 'aal2');
    requiringOrg(userId);
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
  });

  it('decision B: another passkey keeps a second step; the bridge factor is never counted as an app', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId, 'admins_required', 'admin');
    // The bridge alone (a verified reserved-name factor) is no method.
    expect(world.factors.filter((f) => f.user_id === userId && f.status === 'verified')).toHaveLength(1);
    expect(await pk.removePasskey({ passkeyId })).toMatchObject({ ok: false, reason: 'policy' });
    // A second passkey of this site (the same bridge serves both).
    world.passkeys.push({
      ...world.passkeys[0]!,
      id: crypto.randomUUID(),
      credential_id: 'sample-second-credential-0001',
      name: 'Second key',
    });
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
    // A passkey of another site is no method here.
    world.passkeys[1]!.rp_id = 'other.example.test';
    const third = world.passkeys[1]!;
    world.passkeys.push({ ...third, id: crypto.randomUUID(), rp_id: 'localhost', removed_at: null });
    const last = world.passkeys[2]!.id;
    third.removed_at = null;
    expect(await pk.removePasskey({ passkeyId: last })).toMatchObject({ ok: false, reason: 'policy' });
  });

  it('decision B: an admins-only policy does not hold a staff member; any organization of the member counts', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId, 'admins_required', 'staff');
    requiringOrg(userId, 'optional', 'owner');
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
  });

  it('correction 1: a passkey whose bridge cannot serve is no method, so removing it is not refused', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId);
    const bridge = world.bridges.get(userId)!;
    world.factors.find((f) => f.id === bridge.factor_id)!.status = 'unverified';
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
  });

  it('correction 1: with the kill switch off no passkey serves; the passkey itself may still go (decision A)', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId);
    world.addAllowed = 'kill_switch_off';
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
  });

  it('correction 2: the switch cannot be read: the last passkey stays, try again in a moment', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId);
    world.addAllowed = 'sample-unknown-word';
    expect(await pk.removePasskey({ passkeyId })).toMatchObject({
      ok: false,
      code: 'internal_error',
      message: LAST_METHOD_RETRY_WORDS,
      reason: 'last_method_unreadable',
    });
    expect(world.passkeys[0]!.removed_at).toBeNull();
  });

  it('correction 2: the switch cannot be read and no policy requires one: removed', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    requiringOrg(userId, 'optional', 'owner');
    world.addAllowed = 'sample-unknown-word';
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
  });

  it('an app beside: the passkey goes and the switch is never read', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.addApp(userId);
    world.signIn(userId, 'aal2');
    requiringOrg(userId);
    world.addAllowed = 'sample-unknown-word';
    world.calls.fns.length = 0;
    expect(await pk.removePasskey({ passkeyId })).toEqual({ ok: true, finishing: false });
    expect(world.calls.fns.map((c) => c.name)).not.toContain('passkey_add_allowed');
  });

  it('rename keeps the table rule (no dot) and needs aal2', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    world.signIn(userId, 'aal2');
    expect(await pk.renamePasskey({ passkeyId, name: 'my.key' })).toMatchObject({
      ok: false,
      message: pk.PASSKEY_WORDS.nameInvalid,
    });
    expect(await pk.renamePasskey({ passkeyId, name: ' Front  desk ' })).toEqual({ ok: true });
    expect(world.passkeys[0]!.name).toBe('Front desk');
  });
});

describe('correction 1: servingPasskeyIds, the passkeys that can serve as the second step now (the page\'s own judgement)', () => {
  const factorsOf = (userId: string) => world.factors.filter((f) => f.user_id === userId);

  it('a healthy passkey serves; an organization switched off does not change that (the USE level)', async () => {
    const { userId, passkeyId } = await memberWithPasskey();
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([passkeyId]);
    world.addAllowed = 'organization_off';
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([passkeyId]);
    world.addAllowed = 'adds_off';
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([passkeyId]);
  });

  it('an active row alone is no method: no bridge row, the bridge factor unverified or missing, a secret the keys do not open', async () => {
    const cases: Array<[string, (userId: string) => void]> = [
      ['no bridge row', (u) => void world.bridges.delete(u)],
      [
        'bridge factor unverified',
        (u) => {
          const b = world.bridges.get(u)!;
          world.factors.find((f) => f.id === b.factor_id)!.status = 'unverified';
        },
      ],
      [
        'bridge factor missing',
        (u) => {
          const b = world.bridges.get(u)!;
          world.factors = world.factors.filter((f) => f.id !== b.factor_id);
        },
      ],
      [
        'the bridge row names an authenticator app',
        (u) => {
          world.bridges.get(u)!.factor_id = world.addApp(u).id;
        },
      ],
      [
        'a secret the keys do not open',
        () => (world.env.PASSKEY_BRIDGE_KEY_V1 = Buffer.alloc(32, 7).toString('base64')),
      ],
    ];
    for (const [label, breakIt] of cases) {
      world.reset();
      vi.stubGlobal('fetch', world.fetch);
      const { userId } = await memberWithPasskey(`${label.replace(/\W+/g, '-')}@example.test`);
      breakIt(userId);
      expect([label, await pk.servingPasskeyIds(userId, factorsOf(userId))]).toEqual([label, []]);
    }
  });

  it('only active rows of this site: a removed row and another site\'s row serve nothing', async () => {
    const { userId } = await memberWithPasskey();
    world.passkeys[0]!.rp_id = 'other.example.test';
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([]);
    world.passkeys[0]!.rp_id = 'localhost';
    world.passkeys[0]!.removed_at = new Date().toISOString();
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([]);
  });

  it('the kill switch off, the account turned off, no key: nothing serves', async () => {
    const { userId } = await memberWithPasskey();
    for (const word of ['kill_switch_off', 'disabled', 'no_profile']) {
      world.addAllowed = word;
      expect([word, await pk.servingPasskeyIds(userId, factorsOf(userId))]).toEqual([word, []]);
    }
    world.addAllowed = 'ok';
    world.env.PASSKEY_BRIDGE_KEY_V1 = '';
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([]);
  });

  it('with no site nothing serves and nothing is read', async () => {
    const { userId } = await memberWithPasskey();
    world.calls.fns.length = 0;
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toEqual([]);
    expect(world.calls.fns).toEqual([]);
  });

  it('correction 2: what cannot be told is null, never a list: an unknown factor list (nothing read), the switch unread, a failed read', async () => {
    const { userId } = await memberWithPasskey();
    world.calls.fns.length = 0;
    expect(await pk.servingPasskeyIds(userId, null)).toBeNull();
    expect(world.calls.fns).toEqual([]);
    world.addAllowed = 'sample-unknown-word';
    expect(await pk.servingPasskeyIds(userId, factorsOf(userId))).toBeNull();
    world.addAllowed = 'ok';
    for (const table of ['member_passkeys', 'passkey_bridges']) {
      world.knobs.failReads = [table];
      expect([table, await pk.servingPasskeyIds(userId, factorsOf(userId))]).toEqual([table, null]);
    }
  });
});

describe('the page reads', () => {
  it('passkeyStepFor reads nothing for an account with no reserved-name factor', async () => {
    const userId = world.addAccount('plain@example.test');
    world.signIn(userId);
    expect(
      await pk.passkeyStepFor(userId, [{ friendly_name: 'StockPilot app', factor_type: 'totp' }]),
    ).toBe('none');
    expect(world.calls.fns).toEqual([]);
    expect(world.calls.auth).toEqual([]);
  });

  it('passkeyStepFor is ready for a healthy passkey', async () => {
    const { userId } = await memberWithPasskey();
    expect(
      await pk.passkeyStepFor(
        userId,
        world.factors.filter((f) => f.user_id === userId),
      ),
    ).toBe('ready');
  });

  it('the origin the library is given is the configured one, never the request', () => {
    expect(ORIGIN).toBe('http://localhost:3000');
  });
});
