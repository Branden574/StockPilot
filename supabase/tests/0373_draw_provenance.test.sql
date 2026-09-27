-- supabase/tests/0373_draw_provenance.test.sql
-- Proves migration 0373: every null-location draw and increment reached
-- through ledger.adjust_stock, distribute_bundle, assemble_bundle and
-- process_return_disposition carries exactly which holdings it touched on
-- its OWN stock_movements row (stock_movements.draw), and every draw still
-- moves holdings byte-for-byte as before.
--
--   A. STRUCTURE: the two types, the nullable column (no index, no
--      constraint, no inbound key), the security_invoker view and its
--      grants, the stamp trigger's column list, the engine, _seal (INVOKER,
--      no SET, closed), the five forget triggers, the wrapper, the
--      stock_movements policies the view inherits, and the first build's
--      objects gone.
--   P. TEXT PROOFS: the engine is the 0359 apply_level_delta prosrc plus
--      exactly eleven tagged lines; each restated caller is its pre-0373
--      prosrc minus its apply_level_delta lines plus tagged lines of the
--      allowed shapes; kind, config, signature, ACL, owner and comment of the
--      four callers are unchanged; the three draw-loop queries plan the same
--      with and without the added SELECT columns (custom and generic).
--   B. DIFFERENTIAL ORACLE: pg_temp.ald_0359 is the 0359 body verbatim (md5
--      proven). The engine and the wrapper run on the same fixture in
--      rolled-back subtransactions; holdings and SQLSTATE + message must be
--      identical in every mode and shape. record = false returns no draw.
--   C. PROVENANCE TRUTH: per successful engine run, the returned holdings
--      summed by location equal the holdings difference (an independent
--      oracle), the total equals the quantity, seq follows the draw order,
--      steps and draw-time facts are right, and the scope is service /
--      manager / in_scope / out_of_scope.
--   R. SUB-PRECISION QUANTITIES: a share with more than four decimals is
--      recorded as its numeric(14,4) holding moved, and one that rounds to
--      zero is not recorded; rows sum exactly to the holdings difference.
--   D. PER CALLER, as real personas: the phone adjust, the web 'any'
--      removal, a +1, explicit adjust and transfer (no draw), complete_picking
--      with a duplicate line, the cancel restock, reverse_receipt, assemble
--      and distribute (with shortage rows), return restock + scrap (no draw
--      crosses legs), and the pinned post_cycle_count gap (no draw).
--   E. FAILURE AND INTEGRITY: insufficient_placed_stock records nothing; no
--      draw sits on a row the ledger did not write; zero and NULL return no
--      draw; a zero adjust writes no draw; a rolled-back savepoint leaves
--      nothing.
--   F. SECURITY: only a ledger transaction inserts a draw (authenticated,
--      service_role and the owner alike; a forged all-NULL draw too); no role
--      changes a draw afterwards; the engine's and the wrapper's gates; view
--      read parity for every persona (visible rows = rows of visible
--      movements, literal counts), and the same reach straight from the
--      column; anon reads nothing.
--   S. THE SCOPE CACHE: the four restated predicates are pinned; the
--      restatement equals the live has_org_role / caller_can_write_location
--      for twelve signed-in personas plus service over nine locations (by
--      pair and by location); each answer is asked once per transaction;
--      the transaction's own membership, assignment, profile, warehouse and
--      location changes clear it (per table and event); another drawer or
--      organization recomputes; a value bound to another transaction,
--      drawer or organization is ignored; a savepoint rollback discards
--      answers; the non-recording wrapper never touches the cache.
--
-- The push-time lock order needs two sessions:
-- scripts/db-concurrency/0373_push_lock_order.sh. That the cache never
-- outlives its transaction needs COMMIT: the lean commit check
-- (stockpilot-work/provenance/lean/commit_check_lean.sh).
--
-- Closed EXECUTE is asserted from the catalog (A), not by a permission-denied
-- call: images before 17.6.1.155 crash on a permission-denied function call
-- under supautils hint_roles, and CI's image is whatever the CLI pins.
--
-- HOW THE ROLES ARE SIMULATED (house convention): `set local role
-- authenticated` + request.jwt.claim.sub where RLS matters; the jwt claim
-- alone (plus the ledger flag raised by hand) for direct engine calls.
--
-- MUTATION RECORD: (live, 2026-09-26, lean build). Each mutant is one edit of the
-- migration's own text, applied after reverting 0373 inside a rolled-back
-- transaction; then this file and security_invariants run against it (plus
-- 0359 and 0367 for K2). 'post' = the migration's own post-check already
-- refuses it at push time (55000); the tests listed are the ones that fail
-- with that post-check removed. The unedited control ran green; every mutant
-- below was killed.
--  C1     cache key without the transaction id
--         -> S11
--  C2     cache key without the drawer
--         -> D18, D21, D23, D27, F11, S9, S11
--  C3     cache key without the organization
--         -> S10, S11
--  C5     cache never read (every draw asks again)
--         -> S5, S6, S11
--  C6     pair answers never cached
--         -> S5, S6, S12
--  C7     pair key drops the warehouse
--         -> C8, D5, D8, S3, S4, S5, S6
--  C8     pair key drops the organization
--         -> S3, S4
--  C9     in_scope and out_of_scope swapped
--         -> C8, D4, D5, D8, D14, D16, S3, S4, S6 ...
--  C10    manager answer never given (head always S)
--         -> C7, D18, D21, D23, D27, F11, S2, S5, S7 ...
--  C11    mirror: impersonation filter removed from the location org membership
--         -> S3, S4
--  C12    mirror: impersonation filter added to the warehouse org role check
--         -> S3
--  C13    mirror: disabled_at ignored in the location org membership
--         -> S4
--  C14    mirror: disabled_at ignored in the manager answer
--         -> S4
--  C15    mirror: role checked in the LOCATION's organization, not the warehouse's
--         -> S3
--  C16    mirror: a viewer counts as a writer
--         -> S4
--  C17    mirror: staff assignment to ANY warehouse counts
--         -> C8, D5, D8, S3, S6
--  C18    mirror: an increment's Staging location read without its warehouse
--         -> S3, S4
--  C19    mirror: accepted_at ignored in the manager answer
--         -> S4
--  T1     stamp: IS NOT NULL instead of num_nonnulls (the composite trap)
--         -> F4
--  T2     stamp: a draw may be inserted by any non-API role outside the ledger
--         -> F2, F3, F4, F16, F17, F19, F20, R15
--  T3     stamp: the draw immutable only for API roles
--         -> F6, F7, F8, F11, F16, F17, F19, F20, R15
--  T4     stamp: trigger not fired on UPDATE OF draw
--         -> A10, F6, F7, F8, F11, F16, F17, F19, F20 ...
--  F-organization_members forget trigger missing on organization_members
--         -> A15, S7, S8
--  F-user_warehouse_assignments forget trigger missing on user_warehouse_assignments
--         -> A15, S7, S8
--  F-user_profiles forget trigger missing on user_profiles
--         -> A15, S8
--  F-warehouses forget trigger missing on warehouses
--         -> A15, S8
--  F-locations forget trigger missing on locations
--         -> A15, S8
--  F-up-cols forget trigger on user_profiles misses disabled_at
--         -> A15, S8
--  F-loc-cols forget trigger on locations misses warehouse_id
--         -> A15, S8
--  E1     engine: the placed append dropped
--         -> P2, C1, C2, C3, C6, C7, C8, R3, R5 ...
--  E2     engine: the holding's quantity recorded instead of the take (placed)
--         -> P2, C2, R1, R3, R4, R5, D4, D5, D14 ...
--  E3     engine: the placed loop's warehouse fact read from the organization column
--         -> P2, C1, C2, C3, C6, C8, D4, D5, D8 ...
--  E4     engine: the increment not recorded
--         -> P2, C4, C5, R6, D8, D16, D21, D23, E3 ...
--  E5     engine: the final seal dropped
--         -> P2, C1, C2, C3, C6, C7, C8, R3, R5 ...
--  E6     engine: round half away from zero (placed), not as the holding moved
--         -> P2, R4, R14, R15
--  E7     engine: shares that round to zero kept (placed)
--         -> P2, R1, R3, R4, R14, R15
--  E8     engine: the 'any' tail recorded as staging_first
--         -> P2, C3, R8, D8
--  E9     engine draw order: Unplaced FIRST instead of last
--         -> post, P1, B1, B2, B9, B10, B17, B18, B19 ...
--  E10    engine SECURITY INVOKER
--         -> A11, D5, D6, D8, D12, E1, E2, E3, E7 ...
--  K1     the wrapper passes record = true
--         -> post, P6, INV-38
--  K2     adjust_stock records auth.uid() instead of v_user
--         -> post, P3, P5, INV-38
--  K3     adjust_stock records no drawer (service)
--         -> post, P3, P5, D4, D5, D8, D14, D16, D18 ...
--  K4     return: the restock's draw written into the scrap row
--         -> post, P3, P5, P6, D23, F22, R15, INV-38
--  K5     distribute: the component row written without its draw
--         -> post, P4, D21, F16, F17, F18, F20, R15, INV-38
--  K6     view without security_invoker
--         -> A5, F18, F19, F21, INV-8
--  K7     view insertable by authenticated
--         -> A7, INV-38
--  K9b    _seal granted to authenticated
--         -> A13
--  K10b   the forget function granted to authenticated
--         -> A16
--   Survivors, each equivalent by construction:
--   K8     view: coalesce((m.draw).actor_scope, h.actor_scope): exactly one of
--          the two is ever set (service/manager on the draw, in/out on the
--          holding), so the order cannot matter.
--   K9/K10 _seal / the forget function revoked from public and anon only:
--          the ledger schema has no default EXECUTE grant for authenticated
--          (pg_default_acl covers public, storage, graphql* only), so the
--          revoke is redundant belt; the explicit grants K9b/K10b are killed.
--   Killed outside pgTAP (they need a COMMIT, two sessions or the push):
--   C4     _seal writes the cache session-wide (set_config(..., false)):
--          the lean commit check (2b) fails.
--   M-md5 / M-vol / M-unique / M-trigger: each preflight check removed lets its
--          planted drift apply (the lean drift check); the grant check's mutant
--          is still refused by the post-check (a second defence).
--   The push lock prelude's three mutants: scripts/db-concurrency/
--          0373_push_lock_order.sh (40P01 in the scenarios listed there).
--
-- Namespace: 03730000. Wrapped in begin/rollback; nothing leaks.

begin;

select plan(159);

\set orgS    '\'03730000-0000-0000-0000-000000000001\''
\set orgF    '\'03730000-0000-0000-0000-000000000002\''
\set u_adm   '\'03730000-0000-0000-0000-0000000000a1\''
\set u_mgr   '\'03730000-0000-0000-0000-0000000000a2\''
\set u_stf   '\'03730000-0000-0000-0000-0000000000a3\''
\set u_vwr   '\'03730000-0000-0000-0000-0000000000a4\''
\set u_aud   '\'03730000-0000-0000-0000-0000000000a5\''
\set u_out   '\'03730000-0000-0000-0000-0000000000a6\''
\set u_stn   '\'03730000-0000-0000-0000-0000000000a7\''
\set u_dis   '\'03730000-0000-0000-0000-0000000000a8\''
\set u_exp   '\'03730000-0000-0000-0000-0000000000a9\''
\set u_imp   '\'03730000-0000-0000-0000-0000000000aa\''
\set u_pnd   '\'03730000-0000-0000-0000-0000000000ab\''
\set u_two   '\'03730000-0000-0000-0000-0000000000ac\''
\set u_tx    '\'03730000-0000-0000-0000-0000000000ad\''
\set u_dsm   '\'03730000-0000-0000-0000-0000000000ae\''
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
\set itQ     '\'03730000-0000-0000-0000-0000000000cd\''
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
\set locFS   '\'03730000-0000-0000-0000-0000000000e8\''
\set locX1   '\'03730000-0000-0000-0000-0000000000e9\''

-- ── Fixtures (superuser, no jwt subject: RLS bypassed, service path) ─────────

insert into auth.users (id, email, raw_user_meta_data) values
  (:u_adm, 'admin-0373@test.local',    '{}'::jsonb),
  (:u_mgr, 'mgr-0373@test.local',      '{}'::jsonb),
  (:u_stf, 'staff-0373@test.local',    '{}'::jsonb),
  (:u_vwr, 'viewer-0373@test.local',   '{}'::jsonb),
  (:u_aud, 'auditor-0373@test.local',  '{}'::jsonb),
  (:u_out, 'outsider-0373@test.local', '{}'::jsonb),
  (:u_stn, 'staff-nowh-0373@test.local', '{}'::jsonb),
  (:u_dis, 'disabled-0373@test.local', '{}'::jsonb),
  (:u_exp, 'expired-0373@test.local', '{}'::jsonb),
  (:u_imp, 'impersonating-0373@test.local', '{}'::jsonb),
  (:u_pnd, 'pending-0373@test.local', '{}'::jsonb),
  (:u_two, 'two-org-0373@test.local', '{}'::jsonb),
  (:u_tx,  'two-org-expired-0373@test.local', '{}'::jsonb),
  (:u_dsm, 'disabled-manager-0373@test.local', '{}'::jsonb)
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
-- Scope-mirror personas (S): staff with no warehouse; WA staff who is
-- disabled; a manager who is disabled; managers whose impersonation expired / is live / who never
-- accepted; a manager of the foreign org who is WA staff at home (two-org);
-- and WA staff at home whose foreign manager membership has expired.
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgS, :u_stn, 'staff',   now(), null),
  (:orgS, :u_dis, 'staff',   now(), null),
  (:orgS, :u_exp, 'manager', now(), now() - interval '1 hour'),
  (:orgS, :u_imp, 'manager', now(), now() + interval '1 hour'),
  (:orgS, :u_pnd, 'manager', null,  null),
  (:orgF, :u_two, 'manager', now(), null),
  (:orgS, :u_two, 'staff',   now(), null),
  (:orgS, :u_tx,  'staff',   now(), null),
  (:orgF, :u_tx,  'manager', now(), now() - interval '1 hour'),
  (:orgS, :u_dsm, 'manager', now(), null)
on conflict do nothing;
update public.user_profiles set disabled_at = now() where id in (:u_dis, :u_dsm);

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
  (:orgS, :u_vwr, :whB),
  (:orgS, :u_dis, :whA),
  (:orgS, :u_two, :whA),
  (:orgS, :u_tx,  :whA)
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

-- A draw's holdings as seq:location:quantity:step:actor_scope, in seq order
-- (the view's coalesce of the holding's and the draw's scope).
create function pg_temp.drows(p_d public.stock_draw) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || h.quantity::int || ':' || h.step
                             || ':' || coalesce(h.actor_scope, (p_d).actor_scope, 'NULL'), ',' order by h.seq), '')
    from unnest((p_d).holdings) with ordinality
         as h(location_id, quantity, step, location_kind, location_warehouse_id, actor_scope, seq);
$f$;

-- A movement's rows through the read helper, same format.
create function pg_temp.rows(p_mv uuid) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || h.quantity::int
                             || ':' || h.step || ':' || h.actor_scope, ',' order by h.seq), '')
    from public.stock_movement_holdings h where h.movement_id = p_mv;
$f$;

-- The one movement of an item with this reason (D group).
create function pg_temp.mv(p_item uuid, p_reason text) returns uuid language sql stable as $f$
  select m.id from public.stock_movements m where m.item_id = p_item and m.reason = p_reason;
$f$;

-- The draw a call returns (the call yields text: a stock_draw, or '' for
-- void), in a subtransaction that is ALWAYS rolled back. Errors propagate.
create function pg_temp.draw_of(p_call text) returns public.stock_draw language plpgsql as $f$
declare
  v text;
begin
  begin
    execute p_call into v;
    raise exception using errcode = 'ZX373';
  exception
    when sqlstate 'ZX373' then null;
  end;
  return nullif(v, '')::public.stock_draw;
end $f$;

-- Runs one call (yielding text as above) in a subtransaction that is ALWAYS
-- rolled back, and reports:
--   ok|<holdings after>#<the returned draw's rows>#diff=<holdings difference by
--     location>#oracle=<diff equals the draw summed by location>
--     #total=<sum of recorded quantities>#facts=<draw-time facts match>
--     #n=<holdings recorded>
-- or err|<sqlstate>|<message>.
create function pg_temp.run(p_call text, p_item uuid) returns text
language plpgsql as $f$
declare
  v_before jsonb;
  v_after  jsonb;
  v_txt    text;
  v_d      public.stock_draw;
  v_diff   text;
  v_rec    text;
  v_total  numeric;
  v_facts  boolean;
begin
  select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_before
    from public.item_stock_levels s where s.item_id = p_item;
  begin
    execute p_call into v_txt;
    v_d := nullif(v_txt, '')::public.stock_draw;
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
      from (select h.location_id, sum(h.quantity) as q from unnest((v_d).holdings) h group by h.location_id) y;
    select coalesce(sum(h.quantity), 0) into v_total from unnest((v_d).holdings) h;
    select coalesce(bool_and(h.location_kind is not distinct from l.kind
                             and h.location_warehouse_id is not distinct from l.warehouse_id), true)
           and (num_nonnulls(v_d) = 0
                or (v_d).item_warehouse_id is not distinct from (select i.warehouse_id from public.inventory_items i where i.id = p_item))
      into v_facts
      from unnest((v_d).holdings) h
      left join public.locations l on l.id = h.location_id;
    raise exception using errcode = 'ZX373', message =
      'ok|' || pg_temp.snap(p_item) || '#' || pg_temp.drows(v_d) || '#diff=' || v_diff
      || '#oracle=' || (v_diff = v_rec)::text || '#total=' || v_total::int
      || '#facts=' || v_facts::text || '#n=' || coalesce(cardinality((v_d).holdings), 0);
  exception
    when sqlstate 'ZX373' then return sqlerrm;
    when others then return 'err|' || sqlstate || '|' || sqlerrm;
  end;
end $f$;

-- Exact (four-decimal) twins for the R group: run4 reports
--   ok|<holdings after, exact>#<the draw's rows, exact>
--     #oracle=<per location, the holdings difference equals the draw EXACTLY>
-- or err|<sqlstate>|<message>, in a subtransaction that is always rolled back.
create function pg_temp.snap4(p_item uuid) returns text language sql stable as $f$
  select coalesce(string_agg(pg_temp.tag(s.location_id) || '=' || s.quantity::text, ','
                             order by pg_temp.tag(s.location_id) collate "C"), '')
    from public.item_stock_levels s where s.item_id = p_item;
$f$;
create function pg_temp.drows4(p_d public.stock_draw) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || h.quantity::text || ':' || h.step,
                             ',' order by h.seq), '')
    from unnest((p_d).holdings) with ordinality
         as h(location_id, quantity, step, location_kind, location_warehouse_id, actor_scope, seq);
$f$;
create function pg_temp.rows4(p_mv uuid) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || h.quantity::text
                             || ':' || h.step, ',' order by h.seq), '')
    from public.stock_movement_holdings h where h.movement_id = p_mv;
$f$;
create function pg_temp.run4(p_call text, p_item uuid) returns text
language plpgsql as $f$
declare
  v_before jsonb;
  v_after  jsonb;
  v_txt    text;
  v_d      public.stock_draw;
  v_oracle boolean;
begin
  select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_before
    from public.item_stock_levels s where s.item_id = p_item;
  begin
    execute p_call into v_txt;
    v_d := nullif(v_txt, '')::public.stock_draw;
    select coalesce(jsonb_object_agg(s.location_id::text, s.quantity), '{}'::jsonb) into v_after
      from public.item_stock_levels s where s.item_id = p_item;
    select coalesce(bool_and(coalesce(d.d, 0) = coalesce(r.q, 0)), true) into v_oracle
      from (select k.k::uuid as loc,
                   coalesce((v_after ->> k.k)::numeric, 0) - coalesce((v_before ->> k.k)::numeric, 0) as d
              from jsonb_object_keys(v_before || v_after) as k(k)) d
      full join (select h.location_id as loc, sum(h.quantity) as q
                   from unnest((v_d).holdings) h group by h.location_id) r on r.loc = d.loc;
    raise exception using errcode = 'ZX373', message =
      'ok|' || pg_temp.snap4(p_item) || '#' || pg_temp.drows4(v_d) || '#oracle=' || v_oracle::text;
  exception
    when sqlstate 'ZX373' then return sqlerrm;
    when others then return 'err|' || sqlstate || '|' || sqlerrm;
  end;
end $f$;

-- A draw's draw-time facts: seq:location:kind:location warehouse:item
-- warehouse:mode.
create function pg_temp.whtag(p_wh uuid) returns text language sql immutable as $f$
  select case p_wh when '03730000-0000-0000-0000-0000000000b1'::uuid then 'WA'
                   when '03730000-0000-0000-0000-0000000000b2'::uuid then 'WB'
                   else coalesce(p_wh::text, 'org') end;
$f$;
create function pg_temp.facts(p_d public.stock_draw) returns text language sql stable as $f$
  select coalesce(string_agg(h.seq || ':' || pg_temp.tag(h.location_id) || ':' || coalesce(h.location_kind, 'null') || ':'
                             || pg_temp.whtag(h.location_warehouse_id) || ':' || pg_temp.whtag((p_d).item_warehouse_id)
                             || ':' || coalesce((p_d).mode, 'null'), ',' order by h.seq), '<none>')
    from unnest((p_d).holdings) with ordinality
         as h(location_id, quantity, step, location_kind, location_warehouse_id, actor_scope, seq);
$f$;

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
  (select string_agg(t.typname || '(' ||
            (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
               from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped) || ')',
          ' ' order by t.typname)
     from pg_type t where t.typnamespace = 'public'::regnamespace and t.typname in ('stock_draw', 'stock_draw_holding')),
  'stock_draw(mode text, item_warehouse_id uuid, actor_scope text, holdings stock_draw_holding[]) stock_draw_holding(location_id uuid, quantity numeric(14,4), step text, location_kind text, location_warehouse_id uuid, actor_scope text)',
  'A1: the two draw types and their fields (quantity is numeric(14,4), as the holdings)');
select is(
  (select format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || a.atthasdef::text || '|'
          || a.atthasmissing::text
     from pg_attribute a where a.attrelid = 'public.stock_movements'::regclass and a.attname = 'draw' and not a.attisdropped),
  'stock_draw|false|false|false',
  'A2: stock_movements.draw is a nullable stock_draw with no default (a metadata-only column: no rewrite, no missing value)');
select is(
  (select string_agg(i.indexrelid::regclass::text, ',' order by i.indexrelid::regclass::text)
     from pg_index i where i.indrelid = 'public.stock_movements'::regclass),
  'stock_movements_item_created_idx,stock_movements_org_created_idx,stock_movements_org_type_created_idx,stock_movements_pkey,stock_movements_reference_idx',
  'A3: stock_movements keeps exactly its pre-0373 indexes (no composite key, no index on draw)');
select is(
  (select string_agg(c.conname || ':' || c.contype::text || ':' || c.condeferrable::text, ',' order by c.conname)
     from pg_constraint c where c.conrelid = 'public.stock_movements'::regclass)
  || '|' || (select count(*) from pg_constraint c where c.confrelid = 'public.stock_movements'::regclass),
  'stock_movements_from_location_id_fkey:f:false,stock_movements_item_id_fkey:f:false,stock_movements_movement_type_check:c:false,stock_movements_organization_id_fkey:f:false,stock_movements_pkey:p:false,stock_movements_to_location_id_fkey:f:false,stock_movements_user_id_fkey:f:false|0',
  'A4: stock_movements keeps exactly its pre-0373 constraints, none deferrable, and nothing references it (no deferred work at COMMIT)');
select is(
  (select c.relkind::text || '|' || c.reloptions::text from pg_class c where c.oid = 'public.stock_movement_holdings'::regclass),
  'v|{security_invoker=true}',
  'A5: stock_movement_holdings is a VIEW with security_invoker (the reader''s own RLS on stock_movements applies)');
select is(
  (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
     from pg_attribute a where a.attrelid = 'public.stock_movement_holdings'::regclass and a.attnum > 0 and not a.attisdropped),
  'movement_id:uuid,seq:integer,organization_id:uuid,item_id:uuid,location_id:uuid,quantity:numeric(14,4),step:text,mode:text,location_kind:text,location_warehouse_id:uuid,item_warehouse_id:uuid,actor_scope:text,created_at:timestamp with time zone',
  'A6: the view has the first build''s 13 columns, names and types');
select is(
  (select coalesce(string_agg(r || ':' || p, ',' order by r, p), '')
     from unnest(array['anon', 'authenticated', 'service_role']) r,
          unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
    where has_table_privilege(r, 'public.stock_movement_holdings', p)
       or (p in ('INSERT', 'UPDATE', 'REFERENCES')
           and has_any_column_privilege(r, 'public.stock_movement_holdings', p))),
  '',
  'A7: no API role (service_role included) holds any write privilege on the view, table- or column-level');
select ok(
  has_table_privilege('authenticated', 'public.stock_movement_holdings', 'SELECT')
  and has_table_privilege('service_role', 'public.stock_movement_holdings', 'SELECT')
  and not has_table_privilege('anon', 'public.stock_movement_holdings', 'SELECT')
  and not exists (select 1 from pg_class c, aclexplode(c.relacl) a
                   where c.oid = 'public.stock_movement_holdings'::regclass and a.grantee = 0),
  'A8: view SELECT for authenticated and service_role only; nothing for anon or PUBLIC');
select is(
  (select ('draw' = any(t.attnames))::text || '|' || (t.rowfilter is null)::text
     from pg_publication_tables t
    where t.pubname = 'supabase_realtime' and t.schemaname = 'public' and t.tablename = 'stock_movements')
  || '|' || (select count(*) from pg_publication_tables t where t.tablename = 'stock_movement_holdings'),
  'true|true|0',
  'A9: stock_movements is published to realtime with no column list or row filter, so its INSERT events carry draw (delivered under the subscriber''s stock_movements RLS); the view is not published');
select is(
  (select string_agg(pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text, ' ; ' order by t.tgname)
     from pg_trigger t where t.tgrelid = 'public.stock_movements'::regclass and not t.tgisinternal),
  'CREATE TRIGGER trg_zz_stock_movements_via_ledger BEFORE INSERT OR UPDATE OF via_ledger, draw ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION tg_stock_movements_via_ledger()|O',
  'A10: the 0369 stamp is still the only trigger on stock_movements, enabled, now on UPDATE OF via_ledger, draw');
select is(
  (select count(*)::int || '|' || bool_and(p.prosecdef)::text || '|' || min(p.proconfig::text) || '|'
          || min(p.pronargdefaults) || '|' || min(p.prorettype::regtype::text) || '|'
          || min(pg_get_function_arguments(p.oid))
     from pg_proc p where p.pronamespace = 'ledger'::regnamespace and p.proname = 'apply_level_delta_for'),
  '1|true|{search_path=public}|0|stock_draw|p_item_id uuid, p_qty numeric, p_mode text, p_record boolean, p_uid uuid, OUT o_draw stock_draw',
  'A11: exactly one engine: SECURITY DEFINER, search_path=public, no defaults, the draw as its OUT parameter');
select ok(
  has_function_privilege('authenticated', 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)', 'execute')
  and has_function_privilege('service_role', 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)', 'execute')
  and not has_function_privilege('anon', 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)'::regprocedure and a.grantee = 0),
  'A12: engine EXECUTE for authenticated (the INVOKER bodies call it as the user) and service_role; none for anon or PUBLIC');
select ok(
  (select count(*) = 1 and bool_and(not p.prosecdef and p.proconfig is null) from pg_proc p
    where p.pronamespace = 'ledger'::regnamespace and p.proname = '_seal')
  and not has_function_privilege('anon', 'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])', 'execute')
  and not has_function_privilege('service_role', 'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'ledger._seal(uuid,uuid,uuid,text,public.stock_draw_holding[],uuid[])'::regprocedure
                     and a.grantee = 0),
  'A13: _seal is SECURITY INVOKER with no SET clause, and no API role (nor PUBLIC) can execute it');
select is(
  (select count(*)::int || '|' || min(pg_get_function_arguments(p.oid)) || '|' || min(p.prorettype::regtype::text)
          || '|' || bool_and(p.prosecdef)::text || '|' || min(p.proconfig::text) || '|' || min(p.proacl::text)
          || '|' || min(md5(coalesce(obj_description(p.oid, 'pg_proc'), '<none>')))
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_level_delta'),
  '1|p_item_id uuid, p_qty numeric, p_mode text DEFAULT ''placed''::text|void|true|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|627ae82e5211f10ca9e5ede9723cdfe8',
  'A14: public.apply_level_delta keeps one overload, its default, SECURITY DEFINER, search_path, ACL and comment');
select is(
  (select string_agg(pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text, E'\n' order by c.relname)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'trg_zz_forget_draw_scope'),
  'CREATE TRIGGER trg_zz_forget_draw_scope AFTER DELETE OR UPDATE OF id, organization_id, warehouse_id OR TRUNCATE ON public.locations FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_forget_draw_scope()|O' || E'\n' ||
  'CREATE TRIGGER trg_zz_forget_draw_scope AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.organization_members FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_forget_draw_scope()|O' || E'\n' ||
  'CREATE TRIGGER trg_zz_forget_draw_scope AFTER INSERT OR DELETE OR UPDATE OF id, disabled_at OR TRUNCATE ON public.user_profiles FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_forget_draw_scope()|O' || E'\n' ||
  'CREATE TRIGGER trg_zz_forget_draw_scope AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.user_warehouse_assignments FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_forget_draw_scope()|O' || E'\n' ||
  'CREATE TRIGGER trg_zz_forget_draw_scope AFTER INSERT OR DELETE OR UPDATE OF id, organization_id OR TRUNCATE ON public.warehouses FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_forget_draw_scope()|O',
  'A15: the five forget triggers: statement-level AFTER, enabled, on every input of the scope answers (not on locations INSERT)');
select ok(
  (select not p.prosecdef and not has_function_privilege('authenticated', p.oid, 'execute')
          and not has_function_privilege('anon', p.oid, 'execute')
          and not has_function_privilege('service_role', p.oid, 'execute')
     from pg_proc p where p.oid = 'ledger.tg_forget_draw_scope()'::regprocedure),
  'A16: the forget function is SECURITY INVOKER and closed to every API role');
select is(
  (select md5(string_agg(p.policyname || ':' || p.cmd || ':' || p.permissive || ':' || p.roles::text || ':'
                         || coalesce(p.qual, '-') || ':' || coalesce(p.with_check, '-'), E'\n' order by p.policyname))
     from pg_policies p where p.schemaname = 'public' and p.tablename = 'stock_movements'),
  '9839edaeacf7cb78033d18b040828a03',
  'A17: the stock_movements policies (the reach every draw inherits, through the view, PostgREST and Realtime) are exactly the pre-0373 ones');
select ok(
  to_regclass('public.stock_movements_id_org_item_key') is null
  and to_regprocedure('ledger.apply_level_delta_for(uuid,uuid,numeric,text)') is null
  and not exists (select 1 from pg_proc p where p.pronamespace = 'ledger'::regnamespace and p.proname = '_record_holdings')
  and not exists (select 1 from pg_class c where c.relname = 'stock_movement_holdings' and c.relkind <> 'v'),
  'A18: none of the first build''s objects exist (no table, composite index, recorder or id-taking engine)');

-- ══════════════════════════════════════════════════════════════════════════
-- P. TEXT PROOFS
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0373[^\n]*', '', 'g')) from pg_proc p
    where p.oid = 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)'::regprocedure),
  '4be0f94c4390e7cd9c15a73e629133bf',
  'P1: the engine minus its tagged lines IS the 0359 apply_level_delta prosrc (md5)');
select is(
  (select string_agg(btrim(m[1]), E'\n' order by o)
     from pg_proc p, regexp_matches(p.prosrc, '\n([^\n]*)-- 0373[^\n]*', 'g') with ordinality r(m, o)
    where p.oid = 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)'::regprocedure),
  $x$v_h      public.stock_draw_holding[];
v_o      uuid[];
v_q      numeric;
if p_record then v_q := floor(p_qty * 10000 + 0.5) / 10000; if v_q <> 0 then o_draw := ledger._seal(p_uid, v_org, v_wh, p_mode, array[row(v_loc, v_q, 'increment', 'staging', v_wh, null)::public.stock_draw_holding], array[null::uuid]); end if; end if;
, l.kind, l.warehouse_id, l.organization_id
v_q := floor(-v_take * 10000 + 0.5) / 10000; if v_q <> 0 then v_h := v_h || row(v_lvl.location_id, v_q, 'staging_first', v_lvl.kind, v_lvl.warehouse_id, null)::public.stock_draw_holding; v_o := v_o || v_lvl.organization_id; end if;
, l.kind, l.warehouse_id, l.organization_id
v_q := floor(-v_take * 10000 + 0.5) / 10000; if v_q <> 0 then v_h := v_h || row(v_lvl.location_id, v_q, 'placed', v_lvl.kind, v_lvl.warehouse_id, null)::public.stock_draw_holding; v_o := v_o || v_lvl.organization_id; end if;
, l.kind, l.warehouse_id, l.organization_id
v_q := floor(-v_take * 10000 + 0.5) / 10000; if v_q <> 0 then v_h := v_h || row(v_lvl.location_id, v_q, 'any_staging', v_lvl.kind, v_lvl.warehouse_id, null)::public.stock_draw_holding; v_o := v_o || v_lvl.organization_id; end if;
if p_record and v_h is not null then o_draw := ledger._seal(p_uid, v_org, v_wh, p_mode, v_h, v_o); end if;$x$,
  'P2: the engine has exactly eleven tagged lines, in order: three declares, the increment record, then per draw loop (staging_first, placed, any_staging) its three SELECT columns and its append, then the final seal');
select is(
  (select string_agg(x.fn || '=' || (x.stripped = x.want)::text || ':' || x.shapes_ok::text, ',' order by x.fn)
     from (
       select v.fn, v.want,
              md5(regexp_replace(p.prosrc, '\n[^\n]*-- 0373[^\n]*', '', 'g')) as stripped,
              (select bool_and(btrim(m[1]) ~ '^(v_prov\s+public\.stock_draw;|v_prov := ledger\.apply_level_delta_for\([^;]+, true, v_user\);|draw,|v_prov,)\s+-- 0373$'
                               or btrim(m[1]) = '-- 0373: drawn before the insert (0197 drew after it), so this row carries its own draw.')
                 from regexp_matches(p.prosrc, '\n([^\n]*-- 0373[^\n]*)', 'g') m) as shapes_ok
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
  'adjust_stock:4,assemble_bundle:7,distribute_bundle:7,process_return_disposition:9',
  'P4: the tagged-line count per caller (a declare, then per draw: the call, draw and v_prov in the insert; the return also explains its two moved calls)');
select is(
  (select string_agg(p.proname || ':' ||
            (select string_agg(m[1], '/') from regexp_matches(p.prosrc, 'v_prov := ledger\.apply_level_delta_for\(([^;]+)\);', 'g') m),
          ' | ' order by p.proname)
     from pg_proc p where p.oid in (
       'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)'::regprocedure,
       'ledger.assemble_bundle(uuid,numeric,uuid,text)'::regprocedure,
       'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
       'ledger.process_return_disposition(uuid)'::regprocedure)),
  'adjust_stock:p_item_id, p_quantity_change, p_mode, true, v_user | assemble_bundle:v_component.item_id, v_new - v_prev, ''placed'', true, v_user/v_phantom.id, v_new - v_prev, ''staging'', true, v_user | distribute_bundle:v_bundle.phantom_item_id, v_new - v_prev, ''staging_first'', true, v_user/v_component.item_id, v_new - v_prev, ''placed'', true, v_user | process_return_disposition:v_line.item_id, v_line.quantity, ''staging'', true, v_user/v_line.item_id, -v_line.quantity, ''staging_first'', true, v_user',
  'P5: every engine call passes the SAME item, quantity and mode as the apply_level_delta call it replaced, then record = true and the caller''s own v_user');
select ok(
  (select bool_and(p.prosrc !~ 'public\.apply_level_delta\(' and p.prosrc !~ 'perform\s+ledger\.apply_level_delta_for')
     from pg_proc p where p.oid in (
     'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)'::regprocedure,
     'ledger.assemble_bundle(uuid,numeric,uuid,text)'::regprocedure,
     'ledger.distribute_bundle(uuid,numeric,uuid,boolean,uuid,text,text)'::regprocedure,
     'ledger.process_return_disposition(uuid)'::regprocedure))
  and (select p.prosrc ~ 'perform ledger\.apply_level_delta_for\(p_item_id, p_qty, p_mode, false, null\);'
         from pg_proc p where p.oid = 'public.apply_level_delta(uuid,numeric,text)'::regprocedure),
  'P6: no restated caller calls public.apply_level_delta or discards a draw; the wrapper passes record = false and no drawer');
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

-- P9. PLAN SHAPE. The three added SELECT columns come from the locations row
-- each draw loop already joins. They must not change a plan (a new plan
-- could change the order of ties, which 0359 leaves undefined): each loop
-- query, taken from the installed engine with and without its tagged line,
-- is prepared and EXPLAINed (COSTS OFF) under a custom and a generic plan
-- for a real item. Reports loop:mode=same|DIFFERENT and the plan line count.
create function pg_temp.plan_shapes(p_item uuid) returns text language plpgsql as $f$
declare
  v_src  text;
  q      record;
  v_mode text;
  v_with text;
  v_wo   text;
  v_p1   text;
  v_p2   text;
  r      record;
  v_out  text := '';
  i      int := 0;
begin
  select p.prosrc into v_src from pg_proc p
   where p.oid = 'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)'::regprocedure;
  for q in select m[1] as sql from regexp_matches(v_src, 'for v_lvl in\n(.*?)\n\s*loop\n', 'g') m loop
    i := i + 1;
    v_with := replace(q.sql, 'p_item_id', '$1');
    v_wo := regexp_replace(v_with, '\n[^\n]*-- 0373[^\n]*', '', 'g');
    if v_with = v_wo then
      raise exception 'loop % has no tagged line', i;
    end if;
    foreach v_mode in array array['force_custom_plan', 'force_generic_plan'] loop
      perform set_config('plan_cache_mode', v_mode, true);
      execute 'prepare q0373_with(uuid) as ' || v_with;
      execute 'prepare q0373_wo(uuid) as ' || v_wo;
      v_p1 := ''; v_p2 := '';
      for r in execute format('explain (costs off) execute q0373_with(%L)', p_item) loop
        v_p1 := v_p1 || r."QUERY PLAN" || E'\n';
      end loop;
      for r in execute format('explain (costs off) execute q0373_wo(%L)', p_item) loop
        v_p2 := v_p2 || r."QUERY PLAN" || E'\n';
      end loop;
      deallocate q0373_with;
      deallocate q0373_wo;
      v_out := v_out || 'loop' || i || ':' || replace(v_mode, '_plan', '') || '='
               || case when v_p1 = v_p2 and v_p1 <> '' then 'same' else 'DIFFERENT' end
               || '(' || (length(v_p1) - length(replace(v_p1, E'\n', ''))) || ' lines) ';
    end loop;
  end loop;
  perform set_config('plan_cache_mode', 'auto', true);
  return btrim(v_out);
end $f$;
select matches(
  pg_temp.plan_shapes(:itX),
  '^loop1:force_custom=same\(\d+ lines\) loop1:force_generic=same\(\d+ lines\) loop2:force_custom=same\(\d+ lines\) loop2:force_generic=same\(\d+ lines\) loop3:force_custom=same\(\d+ lines\) loop3:force_generic=same\(\d+ lines\)$',
  'P9: each of the three draw-loop queries plans identically with and without its added SELECT columns, custom and generic');

-- ══════════════════════════════════════════════════════════════════════════
-- B. DIFFERENTIAL ORACLE (service path: no jwt subject)
-- Each line: engine vs oracle (holdings or error), then wrapper vs oracle
-- (everything, which includes "returns no draw").
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to '';

select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -1, ''placed'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')::text', :itX), :itX), '#', 1),
  'B1: engine = 0359 oracle: placed -1 (first placed holding only)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -1, ''placed'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')::text', :itX), :itX),
  'B2: wrapper = 0359 oracle, and it records nothing: placed -1 (first placed holding only)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -10, ''placed'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -10, ''placed'')::text', :itX), :itX), '#', 1),
  'B3: engine = 0359 oracle: placed -10 (every placed holding, Unplaced last, the archived crate included)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -10, ''placed'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -10, ''placed'')::text', :itX), :itX),
  'B4: wrapper = 0359 oracle, and it records nothing: placed -10 (every placed holding, Unplaced last, the archived crate included)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -11, ''placed'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -11, ''placed'')::text', :itX), :itX), '#', 1),
  'B5: engine = 0359 oracle: placed -11 (placed never touches Staging: raises)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -11, ''placed'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -11, ''placed'')::text', :itX), :itX),
  'B6: wrapper = 0359 oracle, and it records nothing: placed -11 (placed never touches Staging: raises)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -6, ''staging_first'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -6, ''staging_first'')::text', :itX), :itX), '#', 1),
  'B7: engine = 0359 oracle: staging_first -6 (Staging largest first, across warehouses)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -6, ''staging_first'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -6, ''staging_first'')::text', :itX), :itX),
  'B8: wrapper = 0359 oracle, and it records nothing: staging_first -6 (Staging largest first, across warehouses)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -12, ''staging_first'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -12, ''staging_first'')::text', :itX), :itX), '#', 1),
  'B9: engine = 0359 oracle: staging_first -12 (all Staging, then placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -12, ''staging_first'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -12, ''staging_first'')::text', :itX), :itX),
  'B10: wrapper = 0359 oracle, and it records nothing: staging_first -12 (all Staging, then placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -19, ''staging_first'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''staging_first'')::text', :itX), :itX), '#', 1),
  'B11: engine = 0359 oracle: staging_first -19 (more than exists: raises)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -19, ''staging_first'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''staging_first'')::text', :itX), :itX),
  'B12: wrapper = 0359 oracle, and it records nothing: staging_first -19 (more than exists: raises)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -13, ''any'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -13, ''any'')::text', :itX), :itX), '#', 1),
  'B13: engine = 0359 oracle: any -13 (placed, then Staging)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -13, ''any'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -13, ''any'')::text', :itX), :itX),
  'B14: wrapper = 0359 oracle, and it records nothing: any -13 (placed, then Staging)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -19, ''any'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''any'')::text', :itX), :itX), '#', 1),
  'B15: engine = 0359 oracle: any -19 (more than exists: raises)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -19, ''any'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -19, ''any'')::text', :itX), :itX),
  'B16: wrapper = 0359 oracle, and it records nothing: any -19 (more than exists: raises)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -3, ''staging'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -3, ''staging'')::text', :itX), :itX), '#', 1),
  'B17: engine = 0359 oracle: mode staging -3 (draws as placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -3, ''staging'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -3, ''staging'')::text', :itX), :itX),
  'B18: wrapper = 0359 oracle, and it records nothing: mode staging -3 (draws as placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -4, ''bogus'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -4, ''bogus'')::text', :itX), :itX), '#', 1),
  'B19: engine = 0359 oracle: mode bogus -4 (draws as placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -4, ''bogus'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -4, ''bogus'')::text', :itX), :itX),
  'B20: wrapper = 0359 oracle, and it records nothing: mode bogus -4 (draws as placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -4, null, true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -4, null)::text', :itX), :itX), '#', 1),
  'B21: engine = 0359 oracle: mode NULL -4 (draws as placed)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -4, null)::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -4, null)::text', :itX), :itX),
  'B22: wrapper = 0359 oracle, and it records nothing: mode NULL -4 (draws as placed)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, 3, ''placed'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 3, ''placed'')::text', :itX), :itX), '#', 1),
  'B23: engine = 0359 oracle: placed +3 (lands in WA Staging)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 3, ''placed'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 3, ''placed'')::text', :itX), :itX),
  'B24: wrapper = 0359 oracle, and it records nothing: placed +3 (lands in WA Staging)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, 2, ''any'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''any'')::text', :itX), :itX), '#', 1),
  'B25: engine = 0359 oracle: any +2 (mode ignored for an increment)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 2, ''any'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''any'')::text', :itX), :itX),
  'B26: wrapper = 0359 oracle, and it records nothing: any +2 (mode ignored for an increment)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, 0, ''placed'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 0, ''placed'')::text', :itX), :itX), '#', 1),
  'B27: engine = 0359 oracle: zero (no-op)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 0, ''placed'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 0, ''placed'')::text', :itX), :itX),
  'B28: wrapper = 0359 oracle, and it records nothing: zero (no-op)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, null, ''placed'', true, null)::text', :itX), :itX), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, null, ''placed'')::text', :itX), :itX), '#', 1),
  'B29: engine = 0359 oracle: NULL quantity (no-op)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, null, ''placed'')::text', :itX), :itX),
          pg_temp.run(format('select pg_temp.ald_0359(%L, null, ''placed'')::text', :itX), :itX),
  'B30: wrapper = 0359 oracle, and it records nothing: NULL quantity (no-op)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, 2, ''placed'', true, null)::text', :itN), :itN), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''placed'')::text', :itN), :itN), '#', 1),
  'B31: engine = 0359 oracle: no-warehouse item +2 (org-level Staging, created on demand)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, 2, ''placed'')::text', :itN), :itN),
          pg_temp.run(format('select pg_temp.ald_0359(%L, 2, ''placed'')::text', :itN), :itN),
  'B32: wrapper = 0359 oracle, and it records nothing: no-warehouse item +2 (org-level Staging, created on demand)');
select is(split_part(pg_temp.run(format('select ledger.apply_level_delta_for(%L, -1, ''placed'', true, null)::text', :itN), :itN), '#', 1),
          split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')::text', :itN), :itN), '#', 1),
  'B33: engine = 0359 oracle: no-warehouse item -1 (the org Site)');
select is(pg_temp.run(format('select public.apply_level_delta(%L, -1, ''placed'')::text', :itN), :itN),
          pg_temp.run(format('select pg_temp.ald_0359(%L, -1, ''placed'')::text', :itN), :itN),
  'B34: wrapper = 0359 oracle, and it records nothing: no-warehouse item -1 (the org Site)');
select is(split_part(pg_temp.run(format('select pg_temp.ald_0359(%L, -10, ''placed'')::text', :itX), :itX), '#', 1),
  'ok|A1=0,A2=0,B1=0,S=0,SA=5,SB=3,UA=0',
  'B35: the oracle itself: placed -10 empties every placed holding and leaves Staging');
select is(
  (select string_agg(coalesce(pg_temp.draw_of(format('select ledger.apply_level_delta_for(%L, %s, %L, false, null)::text', :itX, v.q, v.m))::text, 'none'), ',' order by v.o)
     from (values (1, -1, 'placed'), (2, -10, 'placed'), (3, -6, 'staging_first'), (4, -13, 'any'), (5, 3, 'placed'), (6, -4, 'bogus')) v(o, q, m)),
  'none,none,none,none,none,none',
  'B36: with record = false (the wrapper''s call) the engine returns no draw, in every mode and for an increment');

-- ══════════════════════════════════════════════════════════════════════════
-- C. PROVENANCE TRUTH
-- ══════════════════════════════════════════════════════════════════════════
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, -10, 'placed', true, null)::text$$, :itX), :itX),
  'ok|A1=0,A2=0,B1=0,S=0,SA=5,SB=3,UA=0#1:A1:-1:placed:service,2:S:-2:placed:service,3:B1:-4:placed:service,4:A2:-1:placed:service,5:UA:-2:placed:service#diff=A1:-1,A2:-1,B1:-4,S:-2,UA:-2#oracle=true#total=-10#facts=true#n=5',
  'C1: placed -10: rows in draw order (location age: A1, Site, WB rack, archived crate; Unplaced last), summing to the holdings difference');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, -12, 'staging_first', true, null)::text$$, :itX), :itX),
  'ok|A1=0,A2=1,B1=3,S=0,SA=0,SB=0,UA=2#1:SA:-5:staging_first:service,2:SB:-3:staging_first:service,3:A1:-1:placed:service,4:S:-2:placed:service,5:B1:-1:placed:service#diff=A1:-1,B1:-1,S:-2,SA:-5,SB:-3#oracle=true#total=-12#facts=true#n=5',
  'C2: staging_first -12: Staging largest first (WA 5, then WB 3), then placed');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, -13, 'any', true, null)::text$$, :itX), :itX),
  'ok|A1=0,A2=0,B1=0,S=0,SA=2,SB=3,UA=0#1:A1:-1:placed:service,2:S:-2:placed:service,3:B1:-4:placed:service,4:A2:-1:placed:service,5:UA:-2:placed:service,6:SA:-3:any_staging:service#diff=A1:-1,A2:-1,B1:-4,S:-2,SA:-3,UA:-2#oracle=true#total=-13#facts=true#n=6',
  'C3: any -13: every placed holding, then Staging largest first (any_staging)');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, 3, 'placed', true, null)::text$$, :itX), :itX),
  'ok|A1=1,A2=1,B1=4,S=2,SA=8,SB=3,UA=2#1:SA:3:increment:service#diff=SA:3#oracle=true#total=3#facts=true#n=1',
  'C4: +3 lands in the item''s own warehouse Staging: one increment row');
select is(
  pg_temp.run(format($$select ledger.apply_level_delta_for(%L, 2, 'any', true, null)::text$$, :itN), :itN),
  'ok|S=2,new-staging-org=2#1:new-staging-org:2:increment:service#diff=new-staging-org:2#oracle=true#total=2#facts=true#n=1',
  'C5: an item with no warehouse lands in the org-level Staging (created on demand, as before)');
-- The draw-time facts and the mode, literally, for a draw that crosses
-- warehouses (B1 is in WB, the item in WA) and a non-standard mode string.
select is(
  pg_temp.facts(pg_temp.draw_of(format($$select ledger.apply_level_delta_for(%L, -7, 'bogus', true, null)::text$$, :itX))),
  '1:A1:rack:WA:WA:bogus,2:S:null:org:WA:bogus,3:B1:rack:WB:WA:bogus',
  'C6: facts at draw time: location kind and warehouse (NULL Site = org), the ITEM''s warehouse (not the location''s), and p_mode exactly as passed');
set local "request.jwt.claim.sub" to :u_mgr;
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
select is(
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, -7, 'placed', true, %L)::text$$, :itX, :u_mgr), :itX), '#', 2),
  '1:A1:-1:placed:manager,2:S:-2:placed:manager,3:B1:-4:placed:manager',
  'C7: a manager''s draw records actor_scope manager for every holding');
set local "request.jwt.claim.sub" to :u_stf;
select is(
  split_part(pg_temp.run(format($$select ledger.apply_level_delta_for(%L, -7, 'placed', true, %L)::text$$, :itX, :u_stf), :itX), '#', 2),
  '1:A1:-1:placed:in_scope,2:S:-2:placed:in_scope,3:B1:-4:placed:out_of_scope',
  'C8: a WA staff draw: WA rack and the org-level Site in_scope, the WB rack out_of_scope');
select set_config('stockpilot.ledger', '', true);
set local "request.jwt.claim.sub" to '';

-- ══════════════════════════════════════════════════════════════════════════
-- R. SUB-PRECISION QUANTITIES. adjust_stock takes an unconstrained numeric
-- and the API accepts any finite value, but holdings are numeric(14,4). Each
-- share is recorded as its holding moved; one that rounds to zero is not
-- recorded. Each case: the engine's holdings equal the 0359 oracle's EXACTLY,
-- the rows are literal, and per location the rows equal the holdings
-- difference exactly. Service path.
-- ══════════════════════════════════════════════════════════════════════════
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -0.00001, ''placed'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -0.00001, ''placed'')::text', :itX), :itX), '#', 1) || '##oracle=true',
  'R1: -0.00001 moves nothing (as 0359) and records no row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, 0.00004, ''placed'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, 0.00004, ''placed'')::text', :itX), :itX), '#', 1) || '##oracle=true',
  'R2: +0.00004 lands nothing (as 0359) and records no row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -1.00001, ''placed'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -1.00001, ''placed'')::text', :itX), :itX), '#', 1) || '#1:A1:-1.0000:placed#oracle=true',
  'R3: -1.00001 empties A1; the 0.00001 remainder on the Site moves nothing and records no row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -0.00005, ''placed'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -0.00005, ''placed'')::text', :itX), :itX), '#', 1) || '##oracle=true',
  'R4: -0.00005 (an exact half) leaves A1 at 1.0000, so no row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -0.00006, ''placed'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -0.00006, ''placed'')::text', :itX), :itX), '#', 1) || '#1:A1:-0.0001:placed#oracle=true',
  'R5: -0.00006 takes A1 to 0.9999: one -0.0001 row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, 0.00005, ''placed'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, 0.00005, ''placed'')::text', :itX), :itX), '#', 1) || '#1:SA:0.0001:increment#oracle=true',
  'R6: +0.00005 (an exact half) lands 0.0001 in WA Staging: one 0.0001 row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -5.00005, ''staging_first'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -5.00005, ''staging_first'')::text', :itX), :itX), '#', 1) || '#1:SA:-5.0000:staging_first#oracle=true',
  'R7: staging_first -5.00005 empties WA Staging; the half on WB Staging moves nothing and records no row');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -10.00006, ''any'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -10.00006, ''any'')::text', :itX), :itX), '#', 1)
          || '#1:A1:-1.0000:placed,2:S:-2.0000:placed,3:B1:-4.0000:placed,4:A2:-1.0000:placed,5:UA:-2.0000:placed,6:SA:-0.0001:any_staging#oracle=true',
  'R8: any -10.00006: every placed holding, then 0.0001 off WA Staging (any_staging kept: it moved)');
select is(pg_temp.run4(format('select ledger.apply_level_delta_for(%L, -10.00001, ''any'', true, null)::text', :itX), :itX),
          split_part(pg_temp.run4(format('select pg_temp.ald_0359(%L, -10.00001, ''any'')::text', :itX), :itX), '#', 1)
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
select is(
  (select count(*)::int from public.stock_movements m
    where m.item_id = :itX and m.reason in ('D1 phone', 'D1 reach') and m.via_ledger and num_nonnulls(m.draw) = 1),
  2,
  'D3: both movements are ledger rows carrying their own draw');
select is(
  (select count(*)::int || '|' || coalesce(m.from_location_id::text, '-') || '>' || coalesce(m.to_location_id::text, '-')
          || '|' || pg_temp.rows(m.id) || '|' || (select string_agg(distinct h.mode, ',') from public.stock_movement_holdings h where h.movement_id = m.id)
     from public.stock_movements m where m.item_id = :itX and m.reason = 'D1 phone' group by m.id),
  '1|->-|1:A1:-1:placed:in_scope,2:S:-1:placed:in_scope|placed',
  'D4: one movement, from/to still NULL, its rows (A1 then the Site) with mode placed');
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
select is(
  (select pg_temp.rows(pg_temp.mv(:itX, 'D6 web')) || ' | ' || pg_temp.rows(pg_temp.mv(:itX, 'D7 plus'))
          || ' | ' || coalesce((select to_location_id::text from public.stock_movements where id = pg_temp.mv(:itX, 'D7 plus')), 'null')),
  '1:B1:-2:placed:out_of_scope,2:A2:-1:placed:in_scope,3:UA:-2:placed:in_scope,4:SA:-2:any_staging:in_scope | 1:SA:1:increment:in_scope | null',
  'D8: any: the rest of the placed stock, then Staging (any_staging); +1: one increment row at WA Staging, to_location_id still NULL');

-- D9: explicit-location adjust and a transfer record nothing.
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, 2, 'adjust', %L, 'D10 explicit')$$, :itX, :locA1),
  'D9: a manager adjusts +2 at an explicit location');
select lives_ok(format($$select public.transfer_stock(%L, %L, %L, 1, 'D10 transfer')$$, :itX, :locA1, :locS),
  'D10: a manager transfers 1 from A1 to the Site');
reset role;
select is(
  (select string_agg(m.movement_type || ':' || coalesce(bf.tag, '-') || '>' || coalesce(bt.tag, '-') || ':'
                     || (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id)
                     || ':' || num_nonnulls(m.draw),
                     ',' order by m.movement_type)
     from public.stock_movements m
     left join lbl bf on bf.id = m.from_location_id
     left join lbl bt on bt.id = m.to_location_id
    where m.item_id = :itX and (m.reason = 'D10 explicit' or m.notes = 'D10 transfer')),
  'adjust:->A1:0:0,transfer:A1>S:0:0',
  'D11: explicit-location movements keep their from/to and carry no draw');
select is(pg_temp.snap(:itX) || ' qoh=' || (select quantity_on_hand::int from public.inventory_items where id = :itX),
  'A1=1,A2=0,B1=0,S=1,SA=4,SB=3,UA=0 qoh=9',
  'D12: itX holdings equal on hand after D1-D10');

-- D13: complete_picking, two lines of one item; the first spans P1 and P2.
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.complete_picking(%L)$$, :ordP), 'D13: WA staff completes the pick');
reset role;
select is(
  (select count(*)::int || '|' || bool_and(m.reference_type = 'order_request' and m.reference_id = :ordP)::text
          || '|' || bool_and((select sum(h.quantity) from public.stock_movement_holdings h where h.movement_id = m.id) = m.quantity_change)::text
          || '|' || string_agg(pg_temp.rows(m.id), ' / ' order by (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id) desc)
     from public.stock_movements m where m.item_id = :itP and m.movement_type = 'transfer'),
  '2|true|true|1:P1:-1:placed:in_scope,2:P2:-1:placed:in_scope / 1:P2:-2:placed:in_scope',
  'D14: exactly two movements, both stamped order_request (the exactly-one probe still works); each movement''s rows sum to its batch; the duplicate line keeps its own rows');

-- D15: cancel restocks both lines into Staging.
set local role to 'authenticated';
select lives_ok(format($$select public.cancel_order_request(%L, 'D17 cancel')$$, :ordP), 'D15: the requester cancels the picked order');
reset role;
select is(
  (select string_agg(pg_temp.rows(m.id), ' / ' order by m.id)
     from public.stock_movements m where m.item_id = :itP and m.movement_type = 'return'),
  '1:SA:2:increment:in_scope / 1:SA:2:increment:in_scope',
  'D16: one increment row per restocked line, at WA Staging');

-- D17: reverse_receipt draws staging_first.
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select lives_ok($$
do $d$
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
end $d$;
$$, 'D17: a manager receives 3 into Staging, moves 1 to A1, and reverses the receipt');
reset role;
select is(
  (select string_agg(m.movement_type || ':' || m.quantity_change::int || '[' || pg_temp.rows(m.id) || ']', ' ' order by m.movement_type collate "C")
     from public.stock_movements m where m.item_id = :itV),
  'correction:-3[1:SA:-2:staging_first:manager,2:A1:-1:placed:manager] receive_po:3[] transfer:0[]',
  'D18: the receipt (explicit Staging) and the transfer record nothing; the reversal records Staging first, then A1');

-- D19: assemble then distribute (phantom drain, component draws, shortages).
set local role to 'authenticated';
select lives_ok(format($$select public.assemble_bundle(%L, 2, %L, 'D22 assemble')$$, :bnd, :whA),
  'D19: a manager assembles 2 kits');
select lives_ok(format($$select public.distribute_bundle(%L, 4, %L, true, null, 'D22 distribute', null)$$, :bnd, :whA),
  'D20: a manager distributes 4 (2 pre-assembled, 2 built from 1 of each part, shortages allowed)');
reset role;
select is(
  (select string_agg(i.sku || ':' || m.movement_type || ':' || m.quantity_change::int || '[' || pg_temp.rows(m.id) || ']',
                     ' ' order by i.sku collate "C", m.movement_type collate "C", m.quantity_change)
     from public.stock_movements m join public.inventory_items i on i.id = m.item_id
    where m.reference_type = 'bundle' and m.reference_id = :bnd),
  'PV-0373-K1:bundle_assembly:-2[1:A1:-2:placed:manager] PV-0373-K1:bundle_distribution:-1[1:A1:-1:placed:manager] PV-0373-K1:bundle_shortage:0[] PV-0373-K2:bundle_assembly:-2[1:A1:-2:placed:manager] PV-0373-K2:bundle_distribution:-1[1:UA:-1:placed:manager] PV-0373-K2:bundle_shortage:0[] __BUNDLE__03730000:bundle_assembly:2[1:SA:2:increment:manager] __BUNDLE__03730000:bundle_distribution:-2[1:SA:-2:staging_first:manager]',
  'D21: one row set per movement: component draws (placed), the kit landing in Staging, the pre-assembled drain (staging_first); the zero-quantity shortage rows carry no draw');

-- D22: return with scrap: restock lands in WA Staging; the scrap draws the
-- LARGEST Staging (WB), exactly as before; nothing crosses legs.
set local role to 'authenticated';
select lives_ok(format($$select public.process_return_disposition(%L)$$, :retR),
  'D22: a manager closes the scrap return');
reset role;
select is(
  (select string_agg(m.movement_type || ':' || m.quantity_change::int || '[' || pg_temp.rows(m.id) || ']', ' ' order by m.movement_type collate "C" desc)
     from public.stock_movements m where m.item_id = :itR),
  'return:2[1:SA:2:increment:manager] loss:-2[1:SB:-2:staging_first:manager]',
  'D23: the return movement has ONLY its +2 Staging landing; the loss movement has ONLY its own -2 (largest Staging first, as today)');

-- D24: THE PINNED GAP. post_cycle_count's residual draw goes through the
-- non-recording wrapper. When the count slice lands this flips on purpose.
set local role to 'authenticated';
update public.cycle_count_lines set counted_quantity = 2, counted_by = :u_mgr, counted_at = now() where id = :lnC;
select lives_ok(format($$select public.post_cycle_count(%L)$$, :ccC), 'D24: a manager posts a -2 count with no counted location');
reset role;
select is(
  (select m.quantity_change::int || '|' || coalesce(m.from_location_id::text, '-') || '|'
          || (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id) || '|' || num_nonnulls(m.draw)
          || '|' || pg_temp.snap(:itC)
     from public.stock_movements m where m.item_id = :itC and m.reference_type = 'cycle_count' and m.reference_id = :ccC),
  '-2|-|0|0|A1=0,S=2',
  'D25: PINNED GAP (0373 Q4): the count''s residual draw emptied A1 (2 -> 0) but recorded NO draw');

-- D26: a WB item's draw, for the RLS parity below.
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -1, 'remove', null, 'D31 wb', null)$$, :itW),
  'D26: a manager removes 1 of the WB item');
reset role;
select is(pg_temp.rows(pg_temp.mv(:itW, 'D31 wb')), '1:B1:-1:placed:manager',
  'D27: the WB item''s draw is recorded');

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
  pg_temp.run(format($$select pg_temp.ald_0359(%L, -3, 'placed')::text$$, :itX), :itX),
  'err|P0001|insufficient_placed_stock',
  'E2: the same SQLSTATE and message as the 0359 oracle on the same holdings');
select is(
  (select count(*)::int from public.stock_movements where item_id = :itX and reason = 'E1 short') || '|'
  || (select count(*) from public.stock_movement_holdings where item_id = :itX) || '|' || pg_temp.snap(:itX),
  '0|9|A1=1,A2=0,B1=0,S=1,SA=4,SB=3,UA=0',
  'E3: no movement, no new rows (still the 9 from D1-D7), holdings unchanged');
select is(
  (select count(*)::int from public.stock_movements m where num_nonnulls(m.draw) = 1 and not m.via_ledger),
  0,
  'E4: no draw sits on a movement the ledger did not write');
select is(
  coalesce(pg_temp.draw_of(format($$select ledger.apply_level_delta_for(%L, 0, 'placed', true, null)::text$$, :itX))::text, 'none')
  || '|' || coalesce(pg_temp.draw_of(format($$select ledger.apply_level_delta_for(%L, null, 'placed', true, null)::text$$, :itX))::text, 'none'),
  'none|none',
  'E5: zero and NULL quantities return no draw');
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, 0, 'adjust', null, 'E6 zero', null)$$, :itX),
  'E6: a zero adjust with no location runs');
savepoint e7;
select 1 from public.adjust_stock(:itX, -1, 'remove', null, 'E7 rolled back', null);
rollback to savepoint e7;
reset role;
select is(
  (select num_nonnulls(m.draw) || '|' || (select count(*) from public.stock_movement_holdings h where h.movement_id = m.id)
     from public.stock_movements m where m.item_id = :itX and m.reason = 'E6 zero')
  || '|' || (select count(*) from public.stock_movements where item_id = :itX and reason = 'E7 rolled back')
  || '|' || (select count(*) from public.stock_movement_holdings where item_id = :itX) || '|' || pg_temp.snap(:itX),
  '0|0|0|9|A1=1,A2=0,B1=0,S=1,SA=4,SB=3,UA=0',
  'E7: the zero adjust wrote its movement with no draw; a rolled-back savepoint left no movement, no draw and no holdings change');
set local "request.jwt.claim.sub" to '';

-- ══════════════════════════════════════════════════════════════════════════
-- F. SECURITY
-- ══════════════════════════════════════════════════════════════════════════
-- A realistic forged draw: every field set, so `is not null` would catch it
-- too. F4 is the one only num_nonnulls catches.
create temp table forged as
select row('placed', :whB::uuid, 'manager',
           array[row(:locB1::uuid, -1, 'placed', 'rack', :whB::uuid, 'in_scope')::public.stock_draw_holding])::public.stock_draw as d;
grant select on forged to authenticated, service_role, anon;

set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select throws_ok(
  format($$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, draw)
           values (%L, %L, 'adjust', 0, 2, 2, 'F1 forged', (select d from forged))$$, :orgS, :itW),
  '42501', 'ledger_only', 'F1: a manager''s direct insert (the stock_movements insert policy passes) cannot carry a draw: 42501 ledger_only');
reset role;
set local "request.jwt.claim.sub" to '';
set local role to 'service_role';
select throws_ok(
  format($$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, draw)
           values (%L, %L, 'adjust', 0, 2, 2, 'F2 forged', (select d from forged))$$, :orgS, :itW),
  '42501', 'ledger_only', 'F2: nor can service_role outside a ledger transaction');
reset role;
select throws_ok(
  format($$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, draw)
           values (%L, %L, 'adjust', 0, 2, 2, 'F3 forged', (select d from forged))$$, :orgS, :itW),
  '42501', 'ledger_only', 'F3: nor can the owner (postgres) outside a ledger transaction');
select throws_ok(
  format($$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, draw)
           values (%L, %L, 'adjust', 0, 2, 2, 'F4 forged', row(null, null, null, null)::public.stock_draw)$$, :orgS, :itW),
  '42501', 'ledger_only', 'F4: a forged draw whose every field is NULL is refused too (num_nonnulls, not IS NOT NULL)');
savepoint f5;
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
select lives_ok(
  format($$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, notes, draw)
           values (%L, %L, 'adjust', 0, 2, 2, 'F5 in ledger', (select d from forged))$$, :orgS, :itW),
  'F5: the rule is the ledger flag, not the role: inside a ledger transaction the owner can write a draw (forging needs set_config in the same transaction, 0359''s trust basis)');
rollback to savepoint f5;
select throws_ok(
  format($$update public.stock_movements set draw = null where id = %L$$, pg_temp.mv(:itW, 'D31 wb')),
  '42501', 'draw_immutable', 'F6: the owner cannot clear a draw');
select throws_ok(
  format($$update public.stock_movements set draw = (select d from forged) where id = %L$$, pg_temp.mv(:itW, 'D31 wb')),
  '42501', 'draw_immutable', 'F7: nor rewrite it');
set local role to 'service_role';
select throws_ok(
  format($$update public.stock_movements set draw = null where id = %L$$, pg_temp.mv(:itW, 'D31 wb')),
  '42501', 'draw_immutable', 'F8: nor can service_role');
reset role;
select lives_ok(
  format($$update public.stock_movements set notes = 'F9 note', draw = draw where id = %L$$, pg_temp.mv(:itW, 'D31 wb')),
  'F9: an update that leaves the draw as it is (the note editor''s shape, plus draw = draw) goes through');
-- <rows an UPDATE of draw touched>|<rows a DELETE touched>, as the caller.
create function pg_temp.touch(p_id uuid) returns text language plpgsql as $f$
declare
  n1 int;
  n2 int;
begin
  update public.stock_movements set draw = null where id = p_id;
  get diagnostics n1 = row_count;
  delete from public.stock_movements where id = p_id;
  get diagnostics n2 = row_count;
  return n1 || '|' || n2;
end $f$;
create temp table f10 as select pg_temp.mv(:itW, 'D31 wb') as id;
grant select on f10 to authenticated;
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select is(
  pg_temp.touch((select id from f10)),
  '0|0',
  'F10: a manager''s UPDATE or DELETE through the API touches no movement (no UPDATE or DELETE policy)');
reset role;
select is(pg_temp.rows(pg_temp.mv(:itW, 'D31 wb')) || '|' || (select notes from public.stock_movements where id = pg_temp.mv(:itW, 'D31 wb')),
  '1:B1:-1:placed:manager|F9 note',
  'F11: after F6-F10 the WB draw is exactly as recorded');
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(format($$select ledger.apply_level_delta_for(%L, -1, 'placed', true, %L)$$, :itX, :u_stf),
  '42501', 'ledger_only', 'F12: a direct engine call by staff outside a ledger RPC: 42501 ledger_only');
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(format($$select ledger.apply_level_delta_for(%L, -1, 'placed', true, %L)$$, :itX, :u_out),
  '42501', 'forbidden', 'F13: a direct engine call by an org outsider: 42501 forbidden');
set local "request.jwt.claim.sub" to :u_stf;
select throws_ok(format($$select public.apply_level_delta(%L, 500)$$, :itX),
  '42501', 'ledger_only', 'F14: a direct call of the wrapper by staff: still 42501 ledger_only (0359 #34)');
set local "request.jwt.claim.sub" to :u_out;
select throws_ok(format($$select public.apply_level_delta(%L, -1)$$, :itX),
  '42501', 'forbidden', 'F15: a direct call of the wrapper by an outsider: still 42501 forbidden (0331)');
set local "request.jwt.claim.sub" to '';

-- RLS read parity. For every persona: the rows they can see through the view
-- are exactly the rows of the movements they can see (the draw straight from
-- the column), with literal counts. 25 rows exist: 24 on WA items (3 of them
-- naming a WB location) and 1 on the WB item.
create temp table vis (persona text, kind text, key text);
grant insert, select on vis to authenticated, anon;
create function pg_temp.collect(p_persona text) returns void language sql as $f$
  insert into vis select p_persona, 'mv', m.id::text from public.stock_movements m
   where m.organization_id in ('03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-000000000002');
  insert into vis select p_persona, 'h', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
   where h.organization_id in ('03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-000000000002');
  insert into vis select p_persona, 'col', m.id::text || ':' || g.seq
    from public.stock_movements m
    cross join lateral generate_series(1, coalesce(cardinality((m.draw).holdings), 0)) g(seq)
   where m.organization_id in ('03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-000000000002');
  insert into vis select p_persona, 'wb', h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
   where h.location_warehouse_id = '03730000-0000-0000-0000-0000000000b2' and h.item_warehouse_id = '03730000-0000-0000-0000-0000000000b1';
$f$;
grant execute on function pg_temp.collect(text) to authenticated, anon;
-- <rows seen>|<view rows = rows of the visible movements>|<view rows = the
-- visible movements' draws read straight from the column>
create function pg_temp.parity(p_persona text) returns text language sql as $f$
  select (select count(*) from vis where persona = p_persona and kind = 'h')::text || '|' ||
         (not exists (select v.key from vis v where v.persona = p_persona and v.kind = 'h'
                      except
                      select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                        join vis x on x.persona = p_persona and x.kind = 'mv' and x.key = h.movement_id::text)
          and not exists (select h.movement_id::text || ':' || h.seq from public.stock_movement_holdings h
                            join vis x on x.persona = p_persona and x.kind = 'mv' and x.key = h.movement_id::text
                          except
                          select v.key from vis v where v.persona = p_persona and v.kind = 'h'))::text || '|' ||
         (not exists (select key from vis where persona = p_persona and kind = 'h'
                      except select key from vis where persona = p_persona and kind = 'col')
          and not exists (select key from vis where persona = p_persona and kind = 'col'
                          except select key from vis where persona = p_persona and kind = 'h'))::text;
$f$;

set local "request.jwt.claim.sub" to :u_adm;
set local role to 'authenticated';
select pg_temp.collect('adm');
reset role;
select is(pg_temp.parity('adm'), '25|true|true',
  'F16: parity: an admin sees every row (all 25); view rows = rows of visible movements = their draws');
set local "request.jwt.claim.sub" to :u_mgr;
set local role to 'authenticated';
select pg_temp.collect('mgr');
reset role;
select is(pg_temp.parity('mgr'), '25|true|true',
  'F17: parity: a manager sees every row (all 25)');
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select pg_temp.collect('stf');
reset role;
select is(pg_temp.parity('stf'), '24|true|true',
  'F18: parity: WA staff see the 24 rows on WA items, not the row on the WB item');
set local "request.jwt.claim.sub" to :u_vwr;
set local role to 'authenticated';
select pg_temp.collect('vwr');
reset role;
select is(pg_temp.parity('vwr'), '1|true|true',
  'F19: parity: the WB viewer sees only the row on the WB item');
set local "request.jwt.claim.sub" to :u_aud;
set local role to 'authenticated';
select pg_temp.collect('aud');
reset role;
select is(pg_temp.parity('aud'), '25|true|true',
  'F20: parity: a viewer holding activity_logs:read (no warehouse) sees every row');
set local "request.jwt.claim.sub" to :u_out;
set local role to 'authenticated';
select pg_temp.collect('out');
reset role;
select is(pg_temp.parity('out'), '0|true|true',
  'F21: parity: an outsider sees nothing');
select is((select count(*)::int from vis where persona = 'stf' and kind = 'wb'), 3,
  'F22: WA staff see the three rows on WA items that name a WB location (two draws from the WB rack, the scrap from WB Staging), exactly as the first build showed them');
set local "request.jwt.claim.sub" to '';

set local role to 'anon';
select throws_ok($$select count(*) from public.stock_movement_holdings$$,
  '42501', null, 'F23: anon cannot read the view at all');
select is((select count(*)::int from public.stock_movements where num_nonnulls(draw) = 1), 0,
  'F24: anon sees no movement, so no draw');
reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- R (continued). The reachable path: WA staff through public.adjust_stock,
-- the phone and API shape. After F so the parity counts above are untouched.
-- itX holds A1=1, S=1, SA=4, SB=3 (on hand 9) here.
-- ══════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to :u_stf;
set local role to 'authenticated';
select lives_ok(format($$select public.adjust_stock(%L, -0.00001, 'remove', null, 'R tiny minus', null, 'any')$$, :itX),
  'R10: WA staff removes 0.00001 in mode any');
select lives_ok(format($$select public.adjust_stock(%L, 0.00004, 'adjust', null, 'R tiny plus', null)$$, :itX),
  'R11: WA staff adds 0.00004 with no location');
select lives_ok(format($$select public.adjust_stock(%L, -1.00001, 'remove', null, 'R spill', null)$$, :itX),
  'R12: WA staff removes 1.00001: A1 empties, the remainder spills onto the Site');
select lives_ok(format($$select public.adjust_stock(%L, -0.00005, 'remove', null, 'R half', null, 'any')$$, :itX),
  'R13: WA staff removes an exact half (0.00005)');
reset role;
select is(
  (select string_agg(m.reason || ':' || m.quantity_change::text || ':' || (m.new_quantity - m.previous_quantity)::text
                     || '[' || pg_temp.rows4(m.id) || ']', ' ' order by m.reason collate "C")
     from public.stock_movements m where m.item_id = :itX and m.reason like 'R %')
  || ' | ' || pg_temp.snap4(:itX),
  'R half:-0.0001:0.0000[] R spill:-1.0000:-1.0000[1:A1:-1.0000:placed] R tiny minus:0.0000:0.0000[] R tiny plus:0.0000:0.0000[] | A1=0.0000,A2=0.0000,B1=0.0000,S=1.0000,SA=4.0000,SB=3.0000,UA=0.0000',
  'R14: the four movements exist as before 0373; only the spill records a row (A1 -1); the Site, touched by 0.00001 and 0.00005, never moved');
select is(
  (select count(*)::int || '|' || bool_and(x.q = x.d)::text
     from (select m.id, m.new_quantity - m.previous_quantity as d,
                  (select sum(h.quantity) from public.stock_movement_holdings h where h.movement_id = m.id) as q
             from public.stock_movements m
            where m.organization_id = :orgS
              and exists (select 1 from public.stock_movement_holdings h where h.movement_id = m.id)) x),
  '19|true',
  'R15: every movement with a draw in this file: its rows sum EXACTLY to its new_quantity - previous_quantity');

-- ══════════════════════════════════════════════════════════════════════════
-- S. THE SCOPE CACHE. ledger._seal asks the manager answer once per
-- (transaction, drawer, organization) and, below manager, the location
-- answer once per (location organization, warehouse) or, for an increment,
-- per Staging location; a miss restates the live predicates in one
-- statement. S1 pins what the restatement was proven against; S2-S4 prove
-- it equals them; S5-S6 count; S7-S13 prove when an answer is dropped.
-- ══════════════════════════════════════════════════════════════════════════
select is(
  (select string_agg(p.proname || ':' || md5(p.prosrc) || ':' || p.provolatile::text, ',' order by p.proname)
     from pg_proc p where p.oid in ('public.has_org_role(uuid,text)'::regprocedure,
                                    'public.caller_can_write_location(uuid)'::regprocedure,
                                    'public.is_org_member(uuid)'::regprocedure,
                                    'public.user_can_access_warehouse(uuid,uuid,text)'::regprocedure))
  || '|' || exists (select 1 from pg_constraint c
                     where c.conrelid = 'public.organization_members'::regclass and c.contype in ('u', 'p')
                       and (select array_agg(a.attname::text order by a.attname) from unnest(c.conkey) k(attnum)
                              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
                           = array['organization_id', 'user_id'])::text,
  'caller_can_write_location:188634bf8552a0064bfbf1ebfecf814f:s,has_org_role:10422b29a6e15acd003d4f11ed28e90c:s,is_org_member:76492a6556e9f6a7c33d942aa9726f9f:s,user_can_access_warehouse:76b4170f3d393e8a1f293ca3d4895955:s|true',
  'S1: the four predicates ledger._seal restates are the text and volatility it was proven against, and organization_members is unique on (organization_id, user_id) (has_org_role''s limit 1 row is the only row). The preflight refuses the same drift at push time. If this fails, re-prove _seal (S2-S4) before updating both pins');

-- Nine locations: WA rack, WA Unplaced, WA Staging, the home Site, the WB
-- rack, the foreign rack, a foreign org-level location, a home location in
-- the FOREIGN warehouse (the location's organization is not the warehouse's:
-- is_org_member asks the first, user_can_access_warehouse the second), and
-- no location.
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locFS, :orgF, null, 'FS 0373', 'warehouse', null),
  (:locX1, :orgS, :whF, 'X1 0373', 'other', 'rack');
insert into lbl values (:locFS, 'FS'), (:locX1, 'X1');
create temp table s_locs as
select array[:locA1::uuid,
             (select id from public.locations where warehouse_id = :whA and kind = 'unplaced'),
             (select id from public.locations where warehouse_id = :whA and kind = 'staging'),
             :locS::uuid, :locB1::uuid, :locF::uuid, :locFS::uuid, :locX1::uuid, null::uuid] as locs;

-- _seal called directly (as the engine's owner) for one persona, with the
-- cache emptied first, keyed by pair (the draw loops' shape) or by location
-- (the increment's shape). Reports <tag:scope per holding>, then whether
-- every scope equals the LIVE formula (auth.uid() null -> service,
-- has_org_role(org, manager) -> manager, caller_can_write_location ->
-- in/out), then whether both key shapes agree.
create function pg_temp.mirror_one(p_sub text, p_by_location boolean) returns text language plpgsql as $f$
declare
  v_h    public.stock_draw_holding[];
  v_o    uuid[];
  v_d    public.stock_draw;
  v_rows text;
  v_live boolean;
begin
  perform set_config('request.jwt.claim.sub', p_sub, true);
  perform set_config('stockpilot.draw_scope', '', true);
  select array_agg(row(x.loc, -1, 'placed', l.kind, l.warehouse_id, null)::public.stock_draw_holding order by x.o),
         array_agg(case when p_by_location then null else l.organization_id end order by x.o)
    into v_h, v_o
    from unnest((select s.locs from s_locs s)) with ordinality as x(loc, o)
    left join public.locations l on l.id = x.loc;
  v_d := ledger._seal(nullif(p_sub, '')::uuid, '03730000-0000-0000-0000-000000000001',
                      '03730000-0000-0000-0000-0000000000b1', 'placed', v_h, v_o);
  select string_agg(pg_temp.tag(h.location_id) || ':'
                    || case coalesce(h.actor_scope, (v_d).actor_scope)
                         when 'service' then 'svc' when 'manager' then 'mgr'
                         when 'in_scope' then 'in' when 'out_of_scope' then 'out' else '?' end, ',' order by h.seq),
         bool_and(coalesce(h.actor_scope, (v_d).actor_scope)
                  = case when auth.uid() is null then 'service'
                         when public.has_org_role('03730000-0000-0000-0000-000000000001', 'manager') then 'manager'
                         when public.caller_can_write_location(h.location_id) then 'in_scope'
                         else 'out_of_scope' end)
    into v_rows, v_live
    from unnest((v_d).holdings) with ordinality
         as h(location_id, quantity, step, location_kind, location_warehouse_id, actor_scope, seq);
  perform set_config('stockpilot.draw_scope', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_rows || '#live=' || v_live::text;
end $f$;
create function pg_temp.mirror(p_name text, p_sub text) returns text language sql as $f$
  select p_name || '=' || pg_temp.mirror_one(p_sub, false)
         || '#same_by_location=' || (pg_temp.mirror_one(p_sub, false) = pg_temp.mirror_one(p_sub, true))::text;
$f$;

select is(
  pg_temp.mirror('service', '') || E'\n' || pg_temp.mirror('admin', :u_adm) || E'\n'
  || pg_temp.mirror('manager', :u_mgr) || E'\n' || pg_temp.mirror('impersonating', :u_imp),
  $s$service=A1:svc,UA:svc,SA:svc,S:svc,B1:svc,F1:svc,FS:svc,X1:svc,null:svc#live=true#same_by_location=true
admin=A1:mgr,UA:mgr,SA:mgr,S:mgr,B1:mgr,F1:mgr,FS:mgr,X1:mgr,null:mgr#live=true#same_by_location=true
manager=A1:mgr,UA:mgr,SA:mgr,S:mgr,B1:mgr,F1:mgr,FS:mgr,X1:mgr,null:mgr#live=true#same_by_location=true
impersonating=A1:mgr,UA:mgr,SA:mgr,S:mgr,B1:mgr,F1:mgr,FS:mgr,X1:mgr,null:mgr#live=true#same_by_location=true$s$,
  'S2: service, an admin, a manager and a manager inside a live impersonation window: one answer for the whole draw, equal to the live predicates');
select is(
  pg_temp.mirror('staff', :u_stf) || E'\n' || pg_temp.mirror('staff_no_wh', :u_stn) || E'\n'
  || pg_temp.mirror('two_org', :u_two) || E'\n' || pg_temp.mirror('two_org_expired', :u_tx),
  $s$staff=A1:in,UA:in,SA:in,S:in,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
staff_no_wh=A1:out,UA:out,SA:out,S:in,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
two_org=A1:in,UA:in,SA:in,S:in,B1:out,F1:in,FS:in,X1:in,null:out#live=true#same_by_location=true
two_org_expired=A1:in,UA:in,SA:in,S:in,B1:out,F1:out,FS:out,X1:in,null:out#live=true#same_by_location=true$s$,
  'S3: staff personas equal the live predicates per location: WA staff; staff with no warehouse (only org-level); a foreign manager who is WA staff at home (X1 is in scope through the WAREHOUSE''s organization); and one whose foreign membership expired (user_can_access_warehouse has no impersonation filter, is_org_member does)');
select is(
  pg_temp.mirror('viewer', :u_vwr) || E'\n' || pg_temp.mirror('auditor', :u_aud) || E'\n'
  || pg_temp.mirror('outsider', :u_out) || E'\n' || pg_temp.mirror('disabled', :u_dis) || E'\n'
  || pg_temp.mirror('disabled_manager', :u_dsm) || E'\n' || pg_temp.mirror('expired', :u_exp) || E'\n' || pg_temp.mirror('pending', :u_pnd),
  $s$viewer=A1:out,UA:out,SA:out,S:in,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
auditor=A1:out,UA:out,SA:out,S:in,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
outsider=A1:out,UA:out,SA:out,S:out,B1:out,F1:in,FS:in,X1:out,null:out#live=true#same_by_location=true
disabled=A1:out,UA:out,SA:out,S:out,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
disabled_manager=A1:out,UA:out,SA:out,S:out,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
expired=A1:out,UA:out,SA:out,S:out,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true
pending=A1:out,UA:out,SA:out,S:out,B1:out,F1:out,FS:out,X1:out,null:out#live=true#same_by_location=true$s$,
  'S4: below the write floor or outside: the WB viewer and the auditor (only the org-level Site), the foreign manager (only foreign locations), a disabled member, a disabled manager, an expired impersonation and a pending invite (nothing): all equal the live predicates');

-- S5. Each answer is asked once per transaction: a second seal of the same
-- holdings reads organization_members zero times. Reports <the first seal
-- read it>,<reads by the second>,<pair answers cached>.
create function pg_temp.member_reads() returns bigint language sql stable as $f$
  select coalesce(t.seq_scan, 0) + coalesce(t.idx_scan, 0)
    from pg_stat_xact_user_tables t where t.relid = 'public.organization_members'::regclass;
$f$;
create function pg_temp.seal_twice(p_sub uuid) returns text language plpgsql as $f$
declare
  v_h  public.stock_draw_holding[];
  v_o  uuid[];
  r0   bigint;
  r1   bigint;
  r2   bigint;
  v_c  text;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('stockpilot.draw_scope', '', true);
  select array_agg(row(l.id, -1, 'placed', l.kind, l.warehouse_id, null)::public.stock_draw_holding order by x.o),
         array_agg(l.organization_id order by x.o)
    into v_h, v_o
    from unnest((select (s.locs)[1:5] from s_locs s)) with ordinality as x(loc, o)
    join public.locations l on l.id = x.loc;
  r0 := pg_temp.member_reads();
  perform ledger._seal(p_sub, '03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-0000000000b1', 'placed', v_h, v_o);
  r1 := pg_temp.member_reads();
  v_c := current_setting('stockpilot.draw_scope', true);
  perform ledger._seal(p_sub, '03730000-0000-0000-0000-000000000001', '03730000-0000-0000-0000-0000000000b1', 'placed', v_h, v_o);
  r2 := pg_temp.member_reads();
  perform set_config('stockpilot.draw_scope', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return (r1 > r0)::text || ',' || (r2 - r1) || ',' || ((length(v_c) - length(replace(v_c, '|p:', ''))) / 3);
end $f$;
select is(pg_temp.seal_twice(:u_stf) || ' | ' || pg_temp.seal_twice(:u_mgr),
  'true,0,3 | true,0,0',
  'S5: WA staff over five holdings in three pairs: the first seal asks (three pair answers cached), the second reads nothing; a manager: one answer, then nothing');

-- S6. Real engine draws as WA staff (the ledger flag raised by hand): six
-- holdings over three pairs, and a +1 keyed by its Staging location. Each in
-- a subtransaction that is rolled back; reports the rows, then the cache:
-- pair and location answers held, and the head (M or S).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
values ('03730000-0000-0000-0000-0000000000cb', :orgS, :whA, 'PV-0373-S', 'Scope Item 0373', 6, 'active', 'none'),
       (:itQ, :orgS, :whA, 'PV-0373-Q', 'Cache Item 0373', 20, 'active', 'none');
delete from public.item_stock_levels where item_id in ('03730000-0000-0000-0000-0000000000cb', :itQ);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :orgS, '03730000-0000-0000-0000-0000000000cb', x.loc, 1
  from unnest(array[:locA1::uuid, :locP1::uuid, :locP2::uuid, :locS::uuid, :locB1::uuid,
                    (select id from public.locations where warehouse_id = :whA and kind = 'unplaced')]) x(loc);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values (:orgS, :itQ, :locA1, 20);
create function pg_temp.draw_and_cache(p_call text) returns text language plpgsql as $f$
declare
  v text;
  c text;
begin
  begin
    execute p_call into v;
    c := current_setting('stockpilot.draw_scope', true);
    raise exception using errcode = 'ZX373';
  exception
    when sqlstate 'ZX373' then null;
  end;
  return pg_temp.drows(nullif(v, '')::public.stock_draw)
         || '#pairs=' || ((length(c) - length(replace(c, '|p:', ''))) / 3)
         || '#locations=' || ((length(c) - length(replace(c, '|l:', ''))) / 3)
         || '#head=' || split_part(c, '|', 2);
end $f$;
set local "request.jwt.claim.sub" to :u_stf;
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
select is(
  pg_temp.draw_and_cache(format($$select ledger.apply_level_delta_for('03730000-0000-0000-0000-0000000000cb', -6, 'placed', true, %L)::text$$, :u_stf))
  || ' | ' || pg_temp.draw_and_cache(format($$select ledger.apply_level_delta_for(%L, 1, 'placed', true, %L)::text$$, :itQ, :u_stf)),
  '1:A1:-1:placed:in_scope,2:P1:-1:placed:in_scope,3:P2:-1:placed:in_scope,4:S:-1:placed:in_scope,5:B1:-1:placed:out_of_scope,6:UA:-1:placed:in_scope#pairs=3#locations=0#head=S'
  || ' | 1:SA:1:increment:in_scope#pairs=0#locations=1#head=S',
  'S6: a WA staff draw over six holdings asks three pair answers (WA, the org-level Site, WB), not six; a +1 asks one, keyed by its Staging location');

-- S7. The transaction's own changes take effect at the next draw: -1 draws
-- of a WA rack by WA staff, around an assignment removed and restored and a
-- promotion and demotion, all in this one transaction.
create function pg_temp.scope1(p_item uuid, p_uid uuid) returns text language sql as $f$
  select coalesce(((x.d).holdings[1]).actor_scope, (x.d).actor_scope)
    from (select ledger.apply_level_delta_for(p_item, -1, 'placed', true, p_uid) as d) x;
$f$;
create temp table s7 (step int, scope text);
insert into s7 select 1, pg_temp.scope1(:itQ, :u_stf);
delete from public.user_warehouse_assignments where user_id = :u_stf and warehouse_id = :whA;
insert into s7 select 2, pg_temp.scope1(:itQ, :u_stf);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) values (:orgS, :u_stf, :whA);
insert into s7 select 3, pg_temp.scope1(:itQ, :u_stf);
update public.organization_members set role = 'manager' where organization_id = :orgS and user_id = :u_stf;
insert into s7 select 4, pg_temp.scope1(:itQ, :u_stf);
update public.organization_members set role = 'staff' where organization_id = :orgS and user_id = :u_stf;
insert into s7 select 5, pg_temp.scope1(:itQ, :u_stf);
select is((select string_agg(scope, ',' order by step) from s7),
  'in_scope,out_of_scope,in_scope,manager,in_scope',
  'S7: within one transaction, removing the assignment makes the next draw out_of_scope, restoring it in_scope, a promotion manager, the demotion in_scope again');

-- S8. Every forget trigger, per event, on a statement that touches no row
-- (statement triggers fire anyway): cleared, or kept where the column list
-- excludes it (and on locations INSERT, by design).
create function pg_temp.forgets(p_stmt text) returns text language plpgsql as $f$
begin
  perform set_config('stockpilot.draw_scope', 'planted', true);
  execute p_stmt;
  return case when current_setting('stockpilot.draw_scope', true) = 'planted' then 'kept' else 'cleared' end;
end $f$;
select is(
  'om:ins=' || pg_temp.forgets('insert into public.organization_members (organization_id, user_id, role) select organization_id, user_id, role from public.organization_members where false')
  || ',upd=' || pg_temp.forgets('update public.organization_members set role = role where false')
  || ',del=' || pg_temp.forgets('delete from public.organization_members where false')
  || ' uwa:ins=' || pg_temp.forgets('insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id) select organization_id, user_id, warehouse_id from public.user_warehouse_assignments where false')
  || ',upd=' || pg_temp.forgets('update public.user_warehouse_assignments set warehouse_id = warehouse_id where false')
  || ',del=' || pg_temp.forgets('delete from public.user_warehouse_assignments where false')
  || ' up:ins=' || pg_temp.forgets('insert into public.user_profiles (id) select id from public.user_profiles where false')
  || ',upd_disabled_at=' || pg_temp.forgets('update public.user_profiles set disabled_at = disabled_at where false')
  || ',upd_id=' || pg_temp.forgets('update public.user_profiles set id = id where false')
  || ',upd_other=' || pg_temp.forgets('update public.user_profiles set full_name = full_name where false')
  || ',del=' || pg_temp.forgets('delete from public.user_profiles where false')
  || ' wh:ins=' || pg_temp.forgets('insert into public.warehouses (organization_id, name, code) select organization_id, name, code from public.warehouses where false')
  || ',upd_org=' || pg_temp.forgets('update public.warehouses set organization_id = organization_id where false')
  || ',upd_id=' || pg_temp.forgets('update public.warehouses set id = id where false')
  || ',upd_other=' || pg_temp.forgets('update public.warehouses set name = name where false')
  || ',del=' || pg_temp.forgets('delete from public.warehouses where false')
  || ' loc:ins=' || pg_temp.forgets('insert into public.locations (organization_id, name, type) select organization_id, name, type from public.locations where false')
  || ',upd_org=' || pg_temp.forgets('update public.locations set organization_id = organization_id where false')
  || ',upd_wh=' || pg_temp.forgets('update public.locations set warehouse_id = warehouse_id where false')
  || ',upd_id=' || pg_temp.forgets('update public.locations set id = id where false')
  || ',upd_other=' || pg_temp.forgets('update public.locations set name = name where false')
  || ',del=' || pg_temp.forgets('delete from public.locations where false'),
  'om:ins=cleared,upd=cleared,del=cleared uwa:ins=cleared,upd=cleared,del=cleared up:ins=cleared,upd_disabled_at=cleared,upd_id=cleared,upd_other=kept,del=cleared wh:ins=cleared,upd_org=cleared,upd_id=cleared,upd_other=kept,del=cleared loc:ins=kept,upd_org=cleared,upd_wh=cleared,upd_id=cleared,upd_other=kept,del=cleared',
  'S8: each forget trigger clears the cache on every event that can change an answer, and only those');

-- S9. Another drawer in the same transaction recomputes (the drawer is in
-- the key).
create temp table s9 (step int, scope text);
insert into s9 select 1, pg_temp.scope1(:itQ, :u_stf);
set local "request.jwt.claim.sub" to :u_mgr;
insert into s9 select 2, pg_temp.scope1(:itQ, :u_mgr);
set local "request.jwt.claim.sub" to :u_stf;
insert into s9 select 3, pg_temp.scope1(:itQ, :u_stf);
select is((select string_agg(scope, ',' order by step) from s9), 'in_scope,manager,in_scope',
  'S9: WA staff, then a manager, then WA staff again in one transaction: each draw has its own drawer''s scope');

-- S10. Another organization recomputes (the organization is in the key): the
-- two-org persona manages the foreign org and is WA staff at home.
create temp table s10 (step int, scope text);
set local "request.jwt.claim.sub" to :u_two;
insert into s10 select 1, pg_temp.scope1(:itF, :u_two);
insert into s10 select 2, pg_temp.scope1(:itQ, :u_two);
select is((select string_agg(scope, ',' order by step) from s10), 'manager,in_scope',
  'S10: the same drawer draws in the foreign org (manager there), then at home (WA staff): the home draw is in_scope, not the foreign answer');

-- S11. A cached value binds to this transaction, this drawer and this
-- organization: a planted value for another transaction id, with no
-- transaction id, for another drawer or for another organization is ignored.
-- The last one (this transaction, drawer and organization) is trusted: the
-- trust basis is that only set_config inside the same transaction can plant
-- it, exactly as for ledger.active() (0359's census, INV-40).
set local "request.jwt.claim.sub" to :u_stf;
create temp table s11 (step int, scope text);
select set_config('stockpilot.draw_scope', '1/' || :u_stf || '/' || :orgS || '|M|', true);
insert into s11 select 1, pg_temp.scope1(:itQ, :u_stf);
select set_config('stockpilot.draw_scope', :u_stf || '/' || :orgS || '|M|', true);
insert into s11 select 2, pg_temp.scope1(:itQ, :u_stf);
select set_config('stockpilot.draw_scope', pg_current_xact_id()::text || '/' || :u_mgr || '/' || :orgS || '|M|', true);
insert into s11 select 3, pg_temp.scope1(:itQ, :u_stf);
select set_config('stockpilot.draw_scope', pg_current_xact_id()::text || '/' || :u_stf || '/' || :orgF || '|M|', true);
insert into s11 select 4, pg_temp.scope1(:itQ, :u_stf);
select set_config('stockpilot.draw_scope', pg_current_xact_id()::text || '/' || :u_stf || '/' || :orgS || '|M|', true);
insert into s11 select 5, pg_temp.scope1(:itQ, :u_stf);
select is((select string_agg(scope, ',' order by step) from s11),
  'in_scope,in_scope,in_scope,in_scope,manager',
  'S11: planted values for another transaction, with no transaction id, for another drawer or another organization are ignored; one bound to this transaction, drawer and organization is read');

-- S12. A rolled-back savepoint discards what it cached; a released one keeps
-- it. Reports <cached inside>,<after rollback>,<after release>.
create function pg_temp.sp_probe() returns text language plpgsql as $f$
declare
  v_in  text;
  v_rb  text;
  v_rel text;
begin
  perform set_config('stockpilot.draw_scope', '', true);
  begin
    perform pg_temp.scope1('03730000-0000-0000-0000-0000000000cd', '03730000-0000-0000-0000-0000000000a3');
    v_in := current_setting('stockpilot.draw_scope', true);
    raise exception using errcode = 'ZX378';
  exception
    when sqlstate 'ZX378' then null;
  end;
  v_rb := current_setting('stockpilot.draw_scope', true);
  begin
    perform pg_temp.scope1('03730000-0000-0000-0000-0000000000cd', '03730000-0000-0000-0000-0000000000a3');
  exception
    when sqlstate 'ZX379' then null;
  end;
  v_rel := current_setting('stockpilot.draw_scope', true);
  return (v_in like '%|p:%=I|')::text || ',' || coalesce(nullif(v_rb, ''), 'empty') || ',' || (v_rel like '%|p:%=I|')::text;
end $f$;
select is(pg_temp.sp_probe(), 'true,empty,true',
  'S12: answers cached inside a rolled-back savepoint are discarded with it; a released savepoint keeps them');

-- S13. The non-recording wrapper (post_cycle_count's path) never touches the
-- cache.
select set_config('stockpilot.draw_scope', 'planted', true);
select lives_ok(format($$select public.apply_level_delta(%L, -1)$$, :itQ), 'S13: WA staff draws through the wrapper');
select is(current_setting('stockpilot.draw_scope', true) || '|' || pg_temp.snap(:itQ), 'planted|A1=4',
  'S14: the wrapper moved the holding and left the cache alone (record = false never seals)');
select set_config('stockpilot.ledger', '', true);
select set_config('stockpilot.draw_scope', '', true);
set local "request.jwt.claim.sub" to '';

select * from finish();
rollback;
