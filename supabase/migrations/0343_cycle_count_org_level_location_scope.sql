-- ═══════════════════════════════════════════════════════════════════════════
-- 0343 — AN ORG-LEVEL LOCATION IS NOT A CROSS-WAREHOUSE VIOLATION
--
-- 0342 refused to post a cycle count whose counted location had a NULL
-- warehouse_id, because `null is distinct from <warehouse>` is true and the
-- scope guard read that as "this rack belongs to another warehouse".
--
-- It does not. A location with no warehouse is ORG-LEVEL — a legitimate shape
-- this schema has always supported, and one apply_level_delta itself handles
-- (its `v_wh is null` branch reaches for ensure_org_placement_locations).
--
-- THE EFFECT WAS WORSE THAN THE BUG 0342 FIXED. A count that used to post and
-- merely put the surplus in the wrong place now failed outright with
-- cycle_count_location_out_of_scope, and the location it refused was one 0342's
-- own trigger had just stamped. Any org holding org-level locations could not
-- post a cycle count at all.
--
-- FOUND BY POSTING A REAL COUNT, not by the 55 tests that shipped with 0342 —
-- every fixture in that file gave its locations a warehouse, so the null case
-- was never exercised. The pgTAP file gains that case here.
--
-- Cross-warehouse is still refused when BOTH sides are known, which is the
-- only situation in which the claim is true.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.post_cycle_count(p_cycle_count_id uuid)
returns cycle_counts
language plpgsql
set search_path to 'public'
as $function$
declare
  v_cc            public.cycle_counts%rowtype;
  v_line          record;
  v_prev          numeric(14,4);
  v_current_wh    uuid;
  v_base          numeric(14,4);
  v_diff          numeric(14,4);
  v_new           numeric(14,4);
  v_notes         text;
  v_levels_sum    numeric;
  v_recon         numeric;
  v_loc           record;
  v_target_loc    uuid;
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
    select quantity_on_hand, warehouse_id
      into v_prev, v_current_wh
      from public.inventory_items
      where id = v_line.item_id
      for update;
    if not found then continue; end if;

    if v_line.warehouse_id is not null
       and v_current_wh is distinct from v_line.warehouse_id then
      raise exception 'item_out_of_scope' using errcode = '22023';
    end if;

    v_base := v_line.expected_quantity;

    if v_line.expected_at_start is null
       and v_prev is distinct from v_base then
      raise exception 'cycle_count_stale_line' using errcode = 'P0001';
    end if;

    v_diff := v_line.counted_quantity - v_base;
    if v_diff = 0 then continue; end if;

    v_new := v_prev + v_diff;
    if v_new < 0 then
      raise exception 'cycle_count_negative_result' using errcode = 'P0001';
    end if;

    v_notes := v_line.notes;
    if v_line.expected_at_start is not null
       and v_line.expected_at_start <> v_base then
      v_notes := coalesce(v_notes || E'\n', '')
        || '[rebased] expected ' || v_line.expected_at_start::text
        || ' at start, ' || v_base::text || ' when counted';
    end if;
    if v_prev <> v_base then
      v_notes := coalesce(v_notes || E'\n', '')
        || '[drift] live qty ' || v_prev::text
        || ' differed from count-time qty ' || v_base::text
        || ' at post time; variance applied on top';
    end if;

    -- ═══ VALIDATE THE COUNTED LOCATION ═══
    --
    -- Two failure shapes, deliberately handled differently.
    --
    -- A CROSS-ORG OR CROSS-WAREHOUSE TARGET IS A HARD REFUSAL. The trigger
    -- cannot produce one, so its presence means the row was written by
    -- something else, and quietly reconciling somewhere else would hide that.
    -- Warehouse scope is the same rule the item check above enforces: a count
    -- of DC4 must never write stock into DC7.
    --
    -- AN ARCHIVED LOCATION IS A SOFT FALLBACK. The rack was valid when counted
    -- and was retired before posting — a real sequence, not a corruption — so
    -- the variance routes the old way rather than failing a whole count.
    v_target_loc := null;
    if v_line.counted_location_id is not null then
      select * into v_loc
        from public._cycle_count_location_facts(v_line.counted_location_id);

      -- A MISS IS A REFUSAL, not a shrug. The FK is ON DELETE SET NULL, so a
      -- hard-deleted location cannot leave a dangling id here — the only way to
      -- reach this branch is a row pointing somewhere that does not exist.
      if not found or v_loc.organization_id is distinct from v_cc.organization_id then
        raise exception 'cycle_count_location_out_of_org' using errcode = '42501';
      end if;
      -- BOTH must be known before this is a cross-warehouse violation. A
      -- location with a NULL warehouse_id is ORG-LEVEL, not "in some other
      -- warehouse" — apply_level_delta has handled that shape since it was
      -- written (its `v_wh is null` branch reaches for
      -- ensure_org_placement_locations). Treating null as a mismatch refused a
      -- location this system's own trigger had just stamped.
      if v_line.warehouse_id is not null
         and v_loc.warehouse_id is not null
         and v_loc.warehouse_id is distinct from v_line.warehouse_id then
        raise exception 'cycle_count_location_out_of_scope' using errcode = '22023';
      end if;
      -- Archived, or somehow a Staging bucket: valid but not a target. Falls
      -- back rather than failing the count — see the note above.
      if v_loc.deleted_at is null
         and v_loc.kind is distinct from 'staging' then
        v_target_loc := v_line.counted_location_id;
      end if;
    end if;

    insert into public.stock_movements(
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, notes, user_id,
      reference_type, reference_id,
      to_location_id, from_location_id
    ) values (
      v_cc.organization_id, v_line.item_id, 'adjust',
      v_diff,
      v_prev,
      v_new,
      coalesce(v_line.reason, 'Cycle count adjustment'),
      v_notes,
      auth.uid(),
      'cycle_count', p_cycle_count_id,
      -- The counted location travels on the ledger row so history reads
      -- "+5, Rack A-12" instead of a bare "+5". NOT a transfer: the movement
      -- type is still 'adjust' and only the relevant side is set, because the
      -- stock never came from anywhere — it was already there.
      case when v_target_loc is not null and v_diff > 0 then v_target_loc end,
      case when v_target_loc is not null and v_diff < 0 then v_target_loc end
    );

    update public.inventory_items
      set quantity_on_hand = v_new,
          updated_by = auth.uid()
      where id = v_line.item_id
        and deleted_at is null;

    -- Reconcile Σ item_stock_levels back to the new on-hand.
    v_levels_sum := public._cycle_count_org_stock_sum(v_line.item_id, v_cc.organization_id);
    v_recon := v_new - v_levels_sum;

    if v_recon <> 0 and v_target_loc is not null then
      -- Counted location first. Returns whatever it could not absorb, so a
      -- negative bigger than that location holds still reconciles in full.
      v_recon := public.apply_cycle_count_location_delta(
        v_line.item_id, v_target_loc, v_cc.organization_id, v_recon);
    end if;

    -- Whatever is left goes the old way: unknown location, archived target, or
    -- a shortfall deeper than the counted location held. Σ holds either way.
    if v_recon <> 0 then
      perform public.apply_level_delta(v_line.item_id, v_recon, 'staging_first');
    end if;
  end loop;

  update public.cycle_counts
    set status = 'completed',
        completed_at = now(),
        completed_by = auth.uid()
    where id = p_cycle_count_id
    returning * into v_cc;

  return v_cc;
end;
$function$;
