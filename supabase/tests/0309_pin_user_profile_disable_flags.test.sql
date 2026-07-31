-- supabase/tests/0309_pin_user_profile_disable_flags.test.sql
-- Proves migration 0309, which now guards user_profiles on TWO axes:
--
--   * on an ACTIVE row, disabled_at / disabled_reason / disabled_by are
--     writable by the service role ONLY and silently revert for everybody else;
--   * on a DISABLED row, the ENTIRE update is dropped for everybody but the
--     service role — not just those three columns.
--
-- WHY THIS TEST EXISTS
--   0003's user_profiles_update_self grants an authenticated user UPDATE on
--   their own row with no column restriction, and 0308 put Layer A — the flag
--   every enforcement chokepoint reads — on that row. A disabled user's access
--   token stays signature-valid for up to ~1h after their sessions are revoked
--   (PostgREST and RLS never consult GoTrue), so without 0309 the subject of a
--   disable can PATCH disabled_at back to null inside that window and read as
--   active again.
--
--   The first cut of 0309 scoped its trigger with a WHEN clause naming those
--   three columns, which closed the un-disable attack and left the rest of the
--   row writable. That is not a private row: full_name and avatar_url are
--   embedded into every colleague's UI (team list, order timeline actor,
--   cycle-count assignee, movement actor, procedure author), so a user disabled
--   for suspected compromise could still deface their identity ORG-WIDE for the
--   rest of the token's life. Sections A and D below are the regression gate on
--   both halves, and the WHEN clause itself is asserted absent so it cannot come
--   back.
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

select plan(41);

\set u_self  '\'03090000-0000-0000-0000-0000000000a1\''
\set u_other '\'03090000-0000-0000-0000-0000000000a2\''
\set u_act   '\'03090000-0000-0000-0000-0000000000a3\''
\set actor   '\'03090000-0000-0000-0000-0000000000d1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_self,  'self@ad09.test',  '{"full_name":"Self Original"}'::jsonb),
  (:u_other, 'other@ad09.test', '{"full_name":"Other Original"}'::jsonb),
  (:u_act,   'act@ad09.test',   '{"full_name":"Active Original"}'::jsonb),
  (:actor,   'actor@ad09.test', '{}'::jsonb) on conflict (id) do nothing;

-- postgres is on the trigger's allowlist, so this seed passes through untouched.
update public.user_profiles set avatar_url = 'https://cdn.test/original.png'
 where id in (:u_self, :u_act);

-- ── 1. Structure ───────────────────────────────────────────────────────────
select has_function('public', 'tg_pin_user_profile_disable_flags', array[]::text[],
  'tg_pin_user_profile_disable_flags() exists');
select has_trigger('public', 'user_profiles', 'pin_user_profile_disable_flags',
  'pin_user_profile_disable_flags is installed on user_profiles');

-- The WHEN clause is the bug, so its ABSENCE is the fix and has to be pinned.
-- With one, the trigger never fires for full_name/avatar_url and a disabled user
-- keeps write access to the identity their whole org renders.
select ok(
  (select t.tgqual is null
     from pg_trigger t
    where t.tgrelid = 'public.user_profiles'::regclass
      and t.tgname  = 'pin_user_profile_disable_flags'),
  'the trigger has NO WHEN clause — it fires on every update, not only on the three disable columns'
);

-- ── A. ACTIVE row: only the three columns are pinned ───────────────────────
-- Run before any disable, as an ordinary signed-in user. If this section broke,
-- 0309 would have frozen profile editing for the whole product.
set local "request.jwt.claim.sub"  to '03090000-0000-0000-0000-0000000000a3';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- The realistic bypass: smuggle the flag into an ordinary profile save.
select lives_ok(
  $$update public.user_profiles
      set full_name = 'Active Renamed', disabled_at = '2026-07-31T00:00:00Z'::timestamptz
    where id = '03090000-0000-0000-0000-0000000000a3'$$,
  'ACTIVE row: a mixed profile-save + self-disable raises nothing'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_act),
  'Active Renamed',
  'ACTIVE row: the legitimate column in a mixed UPDATE APPLIED — profile editing is intact'
);
select is(
  (select disabled_at from public.user_profiles where id = :u_act),
  null::timestamptz,
  'ACTIVE row: the smuggled disabled_at in the SAME statement was reverted'
);

-- 0177 pins email; 0309 adds a SECOND before-update trigger to this table.
-- Triggers fire in name order (pin_user_profile_disable_flags before
-- pin_user_profile_email), and a trigger that returned NULL or a stale NEW could
-- swallow the other's work.
set local role to 'authenticated';
update public.user_profiles set email = 'attacker@ad09.test'
 where id = '03090000-0000-0000-0000-0000000000a3';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u_act),
  'act@ad09.test',
  '0177 email pin STILL holds against an authenticated self-update on an ACTIVE row'
);

set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles
      set full_name = 'Active Renamed Again', avatar_url = 'https://cdn.test/new.png'
    where id = '03090000-0000-0000-0000-0000000000a3'$$,
  'ACTIVE row: a plain profile edit still runs'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_act),
  'Active Renamed Again',
  'ACTIVE row: full_name is still updatable by its owner — 0309 did not over-pin the table'
);
select is(
  (select avatar_url from public.user_profiles where id = :u_act),
  'https://cdn.test/new.png',
  'ACTIVE row: avatar_url is still updatable by its owner'
);

-- ── B. The service role CAN stamp the disable ──────────────────────────────
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

-- ── C. The disabled user cannot undo it — each column on its own ───────────
-- Asserted one column at a time: a guard that pins only the column someone
-- thought of would still lose. disabled_reason and disabled_by are attribution
-- the operator relies on, so tampering with them is a real attack even though
-- disabled_at is the one that gates access.
set local "request.jwt.claim.sub" to '03090000-0000-0000-0000-0000000000a1';
set local role to 'authenticated';

-- Silent, not an exception: an error would name the guarded column and hand the
-- attacker a map. The statement must succeed and simply do nothing.
select lives_ok(
  $$update public.user_profiles set disabled_at = null
     where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'the disabled user clearing disabled_at raises NOTHING (silent, not an error)'
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

-- ── D. The defacement class: a DISABLED row is frozen ENTIRELY ─────────────
-- This is the section the WHEN clause used to let through. Reproduced live
-- before the fix: `update user_profiles set full_name='DEFACED'` as the disabled
-- subject returned UPDATE 1 and the name stuck, and every colleague's team list,
-- order timeline, cycle-count assignee and movement actor rendered it.
set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles
      set full_name = 'DEFACED', avatar_url = 'http://evil.test/x.png'
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'DISABLED row: the identity write raises nothing (silent, no error to probe with)'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_self),
  'Self Original',
  'DISABLED row: full_name was NOT defaced — the org-wide identity is frozen'
);
select is(
  (select avatar_url from public.user_profiles where id = :u_self),
  'https://cdn.test/original.png',
  'DISABLED row: avatar_url was NOT replaced'
);

-- A mixed statement must be dropped WHOLE, not partially applied.
set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles
      set full_name = 'Smuggled Save', disabled_at = null
    where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'DISABLED row: a mixed profile-save + disable-clear raises nothing'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_self),
  'Self Original',
  'DISABLED row: the legitimate-looking column was dropped too — the whole statement is refused'
);
select is(
  (select disabled_at from public.user_profiles where id = :u_self),
  '2026-07-31T00:00:00Z'::timestamptz,
  'DISABLED row: the smuggled disabled_at in the SAME statement was refused'
);

-- Values surviving could in principle mean "reverted after a write". This proves
-- there was no write at all: the trigger returns NULL, so the row is skipped and
-- RETURNING yields nothing.
set local role to 'authenticated';
with u as (
  update public.user_profiles set full_name = 'DEFACED AGAIN'
   where id = '03090000-0000-0000-0000-0000000000a1'
  returning 1
)
select is((select count(*) from u), 0::bigint,
  'DISABLED row: the UPDATE affected ZERO rows — nothing was written and then undone');
reset role;

-- ── E. service_role can still administer a DISABLED profile ────────────────
-- The freeze must not trap the platform console or support. If this failed, a
-- disabled account could never be corrected or cleaned up.
set local role to 'service_role';
select lives_ok(
  $$update public.user_profiles set full_name = 'Renamed By Support'
     where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'service_role can still edit a DISABLED user''s profile'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_self),
  'Renamed By Support',
  'the service-role edit of a disabled profile APPLIED — the freeze is request-role scoped'
);

-- ── F. 0177's email pin is still unconditional ─────────────────────────────
-- 0177 pins email for EVERY role, including the service role. 0309 must not have
-- relaxed that while carving out its own service-role exemption.
set local role to 'service_role';
update public.user_profiles set email = 'admin-set@ad09.test'
 where id = '03090000-0000-0000-0000-0000000000a1';
reset role;
select is(
  (select email::text from public.user_profiles where id = :u_self),
  'self@ad09.test',
  '0177 email pin is STILL unconditional — 0309''s carve-out did not leak into it'
);

-- ── G. Re-enable works, and lifts the freeze ───────────────────────────────
-- Setting the columns back to null is the re-enable path. A guard that only
-- allowed non-null writes would leave every disabled account permanently
-- disabled — and a freeze that outlived the disable would leave the restored
-- user unable to edit their own profile.
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

set local role to 'authenticated';
select lives_ok(
  $$update public.user_profiles set full_name = 'Back In Business'
     where id = '03090000-0000-0000-0000-0000000000a1'$$,
  'RE-ENABLED: the user can edit their own profile again'
);
reset role;
select is(
  (select full_name from public.user_profiles where id = :u_self),
  'Back In Business',
  'RE-ENABLED: the edit APPLIED — the freeze lifted with the disable'
);

-- ── H. Someone else's row is still wholly out of reach ─────────────────────
-- 0309 guards columns and rows-by-status; 0003's RLS guards row ownership. Both
-- must hold: the trigger must not have become the only thing standing between
-- users' profiles.
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
select is(
  (select full_name from public.user_profiles where id = :u_other),
  'Other Original',
  'the other user''s full_name is untouched too — RLS blocked the whole row'
);

select * from finish();
rollback;
