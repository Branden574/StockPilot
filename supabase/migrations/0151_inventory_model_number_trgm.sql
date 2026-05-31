-- 0151_inventory_model_number_trgm.sql
-- Close the one remaining seq-scan gap in item search.
--
-- InventoryService.list searches model_number with a LEADING-wildcard
-- ilike '%term%' (alongside name/sku/barcode), but 0133 only built a btree
-- (organization_id, model_number) — a leading wildcard cannot use a btree, so
-- that single predicate falls back to a scan/filter while the other three
-- searched columns are already GIN-trigram-backed (0095). Add the matching
-- trigram index so all four searched columns behave consistently.
--
-- Partial (mostly-NULL column + live rows only) keeps the index tiny and the
-- write amplification negligible. Matches the 0095 idiom verbatim
-- (lower(col) + extensions.gin_trgm_ops). The 0133 btree
-- (inventory_items_model_number_idx) stays — it still serves exact / anchored
-- 'x%' lookups and org-scoped scans.

create extension if not exists pg_trgm with schema extensions; -- idempotent (already enabled by 0095)

create index if not exists inventory_items_model_number_trgm_idx
  on public.inventory_items
  using gin (lower(model_number) extensions.gin_trgm_ops)
  where model_number is not null and deleted_at is null;
