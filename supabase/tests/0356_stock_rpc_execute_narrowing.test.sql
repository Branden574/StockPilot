-- supabase/tests/0356_stock_rpc_execute_narrowing.test.sql
-- Proves migration 0356.
--
-- PART 1 (assertions 1-6). post_shipment_shipped(uuid), a stock-ledger
-- writer with no caller since the Shipments feature was removed (commit
-- 98c65656), is closed to anon, authenticated and PUBLIC, and service_role
-- keeps it. On the 0355 head the live ACL was
--   {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
-- so assertions 2, 3 and 4 FAIL there. Assertion 5 guards the ops path and
-- assertion 6 is the control: it proves the has_function_privilege probe
-- still returns true in this database for an RPC the app does call
-- (adjust_stock), so 2 and 3 cannot pass because the probe is broken.
--
-- PART 2 (assertions 7-11). The five SECURITY INVOKER stock RPCs the app
-- calls as the signed-in user lose anon and PUBLIC and keep authenticated.
-- They carried the same default ACL on the 0355 head, so 8 and 9 FAIL there.
-- 10 is the outage guard: dropping authenticated would break transfers,
-- receiving, receipt reversal and bundles for every user.
--
-- CATALOG ONLY, BY DESIGN. Nothing here calls post_shipment_shipped under
-- `anon` or `authenticated`. A permission-denied function call under a
-- supautils hint role segfaulted Postgres images before 17.6.1.155, and the
-- image CI pins may still be one of them, so closed grants are asserted with
-- has_function_privilege / aclexplode, as 0310, 0312 and 0329 do.
--
-- No fixtures. The only write is the temp list in part 2, dropped with the
-- transaction. Wrapped in begin/rollback for house consistency.
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(11);

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

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2. anon off the five SECURITY INVOKER stock RPCs.
-- One temp list drives every assertion, and 7 proves the list resolves, so a
-- typo or a new overload cannot silently shrink what 8-11 judge.
-- ═══════════════════════════════════════════════════════════════════════════
create temporary table _t0356_five (sig text primary key) on commit drop;
insert into _t0356_five (sig) values
  ('public.transfer_stock(uuid, uuid, uuid, numeric, text)'),
  ('public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)'),
  ('public.reverse_receipt(uuid, text)'),
  ('public.assemble_bundle(uuid, numeric, uuid, text)'),
  ('public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text)');

-- 7. List integrity: every signature resolves, and none of the five names
--    has a second overload that would keep the old grants.
--    Both counts are reported in one string so that a missing signature
--    cannot be offset by an extra overload.
select is(
  format('%s resolved, %s overloads',
    (select count(*) from _t0356_five where to_regprocedure(sig) is not null),
    (select count(*)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('transfer_stock','post_receipt_v2','reverse_receipt',
                          'assemble_bundle','distribute_bundle'))),
  '5 resolved, 5 overloads',
  '0356/7: all five signatures resolve and each name has exactly one overload (list-integrity pin)');

-- 8. The fix: anon cannot execute any of them.
select is(
  (select count(*)::int from _t0356_five
    where has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')),
  0,
  '0356/8: anon holds EXECUTE on none of the five SECURITY INVOKER stock RPCs');

-- 9. ... and not through PUBLIC either. A null ACL means default privileges
--    (EXECUTE to PUBLIC), so it counts as open here.
select is(
  (select count(*)::int from _t0356_five f
     join pg_proc p on p.oid = to_regprocedure(f.sig)
    where p.proacl is null
       or exists (select 1 from aclexplode(p.proacl) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
  0,
  '0356/9: PUBLIC holds EXECUTE on none of the five (explicit ACLs, no PUBLIC entry)');

-- 10. Outage guard: the app calls every one of them as the signed-in user.
select is(
  (select count(*)::int from _t0356_five
    where has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE')),
  5,
  '0356/10: authenticated keeps EXECUTE on all five (transfers, receiving, reversal and bundles still work)');

-- 11. service_role is untouched (server-side jobs that use the admin client).
select is(
  (select count(*)::int from _t0356_five
    where has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE')),
  5,
  '0356/11: service_role keeps EXECUTE on all five');

select * from finish();
rollback;
