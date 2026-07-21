import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';
import { getWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { isManagerOrAbove, isWarehouseScoped, type Role } from '@stockpilot/core';

/**
 * Minimal context shape the warehouse helpers actually use. Both
 * `OrgContext` (server components) and `ServiceContext` (services
 * built via withApiContext for API routes) satisfy it, which means
 * an API-route caller can pass its own ctx to skip the redirect-
 * based `requireOrgContext()` fallback that throws NEXT_REDIRECT
 * when there's no x-pathname header.
 */
type WarehouseCtxLike = {
  organizationId: string;
  userId: string;
  role: Role;
  /**
   * The caller's OWN authed client, when it has one (ServiceContext does).
   * CRITICAL for Bearer API routes: the fallback `createClient()` is
   * cookie-bound and resolves to anon on a cookie-less request, which
   * silently returns ZERO assignment rows — a warehouse-scoped user would
   * look unassigned. Callers with a ctx.supabase always get it used.
   */
  supabase?: SupabaseClientLike;
};

/** Minimal structural client type — avoids coupling to generated DB generics. */
type SupabaseClientLike = {
  from: (table: string) => any;
};

export interface WarehouseAccess {
  /** All warehouse IDs the user can read. Empty array if none. */
  readableIds: string[];
  /** Warehouses where the user can write. For viewer this is []. */
  writableIds: string[];
  /** True for owner/admin/manager — all warehouses. */
  hasAllAccess: boolean;
  /** Default warehouse to scope queries to (first assignment, if any). */
  primaryWarehouseId: string | null;
}

/**
 * Resolves the warehouse access for the current user, based on role +
 * user_warehouse_assignments. Cached per render.
 *
 * Decision rules:
 *   • owner / admin / manager  → hasAllAccess = true (readableIds is loaded
 *     to support UIs that need a concrete list, but enforcement is by role).
 *   • staff   → readable + writable = assigned warehouses
 *   • viewer  → readable = assigned warehouses, writable = []
 */
export const getWarehouseAccess = cache(async (ctx?: WarehouseCtxLike): Promise<WarehouseAccess> => {
  const c = ctx ?? (await requireOrgContext());
  // Prefer the caller's own authed client (Bearer API routes) — the cookie
  // client is anon on cookie-less requests and would return zero rows. Only
  // an explicitly PASSED ctx can carry one (the requireOrgContext fallback
  // never does).
  const callerClient = ctx?.supabase;
  const supabase = callerClient ?? (await createClient());

  if (isManagerOrAbove(c.role as Role)) {
    // Rank 8 (query hygiene): shares the dashboard layout's request-cached
    // `warehouses` fetch instead of issuing a second, narrower (`id` only)
    // copy of the same query in the same render — but ONLY when we're on the
    // cookie client the request cache uses. A ctx-supplied client (Bearer)
    // queries directly so the ids reflect the caller's real auth.
    const readableIds = callerClient
      ? (
          (
            await supabase
              .from('warehouses')
              .select('id')
              .eq('organization_id', c.organizationId)
              .neq('status', 'archived')
              .order('name', { ascending: true })
          ).data ?? []
        ).map((w: { id: string }) => w.id)
      : (await getWarehousesForRequest(c.organizationId)).map((w) => w.id);
    return {
      readableIds,
      writableIds: readableIds,
      hasAllAccess: true,
      primaryWarehouseId: readableIds[0] ?? null,
    };
  }

  // staff / viewer: assignments (plus the 0280 all-warehouses membership flag,
  // which means "every warehouse incl. future ones" — surfaced as
  // hasAllAccess so scoped-view banners don't misdescribe these users; their
  // assignment ROWS still exist and still drive RLS).
  const [{ data: assignments }, { data: membership }] = await Promise.all([
    supabase
      .from('user_warehouse_assignments')
      .select('warehouse_id, is_primary')
      .eq('organization_id', c.organizationId)
      .eq('user_id', c.userId)
      .order('is_primary', { ascending: false }),
    supabase
      .from('organization_members')
      .select('all_warehouses')
      .eq('organization_id', c.organizationId)
      .eq('user_id', c.userId)
      .maybeSingle(),
  ]);

  const readableIds = (assignments ?? []).map((a: { warehouse_id: string }) => a.warehouse_id);
  const writableIds = c.role === 'viewer' ? [] : readableIds;
  const primaryAssignment = (assignments ?? []).find(
    (a: { is_primary: boolean }) => a.is_primary,
  );
  return {
    readableIds,
    writableIds,
    hasAllAccess: membership?.all_warehouses === true,
    primaryWarehouseId:
      (primaryAssignment?.warehouse_id as string | undefined) ?? readableIds[0] ?? null,
  };
});

/**
 * Throws a forbidden error if the user can't access the given warehouse for
 * the requested operation. Use at the top of every service method that takes
 * a warehouse_id from request input.
 */
export async function assertWarehouseAccess(
  warehouseId: string,
  op: 'read' | 'write' = 'read',
  ctx?: WarehouseCtxLike,
): Promise<void> {
  const c = ctx ?? (await requireOrgContext());
  const access = await getWarehouseAccess(c);

  if (op === 'write' && c.role === 'viewer') {
    throw new ForbiddenError('Read-only auditor cannot perform write operations.');
  }

  if (access.hasAllAccess) return;

  const allowed = op === 'write' ? access.writableIds : access.readableIds;
  if (!allowed.includes(warehouseId)) {
    throw new ForbiddenError(
      `User does not have ${op} access to warehouse ${warehouseId}.`,
    );
  }
}

/**
 * For a user who is warehouse-scoped, returns the warehouse ID we should
 * silently force their queries to. Throws if the user has no assignments.
 *
 * This is the *defense* against URL/API tampering: the API never trusts a
 * `warehouse_id` from request input for warehouse-scoped users — it derives
 * it from this function instead.
 */
export async function forcedWarehouseId(ctx?: WarehouseCtxLike): Promise<string | null> {
  const c = ctx ?? (await requireOrgContext());
  if (!isWarehouseScoped(c.role as Role)) return null;
  const access = await getWarehouseAccess(c);
  // An all-warehouses member (0280 flag) is scoped-by-role but not to ONE
  // warehouse — forcing primary would wrongly narrow their queries.
  if (access.hasAllAccess) return null;
  if (!access.primaryWarehouseId) {
    throw new ForbiddenError('User has no warehouse assignment.');
  }
  return access.primaryWarehouseId;
}

export class ForbiddenError extends Error {
  readonly code = 'forbidden' as const;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
