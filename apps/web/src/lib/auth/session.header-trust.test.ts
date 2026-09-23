import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The identity header is a hint, never an identity.
 *
 * The proxy sets or deletes `x-stockpilot-user-id` only on the routes in its
 * matcher (src/proxy.ts). Everywhere else (`/api/**`, the public pages, a
 * Server Action POSTed to one of them) the header is whatever the client sent.
 * loadSessionAndContext used to trust it outright, and when get_request_context()
 * answered about a DIFFERENT user it fell back to the legacy reads with the
 * header's user id: a signed-in member naming a colleague got the colleague's
 * organization, role and permissions.
 *
 * Each case pairs a header with the identity the request's own cookie session
 * really carries, as the database (auth.uid()) and the Auth client see it.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

let headerUserId: string | null = 'victim';
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers(
        headerUserId
          ? { 'x-stockpilot-user-id': headerUserId, 'x-stockpilot-user-email': `${headerUserId}@example.com` }
          : {},
      ),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));

const ORG = 'org-1';

/** The user the request's cookie session is REALLY for (null = no session). */
let cookieUser: string | null = 'attacker';
/** How get_request_context() behaves: answers as the cookie user, or fails. */
let rpcMode: 'answer' | 'error' = 'answer';
/** How the two verification calls behave. */
let claimsMode: 'cookie' | 'error' | 'throw' = 'cookie';
let getUserMode: 'cookie' | 'error' = 'cookie';

const calls = { rpc: 0, getClaims: 0, getUser: 0, from: [] as Array<{ table: string; userId?: unknown }> };

/** Every user is a member of ORG; the victim is its owner. */
const ROLE: Record<string, string> = { victim: 'owner', attacker: 'staff' };

function profileOf(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    full_name: id,
    avatar_url: null,
    default_organization_id: ORG,
    disabled_at: null,
  };
}

function bundleFor(id: string | null) {
  return {
    user_id: id,
    profile: id ? profileOf(id) : null,
    memberships: id
      ? [
          {
            organization_id: ORG,
            role: ROLE[id],
            organization: {
              id: ORG,
              name: 'Org One',
              logo_url: null,
              terminology: null,
              mfa_policy: 'optional',
              timezone: null,
              nav_overrides: null,
              dashboard_layout: null,
              order_status_config: null,
              all_modules_comp: false,
            },
            role_overrides: [],
            user_overrides: [],
            enabled_modules: [],
          },
        ]
      : [],
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        calls.getClaims += 1;
        if (claimsMode === 'throw') throw new Error('bad jwk');
        if (claimsMode === 'error' || !cookieUser) {
          return { data: null, error: { message: 'no session' } };
        }
        return { data: { claims: { sub: cookieUser } }, error: null };
      },
      getUser: async () => {
        calls.getUser += 1;
        if (getUserMode === 'error' || !cookieUser) {
          return { data: { user: null }, error: { message: 'no session' } };
        }
        return { data: { user: { id: cookieUser } }, error: null };
      },
    },
    rpc: async () => {
      calls.rpc += 1;
      if (rpcMode === 'error') return { data: null, error: { code: 'PGRST202', message: 'x' } };
      return { data: bundleFor(cookieUser), error: null };
    },
    // The legacy reads. They answer for WHATEVER user id they are asked about,
    // as a co-member's RLS view of a colleague would: the danger is being asked.
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const result = () => {
        const id = (filters.id ?? filters.user_id) as string;
        if (table === 'user_profiles') return profileOf(id);
        if (table === 'organization_members') {
          return [
            {
              organization_id: ORG,
              role: ROLE[id] ?? 'viewer',
              organizations: { id: ORG, name: 'Org One', logo_url: null },
            },
          ];
        }
        return [];
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'not', 'is', 'order', 'limit']) builder[m] = () => builder;
      builder.eq = (col: string, val: unknown) => {
        filters[col] = val;
        if (col === 'id' || col === 'user_id') calls.from.push({ table, userId: val });
        return builder;
      };
      builder.maybeSingle = async () => ({ data: result(), error: null });
      builder.then = (res: (v: unknown) => unknown) => res({ data: result(), error: null });
      return builder;
    },
  }),
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: vi.fn(async () => new Set<string>()),
}));

async function fresh() {
  vi.resetModules();
  return import('./session');
}

beforeEach(() => {
  headerUserId = 'victim';
  cookieUser = 'attacker';
  rpcMode = 'answer';
  claimsMode = 'cookie';
  getUserMode = 'cookie';
  calls.rpc = 0;
  calls.getClaims = 0;
  calls.getUser = 0;
  calls.from = [];
  redirect.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a header naming someone other than the session is not a session', () => {
  it('spoofed header, session of another member: no session, and nothing read about the victim', async () => {
    const { getServerSession, requireOrgContext } = await fresh();
    expect(await getServerSession()).toBeNull();
    await expect(requireOrgContext()).rejects.toThrow('REDIRECT:/signin');
    expect(calls.from).toEqual([]);
  });

  it('spoofed header with no session cookie at all: no session', async () => {
    cookieUser = null;
    const { getServerSession } = await fresh();
    expect(await getServerSession()).toBeNull();
    expect(calls.from).toEqual([]);
  });

  it('no answer from get_request_context and verified claims for another user: no session', async () => {
    rpcMode = 'error';
    const { getServerSession } = await fresh();
    expect(await getServerSession()).toBeNull();
    expect(calls.getClaims).toBe(1);
    expect(calls.from).toEqual([]);
  });

  it('REQUEST_CONTEXT_RPC=off and verified claims for another user: no session', async () => {
    vi.stubEnv('REQUEST_CONTEXT_RPC', 'off');
    const { getServerSession } = await fresh();
    expect(await getServerSession()).toBeNull();
    expect(calls.rpc).toBe(0);
    expect(calls.from).toEqual([]);
  });

  it('no answer and no verifiable session (claims error, then Auth refuses): no session', async () => {
    rpcMode = 'error';
    claimsMode = 'error';
    getUserMode = 'error';
    const { getServerSession } = await fresh();
    expect(await getServerSession()).toBeNull();
    expect(calls.from).toEqual([]);
  });

  it('no answer, claims unverifiable, Auth server names another user: no session', async () => {
    rpcMode = 'error';
    claimsMode = 'throw';
    const { getServerSession } = await fresh();
    expect(await getServerSession()).toBeNull();
    expect(calls.getUser).toBe(1);
  });
});

describe('a header naming the session user is a session', () => {
  beforeEach(() => {
    headerUserId = 'victim';
    cookieUser = 'victim';
  });

  it('fast path: the answer confirms the header, with no extra verification call', async () => {
    const { requireOrgContext } = await fresh();
    const ctx = await requireOrgContext();
    expect(ctx.userId).toBe('victim');
    expect(ctx.organizationId).toBe(ORG);
    expect(ctx.role).toBe('owner');
    expect(calls.rpc).toBe(1);
    expect(calls.getClaims).toBe(0);
    expect(calls.getUser).toBe(0);
    expect(calls.from).toEqual([]);
  });

  it('no answer: verified claims that match let the legacy reads run', async () => {
    rpcMode = 'error';
    const { requireOrgContext } = await fresh();
    const ctx = await requireOrgContext();
    expect(ctx.userId).toBe('victim');
    expect(ctx.role).toBe('owner');
    expect(calls.getClaims).toBe(1);
    expect(calls.getUser).toBe(0);
    expect(calls.from.map((c) => c.userId)).toEqual(['victim', 'victim']);
  });

  it('no answer, claims unverifiable: the Auth server confirming the user is enough', async () => {
    rpcMode = 'error';
    claimsMode = 'throw';
    const { getServerSession } = await fresh();
    expect((await getServerSession())?.userId).toBe('victim');
    expect(calls.getUser).toBe(1);
  });
});
