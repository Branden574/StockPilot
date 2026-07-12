-- 0260_support_ticket_attachments.sql
-- ============================================================================
-- Optional screenshot attachments for in-app support tickets (the new
-- /dashboard/support form). One image per ticket, stored in a PRIVATE bucket.
--
-- Access model mirrors support_tickets itself (mig 0173 — RLS on, no
-- policies, service-role only):
--   • upload — the browser uploads directly to `support-attachments` under a
--     folder named after the uploader's auth uid. The ONLY storage policy is
--     insert-into-your-own-folder; the submit action then verifies the path
--     prefix again before persisting it on the ticket.
--   • read  — NO select policy. Platform admins view screenshots via
--     short-lived signed URLs minted server-side with the service-role client
--     (the /platform/support triage page).
--   • no update/delete policies — attachments are immutable once uploaded;
--     cleanup is a service-role concern.
-- ============================================================================

-- ── 1. Ticket column ────────────────────────────────────────────────────────
alter table public.support_tickets
  add column if not exists attachment_path text;

comment on column public.support_tickets.attachment_path is
  'Storage key in the private support-attachments bucket ({user_id}/{uuid}.{ext}); read via service-role signed URLs only.';

-- ── 2. Private bucket ───────────────────────────────────────────────────────
-- Screenshot-sized images only; limits match the client-side form (5 MB,
-- png/jpeg/webp) so the bucket enforces what the UI promises.
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'support-attachments', 'support-attachments', false,
  array['image/png','image/jpeg','image/webp'],
  5 * 1024 * 1024
)
on conflict (id) do nothing;

-- ── 3. Storage policy: authenticated users may only INSERT into their own
--       {auth.uid()}/... folder. Deliberately NO select/update/delete — reads
--       happen through service-role signed URLs. ─────────────────────────────
drop policy if exists "support-attachments own write" on storage.objects;

create policy "support-attachments own write"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
