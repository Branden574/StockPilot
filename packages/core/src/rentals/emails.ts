import { formatOrgDate, formatOrgDateTime } from '../time/org-timezone';

/**
 * THE RENTAL EMAILS, AS THE SCREENS DESCRIBE THEM.
 *
 * A rental with an email on file gets three emails
 * (apps/web/src/lib/email/rentals.ts):
 *   1. the checkout receipt, right after checkout;
 *   2. the return confirmation, when the rental is marked returned;
 *   3. ONE overdue reminder, from the daily sweep
 *      (apps/web/src/app/api/cron/rental-overdue), on its first run after the
 *      expected return passes, only while the rental is still out, and only for
 *      organizations whose own Rentals row in Settings > Modules is on (never
 *      the all-modules comp: automation that writes to outsiders follows the
 *      row, lib/modules/effective-modules.ts). `rentals.overdue_reminder_sent_at`
 *      (migration 0264) records it.
 * No email on file, no emails. There is NO reminder before the return date:
 * nothing here may say or imply one.
 *
 * WHY THIS FILE EXISTS. The rental detail and list pages (web and phone) say
 * which of these a borrower gets. Saying it from a loose copy of the sweep's
 * rule would drift the first time the sweep changed, and a page that promises
 * a reminder the sweep will not send is worse than no page. So the sweep and
 * the pages share ONE set of checks, here:
 *   - rentalEmailOnFile: the address the emails go to, or none. The email
 *     dispatcher skips on exactly this.
 *   - isOverdueReminderCandidate: the sweep's per-rental rule. The cron's query
 *     filters on the same three columns and re-checks every row it read with
 *     this function before claiming it.
 *   - overdueRemindersOn: the sweep's per-organization rule, applied to the
 *     explicit organization_modules row.
 *   - RENTAL_OVERDUE_SWEEP.utcHour: when the sweep runs. A web test pins it
 *     against apps/web/vercel.json.
 *
 * WHAT IS AND IS NOT RECORDED. Only the overdue reminder leaves a timestamp.
 * The receipt and the return confirmation are sent in the moment and not
 * logged anywhere, so the pages describe their RULE and never claim a send.
 * `overdue_reminder_sent_at` is stamped by the sweep just before its send (it
 * claims the row first so two runs cannot both email), for every overdue
 * rental it picks up, including ones with no email, whose send then skips. A
 * send that did not go out (Resend refused it or could not be reached) gives
 * the stamp back, and the next run tries again, so a stamp with an email on
 * file means the reminder was handed to the email service. The one exception
 * is a run that dies between the claim and the send (see the cron's header).
 * "Sent" is read only together with an email on file: a stamped rental with no
 * email was never emailed. (The app has no way to add an email to a rental
 * after checkout, so an address on file now is the address the sweep saw.)
 */

/** The daily overdue sweep: apps/web/vercel.json runs it at "0 15 * * *". */
export const RENTAL_OVERDUE_SWEEP = {
  /** The hour, in UTC, the daily run starts (8:00 AM Pacific daylight time). */
  utcHour: 15,
  /** The organization_modules row the sweep follows, explicitly enabled. */
  moduleId: 'rentals',
  /** The only status the sweep considers: still out. */
  status: 'out',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The address the rental emails go to, or null when there is none. Blank or
 * whitespace-only counts as none, exactly as the email dispatcher reads it.
 */
export function rentalEmailOnFile(email: string | null | undefined): string | null {
  const trimmed = typeof email === 'string' ? email.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The sweep's organization rule, applied to the organization's explicit
 * `organization_modules` row for rentals: on only when that row says enabled.
 * A missing row is off. The comp is deliberately not an input.
 */
export function overdueRemindersOn(
  row: { enabled?: boolean | null } | null | undefined,
): boolean {
  return row?.enabled === true;
}

/** The columns the sweep decides on. */
export interface OverdueSweepRow {
  status: string;
  expected_return_at: string;
  overdue_reminder_sent_at: string | null;
}

/**
 * The sweep's rental rule: still out, not yet reminded, and past its expected
 * return at `nowMs`. The cron's query filters on these three columns; this is
 * the same rule in code, and the cron applies it to every row it read.
 */
export function isOverdueReminderCandidate(row: OverdueSweepRow, nowMs: number): boolean {
  if (row.status !== RENTAL_OVERDUE_SWEEP.status) return false;
  if (row.overdue_reminder_sent_at != null) return false;
  const due = Date.parse(row.expected_return_at);
  return Number.isFinite(due) && due < nowMs;
}

/**
 * The first daily run at or after `fromMs`. A run at 15:00 UTC reads every
 * rental due before the moment it runs, so a rental due at exactly 15:00 is
 * picked up by that same run.
 */
export function nextOverdueSweepAt(fromMs: number): Date {
  const from = new Date(fromMs);
  const sameDay = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    RENTAL_OVERDUE_SWEEP.utcHour,
    0,
    0,
    0,
  );
  return new Date(sameDay >= fromMs ? sameDay : sameDay + DAY_MS);
}

/** What the page knows about one rental. Column names as stored. */
export interface RentalEmailFacts {
  status: string;
  expected_return_at: string;
  returned_at: string | null;
  borrower_email: string | null;
  overdue_reminder_sent_at: string | null;
}

/**
 * Where one rental's overdue reminder stands.
 *
 *   no_email        nothing is ever sent (checked first: a stamp without an
 *                   email is not a send, see the file header)
 *   sent            the sweep reminded this rental at `sentAt`
 *   returned_on_time / closed_before_reminder
 *                   the rental left 'out' without a reminder, so none will go
 *   reminders_off   the organization's Rentals row is off: the sweep never
 *                   reads its rentals
 *   unknown         that row could not be read: say so, never guess
 *   scheduled       not overdue yet: the first run after the expected return
 *                   (`at`) sends it if the rental is still out
 *   due             overdue and not yet reminded: the next run (`at`) sends it
 *                   if the rental is still out
 */
export type OverdueReminderState =
  | { kind: 'no_email' }
  | { kind: 'sent'; sentAt: string }
  | { kind: 'returned_on_time' }
  | { kind: 'closed_before_reminder'; status: 'returned' | 'cancelled' }
  | { kind: 'reminders_off' }
  | { kind: 'unknown' }
  | { kind: 'scheduled'; at: Date }
  | { kind: 'due'; at: Date };

/**
 * `remindersOn` is overdueRemindersOn() of the organization's row, or null
 * when the row could not be read.
 */
export function overdueReminderState(
  rental: RentalEmailFacts,
  remindersOn: boolean | null,
  nowMs: number,
): OverdueReminderState {
  if (rentalEmailOnFile(rental.borrower_email) === null) return { kind: 'no_email' };
  if (rental.overdue_reminder_sent_at) {
    return { kind: 'sent', sentAt: rental.overdue_reminder_sent_at };
  }
  if (rental.status !== RENTAL_OVERDUE_SWEEP.status) {
    if (rental.status === 'returned') {
      const due = Date.parse(rental.expected_return_at);
      const back = rental.returned_at ? Date.parse(rental.returned_at) : NaN;
      if (Number.isFinite(due) && Number.isFinite(back) && back <= due) {
        return { kind: 'returned_on_time' };
      }
      return { kind: 'closed_before_reminder', status: 'returned' };
    }
    return { kind: 'closed_before_reminder', status: 'cancelled' };
  }
  if (remindersOn === null) return { kind: 'unknown' };
  if (!remindersOn) return { kind: 'reminders_off' };
  if (isOverdueReminderCandidate(rental, nowMs)) {
    return { kind: 'due', at: nextOverdueSweepAt(nowMs) };
  }
  const due = Date.parse(rental.expected_return_at);
  if (!Number.isFinite(due)) return { kind: 'unknown' };
  return { kind: 'scheduled', at: nextOverdueSweepAt(due) };
}

// ─── Copy (web and phone say the same words) ──────────────────────────────

export const RENTAL_BORROWER_TEAM_MEMBER = 'Team member';

/**
 * A rental whose borrower_user_id is null. That column says only that the
 * rental is not tied to an account, not that the person has none: every phone
 * checkout before 2026-09-25 was a typed name (the phone had no member
 * search), and the web picker has always let a typed name through, so many of
 * these borrowers are co-workers. "Not in StockPilot" would be false about
 * them. The New rental forms still offer "Someone not in StockPilot": there
 * the operator is the one saying it.
 */
export const RENTAL_BORROWER_NOT_LINKED = 'Not linked to a StockPilot account';

/** In place of the email when there is none. */
export const RENTAL_NO_EMAIL_NOTE =
  'No email on file: this borrower gets no receipt or reminders.';

/** Under the email of a borrower without an account (lib/email/rentals.ts: viewUrl). */
export const RENTAL_NON_MEMBER_EMAIL_NOTE =
  'They get the same emails as a team member, without a link into StockPilot.';

/** Under the emails list: what the dates on it do and do not prove. */
export const RENTAL_EMAILS_RECORD_NOTE =
  'Only the overdue reminder is recorded. The receipt and the return confirmation go out at checkout and at return, and have no record to show here.';

/**
 *   recorded  sent, with the time it was recorded (the overdue reminder only)
 *   rule      goes out at that moment by rule; nothing records the send
 *   upcoming  has not gone out yet and will, if nothing changes
 *   none      will not go out
 *   warn      off by a setting, or could not be checked
 */
export type RentalEmailTone = 'recorded' | 'rule' | 'upcoming' | 'none' | 'warn';

export interface RentalEmailLine {
  key: 'checkout' | 'returned' | 'overdue';
  label: string;
  detail: string;
  tone: RentalEmailTone;
}

const DAY_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DAY_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/**
 * Formats in the organization's zone when the caller has it (the web pages),
 * else in the device's zone (the phone, the same fallback the Exceptions
 * screens use).
 */
function fmt(
  input: Date | string,
  opts: Intl.DateTimeFormatOptions,
  timeZone: string | null | undefined,
  kind: 'date' | 'dateTime' | 'time',
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  if (timeZone) {
    return kind === 'date' ? formatOrgDate(d, opts, timeZone) : formatOrgDateTime(d, opts, timeZone);
  }
  return kind === 'date'
    ? d.toLocaleDateString('en-US', opts)
    : d.toLocaleString('en-US', opts);
}

/** "Sep 27, around 8:00 AM": when a run starts. */
function runLabel(at: Date, timeZone: string | null | undefined): string {
  return `${fmt(at, DAY_OPTIONS, timeZone, 'date')}, around ${fmt(at, TIME_OPTIONS, timeZone, 'time')}`;
}

/** The detail line for the overdue reminder. */
export function overdueReminderText(
  state: OverdueReminderState,
  timeZone?: string | null,
): string {
  switch (state.kind) {
    case 'no_email':
      return 'Not sent: no email on file.';
    case 'sent':
      return `Sent ${fmt(state.sentAt, DAY_TIME_OPTIONS, timeZone, 'dateTime')}.`;
    case 'returned_on_time':
      return 'Not needed: returned on time.';
    case 'closed_before_reminder':
      return state.status === 'returned'
        ? 'Not sent: returned before a reminder went out.'
        : 'Not sent: the rental was cancelled.';
    case 'reminders_off':
      return 'Not sent: overdue reminders are off for this organization. They go out only while Rentals is switched on in Settings > Modules.';
    case 'unknown':
      return 'Could not check whether overdue reminders are on for this organization.';
    case 'scheduled':
      return `Will be sent ${runLabel(state.at, timeZone)}, if the rental is still out then.`;
    case 'due':
      return `Overdue: will be sent with the next daily run, ${runLabel(state.at, timeZone)}, if the rental is still out.`;
  }
}

function overdueTone(state: OverdueReminderState): RentalEmailTone {
  switch (state.kind) {
    case 'sent':
      return 'recorded';
    case 'scheduled':
    case 'due':
      return 'upcoming';
    case 'unknown':
    case 'reminders_off':
      return 'warn';
    default:
      return 'none';
  }
}

/**
 * The three emails for one rental, in the order they go out. The receipt and
 * the confirmation describe the rule (see the file header: they are not
 * recorded); the reminder carries its real state.
 */
export function rentalEmailLines(
  rental: RentalEmailFacts,
  remindersOn: boolean | null,
  nowMs: number,
  timeZone?: string | null,
): RentalEmailLine[] {
  const hasEmail = rentalEmailOnFile(rental.borrower_email) !== null;
  const state = overdueReminderState(rental, remindersOn, nowMs);
  return [
    {
      key: 'checkout',
      label: 'Checkout receipt',
      detail: hasEmail ? 'Goes out at checkout.' : 'Not sent: no email on file.',
      tone: hasEmail ? 'rule' : 'none',
    },
    {
      key: 'returned',
      label: 'Return confirmation',
      detail: !hasEmail
        ? 'Not sent: no email on file.'
        : rental.status === 'cancelled'
          ? 'Not sent: a cancelled rental gets no return confirmation.'
          : rental.status === 'returned'
            ? 'Goes out when the rental is marked returned.'
            : 'Will go out when the rental is marked returned.',
      tone:
        !hasEmail || rental.status === 'cancelled'
          ? 'none'
          : rental.status === 'returned'
            ? 'rule'
            : 'upcoming',
    },
    {
      key: 'overdue',
      label: 'Overdue reminder',
      detail: overdueReminderText(state, timeZone),
      tone: overdueTone(state),
    },
  ];
}

/**
 * The small mark an OVERDUE row carries on the rentals lists, or null when
 * there is nothing true and short to say (the state is unknown).
 */
export function overdueReminderListMark(
  state: OverdueReminderState,
  timeZone?: string | null,
): string | null {
  switch (state.kind) {
    case 'sent':
      return `Reminder sent ${fmt(state.sentAt, DAY_OPTIONS, timeZone, 'date')}`;
    case 'no_email':
      return 'No email on file';
    case 'reminders_off':
      return 'Reminders off';
    case 'due':
      return `Reminder goes out ${fmt(state.at, DAY_OPTIONS, timeZone, 'date')}`;
    default:
      return null;
  }
}

/** Whether a rental shows as overdue on the lists: out and past due at `nowMs`. */
export function isRentalOverdue(
  rental: { status: string; expected_return_at: string },
  nowMs: number,
): boolean {
  const due = Date.parse(rental.expected_return_at);
  return rental.status === 'out' && Number.isFinite(due) && due < nowMs;
}
