import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/actions/rentals', () => ({
  cancelRentalAction: vi.fn(),
  markRentalReturnedAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { RentalsListTable } from './rentals-list-table';

const DAY = 24 * 60 * 60 * 1000;

function rental(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    borrower_user_id: null,
    borrower_name: `Borrower ${id}`,
    borrower_email: 'sam@school.org',
    checked_out_at: new Date(Date.now() - 10 * DAY).toISOString(),
    expected_return_at: new Date(Date.now() - 2 * DAY).toISOString(),
    returned_at: null,
    status: 'out' as const,
    notes: null,
    created_by: null,
    cancelled_by: null,
    cancelled_at: null,
    cancellation_reason: null,
    returned_by: null,
    return_notes: null,
    overdue_reminder_sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    lines: [],
    ...over,
  };
}

describe('RentalsListTable reminder marks', () => {
  it('shows the server-decided mark under the overdue label, and nothing on rows without one', () => {
    render(
      <RentalsListTable
        rentals={[rental('a'), rental('b')]}
        viewerRole="staff"
        reminderMarks={{ a: 'Reminder sent Sep 20' }}
      />,
    );
    const marks = screen.getAllByTestId('reminder-mark');
    expect(marks.map((m) => m.textContent)).toEqual(['Reminder sent Sep 20']);
    expect(screen.getAllByText(/Overdue by 2 days/)).toHaveLength(2);
  });

  it('renders as before when no marks are given', () => {
    render(<RentalsListTable rentals={[rental('a')]} viewerRole="staff" />);
    expect(screen.queryByTestId('reminder-mark')).toBeNull();
  });
});
