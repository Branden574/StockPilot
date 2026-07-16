/**
 * Movement/Activity P4 Task 2: "Load older" pagination helpers for the item
 * Activity/Movements tabs. Deliberately pure + framework-agnostic (no
 * `'server-only'`, no `'use client'`) so the SAME functions run in the
 * item-detail server component (computing the initial cursor for the
 * first, server-rendered page) and in the client append wrapper (computing
 * the next cursor after each "Load older" fetch) — one implementation, no
 * drift between the two call sites.
 */

import type { ActivityCursor, ActivityEvent } from '@/server/services/activity';

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
 * De-dup is purely a defensive safety net now that `nextActivityCursor`
 * (below) tracks an independent, exact boundary per kind — a correctly
 * threaded per-kind cursor never re-matches a row it has already returned.
 * It still guards against real-world edge cases that don't go through this
 * module's own logic: a double-fired "Load older" click before `loading`
 * disables the button, or a retry after a network error re-issuing the same
 * `before` — both would otherwise double-insert rows into the feed.
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
 * Computes the PER-KIND "Load older" cursor for the NEXT fetch from the
 * events a page JUST returned (not the whole accumulated feed) — see
 * `ActivityCursor`/`ActivityKindCursor` in `server/services/activity.ts` for
 * the composite `(created_at, id)` shape and why it's needed.
 *
 * `ActivityService.forItem` caps movements and audits SEPARATELY
 * (movementLimit = the full requested limit, auditLimit = half that — the
 * P1 invariant, never a combined slice). The ORIGINAL design (before the P4
 * review fix) accepted only ONE shared `created_at` cursor applied to BOTH
 * underlying queries, which had two bugs at once:
 *
 *   1. SKIPPED ROWS AT A TIE: ordering was created_at-only, so whenever a
 *      page's `.limit()` cut a kind off mid-tie (several rows sharing the
 *      exact same `created_at`, only some fitting under the cap), a strict
 *      `created_at < boundary` on the next page excluded EVERY row at that
 *      exact timestamp — including the ones the cap had just cut off, which
 *      then never surfaced again. (created_at-only ordering is also
 *      nondeterministic among ties, so which rows got cut off could vary
 *      page to page.)
 *   2. Because only one cursor value could be threaded through, whichever
 *      kind's boundary was chronologically EARLIER had to borrow the OTHER
 *      kind's (later) boundary to avoid an even worse version of bug 1
 *      across kinds — which then re-fetched a handful of already-seen rows
 *      for the earlier kind on every subsequent page.
 *
 * Giving each kind its OWN `(created_at, id)` boundary (this function) fixes
 * both: `id` breaks every tie deterministically (paired with `forItem`'s
 * `ORDER BY created_at DESC, id DESC` and `.or(created_at.lt…, and(…, id.lt…))`
 * predicate), and the two kinds' cursors never interact.
 *
 * `previous` is the cursor the page just fetched USED (or `null` for the
 * very first page). When a kind returns NO rows on this page — it already
 * exhausted its own boundary on a prior call — that kind's entry is carried
 * forward UNCHANGED rather than cleared: dropping it would make the next
 * call's query for that kind unfiltered, silently re-fetching its NEWEST
 * rows from scratch (harmless after `mergeOlderActivityEvents`'s de-dupe,
 * but a wasted query + cap's worth of thrown-away rows every time the OTHER
 * kind still has more to page through).
 *
 * Returns `null` only when there is no boundary for EITHER kind — i.e. the
 * very first page returned nothing at all, so there is nothing left to page
 * through.
 */
export function nextActivityCursor(
  pageEvents: ActivityEvent[],
  previous: ActivityCursor | null = null,
): ActivityCursor | null {
  const next: ActivityCursor = {};
  for (const kind of ['movement', 'audit'] as const) {
    const rows = pageEvents.filter((e) => e.kind === kind);
    if (rows.length > 0) {
      // `pageEvents` is already sorted createdAt desc (ActivityService.forItem's
      // contract) — filtering by kind preserves relative order, so the LAST
      // element of the filtered subset is the oldest row of that kind in the
      // page, without needing a second sort.
      const oldest = rows[rows.length - 1]!;
      // `ActivityEvent.id` is the display-composite `m:<uuid>` / `a:<uuid>`
      // (see activity.ts) — strip the 2-char kind prefix to recover the RAW
      // stock_movements.id / audit_logs.id the keyset predicate needs.
      next[kind] = { createdAt: oldest.createdAt, id: oldest.id.slice(2) };
    } else if (previous?.[kind]) {
      next[kind] = previous[kind];
    }
  }
  if (!next.movement && !next.audit) return null;
  return next;
}
