-- Instant Size Count — training-data capture (Phase 1, Step 1: the dataset).
-- An opt-in in-app capture mode records LABELED size-sticker examples from
-- real warehouse conditions. Each sample = one photo + the ground-truth size
-- the user tapped (or NONE for a hard negative: buttons/logos/neck tags the
-- model must learn to ignore) + capture-condition metadata. This is the
-- training set for the future on-device detector. Modeled on the AI-shelf-scan
-- storage pattern (0124): private org-scoped bucket + audit table.

-- ── 1) Training samples ─────────────────────────────────────────────────────
create table public.size_count_training_samples (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  captured_by         uuid not null references public.user_profiles(id) on delete restrict,
  -- Storage path (relative to the size-count-training bucket): {org}/{uuid}.jpg
  image_storage_path  text not null,
  -- Ground-truth label the capturer tapped. NONE = a hard negative.
  size_label          text not null check (size_label in
    ('XS','S','M','L','XL','XXL','XXXL','XXXXL','XXXXXL','NONE')),
  is_negative         boolean not null default false,
  -- Capture-condition tags for dataset balancing (lighting/blur/angle/plastic).
  metadata            jsonb not null default '{}'::jsonb,
  device_id           text,
  -- Configurable retention (null = keep). A later cleanup job can prune expired.
  retention_expires_at timestamptz,
  captured_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index size_count_training_org_idx
  on public.size_count_training_samples (organization_id, captured_at desc);
create index size_count_training_label_idx
  on public.size_count_training_samples (organization_id, size_label);

comment on table public.size_count_training_samples is
  'Opt-in labeled training examples for the Instant Size Count detector — one '
  'photo + ground-truth size (or NONE hard-negative) + capture metadata. '
  'Private, org-scoped. The dataset the on-device model trains on.';

-- ── 2) RLS (mirror 0124: org read, staff append, no update, manager delete) ──
alter table public.size_count_training_samples enable row level security;

create policy size_count_training_select on public.size_count_training_samples
  for select to authenticated
  using ((select public.is_org_member(organization_id)));

create policy size_count_training_insert on public.size_count_training_samples
  for insert to authenticated
  with check (
    (select public.has_org_role(organization_id, 'staff'))
    and captured_by = (select auth.uid())
  );

-- Immutable: no UPDATE policy. Managers may prune for storage hygiene.
create policy size_count_training_delete on public.size_count_training_samples
  for delete to authenticated
  using ((select public.has_org_role(organization_id, 'manager')));

grant select, insert, delete on public.size_count_training_samples to authenticated;

-- ── 3) Private storage bucket — size-count-training ─────────────────────────
-- Path convention: {organization_id}/{uuid}.jpg. Private (training images may
-- include warehouse background); signed URLs minted server-side if ever needed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'size-count-training',
  'size-count-training',
  false,
  10 * 1024 * 1024,
  array['image/webp', 'image/jpeg', 'image/png']::text[]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "size-count-training org read" on storage.objects;
drop policy if exists "size-count-training org write" on storage.objects;
drop policy if exists "size-count-training manager delete" on storage.objects;

create policy "size-count-training org read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'size-count-training'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "size-count-training org write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'size-count-training'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'staff')
  );

create policy "size-count-training manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'size-count-training'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );
