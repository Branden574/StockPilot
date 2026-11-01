-- supabase/tests/0421_overview_value_leaves_out_rental_items.test.sql
-- Proves the migration of the same name (B78): inventory value leaves out
-- rental items in every function that adds it up, the counts still include
-- them, and the stored daily values lose their rental share once.
--
--   A. CREATE OR REPLACE kept each function's security shape: SECURITY
--      INVOKER, search_path pinned to public, authenticated may execute, anon
--      may not (get_dashboard_summary's anon state was never revoked and is
--      not asserted). Passes before the migration too: it is the guard that
--      a re-created body did not drop a SET clause or a grant.
--   B. The correction helper org_daily_stats_rental_correction() exists,
--      STABLE, SECURITY INVOKER, search_path pinned, executable by
--      service_role only.
--   C. Scope guard: the counts still include rental items (item count, out
--      of stock, low stock, the history's TODAY counts). Passes before the
--      migration too; the counts follow-up must change it on purpose.
--   D. The item's own test: for an organization holding a rental item, the
--      Overview card's value (get_dashboard_summary) equals the Value
--      breakdown's total (vw_inventory_valuation_by_warehouse).
--   E. One fixture fed to every SQL copy of the value rule: inventory_value,
--      dashboard_history_series (no stored rows, and with a warehouse),
--      dashboard_history_series_reconstructed, dashboard_value_series (cost
--      and retail); inventory_value_on_hand is the anchor (it always left
--      rental items out).
--   F. The helper's rows, per stored day: a rental item counts on the days
--      it existed (created before the day's close, even when its stock was
--      set without a movement), at its quantity at that day's close (current
--      quantity less the movements after the close, never below 0), never an
--      archived, deleted or cost-0 rental item, and the corrected value is
--      floored at 0.
--   G. The correction: the migration's one keyed UPDATE, restated here
--      (every rule it applies lives in the helper, which F calls directly),
--      then the stored days, the untouched columns and organizations, and
--      the Overview's 30-day line as a manager reads it (stored path): the
--      same value on every day, today included, so no step.
--
-- A second run of the migration file is refused while the helper exists
-- (its check runs before anything changes); that is proven on the migration
-- scratch stack by applying the file twice, as a pgTAP file cannot run a
-- migration file.
--
-- Organizations: P (one normal item, two rental items), H (stored days, the
-- helper's main fixture), B (no rental items, stored days), C (rental items
-- only, a cost raised since: the floor), D (a rental item whose stock was set
-- without a movement two days ago: the created_at cut; and one whose
-- movements since a close add up to more than it holds now: the quantity
-- floor). Day boundaries are UTC midnights and every timestamp the helper
-- depends on is anchored to today's UTC midnight, so the expectations hold at
-- any hour the suite runs.
--
-- Namespace: b7800000. Wrapped in begin/rollback, nothing leaks.

begin;

select plan(55);

-- ─────────────────────────────────────────────────────────────────────────────
-- A (1-19). The five functions keep their security shape.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select prosecdef from pg_proc where oid = 'public.get_dashboard_summary(uuid)'::regprocedure),
  false,
  'get_dashboard_summary is SECURITY INVOKER'
);
select is(
  (select prosecdef from pg_proc where oid = 'public.inventory_value(uuid)'::regprocedure),
  false,
  'inventory_value is SECURITY INVOKER'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_history_series(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_history_series is SECURITY INVOKER'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)'::regprocedure),
  false,
  'dashboard_history_series_reconstructed is SECURITY INVOKER'
);
select is(
  (select prosecdef from pg_proc
    where oid = 'public.dashboard_value_series(uuid, uuid, integer, text)'::regprocedure),
  false,
  'dashboard_value_series is SECURITY INVOKER'
);

select ok(
  (select 'search_path=public' = any(proconfig) from pg_proc
    where oid = 'public.get_dashboard_summary(uuid)'::regprocedure),
  'get_dashboard_summary pins search_path to public'
);
select ok(
  (select 'search_path=public' = any(proconfig) from pg_proc
    where oid = 'public.inventory_value(uuid)'::regprocedure),
  'inventory_value keeps the search_path pin 0329 gave it'
);
select ok(
  (select 'search_path=public' = any(proconfig) from pg_proc
    where oid = 'public.dashboard_history_series(uuid, uuid, integer)'::regprocedure),
  'dashboard_history_series pins search_path to public'
);
select ok(
  (select 'search_path=public' = any(proconfig) from pg_proc
    where oid = 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)'::regprocedure),
  'dashboard_history_series_reconstructed pins search_path to public'
);
select ok(
  (select 'search_path=public' = any(proconfig) from pg_proc
    where oid = 'public.dashboard_value_series(uuid, uuid, integer, text)'::regprocedure),
  'dashboard_value_series pins search_path to public'
);

select ok(
  has_function_privilege('authenticated', 'public.get_dashboard_summary(uuid)', 'execute'),
  'authenticated may execute get_dashboard_summary (the Overview card)'
);
select ok(
  has_function_privilege('authenticated', 'public.inventory_value(uuid)', 'execute'),
  'authenticated may execute inventory_value (the phone''s VALUE)'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_history_series(uuid, uuid, integer)', 'execute'),
  'authenticated may execute dashboard_history_series (the Overview''s lines)'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)', 'execute'),
  'authenticated may execute dashboard_history_series_reconstructed (the INVOKER fallback runs as the caller)'
);
select ok(
  has_function_privilege('authenticated', 'public.dashboard_value_series(uuid, uuid, integer, text)', 'execute'),
  'authenticated may execute dashboard_value_series (Compare)'
);

select ok(
  not has_function_privilege('anon', 'public.inventory_value(uuid)', 'execute'),
  'anon may not execute inventory_value'
);
select ok(
  not has_function_privilege('anon', 'public.dashboard_history_series(uuid, uuid, integer)', 'execute'),
  'anon may not execute dashboard_history_series'
);
select ok(
  not has_function_privilege('anon', 'public.dashboard_history_series_reconstructed(uuid, uuid, integer)', 'execute'),
  'anon may not execute dashboard_history_series_reconstructed'
);
select ok(
  not has_function_privilege('anon', 'public.dashboard_value_series(uuid, uuid, integer, text)', 'execute'),
  'anon may not execute dashboard_value_series'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B (20-26). The correction helper. to_regprocedure, so a missing helper is a
-- failed assertion here, not an error that ends the file.
-- ─────────────────────────────────────────────────────────────────────────────

select ok(
  to_regprocedure('public.org_daily_stats_rental_correction()') is not null,
  'org_daily_stats_rental_correction() exists'
);
select is(
  (select provolatile from pg_proc
    where oid = to_regprocedure('public.org_daily_stats_rental_correction()')),
  's'::"char",
  'the helper is STABLE (it reads, never writes)'
);
select is(
  (select prosecdef from pg_proc
    where oid = to_regprocedure('public.org_daily_stats_rental_correction()')),
  false,
  'the helper is SECURITY INVOKER'
);
select ok(
  coalesce((select 'search_path=public' = any(proconfig) from pg_proc
             where oid = to_regprocedure('public.org_daily_stats_rental_correction()')), false),
  'the helper pins search_path to public'
);
select ok(
  coalesce(has_function_privilege('service_role',
    to_regprocedure('public.org_daily_stats_rental_correction()'), 'execute'), false),
  'service_role may execute the helper (the release preview runs it)'
);
select ok(
  coalesce(not has_function_privilege('authenticated',
    to_regprocedure('public.org_daily_stats_rental_correction()'), 'execute'), false),
  'authenticated may not execute the helper'
);
select ok(
  coalesce(not has_function_privilege('anon',
      to_regprocedure('public.org_daily_stats_rental_correction()'), 'execute')
    and not has_function_privilege('public',
      to_regprocedure('public.org_daily_stats_rental_correction()'), 'execute'), false),
  'neither anon nor PUBLIC may execute the helper'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixtures (seeded as the superuser: RLS is not active during this block).
-- ─────────────────────────────────────────────────────────────────────────────

insert into auth.users (id, email, raw_user_meta_data) values
  ('b7800000-0000-0000-0000-000000000101', 'manager-p@b78.test', '{}'::jsonb),
  ('b7800000-0000-0000-0000-000000000102', 'manager-h@b78.test', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  ('b7800000-0000-0000-0000-000000000001', 'Rental Value Org P', 'rental-value-p-b78'),
  ('b7800000-0000-0000-0000-000000000002', 'Rental Value Org H', 'rental-value-h-b78'),
  ('b7800000-0000-0000-0000-000000000003', 'Rental Value Org B', 'rental-value-b-b78'),
  ('b7800000-0000-0000-0000-000000000004', 'Rental Value Org C', 'rental-value-c-b78'),
  ('b7800000-0000-0000-0000-000000000005', 'Rental Value Org D', 'rental-value-d-b78');

insert into public.warehouses (id, organization_id, name, code, status) values
  ('b7800000-0000-0000-0000-000000000011', 'b7800000-0000-0000-0000-000000000001', 'RV WH P', 'WH-RVP-B78', 'active'),
  ('b7800000-0000-0000-0000-000000000012', 'b7800000-0000-0000-0000-000000000002', 'RV WH H', 'WH-RVH-B78', 'active'),
  ('b7800000-0000-0000-0000-000000000013', 'b7800000-0000-0000-0000-000000000003', 'RV WH B', 'WH-RVB-B78', 'active'),
  ('b7800000-0000-0000-0000-000000000014', 'b7800000-0000-0000-0000-000000000004', 'RV WH C', 'WH-RVC-B78', 'active'),
  ('b7800000-0000-0000-0000-000000000015', 'b7800000-0000-0000-0000-000000000005', 'RV WH D', 'WH-RVD-B78', 'active');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  ('b7800000-0000-0000-0000-000000000001', 'b7800000-0000-0000-0000-000000000101', 'manager', now()),
  ('b7800000-0000-0000-0000-000000000002', 'b7800000-0000-0000-0000-000000000102', 'manager', now());

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, retail_price,
   reorder_point, status, tracking_type, is_rental, created_at, deleted_at)
values
  -- P. N1: a normal item, 10 x 2 = 20 at cost, 10 x 5 = 50 at retail.
  ('b7800000-0000-0000-0000-000000000021', 'b7800000-0000-0000-0000-000000000001',
   'b7800000-0000-0000-0000-000000000011', 'RVP-N1', 'Normal item P', 10, 2, 5, 0,
   'active', 'none', false, now() - interval '100 days', null),
  -- P. R1: a rental item, 3 x 100 = 300, below its reorder point of 5 (low).
  ('b7800000-0000-0000-0000-000000000022', 'b7800000-0000-0000-0000-000000000001',
   'b7800000-0000-0000-0000-000000000011', 'RVP-R1', 'Rental item P', 3, 100, 150, 5,
   'active', 'none', true, now() - interval '100 days', null),
  -- P. ROUT: a rental item at 0 (out of stock), value 0.
  ('b7800000-0000-0000-0000-000000000023', 'b7800000-0000-0000-0000-000000000001',
   'b7800000-0000-0000-0000-000000000011', 'RVP-ROUT', 'Rental item P out', 0, 40, 60, 0,
   'active', 'none', true, now() - interval '100 days', null),

  -- H. HN1: the only normal item, 10 x 2 = 20 every day.
  ('b7800000-0000-0000-0000-000000000031', 'b7800000-0000-0000-0000-000000000002',
   'b7800000-0000-0000-0000-000000000012', 'RVH-N1', 'Normal item H', 10, 2, 5, 0,
   'active', 'none', false, now() - interval '100 days', null),
  -- H. HR1: rental, 3 x 100 now, created 40 days before today's UTC midnight
  -- (T0); 2 at first, +1 at T0 - 36h (day today-2, 12:00 UTC).
  ('b7800000-0000-0000-0000-000000000032', 'b7800000-0000-0000-0000-000000000002',
   'b7800000-0000-0000-0000-000000000012', 'RVH-R1', 'Rental item H one', 3, 100, 150, 0,
   'active', 'none', true,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '40 days', null),
  -- H. HR2: rental, 4 x 50, created at day today-5, 06:00 UTC.
  ('b7800000-0000-0000-0000-000000000033', 'b7800000-0000-0000-0000-000000000002',
   'b7800000-0000-0000-0000-000000000012', 'RVH-R2', 'Rental item H two', 4, 50, 80, 0,
   'active', 'none', true,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '5 days' + interval '6 hours', null),
  -- H. HRA: a rental item archived now: in no day's share.
  ('b7800000-0000-0000-0000-000000000034', 'b7800000-0000-0000-0000-000000000002',
   'b7800000-0000-0000-0000-000000000012', 'RVH-RA', 'Rental item H archived', 7, 30, 40, 0,
   'archived', 'none', true, now() - interval '100 days', null),
  -- H. HR0: a rental item with cost 0: no share.
  ('b7800000-0000-0000-0000-000000000035', 'b7800000-0000-0000-0000-000000000002',
   'b7800000-0000-0000-0000-000000000012', 'RVH-R0', 'Rental item H no cost', 5, 0, 10, 0,
   'active', 'none', true, now() - interval '100 days', null),
  -- H. HRD: a rental item deleted yesterday: no share.
  ('b7800000-0000-0000-0000-000000000036', 'b7800000-0000-0000-0000-000000000002',
   'b7800000-0000-0000-0000-000000000012', 'RVH-RD', 'Rental item H deleted', 6, 20, 30, 0,
   'active', 'none', true, now() - interval '100 days', now() - interval '1 day'),

  -- B. BN1: a normal item, 5 x 3 = 15. B holds no rental item.
  ('b7800000-0000-0000-0000-000000000041', 'b7800000-0000-0000-0000-000000000003',
   'b7800000-0000-0000-0000-000000000013', 'RVB-N1', 'Normal item B', 5, 3, 4, 0,
   'active', 'none', false, now() - interval '100 days', null),

  -- C. CR1: rental only, 3 x 100 now (its cost was raised since its stored day).
  ('b7800000-0000-0000-0000-000000000051', 'b7800000-0000-0000-0000-000000000004',
   'b7800000-0000-0000-0000-000000000014', 'RVC-R1', 'Rental item C', 3, 100, 150, 0,
   'active', 'none', true, now() - interval '100 days', null),

  -- D. DN1: a normal item, 1 x 5 = 5.
  ('b7800000-0000-0000-0000-000000000061', 'b7800000-0000-0000-0000-000000000005',
   'b7800000-0000-0000-0000-000000000015', 'RVD-N1', 'Normal item D', 1, 5, 8, 0,
   'active', 'none', false, now() - interval '100 days', null),
  -- D. DR1: rental, 2 x 10, created at day today-2, 12:00 UTC with its stock
  -- set and no movement: only its created_at keeps it out of today-3.
  ('b7800000-0000-0000-0000-000000000062', 'b7800000-0000-0000-0000-000000000005',
   'b7800000-0000-0000-0000-000000000015', 'RVD-R1', 'Rental item D new', 2, 10, 15, 0,
   'active', 'none', true,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '2 days' + interval '12 hours', null),
  -- D. DR2: rental, 0 x 10 now, +3 at day today-1, 12:00 UTC (its stock was
  -- set to 0 since, without a movement): at the closes before that movement
  -- today's 0 less 3 is -3, counted as 0.
  ('b7800000-0000-0000-0000-000000000063', 'b7800000-0000-0000-0000-000000000005',
   'b7800000-0000-0000-0000-000000000015', 'RVD-R2', 'Rental item D emptied', 0, 10, 15, 0,
   'active', 'none', true, now() - interval '100 days', null);

insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, created_at)
values
  -- P. R1 +1 inside every 30-day window: before the migration the rebuilt
  -- lines step by its 100 on that day; after it, R1 is in no line at all.
  ('b7800000-0000-0000-0000-000000000001', 'b7800000-0000-0000-0000-000000000022',
   'add', 1, 2, 3, now() - interval '36 hours'),
  -- H. HR1's opening stock, before every stored day's close.
  ('b7800000-0000-0000-0000-000000000002', 'b7800000-0000-0000-0000-000000000032',
   'initial', 2, 0, 2,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '40 days'),
  -- H. HR1 +1 at T0 - 36h: after the close of today-3 (T0 - 48h), before the
  -- close of today-2 (T0 - 24h).
  ('b7800000-0000-0000-0000-000000000002', 'b7800000-0000-0000-0000-000000000032',
   'add', 1, 2, 3,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '36 hours'),
  -- H. HR2's opening stock, when it was created.
  ('b7800000-0000-0000-0000-000000000002', 'b7800000-0000-0000-0000-000000000033',
   'initial', 4, 0, 4,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '5 days' + interval '6 hours'),
  -- D. DR2 +3 at T0 - 12h: after the close of today-2, before the close of
  -- today-1.
  ('b7800000-0000-0000-0000-000000000005', 'b7800000-0000-0000-0000-000000000063',
   'add', 3, 0, 3,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') - interval '12 hours');

-- Stored days. H: the 29 closed days a 30-day line reads (today-29 to
-- today-1), each the value a refresh wrote before the migration: 20 of HN1
-- plus that day's rental share. HR1 alone at 2 x 100 = 200 up to today-6;
-- HR2's 4 x 50 = 200 joins from today-5 (created that day at 06:00, before
-- its close); HR1 is at 3 x 100 = 300 from today-2 (+1 before that close).
--   g = 1, 2 (today-1, today-2): 300 + 200 = 500
--   g = 3, 4, 5:                 200 + 200 = 400
--   g = 6 .. 29:                 200
-- item_count 7 and low_out_count 1 are distinctive: the live TODAY row has
-- 4 and 0, and no rebuilt line can produce them, so reading them back proves
-- the line came from the stored rows.
insert into public.org_daily_stats
  (organization_id, day, item_count, inventory_value, low_out_count, computed_at)
select
  'b7800000-0000-0000-0000-000000000002',
  (now() at time zone 'utc')::date - g,
  7,
  20 + case when g <= 2 then 500 when g <= 5 then 400 else 200 end,
  1,
  ((((now() at time zone 'utc')::date - g + 1)::timestamp) at time zone 'utc') + interval '10 minutes'
from generate_series(1, 29) g;

-- B: three days at 15, no rental item.
insert into public.org_daily_stats
  (organization_id, day, item_count, inventory_value, low_out_count, computed_at)
select
  'b7800000-0000-0000-0000-000000000003',
  (now() at time zone 'utc')::date - g,
  1, 15, 0,
  ((((now() at time zone 'utc')::date - g + 1)::timestamp) at time zone 'utc') + interval '10 minutes'
from generate_series(1, 3) g;

-- C: yesterday 250 (CR1 at its old cost); its share at today's cost is
-- 3 x 100 = 300, more than the stored value: floored at 0. The day before
-- stored 0: nothing to take out, so no row.
insert into public.org_daily_stats
  (organization_id, day, item_count, inventory_value, low_out_count, computed_at)
values
  ('b7800000-0000-0000-0000-000000000004', (now() at time zone 'utc')::date - 1, 1, 250, 0,
   (((now() at time zone 'utc')::date)::timestamp at time zone 'utc') + interval '10 minutes'),
  ('b7800000-0000-0000-0000-000000000004', (now() at time zone 'utc')::date - 2, 1, 0, 0,
   (((now() at time zone 'utc')::date - 1)::timestamp at time zone 'utc') + interval '10 minutes');

-- D: today-3 stored 5 (DN1; DR1 did not exist yet), today-2 and today-1
-- stored 25 (DN1 and DR1's 2 x 10). The helper counts DR2 at 0 on every day
-- (0 at today-1's close, 0 rather than -3 before its movement), so the share
-- is 20 on today-2 and today-1 and nothing on today-3, which gives no row.
-- Without the created_at cut DR1 would count on today-3; without the
-- quantity floor DR2's -3 x 10 would cancel DR1's share on today-2.
insert into public.org_daily_stats
  (organization_id, day, item_count, inventory_value, low_out_count, computed_at)
select
  'b7800000-0000-0000-0000-000000000005',
  (now() at time zone 'utc')::date - g,
  case when g = 3 then 2 else 3 end,
  case when g = 3 then 5 else 25 end,
  1,
  ((((now() at time zone 'utc')::date - g + 1)::timestamp) at time zone 'utc') + interval '10 minutes'
from generate_series(1, 3) g;

-- ─────────────────────────────────────────────────────────────────────────────
-- C (27-31). Scope guard, as P's manager: the counts still include rental
-- items (3 items; ROUT out of stock; R1 low), on the card and on the line's
-- TODAY row. Unchanged by the migration on purpose.
-- ─────────────────────────────────────────────────────────────────────────────

set local "request.jwt.claim.sub" to 'b7800000-0000-0000-0000-000000000101';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (select item_count from public.get_dashboard_summary('b7800000-0000-0000-0000-000000000001')),
  3,
  'the card''s item count still counts the two rental items (counts follow-up)'
);
select is(
  (select out_of_stock_count from public.get_dashboard_summary('b7800000-0000-0000-0000-000000000001')),
  1,
  'the out-of-stock count still counts a rental item at 0'
);
select is(
  (select low_stock_count from public.get_dashboard_summary('b7800000-0000-0000-0000-000000000001')),
  1,
  'the low-stock count still counts a rental item at its reorder point'
);
select is(
  (select item_count from public.dashboard_history_series('b7800000-0000-0000-0000-000000000001', null, 30)
    where day_index = 29),
  3,
  'the line''s TODAY item count still counts rental items'
);
select is(
  (select low_out_count from public.dashboard_history_series('b7800000-0000-0000-0000-000000000001', null, 30)
    where day_index = 29),
  2,
  'the line''s TODAY low/out count still counts rental items'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D (32-33). The item's test, as P's manager: the Overview card equals the
-- Value breakdown's total. Before the migration: 320 against 20.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select sum(value) from public.vw_inventory_valuation_by_warehouse
    where organization_id = 'b7800000-0000-0000-0000-000000000001'),
  20::numeric,
  'the Value breakdown counts N1 only (it always left rental items out)'
);
select is(
  (select inventory_value from public.get_dashboard_summary('b7800000-0000-0000-0000-000000000001')),
  (select sum(value) from public.vw_inventory_valuation_by_warehouse
    where organization_id = 'b7800000-0000-0000-0000-000000000001'),
  'the Overview card''s Inventory value equals the Value breakdown''s total for an organization with rental items'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E (34-40). Every SQL copy of the value rule, same fixture, as P's manager:
-- 20 everywhere (retail: N1's 50).
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  public.inventory_value('b7800000-0000-0000-0000-000000000001'),
  20::numeric,
  'inventory_value (the phone''s VALUE) leaves rental items out'
);
select results_eq(
  $$ select day_index, inventory_value
       from public.dashboard_history_series('b7800000-0000-0000-0000-000000000001', null, 30)
      order by day_index $$,
  $$ select g, 20::numeric from generate_series(0, 29) g $$,
  'dashboard_history_series, no stored rows (rebuilt path): 20 on every day'
);
select results_eq(
  $$ select day_index, inventory_value
       from public.dashboard_history_series('b7800000-0000-0000-0000-000000000001',
                                            'b7800000-0000-0000-0000-000000000011', 30)
      order by day_index $$,
  $$ select g, 20::numeric from generate_series(0, 29) g $$,
  'dashboard_history_series with a warehouse: 20 on every day'
);
select results_eq(
  $$ select day_index, inventory_value
       from public.dashboard_history_series_reconstructed('b7800000-0000-0000-0000-000000000001', null, 30)
      order by day_index $$,
  $$ select g, 20::numeric from generate_series(0, 29) g $$,
  'dashboard_history_series_reconstructed (it also writes the nightly stored day): 20 on every day'
);
select results_eq(
  $$ select day_index, value
       from public.dashboard_value_series('b7800000-0000-0000-0000-000000000001', null, 30, 'cost')
      order by day_index $$,
  $$ select g, 20::numeric from generate_series(0, 29) g $$,
  'dashboard_value_series at cost (Compare): 20 on every day'
);
select results_eq(
  $$ select day_index, value
       from public.dashboard_value_series('b7800000-0000-0000-0000-000000000001', null, 30, 'retail')
      order by day_index $$,
  $$ select g, 50::numeric from generate_series(0, 29) g $$,
  'dashboard_value_series at retail: N1''s 50 on every day'
);

reset role;

select is(
  public.inventory_value_on_hand('b7800000-0000-0000-0000-000000000001', 'product'),
  20::numeric,
  'anchor: inventory_value_on_hand (the Items footer, service-role only) is 20 for the same fixture'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F (41-45). The helper's rows (as the superuser, standing in for the
-- migration and the release preview).
-- ─────────────────────────────────────────────────────────────────────────────

select results_eq(
  $$ select day, stored_value, rental_value, corrected_value
       from public.org_daily_stats_rental_correction()
      where organization_id = 'b7800000-0000-0000-0000-000000000002'
      order by day $$,
  $$ select (now() at time zone 'utc')::date - g,
            (20 + case when g <= 2 then 500 when g <= 5 then 400 else 200 end)::numeric,
            (case when g <= 2 then 500 when g <= 5 then 400 else 200 end)::numeric,
            20::numeric
       from generate_series(29, 1, -1) g $$,
  'H: one row per stored day; HR1 at its quantity at each close, HR2 from the day it was created; the archived, deleted and cost-0 rental items never count; 20 left every day'
);
select is(
  (select count(*) from public.org_daily_stats_rental_correction()
    where organization_id = 'b7800000-0000-0000-0000-000000000003'),
  0::bigint,
  'B (no rental items): no row'
);
select results_eq(
  $$ select day, stored_value, rental_value, corrected_value
       from public.org_daily_stats_rental_correction()
      where organization_id = 'b7800000-0000-0000-0000-000000000004'
      order by day $$,
  $$ values ((now() at time zone 'utc')::date - 1, 250::numeric, 300::numeric, 0::numeric) $$,
  'C: a share above the stored value is floored at 0; a stored 0 gives no row'
);
select is(
  (select count(*) from public.org_daily_stats_rental_correction()
    where organization_id = 'b7800000-0000-0000-0000-000000000001'),
  0::bigint,
  'P (rental items, no stored days): no row'
);
select results_eq(
  $$ select day, stored_value, rental_value, corrected_value
       from public.org_daily_stats_rental_correction()
      where organization_id = 'b7800000-0000-0000-0000-000000000005'
      order by day $$,
  $$ values ((now() at time zone 'utc')::date - 2, 25::numeric, 20::numeric, 5::numeric),
            ((now() at time zone 'utc')::date - 1, 25::numeric, 20::numeric, 5::numeric) $$,
  'D: a rental item set up without a movement counts from the day it was created, and a quantity rebuilt below 0 counts as 0'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- G (46-55). The correction. The migration's one keyed UPDATE, restated:
--   update public.org_daily_stats s
--      set inventory_value = c.corrected_value
--     from public.org_daily_stats_rental_correction() c
--    where s.organization_id = c.organization_id
--      and s.day = c.day;
-- ─────────────────────────────────────────────────────────────────────────────

create temporary table b78_before as
  select * from public.org_daily_stats
   where organization_id in ('b7800000-0000-0000-0000-000000000002',
                             'b7800000-0000-0000-0000-000000000003',
                             'b7800000-0000-0000-0000-000000000004',
                             'b7800000-0000-0000-0000-000000000005');

select lives_ok(
  $$ update public.org_daily_stats s
        set inventory_value = c.corrected_value
       from public.org_daily_stats_rental_correction() c
      where s.organization_id = c.organization_id
        and s.day = c.day $$,
  'the correction runs'
);

select results_eq(
  $$ select day, inventory_value from public.org_daily_stats
      where organization_id = 'b7800000-0000-0000-0000-000000000002'
      order by day $$,
  $$ select (now() at time zone 'utc')::date - g, 20::numeric
       from generate_series(29, 1, -1) g $$,
  'H: every stored day is 20 after the correction (its rental share taken out)'
);
select results_eq(
  $$ select day, inventory_value from public.org_daily_stats
      where organization_id = 'b7800000-0000-0000-0000-000000000004'
      order by day $$,
  $$ values ((now() at time zone 'utc')::date - 2, 0::numeric),
            ((now() at time zone 'utc')::date - 1, 0::numeric) $$,
  'C: the floored day is 0, the stored 0 is unchanged'
);
select results_eq(
  $$ select day, inventory_value from public.org_daily_stats
      where organization_id = 'b7800000-0000-0000-0000-000000000005'
      order by day $$,
  $$ select (now() at time zone 'utc')::date - g, 5::numeric
       from generate_series(3, 1, -1) g $$,
  'D: 5 on every stored day (today-3 untouched, today-2 and today-1 lose DR1''s 20)'
);
select results_eq(
  $$ select day, inventory_value from public.org_daily_stats
      where organization_id = 'b7800000-0000-0000-0000-000000000003'
      order by day $$,
  $$ select day, inventory_value from b78_before
      where organization_id = 'b7800000-0000-0000-0000-000000000003'
      order by day $$,
  'B (no rental items): its stored days are unchanged'
);
select is(
  (select count(*) from public.org_daily_stats s
     join b78_before b using (organization_id, day)
    where s.item_count    is distinct from b.item_count
       or s.low_out_count is distinct from b.low_out_count
       or s.computed_at   is distinct from b.computed_at),
  0::bigint,
  'item_count, low_out_count and computed_at are untouched on every stored day'
);
select is(
  (select count(*) from public.org_daily_stats
    where organization_id in ('b7800000-0000-0000-0000-000000000002',
                              'b7800000-0000-0000-0000-000000000003',
                              'b7800000-0000-0000-0000-000000000004',
                              'b7800000-0000-0000-0000-000000000005')),
  (select count(*) from b78_before),
  'no stored day is added or removed'
);

set local "request.jwt.claim.sub" to 'b7800000-0000-0000-0000-000000000102';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select results_eq(
  $$ select day_index, item_count, low_out_count
       from public.dashboard_history_series('b7800000-0000-0000-0000-000000000002', null, 30)
      where day_index < 29
      order by day_index $$,
  $$ select g, 7, 1 from generate_series(0, 28) g $$,
  'as H''s manager the line reads the 29 stored days (their item_count 7 and low_out_count 1)'
);
select results_eq(
  $$ select item_count, inventory_value, low_out_count
       from public.dashboard_history_series('b7800000-0000-0000-0000-000000000002', null, 30)
      where day_index = 29 $$,
  $$ values (4, 20::numeric, 0) $$,
  'its TODAY row is live: 4 items (rental items still counted), value 20 without them'
);
select results_eq(
  $$ select day_index, inventory_value
       from public.dashboard_history_series('b7800000-0000-0000-0000-000000000002', null, 30)
      order by day_index $$,
  $$ select g, 20::numeric from generate_series(0, 29) g $$,
  'the 30-day line is 20 on every day, today included: no step on the day of the change'
);

reset role;

select * from finish();
rollback;
