import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_PREF_KEYS, type NotificationPreferences } from '@/lib/notification-prefs';

import { MAINTENANCE_STATUS_LABELS } from '@stockpilot/core';

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

/**
 * B45: the hint said the reminder came when you opened an email draft for a
 * maintenance request "but StockPilot cannot confirm send". The only sender,
 * the daily maintenance-draft-reminders cron, reminds the person who saved a
 * request once, a day or more after saving, while the request still reads
 * Saved; a recorded open (Email draft opened) rules it out for good, and
 * StockPilot never observes a send.
 */
describe('Maintenance draft reminders says when the reminder comes (B45)', () => {
  const HINT =
    'One in-app reminder to open the email draft for a maintenance request you saved, if the request still reads Saved a day or more later.';

  it('the row shows the new words', () => {
    render(<NotificationPreferencesForm initial={allOnPrefs()} />);
    const row = screen.getByText('Maintenance draft reminders').closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText(HINT)).toBeInTheDocument();
    expect(
      within(row!).getByRole('switch', { name: 'Toggle Maintenance draft reminders' }),
    ).toBeInTheDocument();
    expect(screen.getByText('In-app notifications').closest('section')).toContainElement(row);
  });

  it('the old claim cannot come back', () => {
    const { container } = render(<NotificationPreferencesForm initial={allOnPrefs()} />);
    expect(container).not.toHaveTextContent(/you opened an email draft|confirm send/i);
  });

  // The hint restates the cron's rule. If this fails, re-read the Maintenance
  // draft reminders hint in notification-preferences-form.tsx before changing
  // this test.
  it("the words stay tied to the sender's rule", () => {
    expect(MAINTENANCE_STATUS_LABELS.saved).toBe('Saved');
    const cron = readFileSync(
      resolve(__dirname, '../../app/api/cron/maintenance-draft-reminders/route.ts'),
      'utf8',
    );
    for (const line of [
      'const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();',
      ".eq('status', 'saved')",
      ".lt('created_at', cutoffIso)",
      ".is('draft_reminder_sent_at', null)",
      '.update({ draft_reminder_sent_at: nowIso })',
      'userId: row.requester_user_id,',
      ".select('push_maintenance_draft_reminder')",
      'await createNotification({',
    ]) {
      expect(cron).toContain(line);
    }
  });
});
