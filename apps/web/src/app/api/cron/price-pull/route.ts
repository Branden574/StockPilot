import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { googleBooksClient } from '@/server/pricing/google-books-client';
import { refreshBookPricesForOrg } from '@/server/services/price-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Constant-time string compare. Copied from cron/drain-outbox.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Daily Google Books price pull for every org with the price_tracking module enabled. */
export async function GET(req: Request) {
  // Fail-closed when CRON_SECRET is unset/empty. Matches cron/drain-outbox.
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from('organization_modules')
    .select('organization_id')
    .eq('module_id', 'price_tracking')
    .eq('enabled', true);
  if (error) {
    void reportError(new Error(`price-pull org list: ${error.message}`), { tag: 'cron.price-pull' });
    return NextResponse.json({ error: 'org_list_failed' }, { status: 500 });
  }

  const orgIds = Array.from(new Set((rows ?? []).map((r) => r.organization_id as string)));
  const results: Array<{ orgId: string; scanned: number; written: number; skipped: number }> = [];

  // Global budget so one cron invocation can't exceed Vercel's maxDuration=60
  // (an uncatchable hard-kill would silently skip the remaining orgs) or blow
  // Google's daily quota. `deadlineMs` gives ~10s headroom; `GLOBAL_CAP` bounds
  // total observations across ALL orgs this run.
  const GLOBAL_CAP = 500; // total observations per cron invocation
  const deadlineMs = Date.now() + 50_000; // headroom under maxDuration=60
  let used = 0;
  for (const orgId of orgIds) {
    if (Date.now() > deadlineMs || used >= GLOBAL_CAP) break;
    try {
      const r = await refreshBookPricesForOrg(admin, orgId, googleBooksClient, {
        limit: Math.min(300, GLOBAL_CAP - used),
        deadlineMs,
      });
      used += r.written;
      results.push({ orgId, ...r });
    } catch (e) {
      // FAIL-OPEN per org: report and continue; one org must not 500 the cron.
      void reportError(e, { tag: 'cron.price-pull', extra: { orgId } });
    }
  }
  return NextResponse.json({ ok: true, orgs: orgIds.length, results });
}
