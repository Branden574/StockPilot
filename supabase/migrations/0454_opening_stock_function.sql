-- 0454_opening_stock_function.sql
--
-- Opening stock is recorded through one stock-ledger function (docket S8).
-- A new item is inserted with nothing on hand, and its opening quantity, its
-- first holding and its 'initial' movement are written together, in one
-- transaction, by public.open_item_stock. Duplicate opens a copy's stock
-- through it. The file adds two functions (open_item_stock and
-- _opening_stock_location) and restates two (tg_seed_initial_level, which
-- now shares the location rule, and duplicate_inventory_item), with their
-- grants and comments.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
--   0. Preflight: refuse (55000, hint s8a_preflight, nothing applied) unless
--      duplicate_inventory_item is 0413's body and tg_seed_initial_level is
--      0199's (md5 pinned, with their security mode, search_path and owner),
--      and no function named open_item_stock or _opening_stock_location
--      exists in public, with any signature.
--   1. public._opening_stock_location(item): where an item's opening stock
--      lands. 0199's rule, moved out of the trigger so the trigger and the
--      new function share it: the item's primary location when it is a live,
--      non-staging location of the item's organization (and warehouse);
--      else the warehouse's Unplaced; else the organization's Unplaced,
--      created on demand (two openings that create it at once share the one
--      row: ON CONFLICT DO NOTHING, then read again). SECURITY DEFINER; only
--      the owner may execute it. It stays in public: the ledger schema's
--      functions are pinned as a set by other tests and queued files, and
--      with no API role able to execute it, public exposes nothing.
--   2. tg_seed_initial_level restated to call it. Same header, same
--      behaviour, still never blocks an insert.
--   3. public.open_item_stock(p_org_id, p_lines): the opening-stock ledger
--      function. SECURITY DEFINER, search_path public; executable by
--      authenticated and service_role, not by anon or PUBLIC.
--      Whole call:
--        42501 forbidden    no signed-in user, or no organization;
--        42501 forbidden    hint stock:adjust, unless the caller is staff or
--                           above in p_org_id and holds stock:adjust there
--                           (has_org_role(p_org_id, 'staff') and
--                           has_permission(p_org_id, 'stock:adjust'));
--        22023              p_lines is not an array, has more than 1,000
--                           lines, repeats an itemId, or a line's itemId is
--                           not a uuid or its quantity is not a number that
--                           is above 0 at four decimals, or its duplicateOf
--                           is not a uuid;
--        []                 an empty array writes nothing.
--      Per line, in itemId order, the item is locked FOR UPDATE by a query
--      that filters on p_org_id and on the caller as the item's creator (an
--      item of another organization or of another member is never locked):
--        P0002 item_not_found        no such item of the caller's in p_org_id;
--        42501 opening_stock_refused (detail: the item id) unless it was
--                                    created less than 15 minutes ago, it
--                                    is not deleted, it is not a kit, it has
--                                    nothing on hand, no movement and no
--                                    holding above 0;
--        42501 forbidden             hint warehouse_write, unless the caller
--                                    is a manager or above, the item has no
--                                    warehouse, or the caller may write its
--                                    warehouse (the item insert rule, 0298);
--        22023 invalid_duplicate_of  duplicateOf is the item itself, or not
--                                    an item of p_org_id the caller can read.
--      Then, for the line: the holding at _opening_stock_location (added to
--      any row already there), on-hand set to the quantity (updated_by the
--      caller), and one 'initial' movement attributed to the caller.
--      to_location_id names the holding's location when it is the item's
--      primary location, and is null otherwise (Unplaced). With duplicateOf
--      the movement carries reason duplicate_initial_count, reference_type
--      duplicate and reference_id duplicateOf (what Duplicate wrote before).
--      Returns one row per line: (opened_item_id, opened_location_id,
--      opened_movement_id). It never raises 40001 or 40P01 (PostgREST
--      retries those, 0367).
--   4. duplicate_inventory_item restated from 0413: the copy is inserted
--      with nothing on hand, and a quantity above 0 is opened through
--      open_item_stock with duplicateOf = the original. Same signature,
--      SECURITY INVOKER, search_path, owner and grants. The refusal of a
--      negative quantity stays.
--   5. Comments, then a PostgREST schema reload (the 0382 and 0400
--      precedent), so /rest/v1/rpc/open_item_stock answers at once, and
--      lock_timeout reset.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- Functions and comments only: CREATE OR REPLACE FUNCTION, REVOKE and GRANT
-- on a function, and COMMENT ON FUNCTION take no table lock. No trigger is
-- created or dropped, so there is no prelude. lock_timeout 900ms bounds
-- anything unforeseen, and is reset at the end. Proof:
-- scripts/db-concurrency/0454_migration_lock_footprint.sh; two openings that
-- meet: scripts/db-concurrency/0454_opening_races.sh.
--
-- ── ERRORS ────────────────────────────────────────────────────────────────
-- 55000 hint s8a_preflight: drift, or a second run; nothing applied.
-- 55P03: the 900 ms cap; nothing applied, run it again.
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- After 0413 (whose duplicate_inventory_item body it restates) and 0199,
-- 0359 and 0364. No queued migration restates, drops or pins
-- duplicate_inventory_item, tg_seed_initial_level or compensate_opening_stock,
-- or names open_item_stock or _opening_stock_location. The helpers this file
-- calls (has_org_role, has_permission, user_can_access_warehouse,
-- caller_can_read_item, ensure_warehouse_placement_locations) are called by
-- signature, so a queued restatement of any of them keeps working here.

set lock_timeout = '900ms';

-- ═══ 0. Preflight ═══════════════════════════════════════════════════════════
do $pre_s8a$
declare
  v_bad text := '';
  r     record;
begin
  for r in
    select v.sig, v.want_md5, v.want_definer, p.oid as poid, md5(p.prosrc) as got,
           p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
      from (values
        ('public.duplicate_inventory_item(uuid,jsonb)', 'da37e0e972ad359c59a0d110576e5560', false),
        ('public.tg_seed_initial_level()',              '79cff11b3a75138078a439d8ef176b83', true)
      ) v(sig, want_md5, want_definer)
      left join pg_proc p on p.oid = to_regprocedure(v.sig)
  loop
    if r.poid is null then
      v_bad := v_bad || format(' %s missing;', r.sig);
    elsif r.got <> r.want_md5
          or r.prosecdef <> r.want_definer
          or r.proconfig is distinct from array['search_path=public']
          or r.owner <> 'postgres' then
      v_bad := v_bad || format(' %s drifted (md5 %s, definer %s, config %s, owner %s);',
                               r.sig, r.got, r.prosecdef, r.proconfig, r.owner);
    end if;
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'open_item_stock') then
    v_bad := v_bad || ' public.open_item_stock already exists;';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = '_opening_stock_location') then
    v_bad := v_bad || ' public._opening_stock_location already exists;';
  end if;

  if v_bad <> '' then
    raise exception 'S8a preflight refused:%', v_bad
      using errcode = '55000', hint = 's8a_preflight';
  end if;
end;
$pre_s8a$;

-- ═══ 1. Where opening stock lands ══════════════════════════════════════════
create function public._opening_stock_location(p_item public.inventory_items)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc uuid;
begin
  -- The item's primary location, when it is a live, non-staging location of
  -- the item's own organization (and warehouse, when the item has one).
  if p_item.primary_location_id is not null then
    select id into v_loc from public.locations
      where id = p_item.primary_location_id
        and organization_id = p_item.organization_id
        and deleted_at is null
        and kind is distinct from 'staging'
        and (p_item.warehouse_id is null or warehouse_id is not distinct from p_item.warehouse_id)
      limit 1;
  end if;

  -- Else the warehouse's Unplaced location (created with Staging if needed).
  if v_loc is null and p_item.warehouse_id is not null then
    perform public.ensure_warehouse_placement_locations(p_item.warehouse_id);
    select id into v_loc from public.locations
      where warehouse_id = p_item.warehouse_id and kind = 'unplaced' and deleted_at is null
      limit 1;
  end if;

  -- Else the organization's Unplaced location (no warehouse), created on demand.
  if v_loc is null then
    select id into v_loc from public.locations
      where organization_id = p_item.organization_id and warehouse_id is null
        and kind = 'unplaced' and deleted_at is null
      limit 1;
    if v_loc is null then
      -- Two openings may create it at once: the second waits for the first's
      -- row, does nothing, and reads it.
      insert into public.locations(organization_id, name, type, kind)
      values (p_item.organization_id, 'Unplaced', 'other', 'unplaced')
      on conflict do nothing
      returning id into v_loc;
      if v_loc is null then
        select id into v_loc from public.locations
          where organization_id = p_item.organization_id and warehouse_id is null
            and kind = 'unplaced' and deleted_at is null
          limit 1;
      end if;
    end if;
  end if;

  return v_loc;
end;
$$;

revoke all on function public._opening_stock_location(public.inventory_items)
  from public, anon, authenticated, service_role;

-- ═══ 2. The seed trigger shares the rule ═══════════════════════════════════
create or replace function public.tg_seed_initial_level()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc uuid;
begin
  if coalesce(new.quantity_on_hand, 0) <= 0 then return new; end if;

  -- 0199's destination rule, shared with open_item_stock (0454).
  v_loc := public._opening_stock_location(new);

  insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
  values (new.organization_id, new.id, v_loc, new.quantity_on_hand)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  return new;
exception
  when others then
    -- Never block item creation on a seeding hiccup (mirror the 0188 trigger).
    raise warning 'seed initial level failed for item %: %', new.id, sqlerrm;
    return new;
end;
$$;

-- ═══ 3. open_item_stock ════════════════════════════════════════════════════
create function public.open_item_stock(p_org_id uuid, p_lines jsonb)
returns table (opened_item_id uuid, opened_location_id uuid, opened_movement_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_n    integer;
  v_line record;
  v_item public.inventory_items;
  v_loc  uuid;
  v_mov  uuid;
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_uid is null or p_org_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Staff or above, holding stock:adjust.
  if not (public.has_org_role(p_org_id, 'staff') and public.has_permission(p_org_id, 'stock:adjust')) then
    raise exception 'forbidden' using errcode = '42501', hint = 'stock:adjust';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_lines);
  if v_n = 0 then
    return;
  end if;
  if v_n > 1000 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;
  -- Every line is checked before anything is written or locked.
  if exists (
       select 1 from jsonb_array_elements(p_lines) e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e->'itemId') is distinct from 'string'
           or (e->>'itemId') !~ c_uuid
           or case when jsonb_typeof(e->'quantity') = 'number'
                   then round((e->>'quantity')::numeric, 4) <= 0
                   else true end
           or (e ? 'duplicateOf' and jsonb_typeof(e->'duplicateOf') <> 'null'
               and (jsonb_typeof(e->'duplicateOf') <> 'string' or (e->>'duplicateOf') !~ c_uuid))
     ) then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;
  if (select count(distinct lower(e->>'itemId')) from jsonb_array_elements(p_lines) e) <> v_n then
    raise exception 'duplicate_item' using errcode = '22023';
  end if;

  for v_line in
    select (e->>'itemId')::uuid as iid,
           round((e->>'quantity')::numeric, 4) as qty,
           (e->>'duplicateOf')::uuid as dup
      from jsonb_array_elements(p_lines) e
     order by 1
  loop
    select i.* into v_item
      from public.inventory_items i
     where i.id = v_line.iid
       and i.organization_id = p_org_id
       and i.created_by = v_uid
       for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002', detail = v_line.iid::text;
    end if;

    -- Only the caller's own new item (the query above), still empty, opens here.
    if v_item.created_at is null
       or v_item.created_at <= now() - interval '15 minutes'
       or v_item.deleted_at is not null
       or coalesce(v_item.is_bundle, false)
       or v_item.quantity_on_hand <> 0
       or exists (select 1 from public.stock_movements m where m.item_id = v_item.id)
       or exists (select 1 from public.item_stock_levels s
                   where s.item_id = v_item.id and s.quantity <> 0) then
      raise exception 'opening_stock_refused' using errcode = '42501', detail = v_item.id::text;
    end if;

    -- The item insert rule's warehouse arm (0298).
    if not (public.has_org_role(p_org_id, 'manager')
            or v_item.warehouse_id is null
            or public.user_can_access_warehouse(v_uid, v_item.warehouse_id, 'write')) then
      raise exception 'forbidden' using errcode = '42501', hint = 'warehouse_write',
        detail = v_item.id::text;
    end if;

    if v_line.dup is not null
       and (v_line.dup = v_item.id
            or not exists (select 1 from public.inventory_items o
                            where o.id = v_line.dup and o.organization_id = p_org_id)
            or not public.caller_can_read_item(v_line.dup)) then
      raise exception 'invalid_duplicate_of' using errcode = '22023', detail = v_line.dup::text;
    end if;

    v_loc := public._opening_stock_location(v_item);

    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (v_item.organization_id, v_item.id, v_loc, v_line.qty)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();

    update public.inventory_items
       set quantity_on_hand = v_line.qty,
           updated_by = v_uid
     where id = v_item.id;

    insert into public.stock_movements (
      organization_id, item_id, movement_type, quantity_change,
      previous_quantity, new_quantity, user_id, to_location_id,
      reason, reference_type, reference_id
    ) values (
      v_item.organization_id, v_item.id, 'initial', v_line.qty,
      0, v_line.qty, v_uid,
      case when v_loc = v_item.primary_location_id then v_loc end,
      case when v_line.dup is not null then 'duplicate_initial_count' end,
      case when v_line.dup is not null then 'duplicate' end,
      v_line.dup
    )
    returning id into v_mov;

    opened_item_id := v_item.id;
    opened_location_id := v_loc;
    opened_movement_id := v_mov;
    return next;
  end loop;
end;
$$;

revoke all on function public.open_item_stock(uuid, jsonb) from public, anon;
grant execute on function public.open_item_stock(uuid, jsonb) to authenticated, service_role;

-- ═══ 4. Duplicate opens its stock through open_item_stock ══════════════════
-- Restated from 0413 (md5 da37e0e972ad359c59a0d110576e5560). Changed: the
-- copy is inserted with 0 on hand, and the opening is open_item_stock's
-- (the last block). Everything else is 0413's text.
CREATE OR REPLACE FUNCTION public.duplicate_inventory_item(p_original_id uuid, p_overrides jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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

  -- A negative quantity is refused rather than clamped: silently turning -5
  -- into 0 would hand back an id for a row the caller did not ask for. Zero
  -- is allowed: a copy with no stock is the normal case and opens nothing.
  if v_qty < 0 then
    raise exception 'quantity_must_not_be_negative' using errcode = '22023';
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
  -- Never read variant_key from p_overrides (client-forgeable identity).
  v_variant_key := case
    when p_overrides ?| array['variant_size','variant_size_system','variant_width',
                              'variant_fit','variant_color','jersey_number']
      then null
    else v_original.variant_key
  end;

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
    -- Columns the copy carries as well:
    model_number, is_rental, shelf_life_days, expiry_policy,
    -- Phase 3 variant columns:
    group_id, variant_size, variant_size_original, variant_size_system,
    variant_width, variant_fit, variant_color, jersey_number, player_name,
    variant_key,
    -- 0413: the copy keeps the source's ordering visibility (a copy of a
    -- hidden item is hidden; public_visibility is still not copied).
    order_catalog_visible
  ) values (
    v_new_id, v_original.organization_id, v_original.warehouse_id,
    v_original.charter_id, v_new_sku, v_original.barcode,
    v_original.name, v_original.description, v_original.category_id,
    v_original.supplier_id, v_original.primary_location_id,
    -- 0454: the copy starts with nothing on hand; its stock opens below.
    v_original.unit_cost, v_original.retail_price, 0,
    v_original.reorder_point, v_original.reorder_quantity,
    v_original.unit_of_measure, v_new_bin, v_original.tracking_type,
    v_original.item_type, v_new_cf, v_original.status, v_uid, v_uid,
    v_original.model_number, v_original.is_rental,
    v_original.shelf_life_days, v_original.expiry_policy,
    v_original.group_id, v_variant_size, v_variant_size_original,
    v_variant_size_system, v_variant_width, v_variant_fit, v_variant_color,
    v_jersey_number, v_player_name, v_variant_key,
    v_original.order_catalog_visible
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

  -- 0454: the opening stock, its holding and its 'initial' movement are
  -- recorded together by the stock ledger's opening function, as the copy's
  -- creator. The movement names the original (reason duplicate_initial_count,
  -- reference duplicate) as before.
  if v_qty > 0 then
    perform public.open_item_stock(
      v_original.organization_id,
      jsonb_build_array(jsonb_build_object(
        'itemId', v_new_id, 'quantity', v_qty, 'duplicateOf', p_original_id)));
  end if;

  return v_new_id;
end;
$function$;

revoke all on function public.duplicate_inventory_item(uuid, jsonb) from public;
revoke all on function public.duplicate_inventory_item(uuid, jsonb) from anon;
grant execute on function public.duplicate_inventory_item(uuid, jsonb) to authenticated;

-- ═══ 5. Comments, then the schema reload ═══════════════════════════════════
comment on function public._opening_stock_location(public.inventory_items) is
  'Where an item''s opening stock lands (0199''s rule, shared since 0454): the '
  'primary location when it is a live, non-staging location of the item''s '
  'organization and warehouse; else the warehouse''s Unplaced; else the '
  'organization''s Unplaced, created on demand. Executable by the owner only.';

comment on function public.tg_seed_initial_level() is
  'AFTER INSERT on inventory_items (0199): an item inserted with stock gets its '
  'first holding at _opening_stock_location. The web app inserts items with '
  'nothing on hand and opens stock through open_item_stock (0454).';

comment on function public.open_item_stock(uuid, jsonb) is
  'Opening stock through the stock ledger (0454). p_lines is a JSON array of '
  '{itemId, quantity, duplicateOf?}, at most 1,000. For each of the caller''s '
  'own items created in the last 15 minutes that is not a kit and has no stock, '
  'no holding and no movement: the holding at _opening_stock_location, on-hand, '
  'and one ''initial'' movement attributed to the caller, in one transaction. '
  'Needs staff or above with stock:adjust, and write access to the item''s warehouse '
  'unless a manager. Returns (opened_item_id, opened_location_id, '
  'opened_movement_id) per line.';

comment on function public.duplicate_inventory_item(uuid, jsonb) is
  'Copies an item (0125, 0299, 0413). The copy is inserted with nothing on hand; '
  'a quantity above 0 is opened through open_item_stock (0454), with the '
  'original as the movement''s reference.';

notify pgrst, 'reload schema';

reset lock_timeout;
