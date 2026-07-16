-- supabase/tests/0260_support_ticket_attachments.test.sql
-- pgTAP tests for migration 0260 — optional screenshot attachments on
-- support_tickets (attachment_path column) + the private support-attachments
-- storage bucket.
--
-- What the migration ACTUALLY creates (read 0260 + its 0173 dependency
-- carefully before assuming an RLS shape):
--   • support_tickets already has RLS ON with ZERO policies (0173) — access
--     is entirely server-mediated (service-role only), and 0260 does NOT add
--     any select/insert policy to it. So the "ticket owner"/"another org
--     member"/"cross-org user" question all resolve the SAME way: NONE of
--     them can read or write support_tickets directly, even the submitter.
--     Platform-admin triage visibility is a service-role app-layer concern
--     (isPlatformAdmin gate), not an RLS grant.
--   • storage.objects gets exactly ONE new policy: authenticated INSERT into
--     your own {auth.uid()}/... folder. Deliberately no select/update/delete
--     policy — reads happen via service-role signed URLs.
--
-- Namespace a0260000. Wrapped in begin/rollback — nothing leaks.

begin;

select plan(12);

\set orgA    '\'a0260000-0000-0000-0000-000000000001\''
\set orgB    '\'a0260000-0000-0000-0000-000000000002\''
\set owner_u '\'a0260000-0000-0000-0000-0000000000a1\''
\set member  '\'a0260000-0000-0000-0000-0000000000a2\''
\set outside '\'a0260000-0000-0000-0000-0000000000b1\''
\set ticket  '\'a0260000-0000-0000-0000-0000000000c1\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:owner_u, 'owner-0260@test.local', '{}'::jsonb),
  (:member,  'member-0260@test.local', '{}'::jsonb),
  (:outside, 'outside-0260@test.local', '{}'::jsonb);

insert into public.organizations (id, name, slug) values
  (:orgA, 'Support Ticket Org A', 'support-tix-org-a-0260'),
  (:orgB, 'Support Ticket Org B', 'support-tix-org-b-0260');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :owner_u, 'owner',   now()),
  (:orgA, :member,  'admin',  now()),
  (:orgB, :outside, 'owner',  now());

insert into public.support_tickets
  (id, organization_id, submitted_by, email, subject, message)
values
  ('a0260000-0000-0000-0000-0000000000c1', 'a0260000-0000-0000-0000-000000000001',
   'a0260000-0000-0000-0000-0000000000a1', 'owner-0260@test.local',
   'Test subject', 'Test message body');

-- ─────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────
select has_column('public', 'support_tickets', 'attachment_path', 'support_tickets.attachment_path exists');

-- ─────────────────────────────────────────────────────────────────────
-- Bucket: private, size/mime-capped to match the client-side form.
-- ─────────────────────────────────────────────────────────────────────
select is(
  (select public from storage.buckets where id = 'support-attachments'),
  false,
  'support-attachments bucket is PRIVATE'
);
select is(
  (select file_size_limit from storage.buckets where id = 'support-attachments'),
  (5 * 1024 * 1024)::bigint,
  'support-attachments bucket has a 5MB file size limit'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'support-attachments'),
  array['image/png','image/jpeg','image/webp'],
  'support-attachments bucket restricts to png/jpeg/webp'
);

-- ─────────────────────────────────────────────────────────────────────
-- storage.objects policy: exactly one, INSERT-only, own-folder scoped.
-- ─────────────────────────────────────────────────────────────────────
select ok(
  exists(
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'support-attachments own write'
  ),
  'the "support-attachments own write" policy exists'
);
select is(
  (select cmd from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'support-attachments own write'),
  'INSERT',
  'the policy is INSERT-only'
);
select ok(
  (select with_check from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'support-attachments own write')
    like '%support-attachments%'
  and (select with_check from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'support-attachments own write')
    like '%foldername%',
  'the WITH CHECK pins bucket_id + own-folder (storage.foldername) — not a broad grant'
);
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname like 'support-attachments%'),
  1,
  'no select/update/delete policy exists for this bucket — reads are service-role signed-URL only'
);

-- ─────────────────────────────────────────────────────────────────────
-- support_tickets RLS: entirely server-mediated. Prove it the hard way —
-- actually try to read/write as each kind of authenticated user.
-- ─────────────────────────────────────────────────────────────────────

-- Ticket owner (submitted_by) themselves.
set local "request.jwt.claim.sub" to 'a0260000-0000-0000-0000-0000000000a1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.support_tickets where id = 'a0260000-0000-0000-0000-0000000000c1'),
  0,
  'the ticket''s own submitter CANNOT read it directly (no select policy — service-role/signed-URL only)'
);
select throws_ok(
  $$ insert into public.support_tickets (email, subject, message)
       values ('x@test.local', 'x', 'x') $$,
  '42501', null,
  'the submitter cannot insert a support ticket directly either (no insert policy)'
);
reset role;

-- Another member of the SAME org.
set local "request.jwt.claim.sub" to 'a0260000-0000-0000-0000-0000000000a2';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.support_tickets where id = 'a0260000-0000-0000-0000-0000000000c1'),
  0,
  'a fellow org member (admin) also cannot read the ticket — no org-member visibility carve-out exists'
);
reset role;

-- A user in a totally different org.
set local "request.jwt.claim.sub" to 'a0260000-0000-0000-0000-0000000000b1';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select count(*)::int from public.support_tickets where id = 'a0260000-0000-0000-0000-0000000000c1'),
  0,
  'a cross-org user cannot read the ticket either'
);
reset role;

select * from finish();
rollback;
