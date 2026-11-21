import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import type { SecurityActivity } from '@/server/services/security-events';

/**
 * Blocked activity (dashboard/settings/security/activity): owners and admins
 * only. A member who is not one is sent to Settings before anything is read;
 * a refusal from the service's own gate is sent to the Security page (or to
 * set-up, or to the code page, by its reason); a policy that could not be
 * read is never caught, so the dashboard shows its "couldn't check your
 * access" card. The page lists totals by kind for the last 7 days (a kind
 * with none is not shown) and the newest entries with when, what, where,
 * source and count; an entry that counts events past a cap has no place.
 */

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  activity: vi.fn(),
  constructed: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/components/admin/audit-time', async () => {
  const React = await import('react');
  return { AuditTime: ({ iso }: { iso: string }) => React.createElement('time', { dateTime: iso }, iso) };
});
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ServiceError: real.ServiceError,
    withContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: h.role })),
  };
});
vi.mock('@/server/services/security-events', () => ({
  SECURITY_ACTIVITY_ROW_LIMIT: 100,
  SECURITY_ACTIVITY_TOTALS_DAYS: 7,
  SecurityEventsService: class {
    constructor(ctx: unknown) {
      h.constructed(ctx);
    }
    activity() {
      return h.activity();
    }
  },
}));

import { ServiceError } from '@/server/services/context';

import BlockedActivityPage from './page';

const ACTIVITY: SecurityActivity = {
  totals: [
    { category: 'password_guessing', events: 1234 },
    { category: 'exploit', events: 2 },
  ],
  rows: [
    {
      id: 'r1',
      minute: '2026-11-20T10:15:00Z',
      lastSeenAt: '2026-11-20T10:15:42Z',
      category: 'password_guessing',
      outcome: 'blocked',
      reason: 'wrong_password',
      source: 'web',
      country: 'NL',
      city: 'Utrecht',
      count: 3,
    },
    {
      id: 'r2',
      minute: '2026-11-20T10:14:00Z',
      lastSeenAt: '2026-11-20T10:14:10Z',
      category: 'password_guessing',
      outcome: 'blocked',
      reason: 'wrong_code',
      source: 'phone',
      country: null,
      city: null,
      count: 1,
    },
    {
      id: 'r3',
      minute: '2026-11-20T10:13:00Z',
      lastSeenAt: '2026-11-20T10:13:59Z',
      category: 'password_guessing',
      outcome: 'blocked',
      reason: 'over_minute_cap',
      source: 'web',
      country: null,
      city: null,
      count: 4100,
    },
    {
      id: 'r4',
      minute: '2026-11-20T10:12:00Z',
      lastSeenAt: '2026-11-20T10:12:01Z',
      category: 'password_guessing',
      outcome: 'blocked',
      reason: 'a_reason_from_a_later_build',
      source: 'api',
      country: 'CA',
      city: null,
      count: 2,
    },
  ],
};

async function renderPage() {
  render(await BlockedActivityPage());
}

describe('who may see it', () => {
  it.each(['manager', 'staff', 'viewer'])('a %s is sent to Settings before anything is read', async (role) => {
    h.role = role;
    await expect(BlockedActivityPage()).rejects.toThrow('REDIRECT /dashboard/settings');
    expect(h.constructed).not.toHaveBeenCalled();
    expect(h.activity).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, '/dashboard/settings/security'],
    ['mfa_required', '/dashboard/settings/security?enroll=1'],
    ['aal2_required', '/signin/mfa?redirect=/dashboard/settings/security/activity'],
  ])('a refusal from the service (reason %s) goes to %s', async (reason, to) => {
    h.role = 'owner';
    h.activity.mockRejectedValueOnce(
      new ServiceError('forbidden', 'refused', reason ? { reason } : undefined),
    );
    await expect(BlockedActivityPage()).rejects.toThrow(`REDIRECT ${to}`);
  });

  it('a policy that could not be read is not caught: the dashboard shows "couldn’t check your access"', async () => {
    h.role = 'admin';
    h.activity.mockRejectedValueOnce(new OrganizationRowUnavailableError());
    await expect(BlockedActivityPage()).rejects.toBeInstanceOf(OrganizationRowUnavailableError);
  });

  it('any other failure is not caught either', async () => {
    h.role = 'admin';
    h.activity.mockRejectedValueOnce(new ServiceError('internal_error', 'x'));
    await expect(BlockedActivityPage()).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('what an owner or admin sees', () => {
  it('the title, the totals by kind (only kinds with events) and the table', async () => {
    h.role = 'admin';
    h.activity.mockResolvedValueOnce(ACTIVITY);
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Blocked activity' })).toBeTruthy();

    const totals = screen.getByRole('region', { name: 'Last 7 days' });
    expect(within(totals).getByText('Password guessing')).toBeTruthy();
    expect(within(totals).getByText('1,234')).toBeTruthy();
    expect(within(totals).getByText('Exploit attempts')).toBeTruthy();
    expect(within(totals).queryByText('Automated traffic')).toBeNull();
    expect(within(totals).queryByText('Phishing')).toBeNull();

    const rows = screen.getAllByRole('row').slice(1);
    const cells = rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(cells).toEqual([
      ['2026-11-20T10:15:42Z', 'Wrong password at sign-inPassword guessing · Blocked', 'Utrecht, NL', 'Website', '3'],
      ['2026-11-20T10:14:10Z', 'Wrong authenticator codePassword guessing · Blocked', 'Unknown place', 'Mobile app', '1'],
      ['2026-11-20T10:13:59Z', 'More events than could be listedPassword guessing · Blocked', '—', 'Website', '4,100'],
      ['2026-11-20T10:12:01Z', 'Other blocked activityPassword guessing · Blocked', 'CA', 'API', '2'],
    ]);
  });

  it('nothing recorded: says so, with no table', async () => {
    h.role = 'owner';
    h.activity.mockResolvedValueOnce({ totals: [], rows: [] });
    await renderPage();
    expect(screen.getByText('Nothing was blocked in the last 7 days.')).toBeTruthy();
    expect(screen.getByText('No blocked activity yet.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
