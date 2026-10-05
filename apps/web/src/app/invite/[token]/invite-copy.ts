/**
 * The "Invite expired" line. An account deletion expires every pending invite
 * the person sent (migration 0393), so the inviter may no longer exist: point
 * the invitee at the organization when its name is known (A3 review).
 */
export function inviteExpiredDescription(orgName: string | null): string {
  const name = orgName?.trim();
  return name ? `Ask someone at ${name} to invite you again.` : 'Ask the inviter to send a new one.';
}
