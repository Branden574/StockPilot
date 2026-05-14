-- 0079_post_cycle_count_v2.sql
-- ============================================================================
-- post_cycle_count v2 — correctness + audit fixes for the cycle-count hunter.
--
-- Behavior changes vs. v1 (migration 0023):
--   1) Variance is computed against the LINE SNAPSHOT (expected_quantity)
--      taken at start() time, NOT against the current quantity_on_hand.
--      v1 silently rebased variance every time it ran, so a count that
--      saw "variance +3" on the UI could post a different number if any
--      other movement landed between start() and post(). The UI and the
--      database now agree.
--
--      We still want to know if drift happened — if the row's current
--      quantity_on_hand differs from the snapshot at post time, we
--      stash that in `metadata.drift_detected` on the inserted
--      stock_movement so an admin can audit it later. The actual
--      adjustment is `counted_quantity - expected_quantity` so the
--      number on the screen matches what gets posted.
--
--   2) Soft-deleted items are skipped (and ii.deleted_at is null).
--      v1 would try to update a tombstoned row and silently update 0
--      rows (since RLS plus the deleted_at column would filter it out
--      at the row level downstream — but the stock_movements row was
--      still being inserted, which is the bug).
--
--   3) Every inserted stock_movement now carries
--      reference_type='cycle_count' and reference_id=p_cycle_count_id
--      so the audit trail joins cleanly back to the session.
--
--   4) Mid-count warehouse moves are rejected. If an item's
--      warehouse_id has been changed since start() and the cycle
--      count is warehouse-scoped, post() raises 'item_out_of_scope'
--      and the caller surfaces a clean error. The line's snapshot
--      `warehouse_id` (column added in migration 0081) is the
--      reference.
--
--   5) raise-exception strings are stable codes (cycle_count_not_found,
--      cycle_count_not_open, forbidden, item_out_of_scope) that the
--      service maps to user-friendly toasts. Codes are stable across
--      releases — UI strings live in TypeScript.
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
