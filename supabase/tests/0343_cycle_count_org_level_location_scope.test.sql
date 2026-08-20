-- supabase/tests/0343_cycle_count_org_level_location_scope.test.sql
-- pgTAP gate for migration 0343: a counted location with NO warehouse is
-- org-level, not a cross-warehouse violation.
--
-- ═══ WHY THIS FILE EXISTS ═══
--
-- 0342 shipped with 55 tests and this case in none of them: every fixture in
-- that file gave its locations a warehouse_id, so `null is distinct from
-- <warehouse>` was never evaluated. Posting a REAL count in the demo org found
-- it in about a minute — the scope guard refused a location 0342's own trigger
-- had stamped moments earlier, and the whole count failed with
-- cycle_count_location_out_of_scope.
--
-- That was strictly worse than the bug 0342 fixed: before, the count posted and
-- put the surplus in the wrong place; after, it would not post at all.
--
-- Namespace: 03430000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(7);

\set org     '\'03430000-0000-0000-0000-000000000001\''
\set mgr     '\'03430000-0000-0000-0000-0000000000a1\''
\set whA     '\'03430000-0000-0000-0000-0000000000b1\''
\set whB     '\'03430000-0000-0000-0000-0000000000b2\''
\set orgLoc  '\'03430000-0000-0000-0000-0000000000e1\''
\set whBLoc  '\'03430000-0000-0000-0000-0000000000e2\''
\set itemO   '\'03430000-0000-0000-0000-0000000000c1\''
\set itemX   '\'03430000-0000-0000-0000-0000000000c2\''
\set ccOrg   '\'03430000-0000-0000-0000-0000000000d1\''
\set ccBad   '\'03430000-0000-0000-0000-0000000000d2\''
\set lnO     '\'03430000-0000-0000-0000-0000000000f1\''
\set lnX     '\'03430000-0000-0000-0000-0000000000f2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr-0343@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:org, 'Org Level Loc 0343', 'org-level-loc-0343') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :org, 'WH A 0343', 'WH-0343-A', 'active'),
  (:whB, :org, 'WH B 0343', 'WH-0343-B', 'active')
on conflict (id) do nothing;

-- THE SHAPE THAT BROKE IT: a location belonging to the ORG, with no warehouse.
-- Production holds these (the demo org has three), and apply_level_delta has
-- always handled them via its `v_wh is null` branch.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:orgLoc, :org, null, 'Org Level Shelf 0343', 'bin', 'rack'),
  (:whBLoc, :org, :whB, 'WH B Rack 0343',       'bin', 'rack')
on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, item_type) values
  (:itemO, :org, :whA, 'OL-0343-O', 'Counted on an org-level shelf', 12, 'active', 'none', 'product'),
  (:itemX, :org, :whA, 'OL-0343-X', 'Counted in the wrong warehouse', 12, 'active', 'none', 'product')
on conflict (id) do nothing;

delete from public.item_stock_levels where item_id in (:itemO, :itemX);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :itemO, :orgLoc, 12),
  (:org, :itemX, :orgLoc, 12)
on conflict (item_id, location_id) do nothing;

insert into public.cycle_counts
  (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccOrg, :org, :whA, 'in_progress', 'selection', :mgr, now()),
  (:ccBad, :org, :whA, 'in_progress', 'selection', :mgr, now())
on conflict (id) do nothing;

insert into public.cycle_count_lines
  (id, cycle_count_id, item_id, expected_quantity, counted_quantity, warehouse_id) values
  (:lnO, :ccOrg, :itemO, 12, null, :whA),
  (:lnX, :ccBad, :itemX, 12, null, :whA)
on conflict (id) do nothing;

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 15, counted_by = :mgr, counted_at = now() where id = :lnO;
update public.cycle_count_lines set counted_quantity = 15, counted_by = :mgr, counted_at = now() where id = :lnX;
reset role;

select is((select counted_location_id from public.cycle_count_lines where id = :lnO), :orgLoc::uuid,
  '0343: an org-level location is still stamped at count time');

-- The line's warehouse is whA; the location has no warehouse at all.
select is((select warehouse_id from public.locations where id = :orgLoc), null::uuid,
  '0343: ...and that location genuinely has no warehouse');

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ select public.post_cycle_count('03430000-0000-0000-0000-0000000000d1'::uuid) $$,
  '0343: posting succeeds — a missing warehouse is not a cross-warehouse violation');
reset role;

select is((select quantity from public.item_stock_levels where item_id = :itemO and location_id = :orgLoc),
  15::numeric,
  '0343: the +3 landed on the org-level shelf');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemO and l.kind = 'staging'),
  0::numeric,
  '0343: Staging still did not absorb it');

-- The real violation must STILL be refused: both sides known, and different.
update public.cycle_count_lines set counted_location_id = :whBLoc where id = :lnX;
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ select public.post_cycle_count('03430000-0000-0000-0000-0000000000d2'::uuid) $$,
  '22023', 'cycle_count_location_out_of_scope',
  '0343: a location in a DIFFERENT known warehouse is still refused');
reset role;

select is((select quantity_on_hand from public.inventory_items where id = :itemX), 12::numeric,
  '0343: the refused post mutated nothing');

select * from finish();
rollback;
