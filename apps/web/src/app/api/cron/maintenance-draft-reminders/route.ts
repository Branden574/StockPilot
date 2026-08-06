import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { formatMaintenanceRequestNumber } from '@stockpilot/core';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/server/services/lib/paginate';
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
 * draft_reminder_sent_at is null, not archived/cancelled, AND the owning
 * org still has the maintenance_requests module enabled. The `status`
 * enum and the `archived_at`/`cancelled_at` timestamps are always written
 * TOGETHER in the same update (archive()/cancel() in
 * server/services/maintenance-requests.ts), so `status = 'saved'` already
 * implies both timestamps are null — the extra `.is(...)` pair below is
 * belt-and-suspenders, matching the same double-guard 0314's own RLS
 * policies apply everywhere else on this table, not a distinct case the
 * status filter misses.
 *
 * Module gate (fast-follow, final-review finding): this is the one emit
 * point in the feature with no `assertModuleEnabled`-equivalent check — the
 * per-request service layer gates every write behind
 * `assertModuleEnabled(ctx, 'maintenance_requests')`
 * (server/services/maintenance-requests.ts), but a cron has no per-org
 * ServiceContext to run that against; it queries every org's table rows
 * directly. So the org allowlist is fetched FIRST (organization_modules,
 * mirroring the auto-reorder cron's own module-enabled prefetch:
 * api/cron/auto-reorder/route.ts) and applied as an `.in('organization_id',
 * ...)` filter on the eligibility SELECT itself — a module-OFF org's rows
 * never enter `data`, so they are never stamped and never notified. That
 * also means re-enabling the module later revives the reminder for a saved
 * draft that would otherwise have gone quiet, which is the intended
 * behavior (a disabled module should pause the nag, not permanently silence
 * a real unsent draft).
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

  // Module allowlist FIRST — the ONE emit point that had no module-enabled
  // check (final-review finding). PAGINATED: a plain select silently caps at
  // PostgREST's 1000-row `max_rows`, which would drop orgs once the platform
  // has >1000 with this module enabled. Ordered by organization_id (stable,
  // non-duplicating — module_id is fixed by the .eq filter so each row is
  // already unique per org), same pagination shape as the auto-reorder cron.
  let enabledOrgIds: string[];
  try {
    const enabledOrgRows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'maintenance_requests')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );
    enabledOrgIds = enabledOrgRows.map((r) => r.organization_id);
  } catch (e) {
    void reportError(e, { tag: 'cron.maintenance-draft-reminders' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (enabledOrgIds.length === 0) {
    return NextResponse.json({ ok: true, remindersSent: 0 });
  }

  const { data, error } = await admin
    .from('maintenance_requests')
    .select('id, organization_id, requester_user_id, request_number, created_at')
    .eq('status', 'saved')
    .lt('created_at', cutoffIso)
    .is('draft_reminder_sent_at', null)
    .is('archived_at', null)
    .is('cancelled_at', null)
    .in('organization_id', enabledOrgIds)
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
