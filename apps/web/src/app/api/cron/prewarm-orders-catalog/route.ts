import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  prewarmInventoryList,
  type InventoryListPrewarmResult,
} from '@/server/loaders/inventory-list';
import {
  prewarmOrdersNewCatalog,
  type PrewarmPairResult,
} from '@/server/loaders/orders-new-catalog';

import { KNOWN_HOT_ORG_IDS, ORG_SWEEP_CAP, planOrgSweep } from './org-sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A fully cold prewarm signs a whole catalog's thumbnails; give it
// room (matches cron/drain-outbox).
export const maxDuration = 60;

/**
 * Soft deadline for STARTING new per-org work — same headroom pattern
 * as cron/price-pull. Vercel's maxDuration=60 kill is uncatchable, so
 * without this a long cold run would silently truncate the sweep AND
 * lose the response body; instead we truncate ourselves at ~50s and
 * disclose the skips in the response + a log line.
 */
const SWEEP_DEADLINE_MS = 50_000;

/**
 * Prewarms the /dashboard/orders/new caches (catalog items + thumb map
 * + charters) AND the Items/Books default-view caches so the first
 * human after a deploy lands on warm caches instead of the cold
 * sign-storm path — perf plan P3. Hit by the Vercel cron (every 30
 * min), the GH Action deploy hook, and the instrumentation.ts boot
 * self-warm.
 *
 * SCOPE (two tiers):
 *   • KNOWN-HOT orgs (org-sweep.ts) keep the full treatment: orders-new
 *     catalog per warehouse pair + Items/Books 'all' AND per-warehouse
 *     variants.
 *   • EVERY OTHER ACTIVE ORG — any org with ≥1 accepted member, most
 *     recently updated first, capped at ORG_SWEEP_CAP (disclosed, see
 *     org-sweep.ts for the budget math) — gets the Items/Books 'all'
 *     variant, the one nearly every manager request resolves to. The
 *     cold-visit killer: before this sweep a first visit to any
 *     non-hot org paid ~4.8s of cold loaders at 50k-item scale.
 *
 * CALLER TIERING (`?scope=hot`): the broad-sweep tier is for the two
 * SINGLETON callers only — the every-30-min Vercel cron and the
 * post-deploy GH Action (no query param → full sweep). The
 * instrumentation.ts boot self-warm instead passes `?scope=hot`, which
 * warms ONLY the known-hot tier and never even enumerates orgs: a
 * deploy cold-starts K instances at once, and K concurrent full sweeps
 * (~50 orgs × ~1s of duplicated cold Supabase loads each) would be a
 * thundering herd for caches the cron/deploy-hook already warm.
 *
 * Per-org/per-pair failures are isolated: one bad org logs and the
 * sweep continues (prewarmInventoryList additionally captures per-view
 * errors internally).
 */

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

  // `?scope=hot` (boot self-warm) = known-hot tier only, no org
  // enumeration. Anything else — including no param, the cron and the
  // deploy hook — keeps the full sweep. See CALLER TIERING above.
  const hotOnly = new URL(req.url).searchParams.get('scope') === 'hot';

  const startedAt = Date.now();
  const deadlineAt = startedAt + SWEEP_DEADLINE_MS;
  try {
    const admin = createAdminClient();

    // 1) Enumerate every org worth warming — FULL SWEEP ONLY: ≥1
    //    ACCEPTED member (the empty !inner() embed is a pure join
    //    filter — no member rows ship back), ordered by
    //    organizations.updated_at DESC as the recent-activity proxy.
    //    The ordering only matters past the cap: at ≤ORG_SWEEP_CAP
    //    total orgs everyone is warmed regardless. count='exact' rides
    //    along so a cap truncation is measurable (and disclosed)
    //    without fetching the tail. The hot tier skips the query
    //    entirely — its org list is the KNOWN_HOT_ORG_IDS constant.
    let sweepOrgIds: string[] = [...KNOWN_HOT_ORG_IDS];
    let activeOrgTotal: number | null = null;
    let truncatedByCap = 0;
    if (!hotOnly) {
      const {
        data: orgRows,
        error: orgError,
        count: orgCount,
      } = await admin
        .from('organizations')
        .select('id, organization_members!inner()', { count: 'exact' })
        .not('organization_members.accepted_at', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(ORG_SWEEP_CAP);
      if (orgError) {
        return NextResponse.json(
          { error: `org enumeration failed: ${orgError.message}` },
          { status: 500 },
        );
      }
      sweepOrgIds = planOrgSweep({
        knownHotOrgIds: KNOWN_HOT_ORG_IDS,
        activeOrgIds: ((orgRows ?? []) as Array<{ id: string }>).map((r) => r.id),
        cap: ORG_SWEEP_CAP,
      });
      activeOrgTotal = orgCount ?? null;
      truncatedByCap = Math.max(0, (orgCount ?? 0) - (orgRows?.length ?? 0));
    }

    // 2) Warehouse pairs — KNOWN-HOT orgs only. The orders-new picker
    //    prewarm (catalog + thumb-map sign storm) and the per-warehouse
    //    Items/Books cookie variants stay scoped to the known-hot tier:
    //    org-count × warehouse-count × sign-storm for every org would
    //    blow the budget for surfaces almost nobody cold-hits.
    const { data: warehouseRows, error } = await admin
      .from('warehouses')
      .select('id, organization_id')
      .in('organization_id', [...KNOWN_HOT_ORG_IDS])
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

    // Sequential on purpose (the sweep's stagger): each org/pair's cold
    // path can itself fan out (catalog queries + a batch sign);
    // overlapping them would just contend for the same lambda/network
    // budget. One failure logs and the loop continues — a bad org must
    // not abort the sweep.
    let skippedForBudget = 0;
    const results: PrewarmPairResult[] = [];
    for (const pair of pairs) {
      if (Date.now() > deadlineAt) {
        skippedForBudget += 1;
        continue;
      }
      try {
        results.push(await prewarmOrdersNewCatalog(pair.organization_id, pair.id));
      } catch (err) {
        console.warn(
          `[prewarm] orders catalog failed for org ${pair.organization_id} wh ${pair.id}:`,
          err,
        );
      }
    }

    // 3) Items/Books 'all'-variant sweep across EVERY org in
    //    sweepOrgIds (hot tier: just the known-hot ids) — the
    //    no-warehouse-cookie key nearly every manager request resolves
    //    to. Each pass also warms the shared lookup/trend/value caches
    //    the FILTERED views reuse, plus the instant-mode dataset for
    //    ≤2000-item orgs. Known-hot ids are seeded first in
    //    sweepOrgIds, so a deadline can only ever shed the cold tail.
    //    Per-view errors are captured inside prewarmInventoryList; the
    //    try/catch is belt-and-braces isolation.
    const inventory: InventoryListPrewarmResult[] = [];
    for (const orgId of sweepOrgIds) {
      if (Date.now() > deadlineAt) {
        skippedForBudget += 1;
        continue;
      }
      try {
        inventory.push(await prewarmInventoryList(orgId));
      } catch (err) {
        console.warn(`[prewarm] inventory sweep failed for org ${orgId}:`, err);
      }
    }

    // 4) Per-warehouse cookie variants — known-hot pairs only (see the
    //    tier note above). Last on purpose: least-hit surface, first to
    //    shed under the deadline.
    for (const pair of pairs) {
      if (Date.now() > deadlineAt) {
        skippedForBudget += 1;
        continue;
      }
      try {
        inventory.push(await prewarmInventoryList(pair.organization_id, pair.id));
      } catch (err) {
        console.warn(
          `[prewarm] inventory warehouse variant failed for org ${pair.organization_id} wh ${pair.id}:`,
          err,
        );
      }
    }

    // NO SILENT CAPS: any shed work gets a log line, not just a
    // response field nobody reads.
    if (truncatedByCap > 0 || skippedForBudget > 0) {
      console.warn(
        `[prewarm] sweep shed work: cap=${ORG_SWEEP_CAP} activeOrgTotal=${activeOrgTotal ?? 'n/a'} ` +
          `truncatedByCap=${truncatedByCap} skippedForBudget=${skippedForBudget} ` +
          `elapsedMs=${Date.now() - startedAt}`,
      );
    }

    return NextResponse.json({
      // 'hot' = known-hot tier only (boot self-warm); 'full' = the
      // capped all-active-orgs sweep (cron / deploy hook).
      scope: hotOnly ? 'hot' : 'full',
      prewarmed: results.length,
      totalMs: Date.now() - startedAt,
      results,
      inventoryPrewarmed: inventory.length,
      inventory,
      orgSweep: {
        cap: ORG_SWEEP_CAP,
        // null on the hot tier — no enumeration ran.
        activeOrgTotal,
        swept: sweepOrgIds.length,
        truncatedByCap,
        skippedForBudget,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'prewarm failed' },
      { status: 500 },
    );
  }
}
