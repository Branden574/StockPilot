begin;
select plan(40);

-- ── Fixtures ────────────────────────────────────────────────────────────────
\set org_a '''a0000000-0000-0000-0000-00000000000a'''
\set org_b '''b0000000-0000-0000-0000-00000000000b'''
\set org_c '''c0000000-0000-0000-0000-00000000000c'''
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
  (:org_a, 'Maint Org A', 'maint-org-a'), (:org_b, 'Maint Org B', 'maint-org-b'),
  (:org_c, 'Maint Org C', 'maint-org-c');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_a, :requester, 'staff',  now()),
  (:org_a, :other_staff, 'staff', now()),
  (:org_a, :mgr, 'manager', now()),
  (:org_a, :andrew, 'viewer', now()),
  (:org_a, :org_owner, 'owner', now()),
  (:org_b, :outsider, 'staff', now());

-- Module ON for org A only (org B stays grandfathered OFF). Org C also gets
-- the module ON, with zero members and zero requests of its own — it exists
-- solely as a "foreign org whose module IS enabled" target for the
-- attachment cross-org test below, so that test isolates the EXISTS
-- org-match check instead of being masked by the unrelated module_enabled
-- gate (org B's module is OFF, which would block that insert for its own
-- reason regardless of the org-match bug).
update public.organization_modules set enabled = true
 where organization_id in (:org_a, :org_c) and module_id = 'maintenance_requests';

-- Victim-org fixture request (org B), inserted via service-role bypass since
-- org B's module stays OFF (grandfathered) — RLS would otherwise block it.
-- This is the "org V" request used below to prove the parent-consistency
-- (Global Constraint 6) fixes on attachments/notes/share-links.
set local role to postgres;
insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_b, :outsider, 'Out Sider', 'Org B leaking pipe', 'Water under the floor.');
-- Capture its real id as a literal now, while we can still see it. Later
-- cross-org attack tests run under the ATTACKER's own session, which cannot
-- SELECT this row at all (that's a separate, correctly-enforced control) —
-- the write-policy boundary must hold even when the attacker already knows
-- the target id (e.g. leaked via URL), so tests reference it by literal.
select id from public.maintenance_requests
  where organization_id = :org_b and request_number = 1 \gset victim_
-- role stays postgres/bypass here; the Structure section below reads tables
-- (organization_modules, role_default_permissions) that plain 'authenticated'
-- has no grant on.

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
-- Capture its real id as a literal (requester can see their own row here;
-- later attacker sessions below reference it by literal for the same reason
-- documented at the org B victim fixture above).
select id from public.maintenance_requests
  where organization_id = :org_a and subject = 'AC not working in Room 204' \gset req1_

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

-- ── Multi-requester numbering: a DIFFERENT requester in the same org gets ───
-- the next sequential number (proves assign_maintenance_request_number's
-- security-definer advisory lock is keyed on org, not on the calling user).
insert into public.maintenance_requests
  (organization_id, requester_user_id, requester_name_snapshot, subject, description)
values (:org_a, :other_staff, 'Staff Two', 'Broken light in hallway', 'Flickering, then went dark.');
select is(
  (select request_number from public.maintenance_requests
    where organization_id = :org_a and subject = 'Broken light in hallway'), 3::bigint,
  'a different requester gets the next sequential number (3)');

-- ── Manager holds read_all + manage by default: sees all, can update ────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000003';
select is((select count(*)::int from public.maintenance_requests), 3, 'manager (read_all default) sees all');
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

-- Org-P manager cannot insert a note bound to an org-V request: the note's
-- organization_id is stamped as org A (their own, so has_permission passes
-- trivially) but maintenance_request_id points at org B's victim request —
-- the parent-consistency join must catch the mismatch (Fix 2 / exploit 2).
-- The target id is spliced in via format()/%L so psql substitutes it OUTSIDE
-- the dollar-quoted template (psql does not interpolate :vars inside $$..$$);
-- a live subquery under the attacker's own session would return zero rows
-- (RLS already hides org B's row from an org A manager) and silently no-op
-- the insert instead of exercising the write-policy boundary being tested.
select throws_ok(
  format($$ insert into public.maintenance_request_notes
       (organization_id, maintenance_request_id, author_user_id, body)
     values ('a0000000-0000-0000-0000-00000000000a', %L,
             '10000000-0000-0000-0000-000000000003', 'Cross-org note') $$,
    :'victim_id'),
  '42501', null, 'org-P manager cannot insert a note bound to an org-V request');

-- Plain staff (no manage permission) cannot insert a note at all. Same
-- literal-id splice as above (plain staff cannot SELECT request #1 either).
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000002';
select throws_ok(
  format($$ insert into public.maintenance_request_notes
       (organization_id, maintenance_request_id, author_user_id, body)
     values ('a0000000-0000-0000-0000-00000000000a', %L,
             '10000000-0000-0000-0000-000000000002', 'Sneaky note') $$,
    :'req1_id'),
  '42501', null, 'plain staff cannot insert an internal note');

set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.maintenance_request_notes), 0, 'requester cannot read internal notes');

-- ── Attachments: ownership + cross-tenant guards (Fix 1 / exploit 1) ────────
-- Requester inserts an attachment on their own request: allowed.
insert into public.maintenance_request_attachments
  (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
select organization_id, id, 'a0000000-0000-0000-0000-00000000000a/photo.jpg', 'photo.jpg', 'photo.jpg',
       'image/jpeg', 12345, '10000000-0000-0000-0000-000000000001'
  from public.maintenance_requests where organization_id = :org_a and request_number = 1;
select is((select count(*)::int from public.maintenance_request_attachments), 1,
  'requester inserts an attachment on their own request');

-- The proven exploit: same (own) request, but the attachment is stamped with
-- a FOREIGN organization_id — org C, which has the module ENABLED (unlike
-- org B) so this test isolates the EXISTS org-match check itself rather than
-- being blocked for the unrelated reason that the target org's module is
-- off. Must be blocked now that the EXISTS guard compares against the
-- parent row's REAL org, not itself.
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
     select 'c0000000-0000-0000-0000-00000000000c', id, 'c0000000-0000-0000-0000-00000000000c/evil.jpg',
            'evil.jpg', 'evil.jpg', 'image/jpeg', 999, '10000000-0000-0000-0000-000000000001'
       from public.maintenance_requests where organization_id = 'a0000000-0000-0000-0000-00000000000a'
        and request_number = 1 $$,
  '42501', null, 'cross-org organization_id stamp on attachment insert is blocked');

-- Other-org member sees zero of org A's attachments.
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000005';
select is((select count(*)::int from public.maintenance_request_attachments), 0,
  'other-org member sees zero attachments');

-- Module-off org blocks attachment insert too, even for the request's own
-- requester (org B's module has never been enabled).
select throws_ok(
  $$ insert into public.maintenance_request_attachments
       (organization_id, maintenance_request_id, storage_path, original_filename, safe_filename, mime_type, byte_size, uploaded_by)
     select organization_id, id, 'x.jpg', 'x.jpg', 'x.jpg', 'image/jpeg', 100,
            '10000000-0000-0000-0000-000000000005'
       from public.maintenance_requests where organization_id = 'b0000000-0000-0000-0000-00000000000b'
        and request_number = 1 $$,
  '42501', null, 'module-off org blocks attachment insert at RLS');

-- ── Andrew: viewer + per-user override grant of read_all sees everything ────
set local role to postgres;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:org_a, :andrew, 'maintenance_requests:read_all', true);
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000004';
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_requests), 3,
  'per-user override grants Andrew all-request visibility');
select is((select count(*)::int from public.maintenance_request_notes), 0,
  'read_all-only holder (Andrew) reads requests but zero notes');

-- ── Owner: full access always (has_permission owner short-circuit) ──────────
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000006';
select is((select count(*)::int from public.maintenance_requests), 3,
  'org owner retains full visibility without any seeded permission rows');

-- ── Cross-org: org B member sees only its own row, cannot insert into org A ─
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000005';
select is((select count(*)::int from public.maintenance_requests), 1,
  'other org sees only its own row, none of org A''s');
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
-- Requester's own visibility is (and always was) capped at their own rows —
-- unaffected by other_staff's request #3 (no read_all/manage), so this stays
-- at 2, not the org-wide 3.
select is((select count(*)::int from public.maintenance_requests), 2,
  'disabling the module does not hide existing history');

-- UPDATE module gate: the requester's own edit fails once the module is off.
select throws_ok(
  $$ update public.maintenance_requests set subject = 'Edited after module disabled'
      where organization_id = 'a0000000-0000-0000-0000-00000000000a' and request_number = 1 $$,
  '42501', null, 'requester edit fails once module is disabled');

-- ── Share links: real coverage (kills exploit-class 2 + secrecy) ────────────
-- Insert as service-role (no authenticated write policy exists at all — see
-- comment above the policy). Bound to org A's request 1.
set local role to postgres;
insert into public.maintenance_request_share_links
  (organization_id, maintenance_request_id, token, expires_at, created_by)
select organization_id, id, 'sharelinktoken1234567890', now() + interval '7 days', :mgr
  from public.maintenance_requests where organization_id = :org_a and request_number = 1;

-- Manager (holds manage) sees the link.
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000003';
set local role to 'authenticated';
select is((select count(*)::int from public.maintenance_request_share_links), 1,
  'manager sees the share link');

-- Plain staff (no manage) cannot enumerate it.
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.maintenance_request_share_links), 0,
  'non-manager staff cannot enumerate share links');

-- Other-org member cannot enumerate it either.
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000005';
select is((select count(*)::int from public.maintenance_request_share_links), 0,
  'other-org member cannot enumerate share links');

-- No authenticated principal — including an org-A manager — can INSERT a
-- share link at all (service-role only), so an org-P manager cannot bind one
-- to an org-V request either. Literal-id splice for the same reason noted
-- at the notes cross-org test above (attacker's session can't SELECT org
-- B's row; the write-policy boundary must still hold against a known id).
set local "request.jwt.claim.sub" to '10000000-0000-0000-0000-000000000003';
select throws_ok(
  format($$ insert into public.maintenance_request_share_links
       (organization_id, maintenance_request_id, token, expires_at, created_by)
     values ('a0000000-0000-0000-0000-00000000000a', %L, 'crossorgtokenabcdef123456',
             now() + interval '7 days', '10000000-0000-0000-0000-000000000003') $$,
    :'victim_id'),
  '42501', null, 'org-P manager cannot insert a share link bound to an org-V request');

-- notification_preferences carries the four maintenance columns.
select has_column('public', 'notification_preferences', 'push_maintenance_new_request', 'pref col 1');
select has_column('public', 'notification_preferences', 'push_maintenance_urgent_request', 'pref col 2');
select has_column('public', 'notification_preferences', 'push_maintenance_assigned', 'pref col 3');
select has_column('public', 'notification_preferences', 'push_maintenance_draft_reminder', 'pref col 4');

select * from finish();
rollback;
