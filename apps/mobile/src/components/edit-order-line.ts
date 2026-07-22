import { describeRaiseAfterPicking, describeUnpickedShortfall } from '@stockpilot/core';

import { extractApiErrorMessage } from '../lib/po-import-approve';

import { addLinesErrorStatus, canAddOrderItems, type AddItemsGateInput } from './add-order-items';

/**
 * Pure decision/validation helpers for the native "correct a line on an
 * existing order" sheet (components/edit-order-line-sheet.tsx) — the other half
 * of add-order-items.ts. Free of React/react-native imports so every refusal
 * rule is unit-tested without a renderer, which is the only coverage RN
 * components get in this repo.
 *
 * Server contract these mirror (PINNED — apps/web .../api/v1/orders/[id]/lines):
 *   PATCH  /api/v1/orders/[id]/lines   { lineId, quantity }
 *     → 200 { ok: true, quantity, pickSlipStale }
 *   DELETE /api/v1/orders/[id]/lines?lineId=…
 *     → 200 { ok: true, removedItemId, pickSlipStale }
 * Both hand straight to OrderRequestsService.updateLineQuantity / removeLine —
 * the SAME methods the web server actions call — so everything below is a
 * COSMETIC mirror of a server-enforced rule, never the boundary. The wording is
 * copied from the service on purpose: a local refusal and the server's refusal
 * for the same situation must read identically, or the two platforms teach the
 * user two different stories about the same stock.
 */

/** zod cap on the route body (`quantity.max(100_000)`). */
export const LINE_EDIT_MAX_QUANTITY = 100_000;

/** The line fields every rule below reads. `picked` is quantity_picked
 *  normalised to 0 — the column is NULL until a picker stages anything. */
export interface EditableOrderLine {
  /** order_request_lines.id. Null on a row whose id failed to load, which is
   *  not editable at all (there is nothing to address the write to). */
  orderRequestLineId: string | null;
  /** inventory_items.id — the fallback for the removal result's removedItemId
   *  when the route's echo is missing. No rule below reads it. */
  itemId: string | null;
  name: string;
  /** quantity_requested. */
  requested: number;
  /** quantity_fulfilled — units physically HANDED OVER. */
  fulfilled: number;
  /** quantity_picked — units STAGED by a picker, not yet handed over. */
  picked: number;
  /** returned_quantity — units already applied against a return. */
  returned: number;
}

// ── Gate ────────────────────────────────────────────────────────────────────

/**
 * Whether to offer line editing at all.
 *
 * Deliberately delegates to canAddOrderItems rather than restating the rule:
 * on the server, addLines / updateLineQuantity / removeLine all load the order
 * through ONE private helper (loadEditableOrderHeader), so an order you can add
 * to but cannot correct is precisely the bug the owner reported. Re-deriving
 * the gate here would let the two drift apart again.
 */
export function canEditOrderLines(input: AddItemsGateInput): boolean {
  return canAddOrderItems(input);
}

// ── Quantity floors (mirror of U2 / U3) ─────────────────────────────────────

/**
 * The lowest quantity this line may be set to. Raising is always fine — it is
 * the same act as adding more — so only the DOWNWARD direction has a floor:
 *  • quantity_fulfilled — those units left the building; the record must stand.
 *  • quantity_picked — those units are staged on a cart right now, and
 *    shrinking the request beneath them would strand physical stock.
 * A line with neither floors at 1: zero means "remove the line", which is a
 * different operation with its own, stricter rules.
 */
export function lineQuantityFloor(line: EditableOrderLine): number {
  return Math.max(1, line.fulfilled, line.picked);
}

/** Why the floor is where it is, or null when nothing constrains it. Shown
 *  under the stepper so a disabled "−" is never unexplained. */
export function describeQuantityFloor(line: EditableOrderLine): string | null {
  if (line.fulfilled > 0 && line.fulfilled >= line.picked) {
    return `${line.fulfilled} of these have already been handed over, so the quantity cannot go below ${line.fulfilled}.`;
  }
  if (line.picked > 0) {
    return `${line.picked} of these are already picked and staged. Unstage them or finish fulfilling this line to go lower.`;
  }
  return null;
}

/** Step the draft quantity, clamped to [floor, route cap]. */
export function stepLineQuantity(current: number, delta: number, floor: number): number {
  const next = Math.floor(current) + delta;
  return Math.max(floor, Math.min(LINE_EDIT_MAX_QUANTITY, next));
}

/**
 * Read a typed quantity. Returns null for anything that is not a whole number
 * the route would accept, so the sheet can keep the Save button honest while
 * the user is still mid-keystroke (an empty field is null, not 0).
 */
export function parseLineQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > LINE_EDIT_MAX_QUANTITY) return null;
  return n;
}

export type LineEditDecision = { ok: true } | { ok: false; reason: string };

/**
 * Mirror of updateLineQuantity's U1 → U3, in the server's own order and
 * wording. Refusing locally saves a round trip AND — more importantly — means
 * the message the user reads is the same one the server would have sent.
 */
export function validateLineQuantity(line: EditableOrderLine, quantity: number): LineEditDecision {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    return { ok: false, reason: 'Enter a quantity above zero, or remove the line instead.' };
  }
  if (quantity > LINE_EDIT_MAX_QUANTITY) {
    return {
      ok: false,
      reason: `The most you can order on one line is ${LINE_EDIT_MAX_QUANTITY}.`,
    };
  }
  // Raising skips the floors entirely — same act as adding more (U4).
  if (quantity < line.requested) {
    if (quantity < line.fulfilled) {
      return {
        ok: false,
        reason: `${line.fulfilled} of these have already been handed over — the quantity can't go below ${line.fulfilled}.`,
      };
    }
    if (quantity < line.picked) {
      return {
        ok: false,
        reason: `${line.picked} of these are already picked and staged — unstage them or finish fulfilling this line before lowering the quantity below ${line.picked}.`,
      };
    }
  }
  return { ok: true };
}

// ── Shortfall after picking (SO-000061) ─────────────────────────────────────

/**
 * Adapts this file's line shape to the shared derivation in @stockpilot/core.
 * The arithmetic and the status set live THERE, not here — mobile and web must
 * not be able to disagree about how many units nobody has pulled.
 */
function toShortfallLine(line: EditableOrderLine) {
  return {
    quantityRequested: line.requested,
    quantityFulfilled: line.fulfilled,
    quantityPicked: line.picked,
  };
}

/**
 * The sentence to put in front of the user BEFORE a raise is committed, or
 * null when the edit needs no warning.
 *
 * NOT a refusal. Raising a line after picking is legitimate (the service still
 * accepts it, and the floors above are the only hard rules); what went wrong on
 * SO-000061 is that nobody was told the extra units still had to be pulled.
 */
export function describeLineRaiseWarning(
  line: EditableOrderLine,
  nextQuantity: number,
  status: string | null | undefined,
): string | null {
  return describeRaiseAfterPicking({
    line: toShortfallLine(line),
    nextRequested: nextQuantity,
    status,
  });
}

export const LINE_RAISE_CONFIRM_TITLE = 'Raise this quantity anyway?';
export const LINE_RAISE_CONFIRM_ACTION = 'Raise the quantity';
export const LINE_RAISE_CONFIRM_CANCEL = 'Leave it as it is';

/**
 * The standing notice for the order screen: units that are neither handed over
 * nor staged, once picking is settled. Null on a healthy order.
 */
export function orderShortfallNotice(
  lines: readonly EditableOrderLine[],
  status: string | null | undefined,
): string | null {
  return describeUnpickedShortfall(lines.map(toShortfallLine), status);
}

// ── Removal (mirror of R1-R3 and R5; R4 is deleted — see below) ─────────────

export interface RemoveLineInput {
  line: EditableOrderLine;
  /** How many lines the order has in total — removing the last one is refused. */
  totalLines: number;
}

/**
 * Whether "Remove" is offered, and if not, what the user has to do first.
 *
 * The refusal ORDER matches removeLine exactly. It matters: a line that is both
 * staged and last must name the staging problem first, because that is the one
 * the user can act on directly.
 *
 * DELETED (2026-07-22, production defect on SO-000060): there used to be a
 * refusal here when an un-released stock_reservations row pointed at the line's
 * item. A reservation is a SOFT HOLD minted for every line at APPROVAL — it
 * moves no stock — so that rule made removal impossible from approval onward on
 * an order where nothing had been picked, which is exactly what the owner hit.
 * Worse, its copy told the user to "unstage the order or regenerate the pick
 * slip to release it", and neither of those operations releases a reservation:
 * the instruction could not be followed at all. The service now RE-SYNCS the
 * hold to what the order still asks for (releasing it with released_reason
 * 'line_removed' when nothing remains) instead of refusing, so there is nothing
 * left for this mirror to warn about. What protects physical reality is
 * quantity_fulfilled and quantity_picked, which are still hard refusals below.
 */
export function canRemoveOrderLine(input: RemoveLineInput): LineEditDecision {
  const { line } = input;
  if (line.orderRequestLineId === null) {
    return { ok: false, reason: 'This line could not be loaded. Pull to refresh and try again.' };
  }
  if (line.fulfilled > 0) {
    return {
      ok: false,
      reason: `${line.fulfilled} of these have already been handed over — this line can't be removed. Lower the quantity instead, or record a return.`,
    };
  }
  if (line.picked > 0) {
    return {
      ok: false,
      reason: `${line.picked} of these are already picked and staged — unstage them first, then remove the line.`,
    };
  }
  if (line.returned > 0) {
    return {
      ok: false,
      reason:
        'This line has returns recorded against it and has to stay on the order for the history to make sense.',
    };
  }
  if (input.totalLines <= 1) {
    return {
      ok: false,
      reason: 'This is the only item on the order — cancel the order instead of emptying it.',
    };
  }
  return { ok: true };
}

/**
 * Confirmation copy for a removal. Names the item, because the sheet is opened
 * from a list and "Remove this line?" is not something you can check.
 *
 * The release sentence is stated UNCONDITIONALLY and hedged ("any stock still
 * held"), because the sheet no longer reads stock_reservations: the service
 * re-syncs the hold on its own, and re-adding a per-item reservation query just
 * to word this one sentence would put back the round trip whose result nothing
 * else needed. Hedged is honest for all three cases — approved (a hold exists
 * and is released), still pending approval (no hold to release), and the same
 * item sitting on a second line (the hold is REDUCED by this line's share, not
 * released). It is scoped to "this line" for exactly that last case: claiming
 * the item's whole hold goes back would be wrong whenever a sibling line
 * still asks for it.
 */
export function removeLineConfirmCopy(line: EditableOrderLine): {
  title: string;
  message: string;
} {
  return {
    title: `Remove ${line.name}?`,
    message: `All ${line.requested} of this item come off the order. The order keeps its other items; nothing is restocked, because none of these were picked or handed over. Any stock still being held for this line goes back to available.`,
  };
}

// ── Result copy ─────────────────────────────────────────────────────────────

export interface LineQuantityResult {
  quantity: number;
  pickSlipStale: boolean;
}

export interface LineRemovedResult {
  removedItemId: string;
  pickSlipStale: boolean;
}

/** The pick-slip sentence both confirmations end with. A quantity change moves
 *  no line's created_at, so the screen's derived staleness rule cannot see it —
 *  the route's own verdict is the only signal. */
const STALE_SLIP_SENTENCE =
  'The pick slip printed earlier no longer matches this order. Generate it again before picking.';

export function lineQuantitySummary(line: EditableOrderLine, result: LineQuantityResult): string {
  const head =
    result.quantity === line.requested
      ? `${line.name} is unchanged at ${result.quantity}.`
      : `${line.name} is now ${result.quantity} (was ${line.requested}).`;
  return result.pickSlipStale ? `${head} ${STALE_SLIP_SENTENCE}` : head;
}

export function lineRemovedSummary(line: EditableOrderLine, result: LineRemovedResult): string {
  const head = `${line.name} was removed from the order.`;
  return result.pickSlipStale ? `${head} ${STALE_SLIP_SENTENCE}` : head;
}

// ── Server error copy ───────────────────────────────────────────────────────

/**
 * Server error → copy the user can act on. Both routes return a friendly
 * `message` for every 4xx (each ServiceError carries one), so that wins; this
 * map only covers responses that carry a BARE code — 500 is
 * `{"error":"internal_error"}` with no message and 401 is
 * `{"error":"unauthenticated"}` — where extractApiErrorMessage would otherwise
 * put a raw slug in front of the user.
 */
const LINE_EDIT_CODE_COPY = new Map<string, string>([
  ['unauthenticated', 'Your session has expired. Sign in again to change this order.'],
  ['forbidden', 'Only the requester or someone who can approve orders may change the items on it.'],
  ['module_disabled', 'Orders are turned off for this workspace.'],
  ['not_found', 'This line is no longer on the order. Pull to refresh.'],
  ['validation_error', 'That quantity cannot be used on this line.'],
  ['conflict', 'This order has moved on and can no longer be changed. Pull to refresh.'],
  ['rate_limited', 'Too many requests. Wait a moment and try again.'],
  ['internal_error', 'Something went wrong on our side. Try again in a moment.'],
]);

export function describeLineEditError(e: unknown): string {
  const msg = extractApiErrorMessage(e, 'Could not update this line. Please try again.');
  // A Map, not an object literal: a server body echoing something like
  // "constructor" must not resolve through Object.prototype.
  return LINE_EDIT_CODE_COPY.get(msg) ?? msg;
}

/**
 * Whether the failure means the viewer's picture of the order is stale rather
 * than their input being wrong — the session died, their grant was revoked, or
 * the line/order is gone. Nothing they type in the sheet can fix those, so it
 * closes and the screen reloads (which re-runs the gate).
 *
 * 409 is deliberately NOT in here, unlike the add sheet. On these two routes a
 * conflict is usually a FLOOR — "3 of these are already picked and staged" —
 * which is exactly the thing the user fixes by choosing a different number, in
 * the sheet, with the message in front of them. Yanking the sheet away would
 * take the instruction with it. The ONE 409 that must not stay in the sheet is
 * the post-write reservation-sync failure, which has its own predicate below.
 */
export function lineEditErrorIsStale(e: unknown): boolean {
  const status = addLinesErrorStatus(e);
  return status === 401 || status === 403 || status === 404;
}

/**
 * Whether the request never got an answer (api() aborts at 20s, or the socket
 * dropped).
 *
 * Unlike addLines, retrying is SAFE here: PATCH sets quantity_requested to an
 * absolute value and DELETE removes one addressed row, so applying either twice
 * lands on the same state. What is NOT safe is letting the user believe nothing
 * happened, because a write that committed after we gave up leaves the sheet
 * showing the old number — so we reload the order and say so instead of quietly
 * offering "try again".
 */
export function lineEditErrorIsIndeterminate(e: unknown): boolean {
  return addLinesErrorStatus(e) === null;
}

export const LINE_EDIT_INDETERMINATE_TITLE = 'Check the line before changing it again';
export const LINE_EDIT_INDETERMINATE_COPY =
  'We did not hear back from the server, so this change may already have been applied. ' +
  'The order has been refreshed — check the line before changing it again.';

/**
 * The one 409 on these routes that arrives AFTER the write has already
 * committed.
 *
 * removeLine / updateLineQuantity write the line FIRST and then re-sync the
 * item's stock reservation, deliberately in that order (over-holding is
 * self-correcting; over-releasing is not). If that second write loses a race it
 * throws a conflict — but the line change itself really happened. Treating it
 * like every other 409 would leave the sheet open, showing the old number,
 * telling the user to fix something that is already fixed, and inviting a
 * second identical edit.
 *
 * Matched on the service's own sentence, which is how the whole of this file
 * mirrors the server. If the wording ever drifts the match simply fails and we
 * fall back to the ordinary 409 path — a worse message, never a wrong write.
 */
const RESERVATION_SYNC_MARKER = 'stock reserved for this item changed';

export function lineEditErrorIsReservationSync(e: unknown): boolean {
  if (addLinesErrorStatus(e) !== 409) return false;
  return extractApiErrorMessage(e, '').toLowerCase().includes(RESERVATION_SYNC_MARKER);
}

export const LINE_EDIT_RESERVATION_SYNC_TITLE = 'Change saved — check the reserved stock';
export const LINE_EDIT_RESERVATION_SYNC_COPY =
  'The line was changed, but the stock still held for this item could not be updated to match. ' +
  'The order has been refreshed. Nothing is lost — the hold is released when the order is ' +
  'delivered or cancelled — but availability for this item stays low until then.';
