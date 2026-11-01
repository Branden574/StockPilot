-- supabase/tests/0422_notice_audience_follows_permission.test.sql
-- pgTAP proof for the notice audience migration (docket S36, part a): the New
-- order request alert follows orders:approve with overrides and write access
-- to the order's warehouse; no notice reaches a support Act-as seat; and a
-- purchase order's creator or an order's requester is told only while they
-- are still a member of the organization.
--
-- Personas, organization A (warehouses W1 and W2):
--   own     owner                     adm     admin
--   admRev  admin, orders:approve and items:update revoked for them
--   mgr     manager                   mgrRev  manager, orders:approve and
--                                             purchase_orders:manage revoked
--   stf     staff, assigned W1 (no grant): the current creator and requester
--   stfAp   staff granted orders:approve and purchase_orders:manage, W1
--   stfCh   staff granted orders:approve, W1 through a charter row
--   stfMute staff granted orders:approve, W1, New order requests turned off
--   stfW2   staff granted orders:approve, W2 only
--   vwrAp   viewer granted orders:approve and items:update, W1
--   dis     manager whose account is disabled
--   inv     manager invited, not yet accepted
--   seat    a live support Act-as seat (an owner row with an expiry ahead)
--   old     an expired Act-as seat not yet swept
--   gone    staff who created a purchase order and placed orders, then was
--           removed (the membership row deleted, as Team > Remove does)
-- Organization B (warehouse B1): ownB owner; admB admin under an organization
-- revoke of orders:approve for admins; admBGr admin granted it for
-- themselves; stfB staff under an organization grant of it to staff, B1;
-- stfBRev staff under that grant with their own revoke, B1.
--
-- T1. Posture of the two new functions.
-- T2. The resolver equals has_permission run as each persona, for three keys
--     in both organizations.
-- T3. A live Act-as seat holds orders:approve and is never in the resolver; a
--     platform-managed key answers nobody.
-- T4. The INSERT alert: W1, W2 and organization B.
-- T5. pending_confirmation -> pending_approval alerts T4's W1 set.
-- T6. Cancelled after approval and a low-stock crossing still go to the
--     owners, admins and managers, never to a seat.
-- T7. Restatement: each restated body, with this migration's texts taken
--     back out, is the body it replaced, byte for byte.
-- T8. A creator or requester who was removed (or is disabled or a seat) is
--     not told; a current one still is.
--
-- Statement discipline: every write a check depends on runs in its own
-- statement before the check.

begin;

select plan(25);

\set orgA    '\'a36a0000-0000-0000-0000-0000000000a1\''
\set orgB    '\'a36a0000-0000-0000-0000-0000000000b1\''
\set own     '\'a36a0000-0000-0000-0001-000000000001\''
\set adm     '\'a36a0000-0000-0000-0001-000000000002\''
\set admRev  '\'a36a0000-0000-0000-0001-000000000003\''
\set mgr     '\'a36a0000-0000-0000-0001-000000000004\''
\set mgrRev  '\'a36a0000-0000-0000-0001-000000000005\''
\set stf     '\'a36a0000-0000-0000-0001-000000000006\''
\set stfAp   '\'a36a0000-0000-0000-0001-000000000007\''
\set stfCh   '\'a36a0000-0000-0000-0001-000000000008\''
\set stfMute '\'a36a0000-0000-0000-0001-000000000009\''
\set stfW2   '\'a36a0000-0000-0000-0001-00000000000a\''
\set vwrAp   '\'a36a0000-0000-0000-0001-00000000000b\''
\set dis     '\'a36a0000-0000-0000-0001-00000000000c\''
\set inv     '\'a36a0000-0000-0000-0001-00000000000d\''
\set seat    '\'a36a0000-0000-0000-0001-00000000000e\''
\set old     '\'a36a0000-0000-0000-0001-00000000000f\''
\set gone    '\'a36a0000-0000-0000-0001-000000000010\''
\set ownB    '\'a36a0000-0000-0000-0001-000000000011\''
\set admB    '\'a36a0000-0000-0000-0001-000000000012\''
\set admBGr  '\'a36a0000-0000-0000-0001-000000000013\''
\set stfB    '\'a36a0000-0000-0000-0001-000000000014\''
\set stfBRev '\'a36a0000-0000-0000-0001-000000000015\''
\set whA1    '\'a36a0000-0000-0000-0002-000000000001\''
\set whA2    '\'a36a0000-0000-0000-0002-000000000002\''
\set whB1    '\'a36a0000-0000-0000-0002-000000000003\''
\set chA     '\'a36a0000-0000-0000-0003-000000000001\''
\set oT4     '\'a36a0000-0000-0000-0004-000000000001\''
\set oT4b    '\'a36a0000-0000-0000-0004-000000000002\''
\set oT4c    '\'a36a0000-0000-0000-0004-000000000003\''
\set oT5     '\'a36a0000-0000-0000-0004-000000000004\''
\set oT6     '\'a36a0000-0000-0000-0004-000000000005\''
\set oDenStf  '\'a36a0000-0000-0000-0004-000000000006\''
\set oDenGone '\'a36a0000-0000-0000-0004-000000000007\''
\set oStgStf  '\'a36a0000-0000-0000-0004-000000000008\''
\set oStgGone '\'a36a0000-0000-0000-0004-000000000009\''
\set oOrigStf  '\'a36a0000-0000-0000-0004-00000000000a\''
\set oOrigGone '\'a36a0000-0000-0000-0004-00000000000b\''
\set oRepStf   '\'a36a0000-0000-0000-0004-00000000000c\''
\set oRepGone  '\'a36a0000-0000-0000-0004-00000000000d\''
\set poStf   '\'a36a0000-0000-0000-0005-000000000001\''
\set poGone  '\'a36a0000-0000-0000-0005-000000000002\''
\set poDis   '\'a36a0000-0000-0000-0005-000000000003\''
\set poSeat  '\'a36a0000-0000-0000-0005-000000000004\''
\set rcStf   '\'a36a0000-0000-0000-0006-000000000001\''
\set rcGone  '\'a36a0000-0000-0000-0006-000000000002\''
\set rcDis   '\'a36a0000-0000-0000-0006-000000000003\''
\set rcSeat  '\'a36a0000-0000-0000-0006-000000000004\''
\set rtStf   '\'a36a0000-0000-0000-0007-000000000001\''
\set rtGone  '\'a36a0000-0000-0000-0007-000000000002\''
\set iLow    '\'a36a0000-0000-0000-0008-000000000001\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,     'own.s36a@example.test',     '{}'::jsonb),
  (:adm,     'adm.s36a@example.test',     '{}'::jsonb),
  (:admRev,  'admrev.s36a@example.test',  '{}'::jsonb),
  (:mgr,     'mgr.s36a@example.test',     '{}'::jsonb),
  (:mgrRev,  'mgrrev.s36a@example.test',  '{}'::jsonb),
  (:stf,     'stf.s36a@example.test',     '{}'::jsonb),
  (:stfAp,   'stfap.s36a@example.test',   '{}'::jsonb),
  (:stfCh,   'stfch.s36a@example.test',   '{}'::jsonb),
  (:stfMute, 'stfmute.s36a@example.test', '{}'::jsonb),
  (:stfW2,   'stfw2.s36a@example.test',   '{}'::jsonb),
  (:vwrAp,   'vwrap.s36a@example.test',   '{}'::jsonb),
  (:dis,     'dis.s36a@example.test',     '{}'::jsonb),
  (:inv,     'inv.s36a@example.test',     '{}'::jsonb),
  (:seat,    'seat.s36a@example.test',    '{}'::jsonb),
  (:old,     'old.s36a@example.test',     '{}'::jsonb),
  (:gone,    'gone.s36a@example.test',    '{}'::jsonb),
  (:ownB,    'ownb.s36a@example.test',    '{}'::jsonb),
  (:admB,    'admb.s36a@example.test',    '{}'::jsonb),
  (:admBGr,  'admbgr.s36a@example.test',  '{}'::jsonb),
  (:stfB,    'stfb.s36a@example.test',    '{}'::jsonb),
  (:stfBRev, 'stfbrev.s36a@example.test', '{}'::jsonb);
insert into public.organizations (id, name, slug) values
  (:orgA, 'S36a Org A', 's36a-org-a'),
  (:orgB, 'S36a Org B', 's36a-org-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at, impersonation_expires_at) values
  (:orgA, :own,     'owner',   now(), null),
  (:orgA, :adm,     'admin',   now(), null),
  (:orgA, :admRev,  'admin',   now(), null),
  (:orgA, :mgr,     'manager', now(), null),
  (:orgA, :mgrRev,  'manager', now(), null),
  (:orgA, :stf,     'staff',   now(), null),
  (:orgA, :stfAp,   'staff',   now(), null),
  (:orgA, :stfCh,   'staff',   now(), null),
  (:orgA, :stfMute, 'staff',   now(), null),
  (:orgA, :stfW2,   'staff',   now(), null),
  (:orgA, :vwrAp,   'viewer',  now(), null),
  (:orgA, :dis,     'manager', now(), null),
  (:orgA, :inv,     'manager', null,  null),
  (:orgA, :seat,    'owner',   now(), now() + interval '30 minutes'),
  (:orgA, :old,     'owner',   now() - interval '2 hours', now() - interval '1 hour'),
  (:orgA, :gone,    'staff',   now(), null),
  (:orgB, :ownB,    'owner',   now(), null),
  (:orgB, :admB,    'admin',   now(), null),
  (:orgB, :admBGr,  'admin',   now(), null),
  (:orgB, :stfB,    'staff',   now(), null),
  (:orgB, :stfBRev, 'staff',   now(), null);
update public.user_profiles set disabled_at = now() where id = :dis;
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA1, :orgA, 'S36a W1', 'S36A-W1', 'active'),
  (:whA2, :orgA, 'S36a W2', 'S36A-W2', 'active'),
  (:whB1, :orgB, 'S36a B1', 'S36A-B1', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, 'S36a North', 'C36AN', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA1, :chA);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,     :whA1, null, true),
  (:orgA, :stfAp,   :whA1, null, true),
  (:orgA, :stfCh,   :whA1, :chA, true),
  (:orgA, :stfMute, :whA1, null, true),
  (:orgA, :stfW2,   :whA2, null, true),
  (:orgA, :vwrAp,   :whA1, null, true),
  (:orgA, :gone,    :whA1, null, true),
  (:orgB, :stfB,    :whB1, null, true),
  (:orgB, :stfBRev, :whB1, null, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :admRev,  'orders:approve',         false),
  (:orgA, :admRev,  'items:update',           false),
  (:orgA, :mgrRev,  'orders:approve',         false),
  (:orgA, :mgrRev,  'purchase_orders:manage', false),
  (:orgA, :stfAp,   'orders:approve',         true),
  (:orgA, :stfAp,   'purchase_orders:manage', true),
  (:orgA, :stfCh,   'orders:approve',         true),
  (:orgA, :stfMute, 'orders:approve',         true),
  (:orgA, :stfW2,   'orders:approve',         true),
  (:orgA, :vwrAp,   'orders:approve',         true),
  (:orgA, :vwrAp,   'items:update',           true),
  (:orgB, :admBGr,  'orders:approve',         true),
  (:orgB, :stfBRev, 'orders:approve',         false);
insert into public.role_permission_overrides (organization_id, role, permission, granted) values
  (:orgB, 'admin', 'orders:approve', false),
  (:orgB, 'staff', 'orders:approve', true);
insert into public.notification_preferences (user_id, push_order_request_created) values (:stfMute, false)
  on conflict (user_id) do update set push_order_request_created = false;

-- What gone left behind while a member: a purchase order and orders. Then
-- gone is removed: only the membership row goes (team removal).
insert into public.purchase_orders (id, organization_id, po_number, status, created_by) values
  (:poStf,  :orgA, 'S36A-PO-1', 'draft', :stf),
  (:poGone, :orgA, 'S36A-PO-2', 'draft', :gone),
  (:poDis,  :orgA, 'S36A-PO-3', 'draft', :dis),
  (:poSeat, :orgA, 'S36A-PO-4', 'draft', :seat);
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oDenStf,   :orgA, :whA1, 'pending_approval',       'internal', :stf,  'Req Person',  'pickup'),
  (:oDenGone,  :orgA, :whA1, 'pending_approval',       'internal', :gone, 'Gone Person', 'pickup'),
  (:oStgStf,   :orgA, :whA1, 'packing_slip_generated', 'internal', :stf,  'Req Person',  'pickup'),
  (:oStgGone,  :orgA, :whA1, 'packing_slip_generated', 'internal', :gone, 'Gone Person', 'pickup'),
  (:oOrigStf,  :orgA, :whA1, 'completed',              'internal', :stf,  'Req Person',  'pickup'),
  (:oOrigGone, :orgA, :whA1, 'completed',              'internal', :gone, 'Gone Person', 'pickup');
insert into public.returns (id, organization_id, order_request_id, status) values
  (:rtStf,  :orgA, :oOrigStf,  'received'),
  (:rtGone, :orgA, :oOrigGone, 'received');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type, replacement_for_return_id) values
  (:oRepStf,  :orgA, :whA1, 'packing_slip_generated', 'internal', :stf,  'Req Person',  'pickup', :rtStf),
  (:oRepGone, :orgA, :whA1, 'packing_slip_generated', 'internal', :gone, 'Gone Person', 'pickup', :rtGone);
delete from public.organization_members where organization_id = :orgA and user_id = :gone;

insert into public.inventory_items
  (id, organization_id, warehouse_id, name, sku, quantity_on_hand, reorder_point, status) values
  (:iLow, :orgA, :whA1, 'S36a Widget', 'S36A-LOW', 10, 5, 'active');

-- Names for the answers.
create temp table names (id uuid primary key, name text not null, seat boolean not null default false);
insert into names (id, name, seat) values
  (:own, 'own', false), (:adm, 'adm', false), (:admRev, 'admRev', false), (:mgr, 'mgr', false),
  (:mgrRev, 'mgrRev', false), (:stf, 'stf', false), (:stfAp, 'stfAp', false), (:stfCh, 'stfCh', false),
  (:stfMute, 'stfMute', false), (:stfW2, 'stfW2', false), (:vwrAp, 'vwrAp', false), (:dis, 'dis', false),
  (:inv, 'inv', false), (:seat, 'seat', true), (:old, 'old', true), (:gone, 'gone', false),
  (:ownB, 'ownB', false), (:admB, 'admB', false), (:admBGr, 'admBGr', false), (:stfB, 'stfB', false),
  (:stfBRev, 'stfBRev', false);

-- has_permission as the persona (auth.uid() = p_sub).
create function pg_temp.hp(p_sub uuid, p_org uuid, p_perm text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  v := public.has_permission(p_org, p_perm);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
-- The personas (Act-as seats aside) has_permission answers true for.
create function pg_temp.held(p_org uuid, p_perm text) returns text language plpgsql as $$
declare v text := ''; r record;
begin
  for r in select n.id, n.name from pg_temp.names n where not n.seat order by n.name collate "C" loop
    if pg_temp.hp(r.id, p_org, p_perm) then
      v := v || case when v = '' then '' else ',' end || r.name;
    end if;
  end loop;
  return v;
end $$;
-- Who the resolver answers (by persona name), or the error it raised.
create function pg_temp.resolved(p_org uuid, p_perm text) returns text language plpgsql as $$
declare v text;
begin
  execute format($q$select coalesce(string_agg(coalesce(n.name, r.user_id::text), ',' order by coalesce(n.name, r.user_id::text) collate "C"), '')
                      from public._notify_recipients_with_permission(%L::uuid, %L) r
                      left join pg_temp.names n on n.id = r.user_id$q$, p_org, p_perm) into v;
  return v;
exception when others then
  return 'ERR:' || sqlstate;
end $$;
-- Is the persona in the resolver's answer.
create function pg_temp.in_res(p_org uuid, p_perm text, p_user uuid) returns text language plpgsql as $$
declare v boolean;
begin
  execute format('select exists (select 1 from public._notify_recipients_with_permission(%L::uuid, %L) r where r.user_id = %L::uuid)',
                 p_org, p_perm, p_user) into v;
  return v::text;
exception when others then
  return 'ERR:' || sqlstate;
end $$;
-- The member check's answer, or the error it raised.
create function pg_temp.member(p_org uuid, p_user uuid) returns text language plpgsql as $$
declare v boolean;
begin
  execute format('select public._notify_is_current_member(%L::uuid, %L::uuid)', p_org, p_user) into v;
  return coalesce(v::text, 'null');
exception when others then
  return 'ERR:' || sqlstate;
end $$;
-- Who received a notification of this type about this record (by name).
create function pg_temp.who(p_type text, p_key text, p_val uuid) returns text language sql as $$
  select coalesce(string_agg(coalesce(nm.name, n.user_id::text), ',' order by coalesce(nm.name, n.user_id::text) collate "C"), '')
    from public.notifications n
    left join pg_temp.names nm on nm.id = n.user_id
   where n.type = p_type and n.metadata->>p_key = p_val::text
$$;
-- How many notifications of this type about this record reached this person.
create function pg_temp.mine(p_type text, p_key text, p_val uuid, p_user uuid) returns integer language sql as $$
  select count(*)::integer from public.notifications n
   where n.type = p_type and n.metadata->>p_key = p_val::text and n.user_id = p_user
$$;

-- ══ T1. Posture of the two new functions ═══════════════════════════════════
select is(
  (select string_agg(x.sig || '=' || coalesce(
            (select pg_get_function_result(p.oid) || '/' || p.prosecdef::text || '/' || p.provolatile::text || '/'
                    || coalesce(p.proconfig::text, 'null')
                    || '/' || has_function_privilege('anon', p.oid, 'execute')::text
                    || '/' || has_function_privilege('authenticated', p.oid, 'execute')::text
                    || '/' || has_function_privilege('service_role', p.oid, 'execute')::text
                    || '/' || (p.proacl is not null and not exists (select 1 from unnest(p.proacl) a where a::text like '=%'))::text
               from pg_proc p where p.oid = to_regprocedure(x.sig)), 'missing'), ' ' order by x.sig collate "C")
     from (values ('public._notify_is_current_member(uuid,uuid)'),
                  ('public._notify_recipients_with_permission(uuid,text)')) x(sig)),
  'public._notify_is_current_member(uuid,uuid)=boolean/true/s/{search_path=public}/false/false/true/true '
  'public._notify_recipients_with_permission(uuid,text)=TABLE(user_id uuid)/true/s/{search_path=public}/false/false/true/true',
  'T1: both new functions are SECURITY DEFINER and STABLE with search_path public; anon and authenticated hold no EXECUTE, service_role does, and no PUBLIC entry is in the ACL (the 0318 idiom for a roster oracle)');

-- ══ T2. The resolver equals has_permission, persona by persona ════════════
select is(pg_temp.resolved(:orgA, 'orders:approve') || ' | ' || pg_temp.held(:orgA, 'orders:approve'),
  'adm,mgr,own,stfAp,stfCh,stfMute,stfW2,vwrAp | adm,mgr,own,stfAp,stfCh,stfMute,stfW2,vwrAp',
  'T2a: orders:approve in A: the resolver answers exactly who has_permission does (user revokes win over the role, user grants count for staff and a viewer; never a disabled account, an invite, a removed member or B''s members)');
select is(pg_temp.resolved(:orgA, 'purchase_orders:manage') || ' | ' || pg_temp.held(:orgA, 'purchase_orders:manage'),
  'adm,admRev,mgr,own,stfAp | adm,admRev,mgr,own,stfAp',
  'T2b: purchase_orders:manage in A: the same parity (a revoke of another key changes nothing)');
select is(pg_temp.resolved(:orgA, 'items:update') || ' | ' || pg_temp.held(:orgA, 'items:update'),
  'adm,mgr,mgrRev,own,stf,stfAp,stfCh,stfMute,stfW2,vwrAp | adm,mgr,mgrRev,own,stf,stfAp,stfCh,stfMute,stfW2,vwrAp',
  'T2c: items:update in A: the same parity (staff by their role''s default, the admin by their own revoke)');
select is(pg_temp.resolved(:orgB, 'orders:approve') || ' | ' || pg_temp.held(:orgB, 'orders:approve'),
  'admBGr,ownB,stfB | admBGr,ownB,stfB',
  'T2d: orders:approve in B: the organization''s revoke for admins and grant to staff apply, and a user override beats either');
select is(pg_temp.resolved(:orgB, 'purchase_orders:manage') || ' | ' || pg_temp.held(:orgB, 'purchase_orders:manage'),
  'admB,admBGr,ownB | admB,admBGr,ownB',
  'T2e: purchase_orders:manage in B: the role defaults where nothing overrides them');
select is(pg_temp.resolved(:orgB, 'items:update') || ' | ' || pg_temp.held(:orgB, 'items:update'),
  'admB,admBGr,ownB,stfB,stfBRev | admB,admBGr,ownB,stfB,stfBRev',
  'T2f: items:update in B: the same parity, and nobody from A');

-- ══ T3. Act-as seats and platform-managed keys ════════════════════════════
select is(
  'seat=' || pg_temp.hp(:seat, :orgA, 'orders:approve')::text || '/' || pg_temp.in_res(:orgA, 'orders:approve', :seat)
  || ' old=' || pg_temp.hp(:old, :orgA, 'orders:approve')::text || '/' || pg_temp.in_res(:orgA, 'orders:approve', :old),
  'seat=true/false old=false/false',
  'T3a: a live Act-as seat holds orders:approve by has_permission and is never in the resolver; an expired one holds nothing and is not in it either');
select is(
  pg_temp.hp(:own, :orgA, 'orders:manage_catalog_visibility')::text || '/' || pg_temp.hp(:mgr, :orgA, 'orders:manage_catalog_visibility')::text
  || '|' || pg_temp.resolved(:orgA, 'orders:manage_catalog_visibility'),
  'true/true|',
  'T3b: a platform-managed key answers nobody, not even the owner, although has_permission answers true for the owner and a manager');

-- ══ T4. The INSERT alert follows orders:approve and warehouse write ═══════
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oT4,  :orgA, :whA1, 'pending_approval', 'internal', :stf,  'Req Person', 'pickup'),
  (:oT4c, :orgA, :whA2, 'pending_approval', 'internal', :stf,  'Req Person', 'pickup'),
  (:oT4b, :orgB, :whB1, 'pending_approval', 'internal', :stfB, 'Req Person', 'pickup');
select is(pg_temp.who('order_request.created', 'order_request_id', :oT4),
  'adm,mgr,own,stfAp,stfCh',
  'T4a: a new request in W1 tells the owner, the admin, the manager and the granted staff who work in W1 (a charter row counts); not the revoked admin or manager, staff without the grant, the muted approver, the W2 approver, the granted viewer, the disabled manager, the invite or either Act-as seat');
select is(pg_temp.who('order_request.created', 'order_request_id', :oT4c),
  'adm,mgr,own,stfW2',
  'T4b: a new request in W2 tells the W2 approver and none of the W1 staff approvers');
select is(pg_temp.who('order_request.created', 'order_request_id', :oT4b),
  'admBGr,ownB,stfB',
  'T4c: in B the staff granted it by the organization and assigned B1 are told, the admin under the organization''s revoke is not, and the admin granted it for themselves is');

-- ══ T5. Confirmed public request: the same audience ═══════════════════════
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oT5, :orgA, :whA1, 'pending_confirmation', 'internal', :stf, 'Req Person', 'pickup');
select pg_temp.who('order_request.created', 'order_request_id', :oT5) as "t5before" \gset
update public.order_requests set status = 'pending_approval' where id = :oT5;
select is(:'t5before' || '|' || pg_temp.who('order_request.created', 'order_request_id', :oT5),
  '|adm,mgr,own,stfAp,stfCh',
  'T5: a request waiting for confirmation tells nobody; on its move to pending approval it tells T4a''s set exactly');

-- ══ T6. The owners, admins and managers, never a seat ═════════════════════
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, requester_name, fulfillment_type) values
  (:oT6, :orgA, :whA1, 'approved', 'internal', :stf, 'Req Person', 'pickup');
select set_config('request.jwt.claim.sub', :stfAp, true) as "t6sub",
       set_config('request.jwt.claims', jsonb_build_object('sub', :stfAp, 'role', 'authenticated')::text, true) as "t6claims" \gset
update public.order_requests set status = 'cancelled', cancelled_by = :stfAp where id = :oT6;
select set_config('request.jwt.claim.sub', '', true) as "t6sub", set_config('request.jwt.claims', '', true) as "t6claims" \gset
select is(pg_temp.who('order_request.cancelled_after_approval', 'order_request_id', :oT6),
  'adm,admRev,mgr,mgrRev,own',
  'T6a: an approved order cancelled by a staff approver tells the owners, admins and managers (the revoked ones too: they may be preparing it) and neither Act-as seat');
update public.inventory_items set quantity_on_hand = 3 where id = :iLow;
select is(pg_temp.who('inventory.low_stock', 'item_id', :iLow),
  'adm,admRev,mgr,mgrRev,own',
  'T6b: a low-stock crossing tells the owners, admins and managers and neither Act-as seat');

-- ══ T7. Restatement: this migration's texts out, the old body back ════════
-- Each restated body with the texts this migration added taken back out (and
-- 0395's two loop sources put back) has the md5 it had before, so nothing
-- else in it changed.
select is(
  (select md5(p.prosrc) || '|' || md5(replace(replace(replace(p.prosrc,
            $a$
       -- The requester only while still a member of the organization:
       -- removing someone keeps requester_user_id, and a portal buyer
       -- never was a member.
       or not public._notify_is_current_member(new.organization_id, v_recipient)$a$, ''),
            $b$      select r.user_id
        from public._notify_recipients_with_permission(new.organization_id, 'orders:approve') r
       where public.user_can_access_warehouse(r.user_id, new.warehouse_id, 'write')$b$,
            $c$      select user_id from public._notify_recipients(new.organization_id)$c$),
            $d$        select r.user_id
          from public._notify_recipients_with_permission(new.organization_id, 'orders:approve') r
         where public.user_can_access_warehouse(r.user_id, new.warehouse_id, 'write')$d$,
            $e$        select user_id from public._notify_recipients(new.organization_id)$e$))
          || '|' || p.prosecdef::text || '|' || p.proconfig::text
     from pg_proc p where p.oid = 'public._notify_order_request_changes()'::regprocedure),
  'ca103ffa6669cdb7b885099c9a794fb5|438e676429dda6fb9d2b8faee8d6dd59|true|{search_path=public}',
  'T7a: _notify_order_request_changes is 0395''s body (438e6764) with exactly the two loop sources and the requester''s membership term changed');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $a$
    and om.impersonation_expires_at is null$a$, ''))
          || '|' || p.prosecdef::text || '|' || p.proconfig::text
     from pg_proc p where p.oid = 'public._notify_recipients(uuid)'::regprocedure),
  '7b53d7d107211e42620800cb1de7d476|679e6193e3dbe5644055e835e8209043|true|{search_path=public}',
  'T7b: _notify_recipients is 0313''s body (679e6193) with the one Act-as line added');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $a$
       -- The creator only while still a member of the organization:
       -- removing someone, or their leaving, deletes only the membership row.
       where public._notify_is_current_member(new.organization_id, new.created_by)$a$, ''))
          || '|' || p.prosecdef::text || '|' || p.proconfig::text
     from pg_proc p where p.oid = 'public._notify_po_status()'::regprocedure),
  'fd39932ad6c3c21b3e4e8d19a219845c|e80cc4f94048040e8a9d7daf83179f60|true|{search_path=public}',
  'T7c: _notify_po_status is 0092''s body (e80cc4f9) with the creator''s membership clause added');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $a$
       -- The creator only while still a member of the organization.
       where public._notify_is_current_member(new.organization_id, v_po.created_by)$a$, ''))
          || '|' || p.prosecdef::text || '|' || p.proconfig::text
     from pg_proc p where p.oid = 'public._notify_receipt_posted()'::regprocedure),
  'bddb6f437039c85464cf9de3f96cb86a|6fe68d1a1461d9d08cf69497f10dd070|true|{search_path=public}',
  'T7d: _notify_receipt_posted is 0157''s body (6fe68d1a) with the creator''s membership clause added');
select is(
  (select md5(p.prosrc) || '|' || md5(replace(p.prosrc, $a$
     -- The requester only while still a member of the organization:
     -- removing someone keeps requester_user_id, and a portal buyer
     -- never was a member.
     or not public._notify_is_current_member(new.organization_id, v_recipient)$a$, ''))
          || '|' || p.prosecdef::text || '|' || p.proconfig::text
     from pg_proc p where p.oid = 'public._notify_replacement_order_changes()'::regprocedure),
  '6bdc770d07726e3ee527562d395427e3|543131721dbd9c04bb954b447e389972|true|{"search_path=public, pg_temp"}',
  'T7e: _notify_replacement_order_changes is 0396''s body (54313172) with the requester''s membership term added');

-- ══ T8. A creator or requester is told only while a member ════════════════
update public.purchase_orders set status = 'ordered' where id in (:poStf, :poGone, :poDis, :poSeat);
select is(
  'dis:' || pg_temp.mine('purchase_order.status_changed', 'po_id', :poDis, :dis)
  || ',gone:' || pg_temp.mine('purchase_order.status_changed', 'po_id', :poGone, :gone)
  || ',seat:' || pg_temp.mine('purchase_order.status_changed', 'po_id', :poSeat, :seat)
  || ',stf:' || pg_temp.mine('purchase_order.status_changed', 'po_id', :poStf, :stf)
  || '|' || pg_temp.who('purchase_order.status_changed', 'po_id', :poGone),
  'dis:0,gone:0,seat:0,stf:1|adm,admRev,mgr,mgrRev,own',
  'T8a: a purchase order''s status change no longer tells a creator who was removed, is disabled or is an Act-as seat; a current creator (staff) is still told, and so are the owners, admins and managers');
insert into public.receipts (id, organization_id, purchase_order_id, warehouse_id, receipt_number, status, received_by, immutable_hash) values
  (:rcStf,  :orgA, :poStf,  :whA1, 'S36A-R-1', 'posted', :mgr, 'hash-s36a-1'),
  (:rcGone, :orgA, :poGone, :whA1, 'S36A-R-2', 'posted', :mgr, 'hash-s36a-2'),
  (:rcDis,  :orgA, :poDis,  :whA1, 'S36A-R-3', 'posted', :mgr, 'hash-s36a-3'),
  (:rcSeat, :orgA, :poSeat, :whA1, 'S36A-R-4', 'posted', :mgr, 'hash-s36a-4');
select is(
  'dis:' || pg_temp.mine('po.received', 'po_id', :poDis, :dis)
  || ',gone:' || pg_temp.mine('po.received', 'po_id', :poGone, :gone)
  || ',seat:' || pg_temp.mine('po.received', 'po_id', :poSeat, :seat)
  || ',stf:' || pg_temp.mine('po.received', 'po_id', :poStf, :stf)
  || '|' || pg_temp.who('po.received', 'po_id', :poGone),
  'dis:0,gone:0,seat:0,stf:1|adm,admRev,mgr,mgrRev,own',
  'T8b: a posted receipt no longer tells a creator who was removed, is disabled or is an Act-as seat; a current creator is still told, and so are the owners, admins and managers');
update public.order_requests set status = 'denied', denied_reason = 'Not this term' where id in (:oDenStf, :oDenGone);
update public.order_requests set status = 'staged_for_pickup' where id in (:oStgStf, :oStgGone);
select is(
  'gone:' || (pg_temp.mine('order_request.denied', 'order_request_id', :oDenGone, :gone)
              + pg_temp.mine('order_request.staged_for_pickup', 'order_request_id', :oStgGone, :gone))
  || ',stf:' || (pg_temp.mine('order_request.denied', 'order_request_id', :oDenStf, :stf)
                 + pg_temp.mine('order_request.staged_for_pickup', 'order_request_id', :oStgStf, :stf)),
  'gone:0,stf:2',
  'T8c: a requester who was removed is not told their order was denied or is ready; a current requester is told both');
update public.order_requests set status = 'staged_for_pickup' where id in (:oRepStf, :oRepGone);
select is(
  'gone:' || pg_temp.mine('order_request.staged_for_pickup', 'order_request_id', :oRepGone, :gone)
  || ',stf:' || pg_temp.mine('order_request.staged_for_pickup', 'order_request_id', :oRepStf, :stf)
  || '|' || coalesce((select string_agg(n.title, ',') from public.notifications n
                       where n.user_id = :stf and n.metadata->>'order_request_id' = :oRepStf), 'none'),
  'gone:0,stf:1|Your replacement is ready',
  'T8d: a replacement order''s requester who was removed is not pinged; a current requester still hears it in the replacement''s own words');
select is(
  (select string_agg(n.name || '=' || pg_temp.member(:orgA, n.id), ',' order by n.name collate "C")
     from pg_temp.names n where n.name in ('own', 'stf', 'vwrAp', 'gone', 'dis', 'inv', 'seat', 'old', 'ownB'))
  || ',null=' || pg_temp.member(:orgA, null),
  'dis=false,gone=false,inv=false,old=false,own=true,ownB=false,seat=false,stf=true,vwrAp=true,null=false',
  'T8e: the member check answers true for an accepted member of any role and false for a removed member, a disabled account, an invite, a live or expired Act-as seat, another organization''s member and no one');

select * from finish();
rollback;
