begin;
select plan(17);

-- ── Fixtures (0314-test conventions) ────────────────────────────────────────
\set org_a '''a0000000-0000-0000-0000-00000000001a'''
\set requester '''20000000-0000-0000-0000-000000000001'''
\set mgr '''20000000-0000-0000-0000-000000000002'''

insert into auth.users (id, email) values
  (:requester, 'res-req@test.local'), (:mgr, 'res-mgr@test.local');
-- DEVIATION from the brief's literal fixture (documented precedent:
-- 0314_maintenance_requests.test.sql:19-28): `insert ... on conflict (id) do
-- nothing` unconditionally 23502s here, because user_profiles.email is NOT
-- NULL with no default and the on_auth_user_created trigger (0001) already
-- created these rows from the auth.users insert above. Postgres validates
-- NOT NULL constraints on the constructed tuple BEFORE the ON CONFLICT
-- arbiter decides to skip, so the omitted `email` column always fails. An
-- UPDATE against the trigger-created rows achieves the same fixture intent
-- (friendly display names; full_name is never asserted below).
update public.user_profiles set full_name = v.full_name
from (values
  (:requester::uuid, 'Res Req'), (:mgr::uuid, 'Res Mgr')
) as v(id, full_name)
where public.user_profiles.id = v.id;
insert into public.organizations (id, name, slug) values
  (:org_a, 'Resolved Org A', 'resolved-org-a');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_a, :requester, 'staff', now()),
  (:org_a, :mgr, 'manager', now());
update public.organization_modules set enabled = true
 where organization_id = :org_a and module_id = 'maintenance_requests';

-- ── Structure ───────────────────────────────────────────────────────────────
select has_column('public', 'maintenance_requests', 'resolved_at', 'resolved_at exists');
select has_column('public', 'maintenance_requests', 'resolved_by', 'resolved_by exists');
select has_column('public', 'maintenance_requests', 'resolved_by_name_snapshot', 'name snapshot exists');
select has_column('public', 'maintenance_requests', 'resolution_note', 'resolution_note exists');
select has_column('public', 'maintenance_requests', 'resolution_email_sent_at', 'email stamp exists');
select has_column('public', 'maintenance_request_attachments', 'kind', 'attachment kind exists');
select has_column('public', 'notification_preferences', 'push_maintenance_resolved', 'pref column exists');
-- 0316 uniqueness must survive this migration untouched.
select has_index('public', 'maintenance_request_attachments',
  'maintenance_request_attachments_org_path_uniq', '0316 unique index still present');
-- 0207 seed count is deliberately UNTOUCHED by this program (119) — no
-- maintenance permissions are added; do not bump that suite.

-- ── Create an OPEN request as the requester ─────────────────────────────────
set local "request.jwt.claim.sub" to '20000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :requester, 'Res Req', 'Leaking roof tile in Hall B', 'Water drips during rain.');

-- ── RLS: the kind clause, tested on the still-OPEN parent ───────────────────
-- Deliberately BEFORE the resolve below: on an open request the kind clause
-- is the ONLY thing refusing this insert, so mutation T1-M2 (deleting the
-- clause) is genuinely killable here — after the resolve, the parent-open
-- clause would mask it.
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename,
        safe_filename, mime_type, byte_size, uploaded_by, kind)
     select 'a0000000-0000-0000-0000-00000000001a', id,
        'a0000000-0000-0000-0000-00000000001a/' || id || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
        'p.jpg', 'p.jpg', 'image/jpeg', 100, '20000000-0000-0000-0000-000000000001', 'resolution'
       from public.maintenance_requests limit 1 $$,
  '42501', null, 'requester cannot insert kind=resolution on their own OPEN request');
reset role;

-- ── Status CHECK ────────────────────────────────────────────────────────────
update public.maintenance_requests
   set status = 'resolved', resolved_at = now(), resolved_by = :mgr,
       resolved_by_name_snapshot = 'Res Mgr',
       resolution_note = 'The issue for the leaking roof tile has been resolved.'
 where organization_id = :org_a;
select is(
  (select status from public.maintenance_requests where organization_id = :org_a),
  'resolved', 'status CHECK accepts resolved');
select throws_ok(
  $$ update public.maintenance_requests set status = 'zendesk_closed'
      where organization_id = 'a0000000-0000-0000-0000-00000000001a' $$,
  '23514', null, 'status CHECK rejects unknown values');

-- ── RLS: requester cannot edit own RESOLVED row ─────────────────────────────
set local "request.jwt.claim.sub" to '20000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.maintenance_requests set subject = 'edited after resolve'
 where organization_id = :org_a;
reset role;
select is(
  (select subject from public.maintenance_requests where organization_id = :org_a),
  'Leaking roof tile in Hall B', 'requester UPDATE on resolved row matched 0 rows');

-- ── RLS: photos freeze on a resolved parent (even kind=requester) ───────────
set local "request.jwt.claim.sub" to '20000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename,
        safe_filename, mime_type, byte_size, uploaded_by, kind)
     select 'a0000000-0000-0000-0000-00000000001a', id,
        'a0000000-0000-0000-0000-00000000001a/' || id || '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg',
        'p.jpg', 'p.jpg', 'image/jpeg', 100, '20000000-0000-0000-0000-000000000001', 'requester'
       from public.maintenance_requests limit 1 $$,
  '42501', null, 'photos freeze on a resolved parent');
reset role;

-- ── Archive re-buckets resolved AND cancelled (D1) ──────────────────────────
update public.maintenance_requests
   set status = 'archived', archived_at = now()
 where organization_id = :org_a;
select is(
  (select status from public.maintenance_requests where organization_id = :org_a),
  'archived', 'resolved row archives (re-bucket)');
select ok(
  (select resolved_at is not null and resolution_note is not null
     from public.maintenance_requests where organization_id = :org_a),
  'archive preserves the resolution stamps');

-- kind CHECK + default
select is(
  (select count(*)::int from information_schema.check_constraints
    where constraint_name = 'maintenance_request_attachments_kind_check'), 1,
  'kind CHECK constraint exists');
select is(
  (select column_default like '%requester%' from information_schema.columns
    where table_name = 'maintenance_request_attachments' and column_name = 'kind'),
  true, 'kind defaults to requester');

select * from finish();
rollback;
