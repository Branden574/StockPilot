-- 0021_po_imports_bucket.sql
-- ============================================================================
-- Creates the `po-imports` Supabase Storage bucket (private) and the four
-- standard org-scoped RLS policies that mirror item-attachments.
--
-- Why: the PO upload flow calls supabase.storage.from('po-imports')
-- .createSignedUploadUrl(...). Supabase Storage validates the would-be
-- INSERT against storage.objects RLS at signing time. Without a bucket and
-- without an INSERT policy granting the authenticated org member, signing
-- fails with "new row violates row-level security policy" — which is what
-- the user saw on /dashboard/purchase-orders/imports/new.
--
-- Path convention: {organization_id}/po-imports/{uuid}.{ext}
-- (storage.foldername(name))[1] is therefore the org id.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('po-imports', 'po-imports', false)
on conflict (id) do nothing;

drop policy if exists "po-imports authenticated read"   on storage.objects;
drop policy if exists "po-imports manager write"        on storage.objects;
drop policy if exists "po-imports manager update"       on storage.objects;
drop policy if exists "po-imports manager delete"       on storage.objects;

create policy "po-imports authenticated read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'po-imports'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "po-imports manager write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'po-imports'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy "po-imports manager update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'po-imports'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  )
  with check (
    bucket_id = 'po-imports'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );

create policy "po-imports manager delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'po-imports'
    and public.has_org_role((storage.foldername(name))[1]::uuid, 'manager')
  );
