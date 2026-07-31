import 'server-only';

import { redirect } from 'next/navigation';

import { reportError } from '@/lib/error-reporter';

import {
  ACCOUNT_DISABLED_PATH,
  DISABLED_ACCOUNT_EVENTS,
  isAccountDisabled,
} from '@stockpilot/core';

/**
 * Account-status enforcement — ONE guard, installed at the THREE identity
 * funnels this app has. Every authenticated request resolves its principal
 * through exactly one of them:
 *
 *   1. `loadSessionAndContext` (lib/auth/session.ts) — every RSC page and every
 *      org-scoped Server Action, inherited by all requireOrgContext /
 *      withContext call sites without touching any of them.
 *   2. `withApiContext` (lib/auth/api-context.ts) — the cookie API path and the
 *      Bearer API path (mobile).
 *   3. `resolvePortalContext` (server/services/portal.ts) — the B2B customer
 *      portal. It is NOT covered by either of the others: it calls
 *      `createClient()` + `auth.getUser()` itself and then reads with
 *      `createAdminClient()`, i.e. with RLS bypassed. `/portal` and
 *      `/portal/:path*` are in the proxy matcher, and every auth user gets a
 *      `user_profiles` row (0001_init's `on_auth_user_created` trigger), so a
 *      disabled portal user is a real, reachable case — and an unguarded one
 *      would keep full catalog browsing and order submission.
 *
 * WHY LAYER A NEEDS ALL THREE. Disabling is two layers: (A) the
 * `user_profiles.disabled_at` flag this module reads, and (B) the GoTrue ban +
 * session revoke. Layer A is the authoritative one precisely BECAUSE layer B
 * can fail — that is exactly what the disable service's `partial: true` result
 * exists to report. On `/portal` only layer B is in play today, so a partial
 * disable there would leave the customer portal wide open. Installing the guard
 * at all three funnels is what makes the flag, not the ban, the source of truth.
 *
 * A FOURTH AND FIFTH FUNNEL EXIST, and they are guarded at their own call sites
 * rather than here, because each resolves its principal inline:
 *   4. the QuickBooks and Sage Intacct OAuth callbacks, under
 *      `app/api/integrations/<provider>/callback/route.ts`, which call
 *      `createClient()` + `auth.getUser()` themselves. (Written with a
 *      placeholder rather than a glob on purpose: a literal star-slash here
 *      would close this comment block.) They use `loadAccountStatus` and
 *      map the result onto their OWN redirect vocabulary — `forbidden` for a
 *      disable, `internal_error` for an unreadable status — so no new failure
 *      page is invented for them.
 *   5. `changePasswordAction` (server/actions/auth.ts) does the same, and
 *      refuses BEFORE spending the caller's rate-limit budget.
 *
 * WHAT IS STILL NOT COVERED, and why that is a deliberate choice:
 *   - the proxy matcher excludes /api by design, so middleware cannot cover it;
 *   - middleware verifies JWTs LOCALLY (getClaims), so it would accept a
 *     revoked session until the token expires anyway.
 *
 * DIRECT PostgREST TRAFFIC IS NO LONGER AN ACCEPTED GAP. This comment used to
 * say an RLS-level check "would tax every query platform-wide", and that direct
 * PostgREST access therefore coasted on an already-issued token — described as
 * read-only because "every mobile WRITE goes through Bearer /api/v1". That last
 * step was wrong: it constrains OUR client, not an attacker holding the token,
 * who could issue any verb PostgREST exposes. Migration 0310 puts the
 * `disabled_at` check inside the membership gate helpers, so all 261 policies
 * inherit it and a disabled token is refused for SELECT/INSERT/UPDATE/DELETE
 * immediately. The "taxes every query" concern was measured rather than assumed:
 * the read path is hoisted to a one-time InitPlan and is unchanged. The disable
 * flag itself is pinned by migration 0309, so a still-tokened user cannot clear
 * their own `disabled_at`.
 */

/** The column set every chokepoint must select. Keep the readers in sync. */
export const ACCOUNT_STATUS_COLUMNS = 'disabled_at' as const;

export interface AccountStatusRow {
  disabled_at?: string | null;
}

/**
 * What a status read CONCLUDED — the discriminator all three funnels share.
 *
 * `unreadable` exists because a null row used to stand in for two completely
 * different facts: "this user has no profile" (an onboarding state, correctly
 * ACTIVE) and "the read failed". Collapsing them is what let a disabled account
 * through loadSessionAndContext with a full org context whenever the profile
 * query errored, while the SAME error was failing closed at the API and portal
 * funnels — one error class, two opposite outcomes.
 *
 * The two rules this type exists to keep apart:
 *   - unreadable must DENY. An authorization check that cannot read its input
 *     has not authorized anything.
 *   - unreadable must NOT look like `disabled`. The disabled experience tells a
 *     person to contact their administrator; saying that to an active user
 *     during a database problem sends them somewhere no one can help them.
 */
export type AccountStatusState = 'active' | 'disabled' | 'unreadable';

/**
 * Thrown when the status could not be read. Deliberately an EXCEPTION rather
 * than a fourth quiet return value: `withApiContext` answers a disabled caller
 * with the same uniform `null` an anonymous caller gets, and ~138 route
 * handlers turn that null into a 401. Reusing it here would render a database
 * outage as "You do not have access to that." on every device. Escaping instead
 * produces a 5xx, which the mobile client already words as "The server had a
 * problem. Try again in a moment." (apps/mobile/src/lib/api.ts) and which the
 * web error boundary (app/error.tsx) renders as "Something went wrong / Try
 * again" — a transient outcome, which is what this actually is.
 */
export class AccountStatusUnavailableError extends Error {
  readonly code = 'ACCOUNT_STATUS_UNAVAILABLE';

  constructor() {
    super('Account status could not be verified. Please try again.');
    this.name = 'AccountStatusUnavailableError';
  }
}

/** Pure re-export of the shared predicate, so callers need one import. */
export function accountIsDisabled(profile: AccountStatusRow | null | undefined): boolean {
  return isAccountDisabled(profile);
}

/**
 * Classifies a status read that has ALREADY happened, and REPORTS the failure.
 *
 * Exists for install point 1, whose read is the widened select on the session
 * query — it cannot call `loadAccountStatus` without paying a second round trip
 * for a row it already has. Keeping the classification (and the reporting) here
 * is what makes the three funnels agree by construction instead of by comment.
 */
export async function resolveAccountStatus(
  read: {
    data: AccountStatusRow | null | undefined;
    error: { message: string } | null | undefined;
  },
  userId: string,
): Promise<AccountStatusState> {
  if (read.error) {
    await reportError(new Error(read.error.message), {
      tag: 'auth.account-status.read',
      extra: { userId },
    });
    return 'unreadable';
  }
  return accountIsDisabled(read.data) ? 'disabled' : 'active';
}

/**
 * The ONE place a resolved status becomes an outcome, for the two funnels that
 * refuse by returning null (the API and the portal).
 *
 * @returns true when the caller is genuinely DISABLED — each funnel already
 * knows how to refuse that.
 * @throws AccountStatusUnavailableError when the status could not be read.
 */
export function accountIsDisabledOrThrow(status: AccountStatusState): boolean {
  if (status === 'unreadable') throw new AccountStatusUnavailableError();
  return status === 'disabled';
}

/**
 * Page / Server-Action enforcement. Redirects to the dedicated disabled screen.
 *
 * Loop safety (the lesson from the MFA gate's redirect-loop bug): the
 * destination is a standalone route OUTSIDE the (dashboard) group and OUTSIDE
 * the proxy matcher, so it never receives the verified-identity headers, never
 * resolves a session, and therefore can never redirect to itself.
 *
 * An UNREADABLE status throws instead of redirecting: the disabled screen's
 * copy is owner-approved wording about contacting an administrator, and it must
 * never be shown to someone whose account is fine.
 */
export function assertAccountActiveOrRedirect(status: AccountStatusState): void {
  if (!accountIsDisabledOrThrow(status)) return;
  redirect(ACCOUNT_DISABLED_PATH);
}

/**
 * Enforcement helper for the two chokepoints that have no profile row in hand:
 * reads the caller's status with whatever client the request already built.
 *
 * On the Bearer path this is a REAL extra round trip, not a free ride:
 * pickActiveMembership returns before touching user_profiles whenever
 * X-Organization-Id is present, and the mobile client always sends it. The cost
 * is one PK lookup issued in PARALLEL with the membership query, and it buys a
 * backstop for the window where the flag landed but the GoTrue ban write did
 * not.
 *
 * Returns `unreadable` on a read ERROR — which every caller must treat as a
 * refusal (see `accountIsDisabledOrThrow`), never as a disable. A missing or
 * invisible row is ACTIVE by design — see `isAccountDisabled` in
 * @stockpilot/core: absence of a profile is an onboarding state, not a disable,
 * and the membership checks already handle it.
 */
export async function loadAccountStatus(
  // Deliberately untyped: this is called with three DIFFERENT clients — the SSR
  // cookie client, a bearer-bound createClient, and the portal's cookie client
  // — whose generated Database generics do not unify. Same posture as
  // pickActiveMembership / resolveApiMfaState in api-context.ts.
  supabase: any,
  userId: string,
): Promise<AccountStatusState> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select(ACCOUNT_STATUS_COLUMNS)
      .eq('id', userId)
      .maybeSingle();
    return await resolveAccountStatus({ data: data as AccountStatusRow | null, error }, userId);
  } catch (e) {
    await reportError(e, { tag: 'auth.account-status.read', extra: { userId } });
    return 'unreadable';
  }
}

/**
 * Structured breadcrumb for blocked traffic. Deliberately NOT an org-level
 * audit_logs event: whether an org may see that the platform disabled one of
 * its members is an open policy question, and an implementation detail must not
 * answer it. Never carries the reason, a token or a cookie.
 */
export function noteDisabledAccountBlocked(
  kind: 'login' | 'request',
  extra: { userId?: string | null; path?: string | null } = {},
): void {
  const event =
    kind === 'login' ? DISABLED_ACCOUNT_EVENTS.loginBlocked : DISABLED_ACCOUNT_EVENTS.requestBlocked;
  console.info(`[${event}]`, {
    userId: extra.userId ?? null,
    path: extra.path ?? null,
  });
}
