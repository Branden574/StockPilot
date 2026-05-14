-- 0068_set_rack_book_aware.sql
-- Two fixes around the rack feature:
--
-- 1. `inventory_set_rack` (added in 0064) hard-codes the neutral
--    `rack_number` / `rack_row` keys, but books use the legacy
--    `book_rack_number` / `book_rack_row` keys. When the bulk Set
--    rack action runs on a books-page selection, the values land
--    under the wrong custom_fields keys and are invisible to the
--    books rack filter. The function now takes a `p_scope` arg and
--    branches per row using `item_type`.
--
-- 2. Cleanup: any books rows that were bulk-set since 0064 shipped
--    have a `custom_fields.rack_number` we never intended to write.
--    Mirror that value into `book_rack_number` and strip the wrong
--    keys, so historical books data shows up in the books filter.
--
-- 3. `inventory_distinct_racks` (added in 0066) silently treats any
--    p_scope other than 'books' as items. Tighten to raise on
--    unknown values so caller bugs surface immediately.

-- Replace the function in place. SECURITY INVOKER preserved so RLS
-- still enforces org isolation on the underlying inventory_items.
create or replace function public.inventory_set_rack(
  p_item_ids       uuid[],
  p_rack_number    text,
  p_rack_row       text,
  p_bin_location   text,
  p_scope          text default 'items'  -- 'items' | 'books' | 'auto'
) returns integer
language plpgsql
security invoker
as $$
declare
  updated_count integer;
  uid uuid := auth.uid();
begin
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    return 0;
  end if;
  if p_scope not in ('items', 'books', 'auto') then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

  with merged as (
    update public.inventory_items ii
    set custom_fields = case
      -- Books branch: write book_rack_* keys.
      when (p_scope = 'books')
        or (p_scope = 'auto' and ii.item_type = 'book')
      then
        case
          when p_rack_number is null and p_rack_row is null then
            coalesce(ii.custom_fields, '{}'::jsonb)
              - 'book_rack_number' - 'book_rack_row'
          else
            (coalesce(ii.custom_fields, '{}'::jsonb) - 'book_rack_number' - 'book_rack_row')
              || jsonb_strip_nulls(
                   jsonb_build_object(
                     'book_rack_number', p_rack_number,
                     'book_rack_row',    p_rack_row
                   )
                 )
        end
      -- Items branch: write rack_* keys.
      else
        case
          when p_rack_number is null and p_rack_row is null then
            coalesce(ii.custom_fields, '{}'::jsonb)
              - 'rack_number' - 'rack_row'
          else
            (coalesce(ii.custom_fields, '{}'::jsonb) - 'rack_number' - 'rack_row')
              || jsonb_strip_nulls(
                   jsonb_build_object(
                     'rack_number', p_rack_number,
                     'rack_row',    p_rack_row
                   )
                 )
        end
      end,
        bin_location = p_bin_location,
        updated_by   = coalesce(uid, ii.updated_by),
        updated_at   = now()
    where ii.id = any(p_item_ids)
      and ii.deleted_at is null
    returning 1
  )
  select count(*)::integer into updated_count from merged;

  return coalesce(updated_count, 0);
end;
$$;

-- Old signature dropped — the new one with p_scope replaces it.
-- The 4-arg version (0064) is dropped first to avoid PostgREST
-- function-overload ambiguity. Callers must pass p_scope from now on
-- (default 'items' preserves the behavior for any caller that doesn't).
drop function if exists public.inventory_set_rack(uuid[], text, text, text);

revoke all on function public.inventory_set_rack(uuid[], text, text, text, text) from public;
revoke all on function public.inventory_set_rack(uuid[], text, text, text, text) from anon;
grant execute on function public.inventory_set_rack(uuid[], text, text, text, text) to authenticated;

-- One-time cleanup: mirror any orphaned `rack_number` keys on books
-- (created by the buggy 0064 set_rack before this fix) into the
-- correct `book_rack_number` keys, then strip the bad keys.
update public.inventory_items
set custom_fields = (
  (coalesce(custom_fields, '{}'::jsonb) - 'rack_number' - 'rack_row')
  || jsonb_strip_nulls(
       jsonb_build_object(
         'book_rack_number',
           coalesce(custom_fields->>'book_rack_number', custom_fields->>'rack_number'),
         'book_rack_row',
           coalesce(custom_fields->>'book_rack_row',    custom_fields->>'rack_row')
       )
     )
),
    updated_at = now()
where deleted_at is null
  and item_type = 'book'
  and (
    (custom_fields ? 'rack_number') or
    (custom_fields ? 'rack_row')
  );

-- Tighten inventory_distinct_racks to reject unknown scopes.
create or replace function public.inventory_distinct_racks(p_scope text)
returns text[]
language plpgsql
security invoker
stable
as $$
declare
  result text[];
begin
  if p_scope not in ('books', 'items') then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

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
  select coalesce(array_agg(label order by label), '{}')::text[]
    into result
  from labeled;

  return result;
end;
$$;
