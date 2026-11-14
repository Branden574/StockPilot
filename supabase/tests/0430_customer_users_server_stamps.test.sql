-- supabase/tests/NNNN_customer_users_server_stamps.test.sql (NNNN = the
-- migration's number, given in ship order; nothing in this file reads it)
-- pgTAP proof that a portal user's invitation and acceptance times, and the
-- customer and account a customer_users row joins, are set by the server.
--
-- Personas: mgr, a manager of organization A; mgrB, a manager of
-- organization B; acct, acct2 and acct3, portal accounts (made-up).
-- Customers c1, c2, c3 and c4 belong to organization A.
--
-- I.  Insert by a manager: accepted_at is null and invited_at is now(),
--     whatever the statement names (I1-I4); the app's invite insert writes
--     what it wrote before (I5, I6).
-- U.  Update by a manager: a change of accepted_at (set, move, clear),
--     invited_at, user_id or customer_id is refused with 42501 and the row
--     keeps its values (U1-U9); an upsert that names accepted_at on a row
--     that is not accepted leaves it not accepted (U10).
-- K.  What stays the manager's: the app's re-invite upsert (K1, K2), an
--     email change (K3) and removing the row (K4).
-- R.  More shapes of the same writes: an update that names the four columns
--     with their own values goes through (R1, R2, pins); an upsert whose
--     update half names accepted_at or invited_at is refused (R3, R4) and the
--     row keeps its times (R5); a row deleted and inserted again comes back
--     invited now and not accepted (R6-R8); a multi-row insert leaves every
--     row invited now and not accepted (R9, R10); a manager of another
--     organization changes, removes and adds nothing on organization A's
--     rows (R11-R14, pins: the policy).
-- S.  The service role (the portal's own stamp and the platform) writes the
--     two times as before (S1a, S1, S2a, S2b, S2).
-- P.  Posture: one BEFORE INSERT OR UPDATE row trigger, SECURITY INVOKER,
--     EXECUTE for no API role (P1-P3).
-- I1-I4, U1-U10, K2, R3-R5, R8, R10 and P1 hold the trigger's rule. I5, I6,
-- K1, K3, K4, R1, R2, R11-R14 and S hold the paths that keep working.

begin;

select plan(47);

\set orga  '\'ab043000-0000-4000-8000-000000000001\''
\set orgb  '\'ab043000-0000-4000-8000-000000000002\''
\set mgr   '\'ab043000-0000-4000-8000-000000000011\''
\set mgrb  '\'ab043000-0000-4000-8000-000000000012\''
\set acct  '\'ab043000-0000-4000-8000-000000000021\''
\set acct2 '\'ab043000-0000-4000-8000-000000000022\''
\set acct3 '\'ab043000-0000-4000-8000-000000000023\''
\set c1    '\'ab043000-0000-4000-8000-0000000000c1\''
\set c2    '\'ab043000-0000-4000-8000-0000000000c2\''
\set c3    '\'ab043000-0000-4000-8000-0000000000c3\''
\set c4    '\'ab043000-0000-4000-8000-0000000000c4\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,   'stamps-mgr@test.local',   '{}'::jsonb),
  (:mgrb,  'stamps-mgr-b@test.local', '{}'::jsonb),
  (:acct,  'stamps-buyer@test.local', '{}'::jsonb),
  (:acct2, 'stamps-buyer2@test.local', '{}'::jsonb),
  (:acct3, 'stamps-buyer3@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orga, 'Stamps Org A', 'stamps-a-test'),
  (:orgb, 'Stamps Org B', 'stamps-b-test')
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orga, :mgr, 'manager', now()),
  (:orgb, :mgrb, 'manager', now())
  on conflict do nothing;
insert into public.customers (id, organization_id, name) values
  (:c1, :orga, 'Harbor Elementary'),
  (:c2, :orga, 'Ridge Middle'),
  (:c3, :orga, 'Lakeside High'),
  (:c4, :orga, 'Valley Primary')
  on conflict (id) do nothing;

-- A row accepted long ago, written as the platform would (postgres here).
insert into public.customer_users (customer_id, user_id, email, invited_at, accepted_at) values
  (:c2, :acct, 'stamps-buyer@test.local', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');

-- ═══ I. Insert by a manager ═══════════════════════════════════════════════
set local "request.jwt.claim.sub" to 'ab043000-0000-4000-8000-000000000011';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_by, invited_at, accepted_at)
       values ('ab043000-0000-4000-8000-0000000000c1', 'ab043000-0000-4000-8000-000000000021',
               'stamps-buyer@test.local', 'ab043000-0000-4000-8000-000000000011',
               '2099-01-01T00:00:00Z', '2020-01-01T00:00:00Z') $$,
  'I0: a manager''s insert that names both times goes through');
reset role;
select is(
  (select accepted_at from public.customer_users
    where customer_id = :c1 and user_id = :acct),
  null::timestamptz,
  'I1: the inserted row is not accepted, though the statement named a time');
select is(
  (select invited_at from public.customer_users
    where customer_id = :c1 and user_id = :acct),
  now(),
  'I2: the inserted row is invited now, not at the time the statement named');

set local role to 'authenticated';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, accepted_at)
       values ('ab043000-0000-4000-8000-0000000000c2', 'ab043000-0000-4000-8000-000000000022',
               'stamps-buyer2@test.local', now()) $$,
  'I3a: an insert naming only accepted_at goes through');
reset role;
select ok(
  (select accepted_at is null and invited_at = now() from public.customer_users
    where customer_id = :c2 and user_id = :acct2),
  'I3: ... and the row is not accepted and invited now');

set local role to 'authenticated';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_at)
       values ('ab043000-0000-4000-8000-0000000000c1', 'ab043000-0000-4000-8000-000000000023',
               'stamps-buyer3@test.local', '2000-01-01T00:00:00Z') $$,
  'I4a: an insert naming only invited_at goes through');
reset role;
select is(
  (select invited_at from public.customer_users
    where customer_id = :c1 and user_id = :acct3),
  now(),
  'I4: ... and the row is invited now');

-- The app's invite (CustomersService.inviteUser): four columns, upserted.
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_by)
       values ('ab043000-0000-4000-8000-0000000000c1', 'ab043000-0000-4000-8000-000000000022',
               'stamps-buyer2@test.local', 'ab043000-0000-4000-8000-000000000011')
     on conflict (customer_id, user_id) do update
       set customer_id = excluded.customer_id, user_id = excluded.user_id,
           email = excluded.email, invited_by = excluded.invited_by $$,
  'I5: the app''s invite inserts a new portal user');
reset role;
select ok(
  (select accepted_at is null and invited_at = now() and invited_by = :mgr
     from public.customer_users where customer_id = :c1 and user_id = :acct2),
  'I6: ... invited now, by the manager, not accepted');

-- ═══ U. Update by a manager ═══════════════════════════════════════════════
set local role to 'authenticated';
select throws_ok(
  $$ update public.customer_users set accepted_at = now()
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  '42501', 'A portal user''s invitation and acceptance are recorded by StockPilot.',
  'U1: a manager cannot mark a portal user accepted');
select throws_ok(
  $$ update public.customer_users set accepted_at = '2020-01-01T00:00:00Z'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  '42501', null,
  'U2: a manager cannot move an accepted row''s acceptance earlier');
select throws_ok(
  $$ update public.customer_users set accepted_at = null
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  '42501', null,
  'U3: a manager cannot clear an acceptance');
select throws_ok(
  $$ update public.customer_users set invited_at = '2099-01-01T00:00:00Z'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  '42501', null,
  'U4: a manager cannot choose an invitation time');
select throws_ok(
  $$ update public.customer_users set user_id = 'ab043000-0000-4000-8000-000000000023'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  '42501', null,
  'U5: a manager cannot move a row to another account');
select throws_ok(
  $$ update public.customer_users set customer_id = 'ab043000-0000-4000-8000-0000000000c3'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000022' $$,
  '42501', null,
  'U6: a manager cannot move a row to another customer');
select throws_ok(
  $$ update public.customer_users set email = 'stamps-new@test.local', accepted_at = now()
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  '42501', null,
  'U7: an update that also changes the email is refused whole when it names accepted_at');
reset role;
select ok(
  (select accepted_at is null and invited_at = now() and email = 'stamps-buyer@test.local'
     from public.customer_users where customer_id = :c1 and user_id = :acct),
  'U8: the refused updates left the invited row as it was');
select ok(
  (select accepted_at = '2026-01-02T00:00:00Z'::timestamptz
      and invited_at = '2026-01-01T00:00:00Z'::timestamptz
     from public.customer_users where customer_id = :c2 and user_id = :acct),
  'U9: the refused updates left the accepted row as it was');

set local role to 'authenticated';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, accepted_at)
       values ('ab043000-0000-4000-8000-0000000000c1', 'ab043000-0000-4000-8000-000000000021',
               'stamps-buyer@test.local', now())
     on conflict (customer_id, user_id) do update set accepted_at = excluded.accepted_at $$,
  'U10a: an upsert naming accepted_at on a row that is not accepted goes through');
reset role;
select is(
  (select accepted_at from public.customer_users
    where customer_id = :c1 and user_id = :acct),
  null::timestamptz,
  'U10: ... and the row is still not accepted');

-- ═══ K. What stays the manager's ══════════════════════════════════════════
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_by)
       values ('ab043000-0000-4000-8000-0000000000c2', 'ab043000-0000-4000-8000-000000000021',
               'stamps-buyer@test.local', 'ab043000-0000-4000-8000-000000000011')
     on conflict (customer_id, user_id) do update
       set customer_id = excluded.customer_id, user_id = excluded.user_id,
           email = excluded.email, invited_by = excluded.invited_by $$,
  'K1: the app''s re-invite of an accepted portal user goes through');
reset role;
select ok(
  (select accepted_at = '2026-01-02T00:00:00Z'::timestamptz
      and invited_at = '2026-01-01T00:00:00Z'::timestamptz
      and invited_by = :mgr
     from public.customer_users where customer_id = :c2 and user_id = :acct),
  'K2: ... and keeps both times, with the manager as the inviter');

set local role to 'authenticated';
select lives_ok(
  $$ update public.customer_users set email = 'stamps-renamed@test.local'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000023' $$,
  'K3: a manager still changes a portal user''s email');
select lives_ok(
  $$ delete from public.customer_users
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000023' $$,
  'K4a: a manager still removes a portal user');
reset role;
select is(
  (select count(*)::int from public.customer_users where customer_id = :c1 and user_id = :acct3),
  0, 'K4: ... and the row is gone');

-- ═══ R. More shapes of the same writes ════════════════════════════════════
-- The rows as they stand now; the pins compare against this, not against
-- values an earlier line could have moved.
create temp table r_before on commit drop as
  select customer_id, user_id, email, invited_by, invited_at, accepted_at
    from public.customer_users;
set local role to 'authenticated';
select lives_ok(
  $$ update public.customer_users
        set accepted_at = accepted_at, invited_at = invited_at,
            user_id = user_id, customer_id = customer_id
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  'R1: an update naming the four columns with their own values goes through');
reset role;
select ok(
  (select (r.customer_id, r.user_id, r.email, r.invited_by, r.invited_at, r.accepted_at)
          is not distinct from
          (b.customer_id, b.user_id, b.email, b.invited_by, b.invited_at, b.accepted_at)
     from public.customer_users r
     join r_before b using (customer_id, user_id)
    where r.customer_id = :c2 and r.user_id = :acct),
  'R2: ... and changes nothing');

set local role to 'authenticated';
select throws_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, accepted_at)
       values ('ab043000-0000-4000-8000-0000000000c2', 'ab043000-0000-4000-8000-000000000021',
               'stamps-buyer@test.local', now())
     on conflict (customer_id, user_id) do update set accepted_at = excluded.accepted_at $$,
  '42501', null,
  'R3: an upsert whose update half names accepted_at on an accepted row is refused');
select throws_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_at)
       values ('ab043000-0000-4000-8000-0000000000c2', 'ab043000-0000-4000-8000-000000000021',
               'stamps-buyer@test.local', '2099-01-01T00:00:00Z')
     on conflict (customer_id, user_id) do update set invited_at = excluded.invited_at $$,
  '42501', null,
  'R4: an upsert whose update half names invited_at is refused');
reset role;
select ok(
  (select accepted_at = '2026-01-02T00:00:00Z'::timestamptz
      and invited_at = '2026-01-01T00:00:00Z'::timestamptz
     from public.customer_users where customer_id = :c2 and user_id = :acct),
  'R5: the refused upserts left the accepted row''s times as they were');

set local role to 'authenticated';
select lives_ok(
  $$ delete from public.customer_users
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000022' $$,
  'R6: a manager removes a portal user');
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_at, accepted_at)
       values ('ab043000-0000-4000-8000-0000000000c2', 'ab043000-0000-4000-8000-000000000022',
               'stamps-buyer2@test.local', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z') $$,
  'R7: ... and inserts the same mapping again, naming past times');
reset role;
select ok(
  (select accepted_at is null and invited_at = now() from public.customer_users
    where customer_id = :c2 and user_id = :acct2),
  'R8: ... and it comes back invited now and not accepted');

set local role to 'authenticated';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_at, accepted_at) values
       ('ab043000-0000-4000-8000-0000000000c4', 'ab043000-0000-4000-8000-000000000021',
        'stamps-buyer@test.local', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'),
       ('ab043000-0000-4000-8000-0000000000c4', 'ab043000-0000-4000-8000-000000000022',
        'stamps-buyer2@test.local', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'),
       ('ab043000-0000-4000-8000-0000000000c4', 'ab043000-0000-4000-8000-000000000023',
        'stamps-buyer3@test.local', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z') $$,
  'R9: a multi-row insert naming both times goes through');
reset role;
select is(
  (select count(*)::int from public.customer_users
    where customer_id = :c4 and accepted_at is null and invited_at = now()),
  3, 'R10: ... and every row is invited now and not accepted');

-- A manager of organization B, on organization A's rows (the policy).
set local "request.jwt.claim.sub" to 'ab043000-0000-4000-8000-000000000012';
set local role to 'authenticated';
select lives_ok(
  $$ update public.customer_users set email = 'stamps-elsewhere@test.local'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  'R11: another organization''s manager''s update reaches no row');
select lives_ok(
  $$ delete from public.customer_users
      where customer_id = 'ab043000-0000-4000-8000-0000000000c2'
        and user_id = 'ab043000-0000-4000-8000-000000000021' $$,
  'R12: another organization''s manager''s delete reaches no row');
select throws_ok(
  $$ insert into public.customer_users (customer_id, user_id, email)
       values ('ab043000-0000-4000-8000-0000000000c3', 'ab043000-0000-4000-8000-000000000023',
               'stamps-buyer3@test.local') $$,
  '42501', null,
  'R13: another organization''s manager cannot add a portal user to organization A''s customer');
reset role;
select ok(
  (select count(*) = 1 and bool_and(email = 'stamps-buyer@test.local')
     from public.customer_users where customer_id = :c2 and user_id = :acct)
  and not exists (select 1 from public.customer_users
                   where customer_id = :c3 and user_id = :acct3),
  'R14: ... organization A''s row is still there with its email, and nothing was added');
set local "request.jwt.claim.sub" to 'ab043000-0000-4000-8000-000000000011';

-- ═══ S. The service role ══════════════════════════════════════════════════
set local role to 'service_role';
-- The portal's stamp (resolvePortalContext), as it is written.
select lives_ok(
  $$ update public.customer_users set accepted_at = now()
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000021'
        and accepted_at is null $$,
  'S1a: the service role stamps an acceptance');
reset role;
select is(
  (select accepted_at from public.customer_users where customer_id = :c1 and user_id = :acct),
  now(), 'S1: ... and the row is accepted');
set local role to 'service_role';
select lives_ok(
  $$ insert into public.customer_users (customer_id, user_id, email, invited_at, accepted_at)
       values ('ab043000-0000-4000-8000-0000000000c1', 'ab043000-0000-4000-8000-000000000023',
               'stamps-buyer3@test.local', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z') $$,
  'S2a: the service role inserts a row with both times');
select lives_ok(
  $$ update public.customer_users set invited_at = '2026-02-01T00:00:00Z'
      where customer_id = 'ab043000-0000-4000-8000-0000000000c1'
        and user_id = 'ab043000-0000-4000-8000-000000000023' $$,
  'S2b: the service role changes an invitation time');
reset role;
select ok(
  (select accepted_at = '2026-03-02T00:00:00Z'::timestamptz
      and invited_at = '2026-02-01T00:00:00Z'::timestamptz
     from public.customer_users where customer_id = :c1 and user_id = :acct3),
  'S2: ... and the row holds the times it named');

-- ═══ P. Posture ═══════════════════════════════════════════════════════════
select ok(
  (select t.tgenabled = 'O'
      and (t.tgtype & 1) = 1      -- ROW
      and (t.tgtype & 2) = 2      -- BEFORE
      and (t.tgtype & 4) = 4      -- INSERT
      and (t.tgtype & 16) = 16    -- UPDATE
      and (t.tgtype & 8) = 0      -- not DELETE
     from pg_trigger t
    where t.tgrelid = 'public.customer_users'::regclass
      and t.tgname = 'trg_customer_users_server_stamps'),
  'P1: one BEFORE INSERT OR UPDATE row trigger on customer_users, enabled');
select ok(
  (select not p.prosecdef from pg_proc p
    where p.oid = 'public.tg_customer_users_server_stamps()'::regprocedure),
  'P2: the trigger function is SECURITY INVOKER, so current_user is the writer');
select ok(
  not has_function_privilege('anon', 'public.tg_customer_users_server_stamps()', 'execute')
  and not has_function_privilege('authenticated', 'public.tg_customer_users_server_stamps()', 'execute')
  and not has_function_privilege('service_role', 'public.tg_customer_users_server_stamps()', 'execute'),
  'P3: no API role may call the trigger function');

select * from finish();
rollback;
