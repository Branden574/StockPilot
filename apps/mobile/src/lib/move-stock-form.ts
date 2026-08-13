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
  parseBookRackChangeDetail,
  planNewLocation,
  summarizeBookRackClears,
  type BookCrateChangeDetail,
  type BookRackAcknowledgedChange,
  type BookRackChangeDetail,
  type NewRackPlacementDecision,
} from '@stockpilot/core';

// Type-only (erased at build): the two routes' own success bodies, so the
// crate-sync verdicts below read the SAME shape the caller hands them and a new
// flag on either route surfaces here as a type change rather than a silent gap.
// A value import would pull './api' — and with it the Supabase client — into
// this pure module and out of reach of the node test environment.
import type { RemoveStockResult, TransferStockBody, TransferStockResult } from './stock-api';

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
 * `kind` is an EXPLICIT choice of the KIND OF ROW, not something inferred from
 * which boxes happen to be filled. The sheet used to render "RACK NUMBER *"
 * plus two optional crate boxes with no toggle at all, which had two
 * consequences and both were live defects:
 *
 *   • a number-only crate was UNREACHABLE — submit was gated on the rack
 *     number, and the label derivation keyed crate-ness off the COLOUR alone
 *     (`crateColor ? 'crate' : 'rack'`), the exact heuristic the server removed
 *     in afcc5d82. The two halves of one boundary disagreed;
 *   • rack A1 + crate 9 minted "Crate #9" with no confirmation, after asking
 *     "Create new rack A1?" — the string confirmed and the string created
 *     differed character for character (REPRO A / A').
 *
 * ═══ THE KIND IS EXCLUSIVE; THE PLACE IS NOT ═══
 *
 * A CRATE SITS ON A RACK. The crate branch therefore carries the SAME optional
 * rack pair, and "rack A1 + crate 9" now creates ONE row called "Crate #9 on
 * rack A1" — the string confirmed and the string created, identical. Reading
 * the toggle as two rival PLACES is what made a positioned crate unreachable
 * and left books recorded in a crate with no rack at all.
 */
export type NewLocationKind = 'rack' | 'crate';

export interface NewRackInput {
  /** Which branch the user chose. Books may choose 'crate'; nothing else may. */
  kind: NewLocationKind;
  /** The rack — its own identity on the rack branch, the CRATE'S POSITION on the crate branch. */
  rackNumber: string;
  rackRow?: string | null;
  crateColor?: string | null;
  crateNumber?: string | null;
}

/**
 * The four fields as the SERVER will read them for the chosen branch.
 *
 * The RACK branch sends no crate pair — a rack is not a crate. The CRATE branch
 * sends its number, its optional colour AND its optional position, because all
 * three are facts about the same bin; a crate with no position simply omits the
 * pair, which is what keeps an existing position-less crate matched and reused.
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
  const rackNumber = n.rackNumber.trim();
  const row = n.rackRow?.trim();
  if (n.kind === 'crate') {
    const color = n.crateColor?.trim();
    return {
      crateNumber: n.crateNumber?.trim() ?? '',
      ...(color ? { crateColor: color } : {}),
      ...(rackNumber ? { rackNumber } : {}),
      ...(row ? { rackRow: row } : {}),
    };
  }
  return { rackNumber, ...(row ? { rackRow: row } : {}) };
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
 * create another. A crate reads "Blue #42" / "Crate #42", or "Blue #42 on rack
 * 22-B" when it sits on one; a rack reads "22-B" or bare "22". An incomplete
 * form yields '' and the caller must not confirm.
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
 *
 * THE RACK SENTENCE RIDES ON THE SAME LINE when the payload carries one. It is
 * not a second question — the operator is answering the crate change, and this
 * is the rest of what answering it does: a full move into a position-less crate
 * CLEARS `book_rack_number` / `book_rack_row`, which is a value a human typed by
 * hand. Only the server can know that (it reads the live holdings), so the phone
 * prints what it was told and never derives it.
 *
 * A payload with no rack sentence — an older server, a split move, a rack the
 * gate could not predict — simply reads as it always did. `rackLine` is optional
 * on the wire for exactly that reason.
 */
export function bookCrateAlertMessage(detail: BookCrateChangeDetail): string {
  return detail.items
    .map((i) => {
      const base = `${i.itemName} is recorded in ${i.currentLabel ?? 'no crate'} — this move records it in ${i.nextLabel ?? 'no crate'}.`;
      return i.rackLine ? `${base} ${i.rackLine}` : base;
    })
    .join('\n');
}

/**
 * Pull the RACK half of a confirmation payload out of the same API error.
 *
 * A SECOND, INDEPENDENTLY-FINGERPRINTED QUESTION, not a field on the crate one.
 * The defect that created this channel is precisely the case where the crate
 * does NOT change — crate "Blue Shelf" placed into the position-less crate
 * ('blue','Shelf') normalises to the identical pair — so the crate gate is right
 * to stay silent while a hand-typed rack 38-A is erased underneath it. A client
 * that only ever parses the crate half reads that payload as "no question here"
 * and cannot answer the one thing being asked.
 *
 * Reads `rackItems` whatever the `reason` says, because one placement can raise
 * both halves and the server sends ONE payload naming the CRATE reason whenever
 * there is at least one crate line. `parseBookRackChangeDetail` owns that rule.
 */
export function bookRackRefusal(e: unknown): BookRackChangeDetail | null {
  if (!e || typeof e !== 'object') return null;
  return parseBookRackChangeDetail((e as { details?: unknown }).details);
}

/**
 * The `acknowledgedRackChanges` field of a transfer body — ALWAYS PRESENT, even
 * when there is nothing to acknowledge. That absence/emptiness distinction is
 * the entire mechanism, not a formatting detail, which is why it is a function
 * with a test rather than a spread inside a component.
 *
 * ═══ WHY THIS ONE IS NOT SPREAD CONDITIONALLY LIKE THE CRATE LIST ═══
 *
 * `acknowledgedCrateChanges` carries an ANSWER and nothing else, so an empty
 * answer is the same as no answer and is correctly left out.
 *
 * This field carries an answer AND, by its mere PRESENCE, the client's
 * declaration that it can be asked a rack question at all. The route reads an
 * ABSENT key as "this caller cannot answer" and then succeeds while PRESERVING
 * the recorded rack instead of refusing, reporting `crateSyncRackPreserved`.
 * That fail-safe is right for the shipped OTA, which has no rack channel and
 * could not render a refusal it has no way to answer.
 *
 * Spread conditionally, the sheet would therefore opt ITSELF OUT of the question
 * on the FIRST request of every move — the one request that matters, because it
 * is the one the erasure is decided on. The operator would never be offered the
 * choice and nothing would look broken. That was the shipped behaviour.
 *
 * A source grep of the modal cannot tell a key that is absent from one that is
 * present and empty, and this harness cannot render the modal. So the rule lives
 * here, where deleting it fails a test.
 */
/**
 * THE WHOLE REQUEST BODY, built where a test can reach it.
 *
 * WHY THIS IS A FUNCTION and not an object literal inside the sheet: a
 * verifier changed the sheet's one wiring line from an unconditional spread to
 * a conditional one -- literally the shipped bug this feature exists to fix --
 * and the ENTIRE mobile suite stayed green, typecheck included, because the
 * field is optional. The rule was pinned inside `rackAcknowledgementField`,
 * where deleting it fails a test; the WIRING that calls it was pinned by
 * nothing. So "the phone asks at all" rested on a single unprotected line, in
 * a feature whose documented history is exactly this regression shipping once
 * before and surviving every test.
 *
 * The two keys are deliberately asymmetric, and that asymmetry is the point:
 *
 *   `acknowledgedRackChanges` is sent ALWAYS, even empty. Its PRESENCE is how
 *   this client declares it can be asked a rack question. An absent key makes
 *   the server take the fail-safe path forever -- keep the rack, report
 *   crateSyncRackPreserved -- so the phone would never be asked and the
 *   operator would never learn a label went stale.
 *
 *   `acknowledgedCrateChanges` is sent ONLY when non-empty, because that is
 *   the shape already shipped in the live OTA. Sending it empty would be a
 *   payload change against devices in the field for no gain.
 *
 * An empty rack list is not a weak acknowledgement: this sheet holds a
 * render-time snapshot and no live holdings, so it cannot tell a full move
 * (which clears the rack pair) from a split (which does not). It must be TOLD
 * of an erasure by the only reader that knows, then echo that reading back --
 * never predict one and pre-acknowledge it.
 */
export function transferRequestBody(input: {
  fromLocationId: string;
  quantity: number;
  notes?: string;
  destination: Record<string, unknown>;
  acknowledged?: readonly { itemId: string; currentFingerprint: string }[] | null;
  acknowledgedRacks?: readonly BookRackAcknowledgedChange[] | null;
}): TransferStockBody {
  return {
    fromLocationId: input.fromLocationId,
    quantity: input.quantity,
    ...(input.notes ? { notes: input.notes } : {}),
    ...input.destination,
    ...(input.acknowledged && input.acknowledged.length > 0
      ? { acknowledgedCrateChanges: [...input.acknowledged] }
      : {}),
    ...rackAcknowledgementField(input.acknowledgedRacks),
  } as TransferStockBody;
}

export function rackAcknowledgementField(
  acknowledgedRacks?: readonly BookRackAcknowledgedChange[] | null,
): { acknowledgedRackChanges: BookRackAcknowledgedChange[] } {
  return { acknowledgedRackChanges: [...(acknowledgedRacks ?? [])] };
}

/** A native Alert's two strings for a refusal the operator can answer. */
export interface PlacementRefusalAlert {
  title: string;
  message: string;
}

/**
 * ONE Alert for a refusal, however many halves it has.
 *
 * A native Alert is a single title and a single body, and two Alerts in a row
 * are two near-identical modals where the second arrives after the operator has
 * already committed to the first — which trains people to tap through the one
 * that matters. Web solves this with one dialog rendering both panels
 * (placement-confirm-dialog.tsx); the phone joins the sentences instead.
 *
 * ═══ THE TITLE NAMES THE CHANGE THAT IS ACTUALLY HAPPENING ═══
 *
 * A rack-ONLY refusal is the reported defect's own case: the crate is IDENTICAL,
 * so "Change this book's crate?" would name a change that is not happening and
 * the operator would reasonably tap Continue believing they had understood it.
 * Same rule web applies, same two titles.
 *
 * ═══ THE RACK SENTENCE IS SAID EXACTLY ONCE ═══
 *
 * One rack sentence can arrive by two routes here and they are DELIBERATELY the
 * same string — `describeRackChange` composes both: as DISCLOSURE riding on a
 * crate line (`items[].rackLine`, already inside `bookCrateAlertMessage`), and
 * as the answerable QUESTION on a rack line (`rackItems[].line`). A placement
 * that changes the crate AND erases the rack produces both at once, so the
 * rack lines already present in the crate body are dropped rather than repeated:
 * an operator who reads "Rack 38-A will be cleared." twice in one Alert learns
 * to skim it. Deduped by `summarizeBookRackClears` first, so 200 books coming
 * off one rack contribute one sentence and never 200.
 *
 * Returns null when there is nothing answerable — the caller then falls through
 * to the plain error, which is the honest outcome for a payload this client
 * cannot turn into a question.
 */
export function placementRefusalAlert(input: {
  crate: BookCrateChangeDetail | null;
  rack: BookRackChangeDetail | null;
}): PlacementRefusalAlert | null {
  const { crate, rack } = input;
  if (!crate && !rack) return null;
  const crateBody = crate ? bookCrateAlertMessage(crate) : '';
  const rackLines = rack ? summarizeBookRackClears(rack.items).lines : [];
  // Only a sentence this Alert is provably already showing is dropped. No
  // match, no change — this can shorten the body and can never delete the
  // question.
  const unsaid = rackLines.filter((line) => !crateBody.includes(line));
  const message = [crateBody, ...unsaid].filter((s) => s.length > 0).join('\n');
  if (!message) return null;
  return {
    title: crate ? "Change this book's crate?" : "Clear this book's rack?",
    message,
  };
}

// ---------------------------------------------------------------------------
// The SILENT SUCCESSES, on the phone.
//
// A transfer can succeed — the stock really did move — while the book's crate
// LABEL did not follow it. The route reports that as a flag on a 2xx body, and
// a sheet that only branches on failure shows a plain "Moved" for a move that
// left the item naming a crate holding none of it. Web says so in every one of
// the four cases (place-from-staging-dialog.tsx, bulk-place-dialog.tsx,
// stock-transfer-dialog.tsx); the phone must too.
//
// The WRITE-OFF sheet has the same duty and one more case, so its verdict lives
// here too — same precedence, different verbs. Two files would be two
// vocabularies, and a vocabulary that only exists on one screen is how the
// phone ended up silent about a label it had just rewritten.
//
// The words live HERE rather than inline in the modal for the same reason every
// other rule in this file does: apps/mobile has no component-test harness (node
// vitest, `include: ['src/**/*.test.ts']`, no react-test-renderer and no
// @testing-library/react-native), so a branch left inside the component can only
// ever be "tested" by reading the component's source text — which passes just as
// happily against a branch that renders nothing.
// ---------------------------------------------------------------------------

/** A native Alert's two strings: what the sheet SAYS after a successful write. */
export interface CrateSyncWarning {
  title: string;
  message: string;
}

/** The flags a 2xx body can carry about a book's crate label. Structural, so
 *  both route bodies (TransferStockResult, RemoveStockResult) satisfy it and a
 *  new flag on either one shows up here as a type change, not a silent gap. */
interface CrateSyncFlags {
  crateSyncFailed?: boolean;
  crateSyncUnplaced?: boolean;
  crateSyncStale?: boolean;
  crateSyncSkipped?: boolean;
  /** The RACK label was kept rather than erased, because nobody was shown the
   *  erasure. The crate half is unaffected — this is the other label. */
  crateSyncRackPreserved?: boolean;
  crateSyncUpdated?: boolean;
}

/** Which single outcome is worth speaking about. */
type CrateSyncBucket =
  | 'failed'
  | 'unplaced'
  | 'stale'
  | 'skipped'
  | 'rackPreserved'
  | 'updated';

/**
 * THE PRECEDENCE — one chain, shared by every surface that reports a crate
 * label, so the two flavours below can differ in WORDS and never in which
 * outcome wins. A native Alert is modal and stacks badly, and a route can
 * legitimately set more than one flag, so exactly one thing is said.
 *
 * The order runs from "the label is wrong and we know why we could not fix it"
 * down to "the label is merely unchanged, on purpose", with the write we DID
 * perform last:
 *
 *   1. failed        — the write itself errored. The most actionable, so it wins.
 *   2. unplaced      — nothing is left in a rack or crate for the label to follow.
 *   3. stale         — someone else re-recorded the crate mid-write; theirs stands.
 *   4. skipped       — stock now sits in several places, so there is no one crate.
 *   5. rackPreserved — the CRATE half is fine; the RACK label was kept, unasked.
 *   6. updated       — the label was rewritten, and its value really did change.
 *
 * The first four are mutually exclusive with the last two by construction (a
 * book lands in exactly one server-side bucket), so the tail positions cost
 * nothing and keep "we changed something" from ever hiding "we could not".
 *
 * `rackPreserved` sits BELOW the four crate outcomes and above `updated` for the
 * same reason web puts it last in its chain: it is the only one of the six that
 * reports on the OTHER label, so when a crate outcome is also present that crate
 * outcome is the more specific thing to say. The service guarantees they rarely
 * collide at all — `rackPreservedItemIds ⊆ syncedItemIds`, and a synced item is
 * in none of failed/skipped/stale/unplaced — so for a single-item transfer, the
 * shape this sheet always sends, the case is disjoint outright.
 */
function crateSyncBucket(res: CrateSyncFlags): CrateSyncBucket | null {
  if (res.crateSyncFailed) return 'failed';
  if (res.crateSyncUnplaced) return 'unplaced';
  if (res.crateSyncStale) return 'stale';
  if (res.crateSyncSkipped) return 'skipped';
  if (res.crateSyncRackPreserved) return 'rackPreserved';
  if (res.crateSyncUpdated) return 'updated';
  return null;
}

/**
 * What the MOVE sheet must say about a move that SUCCEEDED, given what the
 * route reported about the crate label. `null` = nothing to say; the move was
 * clean and the summary followed the stock.
 *
 * The item name is interpolated rather than left generic because the phone
 * fires this Alert after the sheet has already closed, when "the item" no longer
 * has an on-screen referent.
 *
 * A transfer never reports `crateSyncUpdated` — the route has no such flag, and
 * a put-away that relabels a book already answered the confirmation gate first.
 */
export function crateSyncWarning(
  res: TransferStockResult,
  itemName: string,
): CrateSyncWarning | null {
  switch (crateSyncBucket(res)) {
    case 'failed':
      return {
        title: 'Moved, but the crate label did not update',
        message: `${itemName} was moved. Its crate label could not be written — check the book's details.`,
      };
    case 'unplaced':
      return {
        title: 'Moved — crate label may now be wrong',
        message: `${itemName} has no stock in a rack or crate now, so its crate label was left unchanged.`,
      };
    case 'stale':
      return {
        title: 'Moved — someone else changed the crate',
        message: `${itemName} was moved, but its crate was changed by someone else while it was moving. The label was left as they set it.`,
      };
    case 'skipped':
      return {
        title: 'Moved — crate label left unchanged',
        message: `${itemName} now has stock in more than one location, so its crate label was left as it was.`,
      };
    // The OTHER label. The crate half followed the stock; the RACK pair would
    // have been ERASED by the reconciliation and was kept instead, because
    // nobody was shown that erasure. Saying so is the entire reason keeping it
    // is the safe choice: a stale rack label is visibly wrong and the audit row
    // still says what it was, but only if someone is told to go and look. A
    // preserved rack reported as a bare success is the same silence as a wiped
    // one, and this sheet did exactly that until now.
    case 'rackPreserved':
      return {
        title: 'Moved — rack label may now be wrong',
        message: `${itemName} was moved, but its rack label was left as it was — nobody was asked about clearing it, so it may now name a rack this stock has left.`,
      };
    default:
      return null;
  }
}

/**
 * The same verdict for a WRITE-OFF (remove from rack), whose route answers with
 * the same four flags plus one more.
 *
 * It lives beside `crateSyncWarning`, sharing its precedence chain, because the
 * alternative is two vocabularies drifting apart on two screens: the write-off
 * sheet used to discard the flags entirely and say nothing at all, which is the
 * defect this closes. Only the VERBS differ — the stock did not move anywhere,
 * it left — and saying "Moved" about a write-off would be its own small lie.
 *
 * The wording tracks the web dialog for this same operation
 * (apps/web/src/components/inventory/remove-from-rack-dialog.tsx), which is the
 * established voice for a write-off.
 */
export function removeStockCrateWarning(
  res: RemoveStockResult,
  itemName: string,
): CrateSyncWarning | null {
  switch (crateSyncBucket(res)) {
    case 'failed':
      return {
        title: 'Removed, but the crate label did not update',
        message: `The crate label on ${itemName} could not be updated — check the book's details.`,
      };
    case 'unplaced':
      return {
        title: 'Removed — crate label may now be wrong',
        message: `${itemName} has no stock in a rack or crate now, so its crate label was left unchanged.`,
      };
    case 'stale':
      return {
        title: 'Removed — someone else changed the crate',
        message: `Someone else changed the crate on ${itemName} while the stock was being removed. The label was left as they set it.`,
      };
    case 'skipped':
      return {
        title: 'Removed — crate label left unchanged',
        message: `${itemName} still has stock in more than one location, so its crate label was left as it was.`,
      };
    // A label the app changed on the operator's behalf. They asked to remove
    // stock and typed a reason; they did not ask for "Blue 4" to become
    // "Red 7". The reconciliation is right — the summary is derived from the
    // holdings — but a rewrite of a value a human recorded is a caution, not
    // good news, exactly as it is on web.
    case 'updated':
      return {
        title: 'Removed — the crate label changed',
        message: `The crate label on ${itemName} was changed to follow the stock it has left.`,
      };
    // The OTHER label, and on this path it is never anything BUT preserved: a
    // write-off has no destination, so it has no confirmation gate, so a rack
    // erasure can never be agreed to here. Draining one of two holdings can
    // leave the book in a single position-less crate, which would clear a rack a
    // human typed; the reconciliation withholds that clear and reports it. The
    // report is the only thing that makes keeping a stale label recoverable.
    case 'rackPreserved':
      return {
        title: 'Removed — rack label may now be wrong',
        message: `The rack label on ${itemName} was left as it was — nobody was asked about clearing it, so it may now name a rack this stock has left.`,
      };
    default:
      return null;
  }
}
