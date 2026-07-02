-- supabase/tests/0142_order_attachments_read_floor.test.sql
-- Proves the READ floor of both attachment surfaces is ANY ORG MEMBER
-- (is_org_member) — not owner/manager/uploader-gated. Written while chasing an
-- "only the owner can see attachments on mobile" report: mobile lists rows via
-- RLS (order_request_attachments / po_attachments) and mints signed URLs under
-- the USER's JWT via the bucket SELECT policies, so if any of these four
-- policies ever regresses to a role gate, every non-owner's mobile attachments
-- silently render as an empty state. Behavioral checks (0142/0143) + policy-
-- expression pins (0142 + 0211 buckets).

begin;
select plan(8);

\set orgA   '\'da000000-0000-0000-0000-0000000000da\''
\set mgr    '\'d0000000-0000-0000-0000-0000000000d1\''
\set viewer '\'d0000000-0000-0000-0000-0000000000d2\''
\set wh     '\'d0000000-0000-0000-0000-0000000000d7\''
\set ord    '\'d0000000-0000-0000-0000-0000000000d9\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr@oatt.test', '{}'::jsonb),
  (:viewer, 'view@oatt.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'OAtt Org A', 'oatt-org-a');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr, 'manager', now()),
  (:orgA, :viewer, 'viewer', now());
insert into public.warehouses (id, organization_id, name, code) values
  (:wh, :orgA, 'OAtt WH', 'OATT');
-- 'completed' is an ATTACHABLE status (0143 insert policy requires one).
-- The transition guard is BEFORE UPDATE only, so a direct seed insert is fine.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id)
values
  (:ord, :orgA, :wh, 'completed', 'internal', :mgr);

-- ── Manager can attach (org + attachable-status + path-prefix binds pass) ───
set local "request.jwt.claim.sub" to 'd0000000-0000-0000-0000-0000000000d1'; -- mgr
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.order_request_attachments
       (organization_id, order_request_id, storage_path, kind)
     values ('da000000-0000-0000-0000-0000000000da',
             'd0000000-0000-0000-0000-0000000000d9',
             'da000000-0000-0000-0000-0000000000da/d0000000-0000-0000-0000-0000000000d9/proof.jpg',
             'dropoff_photo') $$,
  'manager can insert an order attachment on a completed order'
);
reset role;

-- ── ANY org member (a plain viewer) can READ the attachments ────────────────
set local "request.jwt.claim.sub" to 'd0000000-0000-0000-0000-0000000000d2'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(
  (select count(*) from public.order_request_attachments
     where organization_id = 'da000000-0000-0000-0000-0000000000da') >= 1,
  'a plain viewer (non-owner, non-manager) can READ the org''s order attachments'
);
-- …but cannot write:
select throws_ok(
  $$ insert into public.order_request_attachments
       (organization_id, order_request_id, storage_path, kind)
     values ('da000000-0000-0000-0000-0000000000da',
             'd0000000-0000-0000-0000-0000000000d9',
             'da000000-0000-0000-0000-0000000000da/d0000000-0000-0000-0000-0000000000d9/v.jpg',
             'other') $$,
  '42501', null,
  'viewer cannot insert an order attachment'
);
-- …and DELETE is RLS-filtered to a no-op (manager-only delete policy).
delete from public.order_request_attachments
  where organization_id = 'da000000-0000-0000-0000-0000000000da';
select ok(
  (select count(*) from public.order_request_attachments
     where organization_id = 'da000000-0000-0000-0000-0000000000da') >= 1,
  'viewer DELETE is a no-op — rows survive'
);
reset role;

-- ── Pin the four READ policies to the org-member floor ──────────────────────
-- Mobile signs download URLs under the user's own JWT, so the bucket SELECT
-- policies ARE the download gate. If any of these ever gains a role gate
-- (has_org_role) or loses is_org_member, non-owner mobile users lose
-- attachments while the (service-role-signing) web keeps working — the exact
-- silent failure shape this file guards against.
select ok(
  (select qual from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'order-attachments read')
    like '%is_org_member%'
  and (select qual from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'order-attachments read')
    not like '%has_org_role%',
  'order-attachments bucket SELECT = is_org_member (no role gate)'
);
select ok(
  (select qual from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'po-attachments read')
    like '%is_org_member%'
  and (select qual from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'po-attachments read')
    not like '%has_org_role%',
  'po-attachments bucket SELECT = is_org_member (no role gate)'
);
select ok(
  (select qual from pg_policies
     where schemaname = 'public' and tablename = 'order_request_attachments'
       and policyname = 'order_request_attachments read')
    like '%is_org_member%'
  and (select qual from pg_policies
     where schemaname = 'public' and tablename = 'order_request_attachments'
       and policyname = 'order_request_attachments read')
    not like '%has_org_role%',
  'order_request_attachments SELECT = is_org_member (no role gate)'
);
select ok(
  (select qual from pg_policies
     where schemaname = 'public' and tablename = 'po_attachments'
       and policyname = 'po_attachments read')
    like '%is_org_member%'
  and (select qual from pg_policies
     where schemaname = 'public' and tablename = 'po_attachments'
       and policyname = 'po_attachments read')
    not like '%has_org_role%',
  'po_attachments SELECT = is_org_member (no role gate)'
);

select * from finish();
rollback;
