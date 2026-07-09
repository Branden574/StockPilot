-- Model B: a SKU may legitimately live in multiple PLACEMENTS — one row per
-- (charter, rack) — and the Items list groups them into a single product.
--
-- The old uniqueness index (0126) was (organization_id, sku, bin_location)
-- NULLS NOT DISTINCT. It leaves CHARTER out of the key, so two placements of
-- the SAME sku under DIFFERENT charters that happen to share a bin_location
-- (or both have an empty bin) collided — blocking the owner from unifying two
-- "same laptop model" rows onto one SKU, and blocking any org whose charters
-- reuse rack numbers (intentional: rack "1-A" exists under many charters).
--
-- Fix: add charter_id to the key. A placement is uniquely
-- (organization_id, sku, charter_id, bin_location). This is STRICTLY MORE
-- PERMISSIVE than the old index — every row set that satisfied the old
-- (org, sku, bin) uniqueness trivially satisfies (org, sku, charter, bin)
-- (the rows already differed on sku or bin, so they differ here too), so the
-- new index builds cleanly with no data migration and no possibility of a
-- pre-existing duplicate. It still forbids a TRUE duplicate — the same SKU at
-- the same charter AND the same rack — which is what "unique per placement"
-- means.
--
-- NULLS NOT DISTINCT keeps the bulk-import dedup guarantees intact: generic
-- stock (charter NULL, bin NULL) is still one row per SKU, and two rows that
-- are both "no charter, no rack" for a SKU still collide.

drop index if exists inventory_items_org_sku_bin_unique;

create unique index if not exists inventory_items_org_sku_charter_bin_unique
  on public.inventory_items (organization_id, sku, charter_id, bin_location)
  nulls not distinct
  where deleted_at is null;
