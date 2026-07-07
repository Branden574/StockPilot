-- supabase/tests/0230_dashboard_snapshot_rollups.test.sql
-- Proves migration 0230: dashboard snapshot rollups.
--
--   • org_daily_stats / org_daily_movement_stats exist, RLS enabled,
--     SELECT-only policies set, TIERED: org_daily_stats is MANAGER+ only
--     (rls_manager_org_ids — org-wide valuation aggregates), while
--     org_daily_movement_stats stays member-wide (rls_member_org_ids —
--     stock_movements RLS is already org-wide for members); a manager+
--     member reads own-org rows only and authenticated CANNOT insert,
--   • rls_manager_org_ids mirrors the 0229 helper shape (zero-arg, STABLE,
--     SECURITY DEFINER, pinned search_path, anon revoked, authenticated
--     granted),
--   • access-scope tiers, live: a warehouse-restricted STAFF member reads
--     ZERO org_daily_stats rows, and BOTH read functions route their whole
--     window through the *_reconstructed path for that caller (results_eq
--     against the reconstructed function and against hand-computed
--     caller-scoped values — none of the org-wide snapshot values leak);
--     a MANAGER still gets the snapshot-hit fast path with an org-wide
--     TODAY row,
--   • refresh_org_daily_stats is SECURITY DEFINER, search_path pinned,
--     EXECUTE revoked from anon/authenticated (live 42501 probe) and granted
--     to service_role,
--   • the *_reconstructed rename-copies of the 0228/0224 bodies exist as
--     SECURITY INVOKER with pinned search_path; anon revoked; authenticated
--     HOLDS execute (required: the INVOKER read functions delegate to them
--     under the caller's role on every fallback path — identical exposure to
--     the pre-0230 public functions),
--   • the nightly cron job is registered (tolerant when pg_cron is absent in
--     the local stack — the coordinator verifies cron.job on prod),
--   • backfill machinery: refresh_org_daily_stats(null, 120) — the exact
--     statement migration 0230 ran — covers EVERY org, 120 closed days deep,
--     with yesterday = the current-state observation and movement stats from
--     the day-sliced grouped count (today's slice excluded),
--   • read path decision tree: snapshot-hit returns the upserted values plus
--     a live TODAY row (row count = p_days, day_index 0..N−1 oldest→newest);
--     a missing closed day falls back to the reconstructed series (still
--     complete); p_warehouse_id ≠ null always takes the reconstructed path;
--     an authenticated non-member still gets the 0224-pinned all-zero series,
--   • gap self-heal never overwrites an already-observed older close;
--     yesterday is always re-observed.
--
-- now() is transaction_timestamp() — constant for this begin/rollback block —
-- so seed offsets, the functions' v_today anchor and the reconstructed
-- functions' rolling window all share one instant; expectations are exact.
--
-- Namespace: ac023000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(62);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as superuser — RLS is NOT active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  ('ac023000-0000-0000-0000-000000000101', 'member-d@0230.test', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  ('ac023000-0000-0000-0000-00000000000d', 'Snapshot Org D', 'snapshot-d-0230'),
  ('ac023000-0000-0000-0000-00000000000e', 'Snapshot Org E', 'snapshot-e-0230');

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac023000-0000-0000-0000-000000000011', 'ac023000-0000-0000-0000-00000000000d', 'Snap WH D', 'WH-SND-0230', 'active'),
  ('ac023000-0000-0000-0000-000000000012', 'ac023000-0000-0000-0000-00000000000e', 'Snap WH E', 'WH-SNE-0230', 'active');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000101', 'admin', now());

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, reorder_point,
   status, tracking_type, created_at, deleted_at)
values
  -- D1: healthy (10 > reorder 4), value 20.
  ('ac023000-0000-0000-0000-000000000021', 'ac023000-0000-0000-0000-00000000000d',
   'ac023000-0000-0000-0000-000000000011', 'SND-1', 'Snap D healthy', 10, 2, 4,
   'active', 'none', now() - interval '100 days', null),
  -- D2: out (0 ≤ threshold 0), value 0. → org D today = (2 items, 20, 1 low/out)
  ('ac023000-0000-0000-0000-000000000022', 'ac023000-0000-0000-0000-00000000000d',
   'ac023000-0000-0000-0000-000000000011', 'SND-2', 'Snap D out', 0, 5, 0,
   'active', 'none', now() - interval '100 days', null),
  -- E1: healthy, value 18. → org E today = (1 item, 18, 0 low/out)
  ('ac023000-0000-0000-0000-000000000023', 'ac023000-0000-0000-0000-00000000000e',
   'ac023000-0000-0000-0000-000000000012', 'SNE-1', 'Snap E item', 6, 3, 0,
   'active', 'none', now() - interval '100 days', null);

-- Movements anchored to UTC-midnight so their calendar-day bucket is
-- deterministic at any test-run hour:
--   D 'add'    @ today_utc_midnight − 30h → closed day (today − 2), 18:00 UTC
--   D 'adjust' @ now()                    → TODAY's live slice
--   E 'remove' @ today_utc_midnight − 12h → closed day (today − 1), 12:00 UTC
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000021',
   'add', 3, 7, 10,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '30 hours'),
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000021',
   'adjust', 1, 9, 10, now()),
  ('ac023000-0000-0000-0000-00000000000e', 'ac023000-0000-0000-0000-000000000023',
   'remove', -2, 8, 6,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '12 hours');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-7. Snapshot tables: exist, RLS enabled, SELECT-only policy surface.
-- ─────────────────────────────────────────────────────────────────────────────

select has_table('public', 'org_daily_stats', 'org_daily_stats exists');
select has_table('public', 'org_daily_movement_stats', 'org_daily_movement_stats exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.org_daily_stats'::regclass),
  'RLS is enabled on org_daily_stats'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.org_daily_movement_stats'::regclass),
  'RLS is enabled on org_daily_movement_stats'
);

select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'org_daily_stats'
      and policyname = 'org_daily_stats_select' and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ),
  'org_daily_stats has the manager+ SELECT policy (to authenticated)'
);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'org_daily_movement_stats'
      and policyname = 'org_daily_movement_stats_select' and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ),
  'org_daily_movement_stats has the member SELECT policy (to authenticated)'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('org_daily_stats', 'org_daily_movement_stats')
      and cmd <> 'SELECT'),
  0::bigint,
  'no INSERT/UPDATE/DELETE policies exist on the snapshot tables (writes are service/cron only — default deny)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8-14. refresh_org_daily_stats: SECURITY DEFINER, pinned search_path,
--       service/cron only (anon + authenticated revoked, live 42501 probe).
-- ─────────────────────────────────────────────────────────────────────────────

select has_function(
  'public', 'refresh_org_daily_stats', array['uuid', 'integer'],
  'refresh_org_daily_stats(uuid, integer) exists'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.refresh_org_daily_stats(uuid, integer)'::regprocedure),
  true,
  'refresh_org_daily_stats is SECURITY DEFINER (must see and write ALL orgs)'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.refresh_org_daily_stats(uuid, integer)'::regprocedure),
  'refresh_org_daily_stats search_path is pinned to public'
);
select ok(
  not has_function_privilege('anon', 'public.refresh_org_daily_stats(uuid, integer)', 'execute'),
  'anon holds no EXECUTE on refresh_org_daily_stats'
);
select ok(
  not has_function_privilege('authenticated', 'public.refresh_org_daily_stats(uuid, integer)', 'execute'),
  'authenticated holds no EXECUTE on refresh_org_daily_stats (cron/service only)'
);
select ok(
  has_function_privilege('service_role', 'public.refresh_org_daily_stats(uuid, integer)', 'execute'),
  'service_role holds EXECUTE on refresh_org_daily_stats'
);

-- LIVE fn-EXECUTE-denial probe — PROD/CI ONLY. The macOS local stack
-- segfaults the backend when throws_ok trips an EXECUTE denial on a
-- function (known class; 0224/0225/0227 carry identical unguarded probes
-- that are verified in CI/prod). The property itself is already pinned
-- statically above ("authenticated holds no EXECUTE"). Opt in where the
-- stack is safe with:  set stockpilot.pgtap_live_denial_probes = 'on';
set local "request.jwt.claim.sub" to 'ac023000-0000-0000-0000-000000000101';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select case
  when coalesce(current_setting('stockpilot.pgtap_live_denial_probes', true), '') = 'on' then
    throws_ok(
      $$ select public.refresh_org_daily_stats('ac023000-0000-0000-0000-00000000000d'::uuid, 3) $$,
      '42501', null,
      'an authenticated org member cannot execute refresh_org_daily_stats (live probe)'
    )
  else
    skip('prod-only: live fn-EXECUTE-denial probe (segfaults this local stack; EXECUTE grants asserted statically above)', 1)
end;
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15-24. The reconstructed rename-copies: exist, SECURITY INVOKER, pinned
--        search_path; anon revoked; authenticated HAS execute (fallback callee
--        of the INVOKER read functions — same exposure as pre-0230).
-- ─────────────────────────────────────────────────────────────────────────────

select has_function(
  'public', 'dashboard_history_series_reconstructed', array['uuid', 'uuid', 'integer'],
  'dashboard_history_series_reconstructed(uuid, uuid, integer) exists (0228 body rename-copy)'
);
select has_function(
  'public', 'dashboard_movement_metrics_reconstructed', array['uuid', 'uuid', 'integer'],
  'dashboard_movement_metrics_reconstructed(uuid, uuid, integer) exists (0224 body rename-copy)'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_history_series_reconstructed is SECURITY INVOKER (RLS binds the caller)'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_movement_metrics_reconstructed(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_movement_metrics_reconstructed is SECURITY INVOKER (RLS binds the caller)'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)'::regprocedure),
  'dashboard_history_series_reconstructed search_path is pinned to public'
);
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.dashboard_movement_metrics_reconstructed(uuid, uuid, integer)'::regprocedure),
  'dashboard_movement_metrics_reconstructed search_path is pinned to public'
);
select ok(
  not has_function_privilege('anon', 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)', 'execute'),
  'anon holds no EXECUTE on dashboard_history_series_reconstructed'
);
select ok(
  not has_function_privilege('anon', 'public.dashboard_movement_metrics_reconstructed(uuid, uuid, integer)', 'execute'),
  'anon holds no EXECUTE on dashboard_movement_metrics_reconstructed'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)', 'execute'),
  'authenticated holds EXECUTE on dashboard_history_series_reconstructed (INVOKER fallback delegation runs under the caller''s role)'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_movement_metrics_reconstructed(uuid, uuid, integer)', 'execute'),
  'authenticated holds EXECUTE on dashboard_movement_metrics_reconstructed (INVOKER fallback delegation runs under the caller''s role)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 25. Nightly cron job registered. Tolerant: when pg_cron is not installable
--     in this environment the check passes with a notice — the coordinator
--     verifies cron.job on prod after applying. Dynamic SQL because cron.job
--     cannot even be parsed when the extension is absent.
-- ─────────────────────────────────────────────────────────────────────────────

create function pg_temp.ac023000_cron_job_registered() returns boolean
language plpgsql as $fn$
declare v boolean;
begin
  if to_regclass('cron.job') is null then
    raise notice '0230 test: pg_cron absent in this environment — cron assertion skipped (verify cron.job on prod)';
    return true;
  end if;
  execute $q$
    select exists (
      select 1 from cron.job
      where jobname = 'refresh-org-daily-stats'
        and schedule = '10 0 * * *'
        and command like '%refresh_org_daily_stats%'
    )
  $q$ into v;
  return v;
end;
$fn$;

select ok(
  pg_temp.ac023000_cron_job_registered(),
  'nightly refresh-org-daily-stats cron job is registered at 00:10 UTC (or pg_cron absent locally)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 26-31. Backfill machinery: refresh_org_daily_stats(null, 120) is the EXACT
--        statement migration 0230 ran as its one-time backfill. Re-run here
--        (as superuser, standing in for the migration/cron) it must cover
--        every org — including the fixture orgs created inside this txn —
--        120 closed days deep, with yesterday = the current-state observation.
-- ─────────────────────────────────────────────────────────────────────────────

select lives_ok(
  $$ select public.refresh_org_daily_stats(null, 120) $$,
  'refresh_org_daily_stats(null, 120) — the migration backfill statement — runs for every org'
);

select is(
  (select count(*) from public.organizations o
    where not exists (
      select 1 from public.org_daily_stats s
      where s.organization_id = o.id
        and s.day = (now() at time zone 'utc')::date - 1
    )),
  0::bigint,
  'backfill leaves no org without a yesterday snapshot row'
);

select is(
  (select count(*) from public.org_daily_stats s
    where s.organization_id = 'ac023000-0000-0000-0000-00000000000e'
      and s.day >= (now() at time zone 'utc')::date - 120
      and s.day <  (now() at time zone 'utc')::date),
  120::bigint,
  'backfill writes exactly the last 120 closed days per org'
);

select results_eq(
  $$ select item_count, inventory_value, low_out_count
       from public.org_daily_stats
      where organization_id = 'ac023000-0000-0000-0000-00000000000e'
        and day = (now() at time zone 'utc')::date - 1 $$,
  $$ values (1::int, 18::numeric, 0::int) $$,
  'yesterday''s snapshot is the current-state observation (org E: 1 item, value 18, 0 low/out)'
);

select results_eq(
  $$ select day, movement_type, move_count
       from public.org_daily_movement_stats
      where organization_id = 'ac023000-0000-0000-0000-00000000000e'
      order by day, movement_type $$,
  $$ values ((now() at time zone 'utc')::date - 1, 'remove'::text, 1::bigint) $$,
  'movement snapshot buckets org E''s movement into its closed UTC day'
);

select results_eq(
  $$ select day, movement_type, move_count
       from public.org_daily_movement_stats
      where organization_id = 'ac023000-0000-0000-0000-00000000000d'
      order by day, movement_type $$,
  $$ values ((now() at time zone 'utc')::date - 2, 'add'::text, 1::bigint) $$,
  'movement snapshot covers closed days only — org D''s TODAY movement is excluded from snapshots'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 32-36. RLS posture, live: a member reads own-org rows only; an outsider
--        reads nothing; authenticated cannot write either table.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'ac023000-0000-0000-0000-000000000101';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select ok(
  (select count(*) from public.org_daily_stats
    where organization_id = 'ac023000-0000-0000-0000-00000000000d') > 0,
  'a manager+ member (admin) reads their own org''s snapshot rows'
);
select is(
  (select count(*) from public.org_daily_stats
    where organization_id = 'ac023000-0000-0000-0000-00000000000e'),
  0::bigint,
  'an org member reads ZERO rows of another org''s snapshots (RLS)'
);
select throws_ok(
  $$ insert into public.org_daily_stats (organization_id, day, item_count, inventory_value, low_out_count)
     values ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 1, 999, 999, 999) $$,
  '42501', null,
  'authenticated cannot INSERT into org_daily_stats (service/cron only)'
);
select throws_ok(
  $$ insert into public.org_daily_movement_stats (organization_id, day, movement_type, move_count)
     values ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 1, 'forged', 999) $$,
  '42501', null,
  'authenticated cannot INSERT into org_daily_movement_stats (service/cron only)'
);

reset role;

set local "request.jwt.claim.sub" to 'ac023000-dead-dead-dead-000000000099';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*) from public.org_daily_stats),
  0::bigint,
  'an authenticated non-member reads ZERO snapshot rows (RLS)'
);
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 37-39. SNAPSHOT-HIT read path, end-to-end as the authenticated member.
--        Overwrite org D's two relevant closed days with DISTINCTIVE synthetic
--        values (impossible to reproduce from org D's 2-item state) so a pass
--        proves the rows really came from the snapshot tables; the TODAY row
--        must be computed live from current item state.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.org_daily_stats (organization_id, day, item_count, inventory_value, low_out_count)
values
  ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 2, 61, 610, 6),
  ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 1, 71, 710, 7)
on conflict (organization_id, day) do update
  set item_count = excluded.item_count,
      inventory_value = excluded.inventory_value,
      low_out_count = excluded.low_out_count;

delete from public.org_daily_movement_stats
 where organization_id = 'ac023000-0000-0000-0000-00000000000d';
insert into public.org_daily_movement_stats (organization_id, day, movement_type, move_count)
values
  ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 2, 'add', 41),
  ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 1, 'remove', 52);

set local "request.jwt.claim.sub" to 'ac023000-0000-0000-0000-000000000101';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)
      order by day_index $$,
  $$ values
       (0::int, 61::int, 610::numeric, 6::int),
       (1::int, 71::int, 710::numeric, 7::int),
       (2::int,  2::int,  20::numeric, 1::int) $$,
  'snapshot-hit: closed days come from org_daily_stats (upserted values), TODAY is live current state (2 items, 20, 1)'
);

select is(
  (select count(*) from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 30)),
  30::bigint,
  'row-count contract holds at the real window size: 30-day call returns exactly 30 rows (day_index 0..29)'
);

select results_eq(
  $$ select day_index, movement_type, move_count
       from public.dashboard_movement_metrics('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)
      order by day_index, movement_type $$,
  $$ values
       (0::int, 'add'::text,    41::bigint),
       (1::int, 'remove'::text, 52::bigint),
       (2::int, 'adjust'::text,  1::bigint) $$,
  'metrics snapshot-hit: closed days from org_daily_movement_stats, TODAY''s slice counted live'
);

reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 40-43. MISSING-DAY fallback: delete one closed day → both read functions
--        must delegate the WHOLE window to the reconstructed bodies (series
--        still complete, none of the synthetic snapshot values leak through).
-- ─────────────────────────────────────────────────────────────────────────────

delete from public.org_daily_stats
 where organization_id = 'ac023000-0000-0000-0000-00000000000d'
   and day = (now() at time zone 'utc')::date - 1;

select results_eq(
  $$ select * from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3) $$,
  $$ select * from public.dashboard_history_series_reconstructed('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3) $$,
  'missing closed day → history falls back to the reconstructed series for the whole window'
);
select is(
  (select count(*) from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)),
  3::bigint,
  'the series stays complete (3 rows) while a snapshot day is missing'
);
select ok(
  not exists (
    select 1 from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)
    where item_count in (61, 71)
  ),
  'fallback output carries NO synthetic snapshot values (whole window reconstructed, not mixed)'
);
select results_eq(
  $$ select * from public.dashboard_movement_metrics('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3) $$,
  $$ select * from public.dashboard_movement_metrics_reconstructed('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3) $$,
  'missing closed day → metrics fall back to the reconstructed rollup (org_daily_stats is the sentinel for both)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 44-46. WAREHOUSE-ARG fallback: restore the snapshots to complete, then call
--        with p_warehouse_id — snapshots are org-wide, so the reconstructed
--        (fully RLS/warehouse-scoped) path must be taken even on a snapshot
--        hit; synthetic snapshot values must NOT appear.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.org_daily_stats (organization_id, day, item_count, inventory_value, low_out_count)
values ('ac023000-0000-0000-0000-00000000000d', (now() at time zone 'utc')::date - 1, 71, 710, 7)
on conflict (organization_id, day) do update
  set item_count = excluded.item_count,
      inventory_value = excluded.inventory_value,
      low_out_count = excluded.low_out_count;

select results_eq(
  $$ select * from public.dashboard_history_series(
       'ac023000-0000-0000-0000-00000000000d'::uuid,
       'ac023000-0000-0000-0000-000000000011'::uuid, 3) $$,
  $$ select * from public.dashboard_history_series_reconstructed(
       'ac023000-0000-0000-0000-00000000000d'::uuid,
       'ac023000-0000-0000-0000-000000000011'::uuid, 3) $$,
  'p_warehouse_id ≠ null → history always takes the reconstructed path (snapshots are org-wide)'
);
select ok(
  not exists (
    select 1 from public.dashboard_history_series(
      'ac023000-0000-0000-0000-00000000000d'::uuid,
      'ac023000-0000-0000-0000-000000000011'::uuid, 3)
    where item_count in (61, 71)
  ),
  'warehouse-scoped output ignores the (complete) org-wide snapshots'
);
select results_eq(
  $$ select * from public.dashboard_movement_metrics(
       'ac023000-0000-0000-0000-00000000000d'::uuid,
       'ac023000-0000-0000-0000-000000000011'::uuid, 3) $$,
  $$ select * from public.dashboard_movement_metrics_reconstructed(
       'ac023000-0000-0000-0000-00000000000d'::uuid,
       'ac023000-0000-0000-0000-000000000011'::uuid, 3) $$,
  'p_warehouse_id ≠ null → metrics always take the reconstructed path'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 47. Cross-org contract preserved: an authenticated NON-MEMBER still gets an
--     all-zero series (empty RLS view of the sentinel → fallback → RLS-zeroed
--     reconstruction) — exactly the behavior 0224 pinned.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'ac023000-dead-dead-dead-000000000099';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select coalesce(sum(item_count), 0)::numeric
        + coalesce(sum(low_out_count), 0)::numeric
        + coalesce(sum(inventory_value), 0)
     from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)),
  0::numeric,
  'authenticated non-member still gets an all-zero series (no snapshot bypass of the cross-org contract)'
);
reset role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 48-49. Gap self-heal semantics: refresh never overwrites an already-observed
--        OLDER close (observed history does not rewrite), but always
--        re-observes YESTERDAY with current state (freshest observation wins).
-- ─────────────────────────────────────────────────────────────────────────────

update public.org_daily_stats
   set item_count = 555
 where organization_id = 'ac023000-0000-0000-0000-00000000000d'
   and day = (now() at time zone 'utc')::date - 3;

select public.refresh_org_daily_stats('ac023000-0000-0000-0000-00000000000d'::uuid, 5);

select is(
  (select item_count from public.org_daily_stats
    where organization_id = 'ac023000-0000-0000-0000-00000000000d'
      and day = (now() at time zone 'utc')::date - 3),
  555,
  'refresh leaves an already-observed OLDER closed day untouched (gap-fill only — observations never rewritten)'
);
select results_eq(
  $$ select item_count, inventory_value, low_out_count
       from public.org_daily_stats
      where organization_id = 'ac023000-0000-0000-0000-00000000000d'
        and day = (now() at time zone 'utc')::date - 1 $$,
  $$ values (2::int, 20::numeric, 1::int) $$,
  'refresh re-observes YESTERDAY with current state (synthetic row replaced by the fresh observation)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 50-56. ACCESS-SCOPE TIERS, structural: rls_manager_org_ids mirrors the 0229
--        helper shape and the two snapshot policies probe the right sets
--        (org_daily_stats: manager+; org_daily_movement_stats: member).
-- ─────────────────────────────────────────────────────────────────────────────

select has_function('public', 'rls_manager_org_ids', '{}'::name[],
  'rls_manager_org_ids() exists (zero-arg set helper, 0229 shape)');
select is(
  (select prosecdef from pg_proc where oid = 'public.rls_manager_org_ids()'::regprocedure),
  true,
  'rls_manager_org_ids is SECURITY DEFINER (reads organization_members like the 0229 helpers)');
select ok(
  (select proconfig @> array['search_path=public'] from pg_proc
    where oid = 'public.rls_manager_org_ids()'::regprocedure),
  'rls_manager_org_ids search_path is pinned to public');
select ok(
  not has_function_privilege('anon', 'public.rls_manager_org_ids()', 'execute'),
  'anon holds NO execute on rls_manager_org_ids');
select ok(
  has_function_privilege('authenticated', 'public.rls_manager_org_ids()', 'execute'),
  'authenticated holds execute on rls_manager_org_ids (policy expressions run as the caller)');

select ok(
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'org_daily_stats'
             and policyname = 'org_daily_stats_select' and cmd = 'SELECT'
             and qual like '%rls_manager_org_ids%'
             and qual not like '%rls_member_org_ids%'),
  'org_daily_stats_select probes the MANAGER+ set (org-wide valuation aggregates are not member-wide)');
select ok(
  exists (select 1 from pg_policies
           where schemaname = 'public' and tablename = 'org_daily_movement_stats'
             and policyname = 'org_daily_movement_stats_select' and cmd = 'SELECT'
             and qual like '%rls_member_org_ids%'),
  'org_daily_movement_stats_select stays on the MEMBER set (counts already org-readable via stock_movements RLS)');

-- ─────────────────────────────────────────────────────────────────────────────
-- 57-62. ACCESS-SCOPE TIERS, live (the 0229 persona harness): a STAFF member
--        restricted to warehouse D2 must (a) read ZERO org_daily_stats rows,
--        (b) get BOTH read functions' whole window from the reconstructed
--        (caller-RLS-scoped) path — equal to calling the reconstructed
--        function directly AND to the hand-computed staff-visible values,
--        with none of the org-wide snapshot values leaking; a MANAGER keeps
--        the snapshot-hit fast path with an org-wide TODAY row.
--
--        Fixtures (seeded as superuser, appended AFTER the earlier sections
--        so org D's original 2-item today-state expectations stay intact):
--        warehouse D2 + item D3 (qty 5 × cost 6 = 30, healthy) + one D3
--        'add' movement TODAY. Staff sees ONLY D3 (0229 warehouse
--        assignment); org-wide today is now (3 items, 50, 1 low/out).
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  ('ac023000-0000-0000-0000-000000000102', 'staff-d@0230.test',   '{}'::jsonb),
  ('ac023000-0000-0000-0000-000000000103', 'manager-d@0230.test', '{}'::jsonb);

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000102', 'staff',   now()),
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000103', 'manager', now());

insert into public.warehouses (id, organization_id, name, code, status) values
  ('ac023000-0000-0000-0000-000000000013', 'ac023000-0000-0000-0000-00000000000d',
   'Snap WH D2', 'WH-SND2-0230', 'active');

-- Staff persona: NULL-charter assignment to warehouse D2 only (the 0229
-- restricted-staff shape) — item D3 is visible, D1/D2 (warehouse D1) are not.
insert into public.user_warehouse_assignments
  (organization_id, user_id, warehouse_id, charter_id)
values
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000102',
   'ac023000-0000-0000-0000-000000000013', null);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, reorder_point,
   status, tracking_type, created_at, deleted_at)
values
  -- D3: healthy (5 > threshold 0), value 30, created before the window.
  ('ac023000-0000-0000-0000-000000000024', 'ac023000-0000-0000-0000-00000000000d',
   'ac023000-0000-0000-0000-000000000013', 'SND-3', 'Snap D staff-visible', 5, 6, 0,
   'active', 'none', now() - interval '100 days', null);

-- One movement on the staff-visible item, TODAY (in the live slice): the
-- staff metrics fallback must count exactly this row — the snapshot path
-- would instead have returned org D's closed-day counts + an org-wide
-- today slice ('add' AND the D1 'adjust').
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  ('ac023000-0000-0000-0000-00000000000d', 'ac023000-0000-0000-0000-000000000024',
   'add', 2, 3, 5, now());

set local "request.jwt.claim.sub" to 'ac023000-0000-0000-0000-000000000102';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- (a) The PostgREST surface: a restricted member reads NO org-wide valuation
--     aggregates at all — not just "not their org's": zero rows anywhere.
select is(
  (select count(*) from public.org_daily_stats),
  0::bigint,
  'a warehouse-restricted STAFF member reads ZERO org_daily_stats rows (manager+ RLS — the 0224-rejected exposure stays closed)');

--     ... while the movement-count tier stays member-readable on purpose
--     (stock_movements RLS is already org-wide for members).
select is(
  (select count(*) from public.org_daily_movement_stats
    where organization_id = 'ac023000-0000-0000-0000-00000000000d'),
  2::bigint,
  'the same STAFF member still reads org_daily_movement_stats rows (member tier retained — counts are already org-readable)');

-- (b) The read function: staff sees no sentinel rows → the WHOLE window is
--     delegated to the reconstructed function under the caller's RLS.
select results_eq(
  $$ select * from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3) $$,
  $$ select * from public.dashboard_history_series_reconstructed('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3) $$,
  'STAFF history series = the reconstructed (caller-RLS-scoped) series — the empty sentinel read routes the whole window to the fallback');

--     Pin the actual scoped numbers: only D3 is staff-visible (1 item; value
--     30 today, 30−12=18 before today''s +2×6 delta; never low/out). The
--     org-wide snapshot values (61/610/6, 2/20/1) must appear NOWHERE.
select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)
      order by day_index $$,
  $$ values
       (0::int, 1::int, 18::numeric, 0::int),
       (1::int, 1::int, 18::numeric, 0::int),
       (2::int, 1::int, 30::numeric, 0::int) $$,
  'STAFF series is the hand-computed WAREHOUSE-SCOPED reconstruction — no org-wide snapshot value leaks, today matches the closed days'' scope');

--     Metrics sentinel keys off org_daily_stats too: staff must get the
--     reconstructed item-visibility-scoped count (exactly the D3 movement),
--     NOT the snapshot rows (add 1 / remove 52) + org-wide today slice.
select results_eq(
  $$ select day_index, movement_type, move_count
       from public.dashboard_movement_metrics('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)
      order by day_index, movement_type $$,
  $$ values (2::int, 'add'::text, 1::bigint) $$,
  'STAFF movement metrics reconstruct under the caller''s RLS (only the visible item''s movement) — the org_daily_stats sentinel gates this path too');

reset role;

-- (c) A MANAGER (the weakest manager+ role) keeps the snapshot fast path:
--     closed days verbatim from org_daily_stats (day-2 still the synthetic
--     61/610/6, day-1 the re-observed 2/20/1) + an org-wide live TODAY row
--     (3 items incl. D3, value 50, 1 out-of-stock) — org-wide end to end.
set local "request.jwt.claim.sub" to 'ac023000-0000-0000-0000-000000000103';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select results_eq(
  $$ select day_index, item_count, inventory_value, low_out_count
       from public.dashboard_history_series('ac023000-0000-0000-0000-00000000000d'::uuid, null, 3)
      order by day_index $$,
  $$ values
       (0::int, 61::int, 610::numeric, 6::int),
       (1::int,  2::int,  20::numeric, 1::int),
       (2::int,  3::int,  50::numeric, 1::int) $$,
  'a MANAGER still gets the snapshot-hit fast path: closed days from org_daily_stats + the org-wide live TODAY row');
reset role;

select * from finish();
rollback;
