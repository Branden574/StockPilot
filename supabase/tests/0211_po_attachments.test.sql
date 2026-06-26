-- supabase/tests/0211_po_attachments.test.sql
-- Proves migration 0211: po_attachments RLS — any org member reads; only
-- managers OR members granted purchase_orders:manage write; the FK-org guard
-- blocks referencing another org's PO; and the bucket is size-capped.

begin;
select plan(7);

\set orgA   '\'ba000000-0000-0000-0000-0000000000ba\''
\set orgB   '\'bb000000-0000-0000-0000-0000000000bb\''
\set mgr    '\'b0000000-0000-0000-0000-0000000000b1\''
\set viewer '\'b0000000-0000-0000-0000-0000000000b2\''
\set gview  '\'b0000000-0000-0000-0000-0000000000b3\''
\set poA    '\'b0000000-0000-0000-0000-00000000000a\''
\set poB    '\'b0000000-0000-0000-0000-00000000000c\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr@att.test', '{}'::jsonb),
  (:viewer, 'view@att.test', '{}'::jsonb),
  (:gview, 'gview@att.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'Att Org A', 'att-org-a'),
  (:orgB, 'Att Org B', 'att-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr, 'manager', now()),
  (:orgA, :viewer, 'viewer', now()),
  (:orgA, :gview, 'viewer', now());
insert into public.purchase_orders (id, organization_id, po_number) values
  (:poA, :orgA, 'PO-ATT-A'),
  (:poB, :orgB, 'PO-ATT-B');
-- Grant gview purchase_orders:manage via a per-user override.
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  values (:orgA, :gview, 'purchase_orders:manage', true);

-- ── Bucket is size-capped ──────────────────────────────────────────────────
select is(
  (select file_size_limit from storage.buckets where id = 'po-attachments'),
  (15 * 1024 * 1024)::bigint,
  'po-attachments bucket has a 15MB file size limit'
);

-- ── Viewer (member, no manage) ─────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'b0000000-0000-0000-0000-0000000000b2'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.po_attachments (organization_id, purchase_order_id, storage_path)
       values ('ba000000-0000-0000-0000-0000000000ba','b0000000-0000-0000-0000-00000000000a','ba000000-0000-0000-0000-0000000000ba/x/f.pdf') $$,
  '42501', null,
  'viewer without purchase_orders:manage cannot insert a po_attachment'
);
reset role;

-- ── Manager can write + read ───────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'b0000000-0000-0000-0000-0000000000b1'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.po_attachments (organization_id, purchase_order_id, storage_path)
       values ('ba000000-0000-0000-0000-0000000000ba','b0000000-0000-0000-0000-00000000000a','ba000000-0000-0000-0000-0000000000ba/x/mgr.pdf') $$,
  'manager can insert a po_attachment'
);
-- Cross-org FK guard: manager of orgA cannot reference orgB's PO.
select throws_ok(
  $$ insert into public.po_attachments (organization_id, purchase_order_id, storage_path)
       values ('ba000000-0000-0000-0000-0000000000ba','b0000000-0000-0000-0000-00000000000c','ba000000-0000-0000-0000-0000000000ba/x/xtenant.pdf') $$,
  '42501', null,
  'cannot attach to another org''s PO (purchase_order_in_org guard)'
);
reset role;

-- ── Granted viewer (purchase_orders:manage via override) can write ─────────
set local "request.jwt.claim.sub" to 'b0000000-0000-0000-0000-0000000000b3'; -- gview
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.po_attachments (organization_id, purchase_order_id, storage_path)
       values ('ba000000-0000-0000-0000-0000000000ba','b0000000-0000-0000-0000-00000000000a','ba000000-0000-0000-0000-0000000000ba/x/gview.pdf') $$,
  'viewer GRANTED purchase_orders:manage can insert a po_attachment'
);
reset role;

-- ── Any org member can READ the org's attachments ──────────────────────────
set local "request.jwt.claim.sub" to 'b0000000-0000-0000-0000-0000000000b2'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select ok(
  (select count(*) from public.po_attachments
     where organization_id = 'ba000000-0000-0000-0000-0000000000ba') >= 2,
  'a plain viewer can READ the org''s po_attachments'
);
-- …but DELETE is RLS-filtered to a no-op (the delete policy needs manage, so the
-- rows aren't visible to the viewer's DELETE — it removes nothing, no error).
delete from public.po_attachments where organization_id = 'ba000000-0000-0000-0000-0000000000ba';
select ok(
  (select count(*) from public.po_attachments
     where organization_id = 'ba000000-0000-0000-0000-0000000000ba') >= 2,
  'viewer DELETE is a no-op — rows survive (only manage can delete)'
);
reset role;

select * from finish();
rollback;
