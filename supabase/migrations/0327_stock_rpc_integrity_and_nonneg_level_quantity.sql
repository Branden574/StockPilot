-- 0327_stock_rpc_integrity_and_nonneg_level_quantity.sql
-- ============================================================================
-- Stock-RPC integrity wave: the three repairs 0322 section 1 and section 4
-- named as prerequisites, plus the CHECK constraint they unblock — in ONE
-- migration, deliberately, because the constraint is only safe once BOTH
-- negative-writing RPC paths are gone, and the fixed RPCs are only fully
-- honest once the constraint backstops them. Splitting them would create a
-- deployable intermediate state that is either still corruptible (RPCs fixed,
-- no constraint) or an outage (constraint first, RPCs still writing
-- negatives, exactly the hazard 0322's header documents).
--
-- (1) adjust_stock (effective body: 0201) — its ONLY quantity guard was on the
--     item TOTAL (`v_new < 0`). The explicit-location branch had no
--     per-location guard at all: drawing −8 against a location holding 0
--     COMMITTED a durable `quantity = -8` row whenever total on-hand stayed
--     >= 0 (reproduced locally during the 0322 audit). The null-location
--     branch was already protected via apply_level_delta
--     (insufficient_placed_stock, 0292). Fix: the negative explicit-location
--     delta becomes a CONDITIONAL update (`and quantity + p_quantity_change
--     >= 0`); a guard miss raises the same 'insufficient_stock' (P0001) the
--     function already uses for the total guard, so callers' error mapping
--     (inventory.ts:3992, remove-stock/route.ts:129) keeps working unchanged.
--     Positive deltas are byte-identical to 0201.
--
-- (2) transfer_stock (effective body: 0231) — it decremented the source row
--     FIRST and inspected the result second, so the negative existed
--     transiently mid-transaction. Any row CHECK would fire at the UPDATE and
--     convert the intended P0001 'insufficient_stock' into a raw 23514
--     check_violation (different error class, different operator message).
--     Fix: the insufficiency test moves INTO the draw (`and quantity >=
--     p_quantity`); a guard miss raises the same P0001 the post-write check
--     raised. The post-write check is deleted as dead code. Everything else
--     — the source-row seed, the destination upsert, the 0231 moved_quantity
--     ledger row — is byte-identical to 0231.
--
-- (3) post_cycle_count (effective body: 0196) is SECURITY INVOKER, and its
--     reconciliation delta is derived from Σ item_stock_levels evaluated
--     under the CALLER's RLS. A holding the caller cannot see makes the sum
--     come back SHORT, and the RPC then writes a WRONG posted quantity with
--     NO error raised anywhere — silent stock corruption, the failure mode
--     0322 section 4 and SECURITY-INVARIANTS.md AR-2 spell out. Fix: the sum
--     moves into a new SECURITY DEFINER helper,
--     _cycle_count_org_stock_sum(item, org), which self-authorizes with the
--     SAME gate post_cycle_count already enforces (has_org_role manager) and
--     sums the org's holdings for the item with RLS bypassed. The RPC itself
--     stays SECURITY INVOKER; only the one read that must be complete
--     regardless of the caller's read scope is privileged. This is the
--     prerequisite 0322 recorded for ever warehouse-narrowing
--     item_stock_levels_select — that narrowing itself is a product decision
--     and is NOT made here (apply_level_delta's draw-down selection is also
--     still caller-scoped; see AR-2).
--
-- (4) item_stock_levels.quantity gets the non-negative CHECK that 0322 had to
--     defer, added NOT VALID and VALIDATED immediately. Production was
--     queried 2026-08-11: ZERO rows with quantity < 0, so validation cannot
--     fail on legacy data. NOT VALID + VALIDATE (rather than a bare ADD
--     CONSTRAINT) keeps the ACCESS EXCLUSIVE window to a metadata-only
--     instant; the validating scan runs under SHARE UPDATE EXCLUSIVE, which
--     permits concurrent reads and writes.
--
-- The pgTAP tripwires that pinned the OLD state (0322 test ~line 295, 0324
-- test ~line 66: "zero quantity CHECK constraints on item_stock_levels") are
-- INVERTED in this same change — they now pin exactly one validated
-- constraint by name. Fixing the RPCs without inverting them fails CI;
-- inverting them without fixing the RPCs destroys the tripwire.
--
-- Function bodies are verbatim copies of the current definitions
-- (adjust_stock from 0201, transfer_stock from 0231, post_cycle_count from
-- 0196) with ONLY the deltas called out inline. Signatures, security modes,
-- search_path pins and grants are identical; CREATE OR REPLACE preserves the
-- existing ACLs (0292's note), and the grants are restated anyway to state
-- the intended end state.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) adjust_stock — body verbatim from 0201.
--     Delta: the explicit-location branch splits on the delta's sign; the
--     negative side is a conditional draw that raises 'insufficient_stock'.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.adjust_stock(
  p_item_id          uuid,
  p_quantity_change  numeric,
  p_movement_type    text,
  p_location_id      uuid default null,
  p_reason           text default null,
  p_notes            text default null,
  p_mode             text default 'placed'   -- draw-down mode for the null-location negative path
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_prev numeric;
  v_new  numeric;
  v_user uuid := auth.uid();
begin
  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify the caller-supplied location_id belongs to the item's org ***
  perform public.assert_location_in_org(p_location_id, v_item.organization_id);

  v_prev := v_item.quantity_on_hand;
  v_new  := v_prev + p_quantity_change;
  if v_new < 0 then raise exception 'insufficient_stock' using errcode = 'P0001'; end if;

  update public.inventory_items
    set quantity_on_hand = v_new, updated_at = now(), updated_by = v_user
  where id = p_item_id
  returning * into v_item;

  -- Per-location maintenance:
  if p_location_id is not null then
    if p_quantity_change >= 0 then
      -- Explicit location (e.g. receiving into Staging): mutate that level.
      insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
      values (v_item.organization_id, p_item_id, p_location_id, p_quantity_change)
      on conflict (item_id, location_id) do update
        set quantity = public.item_stock_levels.quantity + excluded.quantity,
            updated_at = now();
    else
      -- *** 0327: explicit-location DRAW is conditional. The old upsert had no
      -- per-location guard, so drawing against a location holding less than
      -- the delta committed a durable negative row whenever the item TOTAL
      -- stayed >= 0. The guard lives IN the UPDATE's predicate: the row lock
      -- re-evaluates it, so two concurrent draws cannot both pass against the
      -- same stock. A miss (row absent OR insufficient quantity) raises the
      -- SAME error class/message as the total guard above, so callers' error
      -- mapping is unchanged. p_quantity_change is negative here. ***
      update public.item_stock_levels
        set quantity = quantity + p_quantity_change, updated_at = now()
      where item_id = p_item_id
        and location_id = p_location_id
        and quantity + p_quantity_change >= 0;
      if not found then
        raise exception 'insufficient_stock' using errcode = 'P0001';
      end if;
    end if;
  else
    -- Null location: auto-allocate. + -> Staging, - -> draw-down by p_mode
    -- ('placed' for picks/ships; 'staging_first' for reversals/scrap write-offs).
    perform public.apply_level_delta(p_item_id, p_quantity_change, p_mode);
  end if;

  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    from_location_id, to_location_id, reason, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, p_movement_type,
    p_quantity_change, v_prev, v_new,
    case when p_quantity_change < 0 then p_location_id else null end,
    case when p_quantity_change > 0 then p_location_id else null end,
    p_reason, p_notes, v_user
  );

  return v_item;
end;
$$;

grant execute on function public.adjust_stock(uuid, numeric, text, uuid, text, text, text)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) transfer_stock — body verbatim from 0231.
--     Delta: the insufficiency check moves INTO the draw; the dead post-write
--     check and its v_from_qty variable are removed.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.transfer_stock(
  p_item_id           uuid,
  p_from_location_id  uuid,
  p_to_location_id    uuid,
  p_quantity          numeric,
  p_notes             text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive' using errcode = '22023';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'same_location' using errcode = '22023';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_item.deleted_at is not null then raise exception 'item_deleted' using errcode = 'P0002'; end if;
  if not public.has_org_role(v_item.organization_id, 'staff') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- *** 0201: verify both location IDs belong to the item's org ***
  perform public.assert_location_in_org(p_from_location_id, v_item.organization_id);
  perform public.assert_location_in_org(p_to_location_id,   v_item.organization_id);

  -- Ensure a source row exists (kept from 0191/0201: a touched (item, location)
  -- pair always has a level row; harmless when the guard below refuses,
  -- because the raise aborts the transaction).
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_from_location_id, 0)
  on conflict (item_id, location_id) do nothing;

  -- *** 0327: the guard is IN the draw's predicate. 0231 decremented first and
  -- inspected the RETURNING value second, so the negative existed transiently
  -- and a row CHECK would fire at the UPDATE, turning the intended P0001
  -- 'insufficient_stock' into a raw 23514 check_violation. The conditional
  -- UPDATE never writes a negative: a miss falls through to the same raise
  -- the old post-write check performed. ***
  update public.item_stock_levels
    set quantity = quantity - p_quantity, updated_at = now()
  where item_id = p_item_id and location_id = p_from_location_id
    and quantity >= p_quantity;

  if not found then
    raise exception 'insufficient_stock' using errcode = 'P0001';
  end if;

  -- Increment destination.
  insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (v_item.organization_id, p_item_id, p_to_location_id, p_quantity)
  on conflict (item_id, location_id) do update
    set quantity = public.item_stock_levels.quantity + excluded.quantity,
        updated_at = now();

  -- Net-zero on quantity_on_hand: only the location changed.
  -- *** 0231: also record the physical qty moved (moved_quantity) so displays
  --     can show "Stock transferred N" — quantity_change stays 0. ***
  insert into public.stock_movements (
    organization_id, item_id, movement_type,
    quantity_change, previous_quantity, new_quantity,
    moved_quantity,
    from_location_id, to_location_id, notes, user_id
  ) values (
    v_item.organization_id, v_item.id, 'transfer',
    0, v_item.quantity_on_hand, v_item.quantity_on_hand,
    p_quantity,
    p_from_location_id, p_to_location_id, p_notes, auth.uid()
  );

  return v_item;
end;
$$;

grant execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- (3a) _cycle_count_org_stock_sum — the privileged Σ for cycle-count
--      reconciliation. SECURITY DEFINER so the sum is complete regardless of
--      the CALLER's item_stock_levels read scope; self-authorizing with the
--      SAME gate post_cycle_count enforces (0196: has_org_role manager), so it
--      grants no read post_cycle_count's caller does not already need. The
--      org filter means a caller can only ever sum holdings of an org they are
--      a manager of — a foreign item id sums that org's (empty) holdings, not
--      the foreign org's.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public._cycle_count_org_stock_sum(
  p_item_id uuid,
  p_org_id  uuid
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  -- Mirror of post_cycle_count's own gate (0196). Do not loosen: this is what
  -- makes the SECURITY DEFINER read grant nothing new.
  if not public.has_org_role(p_org_id, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    select coalesce(sum(s.quantity), 0)
      from public.item_stock_levels s
     where s.item_id = p_item_id
       and s.organization_id = p_org_id
  );
end;
$$;

comment on function public._cycle_count_org_stock_sum(uuid, uuid) is
  'Privileged Σ item_stock_levels for one item within one org, for post_cycle_count''s reconciliation (0327). SECURITY DEFINER on purpose: post_cycle_count is SECURITY INVOKER, and computing this sum under the caller''s RLS makes it come back SHORT whenever a holding is hidden from them — the delta is then computed against the wrong base and the RPC writes a WRONG quantity with no error (the 0322 s.4 silent-corruption failure mode). Self-authorizes with post_cycle_count''s own gate (has_org_role manager). This is the prerequisite for ever warehouse-narrowing item_stock_levels_select; apply_level_delta''s draw-down selection is still caller-scoped, so that narrowing remains blocked (AR-2).';

-- 0318 posture: Postgres default-grants EXECUTE TO PUBLIC and this project's
-- default privileges add a direct anon grant; both must be named to close
-- them. authenticated keeps EXECUTE because post_cycle_count is SECURITY
-- INVOKER and reaches this helper as the calling user; the helper
-- self-authorizes, so the grant is safe.
revoke execute on function public._cycle_count_org_stock_sum(uuid, uuid) from public, anon;
grant  execute on function public._cycle_count_org_stock_sum(uuid, uuid) to authenticated;
grant  execute on function public._cycle_count_org_stock_sum(uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- (3b) post_cycle_count — body verbatim from 0196.
--      Delta: the reconciliation Σ goes through _cycle_count_org_stock_sum
--      instead of a bare (caller-RLS-scoped) select.
-- ─────────────────────────────────────────────────────────────────────────────

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
    -- *** 0327: the Σ goes through the SECURITY DEFINER helper. This function
    -- is SECURITY INVOKER, so a bare select here runs under the CALLER's RLS;
    -- any holding hidden from them made the sum short and this reconciliation
    -- wrote a WRONG quantity with no error. The helper's sum is complete
    -- regardless of who is posting. ***
    v_levels_sum := public._cycle_count_org_stock_sum(v_line.item_id, v_cc.organization_id);
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

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) The constraint the fixes above unblock. NOT VALID keeps the ADD to a
--     metadata-only instant; the immediate VALIDATE (SHARE UPDATE EXCLUSIVE —
--     concurrent reads and writes proceed) cannot fail: production was
--     queried 2026-08-11 and holds ZERO rows with quantity < 0.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.item_stock_levels
  add constraint item_stock_levels_quantity_nonneg
  check (quantity >= 0) not valid;

alter table public.item_stock_levels
  validate constraint item_stock_levels_quantity_nonneg;

comment on constraint item_stock_levels_quantity_nonneg on public.item_stock_levels is
  '0327. The constraint 0322 s.1 had to defer: safe now because adjust_stock''s explicit-location draw is conditional and transfer_stock tests sufficiency IN the draw, so no RPC writes a negative — transiently or durably. Also blocks the direct PostgREST PATCH route. VALIDATED at add time (production verified zero negative rows 2026-08-11).';
