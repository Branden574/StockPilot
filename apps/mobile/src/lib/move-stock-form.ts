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

import {
  describeNewRackPlacement,
  parseBookCrateChangeDetail,
  planNewLocation,
  type BookCrateChangeDetail,
  type NewRackPlacementDecision,
} from '@stockpilot/core';

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

/**
 * A "+ New" destination as the sheet collects it.
 *
 * `kind` is an EXPLICIT choice, not something inferred from which boxes happen
 * to be filled. The sheet used to render "RACK NUMBER *" plus two optional
 * crate boxes with no toggle at all, which had two consequences and both were
 * live defects:
 *
 *   • a number-only crate was UNREACHABLE — submit was gated on the rack
 *     number, and the label derivation keyed crate-ness off the COLOUR alone
 *     (`crateColor ? 'crate' : 'rack'`), the exact heuristic the server removed
 *     in afcc5d82. The two halves of one boundary disagreed;
 *   • rack A1 + crate 9 minted "Crate #9" with no confirmation, after asking
 *     "Create new rack A1?" — the string confirmed and the string created
 *     differed character for character (REPRO A / A').
 *
 * Rack XOR crate is now the rule on both sides of the boundary, and it is
 * stated once, in packages/core/src/inventory/new-location.ts.
 */
export type NewLocationKind = 'rack' | 'crate';

export interface NewRackInput {
  /** Which branch the user chose. Books may choose 'crate'; nothing else may. */
  kind: NewLocationKind;
  rackNumber: string;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}

/**
 * The four fields as the SERVER will read them for the chosen branch — the
 * crate branch sends no rack pair and the rack branch sends no crate pair, so
 * the combination the server refuses cannot leave this screen.
 *
 * This is also what makes the confirmation honest: the same object produces the
 * label shown and the payload sent.
 */
export function newLocationFields(n: NewRackInput): {
  rackNumber?: string;
  rackRow?: string;
  crateColor?: string;
  crateNumber?: string;
} {
  if (n.kind === 'crate') {
    const color = n.crateColor?.trim();
    return {
      crateNumber: n.crateNumber?.trim() ?? '',
      ...(color ? { crateColor: color } : {}),
    };
  }
  const row = n.rackRow?.trim();
  return { rackNumber: n.rackNumber.trim(), ...(row ? { rackRow: row } : {}) };
}

/** Is the chosen branch complete enough to submit? A crate needs its NUMBER. */
export function newLocationReady(n: NewRackInput): boolean {
  return planNewLocation(newLocationFields(n)).kind !== 'invalid';
}

/**
 * The display label a "+ New" form will create, and the noun to call it.
 *
 * Delegates to the ONE core planner — the same function the server names the
 * `locations` row with — so the phone can no longer confirm one string and
 * create another. A crate reads "Blue #42" / "Crate #42"; a rack reads "22-B"
 * or bare "22". An incomplete form yields '' and the caller must not confirm.
 */
export function newRackLabel(n: NewRackInput): { label: string; noun: NewLocationKind } {
  const plan = planNewLocation(newLocationFields(n));
  if (plan.kind === 'invalid') return { label: '', noun: n.kind };
  return { label: plan.name, noun: plan.noun };
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

// ---------------------------------------------------------------------------
// The book-crate confirmation, on the phone.
//
// POST /api/v1/items/<id>/transfer now runs the same gate the web put-away
// runs, and refuses a move that would overwrite a crate a human recorded with a
// 409 carrying the structured payload. The sheet has to be able to ANSWER that,
// or every crated book dead-ends on an error toast — which is precisely why the
// route used to skip the gate and write nothing at all.
// ---------------------------------------------------------------------------

/**
 * Pull the book-crate confirmation payload out of an API error, if that is what
 * it is. `transferStock()` attaches the parsed body to the thrown Error as
 * `details`; anything else (a plain message, another conflict) yields null and
 * the caller shows the message as-is.
 */
export function bookCrateRefusal(e: unknown): BookCrateChangeDetail | null {
  if (!e || typeof e !== 'object') return null;
  return parseBookCrateChangeDetail((e as { details?: unknown }).details);
}

/**
 * The Alert body for a crate refusal: one line per book, naming where it is
 * recorded today and where this move would put it. Native Alerts take a single
 * string, so the lines are joined rather than rendered as a list.
 */
export function bookCrateAlertMessage(detail: BookCrateChangeDetail): string {
  return detail.items
    .map(
      (i) =>
        `${i.itemName} is recorded in ${i.currentLabel ?? 'no crate'} — this move records it in ${i.nextLabel ?? 'no crate'}.`,
    )
    .join('\n');
}
