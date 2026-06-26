-- supabase/tests/0208_po_write_has_permission.test.sql
-- Proves migration 0208: the PO write surface honors
-- has_permission('purchase_orders:manage'), so a granted viewer can create +
-- import POs, while ungranted viewers stay denied, managers keep access, the
-- FK-org-consistency guards still hold, and a user-level revoke overrides a
-- role-level grant.

begin;
select plan(7);

\set org_id    '\'fa000000-0000-0000-0000-0000000000fa\''
\set org2_id   '\'fb000000-0000-0000-0000-0000000000fb\''
\set mgr_id    '\'fc000000-0000-0000-0000-00000000000c\''
\set view_id   '\'fd000000-0000-0000-0000-00000000000d\''
\set sup2_id   '\'f5000000-0000-0000-0000-000000000052\''

-- Fixtures (superuser — RLS bypassed).
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr_id,  'mgr@po.test',  '{}'::jsonb),
  (:view_id, 'view@po.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:org_id,  'PO Test Org',  'po-test-org'),
  (:org2_id, 'PO Other Org', 'po-other-org');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org_id, :mgr_id,  'manager', now()),
  (:org_id, :view_id, 'viewer',  now());
-- A supplier owned by the OTHER org (for the cross-tenant guard test).
insert into public.suppliers (id, organization_id, name) values
  (:sup2_id, :org2_id, 'Other Org Supplier');

-- ── 1. Viewer WITHOUT a grant cannot create a PO ───────────────────────────
set local "request.jwt.claim.sub" to 'fd000000-0000-0000-0000-00000000000d'; -- viewer
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.purchase_orders (organization_id, po_number)
       values ('fa000000-0000-0000-0000-0000000000fa', 'PO-VIEW-NOGRANT') $$,
  '42501', null,
  'viewer without grant is RLS-denied from creating a purchase_order'
);
select throws_ok(
  $$ insert into public.po_imports
       (organization_id, uploaded_by, source_type, file_name, file_mime_type, file_size, storage_path, sha256)
       values ('fa000000-0000-0000-0000-0000000000fa', 'fd000000-0000-0000-0000-00000000000d',
               'pdf', 'po.pdf', 'application/pdf', 100, 'org/po.pdf', 'deadbeef') $$,
  '42501', null,
  'viewer without grant is RLS-denied from creating a po_import'
);
reset role;

-- ── 2. Manager keeps access (no regression) ────────────────────────────────
set local "request.jwt.claim.sub" to 'fc000000-0000-0000-0000-00000000000c'; -- manager
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  $$ insert into public.purchase_orders (organization_id, po_number)
       values ('fa000000-0000-0000-0000-0000000000fa', 'PO-MGR') $$,
  'manager can still create a purchase_order'
);
reset role;

-- ── Grant the viewer purchase_orders:manage via a role override ────────────
insert into public.role_permission_overrides (organization_id, role, permission, granted)
  values (:org_id, 'viewer', 'purchase_orders:manage', true);

set local "request.jwt.claim.sub" to 'fd000000-0000-0000-0000-00000000000d'; -- viewer (now granted)
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ── 3+4. Granted viewer can create a PO and a po_import ────────────────────
select lives_ok(
  $$ insert into public.purchase_orders (organization_id, po_number)
       values ('fa000000-0000-0000-0000-0000000000fa', 'PO-VIEW-GRANTED') $$,
  'granted viewer CAN create a purchase_order'
);
select lives_ok(
  $$ insert into public.po_imports
       (organization_id, uploaded_by, source_type, file_name, file_mime_type, file_size, storage_path, sha256)
       values ('fa000000-0000-0000-0000-0000000000fa', 'fd000000-0000-0000-0000-00000000000d',
               'pdf', 'po2.pdf', 'application/pdf', 100, 'org/po2.pdf', 'cafef00d') $$,
  'granted viewer CAN create a po_import'
);

-- ── 5. Cross-tenant FK-org guard still holds for the granted viewer ────────
select throws_ok(
  $$ insert into public.purchase_orders (organization_id, po_number, supplier_id)
       values ('fa000000-0000-0000-0000-0000000000fa', 'PO-XTENANT',
               'f5000000-0000-0000-0000-000000000052') $$,
  '42501', null,
  'granted viewer still cannot reference another org''s supplier (FK-org guard intact)'
);
reset role;

-- ── 6. A user-level REVOKE overrides the role-level grant ──────────────────
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
  values (:org_id, :view_id, 'purchase_orders:manage', false);

set local "request.jwt.claim.sub" to 'fd000000-0000-0000-0000-00000000000d'; -- viewer (user-revoked)
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  $$ insert into public.purchase_orders (organization_id, po_number)
       values ('fa000000-0000-0000-0000-0000000000fa', 'PO-USERREVOKED') $$,
  '42501', null,
  'user-level revoke beats the role-level grant — viewer denied again'
);
reset role;

select * from finish();
rollback;
