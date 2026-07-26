-- resume_fulfillment leaves a stale picking_completed_at / picking_completed_by
-- from the superseded pick cycle.
--
-- 0247 rewinds a backordered order back to pick_slip_generated for a fresh pick
-- cycle. Its final UPDATE clears the signature cycle (signed_at, the token
-- trio, signed_by_name/email, signature_data_url), assigned_picker_id, and
-- completed_at / completed_by — but it never touches picking_completed_at /
-- picking_completed_by. A resumed order therefore sits at pick_slip_generated,
-- with quantity_picked reset to null on every line and nothing drawn, while
-- still carrying "picking completed at <timestamp>" from the PREVIOUS cycle.
--
-- Impact is cosmetic today: the only consumer is the order-detail timeline row
-- in the web dashboard (apps/web/src/app/(dashboard)/dashboard/orders/[id]/
-- page.tsx, fed by apps/web/src/server/services/order-requests.ts). Nothing
-- reads picking_completed_at to gate behaviour any more —
-- 0290_cancel_restock_guard.sql moved cancel_order_request's restock guard to
-- order status specifically BECAUSE this field goes stale on resume, so
-- clearing it here is inert for that guard. Still worth fixing: a stale
-- completion timestamp on a not-yet-picked order is simply wrong, and
-- 0290_cancel_restock_guard.test.sql case E documented (and now must be
-- updated to reflect) the corrected behaviour.
--
-- This is a byte-for-byte copy of the live 0247 body (diffed against the
-- production function definition) with exactly two lines added to the final
-- UPDATE: picking_completed_at = null and picking_completed_by = null.

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
  -- batch is a fresh, unassigned pick anyone eligible can take. Also clear the
  -- PREVIOUS cycle's completion stamps: this order has nothing picked yet, so
  -- carrying forward "picking completed at <old timestamp>" from the
  -- superseded cycle is stale data, not history.
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
        completed_by               = null,
        picking_completed_at       = null,
        picking_completed_by       = null
    where id = p_id;

  select * into v_req from public.order_requests where id = p_id;
  return v_req;
end;
$function$;
