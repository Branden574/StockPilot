import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import { factorsOf, type MfaFactorList } from '@/lib/auth/mfa-factors';
import { orSessionEnded } from '@/lib/auth/session-ended';
import {
  getVerifiedSessionClaimsForRequest,
  type VerifiedSessionClaims,
} from '@/lib/auth/verified-claims';
import { getMfaFactorsForRequest } from '@/lib/dashboard/request-cache';

import { stepUpOwed } from '@stockpilot/core';

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
 * none is not asked here: the dashboard layout and assertPermission answer
 * that, as before.
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
