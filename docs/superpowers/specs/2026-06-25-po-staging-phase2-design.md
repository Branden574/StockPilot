# PO Staging Phase 2 — Staging Workflow + Level-Authoritative Mutators — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) → pending implementation plan(s)
**Author:** Branden Vincent-Walker (with Claude)
**Builds on:** Phase 1 (migrations 0188–0193, live in prod) — see
`docs/superpowers/specs/2026-06-25-po-staging-and-placement-design.md` §13.

## 1. Problem / context

Phase 1 made the inventory model per-location (`item_stock_levels`), routed PO
receiving into a per-warehouse **Staging** location, revived `transfer_stock` as a
two-table move, and added a placed/staged display. But it only wired the new model
into **receiving and receipt-reversal**. The whole-branch adversarial review (spec
§13) confirmed two deferred gaps:

1. **`Σ item_stock_levels = quantity_on_hand` is not maintained going forward** — every
   other on-hand mutator (`complete_picking` 0121, `post_shipment_shipped` 0054,
   `cancel_order_request` restore 0137/0155, `process_return_disposition` 0153,
   `post_cycle_count` 0079, manual `adjustStock`, bundle RPCs 0040/0070/0101) changes
   `quantity_on_hand` without touching `item_stock_levels`. The backfill + invariant
   test guarantee the invariant only at backfill time; the per-rack breakdown rots and
   `staged` can show stale after the first non-receiving mutation.
2. **No "Place from Staging" UX** — received stock sits in Staging with no operator
   workflow to place it onto a rack/crate, and the legacy Transfer dialog is a stopgap.

Phase 2 closes both: it makes `item_stock_levels` **authoritative across all mutators**
and ships the **staging worklist + Place workflow**.

## 2. Goals / non-goals

**Goals**
- Every on-hand mutator keeps `item_stock_levels` consistent (`Σlevels = on_hand` holds
  after every operation, not just at backfill).
- Picking/shipping/sales draw from **placed** stock only (racks + Unplaced, never
  Staging) and **hard-block** when placed stock is insufficient — enforcing the spec's
  "staged stock isn't pickable until placed" rule.
- All stock entering inventory without an explicit location (returns, cancel-restores,
  positive adjustments, bundle output) lands in **Staging** and must be placed before
  it's pickable.
- A web **Staging worklist** + **Place** action (existing or new rack/crate, split,
  books-vs-items) and an item-detail **placements breakdown**.
- System locations stop cluttering user-facing location pickers.

**Non-goals (this project)**
- Per-location cycle counting (cycle count stays total-scoped; diff reconciles to a
  location — see §4.4). Truly location-scoped counts are a future enhancement.
- Restore-to-origin for cancel-restore (stock returns to Staging; origin tracking is a
  future refinement).
- Mobile staging/Place screen (Phase 3).
- Aging auto-actions, slotting optimization.

## 3. Confirmed decisions (from brainstorming)

1. **Consistency model = authoritative everywhere.** All mutators maintain
   `item_stock_levels`; it is the system-wide source of truth.
2. **Draw-down = placed-only, block if short.** Decrements draw from non-Staging levels
   (racks first by a deterministic order, **Unplaced last**); if placed < requested,
   raise `insufficient_placed_stock` and roll back.
3. **Increments (null location) → Staging.** Returns/restock, cancel-restore, positive
   manual adjust, positive cycle-count diff, bundle output all land in Staging and must
   be placed before pickable.
4. **Mechanism = centralize in `adjust_stock`.** Auto-allocate on null location; every
   existing null-location caller inherits correct behavior with no call-site change. The
   two paths that bypass `adjust_stock` get explicit fixes.

## 4. Allocation model (backend — Phase 2a)

### 4.1 `adjust_stock` becomes the allocator
- **Location supplied (non-null):** unchanged from Phase 1 (mig 0189) — upsert that
  location's level by `p_quantity_change`, plus the `quantity_on_hand` update + movement
  row. (Receiving still passes Staging explicitly; reverse_receipt — see §4.3 — no longer
  relies on this default.)
- **Location null, `p_quantity_change > 0`:** resolve the warehouse Staging location
  (via `ensure_warehouse_placement_locations`) and add the qty there.
- **Location null, `p_quantity_change < 0`:** draw down across the item's **placed**
  levels (`kind <> 'staging'`), ordered **racks/areas/crates first, Unplaced last**
  (deterministic, e.g. by `kind` then `created_at`), decrementing each until the
  requested qty is satisfied. If the sum of placed levels is less than requested, raise
  `insufficient_placed_stock` (errcode `P0001`) — the whole call rolls back.
- `quantity_on_hand` still moves by the full `p_quantity_change` in all cases (the
  invariant `Σlevels = on_hand` holds because the level moves sum to the same amount).
- The item's warehouse is `inventory_items.warehouse_id`; if null, fall back to the
  org-level Staging/Unplaced buckets used by the Phase 1 backfill.

### 4.2 Draw-down ordering
Deterministic so behavior is testable: placed locations ordered by `kind` priority
(`rack`/`area`/`crate` before `unplaced`) then `created_at`, draining identified rack
stock before the Unplaced catch-all. The exact tiebreak is an implementation detail; the
**binding rule** is: never draw from `kind='staging'`, and Unplaced is drained last.

### 4.3 `reverse_receipt` draws Staging-first, then placed
A receipt added qty to Staging; reversing it must remove from Staging first and only spill
into placed if the stock was already placed out (now possible once Place ships). So
`reverse_receipt` uses a **Staging-first, then placed** decrement (its own small helper),
not the default placed-only draw-down. For each reversed line: decrement the Staging level
up to what it holds, then draw the remainder down from placed (same ordering as §4.2). If
total (Staging + placed) is insufficient, the existing on-hand `< 0` guard already aborts
the reversal (stock shipped/consumed) — preserved.

### 4.4 The two bypassers
- **`post_cycle_count` (0079):** currently sets `quantity_on_hand` directly. Reroute the
  diff through `adjust_stock` (null location): positive diff → Staging, negative diff →
  placed draw-down. (Total-scoped count retained; per-location counting is out of scope.)
- **`process_return_disposition` (0153):** currently mutates `inventory_items` inline.
  Reroute restock increments through `adjust_stock` (null location) → Staging. Scrap/loss
  dispositions that decrement go through the placed draw-down.

### 4.5 Per-mutator behavior (after Phase 2a)
| Flow | on-hand | Level effect |
|------|---------|--------------|
| Receive PO (0190) | +qty | + Staging (explicit) |
| Reverse receipt (0193→updated) | −qty | − Staging first, then placed (§4.3) |
| Pick / ship / sale (0121/0054) | −qty | − placed (block if short) |
| Cancel-restore (0137/0155) | +qty | + Staging |
| Return restock (0153) | +qty | + Staging |
| Return scrap/loss (0153) | −qty | − placed |
| Cycle count diff (0079) | ±diff | + Staging / − placed |
| Manual adjust, no location | ±qty | + Staging / − placed |
| Manual adjust, with location | ±qty | that location (unchanged) |
| Bundle assemble: consume components | −qty | − placed |
| Bundle assemble: produce bundle | +qty | + Staging |
| Place (Phase 2b) | net-zero | Staging → rack via `transfer_stock` |

## 5. Staging workflow UX (web — Phase 2b)

### 5.1 Staging worklist screen
New route `/dashboard/inventory/staging`, gated by `inventory:manage`. Lists every item
with qty in a Staging level, grouped by item, showing **staged qty, source PO/receipt,
received date, age in staging (days)**, filterable by **warehouse** and **books vs
items**, with a **stale badge at >7 days** (visibility only). Age + source derive from the
`receive_po` `stock_movements` rows whose `to_location_id` is the Staging location.

### 5.2 Place action
From a staged row → **Place** dialog:
- **Destination:** an existing area/rack/crate, or **create one inline** — rack # + row
  (items); books also crate color + number. Inline-create makes a `kind='rack'`/`'crate'`
  location under the item's warehouse with the structured columns
  (`rack_number`/`rack_row`/`crate_color`/`crate_number`); a book crate nests under its
  rack via `parent_id`. (These are the structured fields removed from the PO-import create
  step in Phase 1, now living at placement time.)
- **Split:** place part of the staged qty now; the remainder stays staged or goes to
  another rack.
- **Commit → `transfer_stock(item, from=Staging, to=destination, qty)`** — net-zero on
  on-hand, logs a `transfer` movement; `transfer_stock`'s existing guard prevents placing
  more than is staged.

### 5.3 Item / book detail — placements breakdown
A per-location list ("39 in 41-B · 90 in 50-A · 0 staged") powered by the existing
`InventoryService.placements(itemId)` method (added during the Phase 1 Fix B work), wired
into the item/book detail page.

### 5.4 `LocationsService.list()` kind filter
Add an optional kind filter (`excludeKinds`/`onlyKinds`). User-facing primary-location
pickers (item create/edit, PO destination) exclude `staging`/`unplaced`; the Staging/Place
UI opts to include them.

## 6. Edge cases & policies
- **`insufficient_placed_stock`** is surfaced as a friendly UI error in picking/shipping
  ("Place staged stock first"), not a raw error code.
- **Cancel-restore → Staging:** picked-then-cancelled stock returns to Staging and must be
  re-placed (per decision 3). Documented; restore-to-origin is a future refinement.
- **Items with no warehouse_id** use the org-level Staging/Unplaced buckets (Phase 1
  backfill already created these where needed).
- All new reads fail-closed (a placements/staging query error degrades gracefully, never
  throws into a list/detail render).

## 7. Migrations (Phase 2a; next free is 0194)
- `0194` — `adjust_stock` auto-allocate (null-location: +→Staging, −→placed draw-down,
  raise `insufficient_placed_stock`).
- `0195` — `reverse_receipt` Staging-first-then-placed helper.
- `0196` — `post_cycle_count` rerouted through `adjust_stock`.
- `0197` — `process_return_disposition` rerouted through `adjust_stock`.
(Plan may consolidate or split; numbers finalized at planning time. Never edit a shipped
migration; each is independently revertible via `create or replace` of the prior body.)

## 8. Testing & gating
- **pgTAP per mutator (the high-stakes 2a gate):** each asserts `Σlevels = on_hand` AFTER
  the op, plus: pick draws from placed and **raises `insufficient_placed_stock` when
  short**; return/cancel-restore/positive-adjust → Staging; cycle-count diff both signs;
  bundle assemble/disassemble; `reverse_receipt` in BOTH the still-staged and the
  already-placed-out cases.
- **vitest (2b):** staging worklist query, Place action, placements breakdown, locations
  kind-filter.
- Full `pnpm db:test` + `pnpm --filter @stockpilot/web test` + `tsc` + eslint green.
- Because 2a rewires picking/shipping/returns/bundles (money/stock surfaces), a **second
  multi-lens adversarial review** runs before merge.
- After merge: `supabase db push --linked`, then re-verify `Σlevels = on_hand` on prod and
  spot-check a receive→place→pick→reverse cycle.

## 9. Sequencing & risk
- **2a backend lands and is verified first** (the UX trusts the levels), then **2b UX**.
- Biggest behavioral shift: picking an unplaced item now hard-errors. Mitigation: the
  Phase 1 backfill already placed all existing prod stock into rack/Unplaced, so nothing
  is "stuck in Staging" on day one — only newly received stock waits in Staging until
  placed.

## 10. Future / out of scope
- Mobile staging/Place screen (Phase 3).
- Per-location cycle counting; restore-to-origin for cancel; aging auto-actions; slotting.
- Deprecating `custom_fields` rack/crate once placements are fully adopted.
