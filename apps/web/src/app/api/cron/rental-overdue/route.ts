import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { sendRentalOverdueEmail } from '@/lib/email/rentals';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

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

/**
 * Daily overdue-rental reminder. Emails the borrower once when a rental is
 * past its expected return date and still out. `overdue_reminder_sent_at`
 * (mig 0264) guarantees one nudge per rental — a rental already reminded is
 * skipped, so this never re-emails daily. Cross-org (service role); the
 * per-rental email is best-effort and self-skips when there's no borrower
 * email on file.
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

  // Overdue + not-yet-reminded. Bounded: 500 per run is far above any real
  // day's overdue count; the partial index rentals_expected_return_idx
  // (status='out') serves the range scan.
  const { data, error } = await admin
    .from('rentals')
    .select('id')
    .eq('status', 'out')
    .is('overdue_reminder_sent_at', null)
    .lt('expected_return_at', nowIso)
    .order('expected_return_at', { ascending: true })
    .limit(500);

  if (error) {
    void reportError(error, { tag: 'cron/rental-overdue', extra: { step: 'select' } });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  const rentalIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  let sent = 0;
  let failed = 0;

  for (const rentalId of rentalIds) {
    try {
      // Best-effort email (never throws; self-skips when no borrower email).
      await sendRentalOverdueEmail(rentalId);
      // Mark reminded regardless — one nudge per rental (see mig 0264). Not
      // marking on a transient failure would re-send every day once email
      // recovers, which is worse than a single missed nudge.
      const { error: updErr } = await admin
        .from('rentals')
        .update({ overdue_reminder_sent_at: new Date().toISOString() })
        .eq('id', rentalId)
        .is('overdue_reminder_sent_at', null);
      if (updErr) {
        failed += 1;
        void reportError(updErr, { tag: 'cron/rental-overdue', extra: { step: 'stamp', rentalId } });
      } else {
        sent += 1;
      }
    } catch (e) {
      failed += 1;
      void reportError(e, { tag: 'cron/rental-overdue', extra: { step: 'send', rentalId } });
    }
  }

  return NextResponse.json({ ok: true, considered: rentalIds.length, sent, failed });
}
