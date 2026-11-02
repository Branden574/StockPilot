-- B99 pin (scratch candidate for supabase/tests/warehouse_writes_owner_admin_only.test.sql).
-- A member below admin who holds organization:update ('Edit organization details'), by a
-- per-member grant (manager) or a role grant (staff), cannot write warehouses, charters,
-- warehouse_charters or the organization row: UPDATE and DELETE are silent 0-row no-ops (no
-- error) and INSERT is refused with 42501. The grant does not widen which warehouses staff
-- can read. An admin's same writes land, RETURNING included. An admin whose
-- organization:update was revoked still writes: the policies ask the role only, so the app
-- check is the only thing that enforces that revoke.
begin;
select plan(32);

\set org '\'b9900000-0000-4000-8000-0000000000aa\''
\set adm '\'b9900000-0000-4000-8000-0000000000a1\''
\set mgr '\'b9900000-0000-4000-8000-0000000000a2\''
\set stf '\'b9900000-0000-4000-8000-0000000000a3\''
\set wh  '\'b9900000-0000-4000-8000-0000000000b1\''
\set wh2 '\'b9900000-0000-4000-8000-0000000000b2\''
\set c1  '\'b9900000-0000-4000-8000-0000000000c1\''
\set c2  '\'b9900000-0000-4000-8000-0000000000c2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:adm, 'adm@b99.invalid', '{}'::jsonb),
  (:mgr, 'mgr@b99.invalid', '{}'::jsonb),
  (:stf, 'stf@b99.invalid', '{}'::jsonb);
insert into public.organizations (id, name, slug) values (:org, 'B99 Probe Org', 'b99-probe-org');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :adm, 'admin', now()),
  (:org, :mgr, 'manager', now()),
  (:org, :stf, 'staff', now());
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:org, :mgr, 'organization:update', true);
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:org, 'staff', 'organization:update', true);
insert into public.charters (id, organization_id, name, code) values
  (:c1, :org, 'Probe Charter One', 'PC1'),
  (:c2, :org, 'Probe Charter Two', 'PC2');
insert into public.warehouses (id, organization_id, name, code) values
  (:wh, :org, 'Probe Depot', 'PDEPOT'),
  (:wh2, :org, 'Probe Depot Two', 'PDEPOT2');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:org, :wh, :c1);
-- Staff may see the first warehouse only, so a 0-row UPDATE there is the write policy,
-- not the read one, and the second warehouse tests the read scope.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id)
  values (:org, :stf, :wh)
  on conflict do nothing;

-- ── the manager granted organization:update per member ──────────────────────
set local "request.jwt.claim.sub" to 'b9900000-0000-4000-8000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(public.has_permission('b9900000-0000-4000-8000-0000000000aa'::uuid, 'organization:update'),
  'manager: has_permission organization:update is true (the grant)');
select ok(not public.has_org_role('b9900000-0000-4000-8000-0000000000aa'::uuid, 'admin'),
  'manager: has_org_role admin is false');
select is((select count(*) from public.warehouses where id = 'b9900000-0000-4000-8000-0000000000b1'), 1::bigint,
  'manager: can READ the warehouse');
with attempt as (
  update public.warehouses set name = 'Renamed by manager' where id = :wh returning id
)
select is((select count(*) from attempt), 0::bigint, 'manager: warehouse UPDATE changes 0 rows (no error)');
with attempt as (
  delete from public.warehouse_charters where warehouse_id = :wh and charter_id = :c1 returning charter_id
)
select is((select count(*) from attempt), 0::bigint, 'manager: link DELETE removes 0 rows (no error)');
select throws_ok(
  $$ insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
       ('b9900000-0000-4000-8000-0000000000aa','b9900000-0000-4000-8000-0000000000b1','b9900000-0000-4000-8000-0000000000c2') $$,
  '42501', null, 'manager: link INSERT refused 42501');
select throws_ok(
  $$ insert into public.warehouses (organization_id, name, code) values
       ('b9900000-0000-4000-8000-0000000000aa','Manager depot','MGRD') $$,
  '42501', null, 'manager: warehouse INSERT refused 42501');
with attempt as (
  update public.charters set name = 'Renamed charter' where id = :c1 returning id
)
select is((select count(*) from attempt), 0::bigint, 'manager: charter UPDATE changes 0 rows (no error)');
select throws_ok(
  $$ insert into public.charters (organization_id, name, code) values
       ('b9900000-0000-4000-8000-0000000000aa','Manager charter','MGRC') $$,
  '42501', null, 'manager: charter INSERT refused 42501');
with attempt as (
  update public.warehouses set status = 'archived' where id = :wh returning id
)
select is((select count(*) from attempt), 0::bigint, 'manager: archive (status UPDATE) changes 0 rows');
with attempt as (
  update public.warehouses set is_public_orderable = true where id = :wh returning id
)
select is((select count(*) from attempt), 0::bigint,
  'manager: public request switch (is_public_orderable UPDATE) changes 0 rows');
with attempt as (
  update public.organizations set public_request_blurb = 'Manager blurb' where id = :org returning id
)
select is((select count(*) from attempt), 0::bigint,
  'manager: public request message (organizations UPDATE) changes 0 rows');
reset role;

-- ── staff granted organization:update for the whole role ────────────────────
set local "request.jwt.claim.sub" to 'b9900000-0000-4000-8000-0000000000a3';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(public.has_permission('b9900000-0000-4000-8000-0000000000aa'::uuid, 'organization:update'),
  'staff: has_permission organization:update is true (role grant)');
with attempt as (
  update public.warehouses set name = 'Renamed by staff' where id = :wh returning id
)
select is((select count(*) from attempt), 0::bigint, 'staff: warehouse UPDATE changes 0 rows (no error)');
with attempt as (
  delete from public.warehouse_charters where warehouse_id = :wh and charter_id = :c1 returning charter_id
)
select is((select count(*) from attempt), 0::bigint, 'staff: link DELETE removes 0 rows (no error)');
select throws_ok(
  $$ insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
       ('b9900000-0000-4000-8000-0000000000aa','b9900000-0000-4000-8000-0000000000b1','b9900000-0000-4000-8000-0000000000c2') $$,
  '42501', null, 'staff: link INSERT refused 42501');
with attempt as (
  update public.organizations set public_request_blurb = 'Staff blurb' where id = :org returning id
)
select is((select count(*) from attempt), 0::bigint,
  'staff: public request message (organizations UPDATE) changes 0 rows');
select is((select count(*) from public.warehouses where id = 'b9900000-0000-4000-8000-0000000000b2'), 0::bigint,
  'staff: the grant does not widen reads (an unassigned warehouse stays unreadable)');
reset role;

-- ── nothing changed ──────────────────────────────────────────────────────────
select is((select name from public.warehouses where id = :wh), 'Probe Depot', 'state: warehouse name unchanged');
select is((select status from public.warehouses where id = :wh), 'active', 'state: warehouse still active');
select is((select count(*) from public.warehouse_charters where warehouse_id = :wh), 1::bigint,
  'state: the one link is still there and none was added');
select is((select name from public.charters where id = :c1), 'Probe Charter One', 'state: charter name unchanged');
select ok((select public_request_blurb is null and not exists (
             select 1 from public.warehouses w where w.id = :wh and w.is_public_orderable)
           from public.organizations where id = :org),
  'state: public request message and switch unchanged');

-- ── the admin: the same writes land (positive control) ───────────────────────
set local "request.jwt.claim.sub" to 'b9900000-0000-4000-8000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
with attempt as (
  update public.warehouses set name = 'Renamed by admin' where id = :wh returning id
)
select is((select count(*) from attempt), 1::bigint, 'admin: warehouse UPDATE changes 1 row');
select lives_ok(
  $$ insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
       ('b9900000-0000-4000-8000-0000000000aa','b9900000-0000-4000-8000-0000000000b1','b9900000-0000-4000-8000-0000000000c2') $$,
  'admin: link INSERT lands');
with attempt as (
  delete from public.warehouse_charters where warehouse_id = :wh and charter_id = :c1 returning charter_id
)
select is((select count(*) from attempt), 1::bigint, 'admin: link DELETE removes 1 row (RETURNING passes the read policy)');
with attempt as (
  update public.charters set name = 'Charter renamed by admin' where id = :c1 returning id
)
select is((select count(*) from attempt), 1::bigint, 'admin: charter UPDATE changes 1 row');
with attempt as (
  update public.warehouses set is_public_orderable = true where id = :wh returning id
)
select is((select count(*) from attempt), 1::bigint, 'admin: public request switch changes 1 row');
with attempt as (
  update public.organizations set public_request_blurb = 'Admin blurb' where id = :org returning id
)
select is((select count(*) from attempt), 1::bigint, 'admin: public request message changes 1 row');
reset role;

-- ── an admin whose organization:update was REVOKED: the database still lets them ─
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:org, :adm, 'organization:update', false);
set local "request.jwt.claim.sub" to 'b9900000-0000-4000-8000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(not public.has_permission('b9900000-0000-4000-8000-0000000000aa'::uuid, 'organization:update'),
  'revoked admin: has_permission organization:update is false');
with attempt as (
  update public.warehouses set notes = 'revoked admin wrote this' where id = :wh returning id
)
select is((select count(*) from attempt), 1::bigint,
  'revoked admin: warehouse UPDATE still lands (the policy asks the role only; the app check is the only enforcer of the revoke)');
reset role;

select is((select count(*) from public.warehouse_charters where warehouse_id = :wh and charter_id = :c2), 1::bigint,
  'state: the admin''s link landed');

select * from finish();
rollback;
