import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';
import type { ServiceContext } from '@/server/services/context';

import type { Role, Database } from '@stockpilot/core';
import { isAdminRole } from '@stockpilot/core';

/**
 * Mirror of resolveMfaState() in context.ts but parameterized over an
 * arbitrary Supabase client (cookie-bound or bearer-bound). Both auth
 * paths in withApiContext need the same MFA gate the cookie path
 * gets via withContext().
 */
async function resolveApiMfaState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  organizationId: string,
  role: Role,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean }> {
  let mfaRequired = false;
  let mfaSatisfied = false;
  try {
    const { data: org } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', organizationId)
      .maybeSingle();
    const policy =
      (org?.mfa_policy as 'optional' | 'admins_required' | 'all_required' | undefined) ??
      'optional';
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

/**
 * Builds a ServiceContext for use inside an API route handler. Two paths:
 *
 *   1. Cookie-based (web fetches from the dashboard) — uses the SSR
 *      Supabase client. This is what the original implementation did.
 *
 *   2. Bearer-token (mobile or other native callers) — when the request
 *      carries `Authorization: Bearer <access_token>`, we build a fresh
 *      Supabase client bound to that JWT. Lets the React Native app hit
 *      our API routes without a cookie jar.
 *
 * Returns null when neither path resolves a user — the caller should
 * 401. Redirect-to-/signin behavior is intentionally NOT done here
 * because API routes don't have a useful redirect target.
 */
export async function withApiContext(req?: Request): Promise<ServiceContext | null> {
  const auth = req?.headers.get('authorization') ?? null;
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

  if (bearer) {
    // Bearer path: validate the JWT against the Auth API and bind a
    // fresh client to it so subsequent queries enforce that user's RLS.
    const adminAuth = createSupabaseClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    const { data: userRes, error } = await adminAuth.auth.getUser(bearer);
    if (error || !userRes.user) return null;

    const supabase = createSupabaseClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        global: { headers: { Authorization: `Bearer ${bearer}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data: member } = await supabase
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userRes.user.id)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle();
    if (!member) return null;
    const mfa = await resolveApiMfaState(
      supabase,
      member.organization_id as string,
      member.role as Role,
    );
    return {
      organizationId: member.organization_id as string,
      userId: userRes.user.id,
      role: member.role as Role,
      supabase,
      mfaRequired: mfa.mfaRequired,
      mfaSatisfied: mfa.mfaSatisfied,
    };
  }

  // Cookie path (existing web flow).
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

  const mfa = await resolveApiMfaState(
    supabase,
    member.organization_id as string,
    member.role as Role,
  );
  return {
    organizationId: member.organization_id as string,
    userId: user.id,
    role: member.role as Role,
    supabase,
    mfaRequired: mfa.mfaRequired,
    mfaSatisfied: mfa.mfaSatisfied,
  };
}
