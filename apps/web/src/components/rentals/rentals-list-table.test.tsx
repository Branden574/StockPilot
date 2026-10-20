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
const PT = 'America/Los_Angeles';

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
        timeZone={PT}
        reminderMarks={{ a: 'Reminder sent Sep 20' }}
      />,
    );
    const marks = screen.getAllByTestId('reminder-mark');
    expect(marks.map((m) => m.textContent)).toEqual(['Reminder sent Sep 20']);
    expect(screen.getAllByText(/Overdue by 2 days/)).toHaveLength(2);
  });

  it('renders as before when no marks are given', () => {
    render(<RentalsListTable rentals={[rental('a')]} viewerRole="staff" timeZone={PT} />);
    expect(screen.queryByTestId('reminder-mark')).toBeNull();
    // The Rentals page title (titleId="rentals-title") names the scroll
    // region; the table keeps its own name.
    const table = screen.getByRole('table', { name: 'Rentals' });
    expect(table.parentElement).toHaveAttribute('aria-labelledby', 'rentals-title');
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
          rental('one', {
            expected_return_at: new Date(Date.now() - 1 * HOUR - 60_000).toISOString(),
          }),
          rental('just', { expected_return_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
        ]}
        viewerRole="staff"
        timeZone={PT}
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
        timeZone={PT}
      />,
    );
    for (const h of offsets) {
      expect(returnCell(`h${h}`).textContent).toMatch(/^Overdue by /);
      expect(statusCell(`h${h}`).textContent).toBe('Overdue');
    }
    // Whole days, floored like the hours: 36 hours late is 1 day, not 2.
    // Mutation caught: Math.round, which said 2.
    expect(returnCell('h36').textContent).toBe('Overdue by 1 day');
    expect(returnCell('h60').textContent).toBe('Overdue by 2 days');
  });

  it('not yet due: as before', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Fri Sep 25 2026, 10:00 AM PDT.
      vi.setSystemTime(Date.parse('2026-09-25T17:00:00.000Z'));
      render(
        <RentalsListTable
          rentals={[
            rental('soon', { expected_return_at: new Date(Date.now() + 2 * HOUR).toISOString() }),
            rental('later', {
              expected_return_at: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
            }),
          ]}
          viewerRole="staff"
          timeZone={PT}
        />,
      );
      expect(returnCell('soon').textContent).toBe('Due today');
      expect(statusCell('soon').textContent).toBe('Out');
      expect(returnCell('later').textContent).toBe('Due in 3 days');
    } finally {
      vi.useRealTimers();
    }
  });
});

// Review 2026-09-26: "Due today" meant "due within about 12 hours" (the hours
// rounded to days), not the day the detail page prints the expected return
// on. Mutation caught: Math.round(diffMs / DAY_MS), which says "Due today" at
// 9 PM for a rental due at 8 AM tomorrow, and "Due in 1 day" at 8 AM for one
// due at 11 PM that day.
describe("RentalsListTable due label counts calendar days in the organization's zone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function labelAt(nowIso: string, dueIso: string, timeZone: string): string {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(nowIso));
    const { unmount } = render(
      <RentalsListTable
        rentals={[rental('cal', { expected_return_at: dueIso })]}
        viewerRole="staff"
        timeZone={timeZone}
      />,
    );
    const text = returnCell('cal').textContent ?? '';
    unmount();
    return text;
  }

  it('9 PM, due 8 AM tomorrow: due in 1 day, not today', () => {
    // Thu Sep 24 9:00 PM PDT; due Fri Sep 25 8:00 AM PDT (11 hours ahead).
    expect(labelAt('2026-09-25T04:00:00.000Z', '2026-09-25T15:00:00.000Z', PT)).toBe(
      'Due in 1 day',
    );
  });

  it('8 AM, due 11 PM the same day: due today', () => {
    // Fri Sep 25 8:00 AM PDT; due Fri Sep 25 11:00 PM PDT (15 hours ahead).
    expect(labelAt('2026-09-25T15:00:00.000Z', '2026-09-26T06:00:00.000Z', PT)).toBe('Due today');
  });

  it("the day is the organization's, not the server's or the browser's", () => {
    // The same two instants are one calendar day apart in Los Angeles and the
    // same day in UTC.
    expect(labelAt('2026-09-25T04:00:00.000Z', '2026-09-25T15:00:00.000Z', 'UTC')).toBe(
      'Due today',
    );
    // Due just after midnight PDT tomorrow, 1 hour ahead: tomorrow.
    expect(labelAt('2026-09-25T06:30:00.000Z', '2026-09-25T07:30:00.000Z', PT)).toBe(
      'Due in 1 day',
    );
  });

  it('counts calendar days across a clock change', () => {
    // Sat Mar 7 2026 noon PST to Mon Mar 9 noon PDT: 47 hours (the clocks go
    // forward on Mar 8), two days.
    expect(labelAt('2026-03-07T20:00:00.000Z', '2026-03-09T19:00:00.000Z', PT)).toBe(
      'Due in 2 days',
    );
    // Sat Oct 31 noon PDT to Mon Nov 2 noon PST: 49 hours, two days.
    expect(labelAt('2026-10-31T19:00:00.000Z', '2026-11-02T20:00:00.000Z', PT)).toBe(
      'Due in 2 days',
    );
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
    const ui = <RentalsListTable rentals={rows} viewerRole="staff" timeZone={PT} />;
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
        timeZone={PT}
      />,
    );
    const tags = screen.getAllByTestId('borrower-kind');
    expect(tags.map((t) => t.textContent)).toEqual([RENTAL_BORROWER_TEAM_MEMBER]);
    expect(RENTAL_BORROWER_TEAM_MEMBER).toBe('Team member');
    expect(screen.queryByText('(member)')).toBeNull();
    expect(screen.getByText('Borrower m').closest('td')!.textContent).toContain('Team member');
  });
});

// Redesign P4.D1: the table in the redesign's look. The Items and Checked out
// columns still hide at narrow widths (below sm and md); their facts now ride
// as lines under the borrower's name at exactly those widths, so nothing is
// lost on a phone (brief section 10) and nothing is read twice on a desktop.
describe('RentalsListTable at narrow widths and empty', () => {
  it('the hidden columns have a stacked line under the borrower, hidden where the column shows', () => {
    render(
      <RentalsListTable
        rentals={[
          rental('two', {
            lines: [
              { id: 'l1', rental_id: 'two', item_id: 'i1', quantity: 2, notes: null },
              { id: 'l2', rental_id: 'two', item_id: 'i2', quantity: 1, notes: null },
            ],
          }),
        ]}
        viewerRole="staff"
        timeZone={PT}
        itemNames={new Map([['i1', 'Event tent']])}
      />,
    );
    const borrowerCell = screen.getByText('Borrower two').closest('td')!;
    const items = within(borrowerCell).getByTestId('rental-items-narrow');
    expect(items.textContent).toBe('Event tent + 1 more');
    expect(items.className).toMatch(/(^|\s)sm:hidden(\s|$)/);
    const checkedOut = within(borrowerCell).getByTestId('rental-checked-out-narrow');
    expect(checkedOut.className).toMatch(/(^|\s)md:hidden(\s|$)/);

    // The columns themselves are unchanged: same order, same breakpoints.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Borrower', 'Items', 'Checked out', 'Return', 'Status', 'Actions']);
    const row = borrowerCell.closest('tr')!;
    const cells = row.querySelectorAll('td');
    expect(cells[1]!.className).toMatch(/hidden sm:table-cell/);
    expect(cells[2]!.className).toMatch(/md:table-cell/);
    expect(cells[1]!.textContent).toBe('Event tent + 1 more');
    // The same relative time the Checked out column prints.
    expect(cells[2]!.textContent).not.toBe('');
    expect(checkedOut.textContent).toBe(`Checked out ${cells[2]!.textContent}`);
  });

  it('row actions keep their gates and words, 8 px apart for the touch rule', () => {
    render(<RentalsListTable rentals={[rental('a')]} viewerRole="manager" timeZone={PT} />);
    const view = screen.getByRole('link', { name: 'View' });
    expect(view.getAttribute('href')).toBe('/dashboard/rentals/a');
    expect(screen.getByRole('button', { name: 'Mark returned' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel…' })).toBeTruthy();
    expect(view.parentElement!.className).toMatch(/(^|\s)gap-2(\s|$)/);
  });

  // Review finding (P4.D1, MEDIUM): with the reading widths below sm the
  // table scrolls inside its card, and the Actions column used to start past
  // the card's right edge on a 390 px phone. It is pinned to that edge below
  // sm (header and every cell), on the card's fill with a divider, and follows
  // the row hover; from sm up nothing is pinned.
  it('below sm the Actions header and cells stay pinned to the right edge', () => {
    render(<RentalsListTable rentals={[rental('a')]} viewerRole="manager" timeZone={PT} />);
    const pinned = [
      'max-sm:sticky',
      'max-sm:right-0',
      'max-sm:bg-card',
      'max-sm:shadow-[inset_1px_0_0_var(--color-border)]',
    ];
    const header = screen.getByRole('columnheader', { name: 'Actions' });
    const cell = screen.getByRole('link', { name: 'View' }).closest('td')!;
    for (const el of [header, cell]) {
      const classes = el.className.split(/\s+/);
      for (const c of pinned) expect(classes).toContain(c);
      // Never pinned from sm up.
      expect(classes.some((c) => /^(sm:|md:|lg:)?sticky$/.test(c))).toBe(false);
    }
    expect(cell.className.split(/\s+/)).toContain('max-sm:group-hover:bg-muted');
    expect(cell.closest('tr')!.className.split(/\s+/)).toContain('group');
    // Every control stays inside the pinned cell.
    expect(within(cell).getByRole('button', { name: 'Mark returned' })).toBeTruthy();
    expect(within(cell).getByRole('button', { name: 'Cancel…' })).toBeTruthy();
    // The other columns are not pinned.
    for (const name of ['Borrower', 'Return', 'Status']) {
      expect(screen.getByRole('columnheader', { name }).className).not.toMatch(/sticky/);
    }
  });

  it('a viewer sees View only (static role defaults, unchanged)', () => {
    render(<RentalsListTable rentals={[rental('a')]} viewerRole="viewer" timeZone={PT} />);
    expect(screen.getByRole('link', { name: 'View' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark returned' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel…' })).toBeNull();
  });

  it('no rows: the one message for every tab, in the shared state panel', () => {
    render(<RentalsListTable rentals={[]} viewerRole="staff" timeZone={PT} />);
    const message = screen.getByText('No rentals found for this filter.');
    expect(message.closest('[data-slot="state-panel"]')?.getAttribute('data-state-kind')).toBe(
      'empty',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});
