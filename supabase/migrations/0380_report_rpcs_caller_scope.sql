-- 0380_report_rpcs_caller_scope.sql
--
-- The six report aggregates from 0225 answer for the CALLER, not for the
-- whole organization.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
-- ReportsService (apps/web/src/server/services/reports.ts) called these six
-- functions through the SERVICE-ROLE client with only an organization id.
-- The service role bypasses row level security, so every report reader got
-- organization-wide answers: a warehouse-scoped staff member or a
-- category-scoped viewer holding reports:read saw the SKUs and names of items
-- outside their scope in Top movers (Stock movement summary), shrinkage
-- totals that included other warehouses' losses, and the names of warehouses
-- they cannot open in Bundle activity, on the pages and in the CSV and PDF
-- exports. Proven locally on 2026-09-28 (stockpilot-work/sec-reports).
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- ReportsService now calls them with the CALLER'S client. They were already
-- SECURITY INVOKER, so the policies on stock_movements, inventory_items,
-- bundle_distributions, bundles and warehouses now decide what each answer
-- contains: the report shows exactly what the caller could read row by row,
-- and nothing more. The query bodies are UNCHANGED from 0225 (same filters,
-- same joins, same grouping and order), so a reader who can read every row
-- (owner, admin, manager) gets byte-identical answers.
--
-- Each function now holds its own gates in its body, in the Book Order
-- Totals order (0379): signed in (42501 unauthenticated); a member holding
-- reports:read (42501 forbidden, one error for a non-member, a disabled
-- member and a missing permission, so existence does not leak); and for the
-- two bundle functions the bundles module (P0001 module_disabled). Core
-- modules (reports, movements, inventory) are never gated here: the apps
-- treat them as always on, and module_enabled() only reads rows. Nothing
-- raises 40001 or 40P01.
--
-- EXECUTE is granted to authenticated (it was service_role only). anon and
-- PUBLIC stay revoked.
--
-- ── ROLLOUT: THE SERVICE ROLE, FOR NOW ─────────────────────────────────────
-- The code that is live when this migration is pushed still calls these
-- functions with the service role, which carries no user. So that this
-- migration can go FIRST without breaking those reports, a call with no user
-- is still answered when, and only when, the calling role is service_role,
-- exactly as before (the service role reads every row of every table
-- anyway; this adds nothing it could not already do). Every other caller
-- without a user is refused. Once the new code is live, a follow-up
-- migration revokes service_role and removes that branch (recorded in
-- stockpilot-work/six/followups.md).
--
-- plan_cache_mode = force_custom_plan, as 0379: plpgsql caches statement
-- plans per session, and a generic plan cannot see how far back p_since
-- reaches.

set lock_timeout = '5s';

-- ═══ 1. report_movement_type_summary ════════════════════════════════════════
create or replace function public.report_movement_type_summary(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  movement_type text,
  movement_count bigint,
  total_qty numeric
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    if current_user <> 'service_role' then
      raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
    end if;
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    sm.movement_type,
    count(*)::bigint as movement_count,
    coalesce(sum(abs(coalesce(sm.quantity_change, 0))), 0)::numeric as total_qty
  from public.stock_movements sm
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
  group by sm.movement_type;
end $$;

-- ═══ 2. report_top_movers ═══════════════════════════════════════════════════
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
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    if current_user <> 'service_role' then
      raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
    end if;
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
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
  limit greatest(p_limit, 0);
end $$;

-- ═══ 3. report_shrinkage_totals ═════════════════════════════════════════════
create or replace function public.report_shrinkage_totals(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  total_units numeric,
  total_cost numeric
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    if current_user <> 'service_role' then
      raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
    end if;
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    coalesce(sum(abs(sm.quantity_change)), 0)::numeric as total_units,
    coalesce(sum(abs(sm.quantity_change) * coalesce(i.unit_cost, 0)), 0)::numeric as total_cost
  from public.stock_movements sm
  join public.inventory_items i on i.id = sm.item_id
  where sm.organization_id = p_organization_id
    and sm.movement_type = 'adjust'
    and sm.quantity_change < 0
    and sm.created_at >= p_since;
end $$;

-- ═══ 4. report_item_out_movements ═══════════════════════════════════════════
create or replace function public.report_item_out_movements(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  item_id uuid,
  units_out numeric,
  last_out_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    if current_user <> 'service_role' then
      raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
    end if;
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  end if;

  return query
  select
    sm.item_id,
    coalesce(sum(abs(coalesce(sm.quantity_change, 0))), 0)::numeric as units_out,
    max(sm.created_at) as last_out_at
  from public.stock_movements sm
  where sm.organization_id = p_organization_id
    and sm.created_at >= p_since
    and sm.quantity_change < 0
  group by sm.item_id;
end $$;

-- ═══ 5. report_bundle_activity ══════════════════════════════════════════════
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
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    if current_user <> 'service_role' then
      raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
    end if;
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  elsif not public.module_enabled(p_organization_id, 'bundles') then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  return query
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
  group by d.bundle_id, b.name, b.sku, w.name;
end $$;

-- ═══ 6. report_bundle_component_value ═══════════════════════════════════════
create or replace function public.report_bundle_component_value(
  p_organization_id uuid,
  p_since timestamptz
)
returns table (
  bundle_id uuid,
  component_value_out numeric
)
language plpgsql
stable
security invoker
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  if (select auth.uid()) is null then
    if current_user <> 'service_role' then
      raise exception 'unauthenticated' using errcode = '42501', hint = 'unauthenticated';
    end if;
  elsif not public.is_org_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'reports:read') then
    raise exception 'forbidden' using errcode = '42501', hint = 'forbidden';
  elsif not public.module_enabled(p_organization_id, 'bundles') then
    raise exception 'module disabled' using errcode = 'P0001', hint = 'module_disabled';
  end if;

  return query
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
  group by sm.reference_id;
end $$;

-- ═══ Grants ═════════════════════════════════════════════════════════════════
-- authenticated gains EXECUTE; the gates above and RLS decide the answer.
-- service_role keeps EXECUTE for the rollout only (see the header).
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
    execute format('grant execute on function %s to authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- ═══ Comments ═══════════════════════════════════════════════════════════════
comment on function public.report_movement_type_summary(uuid, timestamptz) is
  'Reports: stock movements by movement_type (count + sum(abs(quantity_change))) over org + '
  'created_at >= since, for movements the CALLER can read (SECURITY INVOKER; stock_movements RLS). '
  'Gated in its body: signed in, member with reports:read (0380). Called with the caller''s client.';
comment on function public.report_top_movers(uuid, timestamptz, int) is
  'Reports: top-N items by gross units moved over org + created_at >= since, for movements and items '
  'the CALLER can read (SECURITY INVOKER; stock_movements and inventory_items RLS). Gated in its body: '
  'signed in, member with reports:read (0380).';
comment on function public.report_shrinkage_totals(uuid, timestamptz) is
  'Reports: shrinkage totals (units + cost) for adjust/negative movements over org + created_at >= '
  'since, for movements and items the CALLER can read (SECURITY INVOKER). Gated in its body: signed '
  'in, member with reports:read (0380).';
comment on function public.report_item_out_movements(uuid, timestamptz) is
  'Reports: per-item out-movement aggregate (units_out + last_out_at) over org + created_at >= since '
  '+ quantity_change < 0, for movements the CALLER can read (SECURITY INVOKER). Shared by '
  'velocityClass() and deadStock(). Gated in its body: signed in, member with reports:read (0380).';
comment on function public.report_bundle_activity(uuid, timestamptz) is
  'Reports: bundle distribution rollup (runs/kits_out/last_run_at/top_warehouse) over org + '
  'distributed_at >= since, under the CALLER''s RLS (a warehouse the caller cannot read has no name). '
  'Gated in its body: signed in, member with reports:read, the bundles module (0380).';
comment on function public.report_bundle_component_value(uuid, timestamptz) is
  'Reports: per-bundle component cost of bundle_distribution draws over org + created_at >= since, '
  'for movements and items the CALLER can read (SECURITY INVOKER). Gated in its body: signed in, '
  'member with reports:read, the bundles module (0380).';
