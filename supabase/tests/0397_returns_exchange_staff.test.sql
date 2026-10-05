-- supabase/tests/0397_returns_exchange_staff.test.sql
-- pgTAP proof for migration 0397 (returns and exchanges, slice RX-2):
-- exchanges for staff and the counter. A returned line may ask for a
-- replacement; approval creates ONE linked replacement order (its own SO
-- number), reserved by the unchanged approve_partial; the replacement waits
-- for the returned item unless a manager releases it early with a reason;
-- substitution, cancelling a replacement (picked or staged too), issuing a
-- new one and cancelling the RMA keep the order and the RMA in step (plan
-- section 4 RX-2; brief 18-25, 33, 34, 36, 41-43).
--
-- Personas (org A, plus org Z for foreign checks and the deletion):
--   own    owner                       mgr    manager (returns:manage and
--                                             orders:approve by role)
--   req    staff, the member requester of most originals (assigned whA)
--   stfRm  staff granted returns:manage only, assigned whA
--   stfCh  staff granted returns:manage and orders:approve, assigned to whA
--          for charter C1 only (cannot read a C2 item)
--   stfB   staff granted returns:manage and orders:approve, assigned whB only
--   vwr    viewer, assigned whA        gone   staff who later left (D7)
--   req2   staff requester whose order-status pings are muted
--   portalU  a B2B portal user (not a member)
--   outZ   manager of org Z
--
-- S.  The original pick for acceptance 36 (complete_picking from 31-C).
-- A.  Shape, grants and posture.
-- B.  Gates (brief 42: revocation, warehouse, modules).
-- C.  Create with an exchange (staff tier, quantities, warehouse review) and
--     the shape cases shared with core.
-- T.  The staff tier refusals.
-- E.  Acceptance 36 end to end (staff path): approval holds the Large once and
--     moves nothing, the gate refuses the pick slip until the receipt, the
--     replacement is picked and handed over, the Medium goes back to 31-C.
-- H.  Header inheritance: member, email-only (no track token), portal, a
--     member who left (D7), a deleted requester, delivery sites; never-copied
--     columns; cost stamped; lines merged per item.
-- I.  Idempotency: one replacement per approved revision.
-- J.  Acceptance 41: the replacement unavailable (refuse rolls back, backorder
--     holds nothing), the Medium still receivable, substitution never holds
--     both.
-- X.  X-1: cancelling a picked, staged or in-transit replacement from the RMA
--     restocks the picked batch to Staging; a handed-over one is refused.
--     C-1: a new replacement after a replacement cancel.
-- Z.  A replacement handed over in part (desk check F2): a backorder, and the
--     same resumed into picking, is never cancelled or changed from the RMA;
--     a forced re-issue sends only what is left of the returned quantity.
-- R.  Early release: gates, reason, replay, the gate opens, a substituted
--     order needs its own (D10).
-- G.  G1 approve and receive at the counter; G9 add a replacement.
-- K.  Cancel and deny; cancelling the RMA after a part hand-over (desk check
--     F3): the backorder closed, a resumed remainder cancelled, and the gate
--     never lets a cancelled RMA's replacement into picking.
-- L.  The link column and fixed lines.   Q.  The cancel guard.
-- N.  Notifications: ordinary orders unchanged, replacement words, silence.
-- V.  The exchange status CASE, one fixture per code, and its precedence.
-- P.  Parity T2-C2 with create_order_request.
-- Y.  The requester tier (RX-3's predicate, shipped here).
-- F.  Frozen bodies and triggers; holdings equal on hand; org deletion.
--
-- MUTATION TABLE (stockpilot-work/returns-exchange/mutate-0397.py; each must
-- fail the named lines):
--   M1  the gate lets a pick slip through while the RMA is approved      -> E3, R4
--   M2  the gate takes any value of the flag (not this transaction's id) -> Q1, Q2
--   M3  the notify trigger's WHEN is inverted                            -> N1, N2
--   M4  the staff tier skips caller_can_read_item                        -> T2
--   M5  the issue leaves the line cost at 0                              -> H6
--   M6  the issue lets a short replacement stand under refuse            -> J1
--   M7  a substitution issues the new order before cancelling the old    -> J5
--   M8  the CASE drops the RMA condition from completed                  -> V1
--   M9  the CASE ranks waiting above unavailable                         -> V1
--   M10 cancel_return_replacement refuses a drawn replacement            -> X1, X2
--   M11 the link guard lets an update through                            -> L2
--   M12 the lines guard lets an API line through                         -> L3
--   M13 the approval replay reads the stored key response                -> I2
--   M14 release_return_replacement_early skips the reason                -> R1
--   M15 the on-cancel hook leaves an undrawn replacement live            -> K2
--   M16 the on-deny hook leaves requested lines requested                -> K4
--   M17 the returns API guard drops the exchange clause                  -> L4
--   M18 the requester options keep a hidden item                         -> Y1
--   M19 the issue copies the original's notes                            -> H5
--   M20 the issue drops a deleted requester's stamp                      -> H4
--   M21 the class counts a part hand-over only on a backorder            -> Z2
--   M22 the re-issue ignores what earlier replacements handed over       -> Z3
--   M23 the on-cancel hook leaves a part-handed-over backorder open      -> K5
--   M24 the gate lets a cancelled RMA's replacement into picking         -> K6
--   M25 the on-cancel hook leaves a resumed remainder live               -> K7
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt / pg_temp.try_rpc (always undone) or pg_temp.rpc /
-- pg_temp.call_as / pg_temp.write_as (kept), which switch role and claims
-- with set_config inside a subtransaction (the 0387 helpers), so pgTAP's own
-- bookkeeping never runs as an API role. begin/rollback: nothing leaks.
-- Namespace 03970000.

begin;

select plan(96);

\set orgA    '\'03970000-0000-0000-0000-00000000000a\''
\set orgZ    '\'03970000-0000-0000-0000-00000000000b\''
\set own     '\'03970000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03970000-0000-0000-0000-0000000000a1\''
\set req     '\'03970000-0000-0000-0000-0000000000a2\''
\set stfRm   '\'03970000-0000-0000-0000-0000000000a3\''
\set stfCh   '\'03970000-0000-0000-0000-0000000000a4\''
\set vwr     '\'03970000-0000-0000-0000-0000000000a5\''
\set gone    '\'03970000-0000-0000-0000-0000000000a6\''
\set req2    '\'03970000-0000-0000-0000-0000000000a7\''
\set portalU '\'03970000-0000-0000-0000-0000000000a8\''
\set stfB    '\'03970000-0000-0000-0000-0000000000a9\''
\set outZ    '\'03970000-0000-0000-0000-0000000000b1\''
\set whA     '\'03970000-0000-0000-0000-0000000000d1\''
\set whB     '\'03970000-0000-0000-0000-0000000000d2\''
\set whZ     '\'03970000-0000-0000-0000-0000000000d3\''
\set cA1     '\'03970000-0000-0000-0000-0000000000c1\''
\set cA2     '\'03970000-0000-0000-0000-0000000000c2\''
\set cIn     '\'03970000-0000-0000-0000-0000000000c3\''
\set cFar    '\'03970000-0000-0000-0000-0000000000c4\''
\set r31C    '\'03970000-0000-0000-0000-000000000c31\''
\set r12B    '\'03970000-0000-0000-0000-000000000c12\''
\set grp     '\'03970000-0000-0000-0000-000000000a01\''
\set grpOld  '\'03970000-0000-0000-0000-000000000a02\''
\set grpR    '\'03970000-0000-0000-0000-000000000a03\''
\set cust    '\'03970000-0000-0000-0000-000000000f01\''
\set gM      '\'03970000-0000-0000-0000-000000000e01\''
\set gL      '\'03970000-0000-0000-0000-000000000e02\''
\set gXL     '\'03970000-0000-0000-0000-000000000e03\''
\set gS      '\'03970000-0000-0000-0000-000000000e04\''
\set itNavy  '\'03970000-0000-0000-0000-000000000e05\''
\set itDel   '\'03970000-0000-0000-0000-000000000e06\''
\set itRent  '\'03970000-0000-0000-0000-000000000e07\''
\set itAwait '\'03970000-0000-0000-0000-000000000e08\''
\set itKit   '\'03970000-0000-0000-0000-000000000e09\''
\set itArch  '\'03970000-0000-0000-0000-000000000e0a\''
\set itWhB   '\'03970000-0000-0000-0000-000000000e0b\''
\set itCh2   '\'03970000-0000-0000-0000-000000000e0c\''
\set itZ     '\'03970000-0000-0000-0000-000000000e0d\''
\set zM      '\'03970000-0000-0000-0000-000000000e0e\''
\set zL      '\'03970000-0000-0000-0000-000000000e0f\''
\set oldM    '\'03970000-0000-0000-0000-000000000e10\''
\set oldL    '\'03970000-0000-0000-0000-000000000e11\''
\set rM      '\'03970000-0000-0000-0000-000000000e12\''
\set rL      '\'03970000-0000-0000-0000-000000000e13\''
\set rL2     '\'03970000-0000-0000-0000-000000000e14\''
\set rXLh    '\'03970000-0000-0000-0000-000000000e15\''
\set rXLb    '\'03970000-0000-0000-0000-000000000e16\''
\set rXLc    '\'03970000-0000-0000-0000-000000000e17\''
\set rSame   '\'03970000-0000-0000-0000-000000000e18\''
\set r2XL    '\'03970000-0000-0000-0000-000000000e19\''
\set r3XL    '\'03970000-0000-0000-0000-000000000e1a\''
\set pX      '\'03970000-0000-0000-0000-000000000e1b\''
\set pY      '\'03970000-0000-0000-0000-000000000e1c\''
\set pZ      '\'03970000-0000-0000-0000-000000000e1d\''
\set oE2E    '\'03970000-0000-0000-0000-000000000101\''
\set oG      '\'03970000-0000-0000-0000-000000000102\''
\set oShort  '\'03970000-0000-0000-0000-000000000103\''
\set oEmail  '\'03970000-0000-0000-0000-000000000104\''
\set oPortal '\'03970000-0000-0000-0000-000000000105\''
\set oGone   '\'03970000-0000-0000-0000-000000000106\''
\set oDel    '\'03970000-0000-0000-0000-000000000107\''
\set oDlv    '\'03970000-0000-0000-0000-000000000108\''
\set oDlvIn  '\'03970000-0000-0000-0000-000000000109\''
\set oR      '\'03970000-0000-0000-0000-00000000010a\''
\set oPortalR '\'03970000-0000-0000-0000-00000000010b\''
\set oOld    '\'03970000-0000-0000-0000-00000000010c\''
\set oPar    '\'03970000-0000-0000-0000-00000000010d\''
\set oB      '\'03970000-0000-0000-0000-00000000010e\''
\set oZ      '\'03970000-0000-0000-0000-00000000010f\''
\set oMute   '\'03970000-0000-0000-0000-000000000110\''
\set oCnt    '\'03970000-0000-0000-0000-000000000111\''
\set oOrd    '\'03970000-0000-0000-0000-000000000112\''
\set oPh     '\'03970000-0000-0000-0000-000000000113\''
\set oK5     '\'03970000-0000-0000-0000-000000000114\''
\set oK7     '\'03970000-0000-0000-0000-000000000115\''
\set lE2E    '\'03970000-0000-0000-0000-000000000201\''
\set lG      '\'03970000-0000-0000-0000-000000000202\''
\set lG2     '\'03970000-0000-0000-0000-000000000203\''
\set lShort  '\'03970000-0000-0000-0000-000000000204\''
\set lEmail  '\'03970000-0000-0000-0000-000000000205\''
\set lPortal '\'03970000-0000-0000-0000-000000000206\''
\set lGone   '\'03970000-0000-0000-0000-000000000207\''
\set lDel    '\'03970000-0000-0000-0000-000000000208\''
\set lDlv    '\'03970000-0000-0000-0000-000000000209\''
\set lDlvIn  '\'03970000-0000-0000-0000-00000000020a\''
\set lR      '\'03970000-0000-0000-0000-00000000020b\''
\set lPortalR '\'03970000-0000-0000-0000-00000000020c\''
\set lOld    '\'03970000-0000-0000-0000-00000000020d\''
\set lPar    '\'03970000-0000-0000-0000-00000000020e\''
\set lB      '\'03970000-0000-0000-0000-00000000020f\''
\set lZ      '\'03970000-0000-0000-0000-000000000210\''
\set lMute   '\'03970000-0000-0000-0000-000000000211\''
\set lCnt    '\'03970000-0000-0000-0000-000000000212\''
\set lPh     '\'03970000-0000-0000-0000-000000000213\''
\set lK5     '\'03970000-0000-0000-0000-000000000214\''
\set lK7     '\'03970000-0000-0000-0000-000000000215\''
\set nobody  '\'03970000-0000-0000-0000-0000000009ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,     '0397-own@test.local',    '{}'::jsonb),
  (:mgr,     '0397-mgr@test.local',    '{}'::jsonb),
  (:req,     '0397-req@test.local',    '{}'::jsonb),
  (:stfRm,   '0397-stfrm@test.local',  '{}'::jsonb),
  (:stfCh,   '0397-stfch@test.local',  '{}'::jsonb),
  (:vwr,     '0397-vwr@test.local',    '{}'::jsonb),
  (:gone,    '0397-gone@test.local',   '{}'::jsonb),
  (:req2,    '0397-req2@test.local',   '{}'::jsonb),
  (:portalU, '0397-portal@test.local', '{}'::jsonb),
  (:stfB,    '0397-stfb@test.local',   '{}'::jsonb),
  (:outZ,    '0397-outz@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
update public.user_profiles set full_name = 'Gone Person' where id = :gone;
-- An org insert enables the default modules (orders among them); returns is
-- off by default and is turned on here.
insert into public.organizations (id, name, slug) values
  (:orgA, '0397 Exchanges A', '0397-exchanges-a'),
  (:orgZ, '0397 Exchanges Z', '0397-exchanges-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :stfRm, 'staff',   now()),
  (:orgA, :stfCh, 'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :gone,  'staff',   now()),
  (:orgA, :req2,  'staff',   now()),
  (:orgA, :stfB,  'staff',   now()),
  (:orgZ, :outZ,  'manager', now());
insert into public.organization_modules (organization_id, module_id, enabled, tier, settings) values
  (:orgA, 'returns', true, 'optional', '{}'::jsonb),
  (:orgZ, 'returns', true, 'optional', '{}'::jsonb)
on conflict (organization_id, module_id) do update set enabled = true;
-- The 0188 trigger creates Staging and Unplaced per warehouse.
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0397 Main',   'WH-0397A', 'active'),
  (:whB, :orgA, '0397 Second', 'WH-0397B', 'active'),
  (:whZ, :orgZ, '0397 Zed',    'WH-0397Z', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:cA1,  :orgA, '0397 Site One',      'S0397-1', 'active'),
  (:cA2,  :orgA, '0397 Owner Two',     'S0397-2', 'active'),
  (:cIn,  :orgA, '0397 Closed Site',   'S0397-3', 'inactive'),
  (:cFar, :orgA, '0397 Far Site',      'S0397-4', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :cA1), (:orgA, :whA, :cA2), (:orgA, :whA, :cIn);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary, charter_id) values
  (:orgA, :req,   :whA, true, null),
  (:orgA, :stfRm, :whA, true, null),
  (:orgA, :stfCh, :whA, true, :cA1),
  (:orgA, :vwr,   :whA, true, null),
  (:orgA, :gone,  :whA, true, null),
  (:orgA, :req2,  :whA, true, null),
  (:orgA, :stfB,  :whB, true, null);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfRm, 'returns:manage', true),
  (:orgA, :stfCh, 'returns:manage', true),
  (:orgA, :stfCh, 'orders:approve', true),
  (:orgA, :stfB,  'returns:manage', true),
  (:orgA, :stfB,  'orders:approve', true);
insert into public.notification_preferences (user_id, email_order_status_changed, email_order_in_transit)
values (:req2, false, false)
on conflict (user_id) do update set email_order_status_changed = false, email_order_in_transit = false;

select id as "stA" from public.locations where warehouse_id = :whA and kind = 'staging' \gset

insert into public.locations (id, organization_id, warehouse_id, name, type, kind, created_at) values
  (:r31C, :orgA, :whA, '31-C', 'shelf', 'rack', now() - interval '60 minutes'),
  (:r12B, :orgA, :whA, '12-B', 'shelf', 'rack', now() - interval '59 minutes');

insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status) values
  (:grp,    :orgA, 'Walk New Hire Shirt', '0397|walk new hire shirt', 'each', 'active'),
  (:grpOld, :orgA, 'Walk Old Shirt',      '0397|walk old shirt',      'each', 'archived'),
  (:grpR,   :orgA, 'Walk Requester Polo', '0397|walk requester polo', 'each', 'active');
insert into public.product_groups (id, organization_id, name, group_key, default_counting_unit, status)
values ('03970000-0000-0000-0000-000000000a09', :orgZ, 'Zed Shirt', '0397|zed shirt', 'each', 'active');

-- Items. Single-rack items seed their holding at primary_location_id (the
-- seed trigger). No item carries a reorder point (walk safety, C-7).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type,
   primary_location_id, group_id, variant_size, variant_key) values
  (:gM,     :orgA, :whA, '0397-M',     'Walk New Hire Shirt',  5, 7, 'active', 'none', :r31C, :grp, 'M',  'M'),
  (:gL,     :orgA, :whA, '0397-L',     'Walk New Hire Shirt', 60, 7, 'active', 'none', :r12B, :grp, 'L',  'L'),
  (:gXL,    :orgA, :whA, '0397-XL',    'Walk New Hire Shirt',  0, 7, 'active', 'none', null,  :grp, 'XL', 'XL'),
  (:gS,     :orgA, :whA, '0397-S',     'Walk New Hire Shirt',  3, 7, 'active', 'none', :r12B, :grp, 'S',  'S'),
  (:itNavy, :orgA, :whA, '0397-NAVY-L','Walk Navy Shirt L',    3, 9, 'active', 'none', :r12B, null, null, null),
  (:itDel,  :orgA, :whA, '0397-DEL',   'Walk Deleted Shirt',   2, 7, 'active', 'none', :r12B, null, null, null),
  (:itRent, :orgA, :whA, '0397-RENT',  'Walk Rental Shirt',    2, 7, 'active', 'none', :r12B, null, null, null),
  (:itAwait,:orgA, :whA, '0397-AWAIT', 'Walk Awaited Shirt',   0, 7, 'active', 'none', null,  null, null, null),
  (:itKit,  :orgA, :whA, '0397-KIT',   'Walk Shirt Kit',       2, 7, 'active', 'none', :r12B, null, null, null),
  (:itArch, :orgA, :whA, '0397-ARCH',  'Walk Archived Shirt',  2, 7, 'archived', 'none', :r12B, null, null, null),
  (:itWhB,  :orgA, :whB, '0397-WHB',   'Walk Second WH Shirt', 2, 7, 'active', 'none', null,  null, null, null),
  (:oldM,   :orgA, :whA, '0397-OLD-M', 'Walk Old Shirt',       2, 7, 'active', 'none', :r12B, :grpOld, 'M', 'M'),
  (:oldL,   :orgA, :whA, '0397-OLD-L', 'Walk Old Shirt',       2, 7, 'active', 'none', :r12B, :grpOld, 'L', 'L'),
  (:rM,     :orgA, :whA, '0397-R-M',   'Walk Requester Polo',  2, 5, 'active', 'none', :r12B, :grpR, 'M',  'M'),
  (:rL,     :orgA, :whA, '0397-R-L',   'Walk Requester Polo',  3, 5, 'active', 'none', :r12B, :grpR, 'L',  'L'),
  (:rL2,    :orgA, :whA, '0397-R-L2',  'Walk Requester Polo',  1, 5, 'active', 'none', :r12B, :grpR, 'L',  'L'),
  (:rXLh,   :orgA, :whA, '0397-R-XLH', 'Walk Requester Polo',  2, 5, 'active', 'none', :r12B, :grpR, 'XL', 'XL'),
  (:rXLb,   :orgA, :whB, '0397-R-XLB', 'Walk Requester Polo',  2, 5, 'active', 'none', null,  :grpR, 'XL', 'XL'),
  (:rSame,  :orgA, :whA, '0397-R-M2',  'Walk Requester Polo',  2, 5, 'active', 'none', :r12B, :grpR, 'M',  'M'),
  (:r2XL,   :orgA, :whA, '0397-R-2XL', 'Walk Requester Polo',  0, 5, 'active', 'none', null,  :grpR, '2XL','2XL'),
  (:r3XL,   :orgA, :whA, '0397-R-3XL', 'Walk Requester Polo',  1, 5, 'active', 'none', :r12B, :grpR, '3XL','3XL');
insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type,
   primary_location_id, group_id, variant_size, variant_key) values
  (:itCh2, :orgA, :whA, :cA2, '0397-CH2',   'Walk Owned Shirt',    2, 7, 'active', 'none', :r12B, null,  null, null),
  (:rXLc,  :orgA, :whA, :cA2, '0397-R-XLC', 'Walk Requester Polo', 2, 5, 'active', 'none', :r12B, :grpR, 'XL', 'XL');
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type, group_id, variant_size, variant_key) values
  (:itZ, :orgZ, :whZ, '0397-Z',   'Zed shirt',   2, 7, 'active', 'none', null, null, null),
  (:zM,  :orgZ, :whZ, '0397-Z-M', 'Zed Shirt',   2, 7, 'active', 'none', '03970000-0000-0000-0000-000000000a09', 'M', 'M'),
  (:zL,  :orgZ, :whZ, '0397-Z-L', 'Zed Shirt',   2, 7, 'active', 'none', '03970000-0000-0000-0000-000000000a09', 'L', 'L');
update public.inventory_items set deleted_at = now() where id = :itDel;
update public.inventory_items set is_rental = true where id = :itRent;
update public.inventory_items set awaiting_first_receipt = true where id = :itAwait;
update public.inventory_items set is_bundle = true where id = :itKit;
update public.inventory_items set public_visibility = 'hidden' where id = :rXLh;

-- The B2B customer, its portal user and its catalog (rM, rL and r3XL).
insert into public.customers (id, organization_id, name, status) values (:cust, :orgA, '0397 Customer Co', 'active');
insert into public.customer_users (customer_id, user_id, email, accepted_at) values (:cust, :portalU, '0397-portal@test.local', now());
insert into public.customer_catalog (customer_id, item_id) values (:cust, :rM), (:cust, :rL), (:cust, :r3XL);

-- Orders at their status, by the superuser (the insert guard holds API roles
-- only; the transition trigger fires on UPDATE only). oG carries every
-- column a replacement must never copy.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, customer_id, requester_user_id, requester_name, requester_email,
   requester_phone, requester_deleted_at, fulfillment_type, delivery_charter_id, pickup_location_notes) values
  (:oE2E,    :orgA, :whA, 'pick_slip_generated', 'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, null),
  (:oG,      :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, 'Front desk'),
  (:oShort,  :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, null),
  (:oEmail,  :orgA, :whA, 'completed',           'internal', null,  null,     'Email Person', 'email-0397@test.local', null, null, 'pickup', null, null),
  (:oPortal, :orgA, :whA, 'completed',           'portal',   :cust, :portalU, '0397 Customer Co', '0397-portal@test.local', null, null, 'pickup', null, null),
  (:oGone,   :orgA, :whA, 'completed',           'internal', null,  :gone,    null,           null, null, null, 'pickup', null, null),
  (:oDel,    :orgA, :whA, 'completed',           'internal', null,  null,     'Deleted Person', 'deleted-0397@test.local', null, now(), 'pickup', null, null),
  (:oDlv,    :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'delivery', :cA1, null),
  (:oDlvIn,  :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'delivery', :cIn, null),
  (:oR,      :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, null),
  (:oPortalR,:orgA, :whA, 'completed',           'portal',   :cust, :portalU, '0397 Customer Co', '0397-portal@test.local', null, null, 'pickup', null, null),
  (:oOld,    :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, null),
  (:oPar,    :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, '555-0397', null, 'pickup', null, 'Front desk'),
  (:oB,      :orgA, :whB, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, null),
  (:oZ,      :orgZ, :whZ, 'completed',           'internal', null,  :outZ,    null,           null, null, null, 'pickup', null, null),
  (:oMute,   :orgA, :whA, 'completed',           'internal', null,  :req2,    'Muted Person', null, null, null, 'pickup', null, null),
  (:oCnt,    :orgA, :whA, 'completed',           'internal', null,  :req,     'Req Person',   null, null, null, 'pickup', null, null);
update public.order_requests
   set notes = 'Original notes', internal_notes = 'Gate code 4', needed_by = now() + interval '3 days',
       signed_by_name = 'Signer', signed_at = now(), signature_method = 'physical', completed_at = now(),
       return_prompt_sent_at = now(), approved_by = :mgr, approved_at = now()
 where id = :oG;
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lE2E,    :oE2E,    :gM,    1, 0),
  (:lG,      :oG,      :gM,   40, 40),
  (:lG2,     :oG,      :gS,    5, 5),
  (:lShort,  :oShort,  :gM,    2, 2),
  (:lEmail,  :oEmail,  :gM,    1, 1),
  (:lPortal, :oPortal, :gM,    1, 1),
  (:lGone,   :oGone,   :gM,    1, 1),
  (:lDel,    :oDel,    :gM,    1, 1),
  (:lDlv,    :oDlv,    :gM,    2, 2),
  (:lDlvIn,  :oDlvIn,  :gM,    1, 1),
  (:lR,      :oR,      :rM,    3, 3),
  (:lPortalR,:oPortalR,:rM,    2, 2),
  (:lOld,    :oOld,    :oldM,  1, 1),
  (:lPar,    :oPar,    :gM,    1, 1),
  (:lB,      :oB,      :itWhB, 1, 1),
  (:lZ,      :oZ,      :zM,    1, 1),
  (:lMute,   :oMute,   :gM,    1, 1),
  (:lCnt,    :oCnt,    :gM,    2, 2);
-- The member who later left (D7).
delete from public.user_warehouse_assignments where user_id = :gone;
delete from public.organization_members where user_id = :gone and organization_id = :orgA;

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
    raise exception using errcode = 'XX397', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX397' then
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
    raise exception using errcode = 'XX397', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_hint = pg_exception_hint, v_detail = pg_exception_detail;
  end;
  if v_state = 'XX397' then
    return coalesce(v, 'null'::jsonb);
  end if;
  return jsonb_build_object('error', v_state, 'hint', pg_temp.hint(v_hint), 'message', v_msg, 'detail', v_detail);
end $$;
-- 'ok', or '<sqlstate>:<hint>' for an RPC answer.
create function pg_temp.err(j jsonb) returns text language sql immutable as $$
  select case when j ? 'error' then (j->>'error') || ':' || coalesce(j->>'hint', '-') else 'ok' end
$$;
-- A refusal's detail as json ({"unparsed": ...} when it is not json).
create function pg_temp.detail(j jsonb) returns jsonb language plpgsql immutable as $$
begin
  return (j->>'detail')::jsonb;
exception when others then
  return jsonb_build_object('unparsed', j->>'detail');
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
-- A staff create body: one line, restock, with an optional exchange.
create function pg_temp.xbody(p_line uuid, p_qty numeric, p_exchange jsonb default null, p_here boolean default false)
returns jsonb language sql immutable as $$
  select jsonb_build_object('reasonCode', 'other', 'itemIsHere', p_here,
           'lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', p_line, 'quantity', p_qty, 'disposition', 'restock')
                                      || case when p_exchange is null then '{}'::jsonb
                                              else jsonb_build_object('exchange', p_exchange) end))
$$;
-- Create as p_sub (kept): the RMA id, or the refusal.
create function pg_temp.mk(p_sub uuid, p_order uuid, p_body jsonb) returns text language plpgsql as $$
declare j jsonb;
begin
  j := pg_temp.rpc('authenticated', p_sub,
                   format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', p_order, p_body));
  return coalesce(j->>'returnId', pg_temp.err(j));
end $$;
-- The approval decision: every return line restocked to Staging, every
-- requested exchange line given p_action (null: no exchange decision) with
-- p_extra merged in, and the replacement options.
create function pg_temp.xdec(p_rma uuid, p_action text default 'approve', p_extra jsonb default '{}'::jsonb,
                             p_repl jsonb default null)
returns jsonb language sql as $$
  select jsonb_build_object(
           'lines', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'disposition', 'restock',
                                                         'restock', jsonb_build_object('target', 'staging')))
                       from public.return_lines rl where rl.return_id = p_rma),
           'exchange', coalesce((select jsonb_agg(jsonb_build_object('exchangeLineId', xl.id, 'action', p_action) || p_extra)
                                   from public.return_exchange_lines xl
                                  where xl.return_id = p_rma and xl.status = 'requested' and p_action is not null), '[]'::jsonb))
         || case when p_repl is null then '{}'::jsonb else jsonb_build_object('replacement', p_repl) end
$$;
-- The RMA's current revision, its exchange line, its live replacement.
create function pg_temp.rev(p_rma uuid) returns integer language sql as $$
  select coalesce(max(d.revision), 0)::integer from public.return_decisions d
   where d.return_id = p_rma and d.kind in ('approved', 'replacement_changed', 'replacement_cancelled', 'cancelled')
$$;
create function pg_temp.xl(p_rma uuid) returns uuid language sql as $$
  select xl.id from public.return_exchange_lines xl where xl.return_id = p_rma order by xl.created_at, xl.id limit 1
$$;
create function pg_temp.live(p_rma uuid) returns uuid language sql as $$
  select o.id from public.order_requests o
   where o.replacement_for_return_id = p_rma and o.status not in ('cancelled', 'denied')
$$;
-- Active holds on an order (quantity).
create function pg_temp.holds(p_order uuid) returns numeric language sql as $$
  select coalesce(trim_scale(sum(sr.quantity)), 0) from public.stock_reservations sr
   where sr.order_request_id = p_order and sr.released_at is null
$$;
-- The exchange status a member reads from the list view.
create function pg_temp.xs(p_rma uuid, p_as uuid) returns text language sql as $$
  select pg_temp.call_as('authenticated', p_as, format('select exchange_status from public.return_overview where id = %L', p_rma))
$$;
-- Approve as p_sub (kept), at the current revision.
create function pg_temp.approve(p_sub uuid, p_rma uuid, p_dec jsonb, p_here boolean default false) returns jsonb language plpgsql as $$
begin
  return pg_temp.rpc('authenticated', p_sub,
                     format('select public.approve_return(%L, %s, %L::jsonb, %s)', p_rma, pg_temp.rev(p_rma), p_dec, p_here));
end $$;
-- A manager walks a released replacement to picking_complete through the
-- real order path: the pick slip (the API edge), then complete_picking (one
-- click, the draw recorded). Answers the final status or the refusal.
create function pg_temp.pick(p_sub uuid, p_order uuid) returns text language plpgsql as $$
declare v text;
begin
  v := pg_temp.write_as('authenticated', p_sub,
         format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
                p_sub, p_order));
  if v <> 'ok:1' then
    return v;
  end if;
  return pg_temp.call_as('authenticated', p_sub, format('select (public.complete_picking(%L)).status', p_order));
end $$;
-- ... and on to staged for pickup (packing slips through the 0389 RPC, then
-- the API staging edge).
create function pg_temp.stage(p_sub uuid, p_order uuid) returns text language plpgsql as $$
declare v text;
begin
  v := pg_temp.call_as('authenticated', p_sub, format('select (public.generate_order_packing_slips(%L)).status', p_order));
  if v <> 'packing_slip_generated' then
    return v;
  end if;
  return pg_temp.write_as('authenticated', p_sub,
           format($q$update public.order_requests set status = 'staged_for_pickup', staged_by = %L where id = %L$q$, p_sub, p_order));
end $$;

-- Statement discipline: a write a later check depends on runs in its OWN
-- statement (its JSON answer kept in a psql variable), and every check reads
-- in a later statement.

-- ══ S. The original pick for acceptance 36 ════════════════════════════════
select pg_temp.call_as('authenticated', :mgr, format('select (public.complete_picking(%L)).status', :oE2E)) as "sPick" \gset
update public.order_requests set status = 'packing_slip_generated' where id = :oE2E;
update public.order_requests set status = 'staged_for_pickup' where id = :oE2E;
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :oE2E)) as "sSign" \gset
select is(
  :'sPick' || ',' || :'sSign' || ',' || pg_temp.held(:gM, :r31C)::text || ','
  || (select count(*)::text from public.stock_movements m
       where m.reference_type = 'order_request' and m.reference_id = :oE2E and m.item_id = :gM
         and m.movement_type = 'transfer' and m.quantity_change < 0 and m.via_ledger and m.draw is not null),
  'picking_complete,completed,4,1',
  'S1: the original Medium is picked from 31-C by complete_picking (draw recorded) and handed over with the paper signature');

-- ══ A. Shape, grants and posture ══════════════════════════════════════════
select is(
  (select string_agg(r || ':' || p || '=' || has_table_privilege(r, 'public.return_exchange_lines', p)::text, ','
                     order by r collate "C", p collate "C")
     from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p)
  || '|' || has_table_privilege('service_role', 'public.return_exchange_lines', 'INSERT')::text
  || '|' || (select relrowsecurity::text from pg_class where oid = 'public.return_exchange_lines'::regclass)
  || '|' || (select string_agg(policyname || ':' || cmd || ':' || roles::text, ',') from pg_policies
              where schemaname = 'public' and tablename = 'return_exchange_lines'),
  'anon:DELETE=false,anon:INSERT=false,anon:SELECT=false,anon:UPDATE=false,'
  || 'authenticated:DELETE=false,authenticated:INSERT=false,authenticated:SELECT=true,authenticated:UPDATE=false'
  || '|true|true|return_exchange_lines_select:SELECT:{authenticated}',
  'A1: anon holds nothing on return_exchange_lines, authenticated reads it only (every member, one SELECT policy), the service role holds it all');
select is(
  has_column_privilege('authenticated', 'public.order_requests', 'replacement_for_return_id', 'INSERT')::text || ','
  || has_column_privilege('authenticated', 'public.order_requests', 'replacement_for_return_id', 'UPDATE')::text || ','
  || has_column_privilege('authenticated', 'public.order_requests', 'replacement_for_return_id', 'SELECT')::text || ','
  || has_any_column_privilege('anon', 'public.order_requests', 'SELECT')::text || ','
  || (col_description('public.order_requests'::regclass,
        (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'replacement_for_return_id'))
      ~ 'Written only by the exchange functions')::text,
  'false,false,true,false,true',
  'A2: the link column is server-owned: authenticated reads it but holds no INSERT or UPDATE on it (0384 rule), anon nothing, and its comment says so');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                     || ':' || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
                     || ':' || pg_get_userbyid(p.proowner), ',' order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('change_return_replacement', 'cancel_return_replacement', 'release_return_replacement_early',
                        'return_exchange_candidates', 'return_exchange_options', 'return_exchange_flags')),
  'cancel_return_replacement:true:true:false:false:false:postgres,change_return_replacement:true:true:false:false:false:postgres,'
  || 'release_return_replacement_early:true:true:false:false:false:postgres,return_exchange_candidates:false:true:false:false:false:postgres,'
  || 'return_exchange_flags:true:true:false:true:false:postgres,return_exchange_options:true:false:false:true:false:postgres',
  'A3: the three exchange RPCs are SECURITY DEFINER with EXECUTE for authenticated only; the staff search is SECURITY INVOKER (the caller''s RLS); the requester options are the service role''s alone; the view''s flags read is members and the service role; none for anon or PUBLIC');
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || ':'
                     || (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
                         or has_function_privilege('service_role', p.oid, 'EXECUTE')
                         or coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false))::text,
                     ',' order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_return_exchange_requester_options', '_return_exchange_item_ok', '_return_replacement_summary',
                        '_return_replacement_class', '_return_exchange_fulfilled', '_return_replacement_cancel_order', '_return_exchange_reason',
                        '_return_exchange_quantity', '_return_replacement_issue', '_return_exchange_create',
                        '_return_exchange_approve', '_return_exchange_on_deny', '_return_exchange_on_cancel',
                        '_return_exchange_replay', 'tg_return_exchange_lines_validate', 'tg_order_requests_replacement_link',
                        'tg_order_request_lines_replacement_guard', 'tg_order_requests_replacement_status',
                        '_notify_replacement_order_changes', 'tg_returns_api_guard')),
  '_notify_replacement_order_changes:true:false,_return_exchange_approve:false:false,_return_exchange_create:false:false,'
  || '_return_exchange_fulfilled:false:false,_return_exchange_item_ok:false:false,_return_exchange_on_cancel:false:false,_return_exchange_on_deny:false:false,'
  || '_return_exchange_quantity:false:false,_return_exchange_reason:false:false,_return_exchange_replay:false:false,'
  || '_return_exchange_requester_options:false:false,_return_replacement_cancel_order:false:false,'
  || '_return_replacement_class:false:false,_return_replacement_issue:true:false,_return_replacement_summary:false:false,'
  || 'tg_order_request_lines_replacement_guard:false:false,tg_order_requests_replacement_link:false:false,'
  || 'tg_order_requests_replacement_status:true:false,tg_return_exchange_lines_validate:false:false,tg_returns_api_guard:false:false',
  'A4: every helper, hook and guard has no EXECUTE for any API role; SECURITY INVOKER except the replacement issue (DEFINER, it inserts the order as postgres), the gate (DEFINER, C-5) and the replacement notify (DEFINER)');
select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname collate "C"), '')
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_return_exchange_requester_options', '_return_exchange_item_ok', '_return_replacement_summary',
                        '_return_replacement_class', '_return_exchange_fulfilled', '_return_replacement_cancel_order', '_return_exchange_reason',
                        '_return_exchange_quantity', '_return_replacement_issue', '_return_exchange_create',
                        '_return_exchange_approve', '_return_exchange_on_deny', '_return_exchange_on_cancel',
                        '_return_exchange_replay', 'tg_return_exchange_lines_validate', 'tg_order_requests_replacement_link',
                        'tg_order_request_lines_replacement_guard', 'tg_order_requests_replacement_status',
                        '_notify_replacement_order_changes', 'tg_returns_api_guard', 'change_return_replacement',
                        'cancel_return_replacement', 'release_return_replacement_early', 'return_exchange_candidates',
                        'return_exchange_options', 'return_exchange_flags')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c = 'search_path=public, pg_temp'))
  || '|' ||
  (select string_agg(p.proname || ':' || coalesce((select c from unnest(p.proconfig) c where c like 'lock_timeout=%'), 'none'), ','
                     order by p.proname collate "C")
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('change_return_replacement', 'cancel_return_replacement', 'release_return_replacement_early',
                        '_return_replacement_issue')),
  '|_return_replacement_issue:lock_timeout=5s,cancel_return_replacement:lock_timeout=5s,'
  || 'change_return_replacement:lock_timeout=5s,release_return_replacement_early:lock_timeout=5s',
  'A5: every RX-2 function pins search_path = public, pg_temp, and every writer waits at most 5s for a lock (55P03, retryable)');
select is(
  (select coalesce(string_agg(p.proname, ','), '')
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and (p.proname like '%exchange%' or p.proname like '%replacement%')
      and (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01)'$re$ or p.prosrc ~* 'serialization_failure|deadlock_detected'))
  || '|' ||
  (select count(*)::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')
      and (p.proname like '%exchange%' or p.proname like '%replacement%')
      and p.prosrc !~* '(auth\.uid|has_org_role|has_permission|is_org_member)')
  || '|' ||
  (select (p.prosrc !~* 'for\s+(update|share|no\s+key\s+update|key\s+share)')::text
     from pg_proc p where p.oid = 'public.tg_order_requests_replacement_status()'::regprocedure),
  '|0|true',
  'A6: no exchange function raises a retryable class (0367); every authenticated-EXECUTE DEFINER one gates in its body (INV-25); the return-first gate takes no row lock (risk 4: it would deadlock against an RMA cancel)');
select is(
  (select string_agg(a.attname::text, ',' order by a.attnum) from pg_attribute a
    where a.attrelid = 'public.return_overview'::regclass and a.attnum > 0 and not a.attisdropped)
  || '|' || (select coalesce(array_to_string(c.reloptions, ','), '') from pg_class c where c.oid = 'public.return_overview'::regclass),
  'id,organization_id,return_number,status,source,reason_code,order_request_id,order_number,warehouse_id,'
  || 'requester_name,requester_email,requester_user_id,created_at,approved_at,received_at,closed_at,'
  || 'line_count,unit_count,lines,waiting_days,requested_by,deleted_users,'
  || 'kind,exchange_revision,exchange_lines,any_requested,all_declined,requested_short,replacement_order_id,'
  || 'replacement_order_number,replacement_status,replacement_owed,replacement_held,released_early,counter,exchange_status'
  || '|security_invoker=true',
  'A7: the list view keeps RX-1''s columns in order and appends the exchange columns after deleted_users; it runs as the caller');
select is(
  (select string_agg(t.tgname || '=' || pg_get_triggerdef(t.oid), E'\n' order by t.tgname collate "C")
     from pg_trigger t
    where t.tgname in ('trg_order_requests_notify', 'trg_order_requests_notify_replacement', 'trg_order_requests_zz_replacement_status',
                       'trg_zz_order_requests_replacement_link_ins', 'trg_zz_order_requests_replacement_link_upd',
                       'trg_zz_order_request_lines_replacement_guard', 'trg_return_exchange_lines_validate')
      and not t.tgisinternal),
  'trg_order_requests_notify=CREATE TRIGGER trg_order_requests_notify AFTER INSERT OR UPDATE ON public.order_requests FOR EACH ROW WHEN ((new.replacement_for_return_id IS NULL)) EXECUTE FUNCTION _notify_order_request_changes()' || E'\n'
  || 'trg_order_requests_notify_replacement=CREATE TRIGGER trg_order_requests_notify_replacement AFTER INSERT OR UPDATE ON public.order_requests FOR EACH ROW WHEN ((new.replacement_for_return_id IS NOT NULL)) EXECUTE FUNCTION _notify_replacement_order_changes()' || E'\n'
  || 'trg_order_requests_zz_replacement_status=CREATE TRIGGER trg_order_requests_zz_replacement_status BEFORE UPDATE OF status ON public.order_requests FOR EACH ROW WHEN (((new.replacement_for_return_id IS NOT NULL) AND (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION tg_order_requests_replacement_status()' || E'\n'
  || 'trg_return_exchange_lines_validate=CREATE TRIGGER trg_return_exchange_lines_validate BEFORE INSERT OR UPDATE ON public.return_exchange_lines FOR EACH ROW EXECUTE FUNCTION tg_return_exchange_lines_validate()' || E'\n'
  || 'trg_zz_order_request_lines_replacement_guard=CREATE TRIGGER trg_zz_order_request_lines_replacement_guard BEFORE INSERT ON public.order_request_lines FOR EACH ROW EXECUTE FUNCTION tg_order_request_lines_replacement_guard()' || E'\n'
  || 'trg_zz_order_requests_replacement_link_ins=CREATE TRIGGER trg_zz_order_requests_replacement_link_ins BEFORE INSERT ON public.order_requests FOR EACH ROW WHEN ((new.replacement_for_return_id IS NOT NULL)) EXECUTE FUNCTION tg_order_requests_replacement_link()' || E'\n'
  || 'trg_zz_order_requests_replacement_link_upd=CREATE TRIGGER trg_zz_order_requests_replacement_link_upd BEFORE UPDATE ON public.order_requests FOR EACH ROW WHEN ((old.replacement_for_return_id IS DISTINCT FROM new.replacement_for_return_id)) EXECUTE FUNCTION tg_order_requests_replacement_link()',
  'A8: the notify split (ordinary orders keep _notify_order_request_changes behind a WHEN; replacements get their own), the gate on status changes of replacements only, the link guards, the lines guard and the exchange-line validation, each exactly as pinned');
select is(
  (select pg_get_expr(i.indpred, i.indrelid) from pg_index i where i.indexrelid = 'public.order_requests_live_replacement_uniq'::regclass)
  || '|' || (select pg_get_constraintdef(c.oid) from pg_constraint c
              where c.conrelid = 'public.order_requests'::regclass and c.conname = 'order_requests_replacement_return_fkey')
  || '|' || (select pg_get_constraintdef(c.oid) from pg_constraint c
              where c.conrelid = 'public.return_decisions'::regclass and c.conname = 'return_decisions_exchange_line_fkey')
  || '|' || (select count(*)::text from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'return_exchange_lines'),
  '((replacement_for_return_id IS NOT NULL) AND (status <> ALL (ARRAY[''cancelled''::text, ''denied''::text])))'
  || '|FOREIGN KEY (replacement_for_return_id, organization_id) REFERENCES returns(id, organization_id)'
  || '|FOREIGN KEY (exchange_line_id, return_id) REFERENCES return_exchange_lines(id, return_id) ON DELETE CASCADE'
  || '|0',
  'A9: at most one live replacement per RMA (partial unique index), the link keyed to (RMA, organization) with NO ACTION (G6), the decision log''s exchange line keyed to its RMA, and the new table outside realtime');

-- ══ B. Gates ══════════════════════════════════════════════════════════════
-- rBq: an exchange still requested; rB0: an exchange approved and waiting.
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rBq" \gset
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rB0" \gset
select pg_temp.approve(:mgr, :'rB0', pg_temp.xdec(:'rB0')) as "jB0" \gset
select pg_temp.xl(:'rB0') as "xB0" \gset
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', null, format($q$select public.change_return_replacement(%L, 1, '[]', 'x', 'refuse')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format($q$select public.cancel_return_replacement(%L, 1, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', null, format($q$select public.return_exchange_candidates(%L, %L, null, 30)$q$, :oG, :lG))) || ','
  || pg_temp.err(pg_temp.try_rpc('anon', null, format($q$select public.cancel_return_replacement(%L, 1, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('anon', null, format($q$select public.return_exchange_flags(%L)$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.return_exchange_options(%L)$q$, :oG))),
  '42501:unauthenticated,42501:unauthenticated,42501:unauthenticated,42501:unauthenticated,42501:-,42501:-,42501:-',
  'B1: signed out, every exchange function answers 42501 unauthenticated; anon holds no EXECUTE; authenticated cannot read the requester options');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format($q$select public.change_return_replacement(%L, 1, '[]', 'x', 'refuse')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format($q$select public.cancel_return_replacement(%L, 1, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :nobody))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :outZ, format($q$select public.return_exchange_candidates(%L, %L, null, 30)$q$, :oG, :lG))) || ','
  || coalesce(pg_temp.call_as('authenticated', :outZ, format($q$select public.return_exchange_flags(%L)::text$q$, :'rB0')), 'x'),
  'P0002:return_not_found,P0002:return_not_found,P0002:return_not_found,P0002:return_not_found,P0002:order_not_found,null',
  'B2: a foreign RMA or order answers exactly like a missing one, and the flags read answers nothing to a non-member (no oracle)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, 1, 'x')$q$, :'rB0'),
     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rB0'),
     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'returns'$q$, :orgA))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq', pg_temp.xdec(:'rBq')::text),
     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA))),
  'P0001:module_disabled,P0001:module_disabled,P0001:module_disabled',
  'B3: with the orders or the returns module off, the exchange functions and an exchange approval answer module_disabled');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, format($q$select public.change_return_replacement(%L, 1, '[]', 'x', 'refuse')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, format($q$select public.return_exchange_candidates(%L, %L, null, 30)$q$, :oG, :lG))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format($q$select public.change_return_replacement(%L, 1, '[]', 'x', 'refuse')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format($q$select public.cancel_return_replacement(%L, 1, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq', pg_temp.xdec(:'rBq')::text))) || ','
  || coalesce(pg_temp.try_rpc('authenticated', :stfRm, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq',
                pg_temp.xdec(:'rBq', 'decline', '{"reason":"Not this time"}'::jsonb)::text))->>'status', 'error'),
  '42501:returns_manage,42501:returns_manage,42501:returns_manage,42501:orders_approve,42501:orders_approve,42501:orders_approve,42501:orders_approve,approved',
  'B4: a viewer lacks returns:manage; staff with returns:manage but not orders:approve are refused every replacement action and an exchange approval (clean refusal before any lock), yet may approve the return while declining the exchange');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfB, format($q$select public.change_return_replacement(%L, 1, '[]', 'x', 'refuse')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfB, format($q$select public.cancel_return_replacement(%L, 1, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfB, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rB0'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfB, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq', pg_temp.xdec(:'rBq')::text))),
  '42501:warehouse_write,42501:warehouse_write,42501:warehouse_write,42501:warehouse_write',
  'B5: the grants without write access to the original order''s warehouse are refused warehouse_write (D27)');
select is(
  ((:'jB0'::jsonb)->>'changed') || ':' || ((:'jB0'::jsonb)->>'status') || ':' || ((:'jB0'::jsonb)->>'revision') || ':'
  || ((:'jB0'::jsonb)->'replacement'->>'status') || ':' || ((:'jB0'::jsonb)->'replacement'->>'short') || ':'
  || (((:'jB0'::jsonb)->'replacement'->>'orderId') = pg_temp.live(:'rB0')::text)::text,
  'true:approved:1:approved:false:true',
  'B6: the approval answers its revision and the replacement it created (approved, not short)');

-- ══ C. Create with an exchange ════════════════════════════════════════════
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rC1" \gset
select is(
  (select xl.status || ':' || (xl.requested_item_id = :gL)::text || ':' || trim_scale(xl.requested_quantity)::text || ':'
          || coalesce(xl.request_note, '-') || ':' || xl.requested_by_kind || ':' || (xl.requested_by = :mgr)::text || ':'
          || xl.revision::text || ':' || (xl.replacement_order_request_id is null)::text
     from public.return_exchange_lines xl where xl.return_id = :'rC1')
  || '|' || (select string_agg(d.kind || '/' || d.channel || '/' || d.actor_kind || '/' || (d.exchange_line_id is not null)::text, ','
                               order by d.seq)
               from public.return_decisions d where d.return_id = :'rC1')
  || '|' || (select count(*)::text from public.order_requests where replacement_for_return_id = :'rC1'),
  'requested:true:1:-:staff:true:0:true|exchange_requested/staff/staff/true,created/staff/staff/false|0',
  'C1: a staff exchange line keeps the request (item, quantity defaulted to the return''s, who asked) and its decision; nothing is ordered before approval');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL, 'quantity', 2))::text)))
  || ':' || (select count(*)::text from public.returns where order_request_id = :oG and id not in (:'rBq', :'rB0', :'rC1')),
  'P0001:exchange_quantity_exceeds_return:0',
  'C2: "return 1, exchange for 2" is refused (brief 4) and nothing is created: the header and line roll back with the exchange');
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('note', 'Need the next size up'))) as "rRv" \gset
select is(
  (select coalesce(xl.requested_item_id::text, 'none') || ':' || xl.request_note || ':' || trim_scale(xl.requested_quantity)::text
     from public.return_exchange_lines xl where xl.return_id = :'rRv')
  || '|' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rRv', pg_temp.xdec(:'rRv')::text)))
  || '|' || coalesce(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rRv',
                       pg_temp.xdec(:'rRv', 'approve', jsonb_build_object('itemId', :gL))::text))->'replacement'->>'status', 'error'),
  'none:Need the next size up:1|22023:return_invalid|approved',
  'C3: "the warehouse will review" stores the note with no item; approving it needs the staff''s item choice, which needs no reason');
-- case: create_exchange_no_item_no_note
-- case: create_exchange_note_too_long
-- case: create_exchange_quantity_fractional
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, '{}'::jsonb)::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('note', repeat('x', 501)))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 2, jsonb_build_object('itemId', :gL, 'quantity', 1.5))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL, 'warehouse', :whB))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', 'not-a-uuid'))::text))),
  '22023:return_invalid,22023:return_invalid,22023:return_invalid,22023:return_invalid,22023:return_invalid',
  'C4: an exchange with neither item nor note, a note over 500 characters, a fractional quantity, an unknown field or a malformed item id is refused return_invalid');

-- ══ T. The staff tier ═════════════════════════════════════════════════════
select is(
  (select string_agg(x.label || '=' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr,
             format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                    pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', x.item))::text))), ',' order by x.label)
     from (values ('archived', :itArch::uuid), ('awaiting', :itAwait::uuid), ('deleted', :itDel::uuid), ('kit', :itKit::uuid),
                  ('other_org', :itZ::uuid), ('other_warehouse', :itWhB::uuid), ('rental', :itRent::uuid)) x(label, item)),
  'archived=P0001:exchange_item_not_eligible,awaiting=P0001:exchange_item_not_eligible,deleted=P0001:exchange_item_not_eligible,'
  || 'kit=P0001:exchange_item_not_eligible,other_org=P0001:exchange_item_not_eligible,'
  || 'other_warehouse=P0001:exchange_item_not_eligible,rental=P0001:exchange_item_not_eligible',
  'T1: an archived, awaiting-first-receipt, deleted, kit, other-organization, other-warehouse or rental item is never a replacement (one hint whatever the cause)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :stfCh, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :itCh2))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfCh, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oG,
                  pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :itCh2))::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rC1',
                  pg_temp.xdec(:'rC1', 'approve', jsonb_build_object('itemId', :itRent, 'reason', 'Swap'))::text))),
  'P0001:exchange_item_not_eligible,ok,ok,P0001:exchange_item_not_eligible',
  'T2: an item outside the approver''s own item scope (a charter they are not assigned) is refused for them and accepted for a manager who reads it; the staff tier is applied again at approval (caller_can_read_item, plan 3.6.2)');
select is(
  pg_temp.attempt('postgres', null,
    format($q$insert into public.return_exchange_lines (organization_id, return_id, return_line_id, requested_item_id, requested_quantity, requested_by_kind)
              select %L, %L, rl.id, %L, 2, 'staff' from public.return_lines rl where rl.return_id = %L$q$, :orgA, :'rRv', :gL, :'rRv'),
    format($q$delete from public.return_decisions where return_id = %L; delete from public.return_exchange_lines where return_id = %L$q$,
           :'rRv', :'rRv'))
  || ' | ' ||
  pg_temp.attempt('postgres', null,
    format($q$insert into public.return_exchange_lines (organization_id, return_id, return_line_id, requested_item_id, requested_quantity, requested_by_kind)
              select %L, %L, rl.id, %L, 0.5, 'staff' from public.return_lines rl where rl.return_id = %L$q$, :orgA, :'rRv', :gL, :'rRv'),
    format($q$delete from public.return_decisions where return_id = %L; delete from public.return_exchange_lines where return_id = %L$q$,
           :'rRv', :'rRv'))
  || ' | ' ||
  pg_temp.attempt('postgres', null,
    format($q$update public.return_exchange_lines set requested_item_id = %L where return_id = %L$q$, :gS, :'rRv')),
  'P0001:exchange_quantity_exceeds_return:exchange_quantity_exceeds_return | 23514:-:new row for relation "return_exchange_lines" violates check constraint "return_exchange_lines_requested_quantity_check" | 42501:exchange_request_immutable:exchange_request_immutable',
  'T3: even as the owner, an exchange line above its returned quantity is refused by the trigger, a part unit by the CHECK, and the request is never rewritten (brief 4, 22)');

-- ══ E. Acceptance 36, end to end (the staff path) ═════════════════════════
select pg_temp.mk(:mgr, :oE2E, pg_temp.xbody(:lE2E, 1, jsonb_build_object('itemId', :gL))) as "rE" \gset
select jsonb_build_object(
         'lines', jsonb_build_array(jsonb_build_object(
                    'returnLineId', (select rl.id from public.return_lines rl where rl.return_id = :'rE'),
                    'disposition', 'restock', 'restock', jsonb_build_object('target', 'original'))),
         'exchange', jsonb_build_array(jsonb_build_object('exchangeLineId', pg_temp.xl(:'rE'), 'action', 'approve')),
         'replacement', jsonb_build_object('whenShort', 'refuse'))::text as "dE" \gset
select pg_temp.snap(:gM) as "sMbefore", pg_temp.snap(:gL) as "sLbefore" \gset
select pg_temp.approve(:mgr, :'rE', :'dE'::jsonb) as "jE" \gset
select pg_temp.live(:'rE') as "oRepE" \gset
select is(
  ((:'jE'::jsonb)->>'changed') || ':' || ((:'jE'::jsonb)->>'status') || ':'
  || (((:'jE'::jsonb)->'replacement'->>'orderId') = :'oRepE')::text || ':'
  || (select o.status || ':' || (o.replacement_for_return_id = :'rE')::text || ':'
             || (o.order_number > (select x.order_number from public.order_requests x where x.id = :oE2E))::text
        from public.order_requests o where o.id = :'oRepE') || ':'
  || (select count(*)::text from public.stock_reservations where order_request_id = :'oRepE' and released_at is null) || ':'
  || pg_temp.holds(:'oRepE')::text,
  'true:approved:true:approved:true:true:1:1',
  'E1: approving the exchange creates ONE linked replacement order with its own, newer SO number, approved and holding the Large exactly once (brief 19, 21)');
select is(
  (pg_temp.snap(:gM) = :'sMbefore')::text || ',' || (pg_temp.snap(:gL) = :'sLbefore')::text || ','
  || pg_temp.xs(:'rE', :mgr) || ','
  || (select xl.status || '/' || (xl.approved_item_id = :gL)::text || '/' || (xl.replacement_order_request_id = :'oRepE')::text
             || '/' || (xl.replacement_order_line_id = (select l.id from public.order_request_lines l where l.order_request_id = :'oRepE'))::text
             || '/' || xl.revision::text
        from public.return_exchange_lines xl where xl.return_id = :'rE'),
  'true,true,waiting_for_return,approved/true/true/true/1',
  'E2: approval moves no stock (the Medium and the Large keep on hand, holdings and movements; brief 14) and the exchange reads "waiting for returned item"');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$, :mgr, :'oRepE')),
  'P0001:replacement_waiting_for_return:replacement_waiting_for_return',
  'E3: the replacement''s pick slip is refused while the returned item has not arrived (the return-first gate, brief 23)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.resume_fulfillment(%L)', '03970000-0000-0000-0000-000000000901'),
    format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, replacement_for_return_id)
              values ('03970000-0000-0000-0000-000000000901', %L, %L, 'backordered', 'internal', %L, 'pickup', %L);
              insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled)
              values ('03970000-0000-0000-0000-000000000901', %L, 2, 1)$q$, :orgA, :whA, :req, :'rBq', :gS)),
  'P0001:replacement_waiting_for_return:replacement_waiting_for_return',
  'E4: resuming a backordered replacement re-enters picking through the same gate (resume_fulfillment is the second way into picking)');
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rE')) as "eRecv" \gset
select pg_temp.xs(:'rE', :mgr) as "eXsReady" \gset
select pg_temp.pick(:mgr, :'oRepE') as "ePick" \gset
select is(
  :'eRecv' || ',' || :'eXsReady' || ',' || :'ePick' || ','
  || (select count(*)::text from public.stock_movements m
       where m.reference_type = 'order_request' and m.reference_id = :'oRepE' and m.item_id = :gL
         and m.movement_type = 'transfer' and m.quantity_change = -1 and m.via_ledger and m.draw is not null)
  || ',' || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :gL)
  || ',' || pg_temp.balanced(:gL)::text,
  'received,ready_to_pick,picking_complete,1,59,true',
  'E5: receiving the Medium opens the gate; the pick slip passes and complete_picking draws the Large once, recorded against the replacement (holdings equal on hand)');
select pg_temp.stage(:mgr, :'oRepE') as "eStage" \gset
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :'oRepE')) as "eSign" \gset
select is(
  :'eStage' || ',' || :'eSign' || ',' || pg_temp.xs(:'rE', :mgr),
  'ok:1,completed,handed_over_return_open',
  'E6: the replacement is staged and handed over on its own order (one signature implementation); the exchange reads handed over, return not processed');
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rE')) as "jEclose" \gset
select is(
  ((:'jEclose'::jsonb)->>'status') || ',' || pg_temp.held(:gM, :r31C)::text || ',' || pg_temp.held(:gM, :'stA')::text || ','
  || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :gM) || ','
  || (select count(*)::text from public.stock_movements m
       where m.reference_type = 'return' and m.reference_id = :'rE' and m.movement_type = 'return'
         and m.to_location_id = :r31C and m.quantity_change = 1 and m.via_ledger) || ','
  || pg_temp.balanced(:gM)::text || ',' || pg_temp.xs(:'rE', :mgr),
  'closed,5,0,5,1,true,completed',
  'E7: processing puts the Medium back on 31-C (on hand +1, 31-C +1, Staging +0, one return movement to 31-C) and the exchange reads completed (acceptance 36)');
select is(
  (select string_agg(d.kind, ',' order by d.seq) from public.return_decisions d where d.return_id = :'rE'),
  'exchange_requested,created,disposition_planned,exchange_approved,replacement_issued,approved,received,closed',
  'E8: the decision log keeps the chain: the request, the approval with its replacement, the receipt and the close (brief 35)');

-- ══ H. Header inheritance ═════════════════════════════════════════════════
select pg_temp.mk(:mgr, :oG,      pg_temp.xbody(:lG,      1, jsonb_build_object('itemId', :gL))) as "rHm" \gset
select pg_temp.mk(:mgr, :oEmail,  pg_temp.xbody(:lEmail,  1, jsonb_build_object('itemId', :gL))) as "rHe" \gset
select pg_temp.mk(:mgr, :oPortal, pg_temp.xbody(:lPortal, 1, jsonb_build_object('itemId', :gL))) as "rHp" \gset
select pg_temp.mk(:mgr, :oGone,   pg_temp.xbody(:lGone,   1, jsonb_build_object('itemId', :gL))) as "rHg" \gset
select pg_temp.mk(:mgr, :oDel,    pg_temp.xbody(:lDel,    1, jsonb_build_object('itemId', :gL))) as "rHd" \gset
select pg_temp.mk(:mgr, :oDlv,    pg_temp.xbody(:lDlv,    1, jsonb_build_object('itemId', :gL))) as "rHdl" \gset
select pg_temp.mk(:mgr, :oDlvIn,  pg_temp.xbody(:lDlvIn,  1, jsonb_build_object('itemId', :gL))) as "rHdi" \gset
select pg_temp.approve(:mgr, :'rHm',  pg_temp.xdec(:'rHm'))  as "jHm" \gset
select pg_temp.approve(:mgr, :'rHe',  pg_temp.xdec(:'rHe'))  as "jHe" \gset
select pg_temp.approve(:mgr, :'rHp',  pg_temp.xdec(:'rHp'))  as "jHp" \gset
select pg_temp.approve(:mgr, :'rHg',  pg_temp.xdec(:'rHg'))  as "jHg" \gset
select pg_temp.approve(:mgr, :'rHd',  pg_temp.xdec(:'rHd'))  as "jHd" \gset
select pg_temp.approve(:mgr, :'rHdl', pg_temp.xdec(:'rHdl')) as "jHdl" \gset
select pg_temp.live(:'rHm') as "oHm", pg_temp.live(:'rHe') as "oHe", pg_temp.live(:'rHp') as "oHp",
       pg_temp.live(:'rHg') as "oHg", pg_temp.live(:'rHd') as "oHd", pg_temp.live(:'rHdl') as "oHdl" \gset
select is(
  (select o.source || ':' || coalesce(o.customer_id::text, 'none') || ':' || (o.requester_user_id = :req)::text || ':'
          || coalesce(o.requester_name, '-') || ':' || o.fulfillment_type || ':' || coalesce(o.pickup_location_notes, '-') || ':'
          || (o.replacement_for_return_id = :'rHm')::text || ':' || (o.warehouse_id = :whA)::text || ':' || o.status
     from public.order_requests o where o.id = :'oHm'),
  'internal:none:true:Req Person:pickup:Front desk:true:true:approved',
  'H1: a member requester''s replacement keeps the requester, the warehouse and the pickup context (brief 20)');
select is(
  (select coalesce(o.requester_user_id::text, 'none') || ':' || o.requester_name || ':' || o.requester_email || ':'
          || coalesce(o.public_track_token, 'null') || ':'
          || (select count(*)::text from public.order_request_secrets s where s.order_request_id = o.id)
     from public.order_requests o where o.id = :'oHe'),
  'none:Email Person:email-0397@test.local:null:0',
  'H2: an email-only requester stays email-only, and no track token is minted for the replacement (A-3, D8)');
select is(
  (select o.source || ':' || (o.customer_id = :cust)::text || ':' || (o.requester_user_id = :portalU)::text || ':'
          || (select trim_scale(l.unit_price_at_request)::text from public.order_request_lines l where l.order_request_id = o.id)
     from public.order_requests o where o.id = :'oHp'),
  'portal:true:true:0',
  'H3: a portal original keeps its customer and portal user (order_requests_identity_chk holds; judge B-1) and its replacement line is priced 0 (D9)');
select is(
  (select coalesce(o.requester_user_id::text, 'none') || ':' || coalesce(o.requester_name, '-') || ':' || coalesce(o.requester_email, '-') || ':'
          || case when o.requester_deleted_at is null then 'null' else 'stamped' end
     from public.order_requests o where o.id = :'oHg')
  || '|' ||
  (select coalesce(o.requester_user_id::text, 'none') || ':' || coalesce(o.requester_name, '-') || ':' || coalesce(o.requester_email, '-') || ':'
          || case when o.requester_deleted_at is null then 'null' else 'stamped' end
     from public.order_requests o where o.id = :'oHd'),
  'none:Gone Person:0397-gone@test.local:null|none:Deleted Person:deleted-0397@test.local:stamped',
  'H4: a member who left becomes an email-only requester with their profile''s name and email (D7); a requester whose account was deleted stays deleted (0388/0393: the stamp carried, nobody written to)');
select is(
  (select count(*)::text from jsonb_each(to_jsonb(o)) e
    where e.key in ('notes', 'internal_notes', 'needed_by', 'denied_reason', 'packaging_at', 'ready_at', 'delivered_at',
                    'cancelled_at', 'cancelled_by', 'confirmation_token_hash', 'confirmation_token_expires_at',
                    'assigned_picker_id', 'pick_slip_generated_at', 'pick_slip_generated_by', 'picking_completed_at',
                    'picking_completed_by', 'packing_slip_generated_at', 'packing_slip_generated_by', 'staged_at', 'staged_by',
                    'assigned_delivery_user_id', 'assigned_delivery_by', 'assigned_delivery_at', 'in_transit_at', 'in_transit_by',
                    'signature_token', 'signature_token_expires_at', 'signed_by_name', 'signed_by_email', 'signature_data_url',
                    'signed_at', 'completed_at', 'completed_by', 'return_token', 'picking_claimed_at', 'picking_claimed_by',
                    'signature_method', 'return_prompt_sent_at', 'public_track_token')
      and e.value <> 'null'::jsonb),
  '0',
  'H5: nothing the brief forbids is copied: the original''s notes, internal notes, needed-by, signature, completion, return prompt and every workflow column stay empty on the replacement (brief 20, D8)')
  from public.order_requests o where o.id = :'oHm';
select is(
  (select trim_scale(l.unit_cost_at_request)::text || ':' || coalesce(l.unit_price_at_request::text, 'null') || ':'
          || trim_scale(l.quantity_requested)::text
     from public.order_request_lines l where l.order_request_id = :'oHm')
  || ':' || ((select order_number from public.order_requests where id = :'oHm')
             <> (select order_number from public.order_requests where id = :oG))::text,
  '7:null:1:true',
  'H6: the replacement line''s cost is the item''s cost (a DEFINER insert skips the line guard''s snapshot, so it is stamped in the function), no price for an internal order, and the order has its own SO number');
select is(
  (select o.fulfillment_type || ':' || (o.delivery_charter_id = :cA1)::text from public.order_requests o where o.id = :'oHdl')
  || '|' || (select pg_temp.err(j) || ':' || coalesce(j->>'detail', '') from
             (select pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rHdi', pg_temp.xdec(:'rHdi')::text)) as j) x)
  || '|' || (select pg_temp.err(j) || ':' || coalesce(j->>'detail', '') from
             (select pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rHdi',
                       pg_temp.xdec(:'rHdi', 'approve', '{}'::jsonb, jsonb_build_object('fulfillmentType', 'delivery', 'deliveryCharterId', :cFar))::text)) as j) x)
  || '|' || coalesce(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rHdi',
                       pg_temp.xdec(:'rHdi', 'approve', '{}'::jsonb, '{"fulfillmentType":"pickup"}'::jsonb)::text))->'replacement'->>'status', 'error')
  || '|' || (select status from public.returns where id = :'rHdi'),
  'delivery:true|P0001:replacement_site_not_available:inactive|P0001:replacement_site_not_available:not_serviced|approved|requested',
  'H7: a delivery replacement keeps a site the warehouse serves; a closed site or one the warehouse does not serve is refused (the approver chooses another or pickup), and a refusal leaves the RMA requested');
select pg_temp.mk(:mgr, :oG, jsonb_build_object('reasonCode', 'other', 'lines', jsonb_build_array(
         jsonb_build_object('orderRequestLineId', :lG,  'quantity', 1, 'disposition', 'restock', 'exchange', jsonb_build_object('itemId', :gL)),
         jsonb_build_object('orderRequestLineId', :lG2, 'quantity', 1, 'disposition', 'restock', 'exchange', jsonb_build_object('itemId', :gL))))) as "rHm2" \gset
select pg_temp.approve(:mgr, :'rHm2', pg_temp.xdec(:'rHm2')) as "jHm2" \gset
select is(
  (select count(*)::text || ':' || string_agg(trim_scale(l.quantity_requested)::text, ',')
     from public.order_request_lines l where l.order_request_id = pg_temp.live(:'rHm2'))
  || ':' || (select count(distinct xl.replacement_order_line_id)::text || '/' || count(*)::text
               from public.return_exchange_lines xl where xl.return_id = :'rHm2')
  || ':' || pg_temp.holds(pg_temp.live(:'rHm2'))::text,
  '1:2:1/2:2',
  'H8: two exchange lines for the same item become one replacement line of 2 (the create merge rule), both mapped to it and held once');

-- ══ I. Idempotency: one replacement per approved revision ═════════════════
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rI" \gset
select pg_temp.xdec(:'rI')::text as "dI" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI', :'dI')) as "jI1" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI', :'dI')) as "jI2" \gset
select is(
  ((:'jI1'::jsonb)->>'changed') || ':' || ((:'jI2'::jsonb)->>'changed') || ':' || ((:'jI2'::jsonb)->>'replay') || ':'
  || (((:'jI2'::jsonb)->'replacement'->>'orderId') = pg_temp.live(:'rI')::text)::text || ':'
  || (select count(*)::text from public.order_requests where replacement_for_return_id = :'rI') || ':'
  || (select count(*)::text from public.stock_reservations sr join public.order_requests o on o.id = sr.order_request_id
       where o.replacement_for_return_id = :'rI' and sr.released_at is null),
  'true:false:true:true:1:1',
  'I1: a double click (the same decision at the same revision, web and phone, a retry) replays the one replacement: one order, one hold (brief 33)');
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI',
                 ((:'dI'::jsonb) || '{"replacement":{"whenShort":"backorder"}}'::jsonb)::text)))
  || ':' || ((pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rI', :'dI'),
               format($q$update public.idempotency_keys
                            set response = jsonb_build_object('returnId', %L, 'revision', 1, 'replacement', jsonb_build_object('orderId', %L))
                          where scope = 'return_approval' and key = %L$q$, :'rI', :nobody, :'rI' || ':0'))->'replacement'->>'orderId')
             = pg_temp.live(:'rI')::text)::text,
  'P0001:return_changed:true',
  'I2: another decision at the same revision is refused return_changed; a replay answers the replacement the decision log names, never an edited key response');
select is(
  pg_temp.attempt('postgres', null,
    format($q$insert into public.order_requests (organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, replacement_for_return_id)
              values (%L, %L, 'approved', 'internal', %L, 'pickup', %L)$q$, :orgA, :whA, :req, :'rI')),
  '23505:-:duplicate key value violates unique constraint "order_requests_live_replacement_uniq"',
  'I3: not even the owner can add a second live replacement for one RMA (the partial unique index)');

-- ══ J. Acceptance 41: the replacement unavailable ═════════════════════════
select pg_temp.mk(:mgr, :oShort, pg_temp.xbody(:lShort, 1, jsonb_build_object('itemId', :gXL))) as "rSh" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rSh', pg_temp.xdec(:'rSh')::text)) as "jSh1" \gset
select is(
  pg_temp.err(:'jSh1'::jsonb) || ':'
  || (pg_temp.detail(:'jSh1'::jsonb) = jsonb_build_array(jsonb_build_object('itemId', :gXL, 'needed', 1, 'available', 0)))::text || ':'
  || (select status from public.returns where id = :'rSh') || ':'
  || (select count(*)::text from public.order_requests where replacement_for_return_id = :'rSh') || ':'
  || (select status from public.return_exchange_lines where return_id = :'rSh') || ':'
  || (select string_agg(kind, ',' order by seq) from public.return_decisions where return_id = :'rSh'),
  'P0001:replacement_unavailable:true:requested:0:requested:exchange_requested,created',
  'J1: with the Large at 0 free, the plain approval is refused with the numbers and NOTHING is written: no order, no hold, the RMA still requested (D19)');
select pg_temp.approve(:mgr, :'rSh', pg_temp.xdec(:'rSh', 'approve', '{}'::jsonb, '{"whenShort":"backorder"}'::jsonb)) as "jSh2" \gset
select is(
  ((:'jSh2'::jsonb)->>'status') || ':' || ((:'jSh2'::jsonb)->'replacement'->>'status') || ':' || ((:'jSh2'::jsonb)->'replacement'->>'short') || ':'
  || (select count(*)::text from public.stock_reservations sr where sr.order_request_id = pg_temp.live(:'rSh')) || ':'
  || (select trim_scale(quantity_on_hand)::text from public.inventory_items where id = :gXL) || ':'
  || pg_temp.xs(:'rSh', :mgr),
  'approved:approved:true:0:0:unavailable',
  'J2: "Approve, replacement on backorder" approves with no hold row and nothing negative; the exchange reads replacement unavailable');
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rSh')) as "shRecv" \gset
select pg_temp.held(:gM, :'stA') as "shStBefore" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rSh')) as "jShClose" \gset
select is(
  :'shRecv' || ':' || ((:'jShClose'::jsonb)->>'status') || ':' || (pg_temp.held(:gM, :'stA') - :'shStBefore'::numeric)::text || ':'
  || pg_temp.balanced(:gM)::text || ':' || pg_temp.xs(:'rSh', :mgr),
  'received:closed:1:true:unavailable',
  'J3: the returned Medium is still received and restocked (to Staging: its order has no recorded pick) while the replacement waits for stock (acceptance 41)');
select pg_temp.live(:'rSh') as "oShOld" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Navy instead: no Large in stock', 'refuse')$q$,
          :'rSh', pg_temp.rev(:'rSh'), jsonb_build_array(jsonb_build_object('exchangeLineId', pg_temp.xl(:'rSh'), 'itemId', :itNavy))::text)) as "jSh3" \gset
select is(
  ((:'jSh3'::jsonb)->>'changed') || ':' || ((:'jSh3'::jsonb)->>'mode') || ':' || ((:'jSh3'::jsonb)->>'revision') || ':'
  || (select status from public.order_requests where id = :'oShOld') || ':' || pg_temp.holds(:'oShOld')::text || ':'
  || ((select l.item_id from public.order_request_lines l where l.order_request_id = pg_temp.live(:'rSh')) = :itNavy)::text || ':'
  || pg_temp.holds(pg_temp.live(:'rSh'))::text || ':'
  || (select (xl.approved_item_id = :itNavy)::text || '/' || (xl.requested_item_id = :gXL)::text || '/' || xl.revision::text
        from public.return_exchange_lines xl where xl.return_id = :'rSh') || ':'
  || (select string_agg(d.kind || coalesce('/' || (d.previous_item_id = :gXL)::text, ''), ',' order by d.seq)
        from public.return_decisions d
       where d.return_id = :'rSh'
         and d.seq > (select max(c.seq) from public.return_decisions c where c.return_id = :'rSh' and c.kind = 'closed')),
  'true:substitute:2:cancelled:0:true:1:true/true/2:replacement_changed,exchange_approved/true,replacement_issued',
  'J4: an authorized substitution to the Navy Large (reason required) cancels the old replacement, holds the new one, keeps the original request beside the approved item and records both (brief 22)');
select is(
  (select count(*)::text from public.order_requests o where o.replacement_for_return_id = :'rSh' and o.status not in ('cancelled', 'denied'))
  || ':' || (select count(*)::text from public.stock_reservations sr join public.order_requests o on o.id = sr.order_request_id
              where o.replacement_for_return_id = :'rSh' and sr.released_at is null)
  || ':' || pg_temp.xs(:'rSh', :mgr),
  '1:1:ready_to_pick',
  'J5: never both: one live replacement and one hold after the substitution (the old order cancelled first, in one transaction); the closed RMA leaves it ready to pick');

-- ══ X. X-1: cancelling a replacement that was picked, staged or is on its way
-- rX1 staged for pickup.
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rX1" \gset
select pg_temp.approve(:mgr, :'rX1', pg_temp.xdec(:'rX1')) as "jX1a" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rX1')) as "jX1r" \gset
select pg_temp.live(:'rX1') as "oX1" \gset
select pg_temp.pick(:mgr, :'oX1') as "x1Pick" \gset
select pg_temp.stage(:mgr, :'oX1') as "x1Stage" \gset
select pg_temp.held(:gL, :'stA') as "x1StL", (select trim_scale(quantity_on_hand) from public.inventory_items where id = :gL) as "x1OnL" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, 'The requester changed their mind')$q$, :'rX1', pg_temp.rev(:'rX1'))) as "jX1c" \gset
select is(
  :'x1Pick' || ':' || :'x1Stage' || ':' || ((:'jX1c'::jsonb)->>'changed') || ':' || ((:'jX1c'::jsonb)->>'drawn') || ':'
  || ((:'jX1c'::jsonb)->>'inTransit') || ':'
  || (select status from public.order_requests where id = :'oX1') || ':' || pg_temp.holds(:'oX1')::text || ':'
  || (pg_temp.held(:gL, :'stA') - :'x1StL'::numeric)::text || ':'
  || ((select trim_scale(quantity_on_hand) from public.inventory_items where id = :gL) - :'x1OnL'::numeric)::text || ':'
  || (select string_agg(status, ',') from public.return_exchange_lines where return_id = :'rX1') || ':'
  || pg_temp.xs(:'rX1', :mgr) || ':' || pg_temp.balanced(:gL)::text,
  'picking_complete:ok:1:true:true:false:cancelled:0:1:1:cancelled:replacement_cancelled:true',
  'X1: a staged replacement cancelled from the RMA puts the picked unit back on record in Staging (cancel_order_request''s own drawn branch) and releases every hold; the lines read cancelled (X-1)');
-- rX2 in transit (a delivery), rX3 picking complete.
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rX2" \gset
select pg_temp.approve(:mgr, :'rX2', pg_temp.xdec(:'rX2', 'approve', '{}'::jsonb,
         jsonb_build_object('fulfillmentType', 'delivery', 'deliveryCharterId', :cA1))) as "jX2a" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Swap at delivery: the driver collects the returned item.')$q$, :'rX2')) as "jX2r" \gset
select pg_temp.live(:'rX2') as "oX2" \gset
select pg_temp.pick(:mgr, :'oX2') as "x2Pick" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.generate_order_packing_slips(%L)).status', :'oX2')) as "x2Slip" \gset
update public.order_requests set status = 'staged_for_delivery' where id = :'oX2';
update public.order_requests set status = 'in_transit' where id = :'oX2';
select pg_temp.held(:gL, :'stA') as "x2StL" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, 'Delivery refused at the door')$q$, :'rX2', pg_temp.rev(:'rX2'))) as "jX2c" \gset
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rX3" \gset
select pg_temp.approve(:mgr, :'rX3', pg_temp.xdec(:'rX3')) as "jX3a" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rX3')) as "jX3r" \gset
select pg_temp.live(:'rX3') as "oX3" \gset
select pg_temp.pick(:mgr, :'oX3') as "x3Pick" \gset
select pg_temp.held(:gL, :'stA') as "x3StL" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, 'Picked the wrong size')$q$, :'rX3', pg_temp.rev(:'rX3'))) as "jX3c" \gset
select is(
  :'x2Pick' || ':' || :'x2Slip' || ':' || ((:'jX2c'::jsonb)->>'drawn') || ':' || ((:'jX2c'::jsonb)->>'inTransit') || ':'
  || (select status from public.order_requests where id = :'oX2') || ':' || pg_temp.holds(:'oX2')::text || ':'
  || (:'x3StL'::numeric - :'x2StL'::numeric)::text
  || '|' || :'x3Pick' || ':' || ((:'jX3c'::jsonb)->>'drawn') || ':' || (select status from public.order_requests where id = :'oX3') || ':'
  || pg_temp.holds(:'oX3')::text || ':' || (pg_temp.held(:gL, :'stA') - :'x3StL'::numeric)::text || ':'
  || pg_temp.xs(:'rX3', :mgr) || ':' || pg_temp.balanced(:gL)::text,
  'picking_complete:packing_slip_generated:true:true:cancelled:0:1|picking_complete:true:cancelled:0:1:replacement_cancelled:true',
  'X2: the same for a replacement in transit (the answer says it is with the driver) and one just picked: the picked unit is back in Staging, every hold released, holdings equal on hand (X-1)');
-- rX4 handed over.
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rX4" \gset
select pg_temp.approve(:mgr, :'rX4', pg_temp.xdec(:'rX4')) as "jX4a" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rX4')) as "jX4r" \gset
select pg_temp.live(:'rX4') as "oX4" \gset
select pg_temp.pick(:mgr, :'oX4') as "x4Pick" \gset
select pg_temp.stage(:mgr, :'oX4') as "x4Stage" \gset
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :'oX4')) as "x4Sign" \gset
select pg_temp.snap(:gL) as "x4Snap" \gset
select is(
  :'x4Sign' || ':'
  || pg_temp.err(pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, 'Too late')$q$, :'rX4', pg_temp.rev(:'rX4'))))
  || ':' || pg_temp.err(pg_temp.rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, '[]'::jsonb, 'Too late', 'refuse')$q$, :'rX4', pg_temp.rev(:'rX4'))))
  || ':' || (pg_temp.snap(:gL) = :'x4Snap')::text || ':' || (select status from public.order_requests where id = :'oX4'),
  'completed:P0001:replacement_handed_over:P0001:replacement_handed_over:true:completed',
  'X3: a replacement already handed over is never cancelled or changed from the RMA, and nothing moves (brief 34)');
select pg_temp.rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, '[]'::jsonb, 'Issue it again', 'refuse')$q$, :'rX1', pg_temp.rev(:'rX1'))) as "jX1n" \gset
select is(
  ((:'jX1n'::jsonb)->>'changed') || ':' || ((:'jX1n'::jsonb)->>'mode') || ':' || ((:'jX1n'::jsonb)->>'revision') || ':'
  || (pg_temp.live(:'rX1') <> :'oX1'::uuid)::text || ':' || pg_temp.holds(pg_temp.live(:'rX1'))::text || ':'
  || (select status || '/' || revision::text from public.return_exchange_lines where return_id = :'rX1') || ':'
  || (select status from public.order_requests where id = :'oX1') || ':' || pg_temp.xs(:'rX1', :mgr),
  'true:reissue:3:true:1:approved/3:cancelled:waiting_for_return',
  'X4: after a replacement cancel, "Issue a new replacement" creates and holds a new order, the lines approved again at the next revision; the new order needs its own release (C-1, D10)');

-- ══ Z. A replacement handed over in part (desk check F2) ═════════════════
-- oPh: a completed order of 4 Mediums; pX: a replacement item with one unit
-- on 12-B (no group, no reorder point). rPh returns 2 Mediums for 2 pX,
-- approved on backorder (1 held), released, picked (1), handed over (1): a
-- backorder with 1 of 2 handed over.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type, primary_location_id)
values (:pX, :orgA, :whA, '0397-PX', 'Walk Part Shirt', 1, 7, 'active', 'none', :r12B);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type)
values (:oPh, :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled)
values (:lPh, :oPh, :gM, 4, 4);
select pg_temp.mk(:mgr, :oPh, pg_temp.xbody(:lPh, 2, jsonb_build_object('itemId', :pX))) as "rPh" \gset
select pg_temp.approve(:mgr, :'rPh', pg_temp.xdec(:'rPh', 'approve', '{}'::jsonb, '{"whenShort":"backorder"}'::jsonb)) as "jPh" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rPh')) as "jPhr" \gset
select pg_temp.live(:'rPh') as "oPhR" \gset
select pg_temp.pick(:mgr, :'oPhR') as "phPick" \gset
select pg_temp.stage(:mgr, :'oPhR') as "phStage" \gset
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :'oPhR')) as "phSign" \gset
select is(
  ((:'jPh'::jsonb)->'replacement'->>'short') || ':' || :'phPick' || ':' || :'phStage' || ':' || :'phSign' || ':'
  || (select trim_scale(sum(l.quantity_fulfilled))::text from public.order_request_lines l where l.order_request_id = :'oPhR') || ':'
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, 'Changed my mind')$q$,
       :'rPh', pg_temp.rev(:'rPh')))) || ':'
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Another item', 'backorder')$q$,
       :'rPh', pg_temp.rev(:'rPh'), jsonb_build_array(jsonb_build_object('exchangeLineId', pg_temp.xl(:'rPh'), 'itemId', :gL))::text))) || ':'
  || pg_temp.xs(:'rPh', :mgr),
  'true:picking_complete:ok:1:backordered:1:P0001:replacement_handed_over:P0001:replacement_handed_over:partly_handed_over',
  'Z1: a replacement handed over in part (a backorder with 1 of 2 handed over) is neither cancelled nor changed from the RMA (desk check F2)');
-- Stock arrives (+1 on 12-B) and the backorder is resumed into picking.
do $$
begin
  perform public.adjust_stock('03970000-0000-0000-0000-000000000e1b'::uuid, 1, 'add',
                              '03970000-0000-0000-0000-000000000c12'::uuid, 'Walk restock', null);
end $$;
select pg_temp.call_as('authenticated', :mgr, format('select (public.resume_fulfillment(%L)).status', :'oPhR')) as "phResume" \gset
select is(
  :'phResume' || ':' || pg_temp.holds(:'oPhR')::text || ':'
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, 'Changed my mind')$q$,
       :'rPh', pg_temp.rev(:'rPh')))) || ':'
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Another item', 'backorder')$q$,
       :'rPh', pg_temp.rev(:'rPh'), jsonb_build_array(jsonb_build_object('exchangeLineId', pg_temp.xl(:'rPh'), 'itemId', :gL))::text))) || ':'
  || pg_temp.xs(:'rPh', :mgr) || ':' || pg_temp.balanced(:pX)::text,
  'pick_slip_generated:1:P0001:replacement_handed_over:P0001:replacement_handed_over:in_progress:true',
  'Z2: resumed into picking it is still handed over in part: Cancel replacement and Change replacement are refused, so no new replacement sends the handed-over unit again (desk check F2)');
-- A forced cancel of that order (the exchange flag raised by hand; no
-- function does this any more) leaves the lines cancelled. A re-issue then
-- sends only what is left of the 2 returned after the 1 handed over, and
-- asking for 2 is refused (undone: try_rpc).
create function pg_temp.zforce(p_order uuid, p_rma uuid) returns text language sql immutable as $$
  select format($q$select set_config('request.jwt.claim.sub', '03970000-0000-0000-0000-0000000000a1', true);
                   select set_config('stockpilot.return_exchange', pg_current_xact_id()::text, true);
                   select public.cancel_order_request(%L, 'Forced');
                   select set_config('stockpilot.return_exchange', '', true);
                   update public.return_exchange_lines set status = 'cancelled' where return_id = %L and status = 'approved'$q$,
                p_order, p_rma)
$$;
select is(
  (select coalesce(j->>'changed', pg_temp.err(j)) || ':' || coalesce(j->>'mode', '-') || ':'
          || coalesce(j->'replacement'->'lines'->0->>'requested', 'none')
     from (select pg_temp.try_rpc('authenticated', :mgr,
             format($q$select public.change_return_replacement(%L, %s, '[]'::jsonb, 'Issue the rest', 'backorder')$q$, :'rPh', pg_temp.rev(:'rPh')),
             pg_temp.zforce(:'oPhR', :'rPh')) as j) x)
  || '|' || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr,
             format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Issue it all again', 'backorder')$q$,
                    :'rPh', pg_temp.rev(:'rPh'), jsonb_build_array(jsonb_build_object('exchangeLineId', pg_temp.xl(:'rPh'), 'quantity', 2))::text),
             pg_temp.zforce(:'oPhR', :'rPh'))),
  'true:reissue:1|P0001:exchange_quantity_exceeds_return',
  'Z3: after a forced cancel of a replacement that handed 1 of 2 over, a new replacement carries only the 1 left of the returned quantity, and asking for 2 is refused (desk check F2: never more out than returned)');

-- ══ R. Early release ══════════════════════════════════════════════════════
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rRel" \gset
select pg_temp.approve(:mgr, :'rRel', pg_temp.xdec(:'rRel')) as "jRa" \gset
-- case: release_reason_too_long
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :vwr, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rRel'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rRel'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, '   ')$q$, :'rRel'))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, %L)$q$, :'rRel', repeat('x', 501)))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rBq'))),
  '42501:returns_manage,42501:orders_approve,P0001:reason_required,22023:return_invalid,P0001:replacement_not_waiting',
  'R1: an early release needs returns:manage and orders:approve (requesters never control it, brief 24), a reason of 1 to 500 characters, and a replacement that is waiting');
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rRel')) as "jR1" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Another reason')$q$, :'rRel')) as "jR2" \gset
select is(
  ((:'jR1'::jsonb)->>'changed') || ':' || ((:'jR2'::jsonb)->>'changed') || ':' || ((:'jR2'::jsonb)->>'replay') || ':'
  || (select count(*)::text || '/' || max(d.reason) || '/' || (max(d.order_request_id::text) = pg_temp.live(:'rRel')::text)::text
        from public.return_decisions d where d.return_id = :'rRel' and d.kind = 'released_early'),
  'true:false:true:1/Customer is completing an in-person exchange today./true',
  'R2: the release is recorded once with its reason and the order it opens (audited, brief 24); a second release replays');
select is(
  pg_temp.xs(:'rRel', :mgr) || ':'
  || pg_temp.call_as('authenticated', :req, format($q$select released_early::text || '/' || exchange_status from public.return_overview where id = %L$q$, :'rRel'))
  || ':' || pg_temp.attempt('authenticated', :mgr,
              format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
                     :mgr, pg_temp.live(:'rRel'))),
  'ready_to_pick:true/ready_to_pick:ok:1',
  'R3: the release opens the gate for that order: the pick slip passes, and a member without returns access reads the same exchange status');
select pg_temp.rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, %L::jsonb, 'Small instead', 'refuse')$q$,
          :'rRel', pg_temp.rev(:'rRel'), jsonb_build_array(jsonb_build_object('exchangeLineId', pg_temp.xl(:'rRel'), 'itemId', :gS))::text)) as "jR4" \gset
select is(
  ((:'jR4'::jsonb)->>'mode') || ':' || pg_temp.xs(:'rRel', :mgr) || ':'
  || pg_temp.attempt('authenticated', :mgr,
       format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
              :mgr, pg_temp.live(:'rRel'))),
  'substitute:waiting_for_return:P0001:replacement_waiting_for_return:replacement_waiting_for_return',
  'R4: a substituted replacement is a new order and needs its own release (D10)');
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rRel')) as "rRelRecv" \gset
select is(
  :'rRelRecv' || ':'
  || coalesce(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'x')$q$, :'rRel'))->>'reason', 'none')
  || ':' || pg_temp.xs(:'rRel', :mgr),
  'received:not_needed:ready_to_pick',
  'R5: once the returned item is received a release is not needed (changed false), and the replacement is ready to pick');

-- ══ G. The counter (G1) and "Add a replacement" (G9) ══════════════════════
select pg_temp.mk(:mgr, :oCnt, pg_temp.xbody(:lCnt, 1, jsonb_build_object('itemId', :gL), true)) as "rCt" \gset
select pg_temp.approve(:mgr, :'rCt', pg_temp.xdec(:'rCt'), true) as "jCt" \gset
select is(
  ((:'jCt'::jsonb)->>'status') || ':' || ((:'jCt'::jsonb)->'replacement'->>'status') || ':' || pg_temp.holds(pg_temp.live(:'rCt'))::text || ':'
  || (select string_agg(d.kind || '/' || d.channel, ',' order by d.seq) from public.return_decisions d where d.return_id = :'rCt') || ':'
  || pg_temp.xs(:'rCt', :mgr) || ':'
  || pg_temp.call_as('authenticated', :mgr, format('select counter::text from public.return_overview where id = %L', :'rCt')) || ':'
  || pg_temp.attempt('authenticated', :mgr,
       format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
              :mgr, pg_temp.live(:'rCt'))),
  'received:approved:1:exchange_requested/counter,created/counter,disposition_planned/counter,exchange_approved/staff,'
  || 'replacement_issued/staff,approved/counter,received/counter:ready_to_pick:true:ok:1',
  'G1: "Approve and receive" with an exchange approves, holds the replacement and receives the unit in one transaction (channel counter): the gate is open at once (brief 25)');
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1)) as "rAdd" \gset
select pg_temp.approve(:mgr, :'rAdd', jsonb_build_object(
         'lines', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'disposition', 'restock', 'restock', jsonb_build_object('target', 'staging')))
                     from public.return_lines rl where rl.return_id = :'rAdd'),
         'exchange', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'action', 'add', 'itemId', :gL))
                        from public.return_lines rl where rl.return_id = :'rAdd'))) as "jAdd" \gset
select is(
  ((:'jAdd'::jsonb)->>'status') || ':' || pg_temp.holds(pg_temp.live(:'rAdd'))::text || ':'
  || (select xl.status || '/' || xl.requested_by_kind || '/' || (xl.requested_by = :mgr)::text || '/' || (xl.requested_item_id = :gL)::text
        from public.return_exchange_lines xl where xl.return_id = :'rAdd') || ':'
  || (select string_agg(d.kind, ',' order by d.seq) from public.return_decisions d where d.return_id = :'rAdd') || ':'
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq',
       jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('returnLineId', rl.id, 'disposition', 'restock')) from public.return_lines rl where rl.return_id = :'rBq'),
                          'exchange', jsonb_build_array(
                             jsonb_build_object('exchangeLineId', pg_temp.xl(:'rBq'), 'action', 'approve'),
                             jsonb_build_object('returnLineId', (select rl.id from public.return_lines rl where rl.return_id = :'rBq'), 'action', 'add', 'itemId', :gS)))::text))),
  'approved:1:approved/staff/true/true:created,disposition_planned,exchange_requested,exchange_approved,replacement_issued,approved:22023:return_invalid',
  'G2: "Add a replacement" on a return-only line (G9) records a staff exchange request and approves it with one held replacement; a line that already asks for one cannot take a second');

-- ══ K. Cancel and deny ════════════════════════════════════════════════════
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rCa" \gset
select pg_temp.approve(:mgr, :'rCa', pg_temp.xdec(:'rCa')) as "jCa" \gset
select pg_temp.live(:'rCa') as "oCa" \gset
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.cancel_return(%L, %s, null)', :'rCa', pg_temp.rev(:'rCa')))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :stfRm, format($q$select public.cancel_return(%L, %s, 'No longer needed')$q$, :'rCa', pg_temp.rev(:'rCa')))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.cancel_return(%L, %s, 'No longer needed')$q$, :'rCa', pg_temp.rev(:'rCa')),
       format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA))),
  'P0001:reason_required,42501:orders_approve,P0001:module_disabled',
  'K1: once an exchange was approved, cancelling the RMA needs a reason, order approval and the orders module (it touches the replacement)');
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return(%L, %s, 'The requester no longer needs it')$q$, :'rCa', pg_temp.rev(:'rCa'))) as "jCa2" \gset
select is(
  ((:'jCa2'::jsonb)->>'status') || ':' || (select status from public.order_requests where id = :'oCa') || ':' || pg_temp.holds(:'oCa')::text || ':'
  || (select string_agg(status, ',') from public.return_exchange_lines where return_id = :'rCa') || ':' || pg_temp.xs(:'rCa', :mgr),
  'cancelled:cancelled:0:cancelled:cancelled',
  'K2: cancelling the RMA before the return arrives cancels its replacement and releases the hold in the same transaction (brief 34)');
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rCaH" \gset
select pg_temp.approve(:mgr, :'rCaH', pg_temp.xdec(:'rCaH')) as "jCaHa" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rCaH')) as "jCaHr" \gset
select pg_temp.live(:'rCaH') as "oCaH" \gset
select pg_temp.pick(:mgr, :'oCaH') as "caHPick" \gset
select pg_temp.stage(:mgr, :'oCaH') as "caHStage" \gset
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, :'oCaH')) as "caHSign" \gset
select pg_temp.snap(:gL) as "caHSnap" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return(%L, %s, 'Original not returned')$q$, :'rCaH', pg_temp.rev(:'rCaH'))) as "jCaH" \gset
select is(
  :'caHSign' || ':' || ((:'jCaH'::jsonb)->>'status') || ':' || (select status from public.order_requests where id = :'oCaH') || ':'
  || (pg_temp.snap(:gL) = :'caHSnap')::text || ':' || pg_temp.xs(:'rCaH', :mgr),
  'completed:cancelled:completed:true:handed_over_return_cancelled',
  'K3: after a released replacement was handed over, cancelling the RMA (with a reason) keeps the replacement''s history and moves nothing (brief 34, D11)');
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rDn" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.deny_return(%L, 'Not eligible for an exchange')$q$, :'rDn')) as "jDn" \gset
select is(
  ((:'jDn'::jsonb)->>'status') || ':' || (select status from public.return_exchange_lines where return_id = :'rDn') || ':'
  || (select count(*)::text from public.order_requests where replacement_for_return_id = :'rDn') || ':'
  || (select string_agg(kind, ',' order by seq) from public.return_decisions where return_id = :'rDn') || ':' || pg_temp.xs(:'rDn', :mgr),
  'denied:declined:0:exchange_requested,created,exchange_declined,denied:cancelled',
  'K4: a denied exchange declines its lines and creates no order (no reservation can remain, brief 34)');

-- Desk check F3. oK5 / oK7: completed orders of 4 Mediums; pY / pZ: one unit
-- each on 12-B. Each RMA returns 2 Mediums for 2 of the item, approved on
-- backorder, released early, picked (1) and handed over (1): a backorder with
-- 1 of 2 handed over while the RMA is still approved.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, unit_cost, status, tracking_type, primary_location_id) values
  (:pY, :orgA, :whA, '0397-PY', 'Walk Part Shirt Y', 1, 7, 'active', 'none', :r12B),
  (:pZ, :orgA, :whA, '0397-PZ', 'Walk Part Shirt Z', 1, 7, 'active', 'none', :r12B);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oK5, :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup'),
  (:oK7, :orgA, :whA, 'completed', 'internal', :req, 'Req Person', 'pickup');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled) values
  (:lK5, :oK5, :gM, 4, 4),
  (:lK7, :oK7, :gM, 4, 4);
create function pg_temp.part_handed_over(p_order uuid, p_line uuid, p_item uuid) returns text language plpgsql as $$
declare v_rma text; v_live uuid; v_out text;
begin
  v_rma := pg_temp.mk('03970000-0000-0000-0000-0000000000a1', p_order, pg_temp.xbody(p_line, 2, jsonb_build_object('itemId', p_item)));
  perform pg_temp.approve('03970000-0000-0000-0000-0000000000a1', v_rma::uuid,
                          pg_temp.xdec(v_rma::uuid, 'approve', '{}'::jsonb, '{"whenShort":"backorder"}'::jsonb));
  perform pg_temp.rpc('authenticated', '03970000-0000-0000-0000-0000000000a1',
                      format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, v_rma));
  v_live := pg_temp.live(v_rma::uuid);
  v_out := pg_temp.pick('03970000-0000-0000-0000-0000000000a1', v_live) || '/' || pg_temp.stage('03970000-0000-0000-0000-0000000000a1', v_live)
        || '/' || pg_temp.call_as('authenticated', '03970000-0000-0000-0000-0000000000a1',
                                  format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, v_live));
  if v_out <> 'picking_complete/ok:1/backordered' then
    raise exception 'part_handed_over setup: %', v_out;
  end if;
  return v_rma;
end $$;
select pg_temp.part_handed_over(:oK5, :lK5, :pY) as "rK5" \gset
select pg_temp.live(:'rK5') as "oK5R", pg_temp.snap(:pY) as "k5Snap" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return(%L, %s, 'Original not returned')$q$, :'rK5', pg_temp.rev(:'rK5'))) as "jK5" \gset
select is(
  ((:'jK5'::jsonb)->>'status') || ':' || (select status from public.order_requests where id = :'oK5R') || ':'
  || pg_temp.holds(:'oK5R')::text || ':'
  || (select trim_scale(sum(l.quantity_fulfilled))::text from public.order_request_lines l where l.order_request_id = :'oK5R') || ':'
  || (select string_agg(status, ',') from public.return_exchange_lines where return_id = :'rK5') || ':'
  || pg_temp.xs(:'rK5', :mgr) || ':' || (pg_temp.snap(:pY) = :'k5Snap')::text || ':'
  || pg_temp.attempt('authenticated', :mgr, format('select (public.resume_fulfillment(%L)).status', :'oK5R'),
                     'select public.adjust_stock(''03970000-0000-0000-0000-000000000e1c''::uuid, 1, ''add'', ''03970000-0000-0000-0000-000000000c12''::uuid, ''Walk restock'', null)'),
  'cancelled:completed:0:1:approved:handed_over_return_cancelled:true:P0001:-:invalid_status_transition',
  'K5: released early and handed over in part, cancelling the RMA closes the replacement as delivered-partial (the record kept, nothing moves, nothing held): it is completed and can never be resumed (desk check F3)');
select pg_temp.part_handed_over(:oK7, :lK7, :pZ) as "rK7" \gset
select pg_temp.live(:'rK7') as "oK7R" \gset
select is(
  pg_temp.attempt('authenticated', :mgr, format('select (public.resume_fulfillment(%L)).status', :'oK7R'),
    format($q$select public.adjust_stock('03970000-0000-0000-0000-000000000e1d'::uuid, 1, 'add', '03970000-0000-0000-0000-000000000c12'::uuid, 'Walk restock', null);
              update public.returns set status = 'cancelled' where id = %L$q$, :'rK7'))
  || ' | ' || pg_temp.attempt('authenticated', :mgr, format('select (public.resume_fulfillment(%L)).status', :'oK7R'),
    format($q$select public.adjust_stock('03970000-0000-0000-0000-000000000e1d'::uuid, 1, 'add', '03970000-0000-0000-0000-000000000c12'::uuid, 'Walk restock', null)$q$)),
  'P0001:replacement_return_cancelled:replacement_return_cancelled | ok:1',
  'K6: the gate never lets a cancelled return''s replacement into picking, released or not (a resume refused replacement_return_cancelled); while the RMA is open the released resume passes (desk check F3)');
do $$
begin
  perform public.adjust_stock('03970000-0000-0000-0000-000000000e1d'::uuid, 1, 'add',
                              '03970000-0000-0000-0000-000000000c12'::uuid, 'Walk restock', null);
end $$;
select pg_temp.call_as('authenticated', :mgr, format('select (public.resume_fulfillment(%L)).status', :'oK7R')) as "k7Resume" \gset
select pg_temp.holds(:'oK7R') as "k7Held", pg_temp.snap(:pZ) as "k7Snap" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.cancel_return(%L, %s, 'Original not returned')$q$, :'rK7', pg_temp.rev(:'rK7'))) as "jK7" \gset
select is(
  :'k7Resume' || ':' || :'k7Held' || ':' || ((:'jK7'::jsonb)->>'status') || ':' || (select status from public.order_requests where id = :'oK7R') || ':'
  || pg_temp.holds(:'oK7R')::text || ':'
  || (select trim_scale(sum(l.quantity_fulfilled))::text from public.order_request_lines l where l.order_request_id = :'oK7R') || ':'
  || (select string_agg(status, ',') from public.return_exchange_lines where return_id = :'rK7') || ':'
  || pg_temp.xs(:'rK7', :mgr) || ':' || (pg_temp.snap(:pZ) = :'k7Snap')::text || ':' || pg_temp.balanced(:pZ)::text,
  'pick_slip_generated:1:cancelled:cancelled:0:1:cancelled:handed_over_return_cancelled:true:true',
  'K7: a remainder already resumed into picking is cancelled with the RMA (every hold released, the handed-over unit kept as the record, nothing restocked): nothing more ships for a cancelled return (desk check F3)');

-- ══ L. The link column and fixed lines ════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.order_requests (organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, replacement_for_return_id)
              values (%L, %L, 'pending_approval', 'internal', %L, 'pickup', %L)$q$, :orgA, :whA, :mgr, :'rBq'))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
    format($q$insert into public.order_requests (organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, replacement_for_return_id)
              values (%L, %L, 'pending_approval', 'internal', %L, 'pickup', %L)$q$, :orgA, :whA, :mgr, :'rBq'),
    'grant insert on public.order_requests to authenticated'),
  '42501:-:permission denied for table order_requests | 42501:replacement_link_server_only:replacement_link_server_only',
  'L1: an API-role insert naming the link is refused by privilege, and the link guard refuses it even if a table INSERT grant came back (defence in depth, plan 3.6.4)');
select is(
  pg_temp.attempt('postgres', null, format('update public.order_requests set replacement_for_return_id = null where id = %L', pg_temp.live(:'rB0')))
  || ' | ' || pg_temp.attempt('service_role', null, format('update public.order_requests set replacement_for_return_id = %L where id = %L', :'rBq', pg_temp.live(:'rB0')))
  || ' | ' || pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set replacement_for_return_id = null where id = %L', pg_temp.live(:'rB0'))),
  '42501:replacement_link_immutable:replacement_link_immutable | 42501:replacement_link_immutable:replacement_link_immutable | 42501:-:permission denied for table order_requests',
  'L2: nobody changes the link once written: the owner and the service role meet the guard, an API role holds no UPDATE on the column');
select is(
  pg_temp.attempt('authenticated', :mgr,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', pg_temp.live(:'rB0'), :gS))
  || ' | ' || pg_temp.attempt('authenticated', :req,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', pg_temp.live(:'rB0'), :gS))
  || ' | ' || pg_temp.attempt('authenticated', :mgr,
    format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oOrd, :gS),
    format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
              values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup')$q$, :oOrd, :orgA, :whA, :mgr)),
  '42501:replacement_lines_fixed:replacement_lines_fixed | 42501:replacement_lines_fixed:replacement_lines_fixed | ok:1',
  'L3: a replacement''s lines come from its RMA: an API-role line insert by a manager or the requester is refused; an ordinary pending order still takes one (plan 3.6.6)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.returns set status = 'cancelled' where id = %L$q$, :'rBq'))
  || ' | ' || pg_temp.attempt('authenticated', :mgr, format($q$update public.returns set status = 'denied', denied_by = %L, denial_reason = 'raw' where id = %L$q$, :mgr, :'rBq')),
  '42501:return_exchange_through_rpc:return_exchange_through_rpc | 42501:return_exchange_through_rpc:return_exchange_through_rpc',
  'L4: an old tab''s raw status change on an RMA with an exchange is refused (the returns API guard''s RX-2 clause): only the functions keep the replacement in step');

-- ══ Q. The cancel guard ═══════════════════════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :req, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, pg_temp.live(:'rB0')))
  || ' | ' || pg_temp.attempt('authenticated', :mgr, format($q$select public.cancel_order_request(%L, 'From the order page')$q$, pg_temp.live(:'rB0'))),
  '42501:replacement_cancel_via_return:replacement_cancel_via_return | 42501:replacement_cancel_via_return:replacement_cancel_via_return',
  'Q1: neither the requester nor a manager cancels a replacement from the order: only its RMA does (plan 3.6.5)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.cancel_order_request(%L)', pg_temp.live(:'rB0')),
                  $q$select set_config('stockpilot.return_exchange', 'on', true)$q$)
  || ' | ' || pg_temp.attempt('authenticated', :mgr, format('select public.cancel_order_request(%L)', pg_temp.live(:'rB0')),
                  $q$select set_config('stockpilot.return_exchange', (pg_current_xact_id()::text::bigint + 7)::text, true)$q$),
  '42501:replacement_cancel_via_return:replacement_cancel_via_return | 42501:replacement_cancel_via_return:replacement_cancel_via_return',
  'Q2: the flag counts only when it holds THIS transaction''s id: ''on'' or another transaction''s id is refused (a value left in a pooled session never matches)');

-- ══ N. Notifications ══════════════════════════════════════════════════════
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type)
values ('03970000-0000-0000-0000-000000000913', :orgA, :whA, 'pending_approval', 'internal', :req, 'Req Person', 'pickup');
select is(
  (select count(*)::text from public.notifications n
    where n.type = 'order_request.created' and n.metadata->>'order_request_id' = '03970000-0000-0000-0000-000000000913')
  || '/' || (select count(*)::text from public._notify_recipients(:orgA)),
  '2/2',
  'N1: a new ordinary order still pings every manager (the notify trigger''s WHEN never skips an ordinary order)');
select is(
  (select count(*)::text from public.notifications n
    where n.metadata->>'order_request_id' in (select o.id::text from public.order_requests o
                                               where o.replacement_for_return_id in (:'rB0', :'rHm', :'rI', :'rHe'))),
  '0',
  'N2: a replacement''s insert and approval ping nobody: never "Order approved" beside "Exchange approved" (brief 29)');
select is(
  (select string_agg(n.type || '|' || n.title || '|' || n.body || '|' || (n.user_id = :req)::text || '|'
                     || (n.metadata->>'return_number' = (select return_number from public.returns where id = :'rE'))::text || '|'
                     || (n.link = '/dashboard/orders/' || :'oRepE')::text, E'\n' order by n.type)
     from public.notifications n where n.metadata->>'order_request_id' = :'oRepE'),
  'order_request.completed|Your replacement was handed over|Pickup or delivery is finalized.|true|true|true' || E'\n'
  || 'order_request.staged_for_pickup|Your replacement is ready|Ready for pickup.|true|true|true',
  'N3: the requester hears the replacement in its own words, linked to the replacement order and naming the RMA: ready for pickup, then handed over (the return not yet processed)');
select is(
  (select string_agg(n.type || '|' || n.title || '|' || n.body, ',' order by n.type)
     from public.notifications n where n.metadata->>'order_request_id' = :'oX2'),
  'order_request.in_transit|Your replacement is on the way|It''s out for delivery.,order_request.staged_for_delivery|Your replacement is ready|Ready for delivery.',
  'N4: a delivery replacement says ready for delivery and on the way; its cancellation from the RMA is silent here (the RMA function''s service explains it once)');
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rBo" \gset
select pg_temp.approve(:mgr, :'rBo', pg_temp.xdec(:'rBo')) as "jBo" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rBo')) as "jBor" \gset
select pg_temp.live(:'rBo') as "oBo" \gset
select pg_temp.pick(:mgr, :'oBo') as "boPick" \gset
select pg_temp.stage(:mgr, :'oBo') as "boStage" \gset
update public.order_requests set status = 'backordered' where id = :'oBo';
select is(
  (select string_agg(n.type || '|' || n.title || '|' || n.body, ',' order by n.type)
     from public.notifications n where n.metadata->>'order_request_id' = :'oBo'),
  'order_request.backordered|Part of your replacement was handed over|The rest will follow.,order_request.staged_for_pickup|Your replacement is ready|Ready for pickup.',
  'N5: a partial hand-over of a replacement says the rest will follow');
select pg_temp.pick(:mgr, pg_temp.live(:'rCt')) as "ctPick" \gset
select pg_temp.stage(:mgr, pg_temp.live(:'rCt')) as "ctStage" \gset
select pg_temp.rpc('authenticated', :mgr, format('select public.close_return(%L)', :'rCt')) as "jCtClose" \gset
select pg_temp.call_as('authenticated', :mgr, format($q$select (public.confirm_physical_signature(%L, 'Walk tester')).status$q$, pg_temp.live(:'rCt'))) as "ctSign" \gset
select is(
  :'ctPick' || ':' || :'ctStage' || ':' || ((:'jCtClose'::jsonb)->>'status') || ':' || :'ctSign' || '|'
  || (select string_agg(n.type || '|' || n.title, ',' order by n.type) from public.notifications n
       where n.metadata->>'order_request_id' = pg_temp.live(:'rCt')::text),
  'picking_complete:ok:1:closed:completed|order_request.completed|Your exchange is complete',
  'N6: at the counter the requester is standing there: ready for pickup is silent and only "Your exchange is complete" is sent, once the return is closed (G11, D24)');
select pg_temp.mk(:mgr, :oMute, pg_temp.xbody(:lMute, 1, jsonb_build_object('itemId', :gL))) as "rMu" \gset
select pg_temp.approve(:mgr, :'rMu', pg_temp.xdec(:'rMu')) as "jMu" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rMu')) as "jMur" \gset
select pg_temp.pick(:mgr, pg_temp.live(:'rMu')) as "muPick" \gset
select pg_temp.stage(:mgr, pg_temp.live(:'rMu')) as "muStage" \gset
select is(
  :'muStage' || ':' || (select count(*)::text from public.notifications n where n.metadata->>'order_request_id' = pg_temp.live(:'rMu')::text)
  || ':' || pg_temp.xs(:'rMu', :mgr),
  'ok:1:0:ready_for_pickup',
  'N7: the requester''s own order-status preference silences the replacement''s ready ping, as it does for any order');
select is(
  (select count(*)::text from public.notifications n
     join public.order_requests o on o.id::text = n.metadata->>'order_request_id'
    where o.replacement_for_return_id is not null and n.user_id is distinct from o.requester_user_id),
  '0',
  'N8: no staff member is ever pinged for a replacement order');

-- ══ V. The exchange status CASE ═══════════════════════════════════════════
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1)) as "rNone" \gset
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rDec" \gset
select pg_temp.approve(:mgr, :'rDec', pg_temp.xdec(:'rDec', 'decline', '{"reason":"No Large for this program"}'::jsonb)) as "jDec" \gset
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rOD" \gset
select pg_temp.approve(:mgr, :'rOD', pg_temp.xdec(:'rOD', 'approve', '{}'::jsonb,
         jsonb_build_object('fulfillmentType', 'delivery', 'deliveryCharterId', :cA1))) as "jOD" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Swap at delivery: the driver collects the returned item.')$q$, :'rOD')) as "jODr" \gset
select pg_temp.live(:'rOD') as "oOD" \gset
select pg_temp.pick(:mgr, :'oOD') as "odPick" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.generate_order_packing_slips(%L)).status', :'oOD')) as "odSlip" \gset
update public.order_requests set status = 'staged_for_delivery' where id = :'oOD';
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gL))) as "rIP" \gset
select pg_temp.approve(:mgr, :'rIP', pg_temp.xdec(:'rIP')) as "jIP" \gset
select pg_temp.rpc('authenticated', :mgr, format($q$select public.release_return_replacement_early(%L, 'Customer is completing an in-person exchange today.')$q$, :'rIP')) as "jIPr" \gset
select pg_temp.write_as('authenticated', :mgr,
         format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_by = %L where id = %L$q$,
                :mgr, pg_temp.live(:'rIP'))) as "ipSlip" \gset
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gXL))) as "rUn" \gset
select pg_temp.approve(:mgr, :'rUn', pg_temp.xdec(:'rUn', 'approve', '{}'::jsonb, '{"whenShort":"backorder"}'::jsonb)) as "jUn" \gset
select pg_temp.call_as('authenticated', :mgr, format('select (public.receive_return(%L))->>''status''', :'rAdd')) as "addRecv" \gset
select is(
  (select string_agg(x.label || '=' || pg_temp.xs(x.rma::uuid, :mgr), ',' order by x.n)
     from (values (1, 'return only', :'rNone'), (2, 'handed over then cancelled', :'rCaH'), (3, 'cancelled', :'rCa'),
                  (4, 'denied', :'rDn'), (5, 'requested', :'rBq'), (6, 'declined', :'rDec'), (7, 'completed', :'rE'),
                  (8, 'handed over, return open', :'rX4'), (9, 'backordered', :'rBo'), (10, 'staged for delivery', :'rOD'),
                  (11, 'staged for pickup', :'rMu'), (12, 'pick slip', :'rIP'), (13, 'replacement cancelled', :'rX3'),
                  (14, 'short', :'rUn'), (15, 'held, return approved', :'rI'), (16, 'held, return received', :'rAdd')) x(n, label, rma)),
  'return only=none,handed over then cancelled=handed_over_return_cancelled,cancelled=cancelled,denied=cancelled,'
  || 'requested=requested,declined=declined,completed=completed,handed over, return open=handed_over_return_open,'
  || 'backordered=partly_handed_over,staged for delivery=out_for_delivery,staged for pickup=ready_for_pickup,'
  || 'pick slip=in_progress,replacement cancelled=replacement_cancelled,short=unavailable,'
  || 'held, return approved=waiting_for_return,held, return received=ready_to_pick',
  'V1: one fixture per exchange status code, first match wins: a shortage outranks waiting, and a replacement handed over while the return is open never reads completed (judge A-1)');
select pg_temp.mk(:mgr, :oG, pg_temp.xbody(:lG, 1, jsonb_build_object('itemId', :gXL))) as "rRqS" \gset
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select kind || ':' || counter::text || ':' || released_early::text || ':' || replacement_status
                                                       || ':' || trim_scale(replacement_owed)::text || ':' || exchange_revision::text
                                                  from public.return_overview where id = %L$q$, :'rCt'))
  || '|' || pg_temp.call_as('authenticated', :mgr, format($q$select trim_scale(replacement_owed)::text || ':' || trim_scale(replacement_held)::text
                                                          || ':' || released_early::text || ':' || exchange_status from public.return_overview where id = %L$q$, :'rUn'))
  || '|' || pg_temp.call_as('authenticated', :mgr, format($q$select any_requested::text || ':' || requested_short::text || ':' || exchange_status
                                                     from public.return_overview where id = %L$q$, :'rBq'))
  || '|' || pg_temp.call_as('authenticated', :mgr, format($q$select any_requested::text || ':' || requested_short::text || ':' || exchange_status
                                                     from public.return_overview where id = %L$q$, :'rRqS'))
  || '|' || pg_temp.call_as('authenticated', :mgr, format($q$select kind || ':' || exchange_status || ':' || coalesce(replacement_order_id::text, 'none')
                                                     from public.return_overview where id = %L$q$, :'rNone'))
  || '|' || pg_temp.call_as('authenticated', :mgr, format($q$select all_declined::text || ':' || exchange_status
                                                     from public.return_overview where id = %L$q$, :'rDec')),
  'exchange:true:false:completed:0:1|1:0:false:unavailable|true:false:requested|true:true:requested|return:none:none|true:declined',
  'V2: the view''s exchange facts: the counter receipt, what a replacement owes and holds, the requested advice "replacement short" (brief 8), a return-only row, all lines declined');

-- ══ P. Parity T2-C2 with create_order_request ═════════════════════════════
select pg_temp.call_as('authenticated', :req, format($q$select (public.create_order_request(%L::jsonb, %L::jsonb)).id::text$q$,
          jsonb_build_object('organization_id', :orgA, 'warehouse_id', :whA, 'requester_user_id', :req, 'requester_name', 'Req Person',
                             'fulfillment_type', 'pickup', 'requester_phone', '555-0397', 'pickup_location_notes', 'Front desk'),
          jsonb_build_array(jsonb_build_object('item_id', :gL, 'quantity', 1)))) as "oOrdP" \gset
select pg_temp.mk(:mgr, :oPar, pg_temp.xbody(:lPar, 1, jsonb_build_object('itemId', :gL))) as "rPar" \gset
select pg_temp.approve(:mgr, :'rPar', pg_temp.xdec(:'rPar')) as "jPar" \gset
select pg_temp.live(:'rPar') as "oRepP" \gset
select is(
  (select coalesce(string_agg(k.k, ',' order by k.k), '')
     from (select (select to_jsonb(a) from public.order_requests a where a.id = :'oOrdP') as ja,
                  (select to_jsonb(b) from public.order_requests b where b.id = :'oRepP') as jb) j,
          lateral jsonb_object_keys(j.ja) k(k)
    where k.k not in ('id', 'order_number', 'created_at', 'updated_at', 'status', 'approved_by', 'approved_at', 'source',
                      'customer_id', 'replacement_for_return_id')
      and j.ja->k.k is distinct from j.jb->k.k),
  '',
  'P1: parity T2-C2: a replacement header equals an order create_order_request builds from the same inputs in every column but the documented allowlist (a future change to create_order_request fails here)');
select is(
  (select ((to_jsonb(a) - array['id', 'order_request_id', 'created_at']) = (to_jsonb(b) - array['id', 'order_request_id', 'created_at']))::text
     from public.order_request_lines a, public.order_request_lines b
    where a.order_request_id = :'oOrdP' and b.order_request_id = :'oRepP')
  || ':' || (select trim_scale(unit_cost_at_request)::text from public.order_request_lines where order_request_id = :'oRepP'),
  'true:7',
  'P2: and its line equals the line guard''s (the cost snapshot stamped from the item, no price, nothing picked)');

-- ══ Y. The requester tier (RX-3's predicate, shipped here) ════════════════
select pg_temp.call_as('service_role', null, format('select public.return_exchange_options(%L)::text', :oR)) as "yR" \gset
select pg_temp.call_as('service_role', null, format('select public.return_exchange_options(%L)::text', :oPortalR)) as "yP" \gset
select is(
  (select string_agg((o->>'variantKey') || '='
                     || case when (o->>'itemId') = :rL then 'rL' when (o->>'itemId') = :r2XL then 'r2XL'
                             when (o->>'itemId') = :r3XL then 'r3XL' else 'other' end
                     || '/' || (o->>'free'), ',' order by o->>'variantKey')
     from jsonb_array_elements((:'yR'::jsonb)->0->'options') o)
  || '|' || jsonb_array_length(:'yR'::jsonb)::text
  || '|' || (((:'yR'::jsonb)->0->>'orderRequestLineId') = :lR)::text,
  '2XL=r2XL/0,3XL=r3XL/1,L=rL/3|1|true',
  'Y1: the requester options are the item''s other sizes in its live group, warehouse and charter: never hidden (internal_only offered, D4), another warehouse or charter, or the same size (D3); two rows of one size collapse to the one with most free stock (Model B)');
select is(
  (select string_agg(o->>'variantKey', ',' order by o->>'variantKey') from jsonb_array_elements((:'yP'::jsonb)->0->'options') o)
  || '|' || (pg_temp.try_rpc('service_role', null, format('select public.return_exchange_options(%L)', :oPortalR),
               format($q$update public.customers set status = 'archived' where id = %L$q$, :cust)))::text
  || '|' || pg_temp.call_as('service_role', null, format('select public.return_exchange_options(%L)::text', :oOld)),
  '3XL,L|[]|[]',
  'Y2: a portal order offers only sizes on its customer''s catalog, nothing once the customer is archived, and an archived group offers nothing (D20)');
select is(
  (select string_agg(pg_temp.err(pg_temp.try_rpc('service_role', null,
             format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$, :oR,
                    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lR, 'quantity', 1, 'exchange', x.ex)))::text))),
                     ',' order by x.n)
     from (values (1, jsonb_build_object('itemId', :rL)), (2, jsonb_build_object('itemId', :rXLh)), (3, jsonb_build_object('itemId', :gL)),
                  (4, jsonb_build_object('itemId', :rSame)), (5, jsonb_build_object('itemId', :rL2)),
                  (6, jsonb_build_object('note', 'Need a bigger one'))) x(n, ex)),
  'ok,P0001:exchange_item_not_eligible,P0001:exchange_item_not_eligible,P0001:exchange_item_not_eligible,P0001:exchange_item_not_eligible,ok',
  'Y3: a requester (the token path) may ask only for an offered size, with one answer for every other item (hidden, another group, the same size, a row that collapsed away), or for the warehouse to review (brief 6, 32)');
select (pg_temp.rpc('service_role', null,
          format($q$select public.create_requester_return_request(%L, %L::jsonb, gen_random_uuid(), '{"channel":"token"}'::jsonb)$q$, :oR,
                 jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('orderRequestLineId', :lR, 'quantity', 1,
                                                                                  'exchange', jsonb_build_object('itemId', :rL))))::text))->>'returnId') as "rY" \gset
select is(
  (select xl.requested_by_kind || ':' || coalesce(xl.requested_by::text, 'none') || ':' || (xl.requested_item_id = :rL)::text
     from public.return_exchange_lines xl where xl.return_id = :'rY')
  || ':' || (select string_agg(d.kind || '/' || d.channel || '/' || d.actor_kind, ',' order by d.seq) from public.return_decisions d where d.return_id = :'rY'),
  'requester:none:true:exchange_requested/token/requester,created/token/requester',
  'Y4: a requester''s exchange line records who asked (the anonymous token) and its channel');

-- ══ M. The shape cases shared with core ═══════════════════════════════════
-- case: approve_exchange_decline_without_reason
-- case: approve_exchange_unknown_action
-- case: change_replacement_reason_blank
-- case: cancel_replacement_reason_blank
select is(
  pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq',
                  pg_temp.xdec(:'rBq', 'decline')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format('select public.approve_return(%L, 0, %L::jsonb)', :'rBq',
                  pg_temp.xdec(:'rBq', 'swap')::text))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.change_return_replacement(%L, %s, '[]'::jsonb, '  ', 'refuse')$q$,
                  :'rI', pg_temp.rev(:'rI')))) || ','
  || pg_temp.err(pg_temp.try_rpc('authenticated', :mgr, format($q$select public.cancel_return_replacement(%L, %s, '')$q$,
                  :'rI', pg_temp.rev(:'rI')))),
  'P0001:reason_required,22023:return_invalid,P0001:reason_required,P0001:reason_required',
  'M1: declining an exchange, changing or cancelling a replacement needs a reason; an unknown exchange action is refused');

-- ══ F. Frozen bodies, stock, the organization delete ══════════════════════
select is(
  (select coalesce(string_agg(x.sig, ','), '')
     from (values
       ('public._notify_order_request_changes()',                 'a223ae83810149728156b8e299c7425e'),
       ('public._validate_order_request_status_transition()',     'dee8cd4782ec83abdb31a2b48fcd4ef2'),
       ('public.create_order_request(jsonb,jsonb)',               '4d65cef6c569a8c2c699fd9d5c8b77d5'),
       ('public.tg_order_requests_insert_guard()',                'caf69f8a23d03b9bfa6ea87a9cf94077'),
       ('public.tg_order_request_lines_guard()',                  'd899924c0f8fc1dfae4e8be7bd4c5cad'),
       ('public.tg_order_requests_workflow_guard()',              '55bceafc13d599f8d77d6a4180c28140'),
       ('public.approve_partial(uuid)',                           '40ca0878733b08a649773fe9b7efd4e0'),
       ('public.cancel_order_request(uuid,text)',                 '47cabcd1fe4f52fb7b2b6b6b64b68da1'),
       ('public.complete_picking(uuid)',                          'b8f1ef1fb01efa5c04c916c178129541'),
       ('public.resume_fulfillment(uuid)',                        '2e2d5aab1db5392250879bfa9ff4bccd'),
       ('public.hold_order_stock(uuid)',                          '3b0691d604823164daaa7f248616f00f'),
       ('public.reopen_picking(uuid,text)',                       '293ce0e76d195bb13105cfd1c067de82'),
       ('public.order_readiness_facts(uuid)',                     '2f3fb057bacda8143377ecd9c2c5e6e2'),
       ('public.order_items_orderable(uuid,uuid[])',              'b4df95d74e32850923a430769f96f246'),
       ('public.assign_order_request_number()',                   '03097df3cded3d0ea42676855abc6a25'),
       ('public.confirm_physical_signature(uuid,text)',           'f7a14a46d2c70f635c3da844c786ce67'),
       ('public.caller_can_read_item(uuid)',                      '80523d2cc0fafe7fc6b3599903d7f014'),
       ('public._notify_recipients(uuid)',                        '679e6193e3dbe5644055e835e8209043'),
       ('public.create_return_request(uuid,jsonb,uuid)',          '36596e93f472b0f831a6a43bb316a294'),
       ('public.create_requester_return_request(uuid,jsonb,uuid,jsonb)', '157aebbe26a7baff32dd56755ab9025d'),
       ('public.approve_return(uuid,integer,jsonb,boolean)',      'edf25c49264c74d8597fa87d6260112b'),
       ('public.deny_return(uuid,text)',                          'f94e717d62b1e24df5e46fb83f305e1c'),
       ('public.receive_return(uuid)',                            'c44f3942d4ae1028ed86e6ad305866d0'),
       ('public.cancel_return(uuid,integer,text)',                '11e8be3e7f3fe7899c6c919311fbf9c1'),
       ('public.plan_return_dispositions(uuid,jsonb)',            'ba1399f851f4882a3e66b8f4c8763743'),
       ('public.close_return(uuid,jsonb,bigint)',                 'dfdb2be52dfb3be08b42b0cdb6ca2d6e'),
       ('public.return_restock_options(uuid)',                    '22f0eef799df683558507a42ea45a8d8'),
       ('ledger.process_return_disposition(uuid)',                '69e46c8163600cb55ae70246ca3a85d3'),
       ('public.process_return_disposition(uuid)',                '7ec76cc98b9cefc31707590071ac14d9')
     ) x(sig, want)
     left join pg_proc p on p.oid = to_regprocedure(x.sig)
    where md5(p.prosrc) is distinct from x.want),
  '',
  'F1: every frozen order body, the RX-1 RMA functions and the restated disposition keep their md5 (RX-2 replaces only the hooks and the returns guard)');
select is(
  (select string_agg(c.relname || '.' || t.tgname || '=' || md5(pg_get_triggerdef(t.oid)), ','
                     order by c.relname collate "C", t.tgname collate "C")
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname in ('trg_order_requests_validate_transition', 'trg_assign_order_request_number', 'trg_zz_order_requests_insert_guard',
                       'order_requests_set_updated_at', 'trg_zz_order_request_lines_guard', 'trg_order_requests_workflow_guard',
                       'trg_returns_validate_transition', 'returns_set_updated_at', 'trg_notifications_dispatch_push')
      and c.relnamespace = 'public'::regnamespace),
  'notifications.trg_notifications_dispatch_push=075267e9d04e1a9d15f57556f8f0ea03,'
  || 'order_request_lines.trg_zz_order_request_lines_guard=b2f6dad5ca729f93f534cdbc73d8d395,'
  || 'order_requests.order_requests_set_updated_at=f912d1e6de45c8b6c9c8bcacdbc291c3,'
  || 'order_requests.trg_assign_order_request_number=741c34077fbaf5508d979f966affc84d,'
  || 'order_requests.trg_order_requests_validate_transition=dcf5294e729dc5900c2d7bd1ad4f6412,'
  || 'order_requests.trg_order_requests_workflow_guard=f25d3ae18d19712e1d7d57a34d6c298b,'
  || 'order_requests.trg_zz_order_requests_insert_guard=67131166ed7932bdd3097cb8a289463c,'
  || 'returns.returns_set_updated_at=60a0a59c195649e72a13404ef58e110a,'
  || 'returns.trg_returns_validate_transition=219e2236f7b30e0f4eb886477a2abe7a',
  'F2: every other order, line, return and notification trigger definition is unchanged');
select is(
  (select coalesce(string_agg(i.sku, ',' order by i.sku collate "C"), '')
     from public.inventory_items i where i.organization_id = :orgA and not pg_temp.balanced(i.id)),
  '',
  'F3: holdings equal on hand for every item of the organization after every scenario (brief 15; no stock inflation, no double restock)');
select (pg_temp.rpc('authenticated', :outZ, format('select public.create_return_request(%L, %L::jsonb, gen_random_uuid())', :oZ,
          pg_temp.xbody(:lZ, 1, jsonb_build_object('itemId', :zL))::text))->>'returnId') as "rZ" \gset
select pg_temp.approve(:outZ, :'rZ', pg_temp.xdec(:'rZ')) as "jZ" \gset
select is(
  ((:'jZ'::jsonb)->'replacement'->>'status')
  || ',' || pg_temp.attempt('postgres', null, format('delete from public.organizations where id = %L', :orgZ),
                            'alter table public.order_request_lines drop constraint order_request_lines_item_id_fkey',
                            format($q$select (select count(*) from public.returns where organization_id = %L) || '/'
                                             || (select count(*) from public.return_exchange_lines where organization_id = %L) || '/'
                                             || (select count(*) from public.order_requests where organization_id = %L) || '/'
                                             || (select count(*) from public.return_decisions where organization_id = %L)$q$,
                                   :orgZ, :orgZ, :orgZ, :orgZ)),
  'approved,ok:1:0/0/0/0',
  'F4: an organization delete with an exchange RMA and its replacement order: with the pre-existing RESTRICT key on order lines set aside (as RX-1''s L4), everything cascades; the NO ACTION link adds no obstacle (judge 4.9)');
select is(
  (select count(*)::int from public.return_exchange_lines xl
    where not exists (select 1 from public.returns r where r.id = xl.return_id and r.organization_id = xl.organization_id))
  + (select count(*)::int from public.order_requests o
      where o.replacement_for_return_id is not null
        and not exists (select 1 from public.returns r where r.id = o.replacement_for_return_id and r.organization_id = o.organization_id))
  + (select count(*)::int from public.return_exchange_lines xl
      where xl.replacement_order_request_id is not null
        and not exists (select 1 from public.order_requests o where o.id = xl.replacement_order_request_id and o.replacement_for_return_id = xl.return_id)),
  0,
  'F5: every exchange line and replacement belongs to an RMA of its own organization, and every line''s replacement links back to its RMA (G6)');

select * from finish();
rollback;
