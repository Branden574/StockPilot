import { isSiteLocation } from '@stockpilot/core';

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
 * a rack, into a crate, or back onto the warehouse's SITE (L121: a cancelled
 * pick restocks to Staging, and a warehouse whose stock sits on its Site, with
 * no racks, had no way to put it back). Unplaced is a destination only for
 * stock that is already on a placement; that is the repair path, and it must
 * keep working, so the exclusion keys on the SOURCE kind and never on the mode
 * alone. A rack source's free-form Move offers no Site (unchanged).
 *
 * ═══ A SITE HAS NO KIND ═══
 *
 * A Site is `kind` NULL with a site-ish `type` (warehouse, room, vehicle, job
 * site) — never backfill that kind. So `.in('kind', …)` can never return one
 * (recurring pattern #23), and a NULL kind alone does not make a Site either: a
 * legacy NULL-kind shelf or bin is a placement. Core's isSiteLocation decides,
 * from the type; `moveDestinationGroup` is the one place this file asks it.
 *
 * Kept free of React / react-native imports so it is unit-testable in the
 * mobile vitest config (node env, `src/**\/*.test.ts`) — the sheet itself is a
 * .tsx that pulls in expo at module scope and can never be collected there.
 */

/** The destination groups the picker deals in: three `kind` values and the
 *  Site (no kind; see `moveDestinationGroup`). Never 'staging': stock arriving
 *  there reads as an unprocessed receipt. */
export type MoveDestinationKind = 'rack' | 'crate' | 'unplaced' | 'site';

const PUT_AWAY: readonly MoveDestinationKind[] = ['rack', 'crate', 'site'];
const PLACEMENT_OR_UNPLACED: readonly MoveDestinationKind[] = ['rack', 'crate', 'unplaced'];

/**
 * Which group a destination row is in, or null for a row the picker never
 * offers (Staging, an area, a NULL-kind legacy shelf or bin). The three kinds
 * by their kind; a Site by core's classifier, which reads the type. A row read
 * without its type is classified as core classifies it (a NULL kind with no
 * type is a Site), which is why the sheet's read selects `type`.
 */
export function moveDestinationGroup(
  destination: Pick<MoveDestination, 'kind' | 'type'>,
): MoveDestinationKind | null {
  const kind = destination.kind ?? null;
  if (kind === 'rack' || kind === 'crate' || kind === 'unplaced') return kind;
  return isSiteLocation({ type: destination.type ?? null, kind }) ? 'site' : null;
}

/** A chip's words. A Site says it is one, so it never reads as a rack (the
 *  web Place lists say the same); every other row is its name. */
export function moveDestinationLabel(
  destination: Pick<MoveDestination, 'name' | 'kind' | 'type'>,
): string {
  return moveDestinationGroup(destination) === 'site' ? `${destination.name} (site)` : destination.name;
}

/**
 * THE ROWS A TYPED RACK OR CRATE NAME IS CHECKED AGAINST (slice 3 review, F1):
 * the racks and crates, in the source holding's warehouse when there is one.
 *
 * A typed rack or crate resolves on the server only among rows of that kind
 * (the transfer route's resolve-or-create filters by kind; 0270's unique index
 * is partial over rack/crate), so a Site named "DC4" never answers a typed
 * "DC4": the server mints a real rack DC4. The destinations carry the Site
 * (L121) and, in free-form Move, the Unplaced bucket, so every name check the
 * sheet makes (the existing labels, needs-mint, "Create new rack X?", the
 * near-match suggestions and "Use X instead") is built from these rows and
 * only these. Existence is judged in the warehouse the server creates in.
 */
export function rackNameDestinations<T extends Pick<MoveDestination, 'kind' | 'type' | 'warehouseId'>>(
  destinations: readonly T[],
  sourceWarehouseId: string | null,
): T[] {
  return destinations.filter((d) => {
    const group = moveDestinationGroup(d);
    if (group !== 'rack' && group !== 'crate') return false;
    return sourceWarehouseId == null || d.warehouseId === sourceWarehouseId;
  });
}

/** "Use 10-A instead": the row a suggested label names among `rows` (built
 *  by rackNameDestinations), or null. Never a Site: a rack may share a Site's
 *  name, and the Site is not among the rows. */
export function rackNameMatch<T extends Pick<MoveDestination, 'name'>>(
  rows: readonly T[],
  label: string,
): T | null {
  const key = label.trim().toLowerCase();
  return rows.find((d) => d.name.trim().toLowerCase() === key) ?? null;
}

/**
 * The PostgREST filter for the destinations read: the listed kinds, plus the
 * NULL-kind rows among which the Sites are. A bare `.in('kind', …)` drops
 * every NULL row (pattern #23); the NULL-kind rows that are NOT Sites are
 * dropped afterwards by `offeredDestinationOrder`.
 */
export function destinationKindsOrFilter(kinds: readonly string[]): string {
  // in-list-bound: the move sheet passes its 2- or 3-element literal of kinds
  return `kind.in.(${kinds.join(',')}),kind.is.null`;
}

/**
 * The rows the read returned, as the picker lists them: only the groups it
 * offers (a legacy NULL-kind shelf or bin is dropped), Unplaced first, then the
 * Sites, then the racks and crates in the order read (by name). The safe way
 * off a rack and the way back onto a Site each sit at the top instead of being
 * buried in a 48-rack alphabetical list. The two never show together: Unplaced
 * is for stock on a placement, the Site for stock awaiting put-away.
 */
export function offeredDestinationOrder<T extends Pick<MoveDestination, 'kind' | 'type'>>(
  destinations: readonly T[],
): T[] {
  const rank = (d: T) => {
    const group = moveDestinationGroup(d);
    return group === 'unplaced' ? 0 : group === 'site' ? 1 : 2;
  };
  return destinations
    .filter((d) => moveDestinationGroup(d) !== null)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(({ d }) => d);
}

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
  if (opts.fixedPutAway || awaitingPutAway(source)) return [...PUT_AWAY];
  return [...PLACEMENT_OR_UNPLACED];
}

/** Whether ONE candidate row is a legal destination out of `source`. Used to
 *  drop a destination the user picked under a DIFFERENT source — switching the
 *  FROM chip from a rack to the Staging pile must not leave an Unplaced pick
 *  armed behind a hidden chip. */
export function destinationAllowedForSource(
  destination: Pick<MoveDestination, 'kind' | 'type'> | null | undefined,
  source: Pick<MoveHolding, 'kind'> | null | undefined,
  opts: { fixedPutAway: boolean },
): boolean {
  if (!destination) return false;
  // Judged by GROUP, not by kind: a Site has no kind (L121). A row in no group
  // (Staging, a legacy NULL-kind shelf) is never offered; the sheet's read
  // already drops it, so this only guards odd data.
  const group = moveDestinationGroup(destination);
  if (group === null) return false;
  return moveDestinationKinds(source, opts).includes(group);
}

/**
 * The candidate list, narrowed to what `source` allows. Applied at RENDER (not
 * at the query) on purpose: in free-form mode the source changes with every
 * FROM chip tap, and a query that had already dropped the Unplaced row would
 * leave the rack→Unplaced repair unreachable the moment the sheet happened to
 * open on a staged holding.
 */
export function placementDestinationsForSource<T extends Pick<MoveDestination, 'kind' | 'type'>>(
  destinations: readonly T[],
  source: Pick<MoveHolding, 'kind'> | null | undefined,
  opts: { fixedPutAway: boolean },
): T[] {
  return destinations.filter((d) => destinationAllowedForSource(d, source, opts));
}
