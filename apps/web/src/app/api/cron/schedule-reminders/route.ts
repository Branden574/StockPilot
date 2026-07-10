import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { sendEmail } from '@/lib/email/resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { createNotification } from '@/server/services/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Schedule reminders (every 10 min, vercel.json). Two windows per event:
 *   T-24h — event starts within the next 24h and reminded_24h_at is null
 *   T-1h  — event starts within the next 60min and reminded_1h_at is null
 * Recipients: the event's assigned_user_id (if any) + org owners/admins/
 * managers (deduped). Each gets an in-app notification (createNotification
 * ALSO fans out Expo push — never call notifyUser on top, that double-pushes)
 * and an email resolved via user_profiles.email.
 *
 * Dedupe by stamping reminded_*_at BEFORE sending (crash-safe direction:
 * losing one reminder beats spamming on retry loops). FAIL-OPEN per event.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = Date.now();
  const in1h = new Date(now + 60 * 60 * 1000).toISOString();
  const in24h = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();

  type EventRow = {
    id: string;
    organization_id: string;
    title: string;
    starts_at: string;
    location_text: string | null;
    warehouse_id: string | null;
    assigned_user_id: string | null;
    reminded_24h_at: string | null;
    reminded_1h_at: string | null;
  };

  const { data, error } = await admin
    .from('schedule_events')
    .select(
      'id, organization_id, title, starts_at, location_text, warehouse_id, assigned_user_id, reminded_24h_at, reminded_1h_at',
    )
    .eq('status', 'scheduled')
    .gte('starts_at', nowIso)
    .lte('starts_at', in24h)
    .limit(500);
  if (error) {
    void reportError(new Error(error.message), { tag: 'cron.schedule-reminders' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  let sent = 0;
  for (const ev of (data ?? []) as EventRow[]) {
    try {
      const isOneHour = ev.starts_at <= in1h && !ev.reminded_1h_at;
      const isDayAhead = !isOneHour && !ev.reminded_24h_at;
      if (!isOneHour && !isDayAhead) continue;

      // Stamp FIRST (crash-safe dedupe), and only proceed if we won the write.
      const stamp = isOneHour ? { reminded_1h_at: nowIso } : { reminded_24h_at: nowIso };
      const guard = isOneHour ? 'reminded_1h_at' : 'reminded_24h_at';
      const { data: stamped } = await admin
        .from('schedule_events')
        .update(stamp)
        .eq('id', ev.id)
        .is(guard, null)
        .select('id')
        .maybeSingle();
      if (!stamped) continue; // another run beat us

      // Recipients: assignee + org managers, deduped.
      const { data: mgrs } = await admin
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', ev.organization_id)
        .in('role', ['owner', 'admin', 'manager'])
        .not('accepted_at', 'is', null);
      const userIds = new Set<string>((mgrs ?? []).map((m) => m.user_id as string));
      if (ev.assigned_user_id) userIds.add(ev.assigned_user_id);
      if (userIds.size === 0) continue;

      const when = new Date(ev.starts_at).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
      });
      const horizon = isOneHour ? 'in 1 hour' : 'tomorrow';
      const title = `Reminder: ${ev.title} — ${horizon}`;
      const body = `${when}${ev.location_text ? ` · ${ev.location_text}` : ''}`;
      const link = `/dashboard/schedule/${ev.id}`;

      // Emails need addresses; one batch lookup for all recipients.
      const { data: profiles } = await admin
        .from('user_profiles')
        .select('id, email')
        .in('id', [...userIds]);
      const emailById = new Map(
        ((profiles ?? []) as { id: string; email: string | null }[]).map((p) => [p.id, p.email]),
      );

      for (const uid of userIds) {
        // In-app + push in one call.
        await createNotification({
          organizationId: ev.organization_id,
          userId: uid,
          type: 'schedule_reminder',
          title,
          body,
          link,
          metadata: { scheduleEventId: ev.id, horizon: isOneHour ? '1h' : '24h' },
        });
        const email = emailById.get(uid);
        if (email) {
          await sendEmail({
            to: email,
            subject: title,
            text: `${title}\n${body}\n\n${env.NEXT_PUBLIC_APP_URL}${link}`,
            html: `<p><strong>${title}</strong></p><p>${body}</p><p><a href="${env.NEXT_PUBLIC_APP_URL}${link}">Open the event</a></p>`,
          });
        }
      }
      sent++;
    } catch (e) {
      void reportError(e, { tag: 'cron.schedule-reminders', extra: { eventId: ev.id } });
    }
  }

  return NextResponse.json({ ok: true, remindersSent: sent });
}
