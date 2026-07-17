# Movement/Activity P3 — Integrity + Exports/Filters

> Execute via superpowers:subagent-driven-development. Base: main @ ff463e2a. Branch: feat/movement-activity-p3.

**Goal:** Make the movement ledger honest (kill the fictional archive/delete rows + restore phantom) and give users real export/filter power over movement history.

**Architecture:** Two independent tasks. Task 1 is a correctness fix in `InventoryService` + a one-time cleanup migration (0271). Task 2 is UI/reporting (filters + CSV) on the global Movements page. No dependency between them.

## Global Constraints
- Migration applied to prod via `supabase db push --linked` (project xizpqmhhslgzbuqtjubv) AFTER merge, before/with deploy. Assistant (not the implementer) applies it.
- The cleanup DELETE must be tightly scoped: `movement_type='adjust' AND reason IN ('item_archived','item_deleted')` — these reasons are written ONLY by the two fictional inserts and read by NOTHING (verified). Real adjustments never carry those reasons.
- NO Claude/Anthropic co-author trailer. Live-verify in Demo Co (org 71b27a4a-7948-4638-bc3f-535974713bd2).
- Web-only (mobile Activity tab is P4). No OTA.
- `quantity_on_hand` is the source of truth; archive/delete intentionally PRESERVE stock — do not change that.

---

### Task 1: Kill fictional archive/delete movement rows + restore phantom (integrity)

**Root cause (triple-confirmed by 3 independent discovery lenses):** `InventoryService.archive()` (inventory.ts ~l.2047-2092) and `softDelete()` (~l.2340-2386) UPDATE only `status`/`deleted_at` (quantity_on_hand deliberately unchanged) but, when `onHand>0`, INSERT a `stock_movements` row `movement_type='adjust', quantity_change=-onHand, previous_quantity=onHand, new_quantity=0, reason='item_archived'/'item_deleted'`. No physical stock moves; NO restore path (bulk unarchive ~l.2263, POST /api/v1/items/[id]/restore, receiving.ts maybeAutoUnarchive, _auto_restock_restore trigger) reverses it. Effects: (1) fictional depletion on the item Activity feed; (2) **restore phantom** — on restore the item re-enters dashboard scope (0228 scope_items = status='active' AND deleted_at IS NULL) and the dangling −N row makes `dashboard_history_series` reconstruct pre-archive qty as N−(−N)=**2N**, inflating historical inventory_value and injecting phantom drawdowns into inventory_trend_buckets (0223) + dashboard_movement_metrics (0230); (3) single-vs-bulk archive asymmetry (bulk archive writes no such row).

**Files:** Modify `apps/web/src/server/services/inventory.ts`; Modify `apps/web/src/server/services/activity.ts` (defense); Create `supabase/migrations/0271_purge_fictional_lifecycle_movements.sql`; tests.

**Steps:**
1. **Remove** the `stock_movements` INSERT block in `archive()` (~l.2066-2081) and in `softDelete()` (~l.2360-2375). Keep everything else (the status/deleted_at UPDATE, the `audit_logs` event via `audit()` — `inventory.item.archived`/`inventory.item.deleted` — which correctly records the lifecycle). Do NOT change `bulkUpdate` archive (already writes no such row — this removal makes single-archive match it). Verify no other code reads `reason='item_archived'|'item_deleted'` (grep — discovery says nothing does).
2. **Defense in `ActivityService.forItem`:** add a small reason denylist so any *legacy* lifecycle-reason movement row that still exists is not rendered as a stock event on the item feed. Mirror the P2 `MOVEMENT_SHADOWED_AUDIT_EVENTS` pattern with a `LIFECYCLE_REASON_MOVEMENTS = ['item_archived','item_deleted']` constant filtered out of the movement rows (Postgres `.not('reason','in',...)` + JS backstop). This protects any org whose cleanup hasn't run yet and any future accidental write.
3. **Migration 0271** (`supabase/migrations/0271_purge_fictional_lifecycle_movements.sql`): one-time cleanup — `DELETE FROM public.stock_movements WHERE movement_type = 'adjust' AND reason IN ('item_archived','item_deleted');` with a header comment explaining WHY (fictional rows, never backed by a qty change, corrupt dashboard history reconstruction on restore). This self-heals every org's historical dashboards. No schema change.
4. **Tests:** unit-test that `archive()` and `softDelete()` on an in-stock item write NO `stock_movements` row (still write the audit event); `forItem` filters out a legacy `item_archived` movement row. A pgTAP test for 0271 is optional (it's a data DELETE, not schema) — instead assert in an integration/unit test that after archive there is no adjust/item_archived movement.

### Task 2: Movement history exports + filters (global Movements page)

**Files:** Modify `apps/web/src/app/(dashboard)/dashboard/movements/page.tsx` + its filter/list components; Create a CSV export route `apps/web/src/app/api/movements/export.csv/route.ts` (mirror `apps/web/src/app/api/orders/export.csv/route.ts` and `apps/web/src/app/api/inventory/export.csv/route.ts` — same auth/withContext + CSV-escaping + streaming pattern); extend `MovementsService.list` if needed for the new filters. Tests.

**Current state:** the page has server search (`q`) + numbered pagination + warehouse filter, but NO movement_type filter, NO date-range filter, and NO CSV export. There is NO existing stock-movements CSV route.

**Steps:**
1. Add a **movement_type** filter (multi/single select of the real MovementType enum values) and a **date-range** filter (from/to) to the Movements page, threaded through `searchParams` (like `q`/`page`) into `MovementsService.list`. Reuse existing filter UI components where possible (e.g. the audit page's filter pattern / existing select components).
2. Add a **CSV export** button that hits a new `GET /api/movements/export.csv` route: authed via the same `withContext`/session pattern as the other export.csv routes, respects the SAME active filters (q, type, date range, warehouse) + org scope + RLS, streams CSV with columns: date, item (sku + name), movement_type, quantity_change, previous_qty, new_qty, from_location, to_location, reference_type, reference (resolved number if cheap else id), reason, notes, actor. Escape fields with the existing CSV util pattern. Cap sensibly (or stream) — do not load unbounded into memory beyond the existing MOVEMENTS_INSTANT_CAP posture.
3. **Tests:** the export route returns correct CSV for a filtered query, is org-scoped (no cross-tenant rows), and requires auth (401 unauth); the type/date filters narrow `MovementsService.list` correctly.

**Note:** keep Task 2 scoped to the GLOBAL Movements page. Item-tab pagination beyond 50 and audit-page CSV are out of scope for P3 (note as follow-ups). The bin_location-clear edit-form bug is DEFERRED (needs a product decision; do not touch item-form rack→bin logic here).
