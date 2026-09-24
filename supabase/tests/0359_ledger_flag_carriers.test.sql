-- supabase/tests/0359_ledger_flag_carriers.test.sql
-- Proves migration 0359 (stock-ledger lockdown, prepare).
--
-- PART 1 (1-24) Structure. The eight ledger RPCs keep the exact contract
--   installed phones call (argument list, result, INVOKER, EXECUTE), their
--   bodies live in the unexposed `ledger` schema, and a census proves only
--   those eight wrappers can raise stockpilot.ledger.
-- PART 2 (25-33) The phone path: adjust_stock with the installed build's
--   named arguments still adjusts on-hand, holdings and the ledger, and the
--   flag does not outlive the call. It nests (restores 'on' to an outer
--   ledger caller).
-- PART 3 (34-41) Direct bypasses refused: the SECDEF helpers without the
--   flag, and every write to receipts / receipt_lines / receipt_line_lots.
-- PART 4 (42-58) inventory_items guard: org immutable; cost / charter /
--   warehouse edits follow the item-edit rules; unchanged values and other
--   columns pass; the PO-import re-charter carve-out; owner writes exempt.
-- PART 5 (59-67) compensate_opening_stock: only the caller's own fresh,
--   unledgered items; the gate; the size cap.
-- PART 6 (68-70) recompute_po_status ignores lines filed under the PO from
--   another org.
-- PART 7 (71-79) Review hardening: the flag is bound to its transaction (a
--   literal 'on' or another transaction's id opens nothing); no API-callable
--   function runs dynamic SQL; an item's creator and creation time are the
--   database's; compensate_opening_stock ignores the caller's older and
--   soft-deleted items; the real service_role (not only postgres) is exempt.
--
-- Roles: table guards key on current_user, so those assertions run under
-- `set local role authenticated`. Helper gates key on auth.uid(), set with
-- request.jwt.claim.sub. No assertion calls a function the role lacks
-- EXECUTE on (the supautils permission-denied-function segfault class);
-- closed grants are asserted from the catalog.
--
-- Run via `supabase test db` after `supabase db reset`.

begin;
select plan(79);

\set orgA    '\'03590000-0000-0000-0000-00000000000a\''
\set orgB    '\'03590000-0000-0000-0000-00000000000b\''
\set u_stf   '\'03590000-0000-0000-0000-0000000000a1\''
\set u_mgr   '\'03590000-0000-0000-0000-0000000000a2\''
\set u_adm   '\'03590000-0000-0000-0000-0000000000a3\''
\set u_scp   '\'03590000-0000-0000-0000-0000000000a4\''
\set u_rev   '\'03590000-0000-0000-0000-0000000000a5\''
\set u_po    '\'03590000-0000-0000-0000-0000000000a6\''
\set u_mgrB  '\'03590000-0000-0000-0000-0000000000b1\''
\set whA     '\'03590000-0000-0000-0000-0000000000c1\''
\set whA2    '\'03590000-0000-0000-0000-0000000000c2\''
\set whB     '\'03590000-0000-0000-0000-0000000000c3\''
\set rackA   '\'03590000-0000-0000-0000-0000000000c9\''
\set chA1    '\'03590000-0000-0000-0000-0000000000d1\''
\set itemS   '\'03590000-0000-0000-0000-0000000000e1\''
\set itemZ   '\'03590000-0000-0000-0000-0000000000e2\''
\set itemC1  '\'03590000-0000-0000-0000-0000000000e3\''
\set itemC2  '\'03590000-0000-0000-0000-0000000000e4\''
\set itemC3  '\'03590000-0000-0000-0000-0000000000e5\''
\set itemB   '\'03590000-0000-0000-0000-0000000000e6\''
\set itemM   '\'03590000-0000-0000-0000-0000000000e7\''
\set poA     '\'03590000-0000-0000-0000-0000000000f1\''
\set poLine  '\'03590000-0000-0000-0000-0000000000f2\''
\set rcpt    '\'03590000-0000-0000-0000-0000000000f3\''
\set rline   '\'03590000-0000-0000-0000-0000000000f4\''
\set badLine '\'03590000-0000-0000-0000-0000000000f6\''

-- ── Fixtures (as postgres: RLS bypassed, guards exempt) ─────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  (:u_stf,  'stf-0359@test.local',  '{}'::jsonb),
  (:u_mgr,  'mgr-0359@test.local',  '{}'::jsonb),
  (:u_adm,  'adm-0359@test.local',  '{}'::jsonb),
  (:u_scp,  'scp-0359@test.local',  '{}'::jsonb),
  (:u_rev,  'rev-0359@test.local',  '{}'::jsonb),
  (:u_po,   'po-0359@test.local',   '{}'::jsonb),
  (:u_mgrB, 'mgrb-0359@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgA, 'Ledger Org A 0359', 'ledger-org-a-0359'),
  (:orgB, 'Ledger Org B 0359', 'ledger-org-b-0359');

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :u_stf,  'staff',   now()),
  (:orgA, :u_mgr,  'manager', now()),
  (:orgA, :u_adm,  'admin',   now()),
  (:orgA, :u_scp,  'staff',   now()),
  (:orgA, :u_rev,  'staff',   now()),
  (:orgA, :u_po,   'staff',   now()),
  (:orgB, :u_mgrB, 'manager', now());

insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, 'Ledger WH A 0359',  'L0359A',  'active'),
  (:whA2, :orgA, 'Ledger WH A2 0359', 'L0359A2', 'active'),
  (:whB,  :orgB, 'Ledger WH B 0359',  'L0359B',  'active');

insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rackA, :orgA, :whA, 'Rack A 0359', 'bin', 'rack');

-- Staff read/write by assignment. u_scp is assigned to BOTH A warehouses, so
-- RLS would admit a move between them: only the new guard refuses it.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :u_stf, :whA,  true),
  (:orgA, :u_scp, :whA,  true),
  (:orgA, :u_scp, :whA2, false),
  (:orgA, :u_rev, :whA,  true),
  (:orgA, :u_po,  :whA,  true);

insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :u_rev, 'items:update',           false),
  (:orgA, :u_po,  'items:update',           false),
  (:orgA, :u_po,  'purchase_orders:manage', true);

insert into public.charters (id, organization_id, name) values
  (:chA1, :orgA, 'Charter A1 0359');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chA1);

-- itemS: stocked; the 0199 seed trigger places its 10 in whA's Unplaced.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, item_type) values
  (:itemS, :orgA, :whA, 'L0359-S', 'Stocked 0359', 10, 2, 'active', 'product'),
  (:itemZ, :orgA, :whA, 'L0359-Z', 'Unstocked 0359', 0, 2, 'active', 'product'),
  (:itemM, :orgA, :whA, 'L0359-M', 'Movable 0359', 0, 2, 'active', 'product');

-- Compensation candidates: C1 is the caller's fresh unledgered item; C2 has
-- an 'initial' movement; C3 belongs to another user; itemB to another org.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by) values
  (:itemC1, :orgA, :whA, 'L0359-C1', 'Comp 1', 5, 'active', 'product', :u_stf),
  (:itemC2, :orgA, :whA, 'L0359-C2', 'Comp 2', 5, 'active', 'product', :u_stf),
  (:itemC3, :orgA, :whA, 'L0359-C3', 'Comp 3', 5, 'active', 'product', :u_mgr),
  (:itemB,  :orgB, :whB, 'L0359-B',  'Other org', 5, 'active', 'product', :u_stf);
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id) values
  (:orgA, :itemC2, 'initial', 5, 0, 5, :u_stf);

-- A posted receipt, written as postgres (the guard exempts the owner).
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:poA, :orgA, 'PO-0359-1', 'ordered');
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:poLine, :orgA, :poA, :itemS, 10, 0, 1);
insert into public.receipts
  (id, organization_id, purchase_order_id, warehouse_id, receipt_number, status, received_by, immutable_hash) values
  (:rcpt, :orgA, :poA, :whA, 'R-0359-1', 'posted', :u_mgr, 'hash-0359-1');
insert into public.receipt_lines
  (id, receipt_id, purchase_order_line_id, item_id, qty_received_base, qty_accepted_base) values
  (:rline, :rcpt, :poLine, :itemS, 1, 1);

-- ═══ PART 1: structure ══════════════════════════════════════════════════════

-- 1-8: the installed-client contract, one row per wrapper.
select is(pg_get_function_arguments('public.adjust_stock(uuid, numeric, text, uuid, text, text, text)'::regprocedure),
  'p_item_id uuid, p_quantity_change numeric, p_movement_type text, p_location_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_mode text DEFAULT ''placed''::text',
  '1: adjust_stock keeps its exact argument list (the installed phone calls it by name)');
select is(pg_get_function_arguments('public.transfer_stock(uuid, uuid, uuid, numeric, text)'::regprocedure),
  'p_item_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_notes text DEFAULT NULL::text',
  '2: transfer_stock keeps its argument list');
select is(pg_get_function_arguments('public.post_cycle_count(uuid)'::regprocedure),
  'p_cycle_count_id uuid',
  '3: post_cycle_count keeps its argument list');
select is(pg_get_function_arguments('public.assemble_bundle(uuid, numeric, uuid, text)'::regprocedure),
  'p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_notes text DEFAULT NULL::text',
  '4: assemble_bundle keeps its argument list');
select is(pg_get_function_arguments('public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text)'::regprocedure),
  'p_bundle_id uuid, p_quantity numeric, p_warehouse_id uuid, p_allow_shortage boolean, p_schedule_event_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text',
  '5: distribute_bundle keeps its argument list');
select is(pg_get_function_arguments('public.process_return_disposition(uuid)'::regprocedure),
  'p_return_id uuid',
  '6: process_return_disposition keeps its argument list');
select is(pg_get_function_arguments('public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)'::regprocedure),
  'p_purchase_order_id uuid, p_warehouse_id uuid, p_lines jsonb, p_idempotency_key text, p_request_hash text, p_notes text DEFAULT NULL::text',
  '7: post_receipt_v2 keeps its argument list');
select is(pg_get_function_arguments('public.reverse_receipt(uuid, text)'::regprocedure),
  'p_receipt_id uuid, p_reason text',
  '8: reverse_receipt keeps its argument list');

-- 9: results unchanged.
select is(
  array(select pg_get_function_result(p.oid) from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('adjust_stock','transfer_stock','post_cycle_count','assemble_bundle',
                             'distribute_bundle','process_return_disposition','post_receipt_v2','reverse_receipt')
         order by p.proname),
  -- adjust_stock, assemble_bundle, distribute_bundle, post_cycle_count,
  -- post_receipt_v2, process_return_disposition, reverse_receipt, transfer_stock
  array['inventory_items', 'TABLE(phantom_item_id uuid, phantom_qty numeric)', 'uuid',
        'cycle_counts', 'receipts', 'returns', 'receipts', 'inventory_items'],
  '9: every wrapper returns exactly what its body returned');

-- 10: one overload each (PostgREST named-argument resolution must stay unambiguous).
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('adjust_stock','transfer_stock','post_cycle_count','assemble_bundle',
                        'distribute_bundle','process_return_disposition','post_receipt_v2','reverse_receipt')),
  8, '10: exactly one public overload of each ledger RPC');

-- 11: all wrappers are SECURITY INVOKER.
select ok(
  not exists (select 1 from pg_proc p
               where p.pronamespace = 'public'::regnamespace and p.prosecdef
                 and p.proname in ('adjust_stock','transfer_stock','post_cycle_count','assemble_bundle',
                                   'distribute_bundle','process_return_disposition','post_receipt_v2','reverse_receipt')),
  '11: every wrapper is SECURITY INVOKER (RLS still applies to the bodies they call)');

-- 12-13: EXECUTE posture of the wrappers.
select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute')
               and has_function_privilege('service_role', p.oid, 'execute'))
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('adjust_stock','transfer_stock','post_cycle_count','assemble_bundle',
                        'distribute_bundle','process_return_disposition','post_receipt_v2','reverse_receipt')),
  '12: authenticated and service_role keep EXECUTE on every wrapper');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.pronamespace in ('public'::regnamespace, 'ledger'::regnamespace)
       and p.proname in ('adjust_stock','transfer_stock','post_cycle_count','assemble_bundle',
                         'distribute_bundle','process_return_disposition','post_receipt_v2','reverse_receipt')
       and a.privilege_type = 'EXECUTE'
       and (a.grantee = 0 or a.grantee = 'anon'::regrole)),
  '13: neither PUBLIC nor anon holds EXECUTE on a wrapper or a body');

-- 14-16: the bodies moved, unchanged in kind.
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'ledger'::regnamespace
      and p.proname in ('adjust_stock','transfer_stock','post_cycle_count','assemble_bundle',
                        'distribute_bundle','process_return_disposition','post_receipt_v2','reverse_receipt')),
  8, '14: all eight bodies live in the ledger schema');
-- 0369 adds ledger.cycle_count_line_superseded, the post's read of other
-- counts' movements: SECURITY DEFINER on purpose (an invoker read fails open
-- under the stock_movements SELECT policy), gated on ledger.active(). The
-- eight moved bodies keep their kind.
select is(
  array(select p.proname::text from pg_proc p
         where p.pronamespace = 'ledger'::regnamespace and p.prosecdef order by 1),
  array['cycle_count_line_superseded', 'process_return_disposition'],
  '15: only process_return_disposition''s body (and the 0369 superseded probe) is SECURITY DEFINER, as before the move');
select ok(
  not has_schema_privilege('anon', 'ledger', 'usage')
  and has_schema_privilege('authenticated', 'ledger', 'usage'),
  '16: anon cannot reach the ledger schema; authenticated can (the INVOKER wrappers call into it as the user)');

-- 17-18: census. Only the eight wrappers raise the flag.
select is(
  array(select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
           and p.prosrc ~* '(set_config|set\s+(local\s+)?)[^;]*stockpilot\.ledger'
         order by 1),
  array['public.adjust_stock', 'public.assemble_bundle', 'public.distribute_bundle',
        'public.post_cycle_count', 'public.post_receipt_v2', 'public.process_return_disposition',
        'public.reverse_receipt', 'public.transfer_stock'],
  '17: exactly the eight ledger wrappers can raise stockpilot.ledger');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'storage', 'graphql_public', 'ledger')
      and p.prosrc ~ 'set_config\s*\(\s*[^''\s]'),
  0, '18: no function passes a non-literal setting name to set_config (no caller-chosen flag)');

-- 19-20: guard functions and triggers.
select ok(
  not exists (select 1 from pg_proc p
               where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('tg_ledger_only_guard', 'tg_inventory_items_guard') and p.prosecdef),
  '19: both guard functions are SECURITY INVOKER (a DEFINER trigger would see postgres and never enforce)');
select is(
  array(select c.relname || ':' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where t.tgname like 'trg_zz_%guard'
           and c.relname in ('receipts', 'receipt_lines', 'receipt_line_lots', 'inventory_items')
           and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2   -- ROW, BEFORE
         order by 1),
  array['inventory_items:trg_zz_inventory_items_guard', 'receipt_line_lots:trg_zz_receipt_line_lots_guard',
        'receipt_lines:trg_zz_receipt_lines_guard', 'receipts:trg_zz_receipts_guard'],
  '20: the four guards are BEFORE ROW triggers');

-- 21-23: grants.
select ok(
  not exists (
    select 1 from unnest(array['inventory_items', 'item_stock_levels', 'receipts', 'receipt_lines', 'receipt_line_lots']) t,
                  unnest(array['TRUNCATE', 'TRIGGER', 'REFERENCES']) p,
                  unnest(array['authenticated', 'anon']) r
     where has_table_privilege(r, 'public.' || t, p)),
  '21: no API role holds TRUNCATE, TRIGGER or REFERENCES on the five ledger tables');
select ok(
  not exists (
    select 1 from unnest(array['inventory_items', 'item_stock_levels', 'receipts', 'receipt_lines', 'receipt_line_lots']) t,
                  unnest(array['INSERT', 'UPDATE', 'DELETE']) p
     where has_table_privilege('anon', 'public.' || t, p))
  and not has_table_privilege('authenticated', 'public.inventory_items', 'DELETE'),
  '22: anon writes none of the five tables, and no API role hard-deletes an item');
-- 0364 revoked DELETE on item_stock_levels: no ledger body deletes a holding.
select ok(
  (select bool_and(has_table_privilege('authenticated', 'public.' || t, p))
     from unnest(array['receipts', 'receipt_lines', 'receipt_line_lots']) t,
          unnest(array['INSERT', 'UPDATE', 'DELETE']) p)
  and has_table_privilege('authenticated', 'public.item_stock_levels', 'INSERT')
  and has_table_privilege('authenticated', 'public.item_stock_levels', 'UPDATE')
  and has_table_privilege('authenticated', 'public.inventory_items', 'UPDATE'),
  '23: authenticated keeps the DML the INVOKER ledger bodies perform as the user');

-- 24: recompute_po_status is closed to anon and PUBLIC, open to authenticated.
select ok(
  has_function_privilege('authenticated', 'public.recompute_po_status(uuid)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.recompute_po_status(uuid)'::regprocedure
                     and a.privilege_type = 'EXECUTE'
                     and (a.grantee = 0 or a.grantee = 'anon'::regrole)),
  '24: recompute_po_status: authenticated keeps EXECUTE; PUBLIC and anon lose it');

-- ═══ PART 2: the installed phone's adjust_stock ═════════════════════════════
set local "request.jwt.claim.sub"  to :u_stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

select is(
  (public.adjust_stock(p_item_id => :itemS, p_quantity_change => 1, p_movement_type => 'add',
                       p_location_id => null, p_reason => 'Mobile detail', p_notes => null)).quantity_on_hand,
  11::numeric,
  '25: the phone''s exact named-argument call still adds to on-hand');
select is(coalesce(current_setting('stockpilot.ledger', true), ''), '',
  '26: ... and the flag is off again as soon as it returns (no leak into the rest of the request)');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemS and l.kind = 'staging'),
  1::numeric,
  '27: ... the added unit landed in Staging through the SECDEF helper');
select is(
  (select count(*)::int from public.stock_movements where item_id = :itemS and movement_type = 'add'),
  1, '28: ... and wrote its movement');
select is(
  (public.adjust_stock(p_item_id => :itemS, p_quantity_change => -1, p_movement_type => 'remove',
                       p_location_id => null, p_reason => 'Mobile detail', p_notes => null)).quantity_on_hand,
  11::numeric - 1,
  '29: the phone''s remove still works');
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :itemS and l.kind is distinct from 'staging'),
  9::numeric,
  '30: ... drawing the placed holding down (10 -> 9), not Staging');
-- The on-hand rule arrives with the enforcement migration; a table this step
-- already guards proves the flag is off.
select throws_ok(
  format($$insert into public.receipt_line_lots (receipt_line_id, lot_number, qty_base) values (%L, 'LOT-LEAK', 1)$$, :rline),
  '42501', 'ledger_only',
  '31: after the call, a guarded write in the same transaction is refused (the flag really is gone)');

-- Nesting: an outer ledger caller (post_receipt_v2 calling adjust_stock) keeps
-- its flag after the inner wrapper returns.
-- The flag holds the current transaction's id (0359: ledger.active()).
do $$ begin perform set_config('stockpilot.ledger', pg_current_xact_id()::text, true); end $$;
select lives_ok(
  format($$select public.adjust_stock(%L, 1, 'add', null, 'nested', null)$$, :itemS),
  '32: adjust_stock runs inside an outer ledger call');
select is(current_setting('stockpilot.ledger', true), pg_current_xact_id()::text,
  '33: ... and hands the outer caller its flag back');
set local stockpilot.ledger to '';

-- ═══ PART 3: direct bypasses refused ════════════════════════════════════════
select throws_ok(
  format($$select public.apply_level_delta(%L, 500)$$, :itemS),
  '42501', 'ledger_only',
  '34: staff cannot call apply_level_delta directly to mint holdings');
set local "request.jwt.claim.sub" to :u_mgr;
select throws_ok(
  format($$select public.apply_cycle_count_location_delta(%L, %L, %L, 5)$$, :itemS, :rackA, :orgA),
  '42501', 'ledger_only',
  '35: a manager cannot call apply_cycle_count_location_delta directly');
select is(
  (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemS and location_id = :rackA),
  0::numeric, '36: ... and the rack holding was not written');

select throws_ok(
  format($$insert into public.receipts (organization_id, purchase_order_id, warehouse_id, receipt_number,
                                       status, received_by, immutable_hash)
           values (%L, %L, %L, 'R-0359-FORGED', 'posted', %L, 'hash-forged')$$, :orgA, :poA, :whA, :u_mgr),
  '42501', 'ledger_only',
  '37: a manager cannot fabricate a receipt');
select throws_ok(
  format($$update public.receipts set status = 'reversed' where id = %L$$, :rcpt),
  '42501', 'ledger_only',
  '38: nor flip a posted receipt to reversed');
select throws_ok(
  format($$delete from public.receipts where id = %L$$, :rcpt),
  '42501', 'ledger_only',
  '39: nor delete it');
select throws_ok(
  format($$update public.receipt_lines set qty_accepted_base = 100, unit_cost = 0 where id = %L$$, :rline),
  '42501', 'ledger_only',
  '40: nor rewrite a receipt line''s quantity or cost (they feed the QuickBooks bill)');
reset role;
select is((select status from public.receipts where id = :rcpt), 'posted',
  '41: the receipt is untouched');

-- ═══ PART 4: inventory_items guard ══════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(
  format($$update public.inventory_items set unit_cost = 5 where id = %L$$, :itemS),
  '42: staff holding items:update may change the unit cost');
select is((select unit_cost from public.inventory_items where id = :itemS), 5::numeric,
  '43: ... and it changed');
select throws_ok(
  format($$update public.inventory_items set unit_cost = -1 where id = %L$$, :itemS),
  '23514', 'Unit cost must be 0 or more.',
  '44: a negative unit cost is refused');

set local "request.jwt.claim.sub" to :u_rev;
select throws_ok(
  format($$update public.inventory_items set unit_cost = 7 where id = %L$$, :itemS),
  '42501', 'You do not have permission to change this item''s cost, charter or warehouse.',
  '45: staff whose items:update is revoked cannot change cost (the policy''s staff arm admitted it)');
select lives_ok(
  format($$update public.inventory_items set name = 'Renamed 0359' where id = %L$$, :itemS),
  '46: ... but other columns still go through (the guard is about the three fields)');
select lives_ok(
  format($$update public.inventory_items set unit_cost = 5, charter_id = null, warehouse_id = %L where id = %L$$, :whA, :itemS),
  '47: re-sending the SAME cost, charter and warehouse passes (the item form sends all three on every save)');

set local "request.jwt.claim.sub" to :u_adm;
select throws_ok(
  format($$update public.inventory_items set organization_id = %L where id = %L$$, :orgB, :itemS),
  '42501', 'An item cannot be moved to another organization.',
  '48: not even an admin can move an item to another organization');

set local "request.jwt.claim.sub" to :u_scp;
select throws_ok(
  format($$update public.inventory_items set warehouse_id = %L where id = %L$$, :whA2, :itemM),
  '42501', 'Warehouse-scoped users cannot move items to another warehouse.',
  '49: a warehouse-scoped staffer cannot move an item, even between two warehouses they can write');

set local "request.jwt.claim.sub" to :u_mgr;
select throws_ok(
  format($$update public.inventory_items set warehouse_id = %L where id = %L$$, :whB, :itemM),
  '42501', 'That warehouse is not part of this organization.',
  '50: a manager cannot move an item into another org''s warehouse (the policy never checked the org)');
select throws_ok(
  format($$update public.inventory_items set warehouse_id = null where id = %L$$, :itemM),
  '23514', 'Item must remain assigned to a warehouse.',
  '51: nor clear the warehouse');
select lives_ok(
  format($$update public.inventory_items set warehouse_id = %L where id = %L$$, :whA2, :itemM),
  '52: a manager may move an item between their own org''s warehouses');
select is((select warehouse_id from public.inventory_items where id = :itemM), :whA2::uuid,
  '53: ... and it moved');

-- PO-import approval re-charters an item it just created, as a PO manager
-- who may lack items:update.
set local "request.jwt.claim.sub" to :u_po;
select lives_ok(
  format($$update public.inventory_items set charter_id = %L where id = %L$$, :chA1, :itemZ),
  '54: a PO manager without items:update may re-charter an unstocked item (PO-import approval)');
select throws_ok(
  format($$update public.inventory_items set charter_id = %L where id = %L$$, :chA1, :itemS),
  '42501', 'You do not have permission to change this item''s cost, charter or warehouse.',
  '55: ... but not an item holding stock');
select throws_ok(
  format($$update public.inventory_items set unit_cost = 9 where id = %L$$, :itemZ),
  '42501', 'You do not have permission to change this item''s cost, charter or warehouse.',
  '56: ... and the carve-out is charter-only');
reset role;

-- Owner writes (SECDEF bodies, service_role, FK actions) are exempt.
select lives_ok(
  format($$update public.inventory_items set warehouse_id = null where id = %L$$, :itemM),
  '57: the table owner is not held to the API-role rules (ON DELETE SET NULL, SECDEF bodies)');
select is((select charter_id from public.inventory_items where id = :itemZ), :chA1::uuid,
  '58: the carve-out re-charter was applied');

-- ═══ PART 5: compensate_opening_stock ═══════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select is(
  array(select public.compensate_opening_stock(:orgA, array[:itemC1, :itemC2, :itemC3, :itemB]::uuid[])),
  array[:itemC1]::uuid[],
  '59: only the caller''s own fresh item with no movement is compensated');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itemC1), 0::numeric,
  '60: ... its on-hand is 0');
select is((select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = :itemC1), 0::numeric,
  '61: ... and its seeded placement is 0');
select is((select quantity_on_hand from public.inventory_items where id = :itemC2), 5::numeric,
  '62: an item with an ''initial'' movement is never touched (established ledger)');
select is((select quantity_on_hand from public.inventory_items where id = :itemC3), 5::numeric,
  '63: another user''s item is never touched');
select is((select quantity_on_hand from public.inventory_items where id = :itemB), 5::numeric,
  '64: another org''s item is never touched');

set local role to 'authenticated';
select throws_ok(
  format($$select public.compensate_opening_stock(%L, array[%L]::uuid[])$$, :orgB, :itemB),
  '42501', 'forbidden',
  '65: a non-member of the org is refused');
select throws_ok(
  format($$select public.compensate_opening_stock(%L, array(select gen_random_uuid() from generate_series(1, 1001)))$$, :orgA),
  '22023', 'too_many_items',
  '66: more than 1000 ids is refused');
reset role;
set local "request.jwt.claim.sub" to '';
select throws_ok(
  format($$select public.compensate_opening_stock(%L, array[%L]::uuid[])$$, :orgA, :itemC3),
  '42501', 'forbidden',
  '67: an unauthenticated call is refused');

-- ═══ PART 6: recompute_po_status counts only the PO's own org ═══════════════
-- A line filed under org A's PO but tagged org B (purchase_order_items_write
-- checks organization_id alone). Called as the owner, where RLS would not hide it.
insert into public.purchase_order_items
  (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:badLine, :orgB, :poA, :itemB, 1, 100, 1);
select is(public.recompute_po_status(:poA), 'ordered',
  '68: an injected foreign line does not mark the PO received');
select is((select status from public.purchase_orders where id = :poA), 'ordered',
  '69: ... and the PO row stays ordered');
update public.purchase_order_items set quantity_received = 10 where id = :poLine;
select is(public.recompute_po_status(:poA), 'received',
  '70: the PO''s own lines still drive it (fully received -> received)');

-- ═══ PART 7: review hardening ═══════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
set local stockpilot.ledger to 'on';
select throws_ok(
  format($$insert into public.receipt_line_lots (receipt_line_id, lot_number, qty_base) values (%L, 'LOT-ON', 1)$$, :rline),
  '42501', 'ledger_only',
  '71: the old literal flag value opens nothing (the flag must hold this transaction''s id)');
do $$ begin perform set_config('stockpilot.ledger', (pg_current_xact_id()::text::bigint - 1)::text, true); end $$;
select throws_ok(
  format($$insert into public.receipt_line_lots (receipt_line_id, lot_number, qty_base) values (%L, 'LOT-OLD', 1)$$, :rline),
  '42501', 'ledger_only',
  '72: nor does another transaction''s id (a value left on a pooled connection)');
set local stockpilot.ledger to '';
reset role;

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'graphql_public', 'ledger')
      and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))
      and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M'),
  0,
  '73: no API-callable function in an exposed schema (or ledger) runs dynamic SQL, so none can raise the flag for its caller');

set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(
  format($$insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, status, item_type, created_by, created_at)
           values ('03590000-0000-0000-0000-0000000000f7', %L, %L, 'L0359-P', 'Pinned', 'active', 'product', %L, '2001-01-01')$$,
         :orgA, :whA, :u_mgr),
  '74: staff create an item (naming someone else as creator, in 2001)');
reset role;
select is(
  (select row(created_by, created_at > now() - interval '1 minute')::text from public.inventory_items
    where id = '03590000-0000-0000-0000-0000000000f7'),
  row(:u_stf::uuid, true)::text,
  '75: ... the database records the caller and now instead');
set local role to 'authenticated';
select throws_ok(
  $$update public.inventory_items set created_at = now() - interval '1 day' where id = '03590000-0000-0000-0000-0000000000f7'$$,
  '42501', 'An item''s creator and creation time cannot be changed.',
  '76: and neither can be rewritten later (the failed-create rollback trusts both)');
reset role;

-- The caller's own stocked, unledgered items that are NOT a failed create:
-- one an hour old, one soft-deleted.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, item_type, created_by, created_at, deleted_at) values
  ('03590000-0000-0000-0000-0000000000f8', :orgA, :whA, 'L0359-OLD', 'Hour old', 5, 'active', 'product', :u_stf, now() - interval '1 hour', null),
  ('03590000-0000-0000-0000-0000000000f9', :orgA, :whA, 'L0359-DEL', 'Deleted', 5, 'archived', 'product', :u_stf, now(), now());
set local role to 'authenticated';
select is(
  array(select public.compensate_opening_stock(:orgA,
    array['03590000-0000-0000-0000-0000000000f8', '03590000-0000-0000-0000-0000000000f9']::uuid[])),
  array[]::uuid[],
  '77: compensation ignores the caller''s older and soft-deleted items');
reset role;
select is(
  (select sum(quantity_on_hand) from public.inventory_items
    where id in ('03590000-0000-0000-0000-0000000000f8', '03590000-0000-0000-0000-0000000000f9')),
  10::numeric,
  '78: ... and their stock is untouched');

-- The server's own client arrives as service_role, not postgres.
set local role to 'service_role';
select lives_ok(
  format($$update public.inventory_items set warehouse_id = %L, unit_cost = 3 where id = %L$$, :whA2, :itemM),
  '79: the service_role (Model B fan-out, crons) is not held to the API-role rules');
reset role;

select * from finish();
rollback;
