/**
 * THE ONE-TAP FIX ON A SHORT LINE (F2-2, decision D18).
 *
 * A short line is fixed on the line itself, with the order's existing,
 * audited line edits (OrderRequestsService.updateLineQuantity and removeLine,
 * web and phone): the completion and departure confirms point here rather
 * than carrying buttons of their own. This module decides which of the two a
 * line offers, with the service's own floors, so a button is never offered
 * that the server would refuse:
 *   - Remove: only when nothing on the line was handed over or picked
 *     (fulfilled + picked = 0) and it is not the order's only line (removeLine
 *     R1, R2 and R5; returns need a hand-over, so R3 follows from R1);
 *   - Lower: to a whole quantity of at least 1 (updateLineQuantity U1; the
 *     line edits take whole numbers), never below what was handed over or
 *     picked (U2, U3), and below what is asked now.
 *
 * To pick (readiness phase to_pick), on a line that is short NOW, whatever
 * its worst state (Short, Waiting on a PO, or Can't confirm with numbers):
 * stock here does not cover what it owes (units.awaiting + units.short > 0).
 * That is exactly when the one-click pick takes less than the line owes, so
 * every line the completion confirm names short offers its fix:
 *   "Lower to N", N = what was handed over plus what stock covers for the line
 *   now (ready, needs put-away, or on record here without a location), and
 *   "Remove line". A line whose item the viewer cannot read has no numbers,
 *   and the confirm never names it short ("Stock couldn't be checked").
 * Picked (phase picked), on a line not fully picked:
 *   "Lower to what was picked (N)", N = handed over plus picked, and
 *   "Remove from order". Out for delivery the lines are final: no action, and
 *   a note says what happens instead.
 */

import type { PickedLineAssessment, ReadinessLineAssessment } from './readiness';

export type ShortLineAction =
  /** updateLineQuantity(line, quantity). */
  | { kind: 'lower'; quantity: number; label: string }
  /** removeLine(line). */
  | { kind: 'remove'; label: string };

export interface ShortLineActions {
  actions: ShortLineAction[];
  /** Said when the line is short but offers no action (or only one): why. */
  note: string | null;
}

export const SHORT_LINE_FINAL_NOTE =
  "The order is out for delivery, so this line can't be changed. The units not picked will be owed at hand-over; Close partial ends the order afterwards if they will not be sent.";
export const SHORT_LINE_ONLY_LINE_NOTE =
  "This is the only line on the order, so it can't be removed. Cancel the order instead if none of it is wanted.";

const EPS = 0.00005;

function n(v: number | null | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function qty(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Round to the 4 decimals quantities are stored with (numeric(14,4)). */
function q4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** The service's floors for a new requested quantity (U1-U3), and below what
 *  is asked now (a lower, never a raise). A whole number only: the line edits
 *  take whole numbers (the web action's and the lines route's quantity is
 *  .int()), so "Lower to 40.5" would be refused, on web and phone alike. */
function canLowerTo(target: number, line: { requested: number; fulfilled: number; picked: number | null }): boolean {
  return (
    Number.isInteger(target) &&
    target >= 1 - EPS &&
    target < n(line.requested) - EPS &&
    target >= n(line.fulfilled) - EPS &&
    target >= n(line.picked) - EPS
  );
}

/** removeLine's refusals R1, R2 and R5, as a yes or no. */
function canRemove(line: { fulfilled: number; picked: number | null }, isOnlyLine: boolean): boolean {
  return n(line.fulfilled) <= EPS && n(line.picked) <= EPS && !isOnlyLine;
}

export function shortLineActions(
  input:
    | { phase: 'to_pick'; line: ReadinessLineAssessment; isOnlyLine: boolean }
    | { phase: 'picked'; status: string; line: PickedLineAssessment; isOnlyLine: boolean },
): ShortLineActions {
  const none: ShortLineActions = { actions: [], note: null };
  const actions: ShortLineAction[] = [];

  if (input.phase === 'to_pick') {
    const { line } = input;
    // Short now: what stock covers falls below what the line owes. Waiting on
    // a PO and records that disagree are short now too (review 2026-09-28:
    // the confirm named them, and Review landed on a line with no fix). A
    // hidden item has no numbers; ready and put-away lines are covered.
    if (!line.units || line.units.awaiting + line.units.short <= EPS) return none;
    const covered = q4(line.units.ready + line.units.putAway + line.units.gap);
    const target = q4(n(line.fulfilled) + covered);
    if (canLowerTo(target, line)) {
      actions.push({ kind: 'lower', quantity: target, label: `Lower to ${qty(target)}` });
    }
    if (canRemove(line, input.isOnlyLine)) actions.push({ kind: 'remove', label: 'Remove line' });
  } else {
    const { line } = input;
    if (line.state !== 'short_picked') return none;
    if (input.status === 'in_transit') return { actions: [], note: SHORT_LINE_FINAL_NOTE };
    const target = q4(n(line.fulfilled) + n(line.picked));
    if (canLowerTo(target, line)) {
      actions.push({ kind: 'lower', quantity: target, label: `Lower to what was picked (${qty(target)})` });
    }
    if (canRemove(line, input.isOnlyLine)) actions.push({ kind: 'remove', label: 'Remove from order' });
  }

  const onlyLineBlocksRemove =
    input.isOnlyLine && n(input.line.fulfilled) <= EPS && n(input.line.picked) <= EPS;
  return { actions, note: onlyLineBlocksRemove ? SHORT_LINE_ONLY_LINE_NOTE : null };
}
