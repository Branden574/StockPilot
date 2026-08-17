-- supabase/tests/0341_manual_writeoff_any_mode_and_outbox_secdef.test.sql
-- pgTAP proof for migration 0341.
--
-- Fixture = the exact L4L shape of 2026-08-17: one item, on_hand 3, held as
-- 2 on a rack + 1 in the warehouse's Staging bucket. Manager caller.
--
-- Asserts (13, numbered by claim):
--   1. 'placed' (the default) still REFUSES a -3 (insufficient_placed_stock):
--      picks/ships never reach Staging. Unchanged contract.
--   2. after that refused call the rack still holds 2 (the failed draw rolled
--      back with the exception — nothing half-applied)
--   3. 'any' -3 succeeds: on_hand = 0
--   4. 'any': rack level = 0
--   5. 'any': Staging level = 0
--   6. 'any' partial removal comes off the SHELF first: item2 (rack 2 + staging
--      1), remove 1 in 'any' -> rack 1, staging still 1
--   7. 'any' still raises when the holdings do not cover the delta at all
--      (item3: on_hand 5 but only 2 held anywhere) — drift is surfaced, not
--      papered over
--   8. publish_outbox as a MANAGER succeeds and returns an id (0016 invoker +
--      0140 admin-only policy used to raise 42501 here)
--   9. publish_outbox as a member of ANOTHER org for this org raises 42501
--      (self-authorization, not the old table policy)
--  10. publish_outbox is idempotent on dedupe_key (second call returns null,
--      still exactly one row)
--
-- Wrapped in begin/rollback -- nothing leaks.

begin;

select plan(13);

\set org      '\'ff341000-0000-0000-0000-000000000001\''
\set usr      '\'ff341000-0000-0000-0000-000000000002\''
\set wh       '\'ff341000-0000-0000-0000-000000000003\''
\set item     '\'ff341000-0000-0000-0000-000000000004\''
\set rack     '\'ff341000-0000-0000-0000-000000000005\''
\set item2    '\'ff341000-0000-0000-0000-000000000006\''
\set item3    '\'ff341000-0000-0000-0000-000000000007\''
\set org2     '\'ff341000-0000-0000-0000-000000000008\''
\set usr2     '\'ff341000-0000-0000-0000-000000000009\''

-- ── Fixtures (seeded as superuser before role switch) ─────────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr,  'mw-mgr@test.local',  '{}'::jsonb),
         (:usr2, 'mw-other@test.local','{}'::jsonb)
  on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org,  'MW Test Org',  'mw-test-org-0341'),
         (:org2, 'MW Other Org', 'mw-other-org-0341')
  on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org,  :usr,  'manager', now()),
         (:org2, :usr2, 'manager', now())
  on conflict do nothing;

-- Warehouse -- trigger auto-creates Staging + Unplaced locations (mig 0188).
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'MW Test WH', 'WH-MW', 'active') on conflict (id) do nothing;

insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, '17-A', 'shelf', 'rack') on conflict (id) do nothing;

-- item: on_hand 3 = rack 2 + Staging 1 (the L4L polo).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'MW-0341', 'Polo S', 3, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels where item_id = :item;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item, :rack, 2);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item, l.id, 1 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1;

-- item2: same shape, for the partial-removal ordering proof.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item2, :org, :wh, 'MW-0341-B', 'Polo M', 3, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels where item_id = :item2;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item2, :rack, 2);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item2, l.id, 1 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1;

-- item3: DRIFT — on_hand 5 but only 2 held anywhere (rack 1 + staging 1).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item3, :org, :wh, 'MW-0341-C', 'Polo L', 5, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels where item_id = :item3;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item3, :rack, 1);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item3, l.id, 1 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1;

-- ── Become the manager ────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'ff341000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 1. default 'placed' mode still refuses -3 (2 placed, 1 staged)
select throws_ok(
  $$ select public.adjust_stock('ff341000-0000-0000-0000-000000000004'::uuid, -3, 'remove', null, 'pgtap', null) $$,
  'P0001', 'insufficient_placed_stock',
  '1. placed mode (default) still refuses when only Staging could cover the rest'
);

-- 2. nothing half-applied by the refused call
select is(
  (select quantity from public.item_stock_levels
     where item_id = :item and location_id = :rack),
  2::numeric,
  '2. rack level untouched after the refused placed draw'
);

-- 3-5. 'any' mode drains the shelf then Staging: full write-off succeeds
select lives_ok(
  $$ select public.adjust_stock('ff341000-0000-0000-0000-000000000004'::uuid, -3, 'remove', null, 'pgtap', null, 'any') $$,
  '3. any mode: -3 succeeds'
);
select is(
  (select quantity_on_hand from public.inventory_items where id = :item),
  0::numeric,
  '3b. on_hand = 0'
);
select is(
  (select coalesce(sum(quantity),0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :item and l.kind is distinct from 'staging'),
  0::numeric,
  '4. any mode: placed levels = 0'
);
select is(
  (select coalesce(sum(quantity),0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :item and l.kind = 'staging'),
  0::numeric,
  '5. any mode: Staging level = 0'
);

-- 6. partial 'any' removal comes off the shelf FIRST
select lives_ok(
  $$ select public.adjust_stock('ff341000-0000-0000-0000-000000000006'::uuid, -1, 'remove', null, 'pgtap', null, 'any') $$,
  '6a. any mode: -1 on item2 succeeds'
);
select is(
  (select array[
     (select quantity from public.item_stock_levels where item_id = :item2 and location_id = :rack),
     (select coalesce(sum(quantity),0) from public.item_stock_levels s join public.locations l on l.id = s.location_id
        where s.item_id = :item2 and l.kind = 'staging')
   ]),
  array[1::numeric, 1::numeric],
  '6. any mode partial removal: rack 2->1, Staging still 1 (shelf first)'
);

-- 7. 'any' still surfaces drift: holdings (2) cannot cover -3 even with Staging
select throws_ok(
  $$ select public.adjust_stock('ff341000-0000-0000-0000-000000000007'::uuid, -3, 'remove', null, 'pgtap', null, 'any') $$,
  'P0001', 'insufficient_placed_stock',
  '7. any mode raises when the holdings do not cover the delta at all (drift surfaced)'
);

-- 8. publish_outbox as a MANAGER now succeeds
select ok(
  public.publish_outbox(:org, 'return.created', 'return', :item, '{"pgtap":true}'::jsonb, 'pgtap:0341:1') is not null,
  '8. manager can publish to the outbox (returns an id)'
);

-- 10. idempotent on dedupe_key: second call returns null, still one row
select ok(
  public.publish_outbox(:org, 'return.created', 'return', :item, '{"pgtap":true}'::jsonb, 'pgtap:0341:1') is null,
  '10a. duplicate dedupe_key returns null'
);

-- ── Become a member of ANOTHER org ────────────────────────────────────────────
reset role;
set local "request.jwt.claim.sub" to 'ff341000-0000-0000-0000-000000000009';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- 9. outsider cannot publish into :org
select throws_ok(
  $$ select public.publish_outbox('ff341000-0000-0000-0000-000000000001'::uuid, 'return.created', 'return', null, '{}'::jsonb, 'pgtap:0341:2') $$,
  '42501', 'forbidden',
  '9. a member of another org cannot publish into this org'
);

reset role;
select is(
  (select count(*)::int from public.outbox_events where organization_id = :org and dedupe_key like 'pgtap:0341:%'),
  1,
  '10. exactly one outbox row for the deduped publish; the outsider wrote none'
);

select * from finish();
rollback;
