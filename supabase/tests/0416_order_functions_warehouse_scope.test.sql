-- supabase/tests/0416_order_functions_warehouse_scope.test.sql
-- pgTAP proof for migration 0416 (security slice E): the six order functions
-- that asked orders:approve alone now ask write access to the order's
-- warehouse too (cancel: on the approver's path only), and cancel no longer
-- lets anyone cancel a pending order that has no requester account, nor the
-- person who placed one cancel it once they may no longer place orders in
-- its organization. Written to fail against the head before it (0401 when it
-- was written, 0414 at the renumber) in every section but P, G and the
-- fixture checks; the M-section shows it on the live bodies. C5, C6, P3 and
-- M9 came with the requester's permission term (review, 2026-11-01) and were
-- seen failing on the body before it.
--
-- Written and reviewed as 0405, renumbered 0416 on 2026-10-31 (0413, 0414
-- and 0415 ship first). The migration moved byte for byte, so its text still
-- says 0405: its header line, the lock footprint script's old path in a
-- comment (now scripts/db-concurrency/0416_migration_lock_footprint.sh) and
-- the six function comments. No check here reads that number: P2 is keyed on
-- the words of the rule, and R1-R6 strip the blocks tagged "Slice E".
--
-- Personas (one org, plus a second org and a signed-in nobody):
--   own    owner                 adm    admin
--   mgr    manager, no assignment (works in every warehouse by role)
--   mgrNo  manager, orders:approve revoked
--   stfAp  staff assigned to warehouse A, granted orders:approve: the scoped
--          approver this slice is about
--   stfAB  staff assigned to A and B, granted orders:approve (the 0280
--          all-warehouses flag is one assignment row per warehouse)
--   vwrAp  viewer assigned to A, granted orders:approve
--   req    staff (A), the requester of the fixture orders, no approve
--   stf    staff (A), no approve      vwr  viewer (A)
--   outZ   a manager of another organization
--   nobody signed in, a member of no organization
--   Warehouse B is the other warehouse of the same organization.
-- C5 and C6's requesters (not in the persona table, so F1 and F2 read as
-- before), each the requester of a pending order placed while they could:
--   rmv    staff (A) removed from the organization; still staff of orgZ
--   dis    staff (A) whose account was disabled
--   noRq   staff (A), orders:request revoked
--   apNoRq staff assigned to A, granted orders:approve, orders:request revoked
--   ptl    a B2B portal customer of the organization (customer_users, never
--          a member), the requester of a portal order
--
-- F.  The personas hold what the matrices assume: their permissions, and
--     write access as user_can_access_warehouse answers it; C5 and C6's
--     requesters' membership and permissions (F3).
-- R.  One change per body: md5(prosrc) is slice E's and removing the added
--     text gives production's body exactly (R1-R6).
-- P.  The six keep their posture (arguments, result, volatility, SECURITY
--     DEFINER, SET clauses, owner, EXECUTE); each comment says the rule, and
--     cancel's says the requester's (P3).
-- W.  Per function, on an order of warehouse B and one of warehouse A: the
--     scoped approver and the viewer approver are refused on B (42501, hint
--     warehouse_write); the scoped approver passes on A; an approver assigned
--     to B, a manager with no assignment, the admin and the owner pass on B;
--     a revoked manager and another organization's manager are refused by
--     the permission gate as before (no hint).
-- C.  cancel_order_request: the requester's own pending order asks no
--     warehouse (an approver's own request included); the approver's own
--     order once approved does (the race's end state: decided on the locked
--     row); an order with no requester account (public link, deleted account)
--     is cancelled by no one but an approver, in their warehouses; the
--     requester's cancel asks orders:request of the person who placed the
--     order, which a removed member, a disabled account, a revoked member and
--     a portal customer do not hold (C5), and an approver without it cancels
--     only as an approver (C6).
-- M.  Mutations: each added block taken out of the live body (inside an
--     undone attempt) lets the refused call through, so the W and C lines
--     are not tautological.
-- G.  No body names 40001 or 40P01.
-- Z.  Every undone attempt changed nothing.
--
-- Two sessions (a cancel waiting on an order that another session approves
-- under its lock) need two connections: scripts/db-concurrency/
-- 0416_cancel_scope_race.sh.
--
-- Roles: fixtures as the test superuser. Every attempt runs through
-- pg_temp.attempt (always undone), which switches role and claims with
-- set_config inside a subtransaction (the 0387 helpers), so the pgTAP
-- bookkeeping never runs as an API role. begin/rollback: nothing leaks.
-- Namespace 04160000.

begin;

select plan(41);

\set orgA    '\'04160000-0000-0000-0000-00000000000a\''
\set orgZ    '\'04160000-0000-0000-0000-00000000000b\''
\set own     '\'04160000-0000-0000-0000-0000000000a0\''
\set adm     '\'04160000-0000-0000-0000-0000000000a1\''
\set mgr     '\'04160000-0000-0000-0000-0000000000a2\''
\set mgrNo   '\'04160000-0000-0000-0000-0000000000a3\''
\set stfAp   '\'04160000-0000-0000-0000-0000000000a4\''
\set stfAB   '\'04160000-0000-0000-0000-0000000000a5\''
\set vwrAp   '\'04160000-0000-0000-0000-0000000000a6\''
\set req     '\'04160000-0000-0000-0000-0000000000a7\''
\set stf     '\'04160000-0000-0000-0000-0000000000a8\''
\set vwr     '\'04160000-0000-0000-0000-0000000000a9\''
\set outZ    '\'04160000-0000-0000-0000-0000000000b1\''
\set nobody  '\'04160000-0000-0000-0000-0000000000c1\''
\set whA     '\'04160000-0000-0000-0000-0000000000d1\''
\set whB     '\'04160000-0000-0000-0000-0000000000d2\''
\set whZ     '\'04160000-0000-0000-0000-0000000000d3\''
\set itA     '\'04160000-0000-0000-0000-0000000000e1\''
\set itB     '\'04160000-0000-0000-0000-0000000000e2\''
\set oApA    '\'04160000-0000-0000-0000-000000000101\''
\set oApB    '\'04160000-0000-0000-0000-000000000102\''
\set oBkA    '\'04160000-0000-0000-0000-000000000103\''
\set oBkB    '\'04160000-0000-0000-0000-000000000104\''
\set oPcA    '\'04160000-0000-0000-0000-000000000105\''
\set oPcB    '\'04160000-0000-0000-0000-000000000106\''
\set oAppA   '\'04160000-0000-0000-0000-000000000107\''
\set oAppB   '\'04160000-0000-0000-0000-000000000108\''
\set oOwnPB  '\'04160000-0000-0000-0000-000000000109\''
\set oOwnAB  '\'04160000-0000-0000-0000-00000000010a\''
\set oOwnAA  '\'04160000-0000-0000-0000-00000000010b\''
\set oNulA   '\'04160000-0000-0000-0000-00000000010c\''
\set oNulB   '\'04160000-0000-0000-0000-00000000010d\''
\set oDelA   '\'04160000-0000-0000-0000-00000000010e\''
\set oPc0B   '\'04160000-0000-0000-0000-00000000010f\''
-- The requesters who may no longer place orders in orgA (C5, C6), kept out
-- of the persona table so F1 and F2 read as before.
\set rmv     '\'04160000-0000-0000-0000-0000000000aa\''
\set dis     '\'04160000-0000-0000-0000-0000000000ab\''
\set noRq    '\'04160000-0000-0000-0000-0000000000ac\''
\set apNoRq  '\'04160000-0000-0000-0000-0000000000ad\''
\set oRmvA   '\'04160000-0000-0000-0000-000000000110\''
\set oDisA   '\'04160000-0000-0000-0000-000000000111\''
\set oNoRqA  '\'04160000-0000-0000-0000-000000000112\''
\set oApNqB  '\'04160000-0000-0000-0000-000000000113\''
\set oApNqA  '\'04160000-0000-0000-0000-000000000114\''
\set ptl     '\'04160000-0000-0000-0000-0000000000ae\''
\set cusA    '\'04160000-0000-0000-0000-0000000000f1\''
\set oPtlA   '\'04160000-0000-0000-0000-000000000115\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0416-own@test.local',    '{}'::jsonb),
  (:adm,    '0416-adm@test.local',    '{}'::jsonb),
  (:mgr,    '0416-mgr@test.local',    '{}'::jsonb),
  (:mgrNo,  '0416-mgrno@test.local',  '{}'::jsonb),
  (:stfAp,  '0416-stfap@test.local',  '{}'::jsonb),
  (:stfAB,  '0416-stfab@test.local',  '{}'::jsonb),
  (:vwrAp,  '0416-vwrap@test.local',  '{}'::jsonb),
  (:req,    '0416-req@test.local',    '{}'::jsonb),
  (:stf,    '0416-stf@test.local',    '{}'::jsonb),
  (:vwr,    '0416-vwr@test.local',    '{}'::jsonb),
  (:outZ,   '0416-outz@test.local',   '{}'::jsonb),
  (:nobody, '0416-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0416 Scope A', '0416-scope-a'),
  (:orgZ, '0416 Scope Z', '0416-scope-z');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :adm,   'admin',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :mgrNo, 'manager', now()),
  (:orgA, :stfAp, 'staff',   now()),
  (:orgA, :stfAB, 'staff',   now()),
  (:orgA, :vwrAp, 'viewer',  now()),
  (:orgA, :req,   'staff',   now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgZ, :outZ,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0416 Main',  'WH-0416A', 'active'),
  (:whB, :orgA, '0416 Annex', 'WH-0416B', 'active'),
  (:whZ, :orgZ, '0416 Zed',   'WH-0416Z', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stfAp, :whA, true),
  (:orgA, :stfAB, :whA, true),
  (:orgA, :stfAB, :whB, false),
  (:orgA, :vwrAp, :whA, true),
  (:orgA, :req,   :whA, true),
  (:orgA, :stf,   :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNo, 'orders:approve', false),
  (:orgA, :stfAp, 'orders:approve', true),
  (:orgA, :stfAB, 'orders:approve', true),
  (:orgA, :vwrAp, 'orders:approve', true);

-- reopen_picking puts a reversed draw into the warehouse's Unplaced bucket.
select public.ensure_warehouse_placement_locations(:whA) as "ensA" \gset
select public.ensure_warehouse_placement_locations(:whB) as "ensB" \gset

-- Opening stock lands in each warehouse's Unplaced bucket (tg_seed_initial_level).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itA, :orgA, :whA, '0416-A', 'Main item',  100, 'active', 'none'),
  (:itB, :orgA, :whB, '0416-B', 'Annex item',  50, 'active', 'none');

-- Orders at their status, inserted by the superuser (the insert guard holds
-- API roles only; the transition trigger fires on UPDATE only). oNul* came
-- through a public link (no requester account); oDelA's requester deleted
-- their account (0388 nulls requester_user_id and stamps requester_deleted_at).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, requester_email,
   requester_deleted_at, fulfillment_type, approved_by, approved_at) values
  (:oApA,   :orgA, :whA, 'pending_approval',  'internal',    :req,   null,        null,                null,  'pickup', null, null),
  (:oApB,   :orgA, :whB, 'pending_approval',  'internal',    :req,   null,        null,                null,  'pickup', null, null),
  (:oBkA,   :orgA, :whA, 'backordered',       'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oBkB,   :orgA, :whB, 'backordered',       'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oPcA,   :orgA, :whA, 'picking_complete',  'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oPcB,   :orgA, :whB, 'picking_complete',  'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oPc0B,  :orgA, :whB, 'picking_complete',  'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oAppA,  :orgA, :whA, 'approved',          'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oAppB,  :orgA, :whB, 'approved',          'internal',    :req,   null,        null,                null,  'pickup', :mgr, now()),
  (:oOwnPB, :orgA, :whB, 'pending_approval',  'internal',    :stfAp, null,        null,                null,  'pickup', null, null),
  (:oOwnAB, :orgA, :whB, 'approved',          'internal',    :stfAp, null,        null,                null,  'pickup', :mgr, now()),
  (:oOwnAA, :orgA, :whA, 'approved',          'internal',    :stfAp, null,        null,                null,  'pickup', :mgr, now()),
  (:oNulA,  :orgA, :whA, 'pending_approval',  'public_link', null,   'Pat Buyer', 'pat@0416.test',     null,  'pickup', null, null),
  (:oNulB,  :orgA, :whB, 'pending_approval',  'public_link', null,   'Pat Buyer', 'pat@0416.test',     null,  'pickup', null, null),
  (:oDelA,  :orgA, :whA, 'pending_approval',  'internal',    null,   'Lee Gone',  null,                now(), 'pickup', null, null);

insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:oApA,   :itA, 1, 0, null),
  (:oApB,   :itB, 1, 0, null),
  (:oBkA,   :itA, 4, 2, null),
  (:oBkB,   :itB, 4, 2, null),
  (:oPcA,   :itA, 2, 0, 2),
  (:oPcB,   :itB, 2, 0, 2),
  (:oPc0B,  :itB, 2, 0, 0),
  (:oAppA,  :itA, 1, 0, null),
  (:oAppB,  :itB, 1, 0, null),
  (:oOwnPB, :itB, 1, 0, null),
  (:oOwnAB, :itB, 1, 0, null),
  (:oOwnAA, :itA, 1, 0, null),
  (:oNulA,  :itA, 1, 0, null),
  (:oNulB,  :itB, 1, 0, null),
  (:oDelA,  :itA, 1, 0, null);

-- C5 and C6: requesters who may no longer place orders in orgA. Each placed a
-- pending order while they could. rmv also works in orgZ, so removing them
-- from orgA leaves their session alive (TeamService.removeMember revokes
-- sessions only when the last membership goes, and a removed member can sign
-- in again); dis is disabled, whose access token stays valid until it
-- expires; noRq has orders:request revoked; apNoRq approves orders in
-- warehouse A and has orders:request revoked. ptl is a B2B portal customer's
-- account: mapped to orgA's customer through customer_users, never a member
-- (0250), and the requester of the portal order they placed (0251).
insert into auth.users (id, email, raw_user_meta_data) values
  (:rmv,    '0416-rmv@0416.test',     '{}'::jsonb),
  (:dis,    '0416-dis@0416.test',     '{}'::jsonb),
  (:noRq,   '0416-norq@0416.test',    '{}'::jsonb),
  (:apNoRq, '0416-apnorq@0416.test',  '{}'::jsonb),
  (:ptl,    '0416-ptl@0416.test',     '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :rmv,    'staff', now()),
  (:orgA, :dis,    'staff', now()),
  (:orgA, :noRq,   'staff', now()),
  (:orgA, :apNoRq, 'staff', now()),
  (:orgZ, :rmv,    'staff', now());
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :rmv,    :whA, true),
  (:orgA, :dis,    :whA, true),
  (:orgA, :noRq,   :whA, true),
  (:orgA, :apNoRq, :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :noRq,   'orders:request', false),
  (:orgA, :apNoRq, 'orders:request', false),
  (:orgA, :apNoRq, 'orders:approve', true);
insert into public.customers (id, organization_id, name) values
  (:cusA, :orgA, '0416 Customer');
insert into public.customer_users (customer_id, user_id, email, accepted_at) values
  (:cusA, :ptl, '0416-ptl@0416.test', now());
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, customer_id, fulfillment_type) values
  (:oRmvA,  :orgA, :whA, 'pending_approval', 'internal', :rmv,    null,  'pickup'),
  (:oDisA,  :orgA, :whA, 'pending_approval', 'internal', :dis,    null,  'pickup'),
  (:oNoRqA, :orgA, :whA, 'pending_approval', 'internal', :noRq,   null,  'pickup'),
  (:oApNqB, :orgA, :whB, 'pending_approval', 'internal', :apNoRq, null,  'pickup'),
  (:oApNqA, :orgA, :whA, 'pending_approval', 'internal', :apNoRq, null,  'pickup'),
  (:oPtlA,  :orgA, :whA, 'pending_approval', 'portal',   :ptl,    :cusA, 'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:oRmvA,  :itA, 1, 0, null),
  (:oDisA,  :itA, 1, 0, null),
  (:oNoRqA, :itA, 1, 0, null),
  (:oApNqB, :itB, 1, 0, null),
  (:oApNqA, :itA, 1, 0, null),
  (:oPtlA,  :itA, 1, 0, null);
-- Then rmv leaves orgA as TeamService.removeMember removes a member (the
-- membership row, then their assignments in the organization's warehouses),
-- and dis is disabled as the account-disable service does it (user_profiles
-- disabled_at, which only service_role writes: 0309's pin reverts anyone
-- else's write).
delete from public.organization_members where organization_id = :orgA and user_id = :rmv;
delete from public.user_warehouse_assignments where organization_id = :orgA and user_id = :rmv;
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ══ Helpers (0387's, as 0395 uses them) ═══════════════════════════════════
-- pg_temp.hint drops supautils' generic "Grant the required privileges ..."
-- hint on privilege errors, which depends on the image.
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
-- One statement as p_as with p_sub's claims, then ALWAYS undone. 'ok:<rows>
-- [:<p_check>]' (p_check as the superuser, inside the undone subtransaction),
-- else '<sqlstate>:<hint or ->:<message>'. p_prep runs first, as the
-- superuser, inside the same undone subtransaction (the M-section's mutation).
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
    raise exception using errcode = 'XX416', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX416' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;

create temp table persona (who text primary key, id uuid);
insert into persona (who, id) values
  ('own', :own), ('adm', :adm), ('mgr', :mgr), ('mgrNo', :mgrNo), ('stfAp', :stfAp), ('stfAB', :stfAB),
  ('vwrAp', :vwrAp), ('req', :req), ('stf', :stf), ('vwr', :vwr), ('outZ', :outZ), ('nobody', :nobody);
-- The same statement for each named persona, in the order given, each call
-- undone: 'who=<attempt>, who=<attempt>, ...'.
create function pg_temp.each(p_who text[], p_sql text, p_check text default null)
returns text language plpgsql as $$
declare v text := ''; w text;
begin
  foreach w in array p_who loop
    v := v || case when v = '' then '' else ', ' end || w || '='
           || pg_temp.attempt('authenticated', (select p.id from persona p where p.who = w), p_sql, null, p_check);
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
-- The M-section's mutation: the live definition with p_cut taken out,
-- re-created (always inside an undone attempt). Refuses when the text is not
-- there, so a mutation can never pass by cutting nothing.
create function pg_temp.unpatch(p_sig text, p_cut text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(to_regprocedure(p_sig));
begin
  if position(p_cut in v_def) = 0 then
    raise exception 'unpatch: the text to cut is not in %', p_sig;
  end if;
  execute replace(v_def, p_cut, '');
end $$;

-- ══ F. The fixture is what the matrices assume ═══════════════════════════
create function pg_temp.perm(p_who text, p_perm text) returns text language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub', (select p.id::text from persona p where p.who = p_who), true);
  v := public.has_permission('04160000-0000-0000-0000-00000000000a', p_perm);
  perform set_config('request.jwt.claim.sub', '', true);
  return p_who || '=' || v::text;
end $$;
select is(
  (select string_agg(pg_temp.perm(p.who, 'orders:approve'), ' ' order by p.who collate "C") from persona p),
  'adm=true mgr=true mgrNo=false nobody=false outZ=false own=true req=false stf=false stfAB=true stfAp=true vwr=false vwrAp=true',
  'F1: orders:approve is held by the owner, the admin, the manager and the three granted members; not by the revoked manager, the requester, plain staff, the viewer, another organization''s manager or a member of no organization');
select is(
  (select string_agg(p.who || '=' || public.user_can_access_warehouse(p.id, :whA, 'write')::text
                     || '/' || public.user_can_access_warehouse(p.id, :whB, 'write')::text, ' ' order by p.who collate "C")
     from persona p),
  'adm=true/true mgr=true/true mgrNo=true/true nobody=false/false outZ=false/false own=true/true req=true/false '
  'stf=true/false stfAB=true/true stfAp=true/false vwr=false/false vwrAp=false/false',
  'F2: write access (warehouse A / warehouse B) as user_can_access_warehouse answers it: every warehouse for the owner, admin and managers by role; staff only where assigned; never a viewer, an outsider or a member of no organization');
-- C5 and C6's requesters: is_org_member / orders:request / orders:approve.
create function pg_temp.gates(p_sub uuid) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  v := public.is_org_member('04160000-0000-0000-0000-00000000000a')::text
       || '/' || public.has_permission('04160000-0000-0000-0000-00000000000a', 'orders:request')::text
       || '/' || public.has_permission('04160000-0000-0000-0000-00000000000a', 'orders:approve')::text;
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $$;
select is(
  'rmv=' || pg_temp.gates(:rmv) || ' dis=' || pg_temp.gates(:dis) || ' noRq=' || pg_temp.gates(:noRq)
  || ' apNoRq=' || pg_temp.gates(:apNoRq) || ' ptl=' || pg_temp.gates(:ptl) || ' req=' || pg_temp.gates(:req)
  || ' vwr=' || pg_temp.gates(:vwr) || ' stfAp=' || pg_temp.gates(:stfAp),
  'rmv=false/false/false dis=false/false/false noRq=true/false/false apNoRq=true/false/true ptl=false/false/false '
  'req=true/true/false vwr=true/true/false stfAp=true/true/true',
  'F3: membership / orders:request / orders:approve in orgA: the removed member, the disabled account and the portal customer are no members and hold neither permission; the revoked member is a member without orders:request; the revoked approver keeps orders:approve only; the requester, the viewer and the scoped approver hold orders:request (the role default)');

-- Everything below must leave this unchanged (Z1): every attempt is undone.
create function pg_temp.state() returns text language sql stable as $$
  select (select md5(string_agg(o.id::text || o.status || o.warehouse_id::text
                                || coalesce(o.cancelled_at::text, '') || coalesce(o.cancelled_by::text, '')
                                || coalesce(o.approved_by::text, '') || coalesce(o.completed_at::text, '')
                                || coalesce(o.pick_slip_generated_by::text, '') || coalesce(o.picking_completed_at::text, '')
                                || coalesce(o.denied_reason, ''), ',' order by o.id))
            from public.order_requests o where o.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select md5(string_agg(l.id::text || coalesce(l.quantity_picked::text, '-') || l.quantity_requested::text
                                       || l.quantity_fulfilled::text, ',' order by l.id))
                   from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
                  where o.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.stock_movements m where m.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.stock_reservations r where r.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select count(*) from public.notifications n where n.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select md5(string_agg(i.id::text || i.quantity_on_hand::text, ',' order by i.id))
                   from public.inventory_items i where i.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select coalesce(sum(l.quantity), 0)::text from public.item_stock_levels l where l.organization_id = '04160000-0000-0000-0000-00000000000a')
      || '|' || (select md5(string_agg(p.oid::text || md5(p.prosrc), ',' order by p.oid))
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('approve_order_request', 'approve_partial', 'cancel_order_request', 'close_partial',
                                      'reopen_picking', 'resume_fulfillment'))
$$;
create temp table snap as select pg_temp.state() as v;

-- ══ R. One change per body (generated by gen_0405.py from the same blocks as the file) ══

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.approve_order_request(uuid)')),
  '0fb614dd15db280a97641ae0ac2673b0|7883f466ae2642cbb4664ebc473e571b',
  'R1: approve_order_request has slice E''s body (md5 0fb614dd), and removing the added text gives production''s body exactly (7883f466): the warehouse term is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.approve_partial(uuid)')),
  '897c53295f88b0bac7dcc03edd07211f|40ca0878733b08a649773fe9b7efd4e0',
  'R2: approve_partial has slice E''s body (md5 897c5329), and removing the added text gives production''s body exactly (40ca0878): the warehouse term is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.close_partial(uuid)')),
  '44852737eedc1959e887b8621925d157|a519c3e58fb577c3ff1b30fb3a6cc0ad',
  'R3: close_partial has slice E''s body (md5 44852737), and removing the added text gives production''s body exactly (a519c3e5): the warehouse term is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.resume_fulfillment(uuid)')),
  'ce593a9203c41c1a7311b1af27d4cbd3|2e2d5aab1db5392250879bfa9ff4bccd',
  'R4: resume_fulfillment has slice E''s body (md5 ce593a92), and removing the added text gives production''s body exactly (2e2d5aab): the warehouse term is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $b0$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$b0$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.reopen_picking(uuid, text)')),
  'b62fbb68ee0d0eb44a9e641921a757e5|14e49293fa670dc2e05a1c1b6930bce5',
  'R5: reopen_picking has slice E''s body (md5 b62fbb68), and removing the added text gives production''s body exactly (14e49293): the warehouse term is the only change');

select is(
  (select md5(p.prosrc) || '|' || md5(replace(replace(replace(p.prosrc, $b0$  -- Slice E: an order with no requester account (placed through a public
  -- link, or its requester's account was deleted) is nobody's own order.
  -- The comparison above is NULL for it, and an IF treats NULL as false,
  -- so the rule below refused no one: any signed-in caller could cancel
  -- such an order while it waited for approval.
  v_is_owner := coalesce(v_is_owner, false);
$b0$, ''), $b2$  -- Slice E: the requester's cancel is for someone who may still place
  -- orders in the order's organization: has_permission 'orders:request',
  -- which place_order_request asks to place one and the service asserts
  -- before every cancel. It is false without an accepted membership of an
  -- account that is not disabled, and when orders:request is revoked.
  -- Without it, a member removed from the organization, a disabled account
  -- (its access token outlives the disable) and a member whose
  -- orders:request was revoked could each cancel their own pending order
  -- by calling this function. An approver among them cancels only as an
  -- approver, in their warehouses (below).
  if v_is_owner then
    v_is_owner := public.has_permission(v_req.organization_id, 'orders:request');
  end if;
$b2$, ''), $b1$
  -- Slice E: an approver's cancel asks write access to the order's
  -- warehouse, as every other approver action does (the order update
  -- policy, 0395; the app asks it first). Cancelling your own order while
  -- it waits for approval is the requester's cancel and asks no warehouse.
  -- Decided on the row locked above: an order that moved on from pending
  -- approval after the caller last read it is an approver's cancel here.
  if v_is_manager
     and not (v_is_owner and v_req.status = 'pending_approval')
     and not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$b1$, ''))
     from pg_proc p where p.oid = to_regprocedure('public.cancel_order_request(uuid, text)')),
  'dfbd31ed1083df82ae6de3cbb13b6c27|535fc49935f15adc8d7dfa78836a06af',
  'R6: cancel_order_request has slice E''s body (md5 dfbd31ed), and removing the added text gives production''s body exactly (535fc499): the requester-account fix, the requester''s permission term and the approver''s warehouse term are the only changes');

-- ══ P. The six keep their posture; the comments say the rule ══════════════
select is(
  (select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || '|'
                     || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|'
                     || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
                     || has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|'
                     || (not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text,
                     E'\n' order by p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_request', 'approve_partial', 'cancel_order_request', 'close_partial',
                        'reopen_picking', 'resume_fulfillment')),
  E'approve_order_request(p_id uuid)|order_requests|v|true|{search_path=public}|postgres|true|false|true|true\n'
  'approve_partial(p_id uuid)|order_requests|v|true|{search_path=public}|postgres|true|false|true|true\n'
  'cancel_order_request(p_id uuid, p_reason text)|order_requests|v|true|{"search_path=public, extensions"}|postgres|true|false|true|true\n'
  'close_partial(p_id uuid)|order_requests|v|true|{search_path=public}|postgres|true|false|true|true\n'
  'reopen_picking(p_id uuid, p_reason text)|order_requests|v|true|{"search_path=public, extensions"}|postgres|true|false|true|true\n'
  'resume_fulfillment(p_id uuid)|order_requests|v|true|{search_path=public}|postgres|true|false|true|true',
  'P1: the six keep their arguments, result, volatility, SECURITY DEFINER, SET search_path, owner and EXECUTE (authenticated and service_role, not anon, nothing to PUBLIC: production''s ACLs, read 2026-10-24); one function of each name');
-- Keyed on the words each comment must carry, not on the migration's number,
-- so a push-time renumber cannot break it.
select is(
  (select string_agg(p.proname || '=' || (position(e.says in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0)::text,
                     ', ' order by p.proname collate "C")
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join (values ('approve_order_request', 'only with write access to the order''s warehouse'),
                  ('approve_partial', 'with write access to the order''s warehouse'),
                  ('cancel_order_request', 'an approver''s cancel asks write access to the order''s warehouse (42501 forbidden, hint warehouse_write)'),
                  ('close_partial', 'with write access to the order''s warehouse'),
                  ('reopen_picking', 'only with write access to the order''s warehouse'),
                  ('resume_fulfillment', 'with write access to the order''s warehouse')) e(fn, says)
       on e.fn = p.proname
    where n.nspname = 'public'),
  'approve_order_request=true, approve_partial=true, cancel_order_request=true, close_partial=true, '
  'reopen_picking=true, resume_fulfillment=true',
  'P2: each of the six says in its comment that it asks write access to the order''s warehouse, in the words of the rule (not the migration number)');
select is(
  (select position('the person who placed it cancels it as its requester only while they may place orders in its organization (has_permission orders:request'
                   in coalesce(obj_description(p.oid, 'pg_proc'), '')) > 0
     from pg_proc p where p.oid = to_regprocedure('public.cancel_order_request(uuid, text)')),
  true,
  'P3: cancel_order_request''s comment says the requester''s rule: the person who placed the order cancels it only while they may place orders in its organization (orders:request)');

-- ══ W. Each function asks write access to the order's warehouse ═══════════
-- The order of warehouse B, then the scoped members on warehouse A's.
select is(
  pg_temp.each(array['stfAp', 'vwrAp', 'stfAB', 'mgr', 'adm', 'own', 'mgrNo', 'outZ'],
               format('select public.approve_order_request(%L)', :oApB),
               format('select status from public.order_requests where id = %L', :oApB)),
  'stfAp=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden, stfAB=ok:1:approved, '
  'mgr=ok:1:approved, adm=ok:1:approved, own=ok:1:approved, mgrNo=42501:-:forbidden, outZ=42501:-:forbidden',
  'W1: approve_order_request on warehouse B''s order: the scoped approver and the viewer approver are refused (42501, hint warehouse_write); an approver assigned to B, a manager with no assignment, the admin and the owner approve it; the revoked manager and another organization''s manager are refused by the permission gate as before');
select is(
  pg_temp.each(array['stfAp', 'vwrAp'], format('select public.approve_order_request(%L)', :oApA),
               format('select status from public.order_requests where id = %L', :oApA)),
  'stfAp=ok:1:approved, vwrAp=42501:warehouse_write:forbidden',
  'W2: approve_order_request on warehouse A''s order: the scoped approver approves in their own warehouse; the viewer approver is refused there too (a viewer never writes)');

select is(
  pg_temp.each(array['stfAp', 'vwrAp', 'stfAB', 'mgr', 'adm', 'own', 'mgrNo', 'outZ'],
               format('select public.approve_partial(%L)', :oApB),
               format('select status from public.order_requests where id = %L', :oApB)),
  'stfAp=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden, stfAB=ok:1:approved, '
  'mgr=ok:1:approved, adm=ok:1:approved, own=ok:1:approved, mgrNo=42501:-:forbidden, outZ=42501:-:forbidden',
  'W3: approve_partial on warehouse B''s order: the same matrix as W1');
select is(
  pg_temp.each(array['stfAp', 'vwrAp'], format('select public.approve_partial(%L)', :oApA),
               format('select status from public.order_requests where id = %L', :oApA)),
  'stfAp=ok:1:approved, vwrAp=42501:warehouse_write:forbidden',
  'W4: approve_partial on warehouse A''s order: the scoped approver passes, the viewer approver does not');

select is(
  pg_temp.each(array['stfAp', 'vwrAp', 'stfAB', 'mgr', 'adm', 'own', 'mgrNo', 'outZ'],
               format('select public.close_partial(%L)', :oBkB),
               format('select status from public.order_requests where id = %L', :oBkB)),
  'stfAp=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden, stfAB=ok:1:completed, '
  'mgr=ok:1:completed, adm=ok:1:completed, own=ok:1:completed, mgrNo=42501:-:forbidden, outZ=42501:-:forbidden',
  'W5: close_partial on warehouse B''s backorder: the same matrix');
select is(
  pg_temp.each(array['stfAp', 'vwrAp'], format('select public.close_partial(%L)', :oBkA),
               format('select status from public.order_requests where id = %L', :oBkA)),
  'stfAp=ok:1:completed, vwrAp=42501:warehouse_write:forbidden',
  'W6: close_partial on warehouse A''s backorder: the scoped approver passes, the viewer approver does not');

select is(
  pg_temp.each(array['stfAp', 'vwrAp', 'stfAB', 'mgr', 'adm', 'own', 'mgrNo', 'outZ'],
               format('select public.resume_fulfillment(%L)', :oBkB),
               format('select status from public.order_requests where id = %L', :oBkB)),
  'stfAp=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden, stfAB=ok:1:pick_slip_generated, '
  'mgr=ok:1:pick_slip_generated, adm=ok:1:pick_slip_generated, own=ok:1:pick_slip_generated, '
  'mgrNo=42501:-:forbidden, outZ=42501:-:forbidden',
  'W7: resume_fulfillment on warehouse B''s backorder: the same matrix');
select is(
  pg_temp.each(array['stfAp', 'vwrAp'], format('select public.resume_fulfillment(%L)', :oBkA),
               format('select status from public.order_requests where id = %L', :oBkA)),
  'stfAp=ok:1:pick_slip_generated, vwrAp=42501:warehouse_write:forbidden',
  'W8: resume_fulfillment on warehouse A''s backorder: the scoped approver passes, the viewer approver does not');

select is(
  pg_temp.each(array['stfAp', 'vwrAp', 'stfAB', 'mgr', 'adm', 'own', 'mgrNo', 'outZ'],
               format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPcB),
               format('select status from public.order_requests where id = %L', :oPcB)) || ' / '
  || pg_temp.each(array['stfAp', 'mgr'], format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPc0B),
                  format('select status from public.order_requests where id = %L', :oPc0B)),
  'stfAp=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden, stfAB=ok:1:picking_in_progress, '
  'mgr=ok:1:picking_in_progress, adm=ok:1:picking_in_progress, own=ok:1:picking_in_progress, '
  'mgrNo=42501:-:forbidden, outZ=42501:-:forbidden / '
  'stfAp=42501:warehouse_write:forbidden, mgr=ok:1:picking_in_progress',
  'W9: reopen_picking on warehouse B''s picked order: the same matrix, answered by the function''s own term first (before 0416 the scoped approver met only ledger.adjust_stock''s location check, 0365, with no hint); and on a warehouse B order with nothing picked, where no stock moves and that check never runs');
select is(
  pg_temp.each(array['stfAp', 'vwrAp'], format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPcA),
               format('select status from public.order_requests where id = %L', :oPcA)),
  'stfAp=ok:1:picking_in_progress, vwrAp=42501:warehouse_write:forbidden',
  'W10: reopen_picking on warehouse A''s picked order: the scoped approver passes, the viewer approver does not');

select is(
  pg_temp.each(array['stfAp', 'vwrAp', 'stfAB', 'mgr', 'adm', 'own', 'mgrNo', 'outZ'],
               format($q$select public.cancel_order_request(%L, 'Not needed')$q$, :oAppB),
               format('select status from public.order_requests where id = %L', :oAppB)),
  'stfAp=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden, stfAB=ok:1:cancelled, '
  'mgr=ok:1:cancelled, adm=ok:1:cancelled, own=ok:1:cancelled, mgrNo=42501:-:forbidden, outZ=42501:-:forbidden',
  'W11: cancel_order_request of someone else''s approved order in warehouse B: the same matrix (an approver''s cancel)');
select is(
  pg_temp.each(array['stfAp', 'vwrAp'], format($q$select public.cancel_order_request(%L, 'Not needed')$q$, :oAppA),
               format('select status from public.order_requests where id = %L', :oAppA)),
  'stfAp=ok:1:cancelled, vwrAp=42501:warehouse_write:forbidden',
  'W12: cancel_order_request of someone else''s approved order in warehouse A: the scoped approver passes, the viewer approver does not');

-- ══ C. cancel_order_request: the requester's cancel and the approver's ════
select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oOwnPB), null,
                  format('select status from public.order_requests where id = %L', :oOwnPB)) || ' / '
  || pg_temp.attempt('authenticated', :req, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oApA), null,
                     format('select status from public.order_requests where id = %L', :oApA)),
  'ok:1:cancelled / ok:1:cancelled',
  'C1: cancelling your own order while it waits for approval asks no warehouse: the scoped approver cancels their own request in warehouse B, and a requester who does not approve cancels theirs, as before');
select is(
  pg_temp.over('stfAp', array[:oOwnAB, :oOwnAA]::uuid[], $q$select public.cancel_order_request(%L, 'Changed my mind')$q$),
  '42501:warehouse_write:forbidden, ok:1',
  'C2: once their own order is approved, cancelling it is an approver''s cancel: refused in warehouse B, allowed in warehouse A. The function decides on the row it locks, so an order the service read as pending that was approved before this call is refused here (the race in followups.md)');
select is(
  pg_temp.each(array['stf', 'vwr', 'req', 'mgrNo', 'outZ', 'nobody'],
               format($q$select public.cancel_order_request(%L, 'Not mine')$q$, :oNulA)) || ' / '
  || pg_temp.each(array['stf', 'outZ', 'nobody'],
                  format($q$select public.cancel_order_request(%L, 'Not mine')$q$, :oDelA)),
  'stf=42501:-:forbidden, vwr=42501:-:forbidden, req=42501:-:forbidden, mgrNo=42501:-:forbidden, '
  'outZ=42501:-:forbidden, nobody=42501:-:forbidden / '
  'stf=42501:-:forbidden, outZ=42501:-:forbidden, nobody=42501:-:forbidden',
  'C3: a pending order with no requester account (placed through a public link, or its requester deleted their account) is nobody''s own order: staff, a viewer, a requester of other orders, the revoked manager, another organization''s manager and a member of no organization are all refused (42501 forbidden). Before slice E each of them cancelled it');
select is(
  pg_temp.each(array['mgr', 'stfAp'], format($q$select public.cancel_order_request(%L, 'Duplicate')$q$, :oNulA),
               format('select status from public.order_requests where id = %L', :oNulA)) || ' / '
  || pg_temp.each(array['stfAp', 'stfAB'], format($q$select public.cancel_order_request(%L, 'Duplicate')$q$, :oNulB),
                  format('select status from public.order_requests where id = %L', :oNulB)) || ' / '
  || pg_temp.each(array['mgr'], format($q$select public.cancel_order_request(%L, 'Duplicate')$q$, :oDelA),
                  format('select status from public.order_requests where id = %L', :oDelA)),
  'mgr=ok:1:cancelled, stfAp=ok:1:cancelled / stfAp=42501:warehouse_write:forbidden, stfAB=ok:1:cancelled / mgr=ok:1:cancelled',
  'C4: such an order is cancelled by an approver, in their warehouses: the manager and the scoped approver in warehouse A, an approver assigned to B but not the scoped approver in warehouse B, the manager for the deleted requester''s order');
select is(
  pg_temp.attempt('authenticated', :rmv, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oRmvA), null,
                  format('select status from public.order_requests where id = %L', :oRmvA)) || ' / '
  || pg_temp.attempt('authenticated', :dis, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oDisA), null,
                     format('select status from public.order_requests where id = %L', :oDisA)) || ' / '
  || pg_temp.attempt('authenticated', :noRq, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oNoRqA), null,
                     format('select status from public.order_requests where id = %L', :oNoRqA)) || ' / '
  || pg_temp.attempt('authenticated', :ptl, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oPtlA), null,
                     format('select status from public.order_requests where id = %L', :oPtlA)),
  '42501:-:forbidden / 42501:-:forbidden / 42501:-:forbidden / 42501:-:forbidden',
  'C5: the requester''s cancel asks that the person who placed the order may still place orders in its organization (orders:request, which the service asserts for every cancel): a member removed from the organization, a disabled account, a member whose orders:request was revoked and a portal customer (no member; the portal offers no cancel) are refused their own pending order (42501 forbidden). Before this each of them cancelled it, writing the order''s reason');
select is(
  pg_temp.attempt('authenticated', :apNoRq, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oApNqB), null,
                  format('select status from public.order_requests where id = %L', :oApNqB)) || ' / '
  || pg_temp.attempt('authenticated', :apNoRq, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oApNqA), null,
                     format('select status from public.order_requests where id = %L', :oApNqA)),
  '42501:warehouse_write:forbidden / ok:1:cancelled',
  'C6: an approver who may no longer place orders cancels their own pending order only as an approver: refused in warehouse B, where they do not work (42501, hint warehouse_write), allowed in warehouse A. Before this the requester''s cancel let them cancel it in warehouse B too');

-- ══ M. Mutations (generated by gen_0405.py): each takes the added text out of a live body, inside an undone attempt ══

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.approve_order_request(%L)$q$, :oApB),
    format('select pg_temp.unpatch(%L, %L)', 'public.approve_order_request(uuid)', $c$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$c$)),
  'ok:1',
  'M1: approve_order_request without the warehouse term (production''s body) lets the scoped approver approve warehouse B''s order: W1 fails on it');

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.approve_partial(%L)$q$, :oApB),
    format('select pg_temp.unpatch(%L, %L)', 'public.approve_partial(uuid)', $c$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$c$)),
  'ok:1',
  'M2: approve_partial without the term lets the scoped approver approve warehouse B''s order partially: W3 fails on it');

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.close_partial(%L)$q$, :oBkB),
    format('select pg_temp.unpatch(%L, %L)', 'public.close_partial(uuid)', $c$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$c$)),
  'ok:1',
  'M3: close_partial without the term lets the scoped approver close warehouse B''s backorder: W5 fails on it');

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.resume_fulfillment(%L)$q$, :oBkB),
    format('select pg_temp.unpatch(%L, %L)', 'public.resume_fulfillment(uuid)', $c$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$c$)),
  'ok:1',
  'M4: resume_fulfillment without the term lets the scoped approver resume warehouse B''s backorder: W7 fails on it');

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.reopen_picking(%L, 'Miscount')$q$, :oPc0B),
    format('select pg_temp.unpatch(%L, %L)', 'public.reopen_picking(uuid, text)', $c$
  -- Slice E: an approver acts on an order only in a warehouse they may
  -- write to: user_can_access_warehouse 'write', the rule the order update
  -- policy applies (0395) and the app asks first. It gives an owner, admin
  -- or manager of the order's organization every warehouse, staff only an
  -- assigned one, and a viewer none. Decided on the row locked above.
  if not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$c$)),
  'ok:1',
  'M5: reopen_picking without the term lets the scoped approver reopen warehouse B''s order when nothing on it was picked (with units picked, ledger.adjust_stock''s location check, 0365, refuses it with no hint): W9 fails on it');

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.cancel_order_request(%L, 'Not needed')$q$, :oAppB),
    format('select pg_temp.unpatch(%L, %L)', 'public.cancel_order_request(uuid, text)', $c$
  -- Slice E: an approver's cancel asks write access to the order's
  -- warehouse, as every other approver action does (the order update
  -- policy, 0395; the app asks it first). Cancelling your own order while
  -- it waits for approval is the requester's cancel and asks no warehouse.
  -- Decided on the row locked above: an order that moved on from pending
  -- approval after the caller last read it is an approver's cancel here.
  if v_is_manager
     and not (v_is_owner and v_req.status = 'pending_approval')
     and not public.user_can_access_warehouse(v_user, v_req.warehouse_id, 'write') then
    raise exception 'forbidden'
      using errcode = '42501',
            hint    = 'warehouse_write',
            detail  = 'This order is in a warehouse you don''t work in, so you can''t change it. Ask a manager.';
  end if;
$c$)),
  'ok:1',
  'M6: cancel_order_request without the warehouse term lets the scoped approver cancel warehouse B''s order: W11 fails on it');

select is(
  pg_temp.attempt('authenticated', :stf, format($q$select public.cancel_order_request(%L, 'Not mine')$q$, :oNulA),
    format('select pg_temp.unpatch(%L, %L)', 'public.cancel_order_request(uuid, text)', $c$  -- Slice E: an order with no requester account (placed through a public
  -- link, or its requester's account was deleted) is nobody's own order.
  -- The comparison above is NULL for it, and an IF treats NULL as false,
  -- so the rule below refused no one: any signed-in caller could cancel
  -- such an order while it waited for approval.
  v_is_owner := coalesce(v_is_owner, false);
$c$)),
  'ok:1',
  'M7: cancel_order_request without the requester-account fix (production''s gate) lets staff who neither approve nor placed it cancel a pending public-link order: the hole C3 closes');

select is(
  pg_temp.attempt('authenticated', :stfAp, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, :oOwnPB),
    format('select pg_temp.unpatch(%L, %L)', 'public.cancel_order_request(uuid, text)', $c$     and not (v_is_owner and v_req.status = 'pending_approval')
$c$)),
  '42501:warehouse_write:forbidden',
  'M8: cancel_order_request asking the warehouse of the requester''s own pending order too refuses the scoped approver''s own request in warehouse B: C1 fails on it');

select is(
  (select string_agg(pg_temp.attempt('authenticated', c.sub, format($q$select public.cancel_order_request(%L, 'Changed my mind')$q$, c.ord),
             format('select pg_temp.unpatch(%L, %L)', 'public.cancel_order_request(uuid, text)', $c$  -- Slice E: the requester's cancel is for someone who may still place
  -- orders in the order's organization: has_permission 'orders:request',
  -- which place_order_request asks to place one and the service asserts
  -- before every cancel. It is false without an accepted membership of an
  -- account that is not disabled, and when orders:request is revoked.
  -- Without it, a member removed from the organization, a disabled account
  -- (its access token outlives the disable) and a member whose
  -- orders:request was revoked could each cancel their own pending order
  -- by calling this function. An approver among them cancels only as an
  -- approver, in their warehouses (below).
  if v_is_owner then
    v_is_owner := public.has_permission(v_req.organization_id, 'orders:request');
  end if;
$c$),
             format($q$select status || '/' || coalesce(denied_reason, '-') from public.order_requests where id = %L$q$, c.ord)),
             ' / ' order by c.n)
     from (values (1, :rmv::uuid, :oRmvA::uuid), (2, :dis::uuid, :oDisA::uuid), (3, :noRq::uuid, :oNoRqA::uuid),
                  (4, :ptl::uuid, :oPtlA::uuid), (5, :apNoRq::uuid, :oApNqB::uuid)) c(n, sub, ord)),
  'ok:1:cancelled/Changed my mind / ok:1:cancelled/Changed my mind / ok:1:cancelled/Changed my mind / '
  'ok:1:cancelled/Changed my mind / ok:1:cancelled/Changed my mind',
  'M9: cancel_order_request without the requester''s permission term (the body before it) lets the removed member, the disabled account, the revoked member and the portal customer cancel their own pending order and write its reason, and the revoked approver cancel theirs in warehouse B: C5 and C6 fail on it');

-- ══ G. Never a retryable error ════════════════════════════════════════════
select is(
  (select string_agg(p.proname || '=' || (p.prosrc ~* '40001|40P01|serialization_failure|deadlock_detected')::text, ', ' order by p.proname collate "C")
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_order_request', 'approve_partial', 'cancel_order_request', 'close_partial',
                        'reopen_picking', 'resume_fulfillment')),
  'approve_order_request=false, approve_partial=false, cancel_order_request=false, close_partial=false, '
  'reopen_picking=false, resume_fulfillment=false',
  'G1: none of the six names 40001 or 40P01 (PostgREST retries those forever)');

-- ══ Z. Every undone attempt changed nothing ═══════════════════════════════
select is(pg_temp.state(), (select v from snap),
  'Z1: the undone attempts (the M-section''s mutations included) left every order, line, hold, movement, notification, item, holding and the six bodies as they were');

select * from finish();
rollback;
