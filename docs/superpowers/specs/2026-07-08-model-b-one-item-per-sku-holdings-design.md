# Model B — One Item per SKU, Charter/Rack as Holdings (Design Spec)

**Status:** DRAFT for owner review. NO migration or code until approved.
**Date:** 2026-07-08
**Decision on file:** Owner chose Model B (2026-07-08) after reviewing A vs B twice and validating it from three angles (import destination shows per-holding; orders auto-adjust holdings + total; the SKU total reflects all locations).

---

## 1. The decision, in one paragraph

A SKU is ONE product. `inventory_items` holds one row per SKU (per org). The *quantity* of that SKU is distributed across **holdings** — each holding is "how many units sit at a given location/rack under a given charter." On-hand for the item is the **sum of its holdings**. The Items list shows one row per SKU with the running total, expandable to the per-holding breakdown (charter · location · rack · qty). Receiving adds to a holding; fulfilling an order subtracts from a chosen holding; transfers move between holdings; the total re-sums automatically. Charter becomes a property of **where the stock sits (the holding)**, not of the product.

Example (real data, SKU `SP-G69UU-05H`):
```
Acer Chromebook  SP-G69UU-05H   total 281
  ├ CVSII-West-Shaw · rack 1-A · 75
  ├ CVLYII-Visalia  · rack 1-C · 100
  └ CVSII-Madera    · rack 2-A · 106
```
Today these are THREE `inventory_items` rows. Under Model B they become ONE row + three holdings.

## 2. Current state (verified)

- `inventory_items`: one row PER (sku × rack × charter) today — duplicates per placement. `quantity_on_hand` is a **stored scalar**, maintained by `adjust_stock` (`0189`), and already equals both Σ`stock_movements.quantity_change` and Σ`item_stock_levels.quantity` for that row. `charter_id` is a nullable FK ON THE ITEM.
- `item_stock_levels` (holdings): columns `(id, organization_id, item_id, location_id, quantity, updated_at)` — **no charter column**. A holding is item×location today.
- `locations`: carry `warehouse_id`, `kind` (rack/crate/staging/unplaced/site), `rack_number`, `rack_row`. Rack lives here.
- **23 tables FK `inventory_items.id`** (order lines, purchase_order_items, receipt_lines, serial_registry, stock_movements, item_stock_levels, cycle_count_lines, bundles, reservations, price history, embeddings, …). Merging duplicate rows must remap every one.
- Charter is used in **RLS**: `inventory_items_select` (mig 0229) has a `(warehouse_id, charter_id) IN rls_inv_read_warehouse_charter_ids()` branch — charter-restricted users are gated at the ITEM level today.
- The Items list ALREADY splits one item into per-holding rows (`placementRows` in page.tsx / `expandInstantPlacementRows`), and the 0224-0230 dashboard/snapshot stack depends on the ledger law (Σquantity_change = on-hand).

## 3. Target model

### 3.1 Holdings carry charter
Add `charter_id uuid NULL` (FK charters) to `item_stock_levels`. A holding becomes **item × location × charter**. The unique key becomes `(item_id, location_id, charter_id)` (NULLS NOT DISTINCT — a charterless holding is its own bucket).
- on-hand(item) = Σ holdings (unchanged meaning; now spans charters).
- on-hand(item, charter) = Σ holdings filtered to that charter.
- The per-holding breakdown = the item's `item_stock_levels` rows, each showing charter + location(rack) + qty.

### 3.2 On-hand stays a maintained scalar (KEY simplification — shrinks blast radius)
`inventory_items.quantity_on_hand` **remains** the maintained scalar it is today, still updated by `adjust_stock`/`transfer_stock`, still = Σ holdings for the (now merged) item. **We do NOT switch to a computed/derived on-hand.** Because the merged item's scalar is still the sum of its holdings, and quantity_change still sums to it, **the 0224-0230 snapshot stack, valuation (0227), reorder, dashboards, and mobile keep reading `quantity_on_hand` unchanged.** This is what makes Model B feasible without rewriting every count read. The only reads that change are the ones that want a *per-charter* or *per-holding* slice (the breakdown, charter-scoped views).

### 3.3 Charter moves item → holding (the real semantic shift)
`inventory_items.charter_id` is retired as the source of truth for "where stock belongs." Consequences that MUST be handled:
- **RLS charter-scoping** (0229 `inventory_items_select`): item visibility for a charter-restricted user becomes "the item has ≥1 holding in a charter the user may access." This is an RLS redesign (item-level charter predicate → EXISTS-over-holdings predicate). Highest-care item.
- **"By charter" reads**: valuation-by-charter, reports, filters, the charter dropdown on the Items list — all move from item.charter to holding.charter.
- Item CREATE no longer takes a single charter; charter is supplied when stock is placed (receipt/put-away/import destination).

### 3.4 Import, fulfillment, scan become holding-aware
- **Import (revises Phase 1):** an inventory line adds/creates the ONE SKU item (match by SKU/barcode → the single item; advisory suggestion from Phase 1 survives), and the received qty becomes a **holding** tagged with the import's chosen charter+location+rack. "Create a new item per charter" (Phase 1's default) becomes "add a holding to the SKU item." Phase 1's advisory matching + friendly errors carry forward.
- **Fulfillment:** an order draws from a SPECIFIC holding (charter/rack) — the pick step chooses which (user or pick rule). That holding decrements; total re-sums. (Same-SKU ambiguity is resolved by picking the holding.)
- **Scan-to-adjust:** a scanned SKU/barcode resolves to the ONE item, then the user picks WHICH holding (charter/rack) to adjust — fixing the current "arbitrary `.limit(1)` picks a random same-SKU row" bug the blast-radius investigation found (`scan.tsx:192`, `api/v1/items/lookup`, `restore-points itemKey`).

### 3.5 Staging (absorbs the old "Phase 2")
"Received but not put away" and "awaiting conversion" become **holding kinds/locations** (staging/unplaced) — already how placement works. Owner's earlier decisions still hold: staged stock counts toward VALUE, excluded from AVAILABLE-to-pick until put-away; the amber "awaiting put-away" display already ships. No separate table needed — it's a holding at a staging location.

## 4. The merge migration (the highest-risk piece)

One-time, reversible, per-org data migration:
1. **Group** existing `inventory_items` by `(organization_id, sku)` where deleted_at IS NULL. Each group with >1 row is a merge set; pick a **survivor** (oldest by created_at, deterministic id tiebreak).
2. **Build holdings**: for each non-survivor row, its current placement (existing `item_stock_levels` rows + its `charter_id`) becomes holdings on the survivor, tagged with that row's charter and location/rack. Sum quantities into `(survivor, location, charter)` holdings.
3. **Remap all 23 FK tables** from each non-survivor id → survivor id (order lines, PO items, receipts, serial_registry, stock_movements, cycle_count_lines, reservations, bundles, price history, embeddings, …). stock_movements history is preserved (re-pointed to the survivor) so the ledger stays intact.
4. **Soft-delete** the non-survivor `inventory_items` rows (deleted_at set, or hard-delete after FK remap — TBD, prefer soft for reversibility).
5. **Recompute** each survivor's `quantity_on_hand` = Σ its holdings (a verification pass: it must equal the sum of the merged rows' on-hands — assert zero drift).
6. **Reversibility**: the migration writes a mapping table (`sku_merge_audit`: survivor_id, merged_id, org, qty, charter, timestamp) so a rollback can reconstruct. Run per-org behind an entitlement flag; verify one org (demo, then L4L) before fleet-wide.

**Safety gate:** before/after invariants — total unit count per org unchanged; Σ on-hand unchanged; no orphaned FKs; no holding sums drift. pgTAP + a live dry-run (counts only) per org.

## 5. Blast radius (what changes vs what's untouched)

**Untouched (thanks to keeping the scalar on-hand):** dashboards, snapshot rollups (0224-0230), valuation total (0227), reorder-by-item, forecasting, mobile item on-hand, exports — all keep reading `quantity_on_hand`.

**Must change:**
- RLS `inventory_items_select` charter branch → holdings-EXISTS predicate (crown-jewel; adversarial review + per-persona pgTAP).
- `item_stock_levels` +charter_id; unique key; `adjust_stock`/`transfer_stock`/`post_receipt_v2` write charter on the holding.
- Items list: charter column/filter + the per-holding breakdown reads holding.charter (not item.charter); one row per SKU.
- Item create/edit form: drop the single charter field; charter set at placement.
- Import: add-holding behavior (revise Phase 1 default).
- Fulfillment/pick: choose holding.
- Scan-to-adjust (mobile + web lookup): resolve to one item + pick holding (fixes the ambiguity bug).
- restore-points `itemKey` gains charter; snapshot format version bump.
- Cycle-count scan, PO receive scan: holding/charter-aware (bounded).

## 6. Phasing (each phase ships + verifies before the next)

- **Phase B0 (additive, no behavior change):** add `charter_id` to `item_stock_levels` (nullable), backfill existing holdings from their item's charter_id, keep everything else identical. Dual-source charter (item + holding agree). pgTAP.
- **Phase B1 (reads):** point the Items-list breakdown, charter filter, and "by charter" reads at holding.charter; RLS switches to holdings-EXISTS. On-hand scalar unchanged. Verify charter-restricted personas see the right stock.
- **Phase B2 (the merge):** run the merge migration per-org (demo → L4L → fleet) behind a flag, with the audit/rollback table and zero-drift verification.
- **Phase B3 (writes):** import adds-holding; fulfillment picks-holding; scan resolves-to-item-pick-holding; item form drops single-charter. Retire `inventory_items.charter_id` (or leave nullable/unused).
- Each phase: TDD, pgTAP for migrations, adversarial review, live demo-org verification, mobile parity.

## 7. Interaction with what already shipped

- **Phase 1 (advisory matching, live):** stays. Advisory matching + friendly errors carry forward. Its "create a separate item per charter" default is REPLACED in B3 by "add a holding." Net: Phase 1 was the right interim; B supersedes its identity direction, not its safety work.
- **Cancelled-PO value fix (0232), duplicate-SKU friendly error:** unaffected; stay.
- **The SKU-uniqueness index change (Model A path):** DROPPED — Model B consolidates duplicates rather than allowing more of them.

## 8b. OWNER ANSWERS (2026-07-08) → REVISED, NON-DESTRUCTIVE APPROACH (supersedes §3.3 & §4)

Owner answered the open questions; the answers steer Model B toward a **non-destructive
"grouped" implementation** rather than the destructive record-merge §4 assumed. Binding:

1. **SKU = the product; the same product lives on multiple racks under multiple charters, all one SKU.** (Confirmed the model.)
2. **Inventory VALUE stays as-is (whole).** Do NOT split value per-charter by default. ADD an OPTION in REPORT generation to compute value for a specific charter when needed. (Reporting filter only — no core valuation change.)
3. **Do NOT delete/merge records.** "Not sure we need to delete anything — just change what I'm asking for so it's reflected properly." → **No destructive merge migration.** Keep the existing per-(sku, charter, rack) `inventory_items` rows; treat EACH as a placement of the shared SKU. Model B is achieved by GROUPING same-SKU rows in the UI/counts, not by collapsing rows.
4. **Repeated rack numbers across charters are INTENTIONAL.** "rack 1-A / CVW" and "rack 1-A / CVSII" are legitimately distinct placements → a placement is unique by (sku, charter, rack). (My earlier "North Campus" example was the DEMO org; L4L North Region has no North Campus — use real L4L charters: CVW-Manchester, CVSII-Madera, CVLYII-Visalia, etc. in examples.)
5. **KEEP the charter field on the item.** "The charter field is fine — just make it work properly." → charter STAYS on the `inventory_items` row (per placement). Do NOT move charter to `item_stock_levels`. → **No RLS charter redesign, no charter-to-holdings migration.**

### Revised model (grouped, non-destructive) — this REPLACES §3.3 and §4:
- The per-(sku, charter, rack) `inventory_items` row IS the "holding". Each keeps its own `quantity_on_hand` scalar and its own `charter_id` (§5) — **unchanged storage, unchanged RLS, unchanged on-hand reads.**
- "One item per SKU" is delivered as a **grouping**: the Items list shows ONE row per SKU with the **summed total** (281), expandable to the per-(charter, rack) rows (75 / 100 / 106). No rows deleted or merged.
- **Product attributes are shared across a SKU's rows; placement attributes are per-row.** Shared (edit once → applies to every row of that SKU): name, description, category, unit cost, retail price, barcode, item_type, reorder settings. Per-row: charter, rack/location, quantity_on_hand. (This is what keeps the SKU "consistent" per answer 1 — editing the Chromebook's name/cost updates all its placements; editing a placement's charter/rack/qty is local.)
- **Import** finds-or-creates the row for the chosen (sku, charter, rack) and adds qty there (Phase 1 already creates per-charter rows — now they GROUP by SKU). The stock-impact preview shows BOTH the SKU aggregate (281 → 381) AND the specific placement it lands in (e.g. CVW-Manchester/1-A: 100 → 200) — resolving the "281 vs 100" confusion by showing both, honestly.
- **Scan-to-adjust / order fulfillment** resolve to the SKU, then pick WHICH placement (charter/rack) — fixing the arbitrary-`.limit(1)` same-SKU bug the blast-radius investigation found.
- **Reports**: add an optional "by charter" value/breakdown filter (answer 2).

### Why this is far safer than the merge:
No record deletion, no FK remap across 23 tables, no charter-to-holdings move, no RLS redesign, no on-hand-read rewrite. The change concentrates in: (a) SKU-grouping in the Items list + counts, (b) shared-vs-per-row field semantics on edit, (c) import find-or-create + aggregate preview, (d) scan/fulfillment placement-picking, (e) an optional per-charter report filter. Phasing collapses accordingly (no B2 merge phase).

### CONFIRMED (owner, 2026-07-08): shared-field propagation
Editing a SHARED product field (name, **SKU**, unit cost, description, category, retail price, barcode, reorder settings) on ANY placement updates ALL placements of that SKU — "that specific Chromebook always has the same SKU." Charter/rack/qty stay per placement. **Propagation key = the SKU** (all rows sharing the same org+sku are the same product). Editing the SKU itself re-keys the whole group (all placements move to the new SKU together).
**Deferred (YAGNI):** per-company configurability of this behavior — revisit when multi-tenant onboarding needs it; hardcode the propagate-by-SKU behavior for now.

## 8. Open questions for the owner

1. **Reorder points — per item or per charter?** On-hand-per-item drives reorder today (281 vs reorder point). Do you want per-charter reorder thresholds (North Campus low even if total is fine)? That needs holding-level reorder config (bigger). Default: keep per-item for now.
2. **Valuation by charter** — do you need inventory $ value broken out per charter (for chargebacks/reporting)? Easy once holdings carry charter, but confirm it's wanted.
3. **Merge of non-survivors** — soft-delete (reversible, recommended) vs hard-delete after remap?
4. **A SKU with the same rack under two charters** (your data: rack "1-A" appears under multiple charters) — confirm a holding is uniquely (item, location, charter), so "rack 1-A / North Campus" and "rack 1-A / CVSII" are two distinct holdings. (Spec assumes yes.)
5. **Item edit charter field** — remove entirely, or keep as a "default charter for new receipts" convenience? Recommendation: remove; charter is chosen at placement.
