-- supabase/tests/0345_verified_email_change.test.sql
-- Proves migration 0345: user_profiles.email is a projection of the auth
-- identity that (a) follows auth.users.email transactionally, (b) can be
-- written by nobody — service_role included — to any value OTHER than the
-- verified auth email, and (c) a pending GoTrue email change can be cancelled
-- by service_role only.
--
-- WHY THIS TEST EXISTS
--   0177 froze the column so a member could not rewrite their profile email to
--   a platform-admin allowlisted address. That defence must survive: section A
--   re-asserts it for authenticated AND for service_role. The new capability is
--   narrow — the ONLY writable value is the exact auth identity — and section C
--   is the guarantee every account-directed email in the product now rests on:
--   the weekly digest, schedule reminders and admin password resets all read
--   user_profiles.email, so this trigger is what stops them mailing an
--   abandoned address after a change.
--
-- HOW THE ROLES ARE SIMULATED
--   Same convention as 0309/0310: `set local role` plus request.jwt.claim.sub so
--   auth.uid() resolves for RLS. postgres (the test connection) stands in for
--   GoTrue when writing auth.users.email — GoTrue's own UPDATE fires the same
--   row trigger.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(25);

\set u1 '\'03450000-0000-0000-0000-0000000000a1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u1, 'alpha@ec45.test', '{"full_name":"Alpha Tester"}'::jsonb)
  on conflict (id) do nothing;

-- ── Structure ──────────────────────────────────────────────────────────────
select has_trigger('auth', 'users', 'on_auth_user_email_updated',
  'auth.users carries the AFTER UPDATE OF email sync trigger');
select has_function('public', 'tg_sync_profile_email_from_auth', array[]::text[],
  'tg_sync_profile_email_from_auth() exists');
select has_function('public', 'cancel_pending_email_change', array['uuid'],
  'cancel_pending_email_change(uuid) exists');
select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'tg_pin_user_profile_email'),
  true,
  'the pin is SECURITY DEFINER so it can read auth.users to decide'
);
select function_privs_are('public', 'cancel_pending_email_change', array['uuid'], 'anon',
  array[]::text[], 'anon cannot execute cancel_pending_email_change');
select function_privs_are('public', 'cancel_pending_email_change', array['uuid'], 'authenticated',
  array[]::text[], 'authenticated cannot execute cancel_pending_email_change');
select function_privs_are('public', 'cancel_pending_email_change', array['uuid'], 'service_role',
  array['EXECUTE'], 'service_role can execute cancel_pending_email_change');
select function_privs_are('public', 'tg_sync_profile_email_from_auth', array[]::text[], 'authenticated',
  array[]::text[], 'authenticated holds no EXECUTE on the sync trigger function (0329 posture)');

-- ── A. The 0177 defence is intact ──────────────────────────────────────────
set local "request.jwt.claim.sub" to '03450000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.user_profiles set email = 'attacker@ec45.test'
 where id = '03450000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u1),
  'alpha@ec45.test',
  'A1. authenticated self-update to an arbitrary address is still reverted'
);

set local role to 'service_role';
update public.user_profiles set email = 'someone-else@ec45.test'
 where id = '03450000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u1),
  'alpha@ec45.test',
  'A2. even service_role cannot write an address that is not the auth identity'
);

-- ── B. A write that IS the auth identity is accepted (self-heal path) ──────
set local role to 'service_role';
update public.user_profiles set email = 'ALPHA@EC45.TEST'
 where id = '03450000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u1),
  'alpha@ec45.test',
  'B1. a case-variant of the auth identity is accepted and stored in the auth spelling'
);

-- ── C. GoTrue changes the auth email → projection + audit, same transaction ─
update auth.users set email = 'beta@ec45.test' where id = :u1;
select is(
  (select email::text from public.user_profiles where id = :u1),
  'beta@ec45.test',
  'C1. auth.users.email change propagates to user_profiles.email'
);
select is(
  (select count(*)::int from public.audit_logs where user_id = :u1 and event = 'user.email.changed'),
  1,
  'C2. exactly one user.email.changed audit row'
);
select is(
  (select metadata->>'before' from public.audit_logs where user_id = :u1 and event = 'user.email.changed'),
  'alpha@ec45.test',
  'C3. audit row records the previous address'
);
select is(
  (select metadata->>'after' from public.audit_logs where user_id = :u1 and event = 'user.email.changed'),
  'beta@ec45.test',
  'C4. audit row records the new address'
);

-- Idempotent: writing the same value again is not a change.
update auth.users set email = 'beta@ec45.test' where id = :u1;
select is(
  (select count(*)::int from public.audit_logs where user_id = :u1 and event = 'user.email.changed'),
  1,
  'C5. a no-op auth update writes no second audit row'
);

-- After the change the OLD address is no longer writable into the projection.
set local role to 'service_role';
update public.user_profiles set email = 'alpha@ec45.test'
 where id = '03450000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u1),
  'beta@ec45.test',
  'C6. the abandoned address cannot be written back into the projection'
);

-- ── D. cancel_pending_email_change ────────────────────────────────────────
update auth.users
   set email_change = 'gamma@ec45.test',
       email_change_token_current = 'tok-current',
       email_change_token_new = 'tok-new',
       email_change_sent_at = now(),
       email_change_confirm_status = 1
 where id = :u1;

set local role to 'service_role';
select is(
  (select public.cancel_pending_email_change('03450000-0000-0000-0000-0000000000a1'::uuid)),
  true,
  'D1. cancel returns true when a change was pending'
);
reset role;
select is((select coalesce(email_change, '') from auth.users where id = :u1), '',
  'D2. pending target cleared');
select is((select coalesce(email_change_token_current, '') from auth.users where id = :u1), '',
  'D3. current-side token cleared');
select is((select coalesce(email_change_token_new, '') from auth.users where id = :u1), '',
  'D4. new-side token cleared');
select is((select email_change_confirm_status::int from auth.users where id = :u1), 0,
  'D5. confirm status reset');
select is((select email::text from auth.users where id = :u1), 'beta@ec45.test',
  'D6. cancel never touches the live sign-in email');

set local role to 'service_role';
select is(
  (select public.cancel_pending_email_change('03450000-0000-0000-0000-0000000000a1'::uuid)),
  false,
  'D7. cancel is idempotent: nothing pending → false, no error'
);
reset role;

-- Asserted through the catalog, not by executing: on 2026-08-25 a
-- throws_ok() of this call under `set local role authenticated` segfaulted
-- the local Postgres 17 backend (signal 11) and took the rest of the suite
-- down with it. The privilege bit IS the guarantee — PostgREST refuses the
-- RPC before any code runs — and function_privs_are above already pins it;
-- this is the same fact from the other side of the catalog.
select is(
  has_function_privilege('authenticated', 'public.cancel_pending_email_change(uuid)', 'EXECUTE'),
  false,
  'D8. an authenticated user holds no EXECUTE on cancel_pending_email_change'
);

select * from finish();
rollback;
