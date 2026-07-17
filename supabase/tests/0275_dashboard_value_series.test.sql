-- supabase/tests/0275_dashboard_value_series.test.sql
-- Proves migration 0275: public.dashboard_value_series — the on-demand
-- cost/retail value series behind the dashboard value card's Compare/basis
-- controls (movements.ts getDashboardValueComparison → fetchValueSeries).
--
--   • exists with the (uuid, uuid, integer, text) signature,
--   • SECURITY INVOKER with search_path pinned to public,
--   • anon holds NO EXECUTE; authenticated DOES (SECURITY INVOKER — must run
--     under the caller's JWT so RLS on inventory_items/stock_movements scopes
--     it; cross-org calls return zero rows),
--   • behavioral: hand-computed per-day value reverse-walk for BOTH bases —
--     'cost' (unit_cost) reproduces dashboard_history_series' cost column
--     exactly (parity), 'retail' (retail_price) is distinct and non-null,
--   • org-scoped: an authenticated non-member gets an all-zero series.
--
-- now() = transaction_timestamp() (constant across this begin/rollback block),
-- so the seed offsets and the function's own window anchor share one instant;
-- day indexes are exact. p_days = 3 (last_idx = 2, window = now() − 72h).
--
-- Namespace: ac027500. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(11);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.organizations (id, name, slug) values
  ('ac027500-0000-0000-0000-000000000001', 'Value Series Org A', 'value-series-a-0275'),
  ('ac027500-0000-0000-0000-000000000002', 'Value Series Org B', 'value-series-b-0275')
  on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac027500-0000-0000-0000-000000000003', 'ac027500-0000-0000-0000-000000000001', 'VS WH A', 'WH-VSA', 'active'),
  ('ac027500-0000-0000-0000-000000000004', 'ac027500-0000-0000-0000-000000000002', 'VS WH B', 'WH-VSB', 'active')
  on conflict (id) do nothing;

-- Org A items. X is a mover; Y a nonmover. Both active + non-deleted (value
-- scope). retail_price ≠ unit_cost so the two bases produce distinct series.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, retail_price,
   reorder_point, status, tracking_type, created_at, deleted_at)
values
  -- X: qty 10, cost 2, retail 5. Moves inside the window.
  ('ac027500-0000-0000-0000-000000000010', 'ac027500-0000-0000-0000-000000000001',
   'ac027500-0000-0000-0000-000000000003', 'VS-X', 'Item X', 10, 2, 5, 0,
   'active', 'none', now() - interval '100 days', null),
  -- Y: qty 4, cost 3, retail 10. Nonmover (constant across the window).
  ('ac027500-0000-0000-0000-000000000011', 'ac027500-0000-0000-0000-000000000001',
   'ac027500-0000-0000-0000-000000000003', 'VS-Y', 'Item Y', 4, 3, 10, 0,
   'active', 'none', now() - interval '100 days', null),
  -- Org B item (isolation): must never leak into org A.
  ('ac027500-0000-0000-0000-000000000015', 'ac027500-0000-0000-0000-000000000002',
   'ac027500-0000-0000-0000-000000000004', 'VS-B', 'Item B (other org)', 7, 9, 20, 0,
   'active', 'none', now() - interval '100 days', null)
  on conflict (id) do nothing;

-- Movements. Window start = now() − 72h; day_index = floor(hours/24), clamp
-- [0,2]. X +6 @ now−12h → day2; X −3 @ now−36h → day1.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  ('ac027500-0000-0000-0000-000000000001', 'ac027500-0000-0000-0000-000000000010',
   'add',     6, 4, 10, now() - interval '12 hours'),
  ('ac027500-0000-0000-0000-000000000001', 'ac027500-0000-0000-0000-000000000010',
   'remove', -3, 13, 10, now() - interval '36 hours'),
  -- X, OUT of window (100h): excluded.
  ('ac027500-0000-0000-0000-000000000001', 'ac027500-0000-0000-0000-000000000010',
   'add', 777, 0, 777, now() - interval '100 hours'),
  -- Org B movement inside the window: must never leak into org A.
  ('ac027500-0000-0000-0000-000000000002', 'ac027500-0000-0000-0000-000000000015',
   'add', 50, 0, 50, now() - interval '6 hours');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Shape: exists with the (uuid, uuid, integer, text) signature.
-- ─────────────────────────────────────────────────────────────────────────────

select has_function(
  'public', 'dashboard_value_series', array['uuid', 'uuid', 'integer', 'text'],
  'dashboard_value_series(uuid, uuid, integer, text) exists'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2-3. SECURITY INVOKER (not definer) + search_path pinned.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_value_series(uuid, uuid, integer, text)'::regprocedure),
  false,
  'dashboard_value_series is SECURITY INVOKER (RLS binds the caller)'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.dashboard_value_series(uuid, uuid, integer, text)'::regprocedure),
  'dashboard_value_series search_path is pinned to public'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-5. Privilege matrix: anon NO execute; authenticated HAS execute.
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.dashboard_value_series(uuid, uuid, integer, text)', 'execute'),
  'anon holds no EXECUTE on dashboard_value_series'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_value_series(uuid, uuid, integer, text)', 'execute'),
  'authenticated holds EXECUTE on dashboard_value_series (RLS-scoped on-demand card)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. anon cannot execute (live 42501).
--    PROD/CI ONLY (0230/0224 pattern): the macOS local stack segfaults the
--    backend when throws_ok trips an EXECUTE denial on a function. The property
--    is pinned statically above (test 4). Opt in on a verified-safe stack with:
--      set stockpilot.pgtap_live_denial_probes = 'on';
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select * from public.dashboard_value_series('ac027500-0000-0000-0000-000000000001'::uuid, null, 3, 'cost') $$,
      '42501', null,
      'anon cannot execute dashboard_value_series'
    )
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Cross-org isolation: an authenticated NON-MEMBER gets an all-zero series
--    (RLS filters every inventory_items/stock_movements row) — the real defense,
--    since authenticated is allowed to execute.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'ac027500-dead-dead-dead-000000000099';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select coalesce(sum(value), 0)
     from public.dashboard_value_series('ac027500-0000-0000-0000-000000000001'::uuid, null, 3, 'retail')),
  0::numeric,
  'authenticated non-member gets an all-zero value series (RLS isolation — no cross-org leak)'
);
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. COST basis (as superuser — stands in for the RLS-bypassing/all-access
--    caller). Hand-computed:
--      valueToday = 10·2 + 4·3 = 32
--      dayValueDelta(cost): day1 = −3·2 = −6; day2 = +6·2 = +12
--      value[2]=32, value[1]=32−12=20, value[0]=32−(12−6)=26
--    X's out-of-window row + org B are absent.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, value
       from public.dashboard_value_series('ac027500-0000-0000-0000-000000000001'::uuid, null, 3, 'cost')
      order by day_index $$,
  $$ values (0::int, 26::numeric), (1::int, 20::numeric), (2::int, 32::numeric) $$,
  'cost-basis value series matches the hand-computed reverse-walk'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. RETAIL basis: same reverse-walk with retail_price.
--      valueToday = 10·5 + 4·10 = 90
--      dayValueDelta(retail): day1 = −3·5 = −15; day2 = +6·5 = +30
--      value[2]=90, value[1]=90−30=60, value[0]=90−(30−15)=75
--    Distinct from cost → proves the basis selector uses retail_price.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, value
       from public.dashboard_value_series('ac027500-0000-0000-0000-000000000001'::uuid, null, 3, 'retail')
      order by day_index $$,
  $$ values (0::int, 75::numeric), (1::int, 60::numeric), (2::int, 90::numeric) $$,
  'retail-basis value series matches the hand-computed reverse-walk (retail_price × qty)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Cost-basis PARITY with dashboard_history_series' cost column
--     (dashboard_history_series_reconstructed.inventory_value) over the same
--     window — the cost series the eager dashboard already renders.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, value
       from public.dashboard_value_series('ac027500-0000-0000-0000-000000000001'::uuid, null, 3, 'cost')
      order by day_index $$,
  $$ select day_index, inventory_value
       from public.dashboard_history_series_reconstructed('ac027500-0000-0000-0000-000000000001'::uuid, null, 3)
      order by day_index $$,
  'cost basis is exact parity with dashboard_history_series_reconstructed value column'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Retail series is NON-NULL and non-zero for a seeded item with a
--     retail_price (the plan's explicit requirement).
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  (select bool_and(value is not null) and sum(value) > 0
     from public.dashboard_value_series('ac027500-0000-0000-0000-000000000001'::uuid, null, 3, 'retail')),
  'retail value series is non-null and non-zero for an item with retail_price'
);

select * from finish();
rollback;
