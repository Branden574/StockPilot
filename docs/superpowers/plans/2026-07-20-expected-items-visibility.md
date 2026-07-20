# Expected-items visibility (hide never-received items until first receipt)

> Execute via SDD: Unit 1 (DB) first, then Units 2 (web) + 3 (mobile) in parallel worktrees, opus whole-branch review, ship + OTA. Base: main @ 309f350b.

**Owner report (2026-07-20, screenshots):** items auto-created from expected/inbound POs (e.g. PD 8/7 Lanyard, PD 8/7 Sticker, Clear Backpack via CVW vendor-feed POs) show on the Items list as "Out of stock" and on ordering surfaces before anything has arrived — people see the SKU and think "oh, it got delivered." Established items that are merely out of stock (Dell XPS) must remain visible.

**Owner decisions (AskUserQuestion):** (1) hidden ONLY until first receipt — the moment ANY units are received (even into staging), the item appears; (2) while hidden, admins reach them via an "Expected" filter chip on Items (like Archived), and they're excluded from ordering surfaces.

## Design
- **Marker:** `inventory_items.awaiting_first_receipt boolean not null default false`.
  - SET true at PO-driven item-creation paths: `createItemsFromPoLines` (import approve) and any integration/vendor-feed item creation (Unit 2 must grep the event-engine/connector paths). NOT set on manual item creation (even at qty 0) or CSV import.
  - CLEARED by trigger, not app code: `BEFORE UPDATE OF quantity_on_hand` on inventory_items — when `new.quantity_on_hand > 0 and old.awaiting_first_receipt`, set `new.awaiting_first_receipt := false` (any stock arriving by any path = no longer expected; mirrors the 0266 `_track_zero_since` column-trigger pattern, and remember pattern: column triggers fire on SET-list presence, so guard on VALUE not just presence).
  - Backfill (one-time, in-migration): flag items where quantity_on_hand <= 0 AND the item has ZERO stock_movements rows (never any stock event) AND an open inbound PO line references it (purchase_order_items joined to purchase_orders with status in draft/ordered/expected_inbound/partially_received). This catches the existing phantoms (PD 8/7 etc.) without touching established out-of-stock items (they have movement history).
- **Auto-archive interplay:** none — phantoms have `zero_since` NULL (created at zero, never crossed), so the 0266 cron already ignoreses them. State this in the migration comment.
- **Default-hidden surfaces** (`awaiting_first_receipt = false` added to predicates):
  - Web Items/Books lists (server loaders + instant dataset + counts) — plus a new "Expected" view chip alongside Active/Archived (mirrors the `?archived`/`?auto=1` pattern); chip shows the flagged items with an "Expected" pill; count badge on the chip.
  - Dashboard low-stock/out-of-stock widgets + counts (a phantom must not count as "out of stock").
  - Ordering surfaces: storefront/new-order catalog loaders (KEEP loaders in server/loaders/orders-new-catalog.ts per perf memory), order-create pickers, server-side order-request line validation (reject expected items with a clear message), B2B portal catalog, and the DB predicate `public_link_eligible_items` (public catalogs — mig 0261's single enforcement point).
  - Mobile Items/Books lists (default-hide + "Expected" filter in the filter sheet, per web-parity rule) + Expected pill on item detail.
- **Still visible:** PO/PO-imports screens (obviously), Staging (n/a — no stock yet), item DETAIL by direct link/search (shows an "Expected — awaiting first receipt" badge so context is instant), command palette search (admin tool).

## Units
1. **DB (mig 0277 + pgTAP):** column + partial index `(organization_id) where awaiting_first_receipt` + clear-trigger + backfill + `public_link_eligible_items` gains `and not awaiting_first_receipt` (keep it THE single public predicate). pgTAP: default false; trigger clears on qty rise (and NOT on a status-only update); backfill logic on fixtures (phantom flagged, established zero-qty item NOT flagged); public predicate excludes flagged items; 0207-style count updates if any.
2. **Web:** set-flag at both creation paths; loaders/filters/chip/badges/order-validation + tests (incl. "established zero-qty item still listed", "flagged item invisible by default, visible under Expected chip, rejected from order create with message").
3. **Mobile:** list default-hide + filter + detail pill + tests; regen typed routes if any new route (none expected).

## Global constraints
- Assistant applies mig 0277 to prod via `supabase db push --linked` after merge. Local pgTAP needs `supabase db reset`.
- Perf: no new per-row queries on the hot lists — the flag rides the existing selects; loaders stay module-level; instant-mode dataset carries the flag.
- NO Claude/Anthropic co-author trailer. OTA after merge; sim + live Demo Co/L4L verify (the PD 8/7 phantoms must vanish from default Items + orders and appear under Expected; receiving any unit must surface the item).
