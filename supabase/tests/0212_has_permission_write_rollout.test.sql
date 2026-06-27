-- supabase/tests/0212_has_permission_write_rollout.test.sql
-- Proves migration 0212: write RLS for items/categories/suppliers/locations now
-- honors has_permission(), so a granted viewer can write; managers keep access;
-- cross-org stays blocked.

begin;
select plan(8);

\set orgA   '\'ca000000-0000-0000-0000-0000000000ca\''
\set orgB   '\'cb000000-0000-0000-0000-0000000000cb\''
\set mgr    '\'c0000000-0000-0000-0000-0000000000c1\''
\set viewer '\'c0000000-0000-0000-0000-0000000000c2\''
\set gview  '\'c0000000-0000-0000-0000-0000000000c3\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr@p3.test', '{}'::jsonb),
  (:viewer, 'view@p3.test', '{}'::jsonb),
  (:gview, 'gview@p3.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'P3 Org A', 'p3-org-a'),
  (:orgB, 'P3 Org B', 'p3-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr, 'manager', now()),
  (:orgA, :viewer, 'viewer', now()),
  (:orgA, :gview, 'viewer', now());
-- gview is a viewer GRANTED several write permissions via per-user overrides.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :gview, 'categories:manage', true),
  (:orgA, :gview, 'suppliers:manage', true),
  (:orgA, :gview, 'items:create', true),
  (:orgA, :gview, 'locations:manage', true);

-- ── categories ─────────────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'c0000000-0000-0000-0000-0000000000c2'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.categories (organization_id, name) values ('ca000000-0000-0000-0000-0000000000ca','V cat') $$,
  '42501', null, 'plain viewer cannot insert a category'
);
reset role;

set local "request.jwt.claim.sub" to 'c0000000-0000-0000-0000-0000000000c3'; -- gview
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.categories (organization_id, name) values ('ca000000-0000-0000-0000-0000000000ca','G cat') $$,
  'viewer granted categories:manage CAN insert a category'
);
select lives_ok(
  $$ insert into public.suppliers (organization_id, name) values ('ca000000-0000-0000-0000-0000000000ca','G sup') $$,
  'viewer granted suppliers:manage CAN insert a supplier'
);
select lives_ok(
  $$ insert into public.locations (organization_id, name) values ('ca000000-0000-0000-0000-0000000000ca','G loc') $$,
  'viewer granted locations:manage CAN insert a location'
);
select lives_ok(
  $$ insert into public.inventory_items (organization_id, sku, name) values ('ca000000-0000-0000-0000-0000000000ca','G-SKU-1','G item') $$,
  'viewer granted items:create CAN insert an item'
);
-- cross-org: gview is granted in orgA only, not a member of orgB.
select throws_ok(
  $$ insert into public.categories (organization_id, name) values ('cb000000-0000-0000-0000-0000000000cb','X cat') $$,
  '42501', null, 'granted viewer cannot write into another org (no membership/permission there)'
);
reset role;

-- ── viewer still blocked on items; manager still allowed on categories ─────
set local "request.jwt.claim.sub" to 'c0000000-0000-0000-0000-0000000000c2'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.inventory_items (organization_id, sku, name) values ('ca000000-0000-0000-0000-0000000000ca','V-SKU-1','V item') $$,
  '42501', null, 'plain viewer (no items:create) cannot insert an item'
);
reset role;

set local "request.jwt.claim.sub" to 'c0000000-0000-0000-0000-0000000000c1'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.categories (organization_id, name) values ('ca000000-0000-0000-0000-0000000000ca','M cat') $$,
  'manager can still insert a category (no regression)'
);
reset role;

select * from finish();
rollback;
