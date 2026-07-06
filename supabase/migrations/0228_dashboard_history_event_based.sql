-- 0228_dashboard_history_event_based.sql
--
-- PERFORMANCE REWRITE of public.dashboard_history_series (migration 0224).
-- Signature, return columns, row-level output and security posture are all
-- IDENTICAL to 0224 — this migration only changes HOW the low/out series is
-- computed. movements.ts needs zero changes; the ship gate is a row-by-row
-- diff of this function's output against captured 0224 outputs.
--
-- ── WHY (measured on prod, seeded 50k-item / 1.2M-movement org) ─────────────
-- dashboard_history_series(org, null, 90) took 20-24s. Authenticated users run
-- under statement_timeout = 8s, so a 50k-SKU org's dashboard ERRORS. Profile:
-- the inventory_value and item_count parts are cheap (O(in-window movement
-- days) and O(items), both single passes); the bottleneck is 0224's low/out
-- reconstruction, which cross-joins movers × the day spine (50k movers × 91
-- days = 4.5M rows) and pushes every row through a per-item window sort.
-- Target after this rewrite: < 2s at the same scale. dashboard_movement_metrics
-- is NOT touched here (2.7s, separate concern).
--
-- Verified locally (PG18, 50k items / 1.2M movements / 600k in-window across
-- all 50k movers, work_mem=4MB, no parallel workers): 0224 body 4.7s → this
-- body 1.2s at p_days=90 (0.47s at 30), with a ZERO row-by-row diff between
-- the two bodies across 270 fixture/fuzz org×window×warehouse combinations
-- (random fractional quantities, negative reorder points, archived/deleted
-- items, future-dated + out-of-window movements) AND at the 50k-scale org.
--
-- ── THE ALGORITHM (event-based low/out, O(in-window movements)) ─────────────
-- 0224 semantics, unchanged: a scope item's reconstructed end-of-day-d qty is
--     qty_i(d) = currentQty_i − Σ_{j>d} Δqty_i(j)     (Δ = that day's net move)
-- and it counts toward low_out_count[d] when qty_i(d) ≤ threshold_i, where
-- threshold = (reorder_point if > 0 else 0). NOTE (0224 parity, preserved
-- exactly): created_at plays NO role in low_out — an item created mid-window
-- still contributes on EVERY day, evaluated with the same formula (its
-- pre-creation reconstructed qty is typically ≤ 0 → counted as out). Only the
-- item_count series uses created_at (forward creation sweep, kept verbatim).
--
-- KEY OBSERVATION: qty_i(d) is a step function that changes ONLY on item i's
-- own delta days (~a handful per item), so evaluating every mover on every
-- spine day is pure waste. Instead:
--   1. mov — net Δ per (item, day-bucket). Same scope inner-join, same
--      org + created_at >= start window predicate, same day-bucket formula
--      least(last_idx, greatest(0, floor(epoch/86400))) as 0224, verbatim.
--   2. mover_seg — per mov row, a suffix sum over the item's OWN delta rows
--      (window partitioned by item over its ~k rows — never the 91-row spine):
--        qty_after  = currentQty − Σ Δ on that item's LATER delta days
--                     (reconstructed qty from this delta day until the next)
--        qty_before = qty_after − Δ(this day)
--                     (reconstructed qty on the preceding segment)
--   3. Each row emits a ±1 EVENT where the low/out status flips across the
--      delta day: (qty_after ≤ thr)::int − (qty_before ≤ thr)::int.
--   4. base_lowout — the window-start baseline: EVERY scope item evaluated at
--      qty − total in-window Δ (nonmovers: Δ = 0 → their constant current-qty
--      status). One hash-joined pass over scope_items.
--   5. low_out[d] = base + cumulative Σ of events on days ≤ d. Events on day d
--      take effect ON day d (end-of-day semantics — identical to 0224's
--      "rows between unbounded preceding and current row" spine cumulative).
-- Telescoping proof of equivalence: base_status_i + Σ_{m: d_m ≤ d} (status_m −
-- status_{m−1}) = status of item i's last delta day ≤ d (or the baseline when
-- none) = (qty_i(d) ≤ thr) — exactly 0224's predicate. All arithmetic stays in
-- numeric (exact decimal — summation order is irrelevant), so output is
-- bit-identical to 0224. Asserted by supabase/tests/0228_dashboard_history_
-- event_based.test.sql (pgTAP, incl. the 0224 hand-computed rollup + new
-- event-path stress fixtures) and the extended vitest parity suite
-- (apps/web/src/server/services/dashboard-history-parity.test.ts), plus the
-- unchanged 0224 pgTAP behavioral test which now runs against this body.
--
-- Cost: O(in-window movements) for mov + mover_seg, O(items) for the baseline
-- and item_count, O(days) for the spine cumulatives — no items × days blowup.
--
-- ── SECURITY POSTURE (copied from 0224, unchanged) ──────────────────────────
-- SECURITY INVOKER + search_path=public. RLS on inventory_items
-- (user_can_access_inventory 'read' + user_can_see_item_category) binds the
-- caller, so a warehouse-restricted user aggregates only rows they may already
-- read; cross-org calls return zero rows (is_org_member false). EXECUTE is
-- granted to authenticated (the dashboard calls this via the USER client,
-- never service-role) and revoked from anon/public.

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
  -- (Verbatim from 0224.)
  scope_items as (
    select
      it.id,
      coalesce(it.quantity_on_hand, 0)::numeric as qty,
      coalesce(it.unit_cost, 0)::numeric        as cost,
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

revoke all on function public.dashboard_history_series(uuid, uuid, int) from public;
revoke all on function public.dashboard_history_series(uuid, uuid, int) from anon;
-- authenticated MUST execute: this is SECURITY INVOKER and the dashboard calls
-- it via the user client. RLS (org + warehouse + category) binds inside, so an
-- authenticated caller can only ever aggregate rows it may already read.
grant execute on function public.dashboard_history_series(uuid, uuid, int) to authenticated;

comment on function public.dashboard_history_series(uuid, uuid, int) is
  'Per-day dashboard overview series (item_count, inventory_value cost-basis, '
  'low_out_count) over a p_days window; set-based reproduction of movements.ts '
  'getDashboardHistory''s reverse-walk. Low/out uses the event-based '
  'reconstruction from mig 0228 (O(movements), output identical to 0224''s '
  'movers×days walk). SECURITY INVOKER so RLS on inventory_items enforces the '
  'same per-warehouse/category scope the inline query had — called via the '
  'USER client, never service-role. authenticated may execute (cross-org calls '
  'return zero rows via RLS); anon/public revoked.';
