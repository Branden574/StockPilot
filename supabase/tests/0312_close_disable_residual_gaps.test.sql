-- supabase/tests/0312_close_disable_residual_gaps.test.sql
-- Proves migration 0312 closes both residual gaps in the account-disable
-- program that 0308-0311 left open:
--
--   1. The three `user-avatars` WRITE policies on storage.objects
--      ("user-avatars own write/update/delete") now AND a disabled-subject
--      guard onto the original folder-ownership predicate, rather than
--      replacing it — recurring bug #24 (`alter policy ... with check`
--      REPLACES) means the ORIGINAL predicate must still be present, not just
--      the new one. Asserted as text on pg_policies, the repo's idiom for
--      storage.objects (see 0026_avatar_logo_buckets.test.sql) since these
--      policies cannot be exercised end-to-end without the storage extension.
--      The read policy ("user-avatars authenticated read") is asserted
--      UNCHANGED — this migration must not touch it.
--
--   2. user_can_access_inventory(uuid,uuid,uuid,text) and
--      user_can_access_warehouse(uuid,uuid,text) no longer hold EXECUTE for
--      PUBLIC or anon (closing the unauthenticated per-uuid disable oracle),
--      while authenticated and service_role are unaffected — asserted via
--      has_function_privilege/aclexplode, per 0310's own test file, which
--      documents (and this file does not repeat the risk of) an ACTUAL denied
--      call under `set local role` SEGFAULTING the local Supabase CLI image.
--      Positive lives_ok calls prove neither revoke created a lockout for the
--      roles that must still work.
--
-- Run via `supabase test db` after `supabase db reset`. NOT executed as part
-- of this change — see .superpowers/sdd/db-residual-gaps-report.md for why.

begin;

select plan(24);

-- ============================================================================
-- 1. storage.objects — user-avatars write policies preserve the original
--    folder-ownership predicate AND gain the disabled-subject guard.
-- ============================================================================

-- Loose substring matching, not an exact-expression regex: Postgres's
-- expression deparser is free to reformat parens/casts when it prints
-- pg_policies.qual/with_check back out, and pinning the exact printed form
-- would make this test brittle against a cosmetically-different but
-- semantically-identical policy. This mirrors the repo's own idiom for the
-- same bucket family (0260_support_ticket_attachments.test.sql:103-104 uses
-- `like '%foldername%'` for the same reason). Each policy is asserted to
-- contain BOTH 'foldername' (the untouched original ownership predicate,
-- which also proves auth.uid() is still compared against it) AND
-- 'disabled_at' (the new guard) — recurring bug #24 is exactly the case where
-- the second is present and the first silently is not.

-- "user-avatars own write" — INSERT, with_check only.
select matches(
  (select with_check from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own write'),
  'foldername',
  'user-avatars own write: original folder-ownership predicate is preserved'
);
select matches(
  (select with_check from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own write'),
  'disabled_at',
  'user-avatars own write: gained the disabled_at guard'
);

-- "user-avatars own update" — both USING and WITH CHECK.
select matches(
  (select qual from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own update'),
  'foldername',
  'user-avatars own update: USING preserves the folder-ownership predicate'
);
select matches(
  (select qual from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own update'),
  'disabled_at',
  'user-avatars own update: USING gained the disabled_at guard'
);
select matches(
  (select with_check from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own update'),
  'foldername',
  'user-avatars own update: WITH CHECK preserves the folder-ownership predicate'
);
select matches(
  (select with_check from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own update'),
  'disabled_at',
  'user-avatars own update: WITH CHECK gained the disabled_at guard'
);

-- "user-avatars own delete" — DELETE, using only.
select matches(
  (select qual from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own delete'),
  'foldername',
  'user-avatars own delete: original folder-ownership predicate is preserved'
);
select matches(
  (select qual from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars own delete'),
  'disabled_at',
  'user-avatars own delete: gained the disabled_at guard'
);

-- All three write policies stayed scoped to `authenticated` only — the fix
-- does not widen who may attempt these writes, only who succeeds.
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('user-avatars own write', 'user-avatars own update', 'user-avatars own delete')
      and roles = array['authenticated']::name[]),
  3::bigint,
  'all three user-avatars write policies remain scoped to {authenticated}'
);

-- The read policy is untouched by this migration: no disabled_at reference,
-- still authenticated-only (0105's shape), still just bucket_id.
select ok(
  (select qual from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'user-avatars authenticated read') !~ 'disabled_at',
  'user-avatars authenticated read (SELECT) was NOT touched by this migration'
);

-- ============================================================================
-- 2. user_can_access_inventory / user_can_access_warehouse — EXECUTE revoked
--    from PUBLIC and anon; authenticated and service_role keep it.
-- ============================================================================

-- ---- user_can_access_inventory(uuid, uuid, uuid, text) ----

select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.user_can_access_inventory(uuid, uuid, uuid, text)'::regprocedure
      and a.grantee = 0            -- grantee 0 is PUBLIC
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC holds no EXECUTE on user_can_access_inventory'
);
select ok(
  not has_function_privilege('anon',
    'public.user_can_access_inventory(uuid, uuid, uuid, text)', 'EXECUTE'),
  'anon holds no EXECUTE on user_can_access_inventory — the unauthenticated oracle is closed'
);
select ok(
  has_function_privilege('authenticated',
    'public.user_can_access_inventory(uuid, uuid, uuid, text)', 'EXECUTE'),
  'authenticated keeps EXECUTE on user_can_access_inventory'
);
select ok(
  has_function_privilege('service_role',
    'public.user_can_access_inventory(uuid, uuid, uuid, text)', 'EXECUTE'),
  'service_role keeps EXECUTE on user_can_access_inventory'
);

-- ---- user_can_access_warehouse(uuid, uuid, text) ----

select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.user_can_access_warehouse(uuid, uuid, text)'::regprocedure
      and a.grantee = 0            -- grantee 0 is PUBLIC
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC holds no EXECUTE on user_can_access_warehouse — the implicit default grant was revoked'
);
select ok(
  not has_function_privilege('anon',
    'public.user_can_access_warehouse(uuid, uuid, text)', 'EXECUTE'),
  'anon holds no EXECUTE on user_can_access_warehouse'
);
select ok(
  has_function_privilege('authenticated',
    'public.user_can_access_warehouse(uuid, uuid, text)', 'EXECUTE'),
  'authenticated keeps EXECUTE on user_can_access_warehouse'
);
select ok(
  has_function_privilege('service_role',
    'public.user_can_access_warehouse(uuid, uuid, text)', 'EXECUTE'),
  'service_role keeps EXECUTE on user_can_access_warehouse'
);

-- Asked FROM INSIDE the role, matching 0310's convention exactly: a real
-- `set local role to 'anon'` denied call SEGFAULTS the local Supabase CLI
-- image (documented in 0310_rls_blocks_disabled_accounts.test.sql), so the
-- refusal is asserted through the privilege system itself rather than by
-- attempting the call and expecting an error.
set local role to 'anon';
select ok(
  not has_function_privilege(current_user,
    'public.user_can_access_inventory(uuid, uuid, uuid, text)', 'EXECUTE'),
  'anon, asked as itself, is NOT permitted to call user_can_access_inventory'
);
select ok(
  not has_function_privilege(current_user,
    'public.user_can_access_warehouse(uuid, uuid, text)', 'EXECUTE'),
  'anon, asked as itself, is NOT permitted to call user_can_access_warehouse'
);
reset role;

-- ---- No lockout: authenticated and service_role can still actually call
--      both functions (a real call, not just a catalog question). Dummy
--      uuids are fine — both functions are NULL/absence-safe and simply
--      resolve to false rather than raising.
set local role to 'authenticated';
select lives_ok(
  $$select public.user_can_access_inventory(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      null, 'read')$$,
  'authenticated can still call user_can_access_inventory (no lockout)'
);
select lives_ok(
  $$select public.user_can_access_warehouse(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'read')$$,
  'authenticated can still call user_can_access_warehouse (no lockout)'
);
reset role;

set local role to 'service_role';
select lives_ok(
  $$select public.user_can_access_inventory(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      null, 'read')$$,
  'service_role can still call user_can_access_inventory (no lockout)'
);
select lives_ok(
  $$select public.user_can_access_warehouse(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      'read')$$,
  'service_role can still call user_can_access_warehouse (no lockout)'
);
reset role;

select * from finish();
rollback;
