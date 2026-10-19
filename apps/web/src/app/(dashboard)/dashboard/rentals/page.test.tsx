import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rentals list's reminder marks (2026-09-25). Every OVERDUE row carries a
 * small, true mark about its overdue reminder: sent (with the date), no email
 * on file, reminders off, or when it goes out. The page decides them on the
 * server with the daily sweep's own rule and the organization's zone, and
 * hands the client table plain text.
 */

const list = vi.fn();
const overdueRemindersOn = vi.fn(async (): Promise<boolean | null> => true);
const orgRow = vi.fn(async (): Promise<{ timezone: string | null } | null> => ({
  timezone: 'America/Los_Angeles',
}));
const tableProps = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      prefetch: _prefetch,
      scroll: _scroll,
      replace: _replace,
      ...rest
    }: {
      href: string;
      children: React.ReactNode;
      prefetch?: unknown;
      scroll?: unknown;
      replace?: unknown;
    } & Record<string, unknown>) => React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: false })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({ ModuleNotEnabled: () => null }));
vi.mock('@/components/rentals/rentals-tabs', () => ({ RentalsTabs: () => null }));
vi.mock('@/components/rentals/rentals-list-table', () => ({
  RentalsListTable: (props: Record<string, unknown>) => {
    tableProps(props);
    return null;
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'staff',
    permissions: new Set(['rentals:read', 'rentals:create']),
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({ getOrgRowForRequest: () => orgRow() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ byIds: vi.fn(async () => []) })) },
}));
vi.mock('@/server/services/rentals', () => ({
  RentalsService: { forCurrentUser: vi.fn(async () => ({ list, overdueRemindersOn })) },
}));

import RentalsPage from './page';

const DAY = 24 * 60 * 60 * 1000;

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: 'out',
    borrower_name: `Borrower ${id}`,
    borrower_user_id: null,
    borrower_email: 'sam@school.org',
    checked_out_at: new Date(Date.now() - 10 * DAY).toISOString(),
    expected_return_at: new Date(Date.now() - 2 * DAY).toISOString(),
    returned_at: null,
    overdue_reminder_sent_at: null,
    lines: [],
    ...over,
  };
}

async function marks(): Promise<Record<string, string>> {
  render(await RentalsPage({ searchParams: Promise.resolve({ status: 'all' }) }));
  return (tableProps.mock.calls.at(-1)?.[0] as { reminderMarks: Record<string, string> })
    .reminderMarks;
}

beforeEach(() => {
  vi.clearAllMocks();
  overdueRemindersOn.mockResolvedValue(true);
  orgRow.mockResolvedValue({ timezone: 'America/Los_Angeles' });
});

describe('rentals list: reminder marks on overdue rows', () => {
  it('sent, no email, and not-yet-sent overdue rows each get their mark; others get none', async () => {
    list.mockResolvedValue({
      rentals: [
        row('sent', { overdue_reminder_sent_at: '2026-09-20T15:00:03.000Z' }),
        row('no-email', { borrower_email: null }),
        row('waiting'),
        row('not-overdue', { expected_return_at: new Date(Date.now() + 3 * DAY).toISOString() }),
        row('returned', { status: 'returned', returned_at: new Date().toISOString() }),
      ],
    });
    const m = await marks();
    expect(m.sent).toBe('Reminder sent Sep 20');
    expect(m['no-email']).toBe('No email on file');
    expect(m.waiting).toMatch(/^Reminder goes out [A-Z][a-z]{2} \d{1,2}$/);
    expect(m['not-overdue']).toBeUndefined();
    expect(m.returned).toBeUndefined();
    expect(list).toHaveBeenCalledWith({ status: 'all' });
  });

  it('with Rentals switched off: "Reminders off", except where one was already sent or no email is on file', async () => {
    overdueRemindersOn.mockResolvedValue(false);
    list.mockResolvedValue({
      rentals: [
        row('waiting'),
        row('sent', { overdue_reminder_sent_at: '2026-09-20T15:00:03.000Z' }),
        row('no-email', { borrower_email: '' }),
      ],
    });
    const m = await marks();
    expect(m).toEqual({
      waiting: 'Reminders off',
      sent: 'Reminder sent Sep 20',
      'no-email': 'No email on file',
    });
  });

  it('an unreadable switch: no guess for the undecided rows', async () => {
    overdueRemindersOn.mockResolvedValue(null);
    list.mockResolvedValue({
      rentals: [row('waiting'), row('no-email', { borrower_email: null })],
    });
    const m = await marks();
    expect(m).toEqual({ 'no-email': 'No email on file' });
  });

  it('dates the mark in the organization zone', async () => {
    orgRow.mockResolvedValue({ timezone: 'Asia/Tokyo' });
    list.mockResolvedValue({
      // Sep 20 at 20:00 UTC is Sep 21 in Tokyo.
      rentals: [row('sent', { overdue_reminder_sent_at: '2026-09-20T20:00:00.000Z' })],
    });
    expect((await marks()).sent).toBe('Reminder sent Sep 21');
  });
});

// Redesign P4.D1: the page header and the status views. The same five links
// and default, now a navigation named "Filter by status" with aria-current on
// the open view (the cycle counts list's strip); no counts are read.
describe('rentals list: header and status views', () => {
  beforeEach(() => list.mockResolvedValue({ rentals: [] }));

  it('one h1, the subline and the gated + New rental', async () => {
    render(await RentalsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getAllByRole('heading', { level: 1 }).map((x) => x.textContent)).toEqual([
      'Rentals',
    ]);
    expect(
      screen.getByText('Track items checked out to staff, vendors, and event coordinators.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: '+ New rental' }).getAttribute('href')).toBe(
      '/dashboard/rentals/new',
    );
  });

  it('the five status links, Out by default, the open one current', async () => {
    render(await RentalsPage({ searchParams: Promise.resolve({}) }));
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Out', '/dashboard/rentals?status=out'],
      ['Overdue', '/dashboard/rentals?status=overdue'],
      ['Returned', '/dashboard/rentals?status=returned'],
      ['Cancelled', '/dashboard/rentals?status=cancelled'],
      ['All', '/dashboard/rentals?status=all'],
    ]);
    expect(
      links.filter((l) => l.getAttribute('aria-current') === 'page').map((l) => l.textContent),
    ).toEqual(['Out']);
    expect(list).toHaveBeenCalledWith({ status: 'out' });
  });

  it('an invalid status falls back to Out; a valid one is current', async () => {
    render(await RentalsPage({ searchParams: Promise.resolve({ status: 'nope' }) }));
    expect(list).toHaveBeenLastCalledWith({ status: 'out' });
    document.body.innerHTML = '';
    render(await RentalsPage({ searchParams: Promise.resolve({ status: 'overdue' }) }));
    const nav = screen.getByRole('navigation', { name: 'Filter by status' });
    expect(within(nav).getByRole('link', { name: 'Overdue' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(list).toHaveBeenLastCalledWith({ status: 'overdue' });
  });
});
