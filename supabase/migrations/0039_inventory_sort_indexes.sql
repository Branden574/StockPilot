-- 0039_inventory_sort_indexes.sql
-- Adds two partial indexes to cover the Name A→Z / SKU A→Z sort
-- options shipped in commit 6d7aaec (sort + multi-select filters).
-- Without these, sorting by name or SKU does a sort+filter without
-- index assistance — fine at hundreds of items, painful past 10k.
--
-- Existing org_status, low_stock, org_updated, search_vector,
-- charter, warehouse, item_type, tracking_type indexes already cover
-- the rest of the inventory list's hot paths.
--
-- Originally proposed as a materialized view for low-stock; downgraded
-- to plain indexes after audit confirmed the cross-column compare in
-- the existing low_stock RPC is already O(low-stock count) thanks to
-- inventory_items_low_stock_idx (0002_inventory.sql).

create index if not exists inventory_items_org_name_idx
  on public.inventory_items(organization_id, name)
  where status = 'active' and deleted_at is null;

create index if not exists inventory_items_org_sku_idx
  on public.inventory_items(organization_id, sku)
  where status = 'active' and deleted_at is null;

comment on index public.inventory_items_org_name_idx is
  'Covers ?sort=name_asc / name_desc on /dashboard/inventory + /dashboard/books';
comment on index public.inventory_items_org_sku_idx is
  'Covers ?sort=sku_asc / sku_desc on /dashboard/inventory + /dashboard/books';
