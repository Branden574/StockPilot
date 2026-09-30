/**
 * CHANGING AN ORDER'S NEEDED-BY DATE (F2-4, migration 0383).
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
/** A needed-by later than this many years from now is refused
 *  (needed_by_out_of_range): no screen needs one, and the far end of a
 *  timestamp (infinity, year 290000) is past what JavaScript's Date holds. */
export const NEEDED_BY_MAX_YEARS_AHEAD = 5;

/**
 * Whether a needed-by is within reach: at most NEEDED_BY_MAX_YEARS_AHEAD years
 * after `now` (the function's `now() + interval '5 years'`), and a real
 * instant. The screens say NEEDED_BY_OUT_OF_RANGE_COPY before saving; the
 * server refuses it either way.
 */
export function isNeededByWithinReach(at: number, now: number): boolean {
  if (!Number.isFinite(at)) return false;
  const limit = new Date(now);
  limit.setUTCFullYear(limit.getUTCFullYear() + NEEDED_BY_MAX_YEARS_AHEAD);
  return at <= limit.getTime();
}
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

/**
 * The sentence above, as found in an event's description (0383 replaces the
 * first one, wherever it sits): any order handle, any date text with no period,
 * on one line. It also finds the older numeric format ("Needed by 9/11/2026,
 * 2:00:00 AM.", before SP-043). A regular-expression SOURCE that means the
 * same in JavaScript and in Postgres, and appears verbatim in 0383 (the web
 * guard test order-schedule-details.guard.test.ts checks it).
 */
export const ORDER_SCHEDULE_SENTENCE_PATTERN = 'Auto-created from order [^.\\n]*\\. Needed by [^.\\n]*\\.';

/**
 * What revise_order_needed_by accepts as p_event_details: exactly the sentence
 * orderScheduleEventDetails writes (an SO- number or the 8-character id
 * prefix, a date of at most 64 characters). Any other text is ignored, so no
 * caller can put free text in an event's description or its reminder emails.
 * Verbatim in 0383 too.
 */
export const ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN =
  '^Auto-created from order (SO-[0-9]{6,}|[0-9A-F]{8})\\. Needed by [^.]{1,64}\\.$';

const ORDER_SCHEDULE_SENTENCE = new RegExp(ORDER_SCHEDULE_SENTENCE_PATTERN);

/**
 * An event's description with its date sentence replaced by `sentence`, the
 * rule 0383 applies when it moves an event, for the server's own move of an
 * event written outside the order's lock: the first sentence of that shape is
 * replaced where it sits and whatever a person wrote around it stays; a
 * description with no such sentence (rewritten by hand) is kept whole; an
 * empty one gets the sentence.
 */
export function withOrderScheduleSentence(details: string | null | undefined, sentence: string): string {
  if (!details || details.trim() === '') return sentence;
  const m = ORDER_SCHEDULE_SENTENCE.exec(details);
  if (!m) return details;
  return details.slice(0, m.index) + sentence + details.slice(m.index + m[0].length);
}

// ── The answer ──────────────────────────────────────────────────────────────

/** revise_order_needed_by's answer (0383). Times are ISO instants. */
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
  /** That entry's status (scheduled, in_progress, completed, cancelled), or
   *  null when the order has none. Only a scheduled entry gets reminders. */
  eventStatus: string | null;
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
  const { changed, previous, neededBy, eventId, eventUpdated, eventStatus, status } = raw;
  if (eventId !== null && (typeof eventId !== 'string' || eventId.trim() === '')) {
    throw new NeededByResultShapeError('eventId is not an id');
  }
  if (eventStatus !== undefined && eventStatus !== null && typeof eventStatus !== 'string') {
    throw new NeededByResultShapeError('eventStatus is not a status');
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
    eventStatus: typeof eventStatus === 'string' && eventStatus !== '' ? eventStatus : null,
    status,
  };
}

/**
 * What happened to the order's Schedule entry, as the screens say it:
 *   - `moved`: the entry moved with the order (reminders armed again when it
 *     is scheduled: `eventStatus`);
 *   - `created`: the order was past approval with no entry, so one was added
 *     (also on an unchanged save, which adds a missing entry);
 *   - `none_yet`: a pending order; approving it adds the entry;
 *   - `left_closed`: the entry is completed or cancelled and stays as it is
 *     (or the order closed meanwhile, which closed the entry just added);
 *   - `not_added`: the order has no entry and adding one failed (reported);
 *     saving the same date again tries again;
 *   - `not_moved`: the entry may not match the order (left at another date,
 *     not confirmed closed with a closed order, or not readable; reported);
 *     the order moved;
 *   - `unchanged`: the date was already this value; nothing was written.
 */
export type NeededBySchedule =
  | 'moved'
  | 'created'
  | 'none_yet'
  | 'left_closed'
  | 'not_added'
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
  | 'needed_by_out_of_range'
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
export const NEEDED_BY_OUT_OF_RANGE_COPY = `Pick a needed-by date within the next ${NEEDED_BY_MAX_YEARS_AHEAD} years.`;
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
 *  what the screen expected). The reminders are claimed only for an entry the
 *  reminder cron reminds (a scheduled one). */
export function neededByRevisedCopy(outcome: NeededByRevisionOutcome, now?: number | Date): string {
  const when = neededByLabel(outcome.neededBy, outcome.timeZone, now);
  const head = outcome.changed ? `Needed-by changed to ${when}.` : `The needed-by date is already ${when}.`;
  switch (outcome.schedule) {
    case 'unchanged':
      return `${head} Nothing changed.`;
    case 'moved':
      return outcome.eventStatus === 'scheduled'
        ? `${head} The Schedule entry moved too, and its reminders are set for the new time.`
        : `${head} The Schedule entry moved too.`;
    case 'created':
      return `${head} It's on the Schedule now.`;
    case 'none_yet':
      return `${head} Approving the order puts it on the Schedule.`;
    case 'left_closed':
      return `${head} The Schedule entry is completed or cancelled, so it stays as it is.`;
    case 'not_added':
      return `${head} Its Schedule entry couldn't be added just now; save the same date again to add it.`;
    case 'not_moved':
      return `${head} The Schedule entry may not match the order; check it on the Schedule.`;
  }
}

// ── The change itself: its entry, its dialog (web) and its sheet (phone) ────
//
// Added with the web dialog (F2-4 UI step), so the phone sheet says the same
// words: the entry beside the date, the title, the two fields and what saving
// does, said before saving. What happened AFTER saving is neededByRevisedCopy
// (from the server's answer, never from what the screen expected).

/** The entry beside the needed-by date that opens the change. */
export const NEEDED_BY_CHANGE_LABEL = 'Change';
/** Its accessible name (screen readers, VoiceOver). It starts with the
 *  visible word, so speech input ("click Change") still finds it. */
export const NEEDED_BY_CHANGE_ACCESSIBILITY_LABEL = 'Change needed-by date';
/** The web dialog's and the phone sheet's title. */
export const NEEDED_BY_REVISE_TITLE = 'Change needed-by date';
/** The date and time field (entered in the org's zone: neededByZoneNote). */
export const NEEDED_BY_FIELD_LABEL = 'New needed-by date and time';
/** The reason field, and the hint under it. */
export const NEEDED_BY_REASON_LABEL = 'Reason';
export const NEEDED_BY_REASON_HINT = `Kept in the order's history. Up to ${NEEDED_BY_REASON_MAX} characters.`;
/** The button that saves the change. */
export const NEEDED_BY_SAVE_LABEL = 'Save date';

/**
 * The row the entry sits on: "Needed by Fri, Oct 3, 2:00 PM" in the org's
 * zone, or "No needed-by date" for an order that has none (an approver can
 * set one).
 */
export function neededByRowCopy(
  neededBy: string | null | undefined,
  timeZone: string,
  now?: number | Date,
): string {
  if (!neededBy || !Number.isFinite(Date.parse(neededBy))) return 'No needed-by date';
  return `Needed by ${neededByLabel(neededBy, timeZone, now)}`;
}

/**
 * In the dialog and the sheet, the date being replaced: "Current needed-by:
 * Fri, Oct 3, 2:00 PM". After a stale refusal it is the date someone else
 * saved, which is what the next save replaces.
 */
export function neededByCurrentCopy(
  current: string | null | undefined,
  timeZone: string,
  now?: number | Date,
): string {
  if (!current || !Number.isFinite(Date.parse(current))) return 'This order has no needed-by date yet.';
  return `Current needed-by: ${neededByLabel(current, timeZone, now)}`;
}

/**
 * What saving does to the order's Schedule entry, said before saving (the
 * screens do not know the entry's status yet, so it says both cases). Past
 * approval an open entry follows the new date (or one is added, when the
 * order had no date when it was approved); a completed or cancelled entry
 * stays; only an entry that has not started is reminded. A pending order has
 * none until it is approved. The confirmation after saving says what
 * actually happened.
 */
export function neededByEffectCopy(status: string | null | undefined): string {
  return orderBelongsOnSchedule(status)
    ? "The order's Schedule entry moves to the new date unless it's completed or cancelled. If it hasn't started, its reminders are set for the new time."
    : 'Approving the order puts it on the Schedule at this date.';
}

/** The save never answered (the connection dropped, the page was replaced):
 *  it may have been saved or not, so the person looks before trying again. */
export const NEEDED_BY_NO_ANSWER_COPY =
  "No answer came back, so the date may or may not have changed. Check the order's needed-by date before trying again.";

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
