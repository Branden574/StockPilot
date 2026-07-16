-- supabase/tests/0223_inventory_trend_buckets.test.sql
-- Proves migration 0223: public.inventory_trend_buckets is the service-role-only
-- SQL twin of lib/item-trends.ts bucketTrendMovements —
--   • exists with the (uuid, integer) signature,
--   • SECURITY INVOKER with search_path pinned to public (pg_proc checks),
--   • anon/authenticated hold no EXECUTE (privilege checks + live 42501
--     probes) so it can never become a cross-org aggregate oracle for user
--     clients; service_role can execute,
--   • behavioral: seeded movements aggregate into hand-computed
--     (item, day_index, sum, count) buckets — same-day aggregation, the
--     day-0 window boundary (created_at = now() − 14×24h is INCLUDED),
--     the future-row clamp into day 13, out-of-window exclusion, and
--     cross-org isolation (org B's movement never appears) — with the
--     default p_days = 14 matching the explicit call.
--
-- now() is transaction_timestamp() — constant for this whole begin/rollback
-- block — so seeding offsets and the function's own window anchor are
-- computed from the SAME instant: day indexes below are exact, not racy.
--
-- Namespace: ac022300 — distinct from all other test files.
-- Wrapped in begin/rollback — nothing leaks.

begin;

select plan(11);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- Fixed UUIDs, namespace ac022300. itemX (…10) sorts before itemY (…11),
-- which the ordered results_eq expectations rely on.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.organizations (id, name, slug) values
  ('ac022300-0000-0000-0000-000000000001', 'Trend Buckets Org A', 'trend-buckets-a-0223'),
  ('ac022300-0000-0000-0000-000000000002', 'Trend Buckets Org B', 'trend-buckets-b-0223')
  on conflict (id) do nothing;

-- Warehouses (trigger auto-creates Staging + Unplaced locations per mig 0188).
insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac022300-0000-0000-0000-000000000003', 'ac022300-0000-0000-0000-000000000001', 'TB WH A', 'WH-TBA', 'active'),
  ('ac022300-0000-0000-0000-000000000004', 'ac022300-0000-0000-0000-000000000002', 'TB WH B', 'WH-TBB', 'active')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values
  ('ac022300-0000-0000-0000-000000000010', 'ac022300-0000-0000-0000-000000000001',
   'ac022300-0000-0000-0000-000000000003', 'TB-0223-X', 'Trend Item X', 10, 'active', 'none'),
  ('ac022300-0000-0000-0000-000000000011', 'ac022300-0000-0000-0000-000000000001',
   'ac022300-0000-0000-0000-000000000003', 'TB-0223-Y', 'Trend Item Y', 8, 'active', 'none'),
  ('ac022300-0000-0000-0000-000000000012', 'ac022300-0000-0000-0000-000000000002',
   'ac022300-0000-0000-0000-000000000004', 'TB-0223-B', 'Trend Item B (other org)', 5, 'active', 'none')
  on conflict (id) do nothing;

-- Movements. Window anchor = now() − 14×24h = now() − 336h; day_index =
-- floor(hours_since_anchor / 24), clamped into [0, 13].
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  -- itemX, day 11 twice (60h → floor(11.5); 62.4h → floor(11.4)): sum 2, count 2.
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000010',
   'add',    5, 0, 5,  now() - interval '60 hours'),
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000010',
   'remove', -3, 5, 2, now() - interval '62.4 hours'),
  -- itemX, day 13 (12h → floor(13.5)) + a FUTURE row (clamped into 13): sum 2, count 2.
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000010',
   'remove', -2, 2, 0, now() - interval '12 hours'),
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000010',
   'add',    4, 0, 4,  now() + interval '2 hours'),
  -- itemY, day 1 (300h → floor(1.5)): sum 7, count 1.
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000011',
   'add',    7, 0, 7,  now() - interval '300 hours'),
  -- itemY, EXACT window boundary (336h): created_at >= anchor holds → day 0.
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000011',
   'add',    1, 7, 8,  now() - interval '336 hours'),
  -- itemX, OUT of window (400h): must not appear anywhere.
  ('ac022300-0000-0000-0000-000000000001', 'ac022300-0000-0000-0000-000000000010',
   'add',    99, 0, 99, now() - interval '400 hours'),
  -- Org B movement inside the window: must never leak into org A's buckets.
  ('ac022300-0000-0000-0000-000000000002', 'ac022300-0000-0000-0000-000000000012',
   'add',    50, 0, 50, now() - interval '12 hours');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-3. Shape: exists, SECURITY INVOKER, search_path pinned.
-- ─────────────────────────────────────────────────────────────────────────────

select has_function(
  'public', 'inventory_trend_buckets', array['uuid', 'integer'],
  'inventory_trend_buckets(uuid, integer) exists'
);

select is(
  (select prosecdef from pg_proc
    where oid = 'public.inventory_trend_buckets(uuid, integer)'::regprocedure),
  false,
  'SECURITY INVOKER (not definer) — a non-bypassrls caller would still be bound by stock_movements RLS'
);

select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.inventory_trend_buckets(uuid, integer)'::regprocedure),
  'search_path is pinned to public'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-6. Privilege matrix: EXECUTE revoked from anon/authenticated,
--      granted to service_role.
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.inventory_trend_buckets(uuid, integer)', 'execute'),
  'anon holds no EXECUTE privilege'
);

select ok(
  not has_function_privilege('authenticated', 'public.inventory_trend_buckets(uuid, integer)', 'execute'),
  'authenticated holds no EXECUTE privilege'
);

select ok(
  has_function_privilege('service_role', 'public.inventory_trend_buckets(uuid, integer)', 'execute'),
  'service_role holds EXECUTE (the cached loader calls through the service-role client)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7-8. Live probes: user-facing roles hit 42501 even with a valid org id
--      (no cross-org aggregate oracle).
--
--      PROD/CI ONLY (0230 pattern): the macOS local stack segfaults the
--      backend when throws_ok trips an EXECUTE denial on a function (known
--      class — see 0230's refresh_org_daily_stats probe for the full note).
--      The property is already pinned statically above (tests 4-5: no
--      EXECUTE for anon/authenticated). Opt in where the stack is verified
--      safe with:  set stockpilot.pgtap_live_denial_probes = 'on';
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select * from public.inventory_trend_buckets('ac022300-0000-0000-0000-000000000001'::uuid, 14) $$,
      '42501', null,
      'anon cannot execute inventory_trend_buckets'
    )
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select * from public.inventory_trend_buckets('ac022300-0000-0000-0000-000000000001'::uuid, 14) $$,
      '42501', null,
      'authenticated cannot execute inventory_trend_buckets (not even for an org it belongs to)'
    )
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. service_role can execute.
-- ─────────────────────────────────────────────────────────────────────────────

set local role to 'service_role';
select lives_ok(
  $$ select * from public.inventory_trend_buckets('ac022300-0000-0000-0000-000000000001'::uuid, 14) $$,
  'service_role can execute inventory_trend_buckets'
);
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10-11. Behavior: hand-computed buckets (as superuser — stands in for the
--        service-role caller, which bypasses RLS the same way).
-- Expected (item_id, day_index, sum(quantity_change), count):
--   itemX day 11 → ( 2, 2)   [5 + (−3), same-day aggregation]
--   itemX day 13 → ( 2, 2)   [−2 + clamped future +4]
--   itemY day  0 → ( 1, 1)   [exact boundary row included]
--   itemY day  1 → ( 7, 1)
-- The 400h row and org B's movement must be absent — the full-set
-- results_eq proves both the exclusion and the org scoping.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select item_id, day_index, quantity_change, move_count
       from public.inventory_trend_buckets('ac022300-0000-0000-0000-000000000001'::uuid, 14)
      order by item_id, day_index $$,
  $$ values
       ('ac022300-0000-0000-0000-000000000010'::uuid, 11,  2::numeric, 2::bigint),
       ('ac022300-0000-0000-0000-000000000010'::uuid, 13,  2::numeric, 2::bigint),
       ('ac022300-0000-0000-0000-000000000011'::uuid,  0,  1::numeric, 1::bigint),
       ('ac022300-0000-0000-0000-000000000011'::uuid,  1,  7::numeric, 1::bigint) $$,
  'buckets match the hand-computed per-item per-day sums/counts (aggregation, boundary, clamp, exclusion, org scoping)'
);

select results_eq(
  $$ select item_id, day_index, quantity_change, move_count
       from public.inventory_trend_buckets('ac022300-0000-0000-0000-000000000001'::uuid)
      order by item_id, day_index $$,
  $$ select item_id, day_index, quantity_change, move_count
       from public.inventory_trend_buckets('ac022300-0000-0000-0000-000000000001'::uuid, 14)
      order by item_id, day_index $$,
  'p_days defaults to 14 (single-arg call matches the explicit one)'
);

select * from finish();
rollback;
