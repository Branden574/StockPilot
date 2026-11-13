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

/**
 * A signed-in person who is already a member of the invite's organization.
 * The invite does not change their role or access; the page says so before
 * the press, and the Accept button says it after one.
 */
export const INVITE_ALREADY_MEMBER_TITLE = "You're already a member";
export function inviteAlreadyMemberDescription(orgName: string): string {
  return `You're already a member of ${orgName}. This invite does not change your access.`;
}
export const INVITE_ALREADY_MEMBER_TOAST =
  "You're already a member of this organization. Your access has not changed.";
