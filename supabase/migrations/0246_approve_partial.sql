-- Approve-partial — the knowingly-short approval entry point (backorder Phase 2).
--
-- A permissive sibling of approve_order_request (0111): instead of raising
-- insufficient_stock when a line wants more than is available, it reserves
-- min(requested, available) per line and approves the order anyway. The order
-- then flows the normal pipeline and forks to `backordered` at hand-over for the
-- unreservable remainder (0244). The STRICT approve_order_request is left
-- untouched, so normal "Approve" still refuses short orders.
--
-- available = quantity_on_hand − Σ(active reservations for the item). At
-- pending_approval this order holds no reservations yet, so it never
-- double-counts itself. Manager+ only; same warehouse-match guard as approve.

create or replace function public.approve_partial(p_id uuid)
returns order_requests
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req             public.order_requests%rowtype;
  v_line            record;
  v_active_reserved numeric(14,4);
  v_available       numeric(14,4);
  v_reserve         numeric(14,4);
  v_user            uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id, l.quantity_requested,
           ii.quantity_on_hand, ii.warehouse_id as item_warehouse
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;

    select coalesce(sum(quantity), 0) into v_active_reserved
      from public.stock_reservations
      where item_id = v_line.item_id and released_at is null;

    -- Reserve only what's actually available; the rest becomes backorder.
    v_available := greatest(0, v_line.quantity_on_hand - v_active_reserved);
    v_reserve   := least(v_line.quantity_requested, v_available);
    if v_reserve > 0 then
      insert into public.stock_reservations
        (organization_id, item_id, warehouse_id, order_request_id, quantity)
        values (v_req.organization_id, v_line.item_id, v_req.warehouse_id, p_id, v_reserve);
    end if;
  end loop;

  update public.order_requests
    set status      = 'approved',
        approved_by = v_user,
        approved_at = now()
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

grant execute on function public.approve_partial(uuid) to authenticated, service_role;
