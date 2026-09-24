-- supabase/tests/0364_ledger_lockdown_enforce.test.sql
-- Proves migration 0364 (stock-ledger lockdown, enforce step).
--
-- PART 1 (1-6)   Structure, grants and policies; the SECURITY DEFINER writers
--                the guards exempt stay DEFINER.
-- PART 2 (7-14)  inventory_items: on-hand changes only inside a ledger RPC;
--                other edits, opening stock on insert and the 0359 rules are
--                unchanged; compensate_opening_stock still zeroes a failed
--                create.
-- PART 3 (15-19) item_stock_levels: direct writes refused, transfer_stock
--                still moves holdings, an FK cascade still clears them.
-- PART 4 (20-25) purchase_orders: an API-role insert is a draft with a
--                database-recorded creator; postgres and service_role exempt.
-- PART 5 (26-29) purchase_order_items: lines only into a draft; 0360's org and
--                positive-line rules keep their order.
-- PART 6 (30-34) purchase_order_charges, rentals, rental_lines closed to the
--                API roles.
--
-- Roles: the guards key on current_user, so writes run under
-- `set local role authenticated` with request.jwt.claim.sub. Closed grants
-- are asserted from the catalog as well as by the refused write.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(34);

\set orgA    '\'03640000-0000-0000-0000-00000000000a\''
\set orgB    '\'03640000-0000-0000-0000-00000000000b\''
\set u_stf   '\'03640000-0000-0000-0000-0000000000a1\''
\set u_mgr   '\'03640000-0000-0000-0000-0000000000a2\''
\set u_mgrB  '\'03640000-0000-0000-0000-0000000000b1\''
\set whA     '\'03640000-0000-0000-0000-0000000000c1\''
\set whB     '\'03640000-0000-0000-0000-0000000000c2\''
\set loc1    '\'03640000-0000-0000-0000-0000000000c3\''
\set loc2    '\'03640000-0000-0000-0000-0000000000c4\''
\set locGone '\'03640000-0000-0000-0000-0000000000c5\''
\set supA    '\'03640000-0000-0000-0000-0000000000c6\''
\set itemS   '\'03640000-0000-0000-0000-0000000000d1\''
\set itemN   '\'03640000-0000-0000-0000-0000000000d2\''
\set itemB   '\'03640000-0000-0000-0000-0000000000d3\''
\set poDraft '\'03640000-0000-0000-0000-0000000000e1\''
\set poOrd   '\'03640000-0000-0000-0000-0000000000e2\''
\set poB     '\'03640000-0000-0000-0000-0000000000e3\''
\set poNew   '\'03640000-0000-0000-0000-0000000000e4\''
\set rentA   '\'03640000-0000-0000-0000-0000000000f1\''

-- ── Fixtures (as postgres: RLS bypassed, guards exempt) ─────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_stf,  'stf-0364@test.local',  '{}'::jsonb),
  (:u_mgr,  'mgr-0364@test.local',  '{}'::jsonb),
  (:u_mgrB, 'mgrb-0364@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Enforce Org A 0364', 'enforce-org-a-0364'),
  (:orgB, 'Enforce Org B 0364', 'enforce-org-b-0364');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_stf,  'staff',   now()),
  (:orgA, :u_mgr,  'manager', now()),
  (:orgB, :u_mgrB, 'manager', now());

insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'purchase_orders', true, 'core', '{}'::jsonb),
  (:orgA, 'rentals',         true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, 'Enforce WH A 0364', 'E0364A', 'active'),
  (:whB, :orgB, 'Enforce WH B 0364', 'E0364B', 'active');

insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:loc1,    :orgA, :whA, 'Rack 1 0364',    'bin', 'rack'),
  (:loc2,    :orgA, :whA, 'Rack 2 0364',    'bin', 'rack'),
  (:locGone, :orgA, :whA, 'Rack gone 0364', 'bin', 'rack');

insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :u_stf, :whA, true);

insert into public.suppliers (id, organization_id, name) values
  (:supA, :orgA, 'Supplier A 0364');

-- itemS holds 5 on Rack 1 (and an empty row on the rack a test deletes).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, item_type) values
  (:itemS, :orgA, :whA, 'E0364-S', 'Stocked 0364', 0, 2, 'active', 'product'),
  (:itemB, :orgB, :whB, 'E0364-B', 'Other org 0364', 0, 2, 'active', 'product');
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :itemS, :loc1,    5),
  (:orgA, :itemS, :locGone, 0);
update public.inventory_items set quantity_on_hand = 5 where id = :itemS;

insert into public.purchase_orders (id, organization_id, po_number, status, supplier_id, subtotal, total) values
  (:poDraft, :orgA, 'PO-0364-D', 'draft',   :supA, 0, 0),
  (:poOrd,   :orgA, 'PO-0364-O', 'ordered', :supA, 0, 0),
  (:poB,     :orgB, 'PO-0364-X', 'draft',   null,  0, 0);

insert into public.rentals (id, organization_id, warehouse_id, borrower_name, expected_return_at, status, created_by)
values (:rentA, :orgA, :whA, 'Borrower 0364', now() + interval '7 days', 'out', :u_mgr);

-- ═══ PART 1: structure, grants, policies ════════════════════════════════════
select is(
  (select pg_get_triggerdef(t.oid) from pg_trigger t
    where t.tgrelid = 'public.item_stock_levels'::regclass and t.tgname = 'trg_zz_item_stock_levels_guard'),
  'CREATE TRIGGER trg_zz_item_stock_levels_guard BEFORE INSERT OR DELETE OR UPDATE ON public.item_stock_levels FOR EACH ROW EXECUTE FUNCTION tg_ledger_only_guard()',
  '1: item_stock_levels has the ledger-only guard on insert, update and delete');
select ok(
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
                 and p.proname in ('tg_inventory_items_guard', 'tg_purchase_orders_guard',
                                   'tg_purchase_order_items_guard', 'tg_ledger_only_guard')),
  '2: every guard function is SECURITY INVOKER');
select ok(
  not has_table_privilege('authenticated', 'public.item_stock_levels', 'DELETE')
  and not has_table_privilege('anon', 'public.item_stock_levels', 'DELETE')
  and has_table_privilege('authenticated', 'public.item_stock_levels', 'INSERT')
  and has_table_privilege('authenticated', 'public.item_stock_levels', 'UPDATE'),
  '3: holdings lose DELETE; INSERT/UPDATE stay for the INVOKER ledger bodies');
select ok(
  not exists (
    select 1 from unnest(array['purchase_order_charges', 'rentals', 'rental_lines']) t,
                  unnest(array['authenticated', 'anon']) r,
                  unnest(array['INSERT', 'UPDATE', 'DELETE']) p
     where has_table_privilege(r, 'public.' || t, p))
  and has_table_privilege('authenticated', 'public.purchase_order_charges', 'SELECT')
  and has_table_privilege('authenticated', 'public.rentals', 'SELECT')
  and has_table_privilege('authenticated', 'public.rental_lines', 'SELECT'),
  '4: charges, rentals and rental lines are read-only to the API roles');
select is(
  array(select tablename || ':' || policyname from pg_policies
         where tablename in ('purchase_order_charges', 'rentals', 'rental_lines') order by 1),
  array['purchase_order_charges:purchase_order_charges_select',
        'rental_lines:rental_lines_select',
        'rentals:rentals_select'],
  '5: only the SELECT policies remain on those tables');
select is(
  array(select proname::text from pg_proc
         where pronamespace = 'public'::regnamespace and prosecdef
           and proname in ('tg_seed_initial_level', 'apply_level_delta', 'apply_cycle_count_location_delta',
                           'compensate_opening_stock', 'approve_po_import_commit',
                           'create_rental', 'return_rental', 'cancel_rental')
         order by 1),
  array['apply_cycle_count_location_delta', 'apply_level_delta', 'approve_po_import_commit',
        'cancel_rental', 'compensate_opening_stock', 'create_rental', 'return_rental',
        'tg_seed_initial_level'],
  '6: the writers the guards exempt are still SECURITY DEFINER (a lost DEFINER would fail closed or, for the seed trigger, silently)');

-- ═══ PART 2: inventory_items on-hand ════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select throws_ok(
  format($$update public.inventory_items set quantity_on_hand = 50 where id = %L$$, :itemS),
  '42501', 'On-hand changes only through a stock movement: adjust, transfer, receive or count.',
  '7: a direct PATCH of on-hand is refused');
select lives_ok(
  format($$update public.inventory_items set name = 'Renamed 0364', unit_cost = 3 where id = %L$$, :itemS),
  '8: an edit that leaves on-hand alone is unchanged (name and cost)');
select is(
  (public.adjust_stock(p_item_id => :itemS, p_quantity_change => 1, p_movement_type => 'add',
                       p_location_id => null, p_reason => 'Mobile detail', p_notes => null)).quantity_on_hand,
  6::numeric,
  '9: the ledger (adjust_stock, as the phone calls it) still moves on-hand');
do $$ begin perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true); end $$;
select lives_ok(
  format($$update public.inventory_items set quantity_on_hand = 7 where id = %L$$, :itemS),
  '10: inside a ledger call (the flag of this transaction) the body''s own on-hand write passes');
update public.inventory_items set quantity_on_hand = 6 where id = :itemS;
set local stockpilot.ledger to '';
select lives_ok(
  format($$insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by)
           values (%L, %L, %L, 'E0364-N', 'New with stock 0364', 4, 'active', 'product', %L)$$,
         :itemN, :orgA, :whA, :u_stf),
  '11: an insert may still open with stock (every create does today)');
select is((select created_by from public.inventory_items where id = :itemN), :u_mgr::uuid,
  '12: ... and 0359 still records the real creator');
select throws_ok(
  format($$update public.inventory_items set organization_id = %L where id = %L$$, :orgB, :itemS),
  '42501', 'An item cannot be moved to another organization.',
  '13: the 0359 rules still come first');
select is(
  (select array_agg(x) from public.compensate_opening_stock(:orgA::uuid, array[:itemN::uuid]) x),
  array[:itemN::uuid],
  '14: the failed-create rollback (SECURITY DEFINER) still zeroes a fresh item');
reset role;

-- ═══ PART 3: item_stock_levels ══════════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_stf;
set local role to 'authenticated';

select throws_ok(
  format($$insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values (%L, %L, %L, 99)$$,
         :orgA, :itemS, :loc2),
  '42501', 'ledger_only',
  '15: a direct holdings insert is refused');
select throws_ok(
  format($$update public.item_stock_levels set quantity = 99 where item_id = %L and location_id = %L$$, :itemS, :loc1),
  '42501', 'ledger_only',
  '16: a direct holdings update is refused');
select throws_ok(
  format($$delete from public.item_stock_levels where item_id = %L and location_id = %L$$, :itemS, :loc1),
  '42501', null,
  '17: a direct holdings delete is refused');
select lives_ok(
  format($$select public.transfer_stock(%L, %L, %L, 2, 'rack move 0364')$$, :itemS, :loc1, :loc2),
  '18: transfer_stock still moves holdings as the user');
reset role;
set local "request.jwt.claim.sub"  to :u_mgr;
set local role to 'authenticated';
with gone as (delete from public.locations where id = :locGone returning 1)
select is((select count(*)::int from gone), 1,
  '19: deleting a rack still clears its (empty) holdings row: the FK cascade runs as the owner, so the guard lets it through');
reset role;

-- ═══ PART 4: purchase_orders inserts ════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local role to 'authenticated';

select throws_ok(
  format($$insert into public.purchase_orders (organization_id, po_number, status, supplier_id) values (%L, 'PO-0364-1', 'ordered', %L)$$,
         :orgA, :supA),
  '42501', 'A new purchase order starts as a draft.',
  '20: a PO cannot be created already ordered (it would skip the approval threshold)');
select throws_ok(
  format($$insert into public.purchase_orders (organization_id, po_number, status, supplier_id) values (%L, 'PO-0364-2', 'received', %L)$$,
         :orgA, :supA),
  '42501', 'A new purchase order starts as a draft.',
  '21: nor already received');
select throws_ok(
  format($$insert into public.purchase_orders (organization_id, po_number, status, ordered_at) values (%L, 'PO-0364-3', 'draft', now())$$,
         :orgA),
  '42501', 'A new purchase order has no ordered or received date.',
  '22: a draft cannot carry an ordered date');
select lives_ok(
  format($$insert into public.purchase_orders (id, organization_id, po_number, status, supplier_id, created_by, updated_by, created_at)
           values (%L, %L, 'PO-0364-4', 'draft', %L, %L, %L, '2001-01-01')$$,
         :poNew, :orgA, :supA, :u_stf, :u_stf),
  '23: a draft insert passes');
select ok(
  (select created_by = :u_mgr::uuid and updated_by = :u_mgr::uuid and created_at > now() - interval '1 minute'
     from public.purchase_orders where id = :poNew),
  '24: ... with the creator, updater and creation time recorded by the database');
reset role;
select lives_ok(
  format($$insert into public.purchase_orders (organization_id, po_number, status) values (%L, 'PO-0364-5', 'ordered')$$, :orgA),
  '25: postgres (the recurring-PO path runs as the service role) is exempt');

-- ═══ PART 5: purchase_order_items ═══════════════════════════════════════════
set local "request.jwt.claim.sub"  to :u_mgr;
set local role to 'authenticated';

select throws_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost) values (%L, %L, %L, 1, 1)$$,
         :orgA, :poOrd, :itemS),
  '42501', 'Lines can be added only to a draft purchase order.',
  '26: a line cannot be added to an ordered PO');
select lives_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost) values (%L, %L, %L, 1, 1)$$,
         :orgA, :poDraft, :itemS),
  '27: a line joins a draft');
select throws_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost) values (%L, %L, %L, 1, 1)$$,
         :orgA, :poB, :itemS),
  '42501', 'That purchase order is not part of this organization.',
  '28: another org''s PO still gets the org error first');
select throws_ok(
  format($$insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, unit_cost) values (%L, %L, %L, -1, 1)$$,
         :orgA, :poDraft, :itemS),
  '23514', 'A purchase order line needs a quantity above 0 and a cost of 0 or more.',
  '29: a negative line is still refused (the 0360 threshold rule)');

-- ═══ PART 6: charges, rentals, rental lines ═════════════════════════════════
select throws_ok(
  format($$insert into public.purchase_order_charges (organization_id, purchase_order_id, charge_type, label, amount) values (%L, %L, 'freight', 'Freight', 5)$$,
         :orgA, :poDraft),
  '42501', null,
  '30: charges are written only by the import approval');
select throws_ok(
  format($$insert into public.rentals (organization_id, warehouse_id, borrower_name, expected_return_at, status) values (%L, %L, 'Header only', now() + interval '1 day', 'out')$$,
         :orgA, :whA),
  '42501', null,
  '31: a header-only rental (the pre-1.4.0 phone) is refused');
select throws_ok(
  format($$update public.rentals set status = 'returned' where id = %L$$, :rentA),
  '42501', null,
  '32: a rental is not returned by PATCH');
select throws_ok(
  format($$delete from public.rentals where id = %L$$, :rentA),
  '42501', null,
  '33: nor deleted (which used to cascade its holds away)');
select throws_ok(
  format($$insert into public.rental_lines (rental_id, item_id, quantity) values (%L, %L, 1)$$, :rentA, :itemS),
  '42501', null,
  '34: rental lines come only from create_rental');
reset role;

select * from finish();
rollback;
