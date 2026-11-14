import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';
import { guardedServerSupabaseFetch } from '@/lib/supabase/url-length-guard.server';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';
import { effectiveModules, NON_CORE_MODULE_IDS } from '@/lib/modules/effective-modules';
import { moduleSetFromReads } from '@/lib/modules/module-state';
import { accountIsDisabledOrThrow, loadAccountStatus } from '@/lib/auth/account-status';
import { bearerTokenFrom, refusesCrossSiteCookieWrite } from '@/lib/auth/cross-site-request';
import { readVerifiedSessionClaimsOf } from '@/lib/auth/verified-claims';
import type { ServiceContext } from '@/server/services/context';

import {
  holdMembership,
  parseRequestContextBundle,
  type BundleMembership,
} from '@/lib/auth/request-context-bundle';

import type { Role, Database, ModuleId, Permission } from '@stockpilot/core';
import { effectivePermissions, isAdminRole, stepUpOwed } from '@stockpilot/core';

import { enforcedMfaPolicy, type MfaPolicy } from '@/lib/auth/mfa-policy';

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

/** A session's assurance level; null when it cannot be read, which counts as not aal2. */
type SessionAal = 'aal1' | 'aal2' | null;

/**
 * The level of the session the request came with, read only when a rule needs
 * it: the bearer token's own claim (aalFromJwt), or on the cookie path the
 * level of the validated user's own session (cookieSessionLevel).
 */
type SessionLevelReader = () => Promise<SessionAal>;

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
  // The session's level, read only when MFA is required. Couldn't read
  // (null, or a throw) → fail closed.
  level: SessionLevelReader,
): Promise<{ mfaRequired: boolean; mfaSatisfied: boolean; mfaEnrolled: boolean }> {
  let policy: MfaPolicy;
  try {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', organizationId)
      .maybeSingle();
    // THE ERROR IS NOT A THROW. postgrest-js resolves a failed request as
    // `{ data: null, error }` unless throwOnError is set, and it is not set
    // anywhere in this app — so a statement timeout, a gateway 5xx or a lock on
    // `organizations` used to land on `?? 'optional'` and turn the MFA gate
    // OFF for anyone not already enrolled. Since 0167 the stored default is
    // 'admins_required', so that fallback was more permissive than any real
    // organization's policy.
    //
    // An unreadable authorization input must deny. This is what the page path
    // already does (lib/dashboard/request-cache.ts throws on `error`, and
    // resolveMfaState's catch fails closed) and what the sibling read in this
    // same file already does ("an unreadable flag grants NOTHING").
    //
    // Zero rows is not an error: `maybeSingle()` reports it as
    // `{ data: null, error: null }`. It means row level security hid the row
    // from this member, and since 2026-09-22 that is held to the STRICTEST
    // policy instead of 'optional' (lib/auth/mfa-policy.ts).
    if (error) throw new Error(`mfa_policy unreadable: ${error.code || 'unknown'}`);
    policy = enforcedMfaPolicy(org);
  } catch (err) {
    // Fail CLOSED — assume MFA is required and unsatisfied. A flaky
    // org lookup must NOT silently let an admin bypass MFA on the
    // bearer/API path either. Mirrors resolveMfaState() in
    // services/context.ts for parity between cookie and bearer flows.
    console.error('[resolveApiMfaState] failed:', err);
    return { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: hasVerifiedFactor };
  }
  return mfaFromPolicy(policy, role, hasVerifiedFactor, level);
}

/**
 * The MFA decision once the org's policy is known. Split out of
 * resolveApiMfaState so the one-round-trip path below can hand the policy
 * straight over: it already came back with the membership.
 */
async function mfaFromPolicy(
  policy: MfaPolicy,
  role: Role,
  hasVerifiedFactor: boolean,
  level: SessionLevelReader,
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
      // The bearer token's own claim, or the validated cookie user's own
      // level: never a level read from a session the request cannot tie to
      // the user it validated (docket S43a, review round 1).
      mfaSatisfied = (await level()) === 'aal2';
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
 * separate reads, in serial waves, on every call.
 *
 * Measured locally on a dashboard load, `/api/v1/me/releases` cost 11 Supabase
 * calls in total. NINE of them are this builder: one `auth/v1/user`, two
 * `user_profiles` (the membership choice and the account-status check), one
 * `organization_members`, two `organizations` (the MFA policy and the comp
 * flag), one `organization_modules`, and the two permission-override tables —
 * ten when a user with no default organization needs the extra membership
 * query. The other two are the route's own reads.
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
 * flag must never be guessed). The same holds for the permission overrides:
 * when the legacy loader cannot read a non-owner's, it throws
 * PermissionsUnavailableError, a 5xx, never the role's defaults and never the
 * `null` every route answers as 401 (docket S19).
 *
 * Neither path writes the request's work: this module and everything it loads
 * only read (lib/auth/api-context.read-only.guard.test.ts). That is what lets
 * apiContextGate (server/lib/api-context-gate.ts) answer those two throws as a
 * 503 marked as refused before any write, which the phone may send again
 * (docket S26). A write added here would make it send a change twice.
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
      /** The membership that answered, attached to the context it produces
       *  (holdMembership): a catalog load reads the organization's
       *  ordering-visibility hide mark from it with no round trip (0413). */
      held: BundleMembership;
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
    if (!bundle) {
      // NOT a legitimate answer: a shape this code does not understand, which
      // is permanent for this caller and now costs the RPC ON TOP OF the full
      // legacy reads. Logged for the same reason the page path logs it — a
      // fast path that is permanently dead must not be invisible.
      console.warn('[api-context] unexpected answer, using the legacy reads');
      return null;
    }
    // A profile the caller cannot read is NOT "active": the legacy path turns
    // that into a 5xx through accountIsDisabledOrThrow, and it must keep doing
    // so. That IS a legitimate answer, so it stays quiet.
    if (!bundle.profile) return null;
    if (bundle.profile.disabled_at !== null) return { ok: false };

    // The same three-step choice pickActiveMembership makes, against the same
    // accepted-memberships-only set, already ordered oldest first by 0355.
    // Postgres compared `X-Organization-Id` as a uuid, which ignores case; a
    // JS `===` does not, and iOS hands out UPPERCASE uuid strings by default.
    // Matching case-sensitively here would 401 a caller the legacy path served.
    const wanted = requestedOrgId?.toLowerCase() ?? null;
    const held = wanted
      ? (bundle.memberships.find((m) => m.organization_id.toLowerCase() === wanted) ?? null)
      : (bundle.memberships.find(
          (m) => m.organization_id === bundle.profile?.default_organization_id,
        ) ??
        bundle.memberships[0] ??
        null);
    // A requested organization the caller is not an accepted member of is a
    // refusal, not a fallback — the legacy path returns null for it too.
    if (!held) return { ok: false };
    // No organization row means row level security hid it from a member, which
    // should not happen. Hand it to the legacy reads rather than invent a comp
    // flag here. They hold the session to the STRICTEST MFA policy, not
    // 'optional', so this fallback is no more permissive than this path.
    if (!held.organization) return null;

    return {
      ok: true,
      organizationId: held.organization_id,
      role: held.role,
      mfaPolicy: enforcedMfaPolicy(held.organization),
      enabledModules: effectiveModules(
        held.enabled_modules.map((module_id) => ({ module_id })),
        held.organization.all_modules_comp,
      ),
      // The SAME bundle the role came from, so a role and the overrides that
      // modify it can never be read from two different moments. Owner is never
      // overridable except for a platform-managed key StockPilot denied them
      // (core effectivePermissions applies only that), exactly as
      // resolvePermissions() has it on the page path.
      permissions: effectivePermissions(held.role, held.role_overrides, held.user_overrides),
      held,
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
 * The assurance level of a COOKIE session, as the session of `userId`, the
 * user getUser() just validated on this client: the `aal` of the access token
 * the session holds once its signature checks out, and only when that token's
 * subject is `userId` (readVerifiedSessionClaimsOf). Anything else is null,
 * which every rule here counts as not aal2.
 *
 * WHY NOT getAuthenticatorAssuranceLevel() (docket S43a, review round 1). It
 * LOADS the stored session again and decodes whatever that load returns, and a
 * load refreshes the session, with the cookie's own refresh token, whenever the
 * cookie's own `expires_at` says it is within 90 s of expiry (auth-js
 * __loadSession). Whoever sends the cookie writes both fields: an enrolled
 * member's aal1 access token (the password alone gives it), which getUser()
 * validates, beside the refresh token of ANOTHER account's aal2 session, timed
 * to pass the margin while GoTrue answers /user. The level then came from the
 * other account's session, so the refusal below passed and the context was
 * labelled satisfied. A refresh of the member's own session keeps its subject,
 * so it still answers.
 */
async function cookieSessionLevel(supabase: any, userId: string): Promise<SessionAal> {
  try {
    return (await readVerifiedSessionClaimsOf(supabase, userId))?.aal ?? null;
  } catch {
    // Unreadable: null, which the rules count as not aal2.
    return null;
  }
}

/**
 * core's stepUpOwed() over `factors`, with the level read only when it can
 * matter: the rule owes nothing to an account with no verified factor at any
 * level, so a caller who never enrolled pays no read.
 */
async function owesStepUp(
  factors: Array<{ status?: string }> | null | undefined,
  level: SessionLevelReader,
): Promise<boolean> {
  // Owed at no level at all means never owed: no verified factor, no read.
  if (!stepUpOwed(factors, null)) return false;
  return stepUpOwed(factors, await level());
}

/**
 * Whether a COOKIE session still owes its authenticator code (docket S43a):
 * core's stepUpOwed() over the user getUser() just returned and the level of
 * THAT user's own session (cookieSessionLevel). An error, a throw, a missing
 * level, or a session that now holds another account counts as not aal2
 * (fail closed).
 *
 * Exported for the routes that build their own principal from the cookie
 * session instead of calling withApiContext (the QuickBooks and Sage Intacct
 * OAuth callbacks), so they ask the same question the same way
 * (src/test/api-step-up.guard.test.ts holds them to it). Call it with the user
 * getUser() returned on the same client.
 */
export async function cookieSessionOwesStepUp(
  supabase: any,
  user: { id: string; factors?: Array<{ status?: string }> | null },
): Promise<boolean> {
  return owesStepUp(user.factors, () => cookieSessionLevel(supabase, user.id));
}

/**
 * Mirror of the enabled-module query in withContext() (services/context.ts),
 * parameterized over an arbitrary Supabase client so both the cookie and
 * bearer API paths populate ctx.enabledModules and assertModuleEnabled()
 * works inside API route handlers. Core modules are always treated as
 * enabled by assertModuleEnabled even if absent from this set.
 *
 * One difference from withContext(), on purpose (docket S81): when a read
 * fails, the module state that read would have decided is unknown here, not
 * off (lib/modules/module-state.ts), so a phone is never told a module is off
 * because a read failed.
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
  // A failed read is NOT "off" (docket S81). supabase-js resolves it as
  // `{ data: null, error }`, and a set built from that alone would be the set
  // of an organization that switched every module off. So what the reads that
  // worked say is on stays on (an unreadable flag still grants nothing); any
  // other module's state is unknown, and asking about it, or listing the set,
  // throws ModulesUnavailableError (lib/modules/module-state.ts), which the
  // phone retries. Codes only: the message can quote request details.
  //
  // Only a list of rows that each name a module is an answer. postgrest-js
  // resolves an empty body with no error and data null (a 2xx as it came, a
  // 404 rewritten to 204), the same shape effective-permissions.ts refuses
  // for the overrides, so that counts as a failed read too.
  const rowsUnread =
    Boolean(mods.error) ||
    !Array.isArray(mods.data) ||
    (mods.data as unknown[]).some(
      (r) =>
        !r || typeof r !== 'object' || typeof (r as { module_id?: unknown }).module_id !== 'string',
    );
  if (mods.error) {
    console.error('[resolveApiEnabledModules] rows unreadable:', mods.error.code || 'unknown');
  } else if (rowsUnread) {
    console.error('[resolveApiEnabledModules] rows unreadable: not a list of module rows');
  }
  // The comp flag is a NOT NULL boolean, so only an organization row that
  // carries a boolean flag is an answer. No row without an error is row
  // level security hiding it from a member, the case the one-round-trip read
  // hands here on purpose (resolveApiContextFromBundle: `if
  // (!held.organization) return null`); the MFA policy read above holds a
  // hidden row to the strictest policy. Either way the flag was never seen,
  // so it counts as a failed read and grants nothing.
  const orgRow = org.data as { all_modules_comp?: unknown } | null;
  const compUnread =
    Boolean(org.error) ||
    !orgRow ||
    typeof orgRow !== 'object' ||
    typeof orgRow.all_modules_comp !== 'boolean';
  if (org.error) {
    console.error('[resolveApiEnabledModules] comp flag unreadable:', org.error.code || 'unknown');
  }
  const comped = compUnread ? false : orgRow!.all_modules_comp === true;
  const known = effectiveModules(
    rowsUnread ? null : (mods.data as Array<{ module_id: string }>),
    comped,
  );
  const readFailed = rowsUnread || compUnread;
  return moduleSetFromReads(known, readFailed, NON_CORE_MODULE_IDS);
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
 * The Supabase SSR client's session cookie, `sb-<projectRef>-auth-token[.N]`.
 * Without one in the request there is no cookie session to read.
 */
const SUPABASE_AUTH_COOKIE_RE = /(?:^|;\s*)sb-[^=]+-auth-token(?:\.\d+)?=/;

/**
 * One warning per refused cookie write, so a refusal of the app's own traffic
 * (a proxy that renames the host or strips both headers, a browser that
 * misreports) shows in the runtime logs. Only a write that came with a session
 * cookie is logged: without one the answer was null anyway, and a bot's bare
 * POST is not news. The method, the path, Sec-Fetch-Site and the Origin's host
 * only (null when the header was absent): never the query string, a cookie or
 * a token.
 */
function logRefusedCrossSiteWrite(req: Request): void {
  let path = '(unreadable)';
  try {
    path = new URL(req.url).pathname;
  } catch {
    // Keep the placeholder.
  }
  const origin = req.headers.get('origin');
  let originHost: string | null = null;
  if (origin !== null) {
    try {
      originHost = origin === 'null' ? 'null' : new URL(origin).host || '(no host)';
    } catch {
      originHost = '(unreadable)';
    }
  }
  console.warn('[api-context] refused a cookie-authenticated write not sent from this origin', {
    method: req.method,
    path,
    secFetchSite: req.headers.get('sec-fetch-site')?.slice(0, 32) ?? null,
    originHost: originHost?.slice(0, 255) ?? null,
  });
}

/**
 * One info line per request refused because its session still owes the
 * authenticator code (docket S43a), so the refusal of a real person's phone or
 * tab shows in the runtime logs. Info, not a report: a phone that is not
 * updated yet makes a few of these a minute at its code screen, and that is
 * the rule working, not a fault. The method, the path and which way the
 * session came (bearer or cookie): never the query string, a token, a cookie
 * or an address.
 */
function logStepUpRefused(req: Request | undefined, via: 'bearer' | 'cookie'): void {
  let path = '(unreadable)';
  try {
    if (req) path = new URL(req.url).pathname;
  } catch {
    // Keep the placeholder.
  }
  console.info('[api-context] refused a session that still owes its authenticator code', {
    method: req?.method ?? '(none)',
    path,
    via,
  });
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
 *
 * The cookie path also returns null for a write (any method but GET, HEAD and
 * OPTIONS) that a browser did not send from a page of this origin, before the
 * session is read: another origin, one it will not name, or neither Origin nor
 * Sec-Fetch-Site at all (docket S14, lib/auth/cross-site-request.ts). Pass the
 * request the route received, or one built from it with the same method, URL
 * and headers: the rule reads all three.
 *
 * Both paths return null, right after the identity check and before anything
 * is read, for an account with a verified authenticator factor whose session
 * is not aal2 (docket S43a, core stepUpOwed): a password alone reads nothing
 * through the API. Before, the session was only labelled (mfaRequired,
 * mfaSatisfied) and the refusal was left to assertPermission, which the
 * snapshot, the order reads and the exports never call. Null, not a 403:
 * every route answers it as its own 401, and phones already installed retry a
 * 401 and keep their queued work, where a 403 would drop it. The level is the
 * validated user's own: the bearer token's claim, or on the cookie path the
 * verified token of a session whose subject is the user getUser() returned
 * (cookieSessionLevel), so a cookie that refreshes into another account's
 * session mid-request reads as not aal2, for the refusal and the label alike.
 * `opts.allowStepUpPending` skips that one refusal, for a route that must
 * answer before the code (AAL1_ROUTES in src/test/api-step-up.guard.test.ts,
 * the only files allowed to pass it). Such a route gets the context as
 * before, labelled mfaSatisfied false, so assertPermission still refuses it
 * every permission.
 */
export async function withApiContext(
  req?: Request,
  opts?: { allowStepUpPending?: true },
): Promise<ServiceContext | null> {
  const bearer = bearerTokenFrom(req);

  if (bearer) {
    // Bearer path: validate the JWT against the Auth API and bind a
    // fresh client to it so subsequent queries enforce that user's RLS.
    const adminAuth = createSupabaseClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    const { data: userRes, error } = await adminAuth.auth.getUser(bearer);
    if (error || !userRes.user) return null;

    // THE AUTHENTICATOR CODE (docket S43a). The factors are GoTrue's answer for
    // this token's user; the level is the token's own claim, safe to read now
    // that GoTrue accepted the token. Refused before the client below exists,
    // so nothing is read for it.
    const bearerAal = aalFromJwt(bearer);
    if (!opts?.allowStepUpPending && stepUpOwed(userRes.user.factors, bearerAal)) {
      logStepUpRefused(req, 'bearer');
      return null;
    }
    // The bearer client has no stored session, so the MFA label reads the
    // level from the token itself too (already verified above by
    // adminAuth.auth.getUser(bearer)).
    const level: SessionLevelReader = async () => bearerAal;

    const supabase = createSupabaseClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        // The guard refuses a PostgREST URL too long to succeed instead of
        // letting it fail after ~7 s of retries (see url-length-guard.ts).
        global: {
          headers: { Authorization: `Bearer ${bearer}` },
          fetch: guardedServerSupabaseFetch,
        },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const requestedOrgId = req?.headers.get('x-organization-id') ?? null;

    // One round trip for membership, account status, MFA policy, modules and
    // permissions. Falls through to the reads below whenever it cannot answer.
    const fast = await resolveApiContextFromBundle(supabase, userRes.user.id, requestedOrgId);
    if (fast) {
      if (!fast.ok) return null;
      return holdMembership<ServiceContext>(
        {
          organizationId: fast.organizationId,
          userId: userRes.user.id,
          role: fast.role,
          permissions: fast.permissions,
          supabase,
          ...(await mfaFromPolicy(
            fast.mfaPolicy,
            fast.role,
            userHasVerifiedFactor(userRes.user),
            level,
          )),
          enabledModules: fast.enabledModules,
        },
        fast.held,
      );
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
    // have access to that". Through apiContextGate that 5xx is the 503 marked
    // as refused before any write (docket S26), since nothing here writes.
    if (accountIsDisabledOrThrow(status)) return null;
    const mfa = await resolveApiMfaState(
      supabase,
      member.organization_id as string,
      member.role as Role,
      userHasVerifiedFactor(userRes.user),
      level,
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
  const cookieHeader = req?.headers.get('cookie') ?? '';
  const hasSessionCookie = SUPABASE_AUTH_COOKIE_RE.test(cookieHeader);

  // A write a browser did not send from a page of this origin is refused first
  // (docket S14): another origin, one it will not name, or neither Origin nor
  // Sec-Fetch-Site (fail closed: every supported browser sends Origin on a
  // write). The browser attaches the session cookie whatever page made the
  // request, and SameSite=Lax still lets a page on a sibling subdomain post
  // with it; a route handler gets no Origin check from the framework the way a
  // server action does. Null is every caller's signed-out answer, so the
  // refusal needs no route change, and nothing below (getUser, the context
  // RPC) runs for it.
  if (req && refusesCrossSiteCookieWrite(req)) {
    if (hasSessionCookie) logRefusedCrossSiteWrite(req);
    return null;
  }

  // Fast-path: short-circuit when the request carries no Supabase auth
  // cookie at all. Without this, anonymous requests to any /api/*
  // endpoint paid a ~500-700ms round trip to supabase.auth.getUser()
  // just to be told "no user, 401". The Supabase SSR client uses
  // cookies named `sb-<projectRef>-auth-token[.N]`; if zero such
  // cookies are present we already know there's no session and can
  // skip the network call entirely. Anonymous /api/ai/chat now 401s
  // in <50ms instead of ~676ms (measured in production).
  if (!hasSessionCookie) {
    return null;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // The level of THIS user's own session (cookieSessionLevel), read at most
  // once and only when a rule needs it: the refusal below and the MFA label
  // further down take the same answer.
  let levelRead: Promise<SessionAal> | undefined;
  const level: SessionLevelReader = () => (levelRead ??= cookieSessionLevel(supabase, user.id));

  // The same rule as the bearer path, with this user's own level, before the
  // context read below (docket S43a).
  if (!opts?.allowStepUpPending && (await owesStepUp(user.factors, level))) {
    logStepUpRefused(req, 'cookie');
    return null;
  }

  const requestedOrgId = req?.headers.get('x-organization-id') ?? null;

  // Same one round trip as the bearer branch above.
  const fast = await resolveApiContextFromBundle(supabase, user.id, requestedOrgId);
  if (fast) {
    if (!fast.ok) return null;
    return holdMembership<ServiceContext>(
      {
        organizationId: fast.organizationId,
        userId: user.id,
        role: fast.role,
        permissions: fast.permissions,
        supabase,
        ...(await mfaFromPolicy(fast.mfaPolicy, fast.role, userHasVerifiedFactor(user), level)),
        enabledModules: fast.enabledModules,
      },
      fast.held,
    );
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
    level,
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
