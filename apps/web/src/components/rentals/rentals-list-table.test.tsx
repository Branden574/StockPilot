import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RENTAL_BORROWER_TEAM_MEMBER } from '@stockpilot/core';

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

const HOUR = 60 * 60 * 1000;

function returnCell(id: string): HTMLElement {
  const row = screen.getByText(`Borrower ${id}`).closest('tr')!;
  return row.querySelectorAll('td')[3] as HTMLElement;
}

function statusCell(id: string): HTMLElement {
  const row = screen.getByText(`Borrower ${id}`).closest('tr')!;
  return row.querySelectorAll('td')[4] as HTMLElement;
}

// Web walk 2026-09-25: rental 97333a52, due 17:00Z and viewed at about 22:00Z,
// read "Due today" beside its Overdue pill and "Reminder goes out Sep 26". The
// label rounded 5 hours late to 0 days. Mutation caught: that rounding.
describe('RentalsListTable due label agrees with the pill', () => {
  it('a rental a few hours late says how late, never "Due today"', () => {
    render(
      <RentalsListTable
        rentals={[
          rental('five', { expected_return_at: new Date(Date.now() - 5 * HOUR).toISOString() }),
          rental('one', { expected_return_at: new Date(Date.now() - 1 * HOUR - 60_000).toISOString() }),
          rental('just', { expected_return_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
        ]}
        viewerRole="staff"
        reminderMarks={{ five: 'Reminder goes out Sep 26' }}
      />,
    );
    expect(within(returnCell('five')).getByText('Overdue by 5 hours')).toBeTruthy();
    expect(within(returnCell('one')).getByText('Overdue by 1 hour')).toBeTruthy();
    expect(within(returnCell('just')).getByText('Overdue by less than an hour')).toBeTruthy();
    for (const id of ['five', 'one', 'just']) expect(statusCell(id).textContent).toBe('Overdue');
    expect(screen.queryByText('Due today')).toBeNull();
  });

  it('every past-due offset reads Overdue, beside an Overdue pill', () => {
    const offsets = [0.02, 2, 11.9, 12.1, 23.9, 36, 60];
    render(
      <RentalsListTable
        rentals={offsets.map((h) =>
          rental(`h${h}`, { expected_return_at: new Date(Date.now() - h * HOUR).toISOString() }),
        )}
        viewerRole="staff"
      />,
    );
    for (const h of offsets) {
      expect(returnCell(`h${h}`).textContent).toMatch(/^Overdue by /);
      expect(statusCell(`h${h}`).textContent).toBe('Overdue');
    }
    expect(returnCell('h36').textContent).toBe('Overdue by 2 days');
  });

  it('not yet due: as before', () => {
    render(
      <RentalsListTable
        rentals={[
          rental('soon', { expected_return_at: new Date(Date.now() + 2 * HOUR).toISOString() }),
          rental('later', { expected_return_at: new Date(Date.now() + 3 * 24 * HOUR).toISOString() }),
        ]}
        viewerRole="staff"
      />,
    );
    expect(returnCell('soon').textContent).toBe('Due today');
    expect(statusCell('soon').textContent).toBe('Out');
    expect(returnCell('later').textContent).toBe('Due in 3 days');
  });
});

// Web walk 2026-09-25: "Hydration failed because the server rendered text
// didn't match the client" ("+ 4 minutes ago / - 3 minutes ago") when a
// minute passed between the server render and hydration.
describe('RentalsListTable hydrates across a clock tick', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('the server and the browser a minute apart: no hydration error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-09-25T22:00:00.000Z');
    vi.setSystemTime(t0);
    const rows = [
      // 3.5 minutes before the server render: "3 minutes ago", then "4".
      rental('tick', {
        checked_out_at: new Date(t0 - 210_000).toISOString(),
        // Due 30 s after the server render: Out and "Due today" there,
        // Overdue in the browser.
        expected_return_at: new Date(t0 + 30_000).toISOString(),
      }),
      rental('back', {
        status: 'returned' as never,
        returned_at: new Date(t0 - 210_000).toISOString(),
      }),
    ];
    const ui = <RentalsListTable rentals={rows} viewerRole="staff" />;
    const html = renderToString(ui);
    expect(html).toContain('3 minutes ago');

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    vi.setSystemTime(t0 + 60_000);
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    try {
      await act(async () => {
        hydrateRoot(container, ui, { onRecoverableError: (e) => errors.push(e) });
      });
    } finally {
      consoleError.mockRestore();
    }
    expect(errors).toEqual([]);
  });
});

// Web walk 2026-09-25: the list tagged a member "(member)" while the detail
// page says "Team member" (and "Not linked to a StockPilot account" for the
// rest). Mutation caught: the old "(member)" tag.
describe('RentalsListTable borrower tag', () => {
  it("a team member is tagged in the detail page's words; other borrowers carry no tag", () => {
    render(
      <RentalsListTable
        rentals={[rental('m', { borrower_user_id: 'user-1' }), rental('n')]}
        viewerRole="staff"
      />,
    );
    const tags = screen.getAllByTestId('borrower-kind');
    expect(tags.map((t) => t.textContent)).toEqual([RENTAL_BORROWER_TEAM_MEMBER]);
    expect(RENTAL_BORROWER_TEAM_MEMBER).toBe('Team member');
    expect(screen.queryByText('(member)')).toBeNull();
    expect(screen.getByText('Borrower m').closest('td')!.textContent).toContain('Team member');
  });
});
