/**
 * Org-sweep planning for the prewarm cron (route.ts next door).
 *
 * Pure module on purpose: route files may only export HTTP fields, so
 * the enumeration/ordering/capping logic lives here where vitest can
 * reach it without spinning up the route.
 */

/**
 * Orgs that are ALWAYS warmed first, ahead of the activity-ordered
 * sweep — the sweep's deadline can truncate the tail, never these.
 * They also keep their EXTRA warm surfaces (orders-new catalog per
 * warehouse + per-warehouse Items/Books variants) that the broad sweep
 * deliberately skips — see route.ts.
 */
export const KNOWN_HOT_ORG_IDS = [
  // L4L North Region (owner's production org)
  '63c13e64-92a6-4ea4-9936-6a2c26a85b4a',
  // StockPilot Demo Co (demo workspace, App Store screenshots/testing)
  '71b27a4a-7948-4638-bc3f-535974713bd2',
] as const;

/**
 * DISCLOSED CAP (repo rule: no silent caps) on how many orgs one cron
 * invocation warms. Budget math, measured on the prod-shaped load test
 * (50k items):
 *   • per-org prewarmInventoryList('all') — Items + Books default views
 *     + instant datasets: ~150–400ms when the shared Data Cache is
 *     still warm, ~1–3s fully cold (4 sub-loaders × 2 views + dataset
 *     head-count/fetch; image signs mostly hit the 25-day per-path
 *     cache).
 *   • 50 orgs × ~1s ≈ 50s worst case — right at the route's
 *     maxDuration=60 window, so the cap alone is NOT the safety net:
 *     route.ts also stops starting new orgs at a ~50s soft deadline
 *     (same pattern as cron/price-pull) and reports both the cap
 *     truncation and any deadline skips in its response + a log line.
 * Raise the cap only together with chunking (e.g. a rotating cursor
 * across runs) — the every-30-min cron cadence means a truncated tail
 * is retried within 30 minutes anyway.
 */
export const ORG_SWEEP_CAP = 50;

/**
 * Orders + dedupes + caps the org ids one cron run will warm.
 *
 * `activeOrgIds` comes from the route's enumeration query
 * (organizations with ≥1 ACCEPTED member, most-recently-updated first)
 * and may or may not contain the known-hot ids. Known-hot ids are
 * seeded FIRST so they can never fall off the cap edge or starve
 * behind the deadline — preserving the route's pre-sweep behavior as a
 * floor.
 */
export function planOrgSweep(opts: {
  knownHotOrgIds: readonly string[];
  activeOrgIds: readonly string[];
  cap: number;
}): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of [...opts.knownHotOrgIds, ...opts.activeOrgIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    if (ordered.length >= opts.cap) break;
  }
  return ordered;
}
