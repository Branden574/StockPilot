import 'server-only';

import { cache } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import type { Permission, PlanId, Role } from '@stockpilot/core';
import { hasPermission, isUnlimited, PLANS } from '@stockpilot/core';

export interface ServiceContext {
  organizationId: string;
  userId: string;
  role: Role;
  supabase: Awaited<ReturnType<typeof createClient>>;
}

export const withContext = cache(async (): Promise<ServiceContext> => {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
    supabase,
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
