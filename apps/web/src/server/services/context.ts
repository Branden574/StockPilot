import 'server-only';

import { cache } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import type { Permission, PlanId, Role } from '@stockpilot/core';
import { hasPermission, isAdminRole, isUnlimited, PLANS } from '@stockpilot/core';

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
}

async function resolveMfaState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  role: Role,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean }> {
  // Best-effort: failures here default to "not required" so a flaky
  // org lookup doesn't lock everyone out. The banner in the
  // dashboard layout still shows the org's MFA status.
  let mfaRequired = false;
  let mfaSatisfied = false;
  try {
    const { data: org } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', organizationId)
      .maybeSingle();
    const policy = (org?.mfa_policy as
      | 'optional'
      | 'admins_required'
      | 'all_required'
      | undefined) ?? 'optional';
    mfaRequired =
      policy === 'all_required' ||
      (policy === 'admins_required' && isAdminRole(role));
    if (mfaRequired) {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      mfaSatisfied = data?.currentLevel === 'aal2';
    } else {
      mfaSatisfied = true;
    }
  } catch {
    mfaRequired = false;
    mfaSatisfied = true;
  }
  return { mfaRequired, mfaSatisfied };
}

export const withContext = cache(async (): Promise<ServiceContext> => {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const { mfaRequired, mfaSatisfied } = await resolveMfaState(
    supabase,
    ctx.organizationId,
    ctx.role,
  );
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
    supabase,
    mfaRequired,
    mfaSatisfied,
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

/**
 * Looks up the org's current plan and asserts that the relevant resource
 * count is below its plan limit. Throws a `plan_limit_exceeded` ServiceError
 * with a friendly message that the UI can surface as an upgrade nudge.
 */
export async function assertPlanLimit(
  ctx: ServiceContext,
  resource: 'items' | 'locations' | 'members',
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
  if ((count ?? 0) >= limit) {
    throw new ServiceError(
      'plan_limit_exceeded',
      `You've reached your ${PLANS[plan].name} plan limit of ${limit} ${resource}. Upgrade to add more.`,
      { plan, limit, resource },
    );
  }
}
