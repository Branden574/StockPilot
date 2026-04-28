-- ============================================================================
-- 0005_phase5_helpers.sql — Purchase order receive RPC + import helpers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- receive_purchase_order: atomically post received quantities, increment item
-- on-hand, write stock_movement ledger entries, and update PO status.
--
-- p_lines is a jsonb array shaped like:
--   [{"line_id": "uuid", "quantity": 5}, ...]
-- ----------------------------------------------------------------------------
create or replace function public.receive_purchase_order(
  p_po_id   uuid,
  p_lines   jsonb,
  p_notes   text default null
)
returns public.purchase_orders
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_po          public.purchase_orders%rowtype;
  v_user        uuid := auth.uid();
  v_line        record;
  v_total_lines int;
  v_full        boolean := true;
begin
  select * into v_po
  from public.purchase_orders
  where id = p_po_id
  for update;

  if not found then
    raise exception 'po_not_found' using errcode = 'P0002';
  end if;
  if not public.has_org_role(v_po.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_po.status in ('received', 'cancelled') then
    raise exception 'po_already_closed' using errcode = '22023';
  end if;

  for v_line in
    select
      (elem->>'line_id')::uuid       as line_id,
      (elem->>'quantity')::numeric   as qty
    from jsonb_array_elements(p_lines) elem
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      continue;
    end if;

    -- Update line and validate within bounds.
    update public.purchase_order_items
       set quantity_received = least(quantity_received + v_line.qty, quantity_ordered)
     where id = v_line.line_id
       and purchase_order_id = p_po_id
     returning item_id into v_line.line_id;

    if not found then
      raise exception 'line_not_found' using errcode = 'P0002';
    end if;

    -- Bump item quantity_on_hand and write a movement.
    perform public.adjust_stock(
      v_line.line_id,
      v_line.qty,
      'receive_po',
      v_po.destination_location_id,
      'PO ' || v_po.po_number,
      p_notes
    );
  end loop;

  -- Recompute status: full if every line is fully received.
  select count(*) into v_total_lines from public.purchase_order_items where purchase_order_id = p_po_id;

  if v_total_lines = 0 then
    v_full := false;
  else
    select bool_and(quantity_received >= quantity_ordered)
      into v_full
      from public.purchase_order_items
     where purchase_order_id = p_po_id;
  end if;

  update public.purchase_orders
     set status = case when v_full then 'received' else 'partially_received' end,
         received_at = case when v_full then now() else v_po.received_at end,
         updated_by = v_user,
         updated_at = now()
   where id = p_po_id
   returning * into v_po;

  return v_po;
end;
$$;

grant execute on function public.receive_purchase_order(uuid, jsonb, text) to authenticated;

-- ----------------------------------------------------------------------------
-- next_po_number: simple per-org sequential PO number generator.
-- Format: PO-YYYY-NNNN where NNNN is per-org count + 1.
-- ----------------------------------------------------------------------------
create or replace function public.next_po_number(p_org_id uuid)
returns text
language sql
stable
as $$
  select 'PO-' || to_char(now(), 'YYYY') || '-' || lpad(((
    select count(*) from public.purchase_orders where organization_id = p_org_id
  ) + 1)::text, 4, '0')
$$;

grant execute on function public.next_po_number(uuid) to authenticated;
