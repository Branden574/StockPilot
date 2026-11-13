/**
 * One signed-in member and the network around them, for the suites that run
 * the REAL session loader, the authenticator-code gate (lib/auth/step-up-gate)
 * and withContext() against a faked Supabase client that records every call:
 * lib/auth/session.step-up.test.ts, server/actions/step-up.actions.test.ts
 * and the code page's own test.
 *
 * A test sets `world` (who the proxy forwarded, the account's factors, the
 * verified token's subject and level, the organization's policy) and reads
 * `world.calls` back. `auth:getUser` is the gate's one Auth round trip (the
 * factor list); `auth:getSession` and `auth:getClaims` are local reads.
 *
 * Made-up people and organizations only.
 */

export const USER = '99999999-9999-4999-8999-999999999999';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
export const ORG_2 = 'bbbbbbbb-2222-4222-8222-222222222222';
export const EMAIL = 'person@example.test';

export type Policy = 'optional' | 'admins_required' | 'all_required';
export type MemberRole = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

export interface World {
  /** What the proxy forwarded (null: no session header at all). */
  headerUser: string | null;
  /** `x-stockpilot-return-path`: the page the request was for. */
  returnPath: string | null;
  /** GoTrue's factors for the account. */
  factors: Array<{ status: string }>;
  /** Whose list GoTrue answers with (another account after a refresh swap). */
  factorsOf: string;
  /** How the factor read goes. */
  factorRead: 'answer' | 'error' | 'session-missing' | 'throw';
  /** The verified token: its subject and its level (null: no `aal` claim). */
  claimsSub: string;
  aal: 'aal1' | 'aal2' | null;
  /** How the session load behind the claims goes. */
  claimsRead: 'answer' | 'error' | 'throw';
  policy: Policy;
  role: MemberRole;
  /** The member's organizations, default first. Empty: no membership. */
  orgs: string[];
  disabled: boolean;
  /** Every network call, in order: `rpc:<name>`, `from:<table>`, `auth:<method>`. */
  calls: string[];
}

const START: Omit<World, 'calls'> = {
  headerUser: USER,
  returnPath: '/dashboard/inventory?view=low',
  factors: [],
  factorsOf: USER,
  factorRead: 'answer',
  claimsSub: USER,
  aal: 'aal1',
  claimsRead: 'answer',
  policy: 'optional',
  role: 'staff',
  orgs: [ORG],
  disabled: false,
};

export const world: World = { ...START, factors: [], orgs: [ORG], calls: [] };

export function resetWorld(): void {
  Object.assign(world, START, { factors: [], orgs: [ORG], calls: [] });
}

export const VERIFIED_FACTOR = [{ status: 'verified' }];

export const countCalls = (call: string) => world.calls.filter((c) => c === call).length;

/** What `headers()` answers: the proxy's identity and return-path headers. */
export function fixtureHeaders(): Headers {
  const h = new Headers();
  if (world.headerUser) {
    h.set('x-stockpilot-user-id', world.headerUser);
    h.set('x-stockpilot-user-email', EMAIL);
  }
  if (world.returnPath !== null) h.set('x-stockpilot-return-path', world.returnPath);
  return h;
}

/** get_request_context()'s answer for the member. */
function bundle() {
  return {
    user_id: USER,
    profile: {
      id: USER,
      email: EMAIL,
      full_name: 'Example Person',
      avatar_url: null,
      default_organization_id: world.orgs[0] ?? null,
      disabled_at: world.disabled ? '2026-10-01T00:00:00Z' : null,
    },
    memberships: world.orgs.map((id) => ({
      organization_id: id,
      role: world.role,
      organization: {
        id,
        name: `Org ${id.slice(0, 1)}`,
        logo_url: null,
        terminology: null,
        mfa_policy: world.policy,
        timezone: null,
        nav_overrides: null,
        dashboard_layout: null,
        order_status_config: null,
        all_modules_comp: false,
      },
      role_overrides: [],
      user_overrides: [],
      enabled_modules: [],
    })),
  };
}

const seg = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The stored session's access token: unsigned, the fake getClaims stands in for the verified read. */
function accessToken(): string {
  return `${seg({ alg: 'none' })}.${seg({
    sub: world.claimsSub,
    ...(world.aal ? { aal: world.aal } : {}),
  })}.`;
}

/** GoTrue's user for the session, or the failure `world.factorRead` names. */
function userAnswer() {
  if (world.factorRead === 'throw') throw new Error('fetch failed');
  if (world.factorRead === 'error') {
    return { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } };
  }
  if (world.factorRead === 'session-missing') {
    return {
      data: { user: null },
      error: { name: 'AuthSessionMissingError', __isAuthError: true, status: 400 },
    };
  }
  return {
    data: { user: { id: world.factorsOf, email: EMAIL, factors: world.factors } },
    error: null,
  };
}

/** What `createClient()` answers. A table read is recorded and then refused: none is expected. */
export function fixtureClient() {
  return {
    rpc: async (fn: string) => {
      world.calls.push(`rpc:${fn}`);
      return { data: bundle(), error: null };
    },
    from: (table: string) => {
      world.calls.push(`from:${table}`);
      throw new Error(`unexpected table read: ${table}`);
    },
    auth: {
      // The stored session's access token (a cookie read), then its verified
      // claims (a local signature check): lib/auth/verified-claims.
      getSession: async () => {
        world.calls.push('auth:getSession');
        if (world.claimsRead === 'throw') throw new Error('session storage unreadable');
        if (world.claimsRead === 'error') {
          return { data: { session: null }, error: { name: 'AuthSessionMissingError' } };
        }
        return { data: { session: { access_token: accessToken() } }, error: null };
      },
      getClaims: async (token: string) => {
        world.calls.push('auth:getClaims');
        const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
        return { data: { claims }, error: null };
      },
      // GoTrue's user, with its factors: the gate's one Auth round trip
      // (lib/auth/mfa-factors reads the factor list with getUser()).
      getUser: async () => {
        world.calls.push('auth:getUser');
        return userAnswer();
      },
      mfa: {
        // listFactors() is the same GoTrue read inside auth-js.
        listFactors: async () => {
          world.calls.push('auth:mfa.listFactors');
          const answer = userAnswer();
          if (answer.error) return { data: null, error: answer.error };
          const all = world.factors.map((f, i) => ({
            id: `factor-${i + 1}`,
            factor_type: 'totp',
            friendly_name: null,
            status: f.status,
          }));
          return {
            data: { all, totp: all.filter((f) => f.status === 'verified') },
            error: null,
          };
        },
        getAuthenticatorAssuranceLevel: async () => {
          world.calls.push('auth:mfa.getAuthenticatorAssuranceLevel');
          const enrolled = world.factors.some((f) => f.status === 'verified');
          return {
            data: { currentLevel: world.aal, nextLevel: enrolled ? 'aal2' : world.aal },
            error: null,
          };
        },
        enroll: async () => {
          world.calls.push('auth:mfa.enroll');
          return {
            data: {
              id: 'factor-new',
              type: 'totp',
              totp: { qr_code: 'qr', secret: 'secret', uri: 'otpauth://example' },
            },
            error: null,
          };
        },
        unenroll: async () => {
          world.calls.push('auth:mfa.unenroll');
          return { data: { id: 'factor-old' }, error: null };
        },
      },
    },
  };
}

/** The redirect a call ends in (next/navigation mocked to throw `REDIRECT:<to>`), or null when it resolves. */
export async function redirectOf(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec(e instanceof Error ? e.message : '');
    if (!m) throw e;
    return m[1]!;
  }
}
