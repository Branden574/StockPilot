-- 0061_rack_filter_indexes.sql
-- Indexes backing the new rack/bin filter on the Inventory and Books
-- list pages. Both filters are org-scoped: regular items match on
-- bin_location (case-insensitive), books match on the
-- custom_fields.book_rack_number JSON field. Without these indexes the
-- filter does a full org scan.

create index if not exists inventory_items_org_bin_idx
  on public.inventory_items (organization_id, lower(bin_location))
  where bin_location is not null;

create index if not exists inventory_items_org_book_rack_idx
  on public.inventory_items (
    organization_id,
    (custom_fields->>'book_rack_number')
  )
  where custom_fields->>'book_rack_number' is not null;
