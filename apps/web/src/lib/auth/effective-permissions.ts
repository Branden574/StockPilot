import 'server-only';

import {
  effectivePermissions,
  ROLE_PERMISSIONS,
  type Permission,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

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
 * Resolves a member's EFFECTIVE permission set = static role defaults
 * (ROLE_PERMISSIONS) with org-level role overrides and per-user overrides
 * applied (last wins). The SQL twin is public.has_permission() (migration
 * 0207), used by RLS; this is the app-layer gate consulted by `can(ctx, …)`.
 *
 * FAIL-SAFE: a failed override read NEVER throws — it falls back to the static
 * role defaults. Grants not applying is fail-closed; revokes not applying just
 * preserves the prior behavior. Neither widens access beyond the role's static
 * set, so a flaky read can't escalate privilege or 500 the request.
 *
 * Owner short-circuits to the full set with no DB round-trip (owner is
 * immutable — the org's lockout escape hatch).
 */
export async function loadEffectivePermissions(
  supabase: QueryableClient,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<Set<Permission>> {
  if (role === 'owner') return effectivePermissions('owner');
  try {
    const [roleRes, userRes] = await Promise.all([
      supabase
        .from('role_permission_overrides')
        .select('permission, granted')
        .eq('organization_id', organizationId)
        .eq('role', role),
      supabase
        .from('user_permission_overrides')
        .select('permission, granted')
        .eq('organization_id', organizationId)
        .eq('user_id', userId),
    ]);
    if (roleRes.error || userRes.error) throw roleRes.error ?? userRes.error;
    return effectivePermissions(
      role,
      (roleRes.data ?? []) as PermissionOverride[],
      (userRes.data ?? []) as PermissionOverride[],
    );
  } catch (err) {
    console.error('[loadEffectivePermissions] fail-safe to static defaults:', err);
    return new Set<Permission>(ROLE_PERMISSIONS[role]);
  }
}
