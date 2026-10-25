import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the service context's MFA gate (resolveMfaState in
 * withContext) and the security-settings step-up (assertCurrentAal2) read the
 * session's level from an access token whose signature has been checked.
 *
 * Both called auth.mfa.getAuthenticatorAssuranceLevel() on a server client
 * that had not run getUser(): an unchecked decode of the cookie's token plus a
 * read of the cookie's stored user object, which auth-js logged as "could be
 * insecure" on every page and Server Action of a member with an
 * authenticator. Here the session is read by the REAL server client and
 * auth-js against the fixture's ES256 keys and Auth server
 * (src/test/auth-session-fixture.ts); only the org context and the factor
 * list (their own suites cover them) are stubbed.
 */

// ── One page render ─────────────────────────────────────────────────────────
// Inside a real RSC render React `cache()` shares one answer per request.
// Outside one, as in these tests and in a Server Action, it does not memoize.
// The render case is modelled on request (pass.render), as module-gate.test.ts
// does: every cache()d function then holds one answer per argument list. The
// other cases run as a Server Action does, with no sharing.
const pass = vi.hoisted(() => ({ render: false, memo: new Map<unknown, Map<string, unknown>>() }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        if (!pass.render) return fn(...args);
        let byArgs = pass.memo.get(fn);
        if (!byArgs) pass.memo.set(fn, (byArgs = new Map()));
        const key = JSON.stringify(args);
        if (!byArgs.has(key)) byArgs.set(key, fn(...args));
        return byArgs.get(key) as R;
      },
  };
});

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
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
    organizationId: 'org-1',
    organizationName: 'Acme',
    role: 'staff',
  })),
}));
// An enrolled member under the 'optional' policy: enrollment alone requires
// AAL2 (HI-6), so the level is read.
vi.mock('@/lib/dashboard/request-cache', () => ({
  getMfaFactorsForRequest: vi.fn(async () => [{ status: 'verified' }]),
  getModulesForRequest: vi.fn(async () => new Set(['orders'])),
  getOrgRowForRequest: vi.fn(async () => ({
    terminology: null,
    mfa_policy: 'optional',
    logo_url: null,
    timezone: null,
    nav_overrides: null,
    dashboard_layout: null,
    order_status_config: null,
  })),
}));

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

import { getVerifiedSessionClaimsForRequest } from '@/lib/auth/verified-claims';

import { assertCurrentAal2, ServiceError, withContext } from './context';

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
  vi.spyOn(console, 'error').mockImplementation(() => {});
  jar = new Map();
});

afterEach(() => {
  vi.unstubAllGlobals();
  pass.render = false;
  pass.memo.clear();
});

async function signIn(claims: Record<string, unknown>, token?: string) {
  jar = sessionCookies(token ?? (await signAccessToken(projectKey, claims)), claims);
}

async function forgedAal2() {
  const real = await signAccessToken(projectKey, sessionClaims({ aal: 'aal1' }));
  const forged = sessionClaims({ aal: 'aal2' });
  await signIn(forged, withEditedPayload(real, forged));
}

const insecureWarnings = () =>
  warn.mock.calls.filter((c: unknown[]) => INSECURE_USER_WARNING.test(String(c[0]))).length;

async function stepUpRefusal(): Promise<ServiceError | null> {
  try {
    await assertCurrentAal2(await withContext());
    return null;
  } catch (e) {
    return e as ServiceError;
  }
}

describe('withContext — an enrolled member is satisfied only by a verified AAL2', () => {
  it('a verified AAL2 session satisfies the gate, with no warning and no Auth round trip', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(true);
    expect(insecureWarnings()).toBe(0);
    expect(server.calls['/user']).toBeUndefined();
  });

  it('a verified AAL1 session does not', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    expect((await withContext()).mfaSatisfied).toBe(false);
  });

  it('a token edited to claim AAL2 does not', async () => {
    await forgedAal2();
    const ctx = await withContext();
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it("a token signed with another key under the project's key id does not", async () => {
    const forged = sessionClaims({ aal: 'aal2' });
    await signIn(forged, await signAccessToken(attackerKey, forged, projectKey.kid));
    expect((await withContext()).mfaSatisfied).toBe(false);
  });

  it('an expired AAL2 token that cannot be refreshed does not', async () => {
    await signIn(sessionClaims({ aal: 'aal2', expiresIn: -120 }));
    expect((await withContext()).mfaSatisfied).toBe(false);
  });
});

describe('assertCurrentAal2 — the step-up before security changes', () => {
  it('passes a verified AAL2 session, with no warning', async () => {
    await signIn(sessionClaims({ aal: 'aal2' }));
    expect(await stepUpRefusal()).toBeNull();
    expect(insecureWarnings()).toBe(0);
  });

  it('refuses a verified AAL1 session', async () => {
    await signIn(sessionClaims({ aal: 'aal1' }));
    const refusal = await stepUpRefusal();
    expect(refusal).toBeInstanceOf(ServiceError);
    expect(refusal?.code).toBe('forbidden');
    expect(refusal?.details).toEqual({ reason: 'aal2_required' });
    expect(refusal?.message).toBe('Re-authenticate with MFA before changing security settings.');
  });

  it('refuses a token edited to claim AAL2, as unverifiable', async () => {
    await forgedAal2();
    const refusal = await stepUpRefusal();
    expect(refusal?.code).toBe('forbidden');
    expect(refusal?.details).toEqual({ reason: 'aal2_required' });
    expect(refusal?.message).toBe(
      'Could not verify your two-factor authentication state. Sign in again and try once more.',
    );
  });

  it('refuses an expired AAL2 token that cannot be refreshed', async () => {
    await signIn(sessionClaims({ aal: 'aal2', expiresIn: -120 }));
    const refusal = await stepUpRefusal();
    expect(refusal?.code).toBe('forbidden');
    expect(refusal?.details).toEqual({ reason: 'aal2_required' });
  });
});

/**
 * In a page render the dashboard layout starts the verified claims read first
 * thing (getVerifiedSessionClaimsForRequest). withContext() must take that
 * same read, not start its own: page renders keep their own key set, and on a
 * cold cache a second read would fetch it again (auth-js does not share a
 * key-set fetch in flight), one more Supabase call after the factor list.
 */
describe('withContext — in a page render, the claims read the layout started', () => {
  it('answers the gate from the same read: one key-set fetch for the layout and the page', async () => {
    pass.render = true;
    const coldKey = await makeSigningKey('project-kid-cold-render');
    server = fakeAuthServer([projectKey, coldKey]);
    let answerKeySet!: () => void;
    server.jwksGate = new Promise((resolve) => {
      answerKeySet = resolve;
    });
    vi.stubGlobal('fetch', server.fetch);
    const claims = sessionClaims({ aal: 'aal2' });
    await signIn(claims, await signAccessToken(coldKey, claims));

    // The layout's read, then the page's context, while the key set is held.
    const layoutRead = getVerifiedSessionClaimsForRequest();
    const pageContext = withContext();
    await vi.waitFor(() =>
      expect(server.calls['/.well-known/jwks.json']).toBeGreaterThanOrEqual(1),
    );
    // Time for withContext() to reach its gate before the key set answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    answerKeySet();

    expect((await pageContext).mfaSatisfied).toBe(true);
    expect((await layoutRead)?.aal).toBe('aal2');
    expect(server.calls['/.well-known/jwks.json']).toBe(1);
    expect(server.calls['/user']).toBeUndefined();
  });
});
