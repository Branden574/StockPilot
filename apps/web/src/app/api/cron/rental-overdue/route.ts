import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { sendRentalOverdueEmail } from '@/lib/email/rentals';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { mapIdBatches, rawErrorText } from '@/server/services/lib/fetch-by-ids';
import { fetchAllRows } from '@/server/services/lib/paginate';

import { isOverdueReminderCandidate, RENTAL_OVERDUE_SWEEP } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Constant-time string compare. Copied from cron/price-pull. */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Rentals considered per run: far above any real day's overdue count. */
const OVERDUE_BATCH_LIMIT = 500;

type OverdueRow = {
  id: string;
  status: string;
  expected_return_at: string;
  overdue_reminder_sent_at: string | null;
};

/**
 * Daily overdue-rental reminder. Emails the borrower once when a rental is
 * past its expected return date and still out. `overdue_reminder_sent_at`
 * (mig 0264) guarantees one nudge per rental — a rental already reminded is
 * skipped, so this never re-emails daily. Cross-org (service role); the
 * per-rental email is best-effort and self-skips when there's no borrower
 * email on file.
 *
 * MODULE GATE: only organizations whose explicit `organization_modules` row
 * for rentals is enabled. This is automation that writes to people outside
 * the organization, so it follows the row and never the comp
 * (lib/modules/effective-modules.ts, the same rule as the price-pull,
 * daily-briefing, auto-reorder, recurring-pos and maintenance-draft-reminders
 * crons). It used to read no module state at all, so switching Rentals off,
 * which is the off switch for these emails, did not stop them. Rows of an org
 * with the module off are never read, so they are never stamped: if the module
 * comes back on, their reminder goes out then. The allowlist is read first and
 * a failed read fails the run with nothing sent, rather than treating
 * "unknown" as "everyone".
 *
 * CLAIM, THEN SEND: each rental is stamped with a guarded update (still out,
 * not yet reminded) that returns the row only to the run that won it, and the
 * email goes out only for a claimed row. It used to send first and stamp
 * after, so two overlapping runs (a retried invocation, a manual trigger)
 * could both email the same borrower. A crash between the claim and the send
 * loses that one reminder, the same trade the other reminder crons make: one
 * missed nudge beats a duplicate to an outsider.
 *
 * ONE RULE WITH THE PAGES: the rental detail and list pages (web and phone)
 * tell the operator whether this reminder was sent or when it will be. They
 * decide with the same functions this run uses, from @stockpilot/core
 * (rentals/emails.ts): RENTAL_OVERDUE_SWEEP for the module row and the status,
 * and isOverdueReminderCandidate, which this run applies to every row its
 * query returned before claiming it. The query and the function name the same
 * three columns; if they ever disagree, only a rental both accept is emailed.
 * The schedule is apps/web/vercel.json ("0 15 * * *"), pinned against
 * RENTAL_OVERDUE_SWEEP.utcHour by a test.
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
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Allowlist: organizations with the rentals row explicitly enabled.
  let enabledOrgIds: string[];
  try {
    const rows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', RENTAL_OVERDUE_SWEEP.moduleId)
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );
    enabledOrgIds = rows.map((r) => r.organization_id);
  } catch (e) {
    void reportError(new Error(rawErrorText(e)), {
      tag: 'cron/rental-overdue',
      extra: { step: 'modules' },
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (enabledOrgIds.length === 0) {
    return NextResponse.json({ ok: true, considered: 0, sent: 0, skipped: 0, failed: 0 });
  }

  // Overdue and not yet reminded, per batch of 100 organizations (the
  // allowlist has no bound, and every id rides in the URL). Each batch keeps
  // its oldest OVERDUE_BATCH_LIMIT and the merge keeps the oldest of those,
  // which is the same set one query ordered the same way would return. The
  // partial index rentals_expected_return_idx (status='out') serves the scan.
  let candidates: OverdueRow[];
  try {
    const perBatch = await mapIdBatches(enabledOrgIds, async (batch) => {
      const { data, error } = await admin
        .from('rentals')
        .select('id, status, expected_return_at, overdue_reminder_sent_at')
        .eq('status', RENTAL_OVERDUE_SWEEP.status)
        .is('overdue_reminder_sent_at', null)
        .lt('expected_return_at', nowIso)
        .in('organization_id', batch)
        .order('expected_return_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(OVERDUE_BATCH_LIMIT);
      if (error) throw new Error(error.message);
      return (data ?? []) as OverdueRow[];
    });
    candidates = perBatch
      .flat()
      // The shared rule (see the header), on every row the query returned.
      .filter((row) => isOverdueReminderCandidate(row, nowMs))
      .sort(
        (a, b) =>
          Date.parse(a.expected_return_at) - Date.parse(b.expected_return_at) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, OVERDUE_BATCH_LIMIT);
  } catch (e) {
    void reportError(new Error(rawErrorText(e)), {
      tag: 'cron/rental-overdue',
      extra: { step: 'select' },
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { id: rentalId } of candidates) {
    // Claim FIRST. `status = 'out'` in the guard too: a rental returned since
    // the read above must not get an overdue email.
    const { data: claimed, error: claimErr } = await admin
      .from('rentals')
      .update({ overdue_reminder_sent_at: new Date().toISOString() })
      .eq('id', rentalId)
      .eq('status', RENTAL_OVERDUE_SWEEP.status)
      .is('overdue_reminder_sent_at', null)
      .select('id')
      .maybeSingle();
    if (claimErr) {
      failed += 1;
      void reportError(new Error(claimErr.message), {
        tag: 'cron/rental-overdue',
        extra: { step: 'claim', rentalId },
      });
      continue;
    }
    if (!claimed) {
      // Another run claimed it, or it was returned in between.
      skipped += 1;
      continue;
    }
    try {
      // Best-effort email (never throws; self-skips when no borrower email).
      await sendRentalOverdueEmail(rentalId);
      sent += 1;
    } catch (e) {
      failed += 1;
      void reportError(e, { tag: 'cron/rental-overdue', extra: { step: 'send', rentalId } });
    }
  }

  return NextResponse.json({ ok: true, considered: candidates.length, sent, skipped, failed });
}
