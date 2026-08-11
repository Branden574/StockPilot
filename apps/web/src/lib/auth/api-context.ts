import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';
import { accountIsDisabledOrThrow, loadAccountStatus } from '@/lib/auth/account-status';
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

/** Reads the `session_id` claim from a Supabase access token (already validated
 *  upstream). Used to identify the caller's CURRENT auth.sessions row. */
export function sessionIdFromJwt(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      session_id?: unknown;
    };
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}

async function resolveApiMfaState(

  supabase: any,
  organizationId: string,
  role: Role,
  // True when the (already validated) user has a verified TOTP factor —
  // read off the GoTrue user object both paths have in hand, so it costs
  // no extra auth round-trip. Enrollment escalates: an enrolled factor
  // must be satisfied regardless of org policy (HI-6), and it decides the
  // gate's error shape ('aal2_required' vs 'mfa_required').
  hasVerifiedFactor: boolean,
  // When provided (bearer path), AAL is read from the token's verified `aal`
  // claim instead of getAuthenticatorAssuranceLevel() (which needs a stored
  // session the bearer client doesn't have). null = couldn't read → fail closed.
  bearerAal?: 'aal1' | 'aal2' | null,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled: boolean }> {
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
    const policyRequired =
      policy === 'all_required' ||
      (policy === 'admins_required' && isAdminRole(role));
    // ENROLLMENT ESCALATES (HI-6): mirrors resolveMfaState() in
    // services/context.ts — a verified factor must be satisfied even under
    // an 'optional' policy, or a stolen password alone reaches the API at
    // AAL1 untouched.
    mfaRequired = policyRequired || hasVerifiedFactor;
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
    return { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: hasVerifiedFactor };
  }
  return { mfaRequired, mfaSatisfied, mfaEnrolled: hasVerifiedFactor };
}

/**
 * True when a GoTrue user object carries at least one VERIFIED factor.
 * `getUser()` returns the user's factors inline, so this costs nothing
 * beyond the validation call both withApiContext paths already make.
 * A missing `factors` array reads as unenrolled — identical to the
 * pre-HI-6 behavior for that user, never wider.
 */
function userHasVerifiedFactor(user: { factors?: Array<{ status?: string }> | null }): boolean {
  return (user.factors ?? []).some((f) => f.status === 'verified');
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
    // Status and membership in parallel. The status read is NOT free on this
    // path: pickActiveMembership returns before touching user_profiles whenever
    // an org header is present, which is every mobile request. Issuing both at
    // once keeps the added latency off the hot path.
    const [member, status] = await Promise.all([
      pickActiveMembership(supabase, userRes.user.id, requestedOrgId),
      loadAccountStatus(supabase, userRes.user.id),
    ]);
    if (!member) return null;
    // A disabled account gets the same uniform 401 an anonymous caller gets.
    // The GoTrue ban normally rejects this request one line earlier at
    // getUser(); this is the backstop for the window where the flag landed but
    // the ban write did not.
    //
    // An UNREADABLE status throws instead: it still refuses the request (an
    // authz check that cannot read its input must deny), but as a 5xx the
    // client words as retryable rather than as the 401 it words as "you do not
    // have access to that".
    if (accountIsDisabledOrThrow(status)) return null;
    const mfa = await resolveApiMfaState(
      supabase,
      member.organization_id as string,
      member.role as Role,
      userHasVerifiedFactor(userRes.user),
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
      mfaEnrolled: mfa.mfaEnrolled,
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
  // Same parallel shape as the bearer branch above — a disabled account is
  // refused with the same uniform null (401) an anonymous caller gets.
  const [member, status] = await Promise.all([
    pickActiveMembership(supabase, user.id, requestedOrgId),
    loadAccountStatus(supabase, user.id),
  ]);
  if (!member) return null;
  if (accountIsDisabledOrThrow(status)) return null;

  const mfa = await resolveApiMfaState(
    supabase,
    member.organization_id as string,
    member.role as Role,
    userHasVerifiedFactor(user),
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
    mfaEnrolled: mfa.mfaEnrolled,
    enabledModules,
  };
}
