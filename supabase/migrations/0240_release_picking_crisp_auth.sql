-- release_picking (0237) guarded with:
--   if not (v_req.assigned_picker_id = v_user or has_org_role(...,'manager'))
-- When assigned_picker_id IS NULL (unassigned order) and the caller is a
-- non-manager, `NULL = v_user` is NULL, `NULL or false` is NULL, and `not NULL`
-- is NULL — so the IF does not fire and the function proceeds (a harmless no-op
-- clearing already-null columns, but it returns success to an unauthorized
-- caller instead of a clean forbidden). Tighten to crisp three-valued-safe auth:
-- a non-manager may release ONLY when they are the (non-null) assigned picker.

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
  -- Self-release (I am the CURRENT, non-null picker) OR a manager+. Written so a
  -- NULL assigned_picker_id can never satisfy the self-release branch.
  if not (
    (v_req.assigned_picker_id is not null and v_req.assigned_picker_id = v_user)
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
