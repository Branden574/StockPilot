-- 0211_po_attachments.sql
-- ============================================================================
-- File attachments for purchase orders (e.g. supplier packing slips on a
-- received PO): a private Storage bucket + a metadata table. Mirrors the
-- order-attachments pattern (mig 0142/0143).
--
-- Upload/delete = managers+ OR anyone granted purchase_orders:manage (the
-- configurable-permissions resolver, mig 0207/0208 — so a granted "auditor" can
-- attach too). View = any org member (the PO section already gates
-- purchase_orders:read). Path convention: {org_id}/{po_id}/{uuid}.{ext} so
-- (storage.foldername(name))[1] is the org id for the bucket RLS.
-- ============================================================================

-- ── FK-org guard: a PO referenced by an attachment must belong to that org ──
create or replace function public.purchase_order_in_org(p_po_id uuid, p_org_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_po_id is null or exists (
    select 1 from public.purchase_orders
    where id = p_po_id and organization_id = p_org_id
  );
$$;
grant execute on function public.purchase_order_in_org(uuid, uuid) to authenticated;

-- ── 1. Bucket ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'po-attachments', 'po-attachments', false,
  array['image/png','image/jpeg','image/webp','image/heic','image/heif','application/pdf'],
  15 * 1024 * 1024
)
on conflict (id) do update
  set allowed_mime_types = excluded.allowed_mime_types,
      file_size_limit    = excluded.file_size_limit;

drop policy if exists "po-attachments read"          on storage.objects;
drop policy if exists "po-attachments manage write"  on storage.objects;
drop policy if exists "po-attachments manage update" on storage.objects;
drop policy if exists "po-attachments manage delete" on storage.objects;

create policy "po-attachments read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'po-attachments'
    and ( SELECT public.is_org_member((storage.foldername(name))[1]::uuid) )
  );

create policy "po-attachments manage write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'po-attachments'
    and (
      ( SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( SELECT public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  );

create policy "po-attachments manage update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'po-attachments'
    and (
      ( SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( SELECT public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  )
  with check (
    bucket_id = 'po-attachments'
    and (
      ( SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( SELECT public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  );

create policy "po-attachments manage delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'po-attachments'
    and (
      ( SELECT public.has_org_role((storage.foldername(name))[1]::uuid, 'manager') )
      or ( SELECT public.has_permission((storage.foldername(name))[1]::uuid, 'purchase_orders:manage') )
    )
  );

-- ── 2. Metadata table ─────────────────────────────────────────────────────
create table if not exists public.po_attachments (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  storage_path      text not null,
  file_name         text,
  content_type      text,
  size_bytes        bigint,
  uploaded_by       uuid references public.user_profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists po_attachments_po_idx
  on public.po_attachments(purchase_order_id, created_at desc);

alter table public.po_attachments enable row level security;

drop policy if exists "po_attachments read"         on public.po_attachments;
drop policy if exists "po_attachments manage insert" on public.po_attachments;
drop policy if exists "po_attachments manage delete" on public.po_attachments;

create policy "po_attachments read"
  on public.po_attachments for select to authenticated
  using ( ( SELECT public.is_org_member(organization_id) ) );

create policy "po_attachments manage insert"
  on public.po_attachments for insert to authenticated
  with check (
    (
      ( SELECT public.has_org_role(organization_id, 'manager') )
      or ( SELECT public.has_permission(organization_id, 'purchase_orders:manage') )
    )
    and ( SELECT public.purchase_order_in_org(purchase_order_id, organization_id) )
  );

create policy "po_attachments manage delete"
  on public.po_attachments for delete to authenticated
  using (
    ( SELECT public.has_org_role(organization_id, 'manager') )
    or ( SELECT public.has_permission(organization_id, 'purchase_orders:manage') )
  );

grant select, insert, delete on public.po_attachments to authenticated;
