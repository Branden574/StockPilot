import 'server-only';

import {
  effectivePermissions,
  isPlatformManagedPermission,
  PLATFORM_MANAGED_PERMISSIONS,
  withoutPlatformManaged,
  type Permission,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';

/**
 * Minimal shape we need from any (cookie- or bearer-bound) Supabase client.
 * Loosely typed (`from` returns `any`) on purpose: the project's generated
 * Database type is `any`, and a precise PostgrestFilterBuilder shape here both
 * fails to match the real client and trips TS's "excessively deep" guard.
 */
interface QueryableClient {
  from: (table: string) => any;
}

/**
 * Thrown when a member's permission overrides could not be read, so the
 * request is refused (docket S19).
 *
 * A plain Error on purpose, shaped like AccountStatusUnavailableError:
 *   - never a ServiceError('forbidden'): that answers 403, which the phone
 *     words as "You do not have access to that." and a person reads as a
 *     revoke;
 *   - never a redirect(): the /api routes share this loader, and a redirect
 *     there is a NEXT_REDIRECT 500 (recurring pattern #23).
 * Escaping produces a 5xx, which the phone words as "The server had a
 * problem. Try again in a moment." and keeps its last good permission set,
 * and which the web error boundaries render as a retryable error.
 */
export class PermissionsUnavailableError extends Error {
  readonly code = 'PERMISSIONS_UNAVAILABLE';

  constructor() {
    super('Your permissions could not be checked. Please try again.');
    this.name = 'PermissionsUnavailableError';
  }
}

/**
 * Resolves a member's EFFECTIVE permission set = static role defaults
 * (ROLE_PERMISSIONS) with org-level role overrides and per-user overrides
 * applied (last wins). The SQL twin is public.has_permission() (migration
 * 0207), used by RLS; this is the app-layer gate consulted by `can(ctx, …)`.
 *
 * Only the backup path reaches it: session.ts resolvePermissions and
 * withApiContext call it when get_request_context() gave no usable answer.
 * Normal requests take their overrides from that one round trip instead.
 *
 * FAILS CLOSED for everyone but the owner (docket S19). When either override
 * read fails, this reports it and throws PermissionsUnavailableError: the
 * request is refused. It used to answer with the role's static defaults,
 * which lifts every revoke the organization set and drops every extra grant
 * for that request, and one fault that fails every override read (a lost
 * grant, say) also breaks get_request_context() for everyone, so it lifted
 * every revoke in every organization at once with only a console line to show
 * for it. For about 30 keys the app gate is the only barrier on every path
 * checked, and on several of them the work after the gate runs with the
 * service role or calls an outside service, so nothing behind the gate would
 * refuse instead.
 *
 * Recurring pattern #1 (a read that fails returns a safe default) does NOT
 * apply to an authorization input: no default is safe. The role's defaults
 * hand every revoke back; an empty set reads as one ("Missing permission");
 * and every key but a platform-managed one can be revoked for every non-owner
 * role, so no "minimum" set exists either. Do not turn this back into a
 * fallback. The sibling inputs already refuse the same way: an unreadable
 * account status and an unreadable organization row throw (account-status.ts,
 * request-cache.ts).
 *
 * Owner: every permission, except a platform-managed key StockPilot support
 * explicitly denied to them. Only those rows are read (one query). On a failed
 * read the owner keeps every key except the platform-managed ones, and the
 * request goes on: the owner stays the org's lockout escape hatch for every key
 * an org editor can touch, and that set holds nothing an owner could have lost.
 */
export async function loadEffectivePermissions(
  supabase: QueryableClient,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<Set<Permission>> {
  if (role === 'owner') return loadOwnerPermissions(supabase, organizationId, userId);
  const [roleRead, userRead] = await Promise.all([
    readOverrides('role_permission_overrides', () =>
      supabase
        .from('role_permission_overrides')
        .select('permission, granted')
        .eq('organization_id', organizationId)
        .eq('role', role),
    ),
    readOverrides('user_permission_overrides', () =>
      supabase
        .from('user_permission_overrides')
        .select('permission, granted')
        .eq('organization_id', organizationId)
        .eq('user_id', userId),
    ),
  ]);
  if (!roleRead.ok || !userRead.ok) {
    refuse(
      [roleRead, userRead].flatMap((read) => (read.ok ? [] : [read.failure])),
      organizationId,
      role,
    );
  }
  return effectivePermissions(role, roleRead.rows, userRead.rows);
}

type OverrideTable = 'role_permission_overrides' | 'user_permission_overrides';

/** Codes only: the PostgREST message can quote request details. */
interface FailedRead {
  table: OverrideTable;
  /** The PostgREST code ('unknown' when it gave none), or 'threw' when the request threw. */
  code: string;
  /** The HTTP status (0 when the request got no answer), or null when it threw. */
  status: number | null;
}

type OverrideRead = { ok: true; rows: PermissionOverride[] } | { ok: false; failure: FailedRead };

/** One override read. Never rejects: a thrown request is a failure like any other. */
async function readOverrides(
  table: OverrideTable,
  query: () => PromiseLike<{ data: unknown; error: { code?: string } | null; status?: number }>,
): Promise<OverrideRead> {
  try {
    const { data, error, status } = await query();
    if (error) {
      return {
        ok: false,
        failure: {
          table,
          code: error.code || 'unknown',
          status: typeof status === 'number' ? status : null,
        },
      };
    }
    return { ok: true, rows: (data ?? []) as PermissionOverride[] };
  } catch {
    return { ok: false, failure: { table, code: 'threw', status: null } };
  }
}

/**
 * At most one report per this many milliseconds per server instance.
 * reportError neither dedupes nor rate-limits, and one fault that fails every
 * override read fails every non-owner request; the snapshot route also
 * reports its own uncaught error. Every failure still writes a console line.
 */
const REPORT_INTERVAL_MS = 60_000;
let lastReportAt: number | null = null;

/** Test hook: forget when the last report went out. */
export function resetPermissionsReportThrottleForTests(): void {
  lastReportAt = null;
}

function refuse(failures: FailedRead[], organizationId: string, role: Role): never {
  // One line per refused request, naming each failed read.
  console.error(
    '[loadEffectivePermissions] override read failed, request refused:',
    failures.map((f) => `${f.table} code=${f.code} status=${f.status ?? 'none'}`).join('; '),
  );
  const now = Date.now();
  const sinceLast = lastReportAt === null ? null : now - lastReportAt;
  if (sinceLast === null || sinceLast < 0 || sinceLast >= REPORT_INTERVAL_MS) {
    lastReportAt = now;
    const first = failures[0];
    void reportError(new Error('Permission overrides could not be read; the request was refused'), {
      tag: 'auth.permissions.read',
      organizationId,
      extra: { table: first?.table, code: first?.code, status: first?.status, role },
    });
  }
  throw new PermissionsUnavailableError();
}

async function loadOwnerPermissions(
  supabase: QueryableClient,
  organizationId: string,
  userId: string,
): Promise<Set<Permission>> {
  try {
    const { data, error } = await supabase
      .from('user_permission_overrides')
      .select('permission, granted')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      // in-list-bound: the platform-managed keys (one today)
      .in('permission', [...PLATFORM_MANAGED_PERMISSIONS]);
    if (error) throw error;
    const rows = ((data ?? []) as PermissionOverride[]).filter((r) =>
      isPlatformManagedPermission(r.permission),
    );
    return effectivePermissions('owner', [], rows);
  } catch (err) {
    console.error('[loadEffectivePermissions] owner exception read failed, closed for platform-managed keys:', err);
    return withoutPlatformManaged(effectivePermissions('owner'));
  }
}
