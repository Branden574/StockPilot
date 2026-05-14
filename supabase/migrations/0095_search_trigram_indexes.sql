-- 0095_search_trigram_indexes.sql
-- pg_trgm GIN indexes for fast ilike on items / POs / suppliers.
-- Speeds up:
--   • the /api/items/search endpoint added alongside this migration
--   • the existing /api/search command-palette route (passively)
--   • InventoryService.list's `q` filter when called from page.tsx
--
-- All indexes are partial (only live rows) so they stay small. Wrap
-- the values in `lower(...)` to match the ilike pattern PostgREST
-- generates ("ilike" is already case-insensitive but indexes built
-- on lower(column) + gin_trgm_ops are the standard idiom and let the
-- planner pick the index reliably).

create extension if not exists pg_trgm with schema extensions;

create index if not exists inventory_items_name_trgm_idx
  on public.inventory_items
  using gin (lower(name) extensions.gin_trgm_ops)
  where deleted_at is null;

create index if not exists inventory_items_sku_trgm_idx
  on public.inventory_items
  using gin (lower(sku) extensions.gin_trgm_ops)
  where deleted_at is null;

create index if not exists inventory_items_barcode_trgm_idx
  on public.inventory_items
  using gin (lower(barcode) extensions.gin_trgm_ops)
  where deleted_at is null and barcode is not null;

create index if not exists purchase_orders_po_number_trgm_idx
  on public.purchase_orders
  using gin (lower(po_number) extensions.gin_trgm_ops);

create index if not exists suppliers_name_trgm_idx
  on public.suppliers
  using gin (lower(name) extensions.gin_trgm_ops)
  where deleted_at is null;
