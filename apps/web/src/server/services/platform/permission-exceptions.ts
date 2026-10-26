import 'server-only';

import {
  isPlatformManagedPermission,
  ORDER_CATALOG_VISIBILITY_PERMISSION,
  PERMISSION_EXCEPTION_STATES,
  permissionExceptionFromGranted,
  ROLES,
  type PermissionExceptionState,
  type PlatformManagedPermission,
  type Role,
} from '@stockpilot/core';

import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { reportError } from '@/lib/error-reporter';
import { effectiveModules } from '@/lib/modules/effective-modules';
import { broadcastPermissionsChanged } from '@/lib/realtime/broadcast';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * StockPilot support's per-member exceptions for a PLATFORM-MANAGED permission
 * (today only orders:manage_catalog_visibility, migration 0413): Follow role
 * default, Allow or Deny, set from the God Admin console's Users tab.
 *
 * THE ONE CALLER of public.platform_set_permission_exception (a guard test
 * pins it). That function is SECURITY DEFINER with EXECUTE for the service
 * role only, and the database cannot see the platform allowlist (a server
 * env), so this service is where "is this actor a platform admin" is decided:
 *
 *   - the action above runs checkPlatformAdmin({ requireStepUp: true }) (AAL2
 *     and a fresh step-up, which only the session can prove);
 *   - this service does NOT trust that it ran: it re-resolves the actor's
 *     VERIFIED email from GoTrue and re-checks the allowlist, and hands the
 *     function that verified email for both audit rows (never an email the
 *     caller passed, never user_profiles.email, which its owner can edit).
 *
 * The function does the rest in one transaction: compare-and-set on the
 * expected state (a stale console row is a conflict, never "not authorized"),
 * the write, and both audit rows (platform_admin_audit and the target org's
 * audit_logs). A repeat of the current state writes nothing and pings nobody.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

export interface SetPermissionExceptionInput {
  organizationId: string;
  targetUserId: string;
  /** Defaults to orders:manage_catalog_visibility. */
  permission?: string;
  state: string;
  /** What the console showed: the compare-and-set. */
  expectedState: string;
  /** The session user the action verified; re-verified here. */
  actorUserId: string;
}

export type PermissionExceptionInvalidField = 'permission' | 'state' | 'expectedState' | 'target';

export type SetPermissionExceptionResult =
  | {
      ok: true;
      before: PermissionExceptionState;
      after: PermissionExceptionState;
      targetRole: Role;
      /** False when the state already was the one asked for (nothing written). */
      changed: boolean;
    }
  | { ok: false; code: 'not_authorized' }
  /** Someone changed the exception first; `current` is what it is now (null when unreadable). */
  | { ok: false; code: 'changed'; current: PermissionExceptionState | null }
  | { ok: false; code: 'member_not_found' }
  | { ok: false; code: 'invalid'; field: PermissionExceptionInvalidField }
  /** Another save for the same member held the row past the 3 s lock wait. */
  | { ok: false; code: 'busy' }
  | { ok: false; code: 'internal' };

/** One member's row in the console's Users tab. */
export interface PermissionExceptionMember {
  exception: PermissionExceptionState;
  /** Their own orders:request row (null = none): the preview's phone-entry note. */
  ordersRequestOverride: boolean | null;
}

export interface PermissionExceptionsForMembers {
  permission: PlatformManagedPermission;
  /** The organization's Orders module, by the ACCESS rule (rows or the comp). */
  ordersModuleEnabled: boolean;
  /** The organization's orders:request role rows, by role. */
  ordersRequestRoleOverrides: Partial<Record<Role, boolean>>;
  /** Every requested member, with or without rows. */
  members: Record<string, PermissionExceptionMember>;
}

/** One page of the Users tab (orgs.ts MEMBERS_PAGE_SIZE). */
export const PERMISSION_EXCEPTIONS_MAX_MEMBERS = 50;

const STATES: ReadonlySet<string> = new Set(PERMISSION_EXCEPTION_STATES);
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
/** Lock wait (lock_timeout 3 s), deadlock, statement timeout: try again. */
const BUSY_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01', '57014']);
const INVALID_FIELDS: ReadonlySet<string> = new Set(['state', 'expectedState', 'target']);

function isState(v: unknown): v is PermissionExceptionState {
  return typeof v === 'string' && STATES.has(v);
}

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && ROLE_SET.has(v);
}

/**
 * The actor must still be an allowlisted platform admin as far as GoTrue is
 * concerned. Fail-closed: an unknown actor, an emailless actor or a failed
 * lookup all refuse (account-status.ts verifiedPlatformAdminEmail).
 */
async function verifiedPlatformAdminEmail(admin: AdminClient, actorUserId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(actorUserId);
    if (error || !data?.user) return null;
    const email = data.user.email;
    return typeof email === 'string' && isPlatformAdmin(email) ? email : null;
  } catch {
    return null;
  }
}

interface RpcError {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

function refusalOf(error: RpcError): SetPermissionExceptionResult | null {
  switch (error.hint) {
    case 'permission_exception_changed':
      return { ok: false, code: 'changed', current: isState(error.details) ? error.details : null };
    case 'member_not_found':
      return { ok: false, code: 'member_not_found' };
    case 'permission_not_platform_managed':
      return { ok: false, code: 'invalid', field: 'permission' };
    case 'permission_exception_invalid':
      // 0413 review fix round: the database reads the actor's email from
      // auth.users itself and refuses an actor it cannot find (deleted after
      // the check above): the actor is no longer authorized, not a bad target.
      if (error.details === 'actor') return { ok: false, code: 'not_authorized' };
      return {
        ok: false,
        code: 'invalid',
        field: INVALID_FIELDS.has(error.details ?? '') ? (error.details as PermissionExceptionInvalidField) : 'target',
      };
    default:
      break;
  }
  if (error.code && BUSY_SQLSTATES.has(error.code)) return { ok: false, code: 'busy' };
  return null;
}

async function set(input: SetPermissionExceptionInput): Promise<SetPermissionExceptionResult> {
  const permission = input.permission ?? ORDER_CATALOG_VISIBILITY_PERMISSION;
  if (!isPlatformManagedPermission(permission)) return { ok: false, code: 'invalid', field: 'permission' };
  if (!isState(input.state)) return { ok: false, code: 'invalid', field: 'state' };
  if (!isState(input.expectedState)) return { ok: false, code: 'invalid', field: 'expectedState' };

  const admin = createAdminClient();
  const actorEmail = await verifiedPlatformAdminEmail(admin, input.actorUserId);
  if (!actorEmail) return { ok: false, code: 'not_authorized' };

  let data: unknown;
  let error: RpcError | null;
  try {
    ({ data, error } = await admin.rpc('platform_set_permission_exception', {
      p_organization_id: input.organizationId,
      p_user_id: input.targetUserId,
      p_permission: permission,
      p_state: input.state,
      p_expected_state: input.expectedState,
      p_actor_user_id: input.actorUserId,
      // Kept for the signature; the database records the actor's own auth
      // email and ignores this value (0413 review fix round).
      p_actor_email: actorEmail,
    }));
  } catch (e) {
    await reportError(e instanceof Error ? e : new Error(String(e)), {
      tag: 'platform.permission-exception.set',
      extra: { organizationId: input.organizationId, targetUserId: input.targetUserId, permission },
    });
    return { ok: false, code: 'internal' };
  }

  if (error) {
    const refusal = refusalOf(error);
    if (refusal) return refusal;
    await reportError(new Error(error.message ?? 'platform_set_permission_exception failed'), {
      tag: 'platform.permission-exception.set',
      extra: { organizationId: input.organizationId, targetUserId: input.targetUserId, permission, code: error.code },
    });
    return { ok: false, code: 'internal' };
  }

  const answer = (data ?? null) as Record<string, unknown> | null;
  if (
    !answer ||
    !isState(answer.before) ||
    !isState(answer.after) ||
    !isRole(answer.targetRole) ||
    typeof answer.changed !== 'boolean'
  ) {
    await reportError(new Error('platform_set_permission_exception: malformed answer'), {
      tag: 'platform.permission-exception.answer',
      extra: { organizationId: input.organizationId, targetUserId: input.targetUserId, permission },
    });
    return { ok: false, code: 'internal' };
  }

  if (answer.changed) {
    // The member's open screens re-read their permissions (perms:{org}); the
    // key and direction let their toast name it. Best-effort, never throws.
    await broadcastPermissionsChanged(input.organizationId, {
      userId: input.targetUserId,
      permission,
      granted: answer.after === 'allow' ? true : answer.after === 'deny' ? false : null,
    });
  }

  return {
    ok: true,
    before: answer.before,
    after: answer.after,
    targetRole: answer.targetRole,
    changed: answer.changed,
  };
}

/**
 * The Users tab's one batched read for a page of members (at most 50): their
 * rows for the key and for orders:request, the organization's orders:request
 * role rows, and whether the Orders module is on, so the access preview needs
 * no per-member call. Throws on any failed read: the column is then shown as
 * unavailable, never guessed.
 */
async function listForMembers(
  organizationId: string,
  userIds: readonly string[],
): Promise<PermissionExceptionsForMembers> {
  const ids = [...new Set(userIds)];
  if (ids.length > PERMISSION_EXCEPTIONS_MAX_MEMBERS) {
    throw new Error(`listForMembers reads at most ${PERMISSION_EXCEPTIONS_MAX_MEMBERS} members at a time`);
  }
  const permission: PlatformManagedPermission = ORDER_CATALOG_VISIBILITY_PERMISSION;
  const admin = createAdminClient();

  const [userRes, roleRes, modulesRes, orgRes] = await Promise.all([
    ids.length > 0
      ? admin
          .from('user_permission_overrides')
          .select('user_id, permission, granted')
          .eq('organization_id', organizationId)
          // in-list-bound: one Users tab page, at most 50 members (refused above)
          .in('user_id', ids)
          // in-list-bound: two permission keys
          .in('permission', [permission, 'orders:request'])
      : Promise.resolve({ data: [], error: null }),
    admin
      .from('role_permission_overrides')
      .select('role, granted')
      .eq('organization_id', organizationId)
      .eq('permission', 'orders:request'),
    admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', organizationId)
      .eq('module_id', 'orders')
      .eq('enabled', true),
    admin.from('organizations').select('all_modules_comp').eq('id', organizationId).maybeSingle(),
  ]);
  for (const res of [userRes, roleRes, modulesRes, orgRes]) {
    if (res.error) throw new Error(`listForMembers: ${res.error.message}`);
  }

  const members: Record<string, PermissionExceptionMember> = {};
  for (const id of ids) members[id] = { exception: 'default', ordersRequestOverride: null };
  for (const row of (userRes.data ?? []) as Array<{ user_id: string; permission: string; granted: boolean }>) {
    const member = members[row.user_id];
    if (!member || typeof row.granted !== 'boolean') continue;
    if (row.permission === permission) member.exception = permissionExceptionFromGranted(row.granted);
    else if (row.permission === 'orders:request') member.ordersRequestOverride = row.granted;
  }

  const ordersRequestRoleOverrides: Partial<Record<Role, boolean>> = {};
  for (const row of (roleRes.data ?? []) as Array<{ role: string; granted: boolean }>) {
    if (isRole(row.role) && typeof row.granted === 'boolean') ordersRequestRoleOverrides[row.role] = row.granted;
  }

  const comped = (orgRes.data as { all_modules_comp?: boolean | null } | null)?.all_modules_comp === true;
  const ordersModuleEnabled = effectiveModules(
    (modulesRes.data ?? []) as Array<{ module_id: string }>,
    comped,
  ).has('orders');

  return { permission, ordersModuleEnabled, ordersRequestRoleOverrides, members };
}

export const PermissionExceptionsService = { set, listForMembers };
