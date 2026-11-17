/**
 * Org-sweep planning for the prewarm cron (route.ts next door).
 *
 * Pure module on purpose: route files may only export HTTP fields, so
 * the enumeration/ordering/capping logic lives here where vitest can
 * reach it without spinning up the route.
 */

import { sweepOrder } from '@/server/services/lib/cron-sweep';

/** The cron's cadence: the slot of the fallback order (rotateByClock). */
export const ORG_SWEEP_SLOT_MS = 30 * 60_000;

/**
 * Orgs that are ALWAYS warmed first, ahead of the
 * oldest-warmed-first sweep — the sweep's deadline can truncate the tail, never these.
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
 *     (same pattern as cron/price-pull) and reports the orgs it skipped
 *     for time in its response + a warning line.
 * Past the cap the rest of the orgs take turns (planOrgSweep): the ones
 * least recently warmed go first, by the time the cron last started each
 * (cron_sweep_attempts, job 'prewarm', 0492), and an org the deadline left
 * keeps its old time, so it goes first next run. With C orgs warmed per run
 * (ORG_SWEEP_WINDOW when no run is cut by its deadline, fewer when one is),
 * every active org is warmed within ceil(N / C) runs (N = active orgs other
 * than the known-hot ones; every 30 minutes).
 */
export const ORG_SWEEP_CAP = 50;

/** The rotating part of the cap: what is left after the known-hot orgs. */
export const ORG_SWEEP_WINDOW = ORG_SWEEP_CAP - KNOWN_HOT_ORG_IDS.length;

export interface OrgSweepPlan {
  /** Known-hot orgs first, then this run's window, deduped. */
  orgIds: string[];
  /** The window alone (the orgs whose attempt the route records). */
  windowOrgIds: string[];
  /** Active orgs other than the known-hot ones (the line's N). */
  rotating: number;
  /** Of those, how many are outside this run's window (warmed in a later run). */
  outsideWindow: number;
  /** Runs the line takes to reach every one of them, when no run is cut by
   *  its deadline. */
  runsToCoverAll: number;
}

/**
 * Plans one run's orgs. Known-hot ids are seeded FIRST so they can never
 * fall outside the window or starve behind the deadline. `activeOrgIds` is
 * the route's enumeration (every organization with ≥1 ACCEPTED member, in id
 * order), which may or may not contain the known-hot ids. The rest go least
 * recently warmed first (`lastWarmed`: epoch ms of the cron's last attempt,
 * per org); an org with none goes first, in id order. The first `windowSize`
 * of them are this run's window. With N ≤ windowSize every run takes all of
 * them. When the attempt records could not be read (`lastWarmed` null) the
 * rest go in rotateByClock order instead (`now`, a 30-minute slot), so the
 * window still moves from run to run rather than being the first by id.
 */
export function planOrgSweep(opts: {
  knownHotOrgIds: readonly string[];
  activeOrgIds: readonly string[];
  windowSize: number;
  lastWarmed: ReadonlyMap<string, number> | null;
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
  const width = Math.max(0, Math.floor(opts.windowSize));
  const window = sweepOrder(rest, opts.lastWarmed, {
    now: opts.now,
    slotMs: ORG_SWEEP_SLOT_MS,
  }).slice(0, width);
  return {
    orgIds: [...hot, ...window],
    windowOrgIds: window,
    rotating: rest.length,
    outsideWindow: rest.length - window.length,
    runsToCoverAll: Math.max(1, Math.ceil(rest.length / Math.max(1, width))),
  };
}
