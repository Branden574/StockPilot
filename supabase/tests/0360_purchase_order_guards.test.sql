-- supabase/tests/0360_purchase_order_guards.test.sql
-- Proves migration 0360 (purchase-order guards, prepare step).
--
-- PART 1 (1-6)   Structure and grants.
-- PART 2 (7-24)  purchase_orders guard: the lifecycle, the approval threshold
--                checked against the PO's real value, amounts frozen after
--                draft, immutable columns, the ledger-flag and owner exemptions.
-- PART 3 (25-33) purchase_order_items guard: lines join only their own org's
--                PO and item, start unreceived, are never updated directly,
--                and leave only drafts.
-- PART 4 (34-50) approve_po_import_commit: amounts from the stored import
--                lines, charges built like buildPoCharges, the threshold, the
--                claim, and a failure rolling the claim back.
-- PART 5 (51-59) Review hardening: lines must be positive; negative lines
--                and charges never lower the threshold value; re-typing a
--                line as a discount cannot net an import under the gate; the
--                gate uses quantity x cost when it exceeds the line total;
--                negative import lines are refused; charge rounding and labels
--                match buildPoCharges; the real service_role is exempt.
--
-- Roles: the guards key on current_user, so writes run under
-- `set local role authenticated` with request.jwt.claim.sub. Closed grants
-- are asserted from the catalog.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(59);

\set orgA    '\'03600000-0000-0000-0000-00000000000a\''
\set orgB    '\'03600000-0000-0000-0000-00000000000b\''
\set u_mgr   '\'03600000-0000-0000-0000-0000000000a1\''
\set u_adm   '\'03600000-0000-0000-0000-0000000000a2\''
\set u_other '\'03600000-0000-0000-0000-0000000000a3\''
\set u_mgrB  '\'03600000-0000-0000-0000-0000000000b1\''
\set whA     '\'03600000-0000-0000-0000-0000000000c1\''
\set locA    '\'03600000-0000-0000-0000-0000000000c2\''
\set supA    '\'03600000-0000-0000-0000-0000000000c3\''
\set itemA   '\'03600000-0000-0000-0000-0000000000d1\''
\set itemB   '\'03600000-0000-0000-0000-0000000000d2\''
\set poSmall '\'03600000-0000-0000-0000-0000000000e1\''
\set poBig   '\'03600000-0000-0000-0000-0000000000e2\''
\set poOrd   '\'03600000-0000-0000-0000-0000000000e3\''
\set poRecv  '\'03600000-0000-0000-0000-0000000000e4\''
\set poCanc  '\'03600000-0000-0000-0000-0000000000e5\''
\set poB     '\'03600000-0000-0000-0000-0000000000e6\''
\set poOpen  '\'03600000-0000-0000-0000-0000000000e7\''
\set lnOrd   '\'03600000-0000-0000-0000-0000000000f1\''
\set lnSmall '\'03600000-0000-0000-0000-0000000000f2\''
\set imp1    '\'03600000-0000-0000-0000-000000000101\''
\set imp2    '\'03600000-0000-0000-0000-000000000102\''
\set imp3    '\'03600000-0000-0000-0000-000000000103\''
\set imp4    '\'03600000-0000-0000-0000-000000000104\''

-- ── Fixtures (as postgres) ──────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgr,   'mgr-0360@test.local',   '{}'::jsonb),
  (:u_adm,   'adm-0360@test.local',   '{}'::jsonb),
  (:u_other, 'other-0360@test.local', '{}'::jsonb),
  (:u_mgrB,  'mgrb-0360@test.local',  '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'PO Org A 0360', 'po-org-a-0360'),
  (:orgB, 'PO Org B 0360', 'po-org-b-0360');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_mgr,   'manager', now()),
  (:orgA, :u_adm,   'admin',   now()),
  (:orgA, :u_other, 'manager', now()),
  (:orgB, :u_mgrB,  'manager', now());

insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'purchase_orders', true, 'core', '{"approvalThresholdAmount": 1000}'::jsonb),
  (:orgA, 'po_imports',      true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update
  set enabled = true, settings = excluded.settings;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'PO WH A 0360', 'P0360A', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locA, :orgA, :whA, 'Dock A 0360', 'bin', 'rack');
insert into public.suppliers (id, organization_id, name) values
  (:supA, :orgA, 'Supplier A 0360');

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, status, item_type) values
  (:itemA, :orgA, :whA, 'P0360-A', 'PO item A', 'active', 'product');
insert into public.inventory_items (id, organization_id, sku, name, status, item_type) values
  (:itemB, :orgB, 'P0360-B', 'PO item B', 'active', 'product');

insert into public.purchase_orders (id, organization_id, po_number, status, supplier_id, subtotal, total) values
  (:poSmall, :orgA, 'PO-0360-S', 'draft',     :supA, 100, 100),
  (:poBig,   :orgA, 'PO-0360-B', 'draft',     :supA, 0,   0),     -- total zeroed; lines are worth 5000
  (:poOrd,   :orgA, 'PO-0360-O', 'ordered',   :supA, 50,  50),
  (:poRecv,  :orgA, 'PO-0360-R', 'received',  :supA, 10,  10),
  (:poCanc,  :orgA, 'PO-0360-C', 'cancelled', :supA, 10,  10),
  (:poB,     :orgB, 'PO-0360-X', 'draft',     null,  0,   0),
  -- Stays a draft throughout (poBig is placed in PART 2), so the PART 3 line
  -- checks meet the rule they test before 0364's draft-only rule.
  (:poOpen,  :orgA, 'PO-0360-OPEN', 'draft',     :supA, 0,   0);
insert into public.purchase_order_items (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:lnSmall, :orgA, :poSmall, :itemA, 1,  0, 100),
  (gen_random_uuid(), :orgA, :poBig, :itemA, 10, 0, 500),
  (:lnOrd,   :orgA, :poOrd,   :itemA, 5,  0, 10),
  (gen_random_uuid(), :orgA, :poRecv, :itemA, 1, 1, 10);

-- Import 1: two inventory lines and three charges (a positive discount the
-- builder must negate, a freight line carrying quantity x unit cost).
insert into public.po_imports (id, organization_id, uploaded_by, source_type, file_name, file_mime_type,
                               file_size, storage_path, sha256, status) values
  (:imp1, :orgA, :u_mgr, 'pdf', 'imp1.pdf', 'application/pdf', 1, 'org/imp1.pdf', 'sha-0360-1', 'parsed'),
  (:imp2, :orgA, :u_mgr, 'pdf', 'imp2.pdf', 'application/pdf', 1, 'org/imp2.pdf', 'sha-0360-2', 'parsed'),
  (:imp3, :orgA, :u_mgr, 'pdf', 'imp3.pdf', 'application/pdf', 1, 'org/imp3.pdf', 'sha-0360-3', 'needs_review'),
  (:imp4, :orgA, :u_mgr, 'pdf', 'imp4.pdf', 'application/pdf', 1, 'org/imp4.pdf', 'sha-0360-4', 'parsed');
insert into public.po_import_lines (id, po_import_id, line_number, line_type, qty_ordered_original, unit_cost, line_total, description) values
  ('03600000-0000-0000-0000-000000001101', :imp1, 1, 'inventory', 2, 10, 20,  'Widget'),
  ('03600000-0000-0000-0000-000000001102', :imp1, 2, 'inventory', 1, 5,  5,   'Gadget'),
  ('03600000-0000-0000-0000-000000001103', :imp1, 3, 'tax',       1, 2.5, 2.5, 'Sales tax'),
  ('03600000-0000-0000-0000-000000001104', :imp1, 4, 'discount',  1, 3,  3,   'Promo'),
  ('03600000-0000-0000-0000-000000001105', :imp1, 5, 'freight',   2, 4,  8,   'Shipping'),
  ('03600000-0000-0000-0000-000000001201', :imp2, 1, 'inventory', 1, 5,  5,   'Foreign'),
  ('03600000-0000-0000-0000-000000001301', :imp3, 1, 'inventory', 100, 20, 2000, 'Bulk'),
  ('03600000-0000-0000-0000-000000001401', :imp4, 1, 'inventory', 1, 5,  5,   'Dup number');

-- ═══ PART 1: structure and grants ═══════════════════════════════════════════
select is(
  array(select c.relname || ':' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where t.tgname in ('trg_zz_purchase_orders_guard', 'trg_zz_purchase_order_items_guard')
           and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
         order by 1),
  array['purchase_order_items:trg_zz_purchase_order_items_guard', 'purchase_orders:trg_zz_purchase_orders_guard'],
  '1: both guards are BEFORE ROW triggers');
select ok(
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
                 and p.proname in ('tg_purchase_orders_guard', 'tg_purchase_order_items_guard')),
  '2: both guard functions are SECURITY INVOKER');
select ok(
  not has_table_privilege('authenticated', 'public.purchase_orders', 'DELETE')
  and not has_table_privilege('authenticated', 'public.purchase_order_charges', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.purchase_order_charges', 'DELETE'),
  '3: no API role deletes a PO or edits or deletes its charges');
select ok(
  not exists (
    select 1 from unnest(array['purchase_orders', 'purchase_order_items', 'purchase_order_charges']) t,
                  unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) p
     where has_table_privilege('anon', 'public.' || t, p))
  and not exists (
    select 1 from unnest(array['purchase_orders', 'purchase_order_items', 'purchase_order_charges']) t,
                  unnest(array['TRUNCATE', 'TRIGGER', 'REFERENCES']) p
     where has_table_privilege('authenticated', 'public.' || t, p)),
  '4: anon writes nothing; authenticated holds no TRUNCATE, TRIGGER or REFERENCES');
select ok(
  has_function_privilege('authenticated', 'public.approve_po_import_commit(uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.po_over_approval_threshold(uuid, numeric)', 'execute')
  and has_function_privilege('authenticated', 'public.po_status_in_org(uuid, uuid)', 'execute'),
  '5: authenticated may call the import commit and the helpers the INVOKER guards use');
select ok(
  not has_function_privilege('authenticated', 'public._po_approval_threshold(uuid)', 'execute')
  and not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('approve_po_import_commit', 'po_over_approval_threshold', 'po_status_in_org', '_po_approval_threshold')
       and a.privilege_type = 'EXECUTE' and (a.grantee = 0 or a.grantee = 'anon'::regrole)),
  '6: the raw threshold stays internal; PUBLIC and anon call none of them');

-- ═══ PART 2: purchase_orders guard ══════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select lives_ok(
  format($$update public.purchase_orders set status = 'ordered', ordered_at = '2001-01-01' where id = %L$$, :poSmall),
  '7: a manager places a draft under the threshold');
select ok((select ordered_at > now() - interval '1 minute' from public.purchase_orders where id = :poSmall),
  '8: ... and ordered_at is stamped by the database, not the caller');
select throws_ok(
  format($$update public.purchase_orders set status = 'ordered' where id = %L$$, :poBig),
  '42501', 'This purchase order meets the approval threshold. Ask an owner or admin to place it.',
  '9: a draft whose TOTAL was zeroed but whose lines are worth 5000 still needs an admin');
select throws_ok(
  format($$update public.purchase_orders set status = 'received' where id = %L$$, :poOrd),
  '42501', 'Receiving statuses are set by posting receipts.',
  '10: a PO cannot be PATCHed to received');
select throws_ok(
  format($$update public.purchase_orders set status = 'expected_inbound' where id = %L$$, :poSmall),
  '42501', 'Receiving statuses are set by posting receipts.',
  '11: nor to expected_inbound');
select throws_ok(
  format($$update public.purchase_orders set status = 'ordered' where id = %L$$, :poCanc),
  '42501', 'This purchase order was cancelled and cannot be reopened. Create a new one instead.',
  '12: cancelled is terminal');
select throws_ok(
  format($$update public.purchase_orders set status = 'cancelled' where id = %L$$, :poRecv),
  '42501', 'A fully received purchase order cannot be cancelled.',
  '13: a fully received PO cannot be cancelled');
select throws_ok(
  format($$update public.purchase_orders set status = 'draft' where id = %L$$, :poRecv),
  '42501', 'Only an ordered purchase order with nothing received can go back to draft.',
  '14: a received PO cannot go back to draft');
select throws_ok(
  format($$update public.purchase_orders set total = 1 where id = %L$$, :poOrd),
  '42501', 'Only a draft purchase order''s supplier, charter and amounts can be edited.',
  '15: amounts are frozen once ordered');
select throws_ok(
  format($$update public.purchase_orders set received_at = now() where id = %L$$, :poOrd),
  '42501', 'Received dates are set by posting receipts.',
  '16: received_at cannot be forged');
select throws_ok(
  format($$update public.purchase_orders set ordered_at = '2001-01-01' where id = %L$$, :poOrd),
  '42501', 'The ordered date is set by marking the purchase order as ordered.',
  '17: nor ordered_at');
select throws_ok(
  format($$update public.purchase_orders set organization_id = %L where id = %L$$, :orgB, :poOrd),
  '42501', 'A purchase order''s organization and creator cannot be changed.',
  '18: nor the organization');
select lives_ok(
  format($$update public.purchase_orders set notes = 'call first', po_number = 'PO-0360-O2', updated_by = %L where id = %L$$, :u_other, :poOrd),
  '19: notes and the PO number stay editable after ordering');
select is((select updated_by from public.purchase_orders where id = :poOrd), :u_mgr::uuid,
  '20: ... and updated_by is the caller, whatever the request said');
select lives_ok(
  format($$update public.purchase_orders set status = 'cancelled' where id = %L$$, :poSmall),
  '21: an ordered PO can be cancelled');

-- The receipt RPCs run with the ledger flag and may set receiving statuses.
-- The flag holds the current transaction's id (0359: ledger.active()).
do $$ begin perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true); end $$;
select lives_ok(
  format($$update public.purchase_orders set status = 'partially_received' where id = %L$$, :poOrd),
  '22: with the ledger flag (inside a receipt RPC) the receiving status is written');
set local stockpilot.ledger to '';

set local "request.jwt.claim.sub" to :u_adm;
select lives_ok(
  format($$update public.purchase_orders set status = 'ordered' where id = %L$$, :poBig),
  '23: an admin places the over-threshold order');
reset role;
select lives_ok(
  format($$update public.purchase_orders set status = 'draft' where id = %L$$, :poCanc),
  '24: the table owner (crons as service_role, migrations) is not held to the API-role lifecycle');

-- ═══ PART 3: purchase_order_items guard ═════════════════════════════════════
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$update public.purchase_order_items set quantity_received = 5 where id = %L$$, :lnOrd),
  '42501', 'Purchase order lines change through the PO editor or by receiving.',
  '25: quantity_received cannot be PATCHed');
select throws_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
           values (%L, %L, %L, 1, 1)$$, :orgA, :poB, :itemA),
  '42501', 'That purchase order is not part of this organization.',
  '26: a line cannot be filed under another org''s PO');
select throws_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
           values (%L, %L, %L, 1, 1)$$, :orgA, :poOpen, :itemB),
  '42501', 'That item is not part of this organization.',
  '27: nor carry another org''s item');
select throws_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
           values (%L, %L, %L, 1, 1, 1)$$, :orgA, :poOpen, :itemA),
  '42501', 'A new purchase order line starts with nothing received.',
  '28: nor arrive already received');
select throws_ok(
  format($$delete from public.purchase_order_items where id = %L$$, :lnOrd),
  '42501', 'Lines can be removed only from a draft purchase order.',
  '29: a line cannot be removed from a PO past draft');
reset role;
insert into public.purchase_orders (id, organization_id, po_number, status) values
  ('03600000-0000-0000-0000-0000000000e9', :orgA, 'PO-0360-D', 'draft');
set local role to 'authenticated';
select lives_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
           values (%L, '03600000-0000-0000-0000-0000000000e9', %L, 2, 3)$$, :orgA, :itemA),
  '30: a line is added to this org''s draft');
select lives_ok(
  $$delete from public.purchase_order_items where purchase_order_id = '03600000-0000-0000-0000-0000000000e9'$$,
  '31: ... and removed from it (the draft editor''s full replace)');
-- The flag holds the current transaction's id (0359: ledger.active()).
do $$ begin perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true); end $$;
select lives_ok(
  format($$update public.purchase_order_items set quantity_received = 5 where id = %L$$, :lnOrd),
  '32: with the ledger flag (inside a receipt RPC) quantity_received is written');
set local stockpilot.ledger to '';
reset role;
select is((select quantity_received from public.purchase_order_items where id = :lnOrd), 5::numeric,
  '33: ... and only then');

-- ═══ PART 4: approve_po_import_commit ═══════════════════════════════════════
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';

create temp table t_po (id uuid) on commit drop;
grant all on t_po to authenticated;
insert into t_po
select public.approve_po_import_commit(
  :imp1, 'PO-0360-IMP1', :supA, :locA, null, null, 'Imported',
  jsonb_build_array(
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001101', 'item_id', :itemA, 'line_type', 'inventory'),
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001102', 'item_id', :itemA, 'line_type', 'inventory'),
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001103', 'item_id', null, 'line_type', 'tax'),
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001104', 'item_id', null, 'line_type', 'discount'),
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001105', 'item_id', null, 'line_type', 'freight')));
reset role;

select is(
  (select row(status, trim_scale(subtotal), trim_scale(total), created_by)::text from public.purchase_orders where id = (select id from t_po)),
  row('expected_inbound', 25::numeric, 32.5::numeric, :u_mgr::uuid)::text,
  '34: the PO is expected_inbound; subtotal is the inventory line totals, total adds the charges (2.5 - 3 + 8)');
select is(
  array(select row(trim_scale(quantity_ordered), trim_scale(quantity_received), trim_scale(unit_cost))::text
          from public.purchase_order_items where purchase_order_id = (select id from t_po) order by unit_cost desc),
  array[row(2::numeric, 0::numeric, 10::numeric)::text, row(1::numeric, 0::numeric, 5::numeric)::text],
  '35: lines take quantity and unit cost from the stored import lines, unreceived');
select is(
  array(select row(charge_type, label, trim_scale(quantity), trim_scale(unit_cost), trim_scale(amount), source_line_number, sort_order)::text
          from public.purchase_order_charges where purchase_order_id = (select id from t_po) order by sort_order),
  array[
    row('tax', 'Sales tax', null::numeric, null::numeric, 2.5::numeric, 3, 0)::text,
    row('discount', 'Promo', null::numeric, null::numeric, -3::numeric, 4, 1)::text,
    row('freight', 'Shipping', 2::numeric, 4::numeric, 8::numeric, 5, 2)::text],
  '36: charges are built like buildPoCharges (discount negated; quantity and unit cost only when quantity is not 1)');
select is(
  (select row(status, approved_po_id, approved_by)::text from public.po_imports where id = :imp1),
  row('approved', (select id from t_po), :u_mgr::uuid)::text,
  '37: the import is claimed and linked in the same transaction');

set local role to 'authenticated';
select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-AGAIN', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001101', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp1, :supA, :locA, :itemA),
  'P0001', 'po_import_not_claimable',
  '38: an approved import cannot be approved again (no second PO)');

select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-IMP2', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001201', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp2, :supA, :locA, :itemB),
  '22023', 'line_item_invalid',
  '39: a line mapped to another org''s item is refused');
select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-IMP2', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001101', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp2, :supA, :locA, :itemA),
  '22023', 'lines_invalid',
  '40: a line from another import is refused');
select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-IMP2', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001201', 'item_id', %L, 'line_type', 'inventory'),
                             jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001201', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp2, :supA, :locA, :itemA, :itemA),
  '22023', 'lines_invalid',
  '41: the same line twice is refused');
select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-IMP2', %L, null, null, null, null, '[]'::jsonb)$$, :imp2, :supA),
  '22023', 'destination_invalid',
  '42: a destination is required');

select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-IMP3', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001301', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp3, :supA, :locA, :itemA),
  '42501', 'po_over_approval_threshold',
  '43: a manager cannot approve an import over the threshold');

-- A failure AFTER the claim (the PO number is already in use) rolls the claim back.
reset role;
insert into public.purchase_orders (organization_id, po_number, status) values (:orgA, 'PO-0360-TAKEN', 'draft');
set local role to 'authenticated';
select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-TAKEN', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001401', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp4, :supA, :locA, :itemA),
  '23505', null,
  '44: a duplicate PO number fails the approval');
reset role;
select is((select row(status, approved_po_id, approved_by)::text from public.po_imports where id = :imp4),
  row('parsed', null::uuid, null::uuid)::text,
  '45: ... and the claim was rolled back with it (the import is approvable again)');
select is((select count(*)::int from public.purchase_orders
             where organization_id = :orgA and status = 'expected_inbound'), 1,
  '46: ... and no PO was left behind (only import 1''s exists)');
select is((select status from public.po_imports where id = :imp2), 'parsed',
  '47: the refused approvals left their import unclaimed');

set local "request.jwt.claim.sub" to :u_mgrB;
set local role to 'authenticated';
select throws_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-X', null, null, null, null, null, '[]'::jsonb)$$, :imp2),
  'P0002', 'po_import_not_found',
  '48: a manager of another org cannot approve this org''s import');

set local "request.jwt.claim.sub" to :u_adm;
select lives_ok(
  format($$select public.approve_po_import_commit(%L, 'PO-0360-IMP3', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001301', 'item_id', %L, 'line_type', 'inventory')))$$,
         :imp3, :supA, :locA, :itemA),
  '49: an admin approves the over-threshold import');
reset role;
select is((select status from public.po_imports where id = :imp3), 'approved',
  '50: ... and it is claimed');

-- ═══ PART 5: review hardening ═══════════════════════════════════════════════
reset role;
insert into public.purchase_orders (id, organization_id, po_number, status, subtotal, total) values
  ('03600000-0000-0000-0000-0000000000a7', :orgA, 'PO-0360-NEG', 'draft', 0, 0),
  ('03600000-0000-0000-0000-0000000000a8', :orgA, 'PO-0360-CHG', 'draft', 0, 0),
  ('03600000-0000-0000-0000-0000000000a9', :orgA, 'PO-0360-SVC', 'draft', 0, 0);
-- Written as the owner, which the guard exempts: rows only a direct write
-- could have produced before this migration.
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:orgA, '03600000-0000-0000-0000-0000000000a7', :itemA, 10, 0, 500),
  (:orgA, '03600000-0000-0000-0000-0000000000a7', :itemA, -10, 0, 500),
  (:orgA, '03600000-0000-0000-0000-0000000000a8', :itemA, 1, 0, 1500),
  (:orgA, '03600000-0000-0000-0000-0000000000a9', :itemA, 10, 0, 500);
insert into public.purchase_order_charges (organization_id, purchase_order_id, charge_type, amount) values
  (:orgA, '03600000-0000-0000-0000-0000000000a8', 'discount', -1000);

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  $$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost)
    values ('03600000-0000-0000-0000-00000000000a', '03600000-0000-0000-0000-0000000000e9', '03600000-0000-0000-0000-0000000000d1', -10, 500)$$,
  '23514', 'A purchase order line needs a quantity above 0 and a cost of 0 or more.',
  '51: an API-role line cannot be negative (the PO form''s own rule)');
select throws_ok(
  $$update public.purchase_orders set status = 'ordered' where id = '03600000-0000-0000-0000-0000000000a7'$$,
  '42501', 'This purchase order meets the approval threshold. Ask an owner or admin to place it.',
  '52: a negative line cannot offset a large one under the threshold (5000 - 5000 counts as 5000)');
select throws_ok(
  $$update public.purchase_orders set status = 'ordered' where id = '03600000-0000-0000-0000-0000000000a8'$$,
  '42501', 'This purchase order meets the approval threshold. Ask an owner or admin to place it.',
  '53: nor can a negative charge (1500 - 1000 counts as 1500)');
reset role;

insert into public.po_imports (id, organization_id, uploaded_by, source_type, file_name, file_mime_type,
                               file_size, storage_path, sha256, status) values
  ('03600000-0000-0000-0000-000000000105', :orgA, :u_mgr, 'pdf', 'imp5.pdf', 'application/pdf', 1, 'org/imp5.pdf', 'sha-0360-5', 'parsed'),
  ('03600000-0000-0000-0000-000000000106', :orgA, :u_mgr, 'pdf', 'imp6.pdf', 'application/pdf', 1, 'org/imp6.pdf', 'sha-0360-6', 'parsed'),
  ('03600000-0000-0000-0000-000000000107', :orgA, :u_mgr, 'pdf', 'imp7.pdf', 'application/pdf', 1, 'org/imp7.pdf', 'sha-0360-7', 'parsed'),
  ('03600000-0000-0000-0000-000000000108', :orgA, :u_mgr, 'pdf', 'imp8.pdf', 'application/pdf', 1, 'org/imp8.pdf', 'sha-0360-8', 'parsed');
insert into public.po_import_lines (id, po_import_id, line_number, line_type, qty_ordered_original, unit_cost, line_total, description) values
  ('03600000-0000-0000-0000-000000001501', '03600000-0000-0000-0000-000000000105', 1, 'inventory', 1, 1200, 1200, 'Laptop'),
  ('03600000-0000-0000-0000-000000001502', '03600000-0000-0000-0000-000000000105', 2, 'inventory', 1, 1200, 1200, 'Laptop 2'),
  ('03600000-0000-0000-0000-000000001601', '03600000-0000-0000-0000-000000000106', 1, 'inventory', 100, 20, 500, 'Understated total'),
  ('03600000-0000-0000-0000-000000001701', '03600000-0000-0000-0000-000000000107', 1, 'inventory', -1, 5, -5, 'Negative'),
  ('03600000-0000-0000-0000-000000001801', '03600000-0000-0000-0000-000000000108', 1, 'inventory', 1, 1, 1, 'Cable'),
  ('03600000-0000-0000-0000-000000001802', '03600000-0000-0000-0000-000000000108', 2, 'fee', 1, 1.005, 1.005, E' \n\t');

set local role to 'authenticated';
select throws_ok(
  format($$select public.approve_po_import_commit('03600000-0000-0000-0000-000000000105', 'PO-0360-IMP5', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001501', 'item_id', %L, 'line_type', 'inventory'),
                             jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001502', 'item_id', null, 'line_type', 'discount')))$$,
         :supA, :locA, :itemA),
  '42501', 'po_over_approval_threshold',
  '54: re-typing a 1200 line as a discount does not net a 1200 import under the gate');
select throws_ok(
  format($$select public.approve_po_import_commit('03600000-0000-0000-0000-000000000106', 'PO-0360-IMP6', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001601', 'item_id', %L, 'line_type', 'inventory')))$$,
         :supA, :locA, :itemA),
  '42501', 'po_over_approval_threshold',
  '55: the gate uses quantity x cost (2000) when the stored line total (500) is lower');
select throws_ok(
  format($$select public.approve_po_import_commit('03600000-0000-0000-0000-000000000107', 'PO-0360-IMP7', %L, %L, null, null, null,
           jsonb_build_array(jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001701', 'item_id', %L, 'line_type', 'inventory')))$$,
         :supA, :locA, :itemA),
  '22023', 'line_amount_invalid',
  '56: a negative inventory line is refused (the RPC runs past the line guard)');

truncate t_po;
insert into t_po
select public.approve_po_import_commit('03600000-0000-0000-0000-000000000108', 'PO-0360-IMP8', :supA, :locA, null, null, null,
  jsonb_build_array(
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001801', 'item_id', :itemA, 'line_type', 'inventory'),
    jsonb_build_object('line_id', '03600000-0000-0000-0000-000000001802', 'item_id', null, 'line_type', 'fee')));
reset role;
select is(
  (select row(trim_scale(amount), label)::text from public.purchase_order_charges where purchase_order_id = (select id from t_po)),
  row(1::numeric, null::text)::text,
  '57: a 1.005 fee rounds to 1.00 as Math.round on doubles does, and a whitespace-only description is no label');
select is((select trim_scale(total) from public.purchase_orders where id = (select id from t_po)), 2::numeric,
  '58: ... so the PO total matches the service''s audit (1 + 1.00)');

-- The crons place POs as the service_role.
set local role to 'service_role';
select lives_ok(
  $$update public.purchase_orders set status = 'ordered', ordered_at = now() where id = '03600000-0000-0000-0000-0000000000a9'$$,
  '59: the service_role (recurring-PO and auto-reorder crons) is not held to the API-role lifecycle');
reset role;

select * from finish();
rollback;
