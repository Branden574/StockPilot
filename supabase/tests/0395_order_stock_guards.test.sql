-- supabase/tests/0395_order_stock_guards.test.sql
-- pgTAP proof for migration 0395 (small fixes, slice 2): order and stock
-- guards the web app applied, now applied by the database for every caller.
-- Written to fail against the pre-0395 head (0394, after security A3 and
-- returns RX-1) in every section but P and the fixture checks.
--
-- Personas (one org, plus a second org for foreign checks):
--   own    owner                 adm    admin
--   mgr    manager, no override  mgrNo  manager, stock:adjust, stock:transfer
--                                       and bundles:manage revoked
--   stf    staff (default set)   stfNo  staff, stock:adjust and
--                                       stock:transfer revoked
--   stfAp  staff granted orders:approve (the scoped approver)
--   req    staff, the requester of the fixture orders
--   drv    staff, the assigned delivery driver
--   vwr    viewer                outZ   a manager of another organization
--   Every staff member and the viewer is assigned to warehouse A only;
--   warehouse B is the other warehouse of the same organization.
--
-- R.  One change per body: md5(prosrc) is 0395's and removing the added text
--     gives production's body exactly (R1-R10); the same on the whole
--     definition (R11).
-- P.  Posture of the ten unchanged (SECURITY mode, SET clauses, owner,
--     EXECUTE), the comments say what 0395 enforces.
-- N.  N1: the requester cancels their own order at pending approval only;
--     an approver cancels at every open status.
-- L.  L115: a drawn cancel's restock and a reopen's movement carry the order
--     reference; a same-transaction movement naming another order does not.
-- K.  L8: a direct ledger call answers to the permission the app checks; the
--     order functions, a call inside another ledger call and service_role
--     are not held; a row the caller cannot read is left to the body.
-- D.  L15: no soft delete of an item with stock on record or a holding, for
--     every role; an empty item is deleted; a deleted row's other updates and
--     an undelete pass; the guard's posture.
-- W.  L129a: the scoped approver's raw PATCH on another warehouse's order
--     matches 0 rows on each of the four user-client edges and the notes,
--     its own warehouse's 1; a move to another warehouse is refused (WITH
--     CHECK); manager, admin and owner parity.
-- S.  L129b: a paper signature by the assigned driver needs the driver to be
--     a member (not removed, not disabled) with Orders on; a manager is
--     unchanged.
-- B.  L11: a kit line is refused on the requester's own client and the
--     approver's; a normal line passes.
-- A.  L86: the approved notification for a full, a partial, an enough, a
--     two-lines-one-item approval, and a partial approval that held nothing.
-- H.  The two policies' text (predicted from production's text plus the
--     added term; verify on the stack), still PERMISSIVE for authenticated;
--     no policy pairs has_org_role with orders:approve (0390 H2's census).
-- G.  No function here raises 40001 or 40P01.
-- Z.  Every undone attempt changed nothing.
--
-- MUTATION TABLE (stockpilot-work/six/mutate-0396.py; each must fail the
-- named lines):
--   M1  cancel without the requester window                  -> R1, N1
--   M2  cancel window on pending_confirmation too            -> R1, N1
--   M3  cancel without the restock link                      -> R1, L1
--   M4  cancel link without the reason term (decoy linked)   -> R1, L1
--   M5  reopen without the link                              -> R2, L2
--   M6  adjust_stock gate removed                            -> R5, K1, K3
--   M7  adjust_stock gate without ledger.active() (nested)   -> R5, K5
--   M8  adjust_stock gate holds service_role too             -> R5, K6
--   M9  transfer_stock gate removed                          -> R6, K1, K3
--   M10 post_receipt_v2 gate removed                         -> R9, K3
--   M11 delete guard trigger dropped                         -> D1, D2, D5, D6, D7
--   M12 delete guard ignores holdings                        -> D2
--   M13 delete guard fires on every deleted_at update        -> D4
--   M14 update policy without the warehouse term             -> W1, W3, W4, H1, H3
--   M15 update policy USING only (WITH CHECK unchanged)      -> W4, H1, H3
--   M16 signature without the membership term                -> R3, S2, S3
--   M17 signature without the module term                    -> R3, S4
--   M18 lines policy without the kit term                    -> B1, H2
--   M19 notify without the partial sentence                  -> R4, A2, A4
--   M20 notify comparing per line instead of per item        -> R4, A4
--   M21 update policy with a manager-by-role arm added        -> H1, H3, H4
--   M22 notify says "part" when nothing is held              -> R4, A5
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone) or pg_temp.call_as (kept), which switch role
-- and claims with set_config inside a subtransaction (the 0387 helpers), so
-- the pgTAP bookkeeping never runs as an API role. begin/rollback: nothing
-- leaks. Namespace 03960000.

begin;

select plan(57);

\set orgA    '\'03960000-0000-0000-0000-00000000000a\''
\set orgZ    '\'03960000-0000-0000-0000-00000000000b\''
\set own     '\'03960000-0000-0000-0000-0000000000a0\''
\set adm     '\'03960000-0000-0000-0000-0000000000a1\''
\set mgr     '\'03960000-0000-0000-0000-0000000000a2\''
\set mgrNo   '\'03960000-0000-0000-0000-0000000000a3\''
\set stf     '\'03960000-0000-0000-0000-0000000000a4\''
\set stfNo   '\'03960000-0000-0000-0000-0000000000a5\''
\set stfAp   '\'03960000-0000-0000-0000-0000000000a6\''
\set req     '\'03960000-0000-0000-0000-0000000000a7\''
\set drv     '\'03960000-0000-0000-0000-0000000000a8\''
\set vwr     '\'03960000-0000-0000-0000-0000000000a9\''
\set outZ    '\'03960000-0000-0000-0000-0000000000b1\''
\set whA     '\'03960000-0000-0000-0000-0000000000d1\''
\set whB     '\'03960000-0000-0000-0000-0000000000d2\''
\set whZ     '\'03960000-0000-0000-0000-0000000000d3\''
\set chA     '\'03960000-0000-0000-0000-0000000000c1\''
\set itA     '\'03960000-0000-0000-0000-0000000000e1\''
\set itB     '\'03960000-0000-0000-0000-0000000000e2\''
\set itP     '\'03960000-0000-0000-0000-0000000000e3\''
\set itKit   '\'03960000-0000-0000-0000-0000000000e4\''
\set itD0    '\'03960000-0000-0000-0000-0000000000e5\''
\set itDQ    '\'03960000-0000-0000-0000-0000000000e6\''
\set itDH    '\'03960000-0000-0000-0000-0000000000e7\''
\set itGone  '\'03960000-0000-0000-0000-0000000000e8\''
\set itNone  '\'03960000-0000-0000-0000-0000000000e9\''
\set bnA     '\'03960000-0000-0000-0000-0000000000f1\''
\set ccA     '\'03960000-0000-0000-0000-0000000000f2\''
\set poA     '\'03960000-0000-0000-0000-0000000000f3\''
\set rcA     '\'03960000-0000-0000-0000-0000000000f4\''
\set oPend   '\'03960000-0000-0000-0000-000000000101\''
\set oAppr   '\'03960000-0000-0000-0000-000000000102\''
\set oPSG    '\'03960000-0000-0000-0000-000000000103\''
\set oPIP    '\'03960000-0000-0000-0000-000000000104\''
\set oPC     '\'03960000-0000-0000-0000-000000000105\''
\set oPack   '\'03960000-0000-0000-0000-000000000106\''
\set oStgP   '\'03960000-0000-0000-0000-000000000107\''
\set oStgD   '\'03960000-0000-0000-0000-000000000108\''
\set oTrans  '\'03960000-0000-0000-0000-000000000109\''
\set oBack   '\'03960000-0000-0000-0000-00000000010a\''
\set oPC2    '\'03960000-0000-0000-0000-000000000111\''
\set oPS     '\'03960000-0000-0000-0000-000000000112\''
\set oBPend  '\'03960000-0000-0000-0000-000000000121\''
\set oBAppr  '\'03960000-0000-0000-0000-000000000122\''
\set oBPack  '\'03960000-0000-0000-0000-000000000123\''
\set oBPackD '\'03960000-0000-0000-0000-000000000124\''
\set oAPack  '\'03960000-0000-0000-0000-000000000125\''
\set oAPackD '\'03960000-0000-0000-0000-000000000126\''
\set oAMove  '\'03960000-0000-0000-0000-000000000127\''
\set oLines  '\'03960000-0000-0000-0000-000000000131\''
\set oN1     '\'03960000-0000-0000-0000-000000000141\''
\set oN2     '\'03960000-0000-0000-0000-000000000142\''
\set oN3     '\'03960000-0000-0000-0000-000000000143\''
\set oN4     '\'03960000-0000-0000-0000-000000000144\''
\set oN5     '\'03960000-0000-0000-0000-000000000145\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0395-own@test.local',   '{}'::jsonb),
  (:adm,   '0395-adm@test.local',   '{}'::jsonb),
  (:mgr,   '0395-mgr@test.local',   '{}'::jsonb),
  (:mgrNo, '0395-mgrno@test.local', '{}'::jsonb),
  (:stf,   '0395-stf@test.local',   '{}'::jsonb),
  (:stfNo, '0395-stfno@test.local', '{}'::jsonb),
  (:stfAp, '0395-stfap@test.local', '{}'::jsonb),
  (:req,   '0395-req@test.local',   '{}'::jsonb),
  (:drv,   '0395-drv@test.local',   '{}'::jsonb),
  (:vwr,   '0395-vwr@test.local',   '{}'::jsonb),
  (:outZ,  '0395-outz@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0395 Guards A', '0395-guards-a'),
  (:orgZ, '0395 Guards Z', '0395-guards-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :adm,   'admin',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :mgrNo, 'manager', now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :stfNo, 'staff',   now()),
  (:orgA, :stfAp, 'staff',   now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :drv,   'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgZ, :outZ,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0395 Main',  'WH-0395A', 'active'),
  (:whB, :orgA, '0395 Annex', 'WH-0395B', 'active'),
  (:whZ, :orgZ, '0395 Zed',   'WH-0395Z', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0395 Charter', 'CH-0395', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,   :whA, true),
  (:orgA, :stfNo, :whA, true),
  (:orgA, :stfAp, :whA, true),
  (:orgA, :req,   :whA, true),
  (:orgA, :drv,   :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNo, 'stock:adjust',   false),
  (:orgA, :mgrNo, 'stock:transfer', false),
  (:orgA, :mgrNo, 'bundles:manage', false),
  (:orgA, :stfNo, 'stock:adjust',   false),
  (:orgA, :stfNo, 'stock:transfer', false),
  (:orgA, :stfAp, 'orders:approve', true);

select public.ensure_warehouse_placement_locations(:whA) as "ensA" \gset
select public.ensure_warehouse_placement_locations(:whB) as "ensB" \gset
select id as "locA" from public.locations where warehouse_id = :whA and kind = 'unplaced' and deleted_at is null limit 1 \gset
select id as "locS" from public.locations where warehouse_id = :whA and kind = 'staging' and deleted_at is null limit 1 \gset

-- Opening stock lands in each warehouse's Unplaced bucket (tg_seed_initial_level).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type, is_bundle, deleted_at) values
  (:itA,    :orgA, :whA, '0395-A',    'Guard item',                 100, 'active',   'none', false, null),
  (:itB,    :orgA, :whB, '0395-B',    'Annex item',                  50, 'active',   'none', false, null),
  (:itP,    :orgA, :whA, '0395-P',    'Scarce item',                 10, 'active',   'none', false, null),
  (:itKit,  :orgA, :whA, '0395-KIT',  'Kit stock',                    0, 'active',   'none', true,  null),
  (:itD0,   :orgA, :whA, '0395-D0',   'Empty archived item',          0, 'archived', 'none', false, null),
  (:itDQ,   :orgA, :whA, '0395-DQ',   'Archived with stock on record', 5, 'archived', 'none', false, null),
  (:itDH,   :orgA, :whA, '0395-DH',   'Archived with a holding only',  0, 'archived', 'none', false, null),
  (:itGone, :orgA, :whA, '0395-GONE', 'Deleted with stock on record',  3, 'archived', 'none', false, now() - interval '30 days'),
  (:itNone, :orgA, :whA, '0395-NONE', 'Out of stock',                  0, 'active',   'none', false, null);
-- A holding with nothing on record (the shape the guard must still see).
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :itDH, :'locA', 2);

-- The rows the manager-floor wrappers' gates read: an inactive kit, an open
-- count with no lines, an ordered purchase order and a reversed receipt. Each
-- body refuses them for its own reason once the gate has passed.
insert into public.bundles (id, organization_id, name, sku, is_active, preassembly_enabled) values
  (:bnA, :orgA, '0395 Kit', 'BNDL-0395', false, true);
insert into public.cycle_counts (id, organization_id, warehouse_id, status, started_by) values
  (:ccA, :orgA, :whA, 'in_progress', :mgr);
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:poA, :orgA, 'PO-0395', 'ordered');
insert into public.receipts (id, organization_id, purchase_order_id, warehouse_id, receipt_number, status, received_by, immutable_hash) values
  (:rcA, :orgA, :poA, :whA, 'R-0395', 'reversed', :mgr, 'hash-0395');

-- Orders at their status, inserted by the superuser (the insert guard holds
-- API roles only; the transition trigger fires on UPDATE only). Delivery
-- orders carry the charter (order_requests_delivery_target_chk).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, assigned_delivery_user_id) values
  (:oPend,   :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oAppr,   :orgA, :whA, 'approved',               'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oPSG,    :orgA, :whA, 'pick_slip_generated',    'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oPIP,    :orgA, :whA, 'picking_in_progress',    'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oPC,     :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oPack,   :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oStgP,   :orgA, :whA, 'staged_for_pickup',      'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oStgD,   :orgA, :whA, 'staged_for_delivery',    'internal', :req, 'delivery', :chA, :mgr, now(), null),
  (:oTrans,  :orgA, :whA, 'in_transit',             'internal', :req, 'delivery', :chA, :mgr, now(), :drv),
  (:oBack,   :orgA, :whA, 'backordered',            'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oPC2,    :orgA, :whA, 'picking_complete',       'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oPS,     :orgA, :whA, 'pick_slip_generated',    'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oBPend,  :orgA, :whB, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oBAppr,  :orgA, :whB, 'approved',               'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oBPack,  :orgA, :whB, 'packing_slip_generated', 'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oBPackD, :orgA, :whB, 'packing_slip_generated', 'internal', :req, 'delivery', :chA, :mgr, now(), null),
  (:oAPack,  :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oAPackD, :orgA, :whA, 'packing_slip_generated', 'internal', :req, 'delivery', :chA, :mgr, now(), null),
  (:oAMove,  :orgA, :whA, 'approved',               'internal', :req, 'pickup',   null, :mgr, now(), null),
  (:oLines,  :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oN1,     :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oN2,     :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oN3,     :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oN4,     :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null),
  (:oN5,     :orgA, :whA, 'pending_approval',       'internal', :req, 'pickup',   null, null, null,  null);

insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:oPend,  :itA, 1, 0, null),
  (:oAppr,  :itA, 1, 0, null),
  (:oPSG,   :itA, 1, 0, null),
  (:oPIP,   :itA, 1, 0, null),
  (:oPC,    :itA, 2, 0, 2),
  (:oPack,  :itA, 1, 0, 1),
  (:oStgP,  :itA, 1, 0, 1),
  (:oStgD,  :itA, 1, 0, 1),
  (:oTrans, :itA, 1, 0, 1),
  (:oBack,  :itA, 4, 2, null),
  (:oPC2,   :itA, 2, 0, 2),
  (:oPS,    :itA, 2, 0, null),
  (:oLines, :itA, 1, 0, null),
  (:oN1,    :itA, 3, 0, null),
  (:oN2,    :itP, 30, 0, null),
  (:oN3,    :itP, 4, 0, null),
  (:oN4,    :itP, 6, 0, null),
  (:oN4,    :itP, 6, 0, null),
  (:oN5,    :itNone, 5, 0, null);

-- ══ Helpers (0387's, unchanged) ═══════════════════════════════════════════
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
    raise exception using errcode = 'XX396', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX396' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('mgrNo', :mgrNo), ('stf', :stf), ('stfNo', :stfNo),
  ('stfAp', :stfAp), ('req', :req), ('drv', :drv), ('vwr', :vwr), ('outZ', :outZ);
-- The same statement for each named persona, in the order given, each call
-- undone: 'who=<attempt>, who=<attempt>, ...'.
create function pg_temp.each(p_who text[], p_sql text, p_check text default null, p_prep text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w), p_sql, p_prep, p_check);
  end loop;
  return v;
end $$;
-- One persona, one statement template (%L = the order id) over several
-- orders, each call undone: '<attempt>, <attempt>, ...'.
create function pg_temp.over(p_who text, p_orders uuid[], p_tmpl text)
returns text language plpgsql as $$
declare v text := ''; o uuid;
begin
  foreach o in array p_orders loop
    v := v || case when v = '' then '' else ', ' end
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = p_who), format(p_tmpl, o));
  end loop;
  return v;
end $$;

-- ══ The fixture is what the matrices assume ═══════════════════════════════
create function pg_temp.perm(p_who text, p_perm text) returns text language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub', (select p.id::text from persona p where p.who = p_who), true);
  v := public.has_permission('03960000-0000-0000-0000-00000000000a', p_perm);
  perform set_config('request.jwt.claim.sub', '', true);
  return p_who || ':' || p_perm || '=' || v::text;
end $$;
select is(
  pg_temp.perm('mgrNo', 'stock:adjust') || ' ' || pg_temp.perm('mgrNo', 'stock:transfer') || ' '
  || pg_temp.perm('mgrNo', 'bundles:manage') || ' ' || pg_temp.perm('mgrNo', 'orders:approve') || ' '
  || pg_temp.perm('stfNo', 'stock:adjust') || ' ' || pg_temp.perm('stfNo', 'stock:transfer') || ' '
  || pg_temp.perm('stf', 'stock:adjust') || ' ' || pg_temp.perm('stf', 'stock:transfer') || ' '
  || pg_temp.perm('stfAp', 'orders:approve') || ' ' || pg_temp.perm('req', 'orders:approve') || ' '
  || pg_temp.perm('vwr', 'stock:adjust'),
  'mgrNo:stock:adjust=false mgrNo:stock:transfer=false mgrNo:bundles:manage=false mgrNo:orders:approve=true '
  'stfNo:stock:adjust=false stfNo:stock:transfer=false stf:stock:adjust=true stf:stock:transfer=true '
  'stfAp:orders:approve=true req:orders:approve=false vwr:stock:adjust=false',
  'F1: the personas hold what the matrices assume (the revoked manager and staff member, the default staff set, the granted approver, a requester without approve, a viewer without stock:adjust)');
select is(
  (select string_agg(i.sku || '=' || i.quantity_on_hand::int || '/' || coalesce((select sum(l.quantity)::int from public.item_stock_levels l where l.item_id = i.id), 0), ' ' order by i.sku)
     from public.inventory_items i where i.organization_id = :orgA and i.sku in ('0395-A', '0395-D0', '0395-DH', '0395-DQ', '0395-GONE', '0395-P')),
  '0395-A=100/100 0395-D0=0/0 0395-DH=0/2 0395-DQ=5/5 0395-GONE=3/3 0395-P=10/10',
  'F2: stock on record and holdings: the opening stock sits in Unplaced, DH holds 2 with nothing on record, D0 holds nothing');


-- Everything below must leave this unchanged (Z1): every attempt is undone.
create function pg_temp.state() returns text language sql stable as $$
  select (select md5(string_agg(o.id::text || o.status || coalesce(o.internal_notes, '') || o.warehouse_id::text
                                || coalesce(o.cancelled_at::text, '') || coalesce(o.signed_at::text, '')
                                || coalesce(o.pick_slip_generated_by::text, '') || coalesce(o.staged_by::text, ''), ',' order by o.id))
            from public.order_requests o where o.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.stock_movements m where m.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.stock_reservations r where r.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.notifications n where n.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select md5(string_agg(i.id::text || i.quantity_on_hand::text || coalesce(i.deleted_at::text, '') || i.name, ',' order by i.id))
                   from public.inventory_items i where i.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select coalesce(sum(l.quantity), 0)::text from public.item_stock_levels l where l.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
                  where o.organization_id = '03960000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.organization_members m where m.organization_id = '03960000-0000-0000-0000-00000000000a')
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ R. One change per body (generated by s2-tools/gen_0396_rsection.py) ══

select is(
  (select md5(p.prosrc) || '|' || md5(replace(replace(p.prosrc, $b0$
  -- S2 (N1): the person who placed the order cancels it only while it is
  -- pending approval. After that only someone who approves orders cancels
  -- it: an approved order holds stock, a picked one has drawn it and an
  -- order in transit is on the truck. The web service already refused this
  -- before calling here; now every caller gets the same answer.
  if not v_is_manager and v_req.status <> 'pending_approval' then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'requester_pending_only',
            detail  = 'Only a pending order can be cancelled by the person who placed it.';
  end if;
$b0$, ''), $b1$
  -- S2 (L115): link the restock movements this call just wrote to the
  -- order, as complete_picking links its own. adjust_stock takes no
  -- reference, so the rows are found by what only these restocks share:
  -- this organization, this transaction's time, a 'return' by this caller
  -- with no reference yet, and the reason that names this order. An order
  -- is cancelled once, so nothing else in the transaction matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'return'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Order cancelled (order_request ' || p_id::text || ')';
$b1$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.cancel_order_request(uuid, text)')),
  '535fc49935f15adc8d7dfa78836a06af|47cabcd1fe4f52fb7b2b6b6b64b68da1',
  'R1: cancel_order_request has 0395''s body (md5 535fc499), and removing the added text gives production''s body exactly (47cabcd1): the requester''s window (N1) and the restock link (L115) are the only changes');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
  -- S2 (L115): link the movements this call just wrote back to the order,
  -- as cancel_order_request and complete_picking link theirs: this
  -- organization, this transaction's time, a 'transfer' by this caller with
  -- no reference yet, and the reason that names this order. An order leaves
  -- picking_complete once per transaction, so nothing else matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'transfer'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Reopen picking (order_request ' || p_id::text || ')';
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.reopen_picking(uuid, text)')),
  '14e49293fa670dc2e05a1c1b6930bce5|293ce0e76d195bb13105cfd1c067de82',
  'R2: reopen_picking has 0395''s body (md5 14e49293), and removing the added text gives production''s body exactly (293ce0e7): the movement link (L115) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
          -- S2 (L129b): the driver must still be a member, with Orders on.
          or not public.is_org_member(v_req.organization_id)
          or not public.module_enabled(v_req.organization_id, 'orders')$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.confirm_physical_signature(uuid, text)')),
  'c0d1c11d31dd86e072f05b72f299535c|f7a14a46d2c70f635c3da844c786ce67',
  'R3: confirm_physical_signature has 0395''s body (md5 c0d1c11d), and removing the added text gives production''s body exactly (f7a14a46): the driver''s membership and module terms (L129b) are the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$        -- S2 (L86): approve_partial holds only what is free, which may be
        -- nothing. Say so when any item is held for less than the order
        -- still owes for it, and say nothing is held when no hold is.
        if exists (
          select 1
            from public.order_request_lines l
           where l.order_request_id = new.id
           group by l.item_id
          having sum(greatest(coalesce(l.quantity_requested, 0) - coalesce(l.quantity_fulfilled, 0), 0))
                 > coalesce((select sum(r.quantity)
                               from public.stock_reservations r
                              where r.order_request_id = new.id
                                and r.item_id = l.item_id
                                and r.released_at is null), 0)
        ) then
          if exists (select 1
                       from public.stock_reservations r
                      where r.order_request_id = new.id
                        and r.released_at is null
                        and r.quantity > 0) then
            v_body := 'Part of your order is held; the rest is waiting for stock.';
          else
            v_body := 'Nothing is held yet; your order is waiting for stock.';
          end if;
        end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public._notify_order_request_changes()')),
  '8d9de81d81de84af3e2589e6044506bf|a223ae83810149728156b8e299c7425e',
  'R4: _notify_order_request_changes has 0395''s body (md5 8d9de81d), and removing the added text gives production''s body exactly (a223ae83): the partial-approval sentence (L86) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.inventory_items x
                  where x.id = p_item_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Adjusting stock needs the stock:adjust permission.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.adjust_stock(uuid, numeric, text, uuid, text, text, text)')),
  '329b71a0add8df3e1a13bdd609e7e652|c8cdaf566ec1ed69b8e9ae56791822da',
  'R5: adjust_stock has 0395''s body (md5 329b71a0), and removing the added text gives production''s body exactly (c8cdaf56): the stock:adjust gate (L8) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:transfer). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.inventory_items x
                  where x.id = p_item_id
                    and not public.has_permission(x.organization_id, 'stock:transfer')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Moving stock needs the stock:transfer permission.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.transfer_stock(uuid, uuid, uuid, numeric, text)')),
  'a95dbf8d8fc9e0450aa5a2d733197843|849690c9313d2d8abfc70eb2b3120d90',
  'R6: transfer_stock has 0395''s body (md5 a95dbf8d), and removing the added text gives production''s body exactly (849690c9): the stock:transfer gate (L8) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.cycle_counts x
                  where x.id = p_cycle_count_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Posting a count needs the stock:adjust permission.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.post_cycle_count(uuid)')),
  'b6b00e4d720aad8032a76ec122c4612c|ecc566f4079270480df1d9504358ea73',
  'R7: post_cycle_count has 0395''s body (md5 b6b00e4d), and removing the added text gives production''s body exactly (ecc566f4): the stock:adjust gate (L8) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (bundles:manage). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.bundles x
                  where x.id = p_bundle_id
                    and not public.has_permission(x.organization_id, 'bundles:manage')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Assembling a kit needs the bundles:manage permission.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.assemble_bundle(uuid, numeric, uuid, text)')),
  'bcc4fbe7461ba3c02b5e0c2d18988fcf|7b3f769cb33ef6767557e0b9c4377ddb',
  'R8: assemble_bundle has 0395''s body (md5 bcc4fbe7), and removing the added text gives production''s body exactly (7b3f769c): the bundles:manage gate (L8) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.purchase_orders x
                  where x.id = p_purchase_order_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Posting a receipt needs the stock:adjust permission.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)')),
  '15f5db367d297a58acc1065bae4ffe69|efc01e2e0ea98531c92c7db27f17695c',
  'R9: post_receipt_v2 has 0395''s body (md5 15f5db36), and removing the added text gives production''s body exactly (efc01e2e): the stock:adjust gate (L8) is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.receipts x
                  where x.id = p_receipt_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Reversing a receipt needs the stock:adjust permission.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.reverse_receipt(uuid, text)')),
  'f2f13dc2951ad3a5de4aaf034487cac9|e277d737103a5cb561860c229f6631e7',
  'R10: reverse_receipt has 0395''s body (md5 f2f13dc2), and removing the added text gives production''s body exactly (e277d737): the stock:adjust gate (L8) is the only change');

select is(
  (select string_agg(d.fn || '=' || d.m, E'\n' order by d.fn collate "C") from (
  select 'cancel_order_request' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(replace(pg_get_functiondef(p.oid), $b0$
  -- S2 (N1): the person who placed the order cancels it only while it is
  -- pending approval. After that only someone who approves orders cancels
  -- it: an approved order holds stock, a picked one has drawn it and an
  -- order in transit is on the truck. The web service already refused this
  -- before calling here; now every caller gets the same answer.
  if not v_is_manager and v_req.status <> 'pending_approval' then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'requester_pending_only',
            detail  = 'Only a pending order can be cancelled by the person who placed it.';
  end if;
$b0$, ''), $b1$
  -- S2 (L115): link the restock movements this call just wrote to the
  -- order, as complete_picking links its own. adjust_stock takes no
  -- reference, so the rows are found by what only these restocks share:
  -- this organization, this transaction's time, a 'return' by this caller
  -- with no reference yet, and the reason that names this order. An order
  -- is cancelled once, so nothing else in the transaction matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'return'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Order cancelled (order_request ' || p_id::text || ')';
$b1$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.cancel_order_request(uuid, text)')
  union all
  select 'reopen_picking' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$
  -- S2 (L115): link the movements this call just wrote back to the order,
  -- as cancel_order_request and complete_picking link theirs: this
  -- organization, this transaction's time, a 'transfer' by this caller with
  -- no reference yet, and the reason that names this order. An order leaves
  -- picking_complete once per transaction, so nothing else matches.
  update public.stock_movements
     set reference_type = 'order_request',
         reference_id   = p_id
   where organization_id = v_req.organization_id
     and created_at      = now()
     and movement_type   = 'transfer'
     and user_id         = v_user
     and reference_type is null
     and reason          = 'Reopen picking (order_request ' || p_id::text || ')';
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.reopen_picking(uuid, text)')
  union all
  select 'confirm_physical_signature' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$
          -- S2 (L129b): the driver must still be a member, with Orders on.
          or not public.is_org_member(v_req.organization_id)
          or not public.module_enabled(v_req.organization_id, 'orders')$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.confirm_physical_signature(uuid, text)')
  union all
  select '_notify_order_request_changes' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$        -- S2 (L86): approve_partial holds only what is free, which may be
        -- nothing. Say so when any item is held for less than the order
        -- still owes for it, and say nothing is held when no hold is.
        if exists (
          select 1
            from public.order_request_lines l
           where l.order_request_id = new.id
           group by l.item_id
          having sum(greatest(coalesce(l.quantity_requested, 0) - coalesce(l.quantity_fulfilled, 0), 0))
                 > coalesce((select sum(r.quantity)
                               from public.stock_reservations r
                              where r.order_request_id = new.id
                                and r.item_id = l.item_id
                                and r.released_at is null), 0)
        ) then
          if exists (select 1
                       from public.stock_reservations r
                      where r.order_request_id = new.id
                        and r.released_at is null
                        and r.quantity > 0) then
            v_body := 'Part of your order is held; the rest is waiting for stock.';
          else
            v_body := 'Nothing is held yet; your order is waiting for stock.';
          end if;
        end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public._notify_order_request_changes()')
  union all
  select 'adjust_stock' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.inventory_items x
                  where x.id = p_item_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Adjusting stock needs the stock:adjust permission.';
  end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.adjust_stock(uuid, numeric, text, uuid, text, text, text)')
  union all
  select 'transfer_stock' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:transfer). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.inventory_items x
                  where x.id = p_item_id
                    and not public.has_permission(x.organization_id, 'stock:transfer')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Moving stock needs the stock:transfer permission.';
  end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.transfer_stock(uuid, uuid, uuid, numeric, text)')
  union all
  select 'post_cycle_count' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.cycle_counts x
                  where x.id = p_cycle_count_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Posting a count needs the stock:adjust permission.';
  end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.post_cycle_count(uuid)')
  union all
  select 'assemble_bundle' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (bundles:manage). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.bundles x
                  where x.id = p_bundle_id
                    and not public.has_permission(x.organization_id, 'bundles:manage')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Assembling a kit needs the bundles:manage permission.';
  end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.assemble_bundle(uuid, numeric, uuid, text)')
  union all
  select 'post_receipt_v2' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.purchase_orders x
                  where x.id = p_purchase_order_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Posting a receipt needs the stock:adjust permission.';
  end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)')
  union all
  select 'reverse_receipt' as fn, md5(pg_get_functiondef(p.oid)) || '|' || md5(replace(pg_get_functiondef(p.oid), $b0$  -- S2 (L8): a direct call answers to the permission the app checks
  -- first (stock:adjust). Only an API role's own call is held here: a call
  -- made inside another ledger call of this transaction was answered by
  -- that call, and the order functions run as postgres. A row the caller
  -- cannot read is left to the body, which refuses it as before.
  if current_user in ('authenticated', 'anon')
     and not ledger.active()
     and exists (select 1
                   from public.receipts x
                  where x.id = p_receipt_id
                    and not public.has_permission(x.organization_id, 'stock:adjust')) then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'permission',
            detail  = 'Reversing a receipt needs the stock:adjust permission.';
  end if;
$b0$, '')) as m
    from pg_proc p where p.oid = to_regprocedure('public.reverse_receipt(uuid, text)')) d),
  E'_notify_order_request_changes=7dac8b4627df955f9aeb83d8caee0459|ff18125ea9142821da9c1a0d2b07c1da\n'
  'adjust_stock=0dbc639017c2f827e2c7a18e5486d975|8f2b54ee153cb1dd8cfccce7ab462b62\n'
  'assemble_bundle=c3e186436c7848163beafe5e85b062c8|9c725f9d2aac44bcd38889450056d67a\n'
  'cancel_order_request=6a21252e51fff929fc18573e60b51324|112ba9976a11269694b161bc55d41562\n'
  'confirm_physical_signature=0ce2f35c507bef9e53f58ada6590993d|76899ffd767f579d61cfd2a6fccd1fb7\n'
  'post_cycle_count=40528d9207c8fe353b04d48bc0284acb|d2eee4d6216069731f965e9d2853c832\n'
  'post_receipt_v2=822851e86940eda3a9ad627cc53b3bcc|d40d3757f56f552c361acfbac0232c9b\n'
  'reopen_picking=d5d629e4134fd7581280a1bd05cbcef9|aba2579ec63fcd5400abae9cf5591ac2\n'
  'reverse_receipt=774eb447eaf4d8340522f159295a9377|4c049069d229b92b9b121d723cff081e\n'
  'transfer_stock=6a21d824bb893511cf72d192acb6043a|6231a20a470cd1991d32de9effe472c8',
  'R11: for each of the ten, the whole definition (pg_get_functiondef) is 0395''s, and removing the added text gives production''s definition exactly: arguments and defaults, result, volatility, SECURITY mode and SET clauses are unchanged, not only the body');


-- ══ P. The ten keep their posture; the comments say what 0395 enforces ════
select is(
  (select string_agg(p.proname || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|'
                     || pg_get_userbyid(p.proowner) || '|'
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('service_role', p.oid, 'EXECUTE')::text, E'\n' order by p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('_notify_order_request_changes', 'adjust_stock', 'assemble_bundle', 'cancel_order_request',
                        'confirm_physical_signature', 'post_cycle_count', 'post_receipt_v2', 'reopen_picking',
                        'reverse_receipt', 'transfer_stock')),
  E'_notify_order_request_changes|true|{search_path=public}|postgres|false|false|true\n'
  'adjust_stock|false|{search_path=public}|postgres|true|false|true\n'
  'assemble_bundle|false|{search_path=public}|postgres|true|false|true\n'
  'cancel_order_request|true|{"search_path=public, extensions"}|postgres|true|false|true\n'
  'confirm_physical_signature|true|{search_path=public}|postgres|true|false|true\n'
  'post_cycle_count|false|{search_path=public}|postgres|true|false|true\n'
  'post_receipt_v2|false|{search_path=public}|postgres|true|false|true\n'
  'reopen_picking|true|{"search_path=public, extensions"}|postgres|true|false|true\n'
  'reverse_receipt|false|{search_path=public}|postgres|true|false|true\n'
  'transfer_stock|false|{search_path=public}|postgres|true|false|true',
  'P1: the ten keep their SECURITY mode, SET clauses, owner and who may EXECUTE them (production''s ACLs, read 2026-10-05: the wrappers stay INVOKER, so row level security still applies to the bodies they call)');
-- Keyed on the words each comment must carry, not on the migration's number,
-- so the push-time renumber cannot break it.
select is(
  (select string_agg(p.proname || '=' || (position(e.says in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0)::text,
                     ', ' order by p.proname collate "C")
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join (values ('adjust_stock', 'needs stock:adjust (42501 forbidden, hint permission)'),
                  ('assemble_bundle', 'needs bundles:manage (42501 forbidden, hint permission)'),
                  ('cancel_order_request', 'only while it is pending approval (42501 forbidden, hint requester_pending_only)'),
                  ('confirm_physical_signature', 'while they are still a member of the order''s organization and the Orders module is on'),
                  ('post_cycle_count', 'needs stock:adjust (42501 forbidden, hint permission)'),
                  ('post_receipt_v2', 'needs stock:adjust (42501 forbidden, hint permission)'),
                  ('reopen_picking', 'its movements carry reference_type order_request and the order id'),
                  ('reverse_receipt', 'needs stock:adjust (42501 forbidden, hint permission)'),
                  ('tg_inventory_items_no_delete_with_stock', '(23514, hint item_holds_stock)'),
                  ('transfer_stock', 'needs stock:transfer (42501 forbidden, hint permission)')) e(fn, says)
       on e.fn = p.proname
    where n.nspname = 'public'),
  'adjust_stock=true, assemble_bundle=true, cancel_order_request=true, confirm_physical_signature=true, '
  'post_cycle_count=true, post_receipt_v2=true, reopen_picking=true, reverse_receipt=true, '
  'tg_inventory_items_no_delete_with_stock=true, transfer_stock=true',
  'P2: each function the slice changes or adds says in its comment what it now enforces, in the words of the rule (not the migration number)');

-- ══ N. N1: the requester cancels only while the order is pending ══════════
select is(
  pg_temp.over('req', array[:oPend, :oAppr, :oPSG, :oPIP, :oPC, :oPack, :oStgP, :oStgD, :oTrans, :oBack]::uuid[],
               $q$select public.cancel_order_request(%L, 'Changed my mind')$q$),
  'ok:1, 42501:requester_pending_only:forbidden, 42501:requester_pending_only:forbidden, '
  '42501:requester_pending_only:forbidden, 42501:requester_pending_only:forbidden, '
  '42501:requester_pending_only:forbidden, 42501:requester_pending_only:forbidden, '
  '42501:requester_pending_only:forbidden, 42501:requester_pending_only:forbidden, '
  '42501:requester_pending_only:forbidden',
  'N1: the person who placed the order cancels it at pending approval, and is refused (42501, hint requester_pending_only) at approved, pick slip, picking, picked, packed, staged for pickup, staged for delivery, in transit and backordered');
select is(
  pg_temp.over('mgr', array[:oPend, :oAppr, :oPSG, :oPIP, :oPC, :oPack, :oStgP, :oStgD, :oTrans, :oBack]::uuid[],
               $q$select public.cancel_order_request(%L, 'Not needed')$q$),
  'ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1',
  'N2: a manager (orders:approve by role) still cancels at every open status');
select is(
  pg_temp.over('stfAp', array[:oPend, :oAppr, :oPSG, :oPIP, :oPC, :oPack, :oStgP, :oStgD, :oTrans, :oBack]::uuid[],
               $q$select public.cancel_order_request(%L, 'Not needed')$q$),
  'ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1, ok:1',
  'N3: a staff member granted orders:approve cancels at every open status too (the rule follows the permission, as since 0390)');
select is(
  pg_temp.attempt('authenticated', :stf, format($q$select public.cancel_order_request(%L, 'Not mine')$q$, :oPend)),
  '42501:-:forbidden',
  'N4: someone who neither placed the order nor approves orders is refused as before (42501 forbidden, no hint)');

-- ══ L. L115: the movements a cancel and a reopen write carry the order ═════
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$select public.cancel_order_request(%L, 'Not needed')$q$, :oPC),
    format($q$insert into public.stock_movements (organization_id, item_id, movement_type, quantity_change, previous_quantity, new_quantity, user_id, reason)
              values (%L, %L, 'return', 1, 100, 101, %L, 'Order cancelled (order_request ' || %L || ')')$q$, :orgA, :itA, :mgr, :oAppr),
    format($q$select (select count(*) from public.stock_movements m
                       where m.item_id = %L and m.movement_type = 'return' and m.quantity_change = 2
                         and m.reason = 'Order cancelled (order_request ' || %L || ')'
                         and m.reference_type = 'order_request' and m.reference_id = %L)::text
              || '/' || (select count(*) from public.stock_movements m
                          where m.reason = 'Order cancelled (order_request ' || %L || ')' and m.reference_type is null)::text$q$,
           :itA, :oPC, :oPC, :oAppr)),
  'ok:1:1/1',
  'L1: a drawn cancel restocks its 2 units and that movement carries reference_type order_request and the order''s id; a movement of the same transaction, item, type and caller naming another order stays unlinked');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPC2), null,
    format($q$select count(*)::text from public.stock_movements m
               where m.item_id = %L and m.movement_type = 'transfer' and m.quantity_change = 2
                 and m.reason = 'Reopen picking (order_request ' || %L || ')'
                 and m.reference_type = 'order_request' and m.reference_id = %L$q$, :itA, :oPC2, :oPC2)),
  'ok:1:1',
  'L2: a reopen''s movement back into Unplaced carries reference_type order_request and the order''s id');

-- ══ K. L8: a direct ledger call answers to the permission ══════════════════
select is(
  pg_temp.attempt('authenticated', :stfNo, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA')) || ' / '
  || pg_temp.attempt('authenticated', :stfNo, format('select public.transfer_stock(%L, %L, %L, 1)', :itA, :'locA', :'locS')),
  '42501:permission:forbidden / 42501:permission:forbidden',
  'K1: staff whose stock:adjust and stock:transfer are revoked can no longer adjust or move stock by calling the function directly (42501, hint permission), as the app already refused them');
select is(
  pg_temp.attempt('authenticated', :stf, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA')) || ' / '
  || pg_temp.attempt('authenticated', :stf, format('select public.transfer_stock(%L, %L, %L, 1)', :itA, :'locA', :'locS')) || ' / '
  || pg_temp.attempt('authenticated', :vwr, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA')),
  'ok:1 / ok:1 / 42501:permission:forbidden',
  'K2: staff with the default set still adjust and move stock directly; a viewer (no stock:adjust) is refused, now naming the permission');
select is(
  pg_temp.attempt('authenticated', :mgrNo, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA')) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo, format('select public.transfer_stock(%L, %L, %L, 1)', :itA, :'locA', :'locS')) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo, format('select public.post_cycle_count(%L)', :ccA)) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo, format($q$select public.post_receipt_v2(%L, %L, '[]'::jsonb, 'key-0395', 'hash-0395')$q$, :poA, :whA)) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo, format($q$select public.reverse_receipt(%L, 'Wrong count')$q$, :rcA)) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo, format('select * from public.assemble_bundle(%L, 1, %L)', :bnA, :whA)),
  '42501:permission:forbidden / 42501:permission:forbidden / 42501:permission:forbidden / '
  '42501:permission:forbidden / 42501:permission:forbidden / 42501:permission:forbidden',
  'K3: a manager whose stock:adjust, stock:transfer and bundles:manage are revoked is refused by each wrapper (adjust, transfer, count post, receipt post, receipt reversal, kit assembly) before its body runs');
select is(
  (select string_agg((position(':permission:' in v.r) = 0)::text, ',' order by v.n) from (values
     (1, pg_temp.attempt('authenticated', :mgr, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA'))),
     (2, pg_temp.attempt('authenticated', :mgr, format('select public.transfer_stock(%L, %L, %L, 1)', :itA, :'locA', :'locS'))),
     (3, pg_temp.attempt('authenticated', :mgr, format('select public.post_cycle_count(%L)', :ccA))),
     (4, pg_temp.attempt('authenticated', :mgr, format($q$select public.post_receipt_v2(%L, %L, '[]'::jsonb, 'key-0395', 'hash-0395')$q$, :poA, :whA))),
     (5, pg_temp.attempt('authenticated', :mgr, format($q$select public.reverse_receipt(%L, 'Wrong count')$q$, :rcA))),
     (6, pg_temp.attempt('authenticated', :mgr, format('select * from public.assemble_bundle(%L, 1, %L)', :bnA, :whA)))) v(n, r)),
  'true,true,true,true,true,true',
  'K4: the same six calls by a manager holding the permissions pass the gate and get their body''s own answer');
select is(
  pg_temp.attempt('authenticated', :stfNo, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 nested probe')$q$, :itA, :'locA'),
                  $p$select set_config('stockpilot.ledger', pg_current_xact_id()::text, true)$p$),
  'ok:1',
  'K5: inside another ledger call of the same transaction (the flag holds this transaction''s id, as post_receipt_v2 and reverse_receipt leave it when they call adjust_stock) the gate is not asked again');
select is(
  pg_temp.attempt('service_role', :stfNo, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA')),
  'ok:1',
  'K6: the admin client (service_role) is not held, even carrying the claims of someone whose stock:adjust is revoked');
select is(
  pg_temp.attempt('authenticated', :mgrNo, format($q$select public.cancel_order_request(%L, 'Not needed')$q$, :oPC), null,
    format($q$select count(*)::text from public.stock_movements where item_id = %L and movement_type = 'return' and reference_id = %L$q$, :itA, :oPC)) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo, format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPC2), null,
    format($q$select count(*)::text from public.stock_movements where item_id = %L and movement_type = 'transfer' and reference_id = %L$q$, :itA, :oPC2)) || ' / '
  || pg_temp.attempt('authenticated', :stfNo, format('select public.complete_picking(%L)', :oPS), null,
    format($q$select count(*)::text from public.stock_movements where item_id = %L and movement_type = 'transfer' and reference_id = %L$q$, :itA, :oPS)),
  'ok:1:1 / ok:1:1 / ok:1:1',
  'K7: the order functions still move stock for members whose stock:adjust is revoked (cancel and reopen by the revoked manager, complete_picking by the revoked staff member): they run as postgres, and each movement carries its order');
select is(
  pg_temp.attempt('authenticated', :outZ, format($q$select public.adjust_stock(%L, 1, 'add', %L, '0395 probe')$q$, :itA, :'locA')),
  'P0002:-:item_not_found',
  'K8: a row the caller cannot read is left to the body, which answers as before (another organization''s manager: item_not_found)');

-- ══ D. L15: an item that holds stock is never soft-deleted ══════════════════
select is(
  pg_temp.attempt('service_role', null, format('update public.inventory_items set deleted_at = now() where id = %L', :itDQ)),
  '23514:item_holds_stock:item_holds_stock',
  'D1: the admin client (the daily auto-delete) cannot soft-delete an item with stock on record (23514, hint item_holds_stock)');
select is(
  pg_temp.attempt('service_role', null, format('update public.inventory_items set deleted_at = now() where id = %L', :itDH)),
  '23514:item_holds_stock:item_holds_stock',
  'D2: nor one with nothing on record but a holding on a location');
select is(
  pg_temp.attempt('service_role', null, format('update public.inventory_items set deleted_at = now() where id = %L', :itD0)),
  'ok:1',
  'D3: an item that holds nothing is soft-deleted as before');
select is(
  pg_temp.attempt('service_role', null, format($q$update public.inventory_items set name = 'Deleted, renamed' where id = %L$q$, :itGone)) || ' / '
  || pg_temp.attempt('service_role', null, format($q$update public.inventory_items set deleted_at = deleted_at - interval '1 day' where id = %L$q$, :itGone)) || ' / '
  || pg_temp.attempt('service_role', null, format('update public.inventory_items set deleted_at = null where id = %L', :itGone)),
  'ok:1 / ok:1 / ok:1',
  'D4: an item already deleted with stock on record (the 11 left as history) still takes other updates, a new deletion time and an undelete');
select is(
  pg_temp.attempt('authenticated', :adm, format('update public.inventory_items set deleted_at = now() where id = %L', :itDQ)),
  '23514:item_holds_stock:item_holds_stock',
  'D5: an admin''s raw update through the user client is refused the same way');
select throws_ok(
  format('update public.inventory_items set deleted_at = now() where id = %L', :itDQ),
  '23514', 'item_holds_stock',
  'D6: so is postgres (the order functions, migrations): the guard holds every role');
select is(
  (select p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
          || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
     from pg_proc p where p.oid = to_regprocedure('public.tg_inventory_items_no_delete_with_stock()'))
  || ' / '
  || (select t.tgenabled::text || '|' || pg_get_triggerdef(t.oid)
        from pg_trigger t
       where t.tgrelid = 'public.inventory_items'::regclass and t.tgname = 'trg_zz_inventory_items_no_delete_with_stock'),
  -- The trigger's text is predicted from pg_get_triggerdef's shape; verify on the stack.
  'true|{"search_path=public, pg_temp"}|postgres|false|false|false|false / '
  'O|CREATE TRIGGER trg_zz_inventory_items_no_delete_with_stock BEFORE UPDATE OF deleted_at ON public.inventory_items '
  'FOR EACH ROW WHEN (((old.deleted_at IS NULL) AND (new.deleted_at IS NOT NULL))) '
  'EXECUTE FUNCTION tg_inventory_items_no_delete_with_stock()',
  'D7: the guard is SECURITY DEFINER (it counts holdings the caller cannot see) with search_path pinned, owned by postgres, executable by no API role, and fires BEFORE UPDATE OF deleted_at only when deleted_at goes from null to a value');

-- ══ W. L129a: order_requests_update follows the order's warehouse ═════════
select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'denied', denied_reason = 'Out of season' where id = %L and status = 'pending_approval'$q$, :oBPend)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = now(), pick_slip_generated_by = %L where id = %L and status = 'approved'$q$, :stfAp, :oBAppr)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'staged_for_pickup', staged_at = now(), staged_by = %L where id = %L and status = 'packing_slip_generated'$q$, :stfAp, :oBPack)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'staged_for_delivery', staged_at = now(), staged_by = %L where id = %L and status = 'packing_slip_generated'$q$, :stfAp, :oBPackD)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set internal_notes = 'Gate code 12' where id = %L$q$, :oBAppr)),
  'ok:0 / ok:0 / ok:0 / ok:0 / ok:0',
  'W1: a staff approver assigned to warehouse A matches 0 rows on another warehouse''s order: deny, pick slip, staging for pickup, staging for delivery and the notes');
select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'denied', denied_reason = 'Out of season' where id = %L and status = 'pending_approval'$q$, :oPend)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'pick_slip_generated', pick_slip_generated_at = now(), pick_slip_generated_by = %L where id = %L and status = 'approved'$q$, :stfAp, :oAppr)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'staged_for_pickup', staged_at = now(), staged_by = %L where id = %L and status = 'packing_slip_generated'$q$, :stfAp, :oAPack)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set status = 'staged_for_delivery', staged_at = now(), staged_by = %L where id = %L and status = 'packing_slip_generated'$q$, :stfAp, :oAPackD)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format($q$update public.order_requests set internal_notes = 'Gate code 12' where id = %L$q$, :oAppr)),
  'ok:1 / ok:1 / ok:1 / ok:1 / ok:1',
  'W2: the same five writes on an order of their own warehouse still go through');
select is(
  pg_temp.each(array['stfAp', 'mgr', 'adm', 'own', 'stf', 'vwr'],
               format($q$update public.order_requests set internal_notes = 'Gate code 12' where id = %L$q$, :oBAppr)),
  'stfAp=ok:0, mgr=ok:1, adm=ok:1, own=ok:1, stf=ok:0, vwr=ok:0',
  'W3: persona parity with the app''s write access: a manager with no assignment, the admin and the owner reach every warehouse (through user_can_access_warehouse alone, as the app''s roleSeesEveryWarehouse); staff without orders:approve and the viewer match nothing, as before');
select is(
  pg_temp.attempt('authenticated', :stfAp, format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :oAMove)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set warehouse_id = %L where id = %L', :whB, :oAMove)),
  '42501:-:new row violates row-level security policy for table "order_requests" / ok:1',
  'W4: WITH CHECK: the scoped approver cannot move their order into a warehouse they cannot write; a manager still can (0392 G16''s pinned behaviour)');

-- ══ S. L129b: a paper signature by the driver needs a member, Orders on ════
select is(
  pg_temp.attempt('authenticated', :drv, format($q$select public.confirm_physical_signature(%L, 'Pat Doe')$q$, :oTrans)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format($q$select public.confirm_physical_signature(%L, 'Pat Doe')$q$, :oTrans)),
  'ok:1 / ok:1',
  'S1: the assigned driver and a manager record the paper signature');
select is(
  pg_temp.attempt('authenticated', :drv, format($q$select public.confirm_physical_signature(%L, 'Pat Doe')$q$, :oTrans),
                  format('delete from public.organization_members where organization_id = %L and user_id = %L', :orgA, :drv)),
  '42501:-:forbidden',
  'S2: a driver removed from the organization after the assignment is refused');
select is(
  pg_temp.attempt('authenticated', :drv, format($q$select public.confirm_physical_signature(%L, 'Pat Doe')$q$, :oTrans),
                  format('update public.user_profiles set disabled_at = now() where id = %L', :drv)),
  '42501:-:forbidden',
  'S3: so is a disabled driver (is_org_member counts the member as the rest of the order functions do)');
select is(
  pg_temp.attempt('authenticated', :drv, format($q$select public.confirm_physical_signature(%L, 'Pat Doe')$q$, :oTrans),
                  format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format($q$select public.confirm_physical_signature(%L, 'Pat Doe')$q$, :oTrans),
                  format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA)),
  '42501:-:forbidden / ok:1',
  'S4: with the Orders module off the driver is refused; the manager branch is unchanged');

-- ══ B. L11: an order line never takes a kit ════════════════════════════════
select is(
  pg_temp.attempt('authenticated', :req, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oLines, :itKit)) || ' / '
  || pg_temp.attempt('authenticated', :stfAp, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oLines, :itKit)),
  '42501:-:new row violates row-level security policy for table "order_request_lines" / '
  '42501:-:new row violates row-level security policy for table "order_request_lines"',
  'B1: a kit line is refused on the requester''s own client and on an approver''s (row level security)');
select is(
  pg_temp.attempt('authenticated', :req, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oLines, :itA)),
  'ok:1',
  'B2: a normal line still goes in');

-- ══ A. L86: the approved notification says what is held ═══════════════════
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.approve_order_request(%L)', :oN1), null,
    format($q$select n.body from public.notifications n where n.user_id = %L and n.type = 'order_request.approved' and n.metadata->>'order_request_id' = %L$q$, :req, :oN1)),
  'ok:1:Stock has been reserved.',
  'A1: a full approval keeps "Stock has been reserved."');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.approve_partial(%L)', :oN2), null,
    format($q$select n.body from public.notifications n where n.user_id = %L and n.type = 'order_request.approved' and n.metadata->>'order_request_id' = %L$q$, :req, :oN2)),
  'ok:1:Part of your order is held; the rest is waiting for stock.',
  'A2: a partial approval (30 asked, 10 free) says only part is held');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.approve_partial(%L)', :oN3), null,
    format($q$select n.body from public.notifications n where n.user_id = %L and n.type = 'order_request.approved' and n.metadata->>'order_request_id' = %L$q$, :req, :oN3)),
  'ok:1:Stock has been reserved.',
  'A3: approve_partial that could hold everything (4 asked, 10 free) keeps "Stock has been reserved."');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.approve_partial(%L)', :oN4), null,
    format($q$select n.body from public.notifications n where n.user_id = %L and n.type = 'order_request.approved' and n.metadata->>'order_request_id' = %L$q$, :req, :oN4)),
  'ok:1:Part of your order is held; the rest is waiting for stock.',
  'A4: two lines of one item (6 and 6 of 10 free: held 6 and 4) are compared per item, not per line, and say only part is held');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.approve_partial(%L)', :oN5), null,
    format($q$select n.body || '|' || (select count(*) from public.stock_reservations r
                                          where r.order_request_id = %L and r.released_at is null)::text
                from public.notifications n
               where n.user_id = %L and n.type = 'order_request.approved' and n.metadata->>'order_request_id' = %L$q$, :oN5, :req, :oN5)),
  'ok:1:Nothing is held yet; your order is waiting for stock.|0',
  'A5: approve_partial with nothing free (5 asked, 0 on record) still approves, holds nothing, and says nothing is held yet instead of "part"');

-- ══ H. The two policies' text ═════════════════════════════════════════════
-- Predicted from production's text (read 2026-10-05) plus the added term in
-- the deparsed shape the other terms have; verify on the stack.
select is(
  (select coalesce(qual, '') || E'\n' || coalesce(with_check, '')
     from pg_policies where schemaname = 'public' and tablename = 'order_requests' and policyname = 'order_requests_update'),
  '(' || $p$( SELECT has_permission(order_requests.organization_id, 'orders:approve'::text) AS has_permission)$p$
  || ' AND ' || $t$( SELECT user_can_access_warehouse(( SELECT auth.uid() AS uid), order_requests.warehouse_id, 'write'::text) AS user_can_access_warehouse)$t$
  || ')' || E'\n'
  || left($w$(( SELECT has_permission(order_requests.organization_id, 'orders:approve'::text) AS has_permission) AND ( SELECT warehouse_in_org(order_requests.warehouse_id, order_requests.organization_id) AS warehouse_in_org) AND ( SELECT charter_in_org(order_requests.delivery_charter_id, order_requests.organization_id) AS charter_in_org))$w$, -1)
  || ' AND ' || $t$( SELECT user_can_access_warehouse(( SELECT auth.uid() AS uid), order_requests.warehouse_id, 'write'::text) AS user_can_access_warehouse)$t$
  || ')',
  'H1: order_requests_update is production''s text (USING and WITH CHECK) with the warehouse term added and nothing else');
select is(
  (select coalesce(with_check, '')
     from pg_policies where schemaname = 'public' and tablename = 'order_request_lines' and policyname = 'order_request_lines_insert'),
  replace($p$(EXISTS ( SELECT 1
   FROM (order_requests r
     JOIN inventory_items ii ON (((ii.id = order_request_lines.item_id) AND (ii.organization_id = r.organization_id))))
  WHERE ((r.id = order_request_lines.order_request_id) AND ((r.requester_user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT has_permission(r.organization_id, 'orders:approve'::text) AS has_permission)) AND (ii.warehouse_id = r.warehouse_id) AND (r.status <> ALL (ARRAY['in_transit'::text, 'completed'::text, 'denied'::text, 'cancelled'::text])))))$p$,
          $a$'cancelled'::text])))))$a$, $a$'cancelled'::text])) AND (NOT COALESCE(ii.is_bundle, false)))))$a$),
  'H2: order_request_lines_insert is production''s text with the kit term added and nothing else');
select is(
  (select string_agg(tablename || '.' || policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                     || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')), E'\n' order by tablename, policyname)
     from pg_policies
    where schemaname = 'public' and policyname in ('order_requests_update', 'order_request_lines_insert')),
  E'order_request_lines.order_request_lines_insert|INSERT|{authenticated}|PERMISSIVE|1148ba4defc9bcae9e744bd8a04dd82c\n'
  'order_requests.order_requests_update|UPDATE|{authenticated}|PERMISSIVE|be9f2fbb6ee66d910763de1815365cdd',
  'H3: both policies are still PERMISSIVE, for authenticated, with 0395''s text (pg_policies md5, the 0390 H3 form)');
select is(
  (select coalesce(string_agg(tablename || '.' || policyname, ',' order by tablename, policyname), '')
     from pg_policies
    where schemaname = 'public'
      and coalesce(qual, '') || coalesce(with_check, '') ~ 'orders:approve'
      and coalesce(qual, '') || coalesce(with_check, '') ~ 'has_org_role'),
  '',
  'H4: the warehouse term adds no manager-by-role arm: no policy in public names has_org_role together with orders:approve (0390 H2''s census; user_can_access_warehouse already gives an owner, admin or manager every warehouse)');

-- ══ G. Never a retryable error ════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '=' || (p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected')::text, ', ' order by p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('_notify_order_request_changes', 'adjust_stock', 'assemble_bundle', 'cancel_order_request',
                        'confirm_physical_signature', 'post_cycle_count', 'post_receipt_v2', 'reopen_picking',
                        'reverse_receipt', 'tg_inventory_items_no_delete_with_stock', 'transfer_stock')),
  '_notify_order_request_changes=false, adjust_stock=false, assemble_bundle=false, cancel_order_request=false, '
  'confirm_physical_signature=false, post_cycle_count=false, post_receipt_v2=false, reopen_picking=false, '
  'reverse_receipt=false, tg_inventory_items_no_delete_with_stock=false, transfer_stock=false',
  'G1: none of the eleven names 40001 or 40P01 (PostgREST retries those forever)');

-- ══ Z. Every undone attempt changed nothing ═══════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the undone attempts left every order, line, hold, movement, notification, item, holding and membership as it was');

select * from finish();
rollback;
