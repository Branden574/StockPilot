import 'server-only';

import { cache } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import {
  getMfaFactorsForRequest,
  getModulesForRequest,
  getOrgRowForRequest,
} from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';

import type { Permission, PlanId, Role } from '@stockpilot/core';
import { hasPermission, isAdminRole, isUnlimited, MODULE_REGISTRY, PLANS } from '@stockpilot/core';
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
  supabase: Awaited<ReturnType<typeof createClient>>;
  /**
   * Whether the user's session must satisfy MFA AAL2 before any
   * permission gate fires. Computed once at context build time
   * by reading the org's mfa_policy and the session's current AAL.
   */
  mfaRequired: boolean;
  /** True only when the session is currently at AAL2. */
  mfaSatisfied: boolean;
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
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean }> {
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
    const mfaRequired =
      policy === 'all_required' ||
      (policy === 'admins_required' && isAdminRole(role));
    if (!mfaRequired) {
      return { mfaRequired: false, mfaSatisfied: true };
    }
    // SHORT-CIRCUIT: a user with NO verified factor can never be at AAL2, so
    // skip the `auth.mfa.getAuthenticatorAssuranceLevel()` round-trip and
    // fail closed directly. The factor list is request-cached (the layout
    // already loaded it). Only when a verified factor exists do we spend the
    // AAL round-trip to confirm the session actually stepped up. Same
    // fail-closed outcome as before, fewer round-trips.
    const factors = await getMfaFactorsForRequest();
    const hasVerifiedFactor = factors.some((f) => f.status === 'verified');
    if (!hasVerifiedFactor) {
      return { mfaRequired: true, mfaSatisfied: false };
    }
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return { mfaRequired: true, mfaSatisfied: data?.currentLevel === 'aal2' };
  } catch (err) {
    // Fail CLOSED — assume MFA is required and unsatisfied. A flaky
    // org lookup must NOT silently let an admin bypass MFA. The user
    // sees a clear "MFA required" error instead of silent bypass;
    // matches enterprise expectations from the org MFA policy.
    console.error('[resolveMfaState] failed:', err);
    return { mfaRequired: true, mfaSatisfied: false };
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
  const [{ mfaRequired, mfaSatisfied }, enabledModules] = await Promise.all([
    resolveMfaState(supabase, ctx.organizationId, ctx.role),
    getModulesForRequest(ctx.organizationId),
  ]);
  logContextTiming('withContext', startMs);
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
    supabase,
    mfaRequired,
    mfaSatisfied,
    enabledModules,
  };
});

export class ServiceError extends Error {
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
    super(message);
    this.name = 'ServiceError';
  }
}

export function assertPermission(ctx: ServiceContext, permission: Permission) {
  // MFA gate FIRST. If the org policy requires MFA and the session
  // is at AAL1, no permission check applies — the user must
  // step up before doing anything privileged. The dashboard layout
  // already shows a banner pointing them to /dashboard/settings/mfa
  // (which doesn't go through assertPermission, so enrollment still
  // works at AAL1).
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    throw new ServiceError(
      'forbidden',
      'Multi-factor authentication required. Enroll in MFA before performing this action.',
      { reason: 'mfa_required' },
    );
  }
  if (!hasPermission(ctx.role, permission)) {
    throw new ServiceError('forbidden', `Missing permission: ${permission}`);
  }
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
  const { data: org } = await ctx.supabase
    .from('organizations')
    .select('plan')
    .eq('id', ctx.organizationId)
    .single();
  const plan: PlanId = ((org?.plan as PlanId | undefined) ?? 'free') as PlanId;
  const limit = PLANS[plan].limits[resource];
  if (isUnlimited(limit)) return;

  const table =
    resource === 'items'
      ? 'inventory_items'
      : resource === 'locations'
        ? 'locations'
        : 'organization_members';

  let query = ctx.supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId);

  if (resource === 'items' || resource === 'locations') {
    query = query.is('deleted_at', null);
  }
  if (resource === 'members') {
    query = query.not('accepted_at', 'is', null);
  }

  const { count } = await query;
  if ((count ?? 0) + addCount > limit) {
    throw new ServiceError(
      'plan_limit_exceeded',
      `You've reached your ${PLANS[plan].name} plan limit of ${limit} ${resource}. Upgrade to add more.`,
      { plan, limit, resource },
    );
  }
}
