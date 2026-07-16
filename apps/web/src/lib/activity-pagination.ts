/**
 * Movement/Activity P4 Task 2: "Load older" pagination helpers for the item
 * Activity/Movements tabs. Deliberately pure + framework-agnostic (no
 * `'server-only'`, no `'use client'`) so the SAME functions run in the
 * item-detail server component (computing the initial cursor for the
 * first, server-rendered page) and in the client append wrapper (computing
 * the next cursor after each "Load older" fetch) — one implementation, no
 * drift between the two call sites.
 */

import type { ActivityEvent } from '@/server/services/activity';

/** Page size `item-detail` requests for the first (server-rendered) page,
 * and what the "Load older" server action requests for every subsequent
 * page. Kept as one shared constant so both call sites stay in lockstep —
 * a mismatch here would make `nextActivityCursor` under/over-shoot. */
export const ITEM_ACTIVITY_PAGE_SIZE = 50;

/**
 * Merges a newly-fetched "older" page onto the existing feed, de-duplicating
 * by `id` (already a kind-prefixed composite — `m:<uuid>` / `a:<uuid>` — so
 * movement and audit ids never collide) and re-sorting by `createdAt` desc.
 *
 * De-dup is required, not just defensive: `nextActivityCursor` (below)
 * intentionally picks the LATER of the two per-kind cursors when movements
 * and audits exhaust their caps at different points in time, which can
 * re-fetch a handful of rows the caller already has. Silently dropping
 * those (rather than erroring or skipping the fetch) is the deliberate
 * trade-off — see `nextActivityCursor`'s doc comment for why the
 * alternative (the EARLIER cursor) is a correctness bug, not just noise.
 */
export function mergeOlderActivityEvents(
  existing: ActivityEvent[],
  older: ActivityEvent[],
): ActivityEvent[] {
  const seen = new Set(existing.map((e) => e.id));
  const merged = existing.slice();
  for (const e of older) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return merged;
}

/**
 * Computes the shared `before` cursor for the NEXT "Load older" fetch from
 * the events a page JUST returned (not the whole accumulated feed).
 *
 * `ActivityService.forItem` caps movements and audits SEPARATELY
 * (movementLimit = the full requested limit, auditLimit = half that — the
 * P1 invariant, never a combined slice) but accepts only ONE `before` value
 * applied to BOTH underlying queries. Whichever kind's cap boundary sits
 * chronologically LATER (closer to now) must win:
 *
 *   - Using the EARLIER boundary (i.e. the plain minimum / the oldest
 *     timestamp across the whole merged page) silently DROPS rows: if
 *     audits capped out at a more-recent timestamp than movements did
 *     (e.g. few audit rows exist so `auditLimit` was never fully spent,
 *     while `movementLimit` movements stretch much further back), any
 *     audit rows between the two boundaries never fetched in this page
 *     would fall on the wrong side of an all-consuming "less than the
 *     older boundary" cursor on the NEXT page and are gone forever.
 *   - Using the LATER boundary (what this function returns) can re-fetch
 *     a handful of already-seen rows for the kind whose boundary was
 *     earlier — harmless, because `mergeOlderActivityEvents` de-dupes by
 *     id — but never skips a row.
 *
 * Returns `null` when the page contained no events at all (nothing left to
 * page through for either kind).
 */
export function nextActivityCursor(pageEvents: ActivityEvent[]): string | null {
  let latestBoundary: string | null = null;
  for (const kind of ['movement', 'audit'] as const) {
    const rows = pageEvents.filter((e) => e.kind === kind);
    if (rows.length === 0) continue;
    // `pageEvents` is already sorted createdAt desc (ActivityService.forItem's
    // contract) — filtering by kind preserves relative order, so the LAST
    // element of the filtered subset is the oldest row of that kind in the
    // page, without needing a second sort.
    const oldestOfKind = rows[rows.length - 1]!.createdAt;
    if (
      latestBoundary === null ||
      new Date(oldestOfKind).getTime() > new Date(latestBoundary).getTime()
    ) {
      latestBoundary = oldestOfKind;
    }
  }
  return latestBoundary;
}
