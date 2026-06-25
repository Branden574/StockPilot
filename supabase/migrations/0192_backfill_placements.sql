-- 0192_backfill_placements.sql
-- Seed the per-location breakdown for existing stock so Σ levels = quantity_on_hand.
-- Each item's UNACCOUNTED remainder (on_hand - Σ existing levels) is placed into:
--   * a rack location derived from custom_fields (book_rack_number/row or
--     rack_number/row), creating that rack location under the item's warehouse, OR
--   * the warehouse Unplaced location when there is no rack, OR
--   * a per-org global Unplaced location when the item has no warehouse_id.
-- Idempotent: re-running adds nothing (remainder becomes 0).

do $$
declare
  it record;
  v_remainder numeric;
  v_rack_no text;
  v_rack_row text;
  v_loc uuid;
  v_org_unplaced uuid;
begin
  for it in
    select i.id, i.organization_id, i.warehouse_id, i.item_type,
           i.quantity_on_hand, i.custom_fields
    from public.inventory_items i
    where i.deleted_at is null
  loop
    -- Reset per-iteration vars so a prior row can't leak its location/rack.
    v_loc := null;
    v_rack_no := null;
    v_rack_row := null;

    select coalesce(sum(quantity),0) into v_remainder
      from public.item_stock_levels where item_id = it.id;
    v_remainder := it.quantity_on_hand - v_remainder;
    if v_remainder <= 0 then continue; end if;

    -- Derive rack from custom_fields (books use book_rack_*, products rack_*).
    if it.item_type = 'book' then
      v_rack_no  := nullif(trim(coalesce(it.custom_fields->>'book_rack_number','')), '');
      v_rack_row := nullif(trim(coalesce(it.custom_fields->>'book_rack_row','')), '');
    else
      v_rack_no  := nullif(trim(coalesce(it.custom_fields->>'rack_number','')), '');
      v_rack_row := nullif(trim(coalesce(it.custom_fields->>'rack_row','')), '');
    end if;

    if it.warehouse_id is not null and v_rack_no is not null then
      -- Find or create the rack location under this warehouse.
      select id into v_loc from public.locations
        where warehouse_id = it.warehouse_id and kind = 'rack'
          and coalesce(rack_number,'') = v_rack_no
          and coalesce(rack_row,'') = coalesce(v_rack_row,'')
          and deleted_at is null
        limit 1;
      if v_loc is null then
        insert into public.locations(organization_id, warehouse_id, name, type, kind, rack_number, rack_row)
        values (it.organization_id, it.warehouse_id,
                v_rack_no || coalesce('-'||v_rack_row,''), 'shelf', 'rack', v_rack_no, v_rack_row)
        returning id into v_loc;
      end if;
    elsif it.warehouse_id is not null then
      perform public.ensure_warehouse_placement_locations(it.warehouse_id);
      select id into v_loc from public.locations
        where warehouse_id = it.warehouse_id and kind = 'unplaced' and deleted_at is null limit 1;
    else
      -- No warehouse: one org-level Unplaced bucket (warehouse_id null).
      select id into v_org_unplaced from public.locations
        where organization_id = it.organization_id and warehouse_id is null
          and kind = 'unplaced' and deleted_at is null limit 1;
      if v_org_unplaced is null then
        insert into public.locations(organization_id, name, type, kind)
        values (it.organization_id, 'Unplaced', 'other', 'unplaced')
        returning id into v_org_unplaced;
      end if;
      v_loc := v_org_unplaced;
    end if;

    -- Fail-safe: if no location resolved (e.g. dangling warehouse_id), skip this
    -- item rather than aborting the whole backfill on the location_id NOT NULL
    -- constraint. The global invariant test surfaces any unaccounted remainder.
    if v_loc is null then continue; end if;

    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (it.organization_id, it.id, v_loc, v_remainder)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
  end loop;
end$$;
