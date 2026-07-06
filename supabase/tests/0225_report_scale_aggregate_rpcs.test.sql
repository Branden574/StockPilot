-- supabase/tests/0225_report_scale_aggregate_rpcs.test.sql
-- Proves migration 0225: the six service-role-only report aggregate RPCs that
-- replace reports.ts's truncation-prone JS roll-ups —
--   report_movement_type_summary, report_top_movers, report_shrinkage_totals,
--   report_item_out_movements, report_bundle_activity,
--   report_bundle_component_value.
-- For each:
--   • exists with the declared signature,
--   • SECURITY INVOKER with search_path pinned to public,
--   • anon/authenticated hold NO EXECUTE (so they can never become a
--     cross-org aggregate oracle for user clients); service_role can execute,
--   • behavioral: seeded fixtures aggregate into hand-computed totals, with
--     out-of-window rows excluded and cross-org rows isolated.
-- Plus live 42501 probes on a representative function and a service_role
-- lives_ok.
--
-- now() = transaction_timestamp() is constant across this begin/rollback
-- block, so p_since (= now() − 30 days) and the seeded created_at offsets are
-- computed from the SAME instant — window membership below is exact, not racy.
--
-- Namespace: ac022500 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(47);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- Org A = plain-movement fixtures (type-summary / top-movers / shrinkage /
-- out-movements). Org B = bundle fixtures (activity / component-value). The
-- separation doubles as cross-org isolation: an org-A query must never see an
-- org-B row and vice versa (results_eq below is a FULL-set match).
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.organizations (id, name, slug) values
  ('ac022500-0000-0000-0000-000000000001', 'Report Scale Org A', 'report-scale-a-0225'),
  ('ac022500-0000-0000-0000-000000000002', 'Report Scale Org B', 'report-scale-b-0225')
  on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac022500-0000-0000-0000-000000000003', 'ac022500-0000-0000-0000-000000000001', 'WH A',  'WH-A-0225',  'active'),
  ('ac022500-0000-0000-0000-000000000004', 'ac022500-0000-0000-0000-000000000002', 'WH B',  'WH-B-0225',  'active'),
  ('ac022500-0000-0000-0000-000000000005', 'ac022500-0000-0000-0000-000000000002', 'WH B2', 'WH-B2-0225', 'active')
  on conflict (id) do nothing;

-- Org A items (itemA …010 < itemB …011 < itemC …012, ordering matters).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type)
values
  ('ac022500-0000-0000-0000-000000000010', 'ac022500-0000-0000-0000-000000000001',
   'ac022500-0000-0000-0000-000000000003', 'RS-A', 'Item A', 100, 100, 'active', 'none'),
  ('ac022500-0000-0000-0000-000000000011', 'ac022500-0000-0000-0000-000000000001',
   'ac022500-0000-0000-0000-000000000003', 'RS-B', 'Item B', 100, 10,  'active', 'none'),
  ('ac022500-0000-0000-0000-000000000012', 'ac022500-0000-0000-0000-000000000001',
   'ac022500-0000-0000-0000-000000000003', 'RS-C', 'Item C', 100, 1,   'active', 'none'),
  -- Org B items (for bundle component value).
  ('ac022500-0000-0000-0000-000000000013', 'ac022500-0000-0000-0000-000000000002',
   'ac022500-0000-0000-0000-000000000004', 'RS-BX', 'Item BX', 100, 100, 'active', 'none'),
  ('ac022500-0000-0000-0000-000000000014', 'ac022500-0000-0000-0000-000000000002',
   'ac022500-0000-0000-0000-000000000004', 'RS-BY', 'Item BY', 100, 10,  'active', 'none')
  on conflict (id) do nothing;

-- Org A movements. Window anchor = now() − 30 days; created_at offsets keep
-- the +999 add OUT of window.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  -- itemA: add +20, remove −10, adjust −2 (adjust dated −3d for a distinct max last_out).
  ('ac022500-0000-0000-0000-000000000001', 'ac022500-0000-0000-0000-000000000010', 'add',    20, 0, 20, now() - interval '5 days'),
  ('ac022500-0000-0000-0000-000000000001', 'ac022500-0000-0000-0000-000000000010', 'remove', -10, 20, 10, now() - interval '5 days'),
  ('ac022500-0000-0000-0000-000000000001', 'ac022500-0000-0000-0000-000000000010', 'adjust', -2, 10, 8, now() - interval '3 days'),
  -- itemB: add +15.
  ('ac022500-0000-0000-0000-000000000001', 'ac022500-0000-0000-0000-000000000011', 'add',    15, 0, 15, now() - interval '5 days'),
  -- itemC: adjust −7.
  ('ac022500-0000-0000-0000-000000000001', 'ac022500-0000-0000-0000-000000000012', 'adjust', -7, 100, 93, now() - interval '5 days'),
  -- itemA: OUT of window add +999 (now − 40d) — must be excluded everywhere.
  ('ac022500-0000-0000-0000-000000000001', 'ac022500-0000-0000-0000-000000000010', 'add',    999, 0, 999, now() - interval '40 days');

-- Org B bundle + distributions + component-draw movements.
insert into public.bundles (id, organization_id, name, sku) values
  ('ac022500-0000-0000-0000-000000000020', 'ac022500-0000-0000-0000-000000000002', 'Kit B', 'KB-0225')
  on conflict (id) do nothing;

insert into public.bundle_distributions
  (organization_id, bundle_id, warehouse_id, quantity, distributed_at)
values
  -- WH B ×2 runs, WH B2 ×1 run → top warehouse = WH B. Total kits 35 in window.
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000020', 'ac022500-0000-0000-0000-000000000004', 10, now() - interval '5 days'),
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000020', 'ac022500-0000-0000-0000-000000000004', 20, now() - interval '4 days'),
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000020', 'ac022500-0000-0000-0000-000000000005', 5,  now() - interval '3 days'),
  -- OUT of window — excluded from runs/kits.
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000020', 'ac022500-0000-0000-0000-000000000004', 999, now() - interval '40 days');

-- Org B bundle_distribution component draws (reference_type='bundle',
-- reference_id = bundle id). value = abs(change) × unit_cost.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, reference_type, reference_id, created_at)
values
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000013', 'bundle_distribution', -3, 100, 97, 'bundle', 'ac022500-0000-0000-0000-000000000020', now() - interval '5 days'),
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000014', 'bundle_distribution', -5, 100, 95, 'bundle', 'ac022500-0000-0000-0000-000000000020', now() - interval '5 days'),
  -- OUT of window — excluded from component value.
  ('ac022500-0000-0000-0000-000000000002', 'ac022500-0000-0000-0000-000000000013', 'bundle_distribution', -1, 100, 99, 'bundle', 'ac022500-0000-0000-0000-000000000020', now() - interval '40 days');

-- ═════════════════════════════════════════════════════════════════════════════
-- SHAPE + PRIVILEGE MATRIX (6 checks × 6 functions = 36)
-- ═════════════════════════════════════════════════════════════════════════════

-- report_movement_type_summary(uuid, timestamptz) ────────────────────────────
select has_function('public', 'report_movement_type_summary',
  array['uuid', 'timestamp with time zone'], 'report_movement_type_summary exists');
select is((select prosecdef from pg_proc
  where oid = 'public.report_movement_type_summary(uuid, timestamptz)'::regprocedure),
  false, 'report_movement_type_summary is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.report_movement_type_summary(uuid, timestamptz)'::regprocedure),
  'report_movement_type_summary search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.report_movement_type_summary(uuid, timestamptz)', 'execute'),
  'report_movement_type_summary: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.report_movement_type_summary(uuid, timestamptz)', 'execute'),
  'report_movement_type_summary: authenticated has no EXECUTE');
select ok(has_function_privilege('service_role',
  'public.report_movement_type_summary(uuid, timestamptz)', 'execute'),
  'report_movement_type_summary: service_role has EXECUTE');

-- report_top_movers(uuid, timestamptz, integer) ──────────────────────────────
select has_function('public', 'report_top_movers',
  array['uuid', 'timestamp with time zone', 'integer'], 'report_top_movers exists');
select is((select prosecdef from pg_proc
  where oid = 'public.report_top_movers(uuid, timestamptz, integer)'::regprocedure),
  false, 'report_top_movers is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.report_top_movers(uuid, timestamptz, integer)'::regprocedure),
  'report_top_movers search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.report_top_movers(uuid, timestamptz, integer)', 'execute'),
  'report_top_movers: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.report_top_movers(uuid, timestamptz, integer)', 'execute'),
  'report_top_movers: authenticated has no EXECUTE');
select ok(has_function_privilege('service_role',
  'public.report_top_movers(uuid, timestamptz, integer)', 'execute'),
  'report_top_movers: service_role has EXECUTE');

-- report_shrinkage_totals(uuid, timestamptz) ─────────────────────────────────
select has_function('public', 'report_shrinkage_totals',
  array['uuid', 'timestamp with time zone'], 'report_shrinkage_totals exists');
select is((select prosecdef from pg_proc
  where oid = 'public.report_shrinkage_totals(uuid, timestamptz)'::regprocedure),
  false, 'report_shrinkage_totals is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.report_shrinkage_totals(uuid, timestamptz)'::regprocedure),
  'report_shrinkage_totals search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.report_shrinkage_totals(uuid, timestamptz)', 'execute'),
  'report_shrinkage_totals: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.report_shrinkage_totals(uuid, timestamptz)', 'execute'),
  'report_shrinkage_totals: authenticated has no EXECUTE');
select ok(has_function_privilege('service_role',
  'public.report_shrinkage_totals(uuid, timestamptz)', 'execute'),
  'report_shrinkage_totals: service_role has EXECUTE');

-- report_item_out_movements(uuid, timestamptz) ───────────────────────────────
select has_function('public', 'report_item_out_movements',
  array['uuid', 'timestamp with time zone'], 'report_item_out_movements exists');
select is((select prosecdef from pg_proc
  where oid = 'public.report_item_out_movements(uuid, timestamptz)'::regprocedure),
  false, 'report_item_out_movements is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.report_item_out_movements(uuid, timestamptz)'::regprocedure),
  'report_item_out_movements search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.report_item_out_movements(uuid, timestamptz)', 'execute'),
  'report_item_out_movements: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.report_item_out_movements(uuid, timestamptz)', 'execute'),
  'report_item_out_movements: authenticated has no EXECUTE');
select ok(has_function_privilege('service_role',
  'public.report_item_out_movements(uuid, timestamptz)', 'execute'),
  'report_item_out_movements: service_role has EXECUTE');

-- report_bundle_activity(uuid, timestamptz) ──────────────────────────────────
select has_function('public', 'report_bundle_activity',
  array['uuid', 'timestamp with time zone'], 'report_bundle_activity exists');
select is((select prosecdef from pg_proc
  where oid = 'public.report_bundle_activity(uuid, timestamptz)'::regprocedure),
  false, 'report_bundle_activity is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.report_bundle_activity(uuid, timestamptz)'::regprocedure),
  'report_bundle_activity search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.report_bundle_activity(uuid, timestamptz)', 'execute'),
  'report_bundle_activity: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.report_bundle_activity(uuid, timestamptz)', 'execute'),
  'report_bundle_activity: authenticated has no EXECUTE');
select ok(has_function_privilege('service_role',
  'public.report_bundle_activity(uuid, timestamptz)', 'execute'),
  'report_bundle_activity: service_role has EXECUTE');

-- report_bundle_component_value(uuid, timestamptz) ───────────────────────────
select has_function('public', 'report_bundle_component_value',
  array['uuid', 'timestamp with time zone'], 'report_bundle_component_value exists');
select is((select prosecdef from pg_proc
  where oid = 'public.report_bundle_component_value(uuid, timestamptz)'::regprocedure),
  false, 'report_bundle_component_value is SECURITY INVOKER');
select ok((select proconfig @> array['search_path=public'] from pg_proc
  where oid = 'public.report_bundle_component_value(uuid, timestamptz)'::regprocedure),
  'report_bundle_component_value search_path pinned to public');
select ok(not has_function_privilege('anon',
  'public.report_bundle_component_value(uuid, timestamptz)', 'execute'),
  'report_bundle_component_value: anon has no EXECUTE');
select ok(not has_function_privilege('authenticated',
  'public.report_bundle_component_value(uuid, timestamptz)', 'execute'),
  'report_bundle_component_value: authenticated has no EXECUTE');
select ok(has_function_privilege('service_role',
  'public.report_bundle_component_value(uuid, timestamptz)', 'execute'),
  'report_bundle_component_value: service_role has EXECUTE');

-- ═════════════════════════════════════════════════════════════════════════════
-- LIVE PRIVILEGE PROBES (3) — representative function.
-- ═════════════════════════════════════════════════════════════════════════════

set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select throws_ok(
  $$ select * from public.report_movement_type_summary('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days') $$,
  '42501', null, 'anon cannot execute report_movement_type_summary');
reset role;

set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ select * from public.report_movement_type_summary('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days') $$,
  '42501', null, 'authenticated cannot execute report_movement_type_summary (not even for its own org)');
reset role;

set local role to 'service_role';
select lives_ok(
  $$ select * from public.report_movement_type_summary('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days') $$,
  'service_role can execute report_movement_type_summary');
reset role;

-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIORAL (8) — hand-computed roll-ups; out-of-window excluded, org-scoped.
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. movement_type_summary: adjust(2,9), add(2,35), remove(1,10). The +999
--    add (out of window) and all org-B rows are absent (full-set match).
select results_eq(
  $$ select movement_type, movement_count, total_qty
       from public.report_movement_type_summary('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days')
      order by movement_type $$,
  $$ values ('adjust', 2::bigint, 9::numeric),
            ('add',    2::bigint, 35::numeric),
            ('remove', 1::bigint, 10::numeric) $$,
  'movement_type_summary: per-type count + sum(abs(qty)), window + org scoped');

-- 2. top_movers: itemA(20,12,3) gross 32, itemB(15,0,1) gross 15, itemC(0,7,1) gross 7.
select results_eq(
  $$ select item_id, sku, name, total_in, total_out, movement_count
       from public.report_top_movers('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days', 50) $$,
  $$ values
       ('ac022500-0000-0000-0000-000000000010'::uuid, 'RS-A', 'Item A', 20::numeric, 12::numeric, 3::bigint),
       ('ac022500-0000-0000-0000-000000000011'::uuid, 'RS-B', 'Item B', 15::numeric,  0::numeric, 1::bigint),
       ('ac022500-0000-0000-0000-000000000012'::uuid, 'RS-C', 'Item C',  0::numeric,  7::numeric, 1::bigint) $$,
  'top_movers: per-item in/out/count ordered by gross moved desc');

-- 3. shrinkage_totals: itemA adjust −2 (×100) + itemC adjust −7 (×1) → 9 units, 207 cost.
select results_eq(
  $$ select total_units, total_cost
       from public.report_shrinkage_totals('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days') $$,
  $$ values (9::numeric, 207::numeric) $$,
  'shrinkage_totals: sum(abs(qty)) + sum(abs(qty)*unit_cost) for adjust/negative in window');

-- 4. item_out_movements: itemA units_out 12, itemC units_out 7 (itemB has no out).
select results_eq(
  $$ select item_id, units_out
       from public.report_item_out_movements('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days')
      order by item_id $$,
  $$ values
       ('ac022500-0000-0000-0000-000000000010'::uuid, 12::numeric),
       ('ac022500-0000-0000-0000-000000000012'::uuid,  7::numeric) $$,
  'item_out_movements: per-item sum(abs(qty)) over out-movements, window + org scoped');

-- 5. item_out_movements: itemA last_out_at = the −3d adjust (max created_at).
select is(
  (select last_out_at from public.report_item_out_movements('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days')
     where item_id = 'ac022500-0000-0000-0000-000000000010'::uuid),
  now() - interval '3 days',
  'item_out_movements: last_out_at = max(created_at) of the item''s out-movements');

-- 6. bundle_activity: kit B runs 3, kits 35, top warehouse WH B (2 runs vs WH B2 1).
select results_eq(
  $$ select bundle_id, bundle_name, bundle_sku, runs, kits_out, top_warehouse_name
       from public.report_bundle_activity('ac022500-0000-0000-0000-000000000002'::uuid, now() - interval '30 days') $$,
  $$ values
       ('ac022500-0000-0000-0000-000000000020'::uuid, 'Kit B', 'KB-0225', 3::bigint, 35::numeric, 'WH B') $$,
  'bundle_activity: runs/kits_out/top_warehouse per bundle, window + org scoped');

-- 7. bundle_activity(orgA) is empty — org A has no distributions (isolation).
select is(
  (select count(*) from public.report_bundle_activity('ac022500-0000-0000-0000-000000000001'::uuid, now() - interval '30 days')),
  0::bigint,
  'bundle_activity: org with no distributions returns no rows (cross-org isolation)');

-- 8. bundle_component_value: kit B = itemBX(3×100) + itemBY(5×10) = 350.
select results_eq(
  $$ select bundle_id, component_value_out
       from public.report_bundle_component_value('ac022500-0000-0000-0000-000000000002'::uuid, now() - interval '30 days') $$,
  $$ values ('ac022500-0000-0000-0000-000000000020'::uuid, 350::numeric) $$,
  'bundle_component_value: sum(abs(qty)*unit_cost) of bundle_distribution draws per bundle');

select * from finish();
rollback;
