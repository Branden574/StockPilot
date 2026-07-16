-- supabase/tests/0228_dashboard_history_event_based.test.sql
-- Proves migration 0228: the EVENT-BASED rewrite of public.
-- dashboard_history_series emits output identical to 0224's movers×days walk.
--
--   • signature / SECURITY INVOKER / pinned search_path unchanged,
--   • privilege matrix unchanged: anon NO execute (live 42501 probe),
--     authenticated HAS execute (SECURITY INVOKER + RLS scopes it),
--   • cross-org isolation: an authenticated non-member gets an all-zero series,
--   • behavioral A: the EXACT hand-computed rollup from the 0224 test (value
--     reverse-walk + low/out reconstruction + item-count sweep, incl. archived/
--     deleted/out-of-window/other-org exclusions) — parity with the old body,
--   • behavioral B (NEW — stresses the event path specifically):
--       U  mover that flips low→ok→low across the window,
--       V  mover whose reconstructed qty equals its threshold EXACTLY on the
--          boundary day (≤ must count it),
--       W  item created MID-WINDOW whose stock arrived via a movement: per
--          0224 semantics low_out ignores created_at, so W counts as OUT on
--          days BEFORE its creation (reconstructed qty 0) while item_count
--          only picks it up from its creation bucket,
--       X  nonmover already low (constant +1, no events),
--       Y  mover with a ZERO-NET delta day (two rows summing to 0 — must be a
--          no-op event) plus a real delta day,
--     asserted over a 4-day window AND a 6-day window (the 6-day run has
--     event-free gap days 0-2, proving the baseline+cumulative carry),
--   • warehouse narrowing still applies.
--
-- now() is transaction_timestamp() — constant for this begin/rollback block —
-- so the seed offsets and the function's window anchor share one instant; the
-- day indexes below are exact, not racy.
--
-- Namespace: ac022800. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(11);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.organizations (id, name, slug) values
  ('ac022800-0000-0000-0000-000000000001', 'Dash Evt Org A', 'dash-evt-a-0228'),
  ('ac022800-0000-0000-0000-000000000002', 'Dash Evt Org B', 'dash-evt-b-0228'),
  ('ac022800-0000-0000-0000-000000000005', 'Dash Evt Org C (stress)', 'dash-evt-c-0228')
  on conflict (id) do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac022800-0000-0000-0000-000000000003', 'ac022800-0000-0000-0000-000000000001', 'DE WH A', 'WH-DEA', 'active'),
  ('ac022800-0000-0000-0000-000000000004', 'ac022800-0000-0000-0000-000000000002', 'DE WH B', 'WH-DEB', 'active'),
  ('ac022800-0000-0000-0000-000000000006', 'ac022800-0000-0000-0000-000000000005', 'DE WH C', 'WH-DEC', 'active')
  on conflict (id) do nothing;

-- Org A items — the 0224 behavioral fixture, verbatim (new ids). P/Q/R are
-- active + non-deleted (in scope). S is ARCHIVED, T is DELETED — both must be
-- excluded; if the scope filter regressed they would perturb the expectations.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, reorder_point,
   status, tracking_type, created_at, deleted_at)
values
  -- P: mover; historical qty higher → low-flip on day 1. reorder 4.
  ('ac022800-0000-0000-0000-000000000010', 'ac022800-0000-0000-0000-000000000001',
   'ac022800-0000-0000-0000-000000000003', 'DE-P', 'Item P', 10, 2, 4,
   'active', 'none', now() - interval '100 days', null),
  -- Q: nonmover, always out (qty 0, reorder 0 → threshold 0).
  ('ac022800-0000-0000-0000-000000000011', 'ac022800-0000-0000-0000-000000000001',
   'ac022800-0000-0000-0000-000000000003', 'DE-Q', 'Item Q', 0, 5, 0,
   'active', 'none', now() - interval '100 days', null),
  -- R: mover, healthy; created INSIDE the window (30h ago → counted from day 1).
  ('ac022800-0000-0000-0000-000000000012', 'ac022800-0000-0000-0000-000000000001',
   'ac022800-0000-0000-0000-000000000003', 'DE-R', 'Item R', 100, 1, 10,
   'active', 'none', now() - interval '30 hours', null),
  -- S: ARCHIVED, deleted_at null → excluded from history scope.
  ('ac022800-0000-0000-0000-000000000013', 'ac022800-0000-0000-0000-000000000001',
   'ac022800-0000-0000-0000-000000000003', 'DE-S', 'Item S', 0, 5, 0,
   'archived', 'none', now() - interval '100 days', null),
  -- T: active but DELETED → excluded.
  ('ac022800-0000-0000-0000-000000000014', 'ac022800-0000-0000-0000-000000000001',
   'ac022800-0000-0000-0000-000000000003', 'DE-T', 'Item T', 0, 3, 0,
   'active', 'none', now() - interval '100 days', now() - interval '1 hour'),
  -- Org B item (isolation): its movement must never leak into org A.
  ('ac022800-0000-0000-0000-000000000015', 'ac022800-0000-0000-0000-000000000002',
   'ac022800-0000-0000-0000-000000000004', 'DE-B', 'Item B (other org)', 7, 9, 3,
   'active', 'none', now() - interval '100 days', null)
  on conflict (id) do nothing;

-- Org C stress items (all active/non-deleted, warehouse C).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, reorder_point,
   status, tracking_type, created_at, deleted_at)
values
  -- U: qty 3, cost 2, reorder 5 → low today; +10 mid-window, −10 late
  --    → statuses low→ok→ok→low over a 4-day window (flips BOTH ways).
  ('ac022800-0000-0000-0000-000000000020', 'ac022800-0000-0000-0000-000000000005',
   'ac022800-0000-0000-0000-000000000006', 'DE-U', 'Item U flip', 3, 2, 5,
   'active', 'none', now() - interval '100 days', null),
  -- V: qty 10, cost 1, reorder 4; +6 on day 2 → reconstructed qty before the
  --    flip is EXACTLY 4 = threshold (≤ boundary must count as low).
  ('ac022800-0000-0000-0000-000000000021', 'ac022800-0000-0000-0000-000000000005',
   'ac022800-0000-0000-0000-000000000006', 'DE-V', 'Item V boundary', 10, 1, 4,
   'active', 'none', now() - interval '100 days', null),
  -- W: created MID-WINDOW (30h ago); qty 20, cost 3, reorder 0; its +20 arrived
  --    via a day-2 movement → reconstructed qty 0 (OUT) on days 0-1, i.e.
  --    BEFORE creation — 0224's low_out ignores created_at and so must 0228.
  --    item_count picks it up from its creation bucket only.
  ('ac022800-0000-0000-0000-000000000022', 'ac022800-0000-0000-0000-000000000005',
   'ac022800-0000-0000-0000-000000000006', 'DE-W', 'Item W midwindow', 20, 3, 0,
   'active', 'none', now() - interval '30 hours', null),
  -- X: nonmover already low (qty 2 ≤ reorder 3): constant +1, zero events.
  ('ac022800-0000-0000-0000-000000000023', 'ac022800-0000-0000-0000-000000000005',
   'ac022800-0000-0000-0000-000000000006', 'DE-X', 'Item X nonmover low', 2, 4, 3,
   'active', 'none', now() - interval '100 days', null),
  -- Y: qty 8, cost 5, reorder 0; a ZERO-NET day (rows +5/−5) then +9 on day 2
  --    → OUT (qty −1) on days 0-1, ok after; the zero-net day must be a no-op.
  ('ac022800-0000-0000-0000-000000000024', 'ac022800-0000-0000-0000-000000000005',
   'ac022800-0000-0000-0000-000000000006', 'DE-Y', 'Item Y zeronet', 8, 5, 0,
   'active', 'none', now() - interval '100 days', null)
  on conflict (id) do nothing;

-- Org A movements (0224 fixture verbatim). p_days = 3 → window start = now−72h;
-- day_index = floor(hours_since_start/24) clamped [0,2]. P +6 @ −12h → day2;
-- P −3 @ −36h → day1; R −95 @ −6h → day2; S/T rows excluded via scope; P's
-- −100h row is out of window; org B's row must never leak.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  ('ac022800-0000-0000-0000-000000000001', 'ac022800-0000-0000-0000-000000000010',
   'add',    6, 4, 10, now() - interval '12 hours'),
  ('ac022800-0000-0000-0000-000000000001', 'ac022800-0000-0000-0000-000000000010',
   'remove', -3, 13, 10, now() - interval '36 hours'),
  ('ac022800-0000-0000-0000-000000000001', 'ac022800-0000-0000-0000-000000000012',
   'remove', -95, 195, 100, now() - interval '6 hours'),
  ('ac022800-0000-0000-0000-000000000001', 'ac022800-0000-0000-0000-000000000013',
   'adjust', 1, 0, 1, now() - interval '60 hours'),
  ('ac022800-0000-0000-0000-000000000001', 'ac022800-0000-0000-0000-000000000014',
   'adjust', 1, 0, 1, now() - interval '54 hours'),
  ('ac022800-0000-0000-0000-000000000001', 'ac022800-0000-0000-0000-000000000010',
   'add', 777, 0, 777, now() - interval '100 hours'),
  ('ac022800-0000-0000-0000-000000000002', 'ac022800-0000-0000-0000-000000000015',
   'add', 50, 0, 50, now() - interval '6 hours');

-- Org C stress movements. For p_days = 4 the window start = now−96h and
-- day_index = floor((96 − hours_ago)/24): −64/−63/−60h → day1; −40/−36/−28h →
-- day2; −12h → day3. (For the p_days = 6 re-run these land on days 3/4/5.)
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  -- U: +10 on day1, −10 on day3 → low→ok→ok→low.
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000020',
   'add',    10, 3, 13, now() - interval '60 hours'),
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000020',
   'remove', -10, 13, 3, now() - interval '12 hours'),
  -- U: OUT-OF-WINDOW for both the 4-day and 6-day runs — must be excluded.
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000020',
   'add', 777, 0, 777, now() - interval '200 hours'),
  -- V: +6 on day2 → qty before = 4 = threshold exactly (boundary ≤).
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000021',
   'add', 6, 4, 10, now() - interval '36 hours'),
  -- W: +20 on day2 (after its −30h creation) → qty 0 (OUT) on days 0-1.
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000022',
   'add', 20, 0, 20, now() - interval '28 hours'),
  -- Y: zero-net day1 (+5 then −5) …
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000024',
   'add',     5, 8, 13, now() - interval '64 hours'),
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000024',
   'remove', -5, 13, 8, now() - interval '63 hours'),
  -- … then a real +9 on day2 → −1 (OUT) on days 0-1.
  ('ac022800-0000-0000-0000-000000000005', 'ac022800-0000-0000-0000-000000000024',
   'add', 9, -1, 8, now() - interval '40 hours');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-3. Shape unchanged: signature, SECURITY INVOKER, pinned search_path.
-- ─────────────────────────────────────────────────────────────────────────────

select has_function(
  'public', 'dashboard_history_series', array['uuid', 'uuid', 'integer'],
  'dashboard_history_series(uuid, uuid, integer) exists'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_history_series(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_history_series is SECURITY INVOKER (RLS binds the caller)'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.dashboard_history_series(uuid, uuid, integer)'::regprocedure),
  'dashboard_history_series search_path is pinned to public'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-5. Privilege matrix unchanged: anon NO execute; authenticated HAS execute.
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.dashboard_history_series(uuid, uuid, integer)', 'execute'),
  'anon holds no EXECUTE on dashboard_history_series'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_history_series(uuid, uuid, integer)', 'execute'),
  'authenticated holds EXECUTE on dashboard_history_series (RLS-scoped per-user dashboard)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. anon cannot execute (live 42501).
--
--    PROD/CI ONLY (0230 pattern): the macOS local stack segfaults the
--    backend when throws_ok trips an EXECUTE denial on a function (known
--    class — see 0230's refresh_org_daily_stats probe for the full note).
--    The property is already pinned statically above (test 4: no EXECUTE
--    for anon). Opt in where the stack is verified safe with:
--    set stockpilot.pgtap_live_denial_probes = 'on';
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.role" to 'anon';
set local role to 'anon';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select * from public.dashboard_history_series('ac022800-0000-0000-0000-000000000001'::uuid, null, 3) $$,
      '42501', null,
      'anon cannot execute dashboard_history_series'
    )
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Cross-org isolation: an authenticated NON-MEMBER gets an all-zero series
--    (RLS filters every row) — the real defense against a cross-org oracle.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'ac022800-dead-dead-dead-000000000099';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select coalesce(sum(item_count), 0)::numeric
        + coalesce(sum(low_out_count), 0)::numeric
        + coalesce(sum(inventory_value), 0)
     from public.dashboard_history_series('ac022800-0000-0000-0000-000000000001'::uuid, null, 3)),
  0::numeric,
  'authenticated non-member gets an all-zero series (RLS isolation — no cross-org leak)'
);
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Behavioral A — the 0224 hand-computed rollup, unchanged output (superuser
--    stands in for the RLS-bypassing/all-access caller):
--      valueToday = 10·2 + 0·5 + 100·1 = 120
--      value[2]=120, value[1]=120−(−83)=203, value[0]=120−(−89)=209
--      lowOut: Q always out (+1). P low only on day1 (recon qty 4 ≤ 4).
--        → day0=1, day1=2, day2=1
--      itemCount: P,Q pre-window; R created 30h ago → from day1.
--        → day0=2, day1=3, day2=3
--    S (archived) + T (deleted) + P's out-of-window row + org B are all absent.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac022800-0000-0000-0000-000000000001'::uuid, null, 3)
      order by day_index $$,
  $$ values
       (0::int, 2::int, 209::numeric, 1::int),
       (1::int, 3::int, 203::numeric, 2::int),
       (2::int, 3::int, 120::numeric, 1::int) $$,
  'history series still matches the 0224 hand-computed rollup (event rewrite is output-identical)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Behavioral B — event-path stress, 4-day window. Hand-computed via the
--    0224 formula qty_i(d) = currentQty − Σ_{j>d} Δ:
--      day0: U 3(low) V 4(low=thr) W 0(out, pre-creation) X 2(low) Y −1(out) → 5
--      day1: U 13(ok) V 4(low)     W 0(out)               X low     Y −1     → 4
--      day2: U 13    V 10(ok)      W 20(ok)               X low     Y 8(ok)  → 1
--      day3: U 3(low) …                                   X low               → 2
--      value: today = 3·2+10·1+20·3+2·4+8·5 = 124; dayΔ: d1=+20, d2=+111, d3=−20
--        → [13, 33, 144, 124]
--      itemCount: U,V,X,Y pre-window (day0); W bucket 2 → [4, 4, 5, 5]
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac022800-0000-0000-0000-000000000005'::uuid, null, 4)
      order by day_index $$,
  $$ values
       (0::int, 4::int,  13::numeric, 5::int),
       (1::int, 4::int,  33::numeric, 4::int),
       (2::int, 5::int, 144::numeric, 1::int),
       (3::int, 5::int, 124::numeric, 2::int) $$,
  'event-path stress (4d): low↔ok flips, exact-threshold boundary, mid-window creation counts as out pre-creation, nonmover low, zero-net delta day'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Behavioral B — same org over a 6-day window: days 0-2 have NO events, so
--     the baseline must carry across the gap; every movement shifts +2 days
--     (d1→d3, d2→d4, d3→d5) and W's creation bucket becomes 4.
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac022800-0000-0000-0000-000000000005'::uuid, null, 6)
      order by day_index $$,
  $$ values
       (0::int, 4::int,  13::numeric, 5::int),
       (1::int, 4::int,  13::numeric, 5::int),
       (2::int, 4::int,  13::numeric, 5::int),
       (3::int, 4::int,  33::numeric, 4::int),
       (4::int, 5::int, 144::numeric, 1::int),
       (5::int, 5::int, 124::numeric, 2::int) $$,
  'event-path stress (6d): baseline + cumulative events carry across event-free gap days'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Warehouse narrowing: filtering org A to org B's warehouse yields an
--     all-zero history — the p_warehouse_id predicate still applies.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select coalesce(sum(item_count), 0)::numeric + coalesce(sum(inventory_value), 0)
     from public.dashboard_history_series(
       'ac022800-0000-0000-0000-000000000001'::uuid,
       'ac022800-0000-0000-0000-000000000004'::uuid,  -- org B's warehouse
       3)),
  0::numeric,
  'p_warehouse_id narrows scope (org A rows vanish when filtered to another warehouse)'
);

select * from finish();
rollback;
