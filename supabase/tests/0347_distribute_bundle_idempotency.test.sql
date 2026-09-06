-- supabase/tests/0347_distribute_bundle_idempotency.test.sql
-- Proves migration 0347: distribute_bundle absorbs a replayed request.
--
-- WHY THIS TEST EXISTS
--   Mobile's Distribute screen re-sent a distribution through the offline
--   outbox after its own timeout, and nothing on the server could tell the
--   replay from a new request: components were drawn twice. Assertions 4-10
--   FAIL on the 0198 definition (the 7-argument form does not exist there) and
--   pass on 0347. The null-key path is pinned so the web modal is unchanged.
--
-- Fixtures mirror 0198_bundle_levels.test.sql (1 kit = 2x compA + 3x compB).
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(19);

\set org    '\'03470000-0000-0000-0000-000000000001\''
\set usr    '\'03470000-0000-0000-0000-000000000002\''
\set wh     '\'03470000-0000-0000-0000-000000000003\''
\set compA  '\'03470000-0000-0000-0000-000000000004\''
\set compB  '\'03470000-0000-0000-0000-000000000005\''
\set rack   '\'03470000-0000-0000-0000-000000000006\''
\set bundle '\'03470000-0000-0000-0000-000000000007\''

insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bundle-idem-mgr-0347@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Bundle Idempotency Org 0347', 'bundle-idem-0347')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Bundle Idem WH 0347', 'WH-BI47', 'active')
  on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'Rack I-01 0347', 'bin', 'rack')
  on conflict (id) do nothing;
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:compA, :org, :wh, 'COMP-A-0347', 'Component Alpha 0347', 20, 'active', 'none'),
    (:compB, :org, :wh, 'COMP-B-0347', 'Component Beta 0347',  30, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels where item_id in (:compA, :compB);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values (:org, :compA, :rack, 20), (:org, :compB, :rack, 30)
  on conflict (item_id, location_id) do nothing;
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled)
  values (:bundle, :org, 'Idem Kit 0347', 'BNDL-IDEM47', true, false)
  on conflict (id) do nothing;
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional)
  values (:bundle, :compA, 2, false), (:bundle, :compB, 3, false)
  on conflict do nothing;

-- ── 1. Signature ──────────────────────────────────────────────────────────
select has_function('public', 'distribute_bundle',
  array['uuid','numeric','uuid','boolean','uuid','text','text'],
  '0347/1: distribute_bundle accepts p_idempotency_key');
select hasnt_function('public', 'distribute_bundle',
  array['uuid','numeric','uuid','boolean','uuid','text'],
  '0347/2: the old six-argument overload is gone (no ungated replay path survives)');

-- ── 2. Replay with the SAME key is absorbed ───────────────────────────────
set local "request.jwt.claim.sub" to '03470000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.distribute_bundle(%L, 2, %L, false, null, 'first attempt', 'k1-0347')$$, :bundle, :wh),
  '0347/3: first distribution with key k1 succeeds');
select lives_ok(
  format($$select public.distribute_bundle(%L, 2, %L, false, null, 'outbox replay', 'k1-0347')$$, :bundle, :wh),
  '0347/4: the replay with the same key does not raise');
reset role;
select is((select count(*)::int from public.bundle_distributions where bundle_id = :bundle), 1,
  '0347/5: exactly ONE distribution exists after the replay');
select is((select quantity_on_hand from public.inventory_items where id = :compA), 16::numeric,
  '0347/6: compA drawn once (20 - 2x2), not twice');
select is((select quantity_on_hand from public.inventory_items where id = :compB), 24::numeric,
  '0347/7: compB drawn once (30 - 3x2)');
select is((select count(*)::int from public.stock_movements where item_id = :compA and movement_type = 'bundle_distribution'), 1,
  '0347/8: one bundle_distribution movement for compA, not two');
select is((select status from public.idempotency_keys where organization_id = :org and scope = 'bundle_distribution' and key = 'k1-0347'), 'completed',
  '0347/9: the key row is completed');
select is(
  (select resource_id from public.idempotency_keys where organization_id = :org and scope = 'bundle_distribution' and key = 'k1-0347'),
  (select id from public.bundle_distributions where bundle_id = :bundle limit 1),
  '0347/10: ... and points at the one distribution the replay returned');

-- ── 3. Same key, DIFFERENT request -> conflict, nothing written ───────────
set local "request.jwt.claim.sub" to '03470000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$select public.distribute_bundle(%L, 3, %L, false, null, 'edited', 'k1-0347')$$, :bundle, :wh),
  '40001', 'idempotency_conflict',
  '0347/11: reusing k1 with a different quantity is refused');
reset role;
select is((select count(*)::int from public.bundle_distributions where bundle_id = :bundle), 1,
  '0347/12: ... and nothing was distributed');

-- ── 4. A NEW key is a new distribution ────────────────────────────────────
set local "request.jwt.claim.sub" to '03470000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.distribute_bundle(%L, 1, %L, false, null, null, 'k2-0347')$$, :bundle, :wh),
  '0347/13: a fresh key distributes again');
reset role;
select is((select count(*)::int from public.bundle_distributions where bundle_id = :bundle), 2,
  '0347/14: two distributions now');
select is((select quantity_on_hand from public.inventory_items where id = :compA), 14::numeric,
  '0347/15: compA drawn by the second kit (16 - 2)');

-- ── 5. No key = the historical web path, unchanged ────────────────────────
set local "request.jwt.claim.sub" to '03470000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.distribute_bundle(%L, 1, %L, false)$$, :bundle, :wh),
  '0347/16: a keyless call still works through the defaults');
select lives_ok(
  format($$select public.distribute_bundle(%L, 1, %L, false)$$, :bundle, :wh),
  '0347/17: and a second keyless call is a second distribution (no key, no dedupe)');
reset role;
select is((select count(*)::int from public.bundle_distributions where bundle_id = :bundle), 4,
  '0347/18: four distributions in total');
select is((select count(*)::int from public.idempotency_keys where organization_id = :org and scope = 'bundle_distribution'), 2,
  '0347/19: keyless calls wrote no key rows');

select * from finish();
rollback;
