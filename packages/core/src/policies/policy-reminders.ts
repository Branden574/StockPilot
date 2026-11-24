/**
 * Policy sign-off: when a member who has not acknowledged a policy is
 * reminded. The database's claim (migration 0482,
 * org_policy_reminders_claim) applies the same numbers;
 * policy-text.parity.test.ts reads them out of the migration.
 *
 * AUTOMATIC REMINDERS. A member owes an acknowledgement from the later of
 * the time the version that asks for it was published and the time they
 * joined the organization ("owed since"). Reminder n (1 to 6) is due
 * POLICY_REMINDER_DAYS[n - 1] days after that: 3 and 7 days, then weekly
 * (14, 21, 28, 35), at most 6. A reminder is also never sent within
 * POLICY_REMINDER_MIN_GAP_DAYS of the last reminder of any kind (automatic
 * or "Remind now"), so a late run or a manual reminder never makes two in a
 * row. A correction keeps the count (it asks nobody again); a new version
 * starts a new count.
 *
 * REMIND NOW. An admin may remind everyone who has not acknowledged a policy
 * at most once in POLICY_REMIND_NOW_EVERY_HOURS hours per policy. It does
 * not count toward the 6.
 *
 * PURE: the caller passes `now`.
 */

/** Days after "owed since" at which automatic reminder 1, 2, ... 6 is due. */
export const POLICY_REMINDER_DAYS = [3, 7, 14, 21, 28, 35] as const;
/** The most automatic reminders for one member and one version that asks. */
export const POLICY_REMINDER_MAX = POLICY_REMINDER_DAYS.length;
/** No automatic reminder within this many days of the last reminder of any kind. */
export const POLICY_REMINDER_MIN_GAP_DAYS = 3;
/** "Remind now": once per this many hours per policy. */
export const POLICY_REMIND_NOW_EVERY_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface PolicyReminderState {
  /** The later of the asking version's publish time and the member's joining time. */
  owedSince: Date;
  /** Automatic reminders already sent for this version (0 to 6). */
  sent: number;
  /** The last reminder of any kind (automatic or Remind now), or null. */
  lastRemindedAt: Date | null;
}

/**
 * When the next automatic reminder becomes due, or null when all 6 were sent.
 * A state with a count outside 0 to 6, or a time that is not a time, has none.
 */
export function nextPolicyReminderAt(state: PolicyReminderState): Date | null {
  const { owedSince, sent, lastRemindedAt } = state;
  if (!Number.isInteger(sent) || sent < 0 || sent >= POLICY_REMINDER_MAX) return null;
  const base = owedSince.getTime();
  if (!Number.isFinite(base)) return null;
  const bySchedule = base + POLICY_REMINDER_DAYS[sent]! * DAY_MS;
  if (lastRemindedAt === null) return new Date(bySchedule);
  const last = lastRemindedAt.getTime();
  if (!Number.isFinite(last)) return null;
  return new Date(Math.max(bySchedule, last + POLICY_REMINDER_MIN_GAP_DAYS * DAY_MS));
}

/** Whether an automatic reminder is due at `now` (the claim's rule). */
export function isPolicyReminderDue(state: PolicyReminderState, now: Date): boolean {
  const next = nextPolicyReminderAt(state);
  return next !== null && now.getTime() >= next.getTime();
}

/** When "Remind now" is next allowed for a policy, or null when it is allowed now. */
export function nextRemindNowAt(lastRemindNowAt: Date | null, now: Date): Date | null {
  if (lastRemindNowAt === null) return null;
  const next = lastRemindNowAt.getTime() + POLICY_REMIND_NOW_EVERY_HOURS * HOUR_MS;
  if (!Number.isFinite(next)) return null;
  return now.getTime() >= next ? null : new Date(next);
}
