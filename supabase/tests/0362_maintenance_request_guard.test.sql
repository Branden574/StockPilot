-- supabase/tests/0362_maintenance_request_guard.test.sql
-- Proves migration 0362 (maintenance request guard).
--
-- PART 1 (1-3)   Structure: the guard fires before the numbering trigger,
--                is SECURITY INVOKER, and no API role deletes a request.
-- PART 2 (4-11)  INSERT: open, unassigned and unnumbered; the requester
--                snapshot comes from the caller's profile; references stay
--                in the org. The service's own insert shape passes.
-- PART 3 (12-33) UPDATE: each forgery the requester could PATCH before is
--                refused, and each service transition (edit, draft open,
--                cancel, assign, resolve, archive) still works for the actor
--                the service allows, with the database stamping who and when.
-- PART 4 (34-36) Review hardening: a request's submitted time is the
--                database's; the real service_role (email and reminder
--                stamps) is exempt.
--
-- Guards key on current_user, so writes run under `set local role
-- authenticated` with request.jwt.claim.sub. Run via `supabase test db` after
-- `supabase db reset`.

begin;
select plan(36);

\set orgA   '\'03620000-0000-0000-0000-00000000000a\''
\set orgB   '\'03620000-0000-0000-0000-00000000000b\''
\set u_req  '\'03620000-0000-0000-0000-0000000000a1\''
\set u_mgr  '\'03620000-0000-0000-0000-0000000000a2\''
\set u_oth  '\'03620000-0000-0000-0000-0000000000a3\''
\set u_out  '\'03620000-0000-0000-0000-0000000000b1\''
\set whA    '\'03620000-0000-0000-0000-0000000000c1\''
\set whB    '\'03620000-0000-0000-0000-0000000000c2\''
\set mr1    '\'03620000-0000-0000-0000-0000000000e1\''
\set mr2    '\'03620000-0000-0000-0000-0000000000e2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_req, 'req-0362@test.local', '{"full_name":"Rae Requester"}'::jsonb),
  (:u_mgr, 'mgr-0362@test.local', '{"full_name":"  Max Manager  "}'::jsonb),
  (:u_oth, 'oth-0362@test.local', '{}'::jsonb),
  (:u_out, 'out-0362@test.local', '{}'::jsonb)
on conflict (id) do nothing;
-- The profile trigger may or may not have copied full_name; set it explicitly.
update public.user_profiles set full_name = 'Rae Requester' where id = :u_req;
update public.user_profiles set full_name = '  Max Manager  ' where id = :u_mgr;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Maint Org A 0362', 'maint-org-a-0362'),
  (:orgB, 'Maint Org B 0362', 'maint-org-b-0362');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_req, 'staff',   now()),
  (:orgA, :u_mgr, 'manager', now()),
  (:orgA, :u_oth, 'staff',   now()),
  (:orgB, :u_out, 'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier) values
  (:orgA, 'maintenance_requests', true, 'optional')
on conflict (organization_id, module_id) do update set enabled = true;
-- The requester may submit; the manager holds manage.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :u_req, 'maintenance_requests:submit', true),
  (:orgA, :u_oth, 'maintenance_requests:submit', true),
  (:orgA, :u_mgr, 'maintenance_requests:manage', true)
on conflict do nothing;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'Maint WH A 0362', 'M0362A', 'active'),
  (:whB, :orgB, 'Maint WH B 0362', 'M0362B', 'active');

-- ═══ PART 1 ═════════════════════════════════════════════════════════════════
select ok(
  (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
    where t.tgrelid = 'public.maintenance_requests'::regclass and not t.tgisinternal
      and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4)   -- BEFORE, INSERT
  = array['trg_aa_maintenance_requests_guard', 'trg_assign_maintenance_request_number'],
  '1: the guard fires before the numbering trigger (it must see a caller-supplied number)');
select ok(
  not (select prosecdef from pg_proc where oid = 'public.tg_maintenance_requests_guard()'::regprocedure),
  '2: the guard is SECURITY INVOKER');
select ok(
  not has_table_privilege('authenticated', 'public.maintenance_requests', 'DELETE')
  and not has_table_privilege('anon', 'public.maintenance_requests', 'INSERT'),
  '3: no API role deletes a request; anon inserts none');

-- ═══ PART 2: INSERT ═════════════════════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_req;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  format($$insert into public.maintenance_requests (organization_id, requester_user_id, requester_name_snapshot,
             subject, description, priority, status, request_number)
           values (%L, %L, 'x', 'Broken heater', 'It is cold', 'normal', 'saved', 9223372036854775807)$$, :orgA, :u_req),
  '42501', 'Request numbers are assigned by the database.',
  '4: a caller-supplied request number is refused (the max+1 overflow DoS)');
select throws_ok(
  format($$insert into public.maintenance_requests (organization_id, requester_user_id, requester_name_snapshot,
             subject, description, priority, status, resolved_at, resolved_by, resolved_by_name_snapshot)
           values (%L, %L, 'x', 'Broken heater', 'It is cold', 'normal', 'resolved', now(), %L, 'Max Manager')$$, :orgA, :u_req, :u_mgr),
  '42501', 'A new maintenance request starts open and unassigned.',
  '5: a request cannot arrive already resolved');
select throws_ok(
  format($$insert into public.maintenance_requests (organization_id, requester_user_id, requester_name_snapshot,
             subject, description, priority, status, local_owner_user_id)
           values (%L, %L, 'x', 'Broken heater', 'It is cold', 'normal', 'saved', %L)$$, :orgA, :u_req, :u_mgr),
  '42501', 'A new maintenance request starts open and unassigned.',
  '6: nor assigned');
select throws_ok(
  format($$insert into public.maintenance_requests (organization_id, requester_user_id, requester_name_snapshot,
             subject, description, priority, status, warehouse_id)
           values (%L, %L, 'x', 'Broken heater', 'It is cold', 'normal', 'saved', %L)$$, :orgA, :u_req, :whB),
  '42501', 'A linked record is not part of this organization.',
  '7: nor linked to another org''s warehouse');

-- The service's own shape (plus a forged name the guard replaces).
select lives_ok(
  format($$insert into public.maintenance_requests (id, organization_id, requester_user_id, requester_name_snapshot,
             requester_email_snapshot, requester_phone_snapshot, subject, description, priority, warehouse_id, status)
           values (%L, %L, %L, 'The CEO', 'ceo@elsewhere.test', '555-0100', 'Broken heater', 'It is cold', 'high', %L, 'saved')$$,
         :mr1, :orgA, :u_req, :whA),
  '8: the service''s insert shape is accepted');
reset role;
select is((select request_number from public.maintenance_requests where id = :mr1), 1::bigint,
  '9: the database numbered it');
select is((select row(requester_name_snapshot, requester_email_snapshot, requester_phone_snapshot)::text
             from public.maintenance_requests where id = :mr1),
  row('Rae Requester', 'req-0362@test.local', '555-0100')::text,
  '10: the requester snapshot is the caller''s profile, not the request body (the phone is theirs to give)');
insert into public.maintenance_requests (id, organization_id, requester_user_id, requester_name_snapshot,
  subject, description, priority, status) values
  (:mr2, :orgA, :u_oth, 'Other Staff', 'Leaky tap', 'Drips all day', 'normal', 'saved');
select is((select request_number from public.maintenance_requests where id = :mr2), 2::bigint,
  '11: numbering continues (owner inserts are exempt and numbered by the trigger)');

-- ═══ PART 3: UPDATE ═════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_req;
set local role to 'authenticated';

select throws_ok(
  format($$update public.maintenance_requests set status = 'resolved', resolved_at = now(), resolved_by = %L,
             resolved_by_name_snapshot = 'Max Manager', resolution_note = 'Fixed' where id = %L$$, :u_mgr, :mr1),
  '42501', 'Only a maintenance manager can resolve a request.',
  '12: the requester cannot close out their own request (the forged resolution)');
select throws_ok(
  format($$update public.maintenance_requests set local_owner_user_id = %L where id = %L$$, :u_req, :mr1),
  '42501', 'Only a maintenance manager can assign a local owner.',
  '13: nor assign it');
select throws_ok(
  format($$update public.maintenance_requests set archived_at = now(), status = 'archived' where id = %L$$, :mr1),
  '42501', 'Only a maintenance manager can archive a request.',
  '14: nor archive it');
select throws_ok(
  format($$update public.maintenance_requests set request_number = 99 where id = %L$$, :mr1),
  '42501', 'That part of a maintenance request cannot be changed.',
  '15: nor renumber it');
select throws_ok(
  format($$update public.maintenance_requests set requester_name_snapshot = 'The CEO' where id = %L$$, :mr1),
  '42501', 'That part of a maintenance request cannot be changed.',
  '16: nor rewrite who asked');
select throws_ok(
  format($$update public.maintenance_requests set outlook_draft_open_count = 50 where id = %L$$, :mr1),
  '42501', 'Draft opens are counted one at a time.',
  '17: nor inflate the draft-open count');
select throws_ok(
  format($$update public.maintenance_requests set status = 'resolved' where id = %L$$, :mr1),
  '42501', 'That status change is not allowed.',
  '18: nor set a closed status without its record');
select throws_ok(
  format($$update public.maintenance_requests set warehouse_id = %L where id = %L$$, :whB, :mr1),
  '42501', 'A linked record is not part of this organization.',
  '19: nor re-link it to another org''s warehouse');

-- What the requester legitimately does.
select lives_ok(
  format($$update public.maintenance_requests set subject = 'Heater still broken', priority = 'urgent' where id = %L$$, :mr1),
  '20: the requester edits the content of their open request');
select lives_ok(
  format($$update public.maintenance_requests set outlook_draft_opened_at = now(), outlook_draft_open_count = 1,
             status = 'draft_opened' where id = %L$$, :mr1),
  '21: ... records opening the Outlook draft (saved -> draft_opened, count + 1)');
select throws_ok(
  format($$update public.maintenance_requests set outlook_draft_opened_at = now() - interval '1 day' where id = %L$$, :mr1),
  '42501', 'The first draft-open time is kept.',
  '22: ... but cannot move the first draft-open time');

set local "request.jwt.claim.sub" to :u_oth;
select lives_ok(
  format($$update public.maintenance_requests set cancelled_at = '2001-01-01', status = 'cancelled' where id = %L$$, :mr2),
  '23: the requester cancels their own request');
reset role;
select ok((select cancelled_at > now() - interval '1 minute' from public.maintenance_requests where id = :mr2),
  '24: ... and the database stamps when, not the caller');
-- RLS already hides a closed request from its requester's UPDATE; a manager's
-- policy arm has no closed-state filter, so the guard is what keeps it.
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$update public.maintenance_requests set cancelled_at = null, status = 'saved' where id = %L$$, :mr2),
  '42501', 'A resolved, cancelled or archived request keeps that record.',
  '25: a cancellation cannot be undone, even by a manager');

-- The manager's transitions.
set local "request.jwt.claim.sub" to :u_mgr;
select throws_ok(
  format($$update public.maintenance_requests set local_owner_user_id = %L where id = %L$$, :u_out, :mr1),
  '42501', 'That user is not an active member of this organization.',
  '26: a local owner must be a member of the org');
select lives_ok(
  format($$update public.maintenance_requests set local_owner_user_id = %L where id = %L$$, :u_oth, :mr1),
  '27: a manager assigns a member');
select lives_ok(
  format($$update public.maintenance_requests set status = 'resolved', resolved_at = '2001-01-01', resolved_by = %L,
             resolved_by_name_snapshot = 'Somebody Else', resolution_note = 'Replaced the thermostat' where id = %L$$, :u_oth, :mr1),
  '28: a manager resolves');
reset role;
select is((select row(resolved_by, resolved_by_name_snapshot, resolution_note, resolved_at > now() - interval '1 minute')::text
             from public.maintenance_requests where id = :mr1),
  row(:u_mgr::uuid, 'Max Manager', 'Replaced the thermostat', true)::text,
  '29: ... and the database records the caller as resolver, named from their profile, stamped now');
set local role to 'authenticated';
select throws_ok(
  format($$update public.maintenance_requests set resolution_note = 'Actually never fixed' where id = %L$$, :mr1),
  '42501', 'A resolved, cancelled or archived request keeps that record.',
  '30: a resolution is never rewritten');
select throws_ok(
  format($$update public.maintenance_requests set cancelled_at = now(), status = 'cancelled' where id = %L$$, :mr1),
  '42501', 'Only an open request can be cancelled.',
  '31: a resolved request cannot be cancelled');
select lives_ok(
  format($$update public.maintenance_requests set archived_at = now(), status = 'archived' where id = %L$$, :mr1),
  '32: a manager archives the resolved request');
reset role;
select is((select row(status, resolved_by)::text from public.maintenance_requests where id = :mr1),
  row('archived', :u_mgr::uuid)::text,
  '33: archiving kept the resolution record');

-- ═══ PART 4: review hardening ═══════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_req;
set local role to 'authenticated';
select lives_ok(
  format($$insert into public.maintenance_requests (id, organization_id, requester_user_id, requester_name_snapshot,
             subject, description, priority, status, created_at)
           values ('03620000-0000-0000-0000-0000000000e3', %L, %L, 'x', 'Backdated leak', 'Old news', 'normal', 'saved', '2001-01-01')$$,
         :orgA, :u_req),
  '34: a requester submits with a created_at of 2001');
reset role;
select ok(
  (select created_at > now() - interval '1 minute' from public.maintenance_requests
    where id = '03620000-0000-0000-0000-0000000000e3'),
  '35: ... and the database records it as submitted now (the MR-YYYY handle and the email read it)');
set local role to 'service_role';
select lives_ok(
  format($$update public.maintenance_requests set resolution_email_sent_at = now() where id = %L$$, :mr1),
  '36: the service_role stamps the resolution email (the guard exempts it)');
reset role;

select * from finish();
rollback;
