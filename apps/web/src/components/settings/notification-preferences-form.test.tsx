import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_PREF_KEYS, type NotificationPreferences } from '@/lib/notification-prefs';

import { NotificationPreferencesForm } from './notification-preferences-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/server/actions/notification-preferences', () => ({
  updateNotificationPreferencesAction: vi.fn(async () => ({ ok: true, changed: 1 })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Every key defaults true — mirrors loadNotificationPreferences' own
 *  missing-row default (0 columns muted) so the toggle row renders "on". */
function allOnPrefs(): NotificationPreferences {
  return Object.fromEntries(NOTIFICATION_PREF_KEYS.map((k) => [k, true])) as NotificationPreferences;
}

describe('NotificationPreferencesForm — Maintenance Resolved (Task 4)', () => {
  it('NOTIFICATION_PREF_KEYS contains the literal push_maintenance_resolved key', () => {
    expect(NOTIFICATION_PREF_KEYS).toContain('push_maintenance_resolved');
  });

  it('renders a push-group toggle row with the literal label "Maintenance request resolved"', () => {
    render(<NotificationPreferencesForm initial={allOnPrefs()} />);
    expect(screen.getByText('Maintenance request resolved')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Toggle Maintenance request resolved' }),
    ).toBeInTheDocument();
  });

  it('the resolved toggle renders in the "In-app notifications" (push) group, not the email group', () => {
    render(<NotificationPreferencesForm initial={allOnPrefs()} />);
    const pushSection = screen.getByText('In-app notifications').closest('section');
    expect(pushSection).not.toBeNull();
    expect(pushSection).toHaveTextContent('Maintenance request resolved');
    const emailSection = screen.getByText('Email notifications').closest('section');
    expect(emailSection).not.toHaveTextContent('Maintenance request resolved');
  });

  it('reflects an explicit false in `initial` as an unchecked switch', () => {
    const prefs = allOnPrefs();
    prefs.push_maintenance_resolved = false;
    render(<NotificationPreferencesForm initial={prefs} />);
    expect(
      screen.getByRole('switch', { name: 'Toggle Maintenance request resolved' }),
    ).toHaveAttribute('aria-checked', 'false');
  });
});
