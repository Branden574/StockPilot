import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mirror of context.mfa.test.ts for the API twin (`withApiContext`), pinning
 * the HI-6 inversion on BOTH auth paths:
 *
 *   - ENROLLED (verified TOTP factor on the GoTrue user) under an 'optional'
 *     org policy, at AAL1 -> no context at all (null, the route's 401). Org
 *     policy alone must NOT decide enforcement for an enrolled user, and a
 *     stolen password's AAL1 token is refused before anything is read, not
 *     only by the permission gates (docket S43a, api-context.step-up.test.ts).
 *   - ENROLLED + an AAL2 token -> required=true, satisfied=true (no block).
 *   - UNENROLLED under 'optional' -> required=false — the unattended-login
 *     path (the demo QA account has NO factors) stays open.
 *   - UNENROLLED admin under 'admins_required' -> required=true (existing
 *     policy-driven behavior, pinned byte-for-byte).
 *
 * Bearer AAL comes from the token's own `aal` claim (aalFromJwt); the cookie
 * path reads getAuthenticatorAssuranceLevel(). Enrollment comes from the
 * `factors` array GoTrue returns inline on the validated user object.
 */

const refs = vi.hoisted(() => ({
  client: null as unknown,
  reportError: vi.fn(async () => {}),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: (...a: unknown[]) => refs.reportError(...(a as [])),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: async () => new Set<string>(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { assertPermission, ServiceError, type ServiceContext } from '@/server/services/context';
import { withApiContext } from './api-context';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const ORG_ID = '88888888-8888-8888-8888-888888888888';

type Policy = 'optional' | 'admins_required' | 'all_required';

const state: {
  policy: Policy;
  /** GoTrue factors on the validated user object (bearer + cookie). */
  factors: Array<{ status: string }>;
  /** currentLevel reported to the COOKIE path. */
  cookieAal: 'aal1' | 'aal2';
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
} = {
  policy: 'optional',
  factors: [],
  cookieAal: 'aal1',
  role: 'admin',
};

/** Minimal PostgREST-shaped fake: chainable, awaitable, and maybeSingle-able. */
function table(single: unknown, list: unknown[] = []) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.select = self;
  q.eq = self;
  q.is = self;
  q.not = self;
  q.in = self;
  q.limit = self;
  q.order = self;
  q.maybeSingle = async () => ({ data: single, error: null });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: list, error: null }).then(resolve);
  return q;
}

function fakeUser() {
  return { id: USER_ID, email: 'user@example.com', factors: state.factors };
}

function makeClient() {
  return {
    from: (name: string) => {
      if (name === 'organizations') return table({ mfa_policy: state.policy });
      if (name === 'organization_members')
        return table({ organization_id: ORG_ID, role: state.role });
      if (name === 'user_profiles')
        return table({
          id: USER_ID,
          email: 'user@example.com',
          default_organization_id: ORG_ID,
          disabled_at: null,
        });
      if (name === 'organization_modules') return table(null, []);
      return table(null, []);
    },
    auth: {
      getUser: async () => ({ data: { user: fakeUser() }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: state.cookieAal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
  };
}

/** JWT-shaped token (header.payload.sig) carrying the given `aal` claim. */
function fakeJwt(aal?: 'aal1' | 'aal2'): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER_ID, ...(aal ? { aal } : {}) })}.sig`;
}

function bearerRequest(aal?: 'aal1' | 'aal2'): Request {
  return new Request('https://app.test/api/v1/items', {
    headers: { authorization: `Bearer ${fakeJwt(aal)}`, 'x-organization-id': ORG_ID },
  });
}

function cookieRequest(): Request {
  return new Request('https://app.test/api/items', {
    headers: { cookie: 'sb-example-auth-token=abc' },
  });
}

beforeEach(() => {
  state.policy = 'optional';
  state.factors = [];
  state.cookieAal = 'aal1';
  state.role = 'admin';
  refs.client = makeClient();
});

describe('withApiContext BEARER — enrolled-TOTP enforcement (HI-6)', () => {
  it('ENROLLED under optional policy + AAL1 token -> refused outright (null, the 401; docket S43a)', async () => {
    state.factors = [{ status: 'verified' }];
    const ctx = await withApiContext(bearerRequest('aal1'));
    expect(ctx).toBeNull();
  });

  it('ENROLLED + AAL1 token on the reviewed AAL1 allowlist -> required=true, satisfied=false', async () => {
    state.factors = [{ status: 'verified' }];
    const ctx = await withApiContext(bearerRequest('aal1'), { allowStepUpPending: true });
    expect(ctx).not.toBeNull();
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
    expect(ctx?.mfaEnrolled).toBe(true);
  });

  it('ENROLLED under optional policy + AAL2 token -> required=true, satisfied=true (no block)', async () => {
    state.factors = [{ status: 'verified' }];
    const ctx = await withApiContext(bearerRequest('aal2'));
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(true);
    expect(ctx?.mfaEnrolled).toBe(true);
  });

  it('UNENROLLED under optional policy -> required=false, satisfied=true (unattended login stays open)', async () => {
    // CRITICAL pin: the demo QA account (demo@stockpilotusa.com) has NO
    // factors and must keep logging in untouched under 'optional'.
    state.factors = [];
    const ctx = await withApiContext(bearerRequest('aal1'));
    expect(ctx?.mfaRequired).toBe(false);
    expect(ctx?.mfaSatisfied).toBe(true);
    expect(ctx?.mfaEnrolled).toBe(false);
  });

  it('an UNVERIFIED factor does not escalate (still unenrolled)', async () => {
    state.factors = [{ status: 'unverified' }];
    const ctx = await withApiContext(bearerRequest('aal1'));
    expect(ctx?.mfaRequired).toBe(false);
    expect(ctx?.mfaSatisfied).toBe(true);
  });

  it('UNENROLLED admin under admins_required -> required=true, satisfied=false (policy branch pinned)', async () => {
    state.policy = 'admins_required';
    state.role = 'admin';
    state.factors = [];
    const ctx = await withApiContext(bearerRequest('aal1'));
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
  });

  it('an ENROLLED AAL1 context: assertPermission refuses with reason=aal2_required (the step-up shape)', () => {
    // withApiContext no longer hands this context to a route (docket S43a), but
    // the allowlist's labelled context and every page and action context still
    // reach assertPermission, so its answer for one is pinned on a built context.
    const ctx: ServiceContext = {
      organizationId: ORG_ID,
      userId: USER_ID,
      role: 'admin',
      permissions: new Set(['items:read']),
      supabase: makeClient() as never,
      mfaRequired: true,
      mfaSatisfied: false,
      mfaEnrolled: true,
      enabledModules: new Set(),
    };
    let thrown: unknown;
    try {
      assertPermission(ctx, 'items:read');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('forbidden');
    expect((thrown as ServiceError).details).toEqual({ reason: 'aal2_required' });
  });

  it('a token with NO aal claim fails CLOSED for an enrolled user (refused outright)', async () => {
    state.factors = [{ status: 'verified' }];
    const ctx = await withApiContext(bearerRequest(undefined));
    expect(ctx).toBeNull();
  });
});

describe('withApiContext COOKIE — enrolled-TOTP enforcement (HI-6)', () => {
  it('ENROLLED under optional policy + AAL1 session -> refused outright (null, the 401; docket S43a)', async () => {
    state.factors = [{ status: 'verified' }];
    state.cookieAal = 'aal1';
    const ctx = await withApiContext(cookieRequest());
    expect(ctx).toBeNull();
  });

  it('ENROLLED + AAL1 session on the reviewed AAL1 allowlist -> required=true, satisfied=false', async () => {
    state.factors = [{ status: 'verified' }];
    state.cookieAal = 'aal1';
    const ctx = await withApiContext(cookieRequest(), { allowStepUpPending: true });
    expect(ctx).not.toBeNull();
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
    expect(ctx?.mfaEnrolled).toBe(true);
  });

  it('ENROLLED under optional policy + AAL2 session -> required=true, satisfied=true (no block)', async () => {
    state.factors = [{ status: 'verified' }];
    state.cookieAal = 'aal2';
    const ctx = await withApiContext(cookieRequest());
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(true);
  });

  it('UNENROLLED under optional policy -> required=false, satisfied=true', async () => {
    state.factors = [];
    const ctx = await withApiContext(cookieRequest());
    expect(ctx?.mfaRequired).toBe(false);
    expect(ctx?.mfaSatisfied).toBe(true);
  });
});
