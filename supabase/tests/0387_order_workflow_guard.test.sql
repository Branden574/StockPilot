-- supabase/tests/0387_order_workflow_guard.test.sql
-- pgTAP proof for migration 0387 (S0): an order is approved, and moved along
-- every stock-bearing status edge, only by the order RPCs. A signed-in caller
-- keeps the six edges the app writes through the user client.
--
-- A. Attacks, each as `authenticated` with the attacker's claims, refused with
--    42501 and the stated hint, and changing nothing:
--    A1  a manager's raw PATCH to approved (status_through_rpc_only), and the
--        same PATCH carrying approved_by and approved_at (column privilege);
--    A2  the same by a staff member granted orders:approve;
--    A3  a bulk PATCH with no id filter (every pending order of the org);
--    A4  forging approved_by or approved_at: the column privilege is gone,
--        and with the privilege granted back inside a self-undoing
--        subtransaction the guard alone still refuses
--        (approval_through_rpc_only): defence in depth;
--    A5  clearing approved_by, proven the same way;
--    A6  upserts: INSERT .. ON CONFLICT DO UPDATE to approved (the guard),
--        one carrying approved_by (the column privilege), and approved back
--        to pending_approval (the transition trigger, which sorts first);
--    A7  every one of the 30 edges the transition trigger allows, each on its
--        own fixture order, as a manager with RETURNING *: the six
--        allowlisted edges go through (A-L4), the other 24 are refused, one
--        TAP line per edge; plus the transition function is still 0289's;
--    A8  a raw write of each of the 21 revoked columns, and of the 17 O5
--        columns, is 42501 permission denied;
--    A9  anon holds no privilege on order_requests (and is refused reading
--        or writing it); authenticated holds no TRUNCATE, REFERENCES,
--        TRIGGER or MAINTAIN, keeps SELECT, INSERT and DELETE, and may
--        UPDATE exactly 19 columns;
--    A10 the guard raises 42501 only, never 40001 or 40P01.
-- AL. Legitimate paths:
--    AL1  approve_order_request (a manager) approves, stamps the approver and
--         holds stock; AL2 approve_partial (a staff approver) the same;
--    AL3  is 0384's KO1-KO7 (every user-client order write, exact shapes),
--         which run in that suite, unchanged;
--    AL4  is the six allowlisted rows of A7;
--    AL5  a notes save on an approved order, and one that re-sends the same
--         status, go through (the edge, never the value);
--    AL6  deleting an approver's user_profiles row nulls approved_by through
--         the FK, as postgres and with the deleting session's role
--         authenticated (the RI action runs as the table owner);
--    AL7  the admin client (service_role): the return prompt's token mint and
--         send claim, and a status edge the guard refuses for API roles;
--    AL8  every DEFINER edge still works: cancel (from approved and from
--         staged), complete_picking, reopen_picking, resume_fulfillment,
--         close_partial, confirm_physical_signature, confirm_order_signature
--         (service_role), partial_pick_line, claim_picking (picker columns,
--         now revoked from authenticated) and revise_order_needed_by
--         (needed_by, now revoked);
--    AL9  the writer census: only the two approval bodies assign approval
--         values; no SECURITY INVOKER function updates order_requests; the
--         SECURITY DEFINER writers executable by authenticated or anon are
--         exactly 13, by name (a new one fails here and is reviewed for its
--         own gate);
--    AL10 posture: the guard (body md5, INVOKER, search_path, owner, no
--         EXECUTE for PUBLIC, anon or authenticated), its trigger, the order
--         of the BEFORE UPDATE triggers, the trigger census, the comments, and
--         the approval bodies' md5 pins unchanged;
--    AL11 an illegal edge (completed -> approved) still reports
--         invalid_status_transition (the transition trigger sorts first).
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone) or pg_temp.call_as (kept), which switch role
-- and claims with set_config inside a subtransaction, so the pgTAP bookkeeping
-- itself never runs as an API role and no assertion sits in a savepoint that
-- is rolled back. begin/rollback: nothing leaks. Namespace 03870000.

begin;

select plan(84);

\set orgA   '\'03870000-0000-0000-0000-00000000000a\''
\set orgZ   '\'03870000-0000-0000-0000-00000000000b\''
\set own    '\'03870000-0000-0000-0000-0000000000a0\''
\set mgr    '\'03870000-0000-0000-0000-0000000000a1\''
\set req    '\'03870000-0000-0000-0000-0000000000a3\''
\set stfAp  '\'03870000-0000-0000-0000-0000000000a4\''
\set vwr    '\'03870000-0000-0000-0000-0000000000a6\''
\set mgrZ   '\'03870000-0000-0000-0000-0000000000b1\''
\set apr    '\'03870000-0000-0000-0000-0000000000c7\''
\set apr2   '\'03870000-0000-0000-0000-0000000000c8\''
\set whA    '\'03870000-0000-0000-0000-0000000000d1\''
\set whZ    '\'03870000-0000-0000-0000-0000000000d3\''
\set chA    '\'03870000-0000-0000-0000-0000000000c1\''
\set locA   '\'03870000-0000-0000-0000-0000000000e1\''
\set itG    '\'03870000-0000-0000-0000-0000000000f0\''
\set itAL1  '\'03870000-0000-0000-0000-0000000000f1\''
\set itAL2  '\'03870000-0000-0000-0000-0000000000f2\''
\set itPick '\'03870000-0000-0000-0000-0000000000f3\''
\set itRes  '\'03870000-0000-0000-0000-0000000000f4\''
-- Attack orders.
\set oA1    '\'03870000-0000-0000-0000-000000000101\''
\set oA2    '\'03870000-0000-0000-0000-000000000102\''
\set oZ1    '\'03870000-0000-0000-0000-000000000111\''
\set oZ2    '\'03870000-0000-0000-0000-000000000112\''
\set oZ3    '\'03870000-0000-0000-0000-000000000113\''
\set oApr   '\'03870000-0000-0000-0000-000000000120\''
\set oA6a   '\'03870000-0000-0000-0000-000000000121\''
\set oA6c   '\'03870000-0000-0000-0000-000000000122\''
\set oNote  '\'03870000-0000-0000-0000-000000000130\''
\set oL11   '\'03870000-0000-0000-0000-000000000131\''
-- Legitimate-path orders.
\set oAL1   '\'03870000-0000-0000-0000-000000000201\''
\set oAL2   '\'03870000-0000-0000-0000-000000000202\''
\set oAL6a  '\'03870000-0000-0000-0000-000000000206\''
\set oAL6b  '\'03870000-0000-0000-0000-000000000207\''
\set oRet   '\'03870000-0000-0000-0000-000000000210\''
\set oSvc   '\'03870000-0000-0000-0000-000000000211\''
\set oC1    '\'03870000-0000-0000-0000-000000000221\''
\set oC2    '\'03870000-0000-0000-0000-000000000222\''
\set oCP    '\'03870000-0000-0000-0000-000000000223\''
\set oRO    '\'03870000-0000-0000-0000-000000000224\''
\set oRS    '\'03870000-0000-0000-0000-000000000225\''
\set oCL    '\'03870000-0000-0000-0000-000000000226\''
\set oPS    '\'03870000-0000-0000-0000-000000000227\''
\set oDS    '\'03870000-0000-0000-0000-000000000228\''
\set oPP    '\'03870000-0000-0000-0000-000000000229\''
\set oCLM   '\'03870000-0000-0000-0000-000000000230\''
\set oNB    '\'03870000-0000-0000-0000-000000000231\''
-- Lines.
\set lAL1   '\'03870000-0000-0000-0000-000000000301\''
\set lAL2   '\'03870000-0000-0000-0000-000000000302\''
\set lC1    '\'03870000-0000-0000-0000-000000000321\''
\set lC2    '\'03870000-0000-0000-0000-000000000322\''
\set lCP    '\'03870000-0000-0000-0000-000000000323\''
\set lRO    '\'03870000-0000-0000-0000-000000000324\''
\set lRS    '\'03870000-0000-0000-0000-000000000325\''
\set lCL    '\'03870000-0000-0000-0000-000000000326\''
\set lPS    '\'03870000-0000-0000-0000-000000000327\''
\set lDS    '\'03870000-0000-0000-0000-000000000328\''
\set lPP    '\'03870000-0000-0000-0000-000000000329\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0387-own@test.local',   '{}'::jsonb),
  (:mgr,   '0387-mgr@test.local',   '{}'::jsonb),
  (:req,   '0387-req@test.local',   '{}'::jsonb),
  (:stfAp, '0387-stfap@test.local', '{}'::jsonb),
  (:vwr,   '0387-vwr@test.local',   '{}'::jsonb),
  (:mgrZ,  '0387-mgrz@test.local',  '{}'::jsonb),
  (:apr,   '0387-apr@test.local',   '{}'::jsonb),
  (:apr2,  '0387-apr2@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0387 Guard A', '0387-guard-a'),
  (:orgZ, '0387 Guard Z', '0387-guard-z');
-- apr and apr2 approved an order once and are no longer members (their
-- accounts are the ones deleted in AL6).
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :stfAp, 'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgZ, :mgrZ,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0387 Main', 'WH-0387A', 'active'),
  (:whZ, :orgZ, '0387 Zed',  'WH-0387Z', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0387 Charter', 'CH-0387', 'active');
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:locA, :orgA, :whA, '0387-R1', 'shelf', 'rack');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :req,   :whA, true),
  (:orgA, :stfAp, :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp, 'orders:approve', true);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itG,    :orgA, :whA, '0387-G',    'Guard general', 100, 'active', 'none'),
  (:itAL1,  :orgA, :whA, '0387-AL1',  'Guard approve',  50, 'active', 'none'),
  (:itAL2,  :orgA, :whA, '0387-AL2',  'Guard partial',   5, 'active', 'none'),
  (:itPick, :orgA, :whA, '0387-PICK', 'Guard pick',     20, 'active', 'none'),
  (:itRes,  :orgA, :whA, '0387-RES',  'Guard resume',   30, 'active', 'none');
-- complete_picking draws PLACED stock: itPick's 20 sit on the rack (0244).
delete from public.item_stock_levels where item_id = :itPick;
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :itPick, :locA, 20);

-- Orders, inserted at their status by the superuser (the insert guard holds
-- API roles only; the transition trigger fires on UPDATE only).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id,
   approved_by, approved_at, signature_token, signature_token_expires_at, needed_by) values
  (:oA1,   :orgA, :whA, 'pending_approval',    'internal', :req,  'pickup', null, null,  null,  null, null, null),
  (:oA2,   :orgA, :whA, 'pending_approval',    'internal', :req,  'pickup', null, null,  null,  null, null, null),
  (:oZ1,   :orgZ, :whZ, 'pending_approval',    'internal', :mgrZ, 'pickup', null, null,  null,  null, null, null),
  (:oZ2,   :orgZ, :whZ, 'pending_approval',    'internal', :mgrZ, 'pickup', null, null,  null,  null, null, null),
  (:oZ3,   :orgZ, :whZ, 'pending_approval',    'internal', :mgrZ, 'pickup', null, null,  null,  null, null, null),
  (:oApr,  :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oA6a,  :orgA, :whA, 'pending_approval',    'internal', :req,  'pickup', null, null,  null,  null, null, null),
  (:oA6c,  :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oNote, :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oL11,  :orgA, :whA, 'completed',           'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oAL1,  :orgA, :whA, 'pending_approval',    'internal', :req,  'pickup', null, null,  null,  null, null, null),
  (:oAL2,  :orgA, :whA, 'pending_approval',    'internal', :req,  'pickup', null, null,  null,  null, null, null),
  (:oAL6a, :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :apr,  now(), null, null, null),
  (:oAL6b, :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :apr2, now(), null, null, null),
  (:oRet,  :orgA, :whA, 'completed',           'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oSvc,  :orgA, :whA, 'staged_for_pickup',   'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oC1,   :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oC2,   :orgA, :whA, 'staged_for_pickup',   'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oCP,   :orgA, :whA, 'pick_slip_generated', 'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oRO,   :orgA, :whA, 'picking_complete',    'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oRS,   :orgA, :whA, 'backordered',         'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oCL,   :orgA, :whA, 'backordered',         'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oPS,   :orgA, :whA, 'staged_for_pickup',   'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oDS,   :orgA, :whA, 'staged_for_pickup',   'internal', :req,  'pickup', null, :mgr,  now(),
           repeat('d', 60) || '0387', now() + interval '1 day', null),
  (:oPP,   :orgA, :whA, 'pick_slip_generated', 'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oCLM,  :orgA, :whA, 'pick_slip_generated', 'internal', :req,  'pickup', null, :mgr,  now(), null, null, null),
  (:oNB,   :orgA, :whA, 'approved',            'internal', :req,  'pickup', null, :mgr,  now(), null, null,
           date_trunc('minute', now()) + interval '8 days');

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:lAL1, :oAL1, :itAL1,  10, 0, null),
  (:lAL2, :oAL2, :itAL2,  10, 0, null),
  (:lC1,  :oC1,  :itG,     1, 0, null),
  (:lC2,  :oC2,  :itG,     1, 0, null),
  (:lCP,  :oCP,  :itPick, 10, 0, 10),
  (:lRO,  :oRO,  :itG,     5, 0, null),
  (:lRS,  :oRS,  :itRes,  10, 5, null),
  (:lCL,  :oCL,  :itG,    10, 5, null),
  (:lPS,  :oPS,  :itG,     5, 0, 5),
  (:lDS,  :oDS,  :itG,     5, 0, 5),
  (:lPP,  :oPP,  :itG,     5, 0, null);

-- The 30 edges the transition trigger allows (0289, live def 0965a074), each
-- with its own order at the edge's from-status. Delivery orders carry the
-- charter (order_requests_delivery_target_chk).
create temp table edge (n int primary key, from_s text not null, to_s text not null, allowed boolean not null, ord uuid not null);
insert into edge (n, from_s, to_s, allowed, ord)
select v.n, v.f, v.t, v.a, ('03870000-0000-0000-0000-0000000e' || lpad(v.n::text, 4, '0'))::uuid
  from (values
    ( 1, 'pending_confirmation',   'pending_approval',       false),
    ( 2, 'pending_confirmation',   'cancelled',              false),
    ( 3, 'pending_approval',       'approved',               false),
    ( 4, 'pending_approval',       'denied',                 true),
    ( 5, 'pending_approval',       'cancelled',              false),
    ( 6, 'approved',               'pick_slip_generated',    true),
    ( 7, 'approved',               'cancelled',              false),
    ( 8, 'pick_slip_generated',    'picking_in_progress',    false),
    ( 9, 'pick_slip_generated',    'picking_complete',       false),
    (10, 'pick_slip_generated',    'cancelled',              false),
    (11, 'picking_in_progress',    'picking_complete',       false),
    (12, 'picking_in_progress',    'cancelled',              false),
    (13, 'picking_complete',       'packing_slip_generated', true),
    (14, 'picking_complete',       'picking_in_progress',    false),
    (15, 'picking_complete',       'cancelled',              false),
    (16, 'packing_slip_generated', 'staged_for_pickup',      true),
    (17, 'packing_slip_generated', 'staged_for_delivery',    true),
    (18, 'packing_slip_generated', 'picking_in_progress',    false),
    (19, 'packing_slip_generated', 'cancelled',              false),
    (20, 'staged_for_pickup',      'completed',              false),
    (21, 'staged_for_pickup',      'backordered',            false),
    (22, 'staged_for_pickup',      'cancelled',              false),
    (23, 'staged_for_delivery',    'in_transit',             true),
    (24, 'staged_for_delivery',    'cancelled',              false),
    (25, 'in_transit',             'completed',              false),
    (26, 'in_transit',             'backordered',            false),
    (27, 'in_transit',             'cancelled',              false),
    (28, 'backordered',            'pick_slip_generated',    false),
    (29, 'backordered',            'completed',              false),
    (30, 'backordered',            'cancelled',              false)
  ) v(n, f, t, a);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id)
select e.ord, :orgA, :whA, e.from_s, 'internal', :req,
       case when e.from_s in ('staged_for_delivery', 'in_transit') or e.to_s in ('staged_for_delivery', 'in_transit')
            then 'delivery' else 'pickup' end,
       case when e.from_s in ('staged_for_delivery', 'in_transit') or e.to_s in ('staged_for_delivery', 'in_transit')
            then (:chA)::uuid end
  from edge e;

-- ══ Helpers ═══════════════════════════════════════════════════════════════
-- One statement as p_as with p_sub's claims, then ALWAYS undone: the inner
-- block ends by raising, so its subtransaction (the write, p_prep's grant or
-- policy, and the role and claims set_config switched) is rolled back.
-- 'ok:<rows>[:<p_check>]' when it went through (p_check runs as the superuser
-- inside the same subtransaction, before the undo), else
-- '<sqlstate>:<hint or ->:<message>'.
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
    raise exception using errcode = 'XX387', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX387' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':' || v_msg;
end $$;
-- One statement that returns a value, as p_as, KEPT when it succeeds:
-- '<value>[|<p_check>]' (p_check as the superuser, after the call), else the
-- error as above (the failed statement is rolled back with its subtransaction).
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
    return v_state || ':' || coalesce(nullif(v_hint, ''), '-') || ':' || v_msg;
  end;
  return coalesce(v, 'null') || coalesce('|' || v_seen, '');
end $$;
-- An order's status and approver, read as the superuser.
create function pg_temp.ost(p_id uuid) returns text language sql as $$
  select coalesce((select o.status || '/' || coalesce(o.approved_by::text, 'null') || '/' || (o.approved_at is not null)::text
                     from public.order_requests o where o.id = p_id), 'missing')
$$;
-- A7, one TAP line per edge.
create function pg_temp.edge_tests(p_mgr uuid) returns setof text language plpgsql as $$
declare e record;
begin
  for e in select * from edge order by n loop
    return next is(
      pg_temp.attempt('authenticated', p_mgr,
                      format('update public.order_requests set status = %L where id = %L returning *', e.to_s, e.ord)),
      case when e.allowed then 'ok:1' else '42501:status_through_rpc_only:order_status_through_rpc_only' end,
      format('A7 %s->%s: %s', e.from_s, e.to_s,
             case when e.allowed
                  then 'an edge the app writes through the user client goes through for a manager, with RETURNING * (A-L4)'
                  else 'an RPC-owned edge is refused for a manager: 42501 status_through_rpc_only' end));
  end loop;
end $$;

-- ══ A. Attacks ════════════════════════════════════════════════════════════
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$update public.order_requests set status = 'approved' where id = %L returning status$q$, :oA1)),
  '42501:status_through_rpc_only:order_status_through_rpc_only',
  'A1: a manager''s raw PATCH {"status":"approved"} on a pending order is refused: 42501 status_through_rpc_only (no stock check, no holds, no audit)');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$update public.order_requests set status = 'approved', approved_by = %L, approved_at = now()
                                                 where id = %L returning status$q$, :mgr, :oA1)),
  '42501:-:permission denied for table order_requests',
  'A1b: the same PATCH carrying approved_by and approved_at is refused by the column privilege (42501 permission denied)');
select is(
  pg_temp.call_as('authenticated', :stfAp, format($q$update public.order_requests set status = 'approved' where id = %L returning status$q$, :oA2)),
  '42501:status_through_rpc_only:order_status_through_rpc_only',
  'A2: a staff member granted orders:approve sending the same PATCH is refused: 42501 status_through_rpc_only');
select is(
  pg_temp.ost(:oA1) || ' ' || pg_temp.ost(:oA2),
  'pending_approval/null/false pending_approval/null/false',
  'A2b: A1, A1b and A2 changed nothing: both orders are still pending, with no approver and no approval time');
select is(
  pg_temp.call_as('authenticated', :mgrZ, $q$update public.order_requests set status = 'approved' where status = 'pending_approval' returning status$q$),
  '42501:status_through_rpc_only:order_status_through_rpc_only',
  'A3: a bulk PATCH with no id filter (every pending order the manager can reach) is refused: 42501 status_through_rpc_only');
select is(
  (select string_agg(pg_temp.ost(o), ' ' order by o) from unnest(array[:oZ1, :oZ2, :oZ3]::uuid[]) o),
  'pending_approval/null/false pending_approval/null/false pending_approval/null/false',
  'A3b: the bulk PATCH changed no row: all three of the org''s pending orders are still pending');

select is(
  has_column_privilege('authenticated', 'public.order_requests', 'approved_by', 'UPDATE')::text || ','
  || has_column_privilege('authenticated', 'public.order_requests', 'approved_at', 'UPDATE')::text,
  'false,false',
  'A4: authenticated holds no UPDATE on approved_by or approved_at');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set approved_by = %L where id = %L', :stfAp, :oApr)),
  '42501:-:permission denied for table order_requests',
  'A4b: forging approved_by on an approved order is refused by the column privilege');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set approved_by = %L where id = %L', :stfAp, :oApr),
                  'grant update (approved_by) on table public.order_requests to authenticated'),
  '42501:approval_through_rpc_only:order_approval_through_rpc_only',
  'A4c: with UPDATE (approved_by) granted back (inside the undone subtransaction), the guard alone still refuses the forgery: 42501 approval_through_rpc_only');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set approved_at = now() - interval '1 day' where id = %L$q$, :oApr),
                  'grant update (approved_at) on table public.order_requests to authenticated'),
  '42501:approval_through_rpc_only:order_approval_through_rpc_only',
  'A4d: with UPDATE (approved_at) granted back, the guard alone still refuses backdating the approval: 42501 approval_through_rpc_only');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set approved_by = null where id = %L', :oApr)),
  '42501:-:permission denied for table order_requests',
  'A5: clearing approved_by is refused by the column privilege');
select is(
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set approved_by = null where id = %L', :oApr),
                  'grant update (approved_by) on table public.order_requests to authenticated'),
  '42501:approval_through_rpc_only:order_approval_through_rpc_only',
  'A5b: with UPDATE (approved_by) granted back, the guard alone still refuses clearing it: 42501 approval_through_rpc_only');
select is(
  pg_temp.ost(:oApr) || '|' || has_column_privilege('authenticated', 'public.order_requests', 'approved_by', 'UPDATE')::text
  || ',' || has_column_privilege('authenticated', 'public.order_requests', 'approved_at', 'UPDATE')::text,
  'approved/' || :mgr || '/true|false,false',
  'A5c: after A4 and A5 the approver is unchanged and none of the test grants survived its subtransaction');

select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
                            values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup')
                            on conflict (id) do update set status = 'approved'$q$, :oA6a, :orgA, :whA, :mgr)),
  '42501:status_through_rpc_only:order_status_through_rpc_only',
  'A6: an upsert (INSERT .. ON CONFLICT DO UPDATE SET status = approved) on a pending order passes the insert guard and is refused by the update guard');
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, approved_by)
                            values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup', %L)
                            on conflict (id) do update set approved_by = excluded.approved_by$q$, :oApr, :orgA, :whA, :mgr, :stfAp)),
  '42501:-:permission denied for table order_requests',
  'A6b: an upsert that sets approved_by on conflict is refused by the column privilege');
select is(
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
                            values (%L, %L, %L, 'pending_approval', 'internal', %L, 'pickup')
                            on conflict (id) do update set status = excluded.status$q$, :oA6c, :orgA, :whA, :mgr)),
  'P0001:-:invalid_status_transition',
  'A6c: an upsert moving an approved order back to pending_approval is refused by the transition trigger, which fires before the guard');

select * from pg_temp.edge_tests(:mgr);
select is(
  (select md5(p.prosrc) from pg_proc p where p.oid = 'public._validate_order_request_status_transition()'::regprocedure),
  'dee8cd4782ec83abdb31a2b48fcd4ef2',
  'A7b: the transition trigger is still 0289''s body, so A7''s 30 edges are every edge it allows (a new edge fails here and must be classified in the guard''s allowlist)');

select is(
  (select string_agg(c || '=' || pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set %I = %I where id = %L', c, c, :oApr)),
                     E'\n' order by c collate "C")
     from unnest(array['approved_by', 'approved_at', 'cancelled_at', 'cancelled_by', 'assigned_picker_id', 'picking_claimed_at',
                       'picking_claimed_by', 'picking_completed_at', 'picking_completed_by', 'signed_by_name', 'signed_by_email',
                       'signature_data_url', 'signature_method', 'signed_at', 'completed_at', 'completed_by', 'return_token',
                       'return_prompt_sent_at', 'public_track_token', 'confirmation_token_hash', 'confirmation_token_expires_at']) c),
  (select string_agg(c || '=42501:-:permission denied for table order_requests', E'\n' order by c collate "C")
     from unnest(array['approved_by', 'approved_at', 'cancelled_at', 'cancelled_by', 'assigned_picker_id', 'picking_claimed_at',
                       'picking_claimed_by', 'picking_completed_at', 'picking_completed_by', 'signed_by_name', 'signed_by_email',
                       'signature_data_url', 'signature_method', 'signed_at', 'completed_at', 'completed_by', 'return_token',
                       'return_prompt_sent_at', 'public_track_token', 'confirmation_token_hash', 'confirmation_token_expires_at']) c),
  'A8a: a raw write of each of the 21 columns only the order RPCs or the admin client write is 42501 permission denied');
select is(
  (select string_agg(c || '=' || pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set %I = %I where id = %L', c, c, :oApr)),
                     E'\n' order by c collate "C")
     from unnest(array['id', 'order_number', 'source', 'customer_id', 'needed_by', 'requester_user_id', 'requester_email',
                       'requester_name', 'requester_phone', 'requester_org_label', 'fulfillment_type', 'pickup_location_notes',
                       'notes', 'delivered_at', 'packaging_at', 'ready_at', 'updated_at']) c),
  (select string_agg(c || '=42501:-:permission denied for table order_requests', E'\n' order by c collate "C")
     from unnest(array['id', 'order_number', 'source', 'customer_id', 'needed_by', 'requester_user_id', 'requester_email',
                       'requester_name', 'requester_phone', 'requester_org_label', 'fulfillment_type', 'pickup_location_notes',
                       'notes', 'delivered_at', 'packaging_at', 'ready_at', 'updated_at']) c),
  'A8b: a raw write of each of the 17 columns no user-client path writes (owner decision O5) is 42501 permission denied');

select is(
  (select string_agg(p || '=' || has_table_privilege('anon', 'public.order_requests', p)::text, ',' order by p collate "C")
     from unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p)
  || '|' ||
  (select string_agg(p || '=' || has_any_column_privilege('anon', 'public.order_requests', p)::text, ',' order by p collate "C")
     from unnest(array['INSERT', 'REFERENCES', 'SELECT', 'UPDATE']) p),
  'DELETE=false,INSERT=false,MAINTAIN=false,REFERENCES=false,SELECT=false,TRIGGER=false,TRUNCATE=false,UPDATE=false'
  '|INSERT=false,REFERENCES=false,SELECT=false,UPDATE=false',
  'A9a: anon holds no table privilege and no column privilege on order_requests');
select is(
  pg_temp.attempt('anon', null, 'select 1 from public.order_requests limit 1')
  || ' | ' || pg_temp.attempt('anon', null, format($q$update public.order_requests set status = 'approved' where id = %L$q$, :oA1)),
  '42501:-:permission denied for table order_requests | 42501:-:permission denied for table order_requests',
  'A9b: anon reading or writing order_requests is 42501 permission denied (it had every privilege, stopped only by RLS)');
select is(
  (select string_agg(p || '=' || has_table_privilege('authenticated', 'public.order_requests', p)::text, ',' order by p collate "C")
     from unnest(array['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']) p)
  || '|REFERENCES(any column)=' || has_any_column_privilege('authenticated', 'public.order_requests', 'REFERENCES')::text,
  'DELETE=true,INSERT=true,MAINTAIN=false,REFERENCES=false,SELECT=true,TRIGGER=false,TRUNCATE=false,UPDATE=false|REFERENCES(any column)=false',
  'A9c: authenticated holds no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN and no table UPDATE, and keeps table SELECT, INSERT and DELETE');
select is(
  (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.order_requests'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.order_requests', a.attname, 'UPDATE')),
  'assigned_delivery_at,assigned_delivery_by,assigned_delivery_user_id,created_at,delivery_charter_id,denied_reason,'
  'in_transit_at,in_transit_by,internal_notes,packing_slip_generated_at,packing_slip_generated_by,pick_slip_generated_at,'
  'pick_slip_generated_by,signature_token,signature_token_expires_at,staged_at,staged_by,status,warehouse_id',
  'A9d: authenticated may UPDATE exactly the 19 columns the user client writes plus the owner questions'' three (created_at and warehouse_id: Q4; delivery_charter_id: Q7)');

select is(
  (select string_agg(distinct m[1], ',')
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.tg_order_requests_workflow_guard()'::regprocedure)
  || '/' ||
  (select (p.prosrc !~* '40001|40p01|serialization_failure|deadlock_detected')::text
     from pg_proc p where p.oid = 'public.tg_order_requests_workflow_guard()'::regprocedure),
  '42501/true',
  'A10: the guard raises 42501 only, never 40001 or 40P01 (PostgREST retries those forever)');

-- ══ AL. Legitimate paths ══════════════════════════════════════════════════
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.approve_order_request(%L) r', :oAL1),
                  format($q$select (o.approved_by = %L)::text || '/' || (o.approved_at is not null)::text || '/'
                                   || (select count(*) || 'x' || coalesce(sum(r.quantity), 0)::int
                                         from public.stock_reservations r where r.order_request_id = o.id and r.released_at is null)
                              from public.order_requests o where o.id = %L$q$, :mgr, :oAL1)),
  'approved|true/true/1x10',
  'AL1: approve_order_request (a manager) approves, stamps auth.uid() and now(), and holds the 10 units');
select is(
  pg_temp.call_as('authenticated', :stfAp, format('select r.status from public.approve_partial(%L) r', :oAL2),
                  format($q$select (o.approved_by = %L)::text || '/' || (o.approved_at is not null)::text || '/'
                                   || (select count(*) || 'x' || coalesce(sum(r.quantity), 0)::int
                                         from public.stock_reservations r where r.order_request_id = o.id and r.released_at is null)
                              from public.order_requests o where o.id = %L$q$, :stfAp, :oAL2)),
  'approved|true/true/1x5',
  'AL2: approve_partial (a staff member granted orders:approve) approves, stamps the approver and holds the 5 available units');

select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set internal_notes = 'Gate code 12' where id = %L returning *$q$, :oNote),
                  null, format('select internal_notes from public.order_requests where id = %L', :oNote)),
  'ok:1:Gate code 12',
  'AL5: a notes save on an approved order goes through (the guard keys on the edge, never the value)');
select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set status = 'approved', internal_notes = 'Gate code 13' where id = %L returning *$q$, :oNote),
                  null, format($q$select status || '/' || internal_notes from public.order_requests where id = %L$q$, :oNote)),
  'ok:1:approved/Gate code 13',
  'AL5b: a PATCH that re-sends an approved order''s own status with a note goes through (a same-status write is no edge)');

select is(
  pg_temp.call_as('postgres', null, format('delete from public.user_profiles where id = %L returning id::text', :apr),
                  format($q$select coalesce(approved_by::text, 'null') || '/' || status from public.order_requests where id = %L$q$, :oAL6a)),
  :apr || '|null/approved',
  'AL6: deleting an approver''s user_profiles row (account deletion) nulls approved_by through the FK and raises nothing; the order stays approved');
select is(
  pg_temp.attempt('authenticated', :mgr, format('delete from public.user_profiles where id = %L', :apr2),
                  format('create policy zz_0387_probe on public.user_profiles for all to authenticated using (id = %L)', :apr2),
                  format($q$select coalesce(approved_by::text, 'null') || '/' || status from public.order_requests where id = %L$q$, :oAL6b)),
  'ok:1:null/approved',
  'AL6b: the same deletion with the deleting session''s role authenticated (a probe policy lets it delete) still nulls approved_by: the FK action runs as the table owner, not as the caller');

select is(
  pg_temp.attempt('service_role', null,
                  format('update public.order_requests set return_token = gen_random_uuid() where id = %L and return_token is null returning return_token', :oRet)),
  'ok:1',
  'AL7: the return prompt''s guarded token mint (admin client, service_role) still writes return_token');
select is(
  pg_temp.attempt('service_role', null,
                  format('update public.order_requests set return_prompt_sent_at = now() where id = %L and return_prompt_sent_at is null returning id', :oRet)),
  'ok:1',
  'AL7b: the return prompt''s send claim (service_role) still writes return_prompt_sent_at');
select is(
  pg_temp.attempt('service_role', null, format($q$update public.order_requests set status = 'completed' where id = %L$q$, :oSvc)),
  'ok:1',
  'AL7c: the guard holds the API roles only: service_role (the server''s admin client) is not refused an edge it refuses for authenticated');

select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.cancel_order_request(%L, 'Not needed') r$q$, :oC1)),
  'cancelled',
  'AL8a: cancel_order_request (DEFINER) still cancels an approved order');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.cancel_order_request(%L, 'Not collected') r$q$, :oC2)),
  'cancelled',
  'AL8b: cancel_order_request still cancels a staged order');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.complete_picking(%L) r', :oCP)),
  'picking_complete',
  'AL8c: complete_picking (DEFINER) still completes picking (and draws the placed stock)');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.reopen_picking(%L, 'Miscount') r$q$, :oRO)),
  'picking_in_progress',
  'AL8d: reopen_picking (DEFINER) still sends a picked order back to picking');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.resume_fulfillment(%L) r', :oRS)),
  'pick_slip_generated',
  'AL8e: resume_fulfillment (DEFINER) still resumes a backordered order');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.close_partial(%L) r', :oCL)),
  'completed',
  'AL8f: close_partial (DEFINER) still closes a backordered order');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.confirm_physical_signature(%L, 'Paper Signer') r$q$, :oPS)),
  'completed',
  'AL8g: confirm_physical_signature (DEFINER) still records a paper hand-over (and writes the revoked signature columns)');
select is(
  pg_temp.call_as('service_role', null,
                  format($q$select (public.confirm_order_signature(%L, %L, 'Pat Signer', 'pat@example.com', 'data:image/png;base64,AAAA') = %L)::text$q$,
                         :oDS, repeat('d', 60) || '0387', :orgA),
                  format('select status || ''/'' || signature_method from public.order_requests where id = %L', :oDS)),
  'true|completed/digital',
  'AL8h: confirm_order_signature (DEFINER, service_role only: the sign route) still records a digital hand-over');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select 'ok' from public.partial_pick_line(%L, 2)$q$, :lPP),
                  format('select status || ''/'' || (assigned_picker_id = %L)::text from public.order_requests where id = %L', :mgr, :oPP)),
  'ok|picking_in_progress/true',
  'AL8i: partial_pick_line (DEFINER) still starts picking and writes assigned_picker_id (revoked from authenticated)');
select is(
  pg_temp.call_as('authenticated', :mgr, format('select (r.picking_claimed_by = %L)::text || ''/'' || (r.picking_claimed_at is not null)::text from public.claim_picking(%L) r', :mgr, :oCLM)),
  'true/true',
  'AL8j: claim_picking (DEFINER) still writes picking_claimed_by and picking_claimed_at (revoked from authenticated)');
select is(
  pg_temp.call_as('authenticated', :stfAp,
                  format($q$select r->>'changed' from public.revise_order_needed_by(%L, date_trunc('minute', now()) + interval '9 days',
                                   (select o.needed_by from public.order_requests o where o.id = %L), 'Moved by the school', null) r$q$, :oNB, :oNB),
                  format($q$select (needed_by = date_trunc('minute', now()) + interval '9 days')::text from public.order_requests where id = %L$q$, :oNB)),
  'true|true',
  'AL8k: revise_order_needed_by (DEFINER, a staff approver) still changes needed_by (revoked from authenticated under O5)');

select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname || '.' || p.proname collate "C"), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger', 'private')
      and p.prosrc ~* $re$update\s+(only\s+)?("?public"?\s*\.\s*)?"?order_requests\M"?$re$
      and p.prosrc ~* $re$status\s*=\s*'approved'|approved_by\s*=|approved_at\s*=$re$),
  'public.approve_order_request,public.approve_partial',
  'AL9a: only approve_order_request and approve_partial assign status approved, approved_by or approved_at in a function that updates order_requests');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname || '.' || p.proname collate "C"), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger', 'private') and not p.prosecdef
      and p.prosrc ~* $re$update\s+(only\s+)?("?public"?\s*\.\s*)?"?order_requests\M"?$re$),
  '',
  'AL9b: no SECURITY INVOKER function updates order_requests (schema prefix optional), so no API-role writer needs a flag; a new one fails here');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ',' order by n.nspname || '.' || p.proname collate "C"), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'ledger', 'private') and p.prosecdef
      and p.prosrc ~* $re$update\s+(only\s+)?("?public"?\s*\.\s*)?"?order_requests\M"?$re$
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))),
  'public.approve_order_request,public.approve_partial,public.assign_picking,public.cancel_order_request,public.claim_picking,'
  'public.close_partial,public.complete_picking,public.confirm_physical_signature,public.partial_pick_line,public.release_picking,'
  'public.reopen_picking,public.resume_fulfillment,public.revise_order_needed_by',
  'AL9c: the SECURITY DEFINER writers of order_requests an API role may execute are exactly these 13 (each bypasses the guard by design: a new one fails here and is reviewed for its own gate)');

select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
     from pg_proc p where p.oid = to_regprocedure('public.tg_order_requests_workflow_guard()')),
  '59481b7651dca818a2266a39868db4f0|false|{search_path=public}|postgres|false|false|false',
  'AL10a: the guard is 0387''s body, SECURITY INVOKER (a DEFINER trigger would always see postgres), search_path pinned, owned by postgres, and not executable by PUBLIC, anon or authenticated');
select is(
  (select t.tgtype::text || '|' || t.tgenabled::text || '|' || t.tgfoid::regproc::text
     from pg_trigger t where t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'trg_order_requests_workflow_guard'),
  '19|O|tg_order_requests_workflow_guard',
  'AL10b: trg_order_requests_workflow_guard is BEFORE UPDATE FOR EACH ROW (every column, not UPDATE OF), enabled, and runs the guard');
select is(
  (select array_agg(t.tgname::text order by t.tgname)
     from pg_trigger t
    where t.tgrelid = 'public.order_requests'::regclass and not t.tgisinternal
      and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16),
  array['order_requests_set_updated_at', 'trg_order_requests_validate_transition', 'trg_order_requests_workflow_guard'],
  'AL10c: the BEFORE UPDATE row triggers fire in this order (by name): the transition trigger before the guard');
select is(
  (select md5(string_agg(t.tgname::text || '|' || t.tgfoid::regproc::text || '|' || t.tgenabled::text || '|' || t.tgtype::text, E'\n' order by t.tgname))
          || '|' || count(*)
     from pg_trigger t where t.tgrelid = 'public.order_requests'::regclass and not t.tgisinternal),
  'dc435bd583fc39db07353311079239b4|6',
  'AL10d: order_requests carries exactly its five earlier triggers plus the guard (census e6ea64a2...|5 plus one row)');
select is(
  coalesce(obj_description('public.tg_order_requests_workflow_guard()'::regprocedure, 'pg_proc') ~ '0387', false)::text || ','
  || coalesce(col_description('public.order_requests'::regclass,
                (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'approved_by'))
              ~ '0387', false)::text,
  'true,true',
  'AL10e: the guard and order_requests.approved_by say in their comments what 0387 enforces');
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef::text, E'\n' order by p.oid::regprocedure::text collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('approve_order_request', 'approve_partial', 'tg_order_requests_insert_guard')),
  E'approve_order_request(uuid)|96e5f7c8b4cdd6b7e4ffcc994c9ed642|true\n'
  'approve_partial(uuid)|64bb847ffc8681adeed4b881c1b6a4ab|true\n'
  'tg_order_requests_insert_guard()|1b109d535811e9a21c43d01dcc344892|false',
  'AL10f: approve_order_request, approve_partial and the insert guard are unchanged (0387 edits no body; the 0377/0378/0383/0385 pins hold)');

select is(
  pg_temp.attempt('authenticated', :mgr, format($q$update public.order_requests set status = 'approved' where id = %L$q$, :oL11)),
  'P0001:-:invalid_status_transition',
  'AL11: an illegal edge (completed -> approved) still reports invalid_status_transition: the transition trigger fires before the guard (0243 keeps passing)');

select * from finish();
rollback;
