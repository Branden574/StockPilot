/**
 * Org-sweep planning for the prewarm cron (route.ts next door).
 *
 * Pure module on purpose: route files may only export HTTP fields, so
 * the enumeration/ordering/capping logic lives here where vitest can
 * reach it without spinning up the route.
 */

import { rotatingWindow } from '@/server/services/lib/cron-sweep';

/**
 * Orgs that are ALWAYS warmed first, ahead of the rotating
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
 * invocation warms: the known-hot orgs plus a window of the rest. Budget
 * math, measured on the prod-shaped load test (50k items):
 *   • per-org prewarmInventoryList('all') — Items + Books default views
 *     + instant datasets: ~150–400ms when the shared Data Cache is
 *     still warm, ~1–3s fully cold (4 sub-loaders × 2 views + dataset
 *     head-count/fetch; image signs mostly hit the 25-day per-path
 *     cache).
 *   • 50 orgs × ~1s ≈ 50s worst case — right at the route's
 *     maxDuration=60 window, so the cap alone is NOT the safety net:
 *     route.ts also stops starting new orgs at a ~50s soft deadline
 *     (same pattern as cron/price-pull) and reports both the orgs outside
 *     this run's window and any deadline skips in its response + a log line.
 * Past the cap the rest of the orgs ROTATE (planOrgSweep): each run takes
 * the next window, so every active org is warmed at least once every
 * ceil(N / ORG_SWEEP_WINDOW) runs (N = active orgs other than the known-hot
 * ones; every 30 minutes, so 100 orgs are all warmed within an hour).
 */
export const ORG_SWEEP_CAP = 50;

/** The rotating part of the cap: what is left after the known-hot orgs. */
export const ORG_SWEEP_WINDOW = ORG_SWEEP_CAP - KNOWN_HOT_ORG_IDS.length;

/** The cron's period (vercel.json: every 30 minutes). One window per slot. */
export const ORG_SWEEP_SLOT_MS = 30 * 60_000;

export interface OrgSweepPlan {
  /** Known-hot orgs first, then this run's window, deduped. */
  orgIds: string[];
  /** Active orgs other than the known-hot ones (the rotation's N). */
  rotating: number;
  /** Of those, how many are outside this run's window (warmed in a later run). */
  outsideWindow: number;
  /** Runs it takes for the window to cover every one of them. */
  runsToCoverAll: number;
}

/**
 * Plans one run's orgs. Known-hot ids are seeded FIRST so they can never
 * fall outside the window or starve behind the deadline. `activeOrgIds` is
 * the route's enumeration (every organization with ≥1 ACCEPTED member, in id
 * order), which may or may not contain the known-hot ids. The rest rotate:
 * the run in 30-minute slot s = floor(now / ORG_SWEEP_SLOT_MS) takes
 * `windowSize` of them starting at (s × windowSize) mod N, wrapping
 * (rotatingWindow, services/lib/cron-sweep.ts). With N ≤ windowSize every
 * run takes all of them, in order, as before.
 */
export function planOrgSweep(opts: {
  knownHotOrgIds: readonly string[];
  activeOrgIds: readonly string[];
  windowSize: number;
  now: number;
}): OrgSweepPlan {
  const hot: string[] = [];
  const seen = new Set<string>();
  for (const id of opts.knownHotOrgIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    hot.push(id);
  }
  const rest: string[] = [];
  for (const id of opts.activeOrgIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rest.push(id);
  }
  const slot = Math.floor(opts.now / ORG_SWEEP_SLOT_MS);
  const window = rotatingWindow(rest, opts.windowSize, slot);
  return {
    orgIds: [...hot, ...window],
    rotating: rest.length,
    outsideWindow: rest.length - window.length,
    runsToCoverAll: Math.max(1, Math.ceil(rest.length / Math.max(1, opts.windowSize))),
  };
}
