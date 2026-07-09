-- Backorder exits — resume_fulfillment + close_partial.
--
-- The two manager exits from `backordered` (the third, cancel, is the
-- backorder-aware branch already in 0244). Both are additive: new SECURITY
-- DEFINER RPCs mirroring the auth/role/lock shape of approve_order_request and
-- cancel_order_request. See the 2026-07-09 partial-fulfillment spec §5.
--
--   resume_fulfillment(p_id) → pick_slip_generated. Reserve newly-available
--     stock up to each line's owed, reset the pick cycle, and re-open the
--     signature cycle so the NEXT hand-over can sign fresh (0244's
--     confirm_order_signature and generatePackingSlips both guard on
--     signed_at IS NULL). Refuses when no owed line has any fulfillable stock.
--
--   close_partial(p_id) → completed. Keep what shipped (quantity_fulfilled is
--     the record of what was provided), release any reservation on the
--     un-shipped remainder, no stock change.

-- ---------------------------------------------------------------------------
-- resume_fulfillment — fulfill the still-owed remainder of a backordered order.
-- ---------------------------------------------------------------------------
create or replace function public.resume_fulfillment(p_id uuid)
returns order_requests
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req             public.order_requests%rowtype;
  v_user            uuid := auth.uid();
  v_line            record;
  v_active_reserved numeric(14,4);
  v_available       numeric(14,4);
  v_reserve         numeric(14,4);
  v_total_reserved  numeric(14,4) := 0;
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
  if v_req.status <> 'backordered' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  for v_line in
    select l.id as line_id, l.item_id,
           greatest(coalesce(l.quantity_requested, 0) - coalesce(l.quantity_fulfilled, 0), 0) as owed
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    -- Fresh pick cycle for the next batch.
    update public.order_request_lines set quantity_picked = null where id = v_line.line_id;

    if v_line.owed > 0 then
      select coalesce(sum(quantity), 0) into v_active_reserved
        from public.stock_reservations
        where item_id = v_line.item_id and released_at is null;
      select quantity_on_hand into v_available
        from public.inventory_items where id = v_line.item_id;
      v_available := greatest(0, coalesce(v_available, 0) - v_active_reserved);
      v_reserve := least(v_line.owed, v_available);
      if v_reserve > 0 then
        insert into public.stock_reservations
          (organization_id, item_id, warehouse_id, order_request_id, quantity)
          values (v_req.organization_id, v_line.item_id, v_req.warehouse_id, p_id, v_reserve);
        v_total_reserved := v_total_reserved + v_reserve;
      end if;
    end if;
  end loop;

  -- Resume is only meaningful when something can actually be picked. The whole
  -- function (reservations + cycle resets) rolls back on this raise.
  if v_total_reserved <= 0 then
    raise exception 'no_fulfillable_stock' using errcode = 'P0001';
  end if;

  -- Re-open the signature cycle: clear the prior hand-over so the next batch's
  -- packing slip mints a fresh token and confirm_order_signature can sign again.
  update public.order_requests
    set status                     = 'pick_slip_generated',
        pick_slip_generated_at     = now(),
        pick_slip_generated_by     = v_user,
        signed_at                  = null,
        signature_token            = null,
        signature_token_expires_at = null,
        signed_by_name             = null,
        signed_by_email            = null,
        signature_data_url         = null,
        completed_at               = null,
        completed_by               = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

-- ---------------------------------------------------------------------------
-- close_partial — end a backordered order keeping what already shipped.
-- ---------------------------------------------------------------------------
create or replace function public.close_partial(p_id uuid)
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
  select * into v_req from public.order_requests where id = p_id for update;
  if not found then
    raise exception 'order_request_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_req.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status <> 'backordered' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Release any hold on the un-shipped remainder. No stock moves — the shipped
  -- goods already left and quantity_fulfilled stays as the record of what was
  -- provided.
  update public.stock_reservations
    set released_at = now(), released_reason = 'closed_partial'
    where order_request_id = p_id and released_at is null;

  update public.order_requests
    set status       = 'completed',
        completed_at = now(),
        completed_by = v_user
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;

grant execute on function public.resume_fulfillment(uuid) to authenticated, service_role;
grant execute on function public.close_partial(uuid) to authenticated, service_role;
