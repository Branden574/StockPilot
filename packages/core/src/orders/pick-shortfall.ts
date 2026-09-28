import type { OrderStatus } from '../order-state-machine';

/**
 * "Units nobody has pulled yet" — the derived signal behind the SO-000061
 * defect (2026-07-22).
 *
 * WHAT HAPPENED: an order for 40 was picked in full (quantity_picked = 40),
 * the packing slip was printed, and a manager then RAISED the line to 42.
 * Nothing said the extra 2 now had to come off a shelf. The shortfall only
 * became visible at hand-over, when confirm_physical_signature did
 * `quantity_fulfilled += quantity_picked`, found 42 - 40 = 2 still owed, and
 * flipped the order to `backordered`. The accounting was right the whole way
 * through; the COMMUNICATION arrived hours late.
 *
 * Everything here is DERIVED. No column backs it, none is needed, and none of
 * the fulfilment RPCs change: raising a line after picking is a legitimate act
 * and stays allowed. This module only lets the UI say so at the moment it
 * happens.
 *
 * Shared rather than duplicated per platform because the exact same sentence
 * has to appear on web and on the phone — two copies of this arithmetic would
 * drift, and the drift a user feels is one device warning about a shortfall
 * the other one is silent about.
 */

/**
 * Statuses at which an un-picked remainder is a real, actionable shortfall.
 *
 * Chosen by reading the state machine (`ALLOWED_TRANSITIONS` above, mirrored by
 * the Postgres trigger `_validate_order_request_status_transition` — latest
 * body in migration 0243) rather than guessed. The rule is "picking is
 * FINISHED, and the order has not CLOSED":
 *
 *  • Excluded, picking has not finished — `pending_confirmation`,
 *    `pending_approval`, `approved`, `pick_slip_generated`,
 *    `picking_in_progress`. Raising a quantity here is free: the slip has not
 *    been worked yet (or the picker is still on the floor and will pull the new
 *    number), so `requested - fulfilled - picked` is just "the work that has
 *    not happened yet", which is the normal state of a live order and not
 *    something to warn anybody about.
 *  • Included, picking is done and the order is still moving —
 *    `picking_complete`, `packing_slip_generated`, `staged_for_pickup`,
 *    `staged_for_delivery`, `in_transit`. This is the SO-000061 window: nobody
 *    is going back to the shelf unless someone is told to.
 *  • EXCLUDED, and still open — `backordered`. Picking is done and the order is
 *    open, so it looks like it belongs, but there the shortfall EQUALS what the
 *    order already owes: the notice would fire on every backordered order and
 *    restate the number its own banner exists to show. See the constant.
 *  • Excluded, closed — `completed`, `denied`, `cancelled`. Terminal in the
 *    state machine (empty transition arrays); there is no picking left to ask
 *    for, so a prompt would sit there forever asking for the impossible. This
 *    matches how the pick-slip-staleness banner is gated on the order detail.
 */
export const PICKING_SETTLED_STATUSES: readonly OrderStatus[] = [
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
];

/**
 * `backordered` is deliberately NOT here, even though picking is finished and
 * the order is open.
 *
 * At that status the unpicked shortfall is arithmetically identical to what the
 * order already OWES, so the notice would fire on 100% of backordered orders and
 * restate — inside the "Backordered — awaiting stock" banner — the very number
 * that banner exists to show. Being owed stock you do not have is the definition
 * of backordered, not an anomaly worth a second warning.
 */

/** Whether picking on this order is finished (or past) and the order is open. */
export function isPickingSettled(status: OrderStatus | string | null | undefined): boolean {
  return PICKING_SETTLED_STATUSES.includes(status as OrderStatus);
}

/**
 * The three line columns the arithmetic reads. All nullable because
 * `quantity_picked` is NULL until a picker stages anything and `quantity_fulfilled`
 * defaults to 0 but is read through joins that can hand back null.
 */
export interface ShortfallLine {
  /** order_request_lines.quantity_requested. */
  quantityRequested: number | null | undefined;
  /** quantity_fulfilled — units physically HANDED OVER. */
  quantityFulfilled: number | null | undefined;
  /** quantity_picked — units STAGED by a picker, not yet handed over. */
  quantityPicked: number | null | undefined;
}

function n(v: number | null | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Units on this line that are neither already handed over nor currently
 * staged — i.e. what somebody still has to physically pull.
 *
 *   shortfall = max(0, requested - fulfilled - picked)
 *
 * Clamped at zero so an over-pick (a picker staged more than the line asks
 * for, which the receiving side allows) reads as "nothing left to pull"
 * rather than a negative that would render as a nonsense count.
 *
 * Status-blind on purpose: this is the raw arithmetic. Use
 * `unpickedShortfall` when you want the number only where it MEANS something.
 */
export function lineUnpickedUnits(line: ShortfallLine): number {
  return Math.max(0, n(line.quantityRequested) - n(line.quantityFulfilled) - n(line.quantityPicked));
}

/**
 * Units this line still OWES: requested minus already handed over.
 *
 *   owed = max(0, requested - fulfilled)
 *
 * The one definition (pattern #26). The fulfilment RPCs compute the same
 * number in SQL (`greatest(quantity_requested - quantity_fulfilled, 0)`:
 * resume_fulfillment, complete_picking), and every TypeScript copy goes
 * through here: the hold re-sync after a line edit or removal, the pick-error
 * sentence, and readiness (core readiness.ts). Clamped at zero per line, so an
 * over-receipt on one line (fulfilled above requested) never eats into a
 * sibling line's share when owed is summed per item.
 *
 * Picking is not subtracted: picked units are staged, not yet handed over, so
 * they are still owed. `lineUnpickedUnits` is the "still to pull" number.
 */
export function lineOwedUnits(
  line: Pick<ShortfallLine, 'quantityRequested' | 'quantityFulfilled'>,
): number {
  return Math.max(0, n(line.quantityRequested) - n(line.quantityFulfilled));
}

/**
 * The order-level shortfall: un-picked units summed across lines, but ONLY at
 * a status where picking is settled (see PICKING_SETTLED_STATUSES). Returns 0
 * everywhere else, so a caller can render on `> 0` without repeating the gate.
 */
export function unpickedShortfall(
  lines: readonly ShortfallLine[],
  status: OrderStatus | string | null | undefined,
): number {
  if (!isPickingSettled(status)) return 0;
  return lines.reduce((sum, l) => sum + lineUnpickedUnits(l), 0);
}

/**
 * What the shortfall WOULD be on one line if its requested quantity were
 * changed to `nextRequested` — the edit-time projection. Same gate, same
 * clamp, so a raise before picking projects 0 and stays silent.
 */
export function projectedLineShortfall(
  line: ShortfallLine,
  nextRequested: number,
  status: OrderStatus | string | null | undefined,
): number {
  if (!isPickingSettled(status)) return 0;
  return lineUnpickedUnits({ ...line, quantityRequested: nextRequested });
}

function units(count: number): string {
  return count === 1 ? '1 unit' : `${count} units`;
}

/**
 * The sentence shown BEFORE a line-quantity edit is committed, or null when
 * the edit needs no warning.
 *
 * Fires only on a RAISE at a settled status. Lowering never fires (it removes
 * work, and the service's own floors already guard the cases that matter), and
 * neither does a raise before picking has finished — the common case must not
 * pick up new friction.
 *
 * Two shapes, because the honest number differs. When the line was fully
 * picked, the units added ARE the shortfall and one number tells the whole
 * story. When the line was already short, the addition and the resulting
 * shortfall are different numbers and quoting only the first would understate
 * what the picker has to pull.
 */
export function describeRaiseAfterPicking(input: {
  line: ShortfallLine;
  nextRequested: number;
  status: OrderStatus | string | null | undefined;
}): string | null {
  const { line, nextRequested, status } = input;
  if (!isPickingSettled(status)) return null;
  const prior = n(line.quantityRequested);
  const added = nextRequested - prior;
  if (!Number.isFinite(added) || added <= 0) return null;
  const projected = projectedLineShortfall(line, nextRequested, status);
  if (projected <= 0) return null;
  if (projected === added) {
    return `Picking is already complete. Adding ${added} more will leave this order short until ${added === 1 ? 'it is' : 'they are'} picked.`;
  }
  return `Picking is already complete. Adding ${added} more leaves this order short by ${units(projected)} until ${projected === 1 ? 'it is' : 'they are'} picked.`;
}

/**
 * The standing notice on the order itself, or null when the order is healthy.
 *
 * Names the count and the two things that actually have to happen — reprint
 * the slip, pull the units — because the failure mode this replaces was
 * everyone believing the order was ready to hand over.
 */
export function describeUnpickedShortfall(
  lines: readonly ShortfallLine[],
  status: OrderStatus | string | null | undefined,
): string | null {
  const short = unpickedShortfall(lines, status);
  if (short <= 0) return null;
  const verb = short === 1 ? 'has' : 'have';
  // Deliberately states the CONSEQUENCE, not an action.
  //
  // The first draft said "Generate the pick slip again". That is impossible at
  // five of the six statuses this fires at — including packing_slip_generated,
  // the exact status of the order that motivated this feature — because
  // generatePickSlip requires status 'approved'. Telling someone to do
  // something the system will refuse is worse than telling them nothing.
  //
  // It is also cause-agnostic on purpose: this number cannot tell a
  // quantity raised after picking from a pick that came up short because stock
  // ran out. Both leave real units unpulled, and both end the same way, so the
  // sentence describes the outcome rather than guessing at the cause.
  return `${units(short)} on this order ${verb} not been picked, and will be reported as owed when it is handed over.`;
}

/** Short headline for the same notice (banner label / sheet eyebrow). */
export const UNPICKED_SHORTFALL_TITLE = 'Not everything is picked';

// ── Before the order leaves (F2-2) ──────────────────────────────────────────

/**
 * The step about to take the order further from the shelf: staging it for
 * pickup or delivery, sending it out for delivery, or recording the signature
 * that hands it over (digital or on paper).
 */
export type DepartureAction = 'stage' | 'in_transit' | 'signature';

/** A line as the departure confirm reads it: the shortfall columns and the
 *  item's name (the line id lets a screen focus it). */
export interface DepartureLine extends ShortfallLine {
  lineId?: string | null;
  itemName?: string | null;
}

export interface DepartureRiskLine {
  lineId: string | null;
  itemName: string;
  /** Units picked for the order's current batch (quantity_picked). */
  picked: number;
  /** lineOwedUnits: requested less handed over. */
  owed: number;
  /** lineUnpickedUnits: what nobody has pulled. */
  unpicked: number;
}

export interface DepartureRisk {
  title: string;
  /** "1 line is short: 0 of 60 Pens. <what happens next>" */
  message: string;
  lines: DepartureRiskLine[];
  /** unpickedShortfall over the order. */
  unpickedUnits: number;
  /** The button that goes ahead ("Send it anyway", ...). */
  confirmLabel: string;
  /** The button that goes back to the order ("Fix the order", or "Go back"
   *  once its lines are final). */
  cancelLabel: string;
}

/** Lines listed by name before the rest are counted. */
const DEPARTURE_LINES_LISTED = 5;

function qty(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** The lines are editable until the order is out for delivery
 *  (OrderRequestsService.loadEditableOrderHeader refuses at in_transit). */
function linesAreFinal(status: OrderStatus | string | null | undefined): boolean {
  return status === 'in_transit';
}

/** The lines with units nobody picked, in the order's line order. */
function unpickedLines(lines: readonly DepartureLine[]): DepartureRiskLine[] {
  return lines
    .map((l) => ({
      lineId: l.lineId ?? null,
      itemName: l.itemName?.trim() || 'An item',
      picked: n(l.quantityPicked),
      owed: lineOwedUnits(l),
      unpicked: lineUnpickedUnits(l),
    }))
    .filter((l) => l.unpicked > 0);
}

/** "1 line is short: 0 of 60 Pens." / "7 lines are short: ...; and 2 more
 *  lines.": the first five by name (picked of owed), then counted. */
function describeShortLinesHead(short: readonly DepartureRiskLine[]): string {
  const listed = short
    .slice(0, DEPARTURE_LINES_LISTED)
    .map((l) => `${qty(l.picked)} of ${qty(l.owed)} ${l.itemName}`)
    .join('; ');
  const more = short.length - DEPARTURE_LINES_LISTED;
  return (
    `${short.length === 1 ? '1 line is' : `${short.length} lines are`} short: ${listed}` +
    (more > 0 ? `; and ${more} more ${more === 1 ? 'line' : 'lines'}.` : '.')
  );
}

/**
 * What happens to the units nobody picked once the order is out for delivery.
 * Both "lines are final" notes end with it: the line's own
 * (SHORT_LINE_FINAL_NOTE, on the web row) and the order's
 * (describeFinalShortLines, on the phone's order card).
 */
export const FINAL_SHORT_LINES_OWED_COPY =
  'The units not picked will be owed at hand-over; Close partial ends the order afterwards if they will not be sent.';

/**
 * The confirm before an order with an unpicked shortfall is staged, sent out
 * for delivery or signed for (F2 decision D17). Null when nothing is short:
 * built on describeUnpickedShortfall, so it speaks exactly where the order's
 * standing notice does (a settled pick, the order still open) and is silent
 * everywhere else, including at a shortfall of 0.
 *
 * UI only: the server stays permissive, because shipping short is legitimate
 * (the backorder model). The confirm names the short lines; fixing one is a
 * tap on the line itself (Remove, or Lower to what was picked).
 */
export function describeDepartureRisk(input: {
  lines: readonly DepartureLine[];
  status: OrderStatus | string | null | undefined;
  action: DepartureAction;
}): DepartureRisk | null {
  const { lines, status, action } = input;
  if (describeUnpickedShortfall(lines, status) === null) return null;
  const short = unpickedLines(lines);
  const head = describeShortLinesHead(short);

  const final = linesAreFinal(status);
  let next: string;
  let confirmLabel: string;
  if (action === 'in_transit') {
    next = "Once the order is out for delivery its lines can't be changed, and these units will be owed at hand-over.";
    confirmLabel = 'Send it anyway';
  } else if (action === 'stage') {
    next = 'If it leaves like this, these units will be owed at hand-over. Its lines can still be changed until it is out for delivery.';
    confirmLabel = 'Stage it anyway';
  } else if (final) {
    next = "Its lines can't be changed now, so these units will be owed at hand-over. Close partial ends the order afterwards if they will not be sent.";
    confirmLabel = 'Record signature anyway';
  } else {
    next = 'The signature hands the order over, and these units will be owed.';
    confirmLabel = 'Record signature anyway';
  }
  return {
    title: UNPICKED_SHORTFALL_TITLE,
    message: `${head} ${next}`,
    lines: short,
    unpickedUnits: unpickedShortfall(lines, status),
    confirmLabel,
    cancelLabel: final ? 'Go back' : 'Fix the order',
  };
}

/**
 * The order-level note once the order is out for delivery and a line is not
 * fully picked (F2-2 walk F1, 2026-09-28), or null. The lines can no longer be
 * changed (the line sheet does not open), so the note names the short lines
 * itself, in the departure confirm's words: the line's own note ("so this
 * line can't be changed", SHORT_LINE_FINAL_NOTE) belongs on a row, and on the
 * phone's order card "this line" pointed at nothing.
 *
 *   "The order is out for delivery, so its lines can't be changed. 1 line is
 *    short: 0 of 5 Pens. The units not picked will be owed at hand-over; Close
 *    partial ends the order afterwards if they will not be sent."
 */
export function describeFinalShortLines(
  lines: readonly DepartureLine[],
  status: OrderStatus | string | null | undefined,
): string | null {
  if (!linesAreFinal(status) || describeUnpickedShortfall(lines, status) === null) return null;
  const short = unpickedLines(lines);
  if (short.length === 0) return null;
  return `The order is out for delivery, so its lines can't be changed. ${describeShortLinesHead(short)} ${FINAL_SHORT_LINES_OWED_COPY}`;
}
