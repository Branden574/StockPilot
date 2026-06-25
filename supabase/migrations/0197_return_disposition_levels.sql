-- ============================================================================
-- 0197_return_disposition_levels.sql — process_return_disposition maintains
-- item_stock_levels in sync with quantity_on_hand.
--
-- WHY: Migration 0194 introduced apply_level_delta as the canonical helper for
-- keeping item_stock_levels authoritative. The existing process_return_disposition
-- (last defined in 0154) does inline on_hand updates and custom stock_movements
-- inserts but never calls apply_level_delta, so item_stock_levels diverges after
-- every return disposition:
--   RESTOCK: +qty 'return' on_hand update → the returned unit re-enters stock
--            but lands nowhere in item_stock_levels (Staging left stale/low).
--   SCRAP:   +qty 'return' THEN −qty 'loss' on_hand updates net to zero, but
--            without level calls the Staging level is neither incremented (for
--            the receive leg) nor decremented (for the loss leg), so it stays
--            correct by accident only — and any future item with pre-existing
--            placed stock would be mis-decremented if we used the wrong mode.
--
-- FIX: verbatim copy of the 0154 body with exactly TWO added perform calls:
--   1. After the +qty 'return' on_hand update + movement insert:
--        perform public.apply_level_delta(v_line.item_id, v_line.quantity, 'staging');
--      → returned unit lands in Staging (mode param is ignored for + deltas;
--        passing 'staging' is self-documenting but the mode only matters for − ).
--   2. After the −qty 'loss' on_hand update + movement insert (inside the scrap
--      block only):
--        perform public.apply_level_delta(v_line.item_id, -v_line.quantity, 'staging_first');
--      → the unit that just landed in Staging is drained out first, so scrap
--        nets the Staging level to ±0 (no stranded Staging unit).
--
-- This is DELTA-based (on_hand += qty / −= qty), matching apply_level_delta's
-- delta semantics, so Σlevels = on_hand holds without any reconcile step.
--
-- Everything else is UNCHANGED vs 0154: signature, security DEFINER,
-- search_path = public extensions, returned_quantity increment, status
-- transition received→closed, layer-2 backstop, RLS deny-DELETE, grant.
-- ============================================================================

create or replace function public.process_return_disposition(p_return_id uuid)
returns public.returns
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_return  public.returns%rowtype;
  v_user    uuid := auth.uid();
  v_line    record;
  v_item    public.inventory_items%rowtype;
  v_prev    numeric;
  v_new     numeric;
  v_fulfilled numeric(14,4);
  v_returned  numeric(14,4);
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  -- Lock the header so concurrent receive/close calls on the same return
  -- serialize; the applied latch on each line is the per-line guard.
  select * into v_return from public.returns where id = p_return_id for update;
  if not found then
    raise exception 'return_not_found' using errcode = 'P0002';
  end if;

  if not public.has_org_role(v_return.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Status gate: inventory only moves for a return that has actually been
  -- received. A return still in 'requested'/'approved' (never received) or in
  -- 'denied'/'cancelled' must never push stock — that would let a manager skip
  -- the approval/receipt workflow. 'closed' is already settled (this RPC moved
  -- it there); re-calling on a closed return is a no-op because every line's
  -- applied latch is true, but we still reject the transition explicitly so the
  -- received->closed move is the only path that mutates inventory. Mirrors
  -- cancel_order_request's invalid_status_transition guard (0137).
  if v_return.status <> 'received' then
    raise exception 'invalid_status_transition'
      using errcode = 'P0001', detail = v_return.status;
  end if;

  -- order by item_id keeps the per-item row-lock order stable across concurrent
  -- calls touching the same item (matches complete_picking / cancel_order_request).
  for v_line in
    select rl.id as line_id, rl.item_id, rl.quantity, rl.disposition,
           rl.order_request_line_id
    from public.return_lines rl
    where rl.return_id = p_return_id
      and rl.applied = false
    order by rl.item_id
  loop
    -- ── Layer-2 backstop (0154): re-assert the DURABLE budget for this source
    -- line BEFORE moving any stock. Lock the source line FOR UPDATE so concurrent
    -- dispositions for the same line serialise, then refuse if consuming this
    -- line's quantity would push returned_quantity past quantity_fulfilled. If it
    -- would, a header status was forged past the transition trigger / INSERT cap
    -- (e.g. a cancel→revive). Reading the durable returned_quantity (not a SUM
    -- over mutable return rows) means a revive cannot trick this check. Applies to
    -- scrap lines too — over-claiming a line at all is inconsistent, reject
    -- regardless of disposition.
    select orl.quantity_fulfilled, orl.returned_quantity
      into v_fulfilled, v_returned
    from public.order_request_lines orl
    where orl.id = v_line.order_request_line_id
    for update;
    if not found then
      raise exception 'order_request_line_not_found'
        using errcode = 'P0002', detail = v_line.order_request_line_id::text;
    end if;

    if v_returned + v_line.quantity > v_fulfilled then
      raise exception 'return_exceeds_fulfilled'
        using errcode = 'P0001',
              detail = format(
                'order_request_line %s: returned %s + %s exceeds fulfilled %s',
                v_line.order_request_line_id, v_returned, v_line.quantity, v_fulfilled
              );
    end if;

    -- Lock the item once for the whole (possibly two-movement) disposition.
    select * into v_item
    from public.inventory_items
    where id = v_line.item_id
    for update;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;

    -- Defence in depth: the line's item must belong to the return's org.
    if v_item.organization_id <> v_return.organization_id then
      raise exception 'cross_org_item' using errcode = '42501';
    end if;

    -- INVENTORY MODEL: the returned unit already left on-hand at fulfilment.
    --   RESTOCK → +qty 'return' (re-enters sellable stock; net vs fulfilment = 0).
    --   SCRAP   → +qty 'return' THEN -qty 'loss' (NET-ZERO receive-then-write-off;
    --             a bare -qty would DOUBLE-DECREMENT a unit already gone).
    v_prev := v_item.quantity_on_hand;
    v_new  := v_prev + v_line.quantity;
    update public.inventory_items
      set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
    where id = v_line.item_id;
    insert into public.stock_movements (
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, reference_type, reference_id, user_id
    ) values (
      v_return.organization_id, v_line.item_id, 'return',
      v_line.quantity, v_prev, v_new,
      'Return ' || v_line.disposition || ' (return ' || p_return_id::text || ')',
      'return', p_return_id, v_user
    );
    -- 0197: returned unit lands in Staging (+delta mirrors the on_hand increment above).
    perform public.apply_level_delta(v_line.item_id, v_line.quantity, 'staging');

    -- SCRAP: immediately write the received unit off as a 'loss' so the net
    -- effect on on-hand is zero (the unit is destroyed, it was never sellable).
    if v_line.disposition = 'scrap' then
      v_prev := v_new;
      v_new  := v_prev - v_line.quantity;
      if v_new < 0 then
        raise exception 'insufficient_stock' using errcode = 'P0001';
      end if;
      update public.inventory_items
        set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
      where id = v_line.item_id;
      insert into public.stock_movements (
        organization_id, item_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, reference_type, reference_id, user_id
      ) values (
        v_return.organization_id, v_line.item_id, 'loss',
        -v_line.quantity, v_prev, v_new,
        'Return scrap write-off (return ' || p_return_id::text || ')',
        'return', p_return_id, v_user
      );
      -- 0197: scrap loss drains Staging first (staging_first) so the unit that
      -- just landed in Staging is removed — net Staging change = 0 (no stranded unit).
      perform public.apply_level_delta(v_line.item_id, -v_line.quantity, 'staging_first');
    end if;

    -- Consume the durable budget (idempotent via the applied latch below).
    update public.order_request_lines
      set returned_quantity = returned_quantity + v_line.quantity
    where id = v_line.order_request_line_id;

    -- One-way latch: never apply a disposition twice.
    update public.return_lines
      set applied = true
      where id = v_line.line_id;
  end loop;

  -- Make the received->closed transition atomic with the inventory write: once
  -- stock has moved the return is settled, so close it in the same transaction.
  -- (The status guard above ensures we only ever reach here from 'received'.)
  update public.returns
    set status    = 'closed',
        closed_by = v_user,
        closed_at = now()
  where id = p_return_id;

  select * into v_return from public.returns where id = p_return_id;
  return v_return;
end;
$$;

-- The in-function manager check is the real gate (mirrors cancel_order_request,
-- granted to authenticated). Defensively strip the implicit PUBLIC grant + anon
-- per the SECURITY DEFINER hardening convention (0146).
revoke all on function public.process_return_disposition(uuid) from public, anon;
grant execute on function public.process_return_disposition(uuid) to authenticated;
