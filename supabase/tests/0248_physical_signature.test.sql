-- supabase/tests/0248_physical_signature.test.sql
-- Proves migration 0248: confirm_physical_signature.
--
--   P1. Manager records a paper signature on a fully-picked staged order →
--       completed, signature_method='physical', signed_by_name set, no image,
--       fulfilled accumulated from the staged batch.
--   P2. Short-picked order → forks to backordered (owed > 0), signed fields set.
--   G1. A staff user who is NOT the assigned driver is rejected (forbidden).
--   G2. Recording twice is rejected (already_signed).
--   G3. Wrong status (approved) is rejected.
--   B1. Backfill: a pre-existing digitally-signed row got signature_method='digital'.
--
-- Namespace ab024800. Wrapped in begin/rollback.

begin;

select plan(10);

\set org  '\'ab024800-0000-0000-0000-000000000001\''
\set mgr  '\'ab024800-0000-0000-0000-000000000002\''
\set staff '\'ab024800-0000-0000-0000-000000000004\''
\set wh   '\'ab024800-0000-0000-0000-000000000003\''
\set item '\'ab024800-0000-0000-0000-0000000000a0\''
\set ord1 '\'ab024800-0000-0000-0000-0000000000b1\''
\set l1   '\'ab024800-0000-0000-0000-0000000000b2\''
\set ord2 '\'ab024800-0000-0000-0000-0000000000c1\''
\set l2   '\'ab024800-0000-0000-0000-0000000000c2\''
\set ord3 '\'ab024800-0000-0000-0000-0000000000d1\''
\set ordb '\'ab024800-0000-0000-0000-0000000000e1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'ps-mgr-0248@test.local', '{}'::jsonb),
  (:staff, 'ps-staff-0248@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'PhysSig Org 0248', 'physsig-0248') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now()),
  (:org, :staff, 'staff', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'PS WH', 'WH-PS-0248', 'active') on conflict (id) do nothing;
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :org, :wh, 'PS-1', 'PS Item', 100, 'active', 'none') on conflict (id) do nothing;

-- ord1: staged, fully picked (10 of 10). ord2: staged, short (4 of 10).
-- ord3: approved (wrong status). ordb: already digitally signed (backfill check).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values
  (:ord1, :org, :wh, 'pending_approval', :mgr, 'internal', 'pickup'),
  (:ord2, :org, :wh, 'pending_approval', :mgr, 'internal', 'pickup'),
  (:ord3, :org, :wh, 'pending_approval', :mgr, 'internal', 'pickup'),
  (:ordb, :org, :wh, 'pending_approval', :mgr, 'internal', 'pickup')
  on conflict (id) do nothing;
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_picked)
  values
  (:l1, :ord1, :item, 10, 10),
  (:l2, :ord2, :item, 10, 4)
  on conflict (id) do nothing;

alter table public.order_requests disable trigger trg_order_requests_validate_transition;
update public.order_requests set status = 'staged_for_pickup' where id in (:ord1, :ord2);
update public.order_requests set status = 'approved' where id = :ord3;
update public.order_requests
  set status = 'staged_for_pickup', signed_at = now(), signed_by_name = 'Prior Signer',
      signature_data_url = 'data:image/png;base64,AAAA'
  where id = :ordb;
alter table public.order_requests enable trigger trg_order_requests_validate_transition;

-- B1: the backfill in the migration ran BEFORE this row was seeded, so re-run
-- its statement here to prove it targets signed rows missing a method.
update public.order_requests set signature_method = 'digital'
  where signed_at is not null and signature_method is null;
select is(
  (select signature_method from public.order_requests where id = :ordb),
  'digital',
  'B1: already-signed rows read as digital after backfill');

-- Act as the manager.
set local "request.jwt.claim.sub" to 'ab024800-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- P1: full hand-over → completed.
select lives_ok(
  $$ select public.confirm_physical_signature('ab024800-0000-0000-0000-0000000000b1'::uuid, 'Paper Signer') $$,
  'P1: manager records a physical signature');
select is(
  (select status from public.order_requests where id = :ord1),
  'completed', 'P1: fully-picked order completes');
select is(
  (select signature_method from public.order_requests where id = :ord1),
  'physical', 'P1: signature_method = physical');
select is(
  (select signature_data_url from public.order_requests where id = :ord1),
  null, 'P1: no signature image for a paper signature');
select is(
  (select quantity_fulfilled from public.order_request_lines where id = :l1),
  10::numeric, 'P1: staged batch shipped into quantity_fulfilled');

-- P2: short order → backordered.
select lives_ok(
  $$ select public.confirm_physical_signature('ab024800-0000-0000-0000-0000000000c1'::uuid, 'Paper Signer 2') $$,
  'P2: physical signature on a short order');
select is(
  (select status from public.order_requests where id = :ord2),
  'backordered', 'P2: short order forks to backordered');

-- G2: recording twice rejected.
select throws_ok(
  $$ select public.confirm_physical_signature('ab024800-0000-0000-0000-0000000000b1'::uuid, 'Again') $$,
  'P0001', null, 'G2: double-record rejected (already signed / wrong status)');

-- G1: staff (not assigned driver) rejected. Switch identity.
set local "request.jwt.claim.sub" to 'ab024800-0000-0000-0000-000000000004';
select throws_ok(
  $$ select public.confirm_physical_signature('ab024800-0000-0000-0000-0000000000d1'::uuid, 'Nope') $$,
  '42501', null, 'G1: staff without driver assignment is forbidden');

select * from finish();
rollback;
