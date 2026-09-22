import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';
import { readWarehousesForRequest } from '@/lib/dashboard/request-cache';
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
  /**
   * Set only by withContext() (see ServiceContext.cookieClient): the request's
   * own cookie-bound client. When `supabase` IS this client, the caller's auth
   * and the request cache's auth are the same session, so the request-cached
   * reads answer for it.
   */
  cookieClient?: SupabaseClientLike;
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
  /**
   * Present (always `true`) only when a read this answer is built from came
   * back with an error. The fields above then hold the narrowest answer the
   * role allows (see accessWhenUnreadable), and a caller that must not act on
   * a degraded answer at all (the mobile snapshot, whose full pull deletes
   * every cached row it is not sent) refuses on it. A surface that explains
   * the scope (ScopedWarehouseNotice, the Items empty state) says the access
   * could not be loaded rather than "no assigned warehouses". Absent on every
   * answer built from reads that succeeded, so success answers are unchanged.
   */
  unreadable?: true;
}

/**
 * What a failed read resolves to. supabase-js RESOLVES a failed query as
 * `{ data: null, error }` rather than throwing, and this helper used to read
 * that as `data ?? []`: indistinguishable from a real "no rows". An access
 * decision built on a read that did not happen must deny, not guess:
 *
 *   • staff / viewer: no readable and no writable warehouse, no primary, and
 *     NOT the 0280 all-warehouses flag. The service callers already treat
 *     that shape as "sees nothing" (assertWarehouseAccess and
 *     forcedWarehouseId throw ForbiddenError; list/count readers return
 *     empty). The mobile snapshot refuses on `unreadable` before building
 *     any query, because its empty answer would be acted on (see above). Row
 *     level security still enforces underneath either way.
 *   • owner / admin / manager: hasAllAccess stays true, because the ROLE is
 *     the whole rule for them (isManagerOrAbove, below) and the warehouses
 *     list never fed it. The list itself is empty rather than guessed, so a
 *     failed list read can only ever mean "no ids", never "these ids".
 */
function accessWhenUnreadable(role: Role): WarehouseAccess {
  return {
    readableIds: [],
    writableIds: [],
    hasAllAccess: isManagerOrAbove(role),
    primaryWarehouseId: null,
    unreadable: true,
  };
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
 *   • any read below that returns an error → accessWhenUnreadable(role).
 *     A read that THROWS rejects this promise, which every caller already
 *     treats as a failure (none of them turns a rejection into access).
 */
export const getWarehouseAccess = cache(async (ctx?: WarehouseCtxLike): Promise<WarehouseAccess> => {
  const c = ctx ?? (await requireOrgContext());
  // Prefer the caller's own authed client (Bearer API routes) — the cookie
  // client is anon on cookie-less requests and would return zero rows. Only
  // an explicitly PASSED ctx can carry one (the requireOrgContext fallback
  // never does).
  const callerClient = ctx?.supabase;
  const supabase = callerClient ?? (await createClient());
  // On the request's own cookie session: no ctx (the requireOrgContext fallback
  // above), or a withContext() ctx whose client is the cookie client it made.
  // Compared by IDENTITY, not a flag, so a context rebuilt around another
  // client (Bearer, service role) can never borrow the cookie session's answer.
  const onRequestCookieClient =
    !callerClient || (ctx?.cookieClient !== undefined && ctx.cookieClient === callerClient);

  if (isManagerOrAbove(c.role as Role)) {
    // Rank 8 (query hygiene): shares the dashboard layout's request-cached
    // `warehouses` fetch instead of issuing a second, narrower (`id` only)
    // copy of the same query in the same render — but ONLY when we're on the
    // cookie client the request cache uses. A ctx-supplied client (Bearer)
    // queries directly so the ids reflect the caller's real auth.
    //
    // Every withContext() ctx carries a client, so from 2026-07-20 (a6a5e10b)
    // until this change every one of them took the direct query: one extra
    // `warehouses` read on top of the layout's, ~436 a day, on the page's
    // critical path. A withContext() ctx is the cookie session, so it shares
    // the layout's read again; the rule that decides hasAllAccess (role, and
    // nothing else) is untouched.
    //
    // Both branches keep the read's error: a failed list is reported as
    // unreadable (empty ids, hasAllAccess still by role), never as a list.
    let readableIds: string[];
    if (onRequestCookieClient) {
      const read = await readWarehousesForRequest(c.organizationId);
      if (read.failed) return accessWhenUnreadable(c.role as Role);
      readableIds = read.rows.map((w) => w.id);
    } else {
      const { data, error } = await supabase
        .from('warehouses')
        .select('id')
        .eq('organization_id', c.organizationId)
        .neq('status', 'archived')
        .order('name', { ascending: true });
      if (error) {
        console.error('[getWarehouseAccess] warehouses read failed:', error.message);
        return accessWhenUnreadable(c.role as Role);
      }
      readableIds = ((data ?? []) as Array<{ id: string }>).map((w) => w.id);
    }
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
  const [
    { data: assignments, error: assignmentsError },
    { data: membership, error: membershipError },
  ] = await Promise.all([
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

  // EITHER read failing denies the whole answer, not just its half: the rules
  // above are defined over both reads, and an answer assembled from one of
  // them is not an answer those rules ever give. (A failed assignments read
  // used to look like "no assignments"; a failed membership read like "flag
  // off". Both happened to be narrow; neither was the user's real access.)
  if (assignmentsError || membershipError) {
    if (assignmentsError) {
      console.error(
        '[getWarehouseAccess] user_warehouse_assignments read failed:',
        assignmentsError.message,
      );
    }
    if (membershipError) {
      console.error(
        '[getWarehouseAccess] organization_members read failed:',
        membershipError.message,
      );
    }
    return accessWhenUnreadable(c.role as Role);
  }

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
 *
 * `started` is `getWarehouseAccess(ctx)` for this SAME ctx, begun by a caller
 * that did not yet know the warehouse id: InventoryService.get() starts it
 * alongside the item-row read so the two trips to Supabase overlap instead of
 * queueing (production logs 2026-09-22: 3-5% of calls stall 1-8 s at the
 * gateway, and a stall in a chain delays every level behind it). Passing it
 * in, rather than calling this again after the row arrives, is what keeps it
 * ONE read where React's request cache is not active (route handlers). It
 * changes when the access list is read, never what is decided from it: the
 * rules below are applied to it unchanged, and a rejection still rejects here.
 * Never pass anything but that helper's own result for the same ctx.
 */
export async function assertWarehouseAccess(
  warehouseId: string,
  op: 'read' | 'write' = 'read',
  ctx?: WarehouseCtxLike,
  started?: Promise<WarehouseAccess>,
): Promise<void> {
  const c = ctx ?? (await requireOrgContext());
  const access = await (started ?? getWarehouseAccess(c));

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
