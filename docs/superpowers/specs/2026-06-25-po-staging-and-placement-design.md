# PO Receiving Staging + Multi-Rack Placement — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) → pending implementation plan
**Author:** Branden Vincent-Walker (with Claude)

## 1. Problem

When a PO is received today, the received quantity is applied **immediately** to the
item's on-hand and the item carries a single rack/crate placement chosen back at the
PO-import *create* step. There is no holding area: stock is "placed" the instant it's
received, and a received line that matches an existing item inflates that item's count
in its existing rack (the Science Dimensions 41‑B incident, 2026-06-25).

We want a **staging phase**: received stock lands in a holding area, and an operator
later decides — on their own — which area/rack each batch goes to, transferring it from
staging into one or more real locations. Stock that matches existing inventory must keep
the **same item identity** (same SKU / title / ISBN — no duplicate items) yet sit **staged
separately** until placed, and a single item must be able to live in **multiple racks at
once**.

## 2. Goals / Non-goals

**Goals**
- Received PO stock lands in a per-warehouse **Staging** holding area, not in a rack.
- Operator places staged stock into an existing or newly-created area/rack (crate for
  books), optionally **splitting** a batch across multiple racks.
- One item identity can hold stock in **many racks** simultaneously (no duplicate items).
- The placed (rack) count of a matching existing item **never inflates on receive** — only
  on placement.
- A **view toggle** lets inventory screens show "placed only" or "placed + staged".

**Non-goals (this project)**
- Two separate accounting modes (owned vs not-owned). Rejected during brainstorming in
  favor of one model + a view toggle. Staged stock is always *owned*.
- Auto-placement or auto-aging actions on staged stock (visibility only).
- Bin-level slotting optimization, wave picking, etc.

## 3. Confirmed decisions (from brainstorming)

1. **One staging model + a view toggle** (not two accounting modes). Staged stock is owned
   but lives in a distinct Staging bucket; the toggle only changes what number a list shows.
2. **Rack/crate is chosen at placement time**, not at the PO-import create step. The create
   step's rack/crate dropdowns are removed; matching to existing items at create is by
   SKU/ISBN only.
3. **One item across many racks** → racks/areas/crates become *real locations* with
   per-rack quantities (instead of today's single `custom_fields` rack field).
4. **Model approach ①:** reuse the existing `locations` + `item_stock_levels` +
   `transfer_stock()` machinery rather than building parallel tables.
5. **Web-first**, with a mobile staging/placement screen as the immediate next increment.

## 4. Data model

### 4.1 Placement locations (extend `locations`)
The `locations` table (id, organization_id, parent_id, name, type, …) supports a nested
hierarchy but has **no `warehouse_id`** today (warehouses live in a separate `warehouses`
table, mig 0007; `inventory_items` carries both `warehouse_id` → warehouses and
`primary_location_id` → locations). Add:
- `warehouse_id uuid references warehouses(id)` — so placement locations (staging/area/rack/
  crate) belong to a warehouse, matching `inventory_items.warehouse_id`. (Existing free-form
  locations keep `warehouse_id = null`.)
- `kind` — `'staging' | 'area' | 'rack' | 'crate' | 'unplaced'`. Areas/racks/crates nest via
  the existing `parent_id` (Area → Rack → optional Crate).
- Structured placement columns: `rack_number`, `rack_row`, `crate_color`, `crate_number`
  (nullable) so scans/reports read clean fields, not free-text. The location `name` is a
  derived display label (e.g. `41-B`, `41-B · Blue #3`).
- Each warehouse has exactly **one** `kind='staging'` and **one** `kind='unplaced'`
  location: created by the Phase 1 migration for all existing warehouses, and created
  automatically whenever a new warehouse is added going forward.

### 4.2 Per-rack quantities (reuse `item_stock_levels`)
`item_stock_levels (item_id, location_id, quantity)` (unique on `(item_id, location_id)`)
becomes the **source of truth** for how many of an item are in each rack / in staging.

- `inventory_items.quantity_on_hand` stays the **total owned** = Σ `item_stock_levels.quantity`
  across all of the item's locations (including Staging). Valuation and "do we own it"
  remain correct.
- **Derived:** `staged` = qty in the item's Staging level; `placed` = `quantity_on_hand − staged`
  (= Σ of non-staging levels). The view toggle switches which is displayed.

One item = many `item_stock_levels` rows = stock across many racks (+ maybe Staging). No
duplicate items.

## 5. Receiving → Staging → Place workflow

### 5.1 Receiving routes to Staging
- The PO-import create step no longer collects rack/crate; created items have no placement.
- `ReceivingService.postReceipt` → `post_receipt_v2` → `adjust_stock` is changed so the
  received `qty_accepted` lands in the warehouse's **Staging** location:
  `item_stock_levels[item, Staging] += qty`, `quantity_on_hand += qty`, and a
  `stock_movements` row `movement_type='receive_po'` with `to_location_id = Staging`.
- A received line matching an existing item (same SKU/ISBN/barcode) adds to **that item's**
  Staging level; its placed/rack count is untouched. No duplicate item is created.
- Idempotency of `post_receipt_v2` (key + payload) is preserved.

### 5.2 Staging screen (new, web)
A "received-but-not-placed" worklist: everything with qty in a Staging location, grouped by
item, showing staged qty, source PO/receipt, received date, and **age** (days in staging).
Filterable by warehouse and books vs items. Stale items (e.g. > 7 days) get a badge
(visibility only).

### 5.3 Place action (the transfer)
From a staged row → **Place**:
- Choose a **destination**: an existing area/rack, or **create one inline** (rack #, row;
  books also crate color + number → creates/uses the crate location).
- **Split supported:** place part of the staged qty (e.g. 60 of 90) to one rack now; the
  remainder stays staged or goes to another rack.
- Commit calls the existing `transfer_stock(item_id, from=Staging, to=rack, qty)` →
  net-zero on `quantity_on_hand`, moves qty Staging→rack, logs a `transfer` movement
  (`from_location_id=Staging`, `to_location_id=rack`). `transfer_stock` already guards
  against transferring more than the source holds, so you cannot place more than is staged.
- Books carry crate color/number into the crate location; items use rack/row only.

## 6. Display & view toggle
- **Inventory & Books lists** default to the **placed** count; a persisted per-user toggle
  flips to **placed + staged** total. Items with staged qty show a "staged" badge.
- **Item/book detail** gains a **placements breakdown**: each location with its qty plus a
  `Staging: N` row (e.g. "39 in 41‑B, 90 in 50‑A, 0 staged").

## 7. Edge cases & policies
- **Staged stock is not sellable/pickable until placed.** It counts in total owned, but
  order picking / fulfillment / returns / adjustments operate on **placed** stock only. This
  prevents shipping unsorted stock and keeps staging honest.
- **Never-placed stock** simply remains in Staging (owned, counted). No auto-move; the
  Staging screen surfaces age and badges stale batches for visibility.
- **Partial / repeated receives** accumulate in the item's Staging level (additive).
- **Cancel / over-receive / returns** operate on placed stock per the policy above; existing
  cancel-cleanup of PO-import created vs linked items is unchanged.

## 8. Migration / backfill (Phase 1, one-time)
- For every existing item with on-hand: find/create its rack location from today's
  `custom_fields` rack/crate and write an `item_stock_levels` row equal to its **full current
  `quantity_on_hand`** at that rack. Post-migration: `placed = prior on-hand`, `staged = 0` —
  nothing changes visibly and totals reconcile exactly.
- Items with **no** rack/crate → their on-hand goes to the per-warehouse **`unplaced`**
  location (NOT Staging), so they read as "needs a home" without polluting the receiving
  worklist.
- **Items that already have `item_stock_levels` rows** (some may, since `transfer_stock` has
  always written there): do NOT double-count. The migration only backfills the **unaccounted
  remainder** = `quantity_on_hand − Σ existing levels`, placing that remainder in the item's
  `custom_fields` rack (or `unplaced`); if existing levels already equal on-hand, it's a
  no-op for that item. Post-migration invariant for every item: `Σ item_stock_levels = quantity_on_hand`.
- `custom_fields` rack/crate is retained during the transition (read-compat); UI is then
  switched to read placements. No data loss. Migration is idempotent and gated behind pgTAP.

## 9. Permissions & tenancy
- Staging view = inventory read; placing/transferring and creating locations = `inventory:manage`.
- All new rows are org- and charter-scoped; RLS mirrors existing `locations` /
  `item_stock_levels` policies. A cross-tenant sweep confirms no org can see or place into
  another org's locations/staging.

## 10. Testing & gating
- **pgTAP invariants:** total on-hand = Σ stock-levels (incl. Staging); receive lands in
  Staging; place (`transfer_stock`) is net-zero on total and cannot exceed staged qty;
  staged ≠ placed/pickable; migration backfill reconciles exactly (placed = prior on-hand,
  staged = 0).
- **Unit tests (vitest):** place/transfer action, staging service, placed/staged derivation,
  the receive-routes-to-Staging path.
- pgTAP green → apply migrations to prod via `supabase db push --linked` after merge.

## 11. Phasing & platforms
- **Phase 1 — Foundation (backend + web):** `locations`/`item_stock_levels` model changes,
  Staging + Unplaced locations, receiving routes to Staging, migration/backfill, placed/staged
  derivation + inventory view toggle, removal of create-step rack/crate dropdowns.
- **Phase 2 — Staging workflow (web):** Staging screen + Place/transfer action (existing or
  new location, split, books vs items) + item-detail placements breakdown.
- **Phase 3 — Mobile:** Staging + Place screen on the native app (floor activity).

## 12. Future / out of scope
- Mobile staging screen (Phase 3, fast follow).
- Aging auto-actions, slotting optimization, multi-warehouse transfer flows beyond
  Staging→rack.
- Deprecating `custom_fields` rack/crate entirely once placements are fully adopted.
