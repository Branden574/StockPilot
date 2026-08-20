-- ═══════════════════════════════════════════════════════════════════════════
-- 0342 — A CYCLE COUNT PUTS THE UNITS BACK WHERE THEY WERE FOUND
--
-- THE BUG. Counting a rack and finding MORE than expected added the surplus to
-- STAGING. Rack A-12 says 20, the counter finds 25, and afterwards A-12 still
-- reads 20 while five units appear on the put-away worklist. Nobody received
-- those five units and nobody needs to put them away — they were already on the
-- rack. The warehouse is then asked to walk stock that never moved.
--
-- WHY IT HAPPENED. post_cycle_count reconciles per-location levels to the new
-- on-hand through apply_level_delta(), whose INCREMENT branch is hard-coded to
-- land in Staging. That is correct for its other callers — a receipt genuinely
-- does enter the building and genuinely does await put-away — so the fix must
-- NOT change that function. This migration routes the cycle-count case around
-- it instead, and only when the counted location is known.
--
-- ═══ WHAT THE AUDIT ACTUALLY FOUND, AND WHY THIS IS SHAPED THIS WAY ═══
--
-- A cycle-count line is ITEM-level, not location-level. start_cycle_count seeds
-- one line per item with expected_quantity = the item's TOTAL quantity_on_hand,
-- and tg_cycle_count_line_rebase_expected re-stamps that total at count time.
-- There has never been a column saying WHICH rack was counted, so "I counted
-- A-12 and found 25" is not a statement the schema can currently express.
--
-- This migration adds the missing fact — `counted_location_id` — and stamps it
-- AT COUNT TIME rather than at post time. That distinction is the whole point:
-- an item can be moved between the count and the post, so a location inferred
-- at post time answers "where is it now", while the count is a claim about
-- where it was when somebody looked at it.
--
-- IT IS STAMPED IN THE TRIGGER, which is the single choke point every writer
-- passes through — web, mobile, barcode, the AI shelf scan and offline replay
-- all reach this table by setting counted_quantity. Stamping here gives every
-- one of them identical behaviour with no per-writer change, and makes a future
-- writer that forgets impossible rather than merely unlikely.
--
-- ═══ IT NEVER GUESSES ═══
--
-- The location is stamped ONLY when exactly one non-staging location holds
-- positive stock for that item. With two racks holding the same SKU there is no
-- honest answer to "which one did the extra five come from", so the column
-- stays null and posting falls back to the old behaviour. Wrong location data
-- is worse than coarse location data: a picker sent to the wrong bay loses more
-- time than one reading a Staging worklist.
--
-- On this org today that fallback is rare — 378 of 405 items with placed stock
-- sit in exactly one location, 7 in more than one.
--
-- NOTHING IS BACKFILLED. Historical lines keep a null location; retroactively
-- deciding where a count that happened weeks ago took place would be inventing
-- warehouse history.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.cycle_count_lines
  add column if not exists counted_location_id uuid
    references public.locations(id) on delete set null;

comment on column public.cycle_count_lines.counted_location_id is
  'The physical location this line was counted at, captured WHEN THE COUNT WAS '
  'RECORDED (not at post time, and not at session start). Null means the target '
  'was ambiguous — the item sat in several placed locations — or the line '
  'predates 0342. A null routes the variance the old way, through Staging.';

-- Posting reads this per line and start_cycle_count never filters on it, so the
-- only access pattern is "the lines of one count", which cycle_count_id already
-- serves. No index: an unused index is write cost on the hot count path for a
-- lookup nothing performs.

-- ───────────────────────────────────────────────────────────────────────────
-- STAMP THE LOCATION AT COUNT TIME
--
-- Extends the 0339 rebase trigger rather than adding a second one. Two triggers
-- on the same column would have an execution order decided by name, and the
-- next person to add one would have to discover that.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.tg_cycle_count_line_rebase_expected()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_live      numeric(14,4);
  v_locs      uuid[];
begin
  if new.counted_quantity is null then
    if tg_op = 'UPDATE' then
      -- clearCount: the line reads as it did at start again.
      new.expected_quantity := coalesce(new.expected_at_start, new.expected_quantity);
      -- ...and forgets where it was counted. Keeping a location on an
      -- uncounted line would let a stale rack from an abandoned count decide
      -- where a later recount's surplus lands.
      new.counted_location_id := null;
    end if;
    -- INSERT with no count (start_cycle_count): keep the seeded snapshot.
    return new;
  end if;

  -- First count of this line: remember the start snapshot.
  if new.expected_at_start is null then
    new.expected_at_start := new.expected_quantity;
  end if;

  -- The system quantity at count time is the base the counter's number is
  -- measured against.
  select ii.quantity_on_hand
    into v_live
    from public.inventory_items ii
   where ii.id = new.item_id;
  if found then
    new.expected_quantity := v_live;
  end if;

  -- ═══ WHERE WAS THIS COUNTED ═══
  --
  -- Only derived when the caller did not say. A caller that DOES supply one is
  -- making a stronger claim than we can infer (it scanned the rack), so it wins.
  --
  -- STAGING IS EXCLUDED FROM THE CANDIDATES. Stock in Staging has not been
  -- placed yet, so Staging remains the honest home for its variance — which is
  -- also exactly the old behaviour, reached by leaving this null.
  -- `is distinct from` because locations.kind is nullable (0292).
  if new.counted_location_id is null then
    -- array_agg, not min(): there is no min(uuid) in Postgres, and reaching for
    -- an ordering here would be meaningless anyway — the question is "is there
    -- exactly one", not "which is smallest".
    select array_agg(s.location_id)
      into v_locs
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = new.item_id
       and s.quantity > 0
       and l.deleted_at is null
       and l.kind is distinct from 'staging';

    -- Exactly one, or nothing. Two racks holding the same SKU have no honest
    -- answer, and a fabricated one sends a picker to the wrong bay.
    if coalesce(array_length(v_locs, 1), 0) = 1 then
      new.counted_location_id := v_locs[1];
    end if;
  end if;

  return new;
end;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- APPLY A RECONCILIATION DELTA AT ONE KNOWN LOCATION
--
-- Deliberately narrow, and deliberately NOT a change to apply_level_delta():
-- that function's Staging-on-increment behaviour is correct for receiving,
-- imports and adjustments, and this is the one workflow where it is not.
--
-- Returns how much it could NOT apply, so the caller routes the remainder the
-- old way and the Σ invariant holds however the split falls. A positive delta
-- always applies in full (a location can always hold more). A negative delta is
-- capped at what the location actually holds, because driving one location
-- negative to satisfy a total would be a worse lie than the one being fixed.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.apply_cycle_count_location_delta(
  p_item_id     uuid,
  p_location_id uuid,
  p_org_id      uuid,
  p_delta       numeric
) returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_have numeric;
  v_take numeric;
begin
  if p_delta = 0 or p_delta is null or p_location_id is null then
    return coalesce(p_delta, 0);
  end if;

  if p_delta > 0 then
    insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
    values (p_org_id, p_item_id, p_location_id, p_delta)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return 0;
  end if;

  select quantity into v_have
    from public.item_stock_levels
   where item_id = p_item_id and location_id = p_location_id
   for update;
  if not found or coalesce(v_have, 0) <= 0 then
    return p_delta;                       -- nothing here; caller handles it all
  end if;

  v_take := least(v_have, -p_delta);      -- never below zero at this location
  update public.item_stock_levels
     set quantity = quantity - v_take, updated_at = now()
   where item_id = p_item_id and location_id = p_location_id;

  return p_delta + v_take;                -- 0 when fully absorbed
end;
$function$;

revoke all on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.apply_cycle_count_location_delta(uuid, uuid, uuid, numeric) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- READ THE COUNTED LOCATION AUTHORITATIVELY
--
-- SECURITY DEFINER for the same reason 0327 made the Σ-levels read one:
-- post_cycle_count is SECURITY INVOKER, so a bare select here runs under the
-- CALLER's RLS and a location the caller cannot see comes back "not found".
--
-- That is not a theoretical hazard — it is how the cross-organization guard
-- first shipped broken. A line pointing at another org's rack was invisible,
-- every validation branch was skipped, and the post quietly reconciled through
-- Staging instead of refusing. Safe, but silent, and a corrupted row deserves
-- to be loud. Reading past RLS here means "not found" means what it says.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public._cycle_count_location_facts(p_location_id uuid)
returns table (organization_id uuid, warehouse_id uuid, kind text, deleted_at timestamptz)
language sql
security definer
stable
set search_path to 'public'
as $function$
  select l.organization_id, l.warehouse_id, l.kind, l.deleted_at
    from public.locations l
   where l.id = p_location_id;
$function$;

revoke all on function public._cycle_count_location_facts(uuid) from public, anon;
grant execute on function public._cycle_count_location_facts(uuid) to authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- POST: ROUTE THE VARIANCE TO THE COUNTED LOCATION
--
-- Everything above the reconciliation is UNCHANGED from 0339 and must stay that
-- way: the row locks, the mid-count warehouse-move refusal, the count-time
-- rebase, the stale-legacy-line refusal, applying the variance on top of the
-- LIVE quantity so post-count movement survives, the negative-result refusal,
-- the [rebased]/[drift] breadcrumbs, and the ledger chain
-- previous_quantity + quantity_change = new_quantity.
--
-- The ONLY change is the last step, where the per-location reconciliation now
-- prefers the counted location before falling back to apply_level_delta().
-- ───────────────────────────────────────────────────────────────────────────
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
      if v_line.warehouse_id is not null
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
