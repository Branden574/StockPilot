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

/**
 * What a module keeps in memory for the life of the app process about the
 * account signed in (B25): the count picker's selection, the count list's
 * search, the count screen's Post and Cancel answer, the exceptions shown
 * offline. A sign-out ends the session, not the process, so without this the
 * next person to sign in on the phone saw the previous account's picked items
 * (names and SKUs, from its organization) under "Count selected", and opened
 * the count list on its search. Each module registers its own forget when it
 * loads (a module never loaded holds nothing); every end of the epoch runs
 * them all.
 */
const forgets = new Set<() => void>();

export function forgetOnAccountChange(forget: () => void): void {
  forgets.add(forget);
}

export function endAccountEpoch(): void {
  epoch += 1;
  for (const forget of forgets) {
    try {
      forget();
    } catch (e) {
      // One memory that cannot be cleared never keeps the others.
      console.warn('[account] could not forget a memory at an account change', e);
    }
  }
}
