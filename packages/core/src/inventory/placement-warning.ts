/**
 * The sentence an operator reads when items were created but their stock never
 * reached the rack they typed.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN TWICE
 * The web Add Item form and the phone's Add Item screen both create items
 * against the same service, so they can both land in this state — and the
 * whole point of the message is that it sends someone to a physical shelf. Two
 * copies drift, and a phone that says something subtly different about the
 * same rack is worse than a phone that says nothing: the floor ends up with
 * two vocabularies for one condition.
 *
 * WHAT IT HAS TO CONVEY, IN ORDER
 *  1. The create SUCCEEDED. It must never read as an error — the operator's
 *     items exist, and re-entering them would duplicate stock.
 *  2. The label and the stock DISAGREE. This is the actionable half.
 *  3. WHICH rack, by its normalised name, so it matches what gets printed and
 *     what every other screen shows.
 */

export interface PlacementFailure {
  /** Normalised rack label (what `formatRackLabel` produced). */
  rackName: string;
  /** How many of the created items did not reach it. Always >= 1. */
  count: number;
}

/**
 * `lead` is the caller's own success clause — "Item created", "Created 8
 * variants" — so each surface keeps the count vocabulary it already uses and
 * only the shared second half is centralised. The lead is emitted verbatim,
 * which is what lets one builder serve a single create and a size run without
 * either having to phrase the warning itself.
 */
export function placementWarningMessage(lead: string, failure: PlacementFailure): string {
  const { rackName, count } = failure;
  const subject = count === 1 ? 'its stock' : `the stock for ${count} of them`;
  return (
    `${lead}, but ${subject} could not be placed on rack ${rackName} — ` +
    `it is still where it started. Check before picking.`
  );
}
