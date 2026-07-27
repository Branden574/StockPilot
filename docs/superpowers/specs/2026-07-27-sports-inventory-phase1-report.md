# Sports Inventory — Phase 1: Current-Model Report & Architecture Fit

Audit of 2026-07-27 (workflow wf_4ebe1f44-07a: 6 area readers + synthesis; all
claims carry file/migration evidence — full detail in the session task output).
Companion to `2026-07-27-sports-inventory-requirements.md`.

## Root cause, one sentence

StockPilot has **no stored group/variant/unit identity anywhere** — "grouping"
is re-derived at render time from string conventions (exact-SKU match, then a
name-suffix size regex), while every stock-bearing structure and every
operational flow keys on a single flat `inventory_items` row.

## How the model works today (evidence-backed)

1. **Identity = Model B placements.** One flat `inventory_items` table; a row
   is a PLACEMENT, unique on (org, sku, charter_id, bin_location) NULLS NOT
   DISTINCT (0234:25-30). No product-group table, no variant table, no
   parent/child FK. Bundles are kits, not variants.
2. **Grouping is display-time only.** `group-by-sku.ts` collapses placements
   by exact SKU; `size-run.ts` derives a "style" by stripping a trailing size
   token off the item NAME (regex `6XL|5XL|…|XS|L|M|S`) — its own header
   admits it is display-only. Renaming an item silently breaks the family.
3. **Sizes.** `categories.supports_sizes` gates ONE thing: a create-time
   fan-out (`bulkCreateSizedVariants`) that inserts an independent row per
   size — size stored only in `custom_fields.size` (unindexed jsonb). The size
   vocabulary is a hardcoded apparel enum duplicated in ≥5 places that already
   disagree (web form offers 9 sizes; the server action zod caps at 7; plus
   the size-run regex, the 0284 CHECK, and mobile's own copy). No numeric/
   half/width shoe sizes. No jersey-number field anywhere. Instant Size Count
   (0283) is review-only by explicit owner decision.
4. **Serials.** `serial_registry` unique (org, item_id, serial) — per-item
   scope. The only tracking flag is per-item `tracking_type` in
   ('none','lot','serial') (0015); no isSerialized/requires_serial anywhere;
   categories carry zero tracking config. Serials are REQUIRED in exactly one
   path — `post_receipt_v2` (count must equal qty_accepted; rule re-asserted
   across five rewrites: 0015/0069/0190/0231/0285). Everywhere else they are
   optional/manual. Non-'none' tracking is additionally gated behind the
   `lot_serial` premium module, grandfathered OFF for every org (0162).
5. **Everything keys item_id.** item_stock_levels UNIQUE(item_id, location);
   the ledger invariant SUM(stock_movements) = quantity_on_hand; PO lines,
   receipt lines, cycle-count lines, order lines, reservations, and 6+
   pick/cancel/reopen RPCs all FK item_id.
6. **Imports.** The PO-imports chassis (staging status machine, claude-sonnet-5
   extraction with per-line confidence, needs_review UI, SHA256 idempotency
   with supersede lineage, suggestion-not-link discipline 0233) is prod-
   hardened but extracts a FLAT line schema — no size/variant/group fields.
   The generic items CSV import has no staging, no dedupe, hardcodes
   tracking 'none'. Photo→identity flows carry a reverse-verification
   hallucination guard.
7. **Mobile parity is by convention, not code**: `item/new.tsx` re-implements
   creation + the sized fan-out with raw Supabase writes and no shared zod.

## Why that cannot express sports products

A shoe style with per-size quantities has no group to roll up under and no
variant identity beyond a SKU-suffix convention; a (jerseyNumber, size)
variant has no home at all; PAIR semantics do not exist (`unit_of_measure` is
free text defaulting to 'unit'); a PO size run is only expressible as N
unrelated lines; and per-category tracking policy (the sports-only serial
exemption) has no place to live.

## Architecture fit (minimal delta — no parallel inventory system)

**Keep `inventory_items` as the ONLY stock-bearing entity; lay the hierarchy
over it.** GROUP = one new `product_groups` table (owns NO quantity, ever).
VARIANT = existing `inventory_items` rows (a SKU family under a group; one or
more placement rows per SKU, per Model B). UNIT = existing `serial_registry`
rows. Forced by the audit: every flow FKs item_id and the ledger invariant
makes inventory_items the mandatory quantity owner — "variants-as-items + a
group overlay is the only shape that leaves adjust_stock/apply_level_delta
untouched."

Whole schema delta:
- `product_groups` (org, category, name, style_code, …) + org RLS.
- `inventory_items` + `group_id` (null = untouched non-sports orgs),
  `variant_size` (backfilled/dual-written from custom_fields.size),
  `jersey_number` text (non-unique BY DESIGN — Model B key untouched).
- `categories` + `tracking_mode` CHECK (QUANTITY, QUANTITY_BY_VARIANT,
  NUMBERED_VARIANT, SERIALIZED, OPTIONAL_SERIALIZED, INDIVIDUALLY_TAGGED;
  null = QUANTITY; child inherits parent via the DORMANT `parent_id` that has
  existed since 0002 — subcategories are UI + inheritance work, zero schema),
  `size_scale_id`, `default_unit_of_measure` (PAIR rides existing uom).
- `size_scales` + ordered `size_scale_values` (apparel letters, numeric shoe
  with halves/widths, youth) — retiring five inconsistent hardcoded lists.
- `tracking_type` CHECK widened with `'serial_optional'`; ONE new branch in
  post_receipt_v2 (accept 0..qty serials). Category mode stamps per-item
  tracking_type at creation; the RPC's enforcement seam is unchanged.
- `serial_registry.location_id` (nullable) for INDIVIDUALLY_TAGGED; on-hand
  stays authoritative, units reconcile via report in phase 1.
- Imports: extend PO_SCHEMA/po_import_lines with size/jersey/style-hint;
  group-first matching; multi-candidate review.

## Top migration risks (each carries a mitigation in the plan)

Mobile parity drift (new.tsx raw writes — fix by moving it onto shared
schemas); post_receipt_v2's SIXTH full-body rewrite (pgTAP across all serial
paths); tracking_type enum ripple (5+ enumerator sites); name-heuristic
backfill would bake wrong groupings into persistent identity; custom_fields
dual-write drift; the Model B copy paths (duplicate_inventory_item, PO-import
create) must carry the new columns; lot_serial module gate blocks stamped
tracking types unless packaging decides otherwise; `database.ts` is `any`, so
pgTAP + service tests are the only net; Instant Size Count's style_key must
re-key to group_id or sports counts detach.

## Decisions taken on the evidence (owner may override)

Variants-as-items with a group overlay (forced by the ledger) · first-class
`variant_size`/`jersey_number` columns (custom_fields is unindexed and
unconstrained) · subcategories via the dormant `categories.parent_id` ·
category tracking_mode stamps per-item tracking_type (keeps the proven
post_receipt_v2 seam) · `serial_optional` as a tracking_type value · per-
category size scales · extend the po_imports chassis for variant import.

## Escalated to the owner

1. PAIR counting: uom convention vs first-class count-unit conversions.
2. Existing sized inventory: opt-in group linking with a review tool vs
   auto-backfill from the fragile name heuristic.
3. Packaging: a `sports` module granting its own serial modes vs depending on
   the grandfathered-off `lot_serial` premium module.
(Plus the requirements doc's §policy list: jersey number required?, player-
name grouping, colorway group-vs-variant, which size systems ship first.)
