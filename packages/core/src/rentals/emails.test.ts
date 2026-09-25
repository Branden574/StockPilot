import { describe, expect, it } from 'vitest';

import { RENTAL_BORROWER_EMAIL_HELP } from './borrower';
import {
  RENTAL_BORROWER_NOT_LINKED,
  RENTAL_BORROWER_TEAM_MEMBER,
  RENTAL_EMAILS_RECORD_NOTE,
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
  RENTAL_OVERDUE_SWEEP,
  isOverdueReminderCandidate,
  isRentalOverdue,
  nextOverdueSweepAt,
  overdueReminderListMark,
  overdueReminderState,
  overdueReminderText,
  overdueRemindersOn,
  rentalEmailLines,
  rentalEmailOnFile,
  type OverdueReminderState,
  type RentalEmailFacts,
} from './emails';

const PT = 'America/Los_Angeles';
// Thu Sep 24 2026, 10:00 AM PDT.
const NOW = Date.parse('2026-09-24T17:00:00.000Z');

function rental(over: Partial<RentalEmailFacts> = {}): RentalEmailFacts {
  return {
    status: 'out',
    // Fri Sep 25 2026, 5:00 PM PDT: not overdue at NOW.
    expected_return_at: '2026-09-26T00:00:00.000Z',
    returned_at: null,
    borrower_email: 'sam@school.org',
    overdue_reminder_sent_at: null,
    ...over,
  };
}

describe('rentalEmailOnFile: the address the emails go to', () => {
  it('trims, and treats blank as none (the dispatcher skips on exactly this)', () => {
    expect(rentalEmailOnFile(' sam@school.org ')).toBe('sam@school.org');
    expect(rentalEmailOnFile('')).toBeNull();
    expect(rentalEmailOnFile('   ')).toBeNull();
    expect(rentalEmailOnFile(null)).toBeNull();
    expect(rentalEmailOnFile(undefined)).toBeNull();
  });
});

describe('overdueRemindersOn: the explicit module row, never the comp', () => {
  it('is on only for a row that says enabled', () => {
    expect(overdueRemindersOn({ enabled: true })).toBe(true);
    expect(overdueRemindersOn({ enabled: false })).toBe(false);
    expect(overdueRemindersOn({ enabled: null })).toBe(false);
    // No row: a comped organization that never switched Rentals on.
    expect(overdueRemindersOn(null)).toBe(false);
    expect(overdueRemindersOn(undefined)).toBe(false);
  });

  it('follows the rentals row', () => {
    expect(RENTAL_OVERDUE_SWEEP.moduleId).toBe('rentals');
  });
});

describe('isOverdueReminderCandidate: the sweep rule', () => {
  const base = { status: 'out', expected_return_at: '2026-09-24T16:59:59.000Z', overdue_reminder_sent_at: null };

  it('takes an out, unreminded rental whose expected return has passed', () => {
    expect(isOverdueReminderCandidate(base, NOW)).toBe(true);
  });

  it('refuses each condition on its own', () => {
    expect(isOverdueReminderCandidate({ ...base, status: 'returned' }, NOW)).toBe(false);
    expect(isOverdueReminderCandidate({ ...base, status: 'cancelled' }, NOW)).toBe(false);
    expect(
      isOverdueReminderCandidate({ ...base, overdue_reminder_sent_at: '2026-09-24T15:00:02.000Z' }, NOW),
    ).toBe(false);
    // Due exactly now is not past due: the query is expected_return_at < now.
    expect(isOverdueReminderCandidate({ ...base, expected_return_at: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(isOverdueReminderCandidate({ ...base, expected_return_at: 'not a date' }, NOW)).toBe(false);
  });
});

describe('nextOverdueSweepAt: the first daily run at or after a moment', () => {
  it('is 15:00 UTC the same day when that is still ahead', () => {
    expect(nextOverdueSweepAt(Date.parse('2026-09-24T14:59:00.000Z')).toISOString()).toBe(
      '2026-09-24T15:00:00.000Z',
    );
  });

  it('is the same run for a rental due exactly at 15:00 UTC (the run reads due < its own now)', () => {
    expect(nextOverdueSweepAt(Date.parse('2026-09-24T15:00:00.000Z')).toISOString()).toBe(
      '2026-09-24T15:00:00.000Z',
    );
  });

  it('is the next day once that run has started', () => {
    expect(nextOverdueSweepAt(Date.parse('2026-09-24T15:00:00.001Z')).toISOString()).toBe(
      '2026-09-25T15:00:00.000Z',
    );
    expect(nextOverdueSweepAt(Date.parse('2026-12-31T23:30:00.000Z')).toISOString()).toBe(
      '2027-01-01T15:00:00.000Z',
    );
  });

  it('is NOT always "the morning after": a rental due before 8 AM Pacific is reminded that same morning', () => {
    // Due Sep 25 at 7:00 AM PDT; the run is Sep 25 at 8:00 AM PDT.
    const at = nextOverdueSweepAt(Date.parse('2026-09-25T14:00:00.000Z'));
    expect(at.toISOString()).toBe('2026-09-25T15:00:00.000Z');
  });
});

describe('overdueReminderState', () => {
  it('no email on file wins over everything, even a stamp (the sweep stamps before its send skips)', () => {
    expect(overdueReminderState(rental({ borrower_email: null }), true, NOW)).toEqual({ kind: 'no_email' });
    expect(
      overdueReminderState(
        rental({ borrower_email: '  ', overdue_reminder_sent_at: '2026-09-20T15:00:01.000Z' }),
        true,
        NOW,
      ),
    ).toEqual({ kind: 'no_email' });
  });

  it('sent: the stamp, whatever the status or the switch is now', () => {
    const sentAt = '2026-09-20T15:00:01.000Z';
    for (const status of ['out', 'returned', 'cancelled']) {
      for (const on of [true, false, null]) {
        expect(overdueReminderState(rental({ status, overdue_reminder_sent_at: sentAt }), on, NOW)).toEqual({
          kind: 'sent',
          sentAt,
        });
      }
    }
  });

  it('returned on time, returned late before a run, and cancelled: no reminder will go', () => {
    expect(
      overdueReminderState(
        rental({ status: 'returned', returned_at: '2026-09-25T20:00:00.000Z' }),
        true,
        NOW,
      ),
    ).toEqual({ kind: 'returned_on_time' });
    expect(
      overdueReminderState(
        rental({ status: 'returned', returned_at: '2026-09-26T08:00:00.000Z' }),
        true,
        NOW,
      ),
    ).toEqual({ kind: 'closed_before_reminder', status: 'returned' });
    expect(overdueReminderState(rental({ status: 'cancelled' }), true, NOW)).toEqual({
      kind: 'closed_before_reminder',
      status: 'cancelled',
    });
  });

  it('an out rental in an organization whose Rentals row is off: off (the sweep never reads it)', () => {
    expect(overdueReminderState(rental(), false, NOW)).toEqual({ kind: 'reminders_off' });
    expect(
      overdueReminderState(rental({ expected_return_at: '2026-09-20T00:00:00.000Z' }), false, NOW),
    ).toEqual({ kind: 'reminders_off' });
  });

  it('an unreadable row is unknown, never a promise', () => {
    expect(overdueReminderState(rental(), null, NOW)).toEqual({ kind: 'unknown' });
  });

  it('not overdue yet: scheduled for the first run after the expected return', () => {
    // Due Fri Sep 25, 5:00 PM PDT (Sep 26 00:00 UTC) -> run Sat Sep 26, 8:00 AM PDT.
    const state = overdueReminderState(rental(), true, NOW);
    expect(state).toEqual({ kind: 'scheduled', at: new Date('2026-09-26T15:00:00.000Z') });
  });

  it('overdue and not yet reminded: due with the next run, the SAME rule the sweep applies', () => {
    const late = rental({ expected_return_at: '2026-09-23T00:00:00.000Z' });
    expect(isOverdueReminderCandidate(late, NOW)).toBe(true);
    // NOW is 17:00 UTC, past today's run: the next one is tomorrow.
    expect(overdueReminderState(late, true, NOW)).toEqual({
      kind: 'due',
      at: new Date('2026-09-25T15:00:00.000Z'),
    });
  });

  it('never "due" for a rental the sweep would not take', () => {
    const cases: RentalEmailFacts[] = [
      rental(),
      rental({ status: 'returned', expected_return_at: '2026-09-01T00:00:00.000Z' }),
      rental({ expected_return_at: '2026-09-01T00:00:00.000Z', overdue_reminder_sent_at: '2026-09-02T15:00:00.000Z' }),
    ];
    for (const r of cases) {
      const state = overdueReminderState(r, true, NOW);
      expect(state.kind === 'due').toBe(isOverdueReminderCandidate(r, NOW));
    }
  });
});

describe('overdueReminderText', () => {
  it('sent: the recorded time in the organization zone', () => {
    expect(overdueReminderText({ kind: 'sent', sentAt: '2026-09-26T15:00:04.000Z' }, PT)).toBe(
      'Sent Sep 26, 8:00 AM.',
    );
  });

  it('scheduled: the run date and time, and only if still out', () => {
    expect(
      overdueReminderText({ kind: 'scheduled', at: new Date('2026-09-26T15:00:00.000Z') }, PT),
    ).toBe('Will be sent Sep 26, around 8:00 AM, if the rental is still out then.');
    // Winter: the same 15:00 UTC run is 7:00 AM Pacific standard time.
    expect(
      overdueReminderText({ kind: 'scheduled', at: new Date('2026-12-02T15:00:00.000Z') }, PT),
    ).toBe('Will be sent Dec 2, around 7:00 AM, if the rental is still out then.');
  });

  it('due, off, unknown, closed and no email each say what is true', () => {
    expect(overdueReminderText({ kind: 'due', at: new Date('2026-09-25T15:00:00.000Z') }, PT)).toBe(
      'Overdue: will be sent with the next daily run, Sep 25, around 8:00 AM, if the rental is still out.',
    );
    expect(overdueReminderText({ kind: 'no_email' })).toBe('Not sent: no email on file.');
    expect(overdueReminderText({ kind: 'reminders_off' })).toMatch(
      /^Not sent: overdue reminders are off for this organization\. They go out only while Rentals is switched on in Settings > Modules\.$/,
    );
    expect(overdueReminderText({ kind: 'unknown' })).toMatch(/Could not check/);
    expect(overdueReminderText({ kind: 'returned_on_time' })).toBe('Not needed: returned on time.');
    expect(overdueReminderText({ kind: 'closed_before_reminder', status: 'returned' })).toBe(
      'Not sent: returned before a reminder went out.',
    );
    expect(overdueReminderText({ kind: 'closed_before_reminder', status: 'cancelled' })).toBe(
      'Not sent: the rental was cancelled.',
    );
  });

  it('the reminders-off line does not claim the receipt or the confirmation are off (they are not)', () => {
    expect(overdueReminderText({ kind: 'reminders_off' })).not.toMatch(/rental emails are off/i);
  });

  it('without a zone, formats in the device zone rather than failing', () => {
    expect(overdueReminderText({ kind: 'sent', sentAt: '2026-09-26T15:00:04.000Z' })).toMatch(
      /^Sent Sep 2[67], \d{1,2}:\d{2} [AP]M\.$/,
    );
    expect(overdueReminderText({ kind: 'sent', sentAt: 'garbage' })).toBe('Sent —.');
  });
});

describe('rentalEmailLines', () => {
  it('with an email: the receipt and confirmation state their rule, never a send', () => {
    const lines = rentalEmailLines(rental(), true, NOW, PT);
    expect(lines.map((l) => l.key)).toEqual(['checkout', 'returned', 'overdue']);
    expect(lines[0]).toEqual({
      key: 'checkout',
      label: 'Checkout receipt',
      detail: 'Goes out at checkout.',
      tone: 'rule',
    });
    expect(lines[1]).toMatchObject({
      label: 'Return confirmation',
      detail: 'Will go out when the rental is marked returned.',
      tone: 'upcoming',
    });
    expect(lines[2]).toMatchObject({ label: 'Overdue reminder', tone: 'upcoming' });
    for (const line of lines.slice(0, 2)) expect(line.detail).not.toMatch(/\bsent\b/i);
  });

  it('with no email: all three say not sent', () => {
    const lines = rentalEmailLines(rental({ borrower_email: null }), true, NOW, PT);
    for (const line of lines) {
      expect(line.detail).toBe('Not sent: no email on file.');
      expect(line.tone).toBe('none');
    }
  });

  it('a returned rental: the confirmation rule; a cancelled one: none', () => {
    const returned = rentalEmailLines(
      rental({ status: 'returned', returned_at: '2026-09-25T20:00:00.000Z' }),
      true,
      NOW,
      PT,
    );
    expect(returned[1]).toMatchObject({ detail: 'Goes out when the rental is marked returned.', tone: 'rule' });
    const cancelled = rentalEmailLines(rental({ status: 'cancelled' }), true, NOW, PT);
    expect(cancelled[1]).toMatchObject({
      detail: 'Not sent: a cancelled rental gets no return confirmation.',
      tone: 'none',
    });
  });

  it('a recorded reminder is the only "recorded" line', () => {
    const lines = rentalEmailLines(
      rental({ expected_return_at: '2026-09-20T00:00:00.000Z', overdue_reminder_sent_at: '2026-09-20T15:00:02.000Z' }),
      false,
      NOW,
      PT,
    );
    expect(lines.filter((l) => l.tone === 'recorded').map((l) => l.key)).toEqual(['overdue']);
    expect(lines[2]?.detail).toBe('Sent Sep 20, 8:00 AM.');
  });
});

describe('overdueReminderListMark', () => {
  it('sent, no email, off and due each get a short true mark', () => {
    expect(overdueReminderListMark({ kind: 'sent', sentAt: '2026-09-26T15:00:04.000Z' }, PT)).toBe(
      'Reminder sent Sep 26',
    );
    expect(overdueReminderListMark({ kind: 'no_email' }, PT)).toBe('No email on file');
    expect(overdueReminderListMark({ kind: 'reminders_off' }, PT)).toBe('Reminders off');
    expect(overdueReminderListMark({ kind: 'due', at: new Date('2026-09-25T15:00:00.000Z') }, PT)).toBe(
      'Reminder goes out Sep 25',
    );
  });

  it('nothing when the state is unknown or not an overdue one', () => {
    const none: OverdueReminderState[] = [
      { kind: 'unknown' },
      { kind: 'scheduled', at: new Date() },
      { kind: 'returned_on_time' },
      { kind: 'closed_before_reminder', status: 'cancelled' },
    ];
    for (const state of none) expect(overdueReminderListMark(state, PT)).toBeNull();
  });
});

describe('isRentalOverdue', () => {
  it('out and past due only', () => {
    expect(isRentalOverdue({ status: 'out', expected_return_at: '2026-09-24T16:00:00.000Z' }, NOW)).toBe(true);
    expect(isRentalOverdue({ status: 'out', expected_return_at: '2026-09-24T18:00:00.000Z' }, NOW)).toBe(false);
    expect(isRentalOverdue({ status: 'returned', expected_return_at: '2026-09-01T00:00:00.000Z' }, NOW)).toBe(false);
  });
});

describe('no reminder BEFORE the return date is described anywhere', () => {
  // The owner has not approved a "due soon" reminder and none is sent. Every
  // sentence the rental pages can show comes from this module (or the shared
  // help text), so this is where a stray promise would appear.
  const DUE_SOON = /due soon|before (it is|it's|the rental is) due|upcoming reminder|reminder before|day before|heads[- ]up/i;

  it('in any fixed sentence', () => {
    for (const text of [
      RENTAL_BORROWER_TEAM_MEMBER,
      RENTAL_BORROWER_NOT_LINKED,
      RENTAL_NO_EMAIL_NOTE,
      RENTAL_NON_MEMBER_EMAIL_NOTE,
      RENTAL_EMAILS_RECORD_NOTE,
      RENTAL_BORROWER_EMAIL_HELP,
    ]) {
      expect(text).not.toMatch(DUE_SOON);
    }
  });

  it('in any line or mark, for every state', () => {
    const at = new Date('2026-09-26T15:00:00.000Z');
    const states: OverdueReminderState[] = [
      { kind: 'no_email' },
      { kind: 'sent', sentAt: at.toISOString() },
      { kind: 'returned_on_time' },
      { kind: 'closed_before_reminder', status: 'returned' },
      { kind: 'closed_before_reminder', status: 'cancelled' },
      { kind: 'reminders_off' },
      { kind: 'unknown' },
      { kind: 'scheduled', at },
      { kind: 'due', at },
    ];
    for (const state of states) {
      expect(overdueReminderText(state, PT)).not.toMatch(DUE_SOON);
      expect(overdueReminderListMark(state, PT) ?? '').not.toMatch(DUE_SOON);
    }
    for (const status of ['out', 'returned', 'cancelled']) {
      for (const line of rentalEmailLines(rental({ status }), true, NOW, PT)) {
        expect(`${line.label} ${line.detail}`).not.toMatch(DUE_SOON);
      }
    }
  });

  it('a not-yet-overdue rental is described only as reminded AFTER its return date', () => {
    const state = overdueReminderState(rental(), true, NOW);
    expect(state.kind).toBe('scheduled');
    if (state.kind !== 'scheduled') return;
    expect(state.at.getTime()).toBeGreaterThanOrEqual(Date.parse(rental().expected_return_at));
  });
});

describe('the borrower label says only what the rental records', () => {
  // borrower_user_id null means the rental is not tied to an account, not that
  // the person has none: every phone checkout before 2026-09-25 was a typed
  // name, co-workers included. Mutation caught: "Not in StockPilot", which is
  // false about those co-workers on every web and phone detail page.
  it('a rental without a linked account is never called "Not in StockPilot"', () => {
    expect(RENTAL_BORROWER_NOT_LINKED).toBe('Not linked to a StockPilot account');
    expect(RENTAL_BORROWER_NOT_LINKED).not.toMatch(/not in stockpilot/i);
  });
});
