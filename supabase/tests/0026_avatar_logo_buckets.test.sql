-- supabase/tests/0026_avatar_logo_buckets.test.sql
-- pgTAP tests for migration 0026 — buckets + RLS policies.

begin;

select plan(6);

-- ─────────────────────────────────────────────────────────────────────
-- Test 1-2: buckets exist and are public.
-- ─────────────────────────────────────────────────────────────────────

select is(
  (select public from storage.buckets where id = 'user-avatars'),
  true,
  'user-avatars bucket exists and is public'
);

select is(
  (select public from storage.buckets where id = 'org-logos'),
  true,
  'org-logos bucket exists and is public'
);

-- ─────────────────────────────────────────────────────────────────────
-- Test 3-6: RLS policies exist on storage.objects.
-- ─────────────────────────────────────────────────────────────────────

select ok(
  exists(
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'user-avatars own write'
  ),
  'user-avatars own-write policy is present'
);

select ok(
  exists(
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'user-avatars own delete'
  ),
  'user-avatars own-delete policy is present'
);

select ok(
  exists(
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'org-logos admin update'
  ),
  'org-logos admin-update policy is present'
);

select ok(
  exists(
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'org-logos admin delete'
  ),
  'org-logos admin-delete policy is present'
);

select * from finish();
rollback;
