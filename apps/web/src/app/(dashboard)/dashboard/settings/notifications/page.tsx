import Link from 'next/link';

import { DesktopNotificationsOptIn } from '@/components/settings/desktop-notifications-opt-in';
import { DigestControls } from '@/components/settings/digest-controls';
import { NotificationPreferencesForm } from '@/components/settings/notification-preferences-form';
import { NotificationSoundToggle } from '@/components/settings/notification-sound-toggle';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { requireOrgContext, requireSession } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { digestScheduleLabel, digestSendAt } from '@/lib/email/es/families/digest';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import { loadNotificationPreferences } from '@/server/actions/notification-preferences';

export default async function NotificationsSettingsPage() {
  const session = await requireSession();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select(
      'email_digest_optin, digest_section_low_stock, digest_section_open_pos, digest_section_cycle_counts',
    )
    .eq('id', session.userId)
    .maybeSingle();

  const p = profile as {
    email_digest_optin?: boolean;
    digest_section_low_stock?: boolean;
    digest_section_open_pos?: boolean;
    digest_section_cycle_counts?: boolean;
  } | null;

  const optIn = Boolean(p?.email_digest_optin ?? false);
  const sections = {
    lowStock: p?.digest_section_low_stock ?? true,
    openPos: p?.digest_section_open_pos ?? true,
    cycleCounts: p?.digest_section_cycle_counts ?? true,
  };

  // Per-event email + push toggles. Defaults to "all on" when the
  // notification_preferences row hasn't been written yet (matches the
  // table's column defaults).
  const prefs = await loadNotificationPreferences();

  // When the digest goes out, in the organization's zone: the weekly-digest
  // cron runs at 14:00 UTC on Mondays for every organization (vercel.json),
  // which is Monday morning in US zones, 2:00 PM on UTC and Tuesday from
  // UTC+10 east, so the card says the time instead of "Monday morning". The
  // words are the email footer's (digestScheduleLabel, for the next run). The
  // zone is the request-cached org row the dashboard layout has already read;
  // an unreadable row reads as the documented default zone, as the email's
  // does, and is reported.
  const ctx = await requireOrgContext();
  const digestSchedule = await getOrgRowForRequest(ctx.organizationId)
    .then((org) => digestScheduleLabel(org?.timezone, digestSendAt(new Date(), 'next')))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'settings.notifications.org_timezone_failed', level: 'warning' });
      return digestScheduleLabel(null, digestSendAt(new Date(), 'next'));
    });

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Control which emails and in-app notifications StockPilot sends you.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Desktop notifications</CardTitle>
            <CardDescription>
              Get a pop-up from your operating system when something happens
              in StockPilot while this tab isn&apos;t focused. Stored
              per-device — enable separately on each browser you use.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DesktopNotificationsOptIn />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notification sound</CardTitle>
            <CardDescription>
              A short chime plays whenever an in-app notification toast
              appears. Stored per-device so a noisy workstation can mute
              without affecting your phone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NotificationSoundToggle />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-event notifications</CardTitle>
            <CardDescription>
              Granular control over each event StockPilot can email or push
              you about.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NotificationPreferencesForm initial={prefs} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Weekly inventory digest</CardTitle>
            <CardDescription>
              One email per week summarizing what needs attention.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DigestControls
              initialOptIn={optIn}
              initialSections={sections}
              scheduleLabel={digestSchedule}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
