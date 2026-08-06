import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { formatMaintenanceRequestNumber } from '@stockpilot/core';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
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
 * Unsent-draft reminder cron (Task 22; daily 16:00 UTC, vercel.json). A
 * maintenance request (0314) enters `status = 'saved'` the instant the
 * requester submits the form and only leaves it when they open the
 * generated email draft (-> 'draft_opened') or a manager archives/cancels
 * it. A request that sits in 'saved' for 24h means the requester never
 * opened the draft — this cron pings them once.
 *
 * Cloned from the schedule-reminders skeleton
 * (api/cron/schedule-reminders/route.ts:17-227): timingSafeEqual auth,
 * stamp-FIRST guarded-update dedupe, per-row try/catch, same response
 * shape ({ ok, remindersSent }).
 *
 * Eligibility: status = 'saved', created_at older than 24h,
 * draft_reminder_sent_at is null, not archived/cancelled. The `status`
 * enum and the `archived_at`/`cancelled_at` timestamps are always written
 * TOGETHER in the same update (archive()/cancel() in
 * server/services/maintenance-requests.ts), so `status = 'saved'` already
 * implies both timestamps are null — the extra `.is(...)` pair below is
 * belt-and-suspenders, matching the same double-guard 0314's own RLS
 * policies apply everywhere else on this table, not a distinct case the
 * status filter misses.
 *
 * Dedupe: stamp draft_reminder_sent_at FIRST (guarded on IS NULL), and
 * only notify when the stamp actually won the row — the 2026-07-11
 * duplicate-reminder bug guard from schedule-reminders, cloned here
 * (crash-safe direction: losing one reminder beats spamming on a retry).
 * The stamp always wins regardless of the pref gate below, so a muted
 * request is never re-evaluated on the next run either.
 *
 * Recipient: requester_user_id ONLY, gated by
 * push_maintenance_draft_reminder — fail-OPEN (0265 pattern): a missing
 * notification_preferences row or a null column still notifies; only an
 * explicit `false` mutes.
 *
 * Push rides the 0028 AFTER-INSERT trigger on public.notifications —
 * createNotification is the ONE insert path; this route never calls a
 * push/expo API directly.
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
  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  type EligibleRow = {
    id: string;
    organization_id: string;
    requester_user_id: string | null;
    request_number: number | null;
    created_at: string;
  };

  const { data, error } = await admin
    .from('maintenance_requests')
    .select('id, organization_id, requester_user_id, request_number, created_at')
    .eq('status', 'saved')
    .lt('created_at', cutoffIso)
    .is('draft_reminder_sent_at', null)
    .is('archived_at', null)
    .is('cancelled_at', null)
    .limit(200);
  if (error) {
    void reportError(new Error(error.message), { tag: 'cron.maintenance-draft-reminders' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  let sent = 0;
  for (const row of (data ?? []) as EligibleRow[]) {
    try {
      // Stamp FIRST (crash-safe dedupe), and only proceed if we won the write.
      const { data: stamped } = await admin
        .from('maintenance_requests')
        .update({ draft_reminder_sent_at: nowIso })
        .eq('id', row.id)
        .is('draft_reminder_sent_at', null)
        .select('id')
        .maybeSingle();
      if (!stamped) continue; // another run beat us

      if (!row.requester_user_id) continue; // requester account is gone; nobody to notify

      // Pref gate (fail-open, 0265 pattern): missing row or null column
      // still notifies; only an explicit `false` mutes.
      const { data: prefRow } = await admin
        .from('notification_preferences')
        .select('push_maintenance_draft_reminder')
        .eq('user_id', row.requester_user_id)
        .maybeSingle();
      const wantsPush =
        (prefRow as { push_maintenance_draft_reminder: boolean | null } | null)
          ?.push_maintenance_draft_reminder !== false;
      if (!wantsPush) continue;

      const handle =
        formatMaintenanceRequestNumber(row.request_number, row.created_at) ??
        `MR-${row.id.slice(0, 8)}`;

      await createNotification({
        organizationId: row.organization_id,
        userId: row.requester_user_id,
        type: 'maintenance_request',
        title: `Reminder: finish your ${handle} draft`,
        body: `Your maintenance request ${handle} was saved, but no email draft has been opened yet. Open it in StockPilot to finish sending it to DC4.`,
        link: `/dashboard/maintenance/${row.id}`,
        metadata: { request_id: row.id, event: 'draft_reminder' },
      });
      sent++;
    } catch (e) {
      void reportError(e, {
        tag: 'cron.maintenance-draft-reminders',
        extra: { requestId: row.id },
      });
    }
  }

  return NextResponse.json({ ok: true, remindersSent: sent });
}
