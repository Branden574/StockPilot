import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { resolveOrgTimezone } from '@stockpilot/core';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import {
  renderSchedHour,
  renderSchedTomorrow,
} from '@/lib/email/families/schedule';
import { sendEmail } from '@/lib/email/resend';
import { createAdminClient } from '@/lib/supabase/admin';
import { createNotification } from '@/server/services/notifications';

import type { ScheduleReminderParams } from '@/lib/email/families/schedule';

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
 * managers (deduped). Each gets an in-app notification; Expo push fans out
 * from the notifications AFTER INSERT trigger (mig 0028) — never send push
 * from code on top of the insert, that double-pushes (diagnosed 2026-07-14)
 * — and an email resolved via user_profiles.email.
 *
 * Dedupe by stamping reminded_*_at BEFORE sending (crash-safe direction:
 * losing one reminder beats spamming on retry loops). FAIL-OPEN per event.
 *
 * Emails render via the es-layer schedule family (sched-tmrw / sched-hour,
 * lib/email/families/schedule.ts) — this replaced the raw one-line
 * `<p><strong>` body. The dedupe stamps and recipient selection above are
 * unchanged; only the rendering + send envelope (schedule@ sender,
 * List-Unsubscribe header) moved into the family.
 */

/**
 * THE DISPLAY ZONE IS THE ORG'S, RESOLVED ONCE PER RUN AND THREADED THROUGH.
 *
 * It used to be a file-level `const DISPLAY_TZ = 'America/Los_Angeles'` (plus a
 * second hard-coded copy of the same string on the `when` label), written when
 * the only pilot org was Californian. `organizations.timezone` has existed
 * since 0001_init and is owner/admin-editable in Settings, so that constant was
 * a silent lie for any org that changed it: an event at 00:30 ET on the 25th is
 * 21:30 PT on the 24th, so the reminder named BOTH the wrong hour and the wrong
 * DAY — "today, 9:30 PM" for a delivery that is tomorrow at half past midnight.
 * A reminder that names the wrong day tells someone to stop looking for it
 * today, which is worse than sending nothing.
 *
 * The zone is now a PARAMETER on every helper rather than ambient state, which
 * keeps the invariant the old constant existed to protect: the day WORD and the
 * printed TIME cannot be computed against different zones, because one `tz`
 * value flows into all of them for a given event.
 *
 * Every read goes through `resolveOrgTimezone` (@stockpilot/core) — the ONE
 * expression of "what zone do we print when the org's zone did not arrive" —
 * so a missing org row or an unrecognised stored zone degrades to the
 * documented default instead of throwing a RangeError out of the send loop.
 */

/** Format one field of a date in the org display timezone. */
function tzPart(d: Date, opts: Intl.DateTimeFormatOptions, tz: string): string {
  return d.toLocaleString('en-US', { ...opts, timeZone: tz });
}

/** The calendar date in the display zone as YYYY-MM-DD. en-CA is used purely
 *  because it formats that way; nothing here is locale-facing. */
function tzDateKey(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * The word that goes after the em dash: "today", "tomorrow", or the weekday.
 *
 * THE BUG THIS REPLACES: the day-ahead reminder said 'tomorrow' unconditionally,
 * because the code assumed "inside the 24h window and more than an hour away"
 * meant tomorrow. It does not — an event at 2:30pm seen at 1:20pm is 70 minutes
 * away and squarely today. A delivery reminder that names the wrong day is
 * worse than none: it tells someone to prepare for the wrong shift.
 *
 * So the word is derived from CALENDAR DATES, not from an elapsed-time bucket.
 * Both keys are whole dates in the display zone, parsed at UTC midnight, so the
 * difference is whole days and a DST boundary cannot shift it.
 */
function dayWordFor(startsAt: Date, now: Date, tz: string): string {
  const nowKey = tzDateKey(now, tz);
  const startKey = tzDateKey(startsAt, tz);
  const days = Math.round(
    (Date.parse(`${startKey}T00:00:00Z`) - Date.parse(`${nowKey}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  // Unreachable through the 24h query window above, which can span at most one
  // calendar boundary. Named honestly rather than defaulted to a lie, so a
  // future caller with a wider window gets a true word instead of a wrong one.
  return tzPart(startsAt, { weekday: 'long' }, tz);
}
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
    ends_at: string | null;
    all_day: boolean | null;
    location_text: string | null;
    details: string | null;
    warehouse_id: string | null;
    assigned_user_id: string | null;
    reminded_24h_at: string | null;
    reminded_1h_at: string | null;
  };

  const { data, error } = await admin
    .from('schedule_events')
    .select(
      'id, organization_id, title, starts_at, ends_at, all_day, location_text, details, warehouse_id, assigned_user_id, reminded_24h_at, reminded_1h_at',
    )
    .eq('status', 'scheduled')
    .gte('starts_at', nowIso)
    .lte('starts_at', in24h)
    .limit(500);
  if (error) {
    void reportError(new Error(error.message), { tag: 'cron.schedule-reminders' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // One batched read of the display zone for every org in this run's events.
  // Batched rather than per-event because a single run can carry up to 500
  // events across many orgs; `.in()` on at most 500 distinct ids stays well
  // inside PostgREST's 1000-row clamp, so no pagination is needed here.
  // Read fails CLOSED to the documented default (see resolveOrgTimezone): a
  // missing row must degrade the printed zone, never skip the reminder.
  const events = (data ?? []) as EventRow[];
  const orgIds = [...new Set(events.map((e) => e.organization_id))];
  const tzByOrg = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs, error: orgErr } = await admin
      .from('organizations')
      .select('id, timezone')
      .in('id', orgIds);
    if (orgErr) {
      void reportError(new Error(orgErr.message), {
        tag: 'cron.schedule-reminders.org-timezone',
      });
    }
    for (const o of (orgs ?? []) as { id: string; timezone: string | null }[]) {
      tzByOrg.set(o.id, resolveOrgTimezone(o.timezone));
    }
  }

  let sent = 0;
  for (const ev of events) {
    try {
      const isOneHour = ev.starts_at <= in1h && !ev.reminded_1h_at;
      // 24h reminder is only meaningful BEFORE the 1h one. An event that
      // enters the system already inside the 1h window (or whose 1h notice
      // was sent) must never get a late "tomorrow" notice — the field bug
      // was 'in 1 hour' at 6:20 followed by 'tomorrow' at 6:30 for the
      // same event (owner-reported duplicate, 2026-07-11).
      const isDayAhead = !isOneHour && !ev.reminded_24h_at && !ev.reminded_1h_at;
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
        .not('accepted_at', 'is', null)
        // Real memberships, not act-as grants. Platform "act as" inserts a
        // REAL organization_members row (role owner, accepted_at stamped,
        // impersonation_expires_at set — services/platform/impersonation.ts),
        // which matched this query exactly, so for the life of the grant the
        // platform admin's personal account received the org's reminder push
        // AND email every 10 minutes. Ten sibling recipient queries
        // (daily-briefing, auto-reorder, recurring-pos, …) already filter it.
        .is('impersonation_expires_at', null);
      const userIds = new Set<string>((mgrs ?? []).map((m) => m.user_id as string));
      if (ev.assigned_user_id) userIds.add(ev.assigned_user_id);
      if (userIds.size === 0) continue;

      // ONE zone for this event's every label — see the block above tzPart.
      const tz = tzByOrg.get(ev.organization_id) ?? resolveOrgTimezone(null);
      const startsAt = new Date(ev.starts_at);
      const when = tzPart(
        startsAt,
        {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        },
        tz,
      );
      // The day-ahead word is COMPUTED, never assumed — see dayWordFor.
      const dayWord = dayWordFor(startsAt, new Date(now), tz);
      const horizon = isOneHour ? 'in 1 hour' : dayWord;
      const title = `Reminder: ${ev.title} — ${horizon}`;
      const body = `${when}${ev.location_text ? ` · ${ev.location_text}` : ''}`;
      const link = `/dashboard/schedule/${ev.id}`;

      // es-template merge labels, all in the SAME `tz` as `when` and the day
      // word above — one resolved zone per event, never a second copy.
      const startTime = tzPart(startsAt, { hour: 'numeric', minute: '2-digit' }, tz);
      const endTime = ev.ends_at
        ? tzPart(new Date(ev.ends_at), { hour: 'numeric', minute: '2-digit' }, tz)
        : null;
      const timeLabel = ev.all_day
        ? 'All day'
        : endTime
          ? `${startTime} – ${endTime}`
          : startTime;
      const appUrl = env.NEXT_PUBLIC_APP_URL;
      const settingsUrl = `${appUrl}/dashboard/settings/notifications`;
      const sharedParams = {
        eventTitle: ev.title,
        dayWord,
        month: tzPart(startsAt, { month: 'short' }, tz),
        day: tzPart(startsAt, { day: 'numeric' }, tz),
        dow: tzPart(startsAt, { weekday: 'short' }, tz),
        startTime,
        timeLabel,
        whenLabel: when,
        location: ev.location_text,
        details: ev.details,
        scheduleUrl: `${appUrl}${link}`,
        urls: { manage: settingsUrl, unsubscribe: settingsUrl, support: `${appUrl}/support` },
      } satisfies Omit<
        ScheduleReminderParams,
        'assignedToYou' | 'firstName' | 'recipientEmail'
      >;

      // Emails need addresses; one batch lookup for all recipients.
      // (full_name feeds the greeting only — recipient selection unchanged.)
      // disabled_at rides along on the SAME lookup: a disabled account must
      // get neither the push nor the email. createNotification refuses a
      // disabled recipient on its own (the single insert choke point), but
      // this loop ALSO calls sendEmail directly below, bypassing that
      // choke point entirely — so the check is repeated here, against data
      // already in hand, no extra round trip.
      const { data: profiles } = await admin
        .from('user_profiles')
        .select('id, email, full_name, disabled_at')
        .in('id', [...userIds]);
      const profileById = new Map(
        (
          (profiles ?? []) as {
            id: string;
            email: string | null;
            full_name: string | null;
            disabled_at: string | null;
          }[]
        ).map((p) => [p.id, p]),
      );
      // Per-user prefs (0258), house fail-open pattern: missing row or null
      // column = subscribed; only an explicit false opts out.
      const { data: prefRows } = await admin
        .from('notification_preferences')
        .select('user_id, email_schedule_reminders, push_schedule_reminders')
        .in('user_id', [...userIds]);
      const prefById = new Map(
        (
          (prefRows ?? []) as {
            user_id: string;
            email_schedule_reminders: boolean | null;
            push_schedule_reminders: boolean | null;
          }[]
        ).map((r) => [r.user_id, r]),
      );

      for (const uid of userIds) {
        const profile = profileById.get(uid);
        if (profile?.disabled_at) continue;
        const pref = prefById.get(uid);
        const wantsPush = pref?.push_schedule_reminders !== false;
        const wantsEmail = pref?.email_schedule_reminders !== false;
        if (!wantsPush && !wantsEmail) continue;
        // In-app + push in one call.
        if (wantsPush) {
          await createNotification({
            organizationId: ev.organization_id,
            userId: uid,
            type: 'schedule_reminder',
            title,
            body,
            link,
            metadata: { scheduleEventId: ev.id, horizon: isOneHour ? '1h' : '24h' },
          });
        }
        const email = profile?.email;
        if (email && wantsEmail) {
          const params: ScheduleReminderParams = {
            ...sharedParams,
            assignedToYou: uid === ev.assigned_user_id,
            firstName: (profile?.full_name ?? '').trim().split(/\s+/)[0] || null,
            recipientEmail: email,
          };
          const rendered = isOneHour
            ? renderSchedHour(params)
            : renderSchedTomorrow(params);
          // rendered.subject === `Reminder: ${ev.title} — ${horizon}` (the
          // registry subject builders reproduce the legacy subject exactly).
          await sendEmail({
            to: email,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            from: rendered.from,
            headers: rendered.headers,
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
