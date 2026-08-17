-- 0339_cycle_count_rebase_expected_at_count_time.sql
-- ============================================================================
-- Cycle counts: the variance base is the system quantity WHEN THE LINE WAS
-- COUNTED, and the ledger row written at post time chains from the live
-- quantity. Supersedes post_cycle_count (0327) IN FULL — fourth version after
-- 0023 (v1), 0079 (v2), 0196/0327 (v3).
--
-- THE BUG (prod, L4L, "Maus I", 2026-07-23):
--   14:52 count started        line snapshot expected_quantity = 124
--   16:26 order pick, -15      live on-hand 124 -> 109
--   17:29 counter enters 89    (the shelf really held 89: the pick had
--                               already left it)
--   17:30 post_cycle_count     adjust -35 (= 89 - SNAPSHOT 124),
--                               previous_quantity 124, new_quantity 89,
--                               note "[drift] live qty 109 differed from
--                               snapshot 124 at post time"
--   The 15-unit pick was subtracted twice on the LEDGER — once as the pick
--   row (124 -> 109) and again inside the count's -35 — and the count row's
--   previous_quantity (124) does not chain to the prior row's new_quantity
--   (109). On-hand ended at 89, which was physically right, so the damage is
--   a ledger row that over-states shrink by 15 and breaks the chain.
--
-- WHY v2/v3 DID THIS. 0079 chose "variance = counted - START SNAPSHOT" so the
-- number on the screen matched what got posted, and wrote
-- previous_quantity := snapshot to keep the row internally consistent with
-- that arithmetic. But the on-screen promise (web post dialog) is two-fold:
-- "post N adjustments (net X units) AND update inventory to match the counted
-- quantities". Under drift those halves contradict each other, and the
-- function honoured both only by writing a movement row whose delta and
-- previous_quantity were not what happened to the stock. Latent siblings of
-- the same rule: a movement BETWEEN count and post was silently erased
-- (on-hand := counted), a drifted line whose counted == snapshot was silently
-- discarded (v_diff = 0), and a drifted line whose counted == live wrote a
-- phantom adjust row.
--
-- THE RULE (v4). What the counter counted is the truth about the SHELF at
-- count time.
--   * Stock that moved BETWEEN start and count is already reflected in the
--     count -> it must NOT be in the variance.
--   * Stock that moves BETWEEN count and post is NOT reflected -> it must be
--     preserved on top of the variance.
-- So: expected_quantity is REBASED to the live system quantity at the moment
-- counted_quantity is written (a BEFORE trigger on cycle_count_lines does
-- this in-place, so the web table, the mobile card, cycle_count_lines_page,
-- cycle_count_summary and the PDF — every reader that computes
-- counted - expected — inherit the rule with no code change), the start
-- snapshot is kept in the new expected_at_start column for audit, and
-- post_cycle_count applies (counted - expected) ON TOP OF the live quantity:
--     new_on_hand := live_at_post + (counted - expected_at_count)
-- and writes previous_quantity := live_at_post, so the ledger chains by
-- construction. Maus I under v4: line rebased 124 -> 109 at 17:29; post
-- writes adjust -20, previous 109, new 89 — the pick counted once, on its own
-- row.
--
-- Rejected: rebasing at POST (v1's rule) is wrong for the very case found (a
-- pick between snapshot and count is subtracted twice); refusing every
-- drifted line would refuse every busy-warehouse count; "post counted as the
-- absolute and re-apply post-count movements" is this rule with more
-- machinery.
--
-- LEGACY LINES. A line counted BEFORE this migration has expected_at_start
-- null and an expected_quantity that is still the start snapshot; if its item
-- moved between start and count there is no record of the live quantity at
-- count time, so v4 cannot attribute the drift and REFUSES to post it
-- (cycle_count_stale_line) — clear + recount re-stamps it through the trigger.
-- Undrifted legacy lines post normally. Prod at write time holds 3 in-flight
-- counts (all StockPilot Demo Co) with 1 drifted counted line.
--
-- Carried from 0327 IN FULL and re-pinned in tests/0339: cycle_count_not_found
-- (P0002), cycle_count_not_open (22023), forbidden (42501, has_org_role
-- manager), item_out_of_scope (22023, mid-count warehouse move), deleted-item
-- skip, uncounted-line skip, zero-variance skip, reference_type/id, the
-- reconciliation Σ via the SECURITY DEFINER _cycle_count_org_stock_sum,
-- apply_level_delta(new_on_hand - Σ, 'staging_first'), SECURITY INVOKER with
-- search_path pinned, EXECUTE only for authenticated (0329 posture).
-- New: cycle_count_negative_result (P0001) when live + variance < 0 (stock
-- left after the count; recount), cycle_count_stale_line (P0001, legacy).
--
-- Known limit, stated: offline mobile counts are stamped at SYNC time (the
-- record endpoint stamps counted_at server-side and the client sends no
-- timestamp), so a movement between the physical count and the sync is
-- treated as pre-count. That is the same outcome the snapshot rule produced
-- for that window, with a truthful ledger; closing it needs client
-- timestamps and a per-item quantity history the DB does not keep.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) Column: the start snapshot survives the rebase, for audit.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.cycle_count_lines
  add column if not exists expected_at_start numeric(14,4);

comment on column public.cycle_count_lines.expected_at_start is
  '0339. inventory_items.quantity_on_hand when the count session STARTED, stamped the first time counted_quantity is written (null = never counted since 0339; a counted line with null here was counted before 0339). Audit only: variance and posting use expected_quantity, which is rebased to the live quantity at count time.';

comment on column public.cycle_count_lines.expected_quantity is
  'The system quantity the count is measured against. Seeded with inventory_items.quantity_on_hand when the session started (0023); since 0339 REBASED to the live quantity at the moment counted_quantity is written (tg_cycle_count_line_rebase_expected), and restored to expected_at_start when the count is cleared. counted_quantity - expected_quantity is the variance every reader shows and post_cycle_count applies on top of the live quantity.';

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) Trigger: rebase expected_quantity to the live quantity when a count is
--     written; restore the start snapshot when it is cleared.
--
--     BEFORE INSERT OR UPDATE OF counted_quantity — every writer
--     (CycleCountsService.recordCount/clearCount behind the web action and
--     POST /api/v1/cycle-counts/[id]/lines/[lineId]/record, mobile manual,
--     barcode, AI shelf scan and offline replay, and any direct PostgREST
--     write) flows through it, so recurring pattern #26 (a fix applied to one
--     of several writers) is closed by construction. Fires whenever
--     counted_quantity is in the SET list, not only when the value changes: a
--     re-count that lands on the same number is still a count taken NOW.
--
--     SECURITY DEFINER: the trigger reads inventory_items.quantity_on_hand for
--     the line's item under the writer's session. A counter's inventory read
--     scope can be narrower than the count's line set (0080 staff RLS,
--     warehouse-scoped access), and a rebase against a row the caller cannot
--     see would silently keep the stale snapshot — the exact failure this
--     migration removes. The read is keyed to NEW.item_id of a row the caller
--     is already allowed to write, so nothing wider is exposed. search_path
--     pinned; EXECUTE revoked from PUBLIC/anon/authenticated (0329 trigger-fn
--     posture: firing does not need it).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.tg_cycle_count_line_rebase_expected()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live numeric(14,4);
begin
  if new.counted_quantity is null then
    if tg_op = 'UPDATE' then
      -- clearCount: the line reads as it did at start again.
      new.expected_quantity := coalesce(new.expected_at_start, new.expected_quantity);
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

  return new;
end;
$$;

comment on function public.tg_cycle_count_line_rebase_expected() is
  '0339. BEFORE INSERT OR UPDATE OF counted_quantity on cycle_count_lines: when a count is written, stamp expected_at_start (first time only) and rebase expected_quantity to inventory_items.quantity_on_hand NOW; when a count is cleared, restore expected_quantity from expected_at_start. SECURITY DEFINER so the rebase cannot be defeated by the writer''s inventory read scope; keyed to the row''s own item.';

revoke execute on function public.tg_cycle_count_line_rebase_expected() from public, anon, authenticated;

drop trigger if exists cycle_count_lines_rebase_expected on public.cycle_count_lines;
create trigger cycle_count_lines_rebase_expected
  before insert or update of counted_quantity on public.cycle_count_lines
  for each row execute function public.tg_cycle_count_line_rebase_expected();

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) post_cycle_count v4 — supersedes 0327 in full.
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
  v_prev          numeric(14,4);   -- live on-hand at post time
  v_current_wh    uuid;
  v_base          numeric(14,4);   -- system qty the count was measured against
  v_diff          numeric(14,4);   -- counted - base
  v_new           numeric(14,4);   -- v_prev + v_diff
  v_notes         text;
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
    -- Lock the item row, read the live qty + warehouse.
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

    -- The base is the system quantity WHEN THE LINE WAS COUNTED
    -- (expected_quantity, rebased by tg_cycle_count_line_rebase_expected).
    v_base := v_line.expected_quantity;

    -- Legacy line (counted before 0339): expected_at_start is null and
    -- expected_quantity is still the start snapshot. If the live qty differs
    -- we cannot tell whether the movement happened before or after the count,
    -- so we refuse rather than guess. Clear + recount re-stamps the line.
    if v_line.expected_at_start is null
       and v_prev is distinct from v_base then
      raise exception 'cycle_count_stale_line' using errcode = 'P0001';
    end if;

    v_diff := v_line.counted_quantity - v_base;
    if v_diff = 0 then continue; end if;

    -- Apply the variance ON TOP OF the live quantity: stock that moved after
    -- the count is preserved, and the ledger row chains from the live qty.
    v_new := v_prev + v_diff;
    if v_new < 0 then
      raise exception 'cycle_count_negative_result' using errcode = 'P0001';
    end if;

    v_notes := v_line.notes;
    -- Audit breadcrumbs. Both are guarded so a null never swallows the note
    -- (a legacy line has expected_at_start null and must keep its notes).
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

    insert into public.stock_movements(
      organization_id, item_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, notes, user_id,
      reference_type, reference_id
    ) values (
      v_cc.organization_id, v_line.item_id, 'adjust',
      v_diff,
      v_prev,
      v_new,
      coalesce(v_line.reason, 'Cycle count adjustment'),
      v_notes,
      auth.uid(),
      'cycle_count', p_cycle_count_id
    );

    update public.inventory_items
      set quantity_on_hand = v_new,
          updated_by = auth.uid()
      where id = v_line.item_id
        and deleted_at is null;

    -- Reconcile the per-location levels to the NEW on-hand so Σ
    -- item_stock_levels stays = quantity_on_hand. delta = new_on_hand − current
    -- Σlevels (+ → Staging, − → staging_first: drain Staging before placed,
    -- because freshly-received stock normally sits in Staging and a cycle
    -- count is an authoritative recount, not a pick — it must reconcile from
    -- wherever the stock actually sits). Σ goes through the SECURITY DEFINER
    -- helper (0327): this function is SECURITY INVOKER and a bare select here
    -- would run under the caller's RLS; a hidden holding made the sum short
    -- and the reconciliation wrote a WRONG quantity with no error.
    v_levels_sum := public._cycle_count_org_stock_sum(v_line.item_id, v_cc.organization_id);
    perform public.apply_level_delta(
      v_line.item_id,
      v_new - v_levels_sum,
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

comment on function public.post_cycle_count(uuid) is
  'v4 (0339). Posts every counted line of an in-progress count as an adjust movement: quantity_change = counted_quantity - expected_quantity (expected is the live system qty at COUNT time, rebased by tg_cycle_count_line_rebase_expected), applied ON TOP OF the live qty at post time so post-count movements are preserved and previous_quantity chains from the ledger. Refuses cycle_count_stale_line (a pre-0339 line whose stock moved: recount), cycle_count_negative_result (variance would take the item below zero: recount), item_out_of_scope (mid-count warehouse move), cycle_count_not_open, cycle_count_not_found, forbidden (manager+). Σ item_stock_levels reconciled to the new on-hand via _cycle_count_org_stock_sum + apply_level_delta(staging_first). SECURITY INVOKER; EXECUTE for authenticated only.';

-- 0327/0329 posture, restated so this migration is complete on its own:
-- SECURITY INVOKER (RLS applies to every write), search_path pinned above,
-- EXECUTE closed to PUBLIC and anon, open to authenticated (the RPC gates on
-- has_org_role manager itself).
revoke execute on function public.post_cycle_count(uuid) from public, anon, authenticated;
grant  execute on function public.post_cycle_count(uuid) to authenticated;
