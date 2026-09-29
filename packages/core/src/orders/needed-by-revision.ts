/**
 * CHANGING AN ORDER'S NEEDED-BY DATE (F2-4, migration 0382).
 *
 * An approver (a manager, or anyone holding orders:approve) with write access
 * to the order's warehouse can move the needed-by of any open order, with a
 * reason. The order's Schedule entry moves with it in the same transaction
 * (revise_order_needed_by): its start, its description ("Needed by …") and
 * its reminders, which are armed again for the new time. Nothing is emailed:
 * the requester's delivery-request draft is unchanged and opens only when
 * they tap it (it already carries the current needed-by).
 *
 * What lives here, shared by the web server and the phone:
 *   - which statuses may be revised, and which already have a Schedule entry;
 *   - the Schedule entry's description (`orderScheduleEventDetails`), the ONE
 *     text both the approval (autoScheduleFromOrder) and a revision write;
 *   - the function's answer and its parser;
 *   - every sentence a revision shows, identical on web and phone.
 *
 * Times are entered as a WALL CLOCK in the ORGANIZATION's zone (the web
 * datetime-local, the phone's day and time chips) and converted on the server
 * (../time/zoned-wall-clock.ts), never with the device's zone.
 *
 * Honest words: no percentages, never "guaranteed", and nothing claims an
 * email or a notification was sent.
 */

import type { OrderStatus } from '../order-state-machine';
import { formatOrgDateTime, resolveOrgTimezone } from '../time/org-timezone';
import { zonedParts } from '../time/zoned-wall-clock';
import { formatOrderNumber } from './order-number';

// ── Limits (the function refuses past them too) ─────────────────────────────

/** A reason is required: 1 to 500 characters after trimming. */
export const NEEDED_BY_REASON_MAX = 500;
/** The Schedule entry's description, at most 1000 characters. */
export const NEEDED_BY_EVENT_DETAILS_MAX = 1000;
/** The reason recorded when a manager applies the AI suggestion. */
export const NEEDED_BY_SUGGESTION_REASON = "Set from the requester's note";

// ── Statuses ────────────────────────────────────────────────────────────────

/**
 * Open orders, whose needed-by may change. Closed ones are refused
 * (order_closed): pending_confirmation (a public request not yet confirmed by
 * email), completed, denied and cancelled.
 */
export const NEEDED_BY_REVISABLE_STATUSES: readonly OrderStatus[] = [
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'backordered',
];

export function isNeededByRevisable(status: string | null | undefined): boolean {
  return (NEEDED_BY_REVISABLE_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * Whether an order at this status is past approval, so it belongs on the
 * Schedule. Approval creates the entry (autoScheduleFromOrder); a pending
 * order has none yet, and approving it adds one at the needed-by it has then.
 */
export function orderBelongsOnSchedule(status: string | null | undefined): boolean {
  return isNeededByRevisable(status) && status !== 'pending_approval';
}

// ── The Schedule entry's description ────────────────────────────────────────

/**
 * The description of an order's Schedule entry: "Auto-created from order
 * SO-000016. Needed by Oct 3, 2026, 2:00 PM." The date is printed in the
 * org's zone (SP-043: never the server's UTC), the same zone the Schedule page
 * and the reminder emails print the start in. The approval writes it when it
 * creates the entry, and a revision writes it when it moves the entry, so the
 * date in the text always matches the entry's start.
 */
export function orderScheduleEventDetails(
  order: { id: string; orderNumber: number | null | undefined; neededBy: string | number | Date },
  timeZone: string,
): string {
  const so = formatOrderNumber(order.orderNumber) ?? order.id.slice(0, 8).toUpperCase();
  const neededByDisplay = formatOrgDateTime(
    order.neededBy,
    { dateStyle: 'medium', timeStyle: 'short' },
    resolveOrgTimezone(timeZone),
  );
  return `Auto-created from order ${so}. Needed by ${neededByDisplay}.`;
}

// ── The answer ──────────────────────────────────────────────────────────────

/** revise_order_needed_by's answer (0382). Times are ISO instants. */
export interface NeededByRevisionResult {
  /** False when the new value equals the current one: nothing was written. */
  changed: boolean;
  /** The needed-by before this call (null when the order had none). */
  previous: string | null;
  /** The needed-by after this call. */
  neededBy: string;
  /** The order's Schedule entry, when it has one (any status). */
  eventId: string | null;
  /** Whether this call moved that entry (only a scheduled or in-progress one moves). */
  eventUpdated: boolean;
  /** The order's status, read under the order's lock. */
  status: string;
}

export class NeededByResultShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeededByResultShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function instant(v: unknown, where: string): string {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(t)) throw new NeededByResultShapeError(`${where} is not a time`);
  return new Date(t).toISOString();
}

function flag(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new NeededByResultShapeError(`${where} is not true or false`);
  return v;
}

/**
 * Reads revise_order_needed_by's answer. Throws NeededByResultShapeError on a
 * wrong shape (it never guesses), and tolerates keys it does not know, so a
 * later additive change never breaks an older phone.
 */
export function parseNeededByRevisionResult(raw: unknown): NeededByRevisionResult {
  if (!isRecord(raw)) throw new NeededByResultShapeError('the answer is not an object');
  const { changed, previous, neededBy, eventId, eventUpdated, status } = raw;
  if (eventId !== null && (typeof eventId !== 'string' || eventId.trim() === '')) {
    throw new NeededByResultShapeError('eventId is not an id');
  }
  if (typeof status !== 'string' || status.trim() === '') {
    throw new NeededByResultShapeError('status is missing');
  }
  return {
    changed: flag(changed, 'changed'),
    previous: previous === null ? null : instant(previous, 'previous'),
    neededBy: instant(neededBy, 'neededBy'),
    eventId: eventId as string | null,
    eventUpdated: flag(eventUpdated, 'eventUpdated'),
    status,
  };
}

/**
 * What happened to the order's Schedule entry, as the screens say it:
 *   - `moved`: the entry moved with the order, reminders armed again;
 *   - `created`: the order was past approval with no entry, so one was added;
 *   - `none_yet`: a pending order; approving it adds the entry;
 *   - `left_closed`: the entry is completed or cancelled and stays as it is;
 *   - `not_moved`: the entry could not be written (reported); the order moved;
 *   - `unchanged`: the date was already this value; nothing was written.
 */
export type NeededBySchedule =
  | 'moved'
  | 'created'
  | 'none_yet'
  | 'left_closed'
  | 'not_moved'
  | 'unchanged';

/** A revision's full outcome, as the web action and the phone route answer it. */
export interface NeededByRevisionOutcome extends NeededByRevisionResult {
  schedule: NeededBySchedule;
  /** The zone the wall clock was read in (the org's), for the confirmation. */
  timeZone: string;
}

/** The refusals a revision can meet, as the web action and the phone route
 *  carry them in `details.reason`. */
export type NeededByFailureReason =
  | 'needed_by_changed'
  | 'needed_by_in_past'
  | 'reason_required'
  | 'order_closed'
  | 'invalid_time'
  | 'forbidden'
  | 'not_found'
  | 'module_disabled'
  | 'busy'
  | 'timezone_unreadable'
  | 'not_pending'
  | 'failed';

// ── Words ───────────────────────────────────────────────────────────────────

/**
 * A needed-by as the screens print it, in the org's zone: "Fri, Oct 3, 2:00
 * PM", with the year when it is not the current year there ("Fri, Jan 8,
 * 2027, 9:00 AM").
 */
export function neededByLabel(
  at: string | number | Date,
  timeZone: string,
  now: number | Date = Date.now(),
): string {
  const zone = resolveOrgTimezone(timeZone);
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '—';
  const sameYear = zonedParts(t, zone).year === zonedParts(now, zone).year;
  return formatOrgDateTime(
    t,
    {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' as const }),
      hour: 'numeric',
      minute: '2-digit',
    },
    zone,
  );
}

/** Under the date field: "Times are in America/Los_Angeles." */
export function neededByZoneNote(timeZone: string): string {
  return `Times are in ${resolveOrgTimezone(timeZone)}.`;
}

/** The preview before saving: "New needed-by: Fri, Oct 3, 2:00 PM". */
export function neededByPreviewCopy(at: string | number | Date, timeZone: string, now?: number | Date): string {
  return `New needed-by: ${neededByLabel(at, timeZone, now)}`;
}

/** The timeline entry for order_request.needed_by_revised. */
export const NEEDED_BY_REVISED_TIMELINE_LABEL = 'Needed-by date changed';

export const NEEDED_BY_REASON_REQUIRED_COPY = `Say why the date is changing (up to ${NEEDED_BY_REASON_MAX} characters).`;
export const NEEDED_BY_IN_PAST_COPY = 'Pick a needed-by date and time that is still to come.';
export const NEEDED_BY_CLOSED_COPY =
  "This order is closed (completed, denied, cancelled or not yet confirmed), so its needed-by date can't change.";
export const NEEDED_BY_NOT_APPROVER_COPY = 'Changing the needed-by date needs permission to approve orders.';
export const NEEDED_BY_NO_WAREHOUSE_ACCESS_COPY =
  "Changing this order's needed-by date needs write access to its warehouse.";
export const NEEDED_BY_BUSY_COPY = 'Someone else is changing this order right now. Try again in a moment.';
export const NEEDED_BY_NOT_FOUND_COPY = 'Order not found.';
export const NEEDED_BY_MODULE_OFF_COPY = 'Orders are turned off for this organization.';
export const NEEDED_BY_FAILED_COPY = "The needed-by date couldn't be changed just now. Try again.";
export const NEEDED_BY_TIMEZONE_UNREADABLE_COPY =
  "Your organization's time zone couldn't be read, so the date wasn't changed. Try again.";
export const NEEDED_BY_NOT_PENDING_COPY =
  'This order is no longer waiting for approval. Change its needed-by date from the order page.';
export const NEEDED_BY_SIGN_IN_COPY = 'Sign in again to change the needed-by date.';
/** The needed-by the screen started from could not be read (a stale or
 *  damaged page): reload and start again. */
export const NEEDED_BY_RELOAD_COPY =
  "This order's needed-by date couldn't be read. Reload the order and try again.";

/** A date and time the server could not read, or one that does not exist in
 *  the org's zone (the spring-forward hour, Feb 30). */
export function neededByInvalidTimeCopy(timeZone: string): string {
  return `That date and time don't exist in ${resolveOrgTimezone(timeZone)}. Pick another time.`;
}

/**
 * The stale-version refusal: someone saved a different date while this person
 * was editing. The screens load the current value and show this.
 */
export function neededByChangedCopy(
  current: string | null,
  timeZone: string,
  now?: number | Date,
): string {
  if (!current) return 'Someone changed this date while you were editing. Check it and try again.';
  return `Someone changed this date to ${neededByLabel(current, timeZone, now)} while you were editing.`;
}

/** The confirmation after a revision, from what the server did (never from
 *  what the screen expected). */
export function neededByRevisedCopy(outcome: NeededByRevisionOutcome, now?: number | Date): string {
  const when = neededByLabel(outcome.neededBy, outcome.timeZone, now);
  switch (outcome.schedule) {
    case 'unchanged':
      return `The needed-by date is already ${when}. Nothing changed.`;
    case 'moved':
      return `Needed-by changed to ${when}. The Schedule entry moved too, and its reminders are set for the new time.`;
    case 'created':
      return `Needed-by changed to ${when}. It's on the Schedule now.`;
    case 'none_yet':
      return `Needed-by changed to ${when}. Approving the order puts it on the Schedule.`;
    case 'left_closed':
      return `Needed-by changed to ${when}. The Schedule entry is already completed or cancelled, so it was left as it was.`;
    case 'not_moved':
      return `Needed-by changed to ${when}. The Schedule entry couldn't be updated; check it on the Schedule.`;
  }
}

/** A reason as the function takes it: trimmed, 1 to 500 characters; null
 *  when empty or too long (the screens then show NEEDED_BY_REASON_REQUIRED_COPY). */
export function normalizeNeededByReason(raw: string | null | undefined): string | null {
  const reason = (raw ?? '').trim();
  // Counted in characters (code points), as the function's char_length
  // counts them, not in UTF-16 units: a character outside the BMP is one
  // character to both.
  const length = [...reason].length;
  if (length === 0 || length > NEEDED_BY_REASON_MAX) return null;
  return reason;
}
