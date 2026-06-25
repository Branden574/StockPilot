-- 0196_cycle_count_levels.sql
-- ============================================================================
-- post_cycle_count v3 — keeps item_stock_levels in sync with on-hand.
--
-- What changed vs. 0079:
--   After updating quantity_on_hand (snapshot + variance), we call
--   apply_level_delta(v_line.item_id, v_diff, 'placed') so the
--   per-location breakdown tracks the on-hand total:
--     • Negative variance (v_diff < 0) → placed draw-down (racks first,
--       Unplaced last). Raises insufficient_placed_stock if not enough.
--     • Positive variance (v_diff > 0) → surplus routed to Staging by
--       apply_level_delta (positives always go to Staging regardless of mode).
--   Everything else is unchanged: snapshot-based variance, drift note in
--   stock_movements, custom audit row (reference_type='cycle_count'),
--   warehouse-scope guard, security invoker, search_path = public.
-- ============================================================================

create or replace function public.post_cycle_count(p_cycle_count_id uuid)
returns public.cycle_counts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cc            public.cycle_counts%rowtype;
  v_line          record;
  v_prev          numeric(14,4);
  v_current_wh    uuid;
  v_diff          numeric(14,4);
  v_drift         boolean;
begin
  select * into v_cc from public.cycle_counts where id = p_cycle_count_id for update;
  if not found then
    raise exception 'cycle_count_not_found' using errcode = 'P0002';
  end if;
  if v_cc.status <> 'in_progress' then
    raise exception 'cycle_count_not_open' using errcode = '22023';
  end if;
  if not public.has_org_role(v_cc.organization_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for v_line in
    select l.*
      from public.cycle_count_lines l
      join public.inventory_items   ii on ii.id = l.item_id
     where l.cycle_count_id = p_cycle_count_id
       and l.counted_quantity is not null
       and ii.deleted_at is null
  loop
    -- Lock the item row, read current qty + warehouse for drift check.
    select quantity_on_hand, warehouse_id
      into v_prev, v_current_wh
      from public.inventory_items
      where id = v_line.item_id
      for update;
    if not found then continue; end if;

    -- Mid-count warehouse move check. v_line.warehouse_id is set by
    -- start() (migration 0081) and pinned to the snapshot. If the item
    -- has moved out of the snapshot's warehouse, we refuse to post —
    -- adjusting the new warehouse from a count of the old one would
    -- corrupt stock in both. Manager re-runs the count for the new
    -- warehouse instead.
    if v_line.warehouse_id is not null
       and v_current_wh is distinct from v_line.warehouse_id then
      raise exception 'item_out_of_scope' using errcode = '22023';
    end if;

    -- Variance is computed against the SNAPSHOT, not the live qty.
    v_diff  := v_line.counted_quantity - v_line.expected_quantity;
    v_drift := (v_prev is distinct from v_line.expected_quantity);

    if v_diff = 0 then continue; end if;

    insert into public.stock_movements(
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, notes, user_id,
      reference_type, reference_id
    ) values (
      v_cc.organization_id, v_line.item_id, 'adjust',
      v_diff,
      v_line.expected_quantity,
      v_line.expected_quantity + v_diff,
      coalesce(v_line.reason, 'Cycle count adjustment'),
      case
        when v_drift then
          coalesce(v_line.notes || E'\n', '')
            || '[drift] live qty ' || v_prev::text
            || ' differed from snapshot ' || v_line.expected_quantity::text
            || ' at post time'
        else v_line.notes
      end,
      auth.uid(),
      'cycle_count', p_cycle_count_id
    );

    -- new on-hand = snapshot + variance. If live qty drifted, we
    -- intentionally do NOT re-add the drift on top — the UI promised
    -- the user this delta, that is what we post. Drift surfaces via
    -- the stock_movements note for follow-up.
    update public.inventory_items
      set quantity_on_hand = v_line.expected_quantity + v_diff,
          updated_by = auth.uid()
      where id = v_line.item_id
        and deleted_at is null;

    -- Keep the per-location breakdown in step with the on-hand change.
    perform public.apply_level_delta(v_line.item_id, v_diff, 'placed');
  end loop;

  update public.cycle_counts
    set status = 'completed',
        completed_at = now(),
        completed_by = auth.uid()
    where id = p_cycle_count_id
    returning * into v_cc;

  return v_cc;
end;
$$;

grant execute on function public.post_cycle_count(uuid) to authenticated;
