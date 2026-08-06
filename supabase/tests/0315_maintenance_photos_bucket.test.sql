-- supabase/tests/0315_maintenance_photos_bucket.test.sql
-- pgTAP tests for migration 0315 — the private maintenance-photos storage
-- bucket + its single org-prefix INSERT policy.
--
-- Shape (from the migration header): uploads are SERVER-MINTED (signed
-- upload URLs from the attachments service, Task 9); the INSERT policy here
-- is a defense-in-depth backstop keyed on the org prefix, following the
-- support-attachments (0260) and order-attachments (0142/0143) precedent.
-- There is deliberately NO select/update/delete policy — every read is a
-- short-lived signed URL minted server-side, so a plain authenticated user
-- (even the uploader, even inside their own org) must see ZERO rows via
-- direct PostgREST/SQL access. That "zero visibility" property is asserted
-- directly (test 11) rather than only inferred from policy absence, because
-- it is exactly what a mistakenly-added broad SELECT policy would break.
--
-- Real cross-boundary INSERT attempts are exercised directly against
-- storage.objects (not inferred from pg_policies text), per the house lesson
-- from Task 1's review: throws_ok must assert errcode '42501' exactly, and
-- every candidate row/path is a literal built with \set — never derived via
-- a live subquery run under the attacker's own session (that pattern is a
-- false negative, since RLS already hides rows the attacker can't see before
-- the write policy even runs).
--
-- Namespace a0315000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(11);

-- ─────────────────────────────────────────────────────────────────────────
-- Fixtures
-- ─────────────────────────────────────────────────────────────────────────
\set orgA      '\'a0315000-0000-0000-0000-000000000001\''
\set orgB      '\'a0315000-0000-0000-0000-000000000002\''
\set ownerA    '\'a0315000-0000-0000-0000-0000000000a1\''
\set pendingA  '\'a0315000-0000-0000-0000-0000000000a2\''
\set disabledA '\'a0315000-0000-0000-0000-0000000000a3\''
\set reqId     '\'a0315000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:ownerA,    'owner-0315@test.local',    '{}'::jsonb),
  (:pendingA,  'pending-0315@test.local',  '{}'::jsonb),
  (:disabledA, 'disabled-0315@test.local', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  (:orgA, 'Maintenance Photos Org A', 'maint-photos-org-a-0315'),
  (:orgB, 'Maintenance Photos Org B', 'maint-photos-org-b-0315');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :ownerA,    'admin',  now()),
  (:orgA, :pendingA,  'staff',  null),   -- accepted_at IS NULL — invited, not accepted
  (:orgA, :disabledA, 'staff',  now());

update public.user_profiles set disabled_at = now() where id = :disabledA;

-- ─────────────────────────────────────────────────────────────────────────
-- Bucket shape (brief §Step 1, verbatim)
-- ─────────────────────────────────────────────────────────────────────────
select ok(
  exists (select 1 from storage.buckets where id = 'maintenance-photos' and public = false),
  'maintenance-photos bucket exists and is private');

select is(
  (select allowed_mime_types from storage.buckets where id = 'maintenance-photos'),
  array['image/png','image/jpeg','image/webp'],
  'bucket pinned to png/jpeg/webp (HEIC must transcode client-side)');

select is(
  (select file_size_limit from storage.buckets where id = 'maintenance-photos'),
  10485760::bigint,
  'bucket capped at 10MB per object');

select ok(
  exists (select 1 from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and policyname = 'maintenance-photos org write'),
  'org-prefix INSERT policy exists');

-- ─────────────────────────────────────────────────────────────────────────
-- Policy shape: INSERT-only, nothing else registered for this bucket.
-- ─────────────────────────────────────────────────────────────────────────
select is(
  (select cmd from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'maintenance-photos org write'),
  'INSERT',
  'the policy is INSERT-only');

select is(
  (select count(*)::int from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'maintenance-photos%'),
  1,
  'no select/update/delete policy exists for this bucket — reads are server-minted signed URLs only');

-- ─────────────────────────────────────────────────────────────────────────
-- Real cross-boundary INSERT behavior.
-- ─────────────────────────────────────────────────────────────────────────

-- An accepted member of org A can write under org A's own prefix.
set local "request.jwt.claim.sub" to 'a0315000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format(
    $$insert into storage.objects (bucket_id, name)
        values ('maintenance-photos', %L)$$,
    'a0315000-0000-0000-0000-000000000001/a0315000-0000-0000-0000-0000000000c1/11111111-1111-1111-1111-111111111111.png'
  ),
  'an accepted org-A member can insert a photo under org A''s own prefix'
);
reset role;

-- The SAME accepted member cannot write under org B's prefix (mutation
-- target (b): dropping the org-prefix parse guard must make this pass).
set local "request.jwt.claim.sub" to 'a0315000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format(
    $$insert into storage.objects (bucket_id, name)
        values ('maintenance-photos', %L)$$,
    'a0315000-0000-0000-0000-000000000002/a0315000-0000-0000-0000-0000000000c1/22222222-2222-2222-2222-222222222222.png'
  ),
  '42501', null,
  'an org-A member CANNOT insert under org B''s prefix — foreign-prefix write is rejected'
);
reset role;

-- A pending (not-yet-accepted) member of org A cannot write at all, even
-- under org A's own prefix.
set local "request.jwt.claim.sub" to 'a0315000-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format(
    $$insert into storage.objects (bucket_id, name)
        values ('maintenance-photos', %L)$$,
    'a0315000-0000-0000-0000-000000000001/a0315000-0000-0000-0000-0000000000c1/33333333-3333-3333-3333-333333333333.png'
  ),
  '42501', null,
  'a pending (accepted_at IS NULL) org-A member cannot insert — membership must be accepted'
);
reset role;

-- A disabled account cannot write, even under its own org's prefix (the
-- 0312 inline disabled-account guard).
set local "request.jwt.claim.sub" to 'a0315000-0000-0000-0000-0000000000a3';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format(
    $$insert into storage.objects (bucket_id, name)
        values ('maintenance-photos', %L)$$,
    'a0315000-0000-0000-0000-000000000001/a0315000-0000-0000-0000-0000000000c1/44444444-4444-4444-4444-444444444444.png'
  ),
  '42501', null,
  'a disabled account cannot insert even under its own org''s prefix'
);
reset role;

-- No SELECT policy exists at all: even the org-A member who legitimately
-- owns the row above cannot see it via direct SQL/PostgREST (mutation target
-- (a): a wide-open authenticated SELECT policy would make this count > 0).
-- Insert a row directly as postgres (bypassing RLS) to have something real
-- to fail to see.
insert into storage.objects (bucket_id, name) values (
  'maintenance-photos',
  'a0315000-0000-0000-0000-000000000001/a0315000-0000-0000-0000-0000000000c1/55555555-5555-5555-5555-555555555555.png'
);

set local "request.jwt.claim.sub" to 'a0315000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from storage.objects where bucket_id = 'maintenance-photos'),
  0,
  'an org-A member sees ZERO rows in maintenance-photos via direct SQL — reads are server-minted signed URLs only'
);
reset role;

select * from finish();
rollback;
