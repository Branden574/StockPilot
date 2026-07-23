/**
 * Move-stock / put-away form rules — the PURE half of
 * src/components/move-stock-modal.tsx.
 *
 * The modal serves two callers, and the difference between them is not a set of
 * defaults — it is a difference in WHAT QUESTION IS BEING ASKED:
 *
 *  • the item screen's "Move stock" is a free-form transfer. Which pile, how
 *    much, where to. It needs a source picker, because choosing the source IS
 *    the point.
 *  • Staging put-away is not free-form. The user tapped Place on ONE worklist
 *    row, and the web dialog that does this job
 *    (apps/web/src/components/inventory/place-from-staging-dialog.tsx) has NO
 *    source picker at all: it is handed the item, the source holding and the
 *    quantity available, and asks only "how many" and "which rack".
 *
 * Mobile originally reused the free-form modal for put-away and tried to make
 * it safe with defaults (preselect the tapped holding, scope the destinations).
 * That is what produced a family of defects that web cannot even express:
 *
 *  • a cross-warehouse "put-away": the destinations were pinned to the tapped
 *    row's warehouse, but the FROM chips were not, so switching the source chip
 *    moved a different building's stock into this building's rack;
 *  • a silent substitution: when the tapped holding was gone (someone else
 *    placed it), the modal fell back to whatever OTHER holding the item had —
 *    and since put-away seeds the WHOLE holding, that armed a one-tap move of
 *    an unrelated pile;
 *  • a quantity default with no unambiguous subject, for the same reason.
 *
 * So put-away FIXES the source to the tapped row. Not "defaults to" — fixes.
 * With no way to change the source, the cross-warehouse move stops being a rule
 * that can be got wrong and becomes unexpressible; the destination scope is
 * DERIVED from that fixed holding (defence in depth, not the primary guard);
 * and "the whole holding" has exactly one possible subject.
 *
 * Lives here because apps/mobile has no component-test harness — the modal
 * itself cannot be rendered under vitest.
 */

import { describeNewRackPlacement, type NewRackPlacementDecision } from '@stockpilot/core';

export interface MoveDestination {
  id: string;
  name: string;
  kind: string | null;
  warehouseId: string | null;
}

/** One location this item currently holds stock in. */
export interface MoveHolding {
  locationId: string;
  name: string;
  kind: string | null;
  quantity: number;
  /** The holding location's warehouse. Drives the put-away destination scope. */
  warehouseId: string | null;
}

/**
 * Which holding the form is moving stock OUT of, and whether the user may
 * change it.
 *
 *  • `fixed`   — put-away. The tapped worklist row, and nothing else. The modal
 *                renders no FROM picker in this mode, so there is no code path
 *                that can replace `holding`.
 *  • `missing` — put-away where the tapped holding no longer exists. NOT a
 *                different move: a stale worklist row is a refresh. The form
 *                refuses rather than substituting another holding.
 *  • `choice`  — the item screen's free-form transfer. `holding` is only the
 *                initial selection; the user picks from all of them.
 */
export type MoveSource =
  | { mode: 'fixed'; holding: MoveHolding }
  | { mode: 'missing' }
  | { mode: 'choice'; holding: MoveHolding | null };

/**
 * Resolve the source holding for a freshly-opened sheet.
 *
 * `putAwaySourceLocationId` is the ONLY thing that turns on put-away mode, and
 * when it is given the answer is exact-match-or-nothing. There is deliberately
 * no `?? holdings[0]` here: falling back is how the sheet used to arm a
 * whole-holding move of a pile the user never tapped.
 */
export function resolveMoveSource(
  holdings: readonly MoveHolding[],
  opts: { putAwaySourceLocationId?: string | null } = {},
): MoveSource {
  const wanted = opts.putAwaySourceLocationId ?? null;
  if (wanted !== null && wanted !== '') {
    const holding = holdings.find((h) => h.locationId === wanted);
    return holding ? { mode: 'fixed', holding } : { mode: 'missing' };
  }
  return { mode: 'choice', holding: holdings[0] ?? null };
}

/**
 * How wide the destination list may be.
 *
 * A discriminated union rather than a nullable warehouse id, because "no
 * warehouse" and "every warehouse" are opposite answers and a nullable id spells
 * them the same way — the exact shape in which an out-of-warehouse rack could
 * slip back into a put-away picker.
 */
export type MoveDestinationScope =
  | { kind: 'all' }
  | { kind: 'warehouse'; warehouseId: string }
  | { kind: 'none' };

/**
 * The destination scope IMPLIED by the source. Derived from the fixed holding
 * itself — never from a row id the caller remembered separately, which is how
 * the scope and the actual source got to disagree.
 */
export function moveDestinationScope(source: MoveSource): MoveDestinationScope {
  if (source.mode === 'missing') return { kind: 'none' };
  if (source.mode === 'choice') return { kind: 'all' };
  const warehouseId = source.holding.warehouseId;
  // A holding with no warehouse has nowhere provably-correct to go. Web disables
  // Place for exactly this row; the phone must not silently widen to every rack.
  return warehouseId ? { kind: 'warehouse', warehouseId } : { kind: 'none' };
}

/**
 * The quantity the form opens with, as the TextInput's string value.
 *
 * `wholeHolding` = put-away, matching the web dialog's
 * `useState(String(availableQuantity))`. Mobile seeded '1', so a picker who
 * tapped Place → Put away moved a single unit and silently stranded the rest in
 * staging — with the worklist row still showing the original quantity, which
 * reads as "nothing happened". A non-positive or unknown holding falls back to
 * '1' so the field is never seeded with '0', a value the submit gate would
 * reject with no explanation of why.
 */
export function initialMoveQuantity(
  holdingQuantity: number | null | undefined,
  opts: { wholeHolding: boolean },
): string {
  if (!opts.wholeHolding) return '1';
  const q = typeof holdingQuantity === 'number' && Number.isFinite(holdingQuantity)
    ? Math.floor(holdingQuantity)
    : 0;
  return q > 0 ? String(q) : '1';
}

/**
 * The quantity a freshly-resolved source opens with. Takes the RESOLUTION, not
 * a loose number, so the whole-holding default cannot be computed against some
 * other holding than the one being moved: `missing` has no quantity to seed and
 * `choice` never seeds the whole pile.
 */
export function initialMoveQuantityForSource(source: MoveSource): string {
  if (source.mode === 'fixed') {
    return initialMoveQuantity(source.holding.quantity, { wholeHolding: true });
  }
  return '1';
}

/**
 * The destinations offered for a given source holding.
 *
 * Always drops the source location itself (stock cannot move to where it
 * already is). Under a `warehouse` scope it also drops every rack in another
 * warehouse — including racks with no warehouse at all, which cannot be shown
 * to be in the right building — so the phone cannot express a cross-warehouse
 * "put-away" the web page has no way to express. Under `none` there are no
 * destinations at all.
 */
export function moveDestinationChoices(
  destinations: readonly MoveDestination[],
  opts: { excludeLocationId?: string | null; scope?: MoveDestinationScope } = {},
): MoveDestination[] {
  const scope = opts.scope ?? { kind: 'all' };
  if (scope.kind === 'none') return [];
  return destinations.filter((d) => {
    if (opts.excludeLocationId && d.id === opts.excludeLocationId) return false;
    if (scope.kind === 'warehouse' && d.warehouseId !== scope.warehouseId) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// New-rack confirmation — the 2026-07-23 guard, mirrored on the phone.
//
// When "+ New rack…" is chosen in put-away and the typed label does NOT already
// exist in the destination scope, the phone must ask before creating it — the
// SAME question, in the SAME words as web, because the copy comes from the one
// shared builder in @stockpilot/core. The pure derivation lives here so it can
// be unit-tested; the modal only renders an Alert around the result.
// ---------------------------------------------------------------------------

export interface NewRackInput {
  rackNumber: string;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
  /** Books can create crates; everything else is a rack. Gates the crate fields. */
  isBook: boolean;
}

/**
 * The display label a "+ New rack" form will create — the SAME derivation the
 * web dialog uses, so both platforms feed the identical string to the shared
 * copy builder. A crate reads "Blue #42"; a rack reads "22-B" or bare "22".
 */
export function newRackLabel(n: NewRackInput): { label: string; noun: 'rack' | 'crate' } {
  const color = n.crateColor?.trim();
  if (n.isBook && color) {
    const num = n.crateNumber?.trim() || n.rackNumber.trim();
    return { label: `${color} #${num}`, noun: 'crate' };
  }
  const row = n.rackRow?.trim();
  const number = n.rackNumber.trim();
  return { label: row ? `${number}-${row}` : number, noun: 'rack' };
}

/**
 * Whether a put-away into a typed rack/crate must confirm, and the exact copy +
 * near-match alternatives to show. Delegates the words to the shared core
 * builder so the phone and the web dialog never drift apart.
 */
export function decideNewRackPlacement(input: {
  rack: NewRackInput;
  warehouseName?: string | null;
  quantity: number;
  existingLabels: readonly string[];
}): NewRackPlacementDecision {
  const { label, noun } = newRackLabel(input.rack);
  return describeNewRackPlacement({
    label,
    warehouseName: input.warehouseName,
    quantity: input.quantity,
    existingLabels: input.existingLabels,
    noun,
  });
}
