/**
 * The MFA policy to ENFORCE, given an organization row as it was read.
 *
 * The rule lives in @stockpilot/core (auth/step-up.ts), shared with the phone:
 * a missing or unrecognised `organizations.mfa_policy` means the row could not
 * be read, and that is held to the strictest policy, 'all_required'.
 *
 * READ ERRORS are not handled here. A caller that gets `error` back must throw
 * or deny on its own (see getOrgRowForRequest); this is for the row that came
 * back empty. The two MFA gates (resolveApiMfaState in lib/auth/api-context.ts
 * and resolveMfaState in server/services/context.ts) hold a failed read to
 * this same policy: a session at AAL2 passes, any other is stopped.
 */

import type { OrganizationMfaPolicy } from '@stockpilot/core';

export type MfaPolicy = OrganizationMfaPolicy;

export {
  enforcedMfaPolicy,
  readOrganizationMfaPolicy,
  UNREADABLE_ORG_MFA_POLICY,
} from '@stockpilot/core';

/**
 * WHICH API CONTEXTS WERE BUILT WITHOUT READING THE POLICY.
 *
 * withApiContext (lib/auth/api-context.ts) holds a policy it could not read
 * (the organization row failed, came back hidden, or carried no policy it
 * knows) to the strictest one, so the context's labels read exactly like a
 * member whose organization does require an authenticator. The API context
 * gate (server/lib/api-context-gate.ts) tells the two apart: a write by a
 * member whose policy was not read gets the retryable answer that their
 * access could not be checked, and nothing is written.
 *
 * The mark lives beside the context, not on it, so the context keeps exactly
 * the fields and values it had and everything that compares or copies one
 * reads the same. A copy of a context (`{ ...ctx }`) carries no mark; only the
 * object withApiContext returned does. In memory only.
 */
const POLICY_UNREAD = new WeakSet<object>();

/** Marks `target` (a context, or the labels it is built from) as built from a policy that was not read. */
export function markMfaPolicyUnread<T extends object>(target: T): T {
  POLICY_UNREAD.add(target);
  return target;
}

/** Was `target` marked by markMfaPolicyUnread? */
export function mfaPolicyWasUnread(target: object): boolean {
  return POLICY_UNREAD.has(target);
}
