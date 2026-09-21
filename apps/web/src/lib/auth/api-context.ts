import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';
import { effectiveModules } from '@/lib/modules/effective-modules';
import { accountIsDisabledOrThrow, loadAccountStatus } from '@/lib/auth/account-status';
import type { ServiceContext } from '@/server/services/context';

import { parseRequestContextBundle } from '@/lib/auth/request-context-bundle';

import type { Role, Database, ModuleId, Permission } from '@stockpilot/core';
import { effectivePermissions, isAdminRole } from '@stockpilot/core';

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
  let policy: MfaPolicy;
  try {
    const { data: org } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', organizationId)
      .maybeSingle();
    policy = (org?.mfa_policy as MfaPolicy | undefined) ?? 'optional';
  } catch (err) {
    // Fail CLOSED — assume MFA is required and unsatisfied. A flaky
    // org lookup must NOT silently let an admin bypass MFA on the
    // bearer/API path either. Mirrors resolveMfaState() in
    // services/context.ts for parity between cookie and bearer flows.
    console.error('[resolveApiMfaState] failed:', err);
    return { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: hasVerifiedFactor };
  }
  return mfaFromPolicy(supabase, policy, role, hasVerifiedFactor, bearerAal);
}

type MfaPolicy = 'optional' | 'admins_required' | 'all_required';

/**
 * The MFA decision once the org's policy is known. Split out of
 * resolveApiMfaState so the one-round-trip path below can hand the policy
 * straight over: it already came back with the membership.
 */
async function mfaFromPolicy(
  supabase: any,
  policy: MfaPolicy,
  role: Role,
  hasVerifiedFactor: boolean,
  bearerAal?: 'aal1' | 'aal2' | null,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled: boolean }> {
  let mfaRequired = false;
  let mfaSatisfied = false;
  try {
    const policyRequired =
      policy === 'all_required' || (policy === 'admins_required' && isAdminRole(role));
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
 * The whole request context in ONE round trip, for both API paths.
 *
 * WHY. `/api/**` is deliberately outside the proxy matcher (src/proxy.ts: "API
 * routes always handle their own auth"), so the verified-identity header the
 * page path keys its bundle on is never set here and
 * `loadRequestContextBundle()` returns null. The API builder therefore kept
 * doing what the page path stopped doing in migration 0355: seven to nine
 * separate reads, in serial waves, on every call. Measured locally on a
 * dashboard load, `/api/v1/me/releases` alone cost 11 Supabase calls — three
 * `user_profiles`, two `organizations`, one each of `auth/user`,
 * `organization_members` and `organization_modules`, plus the release query's
 * own two.
 *
 * This asks `get_request_context()` (0355) with the caller's OWN client, so the
 * same row level security decides the answer on both paths, and the strict
 * parser refuses anything it does not recognise.
 *
 * WHAT IT IS NOT. Not a cache: evaluated per request, so a revoked permission
 * or a disabled account bites on the next call exactly as before. Not a policy:
 * every gate below (membership, account status, MFA, modules, permissions) is
 * the same rule applied to the same rows from a different source.
 *
 * `null` means "resolve this request the old way", and the legacy reads keep
 * every fail-closed rule they have. That covers a deploy ahead of its
 * migration, a failed or unrecognised answer, a profile row the caller cannot
 * read (whose "unreadable" status must stay a 5xx, not a silent "active"), and
 * an organization row hidden by row level security (whose MFA policy and comp
 * flag must never be guessed).
 */
type ApiBundleResolution =
  /** Use the legacy reads. */
  | null
  /** The bundle answered, and the answer is "no": 401, exactly as the legacy path would. */
  | { ok: false }
  | {
      ok: true;
      organizationId: string;
      role: Role;
      mfaPolicy: MfaPolicy;
      enabledModules: Set<ModuleId>;
      permissions: Set<Permission>;
    };

async function resolveApiContextFromBundle(
  supabase: any,
  userId: string,
  requestedOrgId: string | null,
): Promise<ApiBundleResolution> {
  if (process.env.REQUEST_CONTEXT_RPC === 'off') return null;
  try {
    // GET: PostgREST runs a STABLE function in a read-only transaction.
    const { data, error } = await supabase.rpc('get_request_context', undefined, { get: true });
    if (error) {
      // Codes only: never the message, which can quote request details.
      console.warn('[api-context] rpc failed, using the legacy reads:', error.code || 'unknown');
      return null;
    }
    const bundle = parseRequestContextBundle(data, userId);
    // A profile the caller cannot read is NOT "active": the legacy path turns
    // that into a 5xx through accountIsDisabledOrThrow, and it must keep doing so.
    if (!bundle?.profile) return null;
    if (bundle.profile.disabled_at !== null) return { ok: false };

    // The same three-step choice pickActiveMembership makes, against the same
    // accepted-memberships-only set, already ordered oldest first by 0355.
    const held = requestedOrgId
      ? (bundle.memberships.find((m) => m.organization_id === requestedOrgId) ?? null)
      : (bundle.memberships.find(
          (m) => m.organization_id === bundle.profile?.default_organization_id,
        ) ??
        bundle.memberships[0] ??
        null);
    // A requested organization the caller is not an accepted member of is a
    // refusal, not a fallback — the legacy path returns null for it too.
    if (!held) return { ok: false };
    // No organization row means row level security hid it. Its `mfa_policy`
    // would silently become 'optional' and its comp flag false, so neither is
    // guessed here: the legacy reads run and fail closed on their own terms.
    if (!held.organization) return null;

    return {
      ok: true,
      organizationId: held.organization_id,
      role: held.role,
      mfaPolicy: held.organization.mfa_policy ?? 'optional',
      enabledModules: effectiveModules(
        held.enabled_modules.map((module_id) => ({ module_id })),
        held.organization.all_modules_comp,
      ),
      // The SAME bundle the role came from, so a role and the overrides that
      // modify it can never be read from two different moments. Owner is never
      // overridable, exactly as resolvePermissions() has it on the page path.
      permissions:
        held.role === 'owner'
          ? effectivePermissions('owner')
          : effectivePermissions(held.role, held.role_overrides, held.user_overrides),
    };
  } catch {
    // A fixed string, never the error: it can quote request details.
    console.warn('[api-context] bundle call threw, using the legacy reads');
    return null;
  }
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
  // Rows AND the comp flag, exactly as the dashboard resolves them. This read
  // the rows alone until 2026-09, so a comped organization with no explicit
  // rows had every module on the web and none through /api/v1: module-gated
  // routes refused it, and the mobile snapshot hid its navigation.
  const [mods, org] = await Promise.all([
    supabase
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', organizationId)
      .eq('enabled', true),
    supabase
      .from('organizations')
      .select('all_modules_comp')
      .eq('id', organizationId)
      .maybeSingle(),
  ]);
  if (mods.error) {
    // Fail open for core / closed for optional (empty set). Log so a silent
    // empty set is distinguishable from "org genuinely has no optional modules".
    console.error('[resolveApiEnabledModules] failed:', mods.error);
  }
  if (org.error) {
    // An unreadable flag grants NOTHING: fall back to the explicit rows.
    console.error('[resolveApiEnabledModules] comp flag unreadable:', org.error);
  }
  const comped = org.error
    ? false
    : (org.data as { all_modules_comp?: boolean | null } | null)?.all_modules_comp === true;
  return effectiveModules(mods.data as Array<{ module_id: string }> | null, comped);
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
    (profile as { default_organization_id: string | null } | null)?.default_organization_id ?? null;
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
    // Oldest first, like loadSessionAndContext and get_request_context() (0355):
    // the page and the cookie-authed /api calls it makes must agree on the
    // organization of a user who has several and no valid default.
    .order('created_at', { ascending: true })
    .order('organization_id', { ascending: true })
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

    // One round trip for membership, account status, MFA policy, modules and
    // permissions. Falls through to the reads below whenever it cannot answer.
    const fast = await resolveApiContextFromBundle(supabase, userRes.user.id, requestedOrgId);
    if (fast) {
      if (!fast.ok) return null;
      return {
        organizationId: fast.organizationId,
        userId: userRes.user.id,
        role: fast.role,
        permissions: fast.permissions,
        supabase,
        ...(await mfaFromPolicy(
          supabase,
          fast.mfaPolicy,
          fast.role,
          userHasVerifiedFactor(userRes.user),
          // The bearer client has no stored session, so read AAL from the token
          // itself (already verified above by adminAuth.auth.getUser(bearer)).
          aalFromJwt(bearer),
        )),
        enabledModules: fast.enabledModules,
      };
    }

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

  // Same one round trip as the bearer branch above.
  const fast = await resolveApiContextFromBundle(supabase, user.id, requestedOrgId);
  if (fast) {
    if (!fast.ok) return null;
    return {
      organizationId: fast.organizationId,
      userId: user.id,
      role: fast.role,
      permissions: fast.permissions,
      supabase,
      // No bearer AAL on this path: the cookie client reads its own assurance
      // level, exactly as it did before.
      ...(await mfaFromPolicy(supabase, fast.mfaPolicy, fast.role, userHasVerifiedFactor(user))),
      enabledModules: fast.enabledModules,
    };
  }

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
  const enabledModules = await resolveApiEnabledModules(supabase, member.organization_id as string);
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
