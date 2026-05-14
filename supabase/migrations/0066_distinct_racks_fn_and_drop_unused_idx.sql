-- 0066_distinct_racks_fn_and_drop_unused_idx.sql
-- Two cleanups in one migration since both are rack-infra cosmetic:
--
-- 1. Drop the items-side bin_location index added in 0061. Items
--    moved to reading rack from custom_fields.rack_number (indexed by
--    0062) so the lower(bin_location) index is dead code. The books
--    half of 0061 (inventory_items_org_book_rack_idx) is kept.
--
-- 2. Replace InventoryService.listDistinctRacks's in-JS dedupe with a
--    server-side DISTINCT. The old path SELECTed every non-deleted
--    org row's full custom_fields just to compute the dropdown
--    options — fine at current scale but quadratic with item count.
--    The RPC does the dedupe in Postgres and returns a sorted text[].
--
-- SECURITY INVOKER keeps RLS in force (the function reads from
-- inventory_items which is org-scoped at the row level). Execute is
-- granted to authenticated only.

drop index if exists public.inventory_items_org_bin_idx;

create or replace function public.inventory_distinct_racks(p_scope text)
returns text[]
language sql
security invoker
stable
as $$
  with src as (
    select
      case when p_scope = 'books'
           then custom_fields->>'book_rack_number'
           else custom_fields->>'rack_number'
      end as num,
      case when p_scope = 'books'
           then custom_fields->>'book_rack_row'
           else custom_fields->>'rack_row'
      end as rrow
    from public.inventory_items
    where deleted_at is null
      and (
        (p_scope =  'books' and item_type =  'book') or
        (p_scope <> 'books' and item_type <> 'book')
      )
  ),
  labeled as (
    select distinct
      case
        when nullif(trim(coalesce(rrow, '')), '') is null
          then trim(num)
        else trim(num) || '-' || trim(rrow)
      end as label
    from src
    where nullif(trim(coalesce(num, '')), '') is not null
  )
  select coalesce(array_agg(label order by label), '{}')::text[] from labeled;
$$;

revoke all on function public.inventory_distinct_racks(text) from public;
revoke all on function public.inventory_distinct_racks(text) from anon;
grant execute on function public.inventory_distinct_racks(text) to authenticated;
