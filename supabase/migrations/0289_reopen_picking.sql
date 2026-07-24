-- Manager reopen-picking override: send a picked/packed (pre-signature) order
-- back to picking_in_progress to fix a miscount. Two parts:
--   1. Extend the transition trigger with the two backward edges (must match
--      packages/core/src/order-state-machine.ts, edited in the same change-set).
--   2. reopen_picking(p_id, p_reason) RPC that reverses complete_picking's
--      per-line stock draw, restores the released reservations, preserves
--      quantity_picked, and clears the packing-slip / signature-token cycle.
--
-- TWO CORRECTIONS TO THE DESIGN, both proved by 0289_reopen_picking.test.sql:
--
--   a. The reversal must return the units to a PICKABLE location. A plain
--      adjust_stock(item, +qty, …, p_location_id => null) lands them in Staging
--      (0194 apply_level_delta: "+ -> Staging"), and complete_picking draws with
--      mode 'placed', whose loop filters `l.kind <> 'staging'`. So the naive
--      reversal restores quantity_on_hand but strands the units where the
--      re-pick cannot reach them: the re-complete dies with
--      insufficient_placed_stock and the reopened order can never be finished.
--      Instead we hand adjust_stock the item's Unplaced bucket explicitly —
--      the same "we no longer know the bin, but it is pickable" destination
--      tg_seed_initial_level (0199) and the 0192 backfill use, and the bucket
--      apply_level_delta's placed draw-down visits last.
--
--   b. Un-releasing reservations is scoped to the CURRENT picking cycle.
--      complete_picking releases every active hold for the order, and
--      resume_fulfillment (0247) INSERTs a fresh set on each backorder resume
--      rather than reviving the old ones — so a resumed order carries several
--      generations of released rows. Un-releasing all of them would resurrect
--      superseded holds and silently over-reserve the item. released_at and
--      picking_completed_at are both stamped with now() inside the same
--      complete_picking transaction, so `released_at >= picking_completed_at`
--      selects exactly the generation this reopen is undoing.

-- 1. Transition trigger — add picking_complete → picking_in_progress and
--    packing_slip_generated → picking_in_progress. Full re-definition (the live
--    body verified against prod on 2026-07-23).
create or replace function public._validate_order_request_status_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_old text := old.status;
  v_new text := new.status;
  v_ok  boolean := false;
begin
  if v_old is not distinct from v_new then
    return new;
  end if;

  v_ok := case v_old
    when 'pending_confirmation'    then v_new in ('pending_approval', 'cancelled')
    when 'pending_approval'        then v_new in ('approved', 'denied', 'cancelled')
    when 'approved'                then v_new in ('pick_slip_generated', 'cancelled')
    when 'pick_slip_generated'     then v_new in ('picking_in_progress', 'picking_complete', 'cancelled')
    when 'picking_in_progress'     then v_new in ('picking_complete', 'cancelled')
    -- Manager reopen: picking_complete may rewind to picking_in_progress.
    when 'picking_complete'        then v_new in ('packing_slip_generated', 'picking_in_progress', 'cancelled')
    -- Manager reopen: packing_slip_generated may rewind to picking_in_progress.
    when 'packing_slip_generated'  then v_new in ('staged_for_pickup', 'staged_for_delivery', 'picking_in_progress', 'cancelled')
    -- Hand-over forks to backordered when units are still owed.
    when 'staged_for_pickup'       then v_new in ('completed', 'backordered', 'cancelled')
    when 'staged_for_delivery'     then v_new in ('in_transit', 'cancelled')
    when 'in_transit'              then v_new in ('completed', 'backordered', 'cancelled')
    -- Backorder exits: resume, close-partial, cancel.
    when 'backordered'             then v_new in ('pick_slip_generated', 'completed', 'cancelled')
    when 'completed'               then false
    when 'denied'                  then false
    when 'cancelled'               then false
    else false
  end;

  if not v_ok then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001',
            detail  = format('Cannot move order_request from %s to %s', v_old, v_new);
  end if;

  return new;
end;
$function$;

-- 2. reopen_picking RPC.
create or replace function public.reopen_picking(p_id uuid, p_reason text)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
  v_line record;
  v_loc  uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reopen_reason_required' using errcode = 'P0001';
  end if;

  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- signed_at is the ONLY correct is-signed predicate (physical signatures
  -- leave signature_data_url NULL). Defence in depth: these statuses are
  -- pre-signature already, but never let a signed order rewind.
  if v_req.signed_at is not null then
    raise exception 'already_signed' using errcode = 'P0001';
  end if;
  if v_req.status not in ('picking_complete', 'packing_slip_generated') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Reverse complete_picking's per-line stock draw. quantity_picked holds the
  -- exact drawn amount (complete_picking sets quantity_picked = v_batch after
  -- adjust_stock(-v_batch)). This writes a visible +movement, the inverse of
  -- the "Order pick" movement.
  --
  -- The units land in the item's Unplaced bucket, NOT the null-location default
  -- (see note (a) at the top): Staging is invisible to the 'placed' draw-down
  -- complete_picking uses, so a Staging reversal makes the order unfinishable.
  for v_line in
    select l.id                as line_id,
           l.item_id           as item_id,
           coalesce(l.quantity_picked, 0) as picked,
           ii.organization_id  as item_org,
           ii.warehouse_id     as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
  loop
    if v_line.picked > 0 then
      v_loc := null;
      if v_line.item_warehouse is not null then
        perform public.ensure_warehouse_placement_locations(v_line.item_warehouse);
        select id into v_loc from public.locations
          where warehouse_id = v_line.item_warehouse
            and kind = 'unplaced'
            and deleted_at is null
          limit 1;
      end if;
      if v_loc is null then
        perform public.ensure_org_placement_locations(v_line.item_org);
        select id into v_loc from public.locations
          where organization_id = v_line.item_org
            and warehouse_id is null
            and kind = 'unplaced'
            and deleted_at is null
          limit 1;
      end if;

      -- Both lookups failed to resolve an Unplaced bucket: refuse instead of
      -- falling through to adjust_stock's null-location default, which would
      -- silently land the reversal in Staging (see note (a) at the top) — the
      -- exact unfinishable-order failure mode this migration exists to prevent.
      if v_loc is null then
        raise exception 'unplaced_location_not_found'
          using errcode = 'P0002', detail = v_line.item_id::text;
      end if;

      perform public.adjust_stock(
        v_line.item_id,
        v_line.picked,
        'transfer',
        v_loc,
        'Reopen picking (order_request ' || p_id::text || ')',
        null
      );
    end if;
  end loop;

  -- Restore the reservations complete_picking released for THIS picking cycle.
  -- Scoped by picking_completed_at (see note (b) at the top) so a previously
  -- superseded generation of holds — left behind by a backorder resume — is not
  -- resurrected on top of the current one.
  update public.stock_reservations
    set released_at = null
    where order_request_id = p_id
      and released_at is not null
      and (v_req.picking_completed_at is null
           or released_at >= v_req.picking_completed_at);

  -- Rewind to picking_in_progress; preserve quantity_picked + assigned_picker_id;
  -- clear the packing-slip / signature-token cycle (voids the packing slip when
  -- reopening from packing_slip_generated; no-op columns are already NULL when
  -- reopening from picking_complete).
  update public.order_requests
    set status                     = 'picking_in_progress',
        picking_completed_at       = null,
        picking_completed_by       = null,
        packing_slip_generated_at  = null,
        packing_slip_generated_by  = null,
        signature_token            = null,
        signature_token_expires_at = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

grant execute on function public.reopen_picking(uuid, text) to authenticated;

comment on function public.reopen_picking(uuid, text) is
  'Manager override: rewind a picked/packed (pre-signature) order to '
  'picking_in_progress to fix a miscount. Reverses complete_picking''s stock '
  'draw (adjust_stock +quantity_picked into the item''s Unplaced bucket, so the '
  'units stay drawable by the re-pick), restores the reservations released by '
  'this picking cycle, preserves quantity_picked + assigned_picker_id, clears '
  'packing-slip/token fields. Refuses when signed_at is set. Reason required.';
