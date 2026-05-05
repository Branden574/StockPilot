-- 0020_item_type.sql
-- ─────────────────────────────────────────────────────────────────────
-- Adds inventory_items.item_type so we can split the UI into "Items"
-- and "Books" (and future "Assets" / "Consumables") while keeping all
-- rows in the same table — dashboard rollups (inventory_value, low
-- stock, out of stock, item_count) automatically include every type.
--
-- Existing rows backfill to 'product' since that's what they represent.
-- ─────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

alter table public.inventory_items
  add column if not exists item_type text not null default 'product'
    check (item_type in ('product', 'book', 'asset', 'consumable'));

create index if not exists inventory_items_item_type_idx
  on public.inventory_items(organization_id, item_type)
  where deleted_at is null;
