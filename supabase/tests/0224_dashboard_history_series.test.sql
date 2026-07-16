-- supabase/tests/0224_dashboard_history_series.test.sql
-- Proves migration 0224: public.dashboard_history_series + public.
-- dashboard_movement_metrics — the set-based twins of movements.ts
-- getDashboardHistory / getThirtyDayMetrics.
--
--   • both exist with the (uuid, uuid, integer) signature,
--   • both are SECURITY INVOKER with search_path pinned to public,
--   • anon holds NO EXECUTE (live 42501 probe) — but, unlike 0223's
--     service-role-only aggregate, `authenticated` DOES hold EXECUTE: these
--     back the per-user dashboard and must run under the caller's JWT so RLS
--     on inventory_items enforces the SAME per-warehouse/category scope the
--     old inline queries had. Cross-org safety comes from RLS returning zero
--     rows for a non-member (asserted live), exactly like get_dashboard_summary,
--   • behavioral: hand-computed per-day series (value reverse-walk, low/out
--     per-item reconstruction, item-count creation sweep) and per-(day,type)
--     movement counts — including the active-only vs deleted_at-only scope
--     difference between the two functions, out-of-window exclusion, the
--     day-bucket clamp, and cross-org isolation.
--
-- now() is transaction_timestamp() — constant for this begin/rollback block —
-- so the seed offsets and each function's own window anchor share one instant;
-- the day indexes below are exact, not racy. p_days = 3 (last_idx = 2, window =
-- now() − 72h) keeps the arithmetic hand-tractable.
--
-- Namespace: ac022400. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(15);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.organizations (id, name, slug) values
  ('ac022400-0000-0000-0000-000000000001', 'Dash Hist Org A', 'dash-hist-a-0224'),
  ('ac022400-0000-0000-0000-000000000002', 'Dash Hist Org B', 'dash-hist-b-0224')
  on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac022400-0000-0000-0000-000000000003', 'ac022400-0000-0000-0000-000000000001', 'DH WH A', 'WH-DHA', 'active'),
  ('ac022400-0000-0000-0000-000000000004', 'ac022400-0000-0000-0000-000000000002', 'DH WH B', 'WH-DHB', 'active')
  on conflict (id) do nothing;

-- Org A items. P/Q/R are active + non-deleted (history scope). S is ARCHIVED
-- (excluded from history's status='active' filter, but included in metrics'
-- deleted_at-only filter). T is DELETED (excluded from BOTH). If either scope
-- filter regressed, S or T would perturb the hand-computed expectations below.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, reorder_point,
   status, tracking_type, created_at, deleted_at)
values
  -- P: mover; historical qty higher → low-flip on day 1. reorder 4.
  ('ac022400-0000-0000-0000-000000000010', 'ac022400-0000-0000-0000-000000000001',
   'ac022400-0000-0000-0000-000000000003', 'DH-P', 'Item P', 10, 2, 4,
   'active', 'none', now() - interval '100 days', null),
  -- Q: nonmover, always out (qty 0, reorder 0 → threshold 0).
  ('ac022400-0000-0000-0000-000000000011', 'ac022400-0000-0000-0000-000000000001',
   'ac022400-0000-0000-0000-000000000003', 'DH-Q', 'Item Q', 0, 5, 0,
   'active', 'none', now() - interval '100 days', null),
  -- R: mover, healthy; created INSIDE the window (30h ago → counted from day 1).
  ('ac022400-0000-0000-0000-000000000012', 'ac022400-0000-0000-0000-000000000001',
   'ac022400-0000-0000-0000-000000000003', 'DH-R', 'Item R', 100, 1, 10,
   'active', 'none', now() - interval '30 hours', null),
  -- S: ARCHIVED, deleted_at null. Metrics include it; history must not.
  ('ac022400-0000-0000-0000-000000000013', 'ac022400-0000-0000-0000-000000000001',
   'ac022400-0000-0000-0000-000000000003', 'DH-S', 'Item S', 0, 5, 0,
   'archived', 'none', now() - interval '100 days', null),
  -- T: active but DELETED. Both functions must exclude it.
  ('ac022400-0000-0000-0000-000000000014', 'ac022400-0000-0000-0000-000000000001',
   'ac022400-0000-0000-0000-000000000003', 'DH-T', 'Item T', 0, 3, 0,
   'active', 'none', now() - interval '100 days', now() - interval '1 hour'),
  -- Org B item (isolation): its movement must never leak into org A.
  ('ac022400-0000-0000-0000-000000000015', 'ac022400-0000-0000-0000-000000000002',
   'ac022400-0000-0000-0000-000000000004', 'DH-B', 'Item B (other org)', 7, 9, 3,
   'active', 'none', now() - interval '100 days', null)
  on conflict (id) do nothing;

-- Movements. Window start = now() − 72h; day_index = floor(hours_since_start/24),
-- clamped [0,2]. P +6 @ now−12h → day2; P −3 @ now−36h → day1; R −95 @ now−6h →
-- day2; S adjust @ now−60h → day0; T adjust @ now−54h → day0.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  ('ac022400-0000-0000-0000-000000000001', 'ac022400-0000-0000-0000-000000000010',
   'add',    6, 4, 10, now() - interval '12 hours'),
  ('ac022400-0000-0000-0000-000000000001', 'ac022400-0000-0000-0000-000000000010',
   'remove', -3, 13, 10, now() - interval '36 hours'),
  ('ac022400-0000-0000-0000-000000000001', 'ac022400-0000-0000-0000-000000000012',
   'remove', -95, 195, 100, now() - interval '6 hours'),
  -- S (archived): counted by metrics only.
  ('ac022400-0000-0000-0000-000000000001', 'ac022400-0000-0000-0000-000000000013',
   'adjust', 1, 0, 1, now() - interval '60 hours'),
  -- T (deleted): counted by NEITHER function.
  ('ac022400-0000-0000-0000-000000000001', 'ac022400-0000-0000-0000-000000000014',
   'adjust', 1, 0, 1, now() - interval '54 hours'),
  -- P, OUT of window (100h): excluded everywhere.
  ('ac022400-0000-0000-0000-000000000001', 'ac022400-0000-0000-0000-000000000010',
   'add', 777, 0, 777, now() - interval '100 hours'),
  -- Org B movement inside the window: must never leak into org A.
  ('ac022400-0000-0000-0000-000000000002', 'ac022400-0000-0000-0000-000000000015',
   'add', 50, 0, 50, now() - interval '6 hours');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-2. Shape: both functions exist with the (uuid, uuid, integer) signature.
-- ─────────────────────────────────────────────────────────────────────────────

select has_function(
  'public', 'dashboard_history_series', array['uuid', 'uuid', 'integer'],
  'dashboard_history_series(uuid, uuid, integer) exists'
);
select has_function(
  'public', 'dashboard_movement_metrics', array['uuid', 'uuid', 'integer'],
  'dashboard_movement_metrics(uuid, uuid, integer) exists'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3-6. SECURITY INVOKER (not definer) + search_path pinned — for both.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_history_series(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_history_series is SECURITY INVOKER (RLS binds the caller)'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_movement_metrics(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_movement_metrics is SECURITY INVOKER (RLS binds the caller)'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.dashboard_history_series(uuid, uuid, integer)'::regprocedure),
  'dashboard_history_series search_path is pinned to public'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.dashboard_movement_metrics(uuid, uuid, integer)'::regprocedure),
  'dashboard_movement_metrics search_path is pinned to public'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7-10. Privilege matrix: anon NO execute; authenticated HAS execute (SECURITY
--       INVOKER — RLS scopes it, so the dashboard's user client may call it).
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.dashboard_history_series(uuid, uuid, integer)', 'execute'),
  'anon holds no EXECUTE on dashboard_history_series'
);
select ok(
  not has_function_privilege('anon', 'public.dashboard_movement_metrics(uuid, uuid, integer)', 'execute'),
  'anon holds no EXECUTE on dashboard_movement_metrics'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_history_series(uuid, uuid, integer)', 'execute'),
  'authenticated holds EXECUTE on dashboard_history_series (RLS-scoped per-user dashboard)'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_movement_metrics(uuid, uuid, integer)', 'execute'),
  'authenticated holds EXECUTE on dashboard_movement_metrics (RLS-scoped per-user dashboard)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. anon cannot execute (live 42501).
--
--     PROD/CI ONLY (0230 pattern): the macOS local stack segfaults the
--     backend when throws_ok trips an EXECUTE denial on a function (known
--     class — see 0230's refresh_org_daily_stats probe for the full note).
--     The property is already pinned statically above (test 7: no EXECUTE
--     for anon). Opt in where the stack is verified safe with:
--     set stockpilot.pgtap_live_denial_probes = 'on';
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select * from public.dashboard_history_series('ac022400-0000-0000-0000-000000000001'::uuid, null, 3) $$,
      '42501', null,
      'anon cannot execute dashboard_history_series'
    )
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Cross-org isolation: an authenticated NON-MEMBER gets an all-zero series
--     (RLS filters every row) — the real defense against a cross-org oracle,
--     since authenticated is allowed to execute.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'ac022400-dead-dead-dead-000000000099';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select coalesce(sum(item_count), 0)::numeric
        + coalesce(sum(low_out_count), 0)::numeric
        + coalesce(sum(inventory_value), 0)
     from public.dashboard_history_series('ac022400-0000-0000-0000-000000000001'::uuid, null, 3)),
  0::numeric,
  'authenticated non-member gets an all-zero series (RLS isolation — no cross-org leak)'
);
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. dashboard_history_series behavioral (as superuser — stands in for the
--     RLS-bypassing/all-access caller). Hand-computed:
--       valueToday = 10·2 + 0·5 + 100·1 = 120
--       value[2]=120, value[1]=120−(−83)=203, value[0]=120−(−89)=209
--         (dayValueDelta: day1 = −3·2 = −6; day2 = 6·2 + (−95)·1 = −83)
--       lowOut: Q always out (+1). P low only on day1 (recon qty 4 ≤ 4).
--         → day0=1, day1=2, day2=1
--       itemCount: P,Q pre-window (all days); R created 30h ago → from day1.
--         → day0=2, day1=3, day2=3
--     S (archived) + T (deleted) + P's out-of-window row + org B are all absent.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac022400-0000-0000-0000-000000000001'::uuid, null, 3)
      order by day_index $$,
  $$ values
       (0::int, 2::int, 209::numeric, 1::int),
       (1::int, 3::int, 203::numeric, 2::int),
       (2::int, 3::int, 120::numeric, 1::int) $$,
  'history series matches the hand-computed value reverse-walk + low/out recon + item-count sweep'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. dashboard_movement_metrics behavioral. Scope = deleted_at IS NULL (P,Q,R,S
--     — NOTE archived S IS counted, deleted T is NOT). Per (day, type):
--       day0 adjust 1 (S), day1 remove 1 (P), day2 add 1 (P), day2 remove 1 (R).
--     P's out-of-window row + org B's movement are absent.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, movement_type, move_count
       from public.dashboard_movement_metrics('ac022400-0000-0000-0000-000000000001'::uuid, null, 3)
      order by day_index, movement_type $$,
  $$ values
       (0::int, 'adjust'::text,  1::bigint),
       (1::int, 'remove'::text,  1::bigint),
       (2::int, 'add'::text,     1::bigint),
       (2::int, 'remove'::text,  1::bigint) $$,
  'movement metrics match hand-computed per-(day,type) counts (archived included, deleted excluded, org-scoped)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. Warehouse narrowing: p_warehouse_id filters to the given warehouse. Org A
--     has a single warehouse, so filtering to a DIFFERENT (org B's) warehouse
--     yields an all-zero history — proving the warehouse predicate is applied.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select coalesce(sum(item_count), 0)::numeric + coalesce(sum(inventory_value), 0)
     from public.dashboard_history_series(
       'ac022400-0000-0000-0000-000000000001'::uuid,
       'ac022400-0000-0000-0000-000000000004'::uuid,  -- org B's warehouse
       3)),
  0::numeric,
  'p_warehouse_id narrows scope (org A rows vanish when filtered to another warehouse)'
);

select * from finish();
rollback;
