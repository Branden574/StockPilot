/**
 * The "Invite expired" line. An account deletion expires every pending invite
 * the person sent (migration 0393), so the inviter may no longer exist: point
 * the invitee at the organization when its name is known (A3 review).
 */
export function inviteExpiredDescription(orgName: string | null): string {
  const name = orgName?.trim();
  return name ? `Ask someone at ${name} to invite you again.` : 'Ask the inviter to send a new one.';
}

/** The footer under the invite sign-up form: a question and its link. */
export const INVITE_SIGN_IN_PROMPT = 'Already have an account?';
export const INVITE_SIGN_IN_LINK = 'Sign in';

/**
 * The one answer for an invite whose address cannot get a new account here:
 * one that already has an account, and a platform-admin address (the same
 * words for both, so the answer does not reveal the allowlist). It names the
 * footer's own words; the page has no other sign-in option (B77).
 */
export const INVITE_ACCOUNT_EXISTS_COPY = `An account already exists for this email. Use "${INVITE_SIGN_IN_PROMPT} ${INVITE_SIGN_IN_LINK}" on this page, then accept the invite.`;
