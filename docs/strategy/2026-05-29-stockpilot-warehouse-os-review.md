# StockPilot → Configurable Warehouse OS — Product & Architecture Review

> Principal-architect review (2026-05-29). Turns StockPilot from a charter-school-oriented system into a configurable warehouse OS via a configuration + packaging layer over the existing engine — no core rewrite, no per-industry forks. Produced by a 17-agent workflow that read the actual repo (migrations, services, nav, RLS), then ran 8 parallel design workstreams + a completeness/contradiction critic. This document reconciles the workstreams into one coherent design.

---

## Executive summary

StockPilot already has the **execution core of a serious WMS** — verified in the code, not just the docs: an immutable `stock_movements` ledger, soft-hold `stock_reservations`, per-location `item_stock_levels`, security-definer RPCs that serialize critical writes (`adjust_stock`, `transfer_stock`, `post_receipt_v2`, `post_cycle_count`), lot/serial capture (`receipt_line_lots`, `serial_registry`), a 5-role permission matrix enforced at UI + service + RLS layers, multi-warehouse tenancy, a 14-status order state machine with a DB-enforced transition trigger, public order links, a transactional outbox (`outbox_events`), and genuine web↔mobile parity through a shared `packages/core` + a unified `withContext`/`withApiContext` service layer. **None of this needs to be rebuilt.**

The single thing blocking "configurable warehouse OS" is **product composition control**. Today there is **no entitlement layer**: every one of ~60 services is always-on, and navigation is **four disconnected static sources** (`BASE_NAV`/`ADMIN_NAV`, `DRAWER_SECTIONS`, the hard-coded 5-tab `_layout.tsx`, and the dashboard `getDashboardActions()`). The only per-org customization is a `terminology` jsonb and a few dormant `plans.ts` booleans. So an owner can rename "charters" but cannot turn Rentals off, cannot add Traceability, and cannot reshape the nav for a different industry without an engineering change.

**The recommended move is a configuration + packaging layer, in this order:**

1. **A third authorization axis — entitlements — kept orthogonal to roles and tenancy.** Tenancy (RLS) answers *whose rows*; permissions answer *what may this user do*; **entitlements answer *which modules exist for this org at all***. The composition is a strict AND that can only *reduce* surface area, never expand it — so it is security-conservative by construction.
2. **A single shared module registry in `packages/core`** that every surface reads from: it declares each module's id, tier (core / optional / premium), dependencies, permissions, owned tables, API prefixes, settings schema, and its nav placements across all five surfaces. Web nav, mobile drawer, mobile tabs, and dashboard widgets become *derived*, not authored — killing the documented web↔mobile drift.
3. **Domain packs as presets over the common core** — Charter Education (what L4L Fresno already is), General Distribution, and Agriculture/Food — each a named bundle of default-on modules + terminology + workflow policies. Packs are config, never forks.
4. **A connector framework** that keeps StockPilot the system of record for physical stock + warehouse execution while external systems own storefront/POS/payments/accounting/parcel — with Square first (catalog/locations pull, bi-directional inventory reconciliation, webhook order ingestion), then Shopify, QuickBooks, and carriers, all draining the existing `outbox_events`.

**Highest-leverage missing warehouse capabilities** (build as optional modules, not forks): cross-warehouse **transfers with an in-transit state**, **returns/RMA**, **quality/QA holds**, and **outbound FEFO/expiry enforcement** (the lot data is captured on receipt but never enforced on the way out). Wave/task orchestration, yard/dock, labor standards, and license plates are real but "grow-into-later" for the small/mid-market target.

**Preserved as strategic strengths:** the immutable ledger, the reservation model, the service-layer architecture, and DB-enforced RLS. Every recommendation here is additive to them.

**The path** is five phases — Foundation (entitlements + registry + nav manifest, grandfathering L4L Fresno so day-one behavior is identical) → Modularization (owner control plane; custom fields/statuses/templates) → Integrations (connector framework + Square) → Vertical Packs (charter → agriculture → distribution) → Enterprise depth (transfers, returns, quality, traceability). Phase 1 is the unlock; everything else composes on top.

One strategic caveat surfaced by the audit and reconciled below: `plans.ts` shows billing was **deliberately neutered** after the 2026-05-04 pivot to an invite-only internal tool. The entitlement axis below is therefore an **owner-toggle, decoupled from billing** — `minPlan` tiering is reserved as a dormant hook for if SaaS returns, not active gating. (See *Open questions* for the pricing decision this defers.)

---

## Canonical reconciliation decisions

The two foundational workstreams ("Proposed Modular Architecture" and "Navigation & Owner Customization") were designed in parallel and overlap. Both are strong, but they diverge on schema, naming, and enforcement. A contradiction/completeness critic compared them against the repo. **These decisions are authoritative — where a section below conflicts with this list, this list wins.** Implementers should treat the two sections as detailed rationale, and this as the spec.

### A. One registry, one key set (`packages/core`)
- **One shared `MODULE_REGISTRY`** in `packages/core/src/modules/registry.ts`. It merges both designs' interfaces into a single `ModuleDefinition` that carries **entitlement metadata** (`id`, `tier`, `dependsOn`, `permissions`, `ownsTables`, `apiPrefixes`, `settingsSchema`, `minPlan?`, `defaultOnFor`) **and** a `placements[]` array (one per surface: `surface`, `section`, `href`, `icon`, `defaultVisible`, `defaultSortOrder`, `mobileTabEligible`, `requires?`). Web + mobile both import it; icons are stored as **string names** resolved per platform.
- **Canonical module-id set = the snake_case ids from the Modular section** (`inventory`, `books`, `purchase_orders`, `cycle_counts`, `ai_assistant`, `ai_shelf_scan`, …). The Nav section's variants (`items`, `ai`, single `reports`) are renamed to match. Reports is **two ids** — `reports_basic` (core) and `reports_advanced` (premium) — since `reports.ts` already separates valuation/movements from ABC/dead-stock/scorecard.
- Admin-ish nav leaves the Nav section listed as standalone modules (`warehouses`, `bins`, `users`, `uom_conversions`, `vendor_mappings`, `reconciliation`, `tags`) are **nav placements under existing core modules** (`locations`, `team`, `categories`), **not** separate entitlement modules. `scan` is a mobile-tab placement of a tools pseudo-entry, not a toggleable module.

### B. One entitlement table + a separate nav-layout table (no collision)
- **`organization_modules`** (entitlement + per-module settings) uses the **Modular shape**: `(organization_id, module_id text, enabled bool, tier text, settings jsonb, enabled_at, enabled_by)`, PK `(organization_id, module_id)`, plus the `module_enabled(org, module)` **SECURITY DEFINER STABLE** helper. This is the entitlement source of truth.
- **`organization_nav_overrides`** (layout only) uses the **Nav shape**: `(organization_id, module_id, surface, owner_hidden, owner_pinned, sort_order, tab_slot, …)`. The Nav section's `surface_overrides` jsonb on `organization_modules` is **dropped** — section/order moves live here instead, so the two tables never overlap (entitlement vs layout are cleanly separated).
- **Migration numbering (corrected):** the repo's highest migration is **`0143`** (there are 139 `.sql` files, not "~143"). Both sections proposed `0144` for different tables — **collision resolved** to this sequence: `0144_org_modules_entitlements.sql` (table + `domain_pack` column + `module_enabled` helper + grandfather insert can fold in or be `0145`), `0145_grandfather_existing_orgs.sql`, `0146_nav_overrides.sql`, `0147_module_rls_predicates.sql`, then the *_defs tables `0148`–`0152`.

### C. Entitlement source vs billing (reconciled with the post-pivot reality)
- The **new `organization_modules` axis is the source of truth** for what is on. The four `plans.ts` booleans (`purchaseOrders`, `advancedReports`, `apiAccess`, `customRoles`) are **not** the entitlement engine.
- **Billing is dormant by deliberate decision** (per `plans.ts`: neutered after the 2026-05-04 internal-tool pivot). Therefore entitlements are an **owner toggle**, not plan-gated, today. `ModuleDefinition.minPlan` exists but is **inert** until/unless SaaS returns — it must not block owner toggles in the internal-tool configuration. The Nav section's "reuse `PlanLimits` keys as the entitlement source" is **rejected** in favor of the dedicated axis; `customRoles` stays a plan *limit* (it is a count, a different axis).

### D. Enforcement: service-layer primary, RLS as selective backstop
- **Primary enforcement is the service layer**, via `assertModuleEnabled(ctx, moduleId)` in `withContext`/`withApiContext`, because **most modules are Server Actions, not `/api/v1` routes** — verified: `/api/v1` contains only `account, ai, books, bundles, cycle-counts, items, mobile, po, public, push`; **orders live at `/api/orders`** (outside v1), and rentals/reports/etc. are Server Actions. The Modular section's "path→module middleware over `apiPrefixes`" is therefore **only a secondary guard for the v1 routes that exist**; it must not be the sole mechanism.
- **RLS backstop is selective, not universal.** Add the `module_enabled()` predicate to the **INSERT/UPDATE/DELETE** policies of a *handful* of high-risk module-owned write tables (e.g. `order_requests`, `receipts`, integration tables) — **not** SELECT (historical reads of a disabled module stay viewable), and **never** on `stock_movements` (core, never gated). This reconciles "Modular wants RLS everywhere" vs "Nav declines RLS entirely": we do a small, sound subset, wrapped in `(select …)` per the existing `0140` InitPlan pattern. Exact policy names must be confirmed against `0044`/`0140` before editing (see *Open questions*).
- **Fail-closed:** a disabled module's routes/actions return the new `ServiceError('module_disabled')` → **HTTP 403** even on a forged/direct request. The exact `ServiceError`→HTTP normalizer site is **unconfirmed** (the Modular section admitted this); the `module_disabled → 403` mapping must be added wherever `forbidden`/`plan_limit_exceeded` are mapped.

### E. Domain pack identity
- **Canonical pack id lives in a new constrained column `organizations.domain_pack`** with values `charter_school | distribution | agriculture_food | retail_backroom | light_3pl`. The existing free-text `organizations.industry` is **migrated into it** (then kept as a display alias or dropped). The Nav section's reuse of `industry` and its `agriculture` (vs `agriculture_food`) key are **superseded** — one canonical id, `agriculture_food`.
- Packs resolve to a default module set via `modulesForPack(pack)` (core ∪ `defaultOnFor`).

### F. Grandfathering L4L Fresno (corrected)
- Identify pre-existing orgs **explicitly**, not by `created_at < now()` (which matches everything). L4L Fresno is confirmed the seed tenant (`0031_reset_l4l_fresno_test_data.sql`). The grandfather migration enables the **full charter_school module set** (incl. the premium modules L4L already exercises — AI, lot/serial capture) for all existing orgs, stamps `domain_pack='charter_school'`, and seeds `organization_nav_overrides` mobile tab slots to today's exact order (Home, Items, Books, POs, Scan). RLS predicates (`0147`) ship **after** the grandfather insert so no current write path breaks.

### G. Owner-config scope is phased (resolving the "simple vs rich" conflict)
- **Phase 1 (Foundation) ships the simple control plane:** module on/off (with `dependsOn` enforcement both directions), show/hide nav items, reorder (`sort_order`), and **mobile tab-slot assignment** (cap 5). This is the union of the Modular section's toggles + the essential Nav controls.
- **The Nav section's rich self-service** (drag-and-drop builder, per-surface section moves, per-user `user_nav_prefs`) is a **later phase** — valuable, but not required for the unlock.

### H. Mobile tabs respect Expo's file-based routing (feasibility correction)
- Expo Router is file-based: **every tab-eligible screen must physically exist as a route file and be statically registered.** Owners **select which of the pre-registered eligible screens** occupy the ≤5 slots; unselected ones are hidden via `href: null` (the trick already used for cycle-counts). The design **cannot conjure routes that have no file** — "owner picks tab slots" means choosing among existing screens, not arbitrary dynamic routes.

### I. Two config stores, clearly divided
- `organization_modules.settings` (jsonb) holds **per-module policy toggles** (e.g. `fefoEnforcement`, `requireSignatureOnDelivery`).
- The dedicated `*_defs` tables (`custom_field_defs`, `org_status_defs`, `document_templates`, `notification_event_types`) hold **org-level extensibility shared across modules**. They are complementary, not competing: module settings = "how this module behaves"; `*_defs` = "what custom shapes this org adds." Custom statuses **alias/skip** canonical states only — they never add states the DB-enforced transition trigger doesn't know (preserving the immutable state machine).

### J. Factual corrections applied throughout
- **139 migrations, highest `0143`** (not ~143).
- The **`order_requests` model is an internal/public-request flow, not an ecommerce sales-order model** — Shopify/Square order *ingestion* needs a mapping decision (treat as a new external-origin order, or a distinct `sales_orders` concept), not a naive write into `order_requests`. Flagged in Integration architecture + *Open questions*.
- **GS1 barcodes are addressed; EPCIS event capture is named but not fully modeled** in the vertical-pack section — listed as a deliberate later item in *Open questions*.

---

## Current-state audit

*Generated from a repo-grounded audit of 8 subsystems (the agents read the actual migrations, services, and nav code). Each subsystem lists what genuinely exists today, the reusable primitives, the charter-school-specific assumptions that block multi-industry use, and the gaps.*

### Stock execution core (ledger, reservations, locations, lots/serials)

The stock-core subsystem is an immutable ledger-based inventory execution engine with per-location balancing, soft-allocation reservations, and atomic movement recording. Stock position is computed from inventory_items.quantity_on_hand (a denormalized aggregate), with per-location detail in item_stock_levels. Movements are permanent audit events (immutable ledger). Transfers operate within-warehouse (no in-transit state); cross-warehouse moves are handled by shipments (a separate audit-only concept). Lot and serial tracking exist for received inventory only (receipt_line_lots + serial_registry), not for general stock. The system preserves stock integrity through RLS + security-definer RPCs (adjust_stock, transfer_stock, post_receipt_v2, post_cycle_count) that serialize critical writes via row locks.

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **stock_movements ledger** | db | Immutable append-only table (139 migrations, 0002_inventory.sql) recording every stock event: movement_type in (add\|remove\|adjust\|transfer\|receive_po\|return\|damage\|loss\|correction\|initial). Each row is a permanent audit fact. Co… |
| **inventory_items.quantity_on_hand** | db | Denormalized aggregate balance column (numeric(14,4), not null, default 0) on inventory_items. Updated atomically by adjust_stock + post_receipt_v2 + post_cycle_count RPCs only. Never updated directly; RLS policies + function security de… |
| **item_stock_levels per-location table** | db | Denormalized location-scoped balances (0002_inventory.sql). Unique on (item_id, location_id). Updated by transfer_stock RPC when moving qty between locations within a warehouse. Ledger entry (movement_type=transfer) is written even thoug… |
| **adjust_stock RPC (0004_phase2_helpers.sql)** | db | Core atomic stock mutation. Signature: adjust_stock(item_id uuid, quantity_change numeric, movement_type text, location_id uuid, reason text, notes text) → inventory_items. Locks the item row (for update), validates sufficient qty, updat… |
| **transfer_stock RPC (0004_phase2_helpers.sql)** | db | Within-warehouse location-to-location movement. Signature: transfer_stock(item_id, from_location_id, to_location_id, quantity, notes) → inventory_items. Validates quantity > 0, locations differ. Decrements from_location via item_stock_le… |
| **stock_reservations soft-hold table (0044_order_requests.sql)** | db | Soft allocation without ledger impact. Columns: organization_id, item_id, warehouse_id, order_request_id, quantity (>0), released_at (null while active), released_reason, created_at. Indexed on (organization_id, item_id) where released_a… |
| **post_receipt_v2 RPC (0015_lot_serial_tracking.sql + 0012_receipts.sql)** | db | Atomic inbound goods receipt. Signature: post_receipt_v2(purchase_order_id, warehouse_id, lines jsonb, idempotency_key, request_hash, notes) → receipts. For each line: validates tracking_type (lot\|serial\|none), calls adjust_stock(qty_a… |
| **receipt_lines + receipt_line_lots (0012_receipts.sql + 0015_lot_serial_tracking.sql)** | db | Received-goods line detail. receipt_lines has qty_received_base, qty_accepted_base, qty_rejected_base (checked: accepted + rejected ≤ received). receipt_line_lots (per lot, tracking_type=lot only) holds lot_number, expiration_date, qty_b… |
| **serial_registry lot/serial tracking (0015_lot_serial_tracking.sql)** | db | Unit-level asset registry for serial-tracked items. Columns: organization_id, item_id, serial_number, warehouse_id, current_status (available\|reserved\|damaged\|rejected\|sold\|rma), receipt_line_id, created_at. Unique constraint on (or… |
| **post_cycle_count RPC (0023_cycle_counts.sql)** | db | Physical count → system reconciliation. Atomically applies counted_quantity to every cycle_count_line with counted_quantity IS NOT NULL, calculates variance, writes adjust-type stock_movements for each variance, updates inventory_items.q… |
| **cycle_counts + cycle_count_lines (0023_cycle_counts.sql)** | db | Periodic recount sessions. cycle_counts (header): organization_id, warehouse_id, status (in_progress\|completed\|canceled), started_by, started_at, completed_by, completed_at. cycle_count_lines: expected_quantity (snapshot at session sta… |
| **warehouses + locations + inventory_items warehouse_id (0007_internal_company.sql + 0008_warehouse_charters.sql)** | db | Multi-warehouse scoping. warehouses table (first-class entity, code unique per org). locations (hierarchical bin/zone structure, warehouse_id fk). inventory_items.warehouse_id denotes item's home warehouse. warehouse_charters junction (o… |
| **inventory_items.item_type (0020_item_type.sql)** | db | Categorical tag for UI segregation: product\|book\|asset\|consumable. Default 'product'. Indexed on (organization_id, item_type). No schema difference; same table, same stock mechanics. Books use custom_fields.book_rack_number / book_rac… |
| **inventory_items.custom_fields JSONB** | db | Flexible per-item metadata (default {}). Used for: book_rack_number, book_rack_row, rack_number, rack_row (bin location display), plus arbitrary org-defined fields. No schema constraint; app layer handles validation. Supports UX branchin… |
| **inventory_items.tracking_type (0015_lot_serial_tracking.sql)** | db | Enum: none\|lot\|serial. Controls post_receipt_v2 validation. none: qty only. lot: requires lot_number + expiration_date per receipt line, sum of lot qtys must equal accepted qty. serial: requires one serial per accepted unit, each (org,… |
| **Shipments cross-warehouse transfer (0050_shipments.sql)** | db | Audit-only inter-warehouse movement. shipments table: source_warehouse_id, destination_warehouse_id, shipment_lines (qty_shipped, qty_back_ordered). No automatic stock deduction. Picking + shipping reduce stock via stock_reservations (so… |
| **RLS + security-definer RPCs** | db | All stock mutations (adjust_stock, transfer_stock, post_receipt_v2, post_cycle_count) are SECURITY DEFINER SQL functions. RLS policies on stock_movements, item_stock_levels, item_stock_levels are read-only for authenticated users; writes… |
| **model_number identifier (0133_inventory_model_number.sql)** | db | Manufacturer product ID (e.g. MX432LL/A for Beats Solo 3), distinct from SKU and barcode. Indexed on (organization_id, model_number) where model_number is not null. Autofill from UPC lookup chain (UPCitemdb → Gemini fallback); existing r… |
| **reorder_point + reorder_quantity (0002_inventory.sql + 0004_phase2_helpers.sql)** | db | Low-stock thresholds. Columns on inventory_items. low_stock_items(org_id) RPC returns items where quantity_on_hand ≤ reorder_point, sorted by deficit. No automatic PO creation; used for alerts + dashboard notifications. |

**Reusable primitives:** adjust_stock(item_id, quantity_change, movement_type, location_id, reason, notes) RPC — the core atomic stock mutation primitive; composable with any movement_type enum value. Used by receipts, cycle counts, and manual adjustments.; stock_movements immutable ledger (append-only, indexed, complete audit trail) — reusable for any industry needing transaction history. Movement types extensible beyond the current 11.; stock_reservations soft-hold table (unreleased qty that doesn't affect ledger) — portable to order systems, rental reservations, or loan tracking.; item_stock_levels per-location denormalization — decouples location-scoped balance queries from the global quantity_on_hand. Extensible to bin / pallet / aisle granularity.; warehouse_charters junction + user_can_access_inventory() helper (org, warehouse, charter, op) — reusable multi-tenancy + hierarchical access pattern. Charter label configurable per org (organization.terminology JSONB).; custom_fields JSONB on inventory_items — extensible metadata store for app-defined attributes (racks, dimensions, weight, supplier_sku, license_info, etc.) without schema migrations.; item_type enum (product|book|asset|consumable|…) — categorical branching on single table. Zero storage/query cost; scales to many types without table splits.; post_receipt_v2 RPC with idempotency_keys (org, scope, key, hash, status, resource_id) — three-way tie-breaking for partial retries + lot/serial validation. Transferable to any inbound goods system.; post_cycle_count(cycle_count_id) RPC — atomic batch reconciliation via variance calculation. Reusable for any periodic physical-count workflow.; RLS policies + SECURITY DEFINER functions — fine-grained per-org / per-warehouse / per-charter enforcement with InitPlan optimization (140_rls_initplan_wrap.sql). Proven pattern for charter-school + multi-tenant SaaS.; tracking_type + receipt_line_lots + serial_registry — optional lot/serial capture at receive time (no schema bloat for non-tracked items). Extensible to expiry, license plate (SSCC), pallet IDs.; transfer_stock(from_loc, to_loc, qty) RPC — zero-delta ledger entry for within-warehouse moves. Reusable for any WMS needing putaway / consolidation / cross-docking audit.

**Charter-specific assumptions to neutralize:**
- warehouse_id mandatory on inventory_items (0007_internal_company.sql backfill). Assumes every item 'lives' in one home warehouse; multi-location stock is per-location detail (item_stock_levels) not a separate master. Blocks pure cross-warehouse inventory pooling without explicit shipment.
- charter_id nullable on inventory_items (0008_warehouse_charters.sql). Generic stock (charter_id = null) is usable by any charter the warehouse services. Breaks multi-tenant use cases where orgs are fully isolated (no shared warehouse concept).
- warehouse_charters M:M junction implies warehouses are charter-scoped (0008_warehouse_charters.sql). A warehouse services 1..N charters; items belong to a charter or are generic. Does not support warehouse serving infinite customers (e.g. 3PL drop-ship).
- user_warehouse_assignments (0007_internal_company.sql) assume staff/viewer role restriction to assigned warehouses. Manager/admin/owner auto-access all warehouses in org. Does not support role-based column-level restrictions (e.g., manager sees only cost, staff sees qty only).
- organizations.terminology JSONB label override (0007_internal_company.sql) only supports charter/warehouse/role renaming. Does not support org-level terminology for item types, movement types, statuses, or custom field names.
- Shipments (0050_shipments.sql) are always source → destination warehouses. No 'drop ship' / 'reroute' / '3PL staging' state. Work order number auto-generated per destination+date; no carrier integration, no tracking #.
- receipt_line_lots + serial_registry only capture at receive time (0015_lot_serial_tracking.sql). Lot rotation / serial retirement / expiry enforcement is app-layer only; no DB constraints on out-of-stock serials or expired lots.
- quantity_on_hand denormalized on inventory_items (0002_inventory.sql), computed by applying successive movements. No separate 'available' vs 'reserved' quantity split in the item row. Reserved qty is tracked in stock_reservations table (soft-holds for orders only).
- Cycle count (0023_cycle_counts.sql) is per-item snapshot + recount, not location-aware counting (no cycle_count_locations table). Two warehouses physically counting the same item must run separate cycle_count sessions.
- No explicit 'holds' / 'quarantine' / 'in-inspection' stock state. Rejected qty in receipt_lines is dropped (not recorded as sellable/reservable inventory). Damaged/loss are movement types but no separate 'damaged goods' warehouse scoping.

**Gaps for a configurable WMS:**
- No lot/expiry enforcement on outbound. serial_registry.current_status allows manual override (available|damaged|rejected|sold|rma) but there is no auto-rule 'if expiration_date < today, mark damaged'. App layer must implement shelf-life warnings.
- No automatic PO generation on low stock. low_stock_items() and low_stock_count() exist for reporting; no trigger to create draft POs or send buyer alerts when threshold crossed.
- No transfer 'in-transit' state. transfer_stock deducts source immediately, increments dest immediately. Cross-warehouse shipments rely on stock_reservations (soft-hold on order approval) to prevent dual-allocation, but no explicit 'package in motion' ledger state.
- No multi-UOM storage. unit_of_measure on inventory_items is a single string (e.g., 'EA', 'BOX', 'PALLET'). No uom_conversions table; 10 BOX = 100 EA conversions must be managed app-side or via custom_fields.
- No ability to track cost changes across movements. stock_movements has quantity_change, previous_qty, new_qty but no unit_cost. Receipt lines capture unit_cost_at_receive, but adjustments (damage/loss/correction) do not record cost impact. Inventory value is moment-in-time (sum of unit_cost * qty_on_hand).
- No cycle count location filtering. cycle_counts are warehouse-level or item-level, not location-level. Two counters cannot split 'count all items in Aisle 5' independently; one session per item per warehouse.
- No partial receipt reversal. reverse_receipt_id on receipts table is a 1:1 link (a receipt reverses exactly one prior receipt). Selective line-item reversal (e.g., 'only reverse 5 of the 10 units we received') requires a full reversal + new receipt adjustment.
- No license-plate / SSCC pallet tracking. No putaway_moves table linking serials/lots to putaway tasks. Bin location is in custom_fields (denormalized); no pallet/case-level hierarchy.
- No threshold-driven cycle count auto-generation. No rule like 'if variance > 10% or qty mismatch > 5, auto-flag item for recount'. Cycle counts are always manual initiative.
- No time-series stock position query. To reconstruct qty on a historical date, must replay stock_movements from that date forward. No snapshot table (e.g., daily_stock_balances) for fast time-travel queries.
- No configurable movement types or reasons. movement_type enum is hardcoded (11 values: add, remove, adjust, transfer, receive_po, return, damage, loss, correction, initial, plus movement_type='transfer' for cross-warehouse). Adding a new type requires schema change.
- No audit of who released a reservation. stock_reservations.released_at is a timestamp but released_reason is text, not a reference to a user_id. Cannot answer 'who approved the delivery that released this reservation?'.
- No support for item kit / bundle stock (0040_bundles.sql exists but it is separate, not integrated into quantity_on_hand calculation). Bundle components have independent stock; no automatic 'consume components when bundled' ledger entry.
- No hold/claim for warranties or extended service. If an item is sold with a 3-year warranty requiring replacement stock, the reserved qty is not ear-marked for the warranty claim (it's just a soft-hold on the order_request).
- No negative-quantity hard stop. adjust_stock raises 'insufficient_stock' if new_qty < 0, but the error is raised at RPC time. No dead-letter queue or approval gate for would-be-negative adjustments (e.g., 'please confirm loss of 100 units' dialog).

### Permissions, roles, RLS & multi-tenancy

StockPilot is a multi-tenant warehouse system with role-based permissions (owner/admin/manager/staff/viewer) enforced at three layers: (1) UI nav filtering via permission matrix; (2) server-side permission asserts in service actions; (3) database RLS using is_org_member() and has_org_role() STABLE functions. Every table has organization_id; queries are scoped by (userId, organizationId) at the RLS level. Multi-factor authentication is configurable per org (optional/admins_required/all_required) and checked on every permission gate. Warehouse access (staff/viewer only) is scoped via user_warehouse_assignments; manager+ have implicit access to all warehouses. Terminology is configurable (charter/warehouse labels). There is NO org-level feature-toggle or module-activation mechanism; all features are always available and gated only by role + plan limits (hard-coded resource counts: items, locations, members per plan tier).

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **Role-Based Permission Matrix** | web \| api | Five immutable roles (owner/admin/manager/staff/viewer) with fixed permission sets. Permissions are defined in packages/core/src/constants/permissions.ts (59 permissions total: organization, members, billing, items, stock, locations, cat… |
| **Permission Enforcement (UI & Action Layer)** | web \| api | Web nav dynamically filters using hasPermission(role, permission) in apps/web/src/components/dashboard/nav.ts (BASE_NAV + ADMIN_NAV). Server actions and API routes call assertPermission(ctx, permission) in apps/web/src/server/services/co… |
| **Database Row-Level Security (RLS)** | db | All tenant tables (inventory_items, stock_movements, locations, etc.) have RLS enabled. Policies use is_org_member(org_id) and has_org_role(org_id, min_role) STABLE SECURITY DEFINER functions (supabase/migrations/0001_init.sql). Policies… |
| **Multi-Factor Authentication (MFA) Policy** | web \| api \| db | organizations.mfa_policy column (migration 0009): 'optional' \| 'admins_required' \| 'all_required'. Resolved at request time in resolveMfaState() / resolveApiMfaState() (context.ts, api-context.ts). If mfaRequired && !mfaSatisfied, asse… |
| **Warehouse-Scoped Access** | web \| api | Staff and viewer roles are warehouse-scoped. Manager+ have implicit all-warehouse access. Scope is tracked in user_warehouse_assignments table (organization_id, user_id, warehouse_id, is_primary, charter_id). getWarehouseAccess() compute… |
| **Viewer Category Restriction** | web \| api \| db | Read-only viewers can be restricted to specific inventory categories via user_category_assignments table (migration 0128). Managers+ can assign/revoke per category. Enforced by viewer-specific RLS policy on inventory_items that checks us… |
| **Organization Terminology (Charter & Warehouse Labels)** | web \| mobile | organizations.terminology (jsonb, migration 0007) stores {charter_singular, charter_plural, warehouse_singular, warehouse_plural}. Default: 'Charter'/'Charters'/'Warehouse'/'Warehouses'. UI and reports reference terminology at runtime vi… |
| **Session Context & API Authorization** | web \| api | withContext() (service) and withApiContext() (API routes) build ServiceContext: {organizationId, userId, role, supabase, mfaRequired, mfaSatisfied}. Cookie-based (web) and bearer-token (mobile/API) flows. X-Organization-Id header honored… |
| **Audit Logging & Activity Tracking** | web \| db | activity_logs and audit_logs tables (org-scoped RLS). Privileged actions recorded automatically via server-side triggers and explicit log_audit() RPC calls. activity_logs:read permission gates the Movements nav item + reports. Admins acc… |
| **Plan-Based Resource Limits** | api | organizations.plan (text, values: 'free'/'pro'/'business'/'enterprise'). PLANS constant in packages/core/src/constants/plans.ts defines limits per tier: members, items, locations, imagesPerItem, attachmentsPerItem, plus feature flags (ap… |

**Reusable primitives:** Multi-tenancy foundation: organization_id on every table, organization_members as the single membership source, user_profiles.default_organization_id for session routing; RLS helper functions (STABLE SECURITY DEFINER): is_org_member(org_id), has_org_role(org_id, min_role), user_org_role(org_id) used in all 91+ policies across 50+ tables (0001_init.sql, 0140_rls_initplan_wrap.sql); Permission matrix pattern: flat PERMISSIONS array, ROLE_PERMISSIONS record, hasPermission/assertPermission functions reusable across UI/API/tests (packages/core/src/constants/permissions.ts); Warehouse assignment abstraction: getWarehouseAccess() returns readableIds/writableIds/hasAllAccess/primaryWarehouseId, enables both UI filtering and service-layer scoping (apps/web/src/lib/auth/warehouse.ts); Category-scoped viewer access: user_category_assignments table + viewer-specific RLS query function (public.user_can_see_category_items), permission:members:assign_categories for mgr+ to control viewer reach; Terminology override pattern: organizations.terminology jsonb + resolveTerminology() utility, allows per-org label customization without schema changes or feature flags (packages/core/src/constants/terminology.ts); MFA as a core security gate: mfa_policy (optional/admins_required/all_required) evaluated once per request, step-up via AAL2 for mutations, fail-CLOSED semantics (resolveMfaState, assertCurrentAal2); Service context wrapper: withContext (RSC) + withApiContext (routes) unify permission + MFA + warehouse scope resolution, eliminates boilerplate in 100+ service methods; Plan-limit architecture: PLANS lookup, assertPlanLimit(resource, count) checks quota before write, ServiceError('plan_limit_exceeded') surfaces to UI as upgrade nudge; Audit trail primitives: activity_logs (org-scoped RLS) + audit_logs (admin-only) + explicit log_audit(action, details) RPC for high-risk ops, enables compliance tracking without per-module work

**Charter-specific assumptions to neutralize:**
- roles and permissions are hard-coded (ROLES const, ROLE_PERMISSIONS static record) — no custom roles per org despite 'customRoles' feature flag in plans. The UI (Settings > Roles) is a read-only reference, not a config editor.
- five fixed roles (owner/admin/manager/staff/viewer) are hard-coded in supabase/migrations/0001_init.sql and packages/core/src/constants/roles.ts — no branching based on industry
- MFA policy applies org-wide to all users; no per-user or per-role MFA toggles (only global optional/admins_required/all_required)
- warehouse-scoped access (user_warehouse_assignments table) is ONLY applied to staff + viewer roles. Manager+ get implicit all-warehouse access regardless of assignments. No customizable warehouse scope per user for manager+.
- terminology overrides are limited to charter_singular/charter_plural/warehouse_singular/warehouse_plural. Other UI labels (e.g., 'Item', 'Location', 'Category') are hard-coded.
- plan limits (members, items, locations) use fixed PLANS record keyed by organizations.plan text value. No dynamic per-org entitlements or feature-gating outside the four hard-coded tiers.
- every table's RLS assumes organization_id column exists and uses is_org_member/has_org_role. New tables automatically get charter-school-oriented RLS policies. No pluggable RLS templates per industry.
- activity_logs and audit_logs are org-scoped but not per-warehouse or per-module; all privileged actions land in a single org-wide log. No industry-specific audit requirements can override this.
- the public order links (/r/[token]) are global per org, not per warehouse or module. No industry-specific customization of the external request form.
- warehouse + charter hierarchy (charters > warehouses > locations/bins) is baked into migrations and assumed throughout the codebase. Distribution/agriculture/retail will need to run schema but scope queries may not align with their physical topology.

**Gaps for a configurable WMS:**
- No org-level feature toggle or module-activation table. All features are always enabled and visible; gating is only role + plan limits. Turning off 'Rentals' or 'Procedures' or 'Cycle Counts' for a specific org requires nav-level filtering that doesn't exist (would need a org_enabled_modules JSONB or similar).
- No custom roles per org. The 'customRoles' feature flag in the business/enterprise plan is a lie — roles are hard-coded at compile time. Organizations cannot create 'Supervisor' or 'Lead' or 'Analyst' roles.
- Plan limits are hard-coded per tier. No way to grant an org 15,000 items under the 'Pro' plan or 100 members under 'Business' without a code change. No dynamic entitlements or overrides.
- No per-module permissions. A user either has stock:adjust (can do cycle counts, adjust stock, transfer) or doesn't — there's no way to allow cycle counts but forbid stock transfer, or to restrict PO approvals to a subset of staff.
- No permission delegation or temporary privilege escalation (other than MFA step-up to AAL2). An admin cannot grant another admin temporary owner-like powers for a specific action.
- Warehouse-scoped viewer category restriction works but viewer_category_assignments is stored at org level, not warehouse level. A viewer assigned to a category can see that category's items across all warehouses they're assigned to. No way to say 'viewer can see Books category only in Warehouse A'.
- No audit log filtering or retention policy. All activity_logs are kept forever, org-scoped. No TTL, no per-module logging toggle, no sensitive-field masking.
- No permission groups or templates. Each permission must be listed individually in ROLE_PERMISSIONS. No way to define 'read-only inventory' as a permission group and reuse it across roles or industries.
- RLS policies are static. No runtime policy injection based on org config (e.g., 'this org's staff can edit supplier names' vs 'that org's staff cannot'). All policies are fixed at migration time.
- No Service Account / API Key alternative to bearer-token auth. API access requires a user account + token. No way to give a third-party integration a permanent, scoped API key without creating a user.

### Navigation composition (web + mobile)

Navigation in StockPilot is entirely hard-coded in static TypeScript arrays with role-based permission filtering. The web sidebar uses a BASE_NAV array (Inventory, Workspace sections) plus an ADMIN_NAV section, with navForRole() filtering items by Permission and requiresAdmin flags. The mobile app mirrors web nav via DRAWER_SECTIONS (same Inventory/Workspace/Admin structure) plus a separate 5-tab bottom bar (Home, Items, Books, POs, Scan) defined in the tabs/_layout.tsx file with inTabs flags. The dashboard homepage surfaces "quick actions" (Review low stock, Open POs, etc.) and attention items (low stock, overdue POs, pending approvals, cycle counts, orders awaiting signature) but all navigation hierarchy, terminology ("Inventory", "Workspace", "Admin"), section labels, and icon mappings are baked into source code. Terminology for "Charter" and "Warehouse" singular/plural CAN be configured per-organization in organizations.terminology (JSONB), but nav item labels and structure itself cannot.

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **Web sidebar nav (BASE_NAV)** | web | Static role-filtered navigation with sections: Overview, Inventory (13 items including Items, Books, Categories, Tags, Movements, Rentals, Bundles, Orders, Cycle counts, Procedures, POs, Locations, Suppliers, Reports), Workspace (AI, Sch… |
| **Web admin nav (ADMIN_NAV)** | web | Eight admin-only items (Admin overview, Charters, Warehouses, Bins, Users, Vendor mappings, UoM conversions, Reconciliation, Audit log). Gated by requiresAdmin: true flag; only admin/owner roles see this section. Appended to BASE_NAV by … |
| **Mobile drawer nav (DRAWER_SECTIONS)** | mobile | Mirrors web nav structure with id, href, label, icon, inTabs?, admin? flags. Five sections: unnamed (Overview), INVENTORY (17 items, same as web), WORKSPACE (AI, Schedule, Notifications, Team, Settings), TOOLS (Scan), ADMIN (same 9 items… |
| **Mobile bottom tabs bar** | mobile | Five fixed-position tabs defined in apps/mobile/app/(drawer)/(tabs)/_layout.tsx: Home (index), Items (inventory), Books, POs (receive), Scan. Uses expo-router Tabs layout with BlurView on iOS. Tab icons and labels hard-coded in Tabs.Scre… |
| **Dashboard quick actions** | web | Shift command section on /dashboard/page.tsx with five hard-coded QuickAction cards: Review low stock, Open POs, Cycle counts in progress, Create receiving run, Open reports. Pulls live counts (lowStockCount, openPoCount, openCycleCount)… |
| **Dashboard attention items** | web | Morning briefing hero section dynamically renders AttentionItem[] with 5-category list: low stock (rank 1), overdue POs (rank 2), pending approvals (rank 3, manager+ only), in-progress cycle counts (rank 4), orders awaiting signature (ra… |
| **Permission-based nav filtering** | web, mobile | Every nav item (web and mobile) optionally declares requires: Permission (e.g., items:read, purchase_orders:manage). navForRole() and drawer-content component filter by hasPermission(role, permission). Admin items declare requiresAdmin: … |
| **Org terminology override (Charter/Warehouse)** | web, mobile | organizations.terminology JSONB stores charter_singular/plural, warehouse_singular/plural. resolveTerminology() merges with DEFAULT_TERMINOLOGY. Used in org settings page, admin charters/warehouses nav labels, and throughout UI. Does NOT… |

**Reusable primitives:** NavItem interface (web): href, label, icon, badge?, alert?, requires?: Permission, requiresAdmin?: boolean—could be extended with visibility flags, feature flags, or order/weight fields for reordering; DrawerNavItem interface (mobile): id, href, label, icon, inTabs?, admin?—mirrors web but lighter; could be unified with NavItem + transformation layer; navForRole(role: Role) filtering function: declarative permission gates via ROLE_PERMISSIONS matrix + hasPermission() checks. Could be extended to support feature flags, tier-based features, or warehouse-scoped visibility; OrgTerminology JSONB store in organizations table: extensible key-value config for any per-org label rename. Could be generalized to store nav reordering, visibility toggles, quick-action customization; Dashboard attention items: dynamic rank+tone model (5 fixed categories with 1-5 rank order). Could be extended to support custom attention workflows per industry vertical; Permission matrix (ROLE_PERMISSIONS): source of truth for role capabilities. Could be extended to include nav visibility, feature availability, API scope gates

**Charter-specific assumptions to neutralize:**
- ADMIN_NAV hard-coded with 'Charters' and 'Warehouses' items: assumes charter/warehouse-scoped multi-location model. For retail (single location) or agriculture (land-parcel-centric), admin nav sections are over-prominent.
- Movements as a top-level nav item: tied to activity_logs:read permission and assumes warehouse-centric stock tracking. Food/agriculture may need lot/serial/batch-centric movements instead.
- Rentals item in Inventory nav: specific to charter-school supply-circulation use case (canopies, equipment). Absent for pure product distribution or retail. No flag to hide it per-org.
- Books item at same level as Items: reflects textbook inventory as co-equal to product. Food/retail have no books. Appears in both web nav and mobile tabs; no way to demote or hide.
- Schedule (calendar events) in Workspace nav: charter schools schedule distributions; food logistics may need work orders or shifts instead. No configuration.
- PO imports as separate nav item: assumes batch vendor-format PO intake. Pure 3PL or agriculture may only need per-PO manual entry. Nav item is always visible when user has purchase_orders:manage permission.
- Terminology overrides limited to Charter/Warehouse singular/plural: does NOT allow renaming of 'Inventory', 'Workspace', 'Admin', 'Items', 'Books', 'Orders', 'Movements', 'Rentals', 'Bundles', 'Cycle counts', 'Procedures', 'Locations', 'Suppliers', 'Reports', 'Team', 'Settings'. Hard-coded in nav.ts and drawer-nav.ts source.
- Dashboard hero section always shows 'Shift command' with five actions: no way to hide, reorder, or swap for industry-specific operations (e.g., food recalls, agriculture crop health).
- Mobile tabs bar fixed to 5 items (Home, Items, Books, POs, Scan): no way to customize for other industries. Cycling counts was removed; settings moved to drawer-only. Tab set is immutable per deployment.

**Gaps for a configurable WMS:**
- No nav customization UI for owners/admins: Cannot reorder, hide, or rename nav items. No feature-flag or tier-based nav visibility (all free-plan orgs see the same nav shape).
- No feature flags or vertical-specific nav packs: Nav structure is identical for charter schools, food distribution, agriculture, retail. Different industries need different nav hierarchies but source code nav arrays don't support branching logic.
- No way to add custom nav items: Nav is a closed set defined at deployment. If a customer wants a custom 'Supplier Portal' or 'Lot Tracking' top-level item, code change required.
- Terminology override only covers Charter/Warehouse: Industry-specific entities ('Lot', 'Serial', 'Crop', 'Batch', 'Shift', 'Route') cannot be added to the terminology JSONB without schema + source code changes.
- Dashboard quick actions hard-coded to 5 specific destinations: No way for a food/agriculture customer to replace 'Cycle counts in progress' with 'Pending lot disposition' or 'Recalls active'.
- Mobile nav mirrors web but with separate source (drawer-nav.ts vs nav.ts): Changes to web nav require manual sync to mobile. No shared nav definition; drift risk.
- Permission matrix tied to charter-school workflow: Permissions like 'rentals:create', 'cycle_counts:assign', 'bundles:manage' are charter-specific. Food/agriculture would need 'lot:assign', 'compliance:review', 'safety:approve' but these don't exist.
- No nav-item weighting/ordering system: Items within a section are defined in source order. No way to boost high-priority items (e.g., 'Review low stock' as first nav item instead of deeply nested under Inventory).
- Admin section always shows all 9 items: No way to hide Bins, Vendor mappings, or UoM conversions for customers who don't need them. All-or-nothing gate (requiresAdmin only).
- Bottom tabs bar fixed in code: Cannot hide Books for retail; cannot add custom tabs for agriculture (e.g., Lot Scanner, Crop Health). Tab set requires code change per customer.

### Organization configuration & terminology

The organization configuration subsystem in StockPilot is a lightweight, role-based settings surface without per-org customization of statuses, templates, or notification event types. Configuration is primarily stored on the `organizations` table (name, logo, timezone, terminology jsonb, mfa_policy, po_terms, public_request_* fields) with supplementary user-level preferences in `user_profiles` (email_digest_optin, digest_section_* toggles) and `notification_preferences` (per-event email/push toggles, user-scoped). Terminology overrides are applied everywhere via resolveTerminology() merges and used in nav/UI. Owner/admin-only gates control all org-level settings. No custom fields, custom statuses, custom document templates, or custom notification event definitions exist in the schema—all are hardcoded in the application layer.

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **Organization Branding** | web | Logo upload, org name, industry/size tags. Logo stored as URL in organizations.logo_url, displayed in sidebar and emails. Max 5 MB, square or wordmark format. Owner/admin only. |
| **Terminology Overrides** | web | Rename 'Charter'/'Charters' and 'Warehouse'/'Warehouses' to custom labels (e.g., 'Region', 'Division', 'Branch'). Stored in organizations.terminology jsonb with keys charter_singular, charter_plural, warehouse_singular, warehouse_plural.… |
| **Timezone Configuration** | web | Pin all date/time rendering (pick slips, packing slips, reports, schedule, dashboard) to org timezone. Stored in organizations.timezone. Constrained to ORG_TIMEZONE_OPTIONS enum. Owner/admin only. |
| **PO Terms (Purchase Order Footer)** | web | Free-form text printed at bottom of every PO PDF. Stored in organizations.po_terms (text, nullable). Owner/admin only. Omitted from PDF if empty. |
| **MFA Policy (Organization-Wide)** | web | Three-tier enforcement: 'optional' (default), 'admins_required', 'all_required'. Stored in organizations.mfa_policy text. AAL2 step-up required for password change when MFA enabled. Admin-only setting visible on /dashboard/settings/secur… |
| **Public Request Token & Settings** | web | Shareable token for external order requests (public link). Stores organizations.public_request_token, public_request_token_rotated_at, public_request_blurb. Per-warehouse toggle: warehouses.is_public_orderable. Manager+ can rotate token,… |
| **Weekly Email Digest (User-Level)** | web | Master toggle in user_profiles.email_digest_optin. Per-section toggles: digest_section_low_stock, digest_section_open_pos, digest_section_cycle_counts (all bool, default true). User can configure own preferences; staff+ can view org's di… |
| **Per-Event Notification Preferences** | web | User-scoped rows in notification_preferences (email_low_stock, email_po_status, email_weekly_digest, email_team_invites, push_low_stock, push_po_status, push_stock_transfer—all bool, default true). Events are hardcoded in the app layer; … |
| **Audit Log (Read-Only)** | web | Queries activity_logs table. Admin+ only. Searchable by event, actor (user_id), entity_type, entity_id, date range. Events are system-generated (inventory.item.created, warehouse.updated, etc.); no custom audit events. IP address capture… |
| **Soft-Delete Recovery** | web | Restore soft-deleted items, categories, suppliers, locations. items:delete permission required (owner/admin only). No custom recovery templates or selective recovery rules. Just a UI to un-set deleted_at per entity. |
| **Role-Based Access Matrix** | web | Five fixed roles (owner, admin, manager, staff, viewer) with hardcoded permission matrix defined in packages/core/src/constants/permissions.ts. No custom roles, no per-warehouse role overrides for managers. Permissions include organizati… |
| **Billing Plan & Usage** | web | Organizations stored with plan (free\|pro\|business\|enterprise), stripe_customer_id, stripe_subscription_id, trial_ends_at. Plan enforces limits on items, members, locations. No usage-based throttling; only plan-tier gating. Billing act… |
| **AI Embeddings Configuration** | web | Backfill control panel at /dashboard/settings/ai (admin+ only, ai:manage permission). Tracks inventory_items.embedding column (null = not embedded). Backfill is opt-in; no org-wide embedding policy. Model selection, backfill status, and … |

**Reusable primitives:** organizations table schema (id, name, slug, logo_url, timezone, currency, terminology jsonb, mfa_policy, po_terms, public_request_token/rotated_at/blurb, plan, stripe_*, trial_ends_at, created_at, updated_at); resolveTerminology(input) function merges user input with DEFAULT_TERMINOLOGY; applied in every UI page that renders org-specific labels; user_org_role(org_id) RPC returns role string for auth.uid() in the org; used by every permission check and RLS policy; has_org_role(org_id, min_role) RPC returns boolean, gating access to admin/manager/staff/viewer features; core of RLS enforcement; Notification_preferences table (user_id PK, email_*, push_* bool columns) shared across all modules; schema omits custom event types by design; User_profiles table columns for digest control (email_digest_optin, digest_section_low_stock, digest_section_open_pos, digest_section_cycle_counts) reused by digest query + UI toggles; Audit_logs table (organization_id, user_id, event string, metadata jsonb, created_at, ip) with RLS scoped to org members; used by recovery + audit UI, searchable by free text; ROLE_PERMISSIONS matrix in packages/core/src/constants/permissions.ts (Record<Role, readonly Permission[]>) is the single source of truth for role access; no admin UI to edit; Terminology stored as jsonb (charter_singular, charter_plural, warehouse_singular, warehouse_plural) to allow translation without schema changes; applied at query and render time via resolveTerminology(); MFA_policy field on organizations (optional|admins_required|all_required) enforced at Supabase auth layer via custom auth hook; org members query it to determine if MFA enrollment is mandatory; Public_request_token on organizations + is_public_orderable on warehouses enable external order requests without requiring auth; implementation is read-only from public user perspective (no config API for public users)

**Charter-specific assumptions to neutralize:**
- No custom document template system: PO terms are free-form text only; packing slips, pick slips, and reports use hardcoded layouts. No template builder or per-org template overrides.
- No custom status types: order_requests, purchase_orders, and other statuses are hardcoded enum strings in the app layer. No org-level status customization or per-workflow status definitions.
- No custom event types for notifications: notification_preferences table has fixed columns (email_low_stock, email_po_status, etc.). No framework for adding new event types per org.
- No custom field definitions: inventory_items.custom_fields jsonb is used for book metadata (author, isbn, rack_number) but not exposed as a configurable schema. Users cannot define custom fields via UI.
- Role assignments are global per org: No warehouse-scoped role overrides or per-location permission exceptions. Managers access all warehouses; staff/viewer assignment is via user_warehouse_assignments table (warehouse-level, not role-level).
- Terminology is org-wide, not per-user or per-role: If one org says 'Region' instead of 'Charter', all members see 'Region'. No per-role terminology customization.
- No field-level RLS or attribute-based access control: RLS is coarse-grained (org membership + warehouse assignment). No masking, redaction, or column-level access policies per user.
- Audit log is read-only from UI: No event filtering rules, no selective audit enablement per entity type, no archival policies. All privileged actions are logged to activity_logs; no way to suppress audit for specific entity types.
- Digest content is fixed: Weekly digest sections (low stock, open POs, cycle counts) are hardcoded. Users can only toggle entire sections on/off, not customize digest report structure.
- Public requests are org-wide: The public_request_token is scoped to the organization, not individual warehouses or users. All warehouses marked is_public_orderable share the same public link and token.
- No audit log retention policies: activity_logs has no built-in purge, archive, or replication settings. Deletions via soft-delete recovery bypass the audit (deleted_at is manually un-set, not logged as 'restored').

**Gaps for a configurable WMS:**
- No custom document templates: Organizations cannot upload or configure packing slip, pick slip, or report layouts. All outputs use hardcoded templates.
- No custom statuses or workflows: order_requests, purchase_orders, and other entities have fixed status enums. No org-level workflow builder or custom status definitions.
- No custom notification events: notification_preferences columns are hardcoded. Organizations cannot define new notification types (e.g., 'notify me when supplier changes price') without code changes.
- No custom fields UI: inventory_items.custom_fields jsonb exists but is not exposed as an admin-configurable schema. Book-specific fields (author, isbn, rack_number) are hardcoded in app logic.
- No per-location permissions: Warehouse-scoped RLS exists but role-level overrides per location do not. A manager manages all warehouses; a staff member is assigned to specific warehouses but cannot have a narrower role in one warehouse vs. another.
- No audit log retention or archival policies: activity_logs has no TTL, no selective logging (all privileged events are logged), no export/archive mechanism. Growing audit trail is unbounded.
- No field-level redaction or masking: RLS is coarse (org + warehouse). No way to hide sensitive fields (e.g., supplier pricing) from certain users while showing them to others.
- No custom digest sections or scheduling: email_digest_optin controls master on/off; digest_section_* toggles control three hardcoded sections. No per-user digest schedule (always weekly) or additional sections.
- No terminology per role or warehouse: Terminology is org-wide. All members see the same 'Charter' or 'Region' label. No way to use different terminology in different warehouses (e.g., 'Location' in warehouse A, 'Bin' in warehouse B).
- No PO term templates or versioning: po_terms is a single free-form text field. No dated versions, no conditional PO terms per supplier or warehouse, no template library.
- No public request filtering rules: is_public_orderable is a boolean per warehouse. No item-level restrictions (e.g., 'these 5 items are public orderable; the rest are staff-only'). No time-based public availability.
- No configurable MFA enforcement per warehouse: mfa_policy is org-wide. Cannot require MFA for managers in warehouse A but not warehouse B.
- No bulk configuration export/import: Settings are edited via UI forms. No API to bulk export / import org settings for multi-org migrations or templates.
- No AI model selection or fine-tuning controls: /dashboard/settings/ai only exposes backfill progress, not model selection, temperature, or retrieval parameters. Embedding config is hard-coded (Gemini, 768 dims).

### Modules — orders fulfillment: Orders, Rentals, Bundles, Schedule Events, Procedures, Notifications, Order Attachments

Orders/fulfillment is a sophisticated multi-stage workflow system built around an immutable stock ledger + soft-hold reservations. The core order_requests table tracks state through 14 statuses (pending_confirmation → completed/denied/cancelled) with a database-enforced state machine (migration 0109). Orders support both internal org-member requests and public-link anonymous submissions (anti-spam via email confirmation tokens, migration 0108). Two fulfillment paths (pickup/delivery) with picking, packing, staging, and signature workflows are structurally in place (columns added, RPCs partially scaffolded) but operationally incomplete — phases 3-6 require UI + action-layer implementations. Rentals track circulating assets via soft reservations. Bundles support virtual recipes + pre-assembled kits with phantom inventory items. Schedule events coordinate work (location, dates, status). Procedures provide org-wide SOPs with video + threading. Notifications fire in-app bells + emails on status changes. Order attachments store proof-of-delivery photos in a private Storage bucket. Every design assumes charter schools (terminology, books items, delivery_charter_id columns). The entire subsystem is organization-scoped and warehouse-scoped with RLS enforcing membership + role checks.

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **Order Requests (Core Lifecycle)** | web \| db | order_requests table with 14-state machine: pending_confirmation → pending_approval → approved → pick_slip_generated → picking_in_progress/complete → packing_slip_generated → staged_for_pickup/delivery → in_transit/completed OR denied/ca… |
| **Public Order Links (/r/[token])** | web \| api | Anonymous submission flow: POST /api/v1/public/order-requests with org-scoped public_request_token (on organizations table). Anti-spam: pending_confirmation status with email confirmation token + 24h expiry (migration 0108); cleanup_expi… |
| **Order State Machine & Transition Validation** | web \| db | 14 statuses with strict allowed transitions (packages/core/src/order-state-machine.ts). Fulfillment-type guards: staged_for_pickup requires pickup, staged_for_delivery requires delivery. assigned_delivery_user_id must be set before in_tr… |
| **Stock Reservations (Soft Holds)** | db | stock_reservations table (migration 0044): quantity soft-hold on approve_order_request, released on deliver or cancel. Tracks order_request_id + item_id + warehouse_id. Released_at + released_reason mark the hold as inactive. Active hold… |
| **Order Request Lines (Items + Quantities)** | db | order_request_lines table: item_id + quantity_requested + quantity_fulfilled + unit_cost_at_request + notes. Migration 0109 added quantity_picked (partial pick tracking), picked_at/by, quantity_packed, packed_at/by. Used by pick slip gen… |
| **Pick/Pack/Staging Columns (Phase 3-5 Foundation)** | db | Migration 0109 added 30+ columns to order_requests for full fulfillment tracking: pick_slip_generated_at/by, picking_completed_at/by, packing_slip_generated_at/by, staged_at/by, assigned_delivery_user_id/at/by, in_transit_at/by, signatur… |
| **Fulfillment Types (Pickup vs. Delivery)** | db \| web | fulfillment_type column on order_requests (pickup \| delivery, defaults delivery per migration 0109). Drives state machine branching: packing_slip_generated → staged_for_pickup OR staged_for_delivery. Pickup path: staged_for_pickup → com… |
| **Notifications (In-App + Email)** | db \| web | Trigger _notify_order_request_changes (migration 0044, extended 0108-0109) fires in-app notifications for managers on new request (pending_confirmation excluded for public spam prevention), requester on approved/denied/completed/cancelle… |
| **Order Attachments (Proof of Delivery)** | db \| web | order_request_attachments table + order-attachments private Storage bucket (migration 0142). Path: {org_id}/{order_request_id}/{uuid}.{ext}. RLS: org members read, managers insert/delete. kind field: signature \| dropoff_photo \| locatio… |
| **Rentals (Circulating Assets)** | db \| web | rentals table (migration 0131): tracks checkout/return of circulating items (canopies, equipment). One row per rental with borrower_user_id (nullable, vendors have no account) + borrower_name + borrower_email. Status: out \| returned \| … |
| **Bundles (Kits & Pre-Assembly)** | db \| web | bundles table (migration 0040): define reusable kit recipes. Components stored in bundle_components (bundle_id + item_id + qty + is_optional). Preassembly_enabled toggle switches virtual-recipe mode vs. pre-boxed phantom items. assemble_… |
| **Bundle Distributions (Event-Triggered Kits)** | db \| web | bundle_distributions table (migration 0040): one row per distribute run, links to optional schedule_event_id so kit shipments for an event are traceable. Shortage_recorded boolean flags when allow_shortage=true but a required component w… |
| **Schedule Events (Coordinate Work)** | web \| db | schedule_events table (migration 0032, 0033): org-wide calendar. Title + starts_at + ends_at + all_day + location_text + warehouse_id (optional filter) + requester_name + details + status (scheduled\|in_progress\|completed\|cancelled). A… |
| **Procedures (Standard Operating Procedures)** | web \| db | procedures table (migration 0053): org-wide knowledge base. Title + description + body (markdown). Optional category_id + authoring_warehouse_id (for credit, visibility is org-wide). search_tsv column provides full-text search (title=A w… |
| **Procedure Videos & Comments** | web \| db | procedure_videos: N per procedure, stored in procedure-videos Storage bucket ({org_id}/{procedure_id}/{uuid}.mp4), server-signed URLs. Metadata: title, duration_seconds, size_bytes, mime_type, order_idx, uploaded_by/at. procedure_comment… |
| **Pick Slips, Packing Slips, Signature Pages** | web \| api | PDF generation routes (apps/web/src/app/api/orders/[id]/{pick-slip.pdf, packing-slip-warehouse.pdf, packing-slip-customer.pdf}). Signature flow: /orders/sign/[signature_token] public page for requester to sign + upload signature_data_url… |
| **AI Chat History** | web \| db | ai_chat_sessions table (migration 0030): tracks conversation history for shelf scan + inventory assistant features. Org-scoped. Used by /lib/ai/chat.ts for multi-turn context. Not directly order-facing but provides smart lookup for order… |
| **Permissions & RBAC** | web | orders:request perm: viewer+ can submit orders. orders:approve perm: manager+ approve/deny. orders:assign_delivery perm: assign delivery user. bundles:manage perm: manager+ define kits. bundles:distribute perm: staff+ run kits. rentals:c… |

**Reusable primitives:** Soft-hold reservation system (stock_reservations table + released_at flag): reusable for any 'hold before commit' flow (pre-orders, allocations, rentals); State machine + trigger validation (order_state_machine.ts mirrored in Postgres trigger): reusable pattern for multi-stage workflows (returns, fulfillment, asset lifecycle); Email confirmation token flow (pending_confirmation status + token_hash + expiry + cleanup RPC): anti-spam foundation, reusable for any public form (feedback, incident reports, support tickets); SECURITY DEFINER RPC pattern for role-based state mutations (approve/deliver/cancel as RPCs): defends against RLS bypass, usable for any sensitive transition; Phantom inventory items (is_bundle flag + virtual assembly/distribution): patterns for kits, pre-boxed combos, damaged-goods phantom bins; Warehouse-scoped RLS helpers (user_can_access_warehouse, is_org_member, has_org_role): foundations for multi-location, role-based access control; Organization-scoped soft delete (archived_at, deleted_at columns): preserves audit trail, supports soft cascade; Storage path convention (bucket/{org_id}/{resource_id}/{uuid}.{ext}) with storage.foldername(name) RLS: multi-tenant bucket safety, reusable for all file uploads; Trigger-based notification dispatch (_notify_order_request_changes pattern): fires bells + emails atomically on data mutations, decouples trigger from async email; Partial indexes on soft-delete + status columns (where deleted_at is null, where status = 'out'): optimize filtered reads without full-table scans

**Charter-specific assumptions to neutralize:**
- books item_type + book-specific tables (isbns, textbooks, rentals assume ephemeral circulating collections)
- delivery_charter_id column on order_requests — assumes delivery orders route to charter school sites (multisite networks)
- requester_org_label field — assumes requester comes from another org (vendor, parent, partner school) with its own label
- Procedures authored_warehouse_id — assumes multi-location credit model for cross-site SOP authorship
- Rental model: borrower_user_id is nullable, borrower_name always set — assumes vendors + parent volunteers (no system accounts) are primary renters
- Schedule events + requester_name field — assumes external requesters (delivery partners, event coordinators) coordinate via shared calendar
- Notification recipients use _notify_recipients() function — likely filters by role or warehouse, assumes manager/coordinator silo for approvals

**Gaps for a configurable WMS:**
- Pick/pack/stage/delivery workflows incomplete: columns exist (migration 0109) but no actionable UIs or RPCs to populate picked_at/picked_by, packed_at/packed_by, staged_at/staged_by, in_transit_at/in_transit_by. Phases 3-6 blocked on UI implementation.
- Signature flow: signature_token + signature_data_url exist but /orders/sign/[token] public page is scaffolded, not fully operational. No wet-signature capture or storage integration.
- Partial pick tracking: quantity_picked column added but no RPC to atomically update line-item picked qty during multi-item picks (partial_pick_line RPC mentioned in comment but not found in migrations)
- Rental checkout/return workflows: rentals table + rental_lines exist but no operational RPC for create_rental, mark_returned, cancel_rental — service layer likely implements via direct Supabase queries, no atomic txn safety
- Bundle assembly/distribution in UI: assemble_bundle + distribute_bundle RPCs exist and are atomic, but bundle distribution UI is not yet visible on mobile or dashboard (photos missing from bundle list views)
- Multi-warehouse fulfillment: warehouse_id on orders but no multi-warehouse picking or transfer-during-fulfillment logic. Single source warehouse assumed.
- Delivery address structure: delivery_address column added in migration 0109 as jsonb but schema/validation never documented; likely unused in phase 1.
- On-behalf-of ordering (migration 0116 added): suggests manager can order on behalf of another user, but feature is not surfaced in UI or action layer.
- Pickup location management: pickup_location_notes is text, no structured locations table; assumes free-form text entry, not dropdown from warehouses/locations
- Order frequency analysis: /api/orders/freq endpoint exists but functionality unknown — likely top-SKU tracking for repeat customers but unrelated to fulfillment
- Notification preferences (migration 0113): toggles added (email_order_received, etc.) but no UI to set them on /dashboard/settings/notifications or account settings
- Cancel-after-picking restoration (migration 0137): adjust_stock 'return' logic added but complete_picking RPC that writes quantity_fulfilled not found — phase 3 responsibility
- Public order tracking page (/r/track): likely shows status to anonymous requester, but redaction logic (denied_reason, internal_notes) and signature page link unknown
- Audit logging: @/server/services/audit suggests mutations are logged, but order-specific audit events (who picked, who staged, who signed) not defined
- Fulfillment type toggle: UI likely shows pickup/delivery radio on order create, but delivery_charter_id dropdown is charter-only; no general-distribution address picker exists
- Batch status updates: no RPC to transition 10 orders from 'approved' → 'pick_slip_generated' in one call; likely requires TS loop + per-order RPC

### Modules — supply inbound

The inbound/supply subsystem is mature for charter schools but contains foundational infrastructure suitable for expansion to other verticals. At core: purchase orders with supplier grouping, idempotent multi-receipt partial receiving with accepted/rejected splits (no QA-hold staging), cycle counts with warehouse snapshots + AI shelf scan (Gemini v1, books-only), and supplier performance reporting. Lot/serial tracking exists (milk-run ready) but QA processes (damage codes, returns RMA, supplier chargebacks) are absent. Purchase order lifecycle supports draft→ordered→partially_received→received + cancellation. The schema is org-scoped (organization_id on ~every table); RLS enforces warehouse access for staff/viewer roles. Reports span 10 types (valuation, reorder forecast, shrinkage, supplier scorecard, velocity class ABC, dead stock, bundle-focused, movements). Category taxonomy includes optional size-matrix support. The system is lightly charter-specific: book import + ISBN fields are optional (item_type='book' is one of product/book/asset/consumable), and charters (regional groupings) are configurable terminology. No hard-coded charter logic blocks multi-industry use—terminology jsonb on organizations allows renaming. Missing: QC hold status, three-way matching, RFQ/quote workflows, damage disposition, return/RMA workflows, per-location receipt acceptance, and quality metrics on suppliers.

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **Purchase Orders (Core)** | web \| api | Draft → Ordered → Partially_Received/Received/Cancelled lifecycle. Line items with quantity_ordered, quantity_received, unit_cost, line_total (generated). Supplier-grouped via supplier_id FK. Expected_at, ordered_at, received_at timestam… |
| **Receiving (post_receipt_v2 RPC)** | web \| api | Idempotent multi-receipt flow via receipts + receipt_lines tables. Per-line qty_received (total arrived), qty_accepted (inventory stock), qty_rejected (damaged/defective, not stocked). Accepted qty written to stock via adjust_stock RPC (… |
| **Lot Tracking (Receipt Lines)** | web \| api | When inventory_items.tracking_type='lot', post_receipt_v2 requires lots array (lot_number, expiration_date?, qty_base). Stored in receipt_line_lots. Sum of qty_base must equal qty_accepted_base. Optional expiration dating. Enforced by RP… |
| **Serial Tracking (Serial Registry)** | web \| api | When tracking_type='serial', post_receipt_v2 requires serials array (one per accepted unit). Stored in serial_registry with (org_id, item_id, serial_number) unique constraint. Prevents duplicate serials. Serial status enum: available, re… |
| **Cycle Counts (Physical Inventory)** | web \| mobile \| api | Start (warehouse-scoped or selection) snapshots quantity_on_hand + warehouse_id per item. Status: in_progress → completed/cancelled. Lines include expected_quantity, counted_quantity, variance reason/notes, counted_at. Post (post_cycle_c… |
| **AI Shelf Scan (Cycle Count Partner, Books-Only v1)** | mobile | Gemini vision model scans a shelf photo, matches SKUs against cycle count line set (books only). Returns confidence-flagged proposed counts. cycle_count_ai_scans table: photo_storage_path, gemini_response (JSONB), model_version, confirme… |
| **Suppliers** | web | Contact master: name, contact_name, email (citext), phone, website, address (jsonb), notes. Created_at, updated_at, deleted_at (soft delete for archive). No supplier performance tracking native to the table (derived in reporting). Suppli… |
| **Categories (Taxonomy)** | web | Hierarchical: parent_id FK allows nesting. name, description, color, icon, supports_sizes boolean. Deleted_at soft-delete. Item → Category is N:1. Used for expense classification on reports (not strictly inbound but foundational for org … |
| **PO Imports (Staging Layer)** | web | Upload PDF/CSV/XLSX/manual PO files → po_imports (status: uploaded → parsing → parsed/failed → approved). Each row refs warehouse_id (destination), supplier_id (vendor). po_import_lines: line_type (inventory/tax/freight/service/fee/disco… |
| **Reports: Inventory Valuation** | web | Per-item cost basis (qty_on_hand × unit_cost), rollups by warehouse and category. Excludes archived/discontinued items and rentals. 10,000-row cap. |
| **Reports: Supplier Scorecard** | web | Per-supplier: total POs, received POs, open POs, total spend, open value, on-time rate (%), avg lead days, fill rate (%), last_received_at. Computed from purchase_orders + receipt history. |
| **Reports: Reorder Forecast** | web | Per-item: qty_on_hand, reorder_point, reorder_quantity, deficit (max(0, reorder_point - qty_on_hand)), estimated reorder cost. Totals by warehouse. Identifies low-stock candidates for bulk PO creation. |
| **Reports: Shrinkage (Adjust Movements)** | web | Stock movements with movement_type='adjust' (from cycle counts, manual corrections). Shows cost impact (quantity_change × unit_cost). Filterable by reason, date range. Range window configurable (7-365 days). |
| **Reports: Velocity Class ABC (Pareto)** | web | Ranks items by value-out (units_out × unit_cost) in a window. Top 80% = A, next 15% = B, bottom 5% = C, no movement = D. Last out-at timestamp. Identifies which SKUs drive cash flow. |
| **Reports: Dead Stock** | web | No movements in window (7-365 days). Shows carrying cost (qty × unit_cost), age days (item created to now), stagnant days (capped to window). Identifies obsolete / slow-turning inventory. |
| **Reports: Stock Movements** | web | Full movement ledger: movement_type (add/remove/adjust/transfer/receive_po/return/damage/loss/correction/initial), quantity_change, previous/new qty, reason, notes, user, timestamp. Filterable by type, date range, warehouse. |
| **Reports: Bundle Activity & Shortages** | web | Bundle-focused: tracks fulfillment rate, shortage volume. Inbound aspect: shows which bundles are constrained by PO-in-flight. |
| **Warehouse Access Control** | web \| api | inventory_items.warehouse_id pinned to 'home' warehouse. purchase_orders.destination_location_id → locations.warehouse_id gates write. Cycle counts scoped to warehouse. user_warehouse_assignments table (user ↔ warehouse N:M) for staff/vi… |

**Reusable primitives:** Immutable stock_movements ledger with organization_id + movement_type enum (add/remove/adjust/transfer/receive_po/damage/loss/correction/initial) — foundation for any inventory variance tracking; purchase_orders + purchase_order_items schema with supplier FK + destination location FK — adaptable to any inbound flow (manufacturing, retail receiving, restaurant prep); post_receipt_v2 RPC with idempotency key + request hash (SHA256) — atomic multi-line receiving with conflict detection, suitable for distributed 3PL / mobile sync scenarios; Lot/serial_registry tracking (tracking_type enum on items) — ready for food/pharma/fashion (expiry dates, unique serials, RMA linkage); RLS helpers is_org_member() + has_org_role() + warehouse access checks — multi-tenant + warehouse scoping works for any vertical; stock_movements.reference_type + reference_id (cycle_count/receipt/shipment) — composable audit trail linking movements to source workflows; Hierarchical categories with supports_sizes boolean — taxonomy + size-matrix reusable across retail/distribution/light manufacturing; supplier + vendor_item_mappings tables — foundation for multi-vendor sourcing regardless of industry; cycle_count_lines.warehouse_id snapshot — prevents mid-count warehouse moves from corrupting variance math (works for any warehouse-scoped counting); movement_type='adjust' + post_cycle_count RPC — variance-capture is industry-agnostic (retail, food, manufacturing all need recount reconciliation)

**Charter-specific assumptions to neutralize:**
- item_type='book' with custom_fields.isbn / custom_fields.author — books import service (lib/books/lookup.ts) hardcoded to call ISBN lookup via Google Books API; no other item_type blocks use
- cycle_count_ai_scans filters to item_type='book' only (v1 Gemini prompt assumes textbooks) — non-book items silently omitted from AI scan, manual barcode scan used instead
- charters table (region/division/branch grouping) with terminology jsonb on organizations ('charter_singular': 'Charter' → renaming is config, not hard-coded)
- notifications include charter-scoped preferences (NotificationPreferences.notify_on_charter_low_stock) — but charter is just a grouping layer; low_stock alerts work for any warehouse set
- book_rentals table (0131_rentals.sql) — tracks checkout/return of textbook rental inventory; non-book items cannot be rented per application logic (separate from purchase order receiving)

**Gaps for a configurable WMS:**
- No QA/Quality Hold status: receipts post directly to available stock (qty_accepted). No staging area for goods awaiting inspection/approval. Damage codes exist on serial_registry.current_status but no receiving-time QC gate. Three-way matching (PO qty ≠ receipt qty ≠ invoice) is not enforced; over-receive is blocked (0069) but tolerance profiles / approval workflows are absent.
- No RMA / Returns workflow: serial_registry.current_status='rma' is an enum option but no return purchase order, return authorization, supplier chargeback, or restocking fee tracking. Loss/damage accounting happens post facto in adjust movements (movement_type='damage'), not at receiving.
- No supplier performance SLA tracking: supplier_scorecard computes on-time rate (expected_at vs received_at) but no SLA contract terms, penalty tracking, or quality metrics (defect rate %). Lead-time is computed from received POs only.
- No per-location receipt acceptance: receipts route to a warehouse (not a specific location/bin), and post_receipt_v2 does not split by receiving dock/zone. Putaway is manual or via procedure workflow, not part of receiving atomicity.
- No PO amendment workflow: original PO qty is fixed; vendor surprises (over-ship) are rejected by post_receipt_v2 (0069 validation). No formal amendment request, cost adjustment, or change-order trail.
- No invoice matching: purchase_orders table has no invoice_number, invoice_date, or invoice amount fields. Receiving validates against PO qty, not invoice line items. Accounting GL posting is out of scope.
- No packaging/case-break handling: All quantities in post_receipt_v2 are in base_uom (default 'EA'); no UOM conversion from case/pallet on receipt to item unit_of_measure. uom_conversions table exists (0014) but is not applied in receiving flow.
- No goods-in-transit visibility: PO status jumps from 'ordered' to 'partially_received'/'received' on first receipt. No 'shipped' / 'in_transit' status or carrier tracking integration.
- No shortage alert customization: reorder_forecast report is static; no configurable min/max logic, seasonal factors, or lead time buffers per supplier.
- AI Shelf Scan limited to books: Gemini v1 prompt is books-only. No multi-category scan or product image matching for general inventory. Confidence scoring is raw Gemini output, not trained on org's barcode/shelf patterns.

### service layer parity

StockPilot's service layer is built on a unified context pattern (withContext for React Server Components, withApiContext for API routes) that resolves organization, user, role, and MFA state once per request and caches via React.cache. Services are ~60 modules in apps/web/src/server/services/ following a convention of `Service.forCurrentUser()` + class methods that take ServiceContext. The API v1 surface spans ~17 route groups (cycle-counts, bundles, items, orders, POs, AI, mobile snapshot, public endpoints); mobile offloads via bearer-token auth and syncs pull/push via a two-way engine with local SQLite queue (pending_actions, outbox-style dedupe). Web uses Supabase realtime channels for org-scoped postgres_changes with per-route throttling. Navigation (web sidebar + mobile drawer) filters items by role and permission via hasPermission() checks applied at render time. All tables have organization_id + RLS; core stock engine (stock_movements immutable ledger, stock_reservations, inventory_items, item_stock_levels, locations, warehouses) is protected by DB-enforced row-level security (is_org_member, has_org_role, user_org_role helpers in migrations 0001 + 0140). The permission matrix (55 total perms) is declared in packages/core/src/constants/permissions.ts and gates both web nav and API endpoints uniformly. MFA state (mfaRequired/mfaSatisfied) is resolved per-request and checked inside assertPermission before any operation. Error handling uses ServiceError with typed codes (unauthenticated, forbidden, not_found, validation_error, plan_limit_exceeded, conflict, internal_error) that map to HTTP status; API routes normalize to JSON. No module-registry or feature-flag layer exists today; all modules are "always on" with nav/perms as the only gate. Seams for entitlements exist naturally: permission checks can be extended, nav filter logic is declarative, ServiceError codes accommodate new failure modes, and the RLS layer is modular (each table references is_org_member, can_user_write, etc. as rules).

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **withContext + ServiceContext** | web | React 19 server-scoped cache that resolves user, org, role, MFA state once per request. Returns typed ServiceContext {organizationId, userId, role, supabase client, mfaRequired, mfaSatisfied}. Cached via React.cache() so multiple calls i… |
| **withApiContext** | api | Dual-path API context builder for cookie-auth (web fetches) and bearer-token (mobile/native). Fast-path: skips supabase.auth.getUser() if no Supabase auth cookie detected. Bearer path: validates JWT, creates bearer-bound Supabase client,… |
| **ServiceError** | api | Typed error class with code field (one of: unauthenticated, forbidden, not_found, validation_error, plan_limit_exceeded, conflict, internal_error), message, and optional details object. API routes catch and map to HTTP status; web server… |
| **assertPermission(ctx, permission)** | web | Checks ctx.role against ROLE_PERMISSIONS[role]. Fires MFA gate first (if mfaRequired && !mfaSatisfied, throws forbidden with reason='mfa_required'). Then checks hasPermission(). Throws ServiceError('forbidden', message). |
| **~60 service modules** | web | Classes in apps/web/src/server/services/ following pattern: static async forCurrentUser() { return new Service(await withContext()); }, methods take ctx: ServiceContext. Examples: InventoryService, CycleCountsService, BundlesService, Ord… |
| **API v1 routes (17 modules)** | api | apps/web/src/app/api/v1/* organized by domain: cycle-counts, bundles, items (lookup/barcode), books (isbn-lookup), orders (public/order-requests), POs (receive-line), push (register/test), mobile (snapshot), AI (identify-from-photo), acc… |
| **API v1 /mobile/snapshot** | api | Returns SnapshotResponse with warehouses, items, openPOs (with lines), openCycleCounts (with lines), bundles (with components). Pulled by mobile via sync.ts pullSnapshot() with ?since=… filtering. Server-side RLS filters rows before resp… |
| **Mobile two-way sync** | mobile | apps/mobile/src/lib/sync.ts + cycle-count-sync.ts. Pull engine: hit /api/v1/mobile/snapshot?since=last_synced_at → upsert local SQLite, track via meta('last_synced_at'). Push engine: drain pending_actions by age, hit each kind's endpoint… |
| **Mobile offline queue (pending_actions)** | mobile | SQLite table: id, kind, idempotency_key (UUID), payload_json, created_at, attempts, last_attempt_at, last_error, status ('pending'\|'sending'\|'ok'\|'failed'). enqueue(kind, payload) → {id, idempotencyKey}. listPending() filters status I… |
| **Supabase realtime subscriptions (postgres_changes)** | web | apps/web/src/components/realtime/inventory-realtime.tsx subscribes to org:${organizationId}:inventory channel with filter `organization_id=eq.${organizationId}` on inventory_items, stock_movements, purchase_orders, rentals. Throttled (le… |
| **Permission matrix (55 perms)** | web | Declared in packages/core/src/constants/permissions.ts. ROLE_PERMISSIONS maps role→permission[]. Perms grouped: Organization (6), Members (6), Items (6), Stock (2), Locations (2), Categories (2), Suppliers (2), PurchaseOrders (2), Report… |
| **Web navigation (BASE_NAV + ADMIN_NAV)** | web | apps/web/src/components/dashboard/nav.ts. BASE_NAV: 5 sections (Overview, Inventory, Workspace). Each NavItem has requires?: Permission and requiresAdmin?: boolean. navForRole(role) filters sections by permission. ADMIN_NAV (requiresAdmi… |
| **Mobile navigation (DRAWER_SECTIONS)** | mobile | apps/mobile/src/lib/drawer-nav.ts mirrors web nav. Items flagged inTabs: true also render as bottom tabs (Home, Items, Books, Cycle Counts, Receive POs, Scan). ADMIN section filtered by role at render time (drawer-content.tsx checks user… |
| **RLS foundation (migrations 0001 + 0140)** | db | Migration 0001: is_org_member(org_id), user_org_role(org_id), has_org_role(org_id, min_role). Migration 0140 (RLS consolidation): creates standardized policy helpers: can_read, can_write, can_delete for each domain table. All tables have… |
| **Outbox events (migration 0016)** | db | Transactional outbox: outbox_events table (organization_id, topic, dedupe_key, payload, created_at, published_at). publish_outbox(org, topic, dedupe_key, user_id, payload) RPC. Used by services to emit domain events (stock_moved, item_cr… |
| **MFA gates (mfaRequired + mfaSatisfied)** | web | Resolved per-request via resolveMfaState() in context.ts + api-context.ts. Queries organizations.mfa_policy ('optional'\|'admins_required'\|'all_required'). If required: checks supabase.auth.mfa.getAuthenticatorAssuranceLevel() → current… |
| **Plan limits (assertPlanLimit)** | web | Called before write ops (create_item, add_location, invite_member). Queries organizations.plan, looks up limit in packages/core/src/constants/plans.ts (free=10 items, pro=100, etc). Checks COUNT(*) against limit + addCount. Throws Servic… |
| **Audit logging (audit.ts service)** | web | apps/web/src/server/services/audit.ts. Services call audit(ctx, {action, resource, changes, actor}) to record organization_members and inventory changes. Also audit-log.ts for raw event tracking. Queryable via /dashboard/admin/audit (adm… |

**Reusable primitives:** ServiceContext shape (org_id, user_id, role, supabase client, mfaRequired, mfaSatisfied) — foundational across all web services and API routes; Permission matrix (ROLE_PERMISSIONS record type, hasPermission function) — applies uniformly to nav, API, and RLS-enforced DB queries; RLS helpers (is_org_member, has_org_role, user_org_role, can_read/can_write patterns) — DB-enforced multi-tenancy with zero application-layer privilege escalation; MFA resolution pattern — dual-path (cookie + bearer) with identical fail-closed semantics and AAL2 step-up gate for security mutations; ServiceError typed codes and API HTTP mapping — consistent across all v1 routes (400 validation, 403 forbidden, 404 not_found, 409 conflict, 500 internal_error); Outbox events + idempotency_key deduping — transactional safety for domain events + mobile offline retries without replay duplication; Two-way sync architecture — pull (snapshot + since), push (outbox + idempotency), offline queue with exponential backoff, applies to any mobile workload; Navigation filter pattern (filter items by requires permission + requiresAdmin flag) — applies to web sidebar, mobile drawer, API endpoint lists; Realtime subscription pattern (org-scoped channels + postgres_changes + throttled refresh) — applies to any multi-user view requiring live updates

**Charter-specific assumptions to neutralize:**
- industry='charter' hardcoded in some organizational contexts (e.g., orgs/charters admin page, warehouse_charters junction table, charter_id on inventory_items for multi-charter scenarios). Assumes a charter is a school/entity that shares warehouses with others and has its own category/item subset.
- terminology overrides in organizations table (presumed) to map 'warehouse' → 'branch', 'location' → 'classroom', etc. for charter vs. distribution use.
- Public order requests (/r/[token] public links, public_items, public_catalog services) seem charter-specific (schools collecting donations/supplies). May not apply to 3PL or retail backroom.
- Rental workflow (check-out/return of circulating assets like canopies) is tailored to event-heavy charters. Retail backroom may not use this module.
- Cycle count + bundle distribution workflows map to school inventory events. General distribution may run different bin-picking, wave-picking, or put-away patterns not modeled here.

**Gaps for a configurable WMS:**
- No feature-flag or module-registry layer. All 60 services are 'always on'; nav and permission checks are the only gates. Adding a WMS for 3PL requires forking or adding per-org module toggles (e.g., org.enabled_modules = '{bundles, receiving, reports}').
- No API route auto-discovery or convention-based module routing. Routes are hand-written in apps/web/src/app/api/v1/*. Adding a new domain (e.g., returns, inter-warehouse transfers) requires manual route scaffolding.
- Navigation is static array (BASE_NAV, ADMIN_NAV) with hardcoded href/icon/label. No CMS or dynamic nav config to support vertical-specific menu layouts (e.g., hide orders for retail, show layovers for 3PL).
- Mobile snapshot endpoint hard-coded to return {warehouses, items, openPOs, openCycleCounts, bundles}. No way to customize response for an industry that doesn't use bundles or uses different entities (e.g., shipments, allocations).
- Permission matrix is monolithic (ROLE_PERMISSIONS record with 55 perms). No per-org override or capability-based access control. Scaling to a new industry with different role models (e.g., 3PL roles: shipper, forwarder, warehouse_op) requires editing core/constants/permissions.ts.
- RLS is DB-enforced but policy definitions are per-table in migrations, not data-driven. No way to define custom RLS rules for vertical-specific row filters without DB migration.
- Audit logging captures all changes via services but no industry-specific audit schema. 3PL may need shipment-level audit, retail may need POS transaction links.
- Outbox events + topic strings (stock_moved, item_created) are baked into services. No plugin or event-handler registration system. Adding vertical-specific webhooks (e.g., notify external TMS on shipment complete) requires service layer edits.
- No multi-warehouse or cross-org movements. All stock is org-scoped. Light 3PLs may need to move stock between client warehouses or consolidate before shipment.
- Custom fields (inventory_items.custom_fields jsonb) support item-type metadata but no schema registry or validation. Data integrity is entirely application-layer.

### data model integrations

StockPilot maintains a multi-tenant warehouse engine with 41 core tables organized by domain (inventory, orders, purchasing, rentals, cycle counts, procedures, schedules, notifications, audit). Core tables (stock_movements, stock_reservations, inventory_items, item_stock_levels, locations, warehouses) are immutable or soft-state with strict RLS. The system has a transactional outbox (outbox_events) for event-driven integrations but only one topic is actively published (receipt.posted). Three external integrations exist: Stripe (billing webhooks), Google Gemini (ISBN lookup + AI chat with hallucination guards), and Expo Push (mobile notifications). Push tokens are table-based and user-scoped. The custom_fields jsonb column on inventory_items holds item-type-specific metadata (book_rack_number, rack_row for books; rack_number for products). Audit logging uses audit_logs with jsonb metadata and entity_id indexing for timelines. No explicit integrations exist for carrier shipping, POS systems, or accounting software. Email digest infrastructure exists (weekly low-stock/PO/cycle-count summaries) but relies on future out-of-band delivery; notification_preferences table gates opt-ins but has no mail provider bindings.

**What exists today:**

| Capability | Surface | Detail |
|---|---|---|
| **Immutable stock ledger (stock_movements)** | db | Insert-only table with movement_type enum (add, remove, adjust, transfer, receive_po, return, damage, loss, correction, initial) and quantity_change (numeric). Supports full audit trail per organization. Indexed by (org_id, item_id, crea… |
| **Stock reservations system** | db | Soft holds against inventory_items scoped by reference_type (order, rental). Auto-released on delivery/cancellation. Constrains available-to-promise (qty_on_hand - active_reservations) for order picker. |
| **Multi-location inventory tracking** | db | item_stock_levels table (item_id, location_id, quantity) provides per-location decomposition. Supports warehouse hierarchies (locations.parent_id) with types: warehouse, room, shelf, bin, vehicle, jobsite, other. |
| **Item type taxonomy (product\|book\|asset\|consumable)** | db, web, mobile | inventory_items.item_type enum drives UI tab filtering + custom_fields branching. Books store rack metadata under custom_fields.book_rack_number; products use custom_fields.rack_number. Indexes on (org_id, item_type, sort_key) optimize t… |
| **Custom fields (JSONB) per item** | db, web | inventory_items.custom_fields holds schemaless extensions (book_rack_number, rack_row, rack_number, etc.). GIN-indexed for full-text search; accessed via jsonb operators in service layer. |
| **Transactional outbox (outbox_events)** | db | Deduplicatable event table (org_id, dedupe_key unique) with topic, aggregate_type, aggregate_id, payload (jsonb), published_at. publish_outbox RPC inserts; future worker process drains unpublished rows. Currently only receipt.posted topi… |
| **Audit logging with entity indexing** | db, web | audit_logs table (org_id, user_id, event, metadata jsonb, ip, user_agent). BTREE expression index on ((metadata->>'entity_id'), org_id, created_at desc) supports item-detail Activity timelines without full-table scans. |
| **Row-level security (RLS) with is_org_member / has_org_role helpers** | db | SQL functions return boolean for membership + role-rank checks (owner=100, admin=80, manager=60, staff=40, viewer=20). Scoped on organization_id; warehouse access via junction table (warehouse_charters) for multi-warehouse orgs. 0140_rls… |
| **Stripe billing integration (webhooks)** | api, web | apps/web/src/app/api/webhooks/stripe/route.ts listens for customer.subscription.updated events. Resolves org via Stripe metadata or price ID; calls syncSubscriptionFromStripe to update organizations.plan. Plans: free\|pro\|business\|ente… |
| **Expo Push notifications (mobile)** | api, mobile | notifyUser() wraps Expo Push API (exp.host/--/api/v2/push/send). Batches tokens (max 100 per request); failures logged but never thrown. Triggered on notification table inserts (stock movements, orders, approvals). Push tokens registered… |
| **Google Gemini integration (ISBN lookup + AI chat)** | api, web | fetchGeminiBookMetadata (lookup-gemini.ts) uses Gemini's structured JSON schema for ISBN→title/authors/publisher. Confidence gates at 'high'\|'medium' to block hallucinations. AI chat endpoint (api/ai/chat/route.ts) streams Gemini respon… |
| **Organization settings + plan configuration** | db, web | organizations table: plan (free\|pro\|business\|enterprise), stripe_customer_id, timezone, currency (USD default). Custom terminology for warehouse/charter labels stored in settings migrations (0052_org_po_terms.sql). Supports per-org fe… |
| **Multi-warehouse + charter hierarchy** | db, web | warehouses table (org_id, name, address jsonb). warehouse_charters junction table for charter-to-warehouse assignments (org-specific). Order requests, rentals, cycle counts scoped to warehouse_id with RLS enforcement. |
| **Order requests (internal + public link)** | db, web, mobile, api | order_requests (org_id, warehouse_id, source='internal'\|'public_link', status state machine: pending_approval→approved→packaging→ready_for_delivery→delivered\|denied\|cancelled). Public link uses email identity; internal uses user_id. s… |
| **Rentals (checkout/return tracking)** | db, web | rentals table (org_id, warehouse_id, borrower_user_id\|borrower_name, checked_out_at, expected_return_at, returned_at, status='out'\|'returned'\|'cancelled'). rental_lines per item+qty. Reuses stock_reservations (reference_type='rental')… |
| **Weekly email digest (low stock, open POs, cycle counts)** | api, web | getDigestData (digest.ts) aggregates per org (20 low-stock items, 20 open POs, open cycle counts). isDigestEmpty filter skips empty digests. notification_preferences gate opt-ins (low_stock, open_pos, cycle_counts booleans), but no mail … |
| **Error reporting webhook** | api | error-reporter.ts posts to ERROR_WEBHOOK_URL (Slack webhook, custom endpoint). Filters by level and exclusions. Best-effort; never blocks caller. Sends via fetch with 2s timeout. |
| **Notification preferences + pushes** | db, api, mobile | notification_preferences (user_id, org_id, category, enabled). notifications table (user_id, title, body, link, data jsonb, read_at). Trigger _dispatch_push_for_notification fires on insert, calling notifyUser(). Realtime published for l… |

**Reusable primitives:** Immutable append-only ledger (stock_movements) with is_org_member/has_org_role RLS guards — reusable for financial transactions, audit trails, compliance logs across any vertical; Soft-state reservations pattern (stock_reservations with reference_type enum) — generalizable to seat bookings, bed assignments, equipment allocation, shelf space reservation; Custom fields JSONB + GIN indexing on inventory_items — reusable for dynamic form data (custom attributes, SKU-level metadata, item bundles) across industries; Transactional outbox (outbox_events with publish_outbox RPC) — ready-to-use event publishing framework for async integrations (webhooks, notifications, third-party syncs) with deduplication; Multi-level location hierarchy (parent_id self-join, type enum) — applicable to organizational units, supply chain nodes, geographic regions, or spatial structures; Organization-scoped multi-tenancy with organization_id on every table + RLS helpers (is_org_member, has_org_role) — portable to any SaaS vertical; Role-rank hierarchy (owner=100, admin=80, manager=60, staff=40, viewer=20) with permission matrix — extensible RBAC for new features; Audit logging with jsonb metadata + entity_id indexing — reusable for compliance timelines, change tracking, activity streams; Push token registry (platform enum, device_id) — reusable for mobile notifications across different notification providers; User category assignments + visibility scoping (user_category_assignments, RLS filter on category reads) — reusable for department-based access control, project filtering, or resource partitioning

**Charter-specific assumptions to neutralize:**
- Warehouse/charter terminology hardcoded in settings UI (apps/web/src/app/(dashboard)/dashboard/settings) — assumes org wants to rebrand these terms; multi-industry fallback needed (e.g., branch, location, site, depot per industry config)
- Item types default to 'product' but include book-specific rack metadata (custom_fields.book_rack_number|book_rack_row, _set_rack_book_aware migration) — assumes charter school textbook inventory; other verticals need asset/consumable/SKU branching
- Rentals assume borrower may lack system account (borrower_name always populated, borrower_user_id nullable) — correct for school volunteer/vendor rentals; less relevant for B2B 3PL or retail
- Location hierarchy supports warehouse→room→shelf→bin structure — matches school/charity storage but may be overkill for flat retail backroom or too shallow for geographically distributed 3PL
- Public order links (/r/[token]) assume external requester identity via email — fits charter school PTA/parent orders but not B2B shipping manifests or retail store-to-HQ transfers
- Cycle count RPC (post_cycle_count) hardcoded for single warehouse — assumes in-one-location counting; distributed inventory (multi-site, serial-tracked) needs partitioning logic
- Notification preferences stored per user per org (user_id + organization_id composite) — works for small teams but doesn't partition by department/location/role for large enterprises
- Item import jobs use entity='items'|'suppliers'|'locations' — no product catalog, category hierarchies, or vendor packs; other industries need richer entity types

**Gaps for a configurable WMS:**
- No active outbox event draining — outbox_events table exists but only 'receipt.posted' topic is published; no worker process, scheduled job, or cloud function subscribed to consume and deliver events. Framework is sound but incomplete.
- No connector/integration management UI — no table for third-party credentials (API keys, OAuth tokens), endpoint configurations, or mapping definitions. Stripe is hardcoded; adding a new carrier/POS/accounting sync requires code changes.
- No webhook event type registry or management — no schema definition for published events (topic → payload structure), no event versioning, no subscriber registry. Future extensibility is blocked without a manifest system.
- Email delivery not wired — notification_preferences gate digest opt-ins, but getDigestData returns a payload; no SMTP/SendGrid/SES handler, template rendering, or scheduled sender. digest.ts is incomplete without downstream delivery.
- No explicit support for carrier/shipping integrations — locations have addresses (jsonb) but no carrier configuration, rate tables, or tracking webhook endpoints. Order requests have no shipment tracking or label generation.
- No POS system integration — no table for POS terminals, register mappings, real-time inventory sync, or sale reconciliation. Receiving is PO-driven only.
- No accounting software integration — no GL account mappings, journal entry templates, or cost variance tracking. Stripe billing is org-level only; no item-level COGS, P&L, or tax category support.
- No vendor onboarding or catalog management — purchase_orders exist but no vendor portal, EDI/ASN support, or item cross-reference tables (UPC↔vendor SKU). Vendor item mappings partially started (vendor-item-mappings.ts) but incomplete.
- Limited stock movement visibility — audit_logs capture entity changes but stock_movements don't trigger audit rows; no drill-down from a 'stock discrepancy' to the RPC call that caused it.
- No asset lifecycle or depreciation tracking — item_type='asset' exists but no purchase_date, useful_life, salvage_value, or depreciation schedule columns. Rental return-to-shelf transition is manual.
- No SKU/UPC translation framework — barcode field is text; no multi-barcode support, GS1 parsing, or vendor-barcode-to-internal-SKU mapping. Barcode search is simple text match.
- No subscription/recurring order support — order_requests are one-time; no standing orders, subscriptions, or auto-fulfillment.
- No service-level agreements or backorder prioritization — order requests queue by created_at; no priority levels, SLA windows, or allocation rules when stock is constrained.
- No dynamic pricing or promotional discounts — purchase_order_items.unit_cost is static; no volume tiers, time-based pricing, or surcharges.
- Limited reporting exports — reports module exists but no scheduled exports, email delivery, or integration with BI tools (Power BI, Tableau, Looker).


---

## Benchmark Comparison & Missing-Capability Analysis

StockPilot today is a **ledger-grade inventory execution engine with a near-complete inbound (PO → receipt → cycle-count) loop and a maturing outbound (order → pick → pack → stage → sign) loop**, wrapped in best-in-class multi-tenant RLS. Measured against tier-1 WMS (Manhattan Active WM, Blue Yonder, SAP EWM, Oracle WMS Cloud) and SMB/mid-market platforms (NetSuite WMS, Odoo Inventory, Cin7, Fishbowl), the engine primitives are competitive but the *directed-work, traceability, and integration* layers are thin or absent. Crucially, **the right target benchmark for StockPilot's small/mid-market is NetSuite/Odoo/Cin7/Fishbowl, not Manhattan/Blue Yonder/SAP** — chasing labor standards or robotics orchestration is a misallocation. This section grades against the *realistic* peer set and ranks what to build.

### Methodology & scoring key

- **StockPilot today** is graded only on what is confirmed in code/migrations (cited), distinguishing shipped vs. scaffolded.
- **Gap severity**: `Critical` (blocks a target vertical from going live), `High` (forces ugly workarounds, loses deals), `Medium` (nice-to-have, has a manual path), `Low` (over-spec for SMB).
- **Leverage** = (customer value across the 5 target verticals) ÷ (build cost given existing primitives). `High` = mostly assembles from existing tables/RPCs; `Low` = needs net-new subsystem + integrations.

---

### Gap matrix: capability × benchmark

| Capability | StockPilot today (grounded) | Typical mid-market benchmark (NetSuite / Odoo / Cin7 / Fishbowl) | Gap severity | Leverage |
|---|---|---|---|---|
| **Basic receiving (PO→receipt)** | **Strong.** `post_receipt_v2` RPC (0015/0069), idempotency keys, accepted/rejected split, multi-receipt partial receiving, auto-unarchive on receipt (`receiving.ts`). | Same; some add ASN/EDI inbound. | None | — |
| **Directed / rules-based putaway** | **Absent.** Receipts route to a `warehouse_id`, not a location. `bin_location` is text on `inventory_items` (0002:101); no putaway task table, no zone/strategy rules. | Odoo/NetSuite: putaway strategies by product/zone; Cin7 bins. | High | High |
| **Wave & task orchestration** | **Partial / single-order.** Pick is per-order: `partial_pick_line`, `complete_picking` RPCs (0111). No wave/batch grouping, no task queue, no "transition 10 orders at once" (confirmed gap). | NetSuite/Odoo: wave & cluster picking, task assignment. | High | Medium |
| **Slotting / bin optimization** | **Absent.** No `bin_location` analytics, velocity-class exists in reports (`reports.ts` ABC) but not wired to slotting. | Tier-1 only; SMB rarely. | Low | Low |
| **Transfers w/ in-transit** | **Partial.** `transfer_stock` (0004) is instant intra-warehouse (no in-transit). Cross-warehouse `shipments` (0050) has a `shipped` status that *is* in-transit — but **0114 marks shipments deprecated**; new outbound flows through orders, which lack a transfer-receive leg. | Two-step transfers w/ in-transit qty (Odoo, NetSuite). | High | High |
| **Returns / RMA** | **Absent.** No return-authorization table; `serial_registry.current_status='rma'` is an enum value with no workflow (0015). `adjust_stock` `return` movement exists for cancel-restock only (0137). | RMA, restock, credit, supplier return (all 4 SMB peers). | High | High |
| **Quality / QA holds** | **Absent.** Receipts post straight to available `qty_accepted`; rejected qty is dropped (not recorded as inventory). No quarantine/inspection stock state. | Inspection holds, NCR (NetSuite, SAP). | High | High |
| **Lots / serials / expiry / FEFO** | **Capture only.** `tracking_type` (none\|lot\|serial), `receipt_line_lots.expiration_date`, `serial_registry` (0015). **No outbound consumption, no FEFO allocation, no expiry enforcement** (confirmed gaps). | Lot/serial capture + FEFO/FIFO pick + expiry blocks (all). | Critical (food/ag/pharma) | Medium |
| **License plates / handling units (SSCC)** | **Absent.** No LP/SSCC/pallet table (grep: zero hits). Bin is denormalized text. | NetSuite/SAP/Manhattan; Odoo packages. | Medium | Medium |
| **Catch weight** | **Absent.** `unit_of_measure` single string; `uom_conversions` table exists (0014) but is **not applied in receiving** (confirmed). No variable-weight capture. | Food/meat distributors (NetSuite, Cin7). | Medium (food only) | Low |
| **Dock / yard scheduling** | **Absent.** `schedule_events` (0032) is generic calendar, not dock-door/appointment. | NetSuite, tier-1. | Low | Low |
| **Labor standards / engineered labor** | **Absent.** | Tier-1 (Manhattan/BY) only. | Low (over-spec) | Low |
| **Carrier labels / tracking** | **Absent.** No `carrier`, `tracking_number`, `shipping_label` columns anywhere (grep: zero hits). Order `delivery_address` jsonb (0109) is undocumented/unused. | ShipStation/EasyPost-class (Cin7, NetSuite SCM). | High | Medium |
| **Traceability / recall** | **Partial primitive.** Immutable `stock_movements` ledger + `reference_type/reference_id` give a forward audit trail; lot capture exists. **No genealogy query** ("which orders got lot X"), no recall workflow. | Lot trace up/down, recall (NetSuite food, SAP). | High (food/ag) | High |
| **POS / commerce sync** | **Absent.** No POS/channel tables; receiving is PO-driven only. | Shopify/Square sync (Cin7, Odoo). | Medium (retail) | Low |
| **Accounting export (GL/COGS)** | **Absent.** `unit_cost_at_receive` captured but adjustments record no cost; no GL mapping, no COGS, no journal export. Stripe is org-billing only. | QuickBooks/Xero/NetSuite GL (all SMB peers). | High | Medium |
| **Automation / robotics connectors** | **Absent.** `outbox_events` (0016) exists but only `receipt.posted` is published (confirmed in `receiving.ts:188`); no consumer/worker. | Tier-1 only. | Low (over-spec) | High (the *outbox*, not robotics) |
| **Customer / B2B portals** | **Partial.** Public order links `/r/[token]` (0044/0108) + tracking `/r/track`. No authenticated B2B customer account portal, no per-customer catalog/pricing. | NetSuite/Cin7 B2B portals. | Medium | Medium |

---

### Reading the matrix: the three honest takeaways

1. **The inbound loop is genuinely competitive; the outbound loop is 70% built but undirected.** Pick/pack RPCs already exist (`partial_pick_line`, `complete_picking`, 0111) — the audit under-credited this. The missing piece outbound is *direction* (where to pick from / put to) and *closure* (returns, carrier handoff), not the core motion.

2. **The single highest-value missing capability is lot/expiry *enforcement on outbound* (FEFO), because it is the only `Critical` row** — it is the literal gate that lets food/ag/pharma go live, and StockPilot already has the capture half built. It is "finish what's started," not "build new."

3. **Two `Low`-severity rows have `High` leverage and should still be built early as enablers, not features**: the **module registry** (no severity in the matrix because it's infrastructure) and **draining the outbox** (0016 exists, unused). Neither is a customer-facing capability, but every other module depends on them.

---

### Prerequisite: the module registry (the spine all modules hang from)

Nothing below should ship as a fork or an always-on feature. The audit confirms **no `org_enabled_modules` mechanism exists** — gating is role + plan only. Build this first.

```sql
-- migration 0144_module_registry.sql
create table public.org_modules (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  module_key      text not null,          -- 'putaway','qa_hold','fefo','returns','transfers','carrier','traceability','b2b_portal'
  enabled         boolean not null default false,
  config          jsonb not null default '{}',   -- per-module manifest overrides
  enabled_at      timestamptz,
  primary key (organization_id, module_key)
);
-- RLS: select for is_org_member, write for has_org_role(org,'admin')
```

```jsonc
// packages/core/src/constants/modules.ts — declarative manifest (the source of truth)
{
  "fefo": {
    "label": "Lots & Expiry (FEFO)",
    "requires": ["tracking_type"],          // capability the org's items must already use
    "permissions": ["stock:adjust"],         // reuse existing perms, do NOT mint per-feature roles yet
    "nav": [{ "section": "Inventory", "href": "/dashboard/lots", "label": "Lots", "icon": "Boxes" }],
    "plans": ["business", "enterprise"],
    "movement_types": [],                    // none new
    "outbox_topics": ["lot.expiring", "lot.consumed"]
  }
}
```

This turns every row below into `org_modules.enabled = true` + a manifest entry. `navForRole()` (`apps/web/src/components/dashboard/nav.ts`) and mobile `DRAWER_SECTIONS` (`apps/mobile/src/lib/drawer-nav.ts`) gain one filter: `&& isModuleEnabled(ctx, item.module)`. `withContext`/`withApiContext` gain `assertModuleEnabled(ctx, key)` next to the existing `assertPermission`. **This is the packaging layer the whole "configurable OS" thesis depends on** — without it, every module below is an unconditional fork.

---

### Ranked build order

#### MUST-HAVE-SOON (next 2 quarters) — unlocks new verticals, assembles from existing primitives

**1. `module:fefo` — Lot/Serial Outbound + Expiry Enforcement** — *Critical severity, the vertical-unlock.*
The capture half exists (`receipt_line_lots`, `serial_registry`, `tracking_type`); the consume half does not. This is the difference between "can demo to a food distributor" and "can sell to one."
- **New table** `lot_balances (organization_id, item_id, lot_number, warehouse_id, location_id, qty_remaining, expiration_date, received_at)` — the running per-lot on-hand, decremented on outbound. (Today lots only exist at the receipt line; there is no current-lot-balance.)
- **New RPC** `allocate_fefo(item_id, qty, warehouse_id)` → returns ordered `[{lot, qty}]` by `expiration_date asc`; called inside `complete_picking` (0111) so pick consumes the soonest-expiring lot.
- **Extend** `adjust_stock` (0004) with optional `p_lot_number` so the ledger movement records which lot moved (enables genealogy below).
- **Expiry rule**: nightly job flips `lot_balances` past `expiration_date` to a `quarantine` state and publishes `lot.expiring` (T-30) / `lot.expired` to the outbox. Closes the "no auto expiry" gap.
- **Why first**: highest severity, ~70% of the schema already exists, and `tracking_type` already branches per-item so non-food orgs pay zero cost (manifest `requires: tracking_type`).

**2. `module:qa_hold` — Quality / Inspection Hold** — *High severity, smallest build.*
Today rejected receipt qty is silently dropped. Add a *stock state* rather than a new warehouse.
- **Extend** `inventory_items`/`item_stock_levels` with a `status_bucket` dimension OR add `stock_status` to the ledger: `available | hold | quarantine | damaged`. Cheapest: add `movement_type` values `hold` / `release_hold` and a `held_qty` companion to `quantity_on_hand` (mirrors how `stock_reservations` already separates soft-holds).
- **Receiving gate**: `post_receipt_v2` gains `p_route_to_hold boolean`; held qty is not reservable/pickable until `release_hold(receipt_line_id, qty)`.
- **Reuses**: the `stock_reservations` soft-hold pattern (0044) is the exact precedent — a quantity that exists but isn't available. Low risk.

**3. `module:returns` — RMA / Returns** — *High severity, high leverage, pure assembly.*
Mirror the receipt pattern in reverse.
- **New tables** `return_authorizations (org, source_order_id, customer_ref, status: requested|approved|received|closed|denied, reason)` + `return_lines (item_id, qty, disposition: restock|scrap|hold|supplier_return)`.
- **New RPC** `post_return(ra_id)` — atomic, calls `adjust_stock` with `movement_type='return'` (already exists, 0137) for `restock`, routes `scrap`/`damaged` to the QA-hold bucket from module 2.
- **Reuses**: the entire `post_receipt_v2` idempotency + ledger pattern, the order state-machine pattern (`packages/core/src/order-state-machine.ts`), and the soft-delete/audit conventions. This is the clearest "primitive already proven, point it backwards" build.

**4. `module:transfers` — Two-step Transfer with In-transit** — *High severity, high leverage.*
Shipments (0050) already modeled in-transit (`shipped` status) but were **deprecated (0114)**. Resurrect the *concept* as a first-class transfer order rather than the old shipments table.
- **New** `transfer_orders` + `transfer_lines` with status `draft|in_transit|received|cancelled`; a `qty_in_transit` that belongs to neither source nor dest available.
- **RPCs** `ship_transfer` (deduct source → in_transit) and `receive_transfer` (in_transit → dest, optionally route to QA-hold). This restores the in-transit ledger state the cross-warehouse flow lost, and gives all 5 verticals real multi-location movement.

**5. Outbox drain + webhook subscriptions** — *infra, High leverage, unblocks accounting/carrier/POS later.*
`outbox_events` (0016) and `publish_outbox` exist; only `receipt.posted` is published and **nothing consumes it**. Add a worker (Supabase scheduled function / cron) that drains `outbox_events` and POSTs to a new `webhook_subscriptions (org, topic, url, secret, active)` table with HMAC signing + retry/backoff (reuse the mobile sync backoff pattern in `cycle-count-sync.ts`). Publish the events the modules above already declare. This is the single integration seam that later makes accounting/carrier/POS *configuration* instead of code.

#### GROW-INTO-LATER (after the above land)

| Module | Why later | Leans on |
|---|---|---|
| **`module:traceability`** (recall / lot genealogy) | Needs `module:fefo` shipping first (lot-stamped movements are its raw data). Then it's a *query* over `stock_movements.lot_number` + order lines — low build once data exists. | FEFO + ledger |
| **`module:putaway`** (directed putaway, bin tasks) | Promote `bin_location` text → real `locations` rows + a `putaway_tasks` queue. High value for larger SMB but the manual text-bin path works today. | locations (0002), QA-hold |
| **`module:carrier`** (EasyPost/ShipStation labels + tracking) | Pure integration; gated on the outbox/webhook drain (#5) existing. Add `carrier`, `service`, `tracking_number`, `label_url` to order/transfer. | Outbox drain |
| **`module:accounting`** (QuickBooks/Xero COGS/GL export) | Requires recording `unit_cost` on *every* movement first (today only receipt lines carry cost). Add `unit_cost` to `stock_movements`, then export via outbox. | Outbox drain, ledger cost |
| **`module:b2b_portal`** (authed customer accounts + per-customer catalog) | Extends existing public `/r/[token]` + `public_catalog` services into authenticated accounts. Medium value, no vertical depends on it to launch. | order-requests, public links |
| **`module:commerce_sync`** (Shopify/Square) | Retail-only; lower than the cross-vertical modules. | Outbox drain |
| Catch weight, dock/yard, labor standards, slotting, robotics | `Low`/over-spec for SMB target — explicitly **de-scope**; revisit only on a tier-1 deal. | — |

---

### Why this ordering (the leverage argument in one breath)

- **#1 FEFO is the only `Critical` row and is half-built** — it's the highest value *and* among the lowest cost. Build-first is unambiguous.
- **#2–#4 (QA-hold, Returns, Transfers) are all `High` severity, `High` leverage, and each is "point an existing proven pattern (receipt/ledger/reservation/state-machine) in a new direction."** They convert StockPilot from "receive-and-store" to a closed-loop WMS.
- **#5 outbox drain is the cheapest `High`-leverage item on the board** — the table already exists and is dead. Lighting it up makes every `grow-into-later` integration a manifest entry instead of a feature branch, which is the entire "configuration over forks" thesis.
- Everything graded `Low` severity (labor standards, robotics, dock/yard, slotting) is **deliberately excluded** — matching tier-1 there would burn the runway that the SMB peer set (NetSuite/Odoo/Cin7/Fishbowl) doesn't even require.

**Assumptions flagged (not confirmed in code):** that `delivery_address` jsonb (0109) is unused (audit says undocumented — treat as greenfield for carrier); that no GL/cost-on-movement exists (confirmed `stock_movements` has no `unit_cost` per the stock-core audit); that the `customRoles` plan flag is non-functional (audit states it's "a lie") — so all module manifests above intentionally reuse existing permissions rather than minting per-module roles until a real custom-role system exists.

**Load-bearing file/table anchors for implementers:** `supabase/migrations/0015_lot_serial_tracking.sql` (FEFO base), `0069_post_receipt_v2_validation.sql` (receiving RPC to extend for QA-hold), `0111_orders_pick_slip_rpcs.sql` (`partial_pick_line`/`complete_picking` to inject FEFO), `0004_phase2_helpers.sql` (`adjust_stock`/`transfer_stock`), `0044_order_requests.sql` (reservation precedent for hold), `0016_outbox.sql` + `apps/web/src/server/services/receiving.ts:186` (the one live publisher), `0050/0114 shipments` (deprecated in-transit model to resurrect as transfer orders), `apps/web/src/components/dashboard/nav.ts` + `apps/mobile/src/lib/drawer-nav.ts` (nav filter injection points for the module registry), `apps/web/src/server/services/context.ts` (`assertModuleEnabled` lives next to `assertPermission`).

---

## Proposed Modular Architecture

### Design thesis

Today StockPilot has **no entitlement layer**. Every one of the ~60 services in `apps/web/src/server/services/` is "always on," gated only by (a) the role→permission matrix in `packages/core/src/constants/permissions.ts` and (b) a few hard-coded plan booleans in `packages/core/src/constants/plans.ts` (`purchaseOrders`, `advancedReports`, `customRoles`, etc.). Nav is two static arrays (`BASE_NAV`/`ADMIN_NAV` in `apps/web/src/components/dashboard/nav.ts`, `DRAWER_SECTIONS` in `apps/mobile/src/lib/drawer-nav.ts`). Turning a module *off* per-org is impossible without nav-level filtering that doesn't exist.

The fix is a **third axis** that is deliberately kept orthogonal to roles/permissions and to RLS tenancy:

| Axis | Question it answers | Where it lives today | Where it lives after |
|---|---|---|---|
| **Tenancy (RLS)** | *Which org's rows can this user touch?* | `is_org_member()`, `has_org_role()`, `user_can_access_inventory()` (0001, 0008, 0140) | unchanged |
| **Permission** | *May this user perform this action inside a module?* | `ROLE_PERMISSIONS` matrix, `assertPermission(ctx, perm)` (context.ts:115) | unchanged matrix; permissions become *namespaced by module* |
| **Entitlement (NEW)** | *Is this module turned on for this org at all?* | nothing | `organization_modules` table + `MODULE_REGISTRY` + `assertModuleEnabled(ctx, moduleId)` |

The composition rule is a strict AND, evaluated in cheapest-first order:

```
visible/allowed  ⇔  is_org_member(org)              -- RLS / tenancy
                AND  module_enabled(org, moduleId)   -- entitlement (NEW)
                AND  hasPermission(role, perm)        -- role matrix
                AND  mfaSatisfied (if mutation)       -- existing AAL2 gate
```

An entitlement never *grants* anything a permission wouldn't; it only *removes* a module from existence for an org. A user with `orders:approve` still cannot touch orders if the `orders` module is disabled for their org. This keeps the security model conservative: disabling a module can only reduce surface area, never expand it.

---

### Part 1 — The shared module registry (`packages/core`)

A declarative manifest is the single source of truth that web nav, mobile drawer, the entitlement guard, the settings UI, and the domain-pack defaults all read from. It belongs in `packages/core` so web + mobile stay in sync (the audit flagged drift between `nav.ts` and `drawer-nav.ts` as a real risk).

**New file: `packages/core/src/modules/registry.ts`**

```ts
import type { Permission } from '../constants/permissions';
import type { PlanId } from '../constants/plans';

/** Every module the platform can offer. String union — extending it is a
 *  one-line edit + a registry entry, never a schema migration. */
export type ModuleId =
  // --- core (always implicitly enabled, cannot be disabled) ---
  | 'inventory' | 'movements' | 'locations' | 'categories'
  | 'team' | 'audit' | 'reports_basic' | 'notifications'
  // --- optional (free to toggle, no upcharge) ---
  | 'purchase_orders' | 'receiving' | 'suppliers'
  | 'cycle_counts' | 'orders' | 'bundles' | 'rentals'
  | 'schedule' | 'procedures' | 'books' | 'public_requests'
  | 'po_imports' | 'shipments' | 'charters'
  // --- premium add-ons (entitlement + plan tier) ---
  | 'lot_serial' | 'traceability' | 'reports_advanced'
  | 'ai_assistant' | 'ai_shelf_scan' | 'api_access'
  | 'pos_sync' | 'accounting_sync' | 'shipping_sync';

export type ModuleTier = 'core' | 'optional' | 'premium';
export type Surface = 'web' | 'mobile' | 'api';

/** Domain packs are the "manifests over forks" mechanism: each industry
 *  is a named bundle of default-on modules + default terminology. */
export type DomainPack =
  | 'charter_school'   // L4L Fresno, the incumbent
  | 'distribution'
  | 'agriculture_food'
  | 'retail_backroom'
  | 'light_3pl';

export interface ModuleNavItem {
  /** Stable key for ordering/override; not the URL. */
  key: string;
  webHref: string;            // e.g. '/dashboard/orders'
  mobileHref?: string;        // e.g. '/(drawer)/(tabs)/orders' — omit if web-only
  label: string;              // default label; overridable via terminology
  icon: string;               // lucide name (web) / mapped to mobile icon set
  section: 'inventory' | 'workspace' | 'admin';
  requires?: Permission;      // existing permission gate, unchanged
  requiresAdmin?: boolean;
  inMobileTabs?: boolean;     // surfaces in the 5-slot bottom tab bar
  weight?: number;            // NEW: ordering hint (lower = higher)
}

export interface ModuleDefinition {
  id: ModuleId;
  tier: ModuleTier;
  title: string;
  description: string;

  /** Hard prerequisites. The guard refuses to enable a module whose
   *  dependencies aren't all enabled, and refuses to disable a module
   *  that another enabled module depends on. */
  dependsOn: ModuleId[];

  /** Permissions this module introduces. These should be *namespaced*
   *  (module-prefixed) so the matrix and the entitlement align 1:1. */
  permissions: Permission[];

  /** Where the module renders. pos_sync is api-only; books is web+mobile. */
  surfaces: Surface[];

  /** Nav entries contributed to web sidebar / mobile drawer. */
  nav: ModuleNavItem[];

  /** API v1 route prefixes this module owns, for the API guard +
   *  the /mobile/snapshot section gate. */
  apiPrefixes: string[];

  /** DB tables this module owns — used by the entitlement RLS helper
   *  and by the grandfather migration to know what to switch on. */
  ownsTables: string[];

  /** Settings sub-schema rendered under /dashboard/settings when enabled.
   *  Zod-serializable descriptor; keeps per-module config out of a god-object. */
  settingsSchema?: Record<string, { type: 'string' | 'boolean' | 'number' | 'enum'; enum?: string[]; default?: unknown }>;

  /** Minimum plan tier required to *enable* a premium module. Optional/core
   *  modules leave this undefined. Composes with assertPlanLimit. */
  minPlan?: PlanId;

  /** Which domain packs turn this on by default. */
  defaultOnFor: DomainPack[];
}
```

#### Four concrete module definitions

```ts
export const MODULE_REGISTRY: Record<ModuleId, ModuleDefinition> = {
  // ---------------------------------------------------------------- ORDERS
  orders: {
    id: 'orders',
    tier: 'optional',
    title: 'Orders & Fulfillment',
    description: 'Internal + public-link order requests, soft-hold reservations, pick/pack/deliver workflow.',
    dependsOn: ['inventory'],
    permissions: ['orders:request', 'orders:approve', 'orders:assign_delivery'],
    surfaces: ['web', 'mobile', 'api'],
    nav: [
      { key: 'orders', webHref: '/dashboard/orders', mobileHref: '/(drawer)/order',
        label: 'Orders', icon: 'ShoppingCart', section: 'inventory',
        requires: 'orders:request', weight: 40 },
    ],
    apiPrefixes: ['/api/v1/orders', '/api/v1/public/order-requests'],
    ownsTables: ['order_requests', 'order_request_lines', 'order_request_attachments', 'stock_reservations'],
    settingsSchema: {
      fulfillmentTypes: { type: 'enum', enum: ['pickup', 'delivery', 'both'], default: 'both' },
      requireSignatureOnDelivery: { type: 'boolean', default: false },
    },
    defaultOnFor: ['charter_school', 'distribution', 'light_3pl'],
  },

  // --------------------------------------------------------------- RENTALS
  rentals: {
    id: 'rentals',
    tier: 'optional',
    title: 'Rentals',
    description: 'Check-out / return of circulating assets via soft reservations.',
    dependsOn: ['inventory'],
    permissions: ['rentals:create', 'rentals:manage'],
    surfaces: ['web', 'mobile'],
    nav: [
      { key: 'rentals', webHref: '/dashboard/rentals', mobileHref: '/(drawer)/rentals',
        label: 'Rentals', icon: 'PackageOpen', section: 'inventory',
        requires: 'rentals:create', weight: 30 },
    ],
    apiPrefixes: ['/api/v1/rentals'],
    ownsTables: ['rentals', 'rental_lines'],
    // Charter-specific (canopies, volunteer borrowers). Off by default for retail/3PL.
    defaultOnFor: ['charter_school'],
  },

  // ---------------------------------------------------------- TRACEABILITY
  // NEW premium module that wraps the EXISTING lot/serial primitives
  // (0015) and adds outbound enforcement the GAPS list called missing.
  traceability: {
    id: 'traceability',
    tier: 'premium',
    title: 'Lot & Serial Traceability',
    description: 'Expiry/FEFO enforcement on outbound, serial lifecycle, recall genealogy. Builds on receipt_line_lots + serial_registry.',
    dependsOn: ['inventory', 'lot_serial', 'receiving'],
    permissions: ['traceability:review', 'traceability:recall', 'lot:assign'],
    surfaces: ['web', 'mobile', 'api'],
    nav: [
      { key: 'traceability', webHref: '/dashboard/traceability', mobileHref: '/(drawer)/traceability',
        label: 'Lot tracking', icon: 'ShieldCheck', section: 'inventory',
        requires: 'traceability:review', weight: 35 },
    ],
    apiPrefixes: ['/api/v1/traceability'],
    ownsTables: ['receipt_line_lots', 'serial_registry'], // shared-read with receiving
    settingsSchema: {
      fefoEnforcement: { type: 'enum', enum: ['off', 'warn', 'block'], default: 'warn' },
      blockExpiredOutbound: { type: 'boolean', default: true },
    },
    minPlan: 'business',
    defaultOnFor: ['agriculture_food'],
  },

  // ------------------------------------------------------------- POS SYNC
  // NEW premium add-on — does NOT exist today (data-model audit: "No POS
  // integration"). API-only; no nav. Drains the existing outbox_events (0016).
  pos_sync: {
    id: 'pos_sync',
    tier: 'premium',
    title: 'POS / Channel Sync',
    description: 'Two-way stock sync to a point-of-sale or sales channel by draining outbox_events (stock_moved).',
    dependsOn: ['inventory', 'api_access'],
    permissions: ['integrations:manage'],
    surfaces: ['api'],
    nav: [
      { key: 'pos_sync', webHref: '/dashboard/settings/integrations/pos', label: 'POS sync',
        icon: 'Plug', section: 'admin', requiresAdmin: true, weight: 90 },
    ],
    apiPrefixes: ['/api/v1/integrations/pos', '/api/webhooks/pos'],
    ownsTables: ['integration_connections', 'integration_event_log'], // NEW tables
    settingsSchema: {
      provider: { type: 'enum', enum: ['square', 'shopify', 'lightspeed'] },
      direction: { type: 'enum', enum: ['push', 'pull', 'both'], default: 'push' },
    },
    minPlan: 'enterprise',
    defaultOnFor: ['retail_backroom'],
  },

  // ... remaining ~25 entries (inventory, movements, books, cycle_counts,
  //     bundles, schedule, procedures, purchase_orders, receiving, shipments,
  //     suppliers, charters, public_requests, ai_assistant, ai_shelf_scan,
  //     reports_advanced, accounting_sync, shipping_sync, api_access, etc.)
};

/** Pack → default-enabled module set. Derived from defaultOnFor + all 'core'. */
export function modulesForPack(pack: DomainPack): ModuleId[] {
  return (Object.values(MODULE_REGISTRY) as ModuleDefinition[])
    .filter((m) => m.tier === 'core' || m.defaultOnFor.includes(pack))
    .map((m) => m.id);
}
```

**Migrating `nav.ts` to read the registry:** `BASE_NAV`/`ADMIN_NAV` become *derived*, not authored. `navForRole(role)` gains a second argument:

```ts
export function navForRole(role: Role, enabled: Set<ModuleId>): NavSection[] {
  // existing permission/admin filtering UNCHANGED, plus:
  // drop any nav item whose owning module is not in `enabled`
}
```

The 18 `BASE_NAV` items and 9 `ADMIN_NAV` items map cleanly onto module nav contributions (e.g. `Charters`/`Warehouses` come from `charters`; `UoM conversions` from a `uom` core sub-feature). The mobile `DRAWER_SECTIONS` and the 5-slot bottom tab bar (`apps/mobile/app/(drawer)/(tabs)/_layout.tsx`) derive from the same `nav[].inMobileTabs` flags — eliminating the documented web↔mobile drift.

---

### Part 2 — DB representation

I considered two options:

| Option | Pros | Cons |
|---|---|---|
| **A. `organizations.enabled_modules jsonb`** | zero new table, one-row read (already loaded for terminology/mfa_policy) | hard to index/audit per-module; RLS subqueries on jsonb are awkward; no per-module settings/audit rows |
| **B. `organization_modules` table (one row per org×module)** ✅ | indexable, RLS-friendly, per-module `settings jsonb` + `enabled_at`/`enabled_by` audit, mirrors `user_warehouse_assignments` pattern | one extra table + a join (mitigated by caching in `withContext`) |

**Recommendation: Option B**, following the established junction-table precedent (`warehouse_charters` 0008, `user_warehouse_assignments` 0007). Keep a `pack` column on `organizations` for the human-readable identity + reseed source.

**New migration `0144_org_modules.sql`:**

```sql
-- 1. record which domain pack the org identifies as (drives reseed + terminology)
alter table organizations
  add column if not exists domain_pack text not null default 'charter_school'
  check (domain_pack in ('charter_school','distribution','agriculture_food','retail_backroom','light_3pl'));

-- 2. per-org per-module entitlement
create table organization_modules (
  organization_id uuid not null references organizations(id) on delete cascade,
  module_id       text not null,                 -- matches ModuleId union
  enabled         boolean not null default true,
  tier            text not null,                 -- core|optional|premium (denormalized for fast checks)
  settings        jsonb not null default '{}'::jsonb,  -- per-module settingsSchema values
  enabled_at      timestamptz not null default now(),
  enabled_by      uuid references user_profiles(id),
  primary key (organization_id, module_id)
);

create index org_modules_enabled_idx
  on organization_modules (organization_id) where enabled;

-- 3. the entitlement RLS helper — STABLE + InitPlan-friendly, same shape as
--    is_org_member() (0140). SECURITY DEFINER so RLS can call it without
--    recursive policy evaluation.
create or replace function public.module_enabled(p_org uuid, p_module text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from organization_modules om
    where om.organization_id = p_org
      and om.module_id = p_module
      and om.enabled
  );
$$;

alter table organization_modules enable row level security;
create policy org_modules_read on organization_modules
  for select using ((select is_org_member(organization_id)));
create policy org_modules_admin on organization_modules
  for all using ((select has_org_role(organization_id, 'admin')))
  with check ((select has_org_role(organization_id, 'admin')));
```

---

### Part 3 — Enforcement at all three layers

The principle: **defense in depth**. Nav-filtering (UI) is convenience; the service guard is the real gate; RLS is the backstop against a forgotten guard or a direct PostgREST call.

#### Layer 1 — Service / API guard (`packages/core` + `context.ts`)

Add to `ServiceContext` (context.ts:11) an `enabledModules: Set<ModuleId>` resolved once per request via `React.cache` (same pattern as `resolveMfaState`). Add a sibling to `assertPermission`:

```ts
// apps/web/src/server/services/context.ts
export function assertModuleEnabled(ctx: ServiceContext, moduleId: ModuleId): void {
  if (!ctx.enabledModules.has(moduleId)) {
    throw new ServiceError('module_disabled', `Module not enabled for this organization: ${moduleId}`);
  }
}
```

`'module_disabled'` is a **new `ServiceError` code** (added to the union at context.ts:89) mapping to **HTTP 403** in the API normalizer — distinct from `forbidden` so the UI can show an "upgrade / contact admin" nudge rather than "access denied." Premium modules also run the existing `assertPlanLimit`-style tier check before allowing enablement.

Convention in each service method (orders.ts, rentals.ts, …):

```ts
async approve(ctx: ServiceContext, id: string) {
  assertModuleEnabled(ctx, 'orders');     // entitlement
  assertPermission(ctx, 'orders:approve'); // permission (existing)
  assertCurrentAal2(ctx);                  // MFA (existing, mutations only)
  // ... existing logic, untouched
}
```

For API routes, `withApiContext` (`apps/web/src/lib/auth/api-context.ts`) resolves the same `enabledModules` set. A thin middleware maps the request path to its owning module via `MODULE_REGISTRY[*].apiPrefixes` and calls `assertModuleEnabled` before the handler — so a mobile client hitting `/api/v1/rentals` on a retail org gets a clean 403 even if it never reads nav. The **`/mobile/snapshot`** endpoint (audit-flagged as hard-coded to `{warehouses, items, openPOs, openCycleCounts, bundles}`) becomes entitlement-aware: it omits the `bundles` / `cycleCounts` keys when those modules are disabled.

#### Layer 2 — Database RLS

Add an entitlement predicate to the **mutation** policies of module-owned tables, so even a leaked service-role-less direct call is blocked. Example for `order_requests` (extends, not replaces, the existing 0044/0045 policies):

```sql
-- writes to order_requests require the orders module to be live
alter policy order_requests_write on order_requests
  using ((select is_org_member(organization_id))
         and (select module_enabled(organization_id, 'orders')))
  with check ((select is_org_member(organization_id))
              and (select module_enabled(organization_id, 'orders')));
```

Design choices:
- Apply the predicate to **INSERT/UPDATE/DELETE only**, not SELECT. Reads of a disabled module's historical rows stay available (you can still view past orders after turning the module off) — disabling stops *new activity*, preserving the immutable-ledger ethos. The `stock_movements` ledger itself is **never** entitlement-gated; it is core.
- Wrap `module_enabled()` in `(select …)` exactly like the InitPlan optimization in `0140_rls_initplan_wrap.sql`, so the planner caches it once per query.
- The grandfather migration (Part 5) guarantees existing orgs have every owned-table module enabled before these predicates go live, so no current write path breaks.

#### Layer 3 — UI (web nav + mobile drawer + settings)

`navForRole(role, ctx.enabledModules)` drops items for disabled modules; empty sections are already pruned. A new **Settings → Modules** page (`/dashboard/settings/modules`, owner/admin-gated via `hasPermission(role,'settings:manage')`) lists all registry modules grouped by tier with toggles, dependency warnings ("Traceability requires Receiving — enable it first"), and premium-tier upsell badges. Server action `setModuleEnabledAction` validates dependencies both directions and writes `organization_modules` + an `audit_logs` row (`event: 'module.enabled'`).

---

### Part 4 — Module classification

Rationale anchors: **core** = the immutable stock engine + tenancy primitives that everything else `dependsOn` and that have no coherent "off" state; **optional** = self-contained workflows toggleable with zero upcharge; **premium** = either net-new integration surface or compliance/enforcement work that warrants a plan gate.

| Module | Tier | Owning tables / files | Rationale |
|---|---|---|---|
| `inventory` | **core** | inventory_items, item_stock_levels, adjust_stock (0004) | The engine. Everything `dependsOn` it. No "off". |
| `movements` | **core** | stock_movements ledger (0002) | Immutable audit trail; ledger must never be disable-able. |
| `locations` | **core** | locations, warehouses (0002/0007) | Required for any stock position. |
| `categories` | **core** | categories (0002) | Taxonomy used by RLS viewer-scoping (0128). |
| `team` | **core** | organization_members (0001) | Membership = tenancy foundation. |
| `audit` | **core** | activity_logs, audit_logs (0002) | Compliance backstop; cannot be silenced per audit GAPS. |
| `reports_basic` | **core** | reports.ts (valuation, movements) | Read-only views over core data. |
| `notifications` | **core** | notifications, push_tokens (0002) | Cross-cutting; every module fires into it. |
| `suppliers` | optional | suppliers (0002) | Distribution/3PL want it; pure retail backroom may not. |
| `purchase_orders` | optional | purchase_orders (0002) | Already a plan boolean (`PLANS.purchaseOrders`) — migrate that flag into the registry. |
| `receiving` | optional | receipts, post_receipt_v2 (0012/0015) | Inbound flow; some POS-driven orgs skip formal receiving. |
| `po_imports` | optional | po_imports (0010) | Batch-vendor intake; 3PL/ag may not need it. |
| `cycle_counts` | optional | cycle_counts, post_cycle_count (0023/0079) | Physical-count workflow; toggleable. |
| `orders` | optional | order_requests (0044) | Charter/distribution use; retail backroom may not. |
| `bundles` | optional | bundles (0040) | Kits; not universal. |
| `rentals` | optional | rentals (0131) | Charter-specific circulating assets. |
| `schedule` | optional | schedule_events (0032) | Calendar coordination; not universal. |
| `procedures` | optional | procedures (0053) | SOPs; nice-to-have. |
| `books` | optional | item_type='book' (0020), ISBN lookup | Pure charter-school artifact; off for everyone else (kills the Books tab + bottom-tab slot the nav audit flagged). |
| `public_requests` | optional | public_request_token (0044), /r/[token] | External order links; charter-specific donation flow. |
| `shipments` | optional | shipments (0050) | Cross-warehouse transfer; single-site orgs skip it. |
| `charters` | optional | charters, warehouse_charters (0007/0008) | The literal charter hierarchy — off for single-tenant verticals. |
| `lot_serial` | **premium** | tracking_type, serial_registry (0015) | Capture exists; gating it as premium funds the enforcement layer. |
| `traceability` | **premium** | (NEW) FEFO/expiry/recall over lot_serial | Net-new outbound enforcement (GAPS: "No lot/expiry enforcement on outbound"). Ag/food. |
| `reports_advanced` | **premium** | reports.ts (ABC, dead stock, scorecard) | Already a plan boolean (`advancedReports`) — migrate. |
| `ai_assistant` | **premium** | api/ai/chat (Gemini) | Metered LLM cost. |
| `ai_shelf_scan` | **premium** | cycle_count_ai_scans (0124) | Metered LLM cost; books-only v1. |
| `api_access` | **premium** | API v1 + (NEW) service accounts | Already a plan boolean (`apiAccess`) — migrate; prerequisite for sync modules. |
| `pos_sync` | **premium** | (NEW) integration_connections | Net-new; doesn't exist today. |
| `accounting_sync` | **premium** | (NEW) integration_connections | Net-new (GAPS: "No accounting integration"). |
| `shipping_sync` | **premium** | (NEW) integration_connections | Net-new (GAPS: "No carrier integration"). |

**Plan-boolean consolidation:** the four ad-hoc booleans in `plans.ts` (`purchaseOrders`, `advancedReports`, `apiAccess`, `customRoles`) are subsumed — `purchase_orders`/`reports_advanced`/`api_access` become registry modules whose `minPlan` reproduces the tier gate; `customRoles` stays a plan limit (it's about role *count*, a different axis). `PlanLimits` loses three booleans; `PLANS[tier]` instead implies a default `enabledModules` ceiling.

---

### Part 5 — Backwards-compatibility / grandfathering L4L Fresno

The incumbent org (L4L Fresno) must wake up with **every module it uses already enabled** and zero behavior change. The migration runs immediately after `0144` and is idempotent.

**`0145_grandfather_existing_orgs.sql`:**

```sql
-- Every pre-existing org keeps the full charter feature set.
-- Stamp the pack first (default already 'charter_school', but be explicit
-- for any org with overridden terminology that signals otherwise).
update organizations set domain_pack = 'charter_school'
  where domain_pack is null;

-- Enable the full charter_school module set for ALL existing orgs.
-- (Premium modules included so nothing the org touched goes dark; the
--  minPlan gate only governs FUTURE enablement, not grandfathered rows.)
insert into organization_modules (organization_id, module_id, tier, enabled, enabled_by)
select o.id, m.module_id, m.tier, true, null
from organizations o
cross join (values
  -- core
  ('inventory','core'),('movements','core'),('locations','core'),
  ('categories','core'),('team','core'),('audit','core'),
  ('reports_basic','core'),('notifications','core'),
  -- optional (full charter set, matches today's always-on nav)
  ('suppliers','optional'),('purchase_orders','optional'),('receiving','optional'),
  ('po_imports','optional'),('cycle_counts','optional'),('orders','optional'),
  ('bundles','optional'),('rentals','optional'),('schedule','optional'),
  ('procedures','optional'),('books','optional'),('public_requests','optional'),
  ('shipments','optional'),('charters','optional'),
  -- premium that L4L already exercises (AI + lot/serial capture)
  ('lot_serial','premium'),('ai_assistant','premium'),
  ('ai_shelf_scan','premium'),('reports_advanced','premium')
) as m(module_id, tier)
where o.created_at < now()   -- grandfather only pre-existing orgs
on conflict (organization_id, module_id) do nothing;
```

Backwards-compat guarantees:

1. **No nav change for L4L** — every previously visible item maps to a now-enabled module; `navForRole(role, enabledModules)` yields the identical sidebar/drawer.
2. **No write breaks** — the RLS entitlement predicates (Part 3, Layer 2) ship in `0146` *after* `0145` has populated `organization_modules`, so every existing write path already satisfies `module_enabled()`.
3. **No service-guard breaks** — `assertModuleEnabled` reads the same populated rows; existing automated flows (the receipt→auto-unarchive in commit `0ab4307`, cycle-count sync) keep passing.
4. **New orgs** pick a pack at creation (`createOrganizationAction`); a post-insert trigger seeds `organization_modules` from `modulesForPack(domain_pack)`. New orgs that aren't charter schools get a *leaner* nav out of the box — the whole point of the pivot.
5. **`pos_sync`/`accounting_sync`/`shipping_sync`/`traceability`** are NOT enabled for anyone by the grandfather insert (they're net-new and have no current behavior to preserve), so no risk of surfacing half-built integrations.

---

### Assumptions called out (not confirmed in the audit)

- I assume `organizations` has an `industry`/`size` column (0001 hints at it) but **did not see a `domain_pack` column** — hence I add one rather than reuse `industry`. If `industry` exists and is free-text, `domain_pack` should be a normalized companion, not a replacement.
- `integration_connections` / `integration_event_log` tables do **not** exist (data-model audit confirms "no connector/integration management UI/table") — they are net-new and out of scope for the registry itself; the `*_sync` modules merely declare them as `ownsTables` for future work.
- The namespaced/module-prefixed permissions for `traceability` (`traceability:review`, `lot:assign`, etc.) and `integrations:manage` do **not** exist in `permissions.ts` today (55-perm matrix) and would be added alongside their modules.
- I did not verify the exact API-route-normalizer file that maps `ServiceError` codes → HTTP; the `'module_disabled' → 403` mapping must be added wherever `plan_limit_exceeded`/`forbidden` are mapped (the v1 route convention in `apps/web/src/app/api/v1/*`).

Relevant files to touch (all absolute):
- New: `/Users/brandenvincent-walker/Desktop/InventorySystem/packages/core/src/modules/registry.ts`
- Edit: `/Users/brandenvincent-walker/Desktop/InventorySystem/apps/web/src/server/services/context.ts` (add `enabledModules`, `assertModuleEnabled`, `'module_disabled'` code)
- Edit: `/Users/brandenvincent-walker/Desktop/InventorySystem/apps/web/src/lib/auth/api-context.ts` (resolve `enabledModules` + path→module middleware)
- Edit: `/Users/brandenvincent-walker/Desktop/InventorySystem/apps/web/src/components/dashboard/nav.ts` (derive from registry; `navForRole(role, enabled)`)
- Edit: `/Users/brandenvincent-walker/Desktop/InventorySystem/apps/mobile/src/lib/drawer-nav.ts` + `/Users/brandenvincent-walker/Desktop/InventorySystem/apps/mobile/app/(drawer)/(tabs)/_layout.tsx` (derive from shared registry)
- Edit: `/Users/brandenvincent-walker/Desktop/InventorySystem/packages/core/src/constants/plans.ts` (retire `purchaseOrders`/`advancedReports`/`apiAccess` booleans → module `minPlan`)
- New migrations: `supabase/migrations/0144_org_modules.sql`, `0145_grandfather_existing_orgs.sql`, `0146_module_rls_predicates.sql`

---

## Navigation & Owner Customization Design

### Goal and what exists today

Today navigation is **four disconnected static sources of truth** that drift:

- `apps/web/src/components/dashboard/nav.ts` — `BASE_NAV` (18 items across Overview/Inventory/Workspace) + `ADMIN_NAV` (9 items), filtered by `navForRole(role)` using `hasPermission()` + `isAdminRole()`.
- `apps/mobile/src/lib/drawer-nav.ts` — `DRAWER_SECTIONS` (a hand-maintained mirror; note it already drifts — web has no `TOOLS`/Scan section, mobile's Receive POs lives under Inventory, web's is `PO imports` href `/purchase-orders/imports` vs mobile `/po-imports`).
- `apps/mobile/app/(drawer)/(tabs)/_layout.tsx` — 5 hard-coded `Tabs.Screen` entries (Home, Items, Books, POs, Scan) with `href: null` to hide cycle-counts.
- `apps/web/src/app/(dashboard)/dashboard/page.tsx` — `getDashboardActions()` quick-actions + 5 rank-ordered `AttentionItem` categories, all hard-coded.

The only per-org customization is `organizations.terminology` jsonb (`charter_*` / `warehouse_*` only) merged via `resolveTerminology()` in `packages/core/src/constants/terminology.ts`. Confirmed by grep: **no `enabled_modules`, `nav_manifest`, `nav_overrides`, `entitlement`, or `feature_flag` table exists** in any of the 143 migrations. `organizations` already carries `industry text` (0001, line 32) and `plan text` — both are currently dead/cosmetic for nav purposes.

The design below collapses all four sources into **one declarative module registry in `packages/core` + two thin DB-backed override layers** (org entitlements, org/user nav overrides), resolved by a single shared function that web and mobile both call.

---

### Three-layer model

The resolved navigation for any `(org, user)` is a pure function of three inputs:

```
ResolvedNav = resolveNav(
  MODULE_REGISTRY,          // 1. static defaults in packages/core (code)
  org.entitlements,         // 2. DB: which modules are ON + surface composition overrides
  membership.role,          // role → permission matrix (existing, unchanged)
  org.nav_overrides,        // 2b. DB: owner hide/pin/reorder/tab-slot choices
  user.nav_prefs            // 3. DB (optional): per-user collapse/reorder within allowed set
)
```

- **Layer 1 — `MODULE_REGISTRY` (code, `packages/core`):** the canonical catalog of every module and its surfaces. This replaces `BASE_NAV`/`ADMIN_NAV`/`DRAWER_SECTIONS`. Single import for web + mobile.
- **Layer 2 — org control plane (DB):** `organization_modules` (on/off + per-surface placement overrides) and `organization_nav_overrides` (hide/pin/sortOrder/tab-slot). Edited only by owner/admin. This is the "configuration + packaging layer" the brief asks for — no per-industry fork.
- **Layer 3 — user prefs (DB, optional, phase 2):** `user_nav_prefs` lets an individual collapse sections or reorder within what their org allows. Never expands access.

**Resolution order (intersection, fail-closed):** an item renders on a surface only if `entitled(module) ∧ hasPermission(role, requiredPermission) ∧ not ownerHidden ∧ surfaceVisible`. Entitlement and permission are an **AND** — turning a module off in the control plane hides it even for owners, and lacking the permission hides it even if the module is on. This is the gap called out in the `permissions-tenancy` and `Navigation` audits ("No org-level feature toggle or module-activation table").

---

### Layer 1: the unified module registry (`packages/core/src/nav/registry.ts`)

One module produces zero-or-more **placements** across **surfaces**. Surfaces are an enum so web and mobile consume the same data:

```ts
export type NavSurface =
  | 'web_sidebar'       // replaces BASE_NAV / ADMIN_NAV
  | 'web_quick_action'  // dashboard "Shift command" cards
  | 'web_attention'     // dashboard attention-items feed
  | 'mobile_drawer'     // replaces DRAWER_SECTIONS
  | 'mobile_tab';       // replaces the 5 hard-coded Tabs.Screen

export type NavSection =
  | 'overview' | 'inventory' | 'fulfillment' | 'supply'
  | 'workspace' | 'admin' | 'tools';

// Stable module keys — the join key for entitlements + overrides + outbox.
export type ModuleKey =
  | 'items' | 'books' | 'categories' | 'tags' | 'movements'
  | 'rentals' | 'bundles' | 'orders' | 'cycle_counts' | 'procedures'
  | 'purchase_orders' | 'po_imports' | 'receiving' | 'locations'
  | 'suppliers' | 'reports' | 'ai' | 'schedule' | 'notifications'
  | 'team' | 'settings' | 'charters' | 'warehouses' | 'bins'
  | 'users' | 'vendor_mappings' | 'uom_conversions'
  | 'reconciliation' | 'audit';

export interface NavPlacement {
  surface: NavSurface;
  section: NavSection;
  /** route on this platform; web + mobile differ, so per-surface */
  href: string;
  /** lucide icon NAME (string, not component) — resolved per platform */
  icon: string;
  defaultVisible: boolean;     // shown out-of-box if entitled+permitted
  defaultSortOrder: number;    // within section; owners can override
  mobileTabEligible: boolean;  // may occupy a bottom-tab slot (cap 4–5)
}

export interface ModuleDef {
  key: ModuleKey;
  /** terminology key for the label so it's renamable (see Layer 4) */
  labelKey: string;            // e.g. 'nav.items', 'nav.charters'
  /** permission gate — unchanged matrix from permissions.ts */
  requiredPermission?: Permission;
  requiresAdmin?: boolean;
  /** can the owner turn this whole module OFF? settings/team cannot. */
  toggleable: boolean;
  /** plan/entitlement feature flag this maps to (reuses PlanLimits keys) */
  entitlementKey?: keyof PlanLimits | string;
  /** every surface this module appears on, with defaults */
  placements: NavPlacement[];
}
```

The brief's required fields map directly: `module`→`ModuleDef.key`, `surface`/`placement`/`label`/`icon`/`defaultVisible`/`sortOrder`/`mobileTabEligible`/`requiredPermission`→`NavPlacement`+`ModuleDef`; `ownerHidden`/`ownerPinned`→Layer 2 override columns (not registry — they're org state, not defaults).

**Icon decoupling:** the registry stores icon **names** (`'Boxes'`), not imported components, because `lucide-react` (web) and `lucide-react-native` (mobile) export different objects. Each app keeps a tiny `ICONS: Record<string, LucideIcon>` map. This is the only platform-specific shim; everything else is shared.

---

### Layer 2: DB-backed org control plane

Two new tables, both org-scoped with the existing RLS pattern (`is_org_member` read / `has_org_role(org,'admin')` write):

```sql
-- Module activation + per-surface composition override.
create table public.organization_modules (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  module_key       text not null,          -- matches ModuleKey
  enabled          boolean not null default true,
  -- jsonb: { "web_sidebar": {"visible":true,"section":"supply","sortOrder":3},
  --          "mobile_tab":  {"visible":false} }  — sparse, only overrides
  surface_overrides jsonb not null default '{}'::jsonb,
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now(),
  primary key (organization_id, module_key)
);

-- Per-item hide / pin / reorder + tab-slot assignment (owner choices).
create table public.organization_nav_overrides (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  module_key       text not null,
  surface          text not null,           -- NavSurface
  owner_hidden     boolean not null default false,
  owner_pinned     boolean not null default false,
  sort_order       integer,                 -- null = use registry default
  tab_slot         smallint,                -- 0..4 for mobile_tab; null otherwise
  updated_at       timestamptz not null default now(),
  primary key (organization_id, module_key, surface)
);
```

`organization_modules.enabled=false` removes the module from **all** surfaces and short-circuits its routes server-side (see "Defense in depth"). `surface_overrides` lets an org move e.g. `purchase_orders` from the Inventory section to a new `supply` section without code. `organization_nav_overrides` is the lighter-weight per-item knob the owner UI writes most often.

Both are loaded once per request and cached alongside the existing `ServiceContext` (`apps/web/src/server/services/context.ts`, via `React.cache`) and inside the mobile snapshot (`apps/mobile/src/lib/sync.ts` `SnapshotResponse`). No new round-trips on hot paths.

---

### The shared resolver (`packages/core/src/nav/resolve.ts`)

```ts
export interface ResolveInput {
  role: Role;
  entitlements: Set<string>;                 // from org plan + overrides
  enabledModules: Set<ModuleKey>;            // organization_modules.enabled
  surfaceOverrides: Record<ModuleKey, Partial<Record<NavSurface, SurfaceOverride>>>;
  navOverrides: NavOverrideRow[];            // organization_nav_overrides
  terminology: ResolvedTerminology;          // Layer 4 (expanded)
}

export interface ResolvedNavItem {
  moduleKey: ModuleKey;
  href: string;
  icon: string;
  label: string;        // already terminology-resolved
  section: NavSection;
  sortOrder: number;
  pinned: boolean;
}

export function resolveSurface(
  surface: NavSurface, input: ResolveInput,
): ResolvedNavSection[] {
  const items = MODULE_REGISTRY.flatMap((m) => {
    if (m.toggleable && !input.enabledModules.has(m.key)) return [];          // module OFF
    if (m.entitlementKey && !input.entitlements.has(m.entitlementKey)) return [];
    if (m.requiresAdmin && !isAdminRole(input.role)) return [];
    if (m.requiredPermission && !hasPermission(input.role, m.requiredPermission)) return [];

    const base = m.placements.find((p) => p.surface === surface);
    if (!base) return [];

    const so = input.surfaceOverrides[m.key]?.[surface];
    const no = input.navOverrides.find((o) => o.module_key === m.key && o.surface === surface);
    const visible = no?.owner_hidden ? false : (so?.visible ?? base.defaultVisible);
    if (!visible) return [];

    return [{
      moduleKey: m.key, href: base.href, icon: base.icon,
      label: resolveNavLabel(m.labelKey, input.terminology),
      section: (so?.section ?? base.section) as NavSection,
      sortOrder: no?.sort_order ?? so?.sortOrder ?? base.defaultSortOrder,
      pinned: no?.owner_pinned ?? false,
    }];
  });
  return groupBySectionSorted(items);   // pinned first, then sortOrder, then label
}
```

`navForRole(role)` in `nav.ts` becomes a one-line wrapper: `resolveSurface('web_sidebar', input)`. The mobile drawer calls `resolveSurface('mobile_drawer', input)`. **One algorithm, two surfaces, zero drift.**

---

### Mobile bottom tabs: hard cap of 4–5, no chaos

Mobile tabs are derived, not authored. Rules enforced in `resolveTabs()`:

1. Candidate set = modules where `placements[mobile_tab].mobileTabEligible === true` **and** entitled **and** permitted **and** not owner-hidden. Registry marks roughly: `overview`, `items`, `books`, `purchase_orders`/`receiving`, `scan` (a tools pseudo-module), `orders`, `cycle_counts` as eligible.
2. **Slot 0 is locked to `overview`** (Home) so there's always an anchor.
3. Owners assign `tab_slot` 1–4 via `organization_nav_overrides` (drag-and-drop in the owner UI). Max **5 total** (0–4); the UI physically prevents a 6th drop.
4. Any eligible module the owner did **not** slot still appears in the drawer — it just isn't a tab. Nothing disappears; tabs are a fast-access subset.
5. If an owner slots fewer than 5, the resolver back-fills remaining slots from `defaultSortOrder` of eligible modules so the bar is never sparse, and never overflows.

This replaces the hard-coded `Tabs.Screen` list in `_layout.tsx`. That file becomes a `.map()` over `resolveTabs(input).slice(0,5)`, rendering `<Tabs.Screen name=... href=... />` and setting `href: null` for any registered tab route the org didn't slot (Expo Router needs the screen registered but hidden — same trick currently used for cycle-counts).

| Constraint | Mechanism |
|---|---|
| Never < 1 tab | Slot 0 pinned to `overview` |
| Never > 5 tabs | `tab_slot` PK domain 0–4 + UI drop guard + `.slice(0,5)` |
| No empty slots | Resolver back-fills from eligible `defaultSortOrder` |
| Owner picks slots | `organization_nav_overrides.tab_slot` |
| Permission/entitlement respected | Candidate filter runs before slotting |

---

### Layer 4: owner control-plane knobs (where stored, where edited)

All editing lives under `apps/web/src/app/(dashboard)/dashboard/settings/*` (owner/admin-gated like the existing `settings/page.tsx` tiles), and all writes go through new server actions in `apps/web/src/server/actions/organization.ts` that `log_audit()` (existing 0007 helper) every change.

| Knob | Stored in | Edited at | Notes / reuse |
|---|---|---|---|
| **Module activation** | `organization_modules.enabled` | `settings/modules` (new) | Replaces the "all features always on" gap. Seeded from an industry preset (below). |
| **Surface composition** (section, sortOrder, hide, tab slots) | `organization_modules.surface_overrides` + `organization_nav_overrides` | `settings/navigation` (new, drag-and-drop) | The owner reorders/pins/hides; mobile tab picker lives here too. |
| **Terminology** | `organizations.terminology` jsonb (expand schema) | existing `terminology-editor.tsx` (extend) | Reuse `resolveTerminology()`. Add `nav.*`, `item_type.*`, `status.*` keys. |
| **Field schemas** (custom fields) | new `custom_field_defs` table → drives `inventory_items.custom_fields` jsonb | `settings/fields` (new) | Constrained, schema-driven (below). |
| **Workflow policies** (which statuses, transitions) | new `org_status_defs` + reuse `order_state_machine.ts` allow-list | `settings/workflows` (new) | Constrained enum extension, not free code (below). |
| **Document templates** (PO/pick/pack/slip) | new `document_templates` table (handlebars-style blocks) | `settings/documents` (new) | Block-based, not raw HTML (below). |
| **Notifications** | extend `notification_preferences` + new `org_notification_events` allow-list | existing `notification-preferences-form.tsx` (extend) | Constrained event registry, not arbitrary events. |
| **Integrations** | new `org_integrations` (provider, scoped config jsonb, secret ref) + reuse `outbox_events` (0016) | `settings/integrations` (new) | Activates the currently-dormant outbox drain. |

The brief's "module activation" and "surface composition" are the two genuinely new tables above; the remaining knobs deliberately **lean on existing patterns** (`terminology` jsonb, `custom_fields` jsonb, `order_state_machine.ts`, `notification_preferences`, `outbox_events`) so this is a configuration layer, not a rewrite.

---

### Constrained schema-driven customization (no maintenance nightmare)

The brief's hard requirement: custom fields / statuses / PDFs / notifications **without** per-customer code. The rule across all four is **declarative rows validated against a fixed type system — never executable strings**.

#### Custom fields — `custom_field_defs`

Builds on the existing pattern: `inventory_items.custom_fields` jsonb already stores `book_rack_number`, `rack_row`, `isbn`, `author` (per `data-model-integrations` audit). Today that's hard-coded in app logic. We make it declarative:

```sql
create table public.custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null,            -- 'inventory_item' | 'order_request' | 'supplier'
  applies_to_item_type text,       -- null=all, or 'product'|'book'|'asset'|'consumable'
  key text not null,               -- jsonb key written into custom_fields
  label text not null,
  data_type text not null check (data_type in
    ('text','number','boolean','date','select','multiselect')),
  options jsonb,                   -- for select/multiselect: ["A","B"]
  required boolean not null default false,
  sort_order integer not null default 0,
  archived_at timestamptz,
  unique (organization_id, entity, key)
);
```

- **No schema migrations per field** — values still land in the existing `custom_fields` jsonb (GIN-indexed already). The def table only describes shape.
- Validation is a single shared Zod builder in `packages/core` (`buildCustomFieldSchema(defs)`) used by both web actions and the mobile form. Six data types is the entire surface area — that's the constraint that prevents the nightmare.
- The hard-coded book-rack branching in `inventory.ts` becomes seeded defs (`book_rack_number`, `rack_row` as `text`, `applies_to_item_type='book'`), so existing behavior is preserved as data.

#### Custom statuses — `org_status_defs` (extend, don't replace, the state machine)

The order state machine is already DB-enforced (migration 0109 + `packages/core/src/order-state-machine.ts` `ALLOWED_TRANSITIONS`). We do **not** let orgs invent arbitrary statuses (that breaks the trigger). Instead orgs **alias and toggle** the canonical statuses, plus add **at most one** custom "parked" sub-state per stage:

```sql
create table public.org_status_defs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null,            -- 'order_request' | 'purchase_order'
  canonical_status text not null,  -- one of the existing enum values
  display_label text,              -- rename only (terminology-style)
  enabled boolean not null default true,   -- hide stages the org doesn't use
  primary key (organization_id, entity, canonical_status)
);
```

The state machine stays the source of truth; orgs only **rename** and **skip** stages (e.g. a retail backroom disables `delivery`/`signature` stages, an ag org renames `packaging`→`grading`). This satisfies "custom statuses" without making the immutable-ledger transitions configurable — the strategic strength the brief says to preserve.

#### Custom documents — `document_templates` (block model, not raw code)

PO terms today are a single free-form text field (`organizations.po_terms`, 0052). Generalize to a **constrained block list**, not raw HTML/JS:

```sql
create table public.document_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('po','pick_slip','packing_slip','order_confirmation')),
  -- ordered array of typed blocks; NO executable code
  blocks jsonb not null,  -- [{type:'logo'},{type:'field',ref:'po.number'},
                          --  {type:'lines_table',cols:['sku','qty','unit_cost']},
                          --  {type:'rich_text',value:'<terms>'},{type:'signature'}]
  is_default boolean not null default false,
  updated_at timestamptz not null default now()
);
```

Rendering is a fixed React/PDF component that switches on `block.type` (a closed set: `logo`, `field`, `lines_table`, `rich_text`, `signature`, `spacer`). `field.ref` resolves against a whitelisted token map. Orgs compose layout from safe blocks; they cannot inject markup or logic. This reuses the existing pick/pack/signature PDF scaffolding (`apps/web/src/app/api/v1/...` slip routes per the orders audit) by feeding it block data instead of hard-coded layout.

#### Custom notifications — `org_notification_events` (registry allow-list)

`notification_preferences` has fixed columns (`email_low_stock`, `email_po_status`, …). Rather than add columns per event (the nightmare), introduce a registry the toggles reference, and store per-user opt-ins as rows:

```sql
create table public.notification_event_types (   -- global catalog (seeded)
  key text primary key,                 -- 'low_stock','po_status','order_received',
  default_channels text[] not null       --  'lot_expiring','recall_open' (future)
);
create table public.org_notification_events (    -- which events an org uses
  organization_id uuid, event_key text references notification_event_types(key),
  enabled boolean not null default true, primary key (organization_id, event_key)
);
-- per-user toggle becomes a row, not a column:
create table public.user_notification_optins (
  user_id uuid, organization_id uuid, event_key text,
  email boolean not null default true, push boolean not null default true,
  primary key (user_id, organization_id, event_key)
);
```

New event types are seeded rows, not migrations-per-org. The existing trigger-based dispatch (`_notify_order_request_changes`, `notifyUser()` in `push.ts`) reads the allow-list. The `notification-preferences-form.tsx` grid renders dynamically from `org_notification_events`.

---

### Web/mobile parity

| Concern | Web | Mobile | Shared |
|---|---|---|---|
| Module catalog | `MODULE_REGISTRY` | `MODULE_REGISTRY` | `packages/core/src/nav/registry.ts` |
| Resolver | `resolveSurface('web_sidebar')` | `resolveSurface('mobile_drawer'/'mobile_tab')` | `packages/core/src/nav/resolve.ts` |
| Org config delivery | `ServiceContext` (React.cache) | `SnapshotResponse` (`sync.ts`) | same two tables |
| Icons | `lucide-react` name map | `lucide-react-native` name map | icon **names** in registry |
| Labels | `resolveTerminology()` | `resolveTerminology()` | expanded terminology jsonb |

The mobile snapshot endpoint (`apps/web/src/app/api/v1/mobile/snapshot`, flagged in `service-layer-parity` as hard-coded) gains `modules`, `navOverrides`, `terminology` keys so the device resolves nav identically and offline-stably. Because resolution is a pure function in `packages/core`, web and mobile **cannot** drift — the current `nav.ts` ↔ `drawer-nav.ts` divergence (Scan/Receive/TOOLS mismatches noted above) becomes structurally impossible.

---

### Defense in depth (nav is not security)

Hiding a nav item must not be the only gate — entitlements need server enforcement (the `service-layer-parity` audit notes routes are "always on"):

1. **UI:** resolver omits the item (this design).
2. **Action/route layer:** extend `withContext`/`withApiContext` (`context.ts`, `api-context.ts`) with `assertModuleEnabled(ctx, moduleKey)` that throws `ServiceError('module_disabled', 403)` — mirrors the existing `assertPermission`/`assertPlanLimit` pattern. A disabled module's routes 403 even on direct URL.
3. **RLS:** unchanged. Module toggles are a product/visibility concern, not a tenancy boundary — RLS still enforces org isolation. (Assumption: we intentionally do **not** push module flags into RLS, to avoid the "static RLS policies" rework the audit flags as out-of-scope; the service-layer assert is sufficient since all writes funnel through `withContext`.)

---

### Industry presets (packaging, not forks)

`organizations.industry` (already exists, 0001) selects a **seed preset** that writes default `organization_modules` rows — it does **not** branch code. A new org picks an industry; we apply a manifest of `{module: enabled}`:

```ts
export const INDUSTRY_PRESETS: Record<string, Partial<Record<ModuleKey, boolean>>> = {
  charter_school:  { books: true, rentals: true, schedule: true, charters: true },
  distribution:    { books: false, rentals: false, charters: false, bundles: true },
  agriculture:     { books: false, rentals: false, charters: false /* relabel locations→parcels via terminology */ },
  retail_backroom: { books: false, rentals: false, charters: false, schedule: false, po_imports: false },
  light_3pl:       { books: false, rentals: false, suppliers: true, shipments: true },
};
```

A preset is just initial rows; the owner re-customizes freely afterward. **One codebase, declarative manifests.**

---

### Concrete example manifest

A trimmed registry showing all required fields, the mobile-tab cap, and multi-surface placement:

```jsonc
[
  { "key": "overview", "labelKey": "nav.overview", "toggleable": false,
    "placements": [
      { "surface": "web_sidebar",  "section": "overview", "href": "/dashboard",          "icon": "Home", "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": false },
      { "surface": "mobile_drawer","section": "overview", "href": "/",                    "icon": "Home", "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": true  },
      { "surface": "mobile_tab",   "section": "overview", "href": "/",                    "icon": "Home", "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": true  }
    ]
  },
  { "key": "items", "labelKey": "nav.items", "requiredPermission": "items:read", "toggleable": false,
    "placements": [
      { "surface": "web_sidebar",  "section": "inventory", "href": "/dashboard/inventory","icon": "Boxes", "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": false },
      { "surface": "mobile_drawer","section": "inventory", "href": "/inventory",          "icon": "Box",   "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": true  },
      { "surface": "mobile_tab",   "section": "inventory", "href": "/inventory",          "icon": "Box",   "defaultVisible": true, "defaultSortOrder": 1, "mobileTabEligible": true  }
    ]
  },
  { "key": "books", "labelKey": "nav.books", "requiredPermission": "items:read",
    "toggleable": true, "entitlementKey": "books_module",
    "placements": [
      { "surface": "web_sidebar",  "section": "inventory", "href": "/dashboard/books",    "icon": "BookOpen", "defaultVisible": true, "defaultSortOrder": 1, "mobileTabEligible": false },
      { "surface": "mobile_drawer","section": "inventory", "href": "/books",              "icon": "BookOpen", "defaultVisible": true, "defaultSortOrder": 1, "mobileTabEligible": true  },
      { "surface": "mobile_tab",   "section": "inventory", "href": "/books",              "icon": "BookOpen", "defaultVisible": true, "defaultSortOrder": 2, "mobileTabEligible": true  }
    ]
  },
  { "key": "purchase_orders", "labelKey": "nav.purchase_orders", "requiredPermission": "purchase_orders:read",
    "toggleable": true, "entitlementKey": "purchaseOrders",
    "placements": [
      { "surface": "web_sidebar",  "section": "supply", "href": "/dashboard/purchase-orders","icon": "ClipboardList", "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": false },
      { "surface": "mobile_drawer","section": "supply", "href": "/purchase-orders",          "icon": "ClipboardList", "defaultVisible": true, "defaultSortOrder": 0, "mobileTabEligible": false },
      { "surface": "mobile_tab",   "section": "supply", "href": "/receive",                  "icon": "Truck",         "defaultVisible": true, "defaultSortOrder": 3, "mobileTabEligible": true  }
    ]
  },
  { "key": "cycle_counts", "labelKey": "nav.cycle_counts", "requiredPermission": "stock:adjust", "toggleable": true,
    "placements": [
      { "surface": "web_sidebar",  "section": "inventory", "href": "/dashboard/cycle-counts","icon": "ClipboardCheck", "defaultVisible": true, "defaultSortOrder": 6, "mobileTabEligible": false },
      { "surface": "mobile_drawer","section": "inventory", "href": "/cycle-counts",          "icon": "ClipboardCheck", "defaultVisible": true, "defaultSortOrder": 6, "mobileTabEligible": true  },
      { "surface": "mobile_tab",   "section": "inventory", "href": "/cycle-counts",          "icon": "ClipboardCheck", "defaultVisible": false,"defaultSortOrder": 9, "mobileTabEligible": true  }
    ]
  }
]
```

Example owner state for a distribution org (turns Books off, makes Receive a tab, hides Rentals): `organization_modules`(`books`,enabled=false), (`rentals`,enabled=false); `organization_nav_overrides`(`purchase_orders`,`mobile_tab`,tab_slot=3,owner_pinned=true). The resolver yields tabs `[overview, items, purchase_orders(Receive), reports, scan]` — exactly 5, no Books, no chaos.

---

### Migration to seed defaults for the existing org

A single migration `0144_nav_manifest.sql` creates the tables and **backfills the current org so behavior is identical day one** (charter-school preset — everything on):

```sql
-- 0144_nav_manifest.sql
begin;

create table public.organization_modules (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  surface_overrides jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, module_key)
);
create table public.organization_nav_overrides (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  module_key text not null,
  surface text not null,
  owner_hidden boolean not null default false,
  owner_pinned boolean not null default false,
  sort_order integer,
  tab_slot smallint check (tab_slot between 0 and 4),
  updated_at timestamptz not null default now(),
  primary key (organization_id, module_key, surface)
);

alter table public.organization_modules        enable row level security;
alter table public.organization_nav_overrides  enable row level security;

-- Reuse existing helpers (0001/0140) — read for members, write for admin+.
create policy org_modules_read   on public.organization_modules
  for select using ((select public.is_org_member(organization_id)));
create policy org_modules_write  on public.organization_modules
  for all    using ((select public.has_org_role(organization_id,'admin')))
             with check ((select public.has_org_role(organization_id,'admin')));
create policy org_nav_read   on public.organization_nav_overrides
  for select using ((select public.is_org_member(organization_id)));
create policy org_nav_write  on public.organization_nav_overrides
  for all    using ((select public.has_org_role(organization_id,'admin')))
             with check ((select public.has_org_role(organization_id,'admin')));

-- Seed EVERY existing org with all current modules ENABLED (no behavior change).
insert into public.organization_modules (organization_id, module_key)
select o.id, m.key
from public.organizations o
cross join (values
  ('items'),('books'),('categories'),('tags'),('movements'),('rentals'),
  ('bundles'),('orders'),('cycle_counts'),('procedures'),('purchase_orders'),
  ('po_imports'),('receiving'),('locations'),('suppliers'),('reports'),('ai'),
  ('schedule'),('notifications'),('team'),('settings'),('charters'),
  ('warehouses'),('bins'),('users'),('vendor_mappings'),('uom_conversions'),
  ('reconciliation'),('audit')
) as m(key)
on conflict do nothing;

-- Seed mobile tab slots = current hard-coded order (Home, Items, Books, POs, Scan).
insert into public.organization_nav_overrides
  (organization_id, module_key, surface, tab_slot, owner_pinned)
select o.id, t.key, 'mobile_tab', t.slot, (t.slot = 0)
from public.organizations o
cross join (values
  ('overview',0),('items',1),('books',2),('purchase_orders',3),('scan',4)
) as t(key, slot)
on conflict do nothing;

commit;
```

A trigger on `organizations` `AFTER INSERT` runs the same seed (parameterized by `industry` preset) so new orgs are provisioned automatically. After this migration ships, `nav.ts`/`drawer-nav.ts`/`_layout.tsx` are refactored to call the resolver; the static arrays are deleted in the same PR.

---

### Files touched / created

- **New (core):** `packages/core/src/nav/registry.ts`, `packages/core/src/nav/resolve.ts`, `packages/core/src/nav/industry-presets.ts`; extend `packages/core/src/constants/terminology.ts` (add `nav.*`/`item_type.*`/`status.*` keys + `resolveNavLabel`).
- **New (db):** `supabase/migrations/0144_nav_manifest.sql` (above), plus follow-ons `0145_custom_field_defs.sql`, `0146_org_status_defs.sql`, `0147_document_templates.sql`, `0148_notification_event_registry.sql`, `0149_org_integrations.sql`.
- **Refactor (web):** `apps/web/src/components/dashboard/nav.ts` → wrapper over resolver; `apps/web/src/components/dashboard/sidebar.tsx` consumes resolved sections; `apps/web/src/app/(dashboard)/dashboard/page.tsx` quick-actions/attention driven by `web_quick_action`/`web_attention` surfaces; `context.ts`/`api-context.ts` add `assertModuleEnabled`; new `settings/modules`, `settings/navigation`, `settings/fields`, `settings/workflows`, `settings/documents`, `settings/integrations` pages + actions in `organization.ts`.
- **Refactor (mobile):** `apps/mobile/src/lib/drawer-nav.ts` → resolver call; `apps/mobile/src/components/drawer-content.tsx` renders resolved sections; `apps/mobile/app/(drawer)/(tabs)/_layout.tsx` maps `resolveTabs()`; `apps/mobile/src/lib/sync.ts` `SnapshotResponse` gains `modules`/`navOverrides`/`terminology`.

**Stated assumptions:** (1) module toggles are enforced at the service layer, not RLS, to avoid reworking the 91 static policies (0140); (2) `entitlementKey` reuses the existing `PlanLimits` flags (`purchaseOrders`, `advancedReports`, etc.) plus a few new string keys (`books_module`) rather than a separate entitlements engine — consistent with the dead-but-present `assertPlanLimit` machinery; (3) Layer-3 `user_nav_prefs` is phase 2 and never widens access; (4) the dashboard quick-action/attention surfaces (`web_quick_action`, `web_attention`) are modeled as registry surfaces but their data still comes from `getDashboardActions()` — the registry controls which cards show and their order, not the live counts.

---

## Integration Architecture

StockPilot becomes the **system of record for warehouse execution and physical stock** (the immutable `stock_movements` ledger from `0002_inventory.sql`, `stock_reservations` soft-holds from `0044_order_requests.sql`, `item_stock_levels` per-location balances). External systems own demand and money: storefront/POS catalog and orders, payments, accounting GL, and parcel labels/tracking. The connector framework is a thin, declarative layer that reuses three pieces of infrastructure that **already exist** and are proven in production:

1. **`outbox_events` + `publish_outbox()` RPC** (`0016_outbox.sql`) — transactional outbox with per-org `dedupe_key` unique index and a `published_at IS NULL` partial index ready for a drain worker. Today only `receipt.posted` is published (`receiving.ts:186`).
2. **`audit()` helper** (`audit.ts:181`) — writes to `audit_logs` with jsonb metadata + `entity_id` BTREE index (`0135`). Reusable verbatim for connector lifecycle events.
3. **Service context + RPC pattern** (`withContext`/`withApiContext`, `context.ts`) — all mutations flow through `adjust_stock`, `transfer_stock`, `approve_order_request`, `post_receipt_v2` SECURITY DEFINER RPCs that serialize critical writes via row locks.

The design rule: **connectors never write `stock_movements`, `item_stock_levels`, or `quantity_on_hand` directly.** They call the same RPCs internal users call, so every external mutation lands in the immutable ledger with full RLS enforcement and audit trail. This preserves the strategic strengths called out in the audit.

> **Assumption flags** (not confirmed in audit): there is no existing secrets-vault table, no encryption-at-rest helper for third-party tokens, and no background worker/cron runtime. I propose Supabase Vault for secrets and a Vercel Cron + Edge Function for the drain worker; if a different secret store or queue is already in use, swap those primitives — the table shapes are unaffected.

### Design principles

| Principle | Mechanism | Why it fits the audit |
|---|---|---|
| Ledger is sacred | Connectors call `adjust_stock`/`transfer_stock`/`post_receipt_v2`, never raw INSERT | The audit names these as the "core atomic stock mutation primitive" |
| Idempotency everywhere | Reuse `outbox_events.dedupe_key` for outbound; new `idempotency_keys` reuse (already exists for `post_receipt_v2`) for inbound | `idempotency_keys` (org, scope, key, hash, status, resource_id) is "transferable to any inbound goods system" |
| Declarative over forked | `connector_definitions` manifest (compile-time) + `connections` (per-org runtime) — no per-customer code | Matches the manifest+pack strategy mandated for the whole product |
| Org-scoped + RLS-enforced | Every new table carries `organization_id` + `is_org_member`/`has_org_role` policies | Every existing table does; "new tables automatically get RLS" |
| Failure is auditable, never silent | Outbox rows persist; `connector_sync_log` records every cycle; conflicts queue to `connector_conflicts` | Audit gap: "outbox events sit there with no consumer" — we add the consumer |

---

### 1. Generic Connector Framework

#### 1.1 Table shapes

Six new tables, one new migration (`0144_connectors.sql`). All carry `organization_id` and standard `is_org_member`/`has_org_role(manager)` RLS following the `outbox_events` policy shape exactly.

```sql
-- 0144_connectors.sql

-- (A) Compile-time manifest, seeded from packages/core. Read-only to orgs.
-- Mirrors the "connector_definitions" manifest concept. NOT per-org.
create table public.connector_definitions (
  provider        text primary key,              -- 'square' | 'shopify' | 'quickbooks' | 'easypost'
  display_name    text not null,
  category        text not null,                 -- 'commerce' | 'accounting' | 'carrier'
  sync_modes      text[] not null,               -- {'pull','bidirectional','event'}
  capabilities    jsonb not null,                -- {catalog:'pull', inventory:'bidirectional', orders:'event'}
  webhook_topics  text[] not null default '{}',  -- topics this provider emits inbound
  outbox_topics   text[] not null default '{}',  -- StockPilot topics this provider consumes
  auth_kind       text not null,                 -- 'oauth2' | 'api_key' | 'hmac'
  min_plan        text not null default 'business'
);

-- (B) Per-org connection. Secrets live in Vault, referenced by id (NOT stored here).
create table public.connections (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  provider           text not null references public.connector_definitions(provider),
  status             text not null default 'pending'
                       check (status in ('pending','active','degraded','paused','revoked','error')),
  sync_mode          text not null default 'pull'
                       check (sync_mode in ('pull','bidirectional','event')),
  display_label      text,                        -- "Square - Main St POS"
  secret_ref         text,                        -- Supabase Vault secret name, never the token
  external_account_id text,                       -- merchant id / shop domain / realm id
  config             jsonb not null default '{}', -- mapping toggles, location routing, sync cadence
  cursor             jsonb not null default '{}', -- per-resource pagination/since cursors
  webhook_secret_ref text,                        -- HMAC verify key (Vault ref)
  last_pull_at       timestamptz,
  last_push_at       timestamptz,
  error_detail       jsonb,
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (organization_id, provider, external_account_id)
);

-- (C) Bidirectional ID map: StockPilot entity <-> external entity.
-- This is the heart of conflict-free sync. One row per (connection, entity, local_id).
create table public.external_id_map (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id   uuid not null references public.connections(id) on delete cascade,
  entity_type     text not null,                 -- 'item' | 'location' | 'order' | 'category' | 'inventory_level'
  local_id        uuid,                          -- inventory_items.id, warehouses.id, order_requests.id...
  external_id     text not null,                 -- Square variation_id, Shopify inventory_item_id, etc.
  external_parent text,                          -- e.g. Shopify product_id for a variant
  external_version text,                          -- Shopify updated_at / Square version for optimistic concurrency
  local_version   text,                           -- StockPilot updated_at at last successful sync
  last_synced_at  timestamptz,
  unique (connection_id, entity_type, external_id),
  unique (connection_id, entity_type, local_id)
);
create index external_id_map_local on public.external_id_map(organization_id, entity_type, local_id);

-- (D) Sync run log — one row per pull/push cycle or webhook batch.
create table public.connector_sync_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id   uuid not null references public.connections(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound')),
  trigger         text not null check (trigger in ('cron','webhook','manual','outbox')),
  entity_type     text not null,
  status          text not null check (status in ('ok','partial','error')),
  records_seen    int not null default 0,
  records_applied int not null default 0,
  records_skipped int not null default 0,
  conflicts       int not null default 0,
  cursor_before   jsonb, cursor_after jsonb,
  error_detail    jsonb,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index connector_sync_log_recent
  on public.connector_sync_log(organization_id, connection_id, started_at desc);

-- (E) Conflict queue — when ledger and external disagree and auto-rules can't decide.
create table public.connector_conflicts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id   uuid not null references public.connections(id) on delete cascade,
  entity_type     text not null,
  local_id        uuid,
  external_id     text,
  kind            text not null,                 -- 'qty_mismatch' | 'missing_local' | 'missing_external' | 'concurrent_edit'
  local_snapshot  jsonb, external_snapshot jsonb,
  proposed_action text,                          -- 'create_cycle_count' | 'adjust_to_external' | 'push_to_external'
  status          text not null default 'open'   check (status in ('open','resolved','ignored')),
  resolved_by     uuid references auth.users(id),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- (F) Inbound webhook receipts (raw, for replay + dedupe). Verifies HMAC before processing.
create table public.connector_webhook_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id   uuid not null references public.connections(id) on delete cascade,
  provider        text not null,
  topic           text not null,                 -- 'order.created' | 'inventory.count.updated'
  external_event_id text,                         -- provider's idempotency id
  signature_ok    boolean not null,
  payload         jsonb not null,
  processed_at    timestamptz,
  error_detail    jsonb,
  received_at     timestamptz not null default now(),
  unique (connection_id, external_event_id)      -- inbound idempotency
);
```

RLS for all six follows the `outbox_events` pattern (`0016`): `select`/`all` gated by `has_org_role(organization_id, 'manager')`. `connector_definitions` is global read (no `organization_id`), seeded via migration, never writable by orgs.

#### 1.2 Where it plugs into the service layer

```
apps/web/src/server/services/
  connectors/
    registry.ts          -- loads connector_definitions + the manifest from packages/core
    connections.ts       -- ConnectionsService.forCurrentUser(): CRUD, OAuth callback, test, pause
    sync-engine.ts       -- generic pull/push driver; provider-agnostic mapping + conflict logic
    mapping.ts           -- applyMapping(definition, externalRecord) -> StockPilot DTO + back
    square.ts            -- SquareAdapter implements ConnectorAdapter
    shopify.ts           -- ShopifyAdapter
    quickbooks.ts        -- QuickBooksAdapter (outbound-only)
    carriers/easypost.ts -- CarrierAdapter (request/response, no sync loop)
```

```ts
// The single contract every connector implements. Generic enough for all four.
interface ConnectorAdapter {
  provider: string;
  // INBOUND (pull): provider data -> StockPilot DTOs
  pullCatalog?(ctx, conn): AsyncIterable<ExternalItem>;
  pullLocations?(ctx, conn): AsyncIterable<ExternalLocation>;
  pullInventory?(ctx, conn): AsyncIterable<ExternalInventoryLevel>;
  // INBOUND (event): verify + normalize a webhook into a domain action
  verifyWebhook?(req, secret): boolean;
  parseWebhook?(payload): { topic: string; action: DomainAction };
  // OUTBOUND: react to a StockPilot outbox topic -> external API call
  handleOutbox?(ctx, conn, event: OutboxEvent): Promise<void>;
  // Map a StockPilot inventory delta -> external inventory set/adjust
  pushInventoryLevel?(ctx, conn, level: { externalId; available: number }): Promise<void>;
}
```

**Outbound path** reuses the existing outbox. Today `receiving.ts` already calls `publish_outbox`. We extend the *same* call sites (and add `adjust_stock`/`approve_order_request` call sites) to publish the new topics below. A **drain worker** (Vercel Cron, every 60s) selects `outbox_events WHERE published_at IS NULL` (the `outbox_unpublished_idx` partial index already exists), fans each row out to every active `connection` whose `connector_definitions.outbox_topics` contains the topic, calls `adapter.handleOutbox`, then stamps `published_at`. Idempotency is the existing per-org `dedupe_key` unique index.

```
Outbox topics to add (published from existing RPC wrappers in the service layer):
  stock.adjusted        -- from adjust_stock wrapper        -> push InventoryLevel to commerce
  stock.transferred     -- from transfer_stock wrapper      -> re-route InventoryLevel by location
  cyclecount.posted     -- from post_cycle_count wrapper     -> push corrected on-hand
  receipt.posted        -- ALREADY published (receiving.ts) -> push on-hand + QBO inventory asset record
  order.fulfilled       -- from complete_picking/deliver     -> QBO sales record, carrier label trigger
  order.cancelled       -- from cancel_order_request         -> release external reservation
```

**Inbound path** is two front doors, both under existing API conventions:
- `POST /api/v1/connectors/[provider]/webhook` — verifies HMAC via `webhook_secret_ref`, inserts into `connector_webhook_events` (the `unique(connection_id, external_event_id)` enforces inbound idempotency), returns 200 immediately, then enqueues processing. This mirrors the existing `app/api/webhooks/stripe/route.ts` pattern.
- A pull cron (`/api/cron/connectors/pull`) for providers/resources that don't push (catalog/location backfill, periodic reconciliation).

Both ultimately call domain RPCs through a `withApiContext`-derived service context, so **RLS, MFA, plan limits, and audit all apply unchanged**.

#### 1.3 Manifest fields (in `packages/core/src/constants/connectors.ts`)

```ts
export const CONNECTOR_MANIFEST = {
  square: {
    category: 'commerce',
    syncModes: ['pull', 'bidirectional', 'event'],
    capabilities: {
      catalog: 'pull',            // Square Catalog -> inventory_items (create/update)
      locations: 'pull',          // Square Location -> external_id_map(location)
      inventory: 'bidirectional', // reconcile against ledger
      orders: 'event',            // order.created webhook -> order_requests
    },
    webhookTopics: ['order.created', 'order.updated', 'inventory.count.updated', 'catalog.version.updated'],
    outboxTopics: ['stock.adjusted', 'stock.transferred', 'cyclecount.posted', 'receipt.posted'],
    authKind: 'oauth2',
    requiredScopes: ['ITEMS_READ', 'INVENTORY_READ', 'INVENTORY_WRITE', 'ORDERS_READ'],
    minPlan: 'business',
  },
  // shopify, quickbooks, easypost ...
} as const;
```

Plan-gating reuses the existing `assertPlanLimit` / `PLANS` mechanism — connectors become an entitlement on `business`/`enterprise` tiers without new gating machinery. Nav surfacing reuses the static `ADMIN_NAV` array (`nav.ts`) with a single new "Integrations" item gated on a new `integrations:manage` permission added to `packages/core/src/constants/permissions.ts` (owner/admin only).

---

### 2. Square Connector

Square is the richest case (pull + bidirectional + event), so it defines the framework's full surface.

#### 2.1 Catalog & locations pull (one-directional, Square → StockPilot)

```
Square CatalogObject(ITEM/ITEM_VARIATION) ──▶ inventory_items
Square Location ───────────────────────────▶ warehouses (via external_id_map)
```

- **Locations first.** Each Square `Location` maps to a StockPilot `warehouse`. On connect, the admin maps each Square location to an existing warehouse or creates one. Persist in `external_id_map(entity_type='location', local_id=warehouse.id, external_id=square_location_id)`. This is the **multi-location routing key** for all inventory math.
- **Catalog.** Each Square `ITEM_VARIATION` becomes one `inventory_items` row. `sku` ← Square SKU (or `generate_sku()` RPC if absent), `barcode` ← Square UPC, `name`/`unit_price` mapped, and `custom_fields.square_variation_id` set. Item creation goes through the existing `InventoryService.create` (respects `assertPlanLimit('items', count)`), **not** raw insert. `item_type` defaults to `product`.
- **Conflict on catalog pull:** if a SKU already exists, link via `external_id_map` rather than duplicate. The `0126_relax_sku_uniqueness_per_location` migration means SKU collisions across warehouses are tolerated; the map disambiguates.
- Cursor: store Square's catalog `cursor` and `begin_time` in `connections.cursor.catalog`. The `connector_definitions.capabilities.catalog='pull'` means StockPilot **never** pushes catalog edits back to Square (Square owns the storefront catalog).

#### 2.2 Inventory bidirectional reconciliation against the ledger

This is the load-bearing flow. The contract: **StockPilot's ledger-derived `quantity_on_hand` is the on-hand authority; Square's `IN_STOCK` count must converge to it.**

```
Steady state (StockPilot → Square), event-driven:
  adjust_stock / post_receipt_v2 / post_cycle_count
        │ (existing RPC, writes ledger atomically)
        ▼
  publish_outbox('stock.adjusted', {itemId, warehouseId, newQty})   ← add to RPC wrappers
        ▼ (drain worker, 60s)
  SquareAdapter.handleOutbox
        │ resolve external_id_map(location) for warehouseId
        │ resolve external_id_map(item) for itemId
        ▼
  Square BatchChangeInventory → set IN_STOCK = newQty at that location
        │ idempotency_key = outbox_events.id
        ▼
  external_id_map.external_version = response version; sync_log row
```

```
Periodic reconciliation (cron, hourly), detects drift either direction:
  pull Square IN_STOCK per (variation, location)
        ▼
  for each: localQty = item_stock_levels.quantity at mapped warehouse
            externalQty = Square IN_STOCK
        ▼
  if equal           → noop
  if differ:
     - if Square change is newer than last StockPilot ledger event for that item
       AND config.reconcile_mode = 'trust_external_sales'   → see §2.3
     - else                                                  → connector_conflicts(kind='qty_mismatch',
                                                                proposed_action='create_cycle_count')
```

Critical rule: a reconciliation discrepancy **never** silently overwrites the ledger with `adjust_stock`. The ledger is immutable history; the correct response to "physical/external reality disagrees" is a **cycle count**, which is exactly the existing `post_cycle_count` workflow (`0023`/`0079`) that produces an auditable variance `adjust` movement. So `proposed_action='create_cycle_count'` can, on admin confirmation, call the existing `CycleCountsService.start` with `scope='selection'` (the `0141_cycle_count_scope` selection mode) seeded with the drifting items. This reuses the audit's named primitive — "variance-capture is industry-agnostic."

#### 2.3 Order ingestion via webhooks (Square → StockPilot)

```
Square order.created webhook
        ▼
POST /api/v1/connectors/square/webhook   (verify HMAC, dedupe via external_event_id)
        ▼ insert connector_webhook_events (unique(connection_id, external_event_id))
        ▼ enqueue processing
        ▼ SquareAdapter.parseWebhook → DomainAction{ createOrder, lines, locationId }
        ▼ resolve warehouse via external_id_map(location)
        ▼ resolve items via external_id_map(item); unknown SKU → connector_conflicts(missing_local)
        ▼ create order_requests(source='connector:square', warehouse_id, status='approved')
          + call approve_order_request RPC  → places stock_reservations soft-holds
```

- A retail/POS sale is a **completed** sale, not a request — so it's ingested as an already-fulfilled outbound movement, not a pending order. Two valid models, chosen by `connections.config.order_mode`:
  - `reserve_then_fulfill` (default for delayed-fulfillment / pickup): create `order_request` at `approved`, place reservations.
  - `immediate_decrement` (default for in-store POS): call `adjust_stock(item, -qty, 'remove', location, reason='square_sale')` directly — the sale already happened, so decrement the ledger and emit `order.fulfilled`. This consumes a *new* `movement_type` value `'remove'` which already exists in the `0002` check constraint — **no enum change needed.**
- **Idempotency** is double-locked: `connector_webhook_events.unique(connection_id, external_event_id)` rejects duplicate webhook deliveries; and the order-creation RPC carries the Square order id as a `dedupe_key` so a replayed event won't create a second `order_request`.
- **The §2.2 reconciliation tie-in:** because every Square sale already decremented the StockPilot ledger via this path, the hourly reconciliation should normally find Square and StockPilot in agreement. A `qty_mismatch` therefore signals a *real* discrepancy (offline POS, manual Square edit, shrinkage) and correctly routes to a cycle count rather than blindly trusting either side.

#### 2.4 Conflict handling summary (Square)

| Situation | Detection | Resolution |
|---|---|---|
| Duplicate webhook | `external_event_id` unique violation | Drop, log `skipped` |
| Unknown SKU in order | No `external_id_map(item)` row | `connector_conflicts(missing_local)`; hold line, alert admin |
| On-hand drift | Hourly pull vs `item_stock_levels` | `connector_conflicts(qty_mismatch)` → propose cycle count (never raw overwrite) |
| Concurrent edit (push race) | Square `version` ≠ `external_id_map.external_version` | Re-pull, re-push with fresh version; if still conflicting → conflict row |
| Negative would-be stock | `adjust_stock` raises `insufficient_stock` | Surface as `connector_conflicts(qty_mismatch)`; do not partially apply |

---

### 3. Shopify Connector (same framework)

Shopify slots into the identical `ConnectorAdapter` contract; only the mapping and entity model differ.

#### 3.1 Model mapping

```
Shopify Product            ─┐
Shopify ProductVariant     ─┴▶ inventory_items   (variant = item; product_id stored as external_parent)
Shopify InventoryItem      ──▶ external_id_map(entity_type='item', external_id=inventory_item_id)
Shopify Location           ──▶ warehouses        (external_id_map entity_type='location')
Shopify InventoryLevel     ──▶ item_stock_levels (the (inventory_item_id, location_id) pair)
Shopify Order/LineItem     ──▶ order_requests / adjust_stock
```

Shopify's separation of `Product` (catalog), `InventoryItem` (the trackable unit), `Location`, and `InventoryLevel` (qty per item per location) maps cleanly onto StockPilot's `inventory_items` × `warehouses` × `item_stock_levels` triple. The `external_id_map.external_parent` column holds the Shopify `product_id` so variant grouping survives.

#### 3.2 Webhook-driven sync + multi-location routing

- Subscribe to `products/create|update`, `inventory_levels/update`, `orders/create|paid|cancelled`, `locations/create`.
- `inventory_levels/update` carries `inventory_item_id` + `location_id` + `available`. Route to the StockPilot warehouse via `external_id_map(location)`, then run the §2.2 reconciliation logic against `item_stock_levels` for that warehouse. **Multi-location is native** because StockPilot already stores per-location balances; the connector just needs the location map.
- Outbound: StockPilot `stock.adjusted`/`cyclecount.posted` → Shopify `inventoryLevels/set` (GraphQL `inventorySetQuantities`) scoped to the mapped `location_id`. `connections.config.fulfillment_location_priority` (an ordered list of warehouse ids) decides which warehouse Shopify orders decrement when a product is stocked in several — defaulting to the order's `location_id` if Shopify sends one.
- Shopify uses `updated_at` for optimistic concurrency → store in `external_id_map.external_version`; same concurrent-edit handling as §2.4.

#### 3.3 Square vs Shopify deltas (everything else is shared)

| Concern | Square | Shopify |
|---|---|---|
| Auth | OAuth2 (`auth_kind='oauth2'`) | OAuth2 + per-shop access token |
| Trackable unit | `ITEM_VARIATION` | `InventoryItem` (≠ variant id) |
| Inventory write API | `BatchChangeInventory` (set) | `inventorySetQuantities` GraphQL |
| Concurrency token | Catalog `version` | `updated_at` |
| Webhook verify | HMAC-SHA256 over body | HMAC-SHA256 `X-Shopify-Hmac-Sha256` |

No new tables, no new RPCs — only `shopify.ts` adapter + a manifest entry.

---

### 4. Adjacent Connectors

#### 4.1 QuickBooks Online (outbound, summarized — not a financial rebuild)

QBO consumes **summarized financial-impact records**, never line-by-line transactions. StockPilot is *not* an accounting system and must not try to be the GL.

```
StockPilot outbox topic        QBO artifact (export-only, outbound)
  receipt.posted        ─────▶ Bill / Inventory Asset increase  (qty × unit_cost_at_receive)
  order.fulfilled       ─────▶ Sales Receipt / Invoice + COGS    (summarized per order)
  cyclecount.posted     ─────▶ Inventory Adjustment journal entry (variance × valuation)
  stock.adjusted(damage/loss) ▶ Shrinkage expense journal entry
```

- QBO is `category='accounting'`, `syncModes=['event']`, `capabilities={financials:'export'}`. It only implements `handleOutbox`; it has no pull loop and no `external_id_map` for stock (it maps StockPilot **categories → QBO GL accounts / item classes** instead, stored in `external_id_map(entity_type='gl_account')`).
- Cost basis comes from `receipt_lines.unit_cost_at_receive` (already captured) and `inventory_value()` RPC (`0004`). The audit notes a real gap: **`stock_movements` has no `unit_cost`** — so for `damage`/`loss`/`correction` movements, QBO export uses the item's current weighted cost as an approximation and flags `cost_basis: 'estimated'` in the payload. This is honest about the limitation rather than inventing precision the ledger doesn't have.
- Batching: a daily cron summarizes the day's `order.fulfilled` events into one Sales Receipt batch per warehouse to avoid QBO API throttling and GL clutter. `connector_sync_log` records each batch.

#### 4.2 Carriers — UPS / FedEx / EasyPost (request/response, not a sync loop)

Carriers are **not** sync connectors — there's no continuous reconciliation. They're request/response services invoked at fulfillment time. They share the `connections` row (secrets, status) but bypass the outbox drain.

```
Order reaches 'ready_for_delivery' (existing state machine, 0109)
        ▼
CarrierAdapter.createLabel(ctx, conn, { fromWarehouse.address, toAddress, parcel })
        ▼ EasyPost/UPS/FedEx API → label PDF + tracking number
        ▼ store label in order-attachments bucket (reuse 0142 order_request_attachments)
        ▼ write tracking# to order_requests (new column: carrier_tracking_number, carrier_provider)
        ▼ audit('order.label_created'); publish_outbox('order.shipped')
        ▼
Tracking webhook (EasyPost 'tracker.updated') ──▶ /api/v1/connectors/easypost/webhook
        ▼ update order_requests delivery status; notify requester (reuse notification dispatch)
Returns: EasyPost return label → new order_request(source='return') + RMA disposition
```

- **Closes an audited gap**: "Order requests have no shipment tracking or label generation," and "serial_registry.current_status='rma' exists but no return workflow." The return label flow creates an inbound `order_request`/receipt path that can re-stock via `post_receipt_v2` or set `serial_registry.current_status='rma'`.
- Minimal schema change: add `carrier_provider`, `carrier_tracking_number`, `label_attachment_id` to `order_requests` (migration `0145`). Addresses come from `locations.address` jsonb (warehouse) and `order_requests.delivery_address` jsonb (`0109`, currently undocumented — this connector gives it a concrete schema: `{name, line1, line2, city, region, postal, country}`).

---

### 5. Source-of-Truth Matrix

For each domain: who is authoritative, sync direction relative to StockPilot, the mechanism, and the StockPilot anchor.

| Domain | Owner (system of record) | Direction | Mechanism | StockPilot anchor |
|---|---|---|---|---|
| **Catalog** (products, SKUs, prices) | **External commerce** (Square/Shopify) where a storefront exists; else StockPilot | Pull (external → SP); SP read-only | `pullCatalog` → `InventoryService.create/update`; `external_id_map(item)` | `inventory_items`, `custom_fields` |
| **On-hand stock** | **StockPilot ledger** (always) | Bi-directional; SP authoritative on conflict | `adjust_stock`/`post_receipt_v2`/`post_cycle_count` → outbox → external set | `stock_movements`, `item_stock_levels`, `quantity_on_hand` |
| **Reservations / soft-holds** | **StockPilot** | SP-only (external "committed" maps to a release) | `stock_reservations` (`0044`); webhook sale → reserve or decrement | `stock_reservations.released_at` |
| **Orders / demand** | **External commerce** (storefront/POS) | Inbound (external → SP) | `order.created` webhook → `order_requests` (`source='connector:*'`) | `order_requests`, `order_request_lines` |
| **Payments** | **External (Stripe / Square / Shopify)** | None into SP stock; metadata only | Existing Stripe webhook (`webhooks/stripe`); commerce payments stay external | n/a — SP never touches money flows |
| **Fulfillment / pick-pack-ship** | **StockPilot** (warehouse execution) | Outbound status; carrier request/response | `0109` state machine → `order.fulfilled`/`order.shipped` outbox; carrier label | `order_requests` workflow columns |
| **Shipping labels / tracking** | **Carrier (EasyPost/UPS/FedEx)** | Request/response + tracking webhook inbound | `CarrierAdapter.createLabel`; tracker webhook | new `order_requests.carrier_*` cols |
| **Financials / GL** | **External accounting (QBO)** | Outbound export only (summarized) | `handleOutbox` → QBO Bill/SalesReceipt/Journal | `unit_cost_at_receive`, `inventory_value()` |

#### 5.1 Reconciliation when the ledger and an external count disagree

The governing rule, restated: **the immutable ledger is the on-hand authority; an external count that disagrees is treated as evidence of an un-recorded physical event, not as a correction to apply blindly.**

```
Detected drift (reconciliation cron or inventory webhook):
  localQty   = item_stock_levels.quantity (mapped warehouse)
  externalQty = provider IN_STOCK / available

  ┌─ |Δ| == 0 ───────────────────────────── no-op
  │
  ├─ external is BEHIND (externalQty < localQty)
  │     and last SP ledger event is NEWER than provider's update timestamp
  │        → SP is right; PUSH localQty to provider (set), log 'ok'
  │
  ├─ external is AHEAD (externalQty > localQty)  — implies an external receipt/restock SP missed
  │        → open connector_conflicts(kind='qty_mismatch',
  │            proposed_action='create_cycle_count')   [never auto-increment the ledger]
  │
  └─ external is BEHIND but provider update is NEWER (an offline POS sale SP missed)
         → if config.reconcile_mode='trust_external_sales':
              adjust_stock(item, -(localQty-externalQty), 'remove', location,
                           reason='reconcile:<provider>')   ← creates an AUDITABLE ledger event
           else: open connector_conflicts(qty_mismatch)
```

Why this is safe and on-brand:
1. **Convergence always flows through a ledger-writing RPC** (`adjust_stock` or, via cycle count, `post_cycle_count`). There is no code path that mutates `quantity_on_hand`/`item_stock_levels` outside the ledger. The audit's "immutable stock ledger" strength is preserved verbatim.
2. **Auto-apply is opt-in and bounded.** Only the narrow "external sale we missed" case auto-applies, gated by `connections.config.reconcile_mode`, and it still writes a `movement_type='remove'` (an existing enum value) with `reason='reconcile:<provider>'` so the discrepancy is fully traceable in `stock_movements`.
3. **Everything else escalates to a human via a cycle count** — the existing, atomic, variance-producing `post_cycle_count` workflow with `scope='selection'` (`0141`). This is the only mechanism in the system that can legitimately *raise* on-hand against an external count, and it produces the proper variance `adjust` movement.
4. **Every reconciliation cycle is logged** in `connector_sync_log` (`records_seen/applied/skipped/conflicts`) and every applied adjustment is `audit()`-logged, so a "stock discrepancy" can be drilled from the audit timeline back to the connection and the cycle that caused it — directly addressing the audited gap "no drill-down from a stock discrepancy to the RPC call that caused it."

#### 5.2 Idempotency guarantees (consolidated)

| Direction | Mechanism | Source |
|---|---|---|
| Outbound to external | `outbox_events.dedupe_key` unique per org; idempotency key = `outbox_events.id` passed to provider | Existing `0016`; existing `receiving.ts` pattern |
| Inbound webhook | `connector_webhook_events.unique(connection_id, external_event_id)` | New, this design |
| Inbound order creation | `order_requests` dedupe key = `connector:<provider>:<external_order_id>` | Reuses the existing `idempotency_keys` table backing `post_receipt_v2` |
| Reconciliation push race | optimistic version compare (`external_id_map.external_version`) | New, this design |

---

### Implementation summary (what to build, grounded in existing primitives)

| Layer | New | Reuses (already exists) |
|---|---|---|
| DB | `0144_connectors.sql` (6 tables), `0145_order_carrier_fields.sql` (3 cols on `order_requests`) | `publish_outbox`/`outbox_events` (`0016`), `idempotency_keys`, `audit_logs` (`0135`), `adjust_stock`/`transfer_stock` (`0004`), `post_cycle_count` (`0023`/`0079`), `post_receipt_v2` (`0015`), `stock_reservations` (`0044`), `cycle_count.scope='selection'` (`0141`), `order-attachments` bucket (`0142`) |
| `packages/core` | `constants/connectors.ts` manifest; `integrations:manage` permission | `PLANS`/`assertPlanLimit`, `ROLE_PERMISSIONS` matrix |
| Service layer | `services/connectors/*` (registry, connections, sync-engine, mapping, square, shopify, quickbooks, carriers/easypost) | `withContext`/`withApiContext`, `ServiceError`, `audit()`, `InventoryService`, `CycleCountsService`, `OrderRequestsService` |
| API | `/api/v1/connectors/[provider]/webhook`, `/api/cron/connectors/{pull,drain}`, OAuth callback routes | `withApiContext` bearer/cookie auth, Stripe-webhook HMAC verify pattern |
| Worker | Vercel Cron drain (`outbox_unpublished_idx`) + hourly reconcile | The partial index and `published_at IS NULL` semantics already designed into `0016` |
| Nav | one "Integrations" `ADMIN_NAV` item | static `nav.ts` array + `navForRole` filter |

The net effect: a single declarative connector framework where adding a provider is one manifest entry + one adapter file, the ledger remains the inviolable system of record for physical stock, every external mutation is funneled through the existing audited RPCs, and reconciliation disagreements resolve through the existing cycle-count machinery rather than blind overwrites.

---

## Vertical-Pack Designs

Vertical packs are **declarative presets over the one shared warehouse engine** — never forks. A pack is a JSON manifest stored on `organizations` (new `domain_pack text` + `pack_config jsonb` columns, or a dedicated `organization_packs` table) and resolved once per request inside `withContext`/`withApiContext` (`apps/web/src/server/services/context.ts`, `apps/web/src/lib/auth/api-context.ts`) the same way `resolveTerminology()` already merges org overrides today. A pack composes five existing-or-near-existing primitives:

| Pack lever | Resolves against | Exists today? |
|---|---|---|
| `enabledModules` | nav filter + service guard | **No registry** — nav is static (`nav.ts`, `drawer-nav.ts`); needs `org_enabled_modules` |
| `terminology` | `resolveTerminology()` (`packages/core/src/constants/terminology.ts`) | Partial — only 4 keys; needs extension |
| `surfaceConfig` | `navForRole()` (`nav.ts`), `DRAWER_SECTIONS` (`drawer-nav.ts`), tabs `_layout.tsx` | **No** — hard-coded arrays |
| `fieldSchemas` | `inventory_items.custom_fields jsonb` (0002) | Storage exists; **no schema registry/validation** |
| `workflowPolicies` | RPC params + service asserts (`post_receipt_v2` 0069, order state machine `packages/core/src/order-state-machine.ts`) | Engine exists; **policies hard-coded, not data-driven** |

### Prerequisite platform work (shared by all packs)

These are the new modules/extensions the packs assume. Anything beyond what the audit confirmed is flagged **[NEW]**.

1. **Module registry [NEW]** — `enabledModules` is a no-op until nav and services honor it. Add `organizations.enabled_modules text[]` (or `pack_config.modules`), a `MODULES` const in `packages/core`, an `isModuleEnabled(ctx, module)` helper, a `requiresModule?: Module` field on `NavItem`/`DrawerNavItem`, and a `ServiceError('module_disabled')` code (extends the existing typed-code set in `context.ts`). Nav filter becomes `navForRole(role, enabledModules)`.
2. **Terminology extension [NEW]** — widen `OrgTerminology` beyond `charter_*`/`warehouse_*` to a generic `Record<string,{singular,plural}>` (keys: `item`, `location`, `order`, `lot`, `serial`, `supplier`, `charter`, `warehouse`, plus pack-defined `grower`, `crop`, `shift`). `resolveTerminology()` already merges by spread — only the interface and editor (`terminology-editor.tsx`) change.
3. **Field-schema registry [NEW]** — `item_field_schemas` table (`organization_id`, `item_type`, `key`, `label`, `data_type`, `required`, `enum_values jsonb`, `unit`) driving a generic custom-field editor + Zod validation on top of the existing `custom_fields jsonb`. Replaces the hard-coded book-rack branching in `inventory.ts`.
4. **Workflow-policy resolver [NEW]** — `pack_config.workflowPolicies` consumed by service methods and passed into RPCs. Several need RPC signature changes (`post_receipt_v2`, order transition guards) — called out per pack.
5. **Outbox draining [NEW]** — only `receipt.posted` is published today (`receiving.ts:186`) and nothing consumes it. Carrier shipping + traceability packs need a worker + `webhook_subscriptions` table.

---

### Pack 1 — Charter Education (must map L4L Fresno exactly as-is)

This pack is the **identity preset**: it must equal current behavior so the existing L4L Fresno org maps onto it with `enabledModules = everything`, no terminology overrides (defaults `Charter`/`Warehouse` already match `DEFAULT_TERMINOLOGY`), and no new policies. Everything below is confirmed-existing (`item_type='book'` 0020, public links 0044, AI shelf scan 0124 books-only, bundles 0040, signatures `order_request.signature_data_url` per memory + 0142 attachments).

```json
{
  "domainPack": "charter_education",
  "version": 1,
  "enabledModules": [
    "items", "books", "categories", "tags", "movements", "rentals",
    "bundles", "orders", "public_requests", "cycle_counts", "ai_shelf_scan",
    "procedures", "purchase_orders", "po_imports", "locations", "suppliers",
    "reports", "schedule", "charters", "warehouses"
  ],
  "terminology": {
    "charter":   { "singular": "Charter",   "plural": "Charters" },
    "warehouse": { "singular": "Warehouse", "plural": "Warehouses" }
  },
  "fieldSchemas": {
    "book": [
      { "key": "isbn",            "label": "ISBN",      "data_type": "string", "required": false },
      { "key": "author",          "label": "Author",    "data_type": "string", "required": false },
      { "key": "book_rack_number","label": "Rack",      "data_type": "string", "required": false },
      { "key": "book_rack_row",   "label": "Rack row",  "data_type": "string", "required": false }
    ]
  },
  "surfaceConfig": {
    "webSidebar": [
      "items","books","categories","tags","movements","rentals","bundles",
      "orders","cycle-counts","procedures","purchase-orders",
      "purchase-orders/imports","locations","suppliers","reports"
    ],
    "mobileTabs": ["home","items","books","receive","scan"],
    "mobileDrawerExtras": ["categories","tags","movements","rentals","bundles",
      "orders","cycle-counts","procedures","purchase-orders","po-imports",
      "locations","suppliers","reports"]
  },
  "workflowPolicies": {
    "requireLotOnReceipt": false,
    "requireExpiryForPerishables": false,
    "requireQAHoldBeforeShip": false,
    "pickStrategy": "none",
    "orderFulfillmentTypes": ["pickup","delivery"],
    "deliverySignatureRequired": true,
    "publicRequestsEnabled": true,
    "aiShelfScanItemTypes": ["book"]
  }
}
```

**New modules required:** none. This is the regression baseline — `mobileTabs` reproduces today's exact 5-tab set (`Home, Items, Books, POs(receive), Scan`) from `_layout.tsx`, and `webSidebar` reproduces `BASE_NAV`'s Inventory section order. Cycle-count AI scan stays books-only exactly as `cycle_count_ai_scans` filters today (0124). **Validation gate for the whole project:** dump current L4L behavior and assert this pack produces an identical nav/perm/RPC surface before any other pack ships.

---

### Pack 2 — General Distribution

Drops the charter-school surfaces (Books, Public Requests, Procedures, Rentals, Schedule, AI shelf scan), renames `Charter→Region` and `Warehouse→DC`, and turns on the **execution + carrier + returns** modules that are partially-scaffolded or missing today.

```json
{
  "domainPack": "general_distribution",
  "version": 1,
  "enabledModules": [
    "items", "categories", "tags", "movements", "orders", "cycle_counts",
    "purchase_orders", "po_imports", "locations", "suppliers", "reports",
    "warehouses", "transfers", "returns", "carrier_shipping", "uom_conversions"
  ],
  "terminology": {
    "charter":   { "singular": "Region", "plural": "Regions" },
    "warehouse": { "singular": "DC",     "plural": "Distribution Centers" },
    "order":     { "singular": "Sales Order", "plural": "Sales Orders" }
  },
  "fieldSchemas": {
    "product": [
      { "key": "upc",          "data_type": "string", "label": "UPC" },
      { "key": "case_pack_qty","data_type": "number", "label": "Case pack (EA)" },
      { "key": "pallet_ti_hi", "data_type": "string", "label": "Ti/Hi" }
    ]
  },
  "surfaceConfig": {
    "webSidebar": [
      "items","categories","tags","movements","orders","transfers","returns",
      "cycle-counts","purchase-orders","purchase-orders/imports",
      "shipments","locations","suppliers","reports"
    ],
    "mobileTabs": ["home","items","orders","receive","scan"],
    "mobileDrawerExtras": ["movements","transfers","returns","cycle-counts",
      "purchase-orders","shipments","locations","suppliers","reports"]
  },
  "workflowPolicies": {
    "requireLotOnReceipt": false,
    "requireQAHoldBeforeShip": false,
    "pickStrategy": "fifo",
    "orderFulfillmentTypes": ["pickup","delivery","ship"],
    "deliverySignatureRequired": false,
    "publicRequestsEnabled": false,
    "transferRequiresInTransit": true,
    "uomConversionOnReceipt": true,
    "carrierIntegration": "manual_tracking"
  }
}
```

**New modules/extensions required:**

- **`transfers` with in-transit state [NEW].** Today `transfer_stock` (0004) is within-warehouse and instantaneous; cross-warehouse uses `shipments` (0050) which is audit-only with no in-transit ledger state (audit GAP). Add an `in_transit` movement reference and a two-phase RPC (`begin_transfer` → soft-hold via `stock_reservations`, `complete_transfer` → release + post). `transferRequiresInTransit:true` selects the two-phase path.
- **`returns` (RMA) [NEW].** Audit confirms `serial_registry.current_status='rma'` exists as an enum value but there is **no** return PO, RMA authorization, or restocking flow. New `return_orders` + `return_order_lines` tables; restock posts `adjust_stock(movement_type='return')` (the `return` movement type already exists in the 11-value enum).
- **`carrier_shipping` [NEW].** `locations.address jsonb` exists but no carrier config/rates/tracking (audit GAP). Add `carrier_shipments` (carrier, service, tracking_number, label_url) and wire the **outbox drain** (prereq #5) so `shipment.created` POSTs to a carrier webhook. `carrierIntegration:"manual_tracking"` = enter tracking by hand (no live rating) for v1.
- **`uom_conversions` activation [NEW wiring].** Table exists (0014) but is **not applied in receiving** (audit GAP). `uomConversionOnReceipt:true` requires extending `post_receipt_v2` (0069) to accept a `uom` per line and convert case/pallet → base EA before posting.
- **`pickStrategy:"fifo"`** requires a pick-allocation helper (new); the engine has no pick-strategy logic today.

Books/Procedures/Rentals/Schedule/AI-scan modules are simply **absent from `enabledModules`** — the module registry (prereq #1) hides their nav entries and `module_disabled`-guards their services. No data is deleted; the surfaces just don't render.

---

### Pack 3 — Agriculture / Food

The most demanding pack: it hard-requires lot/expiry/QA-hold policies and adds traceability + recall + compliance modules that don't exist. Lot/serial capture exists **at receive only** (`receipt_line_lots`, `serial_registry`, 0015) with **no outbound enforcement** (audit GAP) — this pack closes that gap via `workflowPolicies` that the engine must learn to honor.

```json
{
  "domainPack": "agriculture_food",
  "version": 1,
  "enabledModules": [
    "items", "categories", "tags", "movements", "orders", "cycle_counts",
    "purchase_orders", "locations", "suppliers", "reports", "warehouses",
    "lots", "growers", "quality_holds", "traceability", "recall_search",
    "compliance_exports", "transfers", "returns"
  ],
  "terminology": {
    "charter":   { "singular": "Grower",   "plural": "Growers" },
    "warehouse": { "singular": "Facility",  "plural": "Facilities" },
    "supplier":  { "singular": "Grower",    "plural": "Growers" },
    "lot":       { "singular": "Lot",       "plural": "Lots" }
  },
  "fieldSchemas": {
    "product": [
      { "key": "harvest_date",    "data_type": "date",    "label": "Harvest date" },
      { "key": "pack_date",       "data_type": "date",    "label": "Pack date" },
      { "key": "expiry_date",     "data_type": "date",    "label": "Use-by / expiry", "required": true },
      { "key": "is_perishable",   "data_type": "boolean", "label": "Perishable" },
      { "key": "catch_weight",    "data_type": "boolean", "label": "Catch weight" },
      { "key": "country_origin",  "data_type": "string",  "label": "Country of origin" },
      { "key": "gtin",            "data_type": "string",  "label": "GTIN-14" }
    ]
  },
  "surfaceConfig": {
    "webSidebar": [
      "items","lots","categories","movements","orders","quality-holds",
      "cycle-counts","purchase-orders","traceability","recall-search",
      "compliance-exports","locations","growers","reports"
    ],
    "mobileTabs": ["home","items","lots","receive","scan"],
    "mobileDrawerExtras": ["quality-holds","movements","orders","cycle-counts",
      "purchase-orders","traceability","recall-search","locations","growers","reports"]
  },
  "workflowPolicies": {
    "requireLotOnReceipt": true,
    "requireExpiryForPerishables": true,
    "requireQAHoldBeforeShip": true,
    "pickStrategy": "fefo",
    "catchWeightEnabled": true,
    "orderFulfillmentTypes": ["pickup","ship"],
    "deliverySignatureRequired": true,
    "expiryAutoDisposition": "block_and_flag",
    "complianceProfile": "fsma_204",
    "traceabilityEvents": ["receive","transform","ship","dispose"]
  }
}
```

**New modules/extensions required (most of any pack):**

- **`lots` as first-class [extends 0015].** `receipt_line_lots` exists but lots aren't a queryable master with current on-hand. Add `lots` master view (lot_number, item, expiry, qty_remaining) sourced from `receipt_line_lots` + outbound consumption.
- **`requireLotOnReceipt:true` [RPC change].** Extend `post_receipt_v2` (0069) to **reject** lines with `tracking_type!='serial'` and no lot when policy is set. `requireExpiryForPerishables:true` rejects lots missing `expiration_date` when `custom_fields.is_perishable=true`.
- **`quality_holds` [NEW].** Audit GAP: "No QA/Quality Hold status; receipts post directly to available stock." Add a `hold` stock state — either a `quality_holds` table holding qty out of available, or a reserved-style soft-hold. `requireQAHoldBeforeShip:true` routes received qty to hold first; release requires `quality:approve` (new permission). The existing soft-hold primitive (`stock_reservations`) is the natural base.
- **FEFO pick [NEW + outbound enforcement].** `pickStrategy:"fefo"` plus `expiryAutoDisposition:"block_and_flag"` close the audit GAP "No lot/expiry enforcement on outbound." Allocation must pick earliest `expiration_date` first and block shipping expired lots (the audit notes `serial_registry` has no auto-expiry rule today).
- **`traceability` + `recall_search` [NEW].** Build on the immutable `stock_movements` ledger (the ledger is the strategic asset here) plus `receipt_line_lots`/`serial_registry`. Add a `trace_events` table or derive one-up/one-down trace from movement `reference_type`/`reference_id`; recall search = "given lot X, list every order/shipment that consumed it."
- **`compliance_exports` [NEW].** `complianceProfile:"fsma_204"` + GS1/GTIN awareness drives CSV/EDI sortable-source-list exports. Reuses the reports service (`reports.ts`) pattern.
- **`growers` [terminology + reuse].** No new table — `growers` is the `suppliers` table relabeled via terminology (`supplier→Grower`), matching how `charter` is "just a grouping layer" in the audit.
- **`catchWeightEnabled` [NEW].** Audit GAP: "No multi-UOM storage … single `unit_of_measure` string." Catch weight needs a per-unit captured-weight field at receive/ship (store on `receipt_lines` + a new outbound capture); the single-string UOM column can't represent variable weight, so this needs a real column addition.

---

### Cross-pack summary: what each pack needs from new platform work

| Capability | Charter Ed | General Dist | Ag/Food | Status today |
|---|:--:|:--:|:--:|---|
| Module registry (`enabled_modules` + nav/service gates) | uses (all-on) | **required** | **required** | **[NEW]** prereq #1 |
| Extended terminology (item/order/lot/supplier keys) | no | yes | yes | **[NEW]** prereq #2 — `terminology.ts` 4 keys only |
| Field-schema registry over `custom_fields` | optional (book fields) | optional | **required** (expiry/dates) | **[NEW]** prereq #3 |
| In-transit transfers | no | **required** | required | **[NEW]** — 0050 audit-only, no in-transit |
| Returns/RMA module | no | **required** | required | **[NEW]** — only `rma` enum value exists |
| Carrier shipping + outbox drain | no | **required** | (ship) | **[NEW]** — no carrier config; outbox unconsumed |
| UOM conversion on receipt | no | **required** | required (catch wt) | **[NEW wiring]** — 0014 table unused in 0069 |
| Lot-on-receipt / expiry enforcement | no | no | **required** | **[NEW RPC change]** to `post_receipt_v2` |
| Quality holds + outbound block | no | no | **required** | **[NEW]** — audit confirms no QA-hold state |
| FEFO/FIFO pick allocation | no | FIFO | **FEFO** | **[NEW]** — no pick-strategy logic |
| Traceability / recall / compliance | no | no | **required** | **[NEW]** — built on `stock_movements` ledger |

**Implementation order that respects the brief's "preset over existing engine" constraint:** (1) ship the module registry + extended terminology + field-schema registry (pure config layer, zero engine risk), (2) author the Charter Education pack and prove byte-for-byte parity with live L4L Fresno, (3) General Distribution unlocks transfers/returns/carrier, (4) Agriculture/Food last because it requires the deepest engine extensions (QA-hold state, outbound lot/expiry enforcement, FEFO). The immutable ledger, `stock_reservations` soft-holds, security-definer RPCs, and DB-enforced RLS are preserved untouched as the foundation every pack composes against.

**Assumption flags:** I did not re-read the live `organizations` row for L4L Fresno, so the Charter Ed pack assumes its terminology is still the unmodified `DEFAULT_TERMINOLOGY` (`Charter`/`Warehouse`) — verify before declaring parity. The mobile tab IDs (`home/items/books/receive/scan`) are taken from the current `_layout.tsx` description in the audit and the `inTabs` flags in `drawer-nav.ts` (Home, Items, Books, Receive POs, Scan); confirm against the file if exact `Tabs.Screen` names differ. `catchWeightEnabled` and FEFO are the only items requiring real schema columns (not just `custom_fields` jsonb) — everything else fits the existing jsonb + policy-resolver model.

Key files to touch: `packages/core/src/constants/terminology.ts`, new `packages/core/src/constants/modules.ts` + `packs/*.ts`, `apps/web/src/components/dashboard/nav.ts`, `apps/mobile/src/lib/drawer-nav.ts`, `apps/mobile/app/(drawer)/(tabs)/_layout.tsx`, `apps/web/src/server/services/context.ts`, `apps/web/src/lib/auth/api-context.ts`, `apps/web/src/server/services/receiving.ts` (RPC + outbox), and new migrations extending `post_receipt_v2` (after 0069), adding `quality_holds`, `return_orders`, `carrier_shipments`, `trace_events`, and `organization_packs`/`item_field_schemas`.

---

## Canonical Domain Model & Data Recommendations

### Design thesis

StockPilot already has the hard parts of a warehouse OS: an immutable ledger (`stock_movements`, `0002_inventory.sql`), atomic mutation RPCs (`adjust_stock`, `transfer_stock` in `0004_phase2_helpers.sql`), soft-hold reservations (`stock_reservations`, `0044_order_requests.sql`), per-location balances (`item_stock_levels`), security-definer receiving/counting (`post_receipt_v2`, `post_cycle_count`), and DB-enforced multi-tenant RLS. The mistake to avoid is forking this engine per industry. **Every vertical writes the same ledger.** Verticals differ only in (a) *which optional satellite tables* hang off `inventory_items` / `stock_movements`, (b) *which custom fields/statuses* are declared in a per-org manifest, and (c) *which nav/modules* are turned on. None of those require a new ledger or a schema fork.

The model below splits into **CORE** (present in every org, already mostly built) and **OPTIONAL EXTENSIONS** (additive tables + typed `custom_fields`, activated by manifest, never breaking existing rows).

---

### Part 1 — Core domain objects (industry-neutral, every org)

These exist today and must stay generic. The only changes are *renaming via terminology config* and *generalizing two enums* (see Part 3).

| Core object | Table(s) today | Industry-neutral because… | Required change |
|---|---|---|---|
| **Item** | `inventory_items` (`0002`) | Single table for all `item_type`; `custom_fields jsonb` (`0002:102`) absorbs vertical attributes with no schema change | Generalize `item_type` + `tracking_type` enums (Part 3) |
| **Stock position** | `inventory_items.quantity_on_hand` (`0002:95`) + `item_stock_levels` (per-location) | Aggregate + per-location detail is universal | Add derived `available` view (Part 5) |
| **Movement (ledger)** | `stock_movements` (`0002:193`), append-only | Quantity deltas with `reference_type`/`reference_id` are universal | Make `movement_type` data-driven (Part 3) |
| **Reservation** | `stock_reservations` (`0044`) | Soft-hold pattern is industry-neutral | Generalize `reference_type` beyond orders (Part 5) |
| **Warehouse / Location** | `warehouses`, `locations` (`0007`); `locations` is self-joining hierarchy | Site → zone → bin works for retail backroom, 3PL, ag (field/cooler) | Add `location.kind` taxonomy (Part 2.3) |
| **Order (outbound)** | `order_requests` + `order_request_lines` (`0044`), 14-state machine (`0109`) | Demand → fulfillment is universal | `delivery_charter_id` becomes optional generic destination |
| **Purchase Order (inbound demand)** | `purchase_orders` + `purchase_order_items` (`0002`) | Supplier → goods is universal | None for core |
| **Receipt (inbound execution)** | `receipts` + `receipt_lines` (`0012`), `post_receipt_v2` | Idempotent partial receiving is universal | QA-hold extension (Part 2.6) |
| **Count** | `cycle_counts` + `cycle_count_lines` (`0023`), `scope` enum (`0141`) | Variance reconciliation is universal | Location-scoped counts (gap, Part 5) |
| **Supplier** | `suppliers`, `vendor_item_mappings` (`0002`) | Universal | None |
| **Category / Tag** | `categories` (`supports_sizes`), `tags` (`0002`) | Universal taxonomy | None |
| **Transfer / Shipment** | `transfer_stock` RPC (intra-WH); `shipments`+`shipment_lines` (`0050`, statuses `draft/shipped/delivered/cancelled`) | Cross-site movement is universal | Add in-transit ledger state (Part 6) |
| **Audit / Outbox** | `audit_logs`, `activity_logs`, `outbox_events` (`0016`) | Universal | None |

**Industry-neutrality rule:** a column belongs in core **only if** every vertical populates it. Anything a vertical *might* leave null (lot, serial, grower, catch-weight, expiry, license-plate) belongs in an optional extension or `custom_fields`, never in the core item row. This keeps charter-school rows untouched when a food distributor turns on FEFO.

---

### Part 2 — Optional vertical extensions (additive, not forks)

All of the following are **new tables that reference existing PKs** (`inventory_items.id`, `stock_movements.id`, `warehouses.id`) or **typed `custom_fields` keys**. None alter existing rows; each is gated by the org manifest (Part 4). They extend the same ledger — extensions *describe* stock, the ledger *moves* it.

#### 2.1 Lots / batches (food, ag, pharma, cosmetics)

Today lots exist **only at receive time** (`receipt_line_lots`, `0015`) — a known gap: no outbound lot tracking, no FEFO, no expiry enforcement. Promote lots to a first-class stock dimension via a parallel ledger keyed by `stock_movements`.

```sql
-- New: a stock lot is a tracked sub-population of an item's on-hand qty.
create table public.stock_lots (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  item_id           uuid not null references public.inventory_items(id) on delete cascade,
  lot_number        text not null,
  warehouse_id      uuid not null references public.warehouses(id),
  location_id       uuid references public.locations(id),
  qty_on_hand       numeric(18,4) not null default 0,   -- denormalized, like inventory_items
  manufacture_date  date,
  expiration_date   date,                                -- drives FEFO + recall
  best_by_date      date,
  status            text not null default 'available'    -- available|hold|quarantine|expired|consumed|recalled
                      check (status in ('available','hold','quarantine','expired','consumed','recalled')),
  attributes        jsonb not null default '{}',         -- COA #, grade, pack date, supplier lot
  source_receipt_line_id uuid references public.receipt_lines(id),
  created_at        timestamptz not null default now(),
  unique (organization_id, item_id, lot_number, warehouse_id)
);

-- New: ties each ledger event to the lot it touched (a movement may split across lots).
create table public.stock_movement_lots (
  movement_id  uuid not null references public.stock_movements(id) on delete cascade,
  lot_id       uuid not null references public.stock_lots(id) on delete restrict,
  qty_change   numeric(18,4) not null,
  primary key (movement_id, lot_id)
);
```

`stock_lots.qty_on_hand` mirrors the `inventory_items.quantity_on_hand` denormalization pattern (recomputed from `stock_movement_lots`). `adjust_stock` gains an optional `p_lot_id`; when null, lots are ignored entirely (charter rows never see this table). FEFO picking = `order by expiration_date asc nulls last` over `stock_lots` where `status='available'`. **Expiry enforcement** (an existing gap) becomes a nightly job + trigger: `if expiration_date < current_date then status := 'expired'`, and a new movement_type `expire` writes the ledger.

#### 2.2 Serials / units (assets, electronics, high-value)

`serial_registry` already exists (`0015`) keyed to receipt lines with `current_status (available|damaged|rejected|sold|rma)`. The only structural change: decouple it from "received via receipt" so serials can also be created by adjustment/initial load, and link movements to serials for full chain-of-custody.

```sql
alter table public.serial_registry
  add column if not exists current_location_id uuid references public.locations(id),
  add column if not exists lot_id uuid references public.stock_lots(id),   -- serial within a lot
  add column if not exists attributes jsonb not null default '{}';         -- warranty_until, firmware, asset_tag

create table public.stock_movement_serials (
  movement_id uuid not null references public.stock_movements(id) on delete cascade,
  serial_id   uuid not null references public.serial_registry(id) on delete restrict,
  direction   text not null check (direction in ('in','out')),
  primary key (movement_id, serial_id)
);
```

This closes the "no audit of serial state transitions" gap and supports asset lifecycle (`item_type='asset'` + `attributes.depreciation_*`).

#### 2.3 License plates / handling units (3PL, distribution, ag pallets)

A handling unit (SSCC pallet, tote, cart, bin LP) is a **container of stock that moves as one**. This is the missing putaway/cross-dock primitive. Model it as a special node, reusing the existing self-joining `locations` hierarchy where helpful, but as its own table because LPs are mobile and nestable.

```sql
create table public.handling_units (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lp_code         text not null,                  -- SSCC-18 or internal
  kind            text not null default 'pallet'  -- pallet|tote|case|cart|bin
                    check (kind in ('pallet','tote','case','cart','bin')),
  parent_hu_id    uuid references public.handling_units(id), -- nested LPs
  warehouse_id    uuid not null references public.warehouses(id),
  location_id     uuid references public.locations(id),
  status          text not null default 'open'    -- open|sealed|staged|shipped|consumed
                    check (status in ('open','sealed','staged','shipped','consumed')),
  attributes      jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  unique (organization_id, lp_code)
);

-- What stock (item + optional lot/serial) currently sits on an HU.
create table public.handling_unit_contents (
  id             uuid primary key default gen_random_uuid(),
  hu_id          uuid not null references public.handling_units(id) on delete cascade,
  item_id        uuid not null references public.inventory_items(id),
  lot_id         uuid references public.stock_lots(id),
  serial_id      uuid references public.serial_registry(id),
  qty            numeric(18,4) not null,
  unique (hu_id, item_id, lot_id, serial_id)
);
```

A "move pallet" operation writes **one** ledger row per item with `reference_type='handling_unit'`, `reference_id=hu_id`, plus updates `handling_units.location_id`. This is also the natural carrier for the in-transit state (Part 6).

#### 2.4 Expiry + FEFO + catch weight (food / ag)

- **Expiry + FEFO**: lives entirely on `stock_lots.expiration_date` (2.1). No item-row change. FEFO is an allocation *policy* declared in the manifest (`fulfillment.allocation: "fefo" | "fifo" | "lifo" | "manual"`), consumed by the picking RPC.
- **Catch weight** (variable-weight items: meat, produce, cheese where each unit's weight differs): add typed `custom_fields` flags plus a per-event captured weight, because the ledger tracks *count* while billing tracks *weight*.

```jsonc
// inventory_items.custom_fields for a catch-weight item:
{ "catch_weight": true, "nominal_weight": 5.0, "weight_uom": "kg" }
```
```sql
-- captured actual weight on the movement (null for non-catch-weight items)
alter table public.stock_movements
  add column if not exists captured_weight numeric(14,4),
  add column if not exists captured_weight_uom text;
```

#### 2.5 Growers / field-blocks / harvest+pack (agriculture/food traceability)

These are **lot attributes**, not new core objects — they describe *where a lot came from*. Two thin reference tables + lot attributes, so non-ag orgs never see them.

```sql
create table public.growers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, gln text, attributes jsonb not null default '{}'
);
create table public.field_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  grower_id uuid references public.growers(id),
  name text not null, attributes jsonb not null default '{}'  -- variety, acreage, geo
);
alter table public.stock_lots
  add column if not exists grower_id uuid references public.growers(id),
  add column if not exists field_block_id uuid references public.field_blocks(id),
  add column if not exists harvest_date date,
  add column if not exists pack_date date;
```

#### 2.6 Quality holds / quarantine (the audited "no QC gate" gap)

Today receipts post straight to available stock; rejected qty is *dropped*, not tracked. Add a **stock state** dimension rather than a separate warehouse, so held stock stays in place but is unavailable.

Two complementary mechanisms:
1. **Lot/HU level**: `stock_lots.status` and `handling_units.status` already include `hold`/`quarantine` (2.1/2.3).
2. **Non-lot items**: a hold record + reservation against on-hand.

```sql
create table public.stock_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id),
  lot_id uuid references public.stock_lots(id),
  warehouse_id uuid not null references public.warehouses(id),
  qty numeric(18,4) not null,
  reason text not null,                  -- inspection|damage|recall|customer_complaint|qc_fail
  status text not null default 'open' check (status in ('open','released','dispositioned')),
  disposition text,                      -- accept|reject|rework|destroy|return_to_vendor
  created_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz, resolved_by uuid references public.user_profiles(id)
);
```

A held quantity is netted out of *available* (Part 5). `post_receipt_v2` gets an optional `p_qc_required` flag (driven by manifest/category): when set, accepted qty lands as a `stock_hold` rather than free stock.

#### 2.7 Traceability events + recall search (GS1/EPCIS-style)

The audit gap is "no time-series stock position" and "no recall search." The `stock_movements` ledger is *already* an event store; add an EPCIS-style projection table for fast forward/backward trace and recall, populated from the outbox.

```sql
create table public.trace_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_time timestamptz not null default now(),
  biz_step text not null,        -- commissioning|receiving|storing|picking|shipping|consuming (EPCIS bizStep)
  disposition text,              -- active|in_transit|recalled|destroyed
  item_id uuid references public.inventory_items(id),
  lot_id uuid references public.stock_lots(id),
  serial_id uuid references public.serial_registry(id),
  hu_id uuid references public.handling_units(id),
  from_location_id uuid references public.locations(id),
  to_location_id uuid references public.locations(id),
  movement_id uuid references public.stock_movements(id),   -- link back to ledger
  reference_type text, reference_id uuid,
  payload jsonb not null default '{}'
);
create index trace_events_lot_idx on public.trace_events(organization_id, lot_id, event_time);
```

**Recall search** = "give me every order/shipment that touched lot X": join `trace_events` (or `stock_movement_lots` → `stock_movements.reference_type/reference_id`) on `lot_id`, walk forward through `biz_step='shipping'` to `order_requests`/`shipments`. This is a query, not a fork. Emit `trace_events` from the existing `outbox_events` (`0016`) — wire the existing `receipt.posted` topic plus new `stock.moved` / `shipment.delivered` topics into a drainer that writes both `trace_events` and external webhooks (closes the "no active outbox draining" gap).

#### Extension summary

| Extension | New tables | Hangs off | Vertical(s) | Existing rows affected |
|---|---|---|---|---|
| Lots/batches | `stock_lots`, `stock_movement_lots` | `inventory_items`, `stock_movements`, `receipt_lines` | food, ag, pharma | none (FKs only) |
| Serials | `stock_movement_serials` + cols on `serial_registry` | `serial_registry`, `stock_movements` | assets, electronics | none |
| Handling units | `handling_units`, `handling_unit_contents` | `warehouses`, `locations`, `inventory_items` | 3PL, distribution | none |
| Catch weight | cols on `stock_movements` + `custom_fields` | `stock_movements`, `inventory_items` | food | columns nullable |
| Growers/fields | `growers`, `field_blocks` + cols on `stock_lots` | `stock_lots` | ag/food | none |
| Quality holds | `stock_holds` | `inventory_items`, `stock_lots` | food, pharma, mfg | none |
| Traceability | `trace_events` | everything via FKs | regulated verticals | none |

---

### Part 3 — Generalizing `item_type`, `tracking_type`, and `movement_type`

#### `item_type` (currently `product|book|asset|consumable`, hard CHECK in `0020`)

Keep `item_type` as a **small, app-meaningful classifier** (it drives `inventory_value`, low-stock rollups, and the books/items UI split). Do **not** explode it per industry. Instead:

- Keep a stable base set: `product | book | asset | consumable | ingredient | finished_good | raw_material | kit`.
- Replace the hard CHECK with a per-org **item-type registry** so verticals can add a type without a migration:

```sql
create table public.item_type_defs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,            -- 'produce', 'spare_part'
  label text not null,          -- terminology, e.g. 'Produce'
  is_builtin boolean not null default false,
  primary key (organization_id, key)
);
-- Drop the CHECK on inventory_items.item_type; validate against item_type_defs
-- in the service layer + an optional FK-style trigger.
```

The existing `(organization_id, item_type)` index (`0020`) stays valid. Charter orgs are auto-seeded `product`/`book`; a food org seeds `ingredient`/`finished_good`.

#### `tracking_type` (currently `none|lot|serial`, CHECK in `0015`)

Generalize to a small set and allow combination:

- `none | lot | serial | lot_serial` (serial-within-lot, common in pharma/electronics).
- Add an orthogonal flag rather than overloading: keep `tracking_type` for *identity* tracking and let `custom_fields.catch_weight` / `stock_lots.expiration_date` handle *attributes*. Don't create `tracking_type='expiry'` — expiry is a lot attribute, not an identity scheme.

#### `movement_type` (currently 10 hard-coded values, CHECK in `0002:197`)

This is the audited "no configurable movement types" gap. Make it data-driven while preserving the immutable semantics:

```sql
create table public.movement_type_defs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,            -- builtin: add/remove/adjust/transfer/receive_po/return/damage/loss/correction/initial
  label text not null,          -- terminology override per vertical
  sign smallint not null,       -- +1 increases, -1 decreases, 0 neutral (transfer)
  affects_available boolean not null default true,
  is_builtin boolean not null default false,
  primary key (organization_id, key)
);
-- Drop the inline CHECK on stock_movements.movement_type;
-- adjust_stock validates p_movement_type against movement_type_defs for the org.
```

Seed all 10 builtins for every org. New verticals add `expire`, `harvest`, `repack`, `quality_reject`, `consume_for_kit` without a migration. `adjust_stock` (`0004_phase2_helpers.sql`) signature is unchanged — it already takes `p_movement_type text`; only its validation source moves from a hard CHECK to the registry lookup. This is a **low-risk change**: the function is `security invoker` and already row-locks.

---

### Part 4 — Custom fields & custom statuses per-org (no per-customer migrations)

The audited reality: `custom_fields jsonb` exists on `inventory_items` (`0002:102`) but is "not exposed as a configurable schema" — book fields (`isbn`, `author`, `book_rack_number`) are hard-coded in app logic. Fix this with a **declarative manifest** stored in `organizations`, not in code.

#### Custom field definitions

```sql
create table public.custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null,            -- 'item' | 'lot' | 'order' | 'supplier' | 'location'
  applies_to_item_type text,       -- null = all; else scope to one item_type
  key text not null,               -- stored at custom_fields->>key
  label text not null,
  data_type text not null check (data_type in ('text','number','date','bool','enum','reference')),
  enum_values text[],              -- for data_type='enum'
  required boolean not null default false,
  searchable boolean not null default false,  -- promote to GIN/expression index
  position int not null default 0,
  unique (organization_id, entity, key)
);
```

- Storage stays in the existing `custom_fields jsonb` (no per-customer column adds — the whole point). Validation/labels/forms are generated from `custom_field_defs`.
- `book` fields become **seeded** custom-field defs for charter orgs (`isbn`, `author`, `rack`), de-hard-coding the books logic from `lib/books/lookup.ts` and `inventory.ts` rack branching.
- For `searchable: true` fields, generate an expression index, mirroring the existing pattern (`audit_logs((metadata->>'entity_id'))` in `0135`): `create index ... on inventory_items ((custom_fields->>'lot_code')) where ...`. These are the *only* migrations, and they're generic infra, not per-customer.

#### Custom statuses + workflows

The audited gap: order/PO statuses are hard-coded enums + a Postgres state-machine trigger (`0109`) mirroring `order-state-machine.ts`. Make statuses data-driven per-org while keeping a *DB-enforced* state machine:

```sql
create table public.workflow_defs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null,            -- 'order_request' | 'purchase_order' | 'shipment' | 'cycle_count'
  statuses jsonb not null,         -- [{key, label, category:'open|in_progress|done|cancelled', terminal:bool}]
  transitions jsonb not null,      -- {from_key: [to_key, ...]}
  unique (organization_id, entity)
);
```

- The existing trigger that validates transitions reads `workflow_defs.transitions` instead of a baked dict. Every org seeds the canonical 14-state order machine; a retail-backroom org can collapse it to `requested → picked → done`. The `status` columns stay `text` (they already are), so **no column migration** when statuses change.
- Keep the *engine-critical* transitions hard-guarded in the RPC (e.g., a status cannot release a reservation unless its `category='done'`) so a misconfigured manifest can't corrupt the ledger.

#### The org manifest (single source of truth)

Rather than scatter config, add one JSONB manifest on `organizations` (alongside `terminology`, `mfa_policy`, `po_terms` from `0007`/`0009`/`0052`). This is the packaging layer:

```jsonc
// organizations.config (new jsonb column)
{
  "vertical": "food_distribution",          // selects a seed pack
  "modules": { "rentals": false, "books": false, "bundles": true,
               "lots": true, "handling_units": true, "quality_holds": true,
               "traceability": true },       // closes "no module-activation" gap
  "fulfillment": { "allocation": "fefo", "qc_on_receipt": true },
  "terminology": { "item_singular": "Product", "lot_singular": "Lot",
                   "warehouse_singular": "DC", "charter_singular": "Customer" }
}
```

- Extend the audited `OrgTerminology` interface (`packages/core/src/constants/terminology.ts`, today only `charter_*`/`warehouse_*`) to cover `item`, `location`, `lot`, `serial`, `order`, `movement` labels. `resolveTerminology()` already does the merge — just widen the type and `DEFAULT_TERMINOLOGY`.
- `modules` is consumed by `navForRole()` (`apps/web/src/components/dashboard/nav.ts`) and mobile `DRAWER_SECTIONS` (`drawer-nav.ts`) as a second filter after permissions — closing the audited "all features always on" gap with no nav fork.
- A **vertical seed pack** is just a function that inserts the right `item_type_defs`, `movement_type_defs`, `custom_field_defs`, `workflow_defs`, and `config` defaults at org creation. Industries are *data*, not code branches.

---

### Part 5 — Available-to-promise & reservation generalization

Two gaps converge here: "no available vs reserved split in the item row" and "reservations are orders-only."

1. **Available view** (no column change to the ledger):
```sql
create or replace view public.item_availability as
select i.id as item_id, i.organization_id, i.quantity_on_hand,
  coalesce((select sum(r.quantity) from stock_reservations r
            where r.item_id = i.id and r.released_at is null), 0) as reserved,
  coalesce((select sum(h.qty) from stock_holds h
            where h.item_id = i.id and h.status = 'open'), 0) as on_hold,
  i.quantity_on_hand
    - coalesce(...) reserved
    - coalesce(...) on_hold as available
from inventory_items i;
```

2. **Generalize `stock_reservations`** (currently FK'd only to `order_request_id`, `0044`): add a polymorphic reference and a who-released-it answer (audited gap "no audit of who released a reservation"):
```sql
alter table public.stock_reservations
  add column if not exists reference_type text default 'order_request', -- order_request|rental|shipment|warranty|transfer
  add column if not exists reference_id uuid,
  add column if not exists lot_id uuid references public.stock_lots(id),
  add column if not exists released_by uuid references public.user_profiles(id);
```
This makes the soft-hold reusable for rentals, in-transit transfers, and warranty ear-marking (all audited gaps) without a new table.

---

### Part 6 — Cross-warehouse transfers with in-transit state + returns

#### In-transit transfers (the audited "no package in motion" gap)

Today `transfer_stock` (`0004`) is intra-warehouse and instant; cross-warehouse uses `shipments` (`0050`, statuses `draft/shipped/delivered/cancelled`) which is *audit-only* — stock isn't actually held in a transit limbo. Introduce an explicit **in-transit balance** so a unit is neither fully at source nor destination during transit, without inventing a fake warehouse.

Recommended approach — **system "in_transit" location per warehouse + two-phase ledger**, reusing existing primitives:

1. Add `locations.kind` (`shelf|bin|dock|staging|in_transit|virtual`) and auto-create one `kind='in_transit'` location per warehouse.
2. Promote `shipments` to write the ledger in two phases:
   - **Ship**: `adjust_stock(item, -qty, 'transfer', from_loc)` + `adjust_stock(item, +qty, 'transfer', in_transit_loc)`; create a `stock_reservation` with `reference_type='shipment'` so the in-transit qty can't be double-allocated.
   - **Receive at destination**: `adjust_stock(item, -qty, 'transfer', in_transit_loc)` + `adjust_stock(item, +qty, 'receive_transfer', dest_loc)`; release the reservation with `released_by`.
3. Net `quantity_on_hand` is conserved across phases (the in-transit loc is part of the org's on-hand but is a non-available location). `item_availability` excludes `kind='in_transit'`.

Schema changes are minimal:
```sql
alter table public.locations add column if not exists kind text not null default 'bin'
  check (kind in ('shelf','bin','dock','staging','in_transit','virtual'));
alter table public.shipments add column if not exists in_transit_at timestamptz,
  add column if not exists received_at timestamptz,
  add column if not exists carrier text, add column if not exists tracking_number text;
alter table public.shipment_lines add column if not exists qty_received numeric(18,4);
```
New RPCs `ship_shipment(shipment_id)` and `receive_shipment(shipment_id, lines)` mirror the `post_receipt_v2` idempotency pattern (idempotency key + SHA256 hash) so mobile sync retries are safe. Handling units (2.3) become the unit of transit when present (`reference_type='handling_unit'`).

#### Returns / RMA (the audited "no RMA workflow" gap)

Returns are **inbound orders against a prior outbound** — model them as a typed order, not a fork, reusing `order_requests` + the ledger:

```sql
create table public.return_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  rma_number text not null,
  direction text not null check (direction in ('customer_return','return_to_vendor')),
  source_order_id uuid references public.order_requests(id),     -- customer return
  source_po_id uuid references public.purchase_orders(id),       -- return-to-vendor
  supplier_id uuid references public.suppliers(id),
  status text not null default 'requested',  -- driven by workflow_defs (Part 4)
  warehouse_id uuid not null references public.warehouses(id),
  created_at timestamptz not null default now(),
  unique (organization_id, rma_number)
);
create table public.return_lines (
  id uuid primary key default gen_random_uuid(),
  rma_id uuid not null references public.return_authorizations(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id),
  lot_id uuid references public.stock_lots(id),
  serial_id uuid references public.serial_registry(id),
  qty numeric(18,4) not null,
  disposition text not null check (disposition in ('restock','quarantine','scrap','return_to_vendor')),
  reason_code text
);
```

Receiving a customer return = `adjust_stock(item, +qty, 'return', loc)` (the `return` movement_type already exists) — landing into free stock (`restock`) or into `stock_holds` (`quarantine`/`scrap`) per line disposition. Return-to-vendor decrements stock with a new `movement_type='return_to_vendor'` (added via `movement_type_defs`, no migration) and links to a `serial_registry.current_status='rma'`. This reuses the immutable ledger, the hold table (2.6), and the workflow engine (Part 4).

---

### Part 7 — What changes vs. what stays (implementation ledger)

| Change | Type | Risk | Closes audited gap |
|---|---|---|---|
| `item_type_defs`, `movement_type_defs`, drop inline CHECKs | additive table + constraint loosening | low (validation moves to RPC/service) | configurable types/movements |
| `custom_field_defs`, `workflow_defs` + `organizations.config` jsonb | additive | low | custom fields/statuses, module activation |
| Widen `OrgTerminology` + `DEFAULT_TERMINOLOGY` | type widening, `resolveTerminology()` unchanged | low | terminology beyond charter/warehouse |
| `stock_lots`, `stock_movement_lots`, `stock_holds`, `trace_events` | additive satellite tables | low (FK-only, gated) | outbound lot/expiry/FEFO, QC hold, recall, time-travel |
| `handling_units` + contents | additive | low | license-plate/SSCC/putaway |
| `growers`, `field_blocks` + `stock_lots` cols | additive | low | ag traceability |
| `serial_registry` cols + `stock_movement_serials` | additive | low | serial chain-of-custody |
| `stock_reservations` polymorphic ref + `released_by` | column adds (defaulted) | low | reservation reuse, release audit |
| `item_availability` view + `stock_movements.captured_weight` | additive view + nullable cols | low | available/reserved split, catch weight |
| `locations.kind` + 2-phase `shipments` RPCs | column add + new RPCs | medium (touches ledger paths) | in-transit transfers |
| `return_authorizations`, `return_lines` | additive | low | RMA/returns |
| **`stock_movements` core shape** | **unchanged** | — | preserves immutable ledger |
| **`adjust_stock` / `transfer_stock` / `post_receipt_v2` / `post_cycle_count` signatures** | **unchanged (optional params only)** | — | preserves serialized critical writes |
| **RLS helpers `is_org_member`/`has_org_role` + per-table policies** | **unchanged; new tables follow same pattern** | — | preserves DB-enforced tenancy |

**Stated assumptions (not confirmed in audit):**
- `organizations` does not yet have a generic `config jsonb` column — I propose adding one; the audit confirms `terminology`, `mfa_policy`, `po_terms`, `public_request_*` but not a general manifest.
- `shipments` currently does **not** write `stock_movements` (audit says "audit-only concept"); the 2-phase ledger in Part 6 is net-new behavior, not a refactor of existing writes.
- The order/PO state-machine trigger (`0109`) is assumed to read a hard-coded transition dict; making it read `workflow_defs` requires editing that trigger — verify its exact body before implementing.
- `outbox_events` (`0016`) has no live drainer per the audit; `trace_events` population and external webhooks both depend on building that worker (out of scope for the data model, but the schema above is drainer-ready).

The throughline: **one ledger, one reservation model, one RLS pattern, one set of mutation RPCs** — verticals are expressed as *seeded manifest rows + opt-in satellite tables*, never as forks.

---

## Implementation Roadmap, Success Metrics & Acceptance Criteria

This roadmap turns StockPilot from a charter-school warehouse app into a **configurable warehouse operating system** without forking per industry. The strategy is a thin **configuration + packaging layer** (entitlements → module registry → declarative nav manifest → vertical packs) layered on the *existing* engine. The immutable ledger (`stock_movements`), soft-hold reservations (`stock_reservations`), the service-context layer (`withContext`/`withApiContext`), and DB-enforced RLS (`is_org_member`/`has_org_role`, migration `0140`) are preserved untouched as load-bearing strengths.

Grounding facts confirmed by reading the tree:
- **No entitlement/module-registry/feature-flag infrastructure exists today** (grep across `supabase/migrations`, `packages/core`, `apps/web/src/server`, `apps/web/src/lib` returned nothing). All 60 services are "always on"; the only gates are `navForRole(role)` and `assertPermission(role, permission)`.
- Next migration number is **`0144`** (current head: `0143_security_hardening_2026_05_28.sql`).
- `ServiceContext` (`apps/web/src/server/services/context.ts:11`) carries `{organizationId, role, mfaRequired, mfaSatisfied}` and is built by cached `withContext`. `assertPermission(role, permission)` (`packages/core/src/constants/permissions.ts:131`) is the single permission gate.
- Web nav is two static arrays `BASE_NAV` + `ADMIN_NAV` filtered by `navForRole(role)` (`apps/web/src/components/dashboard/nav.ts`). Mobile mirrors it via `DRAWER_SECTIONS` + the 5 fixed bottom tabs (`drawer-nav.ts`, `(tabs)/_layout.tsx`) — **two hand-maintained copies that already drift** (mobile has a TOOLS section + "Receive POs" tab the web lacks).
- `PLANS` (`packages/core/src/constants/plans.ts`) is a hard-coded 4-tier record; the comment at line 32 confirms the SaaS gating is intentionally inert post-pivot. The `customRoles`/`apiAccess` booleans are aspirational ("the architecture is there if SaaS comes back").
- Mobile snapshot is hard-coded to `{warehouses, items, openPOs, openCycleCounts, bundles}` (`apps/mobile/src/lib/sync.ts:20`, served by `apps/web/src/app/api/v1/mobile/snapshot/route.ts`).

The reference org for "zero regression" acceptance is **L4L Fresno** (the live charter warehouse currently in production).

---

### Cross-Cutting Architecture: the four config primitives

Everything below is built on four new declarative primitives. Defining them up front keeps phases additive.

| Primitive | Where it lives | Shape | Replaces / extends |
|---|---|---|---|
| **Module registry** | `packages/core/src/modules/registry.ts` (static manifest) + `org_module_settings` table | `ModuleManifest[]` declaring id, label key, permissions, nav contributions, snapshot contributions, dependencies | Replaces implicit "always on" assumption |
| **Entitlements** | `organization_entitlements` table + `ctx.entitlements` on `ServiceContext` | Per-org `{ enabled_modules: text[], limits jsonb, flags jsonb }` | Extends inert `PLANS` with per-org overrides |
| **Nav manifest** | `packages/core/src/modules/nav-manifest.ts` (derived from registry) | Single source consumed by *both* web `navForRole` and mobile `DRAWER_SECTIONS` | Collapses the two drifting arrays into one |
| **Terminology v2** | `organizations.terminology` jsonb (extend `resolveTerminology`) | Open key→label map (not the 4 fixed keys) | Extends `packages/core/src/constants/terminology.ts` |

The canonical entitlement gate becomes a small addition to the existing context, *not* a rewrite:

```ts
// packages/core/src/modules/types.ts
export interface ModuleManifest {
  id: ModuleId;                 // 'inventory' | 'orders' | 'rentals' | 'bundles' | 'cycle_counts' | ...
  labelKey: string;             // terminology key, e.g. 'module.rentals'
  permissions: Permission[];    // perms this module owns (existing perms reused)
  dependsOn?: ModuleId[];       // 'receiving' dependsOn 'purchase_orders'
  core?: boolean;               // inventory/movements are non-disableable
  nav: NavContribution[];       // web + mobile + tab placement, declarative
  snapshot?: SnapshotKey[];     // which mobile-snapshot slices this module adds
}

// apps/web/src/server/services/context.ts  (additive)
export interface ServiceContext {
  // ...existing fields unchanged...
  entitlements: { enabledModules: Set<ModuleId>; limits: Record<string, number>; flags: Record<string, boolean> };
}
export function assertModule(ctx: ServiceContext, moduleId: ModuleId): void {
  if (!ctx.entitlements.enabledModules.has(moduleId))
    throw new ServiceError('module_disabled', `The ${moduleId} module is not enabled for this organization.`);
}
```

`assertModule` is a *new* `ServiceError` code (add `'module_disabled'` to the union at `context.ts:89` → maps to HTTP 403). The existing `assertPermission` stays; modules gate *availability*, permissions gate *capability within an available module*.

---

### Phase 1 — Foundation: entitlements + module registry + nav manifest + grandfather

**Goal:** Introduce the config substrate with **zero behavior change** for existing orgs. An owner can toggle a module off and it disappears from all four surfaces (web sidebar, mobile drawer, mobile tabs, and the API/snapshot) without a code change. Nothing about L4L Fresno's experience changes because they are grandfathered into "everything enabled."

#### Workstreams

1. **DB: entitlements + module settings (migration `0144`, `0145`).**
   - `0144_module_registry.sql`: `organization_entitlements (organization_id pk fk, enabled_modules text[] not null default '{}', limits jsonb not null default '{}', flags jsonb not null default '{}', updated_at, updated_by)`. RLS: `is_org_member` to read, `has_org_role(org,'admin')` to write. Add `org_module_settings (organization_id, module_id, enabled bool, config jsonb, primary key (organization_id, module_id))` only if per-module config detail is needed beyond the array — start with the array on `organization_entitlements` to keep it simple.
   - `0145_grandfather_entitlements.sql`: backfill `enabled_modules` = **all current module ids** for every existing org (`insert ... select id, ARRAY[...all module ids...] from organizations on conflict do nothing`). This is the grandfather guarantee.
   - Add `'module_disabled'` nowhere in SQL (app-layer only); but **do not** add RLS that hard-blocks disabled modules in Phase 1 — keep enforcement at the service layer first to avoid surprising RLS failures during rollout (RLS module-gating is a Phase 2 hardening step).

2. **core: module registry + nav manifest.**
   - New `packages/core/src/modules/registry.ts` enumerating the real modules already audited: `inventory` (core), `movements` (core), `books`, `categories`, `tags`, `rentals`, `bundles`, `orders`, `cycle_counts`, `procedures`, `purchase_orders`, `receiving`, `po_imports`, `locations`, `suppliers`, `reports`, `schedule`, `ai`, `notifications`. Each maps to its existing nav `href` and `requires` permission from `nav.ts`/`drawer-nav.ts`.
   - New `packages/core/src/modules/nav-manifest.ts`: **single** declarative nav source. `navForRole(role, entitlements)` and the mobile drawer both derive from it. `inventory` + `movements` are `core: true` (cannot be disabled).

3. **web: thread entitlements through context + nav.**
   - `context.ts`/`api-context.ts`: load `organization_entitlements` inside `withContext`/`withApiContext` (one extra query, cached per request alongside the existing plan lookup at `context.ts:210`). Populate `ctx.entitlements`.
   - `nav.ts`: change `navForRole(role)` → `navForRole(role, entitlements)`, filtering items whose owning module is not in `enabledModules` (in addition to existing `requires`/`requiresAdmin` checks at `nav.ts:140`). Build `BASE_NAV`/`ADMIN_NAV` from the manifest so they stop being hand-edited.

4. **mobile: consume manifest + entitlements from snapshot.**
   - Extend the snapshot response (`apps/web/src/app/api/v1/mobile/snapshot/route.ts` + `SnapshotResponse` at `sync.ts:20`) with `enabledModules: ModuleId[]`.
   - `drawer-content.tsx` filters `DRAWER_SECTIONS` by `enabledModules`; `(tabs)/_layout.tsx` hides tabs whose module is disabled (the file already supports `href: null` to hide a tab — reuse that mechanism).

5. **Owner control surface (read-only stub).** A new settings page `apps/web/src/app/(dashboard)/dashboard/settings/modules/page.tsx` listing modules with on/off — wired but **read-only in Phase 1** (toggle write lands in Phase 2 control plane). Gated by a new permission `modules:manage` (owner/admin) added to `PERMISSIONS` at `permissions.ts:3`.

#### Dependencies & sequencing
`0144`/`0145` → core registry/manifest → web context+nav → mobile snapshot+drawer. Web and mobile #3/#4 can proceed in parallel once core #2 lands.

#### Definition of Done
- Migrations applied; every existing org has all modules in `enabled_modules`.
- `navForRole` and mobile drawer both read from the single `nav-manifest.ts` (the two arrays are deleted/derived).
- Flipping `enabled_modules` for a *test* org (manually in DB) hides the module from web sidebar, mobile drawer, mobile tabs, and removes its API-route access (`assertModule` returns 403) and its snapshot slice — verified end-to-end.
- L4L Fresno: nav, tabs, snapshot, and every workflow are byte-identical to pre-change (visual + API diff).

#### Success metrics / acceptance criteria

| Criterion | Target |
|---|---|
| Grandfather correctness | 100% of existing orgs retain full module set; **zero** new "module_disabled" errors in logs for grandfathered orgs over 14 days |
| Single-source nav | `nav.ts` BASE_NAV/ADMIN_NAV and `drawer-nav.ts` DRAWER_SECTIONS contain **no hand-authored item lists** — both derive from `nav-manifest.ts` (enforced by a unit test asserting parity) |
| 4-surface disable | Disabling `rentals` for a test org removes it from web sidebar **and** mobile drawer **and** mobile tabs **and** returns 403 from `/api/v1/...rentals...` — **no code deploy** |
| L4L Fresno regression | Playwright smoke (`everything-claude-code:e2e`) over Fresno's core flows (receive PO, cycle count, order approve, stock adjust) passes with **0 diffs** vs. baseline |
| Perf budget | Added entitlement lookup adds **< 5ms p95** to `withContext` (it rides the same cached request as the existing plan query at `context.ts:210`) |

---

### Phase 2 — Modularization: owner control plane + custom fields / statuses / templates

**Goal:** Make the substrate from Phase 1 *editable by owners*, and remove the three biggest hard-coded assumptions blocking verticals: fixed custom-field shapes, fixed status enums, fixed document templates. This is where "configurable" becomes real.

#### Workstreams

1. **Owner control plane (writable).**
   - `settings/modules/page.tsx` becomes writable; server action `updateOrgModulesAction` in `apps/web/src/server/actions/organization.ts` (same file as `updateTerminologyAction`) validates dependency graph (`dependsOn`: can't enable `receiving` without `purchase_orders`; can't disable a module another enabled module depends on) and writes `organization_entitlements.enabled_modules`. Every change `log_audit`-ed (the `0007` helper).
   - **RLS hardening:** now add per-module RLS guards as a defense-in-depth layer for the highest-risk tables (a new `is_module_enabled(org_id, module_id)` STABLE function, wrapped in `(SELECT ...)` per the `0140` InitPlan convention). App-layer `assertModule` remains the primary gate; RLS is backstop.

2. **Custom field definitions (closes the biggest gap).** Today `inventory_items.custom_fields` jsonb is used ad-hoc for book metadata (`book_rack_number`, `isbn`, `author`) with no schema (`data-model-integrations` audit). Add:
   - `0146_custom_field_defs.sql`: `custom_field_defs (id, organization_id, entity 'item'|'order'|'supplier'|'location', item_type text null, key, label, data_type 'text'|'number'|'date'|'select'|'bool', options jsonb, required bool, position int)`. RLS via `is_org_member`/`has_org_role`.
   - Service `apps/web/src/server/services/custom-fields.ts` + Zod validation applied in `inventory.ts` create/update against the def set (today validation is "entirely application-layer" with no registry — this fixes it).
   - The existing book fields become **seeded definitions** for the charter pack rather than hard-coded branches in `inventory.ts`.

3. **Custom statuses / workflow labels.** `order_requests` has a 14-state machine enforced in DB (migration `0109`) + mirrored in `packages/core/src/order-state-machine.ts`. **Do not** make the *machine* user-editable (it guards the ledger). Instead add a **status-label override** layer: `org_status_labels (organization_id, domain 'order'|'po', status_key, label, color)` so a distribution org can show "Allocated" instead of "approved" without touching `ALLOWED_TRANSITIONS`. This is a label remap, surfaced through `resolveTerminology` v2 — explicitly *not* a workflow builder (stated as a deliberate scope cut).

4. **Document templates.** PO terms are free-form text (`organizations.po_terms`, migration `0052`); pick/pack/signature pages are hard-coded layouts (`orders-fulfillment` audit). Add `document_templates (organization_id, kind 'po'|'packing_slip'|'pick_slip'|'receipt', name, body jsonb/handlebars, is_default)`. Render path: existing template files in `apps/web/src/lib/email/templates.tsx` and the pick/pack pages read from this table with a code default fallback.

5. **Terminology v2.** Extend `OrgTerminology` (`packages/core/src/constants/terminology.ts`) from the 4 fixed keys to an open map with namespaced keys (`module.rentals`, `entity.item`, `entity.location`, `nav.section.inventory`). `resolveTerminology` merges over `DEFAULT_TERMINOLOGY`. This unblocks renaming "Items"/"Locations"/"Charters"/"Warehouses"/section headers per-org (a flagged gap in the Navigation audit).

#### Dependencies & sequencing
Requires Phase 1 entitlements + manifest. Custom fields (#2) and templates (#4) are independent and can be parallelized. Status labels (#3) depends on terminology v2 (#5).

#### Definition of Done
- An owner can toggle any non-core module on/off in the UI, with dependency validation and audit trail.
- An owner can define a custom field (e.g., "Crop variety" / "Lot expiry") on items via UI; it appears on web + mobile item forms and validates on save.
- An owner can rename "Charters"→"Regions", "Items"→"SKUs", and an order status label, reflected on web + mobile.
- A custom PO footer/packing-slip template renders in generated documents.

#### Success metrics / acceptance criteria

| Criterion | Target |
|---|---|
| Self-serve module toggle | Owner enables/disables a module via UI; change reflected on all 4 surfaces within one mobile sync cycle (**< 60s**), **no deploy** |
| Dependency safety | Attempting to disable `purchase_orders` while `receiving` enabled is **blocked with a clear error**; no orphaned nav items ever render |
| Custom fields w/o migration | A new item attribute is added **config-only** (no migration, no deploy) and round-trips web↔mobile↔DB with validation |
| Status relabel | Renaming an order status label changes **display only**; `order_state_machine.ts` transitions and the `0109` DB trigger are unchanged (unit test asserts machine immutability) |
| Template override | Custom PO template renders; falling back to code default when no template row exists (no broken docs) |
| L4L Fresno regression | Fresno operates on the **charter pack defaults** (seeded book fields, charter terminology) with **0 workflow diffs** vs. Phase 1 |

---

### Phase 3 — Integrations: connector framework + Square first, then Shopify / QuickBooks / carriers

**Goal:** Stand up a generic connector framework on top of the existing-but-dormant outbox (`outbox_events`, migration `0016`, today only publishes `receipt.posted`), then ship the first real connector (Square inventory sync). The audit flags "no connector/integration management UI," "no active outbox draining," and "no webhook registry" — this phase fixes all three.

#### Workstreams

1. **Connector framework + credential vault.**
   - `0147_connectors.sql`: `connectors (id, organization_id, kind 'square'|'shopify'|'quickbooks'|'carrier_easypost', status, config jsonb, secret_ref text, created_by)` — secrets stored in Supabase Vault / encrypted, **never** plaintext jsonb. `connector_sync_runs (connector_id, started_at, finished_at, direction 'pull'|'push', counts jsonb, error)`.
   - **Outbox drainer:** a scheduled worker (Vercel Cron / Supabase Edge Function) that reads `outbox_events`, dispatches to subscribed connectors, marks delivered with `idempotency_key` dedupe (the table already supports this per the `service-layer-parity` audit). Add topics beyond `receipt.posted`: `stock.adjusted`, `item.created`, `item.updated`, `order.completed`.
   - Settings UI `settings/integrations/page.tsx` (gated `integrations:manage`, new permission). Connector framework is itself a module (`integrations`) so it respects entitlements.

2. **Square first (inventory + catalog reconcile).** Bi-directional: pull Square catalog → upsert `inventory_items` (mapping Square variation → SKU/barcode); push `stock.adjusted`/`receipt.posted` deltas → Square inventory counts. Reconciliation report under existing `reports` module. Square chosen first because it's the lightest (single inventory model, OAuth, well-documented) and validates the framework before tackling accounting/EDI complexity.

3. **Then Shopify (catalog + orders), QuickBooks (item COGS / invoice → GL), carriers (EasyPost/Shippo for label + tracking).** Each is a new `connectors.kind` + adapter module in `apps/web/src/server/integrations/<kind>/`. Carrier integration finally gives order fulfillment the tracking number the `orders-fulfillment` audit flagged as missing.

#### Dependencies & sequencing
Requires Phase 1 (so `integrations` is a toggleable module). Outbox drainer (#1) is the gate for all connectors. Square (#2) before the rest. Reuse the existing `idempotency_keys` pattern (already proven in `post_receipt_v2`) for sync idempotency.

#### Definition of Done
- Outbox drainer runs on schedule, processes the 4+ topics, with retry + dead-letter visibility.
- An owner connects Square via OAuth in the integrations UI; catalog pulls in; a stock adjustment in StockPilot reflects in Square.
- Sync runs are auditable (`connector_sync_runs`) and surfaced in a reconciliation view.

#### Success metrics / acceptance criteria

| Criterion | Target |
|---|---|
| Square reconcile latency | A stock change in StockPilot reflects in Square (and vice-versa) within **≤ 5 min** p95 |
| Idempotency | Replaying the same outbox event causes **0 duplicate** Square writes (verified by forcing retries) |
| Secret safety | No connector secret ever stored in plaintext; `connectors.config` jsonb contains **no credentials** (audit scan green) |
| Drainer reliability | Outbox backlog drains to **0** within 5 min under normal load; failed events land in DLQ, not lost |
| No ledger contamination | Connector-driven stock changes flow through `adjust_stock`/`post_receipt_v2` RPCs only — **never** direct `stock_movements` inserts (RLS still forbids direct insert) |

---

### Phase 4 — Vertical Packs: charter → agriculture → distribution

**Goal:** Prove the thesis: a new vertical ships as a **declarative pack (config only)** — a bundle of `{ enabled_modules, custom_field_defs, terminology, status_labels, document_templates, seed categories }` — with **no per-industry code fork**.

#### Workstreams

1. **Pack format + installer.** `packages/core/src/packs/<vertical>.ts` exporting a `VerticalPack` manifest. Installer service `apps/web/src/server/services/packs.ts` applies a pack to an org by writing entitlements + seeding `custom_field_defs`, `org_status_labels`, `document_templates`, terminology jsonb. Onboarding adds a "Choose your setup" step (`organizations.industry` column already exists per `0001`).

```jsonc
// packages/core/src/packs/agriculture.ts (illustrative)
{
  "id": "agriculture",
  "label": "Agriculture / Food",
  "enabledModules": ["inventory","movements","cycle_counts","purchase_orders","receiving","suppliers","reports","orders","locations"],
  "disabledModules": ["books","rentals","procedures"],
  "terminology": { "entity.item": "Lot", "warehouse_singular": "Facility", "charter_singular": "Grower" },
  "customFieldDefs": [
    { "entity": "item", "key": "harvest_date", "label": "Harvest date", "dataType": "date" },
    { "entity": "item", "key": "lot_expiry", "label": "Expiry", "dataType": "date", "required": true }
  ],
  "statusLabels": [{ "domain": "order", "statusKey": "approved", "label": "Allocated" }],
  "defaultTrackingType": "lot"  // leverages existing inventory_items.tracking_type (0015)
}
```

2. **Charter pack (refactor-in-place).** Extract the *current* hard-coded charter behavior (book item_type branches in `inventory.ts`, charter/warehouse terminology, ISBN lookup, rentals) into `packs/charter.ts`. **L4L Fresno is migrated to the charter pack** — this is the critical regression boundary. The charter pack must reproduce today's behavior exactly.

3. **Agriculture pack.** Lot-centric: leans on existing `tracking_type='lot'` + `receipt_line_lots.expiration_date` (migration `0015`). Disables `books`/`rentals`. Adds harvest/expiry custom fields. (Note: outbound expiry *enforcement* is a known engine gap — flagged here, delivered in Phase 5 traceability, not as pack config.)

4. **Distribution pack.** Multi-supplier, velocity-focused: enables `purchase_orders`/`receiving`/`reports` (valuation, ABC velocity, reorder forecast — all already exist), `shipments` (migration `0050`). Disables `books`/`rentals`/`procedures`. Relabels "Charter"→"Customer", "Warehouse"→"DC".

#### Dependencies & sequencing
Requires Phases 1–2 (entitlements, custom fields, terminology v2, status labels, templates). Charter pack first (it's the regression anchor), then agriculture, then distribution.

#### Definition of Done
- Three packs exist as pure config; selecting one at onboarding produces a fully-configured org with **0 lines of per-pack application code** beyond the generic installer.
- L4L Fresno runs on `packs/charter.ts` with no behavioral change.

#### Success metrics / acceptance criteria

| Criterion | Target |
|---|---|
| Config-only pack | A **4th** vertical (e.g., retail backroom) can be added by writing a new `packs/*.ts` + JSON pack — **no service/migration/UI code** (this is the headline thesis test) |
| Charter parity | L4L Fresno on the charter pack: full e2e suite **0 regressions**; book ISBN lookup, rentals, charter terminology all intact |
| Pack install correctness | Installing the agriculture pack on a fresh org yields correct modules, terminology, lot tracking default, and expiry custom field — verified by a fixture test |
| Pack switch safety | Switching an org's pack **never deletes inventory or ledger rows**; only entitlements/labels/defs change (existing data preserved) |
| Surface coverage | Every pack's terminology + module set renders correctly on **both** web and mobile from the single manifest |

---

### Phase 5 — Enterprise depth: transfers, returns, quality, traceability, wave/task, labor

**Goal:** Fill the genuine *engine* gaps (not config gaps) the audits flagged, as optional advanced modules gated by entitlements. These are real schema/RPC additions — the heaviest phase.

#### Workstreams (each an optional module in the registry)

| Module | Engine work | Closes audited gap |
|---|---|---|
| **transfers** | `in_transit` state: split `transfer_stock` (migration `0004`) into `transfer_dispatch` (decrement source, create in-transit reservation) + `transfer_receive`. New `transfer_orders` table. | "No transfer in-transit state" (stock-core gap) |
| **returns** | `return_orders` + `return_lines`; RMA workflow tying `serial_registry.current_status='rma'` (already an enum value) to an authorization + restock RPC. | "No RMA/Returns workflow" (supply-inbound gap) |
| **quality** | QA-hold receiving: `received → qa_hold → available` gate; quarantine location type; damage disposition codes. | "No QA/Quality Hold status" (supply-inbound gap) |
| **traceability** | Outbound lot/expiry enforcement (block picking expired lots); lot genealogy (component→finished). Trigger on expiry. | "No lot/expiry enforcement on outbound" (stock-core gap) |
| **wave_task** | `pick_waves` + `pick_tasks`; complete the scaffolded pick/pack/stage columns from migration `0109` (`picked_at`/`packed_at`/`staged_at` have columns but no RPCs). | "Pick/pack/stage workflows incomplete" (orders-fulfillment gap) |
| **labor** | `labor_events` time-tracking against tasks; productivity report. | (new — enterprise/3PL need) |

Also: **multi-UOM** (`uom_conversions` table exists per `0014` but unused in receiving) — wire conversions into `post_receipt_v2`. **Service accounts / scoped API keys** (`api_keys` table) to close the "no service-account auth" gap, gated by the `apiAccess` entitlement (finally making that `PLANS` flag real).

#### Dependencies & sequencing
Requires Phases 1–4. `transfers` and `quality` build on the ledger directly and should come first (highest demand for distribution/3PL). `wave_task` depends on `0109` columns. Each ships as its own module so orgs adopt incrementally.

#### Definition of Done
- Each advanced module is independently toggleable; enabling it adds its nav, RPCs, and snapshot slices via the same manifest mechanism.
- The in-transit transfer, QA-hold, and RMA flows complete atomically through SECURITY DEFINER RPCs (consistent with `adjust_stock`/`post_receipt_v2` discipline).

#### Success metrics / acceptance criteria

| Criterion | Target |
|---|---|
| Transfer integrity | Cross-warehouse transfer with in-transit state never double-counts stock; in-transit qty is reserved, not available; ledger balances reconcile to **0 variance** |
| Expiry enforcement | Picking an expired lot is **blocked at the RPC** (not just a UI warning); enforcement is org-opt-in via the `traceability` module |
| Wave completeness | `picked_at`/`packed_at`/`staged_at` columns (migration `0109`) are populated by real RPCs; a wave of 10 orders transitions in **one batched operation** |
| API keys | A scoped service-account key authenticates to API v1 with **module + permission** scopes, honoring the same `assertModule`/`assertPermission` gates as a user token |
| Opt-in isolation | Orgs **without** an advanced module enabled see **zero** new nav/columns/perf cost; charter pack orgs (Fresno) are unaffected |

---

### Program-level success metrics (apply across all phases)

| Metric | Target |
|---|---|
| **Single config plane** | After Phase 2, **all** module visibility + terminology + custom fields are data-driven; the codebase contains **no `if (industry === 'charter')` branches** in services |
| **Web/mobile parity** | Nav, terminology, modules, and snapshot derive from the **one** `nav-manifest.ts` + entitlements; a parity unit test fails CI if web and mobile diverge |
| **Zero-fork guarantee** | No per-customer or per-industry branch/fork is ever merged; new verticals = new `packs/*.ts` only |
| **Ledger sanctity** | Across all phases, **every** stock mutation still flows through `adjust_stock`/`transfer_stock`/`post_receipt_v2`/`post_cycle_count`; direct `stock_movements` writes remain RLS-forbidden (no regressions to migration `0140` RLS) |
| **Grandfather invariant** | L4L Fresno (and any pre-existing org) experiences **0 workflow regressions** at every phase boundary, verified by the e2e suite |
| **Small-team realism** | Each phase ships in **additive migrations** (`0144+`) with feature flags; no big-bang rewrite; every phase is independently shippable and reversible (toggle off) |

### Assumptions stated explicitly (not confirmed in the audit)
- **L4L Fresno is the live charter org** used as the regression baseline — inferred from MEMORY (`unarchive-lenovo` scripts, "L4L Fresno workflows" in the brief); confirm the exact `organization_id` before writing the grandfather backfill (`0145`).
- **Vercel Cron / Supabase Edge Functions** are the assumed runtime for the Phase-3 outbox drainer; the audit confirms *no* worker exists today ("No active outbox event draining"), so the runtime choice is open.
- **Supabase Vault** for connector secrets is assumed available; if not, an encrypted column + KMS is the fallback.
- The `org_module_settings` per-module-config table is proposed as *optional*; the simpler `organization_entitlements.enabled_modules text[]` is sufficient for Phases 1–4 and is the recommended starting point.

Key files/tables to create or change, by phase:
- **P1:** `supabase/migrations/0144_module_registry.sql`, `0145_grandfather_entitlements.sql`; `packages/core/src/modules/{types,registry,nav-manifest}.ts`; `apps/web/src/server/services/context.ts` (+`assertModule`, `module_disabled` code); `apps/web/src/lib/auth/api-context.ts`; `apps/web/src/components/dashboard/nav.ts`; `apps/mobile/src/lib/drawer-nav.ts`, `apps/mobile/src/components/drawer-content.tsx`, `apps/mobile/app/(drawer)/(tabs)/_layout.tsx`, `apps/mobile/src/lib/sync.ts`, `apps/web/src/app/api/v1/mobile/snapshot/route.ts`; `packages/core/src/constants/permissions.ts` (+`modules:manage`).
- **P2:** `0146_custom_field_defs.sql` (+ status-label + document-template + `is_module_enabled` migrations); `apps/web/src/server/services/{custom-fields,organization}.ts`; `packages/core/src/constants/terminology.ts`; `packages/core/src/order-state-machine.ts` (unchanged — assert immutability).
- **P3:** `0147_connectors.sql`; `apps/web/src/server/integrations/<kind>/`; outbox drainer (Cron/Edge fn); extend topics in `apps/web/src/server/services/receiving.ts` (`publish_outbox`) and `adjust_stock` callers; `settings/integrations/page.tsx`.
- **P4:** `packages/core/src/packs/{charter,agriculture,distribution}.ts`; `apps/web/src/server/services/packs.ts`; onboarding pack-select step.
- **P5:** advanced-module migrations (`transfer_orders`, `return_orders`, QA-hold, `pick_waves`/`pick_tasks`, `labor_events`, `api_keys`), each a registry module; wire `uom_conversions` (migration `0014`) into `post_receipt_v2`.

---

## Risks, Tradeoffs & Backwards-Compatibility

This section assumes the configuration layer being added is: (1) a per-org **entitlements** record (which modules/features are active), (2) a DB-backed **nav manifest** that supersedes the static `BASE_NAV`/`ADMIN_NAV` arrays in `apps/web/src/components/dashboard/nav.ts` and `DRAWER_SECTIONS` in `apps/mobile/src/lib/drawer-nav.ts`, (3) extended **terminology** beyond the four keys in `packages/core/src/constants/terminology.ts`, and (4) optional **connector** definitions feeding the existing `outbox_events` (migration `0016_outbox.sql`). Everything below is grounded in the audited files; where I assume a not-yet-built artifact I label it **[ASSUMED]**.

The single most important real-world precedent for this whole design is migration `0143_security_hardening_2026_05_28.sql`: it exists *because* the mobile app writes directly to tables via PostgREST and "never reaches the service-layer gate." Any entitlements axis that lives only in the TypeScript service layer is therefore already known to be bypassable in this codebase. That fact drives the fail-closed design below.

---

### 1. Backwards-compatibility for L4L Fresno (the existing org)

The existing org currently relies on three things being implicitly true: every module is on; the nav is the static array; terminology is the 4-key `charter_*`/`warehouse_*` override (or defaults). The migration must make all three *explicit* without changing observed behavior on the next request.

#### 1.1 Grandfathering migration

I recommend an additive, default-permissive schema. Do **not** add `NOT NULL` columns without defaults to `organizations` (the table already carries `industry text`, `plan`, `terminology jsonb`, `mfa_policy` per `0001_init.sql`); add a sibling table plus a JSONB column so RLS and reads stay simple.

```sql
-- 0144_entitlements_and_manifests.sql  (additive, default-on)

-- (a) Per-org enabled modules + feature flags. JSONB so we don't
--     migrate a column per module. Default = the full set so EVERY
--     existing org (and every new org until packaging ships) behaves
--     exactly as today.
alter table public.organizations
  add column entitlements jsonb not null default '{}'::jsonb;

-- (b) Canonical module registry (control-plane reference data, NOT org-scoped).
create table public.module_registry (
  key            text primary key,          -- 'inventory','books','rentals','bundles',
                                             -- 'cycle_counts','purchase_orders','receiving',
                                             -- 'orders','procedures','schedule','suppliers',
                                             -- 'reports','ai','public_requests','shipments'
  label          text not null,
  default_on     boolean not null default true,
  min_plan       text,                       -- null = any plan
  requires_native boolean not null default false  -- see §4.2 mobile OTA risk
);

-- (c) DB-backed nav manifest, org-scoped, seeded from today's static nav.
create table public.org_nav_manifest (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  surface        text not null check (surface in ('web','mobile')),
  manifest       jsonb not null,             -- ordered sections+items mirroring NavItem/DrawerNavItem
  version        int  not null default 1,
  updated_at     timestamptz not null default now(),
  primary key (organization_id, surface)
);
alter table public.org_nav_manifest enable row level security;
```

The grandfathering data step (run inside the same migration) seeds existing orgs from the *current* source-of-truth so nothing visually changes:

```sql
-- Mark every existing org as having every module on, derived from the
-- registry's default_on set. New orgs get the same default via the
-- organizations.entitlements default ('{}' is interpreted as "all default_on
-- modules enabled" by resolveEntitlements() — see §6 fail-closed semantics).
update public.organizations o
set entitlements = (
  select jsonb_object_agg(m.key, jsonb_build_object('enabled', true))
  from public.module_registry m
)
where o.entitlements = '{}'::jsonb;
```

Nav manifest seeding is best done **out of SQL** by a one-shot script (`apps/web/scripts/seed-nav-manifests.mjs` **[ASSUMED new]**) that imports `BASE_NAV`/`ADMIN_NAV` and `DRAWER_SECTIONS` and writes the JSONB rows verbatim — keeping the seed identical to the code today instead of re-typing the nav in SQL and drifting. Critically: if `org_nav_manifest` has **no row** for an org/surface, the renderer must **fall back to the static array** (`navForRole()`), not to an empty nav. That single rule means L4L Fresno is correct even if the seed script hasn't run yet, and a failed seed degrades to "exactly today," not "blank sidebar."

Terminology: no migration needed for the existing 4 keys; they already merge via `resolveTerminology()`. Extending the interface (`OrgTerminology` in `packages/core/src/constants/terminology.ts`) to add keys like `item_singular`, `location_singular`, `movement_singular`, `lot_singular` is purely additive because `resolveTerminology()` does `{...DEFAULT_TERMINOLOGY, ...input}` — unknown-but-unset keys fall back to defaults, so L4L sees "Item", "Location", etc. unchanged.

#### 1.2 Rollback path

Because every change is additive and default-permissive, rollback is a column/table drop plus a code feature-flag, not a data restore:

| Layer | Forward | Rollback |
|---|---|---|
| Schema | `0144` adds `entitlements`, `module_registry`, `org_nav_manifest` | `0145_rollback` drops the two tables + column. Existing behavior is unaffected because nothing read those columns at write time (RLS still uses `is_org_member`/`has_org_role`). |
| Service layer | `resolveEntitlements(ctx)` gates routes | A build-time flag `ENTITLEMENTS_ENFORCED=false` makes `assertEntitled()` a no-op returning `true`. Lets you ship the schema + reads, then *flip enforcement separately* once verified. |
| Nav | renderer reads `org_nav_manifest`, falls back to static | Stop reading the table (flag), or just delete the rows — fallback restores static nav. |
| RLS | entitlement-aware policies (§3, §6) | The new policies are `AND`-ed onto existing org/warehouse predicates; dropping them in `0145` returns to the `0140`/`0143` policy set. |

The rollback discipline that matters: **never** make an existing RLS policy *depend* on an entitlement being present. Add entitlement checks as an additional `AND exists(... org_module_enabled ...)` clause that, if the helper or column is dropped, can be removed without weakening the underlying org/warehouse predicate. This is the inverse mistake of `0080` (which "inadvertently dropped" invariants `0049` had — see `0143` header); structure the SQL so a revert restores, never relaxes.

---

### 2. Tradeoffs

#### 2.1 DB-backed nav/entitlements vs. static arrays

| Dimension | Static (today) | DB-backed (proposed) |
|---|---|---|
| Read cost | Zero — array in JS bundle, filtered by `navForRole()` | One row per request unless cached |
| Customizability | Code change + deploy per change | Self-serve per org |
| Drift risk | Web/mobile nav hand-synced (already a known gap) | Single canonical manifest can feed both surfaces |
| Cache invalidation | None needed | New burden (§4.3) |
| Failure mode | Cannot fail | Must define fallback (→ static) |

Recommendation: cache the resolved entitlements + manifest **inside the existing per-request `withContext` cache** (it already uses `React.cache` and resolves org/role/MFA once per request per `context.ts`). Add `entitlements` and `navManifest` to the `ServiceContext` shape so they're resolved exactly once alongside `mfaRequired`/`mfaSatisfied`. For the mobile snapshot, fold the resolved manifest + entitlements into the existing `/api/v1/mobile/snapshot` payload rather than a new endpoint — the snapshot route already centralizes warehouse-access resolution and error funnelling (`dbError`). Net per-request cost: one extra column read on the org row you're already fetching for `mfa_policy`. That is acceptable; the real cost is the cache-invalidation surface, not the read.

#### 2.2 Entitlements as a second authorization axis on top of roles

Today authorization is one axis: role → permission (`ROLE_PERMISSIONS`, 55–59 perms in `packages/core/src/constants/permissions.ts`) plus a warehouse-scope filter (`getWarehouseAccess`). Adding entitlements introduces a second, orthogonal axis (org has module X). The combined gate becomes:

```
allow = hasPermission(role, perm)            -- "is this user allowed?"
     AND orgModuleEnabled(ctx, moduleOf(perm)) -- "is this module sold/active for the org?"
     AND (mfaRequired ? mfaSatisfied : true)  -- existing gate, evaluated FIRST in assertPermission
```

The cost is real: every permission now needs a **module mapping** (`bundles:distribute` → module `bundles`, `rentals:create` → `rentals`, `cycle_counts:*` → `cycle_counts`). I recommend declaring this mapping once in `packages/core` (`PERMISSION_MODULE: Record<Permission, ModuleKey | null>`; `null` = always-available core perms like `items:read`), and wiring it into `assertPermission(ctx, permission)` in `context.ts` so the entitlement check is *not* a separate call sites can forget. The danger of a second axis is partial enforcement — some routes check it, some don't. Centralizing it inside the existing `assertPermission` (which `withContext` services already call) is how you avoid that. The order must be: MFA gate first (as `context.ts` already does at line ~107), then entitlement, then permission — so a disabled module on an MFA-required org still reports MFA first only if MFA genuinely blocks; otherwise reports the module being off.

#### 2.3 Custom fields / statuses flexibility vs. maintainability

`inventory_items.custom_fields jsonb` already holds `book_rack_number`, `rack_row`, `isbn`, `author` with **zero schema registry or validation** (confirmed in the data-model audit). Letting orgs define arbitrary custom fields and custom statuses trades flexibility for three concrete maintenance costs:

- **Query/index cost**: filtering on a custom field needs a GIN index or it table-scans. The service layer's item filter (`apps/web/src/server/services/inventory.ts`) currently branches on known keys (rack-aware `custom_fields`); arbitrary keys can't be indexed ahead of time.
- **Status state machines**: `order_requests` has a **DB-enforced** 14-state machine (trigger in `0109`, mirrored in `packages/core/src/order-state-machine.ts`). Custom statuses cannot be injected into that trigger without either (a) a data-driven transition table the trigger reads, or (b) abandoning DB enforcement. Recommendation: keep the core state machine fixed and offer custom statuses only as **labels/sub-states** layered on top (a `display_status` field), not as new graph nodes — preserving the trigger's integrity guarantees.
- **Validation ownership**: custom fields should get a per-org **field-definition manifest** (`org_custom_field_defs` **[ASSUMED]**: key, label, type, required, item_type scope) validated in the service layer + a Zod schema in `packages/core/src/schemas/inventory.ts`. Without it, "data integrity is entirely application-layer" (audit) becomes "data integrity is nonexistent."

#### 2.4 Connector source-of-truth conflicts (stock double-counting & reservation drift)

The strategic strength is the immutable ledger (`stock_movements`) + soft-hold reservations (`stock_reservations`). Connectors (POS, accounting, carrier, EDI) threaten this in two specific ways:

- **Double-counting stock**: if an external POS both decrements its own inventory *and* posts a `remove` movement via a connector, and a cashier also runs a manual adjust, the ledger and the POS diverge. The mitigation already half-exists: `post_receipt_v2` uses `idempotency_keys (org, scope, key, hash, status, resource_id)` with SHA-256 request hashing. Every connector-driven mutation **must** route through an RPC that takes an idempotency key scoped to the *external* system's transaction id (`scope='pos:square'`, `key=<square_txn_id>`). Replays then dedupe. A connector that writes `stock_movements` directly (bypassing `adjust_stock`/`post_receipt_v2`) is the failure mode to forbid at the RLS layer.
- **Reservation drift**: `stock_reservations.released_reason` is free text with **no `released_by` user reference** (audit gap). A connector that auto-releases reservations on external fulfillment will make "who released this?" unanswerable. Before wiring any connector that touches reservations, add `released_by uuid references user_profiles(id)` and have the connector stamp a synthetic service-account identity (§7 open question).

Recommendation: connectors are **outbound-first**. The `outbox_events` table (`0016`) exists but only `receipt.posted` is published and *nothing drains it* (audit). Build the drain (a worker/cron) and let connectors **react** to ledger events rather than **author** ledger state. Inbound writes (POS sale → stock decrement) must go through the same security-definer RPCs with idempotency, never direct table writes.

---

### 3. Risks

#### 3.1 RLS regressions when adding an entitlements axis

This is the highest-severity risk and it has direct precedent in this repo. `0143` exists because `0080` "inadvertently dropped" two integrity gates that `0049` had enforced, and the exploit path was **the mobile offline-sync direct PostgREST write that "never reaches the service-layer gate."** An entitlements axis enforced only in `assertPermission` (TypeScript) is exactly that class of bug waiting to happen: the web app would honor it, and mobile's direct writes (`apps/mobile/src/lib/sync.ts`, `cycle-count-sync.ts`) would walk right past it.

Concrete risks:
- **Asymmetric enforcement**: service layer blocks a disabled module's writes; raw PostgREST does not. A forged mobile request to `cycle_count_lines` succeeds even though the org has `cycle_counts` disabled.
- **Policy bloat re-introducing the `0140` problem**: `0140_rls_initplan_wrap` rewrote 91 policies to wrap helper calls in `(select ...)` for InitPlan caching. A naive `org_module_enabled(org, 'x')` added to dozens of policies as a bare function call would regress that planner optimization. The entitlement helper must be wrapped the same way: `(select public.org_module_enabled(table.organization_id, 'cycle_counts'))`.

Mitigation: add a **DB-level** helper mirroring the role helpers, and gate the *write* policies of module-scoped tables on it:

```sql
create or replace function public.org_module_enabled(org_id uuid, module_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (entitlements -> module_key ->> 'enabled')::boolean
     from public.organizations where id = org_id),
    -- fail CLOSED for unknown modules, but default-ON for orgs whose
    -- entitlements weren't seeded (NULL key) so grandfathering holds:
    (select default_on from public.module_registry where key = module_key)
  );
$$;
```

Then, for example on `rentals` INSERT/UPDATE (table from `0131_rentals.sql`), `AND (select public.org_module_enabled(organization_id, 'rentals'))`. Apply only to module-scoped tables, never to core (`inventory_items`, `stock_movements`, `item_stock_levels`) which must stay always-on. Treat this as the same review rigor `0143` got: a multi-agent/second-reviewer pass specifically asking "does the mobile direct-write path respect this?"

#### 3.2 Mobile OTA vs. native-build constraints when modules add native deps

A module that is purely screens + API calls (e.g., enabling/disabling Rentals nav) ships via **Expo OTA** and the existing OTA auto-reload on launch (memory: "OTA auto-reloads on launch"). But a module that needs a **native dependency** (a new scanner SDK, BLE for cold-chain temp loggers in agriculture, a label-printer module) requires a **native rebuild + App Store review** — it cannot be turned on by flipping `entitlements`. The build pipeline is also fragile here (memory: "EAS build Xcode 26 + sharp gotchas"; "DO NOT reattempt FlashList 1.7 or Supabase server-side image transforms — both crashed builds").

Mitigation: the `module_registry.requires_native boolean` column above. The mobile snapshot must report, per module, whether the *installed binary* supports it (a compiled-in capability list checked against the registry). If an org enables a `requires_native` module but the user's installed app version predates it, the mobile client shows "Update the app to use X" instead of rendering a broken/crashing screen. Entitlement-on must never be sufficient to *render* native UI; the client's compiled capability set is the gate.

#### 3.3 Cache invalidation for public catalog + nav manifest

Two distinct caches:
- **Public catalog** (`apps/web/src/server/services/public-catalog.ts`, `public-items.ts`, rendered at `apps/web/src/app/r/[token]/page.tsx`). This is anonymous and the public order link uses a token + `is_public_orderable` per warehouse (`0044`). If a connector or an admin disables the `public_requests` module or toggles a warehouse off, a cached `/r/[token]` page can keep accepting orders for a disabled module — a fail-**open** correctness bug. Tag the public catalog cache with the org id + token (`revalidateTag(`pub:${orgId}`)`) and bust it on: token rotation, `is_public_orderable` change, and `public_requests` entitlement change. The public order **submit** endpoint (`apps/web/src/app/api/v1/public/order-requests/route.ts`) must additionally re-check entitlement server-side at submit time, never trusting the cached page.
- **Nav manifest**: cached per-request via `withContext`, but cross-request it's whatever store backs it. Bust on `org_nav_manifest.version` bump. Stale nav is low-severity (a hidden item briefly visible) **only if** the destination route also enforces entitlement server-side (§6) — otherwise stale nav becomes an access bug. Nav cache staleness must never be the sole gate.

#### 3.4 Multi-org workspace correctness on mobile

Mobile recently added a workspace switcher (`apps/mobile/src/components/workspace-switcher.tsx`, `src/lib/use-workspace.ts` — both untracked/new in git status). Entitlements + nav manifest are **per-org**, so switching workspace must atomically swap: (a) the bearer-token's active membership (`pickActiveMembership` in `api-context.ts`), (b) the cached snapshot (entitlements/manifest/warehouses), and (c) the local SQLite outbox scoping. The risk: an outbox action queued under org A is flushed after switching to org B, writing into the wrong org — and if org B has that module disabled, the write either fails confusingly or (worse, if RLS is asymmetric) succeeds. The offline queue (`pending_actions`, `apps/mobile/src/lib/queue.ts`) must stamp `organization_id` on every queued action and the push path must assert the action's org matches the *currently active* membership before sending. This is a correctness requirement independent of entitlements but is made sharper by them.

---

### 4. Security: entitlements must fail closed

The requirement: a disabled module's routes/APIs must return 404/403 even against a forged client. Given the `0143` precedent, this must be enforced at **three** layers, not one.

**Layer 1 — Service/route (web RSC + API v1).** Add `assertEntitled(ctx, moduleKey)` in `context.ts` alongside `assertPermission`, throwing `ServiceError('forbidden')` (maps to 403) or `ServiceError('not_found')` (404) per the existing typed-code→HTTP mapping. Fold the module check into `assertPermission` via `PERMISSION_MODULE` so existing call sites get it for free. For App Router pages, a disabled module's `page.tsx` should `notFound()` (404) so the route is indistinguishable from nonexistent — preferable to 403 for "this org didn't buy it."

```ts
export function assertEntitled(ctx: ServiceContext, moduleKey: ModuleKey) {
  // Mirror resolveMfaState: a flaky entitlements read FAILS CLOSED.
  if (!ctx.entitlements?.[moduleKey]?.enabled) {
    throw new ServiceError('not_found', `Module not available: ${moduleKey}`);
  }
}
```

**Layer 2 — `resolveEntitlements` fails closed on error,** exactly mirroring `resolveMfaState` in `context.ts`, which on a failed org lookup returns `{ mfaRequired: true, mfaSatisfied: false }` with the comment "Fail CLOSED — a flaky org lookup must NOT silently let an admin bypass MFA." The entitlements resolver must do the same: on any error reading `organizations.entitlements`, return all-module-disabled for premium modules (core/default-on modules stay available so the app doesn't brick). This is the inverse of a feature flag's usual "fail open."

**Layer 3 — RLS (the non-negotiable one).** Because mobile writes directly via PostgREST and "never reaches the service-layer gate" (`0143`), the disabled-module guarantee is only real if it's in the database. Use `org_module_enabled()` (§3.1) on the **write** policies of module-scoped tables, InitPlan-wrapped per `0140`. A forged insert into `rentals` for an org without the `rentals` entitlement is rejected by Postgres regardless of how the request was crafted. Reads can stay at Layer 1/2 for premium modules (a user seeing data they can't act on is lower-severity than a forged write), but writes must be DB-enforced.

The combined guarantee: forging past the nav (Layer absent) hits a 404 at the route (Layer 1), and even a forged raw-PostgREST write hits an RLS denial (Layer 3). Fail-closed defaults at every layer mean a bug or outage degrades to "module off," never "module silently on."

---

### 5. Open questions & limitations the team must resolve

| Topic | Question / limitation | Why it blocks design |
|---|---|---|
| Pricing/packaging | The `PLANS` record in `plans.ts` is explicitly described as "not doing useful work" since the 2026-05-04 pivot to an invite-only internal tool, and `customRoles: true` on Business/Enterprise is called "a lie" (perms are compile-time). Is entitlements driven by `plan` (`min_plan` in registry) or sold à-la-carte independent of plan? | Determines whether `module_registry.min_plan` is the gate or just advisory. Reviving `assertPlanLimit` semantics for module gating conflicts with the current "ceilings so the owner never sees limit toasts" stance. |
| Control-plane authority | Who edits `entitlements`, `module_registry`, and `org_nav_manifest`? Owner/admin of the org? Or a super-admin/staff-only plane? `module_registry` is reference data (not org-scoped) — it likely needs a service-role-only write path, not org-admin RLS. | If org admins can self-enable premium modules, entitlements isn't a packaging layer — it's a free-for-all. Custom-field governance (who defines fields, can they be deleted with data present?) is the same class of question. |
| Custom fields governance | No schema registry exists today. Can a field be retyped or deleted while rows hold data? Are custom-field values searchable/indexed? Per-`item_type` scoping? | Without answers, the JSONB free-for-all the audit warns about gets worse, and reports (`reports.ts`) can't aggregate on fields they don't know about. |
| Custom statuses vs. state machine | The `order_requests` 14-state machine is DB-trigger-enforced (`0109`). Are custom statuses display-only labels, or real transition nodes? | Real custom nodes mean a data-driven trigger (large, risky change to the most safety-critical workflow). Recommend labels-only for v1. |
| Service accounts | "No Service Account / API Key alternative to bearer-token auth" (permissions audit). Connectors need a non-human identity; reservations need `released_by`. | Connectors (§2.4) and reservation audit can't be done correctly without a service-principal concept. Blocks the connector axis entirely. |
| Outbox drain | `outbox_events` exists, only `receipt.posted` published, **nothing drains it** (audit). | Connectors are outbound-first (§2.4); with no drain, no outbound integration works. This is prerequisite infrastructure, not a module. |
| Web/mobile nav drift | Today the two navs are hand-synced (audit). Does the manifest become the single source feeding both, or do we seed two manifests and keep drifting? | A shared manifest is the chance to kill the drift gap; punting keeps it. |
| Terminology depth | Extending `OrgTerminology` is additive, but every hard-coded label ("Item", "Movements", "Lot", "Crop") not yet in the interface still requires touching source. How far does v1 go? | Determines scope; full label externalization is large. Recommend the high-traffic nav labels first. |

**Bottom line:** the architecture has the right seams — `withContext`/`ServiceContext` to carry a resolved entitlement set, `assertPermission` as the single choke point, `organizations` JSONB for additive config, `outbox_events` for connectors, and a fail-closed precedent in `resolveMfaState`. The two things that will bite the team if rushed are (1) enforcing entitlements only in TypeScript while mobile writes straight to PostgREST (the exact `0143`/`0080` regression class), and (2) treating nav-manifest cache staleness as an access control rather than backing it with server-side route enforcement. Both are avoided by pushing the disabled-module guarantee down to RLS with the `0140` InitPlan-wrapped helper, and by making every fallback default to "today's behavior" so L4L Fresno is correct even mid-migration.

---

## Open questions and limitations

### Decisions the team must make (not technical blockers — product calls)
1. **Pricing / packaging.** The audit found billing was deliberately neutered (internal-tool pivot, `plans.ts`). Do premium modules (traceability, pos_sync, accounting_sync, shipping_sync) stay **free owner-toggles**, or does StockPilot re-introduce a billing tier if it goes multi-tenant SaaS? This review assumes owner-toggle now, with `minPlan` as a dormant hook. **This is the single biggest strategic fork** and it changes whether the "premium" tier classification means anything yet.
2. **Who edits the control plane?** Module activation and nav composition are powerful. Recommended: `owner`/`admin` only, audit-logged (`module.enabled`/`nav.changed` events). Confirm whether `admin` should be able to disable modules or only `owner`.
3. **Ecommerce order model.** `order_requests` is an internal/public-request flow with a 14-status charter-oriented state machine — **not** a sales-order model. Before Shopify/Square order ingestion, decide: extend `order_requests` with an `origin` (`internal|public|square|shopify`) + a parallel status track, or introduce a distinct `sales_orders` table that reserves/decrements against the same ledger. This review leans toward a distinct external-origin order with its own lifecycle, mapped to reservations — but it is an explicit open decision.
4. **Custom-field governance.** Six data types cap the blast radius, but who can create custom fields, and is there a per-org field cap to prevent jsonb sprawl? Recommend admin-only + a soft cap (e.g. 50 defs/entity).

### Implementation details to confirm before coding (verification gaps)
5. **`ServiceError` → HTTP normalizer location.** The `module_disabled → 403` mapping site was not located in the audit. Find where `forbidden`/`plan_limit_exceeded` become HTTP codes (likely a shared handler near `api-context.ts` or the v1 route wrapper) and add the mapping there. Until found, the Phase-1 enforcement edit is not fully actionable.
6. **Exact RLS policy names/shapes.** The selective RLS backstop (decision D) assumes a single `order_requests_write` policy; `0044`/`0140` may use differently-named/split policies. Enumerate the real policy names per target table before writing `0147`.
7. **Mobile tab dynamic slotting.** Confirm the set of screens that physically exist as tab routes today; any module that should be tab-eligible needs a real route file first (Expo constraint, decision H). The first pass should only re-slot among existing tab screens.
8. **Outbox drainer.** `outbox_events` exists but only `receipt.posted` is published and nothing consumes it for integrations. The connector framework needs a concrete drainer — the verified `/api/cron` directory (`purge-ai-chat-history`, `weekly-digest`) is the natural host for a polling drainer, or a Supabase scheduled function. Decide cron vs webhook-push delivery.

### Capabilities intentionally deferred (named, not designed in depth)
9. **EPCIS / CBV event capture** for full GS1 event-level traceability exchange — the Agriculture pack covers lots/FEFO/expiry/recall genealogy and GS1 barcodes, but EPCIS event interchange is a later, compliance-driven addition, not Phase-4 table stakes.
10. **Catch-weight UoM** — the existing `uom-conversions` admin is noted but not wired to variable-weight items; a true catch-weight model (ordered-in-eaches, priced-by-weight) is an Agriculture deep-cut deferred to enterprise depth.
11. **Wave/task orchestration, yard/dock scheduling, labor standards, license plates/handling units, robotics/WCS connectors** — real benchmark capabilities, correctly classified as "grow-into-later" optional modules for the small/mid-market target. The architecture leaves clean seams (registry + ledger) so they can be added without forks.

### Scope and confidence notes
- This review **did** read the actual migrations, services, nav, and RLS (improving on the docs-level pass the original brief was based on). Even so, it did not line-by-line audit all ~60 services; a few claims (exact policy names, the error-normalizer site) are flagged above as verify-before-edit.
- The two foundational design sections were produced in parallel and contained the conflicts resolved in *Canonical reconciliation decisions* — read that section as the spec and the two sections as rationale.
- Performance/adoption claims that originate in StockPilot's own internal docs should be treated as internal documentation, not independently verified benchmarks.