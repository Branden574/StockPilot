-- Backorder review follow-ups (adversarial review 2026-07-09).
--
-- 1. complete_picking one-click path CLAMPS to available stock. Before this, the
--    all-lines-NULL "manager one-click" branch staged the full owed qty
--    unconditionally; on an approve_partial (knowingly-short) order that made
--    adjust_stock try to draw more than on_hand and raise insufficient_stock,
--    aborting the whole RPC — so the exact orders approve_partial creates could
--    not be completed via one-click. Now it stages min(owed, available) where
--    available = on_hand − OTHER orders' active reservations, so a short order
--    ships what's there and backorders the rest. Explicit per-line picks are
--    unchanged.
--
-- 2. resume_fulfillment (a) guards item_warehouse_mismatch like approve/
--    approve_partial, and (b) clears assigned_picker_id so the resumed pick
--    cycle is a fresh claim (not silently locked to the original picker).

-- ---------------------------------------------------------------------------
-- 1. complete_picking — clamp the one-click batch to available stock.
-- ---------------------------------------------------------------------------
create or replace function public.complete_picking(p_order_id uuid)
returns order_requests
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_req            public.order_requests%rowtype;
  v_line           record;
  v_user           uuid := auth.uid();
  v_all_null       boolean;
  v_owed           numeric(14,4);
  v_batch          numeric(14,4);
  v_other_reserved numeric(14,4);
  v_available      numeric(14,4);
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
    select l.id                  as line_id,
           l.item_id             as item_id,
           l.quantity_picked     as picked,
           l.quantity_requested  as requested,
           l.quantity_fulfilled  as fulfilled,
           ii.quantity_on_hand   as on_hand
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_order_id
    order by l.item_id
    for update of ii
  loop
    v_owed := greatest(coalesce(v_line.requested, 0) - coalesce(v_line.fulfilled, 0), 0);

    if v_all_null then
      -- One-click: stage what's actually available so a short order backorders
      -- the remainder instead of crashing adjust_stock. available = on_hand net
      -- of OTHER orders' active holds (this order's own reservation is its to
      -- draw). Explicit per-line picks (else branch) trust the keyed qty.
      select coalesce(sum(quantity), 0) into v_other_reserved
        from public.stock_reservations
        where item_id = v_line.item_id
          and released_at is null
          and order_request_id <> p_order_id;
      v_available := greatest(0, coalesce(v_line.on_hand, 0) - v_other_reserved);
      v_batch := least(v_owed, v_available);
    else
      v_batch := least(coalesce(v_line.picked, 0), v_owed);
    end if;

    if v_batch > 0 then
      perform public.adjust_stock(
        v_line.item_id,
        -v_batch,
        'transfer',
        null,
        'Order pick (order_request ' || p_order_id::text || ')',
        null
      );
    end if;

    update public.order_request_lines
      set quantity_picked = v_batch
      where id = v_line.line_id;
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

-- ---------------------------------------------------------------------------
-- 2. resume_fulfillment — warehouse guard + clear the picker for a fresh claim.
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
    select l.id as line_id, l.item_id, ii.warehouse_id as item_warehouse,
           greatest(coalesce(l.quantity_requested, 0) - coalesce(l.quantity_fulfilled, 0), 0) as owed
    from public.order_request_lines l
    join public.inventory_items ii on ii.id = l.item_id
    where l.order_request_id = p_id
    order by l.item_id
    for update of ii
  loop
    -- Same warehouse guard the approve paths enforce: an item moved to another
    -- warehouse while backordered can't be fulfilled from this order's warehouse.
    if v_line.item_warehouse is distinct from v_req.warehouse_id then
      raise exception 'item_warehouse_mismatch'
        using errcode = 'P0001', detail = v_line.item_id::text;
    end if;

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

  if v_total_reserved <= 0 then
    raise exception 'no_fulfillable_stock' using errcode = 'P0001';
  end if;

  -- Re-open the signature cycle AND release the picker claim so the resumed
  -- batch is a fresh, unassigned pick anyone eligible can take.
  update public.order_requests
    set status                     = 'pick_slip_generated',
        pick_slip_generated_at     = now(),
        pick_slip_generated_by     = v_user,
        assigned_picker_id         = null,
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
