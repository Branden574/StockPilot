-- supabase/tests/0295_tracking_type_serial_optional.test.sql
--
-- Proves 0295: the tracking_type CHECK now admits 'serial_optional' and still
-- rejects everything else.
--
-- Anti-vacuity: assertion 1 proves the fixture really starts on the OLD value
-- 'none', so assertion 3 ("the new value persists") cannot pass by accident on
-- a row that was already 'serial_optional'.
--
-- Assertion map (9):
--   1    fixture check: the item starts on 'none'
--   2-3  'serial_optional' is accepted and persists
--   4-6  'serial' / 'lot' / 'none' still accepted (the CHECK was WIDENED)
--   7    an unknown value is still rejected with 23514 (it was not DROPPED)
--   8    the 0015 partial index survived the constraint swap
--   9    the CHECK is VALIDATED — 0295 adds it NOT VALID (to keep the scan off
--        the ACCESS EXCLUSIVE window) and then VALIDATEs it, so dropping the
--        second statement would silently leave a constraint Postgres will not
--        trust for planning or for future partition/inheritance work
--
-- Namespace: d0295000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(9);

\set org   '\'d0295000-0000-0000-0000-000000000001\''
\set user1 '\'d0295000-0000-0000-0000-000000000002\''
\set wh    '\'d0295000-0000-0000-0000-000000000003\''
\set item  '\'d0295000-0000-0000-0000-000000000004\''

insert into auth.users (id, email) values (:user1, 'u-0295@example.test')
  on conflict (id) do nothing;
-- organizations.slug and warehouses.code are NOT NULL with no default (verified
-- against information_schema on the reset database), so both must be supplied.
insert into public.organizations (id, name, slug)
  values (:org, 'Serial Optional 0295', 'serial-optional-0295')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :user1, 'admin', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code)
  values (:wh, :org, 'WH 0295', 'WH-0295') on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'SO-0295', 'Optional Serial Item', 0, 'active', 'none')
  on conflict (id) do nothing;

-- Anti-vacuity: the fixture really starts on the OLD value.
select is(
  (select tracking_type from public.inventory_items where id = :item),
  'none',
  'fixture check: the item starts on ''none''');

select lives_ok(
  $$ update public.inventory_items
       set tracking_type = 'serial_optional'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''serial_optional'' is now an accepted tracking_type');

select is(
  (select tracking_type from public.inventory_items where id = :item),
  'serial_optional',
  'the new value persists');

-- The three original values still work, unchanged.
select lives_ok(
  $$ update public.inventory_items set tracking_type = 'serial'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''serial'' still accepted (Electronics is unaffected)');
select lives_ok(
  $$ update public.inventory_items set tracking_type = 'lot'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''lot'' still accepted');
select lives_ok(
  $$ update public.inventory_items set tracking_type = 'none'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '''none'' still accepted');

-- Anything else is still rejected — the CHECK was widened, not removed.
select throws_ok(
  $$ update public.inventory_items set tracking_type = 'serialised'
     where id = 'd0295000-0000-0000-0000-000000000004' $$,
  '23514',
  null,
  'an unknown tracking_type is still rejected (CHECK widened, not dropped)');

-- The 0015 partial index still covers the new value.
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'inventory_items_tracking_type_idx'
  ),
  'the 0015 partial tracking_type index survives the constraint swap');

-- The CHECK is added NOT VALID and then VALIDATEd, so the full-table scan runs
-- under SHARE UPDATE EXCLUSIVE instead of inside the ADD's ACCESS EXCLUSIVE. The
-- end state must still be a VALIDATED constraint: a NOT VALID one enforces new
-- writes but is not trusted for planning, so losing the VALIDATE would be a
-- silent, invisible regression that assertion 7 cannot see.
select is(
  (select convalidated from pg_constraint
    where conrelid = 'public.inventory_items'::regclass
      and conname  = 'inventory_items_tracking_type_check'),
  true,
  'the widened tracking_type CHECK ends up VALIDATED (the VALIDATE step was not dropped)');

select * from finish();
rollback;
