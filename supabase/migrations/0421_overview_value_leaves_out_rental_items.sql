-- 0421_overview_value_leaves_out_rental_items.sql
--
-- B78: inventory value leaves out rental items wherever it is added up.
-- The Overview's Inventory value, its lines over time, its Compare views, the
-- AI assistant's total and the phone's VALUE counted rental items
-- (inventory_items.is_rental), while the Value breakdown on the same page
-- (vw_inventory_valuation_*, 0179), the Items and Books totals
-- (inventory_value_on_hand, 0227), every report, the QuickBooks valuation and
-- the Excel export left them out. An organization holding rental items with
-- a unit cost saw two different totals for the same stock.
--
-- ── WHY THESE FUNCTIONS MISSED THE RULE ─────────────────────────────────────
-- 0131 made rental items their own class and said every existing read path
-- would filter is_rental = false in a follow-up commit. That commit filtered
-- the inventory list, the order picker, search, the AI breakdown tools and
-- the reports, but not get_dashboard_summary (0006) or inventory_value
-- (0004), both older than rental items, nor the dashboard's history, then
-- computed in JavaScript with the same item scope. 0224 moved that history
-- into SQL with that scope, and 0228, 0230 and 0275 copied it. Each copy
-- repeats its own filter and nothing compared them.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
--   1. lock_timeout 4s for this transaction (0402's cap): a lock wait fails
--      the file, which then changes nothing, instead of queueing.
--   2. A second run of this file is refused (A SECOND RUN below).
--   3. The five functions that add up inventory value are re-created from
--      their latest definitions, changed only in their value:
--        get_dashboard_summary(uuid)                         0006
--        inventory_value(uuid)                               0004 (pin: 0329)
--        dashboard_history_series_reconstructed(uuid, uuid, int)   0230
--        dashboard_history_series(uuid, uuid, int)           0230
--        dashboard_value_series(uuid, uuid, int, text)       0275
--      The rule everywhere: an item counts toward inventory value only when
--      status = 'active', deleted_at is null and is_rental = false, as 0179,
--      0227, the reports, QuickBooks and the AI breakdown tools already have
--      it. The item counts, out-of-stock and low-stock counts still include
--      rental items (a follow-up item; the Overview's counts link to Items,
--      which leaves them out).
--   4. org_daily_stats_rental_correction(): a read-only helper holding all
--      of the correction's logic, kept for the release preview and the tests.
--   5. The correction: every stored org_daily_stats day loses its rental
--      share, once, in this transaction.
--   6. org_daily_stats' table comment says so.
--
-- ── CREATE OR REPLACE ───────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps a function's owner and grants and replaces every
-- other property, so each body below restates LANGUAGE, STABLE, SECURITY
-- INVOKER and `set search_path = public`. inventory_value had its pin from
-- 0329's ALTER; leaving the SET out here would drop it (security_invariants
-- INV-27 and 0329's test would fail). No signature or return type changes,
-- so no GRANT is needed and every web and phone build, older ones included,
-- keeps working: the numbers change, the shapes do not.
--
-- ── THE STORED DAYS ─────────────────────────────────────────────────────────
-- org_daily_stats holds one row per organization and closed UTC day: the
-- nightly refresh's observation (00:10 UTC, active items only) or, for the
-- one-time 120-day backfill 0230 ran and for gap fills, a reconstruction in
-- 24-hour windows counted back from the run's own time. Every row counted
-- rental items. Left alone, the Overview's lines would drop by each
-- organization's rental value on the day of this change, and "vs. 30 days
-- ago" would compare a value without rental items to one with them for 30
-- days (90 on the 90-day line).
--
-- So every stored day loses its rental share here, estimated from the
-- current rental items, quantities and costs. For a stored day D, each
-- active, non-deleted rental item with a unit cost above 0 that was created
-- before (D + 1) 00:00 UTC counts at its unit cost times its quantity at that
-- close: today's quantity less its movements since, never below 0. The rest
-- of each stored value, the part without rental items, stays as recorded;
-- item_count, low_out_count and computed_at are not touched.
--
-- It is an estimate. A stored day keeps a small leftover for rental items
-- deleted or archived since, for costs cut since, for stock set without a
-- movement, for the backfill's time-of-day closes and for movements between
-- 00:00 and the 00:10 refresh; items made rental items since are taken out
-- of earlier days too. A cost raised since, or a rental item archived then
-- and restored since, takes out too much: the corrected value is floored at
-- 0. A day's value without rental items lies between 0 and its stored value
-- (quantity_on_hand >= 0 is a validated CHECK, 0322/0324; unit costs are 0
-- or more, 0359's item guard), so the floor keeps the estimate inside that
-- range and no stored day can stop this file. Every stored day is corrected,
-- not only the 90 the Overview reads, so a longer range would read rows
-- that agree with the newer ones.
--
-- refresh_org_daily_stats needs no change: it reads
-- dashboard_history_series_reconstructed (step 3), so every row it writes
-- from now on leaves rental items out.
--
-- ── A SECOND RUN ────────────────────────────────────────────────────────────
-- Applied twice, the correction would take rental items out twice. The
-- helper exists from this file's first run on, so a second run raises 55000
-- at step 2 and changes nothing. A rollback drops the helper (ROLLBACK
-- below); running the file again after one would also take the rental share
-- out of the rows the nightly refresh wrote while it was live, so restore
-- or rebuild those rows first.
--
-- ── SECURITY ────────────────────────────────────────────────────────────────
-- Every function stays SECURITY INVOKER, so the card, its lines, Compare and
-- the Value breakdown cover the same rows for every role (inventory_items
-- RLS). The helper is SECURITY INVOKER, reads only, and its EXECUTE is
-- revoked from public, anon and authenticated and granted to service_role
-- (functions are outside the D1 grants guard, so this file decides it, as
-- 0227 did). This file creates no table, view or sequence.
--
-- ── RELEASE ORDER ───────────────────────────────────────────────────────────
-- Push this file first, from the pull request's head, then merge: a failed
-- push leaves main and production as they were, and the web works with
-- either side. VALUE on the phone changes with this file alone; the phone
-- update (Avg value / SKU on Reports) ships after the push, never before.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Restore the five functions from their saved definitions (SET clauses
-- included), drop the helper, and restore org_daily_stats.inventory_value
-- from the dump taken before the push for the rows this file changed only.
-- Never restore the table wholesale: rows the nightly refresh wrote after
-- the push already leave rental items out.

-- 1. Cap lock waits for this transaction (0402).
select set_config('lock_timeout', '4s', true);

-- 2. Refuse a second run (A SECOND RUN above).
do $$
begin
  if to_regprocedure('public.org_daily_stats_rental_correction()') is not null then
    raise exception 'B78: org_daily_stats has already lost its rental share; running this file again would take rental items out of the stored days twice.'
      using errcode = '55000',
            hint = 'Nothing was changed. After a rollback (which drops org_daily_stats_rental_correction) the file may run again.';
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. The five functions. Each body is its latest definition, changed only
--    where a comment names B78.
-- ────────────────────────────────────────────────────────────────────────────

-- get_dashboard_summary (0006): the Overview's Inventory value with no
-- warehouse selected. The value filter gains is_rental = false; the three
-- counts are unchanged.
create or replace function public.get_dashboard_summary(p_org_id uuid)
returns table (
  item_count          int,
  out_of_stock_count  int,
  low_stock_count     int,
  inventory_value     numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (
      where status = 'active' and deleted_at is null
    )::int as item_count,
    count(*) filter (
      where status = 'active' and deleted_at is null and quantity_on_hand <= 0
    )::int as out_of_stock_count,
    count(*) filter (
      where status = 'active'
        and deleted_at is null
        and reorder_point > 0
        and quantity_on_hand <= reorder_point
    )::int as low_stock_count,
    -- B78: rental items add no value; the counts above still include them.
    coalesce(
      sum(unit_cost * quantity_on_hand) filter (
        where status = 'active' and deleted_at is null and is_rental = false
      ),
      0
    ) as inventory_value
  from public.inventory_items
  where organization_id = p_org_id
$$;

comment on function public.get_dashboard_summary(uuid) is
  'The Overview''s figures in one pass (0006): item_count, out_of_stock_count, low_stock_count and '
  'inventory_value over the organization''s active, non-deleted items. Since 0421 (B78) inventory_value '
  'leaves out rental items, as the Value breakdown (vw_inventory_valuation_*, 0179) and the Items and '
  'Books totals (inventory_value_on_hand, 0227) do; the three counts still include them. SECURITY '
  'INVOKER: RLS binds the caller.';

-- inventory_value (0004; search_path pinned by 0329): the phone's VALUE on
-- Home and Reports. Gains is_rental = false and restates the pin.
create or replace function public.inventory_value(p_org_id uuid)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(unit_cost * quantity_on_hand), 0)
  from public.inventory_items
  where organization_id = p_org_id
    and status = 'active'
    and deleted_at is null
    and is_rental = false
$$;

comment on function public.inventory_value(uuid) is
  'Sum of unit_cost x quantity_on_hand over the organization''s active, non-deleted items that are not '
  'rental items (the phone''s VALUE). Rental items left out since 0421 (B78). SECURITY INVOKER; '
  'search_path pinned (0329).';

-- dashboard_history_series_reconstructed (0230, 0228's body): the rebuilt
-- lines (a warehouse selected, missing stored days, staff and viewers) and
-- the source of every row refresh_org_daily_stats writes. Only scope_items'
-- cost changes: a rental item's cost is 0, so it adds no value on any day,
-- while item_count and low/out, which read qty, reorder and created_at,
-- still count it.
create or replace function public.dashboard_history_series_reconstructed(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  item_count int,
  inventory_value numeric,
  low_out_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      greatest(p_days, 1)                                    as days,
      greatest(p_days, 1) - 1                                as last_idx,
      now() - greatest(p_days, 1) * interval '24 hours'      as start_at
  ),
  -- Active, non-deleted, optionally warehouse-scoped items. RLS on
  -- inventory_items applies (SECURITY INVOKER) → per-warehouse/category scope.
  -- (0224's item scope.) B78: a rental item's cost is 0, so it adds no
  -- value on any day; it still counts in item_count and low/out (the counts
  -- follow-up), which read qty, reorder and created_at only.
  scope_items as (
    select
      it.id,
      coalesce(it.quantity_on_hand, 0)::numeric as qty,
      case when it.is_rental then 0 else coalesce(it.unit_cost, 0) end::numeric as cost,
      coalesce(it.reorder_point, 0)::numeric    as reorder,
      it.created_at
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.status = 'active'
      and it.deleted_at is null
      and (p_warehouse_id is null or it.warehouse_id = p_warehouse_id)
  ),
  totals as (
    select coalesce(sum(qty * cost), 0)::numeric as value_today
    from scope_items
  ),
  -- The day spine: one row per index 0..last_idx (days with no movement still
  -- need a series point). Everything below left-joins onto this.
  days as (
    select gs.d as day_index
    from params
    cross join generate_series(0, (select last_idx from params)) as gs(d)
  ),
  -- Per (item, day-bucket) net quantity_change, scope items only + in-window.
  -- Scope predicate + day-bucket clamp are VERBATIM from 0224.
  mov as (
    select
      sm.item_id,
      least(
        (select last_idx from params),
        greatest(
          0,
          (floor(extract(epoch from (sm.created_at - (select start_at from params))) / 86400))::int
        )
      ) as day_index,
      sum(coalesce(sm.quantity_change, 0))::numeric as qty_delta
    from public.stock_movements sm
    join scope_items si on si.id = sm.item_id
    where sm.organization_id = p_organization_id
      and sm.created_at >= (select start_at from params)
    group by 1, 2
  ),
  -- ── inventory value series (verbatim from 0224) ───────────────────────────
  day_value_delta as (
    select m.day_index, sum(m.qty_delta * si.cost)::numeric as value_delta
    from mov m
    join scope_items si on si.id = m.item_id
    group by m.day_index
  ),
  value_spine as (
    select d.day_index, coalesce(dvd.value_delta, 0)::numeric as value_delta
    from days d
    left join day_value_delta dvd on dvd.day_index = d.day_index
  ),
  value_series as (
    select
      vs.day_index,
      (
        (select value_today from totals)
        - coalesce(
            sum(vs.value_delta) over (
              order by vs.day_index desc
              rows between unbounded preceding and 1 preceding
            ),
            0
          )
      )::numeric as inventory_value
    from value_spine vs
  ),
  -- ── item count series (created_at forward sweep, verbatim from 0224) ──────
  -- First day index at which an item is counted (created_at ≤ start+(d+1)·24h).
  -- Items created before the window (x ≤ 0) land at day 0; every item is
  -- ≤ now() = start+days·24h so its bucket ≤ last_idx.
  item_bucket as (
    select greatest(
             0,
             ceil(extract(epoch from (si.created_at - (select start_at from params))) / 86400 - 1)::int
           ) as b
    from scope_items si
  ),
  item_bucket_counts as (
    select b as day_index, count(*)::int as c
    from item_bucket
    group by b
  ),
  item_count_series as (
    select
      d.day_index,
      coalesce(
        sum(ibc.c) over (order by d.day_index rows between unbounded preceding and current row),
        0
      )::int as item_count
    from days d
    left join item_bucket_counts ibc on ibc.day_index = d.day_index
  ),
  -- ── low / out-of-stock series (EVENT-BASED — the 0228 rewrite) ────────────
  -- Total in-window Δ per mover (nonmovers simply have no row → 0 below).
  mover_totals as (
    select m.item_id, sum(m.qty_delta)::numeric as total_delta
    from mov m
    group by m.item_id
  ),
  -- Window-start baseline: EVERY scope item's status at
  --   qty_i(before any in-window delta) = currentQty − total in-window Δ
  -- (0224's qty_i(d) formula evaluated below the item's first delta day; for
  -- nonmovers this is just currentQty — their constant status). Note: NO
  -- created_at filter, matching 0224 exactly (mid-window-created items count
  -- from day 0 with their reconstructed qty).
  base_lowout as (
    select count(*)::int as c
    from scope_items si
    left join mover_totals mt on mt.item_id = si.id
    where (si.qty - coalesce(mt.total_delta, 0))
          <= (case when si.reorder > 0 then si.reorder else 0 end)
  ),
  -- Per (mover, delta-day) suffix sum over the item's OWN delta rows (~k rows
  -- per item — never the day spine): delta_after = Σ Δ on the item's LATER
  -- delta days. The window runs over mov ALONE (narrow sort payload — joining
  -- scope_items here would drag qty/reorder through the big sort and spill);
  -- item qty/threshold join in afterwards, purely additively:
  --   qty_after  = currentQty − delta_after        (end-of-day qty from this
  --                delta day until the item's next delta day)
  --   qty_before = qty_after − Δ(this day)         (qty on the previous
  --                segment — telescopes to the baseline below the first day)
  mover_seg as (
    select
      m.item_id,
      m.day_index,
      m.qty_delta,
      coalesce(
        sum(m.qty_delta) over (
          partition by m.item_id
          order by m.day_index desc
          rows between unbounded preceding and 1 preceding
        ),
        0
      )::numeric as delta_after
    from mov m
  ),
  -- ±1 status-flip events, aggregated per day. Zero-net delta days (rows whose
  -- Δ sums to 0) yield qty_before = qty_after → event 0 → filtered out.
  day_status_delta as (
    select
      e.day_index,
      sum(e.status_change)::int as status_delta
    from (
      select
        ms.day_index,
        ((si.qty - ms.delta_after)
           <= (case when si.reorder > 0 then si.reorder else 0 end))::int
        - ((si.qty - ms.delta_after - ms.qty_delta)
           <= (case when si.reorder > 0 then si.reorder else 0 end))::int as status_change
      from mover_seg ms
      join scope_items si on si.id = ms.item_id
    ) e
    where e.status_change <> 0
    group by e.day_index
  ),
  -- Cumulative sum over the ~days-row spine: baseline + all events ≤ day d
  -- (events on day d take effect on day d — end-of-day, same as 0224).
  low_out_series as (
    select
      d.day_index,
      (
        (select c from base_lowout)
        + coalesce(
            sum(dsd.status_delta) over (
              order by d.day_index
              rows between unbounded preceding and current row
            ),
            0
          )
      )::int as low_out_count
    from days d
    left join day_status_delta dsd on dsd.day_index = d.day_index
  )
  select
    d.day_index,
    ics.item_count,
    vsr.inventory_value,
    los.low_out_count
  from days d
  join item_count_series ics on ics.day_index = d.day_index
  join value_series vsr       on vsr.day_index = d.day_index
  join low_out_series los     on los.day_index = d.day_index
  order by d.day_index
$$;

comment on function public.dashboard_history_series_reconstructed(uuid, uuid, int) is
  'Migration 0228''s dashboard_history_series body (0230 rename-copy), no longer verbatim since 0421 '
  '(B78): a rental item''s cost is 0 in its item scope, so inventory_value leaves rental items out on '
  'every day, while item_count and low_out_count still include them. Rolling now()-anchored 24h buckets, '
  'event-based low/out, backward reconstruction from current state. Internal: feeds '
  'refresh_org_daily_stats and the warehouse/missing-snapshot fallback paths of the public read '
  'function. SECURITY INVOKER — RLS binds the caller; authenticated may execute (required: the INVOKER '
  'read function delegates here under the caller''s role — identical exposure to the pre-0230 public '
  'function).';

-- dashboard_history_series (0230): the Overview's lines. Only the live TODAY
-- row's value changes; the stored days lose their rental share in step 5,
-- and the rebuilt path is the function above.
create or replace function public.dashboard_history_series(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  item_count int,
  inventory_value numeric,
  low_out_count int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_days  int  := greatest(p_days, 1);
  v_today date := (now() at time zone 'utc')::date;
  v_have  int;
begin
  -- Snapshots are org-wide: a warehouse-scoped request takes the fully
  -- RLS-scoped reconstructed path (out of scope to snapshot per-warehouse).
  if p_warehouse_id is not null then
    return query
      select * from public.dashboard_history_series_reconstructed(
        p_organization_id, p_warehouse_id, p_days);
    return;
  end if;

  -- Completeness gate: all v_days−1 closed UTC days must be present UNDER
  -- THE CALLER'S RLS VIEW of org_daily_stats (SECURITY INVOKER). Two
  -- populations therefore ALWAYS count zero and take the reconstructed
  -- path: authenticated non-members (whose reconstruction RLS-zeroes —
  -- preserving 0224's all-zero cross-org contract) and warehouse/category-
  -- restricted members (staff/viewer — blocked by the manager+ snapshot
  -- policy; their reconstruction is fully caller-scoped, the pre-0230
  -- behavior). Degenerate v_days = 1 skips the gate (0 < 0 is false), but
  -- the snapshot branch then holds no closed days at all — only the live
  -- TODAY row, itself computed under the caller's RLS.
  select count(*) into v_have
  from public.org_daily_stats s
  where s.organization_id = p_organization_id
    and s.day >= v_today - (v_days - 1)
    and s.day <  v_today;

  if v_have < v_days - 1 then
    return query
      select * from public.dashboard_history_series_reconstructed(
        p_organization_id, null, p_days);
    return;
  end if;

  -- Snapshot hit: closed days from org_daily_stats (day D ↦ index
  -- v_days−1−(v_today−D)) + TODAY computed live from current item state
  -- (same aggregate the old function's last row reduced to). One row per
  -- day_index 0..v_days−1, oldest → newest — shape identical to 0224/0228.
  return query
  (
    select
      (v_days - 1 - (v_today - s.day))::int,
      s.item_count,
      s.inventory_value,
      s.low_out_count
    from public.org_daily_stats s
    where s.organization_id = p_organization_id
      and s.day >= v_today - (v_days - 1)
      and s.day <  v_today
    union all
    select
      v_days - 1,
      count(*)::int,
      -- B78: the value leaves out rental items; both counts include them.
      coalesce(sum(coalesce(it.quantity_on_hand, 0)::numeric
                   * coalesce(it.unit_cost, 0)::numeric)
                 filter (where not it.is_rental), 0)::numeric,
      count(*) filter (
        where coalesce(it.quantity_on_hand, 0)::numeric
              <= (case when coalesce(it.reorder_point, 0)::numeric > 0
                       then coalesce(it.reorder_point, 0)::numeric
                       else 0 end)
      )::int
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.status = 'active'
      and it.deleted_at is null
  )
  order by 1;
end;
$$;

comment on function public.dashboard_history_series(uuid, uuid, int) is
  'Per-day dashboard overview series (item_count, inventory_value cost-basis, '
  'low_out_count) over a p_days window, day_index 0..N-1 oldest→newest. Since '
  'mig 0230: closed days are OBSERVED UTC-day closes read from org_daily_stats '
  '(~N tiny rows, manager+ RLS); TODAY is computed live. Falls back to '
  'dashboard_history_series_reconstructed (0228 math) when p_warehouse_id is '
  'set or any closed day is missing from the CALLER''S RLS view — so '
  'warehouse/category-restricted members (staff/viewer) always reconstruct, '
  'fully caller-scoped. Since 0421 (B78) inventory_value leaves out rental '
  'items on every path: the live TODAY row filters them, the stored days lost '
  'their rental share once in 0421 and are written without it since, and the '
  'reconstructed path values them at 0; item_count and low_out_count still '
  'include them. SECURITY INVOKER — called via the USER client, never '
  'service-role; authenticated may execute (cross-org calls return zero rows '
  'via RLS); anon/public revoked.';

-- dashboard_value_series (0275): the value card's Compare views and its Cost
-- and Retail basis. A value-only function: its item scope gains
-- is_rental = false.
create or replace function public.dashboard_value_series(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30,
  p_basis text default 'cost'
)
returns table (
  day_index int,
  value numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      greatest(p_days, 1) - 1                            as last_idx,
      now() - greatest(p_days, 1) * interval '24 hours'  as start_at
  ),
  -- Active, non-deleted, optionally warehouse-scoped items that are not
  -- rental items (B78). RLS on inventory_items applies (SECURITY INVOKER) →
  -- per-warehouse/category scope. `basis` selects the per-item multiplier:
  -- retail_price for 'retail' (COALESCE null → 0), unit_cost for anything
  -- else ('cost' — parity with dashboard_history_series' cost value, which
  -- values a rental item at 0). Mirrors
  -- dashboard_history_series_reconstructed.scope_items otherwise.
  scope_items as (
    select
      it.id,
      coalesce(it.quantity_on_hand, 0)::numeric as qty,
      case
        when p_basis = 'retail' then coalesce(it.retail_price, 0)::numeric
        else coalesce(it.unit_cost, 0)::numeric
      end                                       as basis
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.status = 'active'
      and it.deleted_at is null
      and it.is_rental = false
      and (p_warehouse_id is null or it.warehouse_id = p_warehouse_id)
  ),
  totals as (
    select coalesce(sum(qty * basis), 0)::numeric as value_today
    from scope_items
  ),
  -- Day spine: one row per index 0..last_idx (days with no movement still need
  -- a point). Value is linear in qty, so the same reverse-walk the cost series
  -- uses works for any basis: value[d] = value_today − Σ(basis·Δ) on days > d.
  days as (
    select gs.d as day_index
    from params
    cross join generate_series(0, (select last_idx from params)) as gs(d)
  ),
  mov as (
    select
      sm.item_id,
      least(
        (select last_idx from params),
        greatest(
          0,
          (floor(extract(epoch from (sm.created_at - (select start_at from params))) / 86400))::int
        )
      ) as day_index,
      sum(coalesce(sm.quantity_change, 0))::numeric as qty_delta
    from public.stock_movements sm
    join scope_items si on si.id = sm.item_id
    where sm.organization_id = p_organization_id
      and sm.created_at >= (select start_at from params)
    group by 1, 2
  ),
  day_value_delta as (
    select m.day_index, sum(m.qty_delta * si.basis)::numeric as value_delta
    from mov m
    join scope_items si on si.id = m.item_id
    group by m.day_index
  ),
  value_spine as (
    select d.day_index, coalesce(dvd.value_delta, 0)::numeric as value_delta
    from days d
    left join day_value_delta dvd on dvd.day_index = d.day_index
  )
  select
    vs.day_index,
    (
      (select value_today from totals)
      - coalesce(
          sum(vs.value_delta) over (
            order by vs.day_index desc
            rows between unbounded preceding and 1 preceding
          ),
          0
        )
    )::numeric as value
  from value_spine vs
  order by vs.day_index
$$;

comment on function public.dashboard_value_series(uuid, uuid, int, text) is
  'On-demand per-day inventory VALUE series for the dashboard value card''s '
  'Compare/basis controls (0275). Returns (day_index 0..N-1 oldest→newest, '
  'value) = SUM(basis × reconstructed per-day qty), basis=''retail'' → '
  'retail_price (COALESCE 0), else unit_cost (cost-basis parity with '
  'dashboard_history_series). Since 0421 (B78) rental items are left out of '
  'its item scope, for both bases. RECONSTRUCTED-ONLY: reverse-walks '
  'stock_movements from current state with price held CONSTANT across past '
  'days — APPROXIMATE history (retail is never snapshotted); acceptable '
  'on-demand for a 30/90d window, never the eager render. SECURITY INVOKER — '
  'RLS binds the caller (warehouse/category scope + cross-org isolation); '
  'authenticated may execute; anon/public revoked.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. The correction's helper. Read-only: the release preview runs it before
--    the push, step 5 below runs it once, and the tests call it directly.
--    One row per stored day the correction changes.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.org_daily_stats_rental_correction()
returns table (
  organization_id uuid,
  day             date,
  stored_value    numeric,
  rental_value    numeric,
  corrected_value numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with rental_items as (
    -- The rental items that carry a value today: active, not deleted, with
    -- a unit cost above 0.
    select
      it.id,
      it.organization_id,
      it.quantity_on_hand::numeric as qty,
      it.unit_cost::numeric        as cost,
      it.created_at
    from public.inventory_items it
    where it.is_rental
      and it.status = 'active'
      and it.deleted_at is null
      and it.unit_cost > 0
  ),
  shares as (
    -- Per stored day D: each rental item created before D's close, (D + 1)
    -- 00:00 UTC, at its quantity then (today's less its movements since,
    -- never below 0; one lookup on stock_movements_item_created_idx).
    select
      s.organization_id,
      s.day,
      s.inventory_value as stored_value,
      sum(
        ri.cost * greatest(
          ri.qty - coalesce((
            select sum(sm.quantity_change)
            from public.stock_movements sm
            where sm.item_id = ri.id
              and sm.created_at >= ((s.day + 1)::timestamp at time zone 'utc')
          ), 0),
          0
        )
      )::numeric as rental_value
    from public.org_daily_stats s
    join rental_items ri
      on ri.organization_id = s.organization_id
     and ri.created_at < ((s.day + 1)::timestamp at time zone 'utc')
    group by s.organization_id, s.day, s.inventory_value
  )
  select
    sh.organization_id,
    sh.day,
    sh.stored_value,
    sh.rental_value,
    greatest(sh.stored_value - sh.rental_value, 0)::numeric as corrected_value
  from shares sh
  where sh.rental_value > 0
    and sh.stored_value > 0
$$;

comment on function public.org_daily_stats_rental_correction() is
  'Read-only (0421, B78). One row per stored org_daily_stats day the correction changes: the stored '
  'value, the rental items'' share at that day''s close (each active, non-deleted rental item with a '
  'unit cost above 0 created before (day + 1) 00:00 UTC, at unit_cost x its quantity then: today''s '
  'quantity less its movements since, never below 0) and the corrected value (stored less share, '
  'floored at 0). 0421 applied corrected_value once; applying it again would take rental items out '
  'twice, so 0421 refuses to run while this function exists. EXECUTE: service_role only.';

revoke all on function public.org_daily_stats_rental_correction() from public, anon, authenticated;
grant execute on function public.org_daily_stats_rental_correction() to service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. The correction, once. Only inventory_value changes, and only on the
--    days the helper returns.
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_floored int;
  v_orgs    int;
  v_changed int;
begin
  select count(*) filter (where c.rental_value > c.stored_value),
         count(distinct c.organization_id)
    into v_floored, v_orgs
    from public.org_daily_stats_rental_correction() c;

  update public.org_daily_stats s
     set inventory_value = c.corrected_value
    from public.org_daily_stats_rental_correction() c
   where s.organization_id = c.organization_id
     and s.day = c.day;
  get diagnostics v_changed = row_count;

  raise notice 'B78: took the rental share out of % stored days in % organizations (% floored at 0).',
    v_changed, v_orgs, v_floored;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. The table comment (0230's, restated) records the correction.
-- ────────────────────────────────────────────────────────────────────────────

comment on table public.org_daily_stats is
  'Observed close-of-UTC-day dashboard snapshot per org (0230): active item '
  'count, cost-basis inventory value, low/out-of-stock count. Written by '
  'refresh_org_daily_stats (nightly pg_cron 00:10 UTC + gap self-heal). '
  'Closed-day rows are observations, not rewritten by later edits, with one '
  'exception: 0421 (B78) took the rental items'' share out of every stored '
  'day''s inventory_value once, an estimate from the rental items, quantities '
  'and costs as they were when 0421 ran (a stored day can keep a small '
  'leftover or, rarely, be floored at 0). Every row written since leaves rental items out of '
  'inventory_value; item_count and low_out_count still count them. SELECT '
  'is MANAGER+ only (rls_manager_org_ids): rows are org-wide valuation '
  'aggregates, which warehouse/category-restricted members must not read.';
