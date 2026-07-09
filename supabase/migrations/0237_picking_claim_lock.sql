-- Picking assignment / claim / lock — backend core.
-- Prevents two warehouse users from picking the same order: an order in the
-- picking phase is CLAIMED by a staff picker or ASSIGNED by a manager+, then
-- LOCKED to that picker. Enforced server-side, race-safe.
--
-- Owner decisions: "admin" = manager+ (owner/admin/manager); staff must CLAIM
-- before picking; a picker may RELEASE their own claim.

-- ── 1) Claim provenance columns (assigned_picker_id already exists, 0109) ────
alter table public.order_requests
  add column if not exists picking_claimed_at timestamptz,
  add column if not exists picking_claimed_by uuid references public.user_profiles(id) on delete set null;

comment on column public.order_requests.picking_claimed_at is
  'When the current picker assignment was made (claim or admin-assign). Null = unassigned.';
comment on column public.order_requests.picking_claimed_by is
  'Who performed the current assignment: the picker themselves for a self-claim, or the manager for an admin-assign.';

-- ── 2) claim_picking: atomic self-claim, first-writer-wins ──────────────────
create or replace function public.claim_picking(p_order_id uuid)
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

  -- Row lock: two concurrent claims serialize here; the second waits, then
  -- reads the now-assigned row below and is rejected. This is the race guard —
  -- no frontend check is trusted.
  select * into v_req from public.order_requests where id = p_order_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition' using errcode = 'P0001', detail = v_req.status;
  end if;
  if v_req.assigned_picker_id is not null then
    -- Already claimed — the loser of the race. DETAIL carries the current picker.
    raise exception 'already_claimed' using errcode = 'P0001',
      detail = v_req.assigned_picker_id::text;
  end if;

  update public.order_requests
    set assigned_picker_id = v_user,
        picking_claimed_at = now(),
        picking_claimed_by = v_user
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;

-- ── 3) assign_picking: manager+ assign OR reassign to any member ────────────
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
  -- The target must be an accepted member of the same org.
  if not exists (
    select 1 from public.organization_members
    where organization_id = v_req.organization_id
      and user_id = p_user_id
      and accepted_at is not null
  ) then
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

-- ── 4) release_picking: the assigned picker (self) OR a manager+ ────────────
create or replace function public.release_picking(p_order_id uuid)
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
  if not public.user_can_access_inventory(v_user, v_req.warehouse_id, null, 'write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Self-release (I am the current picker) OR a manager+ releasing anyone's.
  if not (
    v_req.assigned_picker_id = v_user
    or public.has_org_role(v_req.organization_id, 'manager')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Picked quantities are preserved (work stays); only the assignment clears.
  update public.order_requests
    set assigned_picker_id = null,
        picking_claimed_at = null,
        picking_claimed_by = null
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$function$;

grant execute on function public.claim_picking(uuid)          to authenticated;
grant execute on function public.assign_picking(uuid, uuid)   to authenticated;
grant execute on function public.release_picking(uuid)        to authenticated;

-- ── 5) Picker LOCK on the pick RPCs (built on the 0236 warehouse-scoped defs) ─
-- A non-manager may pick/complete ONLY the order assigned to them (claim-before-
-- pick). Managers bypass (override). The existing coalesce(assigned_picker_id,
-- auth.uid()) still auto-stamps a manager who picks an unclaimed order.

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
  -- Picker lock: non-managers must be the assigned picker.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and (v_req.assigned_picker_id is null or v_req.assigned_picker_id <> v_user) then
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
  -- Picker lock: non-managers may only complete the order assigned to them.
  if not public.has_org_role(v_req.organization_id, 'manager')
     and (v_req.assigned_picker_id is null or v_req.assigned_picker_id <> v_user) then
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
