-- 0133_inventory_model_number.sql
--
-- Adds inventory_items.model_number — the manufacturer's per-SKU
-- product identifier (e.g. Beats Solo 3 = MX432LL/A).
--
-- Distinct from the other identifier columns:
--   sku         — our internal code (e.g. "SP-RUQPL-LJC")
--   barcode     — the scanned UPC/EAN/ISBN
--   model_number — what the manufacturer prints on the box (new)
--
-- Per-SKU (one canopy model has one model number) not per-unit
-- (which would be a serial number — out of scope, would require a
-- separate inventory_units table).
--
-- Backed by the UPC-lookup chain (UPCitemdb free trial → Gemini
-- description-only fallback) so the field can autofill when scanning
-- a new product. Existing rows stay NULL — fill going forward only.
-- See docs/superpowers/specs/2026-05-20-upc-lookup-and-model-number-design.md

alter table public.inventory_items
  add column if not exists model_number text;

-- Search index. Partial — most items won't have a model number,
-- and rows with NULL don't help search results, so the where-clause
-- keeps the index lean. Also scoped by organization_id since every
-- list query starts with that filter (matches our other inventory
-- indexes).
create index if not exists inventory_items_model_number_idx
  on public.inventory_items(organization_id, model_number)
  where model_number is not null and deleted_at is null;
