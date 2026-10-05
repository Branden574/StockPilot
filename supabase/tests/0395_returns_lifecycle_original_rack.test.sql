-- supabase/tests/0395_returns_lifecycle_original_rack.test.sql
-- pgTAP proof for migration 0395 (returns and exchanges, slice RX-1): every
-- RMA transition runs through a gated SECURITY DEFINER function, the database
-- follows returns:manage, raw API writes keep only the old tabs' shapes, and a
-- returned unit goes back to the rack it was really picked from, revalidated
-- under lock, in one transaction (plan section 4 RX-1; brief 36-40, 42, 43).
--
-- Personas (org A, plus org Z for foreign checks):
--   own     owner                   mgr      manager, no override
--   mgrNo   manager, returns:manage revoked (user override false)
--   stfRm   staff granted returns:manage, assigned to whA (write)
--   stfRmNoWh  staff granted returns:manage, no warehouse
--   stfRd   staff granted returns:read only, assigned to whA
--   stf     staff, no grant, assigned       vwr  viewer, assigned
--   dis     manager whose account is disabled
--   outZ    manager of org Z
--   mgrAZ   manager of org A and of org Z (the two-organization member)
--
-- S.  The pick: complete_picking draws seven lines from their racks (recorded
--     draws, stamped to the order), and confirm_physical_signature hands the
--     order over.
-- A.  Shape and grants: anon nothing; authenticated SELECT and INSERT on both
--     tables, UPDATE on exactly eight returns columns, nothing else; the
--     decision log and the view SELECT only; EXECUTE on the public RPCs only
--     (the requester create for service_role only); every ledger helper
--     SECURITY INVOKER with no API EXECUTE (0359 test 15 still four); the
--     view's column order; INV-25, 0367 and the search_path pin for every new
--     function; the restated body's md5 and its reverse-replace proof.
-- B.  Gates (brief 42: revocation, disabled): unauthenticated, anon, foreign
--     and missing, module off, the revoked manager (RPCs and raw policies),
--     staff granted returns:manage with and without warehouse write, and
--     refused on another warehouse's RMA by every function (desk check F2),
--     returns:read only, disabled, viewer, and the restock read's gate.
-- C.  Create: one transaction, idempotency, the cap, the requester path
--     forcing restock and copying identity, the RMA number key, exchange
--     input refused, shape errors, the counter channel.
-- D.  Approval, deny, receive, cancel and plans: revision and key replay,
--     every line needs a decision, scrap carries no destination, an identical
--     plan appends nothing, receive and close answer "already", the counter
--     approve-and-receive.
-- E.  Acceptance 36, inbound half (C1): approval moves nothing; the close puts
--     the unit back on 31-C (on hand +1, 31-C +1, Staging +0).
-- F.  Acceptance 37 (Staging).   G.  Acceptance 38 (Scrap) and G16 pinned.
-- H.  Acceptance 39 (not recorded: no draw, reopened, duplicate line, drawn
--     mismatch; Staging, Unplaced and a Site never offered).
-- I.  Acceptance 40 (rack archived after approval, then moved, no longer a
--     placement, warehouse inactive, item deleted): the close raises, nothing
--     moves, a re-plan to Staging closes; every refusal of the close carries
--     a hint, and a rack the closer may not stock is its own refusal (F7).
-- J.  Several sources: full remainder, partial with a manager choice capped
--     at its remaining, rule 9 (two pending RMAs, room for one), a forged leg
--     sum.
-- K.  Direct writes (brief 42) and the old tabs' raw edges; the raw paths
--     bounded by the order's warehouse (F2) and tied to the order's
--     organization and lines (F3).
-- L.  Regression: frozen bodies and triggers, organization deletion, holdings
--     equal on hand for every item touched, the 0359 flag census.
--
-- MUTATION TABLE (stockpilot-work/returns-exchange/mutate-0395.py; each must
-- fail the named lines):
--   M1  the write policies keep has_org_role (manager)               -> A15, B6
--   M2  the create swallows the exchange hook's refusal after the
--       header and line were written (two outcomes, one call)        -> C5
--   M3  approve calls the ledger (the wrapper) before answering      -> E2
--   M4  the rack branch lands in Staging (calls the Staging leg)     -> E5
--   M5  the resolver reads bin_location                              -> H4
--   M6  a failed revalidation falls back to Staging silently         -> I2
--   M7  rule 9 caps the leg to the remaining instead of raising      -> J7, J8
--   M8  the API guard lets an insert at received through             -> K1
--   M9  the API guard lets a PATCH into closed through               -> K3
--   M10 the decision log loses its append-only trigger               -> K6
--   M11 the restated body keeps has_org_role instead of the permission -> A21, B5 (wrapper)
--   M12 create_requester_return_request keeps the client disposition -> C6
--   M13 approve_return skips the revision check                     -> D4
--   M14 return_line_sources ignores the reopen rule                  -> H5
--   M15 the restated body skips the warehouse write check            -> A21, B8 (wrapper)
--   M17 the write policies drop the warehouse term (F2)              -> K10
--   M18 the API guard skips the insert's warehouse check (F2)        -> K10
--   M19 the API guard skips the RMA-order organization tie (F3)      -> K11
--   M20 the line guard skips the line-order tie (F3)                 -> K11
--   M21 close_return passes the body's bare tokens through (F7)      -> I6
--   M22 the rack leg leaves the location gate to the bare writer (F7) -> I7
--   M23 the create passes the cap trigger's bare token through (F7)  -> race 5b
--   M24 the rack leg does not lock the locations' warehouses (F8)    -> race 4c
--   M25 the reopen rule counts a direct (via_ledger false) row (F9)  -> H7
--   M26 the requester create lets a missing actor channel through (F10) -> C12
--   M27 approve_return trusts a key row it did not complete (F11)     -> D12
--   M28 the create replays an RMA of another organization or order (F11) -> C13
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt / pg_temp.try_rpc (always undone) or pg_temp.rpc /
-- pg_temp.call_as / pg_temp.write_as (kept), which switch role and claims with
-- set_config inside a subtransaction (the 0387 helpers), so pgTAP's own
-- bookkeeping never runs as an API role. begin/rollback: nothing leaks.
-- Namespace 03950000.

begin;

select plan(114);

\set orgA      '\'03950000-0000-0000-0000-00000000000a\''
\set orgZ      '\'03950000-0000-0000-0000-00000000000b\''
\set own       '\'03950000-0000-0000-0000-0000000000a0\''
\set mgr       '\'03950000-0000-0000-0000-0000000000a1\''
\set mgrNo     '\'03950000-0000-0000-0000-0000000000a2\''
\set stfRm     '\'03950000-0000-0000-0000-0000000000a3\''
\set stfRmNoWh '\'03950000-0000-0000-0000-0000000000a4\''
\set stfRd     '\'03950000-0000-0000-0000-0000000000a5\''
\set stf       '\'03950000-0000-0000-0000-0000000000a6\''
\set vwr       '\'03950000-0000-0000-0000-0000000000a7\''
\set dis       '\'03950000-0000-0000-0000-0000000000a8\''
\set outZ      '\'03950000-0000-0000-0000-0000000000b1\''
\set mgrAZ     '\'03950000-0000-0000-0000-0000000000a9\''
\set whA       '\'03950000-0000-0000-0000-0000000000d1\''
\set whB       '\'03950000-0000-0000-0000-0000000000d2\''
\set whZ       '\'03950000-0000-0000-0000-0000000000d3\''
\set r31C      '\'03950000-0000-0000-0000-000000000c31\''
\set r32A      '\'03950000-0000-0000-0000-000000000c32\''
\set r33B      '\'03950000-0000-0000-0000-000000000c33\''
\set r34A      '\'03950000-0000-0000-0000-000000000c34\''
\set r35B      '\'03950000-0000-0000-0000-000000000c35\''
\set r40       '\'03950000-0000-0000-0000-000000000c40\''
\set r41       '\'03950000-0000-0000-0000-000000000c41\''
\set rOther    '\'03950000-0000-0000-0000-000000000c42\''
\set siteA     '\'03950000-0000-0000-0000-000000000c50\''
\set rB1       '\'03950000-0000-0000-0000-000000000c51\''
\set itM       '\'03950000-0000-0000-0000-000000000e01\''
\set itS       '\'03950000-0000-0000-0000-000000000e02\''
\set itScr     '\'03950000-0000-0000-0000-000000000e03\''
\set itC2      '\'03950000-0000-0000-0000-000000000e04\''
\set itP       '\'03950000-0000-0000-0000-000000000e05\''
\set itR       '\'03950000-0000-0000-0000-000000000e06\''
\set itV       '\'03950000-0000-0000-0000-000000000e07\''
\set itK       '\'03950000-0000-0000-0000-000000000e08\''
\set itU       '\'03950000-0000-0000-0000-000000000e09\''
\set itG       '\'03950000-0000-0000-0000-000000000e0a\''
\set itX       '\'03950000-0000-0000-0000-000000000e0b\''
\set itX2      '\'03950000-0000-0000-0000-000000000e0c\''
\set itZ       '\'03950000-0000-0000-0000-000000000e0d\''
\set itW       '\'03950000-0000-0000-0000-000000000e0e\''
\set oA        '\'03950000-0000-0000-0000-000000000101\''
\set oK        '\'03950000-0000-0000-0000-000000000102\''
\set oU        '\'03950000-0000-0000-0000-000000000103\''
\set oG        '\'03950000-0000-0000-0000-000000000104\''
\set oX        '\'03950000-0000-0000-0000-000000000105\''
\set oZ        '\'03950000-0000-0000-0000-000000000106\''
\set oPend     '\'03950000-0000-0000-0000-000000000107\''
\set oB        '\'03950000-0000-0000-0000-000000000108\''
\set oW        '\'03950000-0000-0000-0000-000000000109\''
\set lM        '\'03950000-0000-0000-0000-000000000201\''
\set lS        '\'03950000-0000-0000-0000-000000000202\''
\set lScr      '\'03950000-0000-0000-0000-000000000203\''
\set lC2       '\'03950000-0000-0000-0000-000000000204\''
\set lP        '\'03950000-0000-0000-0000-000000000205\''
\set lR        '\'03950000-0000-0000-0000-000000000206\''
\set lV        '\'03950000-0000-0000-0000-000000000207\''
\set lK        '\'03950000-0000-0000-0000-000000000208\''
\set lU        '\'03950000-0000-0000-0000-000000000209\''
\set lG        '\'03950000-0000-0000-0000-00000000020a\''
\set lX1       '\'03950000-0000-0000-0000-00000000020b\''
\set lX2       '\'03950000-0000-0000-0000-00000000020c\''
\set lZ        '\'03950000-0000-0000-0000-00000000020d\''
\set lPend     '\'03950000-0000-0000-0000-00000000020e\''
\set lB        '\'03950000-0000-0000-0000-00000000020f\''
\set lB2       '\'03950000-0000-0000-0000-000000000210\''
\set lW        '\'03950000-0000-0000-0000-000000000211\''
\set kOld      '\'03950000-0000-0000-0000-000000000901\''
\set kOld2     '\'03950000-0000-0000-0000-000000000902\''
\set kOld3     '\'03950000-0000-0000-0000-000000000903\''
\set nobody    '\'03950000-0000-0000-0000-0000000009ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,       '0395-own@test.local',       '{}'::jsonb),
  (:mgr,       '0395-mgr@test.local',       '{}'::jsonb),
  (:mgrNo,     '0395-mgrno@test.local',     '{}'::jsonb),
  (:stfRm,     '0395-stfrm@test.local',     '{}'::jsonb),
  (:stfRmNoWh, '0395-stfrmnowh@test.local', '{}'::jsonb),
  (:stfRd,     '0395-stfrd@test.local',     '{}'::jsonb),
  (:stf,       '0395-stf@test.local',       '{}'::jsonb),
  (:vwr,       '0395-vwr@test.local',       '{}'::jsonb),
  (:dis,       '0395-dis@test.local',       '{}'::jsonb),
  (:outZ,      '0395-outz@test.local',      '{}'::jsonb),
  (:mgrAZ,     '0395-mgraz@test.local',     '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them); returns is
-- off by default and is turned on here.
insert into public.organizations (id, name, slug) values
  (:orgA, '0395 Returns A', '0395-returns-a'),
  (:orgZ, '0395 Returns Z', '0395-returns-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,       'owner',   now()),
  (:orgA, :mgr,       'manager', now()),
  (:orgA, :mgrNo,     'manager', now()),
  (:orgA, :stfRm,     'staff',   now()),
  (:orgA, :stfRmNoWh, 'staff',   now()),
  (:orgA, :stfRd,     'staff',   now()),
  (:orgA, :stf,       'staff',   now()),
  (:orgA, :vwr,       'viewer',  now()),
  (:orgA, :dis,       'manager', now()),
  (:orgZ, :outZ,      'manager', now()),
  (:orgA, :mgrAZ,     'manager', now()),
  (:orgZ, :mgrAZ,     'manager', now());
update public.user_profiles set disabled_at = now() where id = :dis;
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'returns', true, 'optional', '{}'::jsonb),
  (:orgZ, 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
-- The 0188 trigger creates Staging and Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0395 Main',   'WH-0395A', 'active'),
  (:whB, :orgA, '0395 Second', 'WH-0395B', 'active'),
  (:whZ, :orgZ, '0395 Zed',    'WH-0395Z', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stfRm, :whA, true),
  (:orgA, :stfRd, :whA, true),
  (:orgA, :stf,   :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNo,     'returns:manage', false),
  (:orgA, :stfRm,     'returns:manage', true),
  (:orgA, :stfRmNoWh, 'returns:manage', true),
  (:orgA, :stfRd,     'returns:read',   true);

select id as "stA" from public.locations where warehouse_id = :whA and kind = 'staging' \gset
select id as "unA" from public.locations where warehouse_id = :whA and kind = 'unplaced' \gset
select id as "stB" from public.locations where warehouse_id = :whB and kind = 'staging' \gset

-- Racks with distinct ages (the draw takes the oldest placed holding first).
insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:r31C,   :orgA, :whA, '31-C',      'shelf', 'rack', now() - interval '60 minutes'),
  (:r32A,   :orgA, :whA, '32-A',      'shelf', 'rack', now() - interval '59 minutes'),
  (:r33B,   :orgA, :whA, '33-B',      'shelf', 'rack', now() - interval '58 minutes'),
  (:r34A,   :orgA, :whA, '34-A',      'shelf', 'rack', now() - interval '57 minutes'),
  (:r35B,   :orgA, :whA, '35-B',      'shelf', 'rack', now() - interval '56 minutes'),
  (:r40,    :orgA, :whA, '40-A',      'shelf', 'rack', now() - interval '55 minutes'),
  (:r41,    :orgA, :whA, '41-A',      'shelf', 'rack', now() - interval '54 minutes'),
  (:rOther, :orgA, :whA, '42-A',      'shelf', 'rack', now() - interval '53 minutes'),
  (:siteA,  :orgA, :whA, 'Back room', 'room',  null,   now() - interval '52 minutes'),
  (:rB1,    :orgA, :whB, '51-B',      'shelf', 'rack', now() - interval '51 minutes');

-- Single-rack items seed their holding at primary_location_id (the seed
-- trigger); the two- and three-holding items get theirs below.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, primary_location_id) values
  (:itM,   :orgA, :whA, '0395-M',   'Walk New Hire Shirt M',  5, 'active', 'none', :r31C),
  (:itS,   :orgA, :whA, '0395-S',   'Walk Shirt Staging',     3, 'active', 'none', :r31C),
  (:itScr, :orgA, :whA, '0395-SCR', 'Walk Shirt Scrap',       3, 'active', 'none', :r32A),
  (:itR,   :orgA, :whA, '0395-R',   'Walk Shirt Rack Gone',   2, 'active', 'none', :r40),
  (:itV,   :orgA, :whA, '0395-V',   'Walk Shirt Reasons',     2, 'active', 'none', :r41),
  (:itK,   :orgA, :whA, '0395-K',   'Walk Shirt Unknown',     4, 'active', 'none', :r31C),
  (:itX,   :orgA, :whA, '0395-X',   'Walk Shirt X',           8, 'active', 'none', :r31C),
  (:itX2,  :orgA, :whA, '0395-X2',  'Walk Shirt X2',          8, 'active', 'none', :r31C),
  (:itC2,  :orgA, :whA, '0395-C2',  'Walk Shirt Two Racks',   0, 'active', 'none', null),
  (:itP,   :orgA, :whA, '0395-P',   'Walk Shirt Partial',     0, 'active', 'none', null),
  (:itU,   :orgA, :whA, '0395-U',   'Walk Shirt Forged',      0, 'active', 'none', null),
  (:itG,   :orgA, :whA, '0395-G',   'Walk Shirt Two Staging', 0, 'active', 'none', null),
  (:itW,   :orgA, :whB, '0395-W',   'Walk Shirt Second WH',   2, 'active', 'none', :rB1);
insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itZ, :orgZ, :whZ, '0395-Z', 'Zed shirt', 2, 'active', 'none');
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :itC2, :r32A, 1), (:orgA, :itC2, :r33B, 2),
  (:orgA, :itP,  :r34A, 1), (:orgA, :itP,  :r35B, 3),
  (:orgA, :itG,  :'stA', 1), (:orgA, :itG, :'stB', 5);
update public.inventory_items set quantity_on_hand = 3 where id = :itC2;
update public.inventory_items set quantity_on_hand = 4 where id = :itP;
update public.inventory_items set quantity_on_hand = 6 where id = :itG;

-- Orders, at their status, by the superuser (the insert guard holds API roles
-- only; the transition trigger fires on UPDATE only).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, requester_name, requester_email) values
  (:oA,    :orgA, :whA, 'pick_slip_generated', 'internal', :mgr, 'pickup', null, null),
  (:oK,    :orgA, :whA, 'completed',           'internal', :mgr, 'pickup', null, null),
  (:oU,    :orgA, :whA, 'completed',           'internal', :mgr, 'pickup', null, null),
  (:oG,    :orgA, :whA, 'completed',           'internal', :mgr, 'pickup', null, null),
  (:oX,    :orgA, :whA, 'completed',           'internal', null, 'pickup', 'Requester Person', 'requester-0395@test.local'),
  (:oPend, :orgA, :whA, 'pending_approval',    'internal', :mgr, 'pickup', null, null),
  (:oB,    :orgA, :whB, 'completed',           'internal', :mgr, 'pickup', null, null),
  (:oW,    :orgA, :whA, 'completed',           'internal', :mgr, 'pickup', null, null),
  (:oZ,    :orgZ, :whZ, 'completed',           'internal', :outZ, 'pickup', null, null);
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lM,    :oA,    :itM,   1, 0),
  (:lS,    :oA,    :itS,   1, 0),
  (:lScr,  :oA,    :itScr, 1, 0),
  (:lC2,   :oA,    :itC2,  3, 0),
  (:lP,    :oA,    :itP,   4, 0),
  (:lR,    :oA,    :itR,   1, 0),
  (:lV,    :oA,    :itV,   1, 0),
  (:lK,    :oK,    :itK,   1, 1),
  (:lU,    :oU,    :itU,   3, 3),
  (:lG,    :oG,    :itG,   1, 1),
  (:lX1,   :oX,    :itX,  10, 10),
  (:lX2,   :oX,    :itX2,  5, 5),
  (:lPend, :oPend, :itX,   1, 0),
  (:lB,    :oB,    :itX2,  1, 1),
  (:lB2,   :oB,    :itX,   2, 2),
  (:lW,    :oW,    :itW,   1, 1),
  (:lZ,    :oZ,    :itZ,   2, 2);

-- oK: a pick written before draw provenance (via_ledger, no draw).
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
   reason, reference_type, reference_id, user_id) values
  (:orgA, :itK, 'transfer', -1, 5, 4, 'Order pick (pre-provenance fixture)', 'order_request', :oK, :mgr);
-- oU: a pick whose draw names Staging, Unplaced and a Site (a draw may only be
-- written inside a ledger transaction, so the flag is raised around it).
select set_config('stockpilot.ledger', pg_current_xact_id()::text, true);
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
   reason, reference_type, reference_id, user_id, draw) values
  (:orgA, :itU, 'transfer', -3, 3, 0, 'Order pick (forged draw fixture)', 'order_request', :oU, :mgr,
   row('placed', :whA, 'manager',
       array[row(:'stA', -1, 'placed', 'staging', :whA, null)::public.stock_draw_holding,
             row(:'unA', -1, 'placed', 'unplaced', :whA, null)::public.stock_draw_holding,
             row(:siteA, -1, 'placed', null, :whA, null)::public.stock_draw_holding])::public.stock_draw);
-- oW: an order of the main warehouse whose pick drew the item from rack 51-B
-- of the second warehouse (the item lives there): a staff member who writes
-- only the main warehouse may manage the RMA but not stock that rack.
insert into public.stock_movements
  (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity,
   reason, reference_type, reference_id, user_id, draw) values
  (:orgA, :itW, 'transfer', -1, 3, 2, 'Order pick (second warehouse fixture)', 'order_request', :oW, :mgr,
   row('placed', :whB, 'manager',
       array[row(:rB1, -1, 'placed', 'rack', :whB, null)::public.stock_draw_holding])::public.stock_draw);
select set_config('stockpilot.ledger', '', true);

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'.
create function pg_temp.attempt(p_as text, p_sub uuid, p_sql text, p_prep text default null, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint; v_seen text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
    raise exception using errcode = 'XX395', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX395' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- One statement as p_as, KEPT when it succeeds: 'ok:<rows>' or the error.
create function pg_temp.write_as(p_as text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v_n bigint;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql;
    get diagnostics v_n = row_count;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return 'ok:' || v_n::text;
end $$;
-- One statement returning a value, as p_as, KEPT when it succeeds.
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null');
end $$;
-- An RPC (one statement returning jsonb) as p_as, KEPT when it succeeds; an
-- error answers {"error": sqlstate, "hint", "message", "detail"}.
create function pg_temp.rpc(p_as text, p_sub uuid, p_sql text)
returns jsonb language plpgsql as $$
declare v jsonb; v_state text; v_msg text; v_hint text; v_detail text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
  end;
  return coalesce(v, 'null'::jsonb);
end $$;
-- The same, ALWAYS undone; p_prep runs first, as the superuser, inside the
-- undone subtransaction.
create function pg_temp.try_rpc(p_as text, p_sub uuid, p_sql text, p_prep text default null)
returns jsonb language plpgsql as $$
declare v jsonb; v_state text; v_msg text; v_hint text; v_detail text;
begin
  begin
    if p_prep is not null then
      execute p_prep;
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    raise exception using errcode = 'XX395', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
  end;
  if v_state = 'XX395' then
    return coalesce(v, 'null'::jsonb);
  end if;
  return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
end $$;
-- 'ok', or '<sqlstate>:<hint>' for an RPC answer.
create function pg_temp.err(j jsonb) returns text language sql immutable as $$
  select case when j ? 'error' then (j->>'error') || ':' || coalesce(j->>'hint', '-') else 'ok' end
$$;
-- What a read says after a change, the change ALWAYS undone (superuser).
create function pg_temp.undone(p_prep text, p_read text) returns text language plpgsql as $$
declare v text; v_state text;
begin
  begin
    execute p_prep;
    execute p_read into v;
    raise exception using errcode = 'XX395', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'XX395' then
      return 'error:' || v_state;
    end if;
  end;
  return v;
end $$;
-- An item now: on hand | positive holdings by location | its movement count.
create function pg_temp.snap(p_item uuid) returns text language sql as $$
  select (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = p_item) || '|'
      || coalesce((select string_agg(location_id::text || ':' || trim_scale(quantity)::text, ',' order by location_id)
                     from public.item_stock_levels where item_id = p_item and quantity <> 0), '') || '|'
      || (select count(*)::text from public.stock_movements where item_id = p_item)
$$;
create function pg_temp.held(p_item uuid, p_loc uuid) returns numeric language sql as $$
  select coalesce((select trim_scale(quantity) from public.item_stock_levels where item_id = p_item and location_id = p_loc), 0)
$$;
create function pg_temp.balanced(p_item uuid) returns boolean language sql as $$
  select (select quantity_on_hand from public.inventory_items where id = p_item)
       = (select coalesce(sum(quantity), 0) from public.item_stock_levels where item_id = p_item)
$$;
-- The staff create's JSON body for one line.
create function pg_temp.one(p_line uuid, p_qty numeric, p_disp text default 'restock') returns jsonb language sql immutable as $$
  select jsonb_build_object('reasonCode', 'other',
                            'lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', p_line, 'quantity', p_qty, 'disposition', p_disp)))
$$;
-- An approval decision for one line.
create function pg_temp.dec(p_line uuid, p_disp text, p_target text default null, p_loc uuid default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('lines', jsonb_build_array(
           jsonb_build_object('returnLineId', p_line, 'disposition', p_disp)
           || case when p_target is null then '{}'::jsonb
                   else jsonb_build_object('restock', jsonb_build_object('target', p_target)
                                           || case when p_loc is null then '{}'::jsonb else jsonb_build_object('locationId', p_loc) end) end))
$$;

-- Statement discipline: a write a later check depends on runs in its OWN
-- statement (its JSON answer kept in a psql variable), and every check reads
-- in a later statement. A data-changing volatile call inside a SELECT is not
-- visible to the rest of that SELECT (the statement's snapshot), so no
-- assertion mixes a kept write with a table read.

-- ══ S. The pick and the hand-over ═════════════════════════════════════════
select pg_temp.call_as('authenticated', :mgr, format('select (public.complete_picking(%L)).status', :oA)) as "sPick" \gset
update public.order_requests set status = 'packing_slip_generated' where id = :oA;
update public.order_requests set status = 'staged_for_pickup' where id = :oA;
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :oA)) as "sSign" \gset
select is(:'sPick' || ',' || :'sSign', 'picking_complete,completed',
  'S1: complete_picking draws the seven lines (one click) and the paper signature hands the order over');
select is(
  (select count(*)::int from public.stock_movements m
    where m.reference_type = 'order_request' and m.reference_id = :oA and m.movement_type = 'transfer'
      and m.quantity_change < 0 and m.via_ledger and m.draw is not null),
  7,
  'S2: each of the seven lines has its stamped pick transfer carrying its recorded draw');
select is(
  pg_temp.held(:itM, :r31C)::text || ',' || pg_temp.held(:itC2, :r32A)::text || ',' || pg_temp.held(:itC2, :r33B)::text || ','
  || pg_temp.held(:itP, :r34A)::text || ',' || pg_temp.held(:itP, :r35B)::text || '|'
  || (select string_agg(trim_scale(quantity_fulfilled)::text || '/' || coalesce(trim_scale(quantity_picked)::text, 'null'), ',' order by id)
        from public.order_request_lines where order_request_id = :oA),
  '4,0,0,0,0|1/null,1/null,1/null,3/null,4/null,1/null,1/null',
  'S3: the draws took 31-C (M), 32-A then 33-B (two racks), 34-A then 35-B (partial); every line is handed over');

-- ══ A. Shape and grants ═══════════════════════════════════════════════════
select is(
  (select count(*)::int
     from unnest(array['public.returns', 'public.return_lines', 'public.return_decisions', 'public.return_overview']) t(rel),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p(priv)
    where has_table_privilege('anon', t.rel, p.priv)
       or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('anon', t.rel, p.priv))),
  0,
  'A1: anon holds no table or column privilege on returns, return_lines, return_decisions or return_overview (G3)');
select is(
  (select string_agg(p.priv || '=' || has_table_privilege('authenticated', 'public.returns', p.priv)::text, ',' order by p.priv collate "C")
     from unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p(priv))
  || '|' ||
  (select string_agg(column_name::text, ',' order by column_name::text collate "C") from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'returns' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'DELETE=false,INSERT=true,MAINTAIN=false,REFERENCES=false,SELECT=true,TRIGGER=false,TRUNCATE=false,UPDATE=false|'
  || 'approved_at,approved_by,denial_reason,denied_at,denied_by,received_at,received_by,status',
  'A2: authenticated keeps SELECT and INSERT on returns and UPDATE on exactly the eight columns the raw transitions write');
select is(
  (select string_agg(p.priv || '=' || has_table_privilege('authenticated', 'public.return_lines', p.priv)::text, ',' order by p.priv collate "C")
     from unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p(priv))
  || '|' || has_any_column_privilege('authenticated', 'public.return_lines', 'UPDATE')::text,
  'DELETE=false,INSERT=true,MAINTAIN=false,REFERENCES=false,SELECT=true,TRIGGER=false,TRUNCATE=false,UPDATE=false|false',
  'A3: authenticated keeps SELECT and INSERT on return_lines and no UPDATE on any column');
select is(
  (select string_agg(r.role || ':' || p.priv || '=' || has_table_privilege(r.role, 'public.return_decisions', p.priv)::text, ','
                     order by r.role collate "C", p.priv collate "C")
     from unnest(array['authenticated', 'service_role']) r(role),
          unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p(priv)),
  'authenticated:DELETE=false,authenticated:INSERT=false,authenticated:SELECT=true,authenticated:UPDATE=false,'
  || 'service_role:DELETE=true,service_role:INSERT=true,service_role:SELECT=true,service_role:UPDATE=true',
  'A4: authenticated may only read the decision log; the service role holds it all');
select is(
  (select string_agg(p.priv || '=' || has_table_privilege('authenticated', 'public.return_overview', p.priv)::text, ',' order by p.priv collate "C")
     from unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p(priv))
  || '|' || (select coalesce(array_to_string(c.reloptions, ','), '') from pg_class c where c.oid = 'public.return_overview'::regclass),
  'DELETE=false,INSERT=false,SELECT=true,UPDATE=false|security_invoker=true',
  'A5: the list view is read-only for authenticated and runs as the caller (security_invoker)');
select is(
  (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.return_overview'::regclass and a.attnum > 0 and not a.attisdropped),
  'id,organization_id,return_number,status,source,reason_code,order_request_id,order_number,warehouse_id,'
  || 'requester_name,requester_email,requester_user_id,created_at,approved_at,received_at,closed_at,'
  || 'line_count,unit_count,lines,waiting_days',
  'A6: the view''s column order is pinned (RX-2 may only append after waiting_days)');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                     || ':' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
                     || ':' || pg_get_userbyid(p.proowner),
                     ',' order by p.proname collate "C")
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_return_request', 'create_requester_return_request', 'approve_return', 'deny_return',
                        'receive_return', 'cancel_return', 'plan_return_dispositions', 'close_return', 'return_restock_options')),
  'approve_return:true:true:false:false:false:postgres,cancel_return:true:true:false:false:false:postgres,'
  || 'close_return:true:true:false:false:false:postgres,create_requester_return_request:true:false:false:true:false:postgres,'
  || 'create_return_request:true:true:false:false:false:postgres,deny_return:true:true:false:false:false:postgres,'
  || 'plan_return_dispositions:true:true:false:false:false:postgres,receive_return:true:true:false:false:false:postgres,'
  || 'return_restock_options:true:true:false:false:false:postgres',
  'A7: the nine RMA functions are SECURITY DEFINER owned by postgres; EXECUTE for authenticated only (the requester create for service_role only), never anon or PUBLIC');
select is(
  (select string_agg(n.nspname || '.' || p.proname || ':' || p.prosecdef::text || ':'
                     || (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
                         or has_function_privilege('service_role', p.oid, 'EXECUTE')
                         or coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false))::text,
                     ',' order by n.nspname collate "C", p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'ledger' and p.proname in ('return_line_sources', 'return_line_plans_original',
                                                  'return_line_restock_legs', 'return_restock_original'))
       or (n.nspname = 'public' and p.proname in ('_return_exchange_create', '_return_exchange_approve', '_return_exchange_on_deny',
                                                  '_return_exchange_on_cancel', '_return_normalize_request', '_return_create_core',
                                                  '_return_plan_lines', 'tg_returns_api_guard', 'tg_return_lines_api_guard',
                                                  'tg_return_decisions_append_only'))),
  'ledger.return_line_plans_original:false:false,ledger.return_line_restock_legs:false:false,ledger.return_line_sources:false:false,'
  || 'ledger.return_restock_original:false:false,public._return_create_core:false:false,public._return_exchange_approve:false:false,'
  || 'public._return_exchange_create:false:false,public._return_exchange_on_cancel:false:false,public._return_exchange_on_deny:false:false,'
  || 'public._return_normalize_request:false:false,public._return_plan_lines:false:false,public.tg_return_decisions_append_only:false:false,'
  || 'public.tg_return_lines_api_guard:false:false,public.tg_returns_api_guard:false:false',
  'A8: every helper, hook and guard is SECURITY INVOKER with no EXECUTE for any API role (X-3)');
select is(
  array(select p.proname::text from pg_proc p
         where p.pronamespace = 'ledger'::regnamespace and p.prosecdef order by 1),
  array['apply_holding_delta', 'apply_level_delta_for', 'cycle_count_line_superseded', 'process_return_disposition'],
  'A9: the ledger schema still has exactly the four SECURITY DEFINER functions of 0359 test 15');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and p.proname in ('create_return_request', 'approve_return', 'deny_return', 'receive_return', 'cancel_return',
                        'plan_return_dispositions', 'close_return', 'return_restock_options')
      and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)'),
  0,
  'A10: INV-25: every authenticated-EXECUTE RMA function gates in its own body');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ','), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger')
      and p.proname like '%return%'
      and (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$
           or p.prosrc ~* $re$raise\s+(exception\s+)?(serialization_failure|deadlock_detected)\M$re$
           or p.prosrc ~* $re$raise\s+(exception\s+)?sqlstate\s+'40(001|p01)'$re$)),
  '',
  'A11: no return function raises a retryable class (0367)');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ','), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger')
      and p.proname in ('return_line_sources', 'return_line_plans_original', 'return_line_restock_legs', 'return_restock_original',
                        '_return_exchange_create', '_return_exchange_approve', '_return_exchange_on_deny', '_return_exchange_on_cancel',
                        '_return_normalize_request', '_return_create_core', '_return_plan_lines', 'tg_returns_api_guard',
                        'tg_return_lines_api_guard', 'tg_return_decisions_append_only', 'create_return_request',
                        'create_requester_return_request', 'approve_return', 'deny_return', 'receive_return', 'cancel_return',
                        'plan_return_dispositions', 'close_return', 'return_restock_options')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c = 'search_path=public, pg_temp')),
  '',
  'A12: every new function pins search_path = public, pg_temp');
select is(
  (select string_agg(p.proname || ':' || coalesce((select c from unnest(p.proconfig) c where c like 'lock_timeout=%'), 'none'), ','
                     order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_return_request', 'create_requester_return_request', 'approve_return', 'deny_return',
                        'receive_return', 'cancel_return', 'plan_return_dispositions', 'close_return', 'return_restock_options')),
  'approve_return:lock_timeout=5s,cancel_return:lock_timeout=5s,close_return:lock_timeout=5s,create_requester_return_request:lock_timeout=5s,'
  || 'create_return_request:lock_timeout=5s,deny_return:lock_timeout=5s,plan_return_dispositions:lock_timeout=5s,'
  || 'receive_return:lock_timeout=5s,return_restock_options:none',
  'A13: every writing RMA function waits at most 5s for a lock (55P03, retryable); the read takes none');
select is(
  (select string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text, ',' order by policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename = 'return_decisions')
  || '|' || (select relrowsecurity::text from pg_class where oid = 'public.return_decisions'::regclass),
  'return_decisions.return_decisions_select:SELECT:{authenticated}|true',
  'A14: the decision log has RLS and one SELECT policy');
select is(
  (select string_agg(policyname || ':' ||
            ((coalesce(qual, '') || coalesce(with_check, '')) ~ 'has_permission\([a-z_.]*organization_id, ''returns:manage''::text\)')::text
            || ':' || ((coalesce(qual, '') || coalesce(with_check, '')) ~ 'has_org_role')::text,
          ',' order by policyname collate "C")
     from pg_policies where schemaname = 'public' and tablename in ('returns', 'return_lines')
      and policyname in ('returns_insert', 'returns_update', 'return_lines_insert', 'return_lines_update')),
  'return_lines_insert:true:false,return_lines_update:true:false,returns_insert:true:false,returns_update:true:false',
  'A15: the four write policies follow returns:manage and no longer name the manager role (G1)');
select is(
  (select string_agg(c.relname || '.' || t.tgname || ':' || t.tgtype::text || ':' || p.prosecdef::text, ','
                     order by c.relname collate "C", t.tgname collate "C")
     from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where t.tgname in ('trg_returns_zz_api_guard', 'trg_return_lines_zz_api_guard', 'trg_return_decisions_append_only')),
  'return_decisions.trg_return_decisions_append_only:19:false,return_lines.trg_return_lines_zz_api_guard:7:false,'
  || 'returns.trg_returns_zz_api_guard:23:false',
  'A16: the guards are BEFORE ROW triggers (insert or update on returns, insert on return_lines, update on the log), all SECURITY INVOKER');
select is(
  (select string_agg(indexname::text, ',' order by indexname::text collate "C") from pg_indexes
    where schemaname = 'public' and indexname in ('returns_id_org_key', 'return_lines_id_return_key', 'returns_org_number_uniq')
      and indexdef like 'CREATE UNIQUE INDEX%')
  || '|' || (select pg_get_expr(i.indpred, i.indrelid) from pg_index i where i.indexrelid = 'public.returns_org_number_uniq'::regclass),
  'return_lines_id_return_key,returns_id_org_key,returns_org_number_uniq|(return_number IS NOT NULL)',
  'A17: the composite keys and the per-organization RMA number key exist (G6, G15)');
select is(
  (select data_type || ':' || is_nullable || ':' || column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'notification_preferences' and column_name = 'push_return_requested'),
  'boolean:NO:true',
  'A18: notification_preferences.push_return_requested is boolean, not null, default on');
select is(
  (select string_agg(coalesce(to_regprocedure(s)::text, 'missing:' || s), ',' order by s collate "C")
     from unnest(array['public._return_exchange_create(uuid,uuid,jsonb,jsonb)', 'public._return_exchange_approve(uuid,jsonb,uuid,integer)',
                       'public._return_exchange_on_deny(uuid,uuid)', 'public._return_exchange_on_cancel(uuid,uuid,text)']) s),
  '_return_exchange_approve(uuid,jsonb,uuid,integer),_return_exchange_create(uuid,uuid,jsonb,jsonb),'
  || '_return_exchange_on_cancel(uuid,uuid,text),_return_exchange_on_deny(uuid,uuid)',
  'A19: the four exchange hooks exist with the signatures RX-2 replaces');
select is(
  (select md5(p.prosrc) || '|' || md5(regexp_replace(p.prosrc, '\n[^\n]*-- RX-1[^\n]*', '', 'g')) || '|'
          || p.prosecdef::text || '|' || p.proconfig::text || '|' || p.proacl::text || '|' || pg_get_userbyid(p.proowner) || '|'
          || md5(coalesce(obj_description(p.oid, 'pg_proc'), '<none>')) || '|' || (select ty.typname from pg_type ty where ty.oid = p.prorettype)
     from pg_proc p where p.oid = 'ledger.process_return_disposition(uuid)'::regprocedure),
  '7c7edfe53e60e754e9bd47c76266cb7a|f6f516639a4f15ad83c0495a07ec89cf|true|{"search_path=public, extensions"}|'
  || '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|postgres|39c71bb3ec9da1d20cc17322793fe353|returns',
  'A20: the restated body (md5 7c7edfe5) minus its ten -- RX-1 lines IS production''s 0373 body minus the manager-role line (f6f51663); header, ACL, owner and (absent) comment unchanged');
select is(
  (select (p.prosrc ~ 'if not public\.has_permission\(v_return\.organization_id, ''returns:manage''\) then  -- RX-1')::text || ','
          || (p.prosrc ~ 'user_can_access_inventory\(v_user, v_wh, null, ''write''\)')::text || ','
          || (p.prosrc !~ 'has_org_role')::text || ','
          || (select count(*) from regexp_matches(p.prosrc, '\n[^\n]*-- RX-1', 'g'))::text || ','
          || (select count(*) from regexp_matches(p.prosrc, '\n[^\n]*-- 0373', 'g'))::text
     from pg_proc p where p.oid = 'ledger.process_return_disposition(uuid)'::regprocedure),
  'true,true,true,10,9',
  'A21: the body gates on returns:manage and warehouse write, never the manager role; ten RX-1 lines, the nine 0373 lines kept');
select is(
  (select count(*)::int from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('returns', 'return_lines', 'return_decisions')),
  0,
  'A22: no return table is in the realtime publication');

-- ══ B. Gates ══════════════════════════════════════════════════════════════
-- The gate RMA: one unit of X, created by the manager (kept).
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, %L)',
          :oX, pg_temp.one(:lX1, 1)::text, '03950000-0000-0000-0000-00000000f001'))->>'returnId') as "rG" \gset
select id as "rGl" from public.return_lines where return_id = :'rG' \gset

select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.receive_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG', pg_temp.dec(:'rGl', 'restock')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.deny_return(%L, ''x'')', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.cancel_return(%L, 0, null)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.close_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.plan_return_dispositions(%L, ''[]''::jsonb)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.return_restock_options(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 1)::text))),
  '42501:unauthenticated,42501:unauthenticated,42501:unauthenticated,42501:unauthenticated,'
  || '42501:unauthenticated,42501:unauthenticated,42501:unauthenticated,42501:unauthenticated',
  'B1: signed out, every RMA function answers 42501 unauthenticated');
select is(
  pg_temp.err(pg_temp.try_rpc('anon', null, format('select public.receive_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('anon', null, format('select public.return_restock_options(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), ''{"channel":"token"}''::jsonb)', :oX, pg_temp.one(:lX1, 1)::text))),
  '42501:-,42501:-,42501:-',
  'B2: anon holds no EXECUTE on any RMA function, and authenticated none on the requester create');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format('select public.receive_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.receive_return(%L)', :nobody))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format('select public.return_restock_options(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 1)::text))),
  'P0002:return_not_found,P0002:return_not_found,P0002:return_not_found,P0002:order_not_found',
  'B3: a foreign RMA or order answers exactly like a missing one (no oracle)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rG'),
     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'returns'$q$, :orgA))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 1)::text),
     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'returns'$q$, :orgA))),
  'P0001:module_disabled,P0001:module_disabled',
  'B4: with the returns module off, the writes answer module_disabled');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG', pg_temp.dec(:'rGl', 'restock')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.deny_return(%L, ''No'')', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.cancel_return(%L, 0, null)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.receive_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.close_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.plan_return_dispositions(%L, ''[]''::jsonb)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgrNo, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 1)::text)))
  || ',' || pg_temp.attempt('authenticated', :mgrNo, format('select public.process_return_disposition(%L)', :'rG')),
  '42501:returns_manage,42501:returns_manage,42501:returns_manage,42501:returns_manage,'
  || '42501:returns_manage,42501:returns_manage,42501:returns_manage,42501:-:forbidden',
  'B5: a manager whose returns:manage is revoked is refused by every RMA function and by the restated body behind the frozen wrapper (effective permission, not role)');
select is(
  pg_temp.attempt('authenticated', :mgrNo,
    format($q$insert into public.returns (organization_id, order_request_id, status, source) values (%L, %L, 'requested', 'internal')$q$, :orgA, :oX))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgrNo, format($q$update public.returns set status = 'cancelled' where id = %L$q$, :'rG')),
  '42501:-:new row violates row-level security policy for table "returns" | ok:0',
  'B6: and by the raw policies: a direct insert is refused and a direct update reaches no row (G1)');
select is(
  pg_temp.try_rpc('authenticated', :stfRm, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG',
                  pg_temp.dec(:'rGl', 'restock', 'staging')::text))->>'status',
  'approved',
  'B7: staff granted returns:manage with write access to the warehouse may approve');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfRmNoWh, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG',
                  pg_temp.dec(:'rGl', 'restock', 'staging')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRmNoWh, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 1)::text)))
  || ',' || pg_temp.attempt('authenticated', :stfRmNoWh, format('select public.process_return_disposition(%L)', :'rG')),
  '42501:warehouse_write,42501:warehouse_write,42501:warehouse_write:forbidden',
  'B8: the same grant without write access to the order''s warehouse is refused warehouse_write, by the RPCs and by the restated body behind the frozen wrapper (D27)');
select is(
  pg_temp.call_as('authenticated', :stfRd, format('select count(*)::text from public.return_decisions where return_id = %L', :'rG')) || ','
  || pg_temp.call_as('authenticated', :stf, format('select count(*)::text from public.return_decisions where return_id = %L', :'rG')) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRd, format('select public.receive_return(%L)', :'rG'))),
  '1,0,42501:returns_manage',
  'B9: returns:read alone reads the decision log and is refused every write; staff without it read no decision (C-10)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :dis, format('select public.receive_return(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, format('select public.receive_return(%L)', :'rG'))),
  'P0002:return_not_found,42501:returns_manage',
  'B10: a disabled manager is no member (refused as not found); a viewer lacks returns:manage');
select is(
  coalesce(pg_temp.try_rpc('authenticated', :stfRd, format('select public.return_restock_options(%L)', :'rG'))->>'status', 'error') || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stf, format('select public.return_restock_options(%L)', :'rG'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, format('select public.return_restock_options(%L)', :'rG'))),
  'requested,42501:returns_read,42501:returns_read',
  'B11: the destination read answers returns:read holders and refuses members without it');
-- The second warehouse's RMA: one unit of X2 on oB (whB), created by the
-- manager (kept). stfRm holds returns:manage and writes the main warehouse only.
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, %L)',
          :oB, pg_temp.one(:lB, 1)::text, '03950000-0000-0000-0000-00000000f003'))->>'returnId') as "rB" \gset
select id as "rBl" from public.return_lines where return_id = :'rB' \gset
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.approve_return(%L, 0, %L::jsonb)', :'rB', pg_temp.dec(:'rBl', 'restock', 'staging')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rB', pg_temp.dec(:'rBl', 'restock', 'staging')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.deny_return(%L, ''No'')', :'rB'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.cancel_return(%L, 0, null)', :'rB'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.receive_return(%L)', :'rB'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.plan_return_dispositions(%L, ''[]''::jsonb)', :'rB'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.close_return(%L)', :'rB'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.return_restock_options(%L)', :'rB'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oB, pg_temp.one(:lB2, 1)::text)))
  || ',' || coalesce(pg_temp.try_rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rB'))->>'error', 'none'),
  '42501:warehouse_write,42501:warehouse_write,42501:warehouse_write,42501:warehouse_write,42501:warehouse_write,'
  || '42501:warehouse_write,42501:warehouse_write,42501:warehouse_read,42501:warehouse_write,P0001',
  'B12: staff granted returns:manage who writes only the main warehouse is refused on the second warehouse''s RMA and order by every function (approve, approve and receive, deny, cancel, receive, plan, close, the destination read, create), before any status check; the manager reaches the status check (F2)');

-- ══ C. Create ═════════════════════════════════════════════════════════════
select is(
  (select r.status || ':' || r.source || ':' || (r.requested_by = :mgr)::text || ':' || (r.return_number ~ '^RMA-[0-9]{8}-[0-9A-F]{6}$')::text
          || ':' || (select count(*) from public.return_lines rl where rl.return_id = r.id)::text
          || ':' || (select string_agg(d.kind || '/' || d.channel || '/' || d.actor_kind, ',') from public.return_decisions d where d.return_id = r.id)
     from public.returns r where r.id = :'rG'),
  'requested:internal:true:true:1:created/staff/staff',
  'C1: the staff create writes the header, its line and the created decision in one call, with today''s RMA number format');
select pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, %L)',
          :oX, pg_temp.one(:lX1, 1)::text, '03950000-0000-0000-0000-00000000f001'))::text as "jC2" \gset
select is(
  ((:'jC2'::jsonb)->>'replay') || ':' || (((:'jC2'::jsonb)->>'returnId') = :'rG')::text
  || ':' || (select count(*)::text from public.returns where order_request_id = :oX),
  'true:true:1',
  'C2: the same key and body replays the same RMA and creates nothing');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, %L)',
                  :oX, pg_temp.one(:lX1, 2)::text, '03950000-0000-0000-0000-00000000f001'))),
  'P0001:idempotency_conflict',
  'C3: the same key with another body is refused idempotency_conflict (G12)');
select pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
     jsonb_build_object('lines', jsonb_build_array(
       jsonb_build_object('orderRequestLineId', :lX1, 'quantity', 1, 'disposition', 'restock'),
       jsonb_build_object('orderRequestLineId', :lX2, 'quantity', 6, 'disposition', 'restock')))::text))::text as "jC4" \gset
select is(
  pg_temp.err(:'jC4'::jsonb) || ':' || (select count(*)::text from public.returns where order_request_id = :oX),
  'P0001:return_exceeds_fulfilled:1',
  'C4: a line over its durable budget is refused (pending demand counted) and nothing is created');
-- case: create_exchange_refused
select pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
     jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lX1, 'quantity', 1, 'disposition', 'restock',
                                                                       'exchange', jsonb_build_object('itemId', :itX2, 'quantity', 1))))::text))::text as "jC5" \gset
select is(
  pg_temp.err(:'jC5'::jsonb) || ':' || (select count(*)::text from public.returns where order_request_id = :oX)
  || ':' || (select count(*)::text from public.return_lines where order_request_line_id = :lX1),
  'P0001:exchange_not_available:1:1',
  'C5: one transaction: the exchange hook refuses after the header and line were written, and neither survives (the old two-step left an orphan header)');
select (pg_temp.rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, %L, %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1, 'scrap')::text, '03950000-0000-0000-0000-00000000f002', '{"channel":"token"}'))->>'returnId') as "rQ" \gset
select is(
  (select r.source || ':' || coalesce(r.requested_by::text, 'none') || ':' || r.requester_name || ':' || r.requester_email::text || ':'
          || (select string_agg(rl.disposition, ',') from public.return_lines rl where rl.return_id = r.id) || ':'
          || (select string_agg(d.kind || '/' || d.channel || '/' || d.actor_kind, ',') from public.return_decisions d where d.return_id = r.id)
     from public.returns r where r.id = :'rQ'),
  'requester:none:Requester Person:requester-0395@test.local:restock:created/token/requester',
  'C6: the requester path forces restock, takes the name and email from the order, and records the token channel (P19)');
select pg_temp.rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, %L, %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1, 'scrap')::text, '03950000-0000-0000-0000-00000000f002', '{"channel":"token"}'))::text as "jC7" \gset
select is(
  ((:'jC7'::jsonb)->>'replay') || ':' || (((:'jC7'::jsonb)->>'returnId') = :'rQ')::text
  || ':' || (select count(*)::text from public.returns where order_request_id = :oX and source = 'requester'),
  'true:true:1',
  'C7: the requester create replays on the same key');
select is(
  pg_temp.attempt('postgres', null,
    format($q$insert into public.returns (organization_id, order_request_id, return_number, status) select organization_id, order_request_id, return_number, 'requested' from public.returns where id = %L$q$, :'rG')),
  '23505:-:duplicate key value violates unique constraint "returns_org_number_uniq"',
  'C8: a second RMA with the same number in one organization is refused by the key (the create retries such a collision)');
-- The shape refusals core's schemas share (packages/core/src/returns/return-schemas.ts):
-- case: create_quantity_fractional
-- case: create_quantity_zero
-- case: create_quantity_over_cap
-- case: create_too_many_lines
-- case: create_duplicate_line
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oPend, pg_temp.one(:lPend, 1)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lM, 1)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 1.5)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 0)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, null)', :oX, pg_temp.one(:lX1, 1)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX, pg_temp.one(:lX1, 10001)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
       (select jsonb_build_object('lines', jsonb_agg(jsonb_build_object('orderRequestLineId', gen_random_uuid(), 'quantity', 1))) from generate_series(1, 101))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
       jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lX1, 'quantity', 1),
                                                     jsonb_build_object('orderRequestLineId', :lX1, 'quantity', 1)))::text))),
  'P0001:order_not_returnable,22023:return_invalid,22023:return_invalid,22023:return_invalid,22023:idempotency_key_required,'
  || '22023:return_invalid,22023:return_invalid,22023:return_invalid',
  'C9: an order not handed over, a line of another order, a fractional, zero or over-10,000 quantity, more than 100 lines, a repeated line and a missing key are refused (G10)');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
          (pg_temp.one(:lX1, 1) || '{"itemIsHere": true}'::jsonb)::text))->>'returnId') as "rN" \gset
select is(
  (select string_agg(d.kind || '/' || d.channel, ',') from public.return_decisions d where d.return_id = :'rN')
  || ':' || (select status from public.returns where id = :'rN'),
  'created/counter:requested',
  'C10: "The item is here" records the counter channel on the created decision and receives nothing by itself');
select is(
  pg_temp.err(pg_temp.try_rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1)::text, '{"channel":"token"}'),
     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'returns'$q$, :orgA))) || ','
  || pg_temp.err(pg_temp.try_rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1)::text, '{"channel":"portal"}'))),
  'P0001:module_disabled,22023:return_invalid',
  'C11: the requester create honours the module, and a portal or member actor must name its user');
select is(
  pg_temp.err(pg_temp.try_rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1)::text, '{}'))) || ','
  || pg_temp.err(pg_temp.try_rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1)::text, '{"channel": null}'))) || ','
  || pg_temp.err(pg_temp.try_rpc('service_role', null, format('select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), %L::jsonb)', :oX,
          pg_temp.one(:lX2, 1)::text, '{"channel": "staff"}'))),
  '22023:return_invalid,22023:return_invalid,22023:return_invalid',
  'C12: a requester actor with no channel, a null channel or an unknown one is refused return_invalid, never an unmapped error (F10)');
-- idempotency_keys is writable by managers through the API, so the create
-- replays only an RMA of its own organization and order (F11). The planted
-- rows below carry the exact request hash, so only that tie refuses them.
select (pg_temp.rpc('authenticated', :outZ, format('select public.create_return_request(%L, %L::jsonb, %L)', :oZ,
          pg_temp.one(:lZ, 1)::text, '03950000-0000-0000-0000-00000000f005'))->>'returnId') as "rZ0" \gset
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr,
     format('select public.create_return_request(%L, %L::jsonb, %L)', :oX, pg_temp.one(:lX1, 1)::text, '03950000-0000-0000-0000-00000000f006'),
     format($q$insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type, response)
               values (%L, 'return_create', %L, md5('return_create:v1|' || %L || '|' || public._return_normalize_request(%L::jsonb, 'staff')::text),
                       'completed', 'return', jsonb_build_object('returnId', %L))$q$,
            :orgA, :mgr || ':03950000-0000-0000-0000-00000000f006', :oX, pg_temp.one(:lX1, 1)::text, :'rZ0')))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr,
     format('select public.create_return_request(%L, %L::jsonb, %L)', :oX, pg_temp.one(:lX1, 1)::text, '03950000-0000-0000-0000-00000000f007'),
     format($q$insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type, response)
               values (%L, 'return_create', %L, md5('return_create:v1|' || %L || '|' || public._return_normalize_request(%L::jsonb, 'staff')::text),
                       'completed', 'return', jsonb_build_object('returnId', %L))$q$,
            :orgA, :mgr || ':03950000-0000-0000-0000-00000000f007', :oX, pg_temp.one(:lX1, 1)::text, :'rB')))
  || ',' || pg_temp.err(pg_temp.try_rpc('service_role', null,
     format('select public.create_requester_return_request(%L, %L::jsonb, %L, %L::jsonb)', :oX, pg_temp.one(:lX2, 1)::text,
            '03950000-0000-0000-0000-00000000f008', '{"channel":"token"}'),
     format($q$insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type, response)
               values (%L, 'return_create', %L, md5('return_create:v1|' || %L || '|token|' || public._return_normalize_request(%L::jsonb, 'requester')::text),
                       'completed', 'return', jsonb_build_object('returnId', %L))$q$,
            :orgA, 'anon:03950000-0000-0000-0000-00000000f008', :oX, pg_temp.one(:lX2, 1)::text, :'rZ0'))),
  'P0001:idempotency_conflict,P0001:idempotency_conflict,P0001:idempotency_conflict',
  'C13: a key row the create did not write, naming another organization''s RMA or another order''s, is refused idempotency_conflict, never replayed, on the staff and the requester paths (F11)');

-- ══ D. Approval, deny, receive, cancel, plans ═════════════════════════════
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG',
          pg_temp.dec(:'rGl', 'restock', 'staging')::text))::text as "jD1" \gset
select is(
  ((:'jD1'::jsonb)->>'changed') || ':' || ((:'jD1'::jsonb)->>'status') || ':' || ((:'jD1'::jsonb)->>'revision')
  || '|' || (select string_agg(d.kind || '/' || coalesce(d.revision::text, '-'), ',' order by d.seq) from public.return_decisions d where d.return_id = :'rG'),
  'true:approved:1|created/-,disposition_planned/-,approved/1',
  'D1: approve answers changed, approved, revision 1, and logs the plan and the approval');
select is(
  ((pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG',
                  pg_temp.dec(:'rGl', 'restock', 'staging')::text)))->>'replay')
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rG',
                  pg_temp.dec(:'rGl', 'scrap')::text))),
  'true,P0001:return_changed',
  'D2: the same decision at the same revision replays; another decision at that revision is return_changed (double click, two managers)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 1, %L::jsonb)', :'rG',
                  pg_temp.dec(:'rGl', 'restock', 'staging')::text))),
  'P0001:invalid_status_transition',
  'D3: approving an approved RMA at the next revision is invalid_status_transition');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
          pg_temp.one(:lX1, 1)::text))->>'returnId') as "rI" \gset
select id as "rIl" from public.return_lines where return_id = :'rI' \gset
-- case: approve_no_lines
-- case: approve_scrap_with_destination
-- case: approve_unknown_target
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 3, %L::jsonb)', :'rI',
                  pg_temp.dec(:'rIl', 'restock', 'staging')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI', '{"lines":[]}'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI',
                  pg_temp.dec(:'rIl', 'scrap', 'staging')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI',
                  pg_temp.dec(:'rIl', 'restock', 'shelf')::text))),
  'P0001:return_changed,P0001:return_decision_incomplete,22023:return_invalid,22023:return_invalid',
  'D4: a stale revision is return_changed; every line needs a decision; scrap carries no destination; an unknown target is refused');
select pg_temp.rpc('authenticated', :mgr, format('select public.plan_return_dispositions(%L, %L::jsonb)', :'rG',
          (pg_temp.dec(:'rGl', 'restock', 'staging')->'lines')::text))::text as "jD5a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.plan_return_dispositions(%L, %L::jsonb)', :'rG',
          (pg_temp.dec(:'rGl', 'scrap')->'lines')::text))::text as "jD5b" \gset
select (select disposition from public.return_lines where id = :'rGl') as "dD5b" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.plan_return_dispositions(%L, %L::jsonb)', :'rG',
          (pg_temp.dec(:'rGl', 'restock', 'staging')->'lines')::text))::text as "jD5c" \gset
select is(
  ((:'jD5a'::jsonb)->>'appended') || ',' || ((:'jD5b'::jsonb)->>'appended') || ',' || :'dD5b'
  || ',' || ((:'jD5c'::jsonb)->>'appended') || ',' || (select disposition from public.return_lines where id = :'rGl'),
  '0,1,scrap,1,restock',
  'D5: an identical plan appends nothing; a changed plan appends one row and keeps return_lines.disposition equal');
select pg_temp.rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rG'))::text as "jD6a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rG'))::text as "jD6b" \gset
select is(
  ((:'jD6a'::jsonb)->>'changed') || ',' || ((:'jD6b'::jsonb)->>'changed') || ':' || ((:'jD6b'::jsonb)->>'status')
  || ':' || (((:'jD6b'::jsonb)->>'receivedBy') = :mgr::text)::text,
  'true,false:received:true',
  'D6: receive changes once; the second answers changed false with who received it (P24)');
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rG'))::text as "jD7a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rG'))::text as "jD7b" \gset
select is(
  ((:'jD7a'::jsonb)->>'status') || ',' || ((:'jD7b'::jsonb)->>'changed') || ':' || ((:'jD7b'::jsonb)->>'status')
  || ':' || (((:'jD7b'::jsonb)->>'closedBy') = :mgr::text)::text
  || ',' || pg_temp.held(:itX, :'stA')::text || ',' || pg_temp.balanced(:itX)::text,
  'closed,false:closed:true,1,true',
  'D7: a plain Staging restock closes (Staging +1, holdings equal on hand); a second close answers "already closed by"');
-- case: deny_reason_blank
-- case: deny_reason_too_long
select pg_temp.rpc('authenticated', :mgr, format('select public.deny_return(%L, %L)', :'rI', '   '))::text as "jD8a" \gset
select pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.deny_return(%L, %L)', :'rI', repeat('x', 1001)))) as "eD8" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.deny_return(%L, %L)', :'rI', 'Not ours'))::text as "jD8b" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.deny_return(%L, %L)', :'rI', 'Not ours'))::text as "jD8c" \gset
select is(
  pg_temp.err(:'jD8a'::jsonb) || ',' || :'eD8' || ',' || ((:'jD8b'::jsonb)->>'status') || ',' || ((:'jD8c'::jsonb)->>'changed')
  || ',' || (select r.denial_reason || ':' || (r.denied_by = :mgr)::text from public.returns r where r.id = :'rI')
  || ',' || (select string_agg(d.kind || '/' || coalesce(d.reason, '-'), ',' order by d.seq) from public.return_decisions d where d.return_id = :'rI'),
  'P0001:reason_required,22023:return_invalid,denied,false,Not ours:true,created/-,denied/Not ours',
  'D8: deny needs a reason of 1 to 1,000 characters (G18), then denies once, and records the reason on the header and the log');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rN',
          pg_temp.dec((select id from public.return_lines where return_id = :'rN'), 'restock', 'staging')::text))::text as "jD9" \gset
select is(
  ((:'jD9'::jsonb)->>'status') || ':' || ((:'jD9'::jsonb)->>'revision')
  || ',' || (select string_agg(d.kind || '/' || d.channel || '/' || coalesce(d.revision::text, '-'), ',' order by d.seq)
               from public.return_decisions d where d.return_id = :'rN' and d.kind <> 'disposition_planned')
  || ',' || (select r.status || ':' || (r.received_by = :mgr)::text from public.returns r where r.id = :'rN'),
  'received:1,created/counter/-,approved/counter/1,received/counter/-,received:true',
  'D9: approve with "The item is here" approves and receives in one transaction on the counter channel (G1)');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oX,
          pg_temp.one(:lX2, 1)::text))->>'returnId') as "rC" \gset
select pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.cancel_return(%L, 5, null)', :'rC'))) as "eD10" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.cancel_return(%L, 0, %L)', :'rC', 'Sent by mistake'))::text as "jD10a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.cancel_return(%L, 1, null)', :'rC'))::text as "jD10b" \gset
select is(
  :'eD10' || ',' || ((:'jD10a'::jsonb)->>'status') || ':' || ((:'jD10a'::jsonb)->>'revision') || ',' || ((:'jD10b'::jsonb)->>'changed')
  || ',' || (select string_agg(d.kind || '/' || coalesce(d.revision::text, '-') || '/' || coalesce(d.reason, '-'), ',' order by d.seq)
               from public.return_decisions d where d.return_id = :'rC'),
  'P0001:return_changed,cancelled:1,false,created/-/-,cancelled/1/Sent by mistake',
  'D10: cancel checks the revision, cancels once with its revision and optional reason, then answers changed false');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.deny_return(%L, %L)', :'rN', repeat('x', 1001))))
  || ',' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rC'))),
  'P0001:invalid_status_transition,P0001:invalid_status_transition',
  'D11: deny of a received RMA and receive of a cancelled one are invalid_status_transition');
-- A key row approve_return did not complete (no approved decision at the next
-- revision) is taken over, never trusted (F11): a planted row would otherwise
-- wedge this approval (return_changed) or fake its replay.
select is(
  (select (j->>'status') || ':' || (j->>'changed') || ':' || coalesce(j->>'replay', '-')
     from (select pg_temp.try_rpc('authenticated', :mgr,
             format('select public.approve_return(%L, 0, %L::jsonb)', :'rQ',
                    pg_temp.dec((select id from public.return_lines where return_id = :'rQ'), 'restock', 'staging')::text),
             format($q$insert into public.idempotency_keys (organization_id, scope, key, request_hash, status, resource_type, resource_id, response)
                       values (%L, 'return_approval', %L, 'planted', 'completed', 'return', %L, '{"revision": 9}'::jsonb)$q$,
                    :orgA, :'rQ' || ':0', :'rQ')) as j) x),
  'approved:true:false',
  'D12: a planted approval key row (no approved decision behind it) is taken over: the approval goes through (F11)');

-- ══ E. Acceptance 36, inbound half: back to 31-C ══════════════════════════
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lM, 1)::text))->>'returnId') as "rM" \gset
select id as "rMl" from public.return_lines where return_id = :'rM' \gset
select pg_temp.snap(:itM) as "snapM0" \gset
select is(
  (select (l->>'case') || ':' || (l->>'offerOriginal') || ':' || (l->>'preselect') || ':'
          || jsonb_array_length(l->'sources')::text || ':' || ((l->'sources'->0->>'locationId') = :r31C::text)::text || ':'
          || (l->'sources'->0->>'valid') || ':' || (l->'sources'->0->>'remaining') || ':' || (l->'sources'->0->>'name')
     from (select pg_temp.rpc('authenticated', :mgr, format('select public.return_restock_options(%L)', :'rM'))->'lines'->0 as l) x),
  'single_source:true:original:1:true:true:1:31-C',
  'E1: the destination read proves 31-C from the recorded draw, valid, and preselects Return to original rack (G12)');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rM',
          pg_temp.dec(:'rMl', 'restock', 'original')::text))::text as "jE2" \gset
select is(
  ((:'jE2'::jsonb)->>'status') || '|' || (pg_temp.snap(:itM) = :'snapM0')::text,
  'approved|true',
  'E2: approval with the original rack moves nothing: on hand, holdings and movements unchanged (brief 14)');
select is(
  (select string_agg(d.kind || '/' || coalesce(d.disposition, '-') || '/' || coalesce(d.restock_target, '-') || '/' || coalesce(d.basis, '-'), ',' order by d.seq)
     from public.return_decisions d where d.return_id = :'rM'),
  'created/-/-/-,disposition_planned/restock/original/single_source,approved/-/-/-',
  'E3: the log holds the created, planned (original, single_source) and approved decisions');
select pg_temp.rpc('authenticated', :mgr, format('select public.receive_return(%L)', :'rM'))::text as "jE4" \gset
select is(
  ((:'jE4'::jsonb)->>'status') || '|' || (pg_temp.snap(:itM) = :'snapM0')::text,
  'received|true',
  'E4: receiving moves nothing either');
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rM'))::text as "jE5" \gset
select is(
  ((:'jE5'::jsonb)->>'status') || ':' || (((:'jE5'::jsonb)->'legs'->0->>'locationId') = :r31C::text)::text || ':'
  || ((:'jE5'::jsonb)->'legs'->0->>'destination') || ':' || ((:'jE5'::jsonb)->'legs'->0->>'quantity')
  || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :itM)
  || '|' || pg_temp.held(:itM, :r31C)::text || '|' || pg_temp.held(:itM, :'stA')::text || '|' || pg_temp.balanced(:itM)::text
  || '|' || (select count(*)::text || ':' || string_agg((m.to_location_id = :r31C)::text || ':' || trim_scale(m.quantity_change)::text
                                                        || ':' || (m.reason = 'Return restock (return ' || :'rM' || ')')::text || ':' || m.via_ledger::text
                                                        || ':' || (m.draw is null)::text, ',')
               from public.stock_movements m where m.reference_type = 'return' and m.reference_id = :'rM')
  || '|' || (select trim_scale(returned_quantity)::text from public.order_request_lines where id = :lM)
  || '|' || (select applied::text from public.return_lines where id = :'rMl')
  || '|' || (select status from public.returns where id = :'rM'),
  'closed:true:rack:1|5|5|0|true|1:true:1:true:true:true|1|true|closed',
  'E5: the close returns the Medium to 31-C: on hand +1, 31-C +1, Staging +0, holdings = on hand, one return movement to 31-C on the RMA, the budget +1, the line applied (brief 36)');
select is(
  (select string_agg(d.kind, ',' order by d.seq) from public.return_decisions d where d.return_id = :'rM')
  || '|' || (((:'jE5'::jsonb)->'lines'->0->>'returnLineId') = :'rMl')::text
  || ':' || ((:'jE5'::jsonb)->'lines'->0->>'disposition') || ':' || ((:'jE5'::jsonb)->'lines'->0->>'target')
  || ':' || jsonb_array_length((:'jE5'::jsonb)->'lines'->0->'legs')::text,
  'created,disposition_planned,approved,received,closed|true:restock:original:1',
  'E6: the decision log reads the RMA end to end, and the close answers per line (disposition, planned target, its legs)');

-- ══ F. Acceptance 37: Staging ═════════════════════════════════════════════
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lS, 1)::text))->>'returnId') as "rS" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rS',
          pg_temp.dec((select id from public.return_lines where return_id = :'rS'), 'restock', 'staging')::text))::text as "jF1a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rS'))::text as "jF1b" \gset
select is(
  ((:'jF1a'::jsonb)->>'status') || ',' || ((:'jF1b'::jsonb)->>'status')
  || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :itS)
  || '|' || pg_temp.held(:itS, :'stA')::text || '|' || pg_temp.held(:itS, :r31C)::text || '|' || pg_temp.balanced(:itS)::text
  || '|' || (select (m.to_location_id is null)::text || ':' || ((((m.draw).holdings)[1]).location_id = :'stA'::uuid)::text
               from public.stock_movements m where m.reference_type = 'return' and m.reference_id = :'rS'),
  'received,closed|3|1|2|true|true:true',
  'F1: Leave in Staging: on hand +1, Staging +1 with a recorded draw, 31-C unchanged (brief 37)');

-- ══ G. Acceptance 38: Scrap ═══════════════════════════════════════════════
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          jsonb_build_object('reasonCode', 'damaged', 'lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lScr, 'quantity', 1, 'disposition', 'restock')))::text))->>'returnId') as "rScr" \gset
select id as "rScrl" from public.return_lines where return_id = :'rScr' \gset
select is(
  (select r.reason_code || ':' || rl.disposition from public.returns r join public.return_lines rl on rl.return_id = r.id where r.id = :'rScr'),
  'damaged:restock',
  'G1: the reason Damaged never selects scrap by itself (brief 38)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rScr',
                  pg_temp.dec(:'rScrl', 'scrap', 'original')::text))),
  '22023:return_invalid',
  'G2: scrap with a destination is refused (brief 10)');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rScr', pg_temp.dec(:'rScrl', 'scrap')::text))::text as "jG3a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rScr'))::text as "jG3b" \gset
select is(
  ((:'jG3a'::jsonb)->>'status') || ',' || ((:'jG3b'::jsonb)->>'status')
  || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :itScr)
  || '|' || pg_temp.held(:itScr, :r32A)::text || '|' || pg_temp.held(:itScr, :'stA')::text || '|' || pg_temp.balanced(:itScr)::text
  || '|' || (select string_agg(m.movement_type || trim_scale(m.quantity_change)::text, ',' order by m.movement_type desc)
               from public.stock_movements m where m.reference_type = 'return' and m.reference_id = :'rScr')
  || '|' || (select trim_scale(returned_quantity)::text from public.order_request_lines where id = :lScr),
  'received,closed|2|2|0|true|return1,loss-1|1',
  'G3: scrap: nothing on any rack or in Staging, on hand net 0 (+1 return, -1 loss), the budget consumed once (brief 38)');
select pg_temp.snap(:itScr) as "snapScr1" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rScr'))::text as "jG4" \gset
select is(
  ((:'jG4'::jsonb)->>'changed')
  || ',' || pg_temp.attempt('authenticated', :mgr, format('select public.process_return_disposition(%L)', :'rScr'))
  || ',' || (pg_temp.snap(:itScr) = :'snapScr1')::text
  || ',' || (select trim_scale(returned_quantity)::text from public.order_request_lines where id = :lScr),
  'false,P0001:-:invalid_status_transition,true,1',
  'G4: a repeated close answers already closed, the frozen wrapper refuses it, nothing moves again');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
          pg_temp.one(:lG, 1, 'scrap')::text))->>'returnId') as "rG16" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rG16',
          pg_temp.dec((select id from public.return_lines where return_id = :'rG16'), 'scrap')::text))::text as "jG5a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rG16'))::text as "jG5b" \gset
select is(
  ((:'jG5a'::jsonb)->>'status') || ',' || ((:'jG5b'::jsonb)->>'status')
  || '|' || pg_temp.held(:itG, :'stA')::text || '|' || pg_temp.held(:itG, :'stB')::text
  || '|' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :itG) || '|' || pg_temp.balanced(:itG)::text,
  'received,closed|2|4|6|true',
  'G5: G16 pinned: with two Staging holdings the scrap lands in the item''s Staging and drains the larger one (today''s behaviour, totals net zero)');

-- ══ H. Acceptance 39: the original rack was not recorded ══════════════════
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oK,
          pg_temp.one(:lK, 1)::text))->>'returnId') as "rK" \gset
select id as "rKl" from public.return_lines where return_id = :'rK' \gset
select is(
  (select (l->>'case') || ':' || (l->>'notRecordedReason') || ':' || jsonb_array_length(l->'sources')::text || ':'
          || (l->>'offerOriginal') || ':' || (l->>'preselect')
     from (select pg_temp.rpc('authenticated', :mgr, format('select public.return_restock_options(%L)', :'rK'))->'lines'->0 as l) x),
  'not_recorded:no_draw:0:false:staging',
  'H1: a pick without a recorded draw is not recorded: no source, Staging preselected (brief 39)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rK',
                  pg_temp.dec(:'rKl', 'restock', 'original')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rK',
                  pg_temp.dec(:'rKl', 'restock', 'source', :r31C)::text))),
  'P0001:restock_location_not_offered,P0001:restock_location_not_offered',
  'H2: Return to original rack and a guessed source are refused with one generic answer (bin_location is no history)');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rK',
          pg_temp.dec(:'rKl', 'restock', 'staging')::text))::text as "jH3a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rK'))::text as "jH3b" \gset
select is(
  ((:'jH3a'::jsonb)->>'status') || ',' || ((:'jH3b'::jsonb)->>'status')
  || ',' || pg_temp.held(:itK, :'stA')::text || ',' || pg_temp.balanced(:itK)::text,
  'received,closed,1,true',
  'H3: Staging remains, and closes');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ','), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ledger' and p.proname in ('return_line_sources', 'return_line_plans_original', 'return_line_restock_legs', 'return_restock_original')
      and regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') ~* '(bin_location|primary_location_id|custom_fields)'),
  '',
  'H4: the resolver never reads bin_location, primary_location_id or the custom_fields rack keys (brief 11, 13, 39)');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lV, 1)::text))->>'returnId') as "rV" \gset
select id as "rVl" from public.return_lines where return_id = :'rV' \gset
select is(
  (ledger.return_line_sources(:'rVl')->>'case')
  || ',' || pg_temp.undone(
       format($q$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, reason)
                 values (%L, %L, 'transfer', 1, 1, 2, 'Reopen picking (order_request ' || %L || ')')$q$, :orgA, :itV, :oA),
       format($q$select (ledger.return_line_sources(%L)->>'case') || '/' || (ledger.return_line_sources(%L)->>'notRecordedReason')$q$, :'rVl', :'rVl'))
  || ',' || pg_temp.undone(
       format($q$insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled) values (%L, %L, 1, 0)$q$, :oA, :itV),
       format($q$select (ledger.return_line_sources(%L)->>'case') || '/' || (ledger.return_line_sources(%L)->>'notRecordedReason')$q$, :'rVl', :'rVl'))
  || ',' || pg_temp.undone(
       format($q$update public.order_request_lines set quantity_fulfilled = 2, quantity_requested = 2 where id = %L$q$, :lV),
       format($q$select (ledger.return_line_sources(%L)->>'case') || '/' || (ledger.return_line_sources(%L)->>'notRecordedReason')$q$, :'rVl', :'rVl')),
  'single_source,not_recorded/reopened,not_recorded/duplicate_line,not_recorded/drawn_mismatch',
  'H5: a Reopen picking movement, a second line of the item and a drawn total that differs from what was handed over each make the line not recorded');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, user_id)
              values (%L, %L, 'transfer', 1, 1, 2, 'Reopen picking (order_request ' || %L || ')', %L)$q$, :orgA, :itV, :oA, :mgr),
    null,
    format($q$select (select string_agg(via_ledger::text, ',') from public.stock_movements where item_id = %L and reason like 'Reopen picking%%')
                     || '/' || (ledger.return_line_sources(%L)->>'case')$q$, :itV, :'rVl')),
  'ok:1:false/single_source',
  'H7: a Reopen picking row a member wrote directly (via_ledger false) leaves a proven line proven; only a ledger row counts (F9)');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oU,
          pg_temp.one(:lU, 3)::text))->>'returnId') as "rU" \gset
select is(
  (select (l->>'case') || ':' || (l->>'offerOriginal') || ':' || jsonb_array_length(l->'offerSourceIds')::text || ':'
          || (select string_agg((s->>'valid') || '/' || (s->>'reason'), ',') from jsonb_array_elements(l->'sources') s)
     from (select pg_temp.rpc('authenticated', :mgr, format('select public.return_restock_options(%L)', :'rU'))->'lines'->0 as l) x),
  'full_remainder:false:0:false/not_a_placement,false/not_a_placement,false/not_a_placement',
  'H6: a draw from Staging, Unplaced or a Site is never offered as an original location (D12)');

-- ══ I. Acceptance 40: the rack is gone before the close ═══════════════════
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lR, 1)::text))->>'returnId') as "rR" \gset
select id as "rRl" from public.return_lines where return_id = :'rR' \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rR',
          pg_temp.dec(:'rRl', 'restock', 'original')::text))::text as "jI1" \gset
select is((:'jI1'::jsonb)->>'status', 'received', 'I1: approved to 40-A and received at the counter');
update public.locations set deleted_at = now() where id = :r40;
select pg_temp.snap(:itR) as "snapR0" \gset
select pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rR'))::text as "jI2" \gset
select is(
  pg_temp.err(:'jI2'::jsonb) || ':' || (((:'jI2'::jsonb)->>'detail')::jsonb->>'rule')
  || ':' || ((((:'jI2'::jsonb)->>'detail')::jsonb->>'locationId') = :r40::text)::text,
  'P0001:restock_location_unavailable:archived:true',
  'I2: 40-A archived after approval: the close is refused restock_location_unavailable (rule archived), never a silent Staging fallback (brief 17)');
select is(
  (select status from public.returns where id = :'rR') || '|' || (pg_temp.snap(:itR) = :'snapR0')::text
  || '|' || (select trim_scale(returned_quantity)::text from public.order_request_lines where id = :lR)
  || '|' || (select applied::text from public.return_lines where id = :'rRl')
  || '|' || (select (l->'sources'->0->>'reason') || ':' || (l->>'offerOriginal')
               from (select pg_temp.rpc('authenticated', :mgr, format('select public.return_restock_options(%L)', :'rR'))->'lines'->0 as l) x),
  'received|true|0|false|archived:false',
  'I3: nothing moved (on hand, holdings, movements, budget, latch), the RMA stays received, and the read says why');
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L, %L::jsonb)', :'rR',
          (pg_temp.dec(:'rRl', 'restock', 'staging')->'lines')::text))::text as "jI4" \gset
select is(
  ((:'jI4'::jsonb)->>'status')
  || '|' || pg_temp.held(:itR, :'stA')::text || '|' || pg_temp.held(:itR, :r40)::text || '|' || pg_temp.balanced(:itR)::text,
  'closed|1|1|true',
  'I4: re-planned to Staging inside the close, it completes safely (brief 40)');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rV',
          pg_temp.dec(:'rVl', 'restock', 'original')::text))::text as "jI5" \gset
select is(
  ((:'jI5'::jsonb)->>'status')
  || ',' || (select ((j->>'detail')::jsonb->>'rule') from (select pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rV'),
                  format('update public.locations set warehouse_id = %L where id = %L', :whB, :r41)) as j) x)
  || ',' || (select ((j->>'detail')::jsonb->>'rule') from (select pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rV'),
                  format($q$update public.locations set kind = null, type = 'room' where id = %L$q$, :r41)) as j) x)
  || ',' || (select ((j->>'detail')::jsonb->>'rule') from (select pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rV'),
                  format($q$update public.warehouses set status = 'inactive' where id = %L$q$, :whA)) as j) x)
  || ',' || (select ((j->>'detail')::jsonb->>'rule') from (select pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rV'),
                  format('update public.inventory_items set deleted_at = now() where id = %L', :itV)) as j) x),
  'received,moved_warehouse,not_a_placement,warehouse_inactive,item_deleted',
  'I5: a rack moved to another warehouse, turned into a Site, in a closed warehouse, or a deleted item: each refuses the close with its rule');
-- Every refusal the close answers carries a hint (desk check F7): the
-- restated body's bare tokens are raised again by close_return; the frozen
-- wrapper an old tab calls keeps today's bare token.
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rN'),
     format('update public.order_request_lines set returned_quantity = quantity_fulfilled where id = %L', :lX1)))
  || ',' || pg_temp.attempt('authenticated', :mgr, format('select public.process_return_disposition(%L)', :'rN'),
     format('update public.order_request_lines set returned_quantity = quantity_fulfilled where id = %L', :lX1))
  || ',' || (select status from public.returns where id = :'rN'),
  'P0001:return_exceeds_fulfilled,P0001:-:return_exceeds_fulfilled,received',
  'I6: a close the restated body refuses (a forged budget) answers with the hint the app maps; the frozen wrapper keeps its bare token; nothing changed (F7)');
-- oW's pick drew from 51-B in the second warehouse. stfRm writes only the
-- main warehouse (the order's): it may manage the RMA, not stock that rack.
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oW,
          pg_temp.one(:lW, 1)::text))->>'returnId') as "rW" \gset
select id as "rWl" from public.return_lines where return_id = :'rW' \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rW',
          pg_temp.dec(:'rWl', 'restock', 'original')::text))::text as "jI7a" \gset
select pg_temp.try_rpc('authenticated', :stfRm, format('select public.close_return(%L)', :'rW'))::text as "jI7b" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rW'))::text as "jI7c" \gset
select is(
  ((:'jI7a'::jsonb)->>'status') || '|' || pg_temp.err(:'jI7b'::jsonb) || ':' || (((:'jI7b'::jsonb)->>'detail')::jsonb->>'rule')
  || ':' || ((((:'jI7b'::jsonb)->>'detail')::jsonb->>'locationId') = :rB1::text)::text
  || '|' || ((:'jI7c'::jsonb)->>'status') || '|' || pg_temp.held(:itW, :rB1)::text || '|' || pg_temp.balanced(:itW)::text,
  'received|42501:restock_location_forbidden:location_write:true|closed|3|true',
  'I7: a closer who may not stock the original rack''s warehouse is refused restock_location_forbidden (never "no permission to manage returns"); a manager''s close puts the unit back on 51-B (F7)');

-- ══ J. Several sources ════════════════════════════════════════════════════
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lC2, 3)::text))->>'returnId') as "rC2" \gset
select id as "rC2l" from public.return_lines where return_id = :'rC2' \gset
select is(
  (select (l->>'case') || ':' || (l->>'offerOriginal') || ':'
          || (select string_agg((s->>'name') || '/' || (s->>'remaining'), ',' order by s->>'name' collate "C") from jsonb_array_elements(l->'sources') s)
     from (select pg_temp.rpc('authenticated', :mgr, format('select public.return_restock_options(%L)', :'rC2'))->'lines'->0 as l) x),
  'full_remainder:true:32-A/1,33-B/2',
  'J1: a full return of a two-rack pick is full_remainder: 32-A x1 and 33-B x2 (brief 12)');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rC2',
          pg_temp.dec(:'rC2l', 'restock', 'original')::text))::text as "jJ2a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rC2'))::text as "jJ2b" \gset
select is(
  ((:'jJ2a'::jsonb)->>'status') || ',' || ((:'jJ2b'::jsonb)->>'status')
  || '|' || pg_temp.held(:itC2, :r32A)::text || ',' || pg_temp.held(:itC2, :r33B)::text || ',' || pg_temp.held(:itC2, :'stA')::text
  || '|' || (select string_agg(l.name || ':' || trim_scale(m.quantity_change)::text, ',' order by l.name collate "C")
               from public.stock_movements m join public.locations l on l.id = m.to_location_id
              where m.reference_type = 'return' and m.reference_id = :'rC2')
  || '|' || pg_temp.balanced(:itC2)::text,
  'received,closed|1,2,0|32-A:1,33-B:2|true',
  'J2: the close places the exact legs, one movement per rack');
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lP, 1)::text))->>'returnId') as "rP1" \gset
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lP, 1)::text))->>'returnId') as "rP2" \gset
select (pg_temp.rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oA,
          pg_temp.one(:lP, 2)::text))->>'returnId') as "rP3" \gset
select id as "rP1l" from public.return_lines where return_id = :'rP1' \gset
select id as "rP2l" from public.return_lines where return_id = :'rP2' \gset
select id as "rP3l" from public.return_lines where return_id = :'rP3' \gset
select is(
  (select (l->>'case') || ':' || (l->>'offerOriginal') || ':'
          || (select string_agg(x, ',' order by x collate "C") from jsonb_array_elements_text(l->'offerSourceIds') x)
     from (select pg_temp.rpc('authenticated', :mgr, format('select public.return_restock_options(%L)', :'rP1'))->'lines'->0 as l) x),
  'partial:false:' || :r34A::text || ',' || :r35B::text,
  'J3: a part of a two-rack pick is partial: Staging preselected, either actual rack offered');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rP1', pg_temp.dec(:'rP1l', 'restock', 'original')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rP3', pg_temp.dec(:'rP3l', 'restock', 'source', :r34A)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rP3', pg_temp.dec(:'rP3l', 'restock', 'source', :rOther)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rP3', pg_temp.dec(:'rP3l', 'restock', 'source', :nobody)::text))) || ','
  || coalesce(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rP3', pg_temp.dec(:'rP3l', 'restock', 'source', :r35B)::text))->>'status', 'error'),
  'P0001:restock_location_not_offered,P0001:restock_location_not_offered,P0001:restock_location_not_offered,P0001:restock_location_not_offered,approved',
  'J4: partial refuses "all original racks"; a source over its remaining, a rack that was no source and a guessed id are refused alike; a source with room passes');
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rP1', pg_temp.dec(:'rP1l', 'restock', 'source', :r34A)::text))::text as "jJ5a" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb, true)', :'rP2', pg_temp.dec(:'rP2l', 'restock', 'source', :r34A)::text))::text as "jJ5b" \gset
select is(
  ((:'jJ5a'::jsonb)->>'status') || ',' || ((:'jJ5b'::jsonb)->>'status')
  || ',' || (select string_agg(d.restock_target || '/' || d.basis, ',') from public.return_decisions d where d.return_id = :'rP1' and d.kind = 'disposition_planned'),
  'received,received,source/manager_choice',
  'J5: both pending RMAs plan 34-A (room for one each, now), recorded as a manager choice');
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rP1'))::text as "jJ6" \gset
select is(
  ((:'jJ6'::jsonb)->>'status') || ',' || pg_temp.held(:itP, :r34A)::text,
  'closed,1',
  'J6: the first close puts its unit back on 34-A');
select pg_temp.try_rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rP2'))::text as "jJ7" \gset
select is(
  pg_temp.err(:'jJ7'::jsonb) || ':' || (((:'jJ7'::jsonb)->>'detail')::jsonb->>'rule') || '|' || pg_temp.held(:itP, :r34A)::text
  || '|' || (select status from public.returns where id = :'rP2'),
  'P0001:restock_location_unavailable:remaining|1|received',
  'J7: rule 9: the second close re-derives 34-A''s remaining (0) and raises, never caps (judge B-7)');
select is(
  pg_temp.err(pg_temp.try_rpc('postgres', null,
    format('select jsonb_build_object(''done'', true) from (select ledger.return_restock_original(%L, %L, %L, 5, %L)) s', :'rP2', :'rP2l', :itP, :mgr)))
  || ',' || pg_temp.err(pg_temp.try_rpc('postgres', null,
    format('select jsonb_build_object(''done'', true) from (select ledger.return_restock_original(%L, %L, %L, 5, %L)) s', :'rV', :'rVl', :itV, :mgr))),
  'P0001:restock_location_unavailable,P0001:restock_plan_mismatch',
  'J8: the rack leg refuses a leg over its remaining, and legs that do not sum to the line (restock_plan_mismatch)');
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L, %L::jsonb)', :'rP2',
          (pg_temp.dec(:'rP2l', 'restock', 'staging')->'lines')::text))::text as "jJ9" \gset
select is(
  ((:'jJ9'::jsonb)->>'status') || ',' || pg_temp.balanced(:itP)::text,
  'closed,true',
  'J9: re-planned to Staging, the second RMA closes');

-- ══ K. Direct writes and the old tabs ═════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$insert into public.returns (organization_id, order_request_id, status) values (%L, %L, 'received')$q$, :orgA, :oX)),
  '42501:return_insert_through_rpc:return_insert_through_rpc',
  'K1: a raw insert at received is refused (G2)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$insert into public.returns (organization_id, order_request_id, status, approved_by) values (%L, %L, 'requested', %L)$q$, :orgA, :oX, :mgr))
  || ',' || pg_temp.attempt('authenticated', :mgr, format($q$insert into public.returns (organization_id, order_request_id, status, requested_by) values (%L, %L, 'requested', %L)$q$, :orgA, :oX, :own)),
  '42501:return_insert_through_rpc:return_insert_through_rpc,42501:return_stamp_forged:return_stamp_forged',
  'K2: a raw insert carrying a stamp, or naming another requester, is refused');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.returns set status = 'closed' where id = %L$q$, :'rV')),
  '42501:return_close_through_rpc:return_close_through_rpc',
  'K3: a raw PATCH into closed is refused: no stranded close (G2)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.return_lines set disposition = 'scrap' where id = %L$q$, :'rVl'))
  || ',' || pg_temp.attempt('authenticated', :mgr, format('update public.return_lines set applied = true where id = %L', :'rVl'))
  || ',' || pg_temp.attempt('authenticated', :mgr, format('delete from public.returns where id = %L', :'rV')),
  '42501:-:permission denied for table return_lines,42501:-:permission denied for table return_lines,42501:-:permission denied for table returns',
  'K4: no API role updates a return line (forged disposition or latch) or deletes an RMA');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition, applied) values (%L, %L, %L, %L, 1, 'restock', true)$q$,
           :'rI', :orgA, :lX1, :itX))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values (%L, %L, %L, %L, 1, 'restock')$q$,
           :'rV', :orgA, :lX1, :itX)),
  '42501:return_line_insert_through_rpc:return_line_insert_through_rpc,42501:return_line_insert_through_rpc:return_line_insert_through_rpc',
  'K5: a raw line insert already applied, or on an RMA past requested, is refused');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.return_decisions (organization_id, return_id, kind, channel, actor_kind) values (%L, %L, 'received', 'staff', 'staff')$q$, :orgA, :'rV'))
  || ',' || pg_temp.attempt('authenticated', :mgr, format($q$update public.return_decisions set reason = 'x' where return_id = %L$q$, :'rV'))
  || ',' || pg_temp.attempt('postgres', null, format($q$update public.return_decisions set channel = 'system' where return_id = %L$q$, :'rV')),
  '42501:-:permission denied for table return_decisions,42501:-:permission denied for table return_decisions,'
  || '42501:return_decisions_append_only:return_decisions_append_only',
  'K6: the decision log is never written by an API role, and never updated by anyone');
-- The old tab (up to 12 hours under skew protection): raw create, approve,
-- receive, deny and cancel of return-only RMAs keep working, kept here.
select pg_temp.write_as('authenticated', :mgr,
    format($q$insert into public.returns (id, organization_id, order_request_id, return_number, status, source, reason_code, requested_by) values (%L, %L, %L, 'RMA-OLDTAB-0001', 'requested', 'internal', 'other', %L)$q$, :kOld, :orgA, :oX, :mgr)) as "wK7a" \gset
select pg_temp.write_as('authenticated', :mgr,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values (%L, %L, %L, %L, 1, 'restock')$q$, :kOld, :orgA, :lX1, :itX)) as "wK7b" \gset
select pg_temp.write_as('authenticated', :mgr,
    format($q$update public.returns set status = 'approved', approved_by = %L, approved_at = '2001-01-01' where id = %L and status = 'requested'$q$, :mgr, :kOld)) as "wK7c" \gset
select (select (approved_at > now() - interval '1 minute')::text from public.returns where id = :kOld) as "tK7" \gset
select pg_temp.write_as('authenticated', :mgr,
    format($q$update public.returns set status = 'received', received_by = %L, received_at = now() where id = %L and status = 'approved'$q$, :mgr, :kOld)) as "wK7d" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.process_return_disposition(%L)).status', :kOld)) as "wK7e" \gset
select is(
  :'wK7a' || ',' || :'wK7b' || ',' || :'wK7c' || ',' || :'tK7' || ',' || :'wK7d' || ',' || :'wK7e',
  'ok:1,ok:1,ok:1,true,ok:1,closed',
  'K7: the old tab''s raw create, approve (its time made now()), receive and wrapper close of a return-only RMA still work');
select pg_temp.write_as('authenticated', :mgr,
    format($q$insert into public.returns (id, organization_id, order_request_id, return_number, status, source, requested_by) values (%L, %L, %L, 'RMA-OLDTAB-0002', 'requested', 'internal', %L), (%L, %L, %L, 'RMA-OLDTAB-0003', 'requested', 'internal', %L)$q$,
           :kOld2, :orgA, :oX, :mgr, :kOld3, :orgA, :oX, :mgr)) as "wK8a" \gset
select pg_temp.write_as('authenticated', :mgr,
    format($q$update public.returns set status = 'denied', denied_by = %L, denied_at = now(), denial_reason = 'Old tab' where id = %L$q$, :mgr, :kOld2)) as "wK8b" \gset
select pg_temp.write_as('authenticated', :mgr, format($q$update public.returns set status = 'cancelled' where id = %L$q$, :kOld3)) as "wK8c" \gset
select is(
  :'wK8a' || ',' || :'wK8b' || ',' || :'wK8c'
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$update public.returns set status = 'approved', approved_by = %L, approved_at = now() where id = %L$q$, :own, :'rU'))
  || ',' || pg_temp.attempt('authenticated', :mgr, format($q$update public.returns set approved_by = %L where id = %L$q$, :own, :kOld3)),
  'ok:2,ok:1,ok:1,42501:return_stamp_forged:return_stamp_forged,42501:return_stamp_forged:return_stamp_forged',
  'K8: the old tab''s deny and cancel work; a stamp naming someone else, or a stamp changed without an edge, is refused');
select pg_temp.call_as('authenticated', :mgr, format('select (public.process_return_disposition(%L)).status', :'rV')) as "wK9" \gset
select is(
  :'wK9' || '|' || pg_temp.held(:itV, :r41)::text || '|' || pg_temp.held(:itV, :'stA')::text || '|' || pg_temp.balanced(:itV)::text,
  'closed|2|0|true',
  'K9: an old tab closing through the frozen wrapper honours the planned original rack (41-A +1)');
-- returns:manage is fully grantable, so the warehouse bounds the raw paths
-- too (F2): stfRm writes only the main warehouse; rB is the second's.
select is(
  pg_temp.attempt('authenticated', :stfRm,
    format($q$insert into public.returns (organization_id, order_request_id, status, source) values (%L, %L, 'requested', 'internal')$q$, :orgA, :oB))
  || ',' || pg_temp.attempt('authenticated', :stfRm, format($q$update public.returns set status = 'cancelled' where id = %L$q$, :'rB'))
  || ',' || pg_temp.attempt('authenticated', :stfRm, format($q$update public.returns set status = 'denied', denied_by = %L, denied_at = now(), denial_reason = 'x' where id = %L$q$, :stfRm, :'rB'))
  || ',' || pg_temp.attempt('authenticated', :stfRm,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values (%L, %L, %L, %L, 1, 'restock')$q$,
           :'rB', :orgA, :lB2, :itX))
  || ',' || pg_temp.attempt('authenticated', :stfRm,
    format($q$insert into public.returns (organization_id, order_request_id, status, source) values (%L, %L, 'requested', 'internal')$q$, :orgA, :oX),
    null, format('select requested_by = %L from public.returns where order_request_id = %L and requested_by = %L', :stfRm, :oX, :stfRm)),
  '42501:warehouse_write:warehouse_write,ok:0,ok:0,42501:warehouse_write:warehouse_write,ok:1:true',
  'K10: the same staff member''s raw insert on the second warehouse''s order is refused warehouse_write, a raw cancel or deny of its RMA reaches no row, a raw line on it is refused; on the main warehouse the raw insert works (F2)');
select is(
  pg_temp.attempt('authenticated', :mgrAZ,
    format($q$insert into public.returns (organization_id, order_request_id, status, source) values (%L, %L, 'requested', 'internal')$q$, :orgA, :oZ))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values (%L, %L, %L, %L, 1, 'restock')$q$,
           :'rQ', :orgA, :lB2, :itX))
  || ',' || pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values (%L, %L, %L, %L, 1, 'restock')$q$,
           :'rQ', :orgA, :lX1, :itX)),
  'P0002:order_not_found:order_not_found,22023:return_invalid:return_invalid,ok:1',
  'K11: a member of two organizations cannot file an RMA in one for the other''s order, and a raw line naming another order''s line is refused; a line of the RMA''s own order still goes in (F3)');

-- ══ L. Regression ═════════════════════════════════════════════════════════
select is(
  (select coalesce(string_agg(x.sig, ',' order by x.sig collate "C"), '')
     from (values
       ('public.process_return_disposition(uuid)',                    '7ec76cc98b9cefc31707590071ac14d9'),
       ('ledger.apply_holding_delta(uuid,uuid,numeric)',              'f135bb5c02eb9c919cb8c0d8f8d62faa'),
       ('ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)', '9c3301fedd607398dccc72c7b4cfe371'),
       ('public.location_in_org(uuid,uuid)',                          'b39dcfeb29d7083d049882e18d6b2a8f'),
       ('public.caller_can_write_location(uuid)',                     '188634bf8552a0064bfbf1ebfecf814f'),
       ('public.caller_can_read_item(uuid)',                          '80523d2cc0fafe7fc6b3599903d7f014'),
       ('public.tg_return_lines_enforce_fulfilled_cap()',             '3e990eca8496cb8bfaaa7bf22de858d0'),
       ('public._validate_return_status_transition()',                '70ba38342279e582b380bbeaf0adbe10'),
       ('public._notify_order_request_changes()',                     'a223ae83810149728156b8e299c7425e'),
       ('public._validate_order_request_status_transition()',         'dee8cd4782ec83abdb31a2b48fcd4ef2'),
       ('public.tg_order_requests_insert_guard()',                    'caf69f8a23d03b9bfa6ea87a9cf94077'),
       ('public.tg_order_request_lines_guard()',                      'd899924c0f8fc1dfae4e8be7bd4c5cad'),
       ('public.create_order_request(jsonb,jsonb)',                   '4d65cef6c569a8c2c699fd9d5c8b77d5'),
       ('public.assign_order_request_number()',                       '03097df3cded3d0ea42676855abc6a25'),
       ('public.complete_picking(uuid)',                              'b8f1ef1fb01efa5c04c916c178129541'),
       ('public.confirm_physical_signature(uuid,text)',               'f7a14a46d2c70f635c3da844c786ce67'),
       ('public._notify_recipients(uuid)',                            '679e6193e3dbe5644055e835e8209043'),
       ('public._dispatch_push_for_notification()',                   '17f00da160feb6a7d6609cca4fb6337e'),
       ('public.has_permission(uuid,text)',                           'cc0accdad7e2fdf4f88aa82aa887e85f'),
       ('public.user_can_access_inventory(uuid,uuid,uuid,text)',      '8a214b77e32a052ca3bf07a2be39a8ae'),
       ('public.is_org_member(uuid)',                                 '76492a6556e9f6a7c33d942aa9726f9f'),
       ('public.approve_partial(uuid)',                               '40ca0878733b08a649773fe9b7efd4e0'),
       ('public.cancel_order_request(uuid,text)',                     '47cabcd1fe4f52fb7b2b6b6b64b68da1'),
       ('public.hold_order_stock(uuid)',                              '3b0691d604823164daaa7f248616f00f'),
       ('public.order_readiness_facts(uuid)',                         '2f3fb057bacda8143377ecd9c2c5e6e2'),
       ('public.reopen_picking(uuid,text)',                           '293ce0e76d195bb13105cfd1c067de82'),
       ('public.resume_fulfillment(uuid)',                            '2e2d5aab1db5392250879bfa9ff4bccd'),
       ('public.order_items_orderable(uuid,uuid[])',                  'b4df95d74e32850923a430769f96f246')
     ) x(sig, want)
     left join pg_proc p on p.oid = to_regprocedure(x.sig)
    where md5(p.prosrc) is distinct from x.want),
  '',
  'L1: every frozen body (plan 1.5, re-read at build start against production 0392) keeps its md5(prosrc)');
select is(
  (select string_agg(c.relname || '.' || t.tgname || '=' || md5(pg_get_triggerdef(t.oid)), ','
                     order by c.relname collate "C", t.tgname collate "C")
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname in ('trg_order_requests_notify', 'trg_order_requests_validate_transition', 'trg_assign_order_request_number',
                       'trg_zz_order_requests_insert_guard', 'order_requests_set_updated_at', 'trg_zz_order_request_lines_guard',
                       'trg_returns_validate_transition', 'returns_set_updated_at', 'return_lines_enforce_fulfilled_cap',
                       'trg_notifications_dispatch_push', 'trg_inventory_items_low_stock', 'trg_order_requests_workflow_guard')
      and c.relnamespace = 'public'::regnamespace),
  'inventory_items.trg_inventory_items_low_stock=f14efb7ef2b1fe92012db595bfe0fd2e,'
  || 'notifications.trg_notifications_dispatch_push=075267e9d04e1a9d15f57556f8f0ea03,'
  || 'order_request_lines.trg_zz_order_request_lines_guard=b2f6dad5ca729f93f534cdbc73d8d395,'
  || 'order_requests.order_requests_set_updated_at=f912d1e6de45c8b6c9c8bcacdbc291c3,'
  || 'order_requests.trg_assign_order_request_number=741c34077fbaf5508d979f966affc84d,'
  || 'order_requests.trg_order_requests_notify=8c7961ae9a724879f759cb412f283510,'
  || 'order_requests.trg_order_requests_validate_transition=dcf5294e729dc5900c2d7bd1ad4f6412,'
  || 'order_requests.trg_order_requests_workflow_guard=f25d3ae18d19712e1d7d57a34d6c298b,'
  || 'order_requests.trg_zz_order_requests_insert_guard=67131166ed7932bdd3097cb8a289463c,'
  || 'return_lines.return_lines_enforce_fulfilled_cap=02a36286bf74593d5a9575b211ea7f5c,'
  || 'returns.returns_set_updated_at=60a0a59c195649e72a13404ef58e110a,'
  || 'returns.trg_returns_validate_transition=219e2236f7b30e0f4eb886477a2abe7a',
  'L2: every frozen trigger definition is unchanged (md5 of pg_get_triggerdef)');
select is(
  array(select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
           and p.prosrc ~* '(set_config|set\s+(local\s+)?)[^;]*stockpilot\.ledger'
         order by 1),
  array['public.adjust_stock', 'public.assemble_bundle', 'public.distribute_bundle',
        'public.post_cycle_count', 'public.post_receipt_v2', 'public.process_return_disposition',
        'public.reverse_receipt', 'public.transfer_stock'],
  'L3: 0359 test 17 holds: only the eight wrappers raise the ledger flag (close_return calls the wrapper)');
select (pg_temp.rpc('authenticated', :outZ, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oZ,
          pg_temp.one(:lZ, 1)::text))->>'returnId') as "rZ" \gset
select is(
  (select count(*)::text from public.return_decisions where return_id = :'rZ')
  || ',' || pg_temp.attempt('postgres', null, format('delete from public.organizations where id = %L', :orgZ),
                            null, format('select count(*)::text from public.returns where id = %L', :'rZ')),
  '1,ok:1:0',
  'L4: deleting an organization that holds RMAs and decisions passes (the composite keys cascade; NO ACTION checks at the end)');
select is(
  (select string_agg(i.sku || '=' || pg_temp.balanced(i.id)::text, ',' order by i.sku collate "C")
     from public.inventory_items i where i.organization_id = :orgA),
  '0395-C2=true,0395-G=true,0395-K=true,0395-M=true,0395-P=true,0395-R=true,0395-S=true,0395-SCR=true,0395-U=true,0395-V=true,0395-W=true,0395-X=true,0395-X2=true',
  'L5: holdings equal on hand for every item this suite touched (brief 15)');
select is(
  (select count(*)::int from public.return_decisions d
    where d.organization_id = :orgA
      and not exists (select 1 from public.returns r where r.id = d.return_id and r.organization_id = d.organization_id)),
  0,
  'L6: every decision belongs to an RMA of its own organization');

select * from finish();
rollback;
