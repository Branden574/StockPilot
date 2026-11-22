import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import type { OrganizationSignInAlert } from '@/server/services/sign-in-alerts';

/**
 * Sign-in alerts (dashboard/settings/security/sign-ins), part 3: owners and
 * admins only, asked in the order Blocked activity asks it: the authenticator
 * gate first, then the role, before anything is read. A member who owes an
 * authenticator is sent to set-up (or to the code page, with a factor); one
 * whose policy could not be read reaches "couldn't check your access"; a
 * manager, staff member or viewer past that is sent to Settings. A refusal
 * from the read itself goes to the Security page (or by its reason). The list
 * has When, Who, Device, Place, What and Answer, and names the device family.
 */

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  mfaRequired: false,
  mfaSatisfied: true,
  mfaEnrolled: false,
  policyUnread: false,
  forOrganization: vi.fn(),
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
  const { OrganizationRowUnavailableError: Unavailable } = await import(
    '@/lib/auth/organization-row-unavailable'
  );
  return {
    ServiceError: real.ServiceError,
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
// The read is replaced; the gate (assertMaySeeSignInAlerts) is the real one.
vi.mock('@/server/services/sign-in-alerts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/sign-in-alerts')>();
  return {
    SIGN_IN_ALERTS_ROW_LIMIT: real.SIGN_IN_ALERTS_ROW_LIMIT,
    assertMaySeeSignInAlerts: real.assertMaySeeSignInAlerts,
    SignInAlertsService: class {
      constructor(ctx: unknown) {
        h.constructed(ctx);
      }
      forOrganization() {
        return h.forOrganization();
      }
    },
  };
});

import { ServiceError } from '@/server/services/context';

import SignInAlertsPage from './page';

const ROWS: OrganizationSignInAlert[] = [
  {
    id: 'a1',
    userId: 'm1',
    fullName: 'Avery Example',
    email: 'avery@example.test',
    newDevice: true,
    newCountry: true,
    client: 'web',
    deviceFamily: 'Chrome on macOS',
    country: 'MX',
    city: 'Tijuana',
    status: 'not_me',
    resolvedAt: '2026-11-20T15:40:00Z',
    createdAt: '2026-11-20T15:30:00Z',
  },
  {
    id: 'a2',
    userId: 'm2',
    fullName: null,
    email: 'jordan@example.test',
    newDevice: true,
    newCountry: false,
    client: 'phone',
    deviceFamily: 'StockPilot app on iPhone',
    country: null,
    city: null,
    status: 'open',
    resolvedAt: null,
    createdAt: '2026-11-19T09:00:00Z',
  },
  {
    id: 'a3',
    userId: 'm1',
    fullName: 'Avery Example',
    email: 'avery@example.test',
    newDevice: false,
    newCountry: true,
    client: 'web',
    deviceFamily: 'Safari on macOS',
    country: 'BR',
    city: null,
    status: 'was_me',
    resolvedAt: '2026-11-18T08:05:00Z',
    createdAt: '2026-11-18T08:00:00Z',
  },
];

beforeEach(() => {
  h.role = 'admin';
  h.mfaRequired = false;
  h.mfaSatisfied = true;
  h.mfaEnrolled = false;
  h.policyUnread = false;
  h.forOrganization.mockReset();
  h.constructed.mockReset();
});

describe('who may see it', () => {
  it.each(['manager', 'staff', 'viewer'])('a %s is sent to Settings before anything is read', async (role) => {
    h.role = role;
    await expect(SignInAlertsPage()).rejects.toThrow(/^REDIRECT \/dashboard\/settings$/);
    expect(h.constructed).not.toHaveBeenCalled();
    expect(h.forOrganization).not.toHaveBeenCalled();
  });

  it.each(['manager', 'staff', 'admin', 'owner'])(
    'a %s who owes an authenticator is sent to set-up, before anything is read',
    async (role) => {
      h.role = role;
      h.mfaRequired = true;
      h.mfaSatisfied = false;
      await expect(SignInAlertsPage()).rejects.toThrow(/^REDIRECT \/dashboard\/settings\/security\?enroll=1$/);
      expect(h.constructed).not.toHaveBeenCalled();
    },
  );

  it.each(['manager', 'admin'])(
    'a %s with an authenticator whose session has not given its code is sent to the code page',
    async (role) => {
      h.role = role;
      h.mfaRequired = true;
      h.mfaSatisfied = false;
      h.mfaEnrolled = true;
      await expect(SignInAlertsPage()).rejects.toThrow(
        'REDIRECT /signin/mfa?redirect=/dashboard/settings/security/sign-ins',
      );
      expect(h.constructed).not.toHaveBeenCalled();
    },
  );

  it('a policy that could not be read reaches "couldn’t check your access", not Settings', async () => {
    h.role = 'manager';
    h.mfaRequired = true;
    h.mfaSatisfied = false;
    h.policyUnread = true;
    await expect(SignInAlertsPage()).rejects.toBeInstanceOf(OrganizationRowUnavailableError);
    expect(h.constructed).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, '/dashboard/settings/security'],
    ['mfa_required', '/dashboard/settings/security?enroll=1'],
    ['aal2_required', '/signin/mfa?redirect=/dashboard/settings/security/sign-ins'],
  ])('a refusal from the read (reason %s) goes to %s', async (reason, to) => {
    h.role = 'owner';
    h.forOrganization.mockRejectedValueOnce(
      new ServiceError('forbidden', 'refused', reason ? { reason } : undefined),
    );
    await expect(SignInAlertsPage()).rejects.toThrow(`REDIRECT ${to}`);
  });

  it('any other failure is not caught', async () => {
    h.forOrganization.mockRejectedValueOnce(new ServiceError('internal_error', 'x'));
    await expect(SignInAlertsPage()).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('what an owner or admin sees', () => {
  it.each(['owner', 'admin'])('a %s sees the list: When, Who, Device, Place, What, Answer', async (role) => {
    h.role = role;
    h.forOrganization.mockResolvedValueOnce(ROWS);
    render(await SignInAlertsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Sign-in alerts' })).toBeTruthy();
    const head = screen.getAllByRole('columnheader').map((c) => c.textContent);
    expect(head).toEqual(['When', 'Who', 'Device', 'Place', 'What', 'Answer']);
    const rows = screen.getAllByRole('row').slice(1);
    const cells = rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(cells).toEqual([
      [
        '2026-11-20T15:30:00Z',
        'Avery Exampleavery@example.test',
        'Chrome on macOSWebsite',
        'Tijuana, Mexico',
        'New device and new country',
        'Reported: not them',
      ],
      [
        '2026-11-19T09:00:00Z',
        'jordan@example.test',
        'StockPilot app on iPhoneMobile app',
        'Unknown',
        'New device',
        'No answer yet',
      ],
      [
        '2026-11-18T08:00:00Z',
        'Avery Exampleavery@example.test',
        'Safari on macOSWebsite',
        'Brazil',
        'New country',
        'Member confirmed',
      ],
    ]);
  });

  it('fewer alerts than the list can hold: it does not say any are left out', async () => {
    h.forOrganization.mockResolvedValueOnce(ROWS);
    render(await SignInAlertsPage());
    expect(screen.queryByText(/newest 500/)).toBeNull();
  });

  it('as many alerts as the list can hold: it says it shows the newest 500 only', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...ROWS[1]!, id: `row-${i}` }));
    h.forOrganization.mockResolvedValueOnce(many);
    render(await SignInAlertsPage());
    expect(screen.getAllByRole('row')).toHaveLength(501);
    expect(screen.getByText(/Showing the newest 500 alerts only\. Older ones are not listed here\./)).toBeTruthy();
  });

  it('nothing recorded: says so, with no table', async () => {
    h.forOrganization.mockResolvedValueOnce([]);
    render(await SignInAlertsPage());
    expect(screen.getByText('No sign-in alerts in the last 90 days.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
