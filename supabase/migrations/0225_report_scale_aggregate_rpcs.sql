-- 0225_report_scale_aggregate_rpcs.sql
--
-- SILENT-CORRECTNESS scale fix for the Reports service (reports.ts).
--
-- Before: movementSummary / velocityClass / shrinkage / deadStock /
-- bundleActivity each paged a raw rowset into Node under a hard cap
-- (50k / 100k / 50k / 100k-per-batch / 50k) and summed it in JS. Past the
-- cap the accumulated set is an id-ordered SUBSET, so the report's TOTALS
-- (byType counts, totalMovements, totalValueOut, totalUnits/Cost,
-- carrying value, totalRuns/Kits/ValueOut) are silently understated with
-- NO error shown. For an inventory system a confidently-wrong dollar total
-- is worse than a slow page.
--
-- Fix: push the truncation-prone AGGREGATES into Postgres. Each RPC below
-- reproduces the EXACT filter predicates the JS path used (org scope, the
-- caller-supplied `since` instant, movement_type / quantity_change sign
-- filters) so the numbers are identical for a sub-cap org and merely stop
-- truncating past the cap. reports.ts calls these through the SERVICE-ROLE
-- admin client; the org id is passed from the trusted server context
-- (ctx.organizationId), never from user input. Detail line-lists that a
-- report actually DISPLAYS (valuation items, velocity items, dead-stock
-- items, shrinkage events) still stream row-by-row via fetchAllRows — only
-- the roll-up totals move here.
--
-- SECURITY POSTURE (mirrors 0223_inventory_trend_buckets_rpc.sql):
--   • SECURITY INVOKER — a non-bypassrls caller would still be bound by the
--     underlying tables' RLS, so a leaked grant can't become a cross-org
--     oracle. The service-role caller bypasses RLS the same way the JS
--     service path did (it used the user client, but the org scope is the
--     same explicit predicate).
--   • search_path pinned to public.
--   • `p_since timestamptz` is passed as the SAME instant the JS computed
--     (Date.now() − days), NOT recomputed from now() in SQL, so DB/JS clock
--     drift can never shift the window boundary between the two paths.
--   • EXECUTE revoked from public / anon / authenticated and granted ONLY
--     to service_role, so a user-facing client can never call these with an
--     arbitrary org id.
--
-- These RPCs are STABLE (read-only) and volatile-free.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. report_movement_type_summary — movementSummary().byType + totalMovements.
--    JS: filter organization_id + created_at >= since (NO movement_type
--    filter); GROUP BY movement_type → count(*), sum(abs(quantity_change)).
--    totalMovements = data.length = sum(count(*)) over all types, so the
--    caller derives it without a second query.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_movement_type_summary(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  movement_type text,
  movement_count bigint,
  total_qty numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    sm.movement_type,
    count(*)::bigint as movement_count,
    coalesce(sum(abs(coalesce(sm.quantity_change, 0))), 0)::numeric as total_qty
  from public.stock_movements sm
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
  group by sm.movement_type
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. report_top_movers — movementSummary().topMovers.
--    JS: per item (from the joined inventory_items) totalIn = Σ(change ≥ 0),
--    totalOut = Σ(−change where change < 0), movementCount = count(*); sort
--    by (totalIn + totalOut) desc; slice p_limit. item_id FK is NOT NULL and
--    RLS shows every org item (incl. soft-deleted — JS never filtered
--    deleted_at on the embed), so an INNER join reproduces "skip null-item
--    rows" exactly (there are none). Ties past the cut are broken by item_id
--    for determinism (JS broke them by id-ordered fetch order — a display
--    list, not a total).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_top_movers(
  p_organization_id uuid,
  p_since timestamptz,
  p_limit int default 50
)
returns table (
  item_id uuid,
  sku text,
  name text,
  total_in numeric,
  total_out numeric,
  movement_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    sm.item_id,
    i.sku,
    i.name,
    coalesce(sum(case when sm.quantity_change >= 0 then sm.quantity_change else 0 end), 0)::numeric as total_in,
    coalesce(sum(case when sm.quantity_change < 0 then -sm.quantity_change else 0 end), 0)::numeric as total_out,
    count(*)::bigint as movement_count
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
  group by sm.item_id, i.sku, i.name
  order by (
    coalesce(sum(case when sm.quantity_change >= 0 then sm.quantity_change else 0 end), 0)
    + coalesce(sum(case when sm.quantity_change < 0 then -sm.quantity_change else 0 end), 0)
  ) desc, sm.item_id asc
  limit greatest(p_limit, 0)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. report_shrinkage_totals — shrinkage().totalUnits / totalCost.
--    JS: filter movement_type = 'adjust' + quantity_change < 0 +
--    created_at >= since; per row lostUnits = abs(change),
--    cost = lostUnits × (Number(item.unit_cost) || 0). Totals only —
--    the per-event detail rows still stream for display.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_shrinkage_totals(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  total_units numeric,
  total_cost numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(sum(abs(sm.quantity_change)), 0)::numeric as total_units,
    coalesce(sum(abs(sm.quantity_change) * coalesce(i.unit_cost, 0)), 0)::numeric as total_cost
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.movement_type = 'adjust'
    and sm.quantity_change < 0
    and sm.created_at >= p_since
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. report_item_out_movements — the out-movement aggregate shared by
--    velocityClass() and deadStock().
--    JS (both): filter organization_id + created_at >= since +
--    quantity_change < 0 (NO movement_type filter); per item_id
--    unitsOut = Σ abs(quantity_change), lastOutAt = max(created_at).
--    Aggregated over ALL out-movements by item_id (no inventory_items join —
--    the JS keyed on the movement's item_id and intersected with a
--    separately-fetched item list). deadStock only reads the item_id SET
--    (the org-wide set is a superset of its per-item-batch query; the
--    intersection with the stocked-item list is identical), so this one RPC
--    serves both.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_item_out_movements(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  item_id uuid,
  units_out numeric,
  last_out_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    sm.item_id,
    coalesce(sum(abs(coalesce(sm.quantity_change, 0))), 0)::numeric as units_out,
    max(sm.created_at) as last_out_at
  from public.stock_movements sm
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
    and sm.quantity_change < 0
  group by sm.item_id
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. report_bundle_activity — bundleActivity() distribution roll-up.
--    JS: filter organization_id + distributed_at >= since; per bundle
--    runs = count(*), kitsOut = Σ quantity, lastRunAt = max(distributed_at),
--    topWarehouse = the warehouse with the most distribution runs for that
--    bundle. bundle name/sku + warehouse name resolved via join. This is a
--    per-bundle roll-up (bounded by bundle count), so the whole report body
--    comes from here — nothing streams.
--    NOTE topWarehouse tie-break: JS picked the first warehouse to reach the
--    max run count in id-ordered fetch order; here ties break by warehouse_id
--    asc. This affects ONLY the displayed top-warehouse label on an exact
--    run-count tie — never a numeric total.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_bundle_activity(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  bundle_id uuid,
  bundle_name text,
  bundle_sku text,
  runs bigint,
  kits_out numeric,
  last_run_at timestamptz,
  top_warehouse_name text
)
language sql
stable
security invoker
set search_path = public
as $$
  with dist as (
    select bd.bundle_id, bd.warehouse_id, bd.quantity, bd.distributed_at
    from public.bundle_distributions bd
    where bd.organization_id = p_organization_id
      and bd.distributed_at >= p_since
  ),
  wh_runs as (
    select bundle_id, warehouse_id, count(*) as wruns
    from dist
    group by bundle_id, warehouse_id
  ),
  top_wh as (
    select distinct on (bundle_id) bundle_id, warehouse_id
    from wh_runs
    order by bundle_id, wruns desc, warehouse_id asc
  )
  select
    d.bundle_id,
    b.name as bundle_name,
    b.sku as bundle_sku,
    count(*)::bigint as runs,
    coalesce(sum(d.quantity), 0)::numeric as kits_out,
    max(d.distributed_at) as last_run_at,
    w.name as top_warehouse_name
  from dist d
  join public.bundles b on b.id = d.bundle_id
  left join top_wh tw on tw.bundle_id = d.bundle_id
  left join public.warehouses w on w.id = tw.warehouse_id
  group by d.bundle_id, b.name, b.sku, w.name
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. report_bundle_component_value — bundleActivity() component-cost roll-up.
--    JS: filter organization_id + reference_type = 'bundle' +
--    movement_type = 'bundle_distribution' + quantity_change < 0 +
--    created_at >= since; value = abs(quantity_change) × item.unit_cost,
--    grouped by reference_id (= the bundle id; phantom-drain AND component
--    draws both count, matching the JS which applied no is_bundle filter).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.report_bundle_component_value(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  bundle_id uuid,
  component_value_out numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    sm.reference_id as bundle_id,
    coalesce(sum(abs(sm.quantity_change) * coalesce(i.unit_cost, 0)), 0)::numeric as component_value_out
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.reference_type = 'bundle'
    and sm.movement_type = 'bundle_distribution'
    and sm.quantity_change < 0
    and sm.created_at >= p_since
  group by sm.reference_id
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Privilege lock-down — service-role only, for every RPC above. `revoke from
-- public` strips the default PUBLIC execute grant; anon/authenticated are
-- listed explicitly so a later blanket re-grant to public can't silently
-- re-open them without this migration surfacing in the blame.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  fn text;
  fns text[] := array[
    'public.report_movement_type_summary(uuid, timestamptz)',
    'public.report_top_movers(uuid, timestamptz, int)',
    'public.report_shrinkage_totals(uuid, timestamptz)',
    'public.report_item_out_movements(uuid, timestamptz)',
    'public.report_bundle_activity(uuid, timestamptz)',
    'public.report_bundle_component_value(uuid, timestamptz)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

comment on function public.report_movement_type_summary(uuid, timestamptz) is
  'Reports service: stock-movement rollup by movement_type (count + sum(abs(quantity_change))) '
  'over org + created_at >= since. Reproduces reports.ts movementSummary().byType/totalMovements '
  'DB-side so the totals cannot truncate past the old 50k JS cap. Service-role only.';
comment on function public.report_top_movers(uuid, timestamptz, int) is
  'Reports service: top-N items by gross units moved (totalIn/totalOut/movementCount) over '
  'org + created_at >= since. Reproduces reports.ts movementSummary().topMovers. Service-role only.';
comment on function public.report_shrinkage_totals(uuid, timestamptz) is
  'Reports service: shrinkage totals (units + cost) for adjust/negative movements over '
  'org + created_at >= since. Reproduces reports.ts shrinkage() totals DB-side. Service-role only.';
comment on function public.report_item_out_movements(uuid, timestamptz) is
  'Reports service: per-item out-movement aggregate (units_out + last_out_at) over '
  'org + created_at >= since + quantity_change < 0. Shared by velocityClass() and deadStock(). '
  'Service-role only.';
comment on function public.report_bundle_activity(uuid, timestamptz) is
  'Reports service: bundle distribution rollup (runs/kits_out/last_run_at/top_warehouse) over '
  'org + distributed_at >= since. Reproduces reports.ts bundleActivity() distribution side. '
  'Service-role only.';
comment on function public.report_bundle_component_value(uuid, timestamptz) is
  'Reports service: per-bundle component cost of bundle_distribution draws over '
  'org + created_at >= since. Reproduces reports.ts bundleActivity() componentValueOut. '
  'Service-role only.';
