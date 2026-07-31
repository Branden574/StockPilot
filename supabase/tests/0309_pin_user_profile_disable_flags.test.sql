-- supabase/tests/0309_pin_user_profile_disable_flags.test.sql
-- Proves migration 0309: user_profiles.disabled_at / _reason / _by are writable
-- by the service role ONLY, and silently revert for everybody else.
--
-- WHY THIS TEST EXISTS
--   0003's user_profiles_update_self grants an authenticated user UPDATE on
--   their own row with no column restriction, and 0308 put Layer A — the flag
--   every enforcement chokepoint reads — on that row. A disabled user's access
--   token stays signature-valid for up to ~1h after their sessions are revoked
--   (PostgREST and RLS never consult GoTrue), so without 0309 the subject of a
--   disable can PATCH disabled_at back to null inside that window and read as
--   active again. This file is the regression gate on that.
--
-- HOW THE ROLES ARE SIMULATED
--   `supabase test db` connects as postgres, which is ALLOWED to write these
--   columns (migrations, operator SQL, and 0308's own pgTAP all need to be) — so
--   a bare UPDATE here would prove nothing. Every assertion below therefore runs
--   under an explicit `set local role`: 'service_role' for the legitimate writer
--   and 'authenticated' (plus request.jwt.claim.sub, so auth.uid() resolves for
--   RLS) for the attacker. That is the same role-switch convention 0229 and 0279
--   use, and it exercises the real Postgres role PostgREST switches into.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;

select plan(28);

\set u_self  '\'03090000-0000-0000-0000-0000000000a1\''
\set u_other '\'03090000-0000-0000-0000-0000000000a2\''
\set actor   '\'03090000-0000-0000-0000-0000000000d1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_self,  'self@ad09.test',  '{"full_name":"Self Original"}'::jsonb),
  (:u_other, 'other@ad09.test', '{"full_name":"Other Original"}'::jsonb),
  (:actor,   'actor@ad09.test', '{}'::jsonb) on conflict (id) do nothing;

-- ── 1. Structure ───────────────────────────────────────────────────────────
select has_function('public', 'tg_pin_user_profile_disable_flags', array[]::text[],
  'tg_pin_user_profile_disable_flags() exists');
select has_trigger('public', 'user_profiles', 'pin_user_profile_disable_flags',
  'pin_user_profile_disable_flags is installed on user_profiles');

-- ── 2. The service role CAN stamp the disable ──────────────────────────────
-- If this reverted too, the guard would have broken the feature it protects:
-- the disable/re-enable service writes these columns through createAdminClient.
set local role to 'service_role';
select lives_ok(
  $$update public.user_profiles
      set disabled_at = '2026-07-31T00:00:00Z'::timestamptz,
          disabled_reason = 'policy_violation',
          disabled_by = '03090000-0000-0000-0000-0000000000d1'
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'service_role can stamp the disable'
);
reset role;

select is(
  (select disabled_at from public.user_profiles where id = :u_self),
  '2026-07-31T00:00:00Z'::timestamptz,
  'service_role write of disabled_at STUCK'
);
select is(
  (select disabled_reason from public.user_profiles where id = :u_self),
  'policy_violation',
  'service_role write of disabled_reason STUCK'
);
select is(
  (select disabled_by from public.user_profiles where id = :u_self),
  :actor::uuid,
  'service_role write of disabled_by STUCK'
);

-- ── 3. The disabled user cannot undo it — each column on its own ───────────
-- Asserted one column at a time: a guard that pins only the column someone
-- thought of would still lose. disabled_reason and disabled_by are attribution
-- the operator relies on, so tampering with them is a real attack even though
-- disabled_at is the one that gates access.
set local "request.jwt.claim.sub" to '03090000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- Silent revert, not an exception: an error would name the guarded column and
-- hand the attacker a map. The statement must succeed and simply do nothing.
select lives_ok(
  $$update public.user_profiles set disabled_at = null
     where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'the disabled user clearing disabled_at raises NOTHING (silent revert, not an error)'
);
reset role;
select is(
  (select disabled_at from public.user_profiles where id = :u_self),
  '2026-07-31T00:00:00Z'::timestamptz,
  'disabled_at SURVIVED the self-clear — the account is still disabled'
);

set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles set disabled_reason = 'nothing to see here'
     where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'the disabled user rewriting disabled_reason raises nothing'
);
reset role;
select is(
  (select disabled_reason from public.user_profiles where id = :u_self),
  'policy_violation',
  'disabled_reason SURVIVED — the operator''s reason cannot be laundered'
);

set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles
      set disabled_by = '03090000-0000-0000-0000-0000000000a1'
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'the disabled user reassigning disabled_by raises nothing'
);
reset role;
select is(
  (select disabled_by from public.user_profiles where id = :u_self),
  :actor::uuid,
  'disabled_by SURVIVED — attribution still points at the admin'
);

-- All three at once, which is what the actual PATCH would send.
set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles
      set disabled_at = null, disabled_reason = null, disabled_by = null
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'clearing all three in one statement raises nothing'
);
reset role;
select ok(
  (select disabled_at is not null
          and disabled_reason = 'policy_violation'
          and disabled_by = :actor::uuid
     from public.user_profiles where id = :u_self),
  'all three SURVIVED the combined clear'
);

-- ── 4. A mixed UPDATE: the legitimate column lands, the guarded one reverts ─
-- The realistic bypass is to smuggle the flag into an ordinary profile save.
-- Reverting the whole statement would break profile editing; letting it through
-- would defeat the guard. Only the guarded columns may be rolled back.
set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles
      set full_name = 'Smuggled Save', disabled_at = null
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'a mixed profile-save + disable-clear raises nothing'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_self),
  'Smuggled Save',
  'the legitimate column in a mixed UPDATE still APPLIED — profile editing is intact'
);
select is(
  (select disabled_at from public.user_profiles where id = :u_self),
  '2026-07-31T00:00:00Z'::timestamptz,
  'the smuggled disabled_at in the SAME statement was reverted'
);

-- ── 5. Ordinary profile editing is untouched ───────────────────────────────
set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles set full_name = 'Self Renamed'
     where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'a plain profile edit still runs'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_self),
  'Self Renamed',
  'full_name is still updatable by its owner — 0309 did not over-pin the table'
);

-- ── 6. Regression: 0177's email pin still holds ────────────────────────────
-- 0309 adds a SECOND before-update trigger to this table. Triggers fire in name
-- order (pin_user_profile_disable_flags before pin_user_profile_email), and a
-- trigger that returned NULL or a stale NEW could swallow the other's work.
set local role to 'authenticated';
update public.user_profiles set email = 'attacker@ad09.test'
 where id = '03090000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u_self),
  'self@ad09.test',
  '0177 email pin STILL holds against an authenticated self-update'
);

-- 0177 pins email unconditionally — including for the service role. 0309 must
-- not have relaxed that while carving out its own service-role exemption.
set local role to 'service_role';
update public.user_profiles set email = 'admin-set@ad09.test'
 where id = '03090000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u_self),
  'self@ad09.test',
  '0177 email pin is STILL unconditional — 0309''s carve-out did not leak into it'
);

-- ── 7. Re-enable works, as service role ────────────────────────────────────
-- Setting the columns back to null is the re-enable path. A guard that only
-- allowed non-null writes would leave every disabled account permanently
-- disabled.
set local role to 'service_role';
select lives_ok(
  $$update public.user_profiles
      set disabled_at = null, disabled_reason = null, disabled_by = null
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'service_role can re-enable the account'
);
reset role;
select is(
  (select disabled_at from public.user_profiles where id = :u_self),
  null::timestamptz,
  're-enable cleared disabled_at — the account reads ACTIVE again'
);
select is(
  (select disabled_reason from public.user_profiles where id = :u_self),
  null::text,
  're-enable cleared disabled_reason'
);
select is(
  (select disabled_by from public.user_profiles where id = :u_self),
  null::uuid,
  're-enable cleared disabled_by'
);

-- ── 8. Someone else's row is still wholly out of reach ─────────────────────
-- 0309 guards columns; 0003's RLS guards rows. Both must hold: the trigger must
-- not have become the only thing standing between users' profiles.
set local role to 'service_role';
update public.user_profiles
   set disabled_at = '2026-07-31T00:00:00Z'::timestamptz
 where id = '03090000-0000-0000-0000-0000000000a2';
reset role;

set local role to 'authenticated';  -- still request.jwt.claim.sub = u_self
select lives_ok(
  $$update public.user_profiles
      set disabled_at = null, full_name = 'Hijacked'
    where id = '03090000-0000-0000-0000-0000000000a2'$$,
  'updating ANOTHER user''s row raises nothing (RLS matches zero rows)'
);
reset role;
select is(
  (select disabled_at from public.user_profiles where id = :u_other),
  '2026-07-31T00:00:00Z'::timestamptz,
  'the other user''s disabled_at is untouched'
);
-- full_name is NOT guarded by 0309, so its survival proves RLS matched zero rows
-- rather than the trigger quietly cleaning up after a row that was reachable.
select is(
  (select full_name from public.user_profiles where id = :u_other),
  'Other Original',
  'the other user''s UNGUARDED column is untouched too — RLS blocked the whole row'
);

select * from finish();
rollback;
