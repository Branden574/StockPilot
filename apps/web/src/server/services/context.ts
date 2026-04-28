import 'server-only';

import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

import type { Permission, Role } from '@stockpilot/core';
import { hasPermission } from '@stockpilot/core';

export interface ServiceContext {
  organizationId: string;
  userId: string;
  role: Role;
  supabase: Awaited<ReturnType<typeof createClient>>;
}

export async function withContext(): Promise<ServiceContext> {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
    supabase,
  };
}

export class ServiceError extends Error {
  constructor(
    public code: 'unauthenticated' | 'forbidden' | 'not_found' | 'validation_error' | 'plan_limit_exceeded' | 'conflict' | 'internal_error',
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
