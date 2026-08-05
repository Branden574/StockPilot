begin;
select plan(26);

-- ── Fixtures ────────────────────────────────────────────────────────────────
\set org_a '''a0000000-0000-0000-0000-00000000000a'''
\set org_b '''b0000000-0000-0000-0000-00000000000b'''
\set requester '''10000000-0000-0000-0000-000000000001'''
\set other_staff '''10000000-0000-0000-0000-000000000002'''
\set mgr '''10000000-0000-0000-0000-000000000003'''
\set andrew '''10000000-0000-0000-0000-000000000004'''
\set outsider '''10000000-0000-0000-0000-000000000005'''
\set org_owner '''10000000-0000-0000-0000-000000000006'''

insert into auth.users (id, email) values
  (:requester, 'req@test.local'), (:other_staff, 'staff2@test.local'),
  (:mgr, 'mgr@test.local'), (:andrew, 'andrew@test.local'), (:outsider, 'out@test.local'),
  (:org_owner, 'owner@test.local');
-- DEVIATION from the brief's literal fixture: `insert ... on conflict (id) do
-- nothing` unconditionally 23502s here, because user_profiles.email is NOT
-- NULL with no default and the on_auth_user_created trigger (0001) already
-- created these rows from the auth.users insert above. Postgres validates
-- NOT NULL constraints on the constructed tuple BEFORE the ON CONFLICT
-- arbiter decides to skip, so the omitted `email` column always fails —
-- confirmed by reproducing against a brand-new, non-conflicting id too.
-- An UPDATE against the trigger-created rows achieves the same fixture
-- intent (friendly display names; full_name is never asserted below) without
-- ever constructing an insert tuple.
update public.user_profiles set full_name = v.full_name
from (values
  (:requester::uuid, 'Req One'), (:other_staff::uuid, 'Staff Two'), (:mgr::uuid, 'Mgr Three'),
  (:andrew::uuid, 'Andrew Rosas'), (:outsider::uuid, 'Out Sider'), (:org_owner::uuid, 'Org Owner')
) as v(id, full_name)
where public.user_profiles.id = v.id;

insert into public.organizations (id, name, slug) values
  (:org_a, 'Maint Org A', 'maint-org-a'), (:org_b, 'Maint Org B', 'maint-org-b');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_a, :requester, 'staff',  now()),
  (:org_a, :other_staff, 'staff', now()),
  (:org_a, :mgr, 'manager', now()),
  (:org_a, :andrew, 'viewer', now()),
  (:org_a, :org_owner, 'owner', now()),
  (:org_b, :outsider, 'staff', now());

-- Module ON for org A only (org B stays grandfathered OFF).
update public.organization_modules set enabled = true
 where organization_id = :org_a and module_id = 'maintenance_requests';

-- ── Structure ───────────────────────────────────────────────────────────────
select has_table('public', 'maintenance_requests', 'maintenance_requests exists');
select has_table('public', 'maintenance_request_attachments', 'attachments table exists');
select has_table('public', 'maintenance_request_notes', 'notes table exists');
select has_table('public', 'maintenance_request_share_links', 'share links table exists');
select col_not_null('public', 'maintenance_requests', 'organization_id', 'org id not null');

-- Grandfather: every org has a row, disabled by default (org B untouched).
select ok(
  exists (select 1 from public.organization_modules
           where organization_id = :org_b and module_id = 'maintenance_requests' and enabled = false),
  'module grandfathered OFF for other orgs');

-- Seed rows: 8 new defaults, configure seeded for NOBODY.
select is(
  (select count(*)::int from public.role_default_permissions where permission like 'maintenance_requests:%'), 8,
  'exactly 8 maintenance permission default rows');
select ok(
  not exists (select 1 from public.role_default_permissions where permission = 'maintenance_requests:configure'),
  'configure has zero default rows (owner-only)');

-- ── Requester can create own; number auto-assigns 1, 2 ─────────────────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :requester, 'Req One', 'AC not working in Room 204', 'Blowing warm air since yesterday.');
select is(
  (select request_number from public.maintenance_requests
    where organization_id = :org_a and subject = 'AC not working in Room 204'), 1::bigint,
  'first request gets number 1');

insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :requester, 'Req One', 'Leaking sink in break room', 'Steady drip under the sink.');
select is(
  (select max(request_number) from public.maintenance_requests where organization_id = :org_a), 2::bigint,
  'second request gets number 2');

-- Requester reads own rows only.
select is((select count(*)::int from public.maintenance_requests), 2, 'requester sees own 2 rows');

-- Requester cannot forge another user as requester.
select throws_ok(
  $$ insert into public.maintenance_requests
       (organization_id, requester_user_id, requester_name_snapshot, subject, description)
     values ('a0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003',
             'Mgr Three', 'Forged requester', 'nope') $$,
  '42501', null, 'cannot insert with someone else as requester');

-- ── Another staff member sees NOTHING (no read_all) ─────────────────────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.maintenance_requests), 0, 'plain staff sees zero rows');

-- ── Manager holds read_all + manage by default: sees all, can update ────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000003';
select is((select count(*)::int from public.maintenance_requests), 2, 'manager (read_all default) sees all');
update public.maintenance_requests set local_owner_user_id = '10000000-0000-0000-0000-000000000003'
 where organization_id = :org_a and request_number = 1;
select is(
  (select local_owner_user_id from public.maintenance_requests
    where organization_id = :org_a and request_number = 1),
  '10000000-0000-0000-0000-000000000003'::uuid, 'manager can assign local owner');

-- Manager adds an internal note; requester cannot read it.
insert into public.maintenance_request_notes (organization_id, maintenance_request_id, author_user_id, body)
select organization_id, id, '10000000-0000-0000-0000-000000000003', 'Called facilities, waiting on parts.'
  from public.maintenance_requests where organization_id = :org_a and request_number = 1;
select is((select count(*)::int from public.maintenance_request_notes), 1, 'manager reads own note');
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.maintenance_request_notes), 0, 'requester cannot read internal notes');

-- ── Andrew: viewer + per-user override grant of read_all sees everything ────
set local role to postgres;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:org_a, :andrew, 'maintenance_requests:read_all', true);
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000004';
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_requests), 2,
  'per-user override grants Andrew all-request visibility');

-- ── Owner: full access always (has_permission owner short-circuit) ──────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000006';
select is((select count(*)::int from public.maintenance_requests), 2,
  'org owner retains full visibility without any seeded permission rows');

-- ── Cross-org: org B member sees zero rows, cannot insert into org A ────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000005';
select is((select count(*)::int from public.maintenance_requests), 0, 'other org sees zero rows');
select throws_ok(
  $$ insert into public.maintenance_requests
       (organization_id, requester_user_id, requester_name_snapshot, subject, description)
     values ('a0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000005',
             'Out Sider', 'Cross-org write', 'nope') $$,
  '42501', null, 'cross-org insert blocked');

-- Module OFF (org B enabled=false): its own member cannot insert either.
select throws_ok(
  $$ insert into public.maintenance_requests
       (organization_id, requester_user_id, requester_name_snapshot, subject, description)
     values ('b0000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000005',
             'Out Sider', 'Module is off here', 'nope') $$,
  '42501', null, 'module-off org blocks INSERT at RLS');

-- SELECT is NOT module-gated: flip org A off, requester still sees history.
set local role to postgres;
update public.organization_modules set enabled = false
 where organization_id = :org_a and module_id = 'maintenance_requests';
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_requests), 2,
  'disabling the module does not hide existing history');

-- Share links: authenticated non-manager cannot read tokens.
select is((select count(*)::int from public.maintenance_request_share_links), 0,
  'requester cannot enumerate share links');

-- notification_preferences carries the four maintenance columns.
select has_column('public', 'notification_preferences', 'push_maintenance_new_request', 'pref col 1');
select has_column('public', 'notification_preferences', 'push_maintenance_draft_reminder', 'pref col 4');

select * from finish();
rollback;
