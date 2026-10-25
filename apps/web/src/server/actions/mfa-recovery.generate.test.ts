import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: minting recovery codes needs an AAL2 session, and the
 * level comes from an access token whose signature has been checked.
 *
 * The codes are plaintext and replace the old set, so a pre-MFA (AAL1)
 * session that could mint them could use one to strip MFA off the account.
 * The gate read auth.mfa.getAuthenticatorAssuranceLevel() on a fresh server
 * client: the cookie's token decoded unchecked (and its stored user object,
 * logged by auth-js as "could be insecure"). Here the session is read by the
 * REAL server client and auth-js against the fixture's ES256 keys and Auth
 * server (src/test/auth-session-fixture.ts); the database calls are recorded
 * instead of sent.
 */

let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar) };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: null,
  })),
}));
const checkRateLimit = vi.fn(async () => ({ allowed: true }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...(args as [])),
}));
const rpc = vi.fn(async () => ({ data: [{ code: 'aaaa-bbbb' }], error: null }));
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    // The request's cookie client, with its database calls recorded.
    createClient: async () => Object.assign(await real.createClient(), { rpc }),
  };
});

import {
  INSECURE_USER_WARNING,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  withEditedPayload,
  type FakeAuthServer,
  type SigningKey,
} from '@/test/auth-session-fixture';

import { generateMfaRecoveryCodesAction } from './mfa-recovery';

let projectKey: SigningKey;
let attackerKey: SigningKey;
let server: FakeAuthServer;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  projectKey = await makeSigningKey('project-kid-1');
  attackerKey = await makeSigningKey('attacker-kid');
});

beforeEach(() => {
  server = fakeAuthServer(projectKey);
  vi.stubGlobal('fetch', server.fetch);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

const REFUSAL = 'Re-authenticate with MFA before regenerating recovery codes.';

async function expectRefused() {
  const res = await generateMfaRecoveryCodesAction();
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error.code).toBe('forbidden');
    expect(res.error.message).toBe(REFUSAL);
  }
  // Refused before the rate limit is spent and before any code is minted.
  expect(checkRateLimit).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
}

describe('generateMfaRecoveryCodesAction — the AAL2 gate', () => {
  it('a verified AAL2 session mints the codes, with no warning', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    const res = await generateMfaRecoveryCodesAction();
    expect(res).toEqual({ ok: true, data: { codes: ['aaaa-bbbb'] } });
    expect(rpc).toHaveBeenCalledWith('generate_mfa_recovery_codes');
    expect(warn.mock.calls.some((c: unknown[]) => INSECURE_USER_WARNING.test(String(c[0])))).toBe(
      false,
    );
    expect(server.calls['/user']).toBeUndefined();
  });

  it('a verified AAL1 session is refused', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    await expectRefused();
  });

  it('a token edited to claim AAL2 is refused', async () => {
    const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, withEditedPayload(real, forged));
    await expectRefused();
  });

  it("a token signed with another key under the project's key id is refused", async () => {
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, await signAccessToken(attackerKey, forged, projectKey.kid));
    await expectRefused();
  });

  it('an expired AAL2 token that cannot be refreshed is refused', async () => {
    await signIn(sessionClaims({ aal: 'aal2', expiresIn: -120 }));
    await expectRefused();
  });
});
