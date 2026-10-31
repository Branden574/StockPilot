import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const reportError = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { createClient } from '@supabase/supabase-js';

import {
  effectivePermissions,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@stockpilot/core';

import {
  loadEffectivePermissions,
  PermissionsUnavailableError,
  resetPermissionsReportThrottleForTests,
} from './effective-permissions';

/**
 * The legacy (no request-context bundle) resolver.
 *
 *   - Ordering visibility (migration 0413): orders:manage_catalog_visibility
 *     is platform-managed. The OWNER is no longer a zero-read short-circuit:
 *     an explicit deny from StockPilot support takes the key from them too,
 *     so their own rows for the platform-managed keys are read (one query,
 *     nothing else).
 *   - A failed read REFUSES everyone but the owner (docket S19). Without the
 *     override rows nobody can tell which permissions the organization took
 *     away, and the role's defaults would hand every one of them back for
 *     that request. The owner keeps every key except the platform-managed
 *     ones, the org's lockout escape hatch.
 */

const KEY: Permission = 'orders:manage_catalog_visibility';
const ORG = 'org-1';
const USER = 'user-1';
/** Stands for the PostgREST message, which can quote request details. */
const SECRET = 'relation secret-detail is not readable';
const UNAVAILABLE = { name: 'PermissionsUnavailableError', code: 'PERMISSIONS_UNAVAILABLE' };

interface Read {
  /** The rows, or anything else an answer can carry (a test of the list check). */
  data: Array<{ permission: string; granted: boolean }> | null | Record<string, unknown>;
  error: { message: string; code?: string } | null;
  /** The HTTP status postgrest-js answers with. */
  status?: number;
}
/** A read whose promise rejects: the request itself threw. */
interface Rejection {
  reject: unknown;
}
const reads: Record<string, Read | Rejection> = {};
const calls: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];

function client() {
  return {
    from: (table: string) => {
      const call = { table, filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => (call.filters.push(['eq', col, val]), q);
      q.in = (col: string, val: unknown) => (call.filters.push(['in', col, val]), q);
      q.then = (resolve: (v: Read) => unknown, reject?: (e: unknown) => unknown) => {
        const read = reads[table] ?? { data: [], error: null };
        return ('reject' in read ? Promise.reject(read.reject) : Promise.resolve(read)).then(
          resolve,
          reject,
        );
      };
      return q;
    },
  };
}

/** Settles the loader either way, so a test can say what it must NOT answer. */
function settle(role: Role) {
  return loadEffectivePermissions(client(), ORG, USER, role).then(
    (perms) => ({ perms, error: null as unknown }),
    (error: unknown) => ({ perms: null, error }),
  );
}

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  calls.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('loadEffectivePermissions: the owner', () => {
  it('reads ONLY their own rows for the platform-managed keys, and keeps every key without a deny', async () => {
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms).toEqual(effectivePermissions('owner'));
    expect(calls).toEqual([
      {
        table: 'user_permission_overrides',
        filters: [
          ['eq', 'organization_id', ORG],
          ['eq', 'user_id', USER],
          ['in', 'permission', [KEY]],
        ],
      },
    ]);
  });

  it('an explicit deny from StockPilot takes the key from the owner, and nothing else', async () => {
    reads.user_permission_overrides = { data: [{ permission: KEY, granted: false }], error: null };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.has(KEY)).toBe(false);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });

  it('never applies an owner row for any other key, even if one came back', async () => {
    reads.user_permission_overrides = {
      data: [
        { permission: 'billing:manage', granted: false },
        { permission: KEY, granted: true },
      ],
      error: null,
    };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'owner')).size).toBe(
      PERMISSIONS.length,
    );
  });

  it('a failed read fails closed for the platform-managed key only', async () => {
    reads.user_permission_overrides = { data: null, error: { message: 'timeout' } };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.has(KEY)).toBe(false);
    expect(perms.has('billing:manage')).toBe(true);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });

  it('a read whose promise rejects never refuses the owner either: every key but the platform-managed one', async () => {
    reads.user_permission_overrides = { reject: new TypeError('fetch failed') };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.has(KEY)).toBe(false);
    expect(perms.has('billing:manage')).toBe(true);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });
});

describe('loadEffectivePermissions: every other role', () => {
  it('a manager holds the key by default and loses it to an explicit deny', async () => {
    expect((await loadEffectivePermissions(client(), ORG, USER, 'manager')).has(KEY)).toBe(true);
    reads.user_permission_overrides = { data: [{ permission: KEY, granted: false }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'manager')).has(KEY)).toBe(false);
  });

  it('a role row for the key is ignored (only StockPilot sets it, per member)', async () => {
    reads.role_permission_overrides = { data: [{ permission: KEY, granted: true }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'staff')).has(KEY)).toBe(false);
    reads.role_permission_overrides = { data: [{ permission: KEY, granted: false }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'manager')).has(KEY)).toBe(true);
  });

  it('an explicit allow gives a staff member the key', async () => {
    reads.user_permission_overrides = { data: [{ permission: KEY, granted: true }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'staff')).has(KEY)).toBe(true);
  });
});

describe('loadEffectivePermissions: a failed read refuses everyone but the owner (docket S19)', () => {
  it.each(['admin', 'manager', 'staff', 'viewer'] as const)(
    '%s: a user override read that answers an error refuses the request, never the role defaults',
    async (role) => {
      reads.user_permission_overrides = {
        data: null,
        error: { message: SECRET, code: '57014' },
        status: 500,
      };
      const { perms, error } = await settle(role);
      expect(perms).toBeNull();
      expect(error).toMatchObject(UNAVAILABLE);
    },
  );

  it('a staff member whose stock:adjust was revoked does not get it back when the role read fails', async () => {
    // The default the old fallback handed back for the request.
    expect(ROLE_PERMISSIONS.staff).toContain('stock:adjust');
    reads.user_permission_overrides = {
      data: [{ permission: 'stock:adjust', granted: false }],
      error: null,
    };
    reads.role_permission_overrides = {
      data: null,
      error: { message: SECRET, code: '' },
      status: 502,
    };
    const { perms, error } = await settle('staff');
    expect(perms?.has('stock:adjust') ?? false).toBe(false);
    expect(perms).toBeNull();
    expect(error).toMatchObject(UNAVAILABLE);
  });

  it('a read whose promise rejects (the request threw) is refused the same way', async () => {
    reads.role_permission_overrides = { reject: new TypeError(`fetch failed: ${SECRET}`) };
    const { perms, error } = await settle('manager');
    expect(perms).toBeNull();
    expect(error).toMatchObject(UNAVAILABLE);
  });

  it('a client that throws before a read is even sent is refused the same way', async () => {
    const broken = {
      from: () => {
        throw new Error(SECRET);
      },
    };
    await expect(loadEffectivePermissions(broken, ORG, USER, 'viewer')).rejects.toMatchObject(
      UNAVAILABLE,
    );
  });

  it('both reads answering still gives the effective set (the success path is unchanged)', async () => {
    reads.role_permission_overrides = {
      data: [{ permission: 'items:create', granted: false }],
      error: null,
    };
    reads.user_permission_overrides = {
      data: [{ permission: 'members:invite', granted: true }],
      error: null,
    };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'manager');
    expect(perms.has('items:create')).toBe(false);
    expect(perms.has('members:invite')).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('PermissionsUnavailableError', () => {
  it('is a plain Error with a fixed message: never a ServiceError, whose forbidden would answer 403', async () => {
    const e = new PermissionsUnavailableError();
    expect(e).toBeInstanceOf(Error);
    // A DIRECT subclass of Error. A ServiceError('forbidden') would answer 403
    // and read as a revoke; this is a fault, answered as one (a 5xx).
    expect(Object.getPrototypeOf(PermissionsUnavailableError.prototype)).toBe(Error.prototype);
    expect(e.name).toBe('PermissionsUnavailableError');
    expect(e.code).toBe('PERMISSIONS_UNAVAILABLE');
    expect(e.message).toBe('Your permissions could not be checked. Please try again.');

    reads.role_permission_overrides = { data: null, error: { message: SECRET }, status: 500 };
    await expect(loadEffectivePermissions(client(), ORG, USER, 'manager')).rejects.toBeInstanceOf(
      PermissionsUnavailableError,
    );
  });
});

describe('loadEffectivePermissions: a refusal is logged every time and reported at most once a minute', () => {
  const T0 = new Date('2026-10-31T10:00:00Z').getTime();
  const lines = () => vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' '));

  beforeEach(() => {
    resetPermissionsReportThrottleForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the first failure with codes only, logs each one, and reports again after a minute', async () => {
    reads.role_permission_overrides = {
      data: null,
      error: { message: SECRET, code: '42501' },
      status: 403,
    };
    const first = await settle('manager');
    expect(first.error).toMatchObject(UNAVAILABLE);

    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0]!;
    expect(context).toEqual({
      tag: 'auth.permissions.read',
      organizationId: ORG,
      extra: { table: 'role_permission_overrides', code: '42501', status: 403, role: 'manager' },
    });
    // Codes only: the PostgREST message is in neither the report...
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('secret-detail');
    expect((reported as Error).message).not.toContain('secret-detail');
    expect(String((reported as Error).stack)).not.toContain('secret-detail');
    // ...nor the refusal the caller gets.
    const refusal = first.error as Error;
    expect(refusal.message).toBe('Your permissions could not be checked. Please try again.');
    expect(String(refusal.stack)).not.toContain('secret-detail');
    expect(refusal.cause).toBeUndefined();
    expect(JSON.stringify(refusal)).not.toContain('secret-detail');

    // One console line per failure: the table, the code and the status.
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('[loadEffectivePermissions]');
    expect(lines()[0]).toContain('role_permission_overrides');
    expect(lines()[0]).toContain('42501');
    expect(lines()[0]).toContain('403');
    expect(lines()[0]).not.toContain('secret-detail');

    // A second failure inside the minute: logged, not reported.
    vi.setSystemTime(T0 + 59_999);
    expect((await settle('staff')).error).toMatchObject(UNAVAILABLE);
    expect(lines()).toHaveLength(2);
    expect(reportError).toHaveBeenCalledTimes(1);

    // A minute after the report: reported again.
    vi.setSystemTime(T0 + 60_000);
    expect((await settle('viewer')).error).toMatchObject(UNAVAILABLE);
    expect(lines()).toHaveLength(3);
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError.mock.calls[1]![1]).toMatchObject({ extra: { role: 'viewer' } });
  });

  it('a read that threw is reported as such, with no status and nothing of its message', async () => {
    reads.user_permission_overrides = { reject: new TypeError(`fetch failed: ${SECRET}`) };
    expect((await settle('staff')).error).toMatchObject(UNAVAILABLE);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'auth.permissions.read',
      organizationId: ORG,
      extra: { table: 'user_permission_overrides', code: 'threw', status: null, role: 'staff' },
    });
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('secret-detail');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain('secret-detail');
  });

  it('when both reads fail, the line names both and the report the first', async () => {
    reads.role_permission_overrides = {
      data: null,
      error: { message: SECRET, code: '' },
      status: 0,
    };
    reads.user_permission_overrides = {
      data: null,
      error: { message: SECRET, code: 'PGRST301' },
      status: 401,
    };
    expect((await settle('admin')).error).toMatchObject(UNAVAILABLE);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('role_permission_overrides');
    expect(lines()[0]).toContain('user_permission_overrides');
    expect(lines()[0]).toContain('PGRST301');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      extra: { table: 'role_permission_overrides', code: 'unknown', status: 0, role: 'admin' },
    });
  });

  it('an owner whose read fails is neither refused nor reported (the owner path is unchanged)', async () => {
    reads.user_permission_overrides = {
      data: null,
      error: { message: SECRET, code: '57014' },
      status: 500,
    };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.size).toBe(PERMISSIONS.length - 1);
    expect(reportError).not.toHaveBeenCalled();
  });
});

/**
 * An answer with no error that is not a list of rows (docket S19 review).
 * postgrest-js resolves an empty body with `data: null` and `error: null`: on
 * a 2xx as it came, and on a 404 with the status rewritten to 204. Read as
 * "no overrides", either one handed a member their role's defaults back, the
 * failure this loader exists to refuse, with no line and no report. It is a
 * failed read like any other. (A 404 carrying `[]` arrives as an ordinary
 * empty list with status 200, which no check here can tell from "no rows".)
 * The request-context bundle parser already refuses any override value that is
 * not a list.
 */
describe('loadEffectivePermissions: an answer that is not a list is a failed read', () => {
  const NOT_A_LIST = [
    ['an empty 2xx body', { data: null, error: null, status: 200 }],
    ['an empty 404 body (status rewritten to 204)', { data: null, error: null, status: 204 }],
    [
      'a JSON object',
      { data: { permission: 'stock:adjust', granted: false }, error: null, status: 200 },
    ],
  ] as const;

  it.each(NOT_A_LIST)(
    '%s from the user override read refuses a staff member whose stock:adjust was revoked, never the role defaults',
    async (_shape, answer) => {
      expect(ROLE_PERMISSIONS.staff).toContain('stock:adjust');
      reads.user_permission_overrides = { ...answer };
      const { perms, error } = await settle('staff');
      expect(perms).toBeNull();
      expect(error).toMatchObject(UNAVAILABLE);
    },
  );

  it.each(NOT_A_LIST)(
    '%s from the role override read refuses the same way',
    async (_shape, answer) => {
      reads.role_permission_overrides = { ...answer };
      const { perms, error } = await settle('manager');
      expect(perms).toBeNull();
      expect(error).toMatchObject(UNAVAILABLE);
    },
  );

  it('is logged and reported like any failed read, with the code "unexpected" and the status', async () => {
    resetPermissionsReportThrottleForTests();
    reads.role_permission_overrides = { data: null, error: null, status: 204 };
    expect((await settle('manager')).error).toMatchObject(UNAVAILABLE);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'auth.permissions.read',
      organizationId: ORG,
      extra: {
        table: 'role_permission_overrides',
        code: 'unexpected',
        status: 204,
        role: 'manager',
      },
    });
    const line = vi.mocked(console.error).mock.calls.map((c) => c.map(String).join(' '));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('role_permission_overrides code=unexpected status=204');
  });

  it('the owner: an answer that is not a list closes the platform-managed key, like a failed read', async () => {
    reads.user_permission_overrides = { data: null, error: null, status: 204 };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.has(KEY)).toBe(false);
    expect(perms.has('billing:manage')).toBe(true);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });

  it('an empty list is still "no overrides": the role defaults, for the owner and everyone else', async () => {
    reads.role_permission_overrides = { data: [], error: null, status: 200 };
    reads.user_permission_overrides = { data: [], error: null, status: 200 };
    expect(await loadEffectivePermissions(client(), ORG, USER, 'staff')).toEqual(
      effectivePermissions('staff'),
    );
    expect(await loadEffectivePermissions(client(), ORG, USER, 'owner')).toEqual(
      effectivePermissions('owner'),
    );
  });
});

/**
 * The same answers through a real supabase-js client (its own postgrest-js),
 * so the shapes above are the library's, not a guess. The fetch is local: no
 * request leaves the test.
 */
describe('loadEffectivePermissions through a real supabase-js client', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  /** The role read answers no rows; the user read answers `userAnswer()`. */
  function realClient(userAnswer: () => Response) {
    return createClient('https://supabase.example.test', 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          return url.pathname.endsWith('/user_permission_overrides') ? userAnswer() : json([]);
        },
      },
    });
  }

  it.each([
    ['a 404 with an empty body', () => new Response('', { status: 404 })],
    ['a 200 with an empty body', () => new Response('', { status: 200 })],
  ])('%s is refused, never read as "no overrides"', async (_shape, userAnswer) => {
    await expect(
      loadEffectivePermissions(realClient(userAnswer), ORG, USER, 'staff'),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it('a list answer gives the effective set, the revoke applied', async () => {
    const perms = await loadEffectivePermissions(
      realClient(() => json([{ permission: 'stock:adjust', granted: false }])),
      ORG,
      USER,
      'staff',
    );
    expect(perms.has('stock:adjust')).toBe(false);
    expect(perms.has('items:read')).toBe(true);
  });
});
