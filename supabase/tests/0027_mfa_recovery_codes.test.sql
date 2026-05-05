-- supabase/tests/0027_mfa_recovery_codes.test.sql
-- pgTAP tests for migration 0027 — generate + consume recovery codes.
-- Run via `supabase test db`.

begin;

select plan(7);

\set user_id '\'11111111-1111-1111-1111-111111111111\''

-- Seed an auth user we can become.
insert into auth.users (id, email, raw_user_meta_data)
  values (:user_id, 'mfa@test.local', '{}'::jsonb)
  on conflict (id) do nothing;

-- pgTAP-style "become this user" — set the request.jwt.claim.sub so
-- auth.uid() returns it inside SECURITY DEFINER functions.
set local "request.jwt.claim.sub" to '11111111-1111-1111-1111-111111111111';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ─────────────────────────────────────────────────────────────────────
-- Test 1: generate returns 10 distinct plaintexts.
-- ─────────────────────────────────────────────────────────────────────

create temp table _gen on commit drop as
  select code from public.generate_mfa_recovery_codes();

select is((select count(*)::int from _gen), 10, 'Generates exactly 10 codes');
select is((select count(distinct code)::int from _gen), 10, 'All 10 codes are distinct');

-- ─────────────────────────────────────────────────────────────────────
-- Test 2: codes match the format <4chars>-<4>-<4>-<4>.
-- ─────────────────────────────────────────────────────────────────────

select ok(
  not exists(
    select 1 from _gen
    where code !~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'
  ),
  'Every generated code matches XXXX-XXXX-XXXX-XXXX'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 3: generate writes 10 hashed rows + plaintext is not stored.
-- ─────────────────────────────────────────────────────────────────────

select is(
  (select count(*)::int from public.mfa_recovery_codes
    where user_id = :user_id and used_at is null),
  10,
  '10 unused codes persisted'
);

select ok(
  not exists(
    select 1 from public.mfa_recovery_codes c
    join _gen g on g.code = c.code_hash
    where c.user_id = :user_id
  ),
  'Stored hashes are not the plaintext codes (sha256 was applied)'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 4: consuming a valid code marks it used and returns true.
-- ─────────────────────────────────────────────────────────────────────

select is(
  (select public.consume_mfa_recovery_code((select code from _gen limit 1))),
  true,
  'consume_mfa_recovery_code returns true for a valid unused code'
);

select is(
  (select count(*)::int from public.mfa_recovery_codes
    where user_id = :user_id and used_at is not null),
  1,
  'Exactly one code is marked used'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 5: consuming the same code twice returns false.
-- ─────────────────────────────────────────────────────────────────────

select is(
  (select public.consume_mfa_recovery_code((select code from _gen limit 1))),
  false,
  'Already-used code cannot be consumed again'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 6: regenerate wipes the old set entirely.
-- ─────────────────────────────────────────────────────────────────────

perform public.generate_mfa_recovery_codes();

select is(
  (select count(*)::int from public.mfa_recovery_codes
    where user_id = :user_id),
  10,
  'Regenerate wipes the previous set (10 rows total, not 20)'
);

select * from finish();
rollback;
