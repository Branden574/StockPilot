/**
 * A Supabase client double that sends withApiContext down its LEGACY reads
 * (get_request_context() answers an error), so a route test can run the real
 * context loader and the real route together.
 *
 * Each test file still declares its own module mocks, because vitest hoists
 * vi.mock per file:
 *
 *   const refs = vi.hoisted(() => ({ client: null as unknown }));
 *   vi.mock('@/lib/env', () => ({ env: LEGACY_CONTEXT_ENV }));  // inline the values
 *   vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
 *
 * and sets `refs.client = legacyContextClient(world)` before each request.
 *
 * Every table answers an empty list (or no row for a single read) unless the
 * world says otherwise, and every call is recorded in `world.calls`, so a test
 * can show that a refused request reached no table past the context reads.
 * Made-up ids and addresses only.
 */

export const LEGACY_USER_ID = '99999999-0000-4000-8000-000000000001';
export const LEGACY_ORG_ID = '88888888-0000-4000-8000-000000000002';

export interface LegacyContextWorld {
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  /** The explicit enabled rows organization_modules answers when it is read. */
  moduleRows: string[];
  /** organization_modules answers an error instead of its rows. */
  moduleRowsFail: boolean;
  /**
   * organization_modules answers neither a list nor an error: what
   * postgrest-js resolves for an empty-bodied 2xx, or a 404 it rewrites to 204.
   */
  moduleRowsNoList: boolean;
  /** organization_modules answers a list with a row that carries no module id. */
  moduleRowsMalformed: boolean;
  /** organizations.all_modules_comp when the organizations row is read. */
  comped: boolean;
  /** The organizations row read answers an error (MFA policy and comp flag). */
  organizationFail: boolean;
  /** The organizations row reads back as absent with no error (row level security hid it). */
  organizationHidden: boolean;
  /** The organizations row reads back without a boolean comp flag. */
  organizationNoComp: boolean;
  /**
   * The person's memberships, oldest first. Unset: one membership, in
   * LEGACY_ORG_ID, with `role`. `accepted: false` is an invite not yet
   * accepted, which a read filtered to accepted rows does not see. A read of
   * organization_members that names an organization answers the row for it,
   * or no row; a read that names none (the oldest membership) answers the
   * first, or no row.
   */
  memberships: Array<{ organization_id: string; role: string; accepted?: boolean }> | null;
  /** user_profiles.default_organization_id. */
  defaultOrganizationId: string | null;
  /** user_profiles.disabled_at. */
  disabledAt: string | null;
  /** The profile row reads back as absent with no error (no profile row). */
  profileMissing: boolean;
  /** The account-status read of the profile row (disabled_at) answers an error. */
  accountStatusFails: boolean;
  /**
   * One membership choice read that does not answer (lib/auth/api-context.ts
   * pickActiveMembership): the membership read that names this organization
   * (the header's, or the default's), the oldest-membership read, or the
   * profile's default-organization read. The account-status read of the same
   * profile row still answers.
   */
  membershipReadFails: {
    read: 'named' | 'oldest' | 'profile';
    orgId?: string;
    how: ReadFailure;
  } | null;
  /** Single-row answers for other tables, by table name. */
  singles: Record<string, unknown>;
  /** List answers for other tables, by table name. */
  lists: Record<string, unknown[]>;
  /** Every table read (`from:<table>`) and RPC (`rpc:<name>`), in order. */
  calls: string[];
}

export function legacyContextWorld(over: Partial<LegacyContextWorld> = {}): LegacyContextWorld {
  return {
    role: 'admin',
    moduleRows: [],
    moduleRowsFail: false,
    moduleRowsNoList: false,
    moduleRowsMalformed: false,
    comped: false,
    organizationFail: false,
    organizationHidden: false,
    organizationNoComp: false,
    memberships: null,
    defaultOrganizationId: LEGACY_ORG_ID,
    disabledAt: null,
    profileMissing: false,
    accountStatusFails: false,
    membershipReadFails: null,
    singles: {},
    lists: {},
    calls: [],
    ...over,
  };
}

/**
 * How a read does not answer: `error`, a failed PostgREST read as supabase-js
 * resolves it (it does not throw); `throws`, the call itself rejects;
 * `malformed`, a row that carries none of the columns asked for. The other
 * three are answers with neither rows nor an error, as postgrest-js resolves
 * them: `no_body`, a 2xx with an empty body or the body `null` (status 200);
 * `gateway_no_body`, a 404 with an empty body (rewritten to 204);
 * `null_error`, a non-2xx whose body is JSON `null` (a falsy error).
 */
export type ReadFailure =
  'error' | 'throws' | 'malformed' | 'no_body' | 'gateway_no_body' | 'null_error';

/** Every ReadFailure, for tests that try each. */
export const READ_FAILURES: readonly ReadFailure[] = [
  'error',
  'throws',
  'malformed',
  'no_body',
  'gateway_no_body',
  'null_error',
];

/** A failed PostgREST read, as supabase-js resolves it (it does not throw). */
const READ_FAILED = { code: '57014', message: 'canceling statement due to statement timeout' };

type Answer = { data: unknown; error: unknown; status?: number };

/** Text Postgres reads as a uuid (the canonical spelling; the double needs no other). */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filters a query was built with: `eq` column values, `not` columns and the selected columns. */
interface Chain {
  select: string;
  eq: Record<string, unknown>;
  not: string[];
  ordered: boolean;
}

/** A chainable builder: every filter returns it, awaiting it answers `list`. */
function builder(list: (c: Chain) => Answer, single: (c: Chain) => Answer): unknown {
  const chain: Chain = { select: '', eq: {}, not: [], ordered: false };
  const target = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(list(chain)).then(resolve, reject);
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return async () => single(chain);
      }
      if (typeof prop === 'symbol') return undefined;
      return (...args: unknown[]) => {
        if (prop === 'select') chain.select = String(args[0] ?? '');
        if (prop === 'eq') chain.eq[String(args[0])] = args[1];
        if (prop === 'not') chain.not.push(String(args[0]));
        if (prop === 'order') chain.ordered = true;
        return proxy;
      };
    },
  });
  return proxy;
}

/**
 * The answer of a read that does not answer, by how (see ReadFailure), as a
 * list read (`then`) or a single-row read (`maybeSingle`) resolves it.
 */
function failedRead(how: ReadFailure, shape: 'list' | 'single'): Answer {
  switch (how) {
    case 'throws':
      throw new Error('fetch failed');
    case 'malformed':
      return shape === 'list'
        ? { data: [{ unexpected: true }], error: null, status: 200 }
        : { data: { unexpected: true }, error: null, status: 200 };
    case 'no_body':
      return { data: null, error: null, status: 200 };
    case 'gateway_no_body':
      return { data: null, error: null, status: 204 };
    case 'null_error':
      return { data: null, error: null, status: 502 };
    default:
      return { data: null, error: READ_FAILED, status: 500 };
  }
}

export function legacyContextClient(world: LegacyContextWorld) {
  const answerFor = (
    table: string,
  ): { list: (c: Chain) => Answer; single: (c: Chain) => Answer } => {
    switch (table) {
      case 'organization_modules':
        return {
          list: () =>
            world.moduleRowsFail
              ? { data: null, error: READ_FAILED }
              : world.moduleRowsNoList
                ? { data: null, error: null }
                : {
                    data: [
                      ...world.moduleRows.map((module_id) => ({ module_id })),
                      ...(world.moduleRowsMalformed ? [{ module_id: null }] : []),
                    ],
                    error: null,
                  },
          single: () => ({ data: null, error: null }),
        };
      case 'organizations': {
        const row = world.organizationNoComp
          ? { mfa_policy: 'optional' }
          : { mfa_policy: 'optional', all_modules_comp: world.comped };
        return {
          list: () =>
            world.organizationFail
              ? { data: null, error: READ_FAILED }
              : { data: world.organizationHidden ? [] : [row], error: null },
          single: () =>
            world.organizationFail
              ? { data: null, error: READ_FAILED }
              : { data: world.organizationHidden ? null : row, error: null },
        };
      }
      case 'organization_members': {
        // The membership choice reads only accepted rows; any other read of
        // this table (a route's own) answers an empty list, as before.
        const choice = (c: Chain, shape: 'list' | 'single'): Answer => {
          const all = world.memberships ?? [{ organization_id: LEGACY_ORG_ID, role: world.role }];
          const rows = all
            .filter((r) => !c.not.includes('accepted_at') || r.accepted !== false)
            .map(({ organization_id, role }) => ({ organization_id, role }));
          const named = c.eq.organization_id;
          const fail = world.membershipReadFails;
          if (fail && named !== undefined && fail.read === 'named' && fail.orgId === named) {
            return failedRead(fail.how, shape);
          }
          if (fail && named === undefined && fail.read === 'oldest') {
            return failedRead(fail.how, shape);
          }
          // Postgres compares the column as a uuid: any other text is an error.
          if (named !== undefined && !UUID_TEXT.test(String(named))) {
            return {
              data: null,
              error: { code: '22P02', message: 'invalid input syntax for type uuid' },
              status: 400,
            };
          }
          const row =
            named === undefined
              ? rows[0]
              : rows.find((r) => r.organization_id.toLowerCase() === String(named).toLowerCase());
          return shape === 'list'
            ? { data: row ? [row] : [], error: null, status: 200 }
            : { data: row ?? null, error: null, status: 200 };
        };
        return {
          list: (c) =>
            c.not.includes('accepted_at') ? choice(c, 'list') : { data: [], error: null },
          single: (c) => choice(c, 'single'),
        };
      }
      case 'user_profiles': {
        const profile = (c: Chain, shape: 'list' | 'single'): Answer => {
          const fail = world.membershipReadFails;
          if (fail?.read === 'profile' && c.select.includes('default_organization_id')) {
            return failedRead(fail.how, shape);
          }
          if (world.accountStatusFails && c.select.includes('disabled_at')) {
            return failedRead('error', shape);
          }
          const row = {
            id: LEGACY_USER_ID,
            default_organization_id: world.defaultOrganizationId,
            disabled_at: world.disabledAt,
          };
          if (shape === 'list') {
            return { data: world.profileMissing ? [] : [row], error: null, status: 200 };
          }
          return { data: world.profileMissing ? null : row, error: null, status: 200 };
        };
        return {
          // The profile's default-organization read; any other list read of
          // this table answers an empty list, as before.
          list: (c) =>
            c.select.includes('default_organization_id')
              ? profile(c, 'list')
              : { data: [], error: null },
          single: (c) => profile(c, 'single'),
        };
      }
      default:
        return {
          list: () => ({ data: world.lists[table] ?? [], error: null }),
          single: () => ({ data: world.singles[table] ?? null, error: null }),
        };
    }
  };

  return {
    from(table: string) {
      world.calls.push(`from:${table}`);
      const { list, single } = answerFor(table);
      return builder(list, single);
    },
    async rpc(name: string) {
      world.calls.push(`rpc:${name}`);
      // The one-round-trip context read fails, so the legacy reads run.
      return { data: null, error: { code: 'PGRST301', message: 'unavailable' } };
    },
    auth: {
      getUser: async () => ({
        data: { user: { id: LEGACY_USER_ID, email: 'member@example.com', factors: [] } },
        error: null,
      }),
    },
  };
}

const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** The bearer token a phone sends: only its shape matters to the double. */
export function legacyBearerToken(): string {
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: LEGACY_USER_ID, aal: 'aal1' })}.sig`;
}

/** Headers a phone sends with every /api/v1 call. */
export function legacyPhoneHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${legacyBearerToken()}`,
    'x-organization-id': LEGACY_ORG_ID,
    ...extra,
  };
}

/** Tables a context build reads; anything else in `calls` is the route's own work. */
export const CONTEXT_TABLES = new Set([
  'from:organization_members',
  'from:user_profiles',
  'from:organizations',
  'from:organization_modules',
  'from:role_permission_overrides',
  'from:user_permission_overrides',
  'rpc:get_request_context',
]);

/** The calls a request made beyond building its context. */
export function routeWork(world: LegacyContextWorld): string[] {
  return world.calls.filter((c) => !CONTEXT_TABLES.has(c));
}
