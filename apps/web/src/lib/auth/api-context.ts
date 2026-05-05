import 'server-only';

import { createClient } from '@/lib/supabase/server';
import type { ServiceContext } from '@/server/services/context';

import type { Role } from '@stockpilot/core';

/**
 * Builds a ServiceContext for use inside an API route handler. Unlike
 * `withContext()` (which goes through requireOrgContext and *redirects*
 * to /signin when unauthed), this returns null so the route can respond
 * with a proper 401 — redirects don't make sense for an API caller.
 *
 * API routes are excluded from the proxy middleware, which is why the
 * normal session-via-request-header path doesn't work here. We auth
 * directly against Supabase using the cookies the browser sent.
 */
export async function withApiContext(): Promise<ServiceContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .not('accepted_at', 'is', null)
    .limit(1)
    .maybeSingle();
  if (!member) return null;

  return {
    organizationId: member.organization_id as string,
    userId: user.id,
    role: member.role as Role,
    supabase,
  };
}
