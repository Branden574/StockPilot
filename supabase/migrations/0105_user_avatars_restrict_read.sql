-- 0105_user_avatars_restrict_read.sql
-- ============================================================================
-- Tighten the SELECT policy on the `user-avatars` storage bucket from
-- (anon, authenticated) down to authenticated-only.
--
-- Avatars never need to be readable anonymously: the only surfaces that
-- render another user's avatar — the topbar, member list, audit log,
-- order-request reviewer chips, etc. — all sit behind the authenticated
-- dashboard. Allowing anon read meant anyone with the bucket URL prefix
-- could enumerate or hotlink avatars without an auth check.
--
-- The bucket itself stays `public = true` so the existing public-URL
-- builder (`getPublicUrl`) keeps producing stable, predictable URLs —
-- but Supabase storage still evaluates the SELECT policy on read, so
-- restricting the policy to `authenticated` blocks anon-token GETs.
-- (Bucket-`public` only controls whether the URL builder signs; the
-- RLS policy is the actual gate.)
--
-- Migration 0026 created this policy with `to anon, authenticated`;
-- this migration replaces it.
-- ============================================================================

drop policy if exists "user-avatars public read" on storage.objects;

create policy "user-avatars authenticated read"
  on storage.objects for select to authenticated
  using (bucket_id = 'user-avatars');
