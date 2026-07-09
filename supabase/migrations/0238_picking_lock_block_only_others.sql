-- Corrects the picker-lock from 0237. 0237 rejected ANY non-manager pick on an
-- order that wasn't already assigned to the caller — including an UNASSIGNED
-- order. But the claim UI is not live yet, so that hard-blocked a staff picker's
-- first pick (they can't claim, can't pick), a live regression.
--
-- Correct semantic: block a non-manager ONLY when the order is claimed by
-- SOMEONE ELSE. An unassigned order is still pickable and AUTO-CLAIMS to the
-- picker via the existing coalesce(assigned_picker_id, auth.uid()) — which is
-- exactly what prevents a SECOND picker from touching it. So the anti-duplicate
-- guarantee holds (you can never pick an order already claimed by another user),
-- while the "must claim first" preference is enforced by the UI (the state
-- machine shows staff a Claim button instead of the pick UI until they claim).
-- Managers still bypass (override). Bodies are otherwise identical to 0237.

create or replace function public.partial_pick_line(p_line_id uuid, p_qty numeric)
 returns order_request_lines
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_line public.order_request_lines%rowtype;
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;

  select * into v_line from public.order_request_lines where id = p_line_id for update;
  if not found then
    raise exception 'order_request_line_not_found' using errcode = 'P0002';
  end if;
  select * into v_req from public.order_requests where id = v_line.order_request_id for update;

  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Picker lock: a non-manager may not pick an order claimed by ANOTHER user.
  -- Unassigned is allowed (auto-claims below); own claim is allowed.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and v_req.assigned_picker_id is not null
     and v_req.assigned_picker_id <> v_user then
    raise exception 'not_assigned_picker' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;
  if p_qty > v_line.quantity_requested then
    raise exception 'over_pick' using errcode = 'P0001',
      detail = format('Picked %s exceeds requested %s', p_qty, v_line.quantity_requested);
  end if;

  update public.order_request_lines
    set quantity_picked = p_qty,
        picked_at       = now(),
        picked_by       = v_user
    where id = p_line_id;

  if v_req.status = 'pick_slip_generated' and p_qty > 0 then
    update public.order_requests
      set status             = 'picking_in_progress',
          assigned_picker_id = coalesce(assigned_picker_id, v_user)
      where id = v_req.id;
  elsif p_qty > 0 and v_req.assigned_picker_id is null then
    update public.order_requests
      set assigned_picker_id = v_user
      where id = v_req.id;
  end if;

  select * into v_line from public.order_request_lines where id = p_line_id;
  return v_line;
end;
$function$;

create or replace function public.complete_picking(p_order_id uuid)
 returns order_requests
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_req       public.order_requests%rowtype;
  v_line      record;
  v_user      uuid := auth.uid();
  v_all_null  boolean;
  v_effective numeric(14,4);
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Picker lock: a non-manager may not complete an order claimed by ANOTHER user.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and v_req.assigned_picker_id is not null
     and v_req.assigned_picker_id <> v_user then
    raise exception 'not_assigned_picker' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  select bool_and(quantity_picked is null)
    into v_all_null
    from public.order_request_lines
    where order_request_id = p_order_id;
  v_all_null := coalesce(v_all_null, true);

  for v_line in
    select l.id          as line_id,
           l.item_id     as item_id,
           l.quantity_picked    as picked,
           l.quantity_requested as requested
    from public.order_request_lines l
    where l.order_request_id = p_order_id
    order by l.item_id
  loop
    if v_all_null then
      v_effective := coalesce(v_line.requested, 0);
    else
      v_effective := coalesce(v_line.picked, 0);
    end if;

    if v_effective > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_effective,
        'transfer',
        null,
        'Order pick (order_request ' || p_order_id::text || ')',
        null
      );
      update public.order_request_lines
        set quantity_fulfilled = v_effective,
            quantity_picked    = v_effective
        where id = v_line.line_id;
    elsif not v_all_null and v_line.picked is null then
      update public.order_request_lines
        set quantity_fulfilled = 0,
            quantity_picked    = 0
        where id = v_line.line_id;
    end if;
  end loop;

  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user,
        assigned_picker_id   = coalesce(assigned_picker_id, v_user)
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;
