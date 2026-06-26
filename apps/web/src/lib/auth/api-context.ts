import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';
import type { ServiceContext } from '@/server/services/context';

import type { Role, Database, ModuleId } from '@stockpilot/core';
import { isAdminRole } from '@stockpilot/core';

/**
 * Mirror of resolveMfaState() in context.ts but parameterized over an
 * arbitrary Supabase client (cookie-bound or bearer-bound). Both auth
 * paths in withApiContext need the same MFA gate the cookie path
 * gets via withContext().
 */
/**
 * Reads the `aal` claim from a Supabase JWT WITHOUT verifying the signature —
 * the caller MUST have already validated the token (we only call this after
 * `auth.getUser(bearer)` succeeds). Used for the bearer/API path because the
 * bearer-bound client has no stored session, so
 * `auth.mfa.getAuthenticatorAssuranceLevel()` (which reads getSession()) would
 * return currentLevel=null and wrongly report a real AAL2 token as unsatisfied.
 * The token's own `aal` claim is the authoritative AAL of that session.
 */
export function aalFromJwt(token: string): 'aal1' | 'aal2' | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      aal?: unknown;
    };
    return payload.aal === 'aal2' ? 'aal2' : payload.aal === 'aal1' ? 'aal1' : null;
  } catch {
    return null;
  }
}

async function resolveApiMfaState(

  supabase: any,
  organizationId: string,
  role: Role,
  // When provided (bearer path), AAL is read from the token's verified `aal`
  // claim instead of getAuthenticatorAssuranceLevel() (which needs a stored
  // session the bearer client doesn't have). null = couldn't read → fail closed.
  bearerAal?: 'aal1' | 'aal2' | null,
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
      if (bearerAal !== undefined) {
        // Bearer/API path: trust the verified token's own AAL claim.
        mfaSatisfied = bearerAal === 'aal2';
      } else {
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        mfaSatisfied = data?.currentLevel === 'aal2';
      }
    } else {
      mfaSatisfied = true;
    }
  } catch (err) {
    // Fail CLOSED — assume MFA is required and unsatisfied. A flaky
    // org lookup must NOT silently let an admin bypass MFA on the
    // bearer/API path either. Mirrors resolveMfaState() in
    // services/context.ts for parity between cookie and bearer flows.
    console.error('[resolveApiMfaState] failed:', err);
    return { mfaRequired: true, mfaSatisfied: false };
  }
  return { mfaRequired, mfaSatisfied };
}

/**
 * Mirror of the enabled-module query in withContext() (services/context.ts),
 * parameterized over an arbitrary Supabase client so both the cookie and
 * bearer API paths populate ctx.enabledModules and assertModuleEnabled()
 * works inside API route handlers. Core modules are always treated as
 * enabled by assertModuleEnabled even if absent from this set.
 */
async function resolveApiEnabledModules(

  supabase: any,
  organizationId: string,
): Promise<Set<ModuleId>> {
  const { data: modRows, error } = await supabase
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', organizationId)
    .eq('enabled', true);
  if (error) {
    // Fail open for core / closed for optional (empty set). Log so a silent
    // empty set is distinguishable from "org genuinely has no optional modules".
    console.error('[resolveApiEnabledModules] failed:', error);
  }
  return new Set(
    ((modRows ?? []) as Array<{ module_id: string }>).map((r) => r.module_id as ModuleId),
  );
}

/**
 * Resolves the active membership for a bearer-authenticated user.
 *
 *   1. If the request carries `X-Organization-Id`, use that — but only
 *      after verifying the user actually belongs to it. A bad header
 *      returns null (caller 401s) rather than silently falling back,
 *      so a mobile client can't end up scoped to the wrong org if its
 *      requested org was deleted/revoked.
 *   2. Otherwise honor `user_profiles.default_organization_id` (parity
 *      with the cookie path's loadSessionAndContext).
 *   3. Last resort: any active membership.
 */
async function pickActiveMembership(
   
  supabase: any,
  userId: string,
  requestedOrgId: string | null,
): Promise<{ organization_id: string; role: Role } | null> {
  if (requestedOrgId) {
    const { data } = await supabase
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userId)
      .eq('organization_id', requestedOrgId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    return (data as { organization_id: string; role: Role } | null) ?? null;
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('default_organization_id')
    .eq('id', userId)
    .maybeSingle();
  const defaultOrgId =
    (profile as { default_organization_id: string | null } | null)?.default_organization_id ??
    null;
  if (defaultOrgId) {
    const { data } = await supabase
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userId)
      .eq('organization_id', defaultOrgId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (data) return data as { organization_id: string; role: Role };
  }

  const { data } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', userId)
    .not('accepted_at', 'is', null)
    .limit(1)
    .maybeSingle();
  return (data as { organization_id: string; role: Role } | null) ?? null;
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
    const requestedOrgId = req?.headers.get('x-organization-id') ?? null;
    const member = await pickActiveMembership(supabase, userRes.user.id, requestedOrgId);
    if (!member) return null;
    const mfa = await resolveApiMfaState(
      supabase,
      member.organization_id as string,
      member.role as Role,
      // The bearer client has no stored session, so read AAL from the token
      // itself (already verified above by adminAuth.auth.getUser(bearer)).
      aalFromJwt(bearer),
    );
    const enabledModules = await resolveApiEnabledModules(
      supabase,
      member.organization_id as string,
    );
    const permissions = await loadEffectivePermissions(
      supabase,
      member.organization_id as string,
      userRes.user.id,
      member.role as Role,
    );
    return {
      organizationId: member.organization_id as string,
      userId: userRes.user.id,
      role: member.role as Role,
      permissions,
      supabase,
      mfaRequired: mfa.mfaRequired,
      mfaSatisfied: mfa.mfaSatisfied,
      enabledModules,
    };
  }

  // Cookie path (existing web flow). Mirrors the bearer path's
  // default_organization_id preference via pickActiveMembership so a web
  // session with multiple memberships lands on the user's intended org
  // (parity with loadSessionAndContext used by RSC). An `X-Organization-Id`
  // header is honored if present so a cookie-authed client can request a
  // specific org (membership is verified before use).
  //
  // Fast-path: short-circuit when the request carries no Supabase auth
  // cookie at all. Without this, anonymous requests to any /api/*
  // endpoint paid a ~500-700ms round trip to supabase.auth.getUser()
  // just to be told "no user, 401". The Supabase SSR client uses
  // cookies named `sb-<projectRef>-auth-token[.N]`; if zero such
  // cookies are present we already know there's no session and can
  // skip the network call entirely. Anonymous /api/ai/chat now 401s
  // in <50ms instead of ~676ms (measured in production).
  const cookieHeader = req?.headers.get('cookie') ?? '';
  if (cookieHeader && !/(?:^|;\s*)sb-[^=]+-auth-token(?:\.\d+)?=/.test(cookieHeader)) {
    return null;
  }
  if (!cookieHeader) {
    return null;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const requestedOrgId = req?.headers.get('x-organization-id') ?? null;
  const member = await pickActiveMembership(supabase, user.id, requestedOrgId);
  if (!member) return null;

  const mfa = await resolveApiMfaState(
    supabase,
    member.organization_id as string,
    member.role as Role,
  );
  const enabledModules = await resolveApiEnabledModules(
    supabase,
    member.organization_id as string,
  );
  const permissions = await loadEffectivePermissions(
    supabase,
    member.organization_id as string,
    user.id,
    member.role as Role,
  );
  return {
    organizationId: member.organization_id as string,
    userId: user.id,
    role: member.role as Role,
    permissions,
    supabase,
    mfaRequired: mfa.mfaRequired,
    mfaSatisfied: mfa.mfaSatisfied,
    enabledModules,
  };
}
