import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  prewarmOrdersNewCatalog,
  type PrewarmPairResult,
} from '@/server/loaders/orders-new-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A fully cold prewarm signs a whole catalog's thumbnails; give it
// room (matches cron/drain-outbox).
export const maxDuration = 60;

/**
 * Prewarms the /dashboard/orders/new caches (catalog items + thumb map
 * + charters) so the first human after a deploy lands on warm caches
 * instead of the cold sign-storm path — perf plan P3. Intended to be
 * hit by a Vercel deploy webhook and/or a periodic cron.
 *
 * SCOPE: deliberately just the known-hot orgs (L4L North Region + the
 * StockPilot Demo Co workspace) rather than every org×warehouse pair —
 * bounded work per invocation. Widen the list (or replace with an
 * activity-based query) if more orgs become picker-heavy.
 */
const KNOWN_HOT_ORG_IDS = [
  // L4L North Region (owner's production org)
  '63c13e64-92a6-4ea4-9936-6a2c26a85b4a',
  // StockPilot Demo Co (demo workspace, App Store screenshots/testing)
  '71b27a4a-7948-4638-bc3f-535974713bd2',
];

/**
 * Constant-time string compare (copied from cron/drain-outbox — a
 * naive `a !== b` leaks the matching-prefix length through timing).
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Accepts EITHER bearer: CRON_SECRET (Vercel Cron) or
 * BACKFILL_ADMIN_SECRET (operator-invocable — CRON_SECRET is marked
 * Sensitive in Vercel so the owner can't pull it to curl this route).
 * Fail-closed: unset/empty secrets are never compared against, so an
 * unauthenticated GET can't drive admin-client work when neither is
 * configured.
 */
function isAuthorized(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secrets = [env.CRON_SECRET, env.BACKFILL_ADMIN_SECRET].filter(Boolean);
  return secrets.some((secret) => secretsEqual(auth, `Bearer ${secret}`));
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const { data: warehouseRows, error } = await admin
      .from('warehouses')
      .select('id, organization_id')
      .in('organization_id', KNOWN_HOT_ORG_IDS)
      .neq('status', 'archived');
    if (error) {
      return NextResponse.json(
        { error: `warehouse query failed: ${error.message}` },
        { status: 500 },
      );
    }

    const pairs = (warehouseRows ?? []) as Array<{
      id: string;
      organization_id: string;
    }>;

    // Sequential on purpose: each pair's cold path can itself fan out
    // (catalog queries + a batch sign); overlapping pairs would just
    // contend for the same lambda/network budget.
    const results: PrewarmPairResult[] = [];
    for (const pair of pairs) {
      results.push(await prewarmOrdersNewCatalog(pair.organization_id, pair.id));
    }

    return NextResponse.json({
      prewarmed: results.length,
      totalMs: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'prewarm failed' },
      { status: 500 },
    );
  }
}
