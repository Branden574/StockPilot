import 'server-only';

import { SESSION_ENDED_NOTICE } from '@/lib/auth/auth-page-notices';

/**
 * The words of the web's authenticator code checks: the set-up's code
 * (server/actions/mfa.ts verifyEnrollmentAction), the sign-in code at
 * /signin/mfa and the step-up modal (challengeFactorAction).
 *
 * Plain words chosen by how GoTrue answered (classifyMfaCodeError in
 * server/actions/auth-error-classify.ts), never GoTrue's message: it can carry
 * factor and challenge identifiers.
 *
 * The same names and words as docket S29-S32, which adds the code budget to
 * this module; whichever lands second keeps one copy (S31).
 *
 * Server code only: the words live here, not in a 'use server' module.
 */

/** GoTrue judged the code wrong. The reset's words before this budget. */
export const MFA_CODE_REFUSED =
  'That code is not valid. Check your authenticator app and try again.';
/** GoTrue's own rate limit answered. */
export const MFA_CODE_GOTRUE_LIMITED =
  'Too many code checks right now. Wait a minute and try again.';
/** GoTrue did not judge the code: no answer, or an answer this does not know. */
export const MFA_CODE_NOT_CHECKED = 'Could not check your code just now. Try again.';
/** The challenge itself could not be started. */
export const MFA_CHALLENGE_NOT_STARTED =
  'Could not start the authenticator check. Please try again.';
/** The session is gone (the sign-in card's words for it). */
export const MFA_SESSION_ENDED = SESSION_ENDED_NOTICE.text;
