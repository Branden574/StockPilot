-- supabase/tests/0356_stock_rpc_execute_narrowing.test.sql
-- Proves migration 0356: post_shipment_shipped(uuid), a stock-ledger writer
-- with no caller since the Shipments feature was removed (commit 98c65656),
-- is closed to anon, authenticated and PUBLIC, and service_role keeps it.
--
-- On the 0355 head the live ACL was
--   {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
-- so assertions 2, 3 and 4 FAIL there. Assertion 5 guards the ops path and
-- assertion 6 is the control: it proves the has_function_privilege probe
-- still returns true in this database for an RPC the app does call
-- (adjust_stock), so 2 and 3 cannot pass because the probe is broken.
--
-- CATALOG ONLY, BY DESIGN. Nothing here calls post_shipment_shipped under
-- `anon` or `authenticated`. A permission-denied function call under a
-- supautils hint role segfaulted Postgres images before 17.6.1.155, and the
-- image CI pins may still be one of them, so closed grants are asserted with
-- has_function_privilege / aclexplode, as 0310, 0312 and 0329 do.
--
-- No fixtures, no writes. Wrapped in begin/rollback for house consistency.
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(6);

-- 1. List integrity: exactly one overload, with this exact signature. A
--    rename or a new overload fails HERE instead of leaving an open twin
--    that the assertions below would never look at.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'post_shipment_shipped'),
  1,
  '0356/1: post_shipment_shipped has exactly one overload (list-integrity pin)');

-- 2-4. The fix. Revoking from PUBLIC matters as much as the named roles:
--      anon and authenticated both inherit a PUBLIC grant, so leaving it
--      would keep 2 and 3 true through inheritance.
select ok(
  not has_function_privilege('authenticated',
    'public.post_shipment_shipped(uuid)', 'EXECUTE'),
  '0356/2: authenticated holds no EXECUTE on post_shipment_shipped (no signed-in user can call it through PostgREST)');

select ok(
  not has_function_privilege('anon',
    'public.post_shipment_shipped(uuid)', 'EXECUTE'),
  '0356/3: anon holds no EXECUTE on post_shipment_shipped');

-- proacl IS NULL means "default privileges", which for a function is
-- EXECUTE to PUBLIC, so a null ACL must fail this check rather than pass it
-- because aclexplode(null) returns no rows.
select ok(
  (select p.proacl is not null
          and not exists (
            select 1 from aclexplode(p.proacl) a
             where a.grantee = 0            -- grantee 0 is PUBLIC
               and a.privilege_type = 'EXECUTE')
     from pg_proc p
    where p.oid = 'public.post_shipment_shipped(uuid)'::regprocedure),
  '0356/4: PUBLIC holds no EXECUTE on post_shipment_shipped (explicit ACL, no PUBLIC entry)');

-- 5. Ops path kept, per the 0329 Group 3c idiom for orphaned RPCs.
select ok(
  has_function_privilege('service_role',
    'public.post_shipment_shipped(uuid)', 'EXECUTE'),
  '0356/5: service_role keeps EXECUTE on post_shipment_shipped');

-- 6. Control + outage guard: adjust_stock is called by the app as the user
--    (InventoryService via ctx.supabase) and must stay authenticated-EXECUTE.
--    It also proves the probe used in 2 can return true in this database.
select ok(
  has_function_privilege('authenticated',
    'public.adjust_stock(uuid, numeric, text, uuid, text, text, text)', 'EXECUTE'),
  '0356/6 control: authenticated keeps EXECUTE on adjust_stock, so the probe in 0356/2 discriminates');

select * from finish();
rollback;
