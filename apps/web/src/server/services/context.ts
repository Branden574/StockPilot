import 'server-only';

import { cache } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import { PLACEMENT_KINDS, PLACEMENT_TYPES, SYSTEM_KINDS } from '@/lib/locations/groups';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
} from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';

import type { Permission, PlanId, Role } from '@stockpilot/core';
import { can, isAdminRole, isUnlimited, MODULE_REGISTRY, PLANS, resolveEffectivePlan, type OrgBillingState } from '@stockpilot/core';
import type { ModuleId } from '@stockpilot/core';

/**
 * Cheap context-resolution timing. Emitted as a structured debug log only
 * when `DEBUG_CONTEXT_TIMING` is truthy, so it's a no-op in normal prod.
 * The label/duration are the units a Server-Timing header would carry, so
 * a caller (e.g. a route/layout) can forward them if desired. Non-breaking.
 */
function logContextTiming(label: string, startMs: number): void {
  if (!process.env.DEBUG_CONTEXT_TIMING) return;
  const dur = Math.round((performance.now() - startMs) * 100) / 100;
  console.info(`[context.timing] ${label}=${dur}ms`);
}

export interface ServiceContext {
  organizationId: string;
  userId: string;
  role: Role;
  /**
   * Effective permission set = static role defaults with org-level role +
   * per-user overrides applied. Consult via `can(ctx, perm)` / the
   * `assertPermission(ctx, perm)` below — not the static role map —
   * so configurable overrides take effect. Optional: the real auth builders
   * (withContext / withApiContext) always set it; synthetic system contexts
   * (cron, callbacks, tests) omit it and fall back to static role defaults.
   */
  permissions?: Set<Permission>;
  supabase: Awaited<ReturnType<typeof createClient>>;
  /**
   * Whether the user's session must satisfy MFA AAL2 before any
   * permission gate fires. Computed once at context build time:
   * true when the org's mfa_policy demands it for this role OR when
   * the user has a verified TOTP factor enrolled (HI-6 — an enrolled
   * factor must be satisfied regardless of org policy, or a stolen
   * password alone signs in untouched under an 'optional' policy).
   */
  mfaRequired: boolean;
  /** True only when the session is currently at AAL2. */
  mfaSatisfied: boolean;
  /**
   * True when the user has at least one VERIFIED TOTP factor. Decides the
   * error shape when the gate fires: enrolled users get
   * `reason: 'aal2_required'` (step up in place via useStepUp / the mobile
   * challenge screen), unenrolled users keep `reason: 'mfa_required'`
   * (enroll first). Optional: synthetic system contexts omit it and are
   * treated as unenrolled.
   */
  mfaEnrolled?: boolean;
  /**
   * Modules enabled for this org; core modules are always treated as
   * enabled even if absent.
   */
  enabledModules: Set<ModuleId>;
}

async function resolveMfaState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  role: Role,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled: boolean }> {
  try {
    // DEDUPE: the org row (incl. mfa_policy) was already fetched by the
    // dashboard layout via this request-cached helper — reuse it instead of
    // issuing a second `organizations` SELECT for the same row.
    const org = await getOrgRowForRequest(organizationId);
    const policy = (org?.mfa_policy as
      | 'optional'
      | 'admins_required'
      | 'all_required'
      | null
      | undefined) ?? 'optional';
    const policyRequired =
      policy === 'all_required' ||
      (policy === 'admins_required' && isAdminRole(role));
    // ENROLLMENT ESCALATES (HI-6): a user who HAS a verified TOTP factor must
    // satisfy it regardless of org policy. Without this, org policy alone
    // drove enforcement, so an attacker holding only the password of a
    // TOTP-enrolled user signed in at AAL1 untouched under the default
    // 'optional' policy. The factor list is request-cached (the layout
    // already loaded it), so this adds no round-trip.
    const factors = await getMfaFactorsForRequest();
    const hasVerifiedFactor = factors.some((f) => f.status === 'verified');
    const mfaRequired = policyRequired || hasVerifiedFactor;
    if (!mfaRequired) {
      return { mfaRequired: false, mfaSatisfied: true, mfaEnrolled: false };
    }
    // SHORT-CIRCUIT: a user with NO verified factor can never be at AAL2, so
    // skip the `auth.mfa.getAuthenticatorAssuranceLevel()` round-trip and
    // fail closed directly (only reachable via the policy branch). Only when
    // a verified factor exists do we spend the AAL round-trip to confirm the
    // session actually stepped up. Same fail-closed outcome as before,
    // fewer round-trips.
    if (!hasVerifiedFactor) {
      return { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
    }
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return {
      mfaRequired: true,
      mfaSatisfied: data?.currentLevel === 'aal2',
      mfaEnrolled: true,
    };
  } catch (err) {
    // Fail CLOSED — assume MFA is required and unsatisfied. A flaky
    // org lookup must NOT silently let an admin bypass MFA. The user
    // sees a clear "MFA required" error instead of silent bypass;
    // matches enterprise expectations from the org MFA policy.
    console.error('[resolveMfaState] failed:', err);
    return { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false };
  }
}

export const withContext = cache(async (): Promise<ServiceContext> => {
  const startMs = performance.now();
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  // PARALLELIZE: the MFA-state resolution and the enabled-modules read are
  // independent. Run them concurrently instead of sequentially. The modules
  // read goes through the request-cached `getModulesForRequest` so the
  // dashboard layout and `withContext` share ONE `organization_modules`
  // round-trip per render (it also absorbs/logs query errors, returning an
  // empty set = core-only nav, never a wider entitlement than the org has).
  const [{ mfaRequired, mfaSatisfied, mfaEnrolled }, enabledModules] = await Promise.all([
    resolveMfaState(supabase, ctx.organizationId, ctx.role),
    getModulesForRequest(ctx.organizationId),
  ]);
  logContextTiming('withContext', startMs);
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
    permissions: ctx.permissions,
    supabase,
    mfaRequired,
    mfaSatisfied,
    mfaEnrolled,
    enabledModules,
  };
});

export class ServiceError extends Error {
  /**
   * Raw, potentially-sensitive detail behind an `internal_error` (e.g. a
   * PostgREST/Postgres error string carrying table/column/constraint/RLS-policy
   * names). Retained SERVER-SIDE for logging/Sentry; it is NEVER used as the
   * public `message` for an internal_error, so it cannot leak to an API or
   * server-action caller. (S13)
   */
  public readonly internalDetail?: string;
  constructor(
    public code:
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'validation_error'
      | 'plan_limit_exceeded'
      | 'module_disabled'
      | 'conflict'
      | 'internal_error',
    message: string,
    public details?: Record<string, unknown>,
  ) {
    // `internal_error` messages are routinely raw DB/PostgREST error text —
    // returning them to a client leaks schema (table/column/constraint/policy
    // names) and aids recon. Make the PUBLIC message generic and keep the raw
    // detail server-side. Every other code is app-authored and safe verbatim.
    const generic = 'An internal error occurred. Please try again.';
    super(code === 'internal_error' ? generic : message);
    this.name = 'ServiceError';
    if (code === 'internal_error' && message && message !== generic) {
      this.internalDetail = message;
    }
  }
}

/**
 * The error thrown when the MFA gate fires. Two shapes, chosen by enrollment:
 *
 *   - ENROLLED (verified factor, session not stepped up): `reason:
 *     'aal2_required'` — the exact shape the useStepUp() modal already
 *     consumes at its wired sites, so the UI prompts for a TOTP code in
 *     place instead of telling an enrolled user to "enroll".
 *   - UNENROLLED (policy demands MFA, no factor yet): the original
 *     `reason: 'mfa_required'` shape, byte-for-byte — enroll first.
 */
function mfaGateError(ctx: ServiceContext): ServiceError {
  if (ctx.mfaEnrolled) {
    return new ServiceError(
      'forbidden',
      'Re-authenticate with MFA before performing this action.',
      { reason: 'aal2_required' },
    );
  }
  return new ServiceError(
    'forbidden',
    'Multi-factor authentication required. Enroll in MFA before performing this action.',
    { reason: 'mfa_required' },
  );
}

export function assertPermission(ctx: ServiceContext, permission: Permission) {
  // MFA gate FIRST. If MFA is required (org policy, or the user's own
  // enrolled factor) and the session is at AAL1, no permission check
  // applies — the user must step up before doing anything privileged.
  // The dashboard layout already shows a banner pointing them to
  // /dashboard/settings/mfa (which doesn't go through assertPermission,
  // so enrollment still works at AAL1).
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw mfaGateError(ctx);
  }
  if (!can(ctx, permission)) {
    throw new ServiceError('forbidden', `Missing permission: ${permission}`);
  }
}

/**
 * Pass when the caller holds ANY ONE of `permissions`.
 *
 * For an action two different roles legitimately reach by two different
 * routes — e.g. creating a product group, which an item creator does from the
 * item form and a sports reviewer does from the linking tool. Demanding a
 * single permission there would gate a user out of a screen their OTHER
 * permission already let them open. The MFA step-up runs first, exactly as in
 * `assertPermission`; this widens WHICH permission satisfies the gate, never
 * whether a gate applies.
 */
export function assertAnyPermission(ctx: ServiceContext, permissions: readonly Permission[]) {
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw mfaGateError(ctx);
  }
  if (permissions.some((p) => can(ctx, p))) return;
  throw new ServiceError('forbidden', `Missing permission: ${permissions.join(' or ')}`);
}

export function assertModuleEnabled(ctx: ServiceContext, moduleId: ModuleId): void {
  if (ctx.enabledModules.has(moduleId)) return;
  // Core modules are never gated — always available even if a row is missing.
  if (MODULE_REGISTRY[moduleId]?.tier === 'core') return;
  throw new ServiceError('module_disabled', `Module not enabled for this organization: ${moduleId}`);
}

export function serviceErrorStatus(code: ServiceError['code']): number {
  switch (code) {
    case 'unauthenticated': return 401;
    case 'forbidden':
    case 'module_disabled': return 403;
    case 'not_found': return 404;
    // 400 for request-validation failures (the conventional choice, and what
    // routes adopting this helper should converge on); 409 reserved for true
    // state conflicts / plan limits.
    case 'validation_error': return 400;
    case 'conflict':
    case 'plan_limit_exceeded': return 409;
    default: return 500;
  }
}

/**
 * Re-queries the user's current role for (userId, organizationId) and
 * throws `forbidden` if it no longer matches what `ctx` was built with.
 *
 * Why this exists: `withContext()` is wrapped in React.cache, so role is
 * pinned for the lifetime of a single request. RLS enforces the *current*
 * role on every underlying query, so a stale `ctx.role` only matters for
 * application-layer branches that don't ride RLS — most importantly the
 * privilege checks in member management and billing. If an owner demotes
 * an admin mid-request, the in-flight admin call would still see
 * `role=admin` in the cached context and would pass `assertPermission`,
 * even though their NEW role no longer should.
 *
 * Call this at the top of any high-risk admin Server Action *after*
 * `assertPermission`. Cheap (one round-trip) and it kills the demote-mid-
 * request escalation window.
 */
/**
 * Hard-requires the *current* session to be at AAL2 (i.e. the user has
 * completed their MFA challenge in this session). Use as a step-up gate
 * on actions that mutate account-security state — unenrolling a factor,
 * changing the org MFA policy, resetting another user's MFA. The org's
 * `mfa_policy` is irrelevant here: even if the policy is `optional`,
 * the user must prove possession of a second factor before they're
 * allowed to weaken the security posture.
 *
 * Returns silently when AAL2 is satisfied. Throws a `forbidden`
 * `ServiceError` with `reason: 'aal2_required'` otherwise, which the
 * UI surfaces as a re-prompt CTA pointing at `/signin/mfa`.
 *
 * NOTE: a user with NO verified factors has `currentLevel === 'aal1'`
 * (because there's nothing to step up to). We treat that as "not AAL2"
 * — they shouldn't be calling MFA-mutating actions without an MFA
 * factor in the first place, and erring on the strict side keeps the
 * gate's semantics crisp.
 */
export async function assertCurrentAal2(ctx: ServiceContext): Promise<void> {
  const { data, error } = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) {
    throw new ServiceError(
      'forbidden',
      'Could not verify your two-factor authentication state. Sign in again and try once more.',
      { reason: 'aal2_required' },
    );
  }
  if (data.currentLevel !== 'aal2') {
    throw new ServiceError(
      'forbidden',
      'Re-authenticate with MFA before changing security settings.',
      { reason: 'aal2_required' },
    );
  }
}

export async function assertRoleUnchanged(ctx: ServiceContext): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', ctx.userId)
    .eq('organization_id', ctx.organizationId)
    .not('accepted_at', 'is', null)
    .maybeSingle();
  if (error || !data) {
    throw new ServiceError('forbidden', 'Membership no longer active.');
  }
  if ((data as { role: Role }).role !== ctx.role) {
    throw new ServiceError(
      'forbidden',
      'Your role changed during this request. Please reload and try again.',
    );
  }
}

/** A reservation against a `PlanLimitBudget`. Releasing it hands the slot back
 *  — for the row that took one and then failed for some other reason. */
export interface PlanLimitSlot {
  release(): void;
}

/**
 * A plan limit resolved once and then spent in memory, with the count
 * re-readable on demand.
 *
 * `assertPlanLimit` costs two round trips (the org's plan, then a COUNT), which
 * is right for a single create and wrong for a loop. `importItemsAction` calls
 * `InventoryService.create()` once per CSV row, so a 4-row file paid EIGHT
 * reads to answer the same question four times — measurably the largest single
 * cost in the import, and the reason the owner reported a 4-row file as slow.
 *
 * The budget answers it once and then tracks the headroom locally, so the
 * check stays per-row (the row that would cross the limit is still the row that
 * fails, with the same message) while the reads happen per-batch.
 *
 * `take()` is SYNCHRONOUS on purpose: rows run concurrently, and a reservation
 * that awaited anything could let two rows both see the last free slot.
 *
 * ENFORCEMENT LIVES HERE, NOWHERE ELSE. There is no DB constraint behind a plan
 * limit — no trigger, no check, nothing that would reject the insert. So a
 * budget held across a long loop is not merely stale, it is the ONLY thing
 * standing between two simultaneous imports and double the org's item
 * allowance. `refresh()` exists so a long-running caller can re-read the truth
 * between batches instead of trusting a snapshot it took minutes ago; see
 * `importItemsAction`, which calls it once per concurrency batch.
 */
export interface PlanLimitBudget {
  /** Reserve `n` slots, or null when the plan has no room for them. */
  take(n?: number): PlanLimitSlot | null;
  /**
   * Re-read the resource count and discard every outstanding reservation.
   *
   * Only safe to call with NOTHING in flight — it rebases the headroom on the
   * database's current truth, which already includes the rows this request has
   * written, so any slot still held would be counted twice.
   */
  refresh(): Promise<void>;
  /** True once the plan is full as of the last read — the caller should stop
   *  rather than keep asking, because no later row can fit either. */
  isFull(): boolean;
  /** The exact error `assertPlanLimit` throws when there is no room. */
  exceeded(): ServiceError;
}

/**
 * Resolves the org's effective plan and its CURRENT count for `resource`, and
 * returns a budget over the remaining headroom. Two round trips, once.
 *
 * A budget must never outlive the request that built it — it is a snapshot of a
 * count another request can move, and `refresh()` is how a long loop re-reads it.
 */
export async function planLimitBudget(
  ctx: ServiceContext,
  resource: 'items' | 'locations' | 'members',
): Promise<PlanLimitBudget> {
  const { data: org } = await ctx.supabase
    .from('organizations')
    .select(
      'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
    )
    .eq('id', ctx.organizationId)
    .single();
  // Resolve the EFFECTIVE tier (admin override > stripe > trial > plan column),
  // so a platform-admin "access_tier" override (e.g. Comped Enterprise) lifts
  // the limits exactly as configured — the single source of truth.
  const plan: PlanId = resolveEffectivePlan((org as OrgBillingState | null) ?? { plan: null }).tier;
  const limit = PLANS[plan].limits[resource];
  const exceeded = () =>
    new ServiceError(
      'plan_limit_exceeded',
      `You've reached your ${PLANS[plan].name} plan limit of ${limit} ${resource}. Upgrade to add more.`,
      { plan, limit, resource },
    );
  const FREE_SLOT: PlanLimitSlot = { release: () => {} };
  // No count needed, and no accounting: an unlimited plan can never refuse.
  if (isUnlimited(limit)) {
    return {
      take: () => FREE_SLOT,
      refresh: async () => {},
      isFull: () => false,
      exceeded,
    };
  }

  const table =
    resource === 'items'
      ? 'inventory_items'
      : resource === 'locations'
        ? 'locations'
        : 'organization_members';

  /** The COUNT, re-runnable. `refresh()` needs the identical predicate the
   *  first read used, so it is built here rather than inline. */
  const readCount = async (): Promise<number> => {
    let query = ctx.supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId);

    if (resource === 'items' || resource === 'locations') {
      query = query.is('deleted_at', null);
    }
    if (resource === 'locations') {
      // The locations entitlement governs SITES — what pickers offer and the
      // Locations page's "Sites" tab shows. Racks/shelves/crates/areas and the
      // auto-created staging/unplaced buckets must not consume it (every
      // warehouse spawns 2 system rows; put-away creates racks freely). SQL
      // mirror of isSiteLocation() — the two .or() groups AND together, and
      // each keeps NULL rows (NOT IN drops NULLs on its own).
      query = query
        .or(`kind.is.null,kind.not.in.(${[...SYSTEM_KINDS, ...PLACEMENT_KINDS].join(',')})`)
        .or(`type.is.null,type.not.in.(${PLACEMENT_TYPES.join(',')})`);
    }
    if (resource === 'members') {
      query = query.not('accepted_at', 'is', null);
    }

    const { count } = await query;
    return count ?? 0;
  };

  let used = await readCount();
  return {
    take(n = 1) {
      if (used + n > limit) return null;
      used += n;
      return {
        release: () => {
          used -= n;
        },
      };
    },
    // Rebases on the database, which already counts everything this request has
    // written — so this both picks up OTHER requests' inserts and drops our own
    // local tally, and must only be called with nothing in flight.
    refresh: async () => {
      used = await readCount();
    },
    isFull: () => used >= limit,
    exceeded,
  };
}

/**
 * Looks up the org's current plan and asserts that the relevant resource
 * count is below its plan limit. Throws a `plan_limit_exceeded` ServiceError
 * with a friendly message that the UI can surface as an upgrade nudge.
 */
export async function assertPlanLimit(
  ctx: ServiceContext,
  resource: 'items' | 'locations' | 'members',
  /**
   * Number of rows about to be added. Default 1 (matches the original
   * single-create semantics). Bulk-create flows (e.g. sized variant
   * insert) pass the batch size so the check stays a single round trip
   * and the error message reflects the real ask.
   */
  addCount: number = 1,
): Promise<void> {
  const budget = await planLimitBudget(ctx, resource);
  if (!budget.take(addCount)) throw budget.exceeded();
}
