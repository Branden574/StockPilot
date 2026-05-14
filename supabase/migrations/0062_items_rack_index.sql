-- 0062_items_rack_index.sql
-- Index backing the rack filter on regular (non-book) items. Mirrors
-- the book index added in 0061 but reads from a neutral key
-- (custom_fields.rack_number) so books keep their book_rack_* keys
-- and items get their own. No data migration needed — both keys live
-- in custom_fields and only one is populated per row.

create index if not exists inventory_items_org_rack_idx
  on public.inventory_items (
    organization_id,
    (custom_fields->>'rack_number')
  )
  where custom_fields->>'rack_number' is not null;
