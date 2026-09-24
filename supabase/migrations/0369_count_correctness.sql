-- 0369: cycle counts post the right number (Phase 0 S5-C, count correctness).
--
-- THREE DEFECTS, each reproduced against the live bodies (0339 trigger, 0343
-- post in the ledger schema since 0359, 0226 start):
--
--   a. OVERLAPPING COUNTS APPLY A VARIANCE TWICE. Counts A and B both record
--      22 on an item whose book says 20. Each line was rebased to 20 when it
--      was counted, and ledger.post_cycle_count applies counted - expected ON
--      TOP of the live quantity: A posts 20 -> 22, then B posts 22 -> 24. The
--      shelf holds 22 and the ledger carries two "Cycle count adjustment" +2
--      rows under the manager's name.
--   b. AN OFFLINE COUNT IS MEASURED AT SYNC TIME. The phone queues the count
--      and sends it later; the trigger rebased expected to the on-hand at
--      ARRIVAL, so every pick, receipt or adjustment between the physical
--      count and the sync became a phantom variance that the post then wrote
--      into on-hand (count 20 offline, pick 3, sync -> +3, the book says 20
--      while the shelf holds 17).
--   c. WAREHOUSE COUNTS INCLUDE RENTAL EQUIPMENT AND KIT PHANTOMS. A rental
--      out on loan counts 0 on the shelf and the post writes it off (and the
--      item then shows 0 available after the return); a kit phantom
--      ('__BUNDLE__…') counted 0 writes off assembled kits without returning
--      their components.
--
-- WHAT CHANGES (owner defaults D6, D7, D8):
--
--   1. stock_movements.via_ledger: TRUE only for a row written inside a ledger
--      transaction (ledger.active()) or by a non-API role (a SECURITY DEFINER
--      body, service_role, postgres). A signed-in user can still INSERT a
--      movement directly (the app's opening-stock rows do; S1 step 3 closes
--      that), but such a row is now marked untrusted, and the two readers
--      below ignore it. Without this, a staff-inserted "+100 after the
--      capture time" would move an offline count's baseline down by 100 and
--      the manager's post would add the 100: the S5 forge in a new shape.
--      Existing rows keep TRUE (history is trusted; the column is added with
--      a TRUE default and then switched to FALSE, so nothing is rewritten).
--
--   2. cycle_count_lines.captured_at (when the counter counted; the phone
--      sends it, skew-corrected by the API) and baseline_at (the moment the
--      line's expected quantity is true for; written only by the trigger).
--      authenticated may UPDATE captured_at (added to the 0368 column grant);
--      baseline_at is not client-writable.
--
--   3. tg_cycle_count_line_rebase_expected (v2), now also fired by an UPDATE
--      of captured_at alone:
--      - reads on-hand FOR SHARE, so a record WAITS for an in-flight post that
--        holds the item FOR UPDATE and then measures against the posted
--        quantity (without it, a record could read the pre-post quantity and
--        stamp a baseline AFTER the post's movement: the guard in 4 would miss
--        it and the variance would apply twice);
--      - no capture time: expected = on-hand now, baseline_at = clock time
--        after that read (today's behaviour, now with a baseline);
--      - with a capture time: t = clamp(captured_at, [count started_at,
--        now()]); expected = on-hand now - Σ quantity_change of via_ledger
--        movements of this item after t (the book at the moment of the count);
--        baseline_at = t; and if any of those movements could have changed
--        where the item is held, counted_location_id is left null (Staging,
--        the old behaviour) instead of being inferred from today's holdings;
--      - a capture time belongs to ONE record: a re-record that does not
--        bring its own (the web, an old phone) is an online record, so a
--        stale captured_at from an earlier offline record is dropped;
--      - clearing a count nulls captured_at and baseline_at too.
--
--   4. ledger.post_cycle_count (v5):
--      - lines are processed in item_id order (two overlapping posts lock the
--        same items in the same order: no deadlock, never a 40P01);
--      - after the item's FOR UPDATE, a counted line is refused with
--        `cycle_count_line_superseded: <sku>` (P0001, hint
--        cycle_count_line_superseded) when ANOTHER count's via_ledger
--        cycle_count movement for the item landed after this line's baseline
--        (coalesce(baseline_at, counted_at) for a line counted before 0369).
--        Overlapping counts stay allowed (spot recounts during a warehouse
--        count keep working); only the post that would apply the same
--        correction twice is refused. Clear and recount the line to post it.
--        Plain stock movements (picks, receipts, transfers, a manual adjust)
--        never block: the 0339 "variance on top" semantics preserve them.
--      - its own movement is stamped created_at = clock_timestamp(), not the
--        transaction start, so it is ordered after any baseline read that
--        waited for it.
--      The guard reads stock_movements through a SECURITY DEFINER helper in
--      the (unexposed) ledger schema: the post is SECURITY INVOKER, and the
--      stock_movements SELECT policy can hide rows from a manager without
--      activity_logs:read (item with no warehouse) - an invoker read would
--      fail OPEN (the 0342 landmine). The helper answers only inside a ledger
--      transaction.
--
--   5. start_cycle_count: rental items and kit phantoms are excluded from
--      both scopes (a rental-only selection raises cycle_count_no_items).
--
-- NEVER 40001/40P01: PostgREST 14 retries a 40001 raise forever (0367); the
-- new refusal is P0001 with a hint.
--
-- COMPATIBILITY:
--   - Old phone bundles send no capture time: the record is an online record,
--     exactly today's behaviour (expected = on-hand at arrival).
--   - Old web tabs (12 h skew protection) write the 0368 columns only: same.
--   - A record can now wait up to lock_timeout (8 s) behind a post of the
--     same item; the API maps 55P03/57014 to a retryable 5xx.
--   - Existing open counts that already hold rental or phantom lines keep
--     them (the exclusion applies to new counts); the pre-ship query lists
--     them. Their counted lines are backfilled with baseline_at = counted_at
--     so the guard never reads the (client-writable) counted_at for them.

-- ── 1. stock_movements.via_ledger ────────────────────────────────────────
alter table public.stock_movements
  add column if not exists via_ledger boolean not null default true;
alter table public.stock_movements
  alter column via_ledger set default false;

comment on column public.stock_movements.via_ledger is
  '0369. TRUE when the row was written inside a ledger transaction (ledger.active()) or by a non-API role (SECURITY DEFINER body, service_role, postgres); FALSE for a direct PostgREST insert by a signed-in user. Stamped by trg_zz_stock_movements_via_ledger, never by the writer. Cycle-count baselines and the superseded guard read only TRUE rows. Rows that existed before 0369 are TRUE.';

create or replace function public.tg_stock_movements_via_ledger()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- SECURITY INVOKER on purpose: current_user is the role doing the write.
  -- Inside a SECURITY DEFINER body it is the owner; through PostgREST it is
  -- authenticated/anon; a cron is service_role.
  if tg_op = 'INSERT' then
    new.via_ledger := ledger.active() or current_user not in ('authenticated', 'anon');
  elsif current_user in ('authenticated', 'anon') then
    -- stock_movements has no UPDATE policy today, so this is defence in
    -- depth: an API role can never flip the flag.
    new.via_ledger := old.via_ledger;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_stock_movements_via_ledger() from public, anon, authenticated;

-- zz: sorts after any other BEFORE trigger, so nothing can change the stamp
-- after it is set.
drop trigger if exists trg_zz_stock_movements_via_ledger on public.stock_movements;
create trigger trg_zz_stock_movements_via_ledger
  before insert or update of via_ledger on public.stock_movements
  for each row execute function public.tg_stock_movements_via_ledger();

-- ── 2. cycle_count_lines.captured_at / baseline_at ───────────────────────
alter table public.cycle_count_lines
  add column if not exists captured_at timestamptz,
  add column if not exists baseline_at timestamptz;

comment on column public.cycle_count_lines.captured_at is
  '0369. When the counter physically counted (sent by the phone for an offline-queued count, skew-corrected by the API). Stored clamped to [count started_at, now()]. NULL for an online record. Cleared by clearCount.';
comment on column public.cycle_count_lines.baseline_at is
  '0369. The moment expected_quantity is true for: the clamped capture time, or the clock time of the on-hand read for an online record. Written only by tg_cycle_count_line_rebase_expected; the post refuses the line when another count posted a correction for the item after it.';

-- The 0368 column grant plus captured_at (the record route writes it).
grant update (captured_at) on table public.cycle_count_lines to authenticated;

-- Lines already counted on open counts: pin their baseline to counted_at so
-- the guard never falls back to the client-writable counted_at for them.
-- (baseline_at is in neither the old nor the new rebase trigger's column
-- list, so this rebases nothing; the migration runs as the owner, so no guard
-- applies.)
update public.cycle_count_lines l
   set baseline_at = l.counted_at
  from public.cycle_counts cc
 where cc.id = l.cycle_count_id
   and cc.status = 'in_progress'
   and l.counted_quantity is not null
   and l.baseline_at is null
   and l.counted_at is not null;

-- ── 3. The rebase trigger (v2) ───────────────────────────────────────────
create or replace function public.tg_cycle_count_line_rebase_expected()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live      numeric(14,4);
  v_locs      uuid[];
  v_started   timestamptz;
  v_t         timestamptz;
  v_since     numeric;
  v_moved     boolean := false;
begin
  if new.counted_quantity is null then
    if tg_op = 'UPDATE' then
      -- clearCount: the line reads as it did at start again.
      new.expected_quantity := coalesce(new.expected_at_start, new.expected_quantity);
      -- ...and forgets where and when it was counted. Keeping a location on an
      -- uncounted line would let a stale rack from an abandoned count decide
      -- where a later recount's surplus lands; keeping a capture time would
      -- measure a later online recount against the old moment.
      new.counted_location_id := null;
      new.captured_at := null;
      new.baseline_at := null;
    end if;
    -- INSERT with no count (start_cycle_count): keep the seeded snapshot.
    return new;
  end if;

  -- A capture time belongs to ONE record. A re-record that does not bring its
  -- own (the web action, a phone bundle from before 0369) is an online record:
  -- it must not be measured against an earlier offline record's moment.
  if tg_op = 'UPDATE' and new.captured_at is not distinct from old.captured_at then
    new.captured_at := null;
  end if;

  -- First count of this line: remember the start snapshot.
  if new.expected_at_start is null then
    new.expected_at_start := new.expected_quantity;
  end if;

  -- The system quantity now. FOR SHARE: a post holding this item FOR UPDATE
  -- makes this record WAIT, and the read after the wait sees the posted
  -- quantity (READ COMMITTED re-reads the locked row). Every on-hand writer
  -- updates this row, so none can commit between this read and the movement
  -- sum below.
  select ii.quantity_on_hand
    into v_live
    from public.inventory_items ii
   where ii.id = new.item_id
   for share;

  if found then
    if new.captured_at is null then
      -- Online record: measured against the book now.
      new.expected_quantity := v_live;
      new.baseline_at := clock_timestamp();
    else
      -- Offline record: measured against the book at the capture time,
      -- clamped to the count's own window. Only ledger movements count: a
      -- row a user inserted directly (via_ledger false) moves nothing.
      select cc.started_at into v_started
        from public.cycle_counts cc
       where cc.id = new.cycle_count_id;
      v_t := least(greatest(new.captured_at, coalesce(v_started, new.captured_at)), now());

      select coalesce(sum(m.quantity_change), 0),
             coalesce(bool_or(m.quantity_change <> 0
                              or m.from_location_id is not null
                              or m.to_location_id is not null), false)
        into v_since, v_moved
        from public.stock_movements m
       where m.item_id = new.item_id
         and m.via_ledger
         and m.created_at > v_t;

      new.expected_quantity := v_live - v_since;
      new.captured_at := v_t;
      new.baseline_at := v_t;
    end if;
  else
    new.baseline_at := clock_timestamp();
  end if;

  -- ═══ WHERE WAS THIS COUNTED ═══
  --
  -- Stock that moved after the capture time: today's holdings are not the
  -- ones the counter saw, so no location is inferred and the variance goes
  -- the old way (Staging), exactly as for a multi-location item.
  if v_moved then
    new.counted_location_id := null;
    return new;
  end if;

  -- Only derived when the line does not already carry one.
  --
  -- STAGING IS EXCLUDED FROM THE CANDIDATES. Stock in Staging has not been
  -- placed yet, so Staging remains the honest home for its variance — which is
  -- also exactly the old behaviour, reached by leaving this null.
  -- `is distinct from` because locations.kind is nullable (0292).
  if new.counted_location_id is null then
    -- array_agg, not min(): there is no min(uuid) in Postgres, and the
    -- question is "is there exactly one", not "which is smallest".
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
$$;

-- The trigger also fires when captured_at alone is written: the column is
-- client-writable (the record route sets it), and a PATCH of it without the
-- count would otherwise store an unclamped time next to a baseline and an
-- expected quantity measured for another moment. Now the three are always
-- derived together (on an uncounted line the clear path nulls it).
drop trigger if exists cycle_count_lines_rebase_expected on public.cycle_count_lines;
create trigger cycle_count_lines_rebase_expected
  before insert or update of counted_quantity, captured_at on public.cycle_count_lines
  for each row execute function public.tg_cycle_count_line_rebase_expected();

comment on function public.tg_cycle_count_line_rebase_expected() is
  '0339, v2 in 0369. BEFORE INSERT OR UPDATE OF counted_quantity, captured_at on cycle_count_lines. Reads on-hand FOR SHARE (waits for an in-flight post). Online record: expected = on-hand now, baseline_at = clock time. Record with captured_at: expected = on-hand now minus via_ledger movements after the clamped capture time, baseline_at = that time, no location inferred when stock moved since. Clearing restores expected_at_start and nulls location, captured_at and baseline_at. SECURITY DEFINER so the read cannot be narrowed by the writer''s scope; keyed to the row''s own item.';

-- ── 4a. The superseded guard's read (ledger schema, not exposed) ─────────
create or replace function ledger.cycle_count_line_superseded(
  p_item_id        uuid,
  p_cycle_count_id uuid,
  p_since          timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only the post (inside its ledger transaction) asks. Anyone else learns
  -- nothing; the answer is a single boolean about one item either way.
  if not ledger.active() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Callers pass the line's baseline; a line with none cannot be judged here.
  if p_since is null then
    return false;
  end if;
  return exists (
    select 1
      from public.stock_movements m
     where m.item_id = p_item_id
       and m.via_ledger
       and m.reference_type = 'cycle_count'
       and m.reference_id is distinct from p_cycle_count_id
       and m.created_at > p_since
  );
end;
$$;

revoke all on function ledger.cycle_count_line_superseded(uuid, uuid, timestamptz) from public, anon;
grant execute on function ledger.cycle_count_line_superseded(uuid, uuid, timestamptz)
  to authenticated, service_role;

comment on function ledger.cycle_count_line_superseded(uuid, uuid, timestamptz) is
  '0369. TRUE when another count''s via_ledger cycle_count movement for the item is later than p_since. SECURITY DEFINER so the post (SECURITY INVOKER) cannot fail open under the stock_movements SELECT policy; answers only inside a ledger transaction.';

-- ── 4b. ledger.post_cycle_count (v5) ─────────────────────────────────────
-- The 0343 body (moved into the ledger schema by 0359) with three changes,
-- each marked 0369 below.
create or replace function ledger.post_cycle_count(p_cycle_count_id uuid)
returns public.cycle_counts
language plpgsql
set search_path = public
as $$
declare
  v_cc            public.cycle_counts%rowtype;
  v_line          record;
  v_prev          numeric(14,4);
  v_current_wh    uuid;
  v_sku           text;
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
     -- 0369: one global lock order. Two posts that share items take the item
     -- locks in the same order, so they queue instead of deadlocking.
     order by l.item_id
  loop
    select quantity_on_hand, warehouse_id, sku
      into v_prev, v_current_wh, v_sku
      from public.inventory_items
      where id = v_line.item_id
      for update;
    if not found then continue; end if;

    if v_line.warehouse_id is not null
       and v_current_wh is distinct from v_line.warehouse_id then
      raise exception 'item_out_of_scope' using errcode = '22023';
    end if;

    -- 0369: another count already posted a correction for this item after
    -- this line was measured, so this line's variance is (at least partly)
    -- the same correction. Applying it would count it twice. Checked after
    -- the item lock, so a concurrent post of the item has committed (and its
    -- movement is visible) or has not started.
    if ledger.cycle_count_line_superseded(
         v_line.item_id, p_cycle_count_id,
         coalesce(v_line.baseline_at, v_line.counted_at)) then
      raise exception 'cycle_count_line_superseded: %', v_sku
        using errcode = 'P0001', hint = 'cycle_count_line_superseded';
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

    -- ═══ VALIDATE THE COUNTED LOCATION ═══ (0342/0343, unchanged)
    --
    -- A CROSS-ORG OR CROSS-WAREHOUSE TARGET IS A HARD REFUSAL. The trigger
    -- cannot produce one, so its presence means the row was written by
    -- something else. AN ARCHIVED LOCATION IS A SOFT FALLBACK: valid when
    -- counted, retired before posting, so the variance routes the old way.
    v_target_loc := null;
    if v_line.counted_location_id is not null then
      select * into v_loc
        from public._cycle_count_location_facts(v_line.counted_location_id);

      if not found or v_loc.organization_id is distinct from v_cc.organization_id then
        raise exception 'cycle_count_location_out_of_org' using errcode = '42501';
      end if;
      -- BOTH must be known before this is a cross-warehouse violation (0343):
      -- a location with a NULL warehouse_id is ORG-LEVEL.
      if v_line.warehouse_id is not null
         and v_loc.warehouse_id is not null
         and v_loc.warehouse_id is distinct from v_line.warehouse_id then
        raise exception 'cycle_count_location_out_of_scope' using errcode = '22023';
      end if;
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
      to_location_id, from_location_id,
      created_at
    ) values (
      v_cc.organization_id, v_line.item_id, 'adjust',
      v_diff,
      v_prev,
      v_new,
      coalesce(v_line.reason, 'Cycle count adjustment'),
      v_notes,
      auth.uid(),
      'cycle_count', p_cycle_count_id,
      -- The counted location travels on the ledger row (NOT a transfer).
      case when v_target_loc is not null and v_diff > 0 then v_target_loc end,
      case when v_target_loc is not null and v_diff < 0 then v_target_loc end,
      -- 0369: the real moment, not the transaction start. A record that waited
      -- for this post stamps its baseline after this; one that did not wait
      -- read before this post took the item lock, so its baseline is earlier.
      clock_timestamp()
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
      v_recon := public.apply_cycle_count_location_delta(
        v_line.item_id, v_target_loc, v_cc.organization_id, v_recon);
    end if;

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
$$;

-- ── 5. start_cycle_count: no rental equipment, no kit phantoms ───────────
create or replace function public.start_cycle_count(
  p_organization_id     uuid,
  p_scope               text,
  p_header_warehouse_id uuid,
  p_filter_warehouse_id uuid,
  p_item_ids            uuid[],
  p_notes               text
)
returns table(cycle_count_id uuid, line_count integer)
language plpgsql
set search_path = public
as $$
declare
  v_id    uuid;
  v_count integer;
begin
  if p_scope not in ('warehouse', 'selection') then
    raise exception 'cycle_count_bad_scope' using errcode = '22023';
  end if;

  insert into public.cycle_counts (
    organization_id, warehouse_id, scope, status, notes, started_by
  ) values (
    p_organization_id, p_header_warehouse_id, p_scope, 'in_progress', p_notes, auth.uid()
  )
  returning id into v_id;

  insert into public.cycle_count_lines (
    cycle_count_id, item_id, warehouse_id, expected_quantity
  )
  select
    v_id,
    ii.id,
    ii.warehouse_id,
    coalesce(ii.quantity_on_hand, 0)
  from public.inventory_items ii
  where ii.organization_id = p_organization_id
    and ii.deleted_at is null
    and ii.status = 'active'
    -- 0369 (D8): rental equipment is reserved, never decremented, so a count
    -- of a unit out on loan writes it off; a kit phantom is verified by
    -- counting its components. Neither is counted, in either scope.
    and not ii.is_rental
    and not ii.is_bundle
    and (
      (p_scope = 'warehouse'
        and (p_filter_warehouse_id is null or ii.warehouse_id = p_filter_warehouse_id))
      or
      (p_scope = 'selection' and ii.id = any(p_item_ids))
    );

  get diagnostics v_count = row_count;

  -- No in-scope items: abort so the header insert rolls back (no orphan).
  if v_count = 0 then
    raise exception 'cycle_count_no_items' using errcode = 'P0001';
  end if;

  cycle_count_id := v_id;
  line_count := v_count;
  return next;
end;
$$;
