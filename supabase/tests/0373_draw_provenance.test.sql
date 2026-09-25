-- supabase/tests/0373_draw_provenance.test.sql
-- Proves migration 0373: every null-location draw and increment reached
-- through ledger.adjust_stock, distribute_bundle, assemble_bundle and
-- process_return_disposition records exactly which holdings it touched, on
-- exactly its own movement, and every draw still moves holdings byte-for-byte
-- as before.
--
--   A. STRUCTURE: the table, its keys (composite deferred FK, SET NULL
--      location FK), the unique index it references, RLS with one SELECT
--      policy, no write privilege for any API role, not in realtime; the
--      engine, the recorder and the wrapper.
--   P. TEXT PROOFS: the engine is the 0359 apply_level_delta prosrc plus
--      exactly eight tagged lines of the allowed shapes; each restated caller
--      is its pre-0373 prosrc minus its apply_level_delta lines plus tagged
--      lines of the allowed shapes; kind, config, signature, ACL, owner and
--      comment of the four callers are unchanged.
--   B. DIFFERENTIAL ORACLE: pg_temp.ald_0359 is the 0359 body verbatim (md5
--      proven). The engine (with a movement id) and the wrapper run on the
--      same fixture in rolled-back subtransactions; holdings and SQLSTATE +
--      message must be identical in every mode and shape. The wrapper
--      records nothing.
--   C. PROVENANCE TRUTH: per successful engine run, the recorded rows summed
--      by location equal the holdings difference (an independent oracle),
--      the total equals the quantity, seq follows the draw order, steps and
--      draw-time snapshots are right, and actor_scope is service / manager /
--      in_scope / out_of_scope.
--   D. PER CALLER, as real personas (every case then checks the deferred FK
--      with SET CONSTRAINTS ... IMMEDIATE, which a rolled-back test would
--      otherwise never run): the phone adjust, the web 'any' removal, a +1,
--      explicit adjust and transfer (no rows), complete_picking with a
--      duplicate line, the cancel restock, reverse_receipt, assemble and
--      distribute (with shortage rows), return restock + scrap (no row
--      crosses legs), and the pinned post_cycle_count gap (no rows).
--   E. FAILURE AND INTEGRITY: insufficient_placed_stock records nothing; an
--      orphan id and another item's movement id both fail the FK (23503);
--      a second engine call for one movement continues seq; a rolled-back
--      subtransaction leaves no rows; zero and NULL record nothing.
--   F. SECURITY: no direct writes; the engine's gate; the wrapper's gate;
--      RLS read parity for every persona (visible rows = rows of visible
--      movements, with literal counts).
--   R. SUB-PRECISION QUANTITIES (review 2026-09-25): a share with more than
--      four decimals (adjust_stock and the API accept any finite value) is
--      recorded as its numeric(14,4) holding moved, and one that rounds to
--      zero records no row: the engine still equals the 0359 oracle exactly,
--      no draw that succeeded before fails (it did, 23514), and rows sum
--      exactly to the holdings difference and to new - previous quantity.
--   S. SCOPE ONCE PER CALL (perf review, 2026-09-25): service and manager
--      are one answer per call; below manager caller_can_write_location runs
--      once per distinct (organization, warehouse) of the call's locations.
--      Its text and volatility are pinned (it must read the location only
--      for those two columns, and run in the INSERT's snapshot); six personas
--      over eight locations and six pairs give literal values equal to the
--      old per-row formula, with the call counts; a real six-holding staff
--      draw asks three times, not six. A one-location call (every increment,
--      most adjusts) asks once, of that location, and never runs the pair CTE
--      (S10-S15, review 2026-09-25: counted by the locations reads).
--
-- The push-time lock order (the migration's lock prelude) needs two sessions:
-- scripts/db-concurrency/0373_push_lock_order.sh.
--
-- The recorder's closed EXECUTE is asserted from the catalog (A), not by a
-- permission-denied call: images before 17.6.1.155 crash on a
-- permission-denied function call under supautils hint_roles, and CI's image
-- is whatever the CLI pins.
--
-- HOW THE ROLES ARE SIMULATED (house convention): `set local role
-- authenticated` + request.jwt.claim.sub where RLS matters; the jwt claim
-- alone (plus the ledger flag raised by hand) for direct engine calls.
--
-- MUTATION RECORD: MUTATION RECORD (live, 2026-09-25). Each mutant is one edit of the
-- migration's own text, applied after reverting 0373 inside a rolled-back
-- transaction; then this file and security_invariants run against it.
-- 'post' = the migration's own post-check already refuses it at push time
-- (55000); the tests listed are the ones that fail with that post-check
-- removed. Every mutant below was killed; the unedited control ran green.
--   M1   engine: drop the append in the placed loop
--        -> P2, C1, C2, C3, C6, C7, C8, D4, D5 ...
--   M2   engine: record the holding's quantity instead of what was taken (placed loop)
--        -> P2, C2, D4, D5, D16, D25, D32
--   M3   engine: drop the staging_first append
--        -> P2, C2, D21, D25, D28, F8, F9, F10, F12 ...
--   M4   engine: drop the 'any' append
--        -> P2, C3, D9, E3, F8, F9, F10, F12
--   M5   engine: drop the increment record
--        -> P2, C4, C5, D9, D19, D25, D28, E3, E5 ...
--   M5b  engine: drop the final (draw) record
--        -> P2, C1, C2, C3, C6, C7, C8, D4, D5 ...
--   M6   engine draw order: Unplaced FIRST instead of last
--        -> post; P1, B1, B2, B9, B10, B17, B18, B19, B20 ...
--   M7   engine: kind <> 'staging' (the 0292 regression: Sites drop out)
--        -> post; P1, B3, B4, B9, B10, B13, B14, B17, B18 ...
--   M8   engine: enter the 'any' Staging tail for 'placed' too
--        -> post; P1, B5, B6, E1, E3, E9, F8, F9, F10 ...
--   M9   engine draw order: add an l.id tie-breaker
--        -> post; P1
--   M24  engine draw order: staging_first takes the SMALLEST Staging first
--        -> post; P1, B7, B8, C2, D28, F14
--   M10  engine SECURITY INVOKER
--        -> A11, D1, D2, D4, D5, D6, D7, D9, D13 ...
--   M11  FK NOT DEFERRABLE
--        -> A4, B1, B3, B7, B9, B13, B17, B19, B21 ...
--   M12  RLS read widening: policy using (true)
--        -> A2, F10, F11, F13, INV-11
--   M12b RLS read widening: org prefilter only (EXISTS on the parent dropped)
--        -> A2, F10, F11
--   M13  grant INSERT on the table to authenticated
--        -> A7, INV-38
--   M14  wrong pairing: the return's restock landing recorded under the scrap (loss) movement
--        -> D28, INV-38
--   M14b wrong pairing: distribute's phantom drain draws BEFORE its id is minted (records under a stale id)
--        -> D25, F8, F9, F10, F12, INV-38
--   M15  adjust_stock inserts its movement WITHOUT the id (id mismatch)
--        -> P4, D3, D4, D5, D8, D9, D12, D15, D16 ...
--   M16  the wrapper passes a non-null id
--        -> post; P6, B2, B4, B8, B10, B14, B18, B20, B22 ...
--   M17  recorder: item warehouse snapshot taken from the location
--        -> C1, C2, C3, C6, D5, F14
--   M18  recorder: seq restarts at 1 for every call
--        -> E5, E6
--   M19  a new function drawing through public.apply_level_delta
--        -> INV-37
--   M20  splice 40001 back into distribute_bundle
--        -> post; P3, 0367#1, 0367#2
--   M21  adjust_stock passes a NULL id to the engine
--        -> post; P3, P5, D4, D5, D9, D16, D19, D21, D32 ...
--   M22  recorder executable by authenticated
--        -> A13
--   M26  recorder: in_scope and out_of_scope swapped (in the pair CTE; the
--        one-location path is M44)
--        -> C8, D4, D5, D9, D16, S5, S6, S7, S8
--   M28  table added to the realtime publication
--        -> A9
--   M29  recorder: insert the unrounded share (the text before the review fix)
--        -> R1, R2, R3, R4, R7, R9, R10, R11, R12, R14, R15
--   M30  recorder: round, but keep shares that round to zero
--        -> R1, R2, R3, R4, R7, R9, R10, R11, R12, R13, R14, R15
--   M31  recorder: round half away from zero (round(qty, 4)), not as the holding moved
--        -> R4, R7, R14, R15
--   M32  recorder: number seq by array position, not over the kept rows:
--        EQUIVALENT (only the last share of a draw can be fractional, so a
--        dropped row is always last); survives by construction.
--   Scope once per call (perf review, 2026-09-25; re-run with M17, M18,
--   M22, M26, M29-M31 on the new recorder, all killed as listed above; the
--   whole set re-run on the one-location path, 2026-09-25, lists below):
--   M33  recorder: scope asked per row again (values identical, the old cost)
--        -> S5, S6, S7, S9
--   M34  recorder: pair key drops the warehouse (organization only)
--        -> C8, D5, D9, S5, S6, S7, S8, S9
--   M35  recorder: pair key drops the organization (warehouse only)
--        -> S5, S6, S7
--   M36  recorder: one answer for the whole call below manager (first pair wins)
--        -> C8, D5, D9, S5, S6, S7, S8, S9
--   M37  recorder: manager check dropped (managers go through caller_can_write_location)
--        -> C7, D21, D25, D28, D32, S3, S4, S10, S13
--   M38  recorder: COALESCE operands swapped (the pair's answer beats service/manager)
--        -> C1, C2, C3, C4, C5, C7, D21, D25, D28, D32, E6, S2, S3, S4, S10, S13
--   M39  recorder: the pair CTE not MATERIALIZED (inlined into the per-row subplan)
--        -> S5, S6, S7, S9
--   M40  recorder: pair lookup with = instead of IS NOT DISTINCT FROM (a NULL
--        warehouse never matches; actor_scope NULL fails the NOT NULL)
--        -> C8, D1, D2, D4, D5, D6, D9, D13, E1, E2, E3, E9, F8, F9, F10 ...
--   M41  recorder: service decided by has_org_role instead of the NULL subject
--        -> C1, C2, C3, C4, C5, E6, S2, S10
--   One-location path (review, 2026-09-25):
--   M42  recorder: the one-location path removed (every call through the pair
--        CTE; values and call counts identical, only the CTE's cost)
--        -> S13
--   M43  recorder: the one-location path taken for every call (per-row again)
--        -> S5, S6, S7, S9
--   M44  recorder: the one-location path swaps in_scope and out_of_scope
--        -> D9, D16, D19, E6, S11, S12, S14
--   M45  recorder: the one-location path asks has_org_role(staff) instead of
--        the location
--        -> S11, S12, S13, S14, S15
--   M23  the migration's drift preflight disabled: not reachable from pgTAP
--        (the migration is applied before tests run); killed by the live
--        drift check (drift planted in each of the five restated bodies:
--        55000 with the preflight, silently overwritten without it).
--   M46  the preflight's caller_can_write_location pin removed: likewise
--        killed by the live drift check (a planted body drift and a VOLATILE
--        caller_can_write_location: 55000 with the pin, applied without it).
--
-- Namespace: 03730000. Wrapped in begin/rollback; nothing leaks.

begin;

select plan(154);

\set orgS    '\'03730000-0000-0000-0000-000000000001\''
\set orgF    '\'03730000-0000-0000-0000-000000000002\''
\set u_adm   '\'03730000-0000-0000-0000-0000000000a1\''
\set u_mgr   '\'03730000-0000-0000-0000-0000000000a2\''
\set u_stf   '\'03730000-0000-0000-0000-0000000000a3\''
\set u_vwr   '\'03730000-0000-0000-0000-0000000000a4\''
\set u_aud   '\'03730000-0000-0000-0000-0000000000a5\''
\set u_out   '\'03730000-0000-0000-0000-0000000000a6\''
\set whA     '\'03730000-0000-0000-0000-0000000000b1\''
\set whB     '\'03730000-0000-0000-0000-0000000000b2\''
\set whF     '\'03730000-0000-0000-0000-0000000000b3\''
\set itX     '\'03730000-0000-0000-0000-0000000000c1\''
\set itN     '\'03730000-0000-0000-0000-0000000000c2\''
\set itP     '\'03730000-0000-0000-0000-0000000000c3\''
\set itW     '\'03730000-0000-0000-0000-0000000000c4\''
\set itR     '\'03730000-0000-0000-0000-0000000000c5\''
\set itV     '\'03730000-0000-0000-0000-0000000000c6\''
\set itC     '\'03730000-0000-0000-0000-0000000000c7\''
\set itK1    '\'03730000-0000-0000-0000-0000000000c8\''
\set itK2    '\'03730000-0000-0000-0000-0000000000c9\''
\set itF     '\'03730000-0000-0000-0000-0000000000ca\''
\set bnd     '\'03730000-0000-0000-0000-0000000000d1\''
\set ordP    '\'03730000-0000-0000-0000-0000000000d2\''
\set ordR    '\'03730000-0000-0000-0000-0000000000d3\''
\set retR    '\'03730000-0000-0000-0000-0000000000d4\''
\set poV     '\'03730000-0000-0000-0000-0000000000d5\''
\set plV     '\'03730000-0000-0000-0000-0000000000d6\''
\set ccC     '\'03730000-0000-0000-0000-0000000000d7\''
\set lnC     '\'03730000-0000-0000-0000-0000000000d8\''
\set lnR     '\'03730000-0000-0000-0000-0000000000d9\''
\set lnP1    '\'03730000-0000-0000-0000-0000000000da\''
\set lnP2    '\'03730000-0000-0000-0000-0000000000db\''
\set locA1   '\'03730000-0000-0000-0000-0000000000e1\''
\set locS    '\'03730000-0000-0000-0000-0000000000e2\''
\set locB1   '\'03730000-0000-0000-0000-0000000000e3\''
\set locA2   '\'03730000-0000-0000-0000-0000000000e4\''
\set locP1   '\'03730000-0000-0000-0000-0000000000e5\''
\set locP2   '\'03730000-0000-0000-0000-0000000000e6\''
\set locF    '\'03730000-0000-0000-0000-0000000000e7\''
\set mvB     '\'03730000-0000-0000-0000-00000000f001\''
\set mvC     '\'03730000-0000-0000-0000-00000000f002\''
\set mvE     '\'03730000-0000-0000-0000-00000000f003\''

-- ── Fixtures (superuser, no jwt subject: RLS bypassed, service path) ─────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_adm, 'admin-0373@test.local',    '{}'::jsonb),
  (:u_mgr, 'mgr-0373@test.local',      '{}'::jsonb),
  (:u_stf, 'staff-0373@test.local',    '{}'::jsonb),
  (:u_vwr, 'viewer-0373@test.local',   '{}'::jsonb),
  (:u_aud, 'auditor-0373@test.local',  '{}'::jsonb),
  (:u_out, 'outsider-0373@test.local', '{}'::jsonb)
on conflict (id) do nothing;

insert into public.organizations (id, name, slug) values
  (:orgS, 'Provenance Org 0373',         'provenance-org-0373'),
  (:orgF, 'Provenance Foreign Org 0373', 'provenance-foreign-org-0373')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgS, :u_adm, 'admin',   now()),
  (:orgS, :u_mgr, 'manager', now()),
  (:orgS, :u_stf, 'staff',   now()),
  (:orgS, :u_vwr, 'viewer',  now()),
  (:orgS, :u_aud, 'viewer',  now()),
  (:orgF, :u_out, 'manager', now())
on conflict do nothing;

-- The 0188 trigger creates Staging + Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgS, 'Provenance WA 0373', 'WA-0373', 'active'),
  (:whB, :orgS, 'Provenance WB 0373', 'WB-0373', 'active'),
  (:whF, :orgF, 'Provenance WF 0373', 'WF-0373', 'active')
on conflict (id) do nothing;

-- staff: WA. viewer: WB. The auditor has no warehouse but holds
-- activity_logs:read (the movement audit surface, 0321) by override.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values
  (:orgS, :u_stf, :whA),
  (:orgS, :u_vwr, :whB)
on conflict do nothing;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:orgS, :u_aud, 'activity_logs:read', true);

-- Every placed location gets a DISTINCT created_at (draw ties are undefined
-- and stay undefined). S is an org-level Site (kind NULL, no warehouse; the
-- 0292 shape). A2 is an ARCHIVED crate: the draw never filtered deleted_at.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at, deleted_at) values
  (:locA1, :orgS, :whA, 'A1 0373',   'other',     'rack',  now() - interval '60 minutes', null),
  (:locS,  :orgS, null, 'Site 0373', 'warehouse', null,    now() - interval '50 minutes', null),
  (:locB1, :orgS, :whB, 'B1 0373',   'other',     'rack',  now() - interval '40 minutes', null),
  (:locA2, :orgS, :whA, 'A2 0373',   'other',     'crate', now() - interval '30 minutes', now()),
  (:locP1, :orgS, :whA, 'P1 0373',   'other',     'rack',  now() - interval '59 minutes', null),
  (:locP2, :orgS, :whA, 'P2 0373',   'other',     'rack',  now() - interval '58 minutes', null),
  (:locF,  :orgF, :whF, 'F1 0373',   'other',     'rack',  now() - interval '55 minutes', null)
on conflict (id) do nothing;
update public.locations set created_at = now() - interval '20 minutes'
 where warehouse_id = :whA and kind = 'unplaced';
update public.locations set created_at = now() - interval '10 minutes'
 where warehouse_id = :whB and kind = 'unplaced';

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itX,  :orgS, :whA, 'PV-0373-X',  'Draw Item 0373',        18, 'active', 'none'),
  (:itN,  :orgS, null, 'PV-0373-N',  'No-warehouse Item 0373', 2, 'active', 'none'),
  (:itP,  :orgS, :whA, 'PV-0373-P',  'Pick Item 0373',          4, 'active', 'none'),
  (:itW,  :orgS, :whB, 'PV-0373-W',  'WB Item 0373',            3, 'active', 'none'),
  (:itR,  :orgS, :whA, 'PV-0373-R',  'Return Item 0373',        6, 'active', 'none'),
  (:itV,  :orgS, :whA, 'PV-0373-V',  'Receipt Item 0373',       0, 'active', 'none'),
  (:itC,  :orgS, :whA, 'PV-0373-C',  'Count Item 0373',         4, 'active', 'none'),
  (:itK1, :orgS, :whA, 'PV-0373-K1', 'Kit Part One 0373',       3, 'active', 'none'),
  (:itK2, :orgS, :whA, 'PV-0373-K2', 'Kit Part Two 0373',       3, 'active', 'none'),
  (:itF,  :orgF, :whF, 'PV-0373-F',  'Foreign Item 0373',       5, 'active', 'none')
on conflict (id) do nothing;

-- The 0199 trigger seeds an opening row per item; clear and place explicitly.
delete from public.item_stock_levels
 where item_id in (:itX, :itN, :itP, :itW, :itR, :itV, :itC, :itK1, :itK2, :itF);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgS, :itX, :locA1, 1),
  (:orgS, :itX, :locS,  2),
  (:orgS, :itX, :locB1, 4),
  (:orgS, :itX, :locA2, 1),
  (:orgS, :itX, (select id from public.locations where warehouse_id = :whA and kind = 'unplaced'), 2),
  (:orgS, :itX, (select id from public.locations where warehouse_id = :whA and kind = 'staging'),  5),
  (:orgS, :itX, (select id from public.locations where warehouse_id = :whB and kind = 'staging'),  3),
  (:orgS, :itN, :locS,  2),
  (:orgS, :itP, :locP1, 1),
  (:orgS, :itP, :locP2, 3),
  (:orgS, :itW, :locB1, 3),
  (:orgS, :itR, (select id from public.locations where warehouse_id = :whA and kind = 'staging'),  1),
  (:orgS, :itR, (select id from public.locations where warehouse_id = :whB and kind = 'staging'),  5),
  (:orgS, :itC, :locA1, 2),
  (:orgS, :itC, :locS,  2),
  (:orgS, :itK1, :locA1, 3),
  (:orgS, :itK2, :locA1, 2),
  (:orgS, :itK2, (select id from public.locations where warehouse_id = :whA and kind = 'unplaced'), 1),
  (:orgF, :itF, :locF,  5);

-- The pick order: two lines of the SAME item with EQUAL quantities, so the
-- (undefined) order between them cannot change what is drawn: the first line
-- spans P1 and P2, the second takes P2.
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
values (:ordP, :orgS, :whA, 'pick_slip_generated', 'internal', :u_stf, 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested) values
  (:lnP1, :ordP, :itP, 2),
  (:lnP2, :ordP, :itP, 2);

-- The return: a fulfilled order line and a received return scrapping 2.
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
values (:ordR, :orgS, :whA, 'in_transit', 'internal', :u_mgr, 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled)
values (:lnR, :ordR, :itR, 5, 5);
insert into public.returns (id, organization_id, order_request_id, status)
values (:retR, :orgS, :ordR, 'received');
insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition)
values (:retR, :orgS, :lnR, :itR, 2, 'scrap');

-- The receipt: an ordered PO line for itV.
insert into public.purchase_orders (id, organization_id, po_number, status)
values (:poV, :orgS, 'PV-PO-0373', 'ordered');
insert into public.purchase_order_items (id, organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
values (:plV, :orgS, :poV, :itV, 10, 0, 5);

-- The kit: one of each part.
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled)
values (:bnd, :orgS, 'Provenance Kit 0373', 'PV-KIT-0373', true, true);
insert into public.bundle_components (bundle_id, item_id, quantity, is_optional) values
  (:bnd, :itK1, 1, false),
  (:bnd, :itK2, 1, false);

-- The count: itC expected 4, counted 2 below. It holds stock at TWO placed
-- locations, so the rebase trigger infers no counted location (0342) and
-- post_cycle_count's whole variance goes through public.apply_level_delta.
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at)
values (:ccC, :orgS, :whA, 'in_progress', 'selection', :u_mgr, now() - interval '1 hour');
insert into public.cycle_count_lines (id, cycle_count_id, item_id, warehouse_id, expected_quantity)
values (:lnC, :ccC, :itC, :whA, 4);

-- Short labels for literal snapshots.
create temp table lbl (id uuid primary key, tag text not null);
grant select on lbl to authenticated, anon;
insert into lbl values
  (:locA1, 'A1'), (:locS, 'S'), (:locB1, 'B1'), (:locA2, 'A2'),
  (:locP1, 'P1'), (:locP2, 'P2'), (:locF, 'F1');
insert into lbl select id, 'SA' from public.locations where warehouse_id = :whA and kind = 'staging';
insert into lbl select id, 'UA' from public.locations where warehouse_id = :whA and kind = 'unplaced';
insert into lbl select id, 'SB' from public.locations where warehouse_id = :whB and kind = 'staging';
insert into lbl select id, 'UB' from public.locations where warehouse_id = :whB and kind = 'unplaced';

create function pg_temp.tag(p_loc uuid) returns text language sql stable as $f$
  select coalesce(
    (select b.tag from lbl b where b.id = p_loc),
    (select 'new-' || coalesce(l.kind, 'null') || '-' || case when l.warehouse_id is null then 'org' else 'wh' end
       from public.locations l where l.id = p_loc),
    case when p_loc is null then 'null' else '?' end);
$f$;

create function pg_temp.snap(p_item uuid) returns text language sql stable as $f$
  select coalesce(string_agg(pg_temp.tag(s.location_id) || '=' || s.quantity::int, ','
                             order by pg_temp.tag(s.location_id) collate "C"), '')
    from public.item_stock_levels s where s.item_id = p_item;
$f$;

-- seq:location:quantity:step:actor_scope, in seq order.
create function pg_temp.rows(p_mv uuid) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || h.quantity::int
                             || ':' || h.step || ':' || h.actor_scope, ',' order by h.seq), '')
    from public.stock_movement_holdings h where h.movement_id = p_mv;
$f$;

-- The one movement of an item with this reason (D group).
create function pg_temp.mv(p_item uuid, p_reason text) returns uuid language sql stable as $f$
  select m.id from public.stock_movements m where m.item_id = p_item and m.reason = p_reason;
$f$;

-- Runs one call in a subtransaction that is ALWAYS rolled back, and reports:
--   ok|<holdings after>#<rows of p_mv>#diff=<holdings difference by location>
--     #oracle=<diff equals the recorded rows summed by location>
--     #total=<sum of recorded quantities>#facts=<snapshots match the rows>
--     #n=<rows recorded for the item>
-- or err|<sqlstate>|<message>.
create function pg_temp.run(p_call text, p_item uuid, p_mv uuid default null) returns text
language plpgsql as $f$
declare
  v_before jsonb;
  v_after  jsonb;
  v_diff   text;
  v_rec    text;
  v_total  numeric;
  v_facts  boolean;
  v_n      int;
begin
  select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_before
    from public.item_stock_levels s where s.item_id = p_item;
  begin
    execute p_call;
    select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_after
      from public.item_stock_levels s where s.item_id = p_item;
    select coalesce(string_agg(pg_temp.tag(x.k::uuid) || ':' || x.d::int, ','
                               order by pg_temp.tag(x.k::uuid) collate "C"), '')
      into v_diff
      from (select k.k, coalesce((v_after ->> k.k)::numeric, 0) - coalesce((v_before ->> k.k)::numeric, 0) as d
              from jsonb_object_keys(v_before || v_after) as k(k)) x
     where x.d <> 0;
    select coalesce(string_agg(pg_temp.tag(y.location_id) || ':' || y.q::int, ','
                               order by pg_temp.tag(y.location_id) collate "C"), '')
      into v_rec
      from (select h.location_id, sum(h.quantity) as q
              from public.stock_movement_holdings h
             where h.movement_id = p_mv
             group by h.location_id) y;
    select coalesce(sum(h.quantity), 0) into v_total
      from public.stock_movement_holdings h where h.movement_id = p_mv;
    select coalesce(bool_and(h.location_kind is not distinct from l.kind
                             and h.location_warehouse_id is not distinct from l.warehouse_id
                             and h.item_warehouse_id is not distinct from i.warehouse_id
                             and h.organization_id = i.organization_id), true)
      into v_facts
      from public.stock_movement_holdings h
      left join public.locations l on l.id = h.location_id
      join public.inventory_items i on i.id = h.item_id
     where h.movement_id = p_mv;
    select count(*)::int into v_n from public.stock_movement_holdings h where h.item_id = p_item;
    raise exception using errcode = 'ZX373', message =
      'ok|' || pg_temp.snap(p_item) || '#' || pg_temp.rows(p_mv) || '#diff=' || v_diff
      || '#oracle=' || (v_diff = v_rec)::text || '#total=' || v_total::int
      || '#facts=' || v_facts::text || '#n=' || v_n;
  exception
    when sqlstate 'ZX373' then return sqlerrm;
    when others then return 'err|' || sqlstate || '|' || sqlerrm;
  end;
end $f$;

-- The deferred FK, checked now: SET CONSTRAINTS ... IMMEDIATE runs every
-- pending check; DEFERRED puts the constraint back for the next case.
create function pg_temp.fk_ok() returns text language plpgsql as $f$
begin
  set constraints public.stock_movement_holdings_movement_fk immediate;
  set constraints public.stock_movement_holdings_movement_fk deferred;
  return 'fk ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $f$;

-- An engine call and an immediate FK check, in a subtransaction that is
-- always rolled back.
create function pg_temp.fk_probe(p_mv uuid, p_item uuid, p_qty numeric) returns text
language plpgsql as $f$
begin
  begin
    perform ledger.apply_level_delta_for(p_mv, p_item, p_qty, 'placed');
    set constraints public.stock_movement_holdings_movement_fk immediate;
    raise exception using errcode = 'ZX373', message = 'no fk error';
  exception
    when sqlstate 'ZX373' then return sqlerrm;
    when others then return sqlstate;
  end;
end $f$;

-- Exact (four-decimal) twins of snap/rows/run for the R group: run4 reports
--   ok|<holdings after, exact>#<rows of p_mv, exact>
--     #oracle=<per location, the holdings difference equals the recorded rows EXACTLY>
-- or err|<sqlstate>|<message>, in a subtransaction that is always rolled back.
create function pg_temp.snap4(p_item uuid) returns text language sql stable as $f$
  select coalesce(string_agg(pg_temp.tag(s.location_id) || '=' || s.quantity::text, ','
                             order by pg_temp.tag(s.location_id) collate "C"), '')
    from public.item_stock_levels s where s.item_id = p_item;
$f$;
create function pg_temp.rows4(p_mv uuid) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || h.quantity::text
                             || ':' || h.step, ',' order by h.seq), '')
    from public.stock_movement_holdings h where h.movement_id = p_mv;
$f$;
create function pg_temp.run4(p_call text, p_item uuid, p_mv uuid default null) returns text
language plpgsql as $f$
declare
  v_before jsonb;
  v_after  jsonb;
  v_oracle boolean;
begin
  select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_before
    from public.item_stock_levels s where s.item_id = p_item;
  begin
    execute p_call;
    select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_after
      from public.item_stock_levels s where s.item_id = p_item;
    select coalesce(bool_and(coalesce(d.d, 0) = coalesce(r.q, 0)), true) into v_oracle
      from (select k.k::uuid as loc,
                   coalesce((v_after ->> k.k)::numeric, 0) - coalesce((v_before ->> k.k)::numeric, 0) as d
              from jsonb_object_keys(v_before || v_after) as k(k)) d
      full join (select h.location_id as loc, sum(h.quantity) as q
                   from public.stock_movement_holdings h where h.movement_id = p_mv
                  group by h.location_id) r on r.loc = d.loc;
    raise exception using errcode = 'ZX373', message =
      'ok|' || pg_temp.snap4(p_item) || '#' || pg_temp.rows4(p_mv) || '#oracle=' || v_oracle::text;
  exception
    when sqlstate 'ZX373' then return sqlerrm;
    when others then return 'err|' || sqlstate || '|' || sqlerrm;
  end;
end $f$;

-- Report a movement's recorded snapshots from INSIDE pg_temp.run (whose
-- subtransaction is rolled back), as an error message.
create function pg_temp.whtag(p_wh uuid) returns text language sql immutable as $f$
  select case p_wh when '03730000-0000-0000-0000-0000000000b1'::uuid then 'WA'
                   when '03730000-0000-0000-0000-0000000000b2'::uuid then 'WB'
                   when null then 'org' else coalesce(p_wh::text, 'org') end;
$f$;
create function pg_temp.leak(p_mv uuid) returns void language plpgsql as $f$
declare v text;
begin
  select string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || coalesce(h.location_kind, 'null') || ':'
                    || pg_temp.whtag(h.location_warehouse_id) || ':' || pg_temp.whtag(h.item_warehouse_id)
                    || ':' || coalesce(h.mode, 'null'), ',' order by h.seq)
    into v from public.stock_movement_holdings h where h.movement_id = p_mv;
  raise exception using errcode = 'ZX374', message = coalesce(v, '<none>');
end $f$;
create function pg_temp.leak_fk(p_mv uuid) returns void language plpgsql as $f$
begin
  raise exception using errcode = 'ZX375', message = pg_temp.rows(p_mv) || '|' || pg_temp.fk_ok();
end $f$;

-- The 0359 body of public.apply_level_delta, VERBATIM (P8 proves the md5).
-- Run with no jwt subject, so its gate is skipped: the differential oracle.
create function pg_temp.ald_0359(p_item_id uuid, p_qty numeric, p_mode text default 'placed')
returns void
language plpgsql
set search_path = public
as $function$
declare
  v_org    uuid;
  v_wh     uuid;
  v_loc    uuid;
  v_need   numeric;
  v_take   numeric;
  v_lvl    record;
begin
  if p_qty = 0 or p_qty is null then return; end if;
  select organization_id, warehouse_id into v_org, v_wh
    from public.inventory_items where id = p_item_id;

  -- *** 0331 authorization gate — see that migration's header. auth.uid() IS
  -- NULL means a service_role/postgres connection (anon and PUBLIC hold no
  -- EXECUTE; every authenticated request carries a sub claim). Everyone else
  -- must be an accepted, non-disabled, unexpired staff+ member of the org that
  -- OWNS the item (v_org comes from the item row above, never from the caller).
  -- The gate runs BEFORE the not-found early-return on purpose (existence
  -- probing). ***
  if auth.uid() is not null then
    if v_org is null or not public.has_org_role(v_org, 'staff') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    -- *** 0359: only from inside a ledger RPC. A direct call would move
    -- holdings with no movement row and no on-hand change. ***
    if not ledger.active() then
      raise exception 'ledger_only' using errcode = '42501';
    end if;
  end if;
  if v_org is null then return; end if;

  -- ---- INCREMENT: land in Staging ----------------------------------------
  if p_qty > 0 then
    if v_wh is not null then
      perform public.ensure_warehouse_placement_locations(v_wh);
      select id into v_loc from public.locations
        where warehouse_id = v_wh and kind = 'staging' and deleted_at is null limit 1;
    else
      perform public.ensure_org_placement_locations(v_org);
      select id into v_loc from public.locations
        where organization_id = v_org and warehouse_id is null
          and kind = 'staging' and deleted_at is null limit 1;
    end if;
    insert into public.item_stock_levels(organization_id, item_id, location_id, quantity)
    values (v_org, p_item_id, v_loc, p_qty)
    on conflict (item_id, location_id) do update
      set quantity = public.item_stock_levels.quantity + excluded.quantity,
          updated_at = now();
    return;
  end if;

  -- ---- DECREMENT: draw down by mode --------------------------------------
  v_need := -p_qty;  -- positive amount to remove

  -- staging_first: drain the Staging level(s) before placed.
  if p_mode = 'staging_first' then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  -- placed draw-down (racks/areas/crates first, Unplaced last; never Staging).
  -- IS DISTINCT FROM, not <>: locations.kind is nullable (0292).
  for v_lvl in
    select s.location_id, s.quantity
      from public.item_stock_levels s
      join public.locations l on l.id = s.location_id
     where s.item_id = p_item_id and s.quantity > 0 and l.kind is distinct from 'staging'
     order by (case when l.kind = 'unplaced' then 1 else 0 end), l.created_at
  loop
    exit when v_need <= 0;
    v_take := least(v_lvl.quantity, v_need);
    update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
      where item_id = p_item_id and location_id = v_lvl.location_id;
    v_need := v_need - v_take;
  end loop;

  -- *** 0341: 'any' — the placed holdings did not cover a MANUAL removal;
  -- continue into Staging (largest level first, like staging_first). Reached
  -- only in this mode and only when v_need is still positive, so 'placed'
  -- callers keep never touching Staging. ***
  if p_mode = 'any' and v_need > 0 then
    for v_lvl in
      select s.location_id, s.quantity
        from public.item_stock_levels s
        join public.locations l on l.id = s.location_id
       where s.item_id = p_item_id and s.quantity > 0 and l.kind = 'staging'
       order by s.quantity desc
    loop
      exit when v_need <= 0;
      v_take := least(v_lvl.quantity, v_need);
      update public.item_stock_levels set quantity = quantity - v_take, updated_at = now()
        where item_id = p_item_id and location_id = v_lvl.location_id;
      v_need := v_need - v_take;
    end loop;
  end if;

  if v_need > 0 then
    raise exception 'insufficient_placed_stock' using errcode = 'P0001';
  end if;
end;
$function$;

-- ══════════════════════════════════════════════════════════════════════════
-- 0. CONTROL
-- ══════════════════════════════════════════════════════════════════════════
select is(pg_temp.snap(:itX), 'A1=1,A2=1,B1=4,S=2,SA=5,SB=3,UA=2',
  'CONTROL: itX holds 18 across a WA rack, the org Site, a WB rack, an archived WA crate, WA Unplaced and both Stagings');

-- ══════════════════════════════════════════════════════════════════════════
-- A. STRUCTURE
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select c.relrowsecurity::text || '|' ||
          (select string_agg(p.policyname || ':' || p.cmd || ':' || p.permissive || ':' || p.roles::text, ',')
             from pg_policies p where p.schemaname = 'public' and p.tablename = 'stock_movement_holdings')
     from pg_class c where c.oid = 'public.stock_movement_holdings'::regclass),
  'true|stock_movement_holdings_select:SELECT:PERMISSIVE:{authenticated}',
  'A1: RLS is on and the only policy is FOR SELECT TO authenticated');
select ok(
  (select qual ~ 'rls_member_org_ids' and qual ~ 'stock_movements m'
          and qual ~ 'm\.id = stock_movement_holdings\.movement_id'
     from pg_policies where schemaname = 'public' and tablename = 'stock_movement_holdings'),
  'A2: the SELECT policy is the org prefilter plus EXISTS on the parent movement (qualified columns)');
select is(
  (select string_agg(a.attname, ',' order by k.ord)
     from pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conname = 'stock_movement_holdings_pkey'),
  'movement_id,seq',
  'A3: the primary key is (movement_id, seq); location_id is not in it (no PostgREST many-to-many)');
select is(
  (select c.condeferrable::text || c.condeferred::text || '|' || c.confdeltype::text || '|' || c.confrelid::regclass::text || '|'
          || (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
          || '>' || (select string_agg(a.attname, ',' order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
     from pg_constraint c where c.conname = 'stock_movement_holdings_movement_fk'),
  'truetrue|c|stock_movements|movement_id,organization_id,item_id>id,organization_id,item_id',
  'A4: the movement FK is composite (id, org, item), DEFERRABLE INITIALLY DEFERRED, ON DELETE CASCADE');
select is(
  (select c.condeferrable::text || '|' || c.confdeltype::text || '|' || c.confrelid::regclass::text
     from pg_constraint c where c.conname = 'stock_movement_holdings_location_fk'),
  'false|n|locations',
  'A5: the location FK is immediate and ON DELETE SET NULL');
select is(
  (select i.indisunique::text || '|' || (i.indpred is null)::text || '|' || pg_get_indexdef(i.indexrelid)
     from pg_index i where i.indexrelid = 'public.stock_movements_id_org_item_key'::regclass),
  'true|true|CREATE UNIQUE INDEX stock_movements_id_org_item_key ON public.stock_movements USING btree (id, organization_id, item_id)',
  'A6: the unique index the FK references is plain and non-partial on (id, organization_id, item_id)');
select is(
  (select coalesce(string_agg(r || ':' || p, ',' order by r, p), '')
     from unnest(array['anon', 'authenticated', 'service_role']) r,
          unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
    where has_table_privilege(r, 'public.stock_movement_holdings', p)
       or (p in ('INSERT', 'UPDATE', 'REFERENCES')
           and has_any_column_privilege(r, 'public.stock_movement_holdings', p))),
  '',
  'A7: no API role (service_role included) holds any write privilege, table- or column-level');
select ok(
  has_table_privilege('authenticated', 'public.stock_movement_holdings', 'SELECT')
  and has_table_privilege('service_role', 'public.stock_movement_holdings', 'SELECT')
  and not has_table_privilege('anon', 'public.stock_movement_holdings', 'SELECT')
  and not exists (select 1 from pg_class c, aclexplode(c.relacl) a
                   where c.oid = 'public.stock_movement_holdings'::regclass and a.grantee = 0),
  'A8: SELECT for authenticated and service_role only; nothing for anon or PUBLIC');
select ok(
  not exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public'
                 and tablename = 'stock_movement_holdings'),
  'A9: the table is not in the realtime publication');
select is(
  (select string_agg(pg_get_constraintdef(c.oid), ' ; ' order by pg_get_constraintdef(c.oid) collate "C")
     from pg_constraint c
    where c.conrelid = 'public.stock_movement_holdings'::regclass and c.contype = 'c'),
  'CHECK ((actor_scope = ANY (ARRAY[''service''::text, ''manager''::text, ''in_scope''::text, ''out_of_scope''::text]))) ; CHECK ((quantity <> (0)::numeric)) ; CHECK ((seq > 0)) ; CHECK ((step = ANY (ARRAY[''increment''::text, ''staging_first''::text, ''placed''::text, ''any_staging''::text])))',
  'A10: the CHECKs: seq > 0, quantity <> 0, the four steps, the four scopes');
select is(
  (select count(*)::int || '|' || bool_and(p.prosecdef)::text || '|' || min(p.proconfig::text) || '|'
          || min(p.pronargdefaults) || '|' || min(p.prorettype::regtype::text) || '|'
          || min(pg_get_function_identity_arguments(p.oid))
     from pg_proc p where p.pronamespace = 'ledger'::regnamespace and p.proname = 'apply_level_delta_for'),
  '1|true|{search_path=public}|0|void|p_movement_id uuid, p_item_id uuid, p_qty numeric, p_mode text',
  'A11: exactly one engine: SECURITY DEFINER, search_path=public, no defaults, returns void');
select ok(
  has_function_privilege('authenticated', 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)', 'execute')
  and has_function_privilege('service_role', 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)', 'execute')
  and not has_function_privilege('anon', 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)'::regprocedure and a.grantee = 0),
  'A12: engine EXECUTE for authenticated (the INVOKER bodies call it as the user) and service_role; none for anon or PUBLIC');
select ok(
  (select count(*) = 1 and bool_and(not p.prosecdef) from pg_proc p
    where p.pronamespace = 'ledger'::regnamespace and p.proname = '_record_holdings')
  and not has_function_privilege('anon', 'ledger._record_holdings(uuid,uuid,uuid,uuid,uuid[],numeric[],text[],text)', 'execute')
  and not has_function_privilege('authenticated', 'ledger._record_holdings(uuid,uuid,uuid,uuid,uuid[],numeric[],text[],text)', 'execute')
  and not has_function_privilege('service_role', 'ledger._record_holdings(uuid,uuid,uuid,uuid,uuid[],numeric[],text[],text)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'ledger._record_holdings(uuid,uuid,uuid,uuid,uuid[],numeric[],text[],text)'::regprocedure
                     and a.grantee = 0),
  'A13: the recorder is SECURITY INVOKER and no API role (nor PUBLIC) can execute it');
select is(
  (select count(*)::int || '|' || min(pg_get_function_arguments(p.oid)) || '|' || min(p.prorettype::regtype::text)
          || '|' || bool_and(p.prosecdef)::text || '|' || min(p.proconfig::text) || '|' || min(p.proacl::text)
          || '|' || min(md5(coalesce(obj_description(p.oid, 'pg_proc'), '<none>')))
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_level_delta'),
  '1|p_item_id uuid, p_qty numeric, p_mode text DEFAULT ''placed''::text|void|true|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|627ae82e5211f10ca9e5ede9723cdfe8',
  'A14: public.apply_level_delta keeps one overload, its default, SECURITY DEFINER, search_path, ACL and comment');
select is(
  (select pg_get_indexdef(i.indexrelid) from pg_index i
    where i.indexrelid = 'public.stock_movement_holdings_location_idx'::regclass),
  'CREATE INDEX stock_movement_holdings_location_idx ON public.stock_movement_holdings USING btree (location_id, created_at DESC) WHERE (location_id IS NOT NULL)',
  'A15: the per-location index exists (partial, newest first)');
select is(
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.stock_movement_holdings'::regclass and a.attnum > 0 and not a.attisdropped),
  'movement_id:uuid:true,seq:integer:true,organization_id:uuid:true,item_id:uuid:true,location_id:uuid:false,quantity:numeric(14,4):true,step:text:true,mode:text:false,location_kind:text:false,location_warehouse_id:uuid:false,item_warehouse_id:uuid:false,actor_scope:text:true,created_at:timestamp with time zone:true',
  'A16: the column list');

-- ══════════════════════════════════════════════════════════════════════════
-- P. TEXT PROOFS
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0373[^\n]*', '', 'g')) from pg_proc p
    where p.oid = 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)'::regprocedure),
  '4be0f94c4390e7cd9c15a73e629133bf',
  'P1: the engine minus its tagged lines IS the 0359 apply_level_delta prosrc (md5)');
select is(
  (select string_agg(btrim(m[1]), E'\n' order by o)
     from pg_proc p, regexp_matches(p.prosrc, '\n([^\n]*)-- 0373[^\n]*', 'g') with ordinality r(m, o)
    where p.oid = 'ledger.apply_level_delta_for(uuid,uuid,numeric,text)'::regprocedure),
  $x$v_locs   uuid[]    := '{}';
v_qtys   numeric[] := '{}';
v_steps  text[]    := '{}';
perform ledger._record_holdings(p_movement_id, v_org, p_item_id, v_wh, array[v_loc], array[p_qty], array['increment'], p_mode);
v_locs := v_locs || v_lvl.location_id; v_qtys := v_qtys || (-v_take); v_steps := v_steps || 'staging_first'::text;
v_locs := v_locs || v_lvl.location_id; v_qtys := v_qtys || (-v_take); v_steps := v_steps || 'placed'::text;
v_locs := v_locs || v_lvl.location_id; v_qtys := v_qtys || (-v_take); v_steps := v_steps || 'any_staging'::text;
perform ledger._record_holdings(p_movement_id, v_org, p_item_id, v_wh, v_locs, v_qtys, v_steps, p_mode);$x$,
  'P2: the engine has exactly eight tagged lines, in order: three declares, the increment record, one append per draw loop (staging_first, placed, any_staging), the final record');
select is(
  (select string_agg(x.fn || '=' || (x.stripped = x.want)::text || ':' || x.shapes_ok::text, ',' order by x.fn)
     from (
       select v.fn, v.want,
              md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0373[^\n]*', '', 'g')) as stripped,
              (select bool_and(btrim(m[1]) ~ '^(v_mv_id\s+uuid( := gen_random_uuid\(\))?;|v_mv_id := gen_random_uuid\(\);|perform ledger\.apply_level_delta_for\(v_mv_id, [^;]+\);|id,|v_mv_id,)$')
                 from regexp_matches(p.prosrc, '\n([^\n]*)-- 0373[^\n]*', 'g') m) as shapes_ok
         from (values
           ('adjust_stock',               'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)',         '2a3526c05ad8d2dfbd3deba457e7bf42'),
           ('assemble_bundle',            'ledger.assemble_bundle(uuid,numeric,uuid,text)',                     '19f334042018cd4667032da003b6e6ce'),
           ('distribute_bundle',          'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)', '04909b1f699a977aa95f9cd0cf6cc427'),
           ('process_return_disposition', 'ledger.process_return_disposition(uuid)',                            'e13b1e104876286949d95c282008f84b')
         ) v(fn, sig, want)
         join pg_proc p on p.oid = v.sig::regprocedure) x),
  'adjust_stock=true:true,assemble_bundle=true:true,distribute_bundle=true:true,process_return_disposition=true:true',
  'P3: each restated caller minus its tagged lines IS its pre-0373 prosrc minus the apply_level_delta lines (md5), and every tagged line is an allowed shape');
select is(
  (select string_agg(x.fn || ':' || x.n, ',' order by x.fn)
     from (select p.proname as fn, (select count(*) from regexp_matches(p.prosrc, '\n[^\n]*-- 0373', 'g')) as n
             from pg_proc p where p.oid in (
               'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)'::regprocedure,
               'ledger.assemble_bundle(uuid,numeric,uuid,text)'::regprocedure,
               'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
               'ledger.process_return_disposition(uuid)'::regprocedure)) x),
  'adjust_stock:4,assemble_bundle:9,distribute_bundle:9,process_return_disposition:9',
  'P4: the tagged-line count per caller (adjust: declare + call + two id lines; the others: declare + 2 x (mint, call, two id lines))');
select is(
  (select string_agg(p.proname || ':' ||
            (select string_agg(m[1], '/') from regexp_matches(p.prosrc, 'apply_level_delta_for\((v_mv_id, [^,]+, [^,]+(?:, [^)]+)?)\);', 'g') m),
          ' | ' order by p.proname)
     from pg_proc p where p.oid in (
       'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)'::regprocedure,
       'ledger.assemble_bundle(uuid,numeric,uuid,text)'::regprocedure,
       'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
       'ledger.process_return_disposition(uuid)'::regprocedure)),
  'adjust_stock:v_mv_id, p_item_id, p_quantity_change, p_mode | assemble_bundle:v_mv_id, v_component.item_id, v_new - v_prev, ''placed''/v_mv_id, v_phantom.id, v_new - v_prev, ''staging'' | distribute_bundle:v_mv_id, v_bundle.phantom_item_id, v_new - v_prev, ''staging_first''/v_mv_id, v_component.item_id, v_new - v_prev, ''placed'' | process_return_disposition:v_mv_id, v_line.item_id, v_line.quantity, ''staging''/v_mv_id, v_line.item_id, -v_line.quantity, ''staging_first''',
  'P5: every engine call passes v_mv_id and the SAME item, quantity and mode as the apply_level_delta call it replaced');
select ok(
  (select bool_and(p.prosrc !~ 'public\.apply_level_delta\(') from pg_proc p where p.oid in (
     'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)'::regprocedure,
     'ledger.assemble_bundle(uuid,numeric,uuid,text)'::regprocedure,
     'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
     'ledger.process_return_disposition(uuid)'::regprocedure))
  and (select p.prosrc ~ 'perform ledger\.apply_level_delta_for\(null, p_item_id, p_qty, p_mode\);'
         from pg_proc p where p.oid = 'public.apply_level_delta(uuid,numeric,text)'::regprocedure),
  'P6: no restated caller calls public.apply_level_delta any more; the wrapper passes a NULL movement id');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || p.proconfig::text || ':' || p.proacl::text || ':'
                     || pg_get_userbyid(p.proowner) || ':' || md5(coalesce(obj_description(p.oid, 'pg_proc'), '<none>'))
                     || ':' || (select ty.typname from pg_type ty where ty.oid = p.prorettype) || ':' || md5(pg_get_function_arguments(p.oid)),
                     E'\n' order by p.proname)
     from pg_proc p where p.oid in (
       'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)'::regprocedure,
       'ledger.assemble_bundle(uuid,numeric,uuid,text)'::regprocedure,
       'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
       'ledger.process_return_disposition(uuid)'::regprocedure)),
  $p7$adjust_stock:false:{search_path=public}:{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}:postgres:39c71bb3ec9da1d20cc17322793fe353:inventory_items:7c3921bbc4d26bf3219f877e073bb2df
assemble_bundle:false:{search_path=public}:{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}:postgres:39c71bb3ec9da1d20cc17322793fe353:record:1c5ed6163acfb2c91ca285a052fa7509
distribute_bundle:false:{search_path=public}:{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}:postgres:b887a8758dd059600cfb47a9c34fc87e:uuid:a2c0b3a90915d7da486384f113ca56a9
process_return_disposition:true:{"search_path=public, extensions"}:{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}:postgres:39c71bb3ec9da1d20cc17322793fe353:returns:1547eb3193b5cc4c38570399b418da9a$p7$,
  'P7: the four callers keep their SECURITY mode, search_path, ACL, owner, comment, return type and argument list (pinned pre-0373 values)');
select is(
  (select md5(p.prosrc) from pg_proc p where p.oid = 'pg_temp.ald_0359(uuid,numeric,text)'::regprocedure),
  '4be0f94c4390e7cd9c15a73e629133bf',
  'P8: the differential oracle pg_temp.ald_0359 IS the 0359 body (md5)');

-- ══════════════════════════════════════════════════════════════════════════
-- B. DIFFERENTIAL ORACLE (service path: no jwt subject)
-- Each line: engine-with-id vs oracle (holdings or error), then wrapper vs
-- oracle (everything, which includes "no rows recorded").
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to '';

select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -1, ''placed'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')', :itX), :itX), '#', 1),
  'B1: engine = 0359 oracle: placed -1 (first placed holding only)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -1, ''placed'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')', :itX), :itX),
  'B2: wrapper = 0359 oracle, and it records nothing: placed -1 (first placed holding only)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -10, ''placed'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -10, ''placed'')', :itX), :itX), '#', 1),
  'B3: engine = 0359 oracle: placed -10 (every placed holding, Unplaced last, the archived crate included)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -10, ''placed'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -10, ''placed'')', :itX), :itX),
  'B4: wrapper = 0359 oracle, and it records nothing: placed -10 (every placed holding, Unplaced last, the archived crate included)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -11, ''placed'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -11, ''placed'')', :itX), :itX), '#', 1),
  'B5: engine = 0359 oracle: placed -11 (placed never touches Staging: raises)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -11, ''placed'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -11, ''placed'')', :itX), :itX),
  'B6: wrapper = 0359 oracle, and it records nothing: placed -11 (placed never touches Staging: raises)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -6, ''staging_first'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -6, ''staging_first'')', :itX), :itX), '#', 1),
  'B7: engine = 0359 oracle: staging_first -6 (Staging largest first, across warehouses)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -6, ''staging_first'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -6, ''staging_first'')', :itX), :itX),
  'B8: wrapper = 0359 oracle, and it records nothing: staging_first -6 (Staging largest first, across warehouses)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -12, ''staging_first'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -12, ''staging_first'')', :itX), :itX), '#', 1),
  'B9: engine = 0359 oracle: staging_first -12 (all Staging, then placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -12, ''staging_first'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -12, ''staging_first'')', :itX), :itX),
  'B10: wrapper = 0359 oracle, and it records nothing: staging_first -12 (all Staging, then placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -19, ''staging_first'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''staging_first'')', :itX), :itX), '#', 1),
  'B11: engine = 0359 oracle: staging_first -19 (more than exists: raises)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -19, ''staging_first'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''staging_first'')', :itX), :itX),
  'B12: wrapper = 0359 oracle, and it records nothing: staging_first -19 (more than exists: raises)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -13, ''any'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -13, ''any'')', :itX), :itX), '#', 1),
  'B13: engine = 0359 oracle: any -13 (placed, then Staging)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -13, ''any'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -13, ''any'')', :itX), :itX),
  'B14: wrapper = 0359 oracle, and it records nothing: any -13 (placed, then Staging)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -19, ''any'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''any'')', :itX), :itX), '#', 1),
  'B15: engine = 0359 oracle: any -19 (more than exists: raises)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -19, ''any'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''any'')', :itX), :itX),
  'B16: wrapper = 0359 oracle, and it records nothing: any -19 (more than exists: raises)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -3, ''staging'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -3, ''staging'')', :itX), :itX), '#', 1),
  'B17: engine = 0359 oracle: mode staging -3 (draws as placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -3, ''staging'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -3, ''staging'')', :itX), :itX),
  'B18: wrapper = 0359 oracle, and it records nothing: mode staging -3 (draws as placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -4, ''bogus'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -4, ''bogus'')', :itX), :itX), '#', 1),
  'B19: engine = 0359 oracle: mode bogus -4 (draws as placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -4, ''bogus'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -4, ''bogus'')', :itX), :itX),
  'B20: wrapper = 0359 oracle, and it records nothing: mode bogus -4 (draws as placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -4, null)', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -4, null)', :itX), :itX), '#', 1),
  'B21: engine = 0359 oracle: mode NULL -4 (draws as placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -4, null)', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -4, null)', :itX), :itX),
  'B22: wrapper = 0359 oracle, and it records nothing: mode NULL -4 (draws as placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, 3, ''placed'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 3, ''placed'')', :itX), :itX), '#', 1),
  'B23: engine = 0359 oracle: placed +3 (lands in WA Staging)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 3, ''placed'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 3, ''placed'')', :itX), :itX),
  'B24: wrapper = 0359 oracle, and it records nothing: placed +3 (lands in WA Staging)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, 2, ''any'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''any'')', :itX), :itX), '#', 1),
  'B25: engine = 0359 oracle: any +2 (mode ignored for an increment)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 2, ''any'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''any'')', :itX), :itX),
  'B26: wrapper = 0359 oracle, and it records nothing: any +2 (mode ignored for an increment)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, 0, ''placed'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 0, ''placed'')', :itX), :itX), '#', 1),
  'B27: engine = 0359 oracle: zero (no-op)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 0, ''placed'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 0, ''placed'')', :itX), :itX),
  'B28: wrapper = 0359 oracle, and it records nothing: zero (no-op)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, null, ''placed'')', :mvB, :itX), :itX, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, null, ''placed'')', :itX), :itX), '#', 1),
  'B29: engine = 0359 oracle: NULL quantity (no-op)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, null, ''placed'')', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, null, ''placed'')', :itX), :itX),
  'B30: wrapper = 0359 oracle, and it records nothing: NULL quantity (no-op)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, 2, ''placed'')', :mvB, :itN), :itN, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''placed'')', :itN), :itN), '#', 1),
  'B31: engine = 0359 oracle: no-warehouse item +2 (org-level Staging, created on demand)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 2, ''placed'')', :itN), :itN),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''placed'')', :itN), :itN),
  'B32: wrapper = 0359 oracle, and it records nothing: no-warehouse item +2 (org-level Staging, created on demand)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, %L, -1, ''placed'')', :mvB, :itN), :itN, :mvB), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')', :itN), :itN), '#', 1),
  'B33: engine = 0359 oracle: no-warehouse item -1 (the org Site)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -1, ''placed'')', :itN), :itN),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')', :itN), :itN),
  'B34: wrapper = 0359 oracle, and it records nothing: no-warehouse item -1 (the org Site)');
select is(split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -10, ''placed'')', :itX), :itX), '#', 1),
  'ok|A1=0,A2=0,B1=0,S=0,SA=5,SB=3,UA=0',
  'B35: the oracle itself: placed -10 empties every placed holding and leaves Staging');

-- ══════════════════════════════════════════════════════════════════════════
-- C. PROVENANCE TRUTH
-- ══════════════════════════════════════════════════════════════════════════
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, -10, 'placed')$$, :mvC, :itX), :itX, :mvC),
  'ok|A1=0,A2=0,B1=0,S=0,SA=5,SB=3,UA=0#1:A1:-1:placed:service,2:S:-2:placed:service,3:B1:-4:placed:service,4:A2:-1:placed:service,5:UA:-2:placed:service#diff=A1:-1,A2:-1,B1:-4,S:-2,UA:-2#oracle=true#total=-10#facts=true#n=5',
  'C1: placed -10: rows in draw order (location age: A1, Site, WB rack, archived crate; Unplaced last), summing to the holdings difference');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, -12, 'staging_first')$$, :mvC, :itX), :itX, :mvC),
  'ok|A1=0,A2=1,B1=3,S=0,SA=0,SB=0,UA=2#1:SA:-5:staging_first:service,2:SB:-3:staging_first:service,3:A1:-1:placed:service,4:S:-2:placed:service,5:B1:-1:placed:service#diff=A1:-1,B1:-1,S:-2,SA:-5,SB:-3#oracle=true#total=-12#facts=true#n=5',
  'C2: staging_first -12: Staging largest first (WA 5, then WB 3), then placed');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, -13, 'any')$$, :mvC, :itX), :itX, :mvC),
  'ok|A1=0,A2=0,B1=0,S=0,SA=2,SB=3,UA=0#1:A1:-1:placed:service,2:S:-2:placed:service,3:B1:-4:placed:service,4:A2:-1:placed:service,5:UA:-2:placed:service,6:SA:-3:any_staging:service#diff=A1:-1,A2:-1,B1:-4,S:-2,SA:-3,UA:-2#oracle=true#total=-13#facts=true#n=6',
  'C3: any -13: every placed holding, then Staging largest first (any_staging)');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, 3, 'placed')$$, :mvC, :itX), :itX, :mvC),
  'ok|A1=1,A2=1,B1=4,S=2,SA=8,SB=3,UA=2#1:SA:3:increment:service#diff=SA:3#oracle=true#total=3#facts=true#n=1',
  'C4: +3 lands in the item''s own warehouse Staging: one increment row');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, 2, 'any')$$, :mvC, :itN), :itN, :mvC),
  'ok|S=2,new-staging-org=2#1:new-staging-org:2:increment:service#diff=new-staging-org:2#oracle=true#total=2#facts=true#n=1',
  'C5: an item with no warehouse lands in the org-level Staging (created on demand, as before)');
-- The draw-time snapshots and the mode, literally, for a draw that crosses
-- warehouses (B1 is in WB, the item in WA) and a non-standard mode string.
select is(
  (select pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, -7, 'bogus'); select pg_temp.leak(%L)$$, :mvC, :itX, :mvC), :itX, :mvC)),
  'err|ZX374|1:A1:rack:WA:WA:bogus,2:S:null:org:WA:bogus,3:B1:rack:WB:WA:bogus',
  'C6: snapshots are facts at draw time: location kind and warehouse (NULL Site = org), the ITEM''s warehouse (not the location''s), and p_mode exactly as passed');
set local "request.jwt.claim.sub" to :u_mgr;
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
select is(
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, -7, 'placed')$$, :mvC, :itX), :itX, :mvC), '#', 2),
  '1:A1:-1:placed:manager,2:S:-2:placed:manager,3:B1:-4:placed:manager',
  'C7: a manager''s draw records actor_scope manager for every holding');
set local "request.jwt.claim.sub" to :u_stf;
select is(
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, -7, 'placed')$$, :mvC, :itX), :itX, :mvC), '#', 2),
  '1:A1:-1:placed:in_scope,2:S:-2:placed:in_scope,3:B1:-4:placed:out_of_scope',
  'C8: a WA staff draw: WA rack and the org-level Site in_scope, the WB rack out_of_scope');
select set_config('stockpilot.ledger', '', true);
set local "request.jwt.claim.sub" to '';

-- ══════════════════════════════════════════════════════════════════════════
-- R. SUB-PRECISION QUANTITIES (review 2026-09-25). adjust_stock takes an
-- unconstrained numeric and the API accepts any finite value, but holdings
-- are numeric(14,4). Before the fix the recorder inserted the unrounded
-- share: a share under 0.00005 became a 0.0000 row and the CHECK failed the
-- whole draw (23514) where 0359 succeeded, and a half-way take recorded
-- 0.0001 against a holding that did not move. Each case: the engine's
-- holdings equal the 0359 oracle's EXACTLY, the rows are literal, and per
-- location the rows equal the holdings difference exactly. Service path.
-- ══════════════════════════════════════════════════════════════════════════
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -0.00001, ''placed'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -0.00001, ''placed'')', :itX), :itX), '#', 1) || '##oracle=true',
  'R1: -0.00001 moves nothing (as 0359) and records no row (was 23514)');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, 0.00004, ''placed'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, 0.00004, ''placed'')', :itX), :itX), '#', 1) || '##oracle=true',
  'R2: +0.00004 lands nothing (as 0359) and records no row (was 23514)');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -1.00001, ''placed'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -1.00001, ''placed'')', :itX), :itX), '#', 1) || '#1:A1:-1.0000:placed#oracle=true',
  'R3: -1.00001 empties A1; the 0.00001 remainder on the Site moves nothing and records no row (was 23514)');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -0.00005, ''placed'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -0.00005, ''placed'')', :itX), :itX), '#', 1) || '##oracle=true',
  'R4: -0.00005 (an exact half) leaves A1 at 1.0000, so no row (was a -0.0001 row against an unchanged holding)');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -0.00006, ''placed'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -0.00006, ''placed'')', :itX), :itX), '#', 1) || '#1:A1:-0.0001:placed#oracle=true',
  'R5: -0.00006 takes A1 to 0.9999: one -0.0001 row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, 0.00005, ''placed'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, 0.00005, ''placed'')', :itX), :itX), '#', 1) || '#1:SA:0.0001:increment#oracle=true',
  'R6: +0.00005 (an exact half) lands 0.0001 in WA Staging: one 0.0001 row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -5.00005, ''staging_first'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -5.00005, ''staging_first'')', :itX), :itX), '#', 1) || '#1:SA:-5.0000:staging_first#oracle=true',
  'R7: staging_first -5.00005 empties WA Staging; the half on WB Staging moves nothing and records no row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -10.00006, ''any'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -10.00006, ''any'')', :itX), :itX), '#', 1)
          || '#1:A1:-1.0000:placed,2:S:-2.0000:placed,3:B1:-4.0000:placed,4:A2:-1.0000:placed,5:UA:-2.0000:placed,6:SA:-0.0001:any_staging#oracle=true',
  'R8: any -10.00006: every placed holding, then 0.0001 off WA Staging (any_staging kept: it moved)');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, %L, -10.00001, ''any'')', :mvB, :itX), :itX, :mvB),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -10.00001, ''any'')', :itX), :itX), '#', 1)
          || '#1:A1:-1.0000:placed,2:S:-2.0000:placed,3:B1:-4.0000:placed,4:A2:-1.0000:placed,5:UA:-2.0000:placed#oracle=true',
  'R9: any -10.00001: every placed holding; the 0.00001 Staging remainder moves nothing and records no row');

-- ══════════════════════════════════════════════════════════════════════════
-- D. PER CALLER, AS REAL PERSONAS
-- ══════════════════════════════════════════════════════════════════════════

-- D1: the phone shape (6 arguments, default mode 'placed'), WA staff.
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -2, 'remove', null, 'D1 phone', null)$$, :itX),
  'D1: WA staff removes 2 with no location (the phone item screen shape)');
select lives_ok(format($$select public.adjust_stock(%L, -3, 'remove', null, 'D1 reach', null)$$, :itX),
  'D2: WA staff removes 3 more; the draw reaches the WB rack');
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D3: the deferred FK holds for both movements (every row names a real movement of the same org and item)');
select is(
  (select count(*)::int || '|' || coalesce(m.from_location_id::text, '-') || '>' || coalesce(m.to_location_id::text, '-')
          || '|' || pg_temp.rows(m.id) || '|' || (select string_agg(distinct h.mode, ',') from public.stock_movement_holdings h where h.movement_id = m.id)
     from public.stock_movements m where m.item_id = :itX and m.reason = 'D1 phone' group by m.id),
  '1|->-|1:A1:-1:placed:in_scope,2:S:-1:placed:in_scope|placed',
  'D4: one movement, from/to still NULL, its rows (A1 then the Site) carry its id and mode placed');
select is(
  (select pg_temp.rows(m.id) || '|' ||
          (select string_agg(pg_temp.tag(h.location_id) || ':' || (h.location_warehouse_id is not distinct from :whB)::text
                             || ':' || (h.item_warehouse_id is not distinct from :whA)::text, ',' order by h.seq)
             from public.stock_movement_holdings h where h.movement_id = m.id)
     from public.stock_movements m where m.item_id = :itX and m.reason = 'D1 reach'),
  '1:S:-1:placed:in_scope,2:B1:-2:placed:out_of_scope|S:false:true,B1:true:true',
  'D5: the second draw: the Site, then the WB rack marked out_of_scope with the WB warehouse and the item''s WA warehouse');

-- D6: the web / API manual removal: mode 'any', placed stock short.
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -7, 'remove', null, 'D6 web', null, 'any')$$, :itX),
  'D6: WA staff removes 7 in mode any (placed holds only 5)');
-- D7: +1 with no location.
select lives_ok(format($$select public.adjust_stock(%L, 1, 'adjust', null, 'D7 plus', null)$$, :itX),
  'D7: WA staff adds 1 with no location');
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D8: the deferred FK holds');
select is(
  (select pg_temp.rows(pg_temp.mv(:itX, 'D6 web')) || ' | ' || pg_temp.rows(pg_temp.mv(:itX, 'D7 plus'))
          || ' | ' || coalesce((select to_location_id::text from public.stock_movements where id = pg_temp.mv(:itX, 'D7 plus')), 'null')),
  '1:B1:-2:placed:out_of_scope,2:A2:-1:placed:in_scope,3:UA:-2:placed:in_scope,4:SA:-2:any_staging:in_scope | 1:SA:1:increment:in_scope | null',
  'D9: any: the rest of the placed stock, then Staging (any_staging); +1: one increment row at WA Staging, to_location_id still NULL');

-- D10: explicit-location adjust and a transfer record nothing.
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, 2, 'adjust', %L, 'D10 explicit')$$, :itX, :locA1),
  'D10: a manager adjusts +2 at an explicit location');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1, 'D10 transfer')$$, :itX, :locA1, :locS),
  'D11: a manager transfers 1 from A1 to the Site');
reset role;
select is(
  (select string_agg(m.movement_type || ':' || coalesce(bf.tag, '-') || '>' || coalesce(bt.tag, '-') || ':'
                     || (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id),
                     ',' order by m.movement_type)
     from public.stock_movements m
     left join lbl bf on bf.id = m.from_location_id
     left join lbl bt on bt.id = m.to_location_id
    where m.item_id = :itX and (m.reason = 'D10 explicit' or m.notes = 'D10 transfer')) || '|' || pg_temp.fk_ok(),
  'adjust:->A1:0,transfer:A1>S:0|fk ok',
  'D12: explicit-location movements keep their from/to and record no provenance rows (the deferred FK holds)');
select is(pg_temp.snap(:itX) || ' qoh=' || (select quantity_on_hand::int from public.inventory_items where id = :itX),
  'A1=1,A2=0,B1=0,S=1,SA=4,SB=3,UA=0 qoh=9',
  'D13: itX holdings equal on hand after D1-D11');

-- D14: complete_picking, two lines of one item; the first spans P1 and P2.
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.complete_picking(%L)$$, :ordP), 'D14: WA staff completes the pick');
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D15: the deferred FK holds');
select is(
  (select count(*)::int || '|' || bool_and(m.reference_type = 'order_request' and m.reference_id = :ordP)::text
          || '|' || bool_and((select sum(h.quantity) from public.stock_movement_holdings h where h.movement_id = m.id) = m.quantity_change)::text
          || '|' || string_agg(pg_temp.rows(m.id), ' / ' order by (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id) desc)
     from public.stock_movements m where m.item_id = :itP and m.movement_type = 'transfer'),
  '2|true|true|1:P1:-1:placed:in_scope,2:P2:-1:placed:in_scope / 1:P2:-2:placed:in_scope',
  'D16: exactly two movements, both stamped order_request (the exactly-one probe still works); each movement''s rows sum to its batch; the duplicate line keeps its own rows');

-- D17: cancel restocks both lines into Staging.
set local role to 'authenticated';
select lives_ok(format($$select public.cancel_order_request(%L, 'D17 cancel')$$, :ordP), 'D17: the requester cancels the picked order');
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D18: the deferred FK holds');
select is(
  (select string_agg(pg_temp.rows(m.id), ' / ' order by m.id)
     from public.stock_movements m where m.item_id = :itP and m.movement_type = 'return'),
  '1:SA:2:increment:in_scope / 1:SA:2:increment:in_scope',
  'D19: one increment row per restocked line, at WA Staging');

-- D20: reverse_receipt draws staging_first.
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
do $$
declare
  v_receipt public.receipts;
  v_staging uuid;
begin
  select * into v_receipt from public.post_receipt_v2(
    '03730000-0000-0000-0000-0000000000d5'::uuid,
    '03730000-0000-0000-0000-0000000000b1'::uuid,
    jsonb_build_array(jsonb_build_object('po_line_id', '03730000-0000-0000-0000-0000000000d6',
      'qty_received', 3, 'qty_accepted', 3, 'qty_rejected', 0, 'unit_cost', 5)),
    'idem-0373-v', 'hash-0373-v', null);
  select id into v_staging from public.locations
   where warehouse_id = '03730000-0000-0000-0000-0000000000b1'::uuid and kind = 'staging' and deleted_at is null;
  perform public.transfer_stock('03730000-0000-0000-0000-0000000000c6'::uuid, v_staging,
                                '03730000-0000-0000-0000-0000000000e1'::uuid, 1);
  perform public.reverse_receipt(v_receipt.id, 'D20 reverse');
end $$;
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D20: the deferred FK holds after receive, transfer and reverse');
select is(
  (select string_agg(m.movement_type || ':' || m.quantity_change::int || '[' || pg_temp.rows(m.id) || ']', ' ' order by m.movement_type collate "C")
     from public.stock_movements m where m.item_id = :itV),
  'correction:-3[1:SA:-2:staging_first:manager,2:A1:-1:placed:manager] receive_po:3[] transfer:0[]',
  'D21: the receipt (explicit Staging) and the transfer record nothing; the reversal records Staging first, then A1');

-- D22: assemble then distribute (phantom drain, component draws, shortages).
set local role to 'authenticated';
select lives_ok(format($$select public.assemble_bundle(%L, 2, %L, 'D22 assemble')$$, :bnd, :whA),
  'D22: a manager assembles 2 kits');
select lives_ok(format($$select public.distribute_bundle(%L, 4, %L, true, null, 'D22 distribute', null)$$, :bnd, :whA),
  'D23: a manager distributes 4 (2 pre-assembled, 2 built from 1 of each part, shortages allowed)');
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D24: the deferred FK holds');
select is(
  (select string_agg(i.sku || ':' || m.movement_type || ':' || m.quantity_change::int || '[' || pg_temp.rows(m.id) || ']',
                     ' ' order by i.sku collate "C", m.movement_type collate "C", m.quantity_change)
     from public.stock_movements m join public.inventory_items i on i.id = m.item_id
    where m.reference_type = 'bundle' and m.reference_id = :bnd),
  'PV-0373-K1:bundle_assembly:-2[1:A1:-2:placed:manager] PV-0373-K1:bundle_distribution:-1[1:A1:-1:placed:manager] PV-0373-K1:bundle_shortage:0[] PV-0373-K2:bundle_assembly:-2[1:A1:-2:placed:manager] PV-0373-K2:bundle_distribution:-1[1:UA:-1:placed:manager] PV-0373-K2:bundle_shortage:0[] __BUNDLE__03730000:bundle_assembly:2[1:SA:2:increment:manager] __BUNDLE__03730000:bundle_distribution:-2[1:SA:-2:staging_first:manager]',
  'D25: one row set per movement: component draws (placed), the kit landing in Staging, the pre-assembled drain (staging_first); the zero-quantity shortage rows record nothing');

-- D26: return with scrap: restock lands in WA Staging; the scrap draws the
-- LARGEST Staging (WB), exactly as before; nothing crosses legs.
set local role to 'authenticated';
select lives_ok(format($$select public.process_return_disposition(%L)$$, :retR),
  'D26: a manager closes the scrap return');
reset role;
select is(pg_temp.fk_ok(), 'fk ok', 'D27: the deferred FK holds');
select is(
  (select string_agg(m.movement_type || ':' || m.quantity_change::int || '[' || pg_temp.rows(m.id) || ']', ' ' order by m.movement_type collate "C" desc)
     from public.stock_movements m where m.item_id = :itR),
  'return:2[1:SA:2:increment:manager] loss:-2[1:SB:-2:staging_first:manager]',
  'D28: the return movement has ONLY its +2 Staging landing; the loss movement has ONLY its own -2 (largest Staging first, as today)');

-- D29: THE PINNED GAP. post_cycle_count's residual draw goes through the
-- non-recording wrapper. When the count slice lands this flips on purpose.
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 2, counted_by = :u_mgr, counted_at = now() where id = :lnC;
select lives_ok(format($$select public.post_cycle_count(%L)$$, :ccC), 'D29: a manager posts a -2 count with no counted location');
reset role;
select is(
  (select m.quantity_change::int || '|' || coalesce(m.from_location_id::text, '-') || '|'
          || (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id) || '|' || pg_temp.snap(:itC)
          || '|' || pg_temp.fk_ok()
     from public.stock_movements m where m.item_id = :itC and m.reference_type = 'cycle_count' and m.reference_id = :ccC),
  '-2|-|0|A1=0,S=2|fk ok',
  'D30: PINNED GAP (0373 Q4): the count''s residual draw emptied A1 (2 -> 0) but recorded NO provenance');

-- D31: a WB item's draw, for the RLS parity below.
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -1, 'remove', null, 'D31 wb', null)$$, :itW),
  'D31: a manager removes 1 of the WB item');
reset role;
select is(pg_temp.rows(pg_temp.mv(:itW, 'D31 wb')) || '|' || pg_temp.fk_ok(), '1:B1:-1:placed:manager|fk ok',
  'D32: the WB item''s draw is recorded (the deferred FK holds)');

-- ══════════════════════════════════════════════════════════════════════════
-- E. FAILURE AND INTEGRITY
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select throws_ok(format($$select public.adjust_stock(%L, -3, 'remove', null, 'E1 short', null)$$, :itX),
  'P0001', 'insufficient_placed_stock', 'E1: a draw placed stock cannot cover: P0001 insufficient_placed_stock');
reset role;
set local "request.jwt.claim.sub" to '';
select is(
  pg_temp.run(format($$select pg_temp.ald_0359(%L, -3, 'placed')$$, :itX), :itX),
  'err|P0001|insufficient_placed_stock',
  'E2: the same SQLSTATE and message as the 0359 oracle on the same holdings');
select is(
  (select count(*)::int from public.stock_movements where item_id = :itX and reason = 'E1 short') || '|'
  || (select count(*) from public.stock_movement_holdings where item_id = :itX) || '|' || pg_temp.snap(:itX),
  '0|9|A1=1,A2=0,B1=0,S=1,SA=4,SB=3,UA=0',
  'E3: no movement, no new rows (still the 9 from D1-D7), holdings unchanged');
select is(pg_temp.fk_probe(:mvE, :itX, -1), '23503', 'E4: an engine call for a movement that never exists fails the FK (23503)');
select is(pg_temp.fk_probe(pg_temp.mv(:itW, 'D31 wb'), :itX, 1), '23503',
  'E5: an engine call naming ANOTHER item''s real movement fails the composite FK (23503)');
select is(
  (select pg_temp.run(format($$select ledger.apply_level_delta_for(%L, %L, 1, 'placed'); select pg_temp.leak_fk(%L)$$,
                              pg_temp.mv(:itX, 'D7 plus'), :itX, pg_temp.mv(:itX, 'D7 plus')), :itX)),
  'err|ZX375|1:SA:1:increment:in_scope,2:SA:1:increment:service|fk ok',
  'E6: a second engine call for the same movement continues seq (no 23505) and still satisfies the FK');
select is(
  (select count(*)::int from public.stock_movement_holdings where movement_id = pg_temp.mv(:itX, 'D7 plus')),
  1,
  'E7: the rolled-back subtransaction left no row behind');
select lives_ok(format($$select ledger.apply_level_delta_for(%L, %L, 0, 'placed'); select ledger.apply_level_delta_for(%L, %L, null, 'placed')$$,
                       :mvE, :itX, :mvE, :itX),
  'E8: zero and NULL quantities run');
select is(
  (select count(*)::int from public.stock_movement_holdings where movement_id = :mvE) || '|' || pg_temp.fk_ok() || '|' || pg_temp.snap(:itX),
  '0|fk ok|A1=1,A2=0,B1=0,S=1,SA=4,SB=3,UA=0',
  'E9: zero and NULL record nothing (and leave nothing pending for the FK) and move nothing');

-- ══════════════════════════════════════════════════════════════════════════
-- F. SECURITY
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.stock_movement_holdings (movement_id, seq, organization_id, item_id, location_id, quantity, step, actor_scope)
           values (%L, 99, %L, %L, %L, -1, 'placed', 'manager')$$, pg_temp.mv(:itW, 'D31 wb'), :orgS, :itW, :locB1),
  '42501', null, 'F1: a manager cannot INSERT a provenance row directly');
select throws_ok($$update public.stock_movement_holdings set quantity = -99$$,
  '42501', null, 'F2: nor UPDATE one');
select throws_ok($$delete from public.stock_movement_holdings$$,
  '42501', null, 'F3: nor DELETE one');
reset role;
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(format($$select ledger.apply_level_delta_for(%L, %L, -1, 'placed')$$, :mvE, :itX),
  '42501', 'ledger_only', 'F4: a direct engine call by staff outside a ledger RPC: 42501 ledger_only');
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(format($$select ledger.apply_level_delta_for(%L, %L, -1, 'placed')$$, :mvE, :itX),
  '42501', 'forbidden', 'F5: a direct engine call by an org outsider: 42501 forbidden');
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(format($$select public.apply_level_delta(%L, 500)$$, :itX),
  '42501', 'ledger_only', 'F6: a direct call of the wrapper by staff: still 42501 ledger_only (0359 #34)');
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(format($$select public.apply_level_delta(%L, -1)$$, :itX),
  '42501', 'forbidden', 'F7: a direct call of the wrapper by an outsider: still 42501 forbidden (0331)');
set local "request.jwt.claim.sub" to '';

-- RLS read parity. For every persona: the rows they can see are exactly the
-- rows whose parent movement they can see, with literal counts. 25 rows
-- exist: 24 on WA items (2 of them naming the WB rack) and 1 on the WB item.
create temp table vis (persona text, kind text, key text);
grant insert, select on vis to authenticated;

set local "request.jwt.claim.sub" to :u_adm;
set local role to 'authenticated';
insert into vis select 'adm', 'mv', m.id::text from public.stock_movements m where m.organization_id in (:orgS, :orgF);
insert into vis select 'adm', 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.organization_id in (:orgS, :orgF);
reset role;
select is(
  (select count(*) from vis where persona = 'adm' and kind = 'h')::text || '|' ||
  (not exists (select v.key from vis v where v.persona = 'adm' and v.kind = 'h'
               except
               select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                 join vis x on x.persona = 'adm' and x.kind = 'mv' and x.key = h.movement_id::text)
   and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                     join vis x on x.persona = 'adm' and x.kind = 'mv' and x.key = h.movement_id::text
                   except
                   select v.key from vis v where v.persona = 'adm' and v.kind = 'h'))::text,
  '25|true',
  'F8: parity: an admin sees every row (all 25); visible rows = rows of visible movements');
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
insert into vis select 'mgr', 'mv', m.id::text from public.stock_movements m where m.organization_id in (:orgS, :orgF);
insert into vis select 'mgr', 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.organization_id in (:orgS, :orgF);
reset role;
select is(
  (select count(*) from vis where persona = 'mgr' and kind = 'h')::text || '|' ||
  (not exists (select v.key from vis v where v.persona = 'mgr' and v.kind = 'h'
               except
               select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                 join vis x on x.persona = 'mgr' and x.kind = 'mv' and x.key = h.movement_id::text)
   and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                     join vis x on x.persona = 'mgr' and x.kind = 'mv' and x.key = h.movement_id::text
                   except
                   select v.key from vis v where v.persona = 'mgr' and v.kind = 'h'))::text,
  '25|true',
  'F9: parity: a manager sees every row (all 25); visible rows = rows of visible movements');
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
insert into vis select 'stf', 'mv', m.id::text from public.stock_movements m where m.organization_id in (:orgS, :orgF);
insert into vis select 'stf', 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.organization_id in (:orgS, :orgF);
insert into vis select 'stf', 'wb', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.location_warehouse_id = :whB and h.item_warehouse_id = :whA;
reset role;
select is(
  (select count(*) from vis where persona = 'stf' and kind = 'h')::text || '|' ||
  (not exists (select v.key from vis v where v.persona = 'stf' and v.kind = 'h'
               except
               select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                 join vis x on x.persona = 'stf' and x.kind = 'mv' and x.key = h.movement_id::text)
   and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                     join vis x on x.persona = 'stf' and x.kind = 'mv' and x.key = h.movement_id::text
                   except
                   select v.key from vis v where v.persona = 'stf' and v.kind = 'h'))::text,
  '24|true',
  'F10: parity: WA staff see the 24 rows on WA items, not the row on the WB item; visible rows = rows of visible movements');
set local "request.jwt.claim.sub" to :u_vwr;
set local role to 'authenticated';
insert into vis select 'vwr', 'mv', m.id::text from public.stock_movements m where m.organization_id in (:orgS, :orgF);
insert into vis select 'vwr', 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.organization_id in (:orgS, :orgF);
reset role;
select is(
  (select count(*) from vis where persona = 'vwr' and kind = 'h')::text || '|' ||
  (not exists (select v.key from vis v where v.persona = 'vwr' and v.kind = 'h'
               except
               select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                 join vis x on x.persona = 'vwr' and x.kind = 'mv' and x.key = h.movement_id::text)
   and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                     join vis x on x.persona = 'vwr' and x.kind = 'mv' and x.key = h.movement_id::text
                   except
                   select v.key from vis v where v.persona = 'vwr' and v.kind = 'h'))::text,
  '1|true',
  'F11: parity: the WB viewer sees only the row on the WB item; visible rows = rows of visible movements');
set local "request.jwt.claim.sub" to :u_aud;
set local role to 'authenticated';
insert into vis select 'aud', 'mv', m.id::text from public.stock_movements m where m.organization_id in (:orgS, :orgF);
insert into vis select 'aud', 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.organization_id in (:orgS, :orgF);
reset role;
select is(
  (select count(*) from vis where persona = 'aud' and kind = 'h')::text || '|' ||
  (not exists (select v.key from vis v where v.persona = 'aud' and v.kind = 'h'
               except
               select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                 join vis x on x.persona = 'aud' and x.kind = 'mv' and x.key = h.movement_id::text)
   and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                     join vis x on x.persona = 'aud' and x.kind = 'mv' and x.key = h.movement_id::text
                   except
                   select v.key from vis v where v.persona = 'aud' and v.kind = 'h'))::text,
  '25|true',
  'F12: parity: a viewer holding activity_logs:read (no warehouse) sees every row; visible rows = rows of visible movements');
set local "request.jwt.claim.sub" to :u_out;
set local role to 'authenticated';
insert into vis select 'out', 'mv', m.id::text from public.stock_movements m where m.organization_id in (:orgS, :orgF);
insert into vis select 'out', 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h where h.organization_id in (:orgS, :orgF);
reset role;
select is(
  (select count(*) from vis where persona = 'out' and kind = 'h')::text || '|' ||
  (not exists (select v.key from vis v where v.persona = 'out' and v.kind = 'h'
               except
               select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                 join vis x on x.persona = 'out' and x.kind = 'mv' and x.key = h.movement_id::text)
   and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                     join vis x on x.persona = 'out' and x.kind = 'mv' and x.key = h.movement_id::text
                   except
                   select v.key from vis v where v.persona = 'out' and v.kind = 'h'))::text,
  '0|true',
  'F13: parity: an outsider sees nothing; visible rows = rows of visible movements');
select is((select count(*)::int from vis where persona = 'stf' and kind = 'wb'), 3,
  'F14: WA staff see the three rows on WA items that name a WB location (two draws from the WB rack, the scrap from WB Staging)');

set local role to 'anon';
select throws_ok($$select count(*) from public.stock_movement_holdings$$,
  '42501', null, 'F15: anon cannot read the table at all');
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- R (continued). The reachable path: WA staff through public.adjust_stock,
-- the phone and API shape. After F so the parity counts above are untouched.
-- itX holds A1=1, S=1, SA=4, SB=3 (on hand 9) here.
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -0.00001, 'remove', null, 'R tiny minus', null, 'any')$$, :itX),
  'R10: WA staff removes 0.00001 in mode any (was 23514 at the recorder''s CHECK)');
select lives_ok(format($$select public.adjust_stock(%L, 0.00004, 'adjust', null, 'R tiny plus', null)$$, :itX),
  'R11: WA staff adds 0.00004 with no location (was 23514)');
select lives_ok(format($$select public.adjust_stock(%L, -1.00001, 'remove', null, 'R spill', null)$$, :itX),
  'R12: WA staff removes 1.00001: A1 empties, the remainder spills onto the Site (was 23514)');
select lives_ok(format($$select public.adjust_stock(%L, -0.00005, 'remove', null, 'R half', null, 'any')$$, :itX),
  'R13: WA staff removes an exact half (0.00005)');
reset role;
select is(
  (select string_agg(m.reason || ':' || m.quantity_change::text || ':' || (m.new_quantity - m.previous_quantity)::text
                     || '[' || pg_temp.rows4(m.id) || ']', ' ' order by m.reason collate "C")
     from public.stock_movements m where m.item_id = :itX and m.reason like 'R %')
  || ' | ' || pg_temp.snap4(:itX) || ' | ' || pg_temp.fk_ok(),
  'R half:-0.0001:0.0000[] R spill:-1.0000:-1.0000[1:A1:-1.0000:placed] R tiny minus:0.0000:0.0000[] R tiny plus:0.0000:0.0000[] | A1=0.0000,A2=0.0000,B1=0.0000,S=1.0000,SA=4.0000,SB=3.0000,UA=0.0000 | fk ok',
  'R14: the four movements exist as before 0373; only the spill records a row (A1 -1); the Site, touched by 0.00001 and 0.00005, never moved; the deferred FK holds');
select is(
  (select count(*)::int || '|' || bool_and(x.q = x.d)::text
     from (select m.id, m.new_quantity - m.previous_quantity as d,
                  (select sum(h.quantity) from public.stock_movement_holdings h where h.movement_id = m.id) as q
             from public.stock_movements m
            where m.organization_id = :orgS
              and exists (select 1 from public.stock_movement_holdings h where h.movement_id = m.id)) x),
  '19|true',
  'R15: every movement with provenance rows in this file: the rows sum EXACTLY to its new_quantity - previous_quantity');

-- ══════════════════════════════════════════════════════════════════════════
-- S. SCOPE ONCE PER CALL (perf review, 2026-09-25). The recorder decides
-- service / manager once for the whole call and, below manager, asks
-- caller_can_write_location once per distinct (organization, warehouse) of
-- the call's locations instead of once per row. S1 pins the function whose
-- inputs make that safe; S2-S7 prove every persona's values equal the
-- per-row formula (and literal values), with the call counts; S8-S9 count
-- the calls on a real six-holding staff draw.
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || p.provolatile::text from pg_proc p where p.oid = 'public.caller_can_write_location(uuid)'::regprocedure),
  '188634bf8552a0064bfbf1ebfecf814f|s',
  'S1: caller_can_write_location is the text and volatility the recorder''s per-(organization, warehouse) evaluation was proven against: it reads the location only for organization_id and warehouse_id, and STABLE runs it in the INSERT''s snapshot. The migration''s preflight refuses the same drift at push time. If this fails, re-prove ledger._record_holdings before updating both pins');

-- An org-level location of the FOREIGN org: (orgF, NULL) must never share an
-- answer with the home org's Site (orgS, NULL).
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
values ('03730000-0000-0000-0000-0000000000e8', :orgF, null, 'FS 0373', 'warehouse', null);
insert into lbl values ('03730000-0000-0000-0000-0000000000e8', 'FS');
set local track_functions = 'pl';

-- The recorder called directly (as its owner, like the engine) for one
-- persona, in a subtransaction that is always rolled back. Reports
--   <tag:actor_scope per row, in seq order>#per_row=<every row equals the
--   old per-row formula>#calls=<caller_can_write_location calls it made>
create function pg_temp.ccwl_calls() returns bigint language sql stable as $f$
  select coalesce(pg_stat_get_xact_function_calls('public.caller_can_write_location(uuid)'::regprocedure), 0);
$f$;
create function pg_temp.scope_probe(p_sub text, p_locs uuid[]) returns text
language plpgsql as $f$
declare
  v_mv    uuid := gen_random_uuid();
  v_calls bigint;
  v_rows  text;
  v_same  boolean;
begin
  begin
    perform set_config('request.jwt.claim.sub', p_sub, true);
    v_calls := pg_temp.ccwl_calls();
    perform ledger._record_holdings(v_mv, '03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-0000000000c1',
      '03730000-0000-0000-0000-0000000000b1', p_locs, array_fill(-1::numeric, array[cardinality(p_locs)]),
      array_fill('placed'::text, array[cardinality(p_locs)]), 'placed');
    v_calls := pg_temp.ccwl_calls() - v_calls;
    select string_agg(pg_temp.tag(h.location_id) || ':' || h.actor_scope, ',' order by h.seq),
           bool_and(h.actor_scope = case when auth.uid() is null then 'service'
                                         when public.has_org_role(h.organization_id, 'manager') then 'manager'
                                         when public.caller_can_write_location(h.location_id) then 'in_scope'
                                         else 'out_of_scope' end)
      into v_rows, v_same
      from public.stock_movement_holdings h where h.movement_id = v_mv;
    raise exception using errcode = 'ZX376', message = v_rows || '#per_row=' || v_same::text || '#calls=' || v_calls;
  exception
    when sqlstate 'ZX376' then return sqlerrm;
    when others then return 'err|' || sqlstate || '|' || sqlerrm;
  end;
end $f$;

-- Eight locations, six (organization, warehouse) pairs: WA x3 (rack, Unplaced,
-- Staging), the home Site, the WB rack, the foreign rack, the foreign
-- org-level location, and a NULL location.
create temp table s_locs as
select array[:locA1::uuid,
             (select id from public.locations where warehouse_id = :whA and kind = 'unplaced'),
             (select id from public.locations where warehouse_id = :whA and kind = 'staging'),
             :locS::uuid, :locB1::uuid, :locF::uuid,
             '03730000-0000-0000-0000-0000000000e8'::uuid, null::uuid] as locs;

select is(pg_temp.scope_probe('', (select locs from s_locs)),
  'A1:service,UA:service,SA:service,S:service,B1:service,F1:service,FS:service,null:service#per_row=true#calls=0',
  'S2: service (no jwt subject): one answer for the call, no caller_can_write_location call');
select is(pg_temp.scope_probe(:u_adm, (select locs from s_locs)),
  'A1:manager,UA:manager,SA:manager,S:manager,B1:manager,F1:manager,FS:manager,null:manager#per_row=true#calls=0',
  'S3: an admin (manager or above): one answer for the call, no caller_can_write_location call');
select is(pg_temp.scope_probe(:u_mgr, (select locs from s_locs)),
  'A1:manager,UA:manager,SA:manager,S:manager,B1:manager,F1:manager,FS:manager,null:manager#per_row=true#calls=0',
  'S4: a manager: one answer for the call, no caller_can_write_location call');
select is(pg_temp.scope_probe(:u_stf, (select locs from s_locs)),
  'A1:in_scope,UA:in_scope,SA:in_scope,S:in_scope,B1:out_of_scope,F1:out_of_scope,FS:out_of_scope,null:out_of_scope#per_row=true#calls=6',
  'S5: WA staff: WA and the home Site in scope; WB, the foreign org (rack AND org-level) and NULL out; six calls for eight rows (one per pair)');
select is(pg_temp.scope_probe(:u_vwr, (select locs from s_locs)),
  'A1:out_of_scope,UA:out_of_scope,SA:out_of_scope,S:in_scope,B1:out_of_scope,F1:out_of_scope,FS:out_of_scope,null:out_of_scope#per_row=true#calls=6',
  'S6: the WB viewer (below the write floor): only the home org-level Site in scope, as caller_can_write_location answers per row');
select is(pg_temp.scope_probe(:u_out, (select locs from s_locs)),
  'A1:out_of_scope,UA:out_of_scope,SA:out_of_scope,S:out_of_scope,B1:out_of_scope,F1:in_scope,FS:in_scope,null:out_of_scope#per_row=true#calls=6',
  'S7: the foreign manager (not a manager of the item''s org): only the foreign rack and the foreign org-level location in scope; (orgS, NULL) and (orgF, NULL) answer differently');

-- A real staff draw through the engine: six holdings, three pairs.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values ('03730000-0000-0000-0000-0000000000cb', :orgS, :whA, 'PV-0373-S', 'Scope Item 0373', 6, 'active', 'none');
delete from public.item_stock_levels where item_id = '03730000-0000-0000-0000-0000000000cb';
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :orgS, '03730000-0000-0000-0000-0000000000cb', x.loc, 1
  from unnest(array[:locA1::uuid, :locP1::uuid, :locP2::uuid, :locS::uuid, :locB1::uuid,
                    (select id from public.locations where warehouse_id = :whA and kind = 'unplaced')]) x(loc);
create temp table s_calls as select pg_temp.ccwl_calls() as before;
set local "request.jwt.claim.sub" to :u_stf;
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
select is(
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, '03730000-0000-0000-0000-0000000000cb', -6, 'placed')$$, :mvC),
                         '03730000-0000-0000-0000-0000000000cb', :mvC), '#', 2),
  '1:A1:-1:placed:in_scope,2:P1:-1:placed:in_scope,3:P2:-1:placed:in_scope,4:S:-1:placed:in_scope,5:B1:-1:placed:out_of_scope,6:UA:-1:placed:in_scope',
  'S8: a WA staff engine draw over six holdings (four in WA, the home Site, the WB rack): WA and the Site in scope, the WB rack out, in draw order');
select set_config('stockpilot.ledger', '', true);
set local "request.jwt.claim.sub" to '';
select is(pg_temp.ccwl_calls() - (select before from s_calls), 3::bigint,
  'S9: that draw asked caller_can_write_location three times (WA, the Site''s org level, WB), not six');

-- ONE-LOCATION CALLS (review, 2026-09-25). Every increment and most adjusts
-- pass one location; the recorder asks caller_can_write_location of it
-- directly, inside the insert, and never runs the pair CTE (which cost 7 us
-- more than the per-row call there). Each of the eight locations above as
-- its own call, per persona: <tag:scope, in call order>#per_row=<every row
-- equals the old per-row formula>#calls=<total caller_can_write_location calls>.
create function pg_temp.one_probe(p_sub text) returns text language sql as $f$
  select string_agg(split_part(y.r, '#', 1), ',' order by y.o)
         || '#per_row=' || bool_and(split_part(y.r, '#', 2) = 'per_row=true')::text
         || '#calls=' || sum(split_part(split_part(y.r, '#', 3), '=', 2)::int)
    from (select x.o, pg_temp.scope_probe(p_sub, array[x.loc]) as r
            from unnest((select locs from s_locs)) with ordinality as x(loc, o)) y;
$f$;

select is(pg_temp.one_probe('') || ' | ' || pg_temp.one_probe(:u_adm) || ' | ' || pg_temp.one_probe(:u_mgr),
  'A1:service,UA:service,SA:service,S:service,B1:service,F1:service,FS:service,null:service#per_row=true#calls=0'
  || ' | A1:manager,UA:manager,SA:manager,S:manager,B1:manager,F1:manager,FS:manager,null:manager#per_row=true#calls=0'
  || ' | A1:manager,UA:manager,SA:manager,S:manager,B1:manager,F1:manager,FS:manager,null:manager#per_row=true#calls=0',
  'S10: one-location calls as service, an admin and a manager: one answer each, no caller_can_write_location call');
select is(pg_temp.one_probe(:u_stf),
  'A1:in_scope,UA:in_scope,SA:in_scope,S:in_scope,B1:out_of_scope,F1:out_of_scope,FS:out_of_scope,null:out_of_scope#per_row=true#calls=8',
  'S11: one-location calls as WA staff: the per-row answer for each location, one call per call');
select is(pg_temp.one_probe(:u_vwr) || ' | ' || pg_temp.one_probe(:u_out),
  'A1:out_of_scope,UA:out_of_scope,SA:out_of_scope,S:in_scope,B1:out_of_scope,F1:out_of_scope,FS:out_of_scope,null:out_of_scope#per_row=true#calls=8'
  || ' | A1:out_of_scope,UA:out_of_scope,SA:out_of_scope,S:out_of_scope,B1:out_of_scope,F1:in_scope,FS:in_scope,null:out_of_scope#per_row=true#calls=8',
  'S12: one-location calls as the WB viewer and the foreign manager: the per-row answer for each location, one call per call');

-- The pair CTE does not run on a one-location call: a staff call reads
-- public.locations exactly one caller_can_write_location's worth more than a
-- manager's (which never asks), where the CTE's join would add another read.
-- Seven calls each, across the plan cache's custom-to-generic switch. Reports
-- <location>:extra=<distinct staff-minus-manager reads>,direct=<distinct reads
-- of one direct caller_can_write_location call>.
create function pg_temp.loc_reads() returns bigint language sql stable as $f$
  select coalesce(t.seq_scan, 0) + coalesce(t.idx_scan, 0)
    from pg_stat_xact_user_tables t where t.relid = 'public.locations'::regclass;
$f$;
create function pg_temp.reads_probe(p_sub text, p_loc uuid, p_direct boolean) returns bigint
language plpgsql as $f$
declare
  v bigint;
begin
  begin
    perform set_config('request.jwt.claim.sub', p_sub, true);
    v := pg_temp.loc_reads();
    if p_direct then
      perform public.caller_can_write_location(p_loc);
    else
      perform ledger._record_holdings(gen_random_uuid(), '03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-0000000000c1',
        '03730000-0000-0000-0000-0000000000b1', array[p_loc], array[-1::numeric], array['placed'], 'placed');
    end if;
    v := pg_temp.loc_reads() - v;
    raise exception using errcode = 'ZX377', message = v::text;
  exception
    when sqlstate 'ZX377' then return sqlerrm::bigint;
  end;
end $f$;
select is(
  (select string_agg(z.tag || ':extra=' || z.extra || ',direct=' || z.direct, ' ' order by z.tag)
     from (select v.tag,
                  string_agg(distinct (pg_temp.reads_probe(:u_stf, v.loc, false) - pg_temp.reads_probe(:u_mgr, v.loc, false))::text, ';') as extra,
                  string_agg(distinct pg_temp.reads_probe(:u_stf, v.loc, true)::text, ';') as direct
             from (values (:locA1::uuid, 'A1'), (:locB1::uuid, 'B1')) v(loc, tag), generate_series(1, 7) g
            group by v.tag) z),
  'A1:extra=1,direct=1 B1:extra=1,direct=1',
  'S13: a one-location staff call never runs the pair CTE: it reads locations one caller_can_write_location more than a manager''s call, in and out of scope, custom and generic plans');

-- Real engine calls as WA staff: a +1 (always one location, WA Staging) and a
-- one-holding draw from the WB rack.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values ('03730000-0000-0000-0000-0000000000cc', :orgS, :whA, 'PV-0373-O', 'One Holding Item 0373', 2, 'active', 'none');
delete from public.item_stock_levels where item_id = '03730000-0000-0000-0000-0000000000cc';
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
values (:orgS, '03730000-0000-0000-0000-0000000000cc', :locB1, 2);
update s_calls set before = pg_temp.ccwl_calls();
set local "request.jwt.claim.sub" to :u_stf;
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
select is(
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, '03730000-0000-0000-0000-0000000000cc', 1, 'placed')$$, '03730000-0000-0000-0000-00000000f0a1'),
                         '03730000-0000-0000-0000-0000000000cc', '03730000-0000-0000-0000-00000000f0a1'), '#', 2)
  || ' | ' ||
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, '03730000-0000-0000-0000-0000000000cc', -1, 'placed')$$, '03730000-0000-0000-0000-00000000f0a2'),
                         '03730000-0000-0000-0000-0000000000cc', '03730000-0000-0000-0000-00000000f0a2'), '#', 2),
  '1:SA:1:increment:in_scope | 1:B1:-1:placed:out_of_scope',
  'S14: a WA staff +1 lands in WA Staging (in scope) and a one-holding -1 takes from the WB rack (out of scope)');
select set_config('stockpilot.ledger', '', true);
set local "request.jwt.claim.sub" to '';
select is(pg_temp.ccwl_calls() - (select before from s_calls), 2::bigint,
  'S15: those two engine calls asked caller_can_write_location once each');

select * from finish();
rollback;
