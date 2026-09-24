/**
 * Ends whenever the signed-in account changes: a sign-out, a different user
 * signing in, or an account eviction. Workspace work started under an earlier
 * value (a workspace load still waiting on the network, a switch still in the
 * queue) belongs to an account that is gone, so it must not save or show a
 * workspace. use-workspace.ts ends it on auth changes; the eviction also ends
 * it directly before it clears the account's stored keys.
 */
let epoch = 0;

export function accountEpoch(): number {
  return epoch;
}

export function endAccountEpoch(): void {
  epoch += 1;
}
