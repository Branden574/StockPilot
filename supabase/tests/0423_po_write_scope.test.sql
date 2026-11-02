-- supabase/tests/0423_po_write_scope.test.sql
-- pgTAP proof for migration 0423 (docket S46): purchase order reads go by
-- purchase_orders_select alone, and purchase order writes stay inside the
-- writer's warehouses and need 'View purchase orders'.
--
-- Before 0423, purchase_orders_write was a FOR ALL policy whose USING was
-- "manager OR purchase_orders:manage". A FOR ALL USING also answers SELECT and
-- permissive policies OR together, so it overrode purchase_orders_select's
-- read-permission and warehouse rules (0322): a staff member or viewer holding
-- purchase_orders:manage read, and through the Data API changed, every
-- warehouse's purchase orders, and a manager or admin without
-- purchase_orders:read still read them all. 0423 splits it into INSERT and
-- UPDATE policies (the writer floor AND purchase_orders:read AND 0322's
-- warehouse rule, plus 0208's organization checks), splits
-- purchase_order_items_write into INSERT, UPDATE and DELETE policies that
-- need the parent purchase order readable by the caller, and makes
-- next_po_number SECURITY DEFINER with its own gate, so PO numbers still
-- count every purchase order of the organization once reads narrow.
--
-- Run against the schema without it (head 0415, scratch stack, 2026-11-02)
-- it fails 21 of its 32: every check of what 0423 changes (C1-C3, R2-R4,
-- W1-W3, W5-W8, L1, L2, N2, S1, S2, RC4), C4 (no new policy and no comment)
-- and IMP1 (there the approver still reads the purchase order the import
-- created, through the FOR ALL policy). The docket's four failing tests are
-- R2 (reads outside the warehouse), W6 (cancel and place), W7 (insert) and R4
-- (the read revoke). What passes there too is meant to: the fixture (F1),
-- what 0423 keeps (R1, R5, R6, W4, N1, RC1-RC3, IMP2) and C5 (no 0419 on
-- that head).
--
-- Personas (organization A with warehouses A1 and A2; organization B):
--   own        owner                       mgr       manager
--   mgrNoMan   manager, purchase_orders:manage revoked
--   mgrNoRd    manager, purchase_orders:read revoked
--   admNoRd    admin, purchase_orders:read revoked
--   stf        staff in A1 (default set: read, no manage)
--   stfMan     staff in A1 with a purchase_orders:manage override
--   vwrMan     viewer in A1 with a purchase_orders:manage override
--   stfManNoRd staff in A1 with manage granted and read revoked
--   loneMan    staff in no warehouse with a purchase_orders:manage override
--   bAdm       admin of organization B only
-- Purchase orders of A: A1 (to a place in A1), A2 (to a place in A2), ND (no
-- destination), OL (to a place in no warehouse), D1 and D2 (drafts to A1 and
-- A2); one more in B.
--
-- C.   The catalog: no FOR ALL policy on either table, the exact policy set,
--      next_po_number's posture, the comments, and F1's run-policy comment
--      when 0419 is in.
-- R.   Reads: purchase_orders_select alone decides.
-- W.   Purchase order writes: update, redirect, cancel and place, insert.
-- L.   Line writes follow the parent purchase order.
-- N.   next_po_number counts every purchase order for a writer; a non-writer
--      gets 42501.
-- S.   save_purchase_order_draft end to end (it is SECURITY INVOKER).
-- RC.  Receiving: managers still post and reverse; a manager without read
--      gets po_not_found.
-- IMP. PO-import approval (approve_po_import_commit, SECURITY DEFINER) still
--      creates a purchase order outside the approver's warehouses and without
--      purchase_orders:read. 0423 does not close that path (docket S46b);
--      IMP1 pins it so the fix flips it on purpose.
--
-- Roles: fixtures as the test superuser. Every attempt runs through pg_temp.u
-- or pg_temp.imp (always undone), which switch role and claims with
-- set_config inside a subtransaction, so pgTAP's own statements never run as
-- an API role. begin/rollback: nothing leaks. Namespace 04230000.

begin;

select plan(32);

\set orgA       '\'04230000-0000-0000-0000-0000000000a0\''
\set orgB       '\'04230000-0000-0000-0000-0000000000b0\''
\set whA1       '\'04230000-0000-0000-0000-0000000001a1\''
\set whA2       '\'04230000-0000-0000-0000-0000000001a2\''
\set whB1       '\'04230000-0000-0000-0000-0000000001b1\''
\set locA1      '\'04230000-0000-0000-0000-0000000002a1\''
\set locA2      '\'04230000-0000-0000-0000-0000000002a2\''
\set locOrg     '\'04230000-0000-0000-0000-0000000002a9\''
\set locB1      '\'04230000-0000-0000-0000-0000000002b1\''
\set itA1       '\'04230000-0000-0000-0000-0000000003a1\''
\set itA2       '\'04230000-0000-0000-0000-0000000003a2\''
\set poA1       '\'04230000-0000-0000-0000-0000000004a1\''
\set poA2       '\'04230000-0000-0000-0000-0000000004a2\''
\set poND       '\'04230000-0000-0000-0000-0000000004a3\''
\set poOL       '\'04230000-0000-0000-0000-0000000004a4\''
\set drA1       '\'04230000-0000-0000-0000-0000000004d1\''
\set drA2       '\'04230000-0000-0000-0000-0000000004d2\''
\set poB1       '\'04230000-0000-0000-0000-0000000004b1\''
\set lnA1       '\'04230000-0000-0000-0000-0000000005a1\''
\set lnA2       '\'04230000-0000-0000-0000-0000000005a2\''
\set lnD1       '\'04230000-0000-0000-0000-0000000005d1\''
\set lnD2       '\'04230000-0000-0000-0000-0000000005d2\''
\set supA       '\'04230000-0000-0000-0000-0000000006a1\''
\set impA2      '\'04230000-0000-0000-0000-0000000007a2\''
\set impLn      '\'04230000-0000-0000-0000-0000000008a2\''
\set own        '\'04230000-0000-0000-0000-000000000901\''
\set mgr        '\'04230000-0000-0000-0000-000000000902\''
\set stf        '\'04230000-0000-0000-0000-000000000903\''
\set stfMan     '\'04230000-0000-0000-0000-000000000904\''
\set vwrMan     '\'04230000-0000-0000-0000-000000000905\''
\set mgrNoRd    '\'04230000-0000-0000-0000-000000000906\''
\set admNoRd    '\'04230000-0000-0000-0000-000000000907\''
\set stfManNoRd '\'04230000-0000-0000-0000-000000000908\''
\set loneMan    '\'04230000-0000-0000-0000-000000000909\''
\set mgrNoMan   '\'04230000-0000-0000-0000-00000000090a\''
\set bAdm       '\'04230000-0000-0000-0000-00000000090b\''

-- Runs p_sql as p_role with claim sub p_sub, then ALWAYS undoes it.
-- 'ok:<value or row count>' or 'err:<SQLSTATE>'.
create function pg_temp.u(p_sub uuid, p_sql text, p_role text default 'authenticated')
returns text language plpgsql as $$
declare v text; n bigint; st text; msg text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_role, true);
    perform set_config('role', p_role, true);
    if p_sql ~* '^\s*(select|with)\M' then
      execute p_sql into v;
    else
      execute p_sql;
      get diagnostics n = row_count;
      v := n::text;
    end if;
    raise exception using errcode = 'XX499', message = coalesce(v, 'null');
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    if st = 'XX499' then return 'ok:' || msg; end if;
    return 'err:' || st;
  end;
end $$;

-- Which of organization A's six purchase orders the caller reads (labels, sorted).
create function pg_temp.seen_q() returns text language sql as $q$
  select format($f$select coalesce(string_agg(t.l, ',' order by t.l), '')
                     from public.purchase_orders po
                     join (values (%L::uuid, 'A1'), (%L::uuid, 'A2'), (%L::uuid, 'ND'),
                                  (%L::uuid, 'OL'), (%L::uuid, 'D1'), (%L::uuid, 'D2')) t(id, l)
                       on t.id = po.id$f$,
    '04230000-0000-0000-0000-0000000004a1', '04230000-0000-0000-0000-0000000004a2',
    '04230000-0000-0000-0000-0000000004a3', '04230000-0000-0000-0000-0000000004a4',
    '04230000-0000-0000-0000-0000000004d1', '04230000-0000-0000-0000-0000000004d2')
$q$;

create function pg_temp.notes_q(p_po uuid) returns text language sql as $q$
  select format('update public.purchase_orders set notes = %L where id = %L', 'po scope probe', p_po)
$q$;
create function pg_temp.dest_q(p_po uuid, p_loc uuid) returns text language sql as $q$
  select format('update public.purchase_orders set destination_location_id = %L where id = %L', p_loc, p_po)
$q$;
create function pg_temp.status_q(p_po uuid, p_status text) returns text language sql as $q$
  select format('update public.purchase_orders set status = %L where id = %L', p_status, p_po)
$q$;
create function pg_temp.ins_q(p_loc uuid, p_returning boolean default false) returns text language sql as $q$
  select format('insert into public.purchase_orders (organization_id, po_number, status, destination_location_id) values (%L, %L, %L, %L)',
                '04230000-0000-0000-0000-0000000000a0', 'PO-SCOPE-NEW', 'draft', p_loc)
         || case when p_returning then ' returning id' else '' end
$q$;
create function pg_temp.line_ins_q(p_po uuid) returns text language sql as $q$
  select format('insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost) values (%L, %L, %L, 1, 1)',
                '04230000-0000-0000-0000-0000000000a0', p_po, '04230000-0000-0000-0000-0000000003a1')
$q$;
create function pg_temp.line_del_q(p_po uuid) returns text language sql as $q$
  select format('delete from public.purchase_order_items where purchase_order_id = %L', p_po)
$q$;
create function pg_temp.num_q() returns text language sql as $q$
  select format('select public.next_po_number(%L)', '04230000-0000-0000-0000-0000000000a0')
$q$;
-- save_purchase_order_draft as the app calls it; answers 'ok:saved' or the error.
create function pg_temp.save_q(p_po uuid, p_loc uuid, p_number text) returns text language sql as $q$
  select format($f$select case when (public.save_purchase_order_draft(%L, %L, %L, null, %L, null, null, %L, %L::jsonb)) ->> 'id' is not null then 'saved' else 'no id' end$f$,
                '04230000-0000-0000-0000-0000000000a0', p_po, p_number, p_loc, 'po scope probe',
                jsonb_build_array(jsonb_build_object('item_id', '04230000-0000-0000-0000-0000000003a1',
                                                     'quantity_ordered', 1, 'unit_cost', 1))::text)
$q$;
-- The same with the number next_po_number draws for the caller (the app's create path).
create function pg_temp.save_drawn_q(p_loc uuid) returns text language sql as $q$
  select format($f$select case when (public.save_purchase_order_draft(%L, null, public.next_po_number(%L), null, %L, null, null, %L, %L::jsonb)) ->> 'id' is not null then 'saved' else 'no id' end$f$,
                '04230000-0000-0000-0000-0000000000a0', '04230000-0000-0000-0000-0000000000a0', p_loc, 'po scope probe',
                jsonb_build_array(jsonb_build_object('item_id', '04230000-0000-0000-0000-0000000003a1',
                                                     'quantity_ordered', 1, 'unit_cost', 1))::text)
$q$;
create function pg_temp.post_q(p_po uuid, p_wh uuid, p_line uuid, p_key text) returns text language sql as $q$
  select format($f$select (public.post_receipt_v2(%L, %L, %L::jsonb, %L, %L)).id::text$f$,
                p_po, p_wh,
                jsonb_build_array(jsonb_build_object('po_line_id', p_line, 'qty_received', 1, 'qty_accepted', 1,
                                                     'qty_rejected', 0, 'unit_cost', 1))::text,
                p_key, 'hash-' || p_key)
$q$;
create function pg_temp.post_reverse_q(p_po uuid, p_wh uuid, p_line uuid, p_key text) returns text language sql as $q$
  select format($f$select (public.reverse_receipt((public.post_receipt_v2(%L, %L, %L::jsonb, %L, %L)).id, 'po scope probe')).id::text$f$,
                p_po, p_wh,
                jsonb_build_array(jsonb_build_object('po_line_id', p_line, 'qty_received', 1, 'qty_accepted', 1,
                                                     'qty_rejected', 0, 'unit_cost', 1))::text,
                p_key, 'hash-' || p_key)
$q$;

-- ── Fixtures (superuser) ────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:own, 'po-scope-own@example.test', '{}'::jsonb), (:mgr, 'po-scope-mgr@example.test', '{}'::jsonb),
  (:stf, 'po-scope-stf@example.test', '{}'::jsonb), (:stfMan, 'po-scope-stfman@example.test', '{}'::jsonb),
  (:vwrMan, 'po-scope-vwrman@example.test', '{}'::jsonb), (:mgrNoRd, 'po-scope-mgrnord@example.test', '{}'::jsonb),
  (:admNoRd, 'po-scope-admnord@example.test', '{}'::jsonb), (:stfManNoRd, 'po-scope-stfmannord@example.test', '{}'::jsonb),
  (:loneMan, 'po-scope-loneman@example.test', '{}'::jsonb), (:mgrNoMan, 'po-scope-mgrnoman@example.test', '{}'::jsonb),
  (:bAdm, 'po-scope-badm@example.test', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, 'PO Scope Probe A', 'po-scope-probe-a'), (:orgB, 'PO Scope Probe B', 'po-scope-probe-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own, 'owner', now()), (:orgA, :mgr, 'manager', now()),
  (:orgA, :stf, 'staff', now()), (:orgA, :stfMan, 'staff', now()),
  (:orgA, :vwrMan, 'viewer', now()), (:orgA, :mgrNoRd, 'manager', now()),
  (:orgA, :admNoRd, 'admin', now()), (:orgA, :stfManNoRd, 'staff', now()),
  (:orgA, :loneMan, 'staff', now()), (:orgA, :mgrNoMan, 'manager', now()),
  (:orgB, :bAdm, 'admin', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'receiving', true, 'optional', '{}'::jsonb), (:orgA, 'purchase_orders', true, 'optional', '{}'::jsonb),
  (:orgA, 'po_imports', true, 'optional', '{}'::jsonb),
  (:orgB, 'receiving', true, 'optional', '{}'::jsonb), (:orgB, 'purchase_orders', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = excluded.enabled;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'PO Scope A1', 'POSCA1', 'active'), (:whA2, :orgA, 'PO Scope A2', 'POSCA2', 'active'),
  (:whB1, :orgB, 'PO Scope B1', 'POSCB1', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf, :whA1, true), (:orgA, :stfMan, :whA1, true), (:orgA, :vwrMan, :whA1, true),
  (:orgA, :stfManNoRd, :whA1, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfMan, 'purchase_orders:manage', true),
  (:orgA, :vwrMan, 'purchase_orders:manage', true),
  (:orgA, :mgrNoRd, 'purchase_orders:read', false),
  (:orgA, :admNoRd, 'purchase_orders:read', false),
  (:orgA, :stfManNoRd, 'purchase_orders:manage', true),
  (:orgA, :stfManNoRd, 'purchase_orders:read', false),
  (:orgA, :loneMan, 'purchase_orders:manage', true),
  (:orgA, :mgrNoMan, 'purchase_orders:manage', false);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locA1, :orgA, :whA1, 'PO Scope Bin A1', 'bin', null),
  (:locA2, :orgA, :whA2, 'PO Scope Bin A2', 'bin', null),
  (:locOrg, :orgA, null, 'PO Scope Org Site', 'warehouse', null),
  (:locB1, :orgB, :whB1, 'PO Scope Bin B1', 'bin', null);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itA1, :orgA, :whA1, 'PO-SCOPE-A1', 'PO scope item A1', 0, 'active', 'none'),
  (:itA2, :orgA, :whA2, 'PO-SCOPE-A2', 'PO scope item A2', 0, 'active', 'none');
-- Numbered the way next_po_number numbers them (count + 1), in creation order.
insert into public.purchase_orders (id, organization_id, po_number, status, destination_location_id) values
  (:poA1, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-0001', 'ordered', :locA1),
  (:poA2, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-0002', 'ordered', :locA2),
  (:poND, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-0003', 'ordered', null),
  (:poOL, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-0004', 'ordered', :locOrg),
  (:drA1, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-0005', 'draft',   :locA1),
  (:drA2, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-0006', 'draft',   :locA2),
  (:poB1, :orgB, 'PO-' || to_char(now(), 'YYYY') || '-0001', 'ordered', :locB1);
insert into public.purchase_order_items (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:lnA1, :orgA, :poA1, :itA1, 10, 0, 1),
  (:lnA2, :orgA, :poA2, :itA2, 10, 0, 1),
  (:lnD1, :orgA, :drA1, :itA1, 10, 0, 1),
  (:lnD2, :orgA, :drA2, :itA2, 10, 0, 1);
-- A parsed import for warehouse A2, with one line (section IMP).
insert into public.suppliers (id, organization_id, name) values (:supA, :orgA, 'PO Scope Supplier A');
insert into public.po_imports (id, organization_id, uploaded_by, source_type, file_name, file_mime_type,
                               file_size, storage_path, sha256, status, warehouse_id) values
  (:impA2, :orgA, :mgr, 'pdf', 'po-scope-a2.pdf', 'application/pdf', 1, 'org/po-scope-a2.pdf', 'sha-po-scope-a2', 'parsed', :whA2);
insert into public.po_import_lines (id, po_import_id, line_number, line_type, qty_ordered_original, unit_cost, line_total, description) values
  (:impLn, :impA2, 1, 'inventory', 1, 1, 1, 'PO scope import line');

-- Approves the A2 import as p_sub, then counts the new purchase order as p_sub
-- sees it; ALWAYS undone. 'ok:created|<rows visible to the caller>' or
-- 'err:<SQLSTATE>'.
create function pg_temp.imp(p_sub uuid) returns text language plpgsql as $f$
declare v_id uuid; n int; st text; msg text;
begin
  begin
    perform set_config('request.jwt.claim.sub', p_sub::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('role', 'authenticated', true);
    v_id := public.approve_po_import_commit(
      '04230000-0000-0000-0000-0000000007a2', 'PO-SCOPE-IMP-1', '04230000-0000-0000-0000-0000000006a1',
      '04230000-0000-0000-0000-0000000002a2', null, null, 'po scope import',
      jsonb_build_array(jsonb_build_object('line_id', '04230000-0000-0000-0000-0000000008a2',
                                           'item_id', '04230000-0000-0000-0000-0000000003a2',
                                           'line_type', 'inventory')));
    select count(*) into n from public.purchase_orders where id = v_id;
    raise exception using errcode = 'XX499', message = 'created|' || n;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    if st = 'XX499' then return 'ok:' || msg; end if;
    return 'err:' || st;
  end;
end $f$;

select is((select count(*)::int from public.purchase_orders where organization_id = :orgA), 6,
  'F1: organization A holds six purchase orders');

-- ═══ C. The catalog ═════════════════════════════════════════════════════════
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
      and tablename in ('purchase_orders', 'purchase_order_items') and cmd = 'ALL'),
  0, 'C1: no FOR ALL policy is left on purchase_orders or purchase_order_items (INV-35 shape)');
select is(
  (select string_agg(tablename || '.' || policyname || ':' || cmd, ',' order by tablename collate "C", policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename in ('purchase_orders', 'purchase_order_items')),
  'purchase_order_items.purchase_order_items_delete:DELETE,purchase_order_items.purchase_order_items_insert:INSERT,purchase_order_items.purchase_order_items_select:SELECT,purchase_order_items.purchase_order_items_update:UPDATE,purchase_orders.purchase_orders_insert:INSERT,purchase_orders.purchase_orders_select:SELECT,purchase_orders.purchase_orders_update:UPDATE',
  'C2: the policy set: SELECT, INSERT and UPDATE on purchase_orders (DELETE stays revoked), and SELECT, INSERT, UPDATE and DELETE on purchase_order_items');
select is(
  (select p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|'
          || has_function_privilege('anon', p.oid, 'execute')::text || '|'
          || has_function_privilege('authenticated', p.oid, 'execute')::text || '|'
          || has_function_privilege('service_role', p.oid, 'execute')::text
     from pg_proc p where p.oid = 'public.next_po_number(uuid)'::regprocedure),
  'true|{search_path=public}|false|true|true',
  'C3: next_po_number is SECURITY DEFINER with search_path pinned; no anon EXECUTE; authenticated and service_role keep it');

-- ═══ R. Reads ═══════════════════════════════════════════════════════════════
select is(pg_temp.u(:own, pg_temp.seen_q()) || ' ' || pg_temp.u(:mgr, pg_temp.seen_q()) || ' ' || pg_temp.u(:mgrNoMan, pg_temp.seen_q()),
  'ok:A1,A2,D1,D2,ND,OL ok:A1,A2,D1,D2,ND,OL ok:A1,A2,D1,D2,ND,OL',
  'R1: the owner, a manager and a manager without purchase_orders:manage read all six');
select is(pg_temp.u(:stf, pg_temp.seen_q()) || ' ' || pg_temp.u(:stfMan, pg_temp.seen_q()) || ' ' || pg_temp.u(:vwrMan, pg_temp.seen_q()),
  'ok:A1,D1,ND,OL ok:A1,D1,ND,OL ok:A1,D1,ND,OL',
  'R2: staff in A1 with or without purchase_orders:manage, and a viewer in A1 with it, read A1''s purchase orders and the two with no warehouse, never A2''s');
select is(pg_temp.u(:loneMan, pg_temp.seen_q()),
  'ok:ND,OL',
  'R3: staff in no warehouse holding purchase_orders:manage read only the two purchase orders with no warehouse');
select is(pg_temp.u(:mgrNoRd, pg_temp.seen_q()) || ' ' || pg_temp.u(:admNoRd, pg_temp.seen_q()) || ' ' || pg_temp.u(:stfManNoRd, pg_temp.seen_q()),
  'ok: ok: ok:',
  'R4: a manager or admin without purchase_orders:read, and staff holding manage without read, read no purchase order');
select is(pg_temp.u(:bAdm, pg_temp.seen_q()), 'ok:',
  'R5: another organization''s admin reads none of organization A''s purchase orders');
select is(pg_temp.u(:stfMan, format('select count(*)::text from public.purchase_order_items where id = %L', :lnD2)),
  'ok:1',
  'R6 (unchanged by 0423, docket S10 5.1): purchase order lines stay readable by any member, A2''s draft line included');

-- ═══ W. Purchase order writes ═══════════════════════════════════════════════
select is(pg_temp.u(:stfMan, pg_temp.notes_q(:poA1)) || ' ' || pg_temp.u(:stfMan, pg_temp.notes_q(:poA2)) || ' '
          || pg_temp.u(:stfMan, pg_temp.notes_q(:poND)) || ' ' || pg_temp.u(:stfMan, pg_temp.notes_q(:poOL)),
  'ok:1 ok:0 ok:1 ok:1',
  'W1: staff holding manage update A1''s purchase order and the two with no warehouse, and match 0 rows on A2''s');
select is(pg_temp.u(:vwrMan, pg_temp.notes_q(:poA1)) || ' ' || pg_temp.u(:vwrMan, pg_temp.notes_q(:poA2)) || ' '
          || pg_temp.u(:loneMan, pg_temp.notes_q(:poA1)) || ' ' || pg_temp.u(:loneMan, pg_temp.notes_q(:poND)),
  'ok:1 ok:0 ok:0 ok:1',
  'W2: the viewer holding manage as the staff member; the manage holder in no warehouse only the purchase order with no destination');
select is(pg_temp.u(:mgrNoRd, pg_temp.notes_q(:poA1)) || ' ' || pg_temp.u(:admNoRd, pg_temp.notes_q(:poA1)) || ' '
          || pg_temp.u(:stfManNoRd, pg_temp.notes_q(:poA1)) || ' ' || pg_temp.u(:stf, pg_temp.notes_q(:poA1)),
  'ok:0 ok:0 ok:0 ok:0',
  'W3: without purchase_orders:read, or without manage below manager, an update matches 0 rows');
select is(pg_temp.u(:mgr, pg_temp.notes_q(:poA2)) || ' ' || pg_temp.u(:mgrNoMan, pg_temp.notes_q(:poA2)) || ' ' || pg_temp.u(:own, pg_temp.notes_q(:poA2)),
  'ok:1 ok:1 ok:1',
  'W4: managers (with or without purchase_orders:manage) and the owner update any purchase order');
select is(pg_temp.u(:stfMan, pg_temp.dest_q(:drA1, :locA2)) || ' ' || pg_temp.u(:stfMan, pg_temp.dest_q(:drA1, :locOrg)) || ' '
          || pg_temp.u(:stfMan, pg_temp.dest_q(:drA1, null)) || ' ' || pg_temp.u(:mgr, pg_temp.dest_q(:drA1, :locA2)),
  'err:42501 ok:1 ok:1 ok:1',
  'W5: staff holding manage cannot point their purchase order at A2 (42501), and may point it at a place in no warehouse or at none; a manager may point it at A2');
select is(pg_temp.u(:stfMan, pg_temp.status_q(:poA2, 'cancelled')) || ' ' || pg_temp.u(:stfMan, pg_temp.status_q(:drA2, 'ordered')) || ' '
          || pg_temp.u(:stfMan, pg_temp.status_q(:drA1, 'ordered')) || ' ' || pg_temp.u(:stfMan, pg_temp.status_q(:poA1, 'cancelled')),
  'ok:0 ok:0 ok:1 ok:1',
  'W6: staff holding manage cannot cancel or place A2''s purchase orders (0 rows), and still place and cancel A1''s');
select is(pg_temp.u(:stfMan, pg_temp.ins_q(:locA2)) || ' ' || pg_temp.u(:stfMan, pg_temp.ins_q(:locA1)) || ' '
          || pg_temp.u(:stfMan, pg_temp.ins_q(null)) || ' ' || pg_temp.u(:stfMan, pg_temp.ins_q(:locOrg)) || ' '
          || pg_temp.u(:stfMan, pg_temp.ins_q(:locA1, true)),
  'err:42501 ok:1 ok:1 ok:1 ok:1',
  'W7: staff holding manage cannot create a draft for A2, and can for A1, with no destination, for a place in no warehouse, and with RETURNING');
select is(pg_temp.u(:vwrMan, pg_temp.ins_q(:locA2)) || ' ' || pg_temp.u(:vwrMan, pg_temp.ins_q(:locA1)) || ' '
          || pg_temp.u(:mgrNoRd, pg_temp.ins_q(null)) || ' ' || pg_temp.u(:stfManNoRd, pg_temp.ins_q(null)) || ' '
          || pg_temp.u(:stf, pg_temp.ins_q(null)) || ' ' || pg_temp.u(:mgr, pg_temp.ins_q(:locA2)),
  'err:42501 ok:1 err:42501 err:42501 err:42501 ok:1',
  'W8: the viewer holding manage as staff (A1 yes, A2 no); without read, or without manage below manager, refused; a manager anywhere');

-- ═══ L. Line writes ═════════════════════════════════════════════════════════
select is(pg_temp.u(:stfMan, pg_temp.line_ins_q(:drA2)) || ' ' || pg_temp.u(:stfMan, pg_temp.line_ins_q(:drA1)) || ' '
          || pg_temp.u(:stfMan, pg_temp.line_del_q(:drA2)) || ' ' || pg_temp.u(:stfMan, pg_temp.line_del_q(:drA1)),
  'err:42501 ok:1 ok:0 ok:1',
  'L1: staff holding manage cannot add a line to, or delete the lines of, A2''s draft; A1''s still work');
select is(pg_temp.u(:mgr, pg_temp.line_ins_q(:drA2)) || ' ' || pg_temp.u(:mgrNoRd, pg_temp.line_ins_q(:drA1)) || ' '
          || pg_temp.u(:stf, pg_temp.line_ins_q(:drA1)),
  'ok:1 err:42501 err:42501',
  'L2: a manager adds a line anywhere; without read, or without manage below manager, refused');

-- ═══ N. Numbering ═══════════════════════════════════════════════════════════
select is(pg_temp.u(:stfMan, pg_temp.num_q()) || ' ' || pg_temp.u(:mgr, pg_temp.num_q()) || ' ' || pg_temp.u(:vwrMan, pg_temp.num_q()) || ' '
          || pg_temp.u(null, pg_temp.num_q(), 'service_role'),
  'ok:PO-' || to_char(now(), 'YYYY') || '-0007 ok:PO-' || to_char(now(), 'YYYY') || '-0007 ok:PO-' || to_char(now(), 'YYYY') || '-0007 ok:PO-' || to_char(now(), 'YYYY') || '-0007',
  'N1: next_po_number counts every purchase order of the organization for any writer and for the service role');
select is(pg_temp.u(:stf, pg_temp.num_q()) || ' ' || pg_temp.u(:bAdm, pg_temp.num_q()),
  'err:42501 err:42501',
  'N2: someone who may not write purchase orders in the organization gets 42501, so the definer count tells an outsider nothing');

-- ═══ S. save_purchase_order_draft ═══════════════════════════════════════════
select is(pg_temp.u(:stfMan, pg_temp.save_drawn_q(:locA1)) || ' ' || pg_temp.u(:stfMan, pg_temp.save_drawn_q(null)) || ' '
          || pg_temp.u(:stfMan, pg_temp.save_drawn_q(:locA2)),
  'ok:saved ok:saved err:42501',
  'S1: staff holding manage create a draft for A1, or with no destination, with a drawn number; A2 refused');
select is(pg_temp.u(:stfMan, pg_temp.save_q(:drA1, :locA1, 'PO-SCOPE-EDIT')) || ' ' || pg_temp.u(:stfMan, pg_temp.save_q(:drA2, :locA2, 'PO-SCOPE-EDIT')) || ' '
          || pg_temp.u(:mgr, pg_temp.save_q(:drA2, :locA2, 'PO-SCOPE-EDIT')) || ' ' || pg_temp.u(:mgrNoRd, pg_temp.save_drawn_q(null)),
  'ok:saved err:P0002 ok:saved err:42501',
  'S2: staff holding manage edit A1''s draft and do not find A2''s (P0002); a manager edits it; a manager without read cannot create');

-- ═══ RC. Receiving ═══════════════════════════════════════════════════════════
select is(pg_temp.u(:mgr, pg_temp.post_q(:poA2, :whA2, :lnA2, 'po-scope-k1')) ~ '^ok:[0-9a-f-]{36}$', true,
  'RC1: a manager still posts a receipt on A2''s purchase order');
select is(pg_temp.u(:mgrNoMan, pg_temp.post_q(:poA2, :whA2, :lnA2, 'po-scope-k2')) ~ '^ok:[0-9a-f-]{36}$', true,
  'RC2: a manager without purchase_orders:manage still posts (the manager arm of the update policy)');
select is(pg_temp.u(:mgr, pg_temp.post_reverse_q(:poA1, :whA1, :lnA1, 'po-scope-k3')) ~ '^ok:[0-9a-f-]{36}$', true,
  'RC3: a manager posts and reverses (recompute_po_status and the line update run as the caller)');
select is(pg_temp.u(:mgrNoRd, pg_temp.post_q(:poA1, :whA1, :lnA1, 'po-scope-k4')) || ' ' || pg_temp.u(:stfMan, pg_temp.post_q(:poA1, :whA1, :lnA1, 'po-scope-k5')),
  'err:P0002 err:42501',
  'RC4: a manager without purchase_orders:read gets po_not_found (P0002); staff holding manage are refused (managers only, as before)');

-- ═══ C (continued). Comments ════════════════════════════════════════════════
select is(
  (select string_agg(c.relname || '.' || pol.polname || ':' || (d.description is not null)::text, ','
                     order by c.relname collate "C", pol.polname collate "C")
     from pg_policy pol join pg_class c on c.oid = pol.polrelid
     left join pg_description d on d.objoid = pol.oid and d.classoid = 'pg_policy'::regclass
    where pol.polrelid in ('public.purchase_orders'::regclass, 'public.purchase_order_items'::regclass)
      and pol.polname <> all (array['purchase_orders_select', 'purchase_order_items_select']))
  || '|' || (obj_description('public.next_po_number(uuid)'::regprocedure, 'pg_proc') ~ 'SECURITY DEFINER since S46')::text,
  'purchase_order_items.purchase_order_items_delete:true,purchase_order_items.purchase_order_items_insert:true,purchase_order_items.purchase_order_items_update:true,purchase_orders.purchase_orders_insert:true,purchase_orders.purchase_orders_update:true|true',
  'C4: every new policy and next_po_number say what they are in their comments');
select is(
  case when to_regclass('public.checklist_runs') is null then 'no 0419'
       else (select (d.description ~ 'purchase_orders_select alone')::text || '|' || (d.description ~ 'purchase_orders_write')::text
               from pg_policy pol join pg_description d on d.objoid = pol.oid and d.classoid = 'pg_policy'::regclass
              where pol.polrelid = to_regclass('public.checklist_runs') and pol.polname = 'checklist_runs_select') end,
  case when to_regclass('public.checklist_runs') is null then 'no 0419' else 'true|false' end,
  'C5: with 0419 in, the receiving checklist''s run policy comment no longer names purchase_orders_write (without 0419 the file applies and skips it)');

-- ═══ IMP. PO-import approval (not closed by 0423) ═══════════════════════════
select is(pg_temp.imp(:stfMan) || ' ' || pg_temp.imp(:vwrMan) || ' ' || pg_temp.imp(:mgrNoRd) || ' ' || pg_temp.imp(:stfManNoRd),
  'ok:created|0 ok:created|0 ok:created|0 ok:created|0',
  'IMP1 (open after 0423, docket S46b): staff and a viewer in A1 holding manage, a manager without read and staff holding manage without read still create a receivable purchase order for A2 through approve_po_import_commit (SECURITY DEFINER; gate: member, po_imports and purchase_orders:manage; destination checked only with location_in_org), and cannot read it afterwards');
select is(pg_temp.imp(:mgr) || ' ' || pg_temp.imp(:stf) || ' ' || pg_temp.imp(:bAdm),
  'ok:created|1 err:42501 err:P0002',
  'IMP2: a manager creates and reads it; staff without manage are refused (42501); another organization gets po_import_not_found (P0002)');

select * from finish();
rollback;
