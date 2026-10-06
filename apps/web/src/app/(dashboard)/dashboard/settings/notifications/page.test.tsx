import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The weekly digest card's send time, worked out on the server from the
 * organization's zone (the request-cached org row the dashboard layout has
 * already read) with the email footer's own helpers: digestSendAt(now,
 * 'next') and digestScheduleLabel. The cron runs at 14:00 UTC on Mondays for
 * every organization, so the words differ by zone, and in Pacific by season.
 */

const getOrgRowForRequest = vi.fn();
const reportError = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/digest', () => ({
  sendDigestPreviewAction: vi.fn(),
  setDigestPrefsAction: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({ userId: 'u1' })),
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'staff' })),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              email_digest_optin: true,
              digest_section_low_stock: true,
              digest_section_open_pos: true,
              digest_section_cycle_counts: true,
            },
            error: null,
          }),
        }),
      }),
    }),
  })),
}));
vi.mock('@/server/actions/notification-preferences', () => ({
  loadNotificationPreferences: vi.fn(async () => ({})),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: (...args: unknown[]) => getOrgRowForRequest(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/components/settings/desktop-notifications-opt-in', () => ({
  DesktopNotificationsOptIn: () => null,
}));
vi.mock('@/components/settings/notification-preferences-form', () => ({
  NotificationPreferencesForm: () => null,
}));
vi.mock('@/components/settings/notification-sound-toggle', () => ({
  NotificationSoundToggle: () => null,
}));

import NotificationsSettingsPage from './page';

async function digestLineAt(at: string): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  try {
    render(await NotificationsSettingsPage());
  } finally {
    vi.useRealTimers();
  }
  return screen.getByText(/^Sent /).textContent ?? '';
}

describe("the notifications page states the digest's send time in the organization's zone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  // A Tuesday: the next run is Monday Oct 12, 14:00 UTC.
  const OCT_6 = '2026-10-06T12:00:00Z';

  it('a Pacific organization in October: Mondays at 7:00 AM PDT', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    expect(await digestLineAt(OCT_6)).toMatch(
      /^Sent Mondays at 7:00 AM PDT, in your workspace's time zone\./,
    );
    expect(getOrgRowForRequest).toHaveBeenCalledWith('org-1');
  });

  it('a Pacific organization in December: Mondays at 6:00 AM PST', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    expect(await digestLineAt('2026-12-01T12:00:00Z')).toMatch(/^Sent Mondays at 6:00 AM PST,/);
  });

  it('an organization on UTC: Mondays at 2:00 PM UTC', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'UTC' });
    expect(await digestLineAt(OCT_6)).toMatch(/^Sent Mondays at 2:00 PM UTC,/);
  });

  it('an organization in Sydney: Tuesdays at 1:00 AM, the day it arrives there', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'Australia/Sydney' });
    expect(await digestLineAt(OCT_6)).toMatch(/^Sent Tuesdays at 1:00 AM \S+,/);
  });

  it('an unreadable organization row: the documented default zone (Pacific), reported', async () => {
    getOrgRowForRequest.mockRejectedValue(new Error('getOrgRowForRequest: boom'));
    expect(await digestLineAt(OCT_6)).toMatch(/^Sent Mondays at 7:00 AM PDT,/);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'settings.notifications.org_timezone_failed' }),
    );
  });
});
