-- 0064_inventory_set_rack_fn.sql
-- Server-side atomic JSONB merge for bulk Set rack. The previous JS
-- read-modify-write loop in InventoryService.bulkUpdate (set_rack case)
-- could clobber concurrent edits to other custom_fields keys (author,
-- book_grade, thumbnail_url, etc.). This function does the merge in a
-- single UPDATE so concurrent writers don't overwrite each other.
--
-- SECURITY INVOKER so RLS applies (the caller's org / warehouse-write
-- gates still enforce on the inventory_items rows). Grant execute to
-- authenticated only; revoke from anon + public to keep PostgREST
-- exposure tight.

create or replace function public.inventory_set_rack(
  p_item_ids       uuid[],
  p_rack_number    text,
  p_rack_row       text,
  p_bin_location   text
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

  update public.inventory_items
  set custom_fields = case
    when p_rack_number is null and p_rack_row is null then
      coalesce(custom_fields, '{}'::jsonb) - 'rack_number' - 'rack_row'
    else
      (coalesce(custom_fields, '{}'::jsonb) - 'rack_number' - 'rack_row')
        || jsonb_strip_nulls(
             jsonb_build_object(
               'rack_number', p_rack_number,
               'rack_row',    p_rack_row
             )
           )
    end,
      bin_location = p_bin_location,
      updated_by   = uid,
      updated_at   = now()
  where id = any(p_item_ids)
    and deleted_at is null;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

revoke all on function public.inventory_set_rack(uuid[], text, text, text) from public;
revoke all on function public.inventory_set_rack(uuid[], text, text, text) from anon;
grant execute on function public.inventory_set_rack(uuid[], text, text, text) to authenticated;
