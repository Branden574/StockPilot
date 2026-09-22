import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';

import type { OrgRow } from '@/lib/dashboard/request-cache';
import { effectiveModules } from '@/lib/modules/effective-modules';
import { SESSION_HEADER_USER_ID } from '@/lib/supabase/middleware';
import { createClient } from '@/lib/supabase/server';

import type { ModuleId, PermissionOverride, Role } from '@stockpilot/core';

/**
 * The request context in ONE Supabase round trip (`get_request_context()`,
 * migration 0355), instead of seven reads in three serial waves.
 *
 * WHY IT EXISTS. Every render, prefetch and server action resolves who is asking
 * before it does anything else. Measured in production (2026-09-21), the six
 * reads this replaces were about 44 of the ~93 Supabase calls behind one
 * dashboard load plus one navigation (user_profiles 10, organizations 8,
 * organization_members 7, the two override tables 7 each, organization_modules
 * 5). A call costs about 16 ms (p50) while the project is busy, 70 to 170 ms in
 * quiet hours, and 200 to 400 ms after 90 seconds of nothing. The auth-user and
 * warehouses reads that also repeat are NOT covered by this change.
 *
 * WHAT IT IS NOT.
 *   - Not a cache. It is evaluated on every request, so a revoked permission, a
 *     removed membership or a disabled account bites on the next request,
 *     exactly as before. React `cache()` shares one answer between the consumers
 *     of one RENDER PASS only; it does not memoize inside a Server Action or a
 *     Route Handler, which is why `session.ts` threads the bundle it already
 *     holds instead of asking again.
 *   - Not a policy. The function runs SECURITY INVOKER under the caller's own
 *     row level security and decides nothing. Which membership is active, the
 *     effective permissions, the account-status gate and MFA all stay in the code
 *     that already owns them (`session.ts`, `context.ts`); they are handed the
 *     same rows from a different source.
 *   - Not required. `null` means "resolve this request the old way": the function
 *     is missing (a deploy ahead of its migration), the call failed, the answer
 *     has an unexpected shape, or it is about a different user than the one the
 *     proxy verified. The legacy reads keep every fail-closed rule they have.
 */

const ROLES: readonly Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];

export interface BundleProfile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  default_organization_id: string | null;
  disabled_at: string | null;
}

/** Same columns as `OrgRow` in lib/dashboard/request-cache, plus identity. */
export interface BundleOrganization {
  id: string;
  name: string;
  logo_url: string | null;
  terminology: unknown;
  mfa_policy: 'optional' | 'admins_required' | 'all_required' | null;
  timezone: string | null;
  nav_overrides: unknown;
  dashboard_layout: unknown;
  order_status_config: unknown;
  all_modules_comp: boolean | null;
}

export interface BundleMembership {
  organization_id: string;
  role: Role;
  /** null when the caller's RLS hides the organization row (treated as "not in the bundle"). */
  organization: BundleOrganization | null;
  role_overrides: PermissionOverride[];
  user_overrides: PermissionOverride[];
  enabled_modules: string[];
}

export interface RequestContextBundle {
  /** null when the caller's RLS returns no profile row (the legacy read returns null too). */
  profile: BundleProfile | null;
  /** Accepted memberships only, oldest first. */
  memberships: BundleMembership[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseOverrides(value: unknown): PermissionOverride[] | null {
  if (!Array.isArray(value)) return null;
  const out: PermissionOverride[] = [];
  for (const row of value) {
    if (!isRecord(row) || typeof row.permission !== 'string' || typeof row.granted !== 'boolean') {
      return null;
    }
    out.push({ permission: row.permission, granted: row.granted } as PermissionOverride);
  }
  return out;
}

/**
 * Strict on purpose: authorization is built from this. Anything unexpected
 * returns null and the request falls back to the legacy reads, rather than
 * guessing at a half-understood answer.
 */
export function parseRequestContextBundle(
  raw: unknown,
  expectedUserId: string,
): RequestContextBundle | null {
  if (!isRecord(raw)) return null;
  // The answer must be about the user the proxy verified. It always is (the
  // function only knows auth.uid()); if it ever is not, do not build a context
  // from someone else's rows.
  if (raw.user_id !== expectedUserId) return null;

  let profile: BundleProfile | null = null;
  if (raw.profile !== null && raw.profile !== undefined) {
    const p = raw.profile;
    if (!isRecord(p) || p.id !== expectedUserId || typeof p.email !== 'string') return null;
    // The account-status gate reads this key. A profile WITHOUT it is not a
    // profile of an active user, it is an answer this code does not understand.
    if (!('disabled_at' in p)) return null;
    profile = {
      id: p.id as string,
      email: p.email,
      full_name: typeof p.full_name === 'string' ? p.full_name : null,
      avatar_url: typeof p.avatar_url === 'string' ? p.avatar_url : null,
      default_organization_id:
        typeof p.default_organization_id === 'string' ? p.default_organization_id : null,
      disabled_at: typeof p.disabled_at === 'string' ? p.disabled_at : null,
    };
    // A disabled_at that is present but not a string would be silently read as
    // "not disabled" above. Refuse the whole answer instead.
    if (
      p.disabled_at !== null &&
      p.disabled_at !== undefined &&
      typeof p.disabled_at !== 'string'
    ) {
      return null;
    }
  }

  if (!Array.isArray(raw.memberships)) return null;
  const memberships: BundleMembership[] = [];
  for (const m of raw.memberships) {
    if (!isRecord(m) || typeof m.organization_id !== 'string') return null;
    if (typeof m.role !== 'string' || !ROLES.includes(m.role as Role)) return null;
    const roleOverrides = parseOverrides(m.role_overrides);
    const userOverrides = parseOverrides(m.user_overrides);
    if (!roleOverrides || !userOverrides) return null;
    if (!Array.isArray(m.enabled_modules) || m.enabled_modules.some((x) => typeof x !== 'string')) {
      return null;
    }
    let organization: BundleOrganization | null = null;
    if (m.organization !== null && m.organization !== undefined) {
      const o = m.organization;
      if (!isRecord(o) || o.id !== m.organization_id || typeof o.name !== 'string') return null;
      // The column is NOT NULL with a CHECK on these three values (0009), so
      // anything else is never a legitimate answer. Read loosely, a missing or
      // unknown policy would become 'optional' downstream and switch an
      // organization's enforced MFA OFF; the legacy read THROWS on a fault and
      // the MFA gate then fails closed. Refuse, and let that path run.
      if (
        o.mfa_policy !== 'optional' &&
        o.mfa_policy !== 'admins_required' &&
        o.mfa_policy !== 'all_required'
      ) {
        return null;
      }
      // Same reasoning for the comp flag (boolean NOT NULL): it widens the module set.
      if (typeof o.all_modules_comp !== 'boolean') return null;
      organization = {
        id: o.id as string,
        name: o.name,
        logo_url: typeof o.logo_url === 'string' ? o.logo_url : null,
        terminology: o.terminology ?? null,
        mfa_policy: o.mfa_policy,
        timezone: typeof o.timezone === 'string' ? o.timezone : null,
        nav_overrides: o.nav_overrides ?? null,
        dashboard_layout: o.dashboard_layout ?? null,
        order_status_config: o.order_status_config ?? null,
        all_modules_comp: o.all_modules_comp,
      };
    }
    memberships.push({
      organization_id: m.organization_id,
      role: m.role as Role,
      organization,
      role_overrides: roleOverrides,
      user_overrides: userOverrides,
      enabled_modules: m.enabled_modules as string[],
    });
  }
  return { profile, memberships };
}

/**
 * One call per render pass, shared by every consumer of that pass (see "Not a
 * cache" above for Server Actions). Returns null whenever the legacy reads
 * should be used instead (see the file header).
 *
 * `REQUEST_CONTEXT_RPC=off` is the switch back to the legacy reads without a
 * code change.
 */
export const loadRequestContextBundle = cache(async (): Promise<RequestContextBundle | null> => {
  if (process.env.REQUEST_CONTEXT_RPC === 'off') return null;
  try {
    const userId = (await headers()).get(SESSION_HEADER_USER_ID);
    // No proxy-verified user: an API route, a Bearer request, a signed-out page.
    if (!userId) return null;
    const supabase = await createClient();
    // GET: PostgREST runs a STABLE function in a read-only transaction.
    const { data, error } = await supabase.rpc('get_request_context', undefined, { get: true });
    if (error) {
      // Codes only: never the message, which can quote request details.
      console.warn(
        '[request-context] rpc failed, using the legacy reads:',
        error.code ?? 'unknown',
      );
      return null;
    }
    const bundle = parseRequestContextBundle(data, userId);
    if (!bundle) {
      // Told apart on purpose: the first should never happen and is worth a look.
      const aboutSomeoneElse =
        typeof data === 'object' && data !== null && (data as { user_id?: unknown }).user_id !== userId;
      console.warn(
        aboutSomeoneElse
          ? '[request-context] answer is not about the proxy-verified user, using the legacy reads'
          : '[request-context] unexpected answer, using the legacy reads',
      );
    }
    return bundle;
  } catch {
    // A fixed string, never the error: it can quote request details. Logged so
    // that a fast path which is permanently off does not stay invisible.
    console.warn('[request-context] call threw, using the legacy reads');
    return null;
  }
});

/** The caller's accepted membership in `organizationId`, if the bundle has one. */
export function bundleMembership(
  bundle: RequestContextBundle | null,
  organizationId: string,
): BundleMembership | null {
  return bundle?.memberships.find((m) => m.organization_id === organizationId) ?? null;
}

/**
 * The organization settings row (`OrgRow`) a membership carries, or null when
 * the caller's RLS hid the organization (the caller then takes the legacy read,
 * which is where "hidden" and "failed" are told apart). The ONE conversion: the
 * request-cached readers and `withContext()` both use it, so the two can never
 * disagree about what the bundle said.
 */
export function orgRowFromMembership(held: BundleMembership | null): OrgRow | null {
  const o = held?.organization;
  if (!o) return null;
  return {
    terminology: o.terminology,
    mfa_policy: o.mfa_policy,
    logo_url: o.logo_url,
    timezone: o.timezone,
    nav_overrides: o.nav_overrides,
    dashboard_layout: o.dashboard_layout,
    order_status_config: o.order_status_config,
    all_modules_comp: o.all_modules_comp,
  };
}

/**
 * The effective module set a membership carries, through the same
 * `effectiveModules` rule every resolver uses. null under the same condition as
 * `orgRowFromMembership`: without the organization row there is no comp flag,
 * and a module set built without it would be a guess.
 */
export function modulesFromMembership(held: BundleMembership | null): Set<ModuleId> | null {
  if (!held?.organization) return null;
  return effectiveModules(
    held.enabled_modules.map((module_id) => ({ module_id })),
    held.organization.all_modules_comp,
  );
}

// ─── Carrying the membership on the context it produced ─────────────────────
//
// WHY. `cache()` does not memoize inside a Server Action (see "Not a cache"
// above), so every request-cached helper an action reaches asks
// get_request_context() AGAIN. `withContext()` reached three of them
// (requireOrgContext, getOrgRowForRequest, getModulesForRequest): three RPCs
// per action, each its own snapshot, and each a fresh chance at the 1 to 8 s
// stall measured at Supabase's entry point on 2026-09-22 (3 to 5% of weekday
// calls). The membership that answered requireOrgContext() already holds the
// org row and the modules, so it travels on the OrgContext it produced and
// withContext() reads them from there.
//
// A symbol, not a field, and not enumerable: an OrgContext is a plain object
// every page and layout holds, and this row (override lists, module ids) must
// never be serialized into a client component's props by a page that passes the
// context along. A spread or copy of the context drops it, and a context without
// it takes the request-cached readers exactly as before, so losing it is only
// slower, never wrong. Nothing here outlives the object it is attached to: it
// is not a cache, and no other request can reach it.
const HELD_MEMBERSHIP = Symbol('stockpilot.heldMembership');

/** Attaches the membership `ctx` was resolved from. A null membership attaches nothing. */
export function holdMembership<T extends object>(ctx: T, held: BundleMembership | null): T {
  if (held) {
    Object.defineProperty(ctx, HELD_MEMBERSHIP, { value: held, enumerable: false });
  }
  return ctx;
}

/**
 * The membership `ctx` was resolved from, ONLY when it is for the organization
 * and role `ctx` carries. Anything else (none attached, a context rebuilt for
 * another organization, a role that disagrees) returns null, and the caller asks
 * the database as it always did.
 */
export function heldMembership(ctx: { organizationId: string; role: Role }): BundleMembership | null {
  const held = (ctx as { [HELD_MEMBERSHIP]?: BundleMembership })[HELD_MEMBERSHIP];
  if (!held) return null;
  if (held.organization_id !== ctx.organizationId || held.role !== ctx.role) return null;
  return held;
}
