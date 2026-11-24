import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import type { SecurityActivity } from '@/server/services/security-events';

/**
 * Blocked activity (dashboard/settings/security/activity): owners and admins
 * only. The page asks in the service's own order: the authenticator gate
 * first, then the role. So a member who owes an authenticator is sent to
 * set-up (or to the code page, with a factor), and one whose policy could not
 * be read reaches the dashboard's "couldn't check your access" card, whatever
 * their role; only then is a member who is not an owner or admin sent to
 * Settings. All of that happens before anything is read. A refusal from the
 * service's own reads is sent to the Security page (or to set-up, or to the
 * code page, by its reason). The page lists totals by kind for the last 7
 * days (a kind with none is not shown) and the newest entries with when,
 * what, where, source and count; an entry that counts events past a cap has
 * no place.
 */

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  /** The authenticator gate's inputs, as the context carries them. */
  mfaRequired: false,
  mfaSatisfied: true,
  mfaEnrolled: false,
  /** The context was built from a policy that could not be read. */
  policyUnread: false,
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
  return {
    AuditTime: ({ iso }: { iso: string }) => React.createElement('time', { dateTime: iso }, iso),
  };
});
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  const { OrganizationRowUnavailableError: Unavailable } =
    await import('@/lib/auth/organization-row-unavailable');
  return {
    ServiceError: real.ServiceError,
    // The real gate error, and its real refusal for a policy that was not read.
    mfaGateError: (ctx: { mfaEnrolled: boolean }) => {
      if (h.policyUnread && !ctx.mfaEnrolled) throw new Unavailable();
      return real.mfaGateError(ctx);
    },
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'u1',
      role: h.role,
      mfaRequired: h.mfaRequired,
      mfaSatisfied: h.mfaSatisfied,
      mfaEnrolled: h.mfaEnrolled,
    })),
  };
});
// The service's reads are replaced; its gate (assertMaySeeSecurityActivity) is the real one.
vi.mock('@/server/services/security-events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/security-events')>();
  return {
    SECURITY_ACTIVITY_ROW_LIMIT: 100,
    SECURITY_ACTIVITY_TOTALS_DAYS: 7,
    assertMaySeeSecurityActivity: real.assertMaySeeSecurityActivity,
    SecurityEventsService: class {
      constructor(ctx: unknown) {
        h.constructed(ctx);
      }
      activity() {
        return h.activity();
      }
    },
  };
});

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

beforeEach(() => {
  h.role = 'admin';
  h.mfaRequired = false;
  h.mfaSatisfied = true;
  h.mfaEnrolled = false;
  h.policyUnread = false;
  h.activity.mockReset();
  h.constructed.mockReset();
});

describe('who may see it', () => {
  it.each(['manager', 'staff', 'viewer'])(
    'a %s is sent to Settings before anything is read',
    async (role) => {
      h.role = role;
      await expect(BlockedActivityPage()).rejects.toThrow('REDIRECT /dashboard/settings');
      expect(h.constructed).not.toHaveBeenCalled();
      expect(h.activity).not.toHaveBeenCalled();
    },
  );

  describe('the authenticator gate is asked before the role, as the service asks it', () => {
    it.each(['manager', 'staff', 'admin', 'owner'])(
      'a %s who owes an authenticator is sent to set-up, before anything is read',
      async (role) => {
        h.role = role;
        h.mfaRequired = true;
        h.mfaSatisfied = false;
        await expect(BlockedActivityPage()).rejects.toThrow(
          /^REDIRECT \/dashboard\/settings\/security\?enroll=1$/,
        );
        expect(h.constructed).not.toHaveBeenCalled();
        expect(h.activity).not.toHaveBeenCalled();
      },
    );

    it.each(['manager', 'admin'])(
      'a %s with an authenticator whose session has not given its code is sent to the code page',
      async (role) => {
        h.role = role;
        h.mfaRequired = true;
        h.mfaSatisfied = false;
        h.mfaEnrolled = true;
        await expect(BlockedActivityPage()).rejects.toThrow(
          'REDIRECT /signin/mfa?redirect=/dashboard/settings/security/activity',
        );
        expect(h.constructed).not.toHaveBeenCalled();
      },
    );

    it.each(['manager', 'admin'])(
      'a %s whose policy could not be read reaches "couldn’t check your access", not Settings',
      async (role) => {
        h.role = role;
        h.mfaRequired = true;
        h.mfaSatisfied = false;
        h.policyUnread = true;
        await expect(BlockedActivityPage()).rejects.toBeInstanceOf(OrganizationRowUnavailableError);
        expect(h.constructed).not.toHaveBeenCalled();
      },
    );

    it('a manager past the gate is still sent to Settings', async () => {
      h.role = 'manager';
      h.mfaRequired = true;
      h.mfaSatisfied = true;
      await expect(BlockedActivityPage()).rejects.toThrow(/^REDIRECT \/dashboard\/settings$/);
      expect(h.constructed).not.toHaveBeenCalled();
    });
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
    // The page also lists a wrong current password and a wrong set-up code,
    // which are not sign-in attempts: its one line says passwords and codes.
    expect(
      screen.getByText(
        'Wrong passwords and codes the app refused for the accounts in your organization. Kept for 90 days.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Sign-in attempts the app refused/)).toBeNull();

    const totals = screen.getByRole('region', { name: 'Last 7 days' });
    expect(within(totals).getByText('Password guessing')).toBeTruthy();
    expect(within(totals).getByText('1,234')).toBeTruthy();
    expect(within(totals).getByText('Exploit attempts')).toBeTruthy();
    expect(within(totals).queryByText('Automated traffic')).toBeNull();
    expect(within(totals).queryByText('Sign-in alert')).toBeNull();
    expect(within(totals).queryByText('Phishing')).toBeNull();

    const rows = screen.getAllByRole('row').slice(1);
    const cells = rows.map((r) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    );
    expect(cells).toEqual([
      [
        '2026-11-20T10:15:42Z',
        'Wrong password at sign-inPassword guessing · Blocked',
        'Utrecht, NL',
        'Website',
        '3',
      ],
      [
        '2026-11-20T10:14:10Z',
        'Wrong authenticator codePassword guessing · Blocked',
        'Unknown place',
        'Mobile app',
        '1',
      ],
      [
        '2026-11-20T10:13:59Z',
        'More events than could be listedPassword guessing · Blocked',
        '—',
        'Website',
        '4,100',
      ],
      [
        '2026-11-20T10:12:01Z',
        'Other blocked activityPassword guessing · Blocked',
        'CA',
        'API',
        '2',
      ],
    ]);
  });

  it('totals that could not be added up: one plain line in their place, and the table still shown', async () => {
    h.role = 'admin';
    h.activity.mockResolvedValueOnce({ ...ACTIVITY, totals: null });
    await renderPage();
    const totals = screen.getByRole('region', { name: 'Last 7 days' });
    expect(totals.textContent).toContain(
      'Totals are not available right now: there are too many events to add up.',
    );
    expect(within(totals).queryByText('Password guessing')).toBeNull();
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(4);
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
