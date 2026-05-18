-- 0125_duplicate_inventory_item.sql
-- Adds duplicate_inventory_item(p_original_id uuid, p_overrides jsonb)
-- which clones an inventory_items row to a new physical location.
--
-- Overrides JSON shape:
--   {
--     "sku":              text,         -- pre-computed by caller (suffixed)
--     "quantity":         numeric,      -- default 0
--     "rack_number":      text,         -- items branch
--     "rack_row":         text|null,    -- items branch (optional)
--     "book_rack_number": text,         -- books branch
--     "book_rack_row":    text|null,    -- books branch (optional)
--     "book_crate_color": text,         -- books branch
--     "book_crate_number":text,         -- books branch
--     "bin_location":     text          -- pre-rendered label
--   }
--
-- Returns: the new item's id.
--
-- Atomicity: item insert + item_tags copy + item_images copy + optional
-- stock_movements row all run inside the implicit RPC transaction. Any
-- failure rolls back. SKU uniqueness is enforced by the existing
-- (organization_id, sku) constraint; we surface 23505 as a friendly
-- error code so the action layer can translate it.

create or replace function public.duplicate_inventory_item(
  p_original_id uuid,
  p_overrides   jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_new_id uuid := gen_random_uuid();
  v_original public.inventory_items%rowtype;
  v_qty numeric := coalesce((p_overrides->>'quantity')::numeric, 0);
  v_new_sku text := nullif(p_overrides->>'sku', '');
  v_new_bin text := nullif(p_overrides->>'bin_location', '');
  v_new_cf jsonb;
  v_uid uuid := auth.uid();
begin
  -- Load + lock the original row. RLS scopes this to the caller's
  -- accessible warehouses, so a cross-warehouse caller hits not-found
  -- here rather than ever reading the source row.
  select * into v_original
  from public.inventory_items
  where id = p_original_id and deleted_at is null
  for share;

  if not found then
    raise exception 'original_not_found' using errcode = 'P0002';
  end if;
  if v_new_sku is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  -- Compose custom_fields: copy original blob, then overwrite the
  -- location keys (items vs books branch).
  v_new_cf := coalesce(v_original.custom_fields, '{}'::jsonb);
  if v_original.item_type = 'book' then
    v_new_cf := (v_new_cf
                 - 'book_rack_number'
                 - 'book_rack_row'
                 - 'book_crate_color'
                 - 'book_crate_number')
                || jsonb_strip_nulls(jsonb_build_object(
                     'book_rack_number',  p_overrides->>'book_rack_number',
                     'book_rack_row',     p_overrides->>'book_rack_row',
                     'book_crate_color',  p_overrides->>'book_crate_color',
                     'book_crate_number', p_overrides->>'book_crate_number'
                   ));
  else
    v_new_cf := (v_new_cf - 'rack_number' - 'rack_row')
                || jsonb_strip_nulls(jsonb_build_object(
                     'rack_number', p_overrides->>'rack_number',
                     'rack_row',    p_overrides->>'rack_row'
                   ));
  end if;

  insert into public.inventory_items (
    id, organization_id, warehouse_id, charter_id, sku, barcode,
    name, description, category_id, supplier_id, primary_location_id,
    unit_cost, retail_price, quantity_on_hand, reorder_point,
    reorder_quantity, unit_of_measure, bin_location, tracking_type,
    item_type, custom_fields, status, created_by, updated_by
  ) values (
    v_new_id, v_original.organization_id, v_original.warehouse_id,
    v_original.charter_id, v_new_sku, v_original.barcode,
    v_original.name, v_original.description, v_original.category_id,
    v_original.supplier_id, v_original.primary_location_id,
    v_original.unit_cost, v_original.retail_price, v_qty,
    v_original.reorder_point, v_original.reorder_quantity,
    v_original.unit_of_measure, v_new_bin, v_original.tracking_type,
    v_original.item_type, v_new_cf, v_original.status, v_uid, v_uid
  );

  -- item_tags: parallel rows for every original tag.
  insert into public.item_tags (item_id, tag_id)
  select v_new_id, tag_id
  from public.item_tags
  where item_id = p_original_id;

  -- item_images: parallel rows pointing at the SAME storage_path / thumb.
  insert into public.item_images (
    organization_id, item_id, storage_path, thumb_path, lqip,
    alt, sort_order, is_primary
  )
  select v_original.organization_id, v_new_id, storage_path, thumb_path,
         lqip, alt, sort_order, is_primary
  from public.item_images
  where item_id = p_original_id;

  -- Initial stock movement when qty > 0 so the ledger + dashboard
  -- sparklines see the new on-hand value.
  if v_qty > 0 then
    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, user_id, to_location_id, reason
    ) values (
      v_original.organization_id, v_new_id, 'initial', v_qty,
      0, v_qty, v_uid, v_original.primary_location_id,
      'duplicate_initial_count'
    );
  end if;

  return v_new_id;
end;
$$;

revoke all on function public.duplicate_inventory_item(uuid, jsonb) from public;
revoke all on function public.duplicate_inventory_item(uuid, jsonb) from anon;
grant execute on function public.duplicate_inventory_item(uuid, jsonb) to authenticated;
