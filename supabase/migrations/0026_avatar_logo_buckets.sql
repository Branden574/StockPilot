-- 0026_avatar_logo_buckets.sql
-- ============================================================================
-- Creates two public buckets:
--   • org-logos     — bucket existed conceptually (RLS policies live in 0003)
--                     but no row in storage.buckets. Adds it + delete policy.
--   • user-avatars  — new. Path convention: {user_id}/{filename}. Public read
--                     so we don't need signed URLs to render the topbar avatar.
-- Both are public-read so a CDN can cache the image.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('org-logos', 'org-logos', true)
on conflict (id) do nothing;

drop policy if exists "org-logos admin update" on storage.objects;
drop policy if exists "org-logos admin delete" on storage.objects;

create policy "org-logos admin update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'org-logos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'admin')
  )
  with check (
    bucket_id = 'org-logos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'admin')
  );

create policy "org-logos admin delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'org-logos'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'admin')
  );

-- ─────────────────────────────────────────────────────────────────────
-- user-avatars — every user can manage their own avatar.
-- Path convention: {user_id}/{filename}
-- (storage.foldername(name))[1] is therefore the owning user's id.
-- ─────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('user-avatars', 'user-avatars', true)
on conflict (id) do nothing;

drop policy if exists "user-avatars public read" on storage.objects;
drop policy if exists "user-avatars own write"   on storage.objects;
drop policy if exists "user-avatars own update"  on storage.objects;
drop policy if exists "user-avatars own delete"  on storage.objects;

create policy "user-avatars public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'user-avatars');

create policy "user-avatars own write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
  );

create policy "user-avatars own update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
  )
  with check (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
  );

create policy "user-avatars own delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'user-avatars'
    and (storage.foldername(name))[1]::uuid = auth.uid()
  );
