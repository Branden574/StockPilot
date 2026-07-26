-- supabase/tests/0292_placed_drawdown_includes_null_kind.test.sql
-- Proof that apply_level_delta's placed draw-down (mig 0292) sees stock parked in
-- a NULL-kind location, still refuses to touch Staging, and still visits Unplaced
-- last.
--
-- WHY: 0194 filtered the placed loop with `l.kind <> 'staging'`. locations.kind is
-- nullable (0188), and `NULL <> 'staging'` is NULL, not TRUE, so every NULL-kind
-- location was silently dropped from the draw-down and the stock in it became
-- unpickable (complete_picking -> insufficient_placed_stock, with no bin the
-- operator could put away FROM). 0292 changes the predicate to the NULL-safe
-- `l.kind is distinct from 'staging'`.
--
-- Fixtures (one org, one warehouse -- the 0188 trigger auto-creates its Staging
-- and Unplaced buckets -- plus TWO NULL-kind locations and five items):
--   item1: null-kind = 10, Staging = 5, on_hand 15
--   item2: Staging = 7 only, on_hand 7                 (nothing placed at all)
--   item3: null-kind #2 = 5, Unplaced = 5, on_hand 10  (ordering probe; the
--          Unplaced bucket is back-dated one day so a created_at-only ordering
--          would reach it FIRST -- only the CASE rank keeps it last)
--   item4: Staging = 4, null-kind = 6, on_hand 10      (staging_first, fits)
--   item5: Staging = 4, null-kind = 6, on_hand 10      (staging_first, overflows)
--
-- 18 assertions:
--    1-2  the three-valued-logic facts behind the bug and the fix
--    3    fixture sanity: the probe location's kind really IS NULL (without this
--         the whole file could pass vacuously if a default/trigger ever fills it)
--    4-8  the five RPC calls run (or raise, for the staging-only one)
--    9-11 placed draw-down TOOK from the NULL-kind location, left Staging alone,
--         and kept Sigma levels = quantity_on_hand
--    12   staging-only item is still refused: placed never drains Staging
--    13-14 ordering: the NULL-kind location drains to 0 while the older Unplaced
--         bucket is untouched -- NULL-kind sorts in the `else 0` group
--    15-16 staging_first (a branch 0292 did NOT change) still drains Staging
--         first and leaves the NULL-kind placed stock alone
--    17-18 staging_first that outruns Staging now spills into the NULL-kind
--         placed stock instead of raising -- the fix reaches this mode too,
--         because staging_first falls through into the placed loop
--
-- NEGATIVE CONTROL (measured, not predicted). With apply_level_delta re-defined
-- on a LOCAL database using the OLD predicate (`l.kind <> 'staging'`, the exact
-- pre-0292 body dumped from pg_get_functiondef), this file fails 8 of its 18:
--   4  died: P0001 insufficient_placed_stock -- the production symptom
--   8  died: P0001 -- staging_first could not reach the NULL-kind remainder
--   9  NULL-kind level still 10, want 6
--   11 Sigma levels still 15, want 11
--   13 NULL-kind #2 still 5, want 0
--   14 Unplaced drawn to 0 instead of staying 5 (ordering probe inverted)
--   17 staging_first overflow: Staging still 4, want 0
--   18 NULL-kind level still 6, want 3
-- Assertions 5 and 12 (Staging is never drawn by mode 'placed') and 15-16
-- (staging_first still prefers Staging) pass under BOTH predicates -- that is
-- the point of including them: they pin the behaviour that must not move.
-- Captured output in .superpowers/sdd/task-0292-report.md.
--
-- Wrapped in begin/rollback -- nothing leaks.

begin;

select plan(18);

\set org      '\'ff920000-0000-0000-0000-000000000001\''
\set usr      '\'ff920000-0000-0000-0000-000000000002\''
\set wh       '\'ff920000-0000-0000-0000-000000000003\''
\set nullloc  '\'ff920000-0000-0000-0000-000000000004\''
\set item1    '\'ff920000-0000-0000-0000-000000000005\''
\set item2    '\'ff920000-0000-0000-0000-000000000006\''
\set nullloc2 '\'ff920000-0000-0000-0000-000000000007\''
\set item3    '\'ff920000-0000-0000-0000-000000000008\''
\set item4    '\'ff920000-0000-0000-0000-000000000009\''
\set item5    '\'ff920000-0000-0000-0000-00000000000a\''

-- ── Fixtures (seeded as superuser before the role switch) ─────────────────────

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'nullkind-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;

insert into public.organizations (id, name, slug)
  values (:org, 'Null-Kind Test Org', 'nullkind-test-org-0292') on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;

-- Warehouse -- the 0188 trigger auto-creates its Staging + Unplaced locations.
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Null-Kind Test WH', 'WH-NK', 'active') on conflict (id) do nothing;

-- The bug's subject: ordinary operator/seed-created locations carry NO kind.
-- (apps/web/src/server/actions/organization.ts seeds every new org's first
-- location exactly like this, and LocationsService leaves kind optional.)
insert into public.locations (id, organization_id, warehouse_id, name, type)
  values
    (:nullloc,  :org, :wh, 'DC-NULLKIND',   'bin'),
    (:nullloc2, :org, :wh, 'DC-NULLKIND-2', 'bin')
  on conflict (id) do nothing;

-- Back-date the warehouse's Unplaced bucket. Everything in this transaction
-- otherwise shares one now(), so l.created_at would tie and the ORDER BY's
-- second key could not be trusted to prove anything. With Unplaced a day older,
-- a created_at-only ordering would visit it FIRST -- so assertions 13-14 can
-- only pass if the `case when l.kind = 'unplaced' then 1 else 0 end` rank puts
-- the NULL-kind row (rank 0) ahead of it (rank 1).
update public.locations
   set created_at = now() - interval '1 day'
 where warehouse_id = :wh and kind = 'unplaced';

-- ── Items ─────────────────────────────────────────────────────────────────────
-- warehouse_id is required for the user_can_access_inventory RLS predicate.

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item1, :org, :wh, 'NK-0292-1', 'Null-Kind Placed Item',     15, 'active', 'none'),
    (:item2, :org, :wh, 'NK-0292-2', 'Staging Only Item',          7, 'active', 'none'),
    (:item3, :org, :wh, 'NK-0292-3', 'Ordering Probe Item',       10, 'active', 'none'),
    (:item4, :org, :wh, 'NK-0292-4', 'Staging First Fits Item',   10, 'active', 'none'),
    (:item5, :org, :wh, 'NK-0292-5', 'Staging First Spills Item', 10, 'active', 'none')
  on conflict (id) do nothing;

-- The 0199 trigger seeds an Unplaced level for each; clear them so every item's
-- per-location breakdown is exactly what this test intends.
delete from public.item_stock_levels
 where item_id in (:item1, :item2, :item3, :item4, :item5);

-- item1: 10 in the NULL-kind location, 5 in Staging.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item1, :nullloc, 10) on conflict (item_id, location_id) do nothing;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item1, l.id, 5 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1
  on conflict (item_id, location_id) do nothing;

-- item2: 7 in Staging and nothing anywhere else.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item2, l.id, 7 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1
  on conflict (item_id, location_id) do nothing;

-- item3: 5 in the second NULL-kind location, 5 in the (older) Unplaced bucket.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item3, :nullloc2, 5) on conflict (item_id, location_id) do nothing;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item3, l.id, 5 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'unplaced' and l.deleted_at is null limit 1
  on conflict (item_id, location_id) do nothing;

-- item4 + item5: 4 in Staging, 6 in the NULL-kind location.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :item4, :nullloc, 6), (:org, :item5, :nullloc, 6)
  on conflict (item_id, location_id) do nothing;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item4, l.id, 4 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1
  on conflict (item_id, location_id) do nothing;

insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  select :org, :item5, l.id, 4 from public.locations l
   where l.warehouse_id = :wh and l.kind = 'staging' and l.deleted_at is null limit 1
  on conflict (item_id, location_id) do nothing;

-- ── 1-2. The three-valued-logic facts this migration turns on ────────────────

select is(
  (null::text <> 'staging'),
  null::boolean,
  'NULL <> ''staging'' is NULL (not TRUE) -- why the old filter dropped NULL-kind rows');

select ok(
  (null::text is distinct from 'staging'),
  'NULL is distinct from ''staging'' is TRUE -- the NULL-safe predicate 0292 adopts');

-- ── 3. Fixture sanity: the probe locations really are NULL-kind ──────────────

select is(
  (select count(*)::int from public.locations
    where id in ('ff920000-0000-0000-0000-000000000004'::uuid,
                 'ff920000-0000-0000-0000-000000000007'::uuid)
      and kind is null),
  2,
  'fixture: both probe locations have kind IS NULL (test is not vacuous)');

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────────

set local "request.jwt.claim.sub" to 'ff920000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 4-8. The calls ───────────────────────────────────────────────────────────

-- 4. THE BUG: a placed draw-down against stock that lives only in a NULL-kind
--    location. Under `<>` this raised insufficient_placed_stock.
select lives_ok(
  $$ select public.adjust_stock(
       'ff920000-0000-0000-0000-000000000005'::uuid,
       -4, 'remove', null, 'pgtap-nullkind-placed', null) $$,
  'placed draw-down of NULL-kind stock succeeds (no insufficient_placed_stock)');

-- 5. Staging is not placed stock: an item whose only stock is in Staging must
--    still be refused by mode 'placed'.
select throws_ok(
  $$ select public.adjust_stock(
       'ff920000-0000-0000-0000-000000000006'::uuid,
       -3, 'remove', null, 'pgtap-staging-only', null) $$,
  'P0001', 'insufficient_placed_stock',
  'placed draw-down still refuses a Staging-only item (P0001)');

-- 6. Ordering probe: 5 units wanted, NULL-kind location and Unplaced both hold 5.
select lives_ok(
  $$ select public.adjust_stock(
       'ff920000-0000-0000-0000-000000000008'::uuid,
       -5, 'remove', null, 'pgtap-ordering', null) $$,
  'placed draw-down with a NULL-kind location and an Unplaced bucket succeeds');

-- 7. staging_first, need 3 and Staging holds 4 -- must not reach placed stock.
select lives_ok(
  $$ select public.adjust_stock(
       'ff920000-0000-0000-0000-000000000009'::uuid,
       -3, 'remove', null, 'pgtap-stgfirst-fits', null, 'staging_first') $$,
  'staging_first draw-down within Staging succeeds');

-- 8. staging_first, need 7 and Staging holds 4 -- the 3 remaining must come from
--    the NULL-kind placed stock (this branch falls through into the placed loop,
--    so the fix reaches it without its own predicate changing).
select lives_ok(
  $$ select public.adjust_stock(
       'ff920000-0000-0000-0000-00000000000a'::uuid,
       -7, 'remove', null, 'pgtap-stgfirst-spills', null, 'staging_first') $$,
  'staging_first overflowing Staging spills into NULL-kind placed stock');

-- ── Read the resulting levels as superuser (RLS out of the picture) ──────────

reset role;

-- ── 9-11. item1: drawn from NULL-kind, Staging untouched, Sigma = on_hand ────

select is(
  (select quantity from public.item_stock_levels
    where item_id     = 'ff920000-0000-0000-0000-000000000005'::uuid
      and location_id = 'ff920000-0000-0000-0000-000000000004'::uuid),
  6::numeric,
  '-4 placed drew from the NULL-kind location (10 -> 6)');

select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff920000-0000-0000-0000-000000000005'::uuid
      and l.warehouse_id = 'ff920000-0000-0000-0000-000000000003'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  5::numeric,
  'placed draw-down left the Staging level untouched (still 5)');

-- Literal 11, not a comparison against quantity_on_hand: when the draw-down
-- raises, the whole adjust_stock statement rolls back and Sigma == on_hand == 15
-- still holds, so a dynamic comparison would pass under the buggy predicate too.
select is(
  (select coalesce(sum(isl.quantity), 0) from public.item_stock_levels isl
    where isl.item_id = 'ff920000-0000-0000-0000-000000000005'::uuid),
  11::numeric,
  'Sigma item_stock_levels = 11 = quantity_on_hand (15 - 4) -- levels stayed authoritative');

-- ── 12. item2: the refused draw left Staging alone ──────────────────────────

select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff920000-0000-0000-0000-000000000006'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  7::numeric,
  'Staging-only item: Staging level never drawn by mode ''placed'' (still 7)');

-- ── 13-14. Ordering: NULL-kind first, Unplaced last ─────────────────────────

select is(
  (select quantity from public.item_stock_levels
    where item_id     = 'ff920000-0000-0000-0000-000000000008'::uuid
      and location_id = 'ff920000-0000-0000-0000-000000000007'::uuid),
  0::numeric,
  'ordering: the NULL-kind location was drained first (5 -> 0)');

select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff920000-0000-0000-0000-000000000008'::uuid
      and l.kind = 'unplaced'
      and l.deleted_at is null
    limit 1),
  5::numeric,
  'ordering: Unplaced stayed last and untouched (still 5) despite an older created_at');

-- ── 15-16. staging_first (unchanged branch) still prefers Staging ────────────

select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff920000-0000-0000-0000-000000000009'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  1::numeric,
  'staging_first: -3 drained Staging (4 -> 1) with a NULL-kind location present');

select is(
  (select quantity from public.item_stock_levels
    where item_id     = 'ff920000-0000-0000-0000-000000000009'::uuid
      and location_id = 'ff920000-0000-0000-0000-000000000004'::uuid),
  6::numeric,
  'staging_first: NULL-kind placed stock left untouched while Staging covers it (6)');

-- ── 17-18. staging_first overflow now reaches NULL-kind placed stock ─────────

select is(
  (select isl.quantity
     from public.item_stock_levels isl
     join public.locations l on l.id = isl.location_id
    where isl.item_id = 'ff920000-0000-0000-0000-00000000000a'::uuid
      and l.kind = 'staging'
      and l.deleted_at is null
    limit 1),
  0::numeric,
  'staging_first overflow: Staging fully drained (4 -> 0)');

select is(
  (select quantity from public.item_stock_levels
    where item_id     = 'ff920000-0000-0000-0000-00000000000a'::uuid
      and location_id = 'ff920000-0000-0000-0000-000000000004'::uuid),
  3::numeric,
  'staging_first overflow: remaining 3 came from the NULL-kind location (6 -> 3)');

select * from finish();
rollback;
