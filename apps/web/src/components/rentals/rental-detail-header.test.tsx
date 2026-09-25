import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  RENTAL_NO_EMAIL_NOTE,
  RENTAL_NON_MEMBER_EMAIL_NOTE,
} from '@stockpilot/core';

import type { RentalRow } from '@/server/services/rentals';

import { RentalDetailHeader } from './rental-detail-header';

/**
 * The borrower block on the rental detail page: who, whether they are a team
 * member or not in StockPilot, and the email on file (or that there is none,
 * which means no receipt and no reminders).
 */

function rental(over: Partial<RentalRow> = {}): RentalRow {
  return {
    id: 'r-1',
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    borrower_user_id: null,
    borrower_name: 'Sam Ortiz',
    borrower_email: 'sam@school.org',
    checked_out_at: '2026-09-20T17:00:00.000Z',
    expected_return_at: '2099-09-26T00:00:00.000Z',
    returned_at: null,
    status: 'out',
    notes: null,
    created_by: null,
    cancelled_by: null,
    cancelled_at: null,
    cancellation_reason: null,
    returned_by: null,
    return_notes: null,
    overdue_reminder_sent_at: null,
    created_at: '2026-09-20T17:00:00.000Z',
    updated_at: '2026-09-20T17:00:00.000Z',
    ...over,
  };
}

// Thu Sep 24 2026, 10:00 AM PDT.
const NOW = Date.parse('2026-09-24T17:00:00.000Z');

function renderHeader(r: RentalRow) {
  return render(
    <RentalDetailHeader rental={r} warehouseName="DC4" timeZone="America/Los_Angeles" nowMs={NOW} />,
  );
}

describe('RentalDetailHeader borrower block', () => {
  it('a borrower not in StockPilot, with an email: the email and that their emails carry no app link', () => {
    renderHeader(rental());
    expect(screen.getByRole('heading', { name: 'Sam Ortiz' })).toBeTruthy();
    expect(screen.getByTestId('borrower-kind').textContent).toBe('Not in StockPilot');
    expect(screen.getByText('sam@school.org')).toBeTruthy();
    expect(screen.getByText(RENTAL_NON_MEMBER_EMAIL_NOTE)).toBeTruthy();
    expect(screen.queryByText(RENTAL_NO_EMAIL_NOTE)).toBeNull();
  });

  it('a team member: labelled so, with the email on the rental and no non-member note', () => {
    renderHeader(rental({ borrower_user_id: 'u-1', borrower_email: 'ana@school.org', borrower_name: 'Ana Ruiz' }));
    expect(screen.getByTestId('borrower-kind').textContent).toBe('Team member');
    expect(screen.getByText('ana@school.org')).toBeTruthy();
    expect(screen.queryByText(RENTAL_NON_MEMBER_EMAIL_NOTE)).toBeNull();
  });

  it('no email on file (blank counts): the no-email note in its place', () => {
    for (const borrower_email of [null, '   ']) {
      const { unmount } = renderHeader(rental({ borrower_email }));
      expect(screen.getByText(RENTAL_NO_EMAIL_NOTE)).toBeTruthy();
      expect(screen.queryByText(RENTAL_NON_MEMBER_EMAIL_NOTE)).toBeNull();
      unmount();
    }
  });

  it('prints the expected return with its time in the organization zone', () => {
    // Sep 26 00:00 UTC is still Sep 25 in California; the server zone (UTC)
    // used to print the 26th.
    renderHeader(rental({ expected_return_at: '2099-09-26T00:00:00.000Z' }));
    expect(screen.getByText(/Sep 25, 2099,? 5:00 PM/)).toBeTruthy();
  });

  it('decides Overdue at the page moment it is handed', () => {
    renderHeader(rental({ expected_return_at: '2026-09-24T16:59:00.000Z' }));
    expect(screen.getByText('Overdue')).toBeTruthy();
  });
});
