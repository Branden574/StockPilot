import 'server-only';

import {
  effectivePermissions,
  isPlatformManagedPermission,
  PLATFORM_MANAGED_PERMISSIONS,
  ROLE_PERMISSIONS,
  withoutPlatformManaged,
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
 * set, so a flaky read can't escalate privilege or 500 the request. The one
 * exception is the PLATFORM-MANAGED keys (orders:manage_catalog_visibility,
 * migration 0413): StockPilot support may have DENIED one to this member, and
 * a fallback that kept the role default would hand a denied manager the
 * capability for that request. So every fallback drops them (fail closed);
 * the database refuses regardless (can_manage_order_catalog).
 *
 * Owner: every permission, except a platform-managed key StockPilot support
 * explicitly denied to them. Only those rows are read (one query); the owner
 * stays the org's lockout escape hatch for every key an org editor can touch.
 */
export async function loadEffectivePermissions(
  supabase: QueryableClient,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<Set<Permission>> {
  if (role === 'owner') return loadOwnerPermissions(supabase, organizationId, userId);
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
    return withoutPlatformManaged(new Set<Permission>(ROLE_PERMISSIONS[role]));
  }
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
