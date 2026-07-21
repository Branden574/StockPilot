-- supabase/tests/0207_permission_overrides.test.sql
-- pgTAP proof of the configurable-permissions resolver (migration 0207):
--   public.has_permission(org, perm) = owner⇒true; else user override →
--   role override → static default → false. Plus the RLS write guard on the
--   two override tables (admins+ write; members read).
--
-- Run via `supabase test db`. begin/rollback so nothing leaks. Users are
-- "become"d via request.jwt.claim.sub so auth.uid() resolves inside the
-- SECURITY DEFINER has_permission().

begin;

select plan(17);

\set org_id    '\'aa000000-0000-0000-0000-0000000000aa\''
\set owner_id  '\'b0000000-0000-0000-0000-00000000000b\''
\set admin_id  '\'a0000000-0000-0000-0000-00000000000a\''
\set mgr_id    '\'c0000000-0000-0000-0000-00000000000c\''
\set view_id   '\'d0000000-0000-0000-0000-00000000000d\''
\set non_id    '\'e0000000-0000-0000-0000-00000000000e\''

-- ── Fixtures (seeded as the test superuser — RLS bypassed) ─────────────────
-- auth.users insert fires on_auth_user_created → creates user_profiles rows.
insert into auth.users (id, email, raw_user_meta_data) values
  (:owner_id, 'owner@perm.test',  '{}'::jsonb),
  (:admin_id, 'admin@perm.test',  '{}'::jsonb),
  (:mgr_id,   'mgr@perm.test',    '{}'::jsonb),
  (:view_id,  'view@perm.test',   '{}'::jsonb),
  (:non_id,   'non@perm.test',    '{}'::jsonb);

insert into public.organizations (id, name, slug) values (:org_id, 'Perm Test Org', 'perm-test-org');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_id, :owner_id, 'owner',   now()),
  (:org_id, :admin_id, 'admin',   now()),
  (:org_id, :mgr_id,   'manager', now()),
  (:org_id, :view_id,  'viewer',  now());
-- :non_id is intentionally NOT a member.

-- ── Parity-ish guard: seed populated for the four non-owner roles ──────────
select is(
  (select count(*)::int from public.role_default_permissions),
  109,
  'role_default_permissions seeded with 109 rows (admin/manager/staff/viewer flatten; +2 customers:manage rows from 0250; +1 public_links:manage row from 0261; +2 movements:edit_notes rows from 0274; +13 auditor read rows from 0279 — admin/manager 5 each + staff 3)'
);

select ok(
  exists (select 1 from public.role_default_permissions where role = 'viewer' and permission = 'purchase_orders:read'),
  'viewer default includes purchase_orders:read'
);
select ok(
  not exists (select 1 from public.role_default_permissions where role = 'viewer' and permission = 'purchase_orders:manage'),
  'viewer default excludes purchase_orders:manage'
);

-- ── has_permission: defaults ───────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'd0000000-0000-0000-0000-00000000000d'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select ok( public.has_permission(:org_id, 'purchase_orders:read'),
  'viewer: has_permission(purchase_orders:read) = true by default' );
select ok( not public.has_permission(:org_id, 'purchase_orders:manage'),
  'viewer: has_permission(purchase_orders:manage) = false by default' );

reset role;

-- ── Role override GRANT: viewer ⇒ purchase_orders:manage ───────────────────
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org_id, 'viewer', 'purchase_orders:manage', true);

set local "request.jwt.claim.sub" to 'd0000000-0000-0000-0000-00000000000d'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok( public.has_permission(:org_id, 'purchase_orders:manage'),
  'viewer: role override grant flips purchase_orders:manage to true' );
reset role;

-- ── Role override REVOKE: manager ⇏ purchase_orders:manage ─────────────────
-- First prove the manager DOES have it by default…
set local "request.jwt.claim.sub" to 'c0000000-0000-0000-0000-00000000000c'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok( public.has_permission(:org_id, 'purchase_orders:manage'),
  'manager: has_permission(purchase_orders:manage) = true by default' );
reset role;

-- …then a revoke override flips it off.
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org_id, 'manager', 'purchase_orders:manage', false);

set local "request.jwt.claim.sub" to 'c0000000-0000-0000-0000-00000000000c'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok( not public.has_permission(:org_id, 'purchase_orders:manage'),
  'manager: role override revoke flips purchase_orders:manage to false' );
reset role;

-- ── User override beats role override ──────────────────────────────────────
-- Role-revoke items:read for viewer, then user-grant it for THIS viewer.
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org_id, 'viewer', 'items:read', false);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  values (:org_id, :view_id, 'items:read', true);

set local "request.jwt.claim.sub" to 'd0000000-0000-0000-0000-00000000000d'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok( public.has_permission(:org_id, 'items:read'),
  'user override (grant) beats role override (revoke)' );
reset role;

-- ── Owner is immutable — always true, even with a revoke override ──────────
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org_id, 'owner', 'purchase_orders:manage', false);

set local "request.jwt.claim.sub" to 'b0000000-0000-0000-0000-00000000000b'; -- owner
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok( public.has_permission(:org_id, 'purchase_orders:manage'),
  'owner: revoke override is ignored — owner keeps every permission' );
select ok( public.has_permission(:org_id, 'billing:manage'),
  'owner: has billing:manage (which admin lacks)' );
reset role;

-- ── Non-member ⇒ false ─────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'e0000000-0000-0000-0000-00000000000e'; -- non-member
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok( not public.has_permission(:org_id, 'items:read'),
  'non-member: has_permission = false for everything' );
reset role;

-- ── RLS write guard ────────────────────────────────────────────────────────
-- Viewer cannot write overrides; admin can.
set local "request.jwt.claim.sub" to 'd0000000-0000-0000-0000-00000000000d'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.role_permission_overrides (organization_id, role, permission, granted)
       values ('aa000000-0000-0000-0000-0000000000aa', 'staff', 'items:delete', true) $$,
  '42501',
  null,
  'viewer is RLS-denied from writing role_permission_overrides'
);
select throws_ok(
  $$ insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
       values ('aa000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-00000000000d', 'items:delete', true) $$,
  '42501',
  null,
  'viewer is RLS-denied from writing user_permission_overrides'
);
reset role;

set local "request.jwt.claim.sub" to 'a0000000-0000-0000-0000-00000000000a'; -- admin
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.role_permission_overrides (organization_id, role, permission, granted)
       values ('aa000000-0000-0000-0000-0000000000aa', 'staff', 'reports:export', true) $$,
  'admin can write role_permission_overrides'
);
select lives_ok(
  $$ insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
       values ('aa000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-00000000000d', 'reports:export', true) $$,
  'admin can write user_permission_overrides'
);
-- A member can read the global defaults reference.
select ok(
  (select count(*) from public.role_default_permissions) > 0,
  'authenticated member can read role_default_permissions'
);
reset role;

select * from finish();
rollback;
