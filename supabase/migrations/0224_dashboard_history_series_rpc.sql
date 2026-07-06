-- 0224_dashboard_history_series_rpc.sql
--
-- Push the dashboard-overview aggregation into Postgres (the #1 scale bug).
--
-- BEFORE: apps/web/src/app/(dashboard)/dashboard/page.tsx called
-- movements.ts getDashboardHistory() TWICE per login (30d + 90d) using
-- UNCAPPED fetchAllRows over active inventory_items AND the whole
-- stock_movements window, then ran an O(rangeDays × items) JS reverse-walk
-- to reconstruct per-day value + low/out-of-stock counts. getThirtyDayMetrics()
-- paged up to 100 000 movements into Node just to COUNT per-day/per-type.
-- At ~1M+ movements that is 1000+ sequential PostgREST round trips + 100+MB
-- of JS objects on EVERY user's EVERY login → multi-second render escalating
-- to Vercel timeout / Node OOM.
--
-- AFTER: two set-based aggregate RPCs return only the ~90 daily rows the
-- charts actually render. Same idea as migration 0223 (inventory_trend_buckets),
-- and the two functions reproduce the JS math EXACTLY (asserted by the vitest
-- parity suite + the 0224 pgTAP behavioral test).
--
-- ── SECURITY POSTURE (deliberate divergence from 0223) ────────────────────
-- 0223's inventory_trend_buckets is service-role-only because it backs an
-- ORG-WIDE shared cache used only for full-access users. The DASHBOARD is
-- different: it is per-user and MUST respect per-warehouse / per-category read
-- access. Today that scoping is provided by RLS on inventory_items
-- (user_can_access_inventory 'read' + user_can_see_item_category) — the inline
-- item query and the movement inner-join both run under the user's JWT, so a
-- warehouse-restricted staff/viewer sees ONLY their assigned warehouses'
-- numbers. stock_movements RLS is org-only, so the effective scope comes from
-- the item side.
--
-- Therefore these RPCs are SECURITY INVOKER and are called via the USER client
-- (ServiceContext.supabase), NOT the service-role admin client. This:
--   • preserves the EXACT scoping (org + warehouse + category + charter) the
--     inline queries had — no cross-warehouse leak, identical numbers per user;
--   • is safe against a cross-ORG oracle: passing another org's id makes every
--     internal query return zero rows (is_org_member / user_can_access_inventory
--     both false) — exactly why get_dashboard_summary (mig 0006) is also
--     SECURITY INVOKER + granted to authenticated;
--   • still captures the full perf win — the O(days × items) rollup happens in
--     Postgres and only the daily rows leave the database.
-- Using service-role here would BYPASS inventory_items RLS and hand every
-- warehouse-restricted user org-wide totals: a data-exposure regression AND
-- wrong per-user math. EXECUTE is granted to authenticated (the caller role)
-- and revoked from anon/public.
--
-- Both functions clamp/bucket days with the same '24 hours' arithmetic 0223
-- uses (pure epoch ms, DST-immune) so parity with the JS Date math is exact.

-- ────────────────────────────────────────────────────────────────────────────
-- dashboard_history_series
--   Replaces getDashboardHistory(): the three per-day series the StatCards +
--   value widget render — item count, inventory value (cost basis), and
--   low/out-of-stock count — over a `p_days` window (30 or 90), oldest → newest
--   (row order = JS array index).
--
-- Faithful reproduction of the JS reverse-walk (movements.ts):
--   scope items = inventory_items WHERE status='active' AND deleted_at IS NULL
--                 [AND warehouse_id = p_warehouse_id]  (+ RLS)
--   valueToday   = Σ(quantity_on_hand · unit_cost) over scope items
--   value[d]     = valueToday − Σ_{j>d} dayValueDelta[j],
--                  dayValueDelta[j] = Σ over scope-item moves in day j of
--                                     (quantity_change · that item's unit_cost)
--                  → exactly the JS "value -= quantity_change * cost" undo,
--                    snapshot taken BEFORE undoing day d.
--   lowOut[d]    = COUNT of scope items whose reconstructed end-of-day-d qty
--                  qty_i(d) = currentQty_i − Σ_{j>d} (item i's day-j Δqty)
--                  satisfies the JS predicate: qty ≤ (reorder>0 ? reorder : 0).
--                  Items with no window movements are constant across days
--                  (nonmover base); movers are reconstructed per day.
--   itemCount[d] = COUNT of scope items with created_at ≤ start + (d+1)·24h
--                  (JS forward sweep). Items created before the window count
--                  from day 0; every scope item counts by the last day.
-- Only movements for items in scope contribute — the JS walk skips any move
-- whose item_id is absent from costById (deleted/inactive/out-of-scope), which
-- the INNER JOIN to scope_items reproduces.
--
-- CALLER: getDashboardHistory (apps/web/src/server/services/movements.ts) via
--         the request's user-authed client. Never a service-role client.
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
  -- ── inventory value series ────────────────────────────────────────────────
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
  -- ── item count series (created_at forward sweep) ──────────────────────────
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
  -- ── low / out-of-stock series (per-item reconstruction) ───────────────────
  movers as (select distinct item_id from mov),
  nonmover_lowout as (
    select count(*)::int as c
    from scope_items si
    where not exists (select 1 from mov m where m.item_id = si.id)
      and si.qty <= (case when si.reorder > 0 then si.reorder else 0 end)
  ),
  -- movers × every day, each row carrying that day's own Δqty (0 if none).
  mover_dense as (
    select mv.item_id, d.day_index, coalesce(m.qty_delta, 0)::numeric as qty_delta
    from movers mv
    cross join days d
    left join mov m on m.item_id = mv.item_id and m.day_index = d.day_index
  ),
  -- Reconstructed end-of-day-d qty = currentQty − Σ_{j>d} Δqty (window in
  -- descending day order, excluding the current row = exactly the JS undo).
  mover_qty as (
    select
      md.item_id,
      md.day_index,
      si.qty - coalesce(
        sum(md.qty_delta) over (
          partition by md.item_id
          order by md.day_index desc
          rows between unbounded preceding and 1 preceding
        ),
        0
      ) as qty_at_day,
      si.reorder
    from mover_dense md
    join scope_items si on si.id = md.item_id
  ),
  mover_lowout as (
    select day_index, count(*)::int as c
    from mover_qty
    where qty_at_day <= (case when reorder > 0 then reorder else 0 end)
    group by day_index
  ),
  low_out_series as (
    select
      d.day_index,
      (coalesce(ml.c, 0) + (select c from nonmover_lowout))::int as low_out_count
    from days d
    left join mover_lowout ml on ml.day_index = d.day_index
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
  'getDashboardHistory''s reverse-walk. SECURITY INVOKER so RLS on '
  'inventory_items enforces the same per-warehouse/category scope the inline '
  'query had — called via the USER client, never service-role. authenticated '
  'may execute (cross-org calls return zero rows via RLS); anon/public revoked.';

-- ────────────────────────────────────────────────────────────────────────────
-- dashboard_movement_metrics
--   Replaces getThirtyDayMetrics(): per (day-bucket, movement_type) counts over
--   a p_days window. The JS then rolls these into dailyCounts[] (Σ over types)
--   and byType[] (Σ over days, sorted desc, share = count/max).
--
-- Scope = movements whose parent item is deleted_at IS NULL [AND warehouse-
-- matched] (+ RLS). NOTE: unlike the history function this does NOT filter on
-- status='active' — it mirrors getThirtyDayMetrics' inner-join, which only
-- required `is('item.deleted_at', null)` (archived items' movements DO count).
--
-- CALLER: getThirtyDayMetrics (movements.ts) via the request's user client.
create or replace function public.dashboard_movement_metrics(
  p_organization_id uuid,
  p_warehouse_id uuid default null,
  p_days int default 30
)
returns table (
  day_index int,
  movement_type text,
  move_count bigint
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
  -- Non-deleted (any status), optionally warehouse-scoped items. RLS applies.
  metric_items as (
    select it.id
    from public.inventory_items it
    where it.organization_id = p_organization_id
      and it.deleted_at is null
      and (p_warehouse_id is null or it.warehouse_id = p_warehouse_id)
  )
  select
    least(
      (select last_idx from params),
      greatest(
        0,
        (floor(extract(epoch from (sm.created_at - (select start_at from params))) / 86400))::int
      )
    ) as day_index,
    sm.movement_type,
    count(*)::bigint as move_count
  from public.stock_movements sm
  join metric_items mi on mi.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.created_at >= (select start_at from params)
  group by 1, 2
$$;

revoke all on function public.dashboard_movement_metrics(uuid, uuid, int) from public;
revoke all on function public.dashboard_movement_metrics(uuid, uuid, int) from anon;
grant execute on function public.dashboard_movement_metrics(uuid, uuid, int) to authenticated;

comment on function public.dashboard_movement_metrics(uuid, uuid, int) is
  'Per (day-bucket, movement_type) movement counts over a p_days window; '
  'set-based reproduction of movements.ts getThirtyDayMetrics (item scope = '
  'deleted_at IS NULL, no status filter). SECURITY INVOKER — RLS on '
  'inventory_items keeps the same per-warehouse/category scope; called via the '
  'USER client. authenticated may execute; anon/public revoked.';
