# Movement/Activity P4 — Mobile Activity Tab + Pagination

> Execute via superpowers:subagent-driven-development. Base: main @ 8246c57d. Branch: feat/movement-activity-p4. NO migration.

**Goal:** Bring the web item-detail Activity feed (audit events: edits with before/after, archive/restore, serials/tags/images) to the mobile item screen, and let both platforms page past the 50-row cap.

**Architecture:** Mobile reads audit_logs directly under the user JWT (RLS manager+ SELECT — staff see no audit rows, which EXACTLY matches web, whose forItem also runs user-authed). Merge semantics are a client-side port of `ActivityService.forItem`. Pagination copies the SerialsCard "Load more" pattern already in the same file.

## Global Constraints
- Preserve forItem's semantics when porting: SEPARATE per-kind caps (movements=limit, audits=ceil(limit/2)) — never a combined slice (P1 cap bug); suppress `MOVEMENT_SHADOWED_AUDIT_EVENTS` = ['stock.adjusted','stock.transferred','stock.received','stock.removed'] from the item feed (movement row already shows them); filter `LIFECYCLE_REASON_MOVEMENTS` = ['item_archived','item_deleted'] in JS ONLY (recurring-bug #23b: PostgREST `.not(col,'in',...)` on the NULLABLE reason column silently drops null-reason rows — 61% of prod).
- Audit rows are item-scoped via `metadata->>entity_id = itemId` (expr index mig 0135); audit metadata jsonb is untrusted — crash-safe rendering only (plain-object checks + try/catch stringify, mirroring web metadata-diff.tsx).
- Do NOT use FlashList (known crash history) or nest a FlatList in the screen's ScrollView — keep `.map()` + the in-card "Load more" pattern.
- NO Claude/Anthropic co-author trailer. Mobile ships via OTA after merge (controller does it). Simulator hand-test after OTA (controller).

---

### Task 1: Mobile — Activity tab, merged feed, load-more, refresh

**Files:** Modify `apps/mobile/app/item/[id].tsx`; Create `apps/mobile/src/lib/item-activity.ts` (+ test) for the PURE merge/label logic; reuse `apps/mobile/src/lib/movement-references.ts` + `movement-display.ts`.

Anchors in item/[id].tsx (line numbers approximate — confirm): `type TabId = 'overview'|'movements'` (~161); tab row (~806-817); lazy-load effect (~484-486); loadMovements (~409-478, `.limit(50)`); MovementCard (~1155-1268); SerialsCard load-more precedent (~1455, 1489-1554, 1718-1739: PAGE_SIZE=25, `{count:'exact'}` + `.range()`, stable `.order(created_at desc).order('id')` tiebreak, Set-based id-dedupe append, "Load more (N remaining)" footer); single ScrollView (~668), NO RefreshControl anywhere in file.

1. Add `'activity'` to TabId + a third TabButton. Movements tab stays movements-only (unchanged behavior). Activity tab = MERGED feed: existing movements query + a NEW audit_logs query (`select id, event, metadata, created_at, user_id` where org + `metadata->>entity_id = itemId`, order created_at desc/id desc), both lazy-loaded on tab activation like movements.
2. Pure merge in `item-activity.ts` (exported + unit-tested): map audits to a discriminated union with movements, sort desc, apply per-kind caps, apply the two JS filters (shadowed events; lifecycle reasons — keep null reasons). Audit card rendering: event label (small port of the web's formatAuditEvent labels for the events that exist — fall back to title-cased event string), actor + relative time + absolute time (mobile already shows absolute — keep its existing format), `changed_keys` chip line when present, and compact `field: before → after` rows from metadata.before/after (only when BOTH are plain objects; stringify values crash-safe; cap displayed rows ~6 with "+N more"). Match existing card styling (Body/Mono/pills) — no new design system.
3. Load-more on BOTH tabs: copy the SerialsCard pattern (PAGE_SIZE 25-50, count exact, range, id-dedupe append, "Load more (N remaining)" footer). Movements keeps its reference-label resolvers running per-page (merge maps on append — mergeReferenceLabelMaps already supports this).
4. Add RefreshControl to the screen's ScrollView (re-runs the active tab's loaders + item load). Surface query errors inline (crit-red Body, SerialsCard convention) instead of silent `data ?? []`.
5. Verify: typecheck + eslint clean; vitest for item-activity.ts (merge caps, shadowed-event suppression, null-reason retention, lifecycle filtering, crash-safe metadata) with REAL value assertions.

### Task 2: Web — "Load older" on the item Activity/Movements tabs

**Files:** Modify `apps/web/src/components/inventory/item-detail.tsx`, `activity-feed.tsx`; likely a small server action (`server/actions/activity.ts` or existing actions file) wrapping `ActivityService.forItem` with a `before` cursor; extend `ActivityService.forItem` to accept `{ before?: string }` (created_at cursor applied to BOTH queries). Tests.

1. Extend forItem with an optional `before` cursor (`lt('created_at', before)` on movements AND audits) — per-kind caps unchanged. Tie-break duplicates client-side by id on append.
2. Item detail: "Load older" button under the feed (only when the last fetch returned a full page for either kind), appending results via a client wrapper around the existing server-fetched first page (follow however the tab currently fetches — a server action returning ActivityEvent[] serializes fine).
3. Tests: forItem cursor narrows both queries; append de-dupes on id; button hides when exhausted.

**Out of scope:** audit-page pagination changes, exports, any migration. P5 (backfill) is separate.
