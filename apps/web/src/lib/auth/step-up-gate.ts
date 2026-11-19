import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import type { SupabaseClient } from '@supabase/supabase-js';

import { factorsOf, type MfaFactorList } from '@/lib/auth/mfa-factors';
import { readOrganizationMfaPolicy } from '@/lib/auth/mfa-policy';
import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import { orgRowFromMembership, type BundleMembership } from '@/lib/auth/request-context-bundle';
import { orSessionEnded } from '@/lib/auth/session-ended';
import {
  getVerifiedSessionClaimsForRequest,
  readVerifiedSessionClaimsOf,
  type VerifiedSessionClaims,
} from '@/lib/auth/verified-claims';
import { getMfaFactorsForRequest, getOrgRowForRequest } from '@/lib/dashboard/request-cache';

import { authenticatorSetUpOwed, stepUpOwed, type Role } from '@stockpilot/core';

/**
 * Does the signed-in member's session still owe its authenticator code?
 *
 * The question requireOrgContext() (lib/auth/session.ts) asks before it hands
 * out an organization context, so every dashboard page and every Server Action
 * that works for an organization gets the same answer the dashboard layout
 * gives a page load: a member who has a verified factor is sent to
 * /signin/mfa until the session is at aal2. The rule itself is the one copy in
 * @stockpilot/core (stepUpOwed), which the API context and the phone read too.
 * Whether an organization's policy requires a factor from a member who has
 * none is the second question, authenticatorSetUpIsOwed below, which
 * requireOrgContext() asks once the organization and the role are resolved.
 *
 * WHAT IT READS, AND WHAT THAT COSTS.
 *   1. The session's verified claims (lib/auth/verified-claims): a local
 *      signature check once the key set is cached. A session at aal2 is
 *      answered from them alone, with no call to the Auth server.
 *   2. Only for a session that is not at aal2, the member's factor list: one
 *      Auth round trip. In a page render it is the read the dashboard layout
 *      already started (React cache() shares it). In a Server Action cache()
 *      does not memoize, so withContext() offers the read it has already
 *      started (sharingFactorsRead below) and the gate takes that one instead
 *      of a second. A caller that offers none (a page or an action that asks
 *      requireOrgContext() directly) pays the one read.
 *
 * BOTH INPUTS COUNT ONLY AS THIS MEMBER'S OWN. Each is a read of the cookie
 * session, and a load of the session can refresh it into another account's
 * (see readVerifiedSessionClaimsOf and factorsOf). Claims of another account
 * are no level at all, and a factor list of another account is no answer, so
 * the code is owed.
 *
 * AN UNREADABLE FACTOR LIST IS NOT "NO FACTOR". The read rejects, and so does
 * the gate: a page shows its error screen and an action answers its generic
 * failure. A session that no longer exists goes to sign-in through the
 * session-ended route (lib/auth/session-ended).
 *
 * A FUNNEL THAT VALIDATES ITS OWN USER asks stepUpIsOwedByUser (at the bottom):
 * the customer portal resolves the signed-in account with getUser() instead of
 * the member context, and is held to the same rule.
 */

/** The reads the gate decides on, started before the context resolves. */
export interface StepUpReads {
  /** The cookie session's verified claims. Never rejects. */
  claims: Promise<VerifiedSessionClaims | null>;
  /** The factor list: the read a caller offered, else one started on first ask. */
  factors: () => Promise<MfaFactorList>;
}

/**
 * A factor read a caller has under way, for the gate to take instead of
 * starting its own. AsyncLocalStorage, not an argument: requireOrgContext() is
 * React cache()d on its arguments, and a promise passed in would give the
 * layout's call and the page's call two different entries in one render.
 */
const offeredFactorsRead = new AsyncLocalStorage<Promise<MfaFactorList>>();

/**
 * Run `fn` with `read` offered to the gate: withContext() starts the factor
 * list before the context resolves and needs it either way, so the gate inside
 * requireOrgContext() awaits that same read. The offer reaches only what `fn`
 * calls.
 */
export function sharingFactorsRead<T>(
  read: Promise<MfaFactorList>,
  fn: () => Promise<T>,
): Promise<T> {
  return offeredFactorsRead.run(read, fn);
}

/**
 * Start the gate's reads. Called first thing in requireOrgContext(), so they
 * run alongside the context's own round trip instead of after it: the claims
 * at once, and the factor list as soon as the claims show a session that is
 * not at aal2 (when no caller offered one). Rejections are observed here,
 * because the context can redirect and leave them behind; stepUpIsOwed awaits
 * the same promises and still fails on them.
 */
export function startStepUpReads(): StepUpReads {
  let started = offeredFactorsRead.getStore();
  const factors = (): Promise<MfaFactorList> => {
    if (!started) {
      // Promise.resolve().then: a stubbed reader that throws synchronously
      // still becomes a rejection of this read.
      started = Promise.resolve().then(() => getMfaFactorsForRequest());
      started.catch(() => {});
    }
    return started;
  };
  const claims = getVerifiedSessionClaimsForRequest();
  // No claims is no verifiable session, which is usually nobody signed in:
  // the list is then asked for only if the context finds a session after all.
  claims.then((c) => (c && c.aal !== 'aal2' ? factors() : null)).catch(() => {});
  return { claims, factors };
}

/**
 * True when `userId`, the member the context resolved, has a verified factor
 * and this session is not at aal2. Rejects when the factor list cannot be
 * read; redirects to the session-ended route when the session no longer
 * exists.
 */
export async function stepUpIsOwed(reads: StepUpReads, userId: string): Promise<boolean> {
  const claims = await reads.claims;
  const aal = claims?.userId === userId ? claims.aal : null;
  // At aal2 the code is in: nothing else is read.
  if (aal === 'aal2') return false;
  const own = factorsOf(await orSessionEnded(reads.factors()), userId);
  return own ? stepUpOwed(own, aal) : true;
}

/**
 * Does the member the context resolved owe authenticator SET-UP: does their
 * organization's policy require an authenticator of their role while they have
 * no verified one (authenticatorSetUpOwed in @stockpilot/core)? Asked by
 * requireOrgContext() after stepUpIsOwed() above, on the same reads.
 *
 * WHAT IT READS. Nothing new for the sessions that matter:
 *   - at aal2 (this member's own claims) the answer is no, from the claims
 *     alone. Such a session entered a code, so it had a factor. Reading the
 *     list here too would add an Auth round trip to every page and action of
 *     such a session that does not already have one under way. If its last
 *     verified factor was removed since, that session's reads and writes are
 *     refused where the services ask for an authenticator (they read the
 *     list). The dashboard layout, which has the list in hand on a full page
 *     load or a refresh, also shows it a set-up prompt where the page would
 *     be; that is a prompt, not a data stop (the page still runs), and the
 *     layout never redirects. One exception reads more: when the membership
 *     does not carry the organization's policy (aal2SessionHeldForUnreadPolicy
 *     below);
 *   - otherwise the factor list is the one stepUpIsOwed() already awaited
 *     (the same promise), and a verified factor there means the code was owed
 *     and the member never got this far;
 *   - the policy comes from the membership that resolved the context
 *     (`held`), and only without one from the request-cached organization
 *     row the dashboard layout reads too. A read that FAILED throws, the
 *     "could not check your access" state, as it does in the layout; so does
 *     a row that came back empty or with a value that is not a policy, for a
 *     member with no verified factor (policyNotRead below).
 */
export async function authenticatorSetUpIsOwed(
  reads: StepUpReads,
  member: { userId: string; organizationId: string; role: Role },
  held: BundleMembership | null,
): Promise<boolean> {
  const claims = await reads.claims;
  if (claims?.userId === member.userId && claims.aal === 'aal2') {
    return aal2SessionHeldForUnreadPolicy(reads, member, held);
  }
  const own = factorsOf(await orSessionEnded(reads.factors()), member.userId);
  // Another account's list: stepUpIsOwed() already sent this session to the
  // code page, so this is never reached with one; no answer, no set-up.
  if (!own) return false;
  return authenticatorSetUpIsOwedByUser(member, held, own);
}

/**
 * A SESSION AT AAL2, which owes no set-up: it entered a code, so it had a
 * factor. Answered from the membership's policy with no read when it carries
 * one, which is every request whose context came back in one round trip with
 * its organization: false, as for every session at aal2.
 *
 * When the policy was not read (the membership carries no organization row,
 * or no membership was held), the request-cached organization row is asked
 * (the one the dashboard layout reads too). A policy read there: false. Not
 * read: the member's own factor list decides. A verified factor passes, as
 * at aal2 in every state. None left (it was removed after this token was
 * issued), or a list that is not this member's: the could-not-check error
 * (policyNotRead below), so the page and every action refuse on their own,
 * before any work, whatever they read; the layout shows its could-not-check
 * panel in place of the page. A read that fails throws its own could-not-check
 * error. These reads happen only on that path; a session at aal2 whose
 * membership carries its policy reads nothing here.
 */
async function aal2SessionHeldForUnreadPolicy(
  reads: StepUpReads,
  member: { userId: string; organizationId: string },
  held: BundleMembership | null,
): Promise<false> {
  if (readOrganizationMfaPolicy(orgRowFromMembership(held)) !== null) return false;
  const orgRow = await getOrgRowForRequest(member.organizationId);
  if (readOrganizationMfaPolicy(orgRow) !== null) return false;
  const own = factorsOf(await orSessionEnded(reads.factors()), member.userId);
  if (own?.some((f) => f.status === 'verified')) return false;
  throw policyNotRead(orgRow);
}

/**
 * The same set-up question for a funnel that validated its own user with
 * getUser() instead of asking requireOrgContext(): the sign-in email change
 * (server/actions/email-change.ts), which must still work for an account with
 * no organization. `factors` are that account's own, from that same getUser()
 * answer; `member` and `held` are the organization requireOrgContext()
 * resolves for this request and the membership it came from
 * (readSessionOrganization in lib/auth/session.ts).
 *
 * The policy is read as above: from the membership when it carries the
 * organization row, else the request-cached row. A read that FAILED throws
 * OrganizationRowUnavailableError, the "could not check your access" state,
 * and so does a row that came back empty or with a value that is not a policy
 * (policyNotRead below). A verified factor reads nothing.
 */
export async function authenticatorSetUpIsOwedByUser(
  member: { organizationId: string; role: Role },
  held: BundleMembership | null,
  factors: ReadonlyArray<{ readonly status?: string | null }> | null | undefined,
): Promise<boolean> {
  if ((factors ?? []).some((f) => f.status === 'verified')) return false;
  const orgRow = orgRowFromMembership(held) ?? (await getOrgRowForRequest(member.organizationId));
  const policy = readOrganizationMfaPolicy(orgRow);
  if (policy === null) throw policyNotRead(orgRow);
  return authenticatorSetUpOwed(policy, member.role, factors);
}

/**
 * THE POLICY WAS NOT READ: the organization row came back hidden from this
 * member, or with a value that is not a policy. Held to the strictest policy
 * (enforcedMfaPolicy), a member with no verified authenticator would owe
 * set-up, but whether their organization asks for one is not known, so
 * "set up an authenticator" would be a guess. They are told what is true:
 * their access could not be checked, try again. The error is
 * OrganizationRowUnavailableError, the state a row read that FAILED is in
 * already: a page shows its "couldn't check your access" card, a Server
 * Action answers the class's try-again sentence, and nothing is written (it
 * is thrown where the set-up redirect would have been). Nothing passes that
 * the strictest policy refuses: the member gets no context. A verified factor
 * never reaches here (it reads nothing, above).
 *
 * One log line with the cause code, never a value from the row.
 */
function policyNotRead(orgRow: unknown): OrganizationRowUnavailableError {
  console.warn(
    '[step-up-gate] authenticator policy not read:',
    orgRow ? 'not_a_policy' : 'hidden_row',
  );
  return new OrganizationRowUnavailableError();
}

/**
 * The same question for a funnel that validated its own user with getUser()
 * instead of asking requireOrgContext(): the customer portal
 * (resolvePortalContext in server/services/portal.ts). True when that account
 * has a verified factor and this session is not at aal2.
 *
 * `user` is the getUser() answer that named the account, and its `factors` are
 * GoTrue's list for that same account, from that same answer: there is no
 * second read that could be of another account, and a getUser() that fails
 * names nobody, so the funnel has no user to serve. An account with no
 * verified factor owes nothing and no level is read: no added Auth call. For
 * one that has a factor the level comes from the session's verified claims (a
 * local signature check), held to this account by readVerifiedSessionClaimsOf:
 * claims that do not verify, or that are of another account, are no level at
 * all, so the code is owed.
 */
export async function stepUpIsOwedByUser(
  supabase: Pick<SupabaseClient, 'auth'>,
  user: {
    id: string;
    factors?: ReadonlyArray<{ readonly status?: string | null }> | null;
  },
): Promise<boolean> {
  if (!stepUpOwed(user.factors, null)) return false;
  return stepUpOwed(user.factors, (await readVerifiedSessionClaimsOf(supabase, user.id))?.aal);
}
