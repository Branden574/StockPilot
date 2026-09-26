import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RENTAL_EMAILS_RECORD_NOTE, type RentalEmailFacts } from '@stockpilot/core';

import { RentalEmailsCard } from './rental-emails-card';

/**
 * The emails card on the rental detail page. Each state below is one the owner
 * asked the page to tell apart (2026-09-25): the reminder's recorded send, its
 * real schedule, and why it will not go (no email; Rentals switched off; the
 * rental closed). The receipt and the confirmation are never shown as sent:
 * nothing records them.
 */

const PT = 'America/Los_Angeles';
// Thu Sep 24 2026, 10:00 AM PDT.
const NOW = Date.parse('2026-09-24T17:00:00.000Z');

function rental(over: Partial<RentalEmailFacts> = {}): RentalEmailFacts {
  return {
    status: 'out',
    // Fri Sep 25, 5:00 PM PDT.
    expected_return_at: '2026-09-26T00:00:00.000Z',
    returned_at: null,
    borrower_email: 'sam@school.org',
    overdue_reminder_sent_at: null,
    ...over,
  };
}

function line(key: 'checkout' | 'returned' | 'overdue') {
  const el = document.querySelector(`[data-email="${key}"]`);
  if (!el) throw new Error(`no ${key} line`);
  return el as HTMLElement;
}

describe('RentalEmailsCard', () => {
  it('an out rental with an email: the address, the rules, and the reminder schedule', () => {
    render(<RentalEmailsCard rental={rental()} remindersOn nowMs={NOW} timeZone={PT} />);
    expect(screen.getByRole('heading', { name: 'Emails to the borrower' })).toBeTruthy();
    expect(screen.getByText('Rental emails go to sam@school.org')).toBeTruthy();
    expect(within(line('checkout')).getByText('Goes out at checkout.')).toBeTruthy();
    expect(
      within(line('returned')).getByText('Will go out when the rental is marked returned.'),
    ).toBeTruthy();
    // Due Fri 5 PM: the first run after is Sat Sep 26 at 8:00 AM Pacific.
    expect(
      within(line('overdue')).getByText(
        'Will be sent Sep 26, around 8:00 AM, if the rental is still out then.',
      ),
    ).toBeTruthy();
    expect(line('overdue').dataset.tone).toBe('upcoming');
    expect(screen.getByText(RENTAL_EMAILS_RECORD_NOTE)).toBeTruthy();
  });

  it('a reminded rental: "Sent" with the recorded time, the only recorded line', () => {
    render(
      <RentalEmailsCard
        rental={rental({
          expected_return_at: '2026-09-20T00:00:00.000Z',
          overdue_reminder_sent_at: '2026-09-20T15:00:03.000Z',
        })}
        remindersOn
        nowMs={NOW}
        timeZone={PT}
      />,
    );
    expect(within(line('overdue')).getByText('Sent Sep 20, 8:00 AM.')).toBeTruthy();
    expect(line('overdue').dataset.tone).toBe('recorded');
    expect(line('checkout').dataset.tone).not.toBe('recorded');
    expect(line('returned').dataset.tone).not.toBe('recorded');
  });

  it('overdue and not yet reminded: the next daily run', () => {
    render(
      <RentalEmailsCard
        rental={rental({ expected_return_at: '2026-09-23T00:00:00.000Z' })}
        remindersOn
        nowMs={NOW}
        timeZone={PT}
      />,
    );
    expect(
      within(line('overdue')).getByText(
        'Overdue: will be sent with the next daily run, Sep 25, around 8:00 AM, if the rental is still out.',
      ),
    ).toBeTruthy();
  });

  it('no email on file: nothing is sent, and the page says so for all three', () => {
    render(
      <RentalEmailsCard rental={rental({ borrower_email: null })} remindersOn nowMs={NOW} timeZone={PT} />,
    );
    expect(screen.getByText('No email on file')).toBeTruthy();
    for (const key of ['checkout', 'returned', 'overdue'] as const) {
      expect(within(line(key)).getByText('Not sent: no email on file.')).toBeTruthy();
    }
    // Nothing to be recorded, so no note about records.
    expect(screen.queryByText(RENTAL_EMAILS_RECORD_NOTE)).toBeNull();
  });

  it('Rentals switched off (or comped with the row off): the reminder is off, the others are not', () => {
    render(<RentalEmailsCard rental={rental()} remindersOn={false} nowMs={NOW} timeZone={PT} />);
    expect(
      within(line('overdue')).getByText(
        'Not sent: overdue reminders are off for this organization. They go out only while Rentals is switched on in Settings > Modules.',
      ),
    ).toBeTruthy();
    expect(within(line('checkout')).getByText('Goes out at checkout.')).toBeTruthy();
  });

  it('an unreadable switch: says it could not check, never a promise', () => {
    render(<RentalEmailsCard rental={rental()} remindersOn={null} nowMs={NOW} timeZone={PT} />);
    expect(within(line('overdue')).getByText(/Could not check whether overdue reminders are on/)).toBeTruthy();
    expect(line('overdue').textContent).not.toMatch(/Will be sent/);
  });

  it('returned and cancelled rentals', () => {
    const { unmount } = render(
      <RentalEmailsCard
        rental={rental({ status: 'returned', returned_at: '2026-09-25T20:00:00.000Z' })}
        remindersOn
        nowMs={NOW}
        timeZone={PT}
      />,
    );
    expect(within(line('returned')).getByText('Goes out when the rental is marked returned.')).toBeTruthy();
    expect(within(line('overdue')).getByText('Not needed: returned on time.')).toBeTruthy();
    unmount();

    render(<RentalEmailsCard rental={rental({ status: 'cancelled' })} remindersOn nowMs={NOW} timeZone={PT} />);
    expect(
      within(line('returned')).getByText('Not sent: a cancelled rental gets no return confirmation.'),
    ).toBeTruthy();
    expect(within(line('overdue')).getByText('Not sent: the rental was cancelled.')).toBeTruthy();
  });

  it('never describes a reminder before the return date', () => {
    for (const on of [true, false, null]) {
      const { container, unmount } = render(
        <RentalEmailsCard rental={rental()} remindersOn={on} nowMs={NOW} timeZone={PT} />,
      );
      expect(container.textContent).not.toMatch(/due soon|before (it is|the rental is) due|upcoming reminder/i);
      unmount();
    }
  });
});
