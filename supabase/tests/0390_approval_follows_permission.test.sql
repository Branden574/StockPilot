-- supabase/tests/0390_approval_follows_permission.test.sql
-- pgTAP proof for migration 0390 (security slice D): approving an order, and
-- every other action the approve permission allows, follows the effective
-- orders:approve permission in the database, with no manager-by-role
-- exception.
--
-- Personas (one org, plus a second org for foreign checks):
--   own     owner                     mgr     manager, no override
--   mgrNo   manager, orders:approve revoked (user override false)
--   mgrNoAD manager, orders:assign_delivery revoked
--   stfAp   staff granted orders:approve and orders:assign_delivery,
--           assigned to the warehouse
--   stfAD   staff granted orders:assign_delivery, assigned to the warehouse
--   stfNoWh staff granted both, assigned to no warehouse (no write access)
--   stf     staff, no grant, assigned (also the staff delivery driver)
--   req     staff, the requester of the fixture orders
--   vwr     viewer, assigned            pend   an invited, not accepted member
--   outZ    a manager of another organization
--
-- R.  Exactly one edit per body: md5(prosrc) is 0390's, and putting the role
--     term back gives production's pre-0390 body exactly (R1-R10); the same
--     on the whole definition (pg_get_functiondef), so the header did not
--     change either (R11).
-- P.  Posture of the ten unchanged (DEFINER, SET clauses, owner, EXECUTE),
--     the three function comments that described the old rule now say what
--     0390 enforces, and the header attributes spelled out (P3: volatility,
--     strictness, cost, rows, parallel, leakproof, arguments with defaults,
--     result).
-- C.  Each approval-class function, per persona (every call undone): the
--     revoked manager and staff without the grant are refused, the granted
--     staff member, the manager and the owner are answered. The two tests
--     that pinned the old precedence (0378 G13, 0383 G12) flip in their own
--     files. cancel_order_request keeps the requester's own-order branch.
-- B.  The three policies, per persona: a raw notes update (0 rows for the
--     revoked manager), an on-behalf insert and a line on another member's
--     order (42501, row level security) are refused for the revoked manager
--     and answered for the granted staff member.
-- E.  assign_order_delivery: orders:assign_delivery AND orders:approve (what
--     assigning took before 0390 once the role term is gone: the app asked
--     the first, the update policy a manager or the second). Holders of both
--     answered (a manager, staff granted both, the owner); a revoked holder of
--     assign_delivery, staff without it and a viewer refused
--     (orders_assign_delivery); the manager whose orders:approve is revoked
--     and staff holding only orders:assign_delivery refused (orders_approve);
--     no warehouse write (warehouse_write); a non-member, an invited and a
--     null driver (driver_not_member); the wrong status
--     (not_staged_for_delivery); a foreign or missing order (P0002); anon (no
--     EXECUTE); the module off; the last of two kept calls wins; and the
--     revoked manager cannot make themself the driver by either road (E9).
-- F.  mark_order_in_transit: an approver who is not the driver, the owner,
--     the granted staff member and the granted staff driver are answered; a
--     staff driver without orders:approve and the revoked manager (driver or
--     not) are refused orders_approve (owner decision O3, default); no write
--     access (warehouse_write); no driver (no_driver); a pickup order
--     (not_a_delivery); a second call (status_changed, written once); a
--     foreign order, anon and the module off.
-- G.  Posture of the two new functions (DEFINER, search_path, lock_timeout
--     5s, owner, EXECUTE for authenticated only, comments) and no 40001 or
--     40P01 in their text.
-- H.  Census: no function in public, ledger or private keeps the role-or-
--     permission gate; no policy in public names has_org_role together with
--     orders:approve; the three policies are 0390's text (pg_policies md5,
--     roles by name).
-- Z.  Every undone attempt changed nothing.
--
-- MUTATION TABLE (sec-orders/mutate-0390.py; each must fail the named lines):
--   M1  leave the role term in one body (approve_order_request) -> R1, C1
--   M2  role only in one body (drop has_permission: has_org_role manager)  -> C1 (stfAp)
--   M3  update policy USING by role rank only                             -> B1 (stfAp), 0384 KO3/KO4
--   M4  mark_order_in_transit without the status check                    -> F6b
--   M5  assign_order_delivery without the permission check                -> E2
--   M6  mark_order_in_transit without the orders:approve gate             -> F1 (stf, mgrNo), F2
--   M7  assign_order_delivery without the driver-member check             -> E3
--   M8  insert policy keeps has_org_role in the on-behalf branch           -> B2 (mgrNo), H2, H3
--   M9  lines policy keeps has_org_role                                    -> B3 (mgrNo), H2, H3
--   M10 assign_order_delivery EXECUTE left to service_role                -> G1
--   M11-M15 (the row lock, and the role term kept in cancel, hold, readiness
--       and revise) are in sec-orders/mutate-0390.py with their targets.
--   M16 assign_order_delivery without the orders:approve gate              -> E2 (mgrNo, stfAD), E9
--   M17 a header change in one body (order_readiness_facts VOLATILE)       -> R11, P3
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone) or pg_temp.call_as (kept), which switch role
-- and claims with set_config inside a subtransaction (the 0387 helpers), so
-- the pgTAP bookkeeping never runs as an API role. begin/rollback: nothing
-- leaks. Namespace 03900000.

begin;

select plan(54);

\set orgA    '\'03900000-0000-0000-0000-00000000000a\''
\set orgZ    '\'03900000-0000-0000-0000-00000000000b\''
\set own     '\'03900000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03900000-0000-0000-0000-0000000000a1\''
\set mgrNo   '\'03900000-0000-0000-0000-0000000000a2\''
\set mgrNoAD '\'03900000-0000-0000-0000-0000000000a3\''
\set stfAp   '\'03900000-0000-0000-0000-0000000000a4\''
\set stfAD   '\'03900000-0000-0000-0000-0000000000a5\''
\set stfNoWh '\'03900000-0000-0000-0000-0000000000a6\''
\set stf     '\'03900000-0000-0000-0000-0000000000a7\''
\set req     '\'03900000-0000-0000-0000-0000000000a8\''
\set vwr     '\'03900000-0000-0000-0000-0000000000a9\''
\set pend    '\'03900000-0000-0000-0000-0000000000aa\''
\set outZ    '\'03900000-0000-0000-0000-0000000000b1\''
\set whA     '\'03900000-0000-0000-0000-0000000000d1\''
\set whZ     '\'03900000-0000-0000-0000-0000000000d2\''
\set chA     '\'03900000-0000-0000-0000-0000000000c1\''
\set itA     '\'03900000-0000-0000-0000-0000000000e1\''
\set itRes   '\'03900000-0000-0000-0000-0000000000e2\''
\set itG     '\'03900000-0000-0000-0000-0000000000e3\''
\set oPend   '\'03900000-0000-0000-0000-000000000101\''
\set oMine   '\'03900000-0000-0000-0000-000000000102\''
\set oBack   '\'03900000-0000-0000-0000-000000000103\''
\set oPC     '\'03900000-0000-0000-0000-000000000104\''
\set oPS     '\'03900000-0000-0000-0000-000000000105\''
\set oAppr   '\'03900000-0000-0000-0000-000000000106\''
\set oNotes  '\'03900000-0000-0000-0000-000000000107\''
\set oLines  '\'03900000-0000-0000-0000-000000000108\''
\set oStg    '\'03900000-0000-0000-0000-000000000111\''
\set oStgA   '\'03900000-0000-0000-0000-000000000112\''
\set oStgD   '\'03900000-0000-0000-0000-000000000113\''
\set oStgD2  '\'03900000-0000-0000-0000-000000000114\''
\set oStgDN  '\'03900000-0000-0000-0000-000000000115\''
\set oStgK   '\'03900000-0000-0000-0000-000000000116\''
\set oPick   '\'03900000-0000-0000-0000-000000000117\''
\set oPendD  '\'03900000-0000-0000-0000-000000000118\''
\set oZ      '\'03900000-0000-0000-0000-000000000121\''
\set nobody  '\'03900000-0000-0000-0000-0000000009ff\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,     '0390-own@test.local',     '{}'::jsonb),
  (:mgr,     '0390-mgr@test.local',     '{}'::jsonb),
  (:mgrNo,   '0390-mgrno@test.local',   '{}'::jsonb),
  (:mgrNoAD, '0390-mgrnoad@test.local', '{}'::jsonb),
  (:stfAp,   '0390-stfap@test.local',   '{}'::jsonb),
  (:stfAD,   '0390-stfad@test.local',   '{}'::jsonb),
  (:stfNoWh, '0390-stfnowh@test.local', '{}'::jsonb),
  (:stf,     '0390-stf@test.local',     '{}'::jsonb),
  (:req,     '0390-req@test.local',     '{}'::jsonb),
  (:vwr,     '0390-vwr@test.local',     '{}'::jsonb),
  (:pend,    '0390-pend@test.local',    '{}'::jsonb),
  (:outZ,    '0390-outz@test.local',    '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0390 Approve A', '0390-approve-a'),
  (:orgZ, '0390 Approve Z', '0390-approve-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,     'owner',   now()),
  (:orgA, :mgr,     'manager', now()),
  (:orgA, :mgrNo,   'manager', now()),
  (:orgA, :mgrNoAD, 'manager', now()),
  (:orgA, :stfAp,   'staff',   now()),
  (:orgA, :stfAD,   'staff',   now()),
  (:orgA, :stfNoWh, 'staff',   now()),
  (:orgA, :stf,     'staff',   now()),
  (:orgA, :req,     'staff',   now()),
  (:orgA, :vwr,     'viewer',  now()),
  (:orgA, :pend,    'staff',   null),
  (:orgZ, :outZ,    'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0390 Main', 'WH-0390A', 'active'),
  (:whZ, :orgZ, '0390 Zed',  'WH-0390Z', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0390 Charter', 'CH-0390', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stfAp, :whA, true),
  (:orgA, :stfAD, :whA, true),
  (:orgA, :stf,   :whA, true),
  (:orgA, :req,   :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNo,   'orders:approve',         false),
  (:orgA, :mgrNoAD, 'orders:assign_delivery', false),
  (:orgA, :stfAp,   'orders:approve',         true),
  (:orgA, :stfAp,   'orders:assign_delivery', true),
  (:orgA, :stfAD,   'orders:assign_delivery', true),
  (:orgA, :stfNoWh, 'orders:approve',         true),
  (:orgA, :stfNoWh, 'orders:assign_delivery', true);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itA,   :orgA, :whA, '0390-A',   'Approve item', 100, 'active', 'none'),
  (:itRes, :orgA, :whA, '0390-RES', 'Resume item',   30, 'active', 'none'),
  (:itG,   :orgA, :whA, '0390-G',   'General item',  50, 'active', 'none');

-- Orders at their status, inserted by the superuser (the insert guard holds
-- API roles only; the transition trigger fires on UPDATE only). Delivery
-- orders carry the charter (order_requests_delivery_target_chk).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, assigned_delivery_user_id, needed_by) values
  (:oPend,  :orgA, :whA, 'pending_approval',    'internal', :req,   'pickup',   null, null, null,  null,    null),
  (:oMine,  :orgA, :whA, 'pending_approval',    'internal', :mgrNo, 'pickup',   null, null, null,  null,    null),
  (:oBack,  :orgA, :whA, 'backordered',         'internal', :req,   'pickup',   null, :mgr, now(), null,    null),
  (:oPC,    :orgA, :whA, 'picking_complete',    'internal', :req,   'pickup',   null, :mgr, now(), null,    null),
  (:oPS,    :orgA, :whA, 'pick_slip_generated', 'internal', :req,   'pickup',   null, :mgr, now(), null,    null),
  (:oAppr,  :orgA, :whA, 'approved',            'internal', :req,   'pickup',   null, :mgr, now(), null,
            date_trunc('minute', now()) + interval '8 days'),
  (:oNotes, :orgA, :whA, 'approved',            'internal', :req,   'pickup',   null, :mgr, now(), null,    null),
  (:oLines, :orgA, :whA, 'pending_approval',    'internal', :req,   'pickup',   null, null, null,  null,    null),
  (:oStg,   :orgA, :whA, 'staged_for_delivery', 'internal', :req,   'delivery', :chA, :mgr, now(), null,    null),
  (:oStgA,  :orgA, :whA, 'staged_for_delivery', 'internal', :req,   'delivery', :chA, :mgr, now(), null,    null),
  (:oStgD,  :orgA, :whA, 'staged_for_delivery', 'internal', :req,   'delivery', :chA, :mgr, now(), :stf,    null),
  (:oStgD2, :orgA, :whA, 'staged_for_delivery', 'internal', :req,   'delivery', :chA, :mgr, now(), :stfAp,  null),
  (:oStgDN, :orgA, :whA, 'staged_for_delivery', 'internal', :req,   'delivery', :chA, :mgr, now(), :mgrNo,  null),
  (:oStgK,  :orgA, :whA, 'staged_for_delivery', 'internal', :req,   'delivery', :chA, :mgr, now(), :stf,    null),
  (:oPick,  :orgA, :whA, 'staged_for_pickup',   'internal', :req,   'pickup',   null, :mgr, now(), :stf,    null),
  (:oPendD, :orgA, :whA, 'pending_approval',    'internal', :req,   'delivery', :chA, null, null,  null,    null);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:oZ, :orgZ, :whZ, 'pending_approval', 'internal', :outZ, 'pickup');

insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:oPend,  :itA,    5, 0, null),
  (:oMine,  :itA,    1, 0, null),
  (:oBack,  :itRes, 10, 5, null),
  (:oPC,    :itG,    5, 0, null),
  (:oPS,    :itG,    5, 0, null),
  (:oAppr,  :itA,    3, 0, null),
  (:oNotes, :itG,    1, 0, null),
  (:oLines, :itA,    1, 0, null);

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
    raise exception using errcode = 'XX390', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX390' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
-- One statement that returns a value, as p_as, KEPT when it succeeds.
create function pg_temp.call_as(p_as text, p_sub uuid, p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v_state text; v_msg text; v_hint text; v text; v_seen text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('request.jwt.claim.role', p_as, true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claim.role', '', true);
    if p_check is not null then
      execute p_check into v_seen;
    end if;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
  end;
  return coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('mgr', :mgr), ('mgrNo', :mgrNo), ('mgrNoAD', :mgrNoAD), ('stfAp', :stfAp),
  ('stfAD', :stfAD), ('stfNoWh', :stfNoWh), ('stf', :stf), ('req', :req), ('vwr', :vwr);
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
-- A read for each named persona (call_as; the reads change nothing).
create function pg_temp.each_val(p_who text[], p_sql text)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.call_as('authenticated', (select p.id from persona p where p.who = w), p_sql);
  end loop;
  return v;
end $$;

-- The C and B matrices run as these five, in this order.
\set five '\'{mgrNo,stf,stfAp,mgr,own}\''

-- ══ R. Exactly one edit per body ══════════════════════════════════════════
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.approve_order_request(uuid)')),
  '7883f466ae2642cbb4664ebc473e571b|96e5f7c8b4cdd6b7e4ffcc994c9ed642',
  'R1: approve_order_request has 0390''s body (md5 7883f466), and putting the role term back gives production''s pre-0390 body exactly (96e5f7c8): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.approve_partial(uuid)')),
  '40ca0878733b08a649773fe9b7efd4e0|64bb847ffc8681adeed4b881c1b6a4ab',
  'R2: approve_partial has 0390''s body (md5 40ca0878), and putting the role term back gives production''s pre-0390 body exactly (64bb847f): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.assign_picking(uuid, uuid)')),
  'd6e8dc7c2f92863a88ed381dc883637c|44ebd4558995a343aa878ca47c5a9b8f',
  'R3: assign_picking has 0390''s body (md5 d6e8dc7c), and putting the role term back gives production''s pre-0390 body exactly (44ebd455): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n                  or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.cancel_order_request(uuid, text)')),
  '47cabcd1fe4f52fb7b2b6b6b64b68da1|7a2302dec888970054738b0dad420fd3',
  'R4: cancel_order_request has 0390''s body (md5 47cabcd1), and putting the role term back gives production''s pre-0390 body exactly (7a2302de): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.close_partial(uuid)')),
  'a519c3e58fb577c3ff1b30fb3a6cc0ad|2d873a049a5584df7d3a168fb2b45e34',
  'R5: close_partial has 0390''s body (md5 a519c3e5), and putting the role term back gives production''s pre-0390 body exactly (2d873a04): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_org, ''orders:approve'')',
                                              E'public.has_org_role(v_org, ''manager'')\n          or public.has_permission(v_org, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.hold_order_stock(uuid)')),
  '3b0691d604823164daaa7f248616f00f|c38fe9b12af77fdaa2d372f4fd324a43',
  'R6: hold_order_stock has 0390''s body (md5 3b0691d6), and putting the role term back gives production''s pre-0390 body exactly (c38fe9b1): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_org, ''orders:approve'')',
                                              E'public.has_org_role(v_org, ''manager'')\n                 or public.has_permission(v_org, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.order_readiness_facts(uuid)')),
  '2f3fb057bacda8143377ecd9c2c5e6e2|5ac332d439117e498096fc9b1098cf04',
  'R7: order_readiness_facts has 0390''s body (md5 2f3fb057), and putting the role term back gives production''s pre-0390 body exactly (5ac332d4): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.reopen_picking(uuid, text)')),
  '293ce0e76d195bb13105cfd1c067de82|a7fabd5fb3d07467135006b56581e46c',
  'R8: reopen_picking has 0390''s body (md5 293ce0e7), and putting the role term back gives production''s pre-0390 body exactly (a7fabd5f): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                              E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.resume_fulfillment(uuid)')),
  '2e2d5aab1db5392250879bfa9ff4bccd|e0f2ae5d7d3564cdad3b36ba4cf5aa8c',
  'R9: resume_fulfillment has 0390''s body (md5 2e2d5aab), and putting the role term back gives production''s pre-0390 body exactly (e0f2ae5d): the gate is the only change');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, 'public.has_permission(v_org, ''orders:approve'')',
                                              E'public.has_org_role(v_org, ''manager'')\n          or public.has_permission(v_org, ''orders:approve'')'))
     from pg_proc p where p.oid = to_regprocedure('public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)')),
  'dd11c6a10d4ec6fe3543e86680130347|c2ce20a076301c95b2b9ef968db1b206',
  'R10: revise_order_needed_by has 0390''s body (md5 dd11c6a1), and putting the role term back gives production''s pre-0390 body exactly (c2ce20a0): the gate is the only change');
select is(
  (select string_agg(d.fn || '=' || d.m, E'\n' order by d.fn) from (
  select 'approve_order_request' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.approve_order_request(uuid)')
  union all
  select 'approve_partial' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.approve_partial(uuid)')
  union all
  select 'assign_picking' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.assign_picking(uuid, uuid)')
  union all
  select 'cancel_order_request' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n                  or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.cancel_order_request(uuid, text)')
  union all
  select 'close_partial' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.close_partial(uuid)')
  union all
  select 'hold_order_stock' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_org, ''orders:approve'')',
                                  E'public.has_org_role(v_org, ''manager'')\n          or public.has_permission(v_org, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.hold_order_stock(uuid)')
  union all
  select 'order_readiness_facts' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_org, ''orders:approve'')',
                                  E'public.has_org_role(v_org, ''manager'')\n                 or public.has_permission(v_org, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.order_readiness_facts(uuid)')
  union all
  select 'reopen_picking' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.reopen_picking(uuid, text)')
  union all
  select 'resume_fulfillment' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_req.organization_id, ''orders:approve'')',
                                  E'public.has_org_role(v_req.organization_id, ''manager'')\n          or public.has_permission(v_req.organization_id, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.resume_fulfillment(uuid)')
  union all
  select 'revise_order_needed_by' as fn, md5(replace(pg_get_functiondef(p.oid), 'public.has_permission(v_org, ''orders:approve'')',
                                  E'public.has_org_role(v_org, ''manager'')\n          or public.has_permission(v_org, ''orders:approve'')')) as m
    from pg_proc p where p.oid = to_regprocedure('public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)')) d),
  E'approve_order_request=a133a783f3d4c2257e9979cb5ec90683\n'
  'approve_partial=76cf3cf8d6f10908f3e63e66cffbf8fc\n'
  'assign_picking=87c2d7c6289af3e12179ddc8c13ce4c1\n'
  'cancel_order_request=60198cff2d40c936d4d1cd11e050de14\n'
  'close_partial=eca9e0f511b63c157f278adf05f34955\n'
  'hold_order_stock=8f40b4baabd79973458d1759be5da4dd\n'
  'order_readiness_facts=faea50d0129c265a99b2660b42998abc\n'
  'reopen_picking=53b3b2e29c611896d4a99987c0983c18\n'
  'resume_fulfillment=6cd0f43bc073c47555bbc12268c20415\n'
  'revise_order_needed_by=63ebe4a959306bc59edf61f39f68739b',
  'R11: for each of the ten, putting the role term back into the whole definition (pg_get_functiondef) gives production''s pre-0390 definition exactly: arguments and defaults, result, volatility, strictness, cost, parallel, leakproof, SECURITY DEFINER and SET clauses are unchanged, not only the body');

-- ══ P. The ten keep their posture; three comments say what 0390 enforces ══
select is(
  (select string_agg(p.proname || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|'
                     || pg_get_userbyid(p.proowner) || '|'
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('service_role', p.oid, 'EXECUTE')::text, E'\n' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_request', 'approve_partial', 'assign_picking', 'cancel_order_request',
                        'close_partial', 'hold_order_stock', 'order_readiness_facts', 'reopen_picking',
                        'resume_fulfillment', 'revise_order_needed_by')),
  E'approve_order_request|true|{search_path=public}|postgres|true|false|true\n'
  'approve_partial|true|{search_path=public}|postgres|true|false|true\n'
  'assign_picking|true|{search_path=public}|postgres|true|false|true\n'
  'cancel_order_request|true|{"search_path=public, extensions"}|postgres|true|false|true\n'
  'close_partial|true|{search_path=public}|postgres|true|false|true\n'
  'hold_order_stock|true|{"search_path=public, pg_temp",lock_timeout=5s}|postgres|true|false|true\n'
  'order_readiness_facts|true|{"search_path=public, pg_temp"}|postgres|true|false|true\n'
  'reopen_picking|true|{"search_path=public, extensions"}|postgres|true|false|true\n'
  'resume_fulfillment|true|{search_path=public}|postgres|true|false|true\n'
  'revise_order_needed_by|true|{"search_path=public, pg_temp",lock_timeout=5s}|postgres|true|false|false',
  'P1: the ten keep SECURITY DEFINER, their SET clauses, their owner and who may EXECUTE them (production''s posture, read 2026-10-03; revise_order_needed_by was authenticated-only before 0390 too)');
select is(
  (select string_agg(p.proname || '=' || (coalesce(obj_description(p.oid, 'pg_proc'), '') ~ '0390')::text || '/'
                     || (coalesce(obj_description(p.oid, 'pg_proc'), '') ~ 'manager or orders:approve|manager\+ by role')::text,
                     ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('approve_order_request', 'hold_order_stock', 'revise_order_needed_by')),
  'approve_order_request=true/false, hold_order_stock=true/false, revise_order_needed_by=true/false',
  'P2: the three function comments that stated "manager or orders:approve" now state 0390''s rule');
select is(
  (select string_agg(p.proname || '|' || p.provolatile::text || '|' || p.proisstrict::text || '|' || p.procost::text || '|' || p.prorows::text || '|' || p.proparallel::text || '|' || p.proleakproof::text || '|' || pg_get_function_arguments(p.oid) || '|' || pg_get_function_result(p.oid), E'\n' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('approve_order_request', 'approve_partial', 'assign_picking', 'cancel_order_request', 'close_partial', 'hold_order_stock', 'order_readiness_facts', 'reopen_picking', 'resume_fulfillment', 'revise_order_needed_by')),
  E'approve_order_request|v|false|100|0|u|false|p_id uuid|order_requests\n'
  'approve_partial|v|false|100|0|u|false|p_id uuid|order_requests\n'
  'assign_picking|v|false|100|0|u|false|p_order_id uuid, p_user_id uuid|order_requests\n'
  'cancel_order_request|v|false|100|0|u|false|p_id uuid, p_reason text DEFAULT NULL::text|order_requests\n'
  'close_partial|v|false|100|0|u|false|p_id uuid|order_requests\n'
  'hold_order_stock|v|false|100|0|u|false|p_order_id uuid|jsonb\n'
  'order_readiness_facts|s|false|100|0|u|false|p_order_id uuid|jsonb\n'
  'reopen_picking|v|false|100|0|u|false|p_id uuid, p_reason text|order_requests\n'
  'resume_fulfillment|v|false|100|0|u|false|p_id uuid|order_requests\n'
  'revise_order_needed_by|v|false|100|0|u|false|p_id uuid, p_needed_by timestamp with time zone, p_expected_needed_by timestamp with time zone, p_reason text, p_event_details text|jsonb',
  'P3: the ten keep their volatility (order_readiness_facts STABLE, the rest VOLATILE), not STRICT, cost 100, rows 0, PARALLEL UNSAFE, not LEAKPROOF, and their arguments with defaults and result type (production, read 2026-10-03)');

-- ══ The fixture is what the matrices assume ═══════════════════════════════
select is(
  pg_temp.each_val(array['mgrNo', 'stfAp', 'mgr', 'stf'],
    format($q$select public.has_org_role(%L, 'manager')::text || '/' || public.has_permission(%L, 'orders:approve')::text$q$, :orgA, :orgA)),
  'mgrNo=true/false, stfAp=false/true, mgr=true/true, stf=false/false',
  'C0: the revoked manager is a manager by rank without orders:approve, the granted staff member has it without the rank (the two cases the role term decided)');

-- ══ C. The approval-class functions, per persona ══════════════════════════
select is(
  pg_temp.each(:five, format('select public.approve_order_request(%L)', :oPend)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C1: approve_order_request: the revoked manager is refused (42501 forbidden), the granted staff member, a manager and the owner approve');
select is(
  pg_temp.each(:five, format('select public.approve_partial(%L)', :oPend)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C2: approve_partial: the same');
select is(
  pg_temp.each(:five, format('select public.close_partial(%L)', :oBack)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C3: close_partial: the same');
select is(
  pg_temp.each(:five, format('select public.resume_fulfillment(%L)', :oBack)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C4: resume_fulfillment: the same (stock to re-hold is free)');
select is(
  pg_temp.each(:five, format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPC)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C5: reopen_picking: the same');
select is(
  pg_temp.each(:five, format('select public.assign_picking(%L, %L)', :oPS, :stf)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C6: assign_picking: the same (the granted staff member has write access to the warehouse)');
select is(
  pg_temp.each(:five, format($q$select public.cancel_order_request(%L, 'Not needed')$q$, :oPend)),
  'mgrNo=42501:-:forbidden, stf=42501:-:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C7: cancel_order_request on another member''s order: the revoked manager is refused, the granted staff member, a manager and the owner cancel');
select is(
  pg_temp.attempt('authenticated', :mgrNo, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oMine)),
  'ok:1',
  'C8: cancel_order_request on their own order still works for the revoked manager (the requester branch)');
select is(
  pg_temp.each(:five, format('select public.hold_order_stock(%L)', :oAppr)),
  'mgrNo=42501:orders_approve:forbidden, stf=42501:orders_approve:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C9: hold_order_stock: the revoked manager is refused (hint orders_approve), the granted staff member, a manager and the owner hold');
select is(
  pg_temp.each(:five, format($q$select public.revise_order_needed_by(%L, date_trunc('minute', now()) + interval '9 days',
                                   (select o.needed_by from public.order_requests o where o.id = %L), 'Moved by the school', null)$q$, :oAppr, :oAppr)),
  'mgrNo=42501:orders_approve:forbidden, stf=42501:orders_approve:forbidden, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'C10: revise_order_needed_by: the revoked manager is refused (hint orders_approve), the granted staff member, a manager and the owner change the date');
select is(
  pg_temp.each_val(:five, format($q$select coalesce(jsonb_typeof(r->'items'->0->'pendingOthers'), 'absent')
                                      from public.order_readiness_facts(%L) r$q$, :oPend)),
  'mgrNo=null, stf=null, stfAp=object, mgr=object, own=object',
  'C11: order_readiness_facts: other pending demand (pendingOthers) is withheld from the revoked manager and given to the granted staff member, a manager and the owner');

-- ══ B. The three policies, per persona ════════════════════════════════════
select is(
  pg_temp.each(:five, format($q$update public.order_requests set internal_notes = '0390 note' where id = %L$q$, :oNotes)),
  'mgrNo=ok:0, stf=ok:0, stfAp=ok:1, mgr=ok:1, own=ok:1',
  'B1: order_requests_update: a raw notes update matches 0 rows for the revoked manager (USING) and 1 for the granted staff member, a manager and the owner');
select is(
  pg_temp.each(:five, format($q$insert into public.order_requests
                                   (organization_id, warehouse_id, requester_name, requester_email, source, fulfillment_type, status)
                                 values (%L, %L, 'Pat Doe', 'pat-0390@example.test', 'internal', 'pickup', 'pending_approval')$q$, :orgA, :whA)),
  'mgrNo=42501:-:new row violates row-level security policy for table "order_requests", '
  'stf=42501:-:new row violates row-level security policy for table "order_requests", stfAp=ok:1, mgr=ok:1, own=ok:1',
  'B2: order_requests_insert: an order on someone else''s behalf is refused for the revoked manager (42501, row level security) and accepted for the granted staff member, a manager and the owner');
select is(
  pg_temp.each(:five, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oLines, :itA)),
  'mgrNo=42501:-:new row violates row-level security policy for table "order_request_lines", '
  'stf=42501:-:new row violates row-level security policy for table "order_request_lines", stfAp=ok:1, mgr=ok:1, own=ok:1',
  'B3: order_request_lines_insert: a line on another member''s order is refused for the revoked manager and accepted for the granted staff member, a manager and the owner');
select is(
  pg_temp.attempt('authenticated', :req, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :oLines, :itA)),
  'ok:1',
  'B4: the requester still adds a line to their own order (the requester branch is kept)');

-- ══ E. assign_order_delivery ══════════════════════════════════════════════
select is(
  pg_temp.each(array['mgr', 'stfAp', 'own'], format('select public.assign_order_delivery(%L, %L)', :oStg, :stf),
               format($q$select (assigned_delivery_user_id = %L)::text || '/' || (assigned_delivery_by = current_setting('request.jwt.claim.sub')::uuid)::text
                               || '/' || (assigned_delivery_at is not null)::text
                          from public.order_requests where id = %L$q$, :stf, :oStg)),
  'mgr=ok:1:true/true/true, stfAp=ok:1:true/true/true, own=ok:1:true/true/true',
  'E1: holders of orders:assign_delivery and orders:approve assign the driver and are recorded as the assigner: a manager, staff granted both, the owner');
select is(
  pg_temp.each(array['mgrNoAD', 'stf', 'vwr', 'mgrNo', 'stfAD', 'stfNoWh'], format('select public.assign_order_delivery(%L, %L)', :oStg, :stf)),
  'mgrNoAD=42501:orders_assign_delivery:forbidden, stf=42501:orders_assign_delivery:forbidden, '
  'vwr=42501:orders_assign_delivery:forbidden, mgrNo=42501:orders_approve:forbidden, '
  'stfAD=42501:orders_approve:forbidden, stfNoWh=42501:warehouse_write:forbidden',
  'E2: refused: the manager whose orders:assign_delivery is revoked, staff without it and a viewer (hint orders_assign_delivery); the manager whose orders:approve is revoked and staff holding only orders:assign_delivery (hint orders_approve: the update policy refused both before 0390); staff granted both with no write access to the warehouse (hint warehouse_write)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, %L)', :oStg, :outZ)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, %L)', :oStg, :pend)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, null)', :oStg)),
  'P0001:driver_not_member:driver_not_member / P0001:driver_not_member:driver_not_member / P0001:driver_not_member:driver_not_member',
  'E3: the driver must be an accepted member of the order''s organization: another org''s member, an invited member and no driver are refused');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, %L)', :oPendD, :stf)),
  'P0001:not_staged_for_delivery:delivery_not_assignable',
  'E4: only a staged-for-delivery order takes a driver (P0001 delivery_not_assignable, hint not_staged_for_delivery)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, %L)', :oZ, :stf)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, %L)', :nobody, :stf)),
  'P0002:-:order_request_not_found / P0002:-:order_request_not_found',
  'E5: another organization''s order and a missing order get the same answer (P0002 order_request_not_found)');
select is(
  pg_temp.attempt('anon', null, format('select public.assign_order_delivery(%L, %L)', :oStg, :stf)),
  '42501:-:permission denied for function assign_order_delivery',
  'E6: anon may not EXECUTE it');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.assign_order_delivery(%L, %L)', :oStg, :stf),
                  format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA)),
  'P0001:module_disabled:module_disabled',
  'E7: with the Orders module off: P0001 module_disabled');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.assigned_delivery_user_id::text from public.assign_order_delivery(%L, %L) r', :oStgA, :stf)) || ' / '
  || pg_temp.call_as('authenticated', :mgr, format('select r.assigned_delivery_user_id::text from public.assign_order_delivery(%L, %L) r', :oStgA, :stfAp),
                     format('select assigned_delivery_user_id::text from public.order_requests where id = %L', :oStgA)),
  :stf || ' / ' || :stfAp || '|' || :stfAp,
  'E8: a reassignment replaces the driver: the last call wins (today''s behaviour), and the function returns the row');
select is(
  pg_temp.attempt('authenticated', :mgrNo, format('select public.assign_order_delivery(%L, %L)', :oStg, :mgrNo)) || ' / '
  || pg_temp.attempt('authenticated', :mgrNo,
       format('update public.order_requests set assigned_delivery_user_id = %L, assigned_delivery_by = %L, assigned_delivery_at = now() where id = %L',
              :mgrNo, :mgrNo, :oStg)),
  '42501:orders_approve:forbidden / ok:0',
  'E9: the manager whose orders:approve is revoked cannot make themself the driver (and then hand the order over as the driver): the function refuses (orders_approve) and a raw update matches no row (the update policy)');

-- ══ F. mark_order_in_transit ══════════════════════════════════════════════
select is(
  pg_temp.each(array['stf', 'mgrNo', 'vwr', 'stfNoWh', 'stfAp', 'mgr', 'own'], format('select public.mark_order_in_transit(%L)', :oStgD),
               format($q$select status || '/' || (in_transit_by = current_setting('request.jwt.claim.sub')::uuid)::text || '/' || (in_transit_at is not null)::text
                          from public.order_requests where id = %L$q$, :oStgD)),
  'stf=42501:orders_approve:forbidden, mgrNo=42501:orders_approve:forbidden, vwr=42501:warehouse_write:forbidden, '
  'stfNoWh=42501:warehouse_write:forbidden, stfAp=ok:1:in_transit/true/true, mgr=ok:1:in_transit/true/true, own=ok:1:in_transit/true/true',
  'F1: the staff driver without orders:approve is refused (owner decision O3, default) and so is the revoked manager; no write access is refused; the granted staff member, a manager and the owner (none of them the driver) mark it in transit and are recorded');
select is(
  pg_temp.attempt('authenticated', :mgrNo, format('select public.mark_order_in_transit(%L)', :oStgDN)),
  '42501:orders_approve:forbidden',
  'F2: the revoked manager is refused even as the assigned driver');
select is(
  pg_temp.attempt('authenticated', :stfAp, format('select public.mark_order_in_transit(%L)', :oStgD2)),
  'ok:1',
  'F3: the granted staff member who is the driver marks their own delivery in transit');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.mark_order_in_transit(%L)', :oStg)),
  'P0001:no_driver:no_driver',
  'F4: no driver assigned: P0001 no_driver');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.mark_order_in_transit(%L)', :oPick)),
  'P0001:not_a_delivery:not_a_delivery',
  'F5: a pickup order: P0001 not_a_delivery');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.mark_order_in_transit(%L) r', :oStgK)),
  'in_transit',
  'F6a: a manager marks the order in transit (kept)');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.mark_order_in_transit(%L)', :oStgK))
  || ' / ' || (select (in_transit_by = :mgr)::text from public.order_requests where id = :oStgK),
  'P0001:status_changed:order_status_changed / true',
  'F6b: a second call is refused under the row lock (P0001 order_status_changed, hint status_changed) and the first mark stands');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.mark_order_in_transit(%L)', :oZ)) || ' / '
  || pg_temp.attempt('anon', null, format('select public.mark_order_in_transit(%L)', :oStgD)) || ' / '
  || pg_temp.attempt('authenticated', :mgr, format('select public.mark_order_in_transit(%L)', :oStgD),
                     format($q$update public.organization_modules set enabled = false where organization_id = %L and module_id = 'orders'$q$, :orgA)),
  'P0002:-:order_request_not_found / 42501:-:permission denied for function mark_order_in_transit / P0001:module_disabled:module_disabled',
  'F7: another organization''s order (P0002), anon (no EXECUTE) and the Orders module off (module_disabled)');

-- ══ G. The two new functions' posture ═════════════════════════════════════
select is(
  (select string_agg(p.proname || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || p.provolatile::text
                     || '|' || pg_get_userbyid(p.proowner) || '|'
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
                     || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false'),
                     E'\n' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assign_order_delivery', 'mark_order_in_transit')),
  E'assign_order_delivery|true|{"search_path=public, pg_temp",lock_timeout=5s}|v|postgres|true|false|false|false\n'
  'mark_order_in_transit|true|{"search_path=public, pg_temp",lock_timeout=5s}|v|postgres|true|false|false|false',
  'G1: both are SECURITY DEFINER with search_path pinned and lock_timeout 5s, owned by postgres, EXECUTE for authenticated only (not PUBLIC, anon or service_role)');
select is(
  (select string_agg(p.proname || '=' || (p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected')::text, ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assign_order_delivery', 'mark_order_in_transit')),
  'assign_order_delivery=false, mark_order_in_transit=false',
  'G2: neither raises 40001 or 40P01 (PostgREST retries those forever)');
select is(
  (select string_agg(p.proname || '=' || (coalesce(obj_description(p.oid, 'pg_proc'), '') ~ '^Slice D \(0390\)')::text, ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assign_order_delivery', 'mark_order_in_transit')),
  'assign_order_delivery=true, mark_order_in_transit=true',
  'G3: both say in their comments what they check');

-- ══ H. Census ═════════════════════════════════════════════════════════════
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname, p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger', 'private')
      and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ $re$has_org_role\([^)]*'manager'\)$re$
      and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ $re$has_permission\([^)]*'orders:approve'\)$re$),
  '',
  'H1: no function in public, ledger or private names both has_org_role(..., ''manager'') and has_permission(..., ''orders:approve'') in its code (comments left out), in any order or shape: the "manager by role, or orders:approve" gate is gone and a new one fails here (before 0390 exactly the ten matched)');
select is(
  (select coalesce(string_agg(tablename || '.' || policyname, ',' order by tablename, policyname), '')
     from pg_policies
    where schemaname = 'public'
      and coalesce(qual, '') || coalesce(with_check, '') ~ 'orders:approve'
      and coalesce(qual, '') || coalesce(with_check, '') ~ 'has_org_role'),
  '',
  'H2: no policy in public names has_org_role together with orders:approve');
select is(
  (select string_agg(tablename || '.' || policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                     || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')), E'\n' order by tablename, policyname)
     from pg_policies
    where schemaname = 'public'
      and policyname in ('order_requests_update', 'order_requests_insert', 'order_request_lines_insert')),
  -- Predicted from production's text minus the role term (sec-orders
  -- D-NOTES step 2); the method reproduces production's pre-0390 values
  -- e5873a6e / 5fe018ed / a8bb4e38. Verify on the stack.
  E'order_request_lines.order_request_lines_insert|INSERT|{authenticated}|PERMISSIVE|f9fe86e630f9a912cd35ca9f0f0fe621\n'
  'order_requests.order_requests_insert|INSERT|{authenticated}|PERMISSIVE|6d0d5912d9e99a8073ab6b18bbba5385\n'
  'order_requests.order_requests_update|UPDATE|{authenticated}|PERMISSIVE|0116460a0227c2c7b08eb457b8a9c4e0',
  'H3: the three policies are 0390''s text, still PERMISSIVE and for authenticated (pg_policies md5, comparable with production)');

-- ══ Z. Every undone attempt changed nothing ═══════════════════════════════
select is(
  (select string_agg(o.status || '/' || coalesce(o.assigned_picker_id::text, '-') || '/' || coalesce(o.assigned_delivery_user_id::text, '-')
                     || '/' || coalesce(o.internal_notes, '-'), ' ' order by o.id)
     from public.order_requests o where o.id in (:oPend, :oBack, :oPC, :oPS, :oNotes, :oStg, :oStgD)) || ' | '
  || (select count(*)::text from public.stock_reservations r where r.organization_id = :orgA) || ' | '
  || (select count(*)::text from public.order_requests o where o.organization_id = :orgA and o.requester_email = 'pat-0390@example.test') || ' | '
  || (select count(*)::text from public.order_request_lines l where l.order_request_id = :oLines),
  'pending_approval/-/-/- backordered/-/-/- picking_complete/-/-/- pick_slip_generated/-/-/- approved/-/-/- staged_for_delivery/-/-/- staged_for_delivery/-/'
  || :stf || '/- | 0 | 0 | 1',
  'Z1: the undone attempts left every fixture order, hold, on-behalf order and line as it was');

select * from finish();
rollback;
