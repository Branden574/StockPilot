import { describe, expect, it } from 'vitest';

import {
  POLICY_REMINDER_DAYS,
  POLICY_REMINDER_MAX,
  POLICY_REMINDER_MIN_GAP_DAYS,
  POLICY_REMIND_NOW_EVERY_HOURS,
  isPolicyReminderDue,
  nextPolicyReminderAt,
  nextRemindNowAt,
} from './policy-reminders';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-02T09:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('the reminder schedule', () => {
  it('is 3 and 7 days, then weekly, at most 6, never within 3 days of the last; Remind now once a day', () => {
    expect(POLICY_REMINDER_DAYS).toEqual([3, 7, 14, 21, 28, 35]);
    expect(POLICY_REMINDER_MAX).toBe(6);
    expect(POLICY_REMINDER_MIN_GAP_DAYS).toBe(3);
    expect(POLICY_REMIND_NOW_EVERY_HOURS).toBe(24);
  });

  it('follows the schedule when every run is on time', () => {
    let last: Date | null = null;
    const sentOn: number[] = [];
    for (let day = 0; day <= 60; day += 1) {
      const state = { owedSince: T0, sent: sentOn.length, lastRemindedAt: last };
      if (isPolicyReminderDue(state, at(day))) {
        sentOn.push(day);
        last = at(day);
      }
    }
    expect(sentOn).toEqual([3, 7, 14, 21, 28, 35]);
  });

  it('is due exactly at the offset, not a millisecond before', () => {
    const s = { owedSince: T0, sent: 0, lastRemindedAt: null };
    expect(isPolicyReminderDue(s, new Date(at(3).getTime() - 1))).toBe(false);
    expect(isPolicyReminderDue(s, at(3))).toBe(true);
    expect(nextPolicyReminderAt(s)).toEqual(at(3));
  });

  it('keeps 3 days after any reminder, Remind now included, and catches up one at a time', () => {
    // Remind now on day 6: the second automatic reminder waits to day 9.
    expect(nextPolicyReminderAt({ owedSince: T0, sent: 1, lastRemindedAt: at(6) })).toEqual(at(9));
    // A job that did not run for 20 days: one reminder, then the next 3 days later.
    expect(nextPolicyReminderAt({ owedSince: T0, sent: 0, lastRemindedAt: null })).toEqual(at(3));
    expect(isPolicyReminderDue({ owedSince: T0, sent: 1, lastRemindedAt: at(20) }, at(21))).toBe(
      false,
    );
    expect(isPolicyReminderDue({ owedSince: T0, sent: 1, lastRemindedAt: at(20) }, at(23))).toBe(
      true,
    );
  });

  it('has none after 6, and none for a broken state', () => {
    expect(nextPolicyReminderAt({ owedSince: T0, sent: 6, lastRemindedAt: at(35) })).toBeNull();
    expect(nextPolicyReminderAt({ owedSince: T0, sent: 7, lastRemindedAt: null })).toBeNull();
    expect(nextPolicyReminderAt({ owedSince: T0, sent: -1, lastRemindedAt: null })).toBeNull();
    expect(nextPolicyReminderAt({ owedSince: T0, sent: 1.5, lastRemindedAt: null })).toBeNull();
    expect(
      nextPolicyReminderAt({ owedSince: new Date('x'), sent: 0, lastRemindedAt: null }),
    ).toBeNull();
    expect(
      nextPolicyReminderAt({ owedSince: T0, sent: 0, lastRemindedAt: new Date('x') }),
    ).toBeNull();
    expect(isPolicyReminderDue({ owedSince: T0, sent: 6, lastRemindedAt: null }, at(400))).toBe(
      false,
    );
  });
});

describe('Remind now', () => {
  it('is allowed again 24 hours after the last one', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(nextRemindNowAt(null, now)).toBeNull();
    expect(nextRemindNowAt(new Date('2026-11-23T12:00:00Z'), now)).toBeNull();
    expect(nextRemindNowAt(new Date('2026-11-23T12:00:01Z'), now)).toEqual(
      new Date('2026-11-24T12:00:01Z'),
    );
    expect(nextRemindNowAt(new Date('x'), now)).toBeNull();
  });
});
