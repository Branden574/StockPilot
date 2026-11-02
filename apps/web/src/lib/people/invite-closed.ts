/**
 * Whether an invitation can no longer be accepted: withdrawn (revoked_at) or
 * past its expiry.
 *
 * A withdrawn invitation is terminal (migration 0098): removing the member
 * who sent it (0429) or deleting their account (0393) sets revoked_at and
 * moves expires_at into the past. The expiry alone is not enough, because a
 * Resend from a Team page loaded before the withdrawal used to renew it. The
 * accept paths and the invite page answer a withdrawn invitation as an
 * expired one ("Invite expired": ask for a new one), as they already did for
 * one whose expiry the withdrawal had moved.
 *
 * The row must be read WITH revoked_at: a select that leaves it out reads
 * every withdrawn invitation as open.
 */
export function inviteIsClosed(invite: { expires_at: unknown; revoked_at: unknown }): boolean {
  if (invite.revoked_at) return true;
  return new Date(invite.expires_at as string).getTime() < Date.now();
}
