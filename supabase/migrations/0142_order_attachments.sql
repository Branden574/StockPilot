-- 0142_order_attachments.sql
-- ============================================================================
-- Proof-of-delivery attachments for order_requests: a private Storage bucket
-- + a metadata table. Managers+ upload/delete; any org member can view.
--
-- Path convention: {organization_id}/{order_request_id}/{uuid}.{ext}
-- so (storage.foldername(name))[1] is the org id for the bucket RLS, mirroring
-- the po-imports bucket (migration 0021).
-- ============================================================================

-- 1. Bucket --------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('order-attachments', 'order-attachments', false)
on conflict (id) do nothing;

drop policy if exists "order-attachments read"           on storage.objects;
drop policy if exists "order-attachments manager write"  on storage.objects;
drop policy if exists "order-attachments manager update" on storage.objects;
drop policy if exists "order-attachments manager delete" on storage.objects;

create policy "order-attachments read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'order-attachments'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "order-attachments manager write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy "order-attachments manager update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  )
  with check (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy "order-attachments manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'order-attachments'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

-- 2. Metadata table -----------------------------------------------------------
create table if not exists public.order_request_attachments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  storage_path     text not null,
  file_name        text,
  content_type     text,
  size_bytes       bigint,
  -- Optional label so the proof gallery can group: a wet-signature photo,
  -- a photo of the dropped-off items, the drop-off location, or other.
  kind             text not null default 'other'
                     check (kind in ('signature', 'dropoff_photo', 'location', 'other')),
  uploaded_by      uuid references public.user_profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists order_request_attachments_order_idx
  on public.order_request_attachments(order_request_id, created_at desc);

alter table public.order_request_attachments enable row level security;

drop policy if exists "order_request_attachments read"           on public.order_request_attachments;
drop policy if exists "order_request_attachments manager insert" on public.order_request_attachments;
drop policy if exists "order_request_attachments manager delete" on public.order_request_attachments;

create policy "order_request_attachments read"
  on public.order_request_attachments for select to authenticated
  using (public.is_org_member(organization_id));

create policy "order_request_attachments manager insert"
  on public.order_request_attachments for insert to authenticated
  with check (public.has_org_role(organization_id, 'manager'));

create policy "order_request_attachments manager delete"
  on public.order_request_attachments for delete to authenticated
  using (public.has_org_role(organization_id, 'manager'));

grant select, insert, delete on public.order_request_attachments to authenticated;
