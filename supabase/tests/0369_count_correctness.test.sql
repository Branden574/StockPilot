-- supabase/tests/0369_count_correctness.test.sql
-- pgTAP proof for migration 0369 (Phase 0 S5-C, count correctness).
--
-- A. stock_movements.via_ledger: stamped by the trigger, never by the writer.
--    Ledger writers (adjust, transfer, post) are TRUE; a signed-in user's
--    direct insert is FALSE even when it says TRUE; a non-API role is TRUE.
-- B. Overlapping counts (D6): A and B both record 22 on 20. A posts (22), B is
--    refused as superseded and nothing moves. B cleared and recounted after A
--    posts: B posts with no movement. A pick after B's count does not block B.
--    A staff-inserted movement moves neither the guard nor the baseline. A
--    line that matches its book is never refused. Every superseded line is
--    named in one refusal. A counted line with no baseline fails closed.
-- C. Offline capture time (D7): capture at T0, then an adjust of -3: the
--    variance is 0 and the post leaves 17. Clamps: a future capture is
--    clamped to now(), a capture before the count started is clamped to
--    started_at, a transfer after T0 moves nothing (and leaves the location
--    un-inferred), clearing nulls captured_at and baseline_at, a re-record
--    without a capture time is an online record, and a retry that re-sends
--    the same capture time keeps it.
-- D. Rental equipment and kit phantoms are not counted (D8), in either scope;
--    a rental-only selection raises cycle_count_no_items.
-- E. Grants: captured_at is client-writable, baseline_at is not.
-- H. A trusted row dated in the future (a pre-0369 plant) moves neither a
--    baseline nor the guard.
--
-- The mutation each case must catch is named next to it.
--
-- TIME INSIDE ONE TRANSACTION. now() is the transaction start for the whole
-- file, so every movement a ledger RPC writes here carries created_at =
-- now(); the post's own movement and an online record's baseline use
-- clock_timestamp() and are later. Capture times are therefore placed
-- relative to now() (the counts start an hour earlier). The concurrency
-- properties (a record waits for an in-flight post; overlapping posts never
-- deadlock) need two sessions and live in
-- scripts/db-concurrency/0369_count_overlap.sh.
--
-- Roles: fixtures as the test superuser; records, posts and ledger RPCs run as
-- `authenticated` with request.jwt.claim.sub, so grants, RLS and the guards
-- apply for real. begin/rollback: nothing leaks. Namespace 03690000.

begin;

select plan(87);

\set org     '\'03690000-0000-0000-0000-00000000000a\''
\set mgr     '\'03690000-0000-0000-0000-0000000000a1\''
\set stf     '\'03690000-0000-0000-0000-0000000000a2\''
\set wh      '\'03690000-0000-0000-0000-0000000000b1\''
\set whG     '\'03690000-0000-0000-0000-0000000000b2\''
\set r1      '\'03690000-0000-0000-0000-0000000000e1\''
\set r2      '\'03690000-0000-0000-0000-0000000000e2\''
\set rG      '\'03690000-0000-0000-0000-0000000000e3\''
\set itAB    '\'03690000-0000-0000-0000-0000000000c1\''
\set itPK    '\'03690000-0000-0000-0000-0000000000c2\''
\set itSF    '\'03690000-0000-0000-0000-0000000000c3\''
\set itCP    '\'03690000-0000-0000-0000-0000000000c4\''
\set itFU    '\'03690000-0000-0000-0000-0000000000c5\''
\set itPA    '\'03690000-0000-0000-0000-0000000000c6\''
\set itTR    '\'03690000-0000-0000-0000-0000000000c7\''
\set itLC    '\'03690000-0000-0000-0000-0000000000c8\''
\set itRE    '\'03690000-0000-0000-0000-0000000000c9\''
\set itVL    '\'03690000-0000-0000-0000-0000000000ca\''
\set itZD    '\'03690000-0000-0000-0000-0000000000cb\''
\set itGP    '\'03690000-0000-0000-0000-0000000000d1\''
\set itGR    '\'03690000-0000-0000-0000-0000000000d2\''
\set itGK    '\'03690000-0000-0000-0000-0000000000d3\''
\set itFD    '\'03690000-0000-0000-0000-0000000000cc\''
\set itFC    '\'03690000-0000-0000-0000-0000000000cd\''
\set itRT    '\'03690000-0000-0000-0000-0000000000ce\''
\set itM1    '\'03690000-0000-0000-0000-0000000000cf\''
\set itM2    '\'03690000-0000-0000-0000-0000000000da\''
\set itNB    '\'03690000-0000-0000-0000-0000000000db\''
\set ccA     '\'03690000-0000-0000-0000-0000000000f1\''
\set ccB     '\'03690000-0000-0000-0000-0000000000f2\''
\set ccP     '\'03690000-0000-0000-0000-0000000000f3\''
\set ccS     '\'03690000-0000-0000-0000-0000000000f4\''
\set ccS2    '\'03690000-0000-0000-0000-0000000000f5\''
\set ccC     '\'03690000-0000-0000-0000-0000000000f6\''
\set ccZ1    '\'03690000-0000-0000-0000-0000000000f7\''
\set ccZ2    '\'03690000-0000-0000-0000-0000000000f8\''
\set ccFD    '\'03690000-0000-0000-0000-0000000000f9\''
\set ccR     '\'03690000-0000-0000-0000-0000000000fa\''
\set ccM1    '\'03690000-0000-0000-0000-0000000000fb\''
\set ccM2    '\'03690000-0000-0000-0000-0000000000fc\''
\set ccN1    '\'03690000-0000-0000-0000-0000000000fd\''
\set ccN2    '\'03690000-0000-0000-0000-0000000000fe\''
\set lnA     '\'03690000-0000-0000-0000-000000000101\''
\set lnB     '\'03690000-0000-0000-0000-000000000102\''
\set lnP     '\'03690000-0000-0000-0000-000000000103\''
\set lnS     '\'03690000-0000-0000-0000-000000000104\''
\set lnCP    '\'03690000-0000-0000-0000-000000000105\''
\set lnFU    '\'03690000-0000-0000-0000-000000000106\''
\set lnPA    '\'03690000-0000-0000-0000-000000000107\''
\set lnTR    '\'03690000-0000-0000-0000-000000000108\''
\set lnLC    '\'03690000-0000-0000-0000-000000000109\''
\set lnRE    '\'03690000-0000-0000-0000-00000000010a\''
\set lnZ1    '\'03690000-0000-0000-0000-00000000010b\''
\set lnZ2    '\'03690000-0000-0000-0000-00000000010c\''
\set lnFD    '\'03690000-0000-0000-0000-00000000010d\''
\set lnFC    '\'03690000-0000-0000-0000-00000000010e\''
\set lnRT    '\'03690000-0000-0000-0000-00000000010f\''
\set lnM1a   '\'03690000-0000-0000-0000-000000000110\''
\set lnM1b   '\'03690000-0000-0000-0000-000000000111\''
\set lnM2a   '\'03690000-0000-0000-0000-000000000112\''
\set lnM2b   '\'03690000-0000-0000-0000-000000000113\''
\set lnN1    '\'03690000-0000-0000-0000-000000000114\''
\set lnN2    '\'03690000-0000-0000-0000-000000000115\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, '0369-mgr@test.local', '{}'::jsonb),
  (:stf, '0369-stf@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, '0369 Count Org', '0369-count-org') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now()),
  (:org, :stf, 'staff',   now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:wh,  :org, '0369 Main',  'WH-0369',  'active'),
  (:whG, :org, '0369 Gear',  'WH-0369G', 'active')
  on conflict (id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary)
  values (:org, :stf, :wh, true);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:r1, :org, :wh,  '69-A', 'shelf', 'rack'),
  (:r2, :org, :wh,  '69-B', 'shelf', 'rack'),
  (:rG, :org, :whG, '69-G', 'shelf', 'rack')
  on conflict (id) do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, status, is_rental, is_bundle) values
  (:itAB, :org, :wh,  'Overlap widget',        'SKU-0369-AB', 20, 'active', false, false),
  (:itPK, :org, :wh,  'Picked widget',         'SKU-0369-PK', 20, 'active', false, false),
  (:itSF, :org, :wh,  'Forged widget',         'SKU-0369-SF', 20, 'active', false, false),
  (:itCP, :org, :wh,  'Captured widget',       'SKU-0369-CP', 20, 'active', false, false),
  (:itFU, :org, :wh,  'Future widget',         'SKU-0369-FU', 20, 'active', false, false),
  (:itPA, :org, :wh,  'Past widget',           'SKU-0369-PA', 20, 'active', false, false),
  (:itTR, :org, :wh,  'Transferred widget',    'SKU-0369-TR', 20, 'active', false, false),
  (:itLC, :org, :wh,  'Located widget',        'SKU-0369-LC', 20, 'active', false, false),
  (:itRE, :org, :wh,  'Re-recorded widget',    'SKU-0369-RE', 20, 'active', false, false),
  (:itVL, :org, :wh,  'Ledger stamp widget',   'SKU-0369-VL', 20, 'active', false, false),
  (:itZD, :org, :wh,  'Zero-diff widget',      'SKU-0369-ZD', 20, 'active', false, false),
  (:itFD, :org, :wh,  'Future-plant widget',   'SKU-0369-FD', 20, 'active', false, false),
  (:itFC, :org, :wh,  'Future-count widget',   'SKU-0369-FC', 20, 'active', false, false),
  (:itRT, :org, :wh,  'Retried widget',        'SKU-0369-RT', 20, 'active', false, false),
  (:itM1, :org, :wh,  'Multi widget one',      'SKU-0369-M1', 20, 'active', false, false),
  (:itM2, :org, :wh,  'Multi widget two',      'SKU-0369-M2', 20, 'active', false, false),
  (:itNB, :org, :wh,  'No-baseline widget',    'SKU-0369-NB', 20, 'active', false, false),
  (:itGP, :org, :whG, 'Gear pallet',           'SKU-0369-GP',  4, 'active', false, false),
  (:itGR, :org, :whG, 'Gear projector',        'SKU-0369-GR',  2, 'active', true,  false),
  (:itGK, :org, :whG, 'Gear kit',              '__BUNDLE__0369GK', 3, 'active', false, true)
  on conflict (id) do nothing;

-- The 0199 trigger seeds an Unplaced row per item; put every unit on a rack so
-- each holding below is a literal this file controls.
delete from public.item_stock_levels
 where item_id in (:itAB, :itPK, :itSF, :itCP, :itFU, :itPA, :itTR, :itLC, :itRE, :itVL, :itZD,
                   :itGP, :itGR, :itGK, :itFD, :itFC, :itRT, :itM1, :itM2, :itNB);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :itAB, :r1, 20), (:org, :itPK, :r1, 20), (:org, :itSF, :r1, 20),
  (:org, :itCP, :r1, 20), (:org, :itFU, :r1, 20), (:org, :itPA, :r1, 20),
  (:org, :itTR, :r1, 20), (:org, :itLC, :r1, 20), (:org, :itRE, :r1, 20),
  (:org, :itVL, :r1, 20), (:org, :itZD, :r1, 20),
  (:org, :itFD, :r1, 20), (:org, :itFC, :r1, 20), (:org, :itRT, :r1, 20),
  (:org, :itM1, :r1, 20), (:org, :itM2, :r1, 20), (:org, :itNB, :r1, 20),
  (:org, :itGP, :rG,  4), (:org, :itGR, :rG,  2), (:org, :itGK, :rG, 3);

-- Every count started an hour ago, so capture times can sit inside the window.
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at) values
  (:ccA,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccB,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccP,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccS,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccS2, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccC,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccZ1, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccZ2, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccFD, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccR,  :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccM1, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccM2, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccN1, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour'),
  (:ccN2, :org, :wh, 'in_progress', 'selection', :mgr, now() - interval '1 hour');
insert into public.cycle_count_lines (id, cycle_count_id, item_id, warehouse_id, expected_quantity) values
  (:lnA,  :ccA,  :itAB, :wh, 20),
  (:lnB,  :ccB,  :itAB, :wh, 20),
  (:lnP,  :ccP,  :itPK, :wh, 20),
  (:lnS,  :ccS,  :itSF, :wh, 20),
  (:lnCP, :ccC,  :itCP, :wh, 20),
  (:lnFU, :ccC,  :itFU, :wh, 20),
  (:lnPA, :ccC,  :itPA, :wh, 20),
  (:lnTR, :ccC,  :itTR, :wh, 20),
  (:lnLC, :ccC,  :itLC, :wh, 20),
  (:lnRE, :ccC,  :itRE, :wh, 20),
  (:lnZ1, :ccZ1, :itZD, :wh, 20),
  (:lnZ2, :ccZ2, :itZD, :wh, 20),
  (:lnFD, :ccFD, :itFD, :wh, 20),
  (:lnFC, :ccFD, :itFC, :wh, 20),
  (:lnRT, :ccR,  :itRT, :wh, 20),
  (:lnM1a, :ccM1, :itM1, :wh, 20),
  (:lnM1b, :ccM1, :itM2, :wh, 20),
  (:lnM2a, :ccM2, :itM1, :wh, 20),
  (:lnM2b, :ccM2, :itM2, :wh, 20),
  (:lnN1, :ccN1, :itNB, :wh, 20),
  (:lnN2, :ccN2, :itNB, :wh, 20);

-- Guard the fixtures: a silently missing row would let a refusal pass for the
-- wrong reason.
do $$ begin
  if (select count(*) from public.cycle_count_lines
       where cycle_count_id::text like '03690000-%') <> 21
     or (select count(*) from public.user_warehouse_assignments
          where user_id = '03690000-0000-0000-0000-0000000000a2') <> 1
  then raise exception '0369 test fixtures incomplete'; end if;
end $$;

-- ═══ E. Grants ════════════════════════════════════════════════════════════
select ok(
  has_column_privilege('authenticated', 'public.cycle_count_lines', 'captured_at', 'UPDATE'),
  'E1: authenticated may UPDATE captured_at (the record route writes it)');
select ok(
  not has_column_privilege('authenticated', 'public.cycle_count_lines', 'baseline_at', 'UPDATE'),
  'E2: baseline_at is written only by the trigger, never by a client');
select has_trigger('public', 'stock_movements', 'trg_zz_stock_movements_via_ledger',
  'E3: the via_ledger stamp is installed on stock_movements');

-- ═══ A. via_ledger is stamped, never chosen ═══════════════════════════════
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.adjust_stock(%L::uuid, -1, 'remove', %L::uuid, 'stamp probe')$$, :itVL, :r1),
  'A1: a manager adjust through the ledger RPC');
select lives_ok(
  format($$select public.transfer_stock(%L::uuid, %L::uuid, %L::uuid, 2)$$, :itVL, :r1, :r2),
  'A2: a manager transfer through the ledger RPC');
reset role;
select is(
  (select array_agg(movement_type || ':' || via_ledger::text order by movement_type)
     from public.stock_movements where item_id = :itVL),
  array['remove:true', 'transfer:true'],
  'A3: adjust_stock and transfer_stock movements are via_ledger');

set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$insert into public.stock_movements
             (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
              reference_type, reference_id, created_at, via_ledger, notes)
           values (%L, %L, 'adjust', 100, 20, 120, 'cycle_count', %L, now() + interval '1 day', true, '0369 forged')$$,
         :org, :itSF, :ccS2),
  'A4: staff can still insert a movement directly (S1 step 3 closes that)');
select lives_ok(
  format($$update public.stock_movements set via_ledger = true where item_id = %L$$, :itSF),
  'A5: a staff UPDATE of the flag is filtered out (no UPDATE policy; the trigger pins it too)');
reset role;
select is(
  (select via_ledger from public.stock_movements where item_id = :itSF and notes = '0369 forged'),
  false,
  'A6: the direct insert is stamped via_ledger = false although it claimed true');

set local role to 'service_role';
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes)
  values (:org, :itVL, 'adjust', 0, 17, 17, '0369 service probe');
reset role;
select is(
  (select via_ledger from public.stock_movements where item_id = :itVL and notes = '0369 service probe'),
  true,
  'A7: a non-API role (service_role) writes a trusted row');
select is(
  (select count(*)::int from public.stock_movements where via_ledger is null),
  0,
  'A8: via_ledger is never null');

-- Every stock_movements writer outside the ledger schema that is not SECURITY
-- DEFINER writes UNTRUSTED rows when a user calls it. Today that is exactly
-- the opening-stock copy in duplicate_inventory_item (a brand-new item, never
-- on an open count). A new invoker writer outside the ledger shows up here.
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger') and p.prokind = 'f'
      and p.prosrc ~* 'insert\s+into\s+(public\.)?stock_movements'
      and n.nspname <> 'ledger' and not p.prosecdef),
  array['public.duplicate_inventory_item'],
  'A9: the only non-ledger invoker writer of stock_movements is the opening-stock copy');

-- ═══ B. Overlapping counts ════════════════════════════════════════════════
-- B1-B6: A and B both record 22 on 20. Mutation: drop the superseded guard,
-- and B posts 22 -> 24.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 22, counted_by = :stf, counted_at = now() where id = :lnA;
update public.cycle_count_lines set counted_quantity = 22, counted_by = :stf, counted_at = now() where id = :lnB;
reset role;
select is(
  (select array_agg(expected_quantity order by id) from public.cycle_count_lines where id in (:lnA, :lnB)),
  array[20, 20]::numeric[],
  'B1: both lines were measured against the book (20)');
select ok(
  (select bool_and(baseline_at is not null and captured_at is null) from public.cycle_count_lines where id in (:lnA, :lnB)),
  'B2: an online record carries a baseline and no capture time');

set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccA), 'B3: count A posts');
select throws_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :ccB),
  'P0001', 'cycle_count_line_superseded: SKU-0369-AB',
  'B4: count B is refused: A already posted that correction after B was counted');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itAB), 22::numeric,
  'B5: on-hand is 22 (the correction applied once, not 24)');
select is(
  (select count(*)::int from public.stock_movements where item_id = :itAB and reference_type = 'cycle_count'),
  1,
  'B6: exactly one cycle-count movement for the item; count B is still open');
select ok(
  (select created_at > (select baseline_at from public.cycle_count_lines where id = :lnB)
     from public.stock_movements where item_id = :itAB and reference_type = 'cycle_count'),
  'B7: the post stamps its movement with the real clock time (after B''s baseline)');

-- B8-B10: B cleared and recounted after A posts, so B is measured against 22.
-- Mutation: an untimed guard (any other count's movement refuses), and B is
-- refused forever.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = null, reason = null, notes = null, counted_by = null, counted_at = null where id = :lnB;
update public.cycle_count_lines set counted_quantity = 22, counted_by = :stf, counted_at = now() where id = :lnB;
reset role;
select is((select expected_quantity from public.cycle_count_lines where id = :lnB), 22::numeric,
  'B8: the recount is measured against the posted 22');
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccB),
  'B9: count B posts after the recount');
reset role;
select is(
  (select count(*)::int from public.stock_movements where reference_id = :ccB),
  0,
  'B10: and moves nothing (22 counted, 22 on the book)');

-- B11-B13: a pick after B's count does not block B (the 0339 semantics keep
-- the pick). Line P is counted at a capture time 10 minutes ago, so the pick
-- (created_at = now()) lands after its baseline. Mutation: drop the
-- reference_type filter, and B is refused over a pick.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 22, counted_by = :stf, counted_at = now(), captured_at = now() - interval '10 minutes'
 where id = :lnP;
reset role;
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.adjust_stock(%L::uuid, -3, 'remove', %L::uuid, 'pick after the count')$$, :itPK, :r1),
  'B11: a pick of 3 after the count');
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccP),
  'B12: the count still posts');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itPK), 19::numeric,
  'B13: the pick is preserved and the +2 applied on top (20 - 3 + 2)');

-- B14-B17: a staff-inserted movement (A4: +100, cycle_count, another count,
-- dated tomorrow) moves neither the baseline nor the guard. Mutations: drop
-- the via_ledger filter in the trigger (expected becomes -80) or in the guard
-- (the post is refused).
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '10 minutes'
 where id = :lnS;
reset role;
select is((select expected_quantity from public.cycle_count_lines where id = :lnS), 20::numeric,
  'B14: the forged +100 does not move the baseline');
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccS),
  'B15: the forged "cycle count" movement does not supersede the line');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itSF), 20::numeric,
  'B16: on-hand unchanged (counted 20 = book 20)');
select is(
  (select count(*)::int from public.stock_movements where reference_id = :ccS),
  0,
  'B17: nothing was posted for the forged difference');

-- B18-B21: a line that matches its book (variance 0) applies nothing, so it
-- can never apply a correction twice, and it is never refused (D6 refuses
-- only the unsafe post; posted first, it would write nothing and could not
-- refuse the other count either). Z1 records 21, Z2 records 20 (= book), Z1
-- posts, then Z2 posts and moves nothing. Mutation: judge the guard before
-- the zero-variance skip, and Z2 is refused.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 21, counted_by = :stf, counted_at = now() where id = :lnZ1;
update public.cycle_count_lines set counted_quantity = 20, counted_by = :stf, counted_at = now() where id = :lnZ2;
reset role;
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccZ1), 'B18: count Z1 posts +1');
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccZ2),
  'B19: count Z2 posts: its zero-variance line cannot apply anything twice');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itZD), 21::numeric,
  'B20: on-hand keeps Z1''s posted 21');
select is(
  (select count(*)::int from public.stock_movements where reference_id = :ccZ2),
  0,
  'B21: and count Z2 wrote no movement');

-- B22-B25: every superseded line is named in ONE refusal. M1 and M2 both
-- record 21 on two items; M1 posts; M2 is refused naming both SKUs, with the
-- total in DETAIL. Mutation: raise on the first superseded line, and only
-- SKU-0369-M1 is named (one post attempt per line to find them all).
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 21, counted_by = :stf, counted_at = now()
 where id in (:lnM1a, :lnM1b, :lnM2a, :lnM2b);
reset role;
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccM1), 'B22: count M1 posts +1 on both items');
select throws_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :ccM2),
  'P0001', 'cycle_count_line_superseded: SKU-0369-M1, SKU-0369-M2',
  'B23: count M2 is refused once, naming both superseded lines');
do $$
declare
  v_detail text;
begin
  perform public.post_cycle_count('03690000-0000-0000-0000-0000000000fc'::uuid);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  perform set_config('test0369.detail', coalesce(v_detail, ''), true);
end $$;
reset role;
select is(current_setting('test0369.detail', true), 'superseded_lines=2',
  'B24: DETAIL carries how many lines were superseded');
select is(
  (select array_agg(quantity_on_hand order by sku) from public.inventory_items where id in (:itM1, :itM2)),
  array[21, 21]::numeric[],
  'B25: each correction applied once (M2 wrote nothing)');

-- B26-B28: a counted line with no baseline (a line counted before 0369 whose
-- counted_at was nulled, so the backfill had nothing to pin) is judged from
-- the count's start: fail closed. Mutation: skip the guard for a NULL
-- baseline, and N2 posts 22 -> 24.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 22, counted_by = :stf, counted_at = now()
 where id in (:lnN1, :lnN2);
reset role;
-- The pre-0369 shape, written as the owner (neither column fires the trigger).
update public.cycle_count_lines set baseline_at = null, counted_at = null where id = :lnN2;
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccN1), 'B26: count N1 posts +2');
select throws_ok(
  format($$select public.post_cycle_count(%L::uuid)$$, :ccN2),
  'P0001', 'cycle_count_line_superseded: SKU-0369-NB',
  'B27: count N2''s line without a baseline is refused, not waved through');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itNB), 22::numeric,
  'B28: on-hand is 22 (the correction applied once, not 24)');

-- ═══ C. Offline capture time ══════════════════════════════════════════════
-- C1-C5: capture at T0 (30 minutes ago), then an adjust of -3. Mutation:
-- ignore captured_at, and expected becomes 17 and the post gives 20.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.adjust_stock(%L::uuid, -3, 'remove', %L::uuid, 'adjust after the offline count')$$, :itCP, :r1),
  'C1: an adjust of -3 after the capture time');
reset role;
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '30 minutes'
 where id = :lnCP;
reset role;
select is((select expected_quantity from public.cycle_count_lines where id = :lnCP), 20::numeric,
  'C2: the line is measured against the book at the capture time (17 + 3)');
select is((select counted_quantity - expected_quantity from public.cycle_count_lines where id = :lnCP), 0::numeric,
  'C3: variance 0 (no phantom +3)');
select is(
  (select array[captured_at, baseline_at] from public.cycle_count_lines where id = :lnCP),
  array[now() - interval '30 minutes', now() - interval '30 minutes'],
  'C4: captured_at and baseline_at are the capture time');

-- C5-C7: a future capture is clamped to now() (today's behaviour).
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() + interval '1 day'
 where id = :lnFU;
reset role;
select is((select captured_at from public.cycle_count_lines where id = :lnFU), now(),
  'C5: a capture in the future is clamped to now()');
select is((select baseline_at from public.cycle_count_lines where id = :lnFU), now(),
  'C6: and so is its baseline');
select is((select expected_quantity from public.cycle_count_lines where id = :lnFU), 20::numeric,
  'C7: expected is the book now');

-- C8-C10: a capture before the count started is clamped to started_at. A
-- ledger movement 90 minutes ago (before the count started) must not count.
-- Mutation: drop the lower clamp, and expected becomes 15.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, created_at)
  values (:org, :itPA, 'add', 5, 15, 20, '0369 receipt before the count', now() - interval '90 minutes');
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '2 days'
 where id = :lnPA;
reset role;
select is((select captured_at from public.cycle_count_lines where id = :lnPA), now() - interval '1 hour',
  'C8: a capture before the count started is clamped to started_at');
select is((select baseline_at from public.cycle_count_lines where id = :lnPA), now() - interval '1 hour',
  'C9: and so is its baseline');
select is((select expected_quantity from public.cycle_count_lines where id = :lnPA), 20::numeric,
  'C10: a movement from before the count started is not subtracted');

-- C11-C13: a transfer after T0 moves nothing (quantity_change 0) and leaves
-- the location un-inferred: after the transfer ONE rack holds the item, but
-- it is not the rack the counter saw.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.transfer_stock(%L::uuid, %L::uuid, %L::uuid, 20)$$, :itTR, :r1, :r2),
  'C11: every unit moves from 69-A to 69-B after the capture time');
reset role;
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '10 minutes'
 where id = :lnTR;
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '10 minutes'
 where id = :lnLC;
reset role;
select is((select expected_quantity from public.cycle_count_lines where id = :lnTR), 20::numeric,
  'C12: a transfer moves nothing (expected 20)');
select is((select counted_location_id from public.cycle_count_lines where id = :lnTR), null::uuid,
  'C13: stock moved after the capture, so no location is inferred from today''s holdings');
select is((select counted_location_id from public.cycle_count_lines where id = :lnLC), :r1::uuid,
  'C14: control: nothing moved since the capture, so the single rack is still inferred');

-- C15-C17: clearing nulls captured_at and baseline_at. Mutation: keep them,
-- and a later online recount is measured against the old capture time.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = null, reason = null, notes = null, counted_by = null, counted_at = null
 where id = :lnCP;
reset role;
select is(
  (select array[captured_at, baseline_at] from public.cycle_count_lines where id = :lnCP),
  array[null, null]::timestamptz[],
  'C15: clearing a count nulls captured_at and baseline_at');
select is((select expected_quantity from public.cycle_count_lines where id = :lnCP), 20::numeric,
  'C16: and restores the start snapshot');
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 17, counted_by = :stf, counted_at = now() where id = :lnCP;
reset role;
select is((select expected_quantity from public.cycle_count_lines where id = :lnCP), 17::numeric,
  'C17: an online recount after the clear is measured against the book now (17)');

-- C18-C20: a re-record that brings no capture time is an online record, even
-- when the line still carries an earlier offline one (the web, an old phone).
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '10 minutes'
 where id = :lnRE;
reset role;
select is((select captured_at from public.cycle_count_lines where id = :lnRE), now() - interval '10 minutes',
  'C18: the offline record keeps its capture time');
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 19, counted_by = :stf, counted_at = now() where id = :lnRE;
reset role;
select is((select captured_at from public.cycle_count_lines where id = :lnRE), null::timestamptz,
  'C19: a re-record without a capture time drops the old one');
select ok((select baseline_at > now() from public.cycle_count_lines where id = :lnRE),
  'C20: and is baselined at the clock time of its own read');

-- C24-C25: a PATCH of captured_at alone (the column is client-writable) runs
-- the trigger too, so the stored time is clamped and the baseline follows it.
-- Mutation: fire the trigger only on counted_quantity, and the raw time is
-- stored next to a stale baseline.
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines set captured_at = now() - interval '2 days' where id = :lnFU;
reset role;
select is(
  (select array[captured_at, baseline_at] from public.cycle_count_lines where id = :lnFU),
  array[now() - interval '1 hour', now() - interval '1 hour'],
  'C24: a captured_at-only PATCH is clamped to the count window and moves the baseline with it');
select is((select expected_quantity from public.cycle_count_lines where id = :lnFU), 20::numeric,
  'C25: and the line is re-measured at that moment (nothing moved: still 20)');

-- C26-C27: a retry of the same record (same quantity, same capture time,
-- e.g. the first attempt committed and its response was lost) keeps its
-- moment. Mutation: treat an unchanged captured_at as "none sent", and the
-- retry is re-measured at arrival (expected 17: the -3 becomes a variance).
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '30 minutes'
 where id = :lnRT;
reset role;
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(
  format($$select public.adjust_stock(%L::uuid, -3, 'remove', %L::uuid, 'pick after the offline count')$$, :itRT, :r1),
  'C25b: a pick of 3 after the offline count');
set local "request.jwt.claim.sub"  to :stf;
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '30 minutes'
 where id = :lnRT;
reset role;
select is((select captured_at from public.cycle_count_lines where id = :lnRT), now() - interval '30 minutes',
  'C26: a retry that re-sends the same capture time keeps it');
select is((select expected_quantity from public.cycle_count_lines where id = :lnRT), 20::numeric,
  'C27: and stays measured at that moment (20, not 17)');

-- C21-C23: the count with the captured lines posts: CP 17 counted on 17 (0),
-- FU 0, PA 0, TR 0, LC 0, RE 19 on 20 (-1).
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccC), 'C21: the captured count posts');
reset role;
select is((select quantity_on_hand from public.inventory_items where id = :itCP), 17::numeric,
  'C22: the offline count after the -3 adjust leaves 17 (not 20)');
select is(
  (select array_agg(item_id::text || ':' || quantity_change::text) from public.stock_movements where reference_id = :ccC),
  array[:itRE || ':-1.0000'],
  'C23: only the re-recorded line moved stock');

-- ═══ D. Rental equipment and kit phantoms are not counted ═════════════════
-- Mutation: drop the predicate, and the warehouse count carries 3 lines.
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select is(
  (select line_count from public.start_cycle_count(:org::uuid, 'warehouse', :whG::uuid, :whG::uuid, null, '0369 gear count')),
  1,
  'D1: a warehouse count reports one line');
reset role;
select is(
  (select array_agg(l.item_id) from public.cycle_count_lines l
     join public.cycle_counts c on c.id = l.cycle_count_id
    where c.notes = '0369 gear count'),
  array[:itGP::uuid],
  'D2: the rental and the kit phantom are not on it');
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$select * from public.start_cycle_count(%L::uuid, 'selection', %L::uuid, null, array[%L::uuid], 'rental only')$$,
         :org, :whG, :itGR),
  'P0001', 'cycle_count_no_items',
  'D3: a selection of only a rental starts nothing');
select throws_ok(
  format($$select * from public.start_cycle_count(%L::uuid, 'selection', %L::uuid, null, array[%L::uuid], 'kit only')$$,
         :org, :whG, :itGK),
  'P0001', 'cycle_count_no_items',
  'D4: a selection of only a kit phantom starts nothing');
select is(
  (select line_count from public.start_cycle_count(:org::uuid, 'selection', :whG::uuid, null,
                                                   array[:itGR::uuid, :itGK::uuid, :itGP::uuid], 'mixed')),
  1,
  'D5: a mixed selection keeps only the countable item');
reset role;
select is(
  (select count(*)::int from public.cycle_counts where notes in ('rental only', 'kit only')),
  0,
  'D6: the refused starts left no header behind');

-- ═══ F. The guard helper answers only the post ════════════════════════════
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select throws_ok(
  format($$select ledger.cycle_count_line_superseded(%L::uuid, %L::uuid, now())$$, :itAB, :ccB),
  '42501', 'forbidden',
  'F1: outside a ledger transaction the superseded probe refuses');
reset role;
select ok(
  not has_function_privilege('anon', 'ledger.cycle_count_line_superseded(uuid, uuid, timestamptz)', 'execute'),
  'F2: anon cannot execute the superseded probe');
select is(
  (select prosecdef from pg_proc where oid = 'ledger.cycle_count_line_superseded(uuid, uuid, timestamptz)'::regprocedure),
  true,
  'F3: the probe is SECURITY DEFINER (an invoker read would fail open under the movements RLS)');
select ok(
  (select pg_get_functiondef('ledger.post_cycle_count(uuid)'::regprocedure) ~ 'order by l\.item_id'),
  'F4: the post takes item locks in item_id order (no 40P01 between overlapping posts)');
select ok(
  (select pg_get_functiondef('public.tg_cycle_count_line_rebase_expected()'::regprocedure) ~* 'for share'),
  'F5: the rebase read waits for an in-flight post (FOR SHARE); the two-session script proves it');
select ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'ledger')
       and p.proname in ('post_cycle_count', 'cycle_count_line_superseded', 'tg_cycle_count_line_rebase_expected')
       and p.prosrc ~* 'errcode\s*=\s*''(40001|40P01)'''),
  'F6: none of the rewritten bodies raises a retryable SQLSTATE');

select ok(
  (select pg_get_functiondef('public.tg_cycle_count_line_rebase_expected()'::regprocedure)
     ~* 'from public\.cycle_counts cc\s+where cc\.id = new\.cycle_count_id\s+for key share[\s\S]*from public\.inventory_items ii\s+where ii\.id = new\.item_id\s+for share'),
  'F7: the record locks the count header before the item (the post''s order) whatever order the BEFORE triggers fire in');

-- ═══ H. A trusted row dated in the future counts for nothing ══════════════
-- 0369 marks rows dated after the migration untrusted (a pre-0369 plant: no
-- ledger writer dates a movement ahead); the readers are also bounded to
-- their own read. Written here as the owner, so the row is stamped TRUE: the
-- shape a plant would have if the backfill had missed it. Mutations: drop
-- the created_at <= clock_timestamp() bound from the baseline sum (expected
-- becomes -80, and the post would add 100) or from the guard (FC is refused
-- for good: the row is later than any baseline).
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, created_at)
  values (:org, :itFD, 'adjust', 100, 20, 120, '0369 future plant', now() + interval '5 years');
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
   reference_type, reference_id, notes, created_at)
  values (:org, :itFC, 'adjust', 100, 20, 120, 'cycle_count', :ccA, '0369 future count plant', now() + interval '5 years');
select is(
  (select bool_and(via_ledger) from public.stock_movements where notes like '0369 future%'),
  true,
  'H0: the planted rows are trusted (the worst case the readers must survive)');
set local "request.jwt.claim.sub"  to :stf;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
update public.cycle_count_lines
   set counted_quantity = 20, counted_by = :stf, counted_at = now(), captured_at = now() - interval '10 minutes'
 where id = :lnFD;
update public.cycle_count_lines set counted_quantity = 22, counted_by = :stf, counted_at = now() where id = :lnFC;
reset role;
select is((select expected_quantity from public.cycle_count_lines where id = :lnFD), 20::numeric,
  'H1: a future-dated row is not subtracted from a captured record (20, not -80)');
set local "request.jwt.claim.sub"  to :mgr;
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
select lives_ok(format($$select public.post_cycle_count(%L::uuid)$$, :ccFD),
  'H2: a future-dated "cycle count" row does not supersede the line');
reset role;
select is(
  (select array_agg(quantity_on_hand order by sku) from public.inventory_items where id in (:itFC, :itFD)),
  array[22, 20]::numeric[],
  'H3: FC takes its own +2, FD is unchanged (no forged +100)');

-- ═══ G. The 0368 posture is intact ════════════════════════════════════════
select is(
  (select array_agg(c order by c) from unnest(array['counted_quantity','reason','notes','counted_by','counted_at','ai_scan_id','captured_at']) c
    where has_column_privilege('authenticated', 'public.cycle_count_lines', c, 'UPDATE')),
  array['ai_scan_id','captured_at','counted_at','counted_by','counted_quantity','notes','reason'],
  'G1: authenticated UPDATEs exactly the recordCount/clearCount columns plus captured_at');
select is(
  (select array_agg(c order by c) from unnest(array['expected_quantity','expected_at_start','item_id','warehouse_id',
      'counted_location_id','cycle_count_id','baseline_at']) c
    where has_column_privilege('authenticated', 'public.cycle_count_lines', c, 'UPDATE')),
  null::text[],
  'G2: none of the columns the post trusts is client-writable');

select * from finish();
rollback;
