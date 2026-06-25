-- 0196_cycle_count_levels.sql
-- ============================================================================
-- post_cycle_count v3 — keeps item_stock_levels in sync with on-hand.
--
-- What changed vs. 0079:
--   After updating quantity_on_hand (= snapshot + variance), we reconcile the
--   per-location breakdown to the NEW on-hand via apply_level_delta so the
--   Phase 2a invariant Σ item_stock_levels = quantity_on_hand always holds:
--     delta = new_on_hand − current Σ item_stock_levels
--     (+ → Staging; − → placed draw-down, racks first / Unplaced last).
--   This deliberately reconciles to the new on-hand rather than blindly
--   applying v_diff: if live qty DRIFTED from the snapshot (a movement landed
--   between count start and post), the live Σlevels already differs from the
--   snapshot, so applying v_diff alone would leave Σlevels = live + v_diff
--   while on_hand = expected + v_diff — they'd diverge by the drift amount.
--   The reconcile collapses that gap. In the no-drift case (Σlevels = expected)
--   the delta equals v_diff exactly, so positive variance still lands in
--   Staging and negative variance still draws from placed stock.
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
  v_levels_sum    numeric;
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

    -- Reconcile the per-location levels to the NEW on-hand (= expected + v_diff)
    -- so Σ item_stock_levels stays = quantity_on_hand even if live qty drifted
    -- from the snapshot. delta = new_on_hand − current Σlevels (+ → Staging,
    -- − → staging_first: drain Staging before placed, because freshly-received
    -- stock normally sits in Staging and a cycle count is an authoritative recount,
    -- not a pick — it must reconcile from wherever the stock actually sits).
    -- In the no-drift case this equals v_diff.
    select coalesce(sum(quantity), 0) into v_levels_sum
      from public.item_stock_levels where item_id = v_line.item_id;
    perform public.apply_level_delta(
      v_line.item_id,
      (v_line.expected_quantity + v_diff) - v_levels_sum,
      'staging_first');
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
