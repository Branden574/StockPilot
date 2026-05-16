-- 0118_complete_picking_defaults_to_requested.sql
--
-- Bug: the "Mark picking complete" button on the order detail page
-- calls complete_picking RPC directly, bypassing the digital pick UI.
-- Every order_request_lines row in that flow still has
-- quantity_picked IS NULL (column default; partial_pick_line was never
-- called). The original 0111 RPC body coalesces NULL → 0, so adjust_stock
-- gets a 0 delta and is skipped entirely. The order flips to
-- picking_complete with quantity_fulfilled = 0 and zero stock movement.
--
-- New semantic:
--   * quantity_picked IS NULL  → manager one-click flow on the detail
--                                page. Treat as "fulfill the full
--                                requested quantity" for that line.
--   * quantity_picked = 0       → digital pick UI explicitly wrote 0
--                                (picker found nothing on the shelf).
--                                Honor it — skip the line.
--   * quantity_picked > 0       → digital pick UI saved a real number.
--                                Decrement that exact amount.
--
-- The NULL fallback is gated on "every line is NULL." If even one line
-- has a non-NULL quantity_picked (signature of the digital pick flow),
-- we stay in strict mode so partial picks with intentionally-skipped
-- lines aren't silently fulfilled to their requested qty.

create or replace function public.complete_picking(p_order_id uuid)
returns public.order_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
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
  if not public.has_org_role(v_req.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_req.status not in ('pick_slip_generated', 'picking_in_progress') then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_req.status;
  end if;

  -- Detect the "manager one-click complete" shape: every line still
  -- has quantity_picked IS NULL because partial_pick_line was never
  -- called. In that case we treat the whole order as "everything
  -- picked exactly as requested."
  select bool_and(quantity_picked is null)
    into v_all_null
    from public.order_request_lines
    where order_request_id = p_order_id;
  -- empty order_request → bool_and returns null → coalesce to true
  -- (vacuously, every line is NULL); the loop below just won't run.
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
    -- Effective qty per the table at the top of this migration.
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
    end if;
  end loop;

  update public.stock_reservations
    set released_at = now()
    where order_request_id = p_order_id
      and released_at is null;

  update public.order_requests
    set status               = 'picking_complete',
        picking_completed_at = now(),
        picking_completed_by = v_user
    where id = p_order_id;

  select * into v_req from public.order_requests where id = p_order_id;
  return v_req;
end;
$$;

grant execute on function public.complete_picking(uuid) to authenticated;

comment on function public.complete_picking(uuid) is
  'Atomic stock decrement + reservation release + flip to '
  'picking_complete. If every line has quantity_picked IS NULL '
  '(manager one-click flow), falls back to quantity_requested per line; '
  'otherwise honors quantity_picked exactly (digital pick UI flow).';
