import { NextResponse } from 'next/server';

import { sweepMissingEmbeddings } from '@/lib/ai/embeddings-sweep';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit, explicit. The sweep starts no item after
 * EMBEDDINGS_SWEEP.deadlineMs (150 s); the one in flight then has at most
 * EMBED_TIMEOUT_MS (10 s) of Gemini, then its read again and its write, and
 * its organization one count query, so a run ends well inside 300 s even when
 * every Gemini call times out and Supabase stalls. Same limit as
 * daily-briefing and exception-occurrences.
 */
export const maxDuration = 300;

/**
 * EMBEDDINGS SWEEP, every hour at minute 37 (vercel.json): embeds the live
 * items that still have no search embedding, in every organization, within
 * the per-run budget in lib/ai/embeddings-sweep.ts (100 items per
 * organization, 150 per run, 150 s). It covers what the request paths do
 * not embed at once (the books import, bulkCreate), a Gemini failure, a call
 * cut off, and any path added later.
 *
 * MINUTE 37: no other cron fires on it. drain-outbox and schedule-reminders
 * run every 10 minutes, exception-occurrences every 15,
 * prewarm-orders-catalog every 30 and the rest on the hour, and it is clear
 * of the 12:55-13:05, 13:55-14:10 and 14:55-15:10 UTC windows around the
 * daily briefing, the weekly digest and rental-overdue.
 *
 * Auth: Bearer ${CRON_SECRET}, compared in constant time (the shared
 * secretsEqual), and FAIL-CLOSED when CRON_SECRET is unset, as drain-outbox:
 * an unauthenticated GET must never start a cross-organization run. The
 * service-role client is scoped per organization inside the sweep.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await sweepMissingEmbeddings(createAdminClient());
    // One line per run, counts only: no item names, no organization ids.
    console.info('[cron.embeddings-sweep]', JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    void reportError(err, { tag: 'cron.embeddings-sweep' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
