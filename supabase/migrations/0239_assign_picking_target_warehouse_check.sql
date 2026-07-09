-- assign_picking (0237) verified the ACTOR is a manager+ with warehouse write
-- and that the target is an accepted org member — but NOT that the TARGET can
-- actually pick at the order's warehouse. So a manager could assign an order in
-- warehouse A to a staffer scoped only to warehouse B: the assignment succeeds,
-- but every pick/complete by that staffer is rejected by the pick RPCs'
-- warehouse check, AND the picker-lock then blocks every other staffer — the
-- order is bricked for all staff until a manager releases/reassigns it.
--
-- Fix: assign_picking now also requires the TARGET to have write access to the
-- order's warehouse (user_can_access_inventory), raising 'invalid_picker'
-- otherwise. Body is otherwise identical to 0237.

create or replace function public.assign_picking(p_order_id uuid, p_user_id uuid)
 returns order_requests
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_req  public.order_requests%rowtype;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  -- Only a manager+ (with warehouse write) may assign/reassign a picker.
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', detail = v_req.status;
  end if;
  -- The target must be an accepted member of the same org…
  if not exists (
    select 1 from public.organization_members
    where organization_id = v_req.organization_id
      and user_id = p_user_id
      and accepted_at is not null
  ) then
    raise exception 'invalid_picker' using errcode = 'P0001';
  end if;
  -- …AND must have write access to the order's warehouse, so we never lock an
  -- order to a picker the pick RPCs would then reject (bricking it for everyone).
  if not public.user_can_access_inventory(p_user_id, v_req.warehouse_id, null, 'write') then
    raise exception 'invalid_picker' using errcode = 'P0001';
  end if;

  update public.order_requests
    set assigned_picker_id = p_user_id,
        picking_claimed_at = now(),
        picking_claimed_by = v_user
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;
