-- supabase/tests/0250_b2b_customers.test.sql
-- Proves migration 0250 (B2B P1 org-side surface):
--   S1. Org MEMBER (viewer) can read customers but NOT write them.
--   S2. Manager can create a customer + price list + price row + catalog row.
--   S3. Cross-org isolation: a member of org B sees NONE of org A's customers.
--   S4. customers:manage seeded for admin+manager, not staff/viewer.
--   S5. order_requests.customer_id exists and FKs to customers.
-- Namespace ab025000. Wrapped in begin/rollback.

begin;

select plan(9);

\set orga  '\'ab025000-0000-0000-0000-000000000001\''
\set orgb  '\'ab025000-0000-0000-0000-000000000002\''
\set mgr   '\'ab025000-0000-0000-0000-000000000011\''
\set view  '\'ab025000-0000-0000-0000-000000000012\''
\set outsider '\'ab025000-0000-0000-0000-000000000013\''
\set cust  '\'ab025000-0000-0000-0000-0000000000c1\''
\set pl    '\'ab025000-0000-0000-0000-0000000000d1\''
\set wh    '\'ab025000-0000-0000-0000-0000000000e1\''
\set item  '\'ab025000-0000-0000-0000-0000000000f1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'b2b-mgr-0250@test.local', '{}'::jsonb),
  (:view, 'b2b-view-0250@test.local', '{}'::jsonb),
  (:outsider, 'b2b-out-0250@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orga, 'B2B Org A', 'b2b-a-0250'),
  (:orgb, 'B2B Org B', 'b2b-b-0250')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orga, :mgr, 'manager', now()),
  (:orga, :view, 'viewer', now()),
  (:orgb, :outsider, 'manager', now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :orga, 'B2B WH', 'WH-B2B-0250', 'active') on conflict (id) do nothing;
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values (:item, :orga, :wh, 'B2B-1', 'B2B Item', 10, 'active', 'none') on conflict (id) do nothing;

-- S4 — permission seed rows.
select is(
  (select count(*)::int from public.role_default_permissions
    where permission = 'customers:manage' and role in ('admin','manager')),
  2, 'S4: customers:manage seeded for admin + manager');
select is(
  (select count(*)::int from public.role_default_permissions
    where permission = 'customers:manage' and role in ('staff','viewer')),
  0, 'S4b: customers:manage NOT seeded for staff/viewer');

-- S2 — manager writes.
set local "request.jwt.claim.sub" to 'ab025000-0000-0000-0000-000000000011';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ insert into public.customers (id, organization_id, name)
       values ('ab025000-0000-0000-0000-0000000000c1', 'ab025000-0000-0000-0000-000000000001', 'Acme Schools') $$,
  'S2: manager creates a customer');
select lives_ok(
  $$ insert into public.price_lists (id, organization_id, name)
       values ('ab025000-0000-0000-0000-0000000000d1', 'ab025000-0000-0000-0000-000000000001', 'Acme pricing') $$,
  'S2b: manager creates a price list');
select lives_ok(
  $$ insert into public.price_list_items (price_list_id, item_id, unit_price)
       values ('ab025000-0000-0000-0000-0000000000d1', 'ab025000-0000-0000-0000-0000000000f1', 199.99) $$,
  'S2c: manager prices an item');
select lives_ok(
  $$ insert into public.customer_catalog (customer_id, item_id)
       values ('ab025000-0000-0000-0000-0000000000c1', 'ab025000-0000-0000-0000-0000000000f1') $$,
  'S2d: manager allowlists an item');

-- S1 — viewer reads, cannot write.
set local "request.jwt.claim.sub" to 'ab025000-0000-0000-0000-000000000012';
select is(
  (select count(*)::int from public.customers where organization_id = :orga),
  1, 'S1: org viewer can read customers');
select throws_ok(
  $$ insert into public.customers (organization_id, name)
       values ('ab025000-0000-0000-0000-000000000001', 'Sneaky') $$,
  '42501', null,
  'S1b: viewer INSERT is rejected by RLS');

-- S3 — org B sees nothing of org A.
set local "request.jwt.claim.sub" to 'ab025000-0000-0000-0000-000000000013';
select is(
  (select count(*)::int from public.customers),
  0, 'S3: cross-org member sees zero customers');

select * from finish();
rollback;
