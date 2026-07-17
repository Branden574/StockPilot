-- 0275_dashboard_value_series.sql
--
-- ON-DEMAND VALUE SERIES with a COST/RETAIL basis toggle for the dashboard
-- overview "Inventory value" card's interactive Compare / basis controls
-- (Unit A of the interactive value chart). Adds a SINGLE new function; touches
-- nothing that the eager dashboard render depends on.
--
-- ── WHY A NEW SIBLING FUNCTION (not an extended dashboard_history_series) ──────
-- dashboard_history_series (0224/0228, snapshot-backed since 0230) is the hot,
-- eager path every dashboard render hits — its return shape (day_index,
-- item_count, inventory_value, low_out_count) is consumed by mapHistorySeries
-- and the StatCards. Widening it to carry a retail column would force a shape
-- change on that hot path AND require snapshotting retail into org_daily_stats
-- (a new nightly-cron/backfill concern) for parity. This card's Compare/basis
-- overlays are ON-DEMAND only (fired when the user interacts), so the cheapest
-- correct diff is a self-contained reconstructed-math function the on-demand
-- endpoint calls — leaving the eager path, the snapshot tables, and the cron
-- completely untouched.
--
-- ── RETAIL IS APPROXIMATE (read before trusting the retail line) ──────────────
-- This function is RECONSTRUCTED-ONLY: it re-derives each day's per-item qty by
-- reverse-walking stock_movements from current state (the pre-snapshot 0228
-- math), and multiplies by a CURRENT per-item price held CONSTANT across all
-- past days. For basis='cost' that is exactly the fallback approximation the
-- old dashboard already showed on reconstructed days (unit_cost treated as
-- constant); for basis='retail' the same approximation applies to retail_price.
-- Neither basis observes historical price edits — retail history is not
-- snapshotted anywhere. This is the reconstructed (slower) path by design;
-- acceptable because it runs on demand for a 30/90-day window only, never on
-- the eager render. Callers must label the retail overlay "(approx.)".
--
-- ── SECURITY ──────────────────────────────────────────────────────────────────
-- SECURITY INVOKER (RLS binds the caller, exactly like dashboard_history_series
-- and _reconstructed): reads inventory_items + stock_movements under the user's
-- JWT, so warehouse/category scope and cross-org isolation come for free (a
-- non-member / other-org caller aggregates zero rows). search_path pinned.
-- EXECUTE revoked from public/anon; granted to authenticated (the on-demand
-- endpoint calls it via the user client) and service_role.

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
  -- Active, non-deleted, optionally warehouse-scoped items. RLS on
  -- inventory_items applies (SECURITY INVOKER) → per-warehouse/category scope.
  -- `basis` selects the per-item multiplier: retail_price for 'retail'
  -- (COALESCE null → 0), unit_cost for anything else ('cost' — parity with
  -- dashboard_history_series' cost value). Mirrors
  -- dashboard_history_series_reconstructed.scope_items verbatim otherwise.
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
  'dashboard_history_series). RECONSTRUCTED-ONLY: reverse-walks stock_movements '
  'from current state with price held CONSTANT across past days — APPROXIMATE '
  'history (retail is never snapshotted); acceptable on-demand for a 30/90d '
  'window, never the eager render. SECURITY INVOKER — RLS binds the caller '
  '(warehouse/category scope + cross-org isolation); authenticated may execute; '
  'anon/public revoked.';

revoke all on function public.dashboard_value_series(uuid, uuid, int, text) from public;
revoke all on function public.dashboard_value_series(uuid, uuid, int, text) from anon;
grant execute on function public.dashboard_value_series(uuid, uuid, int, text) to authenticated, service_role;
