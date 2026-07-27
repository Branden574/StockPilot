-- 0299_duplicate_inventory_item_variants.sql
--
-- Re-bodies duplicate_inventory_item so a duplicated VARIANT stays inside its
-- product group.
--
-- Drift check before writing this file: pg_get_functiondef() of the live
-- function on a freshly reset local database is BYTE-IDENTICAL to the body in
-- 0125_duplicate_inventory_item.sql. No migration between 0125 and 0298
-- touches it, so this rewrite starts from the 0125 text plus a minimal delta.
--
-- The 0125 original uses an explicit 24-column INSERT list, so every column
-- added to inventory_items since then is silently dropped on duplicate. This
-- migration adds the Phase 3 variant columns AND closes the pre-existing gaps
-- that are plainly defects rather than intent:
--   * model_number   (0133) - a duplicated item losing its model number is a bug
--   * is_rental      (0131) - a duplicated rental asset must stay a rental
--   * shelf_life_days / expiry_policy (0162) - lot policy must survive a copy
--
-- Deliberately NOT copied (the DB default is correct for a fresh row):
--   zero_since, auto_archived, archived_at, awaiting_first_receipt,
--   last_priced_at, created_from_purchase_order_id, public_visibility /
--   public_display_name / public_description - a duplicate is a NEW row with
--   its own lifecycle and its own visibility decision, and inheriting
--   public_visibility would silently publish a copy to a public catalog.
--   is_bundle is also left at its default: a bundle item is a phantom row
--   synthesized from a `bundles` row (0040/0198), and a copy of it has no
--   bundles row of its own, so a duplicate must be an ordinary item.
--   search_vector / embedding are derived and are rebuilt by their own paths.
--
-- group_id is copied straight from the original: duplicating a variant means
-- "another placement/variant of the same product", never a new group. The
-- inventory_items_insert WITH CHECK arm added by 0298
-- (product_group_in_org(group_id, organization_id)) is satisfied for free,
-- because group_id and organization_id are copied from the same source row.
-- variant_size / jersey_number / variant_key are OVERRIDABLE via p_overrides
-- so "duplicate size 10 as size 11" works in one call.
--
-- Model B (0234) is untouched: the SKU and bin_location still come from
-- p_overrides and the (organization_id, sku, charter_id, bin_location)
-- NULLS NOT DISTINCT unique index still decides what is a legal placement.

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
  v_variant_size text;
  v_variant_size_original text;
  v_variant_size_system text;
  v_variant_width text;
  v_variant_fit text;
  v_variant_color text;
  v_jersey_number text;
  v_player_name text;
  v_variant_key text;
begin
  -- Defense-in-depth: function is only granted to `authenticated`, but
  -- a service_role/anomalous context would silently produce a NULL
  -- audit trail otherwise. Surface a clear error instead.
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

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

  -- Variant attributes: an override wins, otherwise inherit the original.
  -- Keyed on `p_overrides ? 'key'` rather than coalesce so an explicit JSON
  -- null CLEARS the field instead of silently inheriting it.
  v_variant_size := case when p_overrides ? 'variant_size'
    then nullif(p_overrides->>'variant_size', '') else v_original.variant_size end;
  v_variant_size_original := case when p_overrides ? 'variant_size_original'
    then nullif(p_overrides->>'variant_size_original', '')
    else v_original.variant_size_original end;
  v_variant_size_system := case when p_overrides ? 'variant_size_system'
    then nullif(p_overrides->>'variant_size_system', '')
    else v_original.variant_size_system end;
  v_variant_width := case when p_overrides ? 'variant_width'
    then nullif(p_overrides->>'variant_width', '') else v_original.variant_width end;
  v_variant_fit := case when p_overrides ? 'variant_fit'
    then nullif(p_overrides->>'variant_fit', '') else v_original.variant_fit end;
  v_variant_color := case when p_overrides ? 'variant_color'
    then nullif(p_overrides->>'variant_color', '') else v_original.variant_color end;
  v_jersey_number := case when p_overrides ? 'jersey_number'
    then nullif(p_overrides->>'jersey_number', '') else v_original.jersey_number end;
  v_player_name := case when p_overrides ? 'player_name'
    then nullif(p_overrides->>'player_name', '') else v_original.player_name end;
  v_variant_key := case when p_overrides ? 'variant_key'
    then nullif(p_overrides->>'variant_key', '') else v_original.variant_key end;

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

  -- Keep custom_fields.size in step with the first-class column during the
  -- dual-write window (migration 0302 backfills variant_size FROM this key):
  --   * a resolved size writes the key;
  --   * an EXPLICIT clear (p_overrides carries "variant_size": null) removes
  --     it, so the copy never keeps a size the column says it does not have;
  --   * a legacy row - no override, column already null - is LEFT ALONE, so a
  --     pre-0302 item whose only size lives in custom_fields.size does not
  --     lose it on duplicate.
  if v_variant_size is not null then
    v_new_cf := v_new_cf || jsonb_build_object('size', v_variant_size);
  elsif p_overrides ? 'variant_size' then
    v_new_cf := v_new_cf - 'size';
  end if;

  insert into public.inventory_items (
    id, organization_id, warehouse_id, charter_id, sku, barcode,
    name, description, category_id, supplier_id, primary_location_id,
    unit_cost, retail_price, quantity_on_hand, reorder_point,
    reorder_quantity, unit_of_measure, bin_location, tracking_type,
    item_type, custom_fields, status, created_by, updated_by,
    -- Pre-existing gaps closed by this migration:
    model_number, is_rental, shelf_life_days, expiry_policy,
    -- Phase 3 variant columns:
    group_id, variant_size, variant_size_original, variant_size_system,
    variant_width, variant_fit, variant_color, jersey_number, player_name,
    variant_key
  ) values (
    v_new_id, v_original.organization_id, v_original.warehouse_id,
    v_original.charter_id, v_new_sku, v_original.barcode,
    v_original.name, v_original.description, v_original.category_id,
    v_original.supplier_id, v_original.primary_location_id,
    v_original.unit_cost, v_original.retail_price, v_qty,
    v_original.reorder_point, v_original.reorder_quantity,
    v_original.unit_of_measure, v_new_bin, v_original.tracking_type,
    v_original.item_type, v_new_cf, v_original.status, v_uid, v_uid,
    v_original.model_number, v_original.is_rental,
    v_original.shelf_life_days, v_original.expiry_policy,
    v_original.group_id, v_variant_size, v_variant_size_original,
    v_variant_size_system, v_variant_width, v_variant_fit, v_variant_color,
    v_jersey_number, v_player_name, v_variant_key
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
      previous_quantity, new_quantity, user_id, to_location_id, reason,
      reference_type, reference_id
    ) values (
      v_original.organization_id, v_new_id, 'initial', v_qty,
      0, v_qty, v_uid, v_original.primary_location_id,
      'duplicate_initial_count',
      'duplicate', p_original_id
    );
  end if;

  return v_new_id;
end;
$$;

revoke all on function public.duplicate_inventory_item(uuid, jsonb) from public;
revoke all on function public.duplicate_inventory_item(uuid, jsonb) from anon;
grant execute on function public.duplicate_inventory_item(uuid, jsonb) to authenticated;
