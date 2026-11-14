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
   * The person's accepted memberships, oldest first. Unset: one membership,
   * in LEGACY_ORG_ID, with `role`. A read of organization_members that names
   * an organization answers the row for it, or no row; a read that names none
   * (the oldest membership) answers the first, or no row.
   */
  memberships: Array<{ organization_id: string; role: string }> | null;
  /** user_profiles.default_organization_id. */
  defaultOrganizationId: string | null;
  /** user_profiles.disabled_at. */
  disabledAt: string | null;
  /** The profile row reads back as absent with no error (no profile row). */
  profileMissing: boolean;
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
 * `malformed`, a row that carries none of the columns asked for.
 */
export type ReadFailure = 'error' | 'throws' | 'malformed';

/** A failed PostgREST read, as supabase-js resolves it (it does not throw). */
const READ_FAILED = { code: '57014', message: 'canceling statement due to statement timeout' };

type Answer = { data: unknown; error: unknown };

/** Text Postgres reads as a uuid (the canonical spelling; the double needs no other). */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filters a query was built with: `eq` column values and the selected columns. */
interface Chain {
  select: string;
  eq: Record<string, unknown>;
  ordered: boolean;
}

/** A chainable builder: every filter returns it, awaiting it answers `list`. */
function builder(list: (c: Chain) => Answer, single: (c: Chain) => Answer): unknown {
  const chain: Chain = { select: '', eq: {}, ordered: false };
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
        if (prop === 'order') chain.ordered = true;
        return proxy;
      };
    },
  });
  return proxy;
}

/** The answer of a read that does not answer, by how (see ReadFailure). */
function failedRead(how: ReadFailure): Answer {
  if (how === 'throws') throw new Error('fetch failed');
  if (how === 'malformed') return { data: { unexpected: true }, error: null };
  return { data: null, error: READ_FAILED };
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
      case 'organization_members':
        return {
          list: () => ({ data: [], error: null }),
          single: (c) => {
            const rows = world.memberships ?? [
              { organization_id: LEGACY_ORG_ID, role: world.role },
            ];
            const named = c.eq.organization_id;
            const fail = world.membershipReadFails;
            if (fail && named !== undefined && fail.read === 'named' && fail.orgId === named) {
              return failedRead(fail.how);
            }
            if (fail && named === undefined && fail.read === 'oldest') return failedRead(fail.how);
            // Postgres compares the column as a uuid: any other text is an error.
            if (named !== undefined && !UUID_TEXT.test(String(named))) {
              return {
                data: null,
                error: { code: '22P02', message: 'invalid input syntax for type uuid' },
              };
            }
            const row =
              named === undefined
                ? rows[0]
                : rows.find((r) => r.organization_id.toLowerCase() === String(named).toLowerCase());
            return { data: row ?? null, error: null };
          },
        };
      case 'user_profiles':
        return {
          list: () => ({ data: [], error: null }),
          single: (c) => {
            const fail = world.membershipReadFails;
            if (fail?.read === 'profile' && c.select.includes('default_organization_id')) {
              return failedRead(fail.how);
            }
            if (world.profileMissing) return { data: null, error: null };
            return {
              data: {
                id: LEGACY_USER_ID,
                default_organization_id: world.defaultOrganizationId,
                disabled_at: world.disabledAt,
              },
              error: null,
            };
          },
        };
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
