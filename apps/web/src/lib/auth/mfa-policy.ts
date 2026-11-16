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

export { enforcedMfaPolicy, UNREADABLE_ORG_MFA_POLICY } from '@stockpilot/core';
