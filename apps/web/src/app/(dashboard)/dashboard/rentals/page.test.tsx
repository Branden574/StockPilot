import { render } from '@testing-library/react';
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
const orgRow = vi.fn(async (): Promise<{ timezone: string | null } | null> => ({ timezone: 'America/Los_Angeles' }));
const tableProps = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
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
  return (tableProps.mock.calls.at(-1)?.[0] as { reminderMarks: Record<string, string> }).reminderMarks;
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
    list.mockResolvedValue({ rentals: [row('waiting'), row('no-email', { borrower_email: null })] });
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
