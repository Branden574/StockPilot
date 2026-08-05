-- 0315_maintenance_photos_bucket.sql
-- Private bucket for maintenance request photos.
--
-- Path scheme: {organization_id}/{maintenance_request_id}/{uuid}.{ext}
--              {organization_id}/{maintenance_request_id}/{uuid}-thumb.webp
--
-- Uploads are SERVER-MINTED (signed upload URLs from the attachments service,
-- which is where rate limiting + entity checks live); the INSERT policy below
-- is the defense-in-depth backstop keyed on the org prefix. There is NO select
-- policy: every read is a short-lived signed URL minted server-side after an
-- RLS-visible parent check. HEIC is deliberately NOT in allowed_mime_types —
-- both platforms transcode to JPEG client-side before upload (the
-- order-attachments bucket accepts raw HEIC and produced unrenderable
-- originals; we do not repeat that).
--
-- Precedent: 0142/0143 (order-attachments, org-prefix), 0260 (support-
-- attachments, insert-only + no select policy), 0312 (the inline
-- disabled-account guard, since account_is_disabled() has EXECUTE revoked
-- from `authenticated` and only the inlined `not exists` form is callable
-- from inside a storage policy evaluated as that role).
--
-- lock_timeout: policy DDL on storage.objects takes a lock on a table read on
-- every attachment/avatar/logo render across the product (0312's rationale,
-- reapplied here since this is the next storage.objects DDL after it). A
-- blocked push fails fast and can be retried in a quiet window instead of
-- queuing every reader behind it.
set lock_timeout = '5s';

insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'maintenance-photos', 'maintenance-photos', false,
  array['image/png','image/jpeg','image/webp'],
  10 * 1024 * 1024
)
on conflict (id) do nothing;

drop policy if exists "maintenance-photos org write" on storage.objects;

-- Org-prefix write, with the 0312 INLINE disabled-account guard:
-- account_is_disabled() is EXECUTE-revoked from `authenticated`, so only the
-- inlined not-exists form works inside a storage policy. auth.uid() is
-- wrapped in (select ...) per the 0140 initplan convention (also how 0312's
-- own new guard clauses and 0143's order-attachments hardening are written) —
-- storage.objects has no `organization_id` column, so the `in (select
-- organization_id from organization_members ...)` list and the disabled-check
-- EXISTS are both non-correlated with the outer row and free of the pattern
-- #25 self-comparison hazard (an unqualified outer-table column resolving to
-- the inner relation); verified by inspection, and covered by real
-- cross-boundary pgTAP INSERT attempts rather than only a policy-existence
-- check.
create policy "maintenance-photos org write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'maintenance-photos'
    and (storage.foldername(name))[1]::uuid in (
      select organization_id from public.organization_members
       where user_id = (select auth.uid()) and accepted_at is not null
    )
    and not exists (
      select 1 from public.user_profiles up
       where up.id = (select auth.uid()) and up.disabled_at is not null
    )
  );

reset lock_timeout;
