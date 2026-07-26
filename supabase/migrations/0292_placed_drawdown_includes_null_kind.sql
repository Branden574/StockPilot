-- apply_level_delta's placed draw-down cannot see stock in a NULL-kind location,
-- so that stock is unpickable and picking dies with insufficient_placed_stock.
--
-- 0194 wrote the placed draw-down filter as `l.kind <> 'staging'`. locations.kind
-- is NULLABLE (0188 added it as `text check (kind in (...))`, with no NOT NULL and
-- no backfill), and in SQL `NULL <> 'staging'` is NULL, not TRUE — so every row
-- whose kind IS NULL is dropped by the WHERE clause. Stock parked in such a
-- location is invisible to the draw-down: complete_picking raises
-- insufficient_placed_stock and tells the operator to put away stock that is
-- already put away, with no bin they can move it out of to fix it.
--
-- NULL-kind locations are not an anomaly, they are the norm for anything created
-- before 0188 and for most locations created since:
--   * apps/web/src/server/actions/organization.ts and platform-admin.ts seed every
--     new org's first location ('Main Warehouse') with no kind at all.
--   * LocationsService.createLocationSchema (apps/web/src/server/services/
--     locations.ts) makes kind optional, so ordinary operator-created locations
--     are NULL-kind unless they are explicitly a rack/crate/area.
--
-- The rest of the system already treats NULL-kind as an ordinary placed bin, which
-- is what makes the SQL filter the outlier rather than the intent:
--   * 0194's own comment on the loop: "placed draw-down (racks/areas/crates first,
--     Unplaced last; never Staging)" — everything EXCEPT staging.
--   * 0199_seed_initial_level.sql selects the destination for a new item's opening
--     stock with `kind is distinct from 'staging'` and calls the result "a real,
--     non-staging placed bin" — i.e. it deliberately SEEDS stock into NULL-kind
--     locations that this draw-down then refuses to draw from.
--   * isUserFacingLocation() (locations.ts) is `kind !== 'staging' && kind !==
--     'unplaced'`, which in JS is TRUE for null. The two-valued mental model from
--     the TypeScript layer was carried into SQL, where it is three-valued.
--
-- Measured impact before this fix (read-only queries against production):
--   * L4L North Region, location 'DC4' (type warehouse, kind NULL, created
--     2026-05-28): 405 units across 7 items, unpickable the whole time.
--   * StockPilot Demo Co: 5 of its 8 active locations are NULL-kind ('Main
--     Distribution Center', 'Aisle A - Shelf 1', 'Receiving Dock', 'Aisle B -
--     Shelf 2', 'Returns Bin'), holding 2736 units across 29 items over 30
--     item_stock_levels rows -- i.e. essentially all demo stock, which is why
--     every demo-org order failed at complete_picking.
-- No data backfill of locations.kind is attempted here; whether those rows should
-- become kind='area' is a separate call for the owner. This changes query logic
-- only, so it is correct with or without such a backfill.
--
-- FIX: `l.kind is distinct from 'staging'` in the placed loop. IS DISTINCT FROM is
-- the NULL-safe inequality — it yields TRUE (not NULL) when the left side is NULL,
-- so NULL-kind rows are included and only literal 'staging' rows are excluded. It
-- is also the predicate 0199 already uses for exactly this question, so the two
-- halves of the placement model now agree. (coalesce(l.kind,'') <> 'staging' would
-- work too but reads as a workaround and hides the intent.)
--
-- This is a byte-for-byte copy of the live body — verified with
-- pg_get_functiondef() against production (md5 cc9613a32e3ad2d58ad361b8cfe0ed62,
-- 3157 bytes) and against the local DB, which match each other and 0194 exactly,
-- so no later migration had amended it — with exactly ONE predicate changed
-- (`l.kind <> 'staging'` -> `l.kind is distinct from 'staging'`) plus comments.
-- CREATE OR REPLACE preserves the existing ACL, so no re-grant is needed.
--
-- DELIBERATELY UNCHANGED — the other three places this function touches `kind`
-- are all correct under three-valued logic, and "fixing" them would break them:
--
--   1. INCREMENT branch (`kind = 'staging'`, both the warehouse-scoped and the
--      org-scoped lookup): a POSITIVE equality test that hunts for THE staging
--      bucket to land new stock in. NULL kind yields NULL, so a NULL-kind row is
--      not selected — which is right: a NULL-kind location is not the Staging
--      bucket and must never receive the auto-allocated increment.
--
--   2. staging_first pre-pass (`l.kind = 'staging'`): same positive equality,
--      draining only true Staging levels before falling through to the placed
--      loop. NULL-kind rows must NOT be drained here — they are placed stock, not
--      staging. They stay reachable in this mode because control then falls
--      through into the placed loop, which this migration repairs, so
--      'staging_first' gets the fix transitively without its own predicate moving.
--
--   3. ORDER BY (`case when l.kind = 'unplaced' then 1 else 0 end`): for a NULL
--      kind the WHEN is NULL, which is not TRUE, so the ELSE arm gives 0 — the
--      same rank as racks/areas/crates. NULL-kind rows therefore sort in the
--      first group and Unplaced stays strictly last, which is the documented
--      intent ("Unplaced last"). Left exactly as written: rewriting it as
--      `is not distinct from` would be behaviourally identical and pure diff
--      noise on a function this hot.

create or replace function public.apply_level_delta(
  p_item_id uuid,
  p_qty     numeric,
  p_mode    text default 'placed'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_take   numeric;
  v_lvl    record;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;
  if v_org is null then return; end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      -- `kind = 'staging'` is a positive match on THE staging bucket; NULL-kind
      -- rows are correctly not selected (they are placed bins, not Staging).
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
      -- Use SECURITY DEFINER helper to bypass locations_insert RLS (requires manager)
      -- so staff-role positive adjustments on warehouseless items also succeed.
      perform public.ensure_org_placement_locations(v_org);
      select id into v_loc from public.locations
        where organization_id = v_org and warehouse_id is null
          and kind = 'staging' and deleted_at is null limit 1;
    end if;
    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (v_org, p_item_id, v_loc, p_qty)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return;
  end if;

  -- ---- DECREMENT: draw down by mode --------------------------------------
  v_need := -p_qty;  -- positive amount to remove

  -- staging_first: drain the Staging level(s) before placed.
  -- `l.kind = 'staging'` again matches Staging ONLY. NULL-kind stock is placed
  -- stock and is intentionally left to the placed loop below.
  if p_mode = 'staging_first' then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  -- IS DISTINCT FROM, not <>: locations.kind is nullable and `NULL <> 'staging'`
  -- is NULL, which silently excluded every NULL-kind location and made the stock
  -- sitting in it unpickable (see this migration's header).
  -- The ORDER BY leaves NULL-kind rows in the `else 0` group, so real bins
  -- (including NULL-kind ones) are still visited before Unplaced.
  for v_lvl in
    select s.location_id, s.quantity
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = p_item_id and s.quantity > 0 and l.kind is distinct from 'staging'
     order by (case when l.kind = 'unplaced' then 1 else 0 end), l.created_at
  loop
    exit when v_need <= 0;
    v_take := least(v_lvl.quantity, v_need);
    update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
      where item_id = p_item_id and location_id = v_lvl.location_id;
    v_need := v_need - v_take;
  end loop;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
end;
$$;
