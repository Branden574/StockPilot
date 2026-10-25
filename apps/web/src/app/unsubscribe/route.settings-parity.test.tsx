import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B15: the one-click link switches off THE switch the signed-in
 * Notifications page shows, not a look-alike column. One in-memory database
 * sits behind both the service-role client (the public route and its
 * service) and the session client (the settings page and its loaders): a
 * member's one-click POST runs through the real route, service and shared
 * writer, then the real settings page is rendered for that member.
 */

const envState = vi.hoisted(() => {
  const PARITY_ROUTE_VALUE = 'parity-route-' + 'v'.repeat(21);
  return { UNSUBSCRIBE_SECRET: PARITY_ROUTE_VALUE };
});
vi.mock('@/lib/env', () => ({ env: envState }));

const MEMBER = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-00000000c0c0';

type Row = Record<string, unknown>;

/** A small PostgREST-shaped client over in-memory tables: just the calls
 *  the route, the service, the shared writer and the settings page make. */
function makeDb(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op:
      | { kind: 'select' }
      | { kind: 'update'; patch: Row }
      | { kind: 'upsert'; row: Row; key: string }
      | { kind: 'insert'; rows: Row[] } = { kind: 'select' };
    const matching = () => rows.filter((r) => filters.every((f) => f(r)));
    const run = (): { data: unknown; error: null } => {
      if (op.kind === 'update') {
        for (const r of matching()) Object.assign(r, op.patch);
        return { data: null, error: null };
      }
      if (op.kind === 'upsert') {
        const { row, key } = op;
        const existing = rows.find((r) => r[key] === row[key]);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
        return { data: null, error: null };
      }
      if (op.kind === 'insert') {
        rows.push(...op.rows);
        return { data: null, error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
    };
    const builder = {
      select: () => builder,
      update: (patch: Row) => {
        op = { kind: 'update', patch };
        return builder;
      },
      upsert: (row: Row, opts: { onConflict: string }) => {
        op = { kind: 'upsert', row, key: opts.onConflict };
        return builder;
      },
      insert: (r: Row | Row[]) => {
        op = { kind: 'insert', rows: Array.isArray(r) ? r : [r] };
        return builder;
      },
      eq: (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      },
      is: (col: string, value: unknown) => {
        filters.push((r) => (r[col] ?? null) === value);
        return builder;
      },
      not: (col: string, operator: string, value: unknown) => {
        if (operator !== 'is') throw new Error(`fake db: not.${operator}`);
        filters.push((r) => (r[col] ?? null) !== value);
        return builder;
      },
      maybeSingle: async () => {
        const res = run();
        return { data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data, error: null };
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }
  return { from };
}

const dbHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => dbHolder.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => dbHolder.client }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({ userId: MEMBER })),
  requireOrgContext: vi.fn(async () => ({ organizationId: ORG, userId: MEMBER, role: 'staff' })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The digest card's buttons call these; nothing here presses them.
vi.mock('@/server/actions/digest', () => ({
  sendDigestPreviewAction: vi.fn(),
  setDigestPrefsAction: vi.fn(),
}));
vi.mock('@/components/settings/desktop-notifications-opt-in', () => ({
  DesktopNotificationsOptIn: () => null,
}));
vi.mock('@/components/settings/notification-sound-toggle', () => ({
  NotificationSoundToggle: () => null,
}));

import NotificationsSettingsPage from '@/app/(dashboard)/dashboard/settings/notifications/page';
import { mintMemberUnsubscribeToken } from '@/lib/email/member-unsubscribe';

import { POST } from './route';

function oneClick(kind: 'weekly_digest' | 'schedule_reminders') {
  // Built just now, as the cron would: well inside its 90 days.
  const link = mintMemberUnsubscribeToken(
    { userId: MEMBER, organizationId: ORG, kind },
    new Date(),
  )!;
  return new Request(`https://test.local/unsubscribe?m=${link}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }) as unknown as Parameters<typeof POST>[0];
}

async function renderSettings() {
  document.body.replaceChildren();
  render(await NotificationsSettingsPage());
  const emailGroup = screen
    .getByRole('heading', { name: 'Email notifications' })
    .closest('section')!;
  const pushGroup = screen
    .getByRole('heading', { name: 'In-app notifications' })
    .closest('section')!;
  const checked = (el: HTMLElement) => el.getAttribute('aria-checked');
  return {
    digest: checked(screen.getByRole('switch', { name: 'Toggle weekly digest' })),
    reminderEmails: checked(
      within(emailGroup).getByRole('switch', { name: 'Toggle Schedule reminders' }),
    ),
    reminderPush: checked(
      within(pushGroup).getByRole('switch', { name: 'Toggle Schedule reminders' }),
    ),
  };
}

describe('the one-click link turns off the switch the Notifications page shows', () => {
  beforeEach(() => {
    dbHolder.client = makeDb({
      organization_members: [
        {
          organization_id: ORG,
          user_id: MEMBER,
          role: 'staff',
          accepted_at: '2026-01-01T00:00:00Z',
          impersonation_expires_at: null,
        },
      ],
      user_profiles: [
        {
          id: MEMBER,
          email_digest_optin: true,
          digest_section_low_stock: true,
          digest_section_open_pos: true,
          digest_section_cycle_counts: true,
        },
      ],
      notification_preferences: [
        { user_id: MEMBER, email_schedule_reminders: true, push_schedule_reminders: true },
      ],
    });
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('the weekly digest link turns off "Email me a weekly inventory digest", and nothing else', async () => {
    expect(await renderSettings()).toEqual({
      digest: 'true',
      reminderEmails: 'true',
      reminderPush: 'true',
    });

    const res = await POST(oneClick('weekly_digest'));
    expect(res.status).toBe(200);

    expect(await renderSettings()).toEqual({
      digest: 'false',
      reminderEmails: 'true',
      reminderPush: 'true',
    });
  });

  it('the schedule reminders link turns off the email switch and leaves the in-app one on', async () => {
    const res = await POST(oneClick('schedule_reminders'));
    expect(res.status).toBe(200);

    expect(await renderSettings()).toEqual({
      digest: 'true',
      reminderEmails: 'false',
      reminderPush: 'true',
    });
  });
});
