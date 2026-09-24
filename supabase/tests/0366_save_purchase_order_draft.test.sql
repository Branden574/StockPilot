-- supabase/tests/0366_save_purchase_order_draft.test.sql
-- Proves migration 0366 (S3 planning, F2): a draft purchase order is saved,
-- header and lines together, in ONE transaction.
--
-- PART 1 (1-2)   Structure and grants: SECURITY INVOKER, search_path pinned,
--                closed to anon and PUBLIC, open to authenticated/service_role.
-- PART 2 (3-8)   Create as a manager: every header column and the lines, the
--                totals from the lines, the creator stamped from the session
--                (p_actor cannot spoof it), and the result can be ordered.
-- PART 3 (9-19)  A failed create leaves nothing: a foreign item, no lines, a
--                malformed line, a PO number in use.
-- PART 4 (20-33) Edit: a failure leaves the header and both old lines exactly
--                as they were; a good edit replaces all of it; a PO that is
--                no longer a draft, or not this org's, is refused; a draft
--                carrying charges keeps them in its total.
-- PART 5 (34-37) Permissions: staff without purchase_orders:manage and a
--                manager of another org are refused by RLS.
-- PART 6 (38-43) The service role (the crons): p_actor records the creator,
--                and the checks that do not depend on the guards still hold.
-- PART 7 (44-47) Custom-item tags: set on success, untouched on failure,
--                only for items on this PO's lines, only in this org.
--
-- The row lock (edit vs edit, edit vs "Mark as ordered") needs two sessions;
-- it is proved by the two-session check recorded with this migration, not
-- here.
--
-- Roles: `set local role` with request.jwt.claim.sub, as the house tests do.
-- Closed grants are asserted from the catalog. Run via `supabase test db`
-- after `supabase db reset`.

begin;
select plan(47);

\set orgA    '\'03660000-0000-0000-0000-00000000000a\''
\set orgB    '\'03660000-0000-0000-0000-00000000000b\''
\set u_mgr   '\'03660000-0000-0000-0000-0000000000a1\''
\set u_stf   '\'03660000-0000-0000-0000-0000000000a2\''
\set u_other '\'03660000-0000-0000-0000-0000000000a3\''
\set u_mgrB  '\'03660000-0000-0000-0000-0000000000a4\''
\set whA     '\'03660000-0000-0000-0000-0000000000b1\''
\set whB     '\'03660000-0000-0000-0000-0000000000b2\''
\set locA    '\'03660000-0000-0000-0000-0000000000b3\''
\set locB    '\'03660000-0000-0000-0000-0000000000b4\''
\set supA    '\'03660000-0000-0000-0000-0000000000b5\''
\set supB    '\'03660000-0000-0000-0000-0000000000b6\''
\set chA     '\'03660000-0000-0000-0000-0000000000b7\''
\set i1      '\'03660000-0000-0000-0000-0000000000c1\''
\set i2      '\'03660000-0000-0000-0000-0000000000c2\''
\set i3      '\'03660000-0000-0000-0000-0000000000c3\''
\set iB      '\'03660000-0000-0000-0000-0000000000c9\''
\set cu1     '\'03660000-0000-0000-0000-0000000000ca\''
\set cu2     '\'03660000-0000-0000-0000-0000000000cb\''
\set cu3     '\'03660000-0000-0000-0000-0000000000cc\''
\set cu4     '\'03660000-0000-0000-0000-0000000000cd\''
\set poDraft '\'03660000-0000-0000-0000-0000000000e1\''
\set poOrd   '\'03660000-0000-0000-0000-0000000000e2\''
\set poChg   '\'03660000-0000-0000-0000-0000000000e3\''
\set poTaken '\'03660000-0000-0000-0000-0000000000e4\''
\set poB     '\'03660000-0000-0000-0000-0000000000e5\''
\set lnD1    '\'03660000-0000-0000-0000-0000000000f1\''
\set lnD2    '\'03660000-0000-0000-0000-0000000000f2\''
\set lnOrd   '\'03660000-0000-0000-0000-0000000000f3\''

-- ── Fixtures (as postgres: RLS bypassed, guards exempt) ─────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_mgr,   'mgr-0366@test.local',   '{}'::jsonb),
  (:u_stf,   'stf-0366@test.local',   '{}'::jsonb),
  (:u_other, 'other-0366@test.local', '{}'::jsonb),
  (:u_mgrB,  'mgrb-0366@test.local',  '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'PO Save Org A 0366', 'po-save-a-0366'),
  (:orgB, 'PO Save Org B 0366', 'po-save-b-0366');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_mgr,   'manager', now()),
  (:orgA, :u_stf,   'staff',   now()),
  (:orgA, :u_other, 'manager', now()),
  (:orgB, :u_mgrB,  'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'purchase_orders', true, 'core', '{}'::jsonb),
  (:orgB, 'purchase_orders', true, 'core', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true, settings = excluded.settings;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'PO Save WH A 0366', 'S0366A', 'active'),
  (:whB, :orgB, 'PO Save WH B 0366', 'S0366B', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locA, :orgA, :whA, 'Dock A 0366', 'bin', 'rack'),
  (:locB, :orgB, :whB, 'Dock B 0366', 'bin', 'rack');
insert into public.suppliers (id, organization_id, name) values
  (:supA, :orgA, 'Supplier A 0366'),
  (:supB, :orgB, 'Supplier B 0366');
insert into public.charters (id, organization_id, name) values
  (:chA, :orgA, 'Charter A 0366');

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, status, item_type) values
  (:i1, :orgA, :whA, 'S0366-1', 'Save item 1', 'active', 'product'),
  (:i2, :orgA, :whA, 'S0366-2', 'Save item 2', 'active', 'product'),
  (:i3, :orgA, :whA, 'S0366-3', 'Save item 3', 'active', 'product'),
  (:iB, :orgB, :whB, 'S0366-B', 'Other org item', 'active', 'product');
-- PO-born custom items, as InventoryService creates them: hidden until the
-- first receipt, nothing on hand, not yet tagged with a PO.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, status, item_type, awaiting_first_receipt) values
  (:cu1, :orgA, :whA, 'S0366-CU1', 'Custom 1', 'active', 'product', true),
  (:cu2, :orgA, :whA, 'S0366-CU2', 'Custom 2', 'active', 'product', true),
  (:cu3, :orgA, :whA, 'S0366-CU3', 'Custom 3', 'active', 'product', true),
  (:cu4, :orgA, :whA, 'S0366-CU4', 'Custom 4', 'active', 'product', true);

insert into public.purchase_orders
  (id, organization_id, po_number, status, supplier_id, notes, subtotal, total, created_by, updated_by) values
  (:poDraft, :orgA, 'S0366-DRAFT', 'draft',   :supA, 'original notes', 10, 10, :u_other, :u_other),
  (:poOrd,   :orgA, 'S0366-ORD',   'ordered', :supA, null,              5,  5, :u_other, :u_other),
  (:poChg,   :orgA, 'S0366-CHG',   'draft',   :supA, null,              4,  9, :u_other, :u_other),
  (:poTaken, :orgA, 'S0366-TAKEN', 'draft',   null,  null,              0,  0, :u_other, :u_other),
  (:poB,     :orgB, 'S0366-B',     'draft',   :supB, 'org B notes',     1,  1, :u_mgrB,  :u_mgrB);
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost) values
  (:lnD1,  :orgA, :poDraft, :i1, 2, 3),
  (:lnD2,  :orgA, :poDraft, :i2, 1, 4),
  (:lnOrd, :orgA, :poOrd,   :i1, 1, 5),
  (gen_random_uuid(), :orgA, :poChg,   :i1, 1, 4),
  (gen_random_uuid(), :orgA, :poTaken, :i1, 1, 0),
  (gen_random_uuid(), :orgB, :poB,     :iB, 1, 1);
-- A charge on a draft. None exists today (charges come from PO-import
-- approvals, which create expected_inbound POs), but a draft's total must
-- keep them if one ever does.
insert into public.purchase_order_charges (organization_id, purchase_order_id, charge_type, label, amount) values
  (:orgA, :poChg, 'freight', 'Freight', 5);

create temp table saved (tag text primary key, result jsonb) on commit drop;
grant all on saved to authenticated, service_role;

-- A header + lines fingerprint, to prove a failed edit changed nothing.
create function pg_temp.po_fingerprint(p_po uuid) returns text language sql as $$
  select p.po_number || '|' || coalesce(p.supplier_id::text, '-') || '|' || coalesce(p.notes, '-')
         || '|' || p.subtotal::text || '|' || p.total::text || '|' || p.status
         || '|' || coalesce(p.updated_by::text, '-') || '|' || p.updated_at::text
         || '|' || coalesce((select string_agg(i.id::text || ':' || i.item_id::text || ':' || i.quantity_ordered::text
                                               || ':' || i.unit_cost::text, ',' order by i.id)
                               from public.purchase_order_items i where i.purchase_order_id = p.id), '-')
    from public.purchase_orders p where p.id = p_po
$$;
grant execute on function pg_temp.po_fingerprint(uuid) to authenticated, service_role;

create temp table before_edit on commit drop as
  select :poDraft::uuid as id, pg_temp.po_fingerprint(:poDraft) as fp
  union all select :poOrd::uuid, pg_temp.po_fingerprint(:poOrd)
  union all select :poB::uuid,   pg_temp.po_fingerprint(:poB);
grant select on before_edit to authenticated, service_role;

-- ═══ PART 1: structure and grants ═══════════════════════════════════════════
select ok(
  (select not p.prosecdef
          and p.proconfig @> array['search_path=public, pg_temp']
     from pg_proc p
    where p.oid = 'public.save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,jsonb,uuid[],uuid)'::regprocedure),
  '1: SECURITY INVOKER (RLS and the PO guards still decide) with search_path pinned');
select ok(
  not has_function_privilege('anon', 'public.save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,jsonb,uuid[],uuid)', 'execute')
  and (select p.proacl is not null
                 and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
            from pg_proc p
           where p.oid = 'public.save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,jsonb,uuid[],uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,jsonb,uuid[],uuid)', 'execute')
  and has_function_privilege('service_role', 'public.save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamptz,text,jsonb,uuid[],uuid)', 'execute'),
  '2: closed to anon and PUBLIC; open to authenticated and service_role');

-- ═══ PART 2: create as a manager ════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(
  format($$insert into saved
           select 'create', public.save_purchase_order_draft(
             p_org_id => %L, p_po_id => null, p_po_number => 'S0366-NEW',
             p_supplier_id => %L, p_destination_location_id => %L, p_charter_id => %L,
             p_expected_at => '2026-10-01T00:00:00Z', p_notes => 'created 0366',
             p_lines => %L::jsonb, p_custom_item_ids => '{}'::uuid[],
             p_actor => %L)$$,
         :orgA, :supA, :locA, :chA,
         jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 3,   'unit_cost', 1.1),
                           jsonb_build_object('item_id', :i2, 'quantity_ordered', 0.5, 'unit_cost', 2.25)),
         :u_other),
  '3: a manager creates a draft with its lines in one call');
reset role;

select is(
  (select p.status || '|' || p.po_number || '|' || p.supplier_id::text || '|' || p.destination_location_id::text
          || '|' || p.charter_id::text || '|' || p.notes || '|' || (p.expected_at = '2026-10-01T00:00:00Z')::text
          || '|' || p.tax::text || '|' || p.shipping::text || '|' || (p.ordered_at is null)::text
     from public.purchase_orders p where p.id = (select (result->>'id')::uuid from saved where tag = 'create')),
  format('draft|S0366-NEW|%s|%s|%s|created 0366|true|0.0000|0.0000|true', :supA, :locA, :chA),
  '4: every header column the TypeScript wrote, and tax/shipping/ordered_at left at their defaults');
select is(
  (select p.subtotal::text || '|' || p.total::text
     from public.purchase_orders p where p.id = (select (result->>'id')::uuid from saved where tag = 'create')),
  '4.4250|4.4250',
  '5: subtotal = total = sum(quantity x cost) of the lines (3 x 1.1 + 0.5 x 2.25), a new PO has no charges');
select is(
  (select p.created_by::text || '|' || p.updated_by::text
     from public.purchase_orders p where p.id = (select (result->>'id')::uuid from saved where tag = 'create')),
  format('%s|%s', :u_mgr, :u_mgr),
  '6: the creator is the signed-in caller; a p_actor naming someone else is ignored');
select is(
  (select string_agg(i.item_id::text || ':' || trim_scale(i.quantity_ordered)::text || ':' || trim_scale(i.unit_cost)::text
                     || ':' || trim_scale(i.quantity_received)::text, ',' order by i.item_id)
     from public.purchase_order_items i
    where i.purchase_order_id = (select (result->>'id')::uuid from saved where tag = 'create')
      and i.organization_id = :orgA),
  format('%s:3:1.1:0,%s:0.5:2.25:0', :i1, :i2),
  '7: both lines, in this org, nothing received');
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(
  format($$update public.purchase_orders set status = 'ordered' where id = %L$$,
         (select (result->>'id')::uuid from saved where tag = 'create')),
  '8: the saved draft can be marked ordered (0364: never an empty PO)');
reset role;

-- ═══ PART 3: a failed create leaves nothing ═════════════════════════════════
create temp table po_count on commit drop as
  select count(*) as n from public.purchase_orders where organization_id = :orgA;
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-FOREIGN', null, null, null, null, null, %L::jsonb)$$,
         :orgA,
         jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1),
                           jsonb_build_object('item_id', :iB, 'quantity_ordered', 1, 'unit_cost', 1))),
  '42501', 'An item, supplier, destination or charter on this purchase order is not part of this organization.',
  '9: a line with another organization''s item is refused');
reset role;
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA and po_number = 'S0366-FOREIGN'),
  0::bigint,
  '10: ... and its header was rolled back with it (the old create left an empty draft)');

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-EMPTY', null, null, null, null, null, '[]'::jsonb)$$, :orgA),
  '22023', 'Add at least one line item.',
  '11: no lines is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-OBJ', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1)),
  '22023', 'Add at least one line item.',
  '12: lines that are not an array are refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-Q0', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 0, 'unit_cost', 1))),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '13: a zero quantity is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-QTINY', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 0.00001, 'unit_cost', 1))),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '14: a quantity that the column rounds to 0 is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-QSTR', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 'NaN', 'unit_cost', 1))),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '15: a quantity that is not a JSON number (NaN as text) is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-QNULL', null, null, null, null, null, %L::jsonb)$$,
         :orgA, '[{"item_id": "03660000-0000-0000-0000-0000000000c1", "quantity_ordered": null, "unit_cost": 1}]'),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '16: a null quantity (what JSON.stringify makes of NaN and Infinity) is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-CNEG', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', -0.5))),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '17: a negative cost is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-NOITEM', null, null, null, null, null, %L::jsonb)$$,
         :orgA, '[{"item_id": "not-a-uuid", "quantity_ordered": 1, "unit_cost": 1}]'),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '18: a line without a real item id is refused');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-TAKEN', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1))),
  '23505', null,
  '19: a PO number another open PO holds is refused (23505, which the service maps to "already in use")');
reset role;
-- (checked below together with PART 4's failures)

-- ═══ PART 4: edit ═══════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-RENAMED', null, null, null, null, 'changed', %L::jsonb)$$,
         :orgA, :poDraft,
         jsonb_build_array(jsonb_build_object('item_id', :i3, 'quantity_ordered', 9, 'unit_cost', 9),
                           jsonb_build_object('item_id', :iB, 'quantity_ordered', 1, 'unit_cost', 1))),
  '42501', 'An item, supplier, destination or charter on this purchase order is not part of this organization.',
  '20: an edit with a foreign line is refused ...');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-RENAMED', null, null, null, null, 'changed', %L::jsonb)$$,
         :orgA, :poDraft,
         jsonb_build_array(jsonb_build_object('item_id', :i3, 'quantity_ordered', 9, 'unit_cost', 9),
                           jsonb_build_object('item_id', :i1, 'quantity_ordered', -1, 'unit_cost', 1))),
  '22023', 'Each line needs an item, a quantity above 0 and a cost of 0 or more.',
  '21: ... so is an edit with a bad quantity ...');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-TAKEN', null, null, null, null, 'changed', %L::jsonb)$$,
         :orgA, :poDraft,
         jsonb_build_array(jsonb_build_object('item_id', :i3, 'quantity_ordered', 9, 'unit_cost', 9))),
  '23505', null,
  '22: ... and an edit to a PO number in use');
reset role;
select is(
  pg_temp.po_fingerprint(:poDraft),
  (select fp from before_edit where id = :poDraft),
  '23: after the failed edits the draft''s number, supplier, notes, totals, editor and BOTH old lines are unchanged (the old edit saved the header first)');
select is(
  (select count(*) from public.purchase_orders where organization_id = :orgA),
  (select n from po_count),
  '24: no failed create left a purchase order behind');

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(
  format($$insert into saved
           select 'edit', public.save_purchase_order_draft(
             p_org_id => %L, p_po_id => %L, p_po_number => 'S0366-EDITED',
             p_supplier_id => null, p_destination_location_id => %L, p_charter_id => %L,
             p_expected_at => null, p_notes => 'edited notes',
             p_lines => %L::jsonb, p_actor => %L)$$,
         :orgA, :poDraft, :locA, :chA,
         jsonb_build_array(jsonb_build_object('item_id', :i3, 'quantity_ordered', 4, 'unit_cost', 2.5)),
         :u_other),
  '25: a good edit saves');
reset role;
select is(
  (select p.po_number || '|' || coalesce(p.supplier_id::text, '-') || '|' || p.destination_location_id::text
          || '|' || p.charter_id::text || '|' || p.notes || '|' || p.subtotal::text || '|' || p.total::text
          || '|' || p.created_by::text || '|' || p.updated_by::text || '|' || p.status
     from public.purchase_orders p where p.id = :poDraft),
  format('S0366-EDITED|-|%s|%s|edited notes|10.0000|10.0000|%s|%s|draft', :locA, :chA, :u_other, :u_mgr),
  '26: the whole header is replaced, subtotal = total = the new lines, creator kept, editor = the caller');
select is(
  (select string_agg(i.item_id::text || ':' || trim_scale(i.quantity_ordered)::text, ',')
          || '|' || bool_and(i.id not in (:lnD1, :lnD2))::text
     from public.purchase_order_items i where i.purchase_order_id = :poDraft),
  format('%s:4|true', :i3),
  '27: the line set is replaced, not appended to');

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-ORD', null, null, null, null, null, %L::jsonb)$$,
         :orgA, :poOrd,
         jsonb_build_array(jsonb_build_object('item_id', :i2, 'quantity_ordered', 1, 'unit_cost', 1))),
  '40001', 'This purchase order is no longer a draft (it may have just been ordered).',
  '28: an ordered PO is refused ...');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-X', null, null, null, null, null, %L::jsonb)$$,
         :orgA, :poB,
         jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1))),
  'P0002', 'Purchase order not found.',
  '29: ... so is another org''s PO under this org''s id ...');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-X', null, null, null, null, null, %L::jsonb)$$,
         :orgB, :poB,
         jsonb_build_array(jsonb_build_object('item_id', :iB, 'quantity_ordered', 1, 'unit_cost', 1))),
  'P0002', 'Purchase order not found.',
  '30: ... and a PO in an org the caller is not a member of (RLS hides it)');
select lives_ok(
  format($$insert into saved
           select 'charges', public.save_purchase_order_draft(%L, %L, 'S0366-CHG', %L, null, null, null, null, %L::jsonb)$$,
         :orgA, :poChg, :supA,
         jsonb_build_array(jsonb_build_object('item_id', :i2, 'quantity_ordered', 2, 'unit_cost', 3))),
  '31: a draft carrying a charge saves');
reset role;
select ok(
  pg_temp.po_fingerprint(:poOrd) = (select fp from before_edit where id = :poOrd)
  and pg_temp.po_fingerprint(:poB) = (select fp from before_edit where id = :poB),
  '32: the refused ordered PO and the other org''s PO are unchanged');
select is(
  (select p.subtotal::text || '|' || p.total::text from public.purchase_orders p where p.id = :poChg),
  '6.0000|11.0000',
  '33: its subtotal is the lines only and its total keeps the charge (6 + 5), neither zeroed nor counted twice');

-- ═══ PART 5: permissions ════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-STAFF', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1))),
  '42501', null,
  '34: staff without purchase_orders:manage cannot create (RLS) ...');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-EDITED', null, null, null, null, 'staff edit', %L::jsonb)$$,
         :orgA, :poDraft,
         jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1))),
  'P0002', 'Purchase order not found.',
  '35: ... nor edit (the row lock needs the write policy)');
reset role;
set local "request.jwt.claim.sub" to :u_mgrB;
set local role to 'authenticated';
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-CROSS', null, null, null, null, null, %L::jsonb)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1))),
  '42501', null,
  '36: a manager of another organization cannot create in this one');
reset role;
select is(
  (select count(*) from public.purchase_orders where po_number in ('S0366-STAFF', 'S0366-CROSS'))
    || '|' || (select p.notes from public.purchase_orders p where p.id = :poDraft),
  '0|edited notes',
  '37: ... and nothing was written');

-- ═══ PART 6: the service role (crons) ═══════════════════════════════════════
set local "request.jwt.claim.sub" to '';
set local role to 'service_role';
select lives_ok(
  format($$insert into saved
           select 'cron', public.save_purchase_order_draft(%L, null, 'S0366-CRON', %L, null, null, null, null, %L::jsonb,
                                                           '{}'::uuid[], %L)$$,
         :orgA, :supA,
         jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 2, 'unit_cost', 5)),
         :u_mgr),
  '38: the service role (auto-reorder, recurring POs) saves a draft');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-CRONX', null, null, null, null, null, %L::jsonb, '{}'::uuid[], %L)$$,
         :orgA, jsonb_build_array(jsonb_build_object('item_id', :iB, 'quantity_ordered', 1, 'unit_cost', 1)), :u_mgr),
  '42501', 'An item, supplier, destination or charter on this purchase order is not part of this organization.',
  '39: the service role cannot put another org''s item on a PO (no guard runs for it)');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-CRONS', %L, null, null, null, null, %L::jsonb, '{}'::uuid[], %L)$$,
         :orgA, :supB, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1)), :u_mgr),
  '42501', 'An item, supplier, destination or charter on this purchase order is not part of this organization.',
  '40: ... nor another org''s supplier');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-CRONE', null, null, null, null, null, '[]'::jsonb, '{}'::uuid[], %L)$$,
         :orgA, :u_mgr),
  '22023', 'Add at least one line item.',
  '41: ... nor save an empty PO (0364''s rule covers only the API roles)');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, %L, 'S0366-ORD', null, null, null, null, null, %L::jsonb, '{}'::uuid[], %L)$$,
         :orgA, :poOrd, jsonb_build_array(jsonb_build_object('item_id', :i1, 'quantity_ordered', 1, 'unit_cost', 1)), :u_mgr),
  '40001', 'This purchase order is no longer a draft (it may have just been ordered).',
  '42: ... nor edit a PO that is no longer a draft');
reset role;
select is(
  (select p.status || '|' || p.created_by::text || '|' || p.updated_by::text || '|' || p.total::text
          || '|' || (select count(*) from public.purchase_orders where po_number in ('S0366-CRONX', 'S0366-CRONS', 'S0366-CRONE'))::text
     from public.purchase_orders p where p.id = (select (result->>'id')::uuid from saved where tag = 'cron')),
  format('draft|%s|%s|10.0000|0', :u_mgr, :u_mgr),
  '43: the cron''s draft records p_actor as its creator, and the refused saves left nothing');

-- ═══ PART 7: custom-item tags ═══════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(
  format($$insert into saved
           select 'custom', public.save_purchase_order_draft(%L, null, 'S0366-CUSTOM', null, null, null, null, null, %L::jsonb,
                                                             array[%L, %L, %L, %L]::uuid[])$$,
         :orgA,
         jsonb_build_array(jsonb_build_object('item_id', :cu1, 'quantity_ordered', 1, 'unit_cost', 1),
                           jsonb_build_object('item_id', :cu2, 'quantity_ordered', 1, 'unit_cost', 1)),
         :cu1, :cu2, :cu4, :iB),
  '44: a save with custom lines tags them');
select throws_ok(
  format($$select public.save_purchase_order_draft(%L, null, 'S0366-CUSTOMX', null, null, null, null, null, %L::jsonb, array[%L]::uuid[])$$,
         :orgA,
         jsonb_build_array(jsonb_build_object('item_id', :cu3, 'quantity_ordered', 1, 'unit_cost', 1),
                           jsonb_build_object('item_id', :iB,  'quantity_ordered', 1, 'unit_cost', 1)),
         :cu3),
  '42501', null,
  '45: a failed save with a custom line ...');
reset role;
select is(
  (select (result->>'stamped') || '|' || coalesce(result->>'stamp_error', '-') from saved where tag = 'custom'),
  '2|-',
  '46: the save reports tagging exactly the custom items on its lines');
select is(
  (select string_agg(it.id::text || ':' || coalesce((it.created_from_purchase_order_id = (select (result->>'id')::uuid from saved where tag = 'custom'))::text, 'null'), ',' order by it.id)
     from public.inventory_items it where it.id in (:cu1, :cu2, :cu3, :cu4, :iB)),
  format('%s:null,%s:true,%s:true,%s:null,%s:null', :iB, :cu1, :cu2, :cu3, :cu4),
  '47: cu1/cu2 tagged; the failed save''s item untouched; an id not on the lines and another org''s item never tagged');

select * from finish();
rollback;
