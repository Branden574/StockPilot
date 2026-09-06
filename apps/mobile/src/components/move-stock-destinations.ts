import type { MoveDestination, MoveHolding } from '../lib/move-stock-form';

/**
 * WHICH DESTINATIONS THE FREE-FORM "Move stock" SHEET MAY OFFER, given the pile
 * the stock is being moved OUT of.
 *
 * ═══ THE BUG THIS CLOSES (SP-053) ═══
 *
 * The item screen's free-form Move lists EVERY holding as a source — placed
 * racks and the Staging / Unplaced buckets alike, because choosing which pile
 * to move IS the point of that mode. It also offered the per-warehouse Unplaced
 * bucket as a DESTINATION (added for the 2026-07-23 rack 100-A repair: without
 * a non-destructive way off a rack, clearing one cost 220 real books to a
 * write-off). Those two facts together made "Staging · 40" → "Unplaced" a
 * two-tap move on the phone. Nothing shelved anything: the units keep their
 * quantity, lose the "Received (staged)" reading of the row, and sit in a
 * bucket with no bin label. Web cannot express that move at all — its
 * StockTransferDialog drops staging and unplaced holdings from the source list
 * outright (apps/web/src/lib/placements.ts `transferableHoldings`), and the
 * transfer route only ever refused a STAGING destination, so the server said
 * yes to it.
 *
 * ═══ THE RULE ═══
 *
 * Stock that is WAITING FOR PUT-AWAY — kind 'staging' or 'unplaced' — goes onto
 * a rack or into a crate. Unplaced is a destination only for stock that is
 * already on a placement; that is the repair path, and it must keep working, so
 * the exclusion keys on the SOURCE kind and never on the mode alone.
 *
 * Kept free of React / react-native imports so it is unit-testable in the
 * mobile vitest config (node env, `src/**\/*.test.ts`) — the sheet itself is a
 * .tsx that pulls in expo at module scope and can never be collected there.
 */

/** The location kinds the destination picker deals in. Never 'staging': stock
 *  arriving there reads as an unprocessed receipt. */
export type MoveDestinationKind = 'rack' | 'crate' | 'unplaced';

const PLACEMENT_ONLY: readonly MoveDestinationKind[] = ['rack', 'crate'];
const PLACEMENT_OR_UNPLACED: readonly MoveDestinationKind[] = ['rack', 'crate', 'unplaced'];

/** A holding is "awaiting put-away" when it is one of the two pre-placement
 *  buckets. Matches `isPutAway` in the sheet and the web staged worklist's
 *  `sourceKind: 'staging' | 'unplaced'`. */
function awaitingPutAway(source: Pick<MoveHolding, 'kind'> | null | undefined): boolean {
  return source?.kind === 'staging' || source?.kind === 'unplaced';
}

/**
 * The destination kinds allowed out of `source`.
 *
 * `fixedPutAway` is the Staging worklist's Place (the sheet's
 * `putAwaySourceLocationId` mode), which has never offered Unplaced — resolving
 * Place to "no rack" would drain the worklist without shelving anything.
 *
 * A null source (nothing picked yet, or the holdings read is still in flight)
 * stays PERMISSIVE: the FROM chip is what decides, and narrowing on the empty
 * state would hide the repair path from anyone whose first holding happens to
 * be staged.
 */
export function moveDestinationKinds(
  source: Pick<MoveHolding, 'kind'> | null | undefined,
  opts: { fixedPutAway: boolean },
): MoveDestinationKind[] {
  if (opts.fixedPutAway || awaitingPutAway(source)) return [...PLACEMENT_ONLY];
  return [...PLACEMENT_OR_UNPLACED];
}

/** Whether ONE candidate row is a legal destination out of `source`. Used to
 *  drop a destination the user picked under a DIFFERENT source — switching the
 *  FROM chip from a rack to the Staging pile must not leave an Unplaced pick
 *  armed behind a hidden chip. */
export function destinationAllowedForSource(
  destination: Pick<MoveDestination, 'kind'> | null | undefined,
  source: Pick<MoveHolding, 'kind'> | null | undefined,
  opts: { fixedPutAway: boolean },
): boolean {
  if (!destination) return false;
  // A row with no kind is not one of ours to judge; the sheet's query already
  // constrains `kind IN (...)`, so this only guards odd data.
  if (destination.kind == null) return true;
  return (moveDestinationKinds(source, opts) as string[]).includes(destination.kind);
}

/**
 * The candidate list, narrowed to what `source` allows. Applied at RENDER (not
 * at the query) on purpose: in free-form mode the source changes with every
 * FROM chip tap, and a query that had already dropped the Unplaced row would
 * leave the rack→Unplaced repair unreachable the moment the sheet happened to
 * open on a staged holding.
 */
export function placementDestinationsForSource<T extends Pick<MoveDestination, 'kind'>>(
  destinations: readonly T[],
  source: Pick<MoveHolding, 'kind'> | null | undefined,
  opts: { fixedPutAway: boolean },
): T[] {
  return destinations.filter((d) => destinationAllowedForSource(d, source, opts));
}
