-- supabase/tests/0391_place_order_request.test.sql
-- pgTAP proof for migration 0391 (phone ordering PO-2): one create path for
-- every order request, and no duplicate order from a retry, a double tap or a
-- lost answer.
--
-- Personas (real `authenticated` calls with request.jwt.claim.sub):
--   own     owner                    adm    admin
--   mgr     manager                  mgr2   manager, "New order requests" off
--   mgrNo   manager whose orders:approve is revoked (user override false)
--   stf     staff assigned to whA    stfAp  staff assigned to whA, granted
--                                           orders:approve (user override)
--   stfNoReq staff assigned to whA, orders:request revoked
--   vwr     viewer with one category grant (catA) and a charter-scoped
--           assignment (whA, chA): the L4L shape
--   del     staff assigned to whA, whose account is deleted (D1)
--   dis     a disabled manager       mgrB   a manager of another org
--   nobody  signed in, in no org;  anon and service_role hold no EXECUTE.
--
-- G.  Grants and shape: order_submissions has RLS, SELECT and INSERT for
--     authenticated only (service_role SELECT, anon and PUBLIC nothing), two
--     policies (own rows; the flag-gated insert), its keys (the organization
--     and the order cascade, no foreign key on user_id), the one-order index;
--     the six functions' posture (INVOKER, volatility, search_path,
--     lock_timeout on the two writers, EXECUTE to authenticated only); the
--     flag census (exactly the two writers raise stockpilot.order_submit,
--     each with a literal name); no dynamic SQL; no 40001/40P01; the wrapper
--     reaches order_requests only through create_order_request.
-- P.  Place: one order, its lines (summed, item order), one placed row with
--     its surface, one notification per owner, admin and manager without an
--     opt-out; a self-submit carries no requester name or email (A2 F1); the
--     same key and body replays (no new order, line, notification or row);
--     another body is idempotency_conflict naming the stored order; another
--     user's same key is independent; two keys give consecutive numbers; the
--     answer's exact shape.
-- RF. Replay first: the item or the warehouse archived after the first call,
--     the resend still replays (mutation: look up after the floors).
-- R.  Recorded refusals, each recorded once and answered again with replay:
--     module off; orders:request revoked; a foreign, a hidden and an
--     archived warehouse; on behalf by the manager whose orders:approve is
--     revoked (the staff member granted it places on behalf: slice D's rule;
--     mutation: admit has_org_role manager); needed-by past and more than 5
--     years ahead; a site not serviced and an inactive site; each item
--     reason; the line guard's two sentences (probe triggers); a refusal
--     followed by a late original after the rule relaxed: the same refusal,
--     no order.
-- N.  Not recorded: signed out, placer_mismatch (before the key), a
--     non-member, a disabled member, every shape case of the parity fixture
--     (generated block): each writes nothing (mutation: record shape
--     refusals).
-- W.  Withdraw: with no row it records withdrawn and a later place answers
--     withdrawn with no order; with a placed row it returns the order and
--     writes nothing; a refused row returns the refusal; it needs only
--     membership (works with orders:request revoked).
-- S.  Status: none, placed, refused, withdrawn, only for your own key.
-- I.  The insert policy: a direct insert of each outcome without the flag is
--     refused; 'on' and another transaction's id are refused (mutation:
--     compare the flag to 'on'); SELECT shows only your own rows.
-- D.  Deletes: a user who has submissions is deleted and the rows stay; an
--     organization's deletion cascades; an order's deletion cascades its row.
-- RR. Recent requesters: [] without orders:approve (staff, the revoked
--     manager); one row per email ignoring case and spaces, at most 50, never
--     another organization's, never older than a year.
-- Z.  Frozen: the functions the wrapper relies on (md5, posture), the set
--     fingerprint of the first eight (0385 Z1 form), the five policy
--     fingerprints, the trigger lists.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt). begin/rollback: nothing leaks. Namespace 03910000.

begin;

select plan(51);

\set orgA    '\'03910000-0000-0000-0000-00000000000a\''
\set orgB    '\'03910000-0000-0000-0000-00000000000b\''
\set orgD    '\'03910000-0000-0000-0000-00000000000d\''
\set own     '\'03910000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03910000-0000-0000-0000-0000000000a1\''
\set mgr2    '\'03910000-0000-0000-0000-0000000000a2\''
\set mgrNo   '\'03910000-0000-0000-0000-0000000000a3\''
\set stf     '\'03910000-0000-0000-0000-0000000000a4\''
\set stfAp   '\'03910000-0000-0000-0000-0000000000a5\''
\set vwr     '\'03910000-0000-0000-0000-0000000000a6\''
\set stfNoRq '\'03910000-0000-0000-0000-0000000000a7\''
\set dis     '\'03910000-0000-0000-0000-0000000000a8\''
\set adm     '\'03910000-0000-0000-0000-0000000000a9\''
\set del     '\'03910000-0000-0000-0000-0000000000ab\''
\set mgrB    '\'03910000-0000-0000-0000-0000000000b1\''
\set ownD    '\'03910000-0000-0000-0000-0000000000b3\''
\set nobody  '\'03910000-0000-0000-0000-0000000000c1\''
\set whA     '\'03910000-0000-0000-0000-0000000000d1\''
\set whA2    '\'03910000-0000-0000-0000-0000000000d2\''
\set whArch  '\'03910000-0000-0000-0000-0000000000d3\''
\set whB     '\'03910000-0000-0000-0000-0000000000d4\''
\set whD     '\'03910000-0000-0000-0000-0000000000d5\''
\set chA     '\'03910000-0000-0000-0000-0000000000e1\''
\set chOff   '\'03910000-0000-0000-0000-0000000000e2\''
\set chFar   '\'03910000-0000-0000-0000-0000000000e3\''
\set catA    '\'03910000-0000-0000-0000-0000000000e8\''
\set catB    '\'03910000-0000-0000-0000-0000000000e9\''
\set iOk     '\'03910000-0000-0000-0000-000000000f01\''
\set iOk2    '\'03910000-0000-0000-0000-000000000f02\''
\set iVw     '\'03910000-0000-0000-0000-000000000f03\''
\set iVwHid  '\'03910000-0000-0000-0000-000000000f04\''
\set iDel    '\'03910000-0000-0000-0000-000000000f05\''
\set iMov    '\'03910000-0000-0000-0000-000000000f06\''
\set iArch   '\'03910000-0000-0000-0000-000000000f07\''
\set iRent   '\'03910000-0000-0000-0000-000000000f08\''
\set iAwait  '\'03910000-0000-0000-0000-000000000f09\''
\set iKit    '\'03910000-0000-0000-0000-000000000f0a\''
\set iLate   '\'03910000-0000-0000-0000-000000000f0b\''
\set iPrb1   '\'03910000-0000-0000-0000-000000000f0c\''
\set iPrb2   '\'03910000-0000-0000-0000-000000000f0d\''
\set iB      '\'03910000-0000-0000-0000-000000000f0e\''
\set iD      '\'03910000-0000-0000-0000-000000000f0f\''
\set pOrg    '\'0f0e0000-0000-4000-8000-00000000000a\''
\set pPlacer '\'0f0e0000-0000-4000-8000-0000000000a1\''
\set pOther  '\'0f0e0000-0000-4000-8000-0000000000a2\''
\set pWh     '\'0f0e0000-0000-4000-8000-0000000000d1\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,     '0391-own@test.local',    '{}'::jsonb),
  (:adm,     '0391-adm@test.local',    '{}'::jsonb),
  (:mgr,     '0391-mgr@test.local',    '{}'::jsonb),
  (:mgr2,    '0391-mgr2@test.local',   '{}'::jsonb),
  (:mgrNo,   '0391-mgrno@test.local',  '{}'::jsonb),
  (:stf,     '0391-stf@test.local',    '{}'::jsonb),
  (:stfAp,   '0391-stfap@test.local',  '{}'::jsonb),
  (:vwr,     '0391-vwr@test.local',    '{}'::jsonb),
  (:stfNoRq, '0391-stfnorq@test.local','{}'::jsonb),
  (:dis,     '0391-dis@test.local',    '{}'::jsonb),
  (:del,     '0391-del@test.local',    '{}'::jsonb),
  (:mgrB,    '0391-mgrb@test.local',   '{}'::jsonb),
  (:ownD,    '0391-ownd@test.local',   '{}'::jsonb),
  (:nobody,  '0391-nobody@test.local', '{}'::jsonb),
  (:pPlacer, '0391-pplacer@test.local','{}'::jsonb),
  (:pOther,  '0391-pother@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0391 Orders A', '0391-orders-a'),
  (:orgB, '0391 Orders B', '0391-orders-b'),
  (:orgD, '0391 Orders D', '0391-orders-d'),
  (:pOrg, '0391 Parity',   '0391-parity');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,     'owner',   now()),
  (:orgA, :adm,     'admin',   now()),
  (:orgA, :mgr,     'manager', now()),
  (:orgA, :mgr2,    'manager', now()),
  (:orgA, :mgrNo,   'manager', now()),
  (:orgA, :stf,     'staff',   now()),
  (:orgA, :stfAp,   'staff',   now()),
  (:orgA, :vwr,     'viewer',  now()),
  (:orgA, :stfNoRq, 'staff',   now()),
  (:orgA, :dis,     'manager', now()),
  (:orgA, :del,     'staff',   now()),
  (:orgB, :mgrB,    'manager', now()),
  (:orgD, :ownD,    'owner',   now()),
  (:pOrg, :pPlacer, 'staff',   now()),
  (:pOrg, :pOther,  'staff',   now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,    :orgA, '0391 Main',     'WH-0391A',  'active'),
  (:whA2,   :orgA, '0391 Annex',    'WH-0391A2', 'active'),
  (:whArch, :orgA, '0391 Old',      'WH-0391AR', 'archived'),
  (:whB,    :orgB, '0391 Other',    'WH-0391B',  'active'),
  (:whD,    :orgD, '0391 D',        'WH-0391D',  'active'),
  (:pWh,    :pOrg, '0391 Parity',   'WH-0391P',  'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA,   :orgA, '0391 North',  'C0391N', 'active'),
  (:chOff, :orgA, '0391 Closed', 'C0391C', 'inactive'),
  (:chFar, :orgA, '0391 Far',    'C0391F', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA,  :chA),
  (:orgA, :whA,  :chOff),
  (:orgA, :whA2, :chFar);
insert into public.categories (id, organization_id, name) values
  (:catA, :orgA, '0391 Books'),
  (:catB, :orgA, '0391 Tech');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,     :whA, null, true),
  (:orgA, :stfAp,   :whA, null, true),
  (:orgA, :stfNoRq, :whA, null, true),
  (:orgA, :del,     :whA, null, true),
  (:orgA, :vwr,     :whA, :chA, true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwr, :catA);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :mgrNo,   'orders:approve', false),
  (:orgA, :stfAp,   'orders:approve', true),
  (:orgA, :stfNoRq, 'orders:request', false);
insert into public.notification_preferences (user_id, push_order_request_created) values (:mgr2, false)
  on conflict (user_id) do update set push_order_request_created = false;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, category_id, charter_id,
   is_rental, awaiting_first_receipt, is_bundle, deleted_at) values
  (:iOk,    :orgA, :whA,  'X0391-OK',   'Fine item',      10, 'active',   :catA, null, false, false, false, null),
  (:iOk2,   :orgA, :whA,  'X0391-OK2',  'Fine item two',  10, 'active',   :catB, null, false, false, false, null),
  (:iVw,    :orgA, :whA,  'X0391-VW',   'Charter book',   10, 'active',   :catA, :chA, false, false, false, null),
  (:iVwHid, :orgA, :whA,  'X0391-VWH',  'Charter laptop', 10, 'active',   :catB, :chA, false, false, false, null),
  (:iDel,   :orgA, :whA,  'X0391-DEL',  'Deleted item',   10, 'active',   :catA, null, false, false, false, now()),
  (:iMov,   :orgA, :whA2, 'X0391-MOV',  'Annex item',     10, 'active',   :catA, null, false, false, false, null),
  (:iArch,  :orgA, :whA,  'X0391-ARC',  'Archived item',  10, 'archived', :catA, null, false, false, false, null),
  (:iRent,  :orgA, :whA,  'X0391-RNT',  'Rental item',    10, 'active',   :catA, null, true,  false, false, null),
  (:iAwait, :orgA, :whA,  'X0391-AWT',  'Expected item',  0,  'active',   :catA, null, false, true,  false, null),
  (:iKit,   :orgA, :whA,  'X0391-KIT',  'Kit stock',      10, 'active',   :catA, null, false, false, true,  null),
  (:iLate,  :orgA, :whA,  'X0391-LATE', 'Late item',      0,  'active',   :catA, null, false, true,  false, null),
  (:iPrb1,  :orgA, :whA,  'X0391-PR1',  'Probe one',      10, 'active',   :catA, null, false, false, false, null),
  (:iPrb2,  :orgA, :whA,  'X0391-PR2',  'Probe two',      10, 'active',   :catA, null, false, false, false, null),
  (:iB,     :orgB, :whB,  'X0391-B',    'Org B item',     10, 'active',   null,  null, false, false, false, null),
  (:iD,     :orgD, :whD,  'X0391-D',    'Org D item',     10, 'active',   null,  null, false, false, false, null);

-- The disabled manager, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- One call as a role and a user. Answers the result as text, or
-- ERR:<sqlstate>:<hint>:<detail> (a failed call's subtransaction is rolled
-- back, so it wrote nothing; its set_config calls are undone with it).
create function pg_temp.run(p_as text, p_sub uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_detail text; v text;
begin
  begin
    perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
    perform set_config('role', p_as, true);
    execute p_sql into v;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claim.sub', '', true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_detail = pg_exception_detail;
    return 'ERR:' || v_state || ':' || coalesce(v_hint, '') || ':' || coalesce(v_detail, '');
  end;
  return coalesce(v, 'null');
end $$;
-- A request (snake_case, as the service builds it) for orgA.
create function pg_temp.req(p_placer uuid, p_wh uuid, p_lines jsonb, p_extra jsonb default '{}'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'organization_id', '03910000-0000-0000-0000-00000000000a', 'placer_user_id', p_placer,
    'surface', 'web', 'warehouse_id', p_wh, 'fulfillment_type', 'pickup', 'delivery_charter_id', null,
    'on_behalf_name', null, 'on_behalf_email', null, 'notes', null, 'needed_by', null, 'lines', p_lines) || p_extra
$$;
create function pg_temp.l1(p_item uuid, p_qty integer default 1) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('item_id', p_item, 'quantity', p_qty))
$$;
-- Key n.
create function pg_temp.k(p_n integer) returns text language sql as $$
  select '03919000-0000-4000-8000-' || lpad(to_hex(p_n), 12, '0')
$$;
create function pg_temp.place(p_sub uuid, p_req jsonb, p_key text) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.place_order_request(%L::jsonb, %L)::text', p_req, p_key))
$$;
create function pg_temp.withdraw(p_sub uuid, p_org uuid, p_key text, p_surface text default 'web') returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.withdraw_order_submission(%L, %L, %L)::text', p_org, p_key, p_surface))
$$;
create function pg_temp.status(p_sub uuid, p_org uuid, p_key text) returns text language sql as $$
  select pg_temp.run('authenticated', p_sub, format('select public.order_submission_status(%L, %L)::text', p_org, p_key))
$$;
-- outcome/replay/reason/detail of an answer (or the ERR text as it is).
create function pg_temp.brief(p text) returns text language sql as $$
  select case when p like 'ERR:%' then p
    else concat_ws('/', p::jsonb->>'outcome', coalesce(p::jsonb->>'replay', '-'),
                   coalesce(p::jsonb#>>'{refusal,reason}', '-'), coalesce(p::jsonb#>'{refusal,detail}', 'null'::jsonb)::text) end
$$;
-- Orders, lines, submissions and notifications in the 0391 orgs.
create function pg_temp.counts() returns text language sql as $$
  select (select count(*) from public.order_requests where organization_id in ('03910000-0000-0000-0000-00000000000a', '03910000-0000-0000-0000-00000000000b'))::text || '|'
      || (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
           where o.organization_id in ('03910000-0000-0000-0000-00000000000a', '03910000-0000-0000-0000-00000000000b'))::text || '|'
      || (select count(*) from public.order_submissions where organization_id in ('03910000-0000-0000-0000-00000000000a', '03910000-0000-0000-0000-00000000000b'))::text || '|'
      || (select count(*) from public.notifications where organization_id in ('03910000-0000-0000-0000-00000000000a', '03910000-0000-0000-0000-00000000000b'))::text
$$;

create temp table ans (tag text primary key, r text);
create temp table pop_case (case_no integer primary key, case_id text not null, request jsonb not null, p_key text,
                            expect_sqlstate text, expect_hint text, expect_field text);

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.inventory_items where id::text like '03910000-%') <> 15 then
    raise exception 'fixture: items';
  end if;
  if not public.module_enabled('03910000-0000-0000-0000-00000000000a', 'orders')
     or not public.module_enabled('0f0e0000-0000-4000-8000-00000000000a', 'orders') then
    raise exception 'fixture: modules';
  end if;
end $$;

-- ═══ G. Grants and shape ══════════════════════════════════════════════════
select is(
  (select c.relrowsecurity::text || '|' || c.relforcerowsecurity::text from pg_class c where c.oid = 'public.order_submissions'::regclass)
  || '|' || (select string_agg(r.r || '=' || coalesce((select string_agg(p.p, ',' order by p.p)
                                                    from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(p)
                                                   where has_table_privilege(r.r, 'public.order_submissions', p.p)), '-'), ' ' order by r.r)
               from unnest(array['anon', 'authenticated', 'service_role']) r(r))
  || '|' || (select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.order_submissions'::regclass and a.grantee = 0)::text,
  'true|false|anon=- authenticated=INSERT,SELECT service_role=SELECT|0',
  'G1: order_submissions has RLS on; authenticated holds SELECT and INSERT only, service_role SELECT only, anon and PUBLIC nothing');
select is(
  (select string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polroles::regrole[]::text || '|'
                     || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
                     E'\n' order by pol.polname)
     from pg_policy pol where pol.polrelid = 'public.order_submissions'::regclass),
  E'order_submissions_insert|a|{authenticated}||((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT is_org_member(order_submissions.organization_id) AS is_org_member) AND (COALESCE(current_setting(''stockpilot.order_submit''::text, true), ''''::text) = (pg_current_xact_id())::text))\n'
  'order_submissions_select|r|{authenticated}|((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT is_org_member(order_submissions.organization_id) AS is_org_member))|',
  'G2: two policies, both for authenticated: SELECT of your own rows (member), INSERT of your own rows only while the flag holds this transaction''s id; no UPDATE or DELETE policy');
select is(
  (select string_agg(pg_get_constraintdef(c.oid), E'\n' order by pg_get_constraintdef(c.oid))
     from pg_constraint c where c.conrelid = 'public.order_submissions'::regclass and c.contype in ('f', 'p', 'u'))
  || E'\n' || (select pg_get_indexdef(i.indexrelid) from pg_index i
                where i.indrelid = 'public.order_submissions'::regclass and not i.indisprimary),
  E'FOREIGN KEY (order_request_id) REFERENCES order_requests(id) ON DELETE CASCADE\n'
  'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE\n'
  'PRIMARY KEY (organization_id, user_id, key)\n'
  'CREATE UNIQUE INDEX order_submissions_order_request_uidx ON public.order_submissions USING btree (order_request_id) WHERE (order_request_id IS NOT NULL)',
  'G3: the organization and the order cascade, there is NO foreign key on user_id (account deletion is never blocked), one row per (org, placer, key) and at most one per order');
select is(
  (select string_agg(p.proname || '=' || p.provolatile::text || '/' || p.prosecdef || '/' || coalesce(p.proconfig::text, '')
                     || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || '/' || exists (select 1 from unnest(p.proacl) a where a::text like '=%')
                     || '/' || pg_get_userbyid(p.proowner), E'\n' order by p.proname)
     from pg_proc p
    where p.oid in ('public.place_order_request(jsonb, text)'::regprocedure,
                    'public.withdraw_order_submission(uuid, text, text)'::regprocedure,
                    'public.order_submission_status(uuid, text)'::regprocedure,
                    'public.order_items_orderable(uuid, uuid[])'::regprocedure,
                    'public.order_recent_requesters(uuid)'::regprocedure,
                    'public._order_submission_summary(uuid)'::regprocedure)),
  E'_order_submission_summary=s/false/{"search_path=public, pg_temp"}/true/false/false/false/postgres\n'
  'order_items_orderable=s/false/{"search_path=public, pg_temp"}/true/false/false/false/postgres\n'
  'order_recent_requesters=s/false/{"search_path=public, pg_temp"}/true/false/false/false/postgres\n'
  'order_submission_status=s/false/{"search_path=public, pg_temp"}/true/false/false/false/postgres\n'
  'place_order_request=v/false/{"search_path=public, pg_temp",lock_timeout=5s}/true/false/false/false/postgres\n'
  'withdraw_order_submission=v/false/{"search_path=public, pg_temp",lock_timeout=5s}/true/false/false/false/postgres',
  'G4: the six functions are SECURITY INVOKER (RLS and create_order_request''s policies apply), search_path pinned, lock_timeout 5s on the two writers, the reads STABLE; EXECUTE to authenticated only (not service_role, which has no auth.uid(), not anon, not PUBLIC); owned by postgres');
select is(
  (select string_agg(n.nspname || '.' || p.proname, ',' order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'storage', 'graphql_public', 'ledger', 'extensions')
      and p.prosrc ~* '(set_config|set\s+(local\s+)?)[^;]*stockpilot\.order_submit'),
  'public.place_order_request,public.withdraw_order_submission',
  'G5: census: exactly place_order_request and withdraw_order_submission raise stockpilot.order_submit (no helper writes order_submissions)');
select is(
  (select string_agg(p.proname || ':' || (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '\mexecute\M')::text
                     || ':' || (p.prosrc ~ 'set_config\s*\(\s*[^''\s]')::text
                     || ':' || (p.prosrc ~* $re$errcode\s*=\s*'(40001|40p01|serialization_failure|deadlock_detected)'$re$)::text
                     || ':' || (p.prosrc ~* '(insert\s+into|update|delete\s+from|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?order_requests\M')::text,
                     ',' order by p.proname)
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('place_order_request', 'withdraw_order_submission', 'order_submission_status', 'order_items_orderable',
                        'order_recent_requesters', '_order_submission_summary')),
  '_order_submission_summary:false:false:false:false,order_items_orderable:false:false:false:false,'
  'order_recent_requesters:false:false:false:false,order_submission_status:false:false:false:false,'
  'place_order_request:false:false:false:false,withdraw_order_submission:false:false:false:false',
  'G6: no 0391 function runs dynamic SQL (0359 premise), passes a non-literal name to set_config, raises 40001/40P01 (0367), or writes order_requests itself');
select ok(
  (select p.prosrc ~ 'public\.create_order_request\('
          and p.prosrc ~ 'pg_advisory_xact_lock\('
          and p.prosrc ~ $re$public\.module_enabled\(v_org, 'orders'\)$re$
          and p.prosrc ~ $re$public\.has_permission\(v_org, 'orders:request'\)$re$
          and p.prosrc ~ $re$public\.has_permission\(v_org, 'orders:approve'\)$re$
          and p.prosrc !~ $re$has_org_role$re$
          and p.prosrc ~ 'public\.order_items_orderable\(v_wh, v_item_ids\)'
     from pg_proc p where p.oid = 'public.place_order_request(jsonb, text)'::regprocedure),
  'G7: place_order_request creates through create_order_request under the key''s advisory lock, gates on the orders module, orders:request and (on behalf) orders:approve with no role-rank term (slice D), and asks order_items_orderable');

-- ═══ P. Place ═════════════════════════════════════════════════════════════
select pg_temp.counts() as "c0" \gset
insert into ans values ('P1', pg_temp.place(:stf, pg_temp.req(:stf, :whA,
  jsonb_build_array(jsonb_build_object('item_id', :iOk2, 'quantity', 2), jsonb_build_object('item_id', :iOk, 'quantity', 3),
                    jsonb_build_object('item_id', :iOk2, 'quantity', 4)),
  jsonb_build_object('notes', E'  Room 12 \t', 'needed_by', to_char((now() + interval '3 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"'))),
  pg_temp.k(1)));
select is(
  (select (a.r::jsonb->>'outcome') || '/' || (a.r::jsonb->>'replay') || '/'
          || (select string_agg(o.status || '/' || o.requester_user_id::text || '/' || coalesce(o.requester_name, 'null') || '/'
                                || coalesce(o.requester_email, 'null') || '/' || coalesce(o.notes, 'null') || '/'
                                || (o.needed_by = date_trunc('minute', now() + interval '3 days'))::text, ',')
                from public.order_requests o where o.id = (a.r::jsonb#>>'{order,id}')::uuid)
          || '/' || (select string_agg(l.item_id::text || '=' || trim_scale(l.quantity_requested)::text, ',' order by l.item_id)
                       from public.order_request_lines l where l.order_request_id = (a.r::jsonb#>>'{order,id}')::uuid)
     from ans a where a.tag = 'P1'),
  'placed/false/pending_approval/' || :stf || '/null/null/Room 12/true/' || :iOk || '=3,' || :iOk2 || '=6',
  'P1: a staff member''s first call places one order pending approval for themself, with NO requester name or email (A2 F1: a self-submit carries none), notes trimmed of JavaScript''s whitespace, the needed-by instant as sent, and one line per item, summed');
select is(
  (select s.outcome || '|' || s.surface || '|' || (s.user_id = :stf)::text || '|' || (s.order_request_id = (a.r::jsonb#>>'{order,id}')::uuid)::text
          || '|' || (s.request_hash ~ '^[0-9a-f]{32}$')::text || '|' || coalesce(s.refusal::text, 'null')
     from public.order_submissions s, ans a where a.tag = 'P1' and s.key = pg_temp.k(1)::uuid)
  || '|' || (select string_agg(u.who, ',' order by u.who) from public.notifications n
               join (values (:own::uuid, 'own'), (:adm::uuid, 'adm'), (:mgr::uuid, 'mgr'), (:mgr2::uuid, 'mgr2'), (:mgrNo::uuid, 'mgrNo'), (:dis::uuid, 'dis')) u(id, who) on u.id = n.user_id
              where n.type = 'order_request.created' and n.link = '/dashboard/orders/' || (select a.r::jsonb#>>'{order,id}' from ans a where a.tag = 'P1')),
  'placed|web|true|true|true|null|adm,mgr,mgrNo,own',
  'P2: one placed row for the key (the placer, the order, the hash, the surface) and one "New order request" notification per owner, admin and manager, the revoked manager included (role-based alerts), not the manager who turned it off nor the disabled one');
select is(
  (select string_agg(k, ',' order by k) from jsonb_object_keys((select a.r::jsonb->'order' from ans a where a.tag = 'P1')) k)
  || '|' || (select (a.r::jsonb#>>'{order,line_count}') || '/' || (a.r::jsonb#>>'{order,unit_count}') || '/'
                    || ((a.r::jsonb#>>'{order,order_number}')::bigint = o.order_number)::text
               from ans a join public.order_requests o on o.id = (a.r::jsonb#>>'{order,id}')::uuid where a.tag = 'P1'),
  'created_at,delivery_charter_id,fulfillment_type,id,line_count,needed_by,order_number,requester_email,requester_name,requester_user_id,status,unit_count,warehouse_id|2/9/true',
  'P3: the answer names the order by its summary only (no token, signature or cost): id, number, status, warehouse, method, site, needed-by, created, requester, 2 lines and 9 units');
select pg_temp.counts() as "c1" \gset
insert into ans values ('P4', pg_temp.place(:stf, pg_temp.req(:stf, :whA,
  jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity', 3), jsonb_build_object('item_id', :iOk2, 'quantity', 6)),
  jsonb_build_object('notes', 'Room 12', 'needed_by', to_char((now() + interval '3 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:00.000"Z"'))),
  pg_temp.k(1)));
select is(
  (select (a.r::jsonb->>'outcome') || '/' || (a.r::jsonb->>'replay') || '/'
          || ((a.r::jsonb#>>'{order,id}') = (b.r::jsonb#>>'{order,id}'))::text from ans a, ans b where a.tag = 'P4' and b.tag = 'P1')
  || '|' || (pg_temp.counts() = :'c1')::text,
  'placed/true/true|true',
  'P4: the same key with the same request (the lines already summed, the notes already trimmed, the instant in another spelling) replays the first order: no new order, line, notification or row');
select is(
  pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk, 4)), pg_temp.k(1)),
  (select 'ERR:P0001:idempotency_conflict:' || jsonb_build_object('orderId', o.id, 'orderNumber', o.order_number)::text
     from ans a join public.order_requests o on o.id = (a.r::jsonb#>>'{order,id}')::uuid where a.tag = 'P1'),
  'P5: the same key with another request is P0001 idempotency_conflict naming the stored order, never a second order');
select is(
  (select pg_temp.counts() = :'c1')::text,
  'true',
  'P6: the conflict wrote nothing');
insert into ans values ('P7', pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iOk, 1)), pg_temp.k(1)));
insert into ans values ('P8', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk, 1)), pg_temp.k(2)));
insert into ans values ('P9', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk, 1)), pg_temp.k(3)));
select is(
  (select pg_temp.brief(a.r) from ans a where a.tag = 'P7') || '|'
  || ((select a.r::jsonb#>>'{order,id}' from ans a where a.tag = 'P7') <> (select a.r::jsonb#>>'{order,id}' from ans a where a.tag = 'P1'))::text || '|'
  || ((select (a.r::jsonb#>>'{order,order_number}')::bigint from ans a where a.tag = 'P9')
      - (select (a.r::jsonb#>>'{order,order_number}')::bigint from ans a where a.tag = 'P8'))::text,
  'placed/false/-/null|true|1',
  'P7: another member''s identical key is their own namespace (an independent order); two keys from one person give two orders with consecutive numbers');
insert into ans values ('P10', pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iOk, 2),
  jsonb_build_object('on_behalf_name', '  Maria Lopez ', 'on_behalf_email', ' Maria@Example.org', 'fulfillment_type', 'delivery', 'delivery_charter_id', :chA)),
  pg_temp.k(4)));
select is(
  (select coalesce(o.requester_user_id::text, 'null') || '/' || o.requester_name || '/' || o.requester_email || '/' || o.fulfillment_type || '/' || o.delivery_charter_id::text
          || '/' || (s.user_id = :mgr)::text
     from ans a join public.order_requests o on o.id = (a.r::jsonb#>>'{order,id}')::uuid
     join public.order_submissions s on s.order_request_id = o.id where a.tag = 'P10'),
  'null/Maria Lopez/Maria@Example.org/delivery/' || :chA || '/true',
  'P8: a manager''s on-behalf delivery: no requester, the trimmed name and email, the site; the placer is on record only in order_submissions');

-- ═══ RF. Replay first ════════════════════════════════════════════════════
insert into ans values ('RF0', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iPrb1, 1)), pg_temp.k(10)));
update public.inventory_items set status = 'archived' where id = :iPrb1;
update public.warehouses set status = 'archived' where id = :whA;
select is(
  pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iPrb1, 1)), pg_temp.k(10)))
  || '|' || ((select a.r::jsonb#>>'{order,id}' from ans a where a.tag = 'RF0')
             = (pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iPrb1, 1)), pg_temp.k(10))::jsonb#>>'{order,id}'))::text,
  'placed/true/-/null|true',
  'RF1: with the item AND the warehouse archived after the first call, the resend still replays the order (the lookup comes before every floor; mutation: look up after the floors)');
update public.warehouses set status = 'active' where id = :whA;
update public.inventory_items set status = 'active' where id = :iPrb1;

-- ═══ R. Recorded refusals ════════════════════════════════════════════════
select pg_temp.counts() as "c2" \gset
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
insert into ans values ('R1a', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), pg_temp.k(20)));
insert into ans values ('R1b', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), pg_temp.k(20)));
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';
-- The rule relaxed (module back on); the late original still gets the refusal.
insert into ans values ('R1c', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), pg_temp.k(20)));
select is(
  (select string_agg(pg_temp.brief(a.r), ' ' order by a.tag) from ans a where a.tag in ('R1a', 'R1b', 'R1c')),
  'refused/false/module_disabled/null refused/true/module_disabled/null refused/true/module_disabled/null',
  'R1: the orders module off is recorded under the key; the resend gets the same refusal with replay, and so does a late original after the module is back on');
select is(
  (select count(*) from public.order_submissions where key = pg_temp.k(20)::uuid)::text || '|'
  || (select count(*) from public.order_requests where organization_id = :orgA)::text,
  '1|' || split_part(:'c2', '|', 1),
  'R2: the refusal was recorded once and no order was written');
select is(
  pg_temp.brief(pg_temp.place(:stfNoRq, pg_temp.req(:stfNoRq, :whA, pg_temp.l1(:iOk)), pg_temp.k(21))) || ' '
  || pg_temp.brief(pg_temp.place(:stfNoRq, pg_temp.req(:stfNoRq, :whA, pg_temp.l1(:iOk)), pg_temp.k(21))),
  'refused/false/permission/null refused/true/permission/null',
  'R3: orders:request revoked by a user override: permission, recorded and replayed');
select is(
  pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whB, pg_temp.l1(:iB)), pg_temp.k(22))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA2, pg_temp.l1(:iMov)), pg_temp.k(23))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whArch, pg_temp.l1(:iOk)), pg_temp.k(24))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whB, pg_temp.l1(:iB)), pg_temp.k(22))),
  'refused/false/warehouse_not_available/null refused/false/warehouse_not_available/null refused/false/warehouse_not_available/null refused/true/warehouse_not_available/null',
  'R4: another organization''s warehouse, a warehouse the staff member is not assigned to (hidden by warehouses_select) and an archived one: warehouse_not_available, recorded and replayed');
select is(
  pg_temp.brief(pg_temp.place(:mgrNo, pg_temp.req(:mgrNo, :whA, pg_temp.l1(:iOk), jsonb_build_object('on_behalf_name', 'Ann', 'on_behalf_email', 'ann@example.org')), pg_temp.k(25))) || ' '
  || pg_temp.brief(pg_temp.place(:mgrNo, pg_temp.req(:mgrNo, :whA, pg_temp.l1(:iOk), jsonb_build_object('on_behalf_name', 'Ann', 'on_behalf_email', 'ann@example.org')), pg_temp.k(25))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk), jsonb_build_object('on_behalf_name', 'Ann', 'on_behalf_email', 'ann@example.org')), pg_temp.k(26))),
  'refused/false/on_behalf_not_permitted/null refused/true/on_behalf_not_permitted/null refused/false/on_behalf_not_permitted/null',
  'R5: on behalf of someone else by a manager whose orders:approve is revoked, and by plain staff: on_behalf_not_permitted (slice D: on-behalf follows orders:approve, not the role; mutation: admit has_org_role manager)');
insert into ans values ('R6', pg_temp.place(:stfAp, pg_temp.req(:stfAp, :whA, pg_temp.l1(:iOk), jsonb_build_object('on_behalf_name', 'Ann', 'on_behalf_email', 'ann@example.org')), pg_temp.k(27)));
select is(
  (select pg_temp.brief(a.r) || '|' || coalesce(o.requester_user_id::text, 'null') || '/' || o.requester_name || '/' || o.requester_email
     from ans a join public.order_requests o on o.id = (a.r::jsonb#>>'{order,id}')::uuid where a.tag = 'R6'),
  'placed/false/-/null|null/Ann/ann@example.org',
  'R6: a staff member granted orders:approve places an order on behalf of someone else (the wrapper, the insert policy and the app agree)');
select is(
  pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk), jsonb_build_object('needed_by', to_char((now() - interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))), pg_temp.k(28))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk), jsonb_build_object('needed_by', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))), pg_temp.k(29))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk), jsonb_build_object('needed_by', to_char((now() + interval '5 years 1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))), pg_temp.k(30))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk), jsonb_build_object('needed_by', to_char((now() - interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))), pg_temp.k(28))),
  'refused/false/needed_by_past/null refused/false/needed_by_past/null refused/false/needed_by_out_of_range/null refused/true/needed_by_past/null',
  'R7: a needed-by in the past (and one equal to now) is needed_by_past, more than 5 years ahead is needed_by_out_of_range, each recorded and replayed');
select is(
  pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iOk), jsonb_build_object('fulfillment_type', 'delivery', 'delivery_charter_id', :chFar)), pg_temp.k(31))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iOk), jsonb_build_object('fulfillment_type', 'delivery', 'delivery_charter_id', :chOff)), pg_temp.k(32))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iOk), jsonb_build_object('fulfillment_type', 'delivery', 'delivery_charter_id', :chOff)), pg_temp.k(32))),
  'refused/false/site_not_available/"not_serviced" refused/false/site_not_available/"inactive" refused/true/site_not_available/"inactive"',
  'R8: a site the warehouse does not deliver to is site_not_available (not_serviced), an inactive site is site_not_available (inactive), recorded and replayed');
select is(
  pg_temp.brief(pg_temp.place(:vwr, pg_temp.req(:vwr, :whA, pg_temp.l1(:iVwHid)), pg_temp.k(33))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iDel)), pg_temp.k(34))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iMov)), pg_temp.k(35))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iArch)), pg_temp.k(36))),
  'refused/false/item_not_orderable/{"' || :iVwHid || '": "not_visible"} refused/false/item_not_orderable/{"' || :iDel || '": "deleted"} '
  'refused/false/item_not_orderable/{"' || :iMov || '": "other_warehouse"} refused/false/item_not_orderable/{"' || :iArch || '": "archived"}',
  'R9: item_not_orderable names each item and why: hidden from the scoped viewer by category (not_visible), deleted, in another warehouse, archived');
select is(
  pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iRent)), pg_temp.k(37))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iAwait)), pg_temp.k(38))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iKit)), pg_temp.k(39))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, jsonb_build_array(jsonb_build_object('item_id', :iOk, 'quantity', 1), jsonb_build_object('item_id', :iRent, 'quantity', 1))), pg_temp.k(40))) || ' '
  || pg_temp.brief(pg_temp.place(:mgr, pg_temp.req(:mgr, :whA, pg_temp.l1(:iKit)), pg_temp.k(39))),
  'refused/false/item_not_orderable/{"' || :iRent || '": "rental"} refused/false/item_not_orderable/{"' || :iAwait || '": "awaiting_first_receipt"} '
  'refused/false/item_not_orderable/{"' || :iKit || '": "kit_stock"} refused/false/item_not_orderable/{"' || :iRent || '": "rental"} '
  'refused/true/item_not_orderable/{"' || :iKit || '": "kit_stock"}',
  'R10: a rental item, an item awaiting its first receipt and a kit''s stock are item_not_orderable; beside a fine item only the bad one is named; replayed');
select is(
  pg_temp.brief(pg_temp.place(:vwr, pg_temp.req(:vwr, :whA, pg_temp.l1(:iVw)), pg_temp.k(41))),
  'placed/false/-/null',
  'R11: the scoped viewer places an order for an item inside their category and charter scope');
-- The late original: refused while the item awaits its first receipt, then
-- received; the same key still gets the refusal and writes no order.
insert into ans values ('R12a', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iLate)), pg_temp.k(42)));
update public.inventory_items set awaiting_first_receipt = false where id = :iLate;
select pg_temp.counts() as "c3" \gset
select is(
  (select pg_temp.brief(a.r) from ans a where a.tag = 'R12a') || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iLate)), pg_temp.k(42))) || '|'
  || (pg_temp.counts() = :'c3')::text,
  'refused/false/item_not_orderable/{"' || :iLate || '": "awaiting_first_receipt"} refused/true/item_not_orderable/{"' || :iLate || '": "awaiting_first_receipt"}|true',
  'R12: a recorded refusal followed by the late original after the item was received: the same refusal, no order, nothing written');
-- The line guard's two sentences, reached through probe triggers (dropped
-- below): the item turns into a rental between the floors and the lines, and
-- a line's quantity turns into NaN.
create function public._zz0391_probe_flip() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.inventory_items set is_rental = true where id = '03910000-0000-0000-0000-000000000f0c';
  return new;
end $$;
create trigger trg_aa_0391_probe_flip after insert on public.order_requests
  for each row when (new.notes = 'probe-flip') execute function public._zz0391_probe_flip();
create function public._zz0391_probe_nan() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.item_id = '03910000-0000-0000-0000-000000000f0d' then
    new.quantity_requested := 'NaN';
  end if;
  return new;
end $$;
create trigger trg_aa_0391_probe_nan before insert on public.order_request_lines
  for each row execute function public._zz0391_probe_nan();
select pg_temp.counts() as "c4" \gset
select is(
  pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iPrb1), jsonb_build_object('notes', 'probe-flip')), pg_temp.k(43))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iPrb2)), pg_temp.k(44))) || ' '
  || pg_temp.brief(pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iPrb2)), pg_temp.k(44))) || '|'
  || (select count(*) from public.order_requests where organization_id = :orgA)::text,
  'refused/false/item_not_orderable/{} refused/false/invalid/null refused/true/invalid/null|' || split_part(:'c4', '|', 1),
  'R13: the line guard''s two sentences are caught by SQLSTATE and exact text and recorded (item_not_orderable; invalid); the order and its notifications roll back with them');
drop trigger trg_aa_0391_probe_flip on public.order_requests;
drop trigger trg_aa_0391_probe_nan on public.order_request_lines;
drop function public._zz0391_probe_flip();
drop function public._zz0391_probe_nan();
select is(
  (select count(*) from public.inventory_items where id = :iPrb1 and is_rental)::text,
  '0',
  'R14: the probe''s change rolled back with the refused create');

-- ═══ N. Not recorded ═════════════════════════════════════════════════════
select pg_temp.counts() as "c5" \gset
select is(
  pg_temp.run('authenticated', null, format('select public.place_order_request(%L::jsonb, %L)::text', pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), pg_temp.k(50))) || ' '
  || pg_temp.place(:stf, pg_temp.req(:mgr, :whA, pg_temp.l1(:iOk)), pg_temp.k(1)) || ' '
  || pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)) || '{"placer_user_id": null}'::jsonb, pg_temp.k(51)) || ' '
  || pg_temp.place(:mgrB, pg_temp.req(:mgrB, :whA, pg_temp.l1(:iOk)), pg_temp.k(52)) || ' '
  || pg_temp.place(:nobody, pg_temp.req(:nobody, :whA, pg_temp.l1(:iOk)), pg_temp.k(53)) || ' '
  || pg_temp.place(:dis, pg_temp.req(:dis, :whA, pg_temp.l1(:iOk)), pg_temp.k(54)),
  'ERR:42501:unauthenticated: ERR:42501:placer_mismatch: ERR:42501:placer_mismatch: ERR:42501:not_member: ERR:42501:not_member: ERR:42501:not_member:',
  'N1: signed out, another account''s placer (even on a key that placed an order: refused before the key), no placer, a member of another organization, nobody''s member and a disabled member are refused in step 1');
select is(
  pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), null) || ' '
  || pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), '  ') || ' '
  || pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), 'shortfall-1') || '|'
  || (pg_temp.counts() = :'c5')::text,
  'ERR:22023:idempotency_key_required: ERR:22023:idempotency_key_required: ERR:22023:idempotency_key_invalid:|true',
  'N2: a missing, blank or malformed key is refused in step 2; nothing in N1 or N2 wrote an order, a line, a notification or a row');

-- The parity fixture: every case the database sees, as the parity placer.
-- BEGIN GENERATED: scripts/gen-place-order-parity-sql.mjs from packages/core/src/orders/place-order-parity-cases.json. Do not edit by hand.
-- 59 cases the database sees (64 in the fixture; core alone checks R26, R27, R28, R33, R34).
-- Accepted (expect_sqlstate null): place_order_request gets past step 3 (no 22023). Refused: it raises exactly expect_sqlstate with hint expect_hint (and, for order_invalid, detail expect_field), writing nothing.
-- placer_user_id is the parity placer (0f0e0000-0000-4000-8000-0000000000a1); the pgTAP file signs in as that member of the parity organization (0f0e0000-0000-4000-8000-00000000000a).
insert into pop_case (case_no, case_id, request, p_key, expect_sqlstate, expect_hint, expect_field) values
  (1, 'A01', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000001', null, null, null),
  (2, 'A02', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"delivery","delivery_charter_id":"0f0e0000-0000-4000-8000-0000000000c1","on_behalf_name":"Maria Lopez","on_behalf_email":"maria@example.org","notes":"Room 12, by Friday","needed_by":"2026-10-05T10:00:00Z","lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2},{"item_id":"0f0e1000-0000-4000-8000-000000000002","quantity":10}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000002', null, null, null),
  (3, 'A03', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000002","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000003","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000004","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000005","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000006","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000007","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000008","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000009","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000010","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000011","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000012","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000013","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000014","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000015","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000016","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000017","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000018","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000019","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000020","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000021","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000022","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000023","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000024","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000025","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000026","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000027","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000028","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000029","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000030","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000031","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000032","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000033","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000034","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000035","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000036","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000037","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000038","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000039","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000040","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000041","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000042","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000043","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000044","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000045","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000046","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000047","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000048","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000049","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000050","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000051","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000052","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000053","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000054","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000055","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000056","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000057","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000058","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000059","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000060","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000061","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000062","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000063","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000064","quantity":1}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000003', null, null, null),
  (4, 'A04', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":10000}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000004', null, null, null),
  (5, 'A05', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":5000},{"item_id":"0f0e1000-0000-4000-8000-000000000002","quantity":5000}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000005', null, null, null),
  (6, 'A06', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000006', null, null, null),
  (7, 'A07', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":"\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00\ud835\udc00","needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000007', null, null, null),
  (8, 'A08', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":" \t\nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn\n  ","needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000008', null, null, null),
  (9, 'A09', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":" \n\t ","needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000009', null, null, null),
  (10, 'A10', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","on_behalf_email":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000000a', null, null, null),
  (11, 'A11', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"  Maria Lopez ","on_behalf_email":" maria@example.org\t","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000000b', null, null, null),
  (12, 'A12', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":3},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":4}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000000c', null, null, null),
  (13, 'A13', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffMaria Lopez\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff","on_behalf_email":"\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffmaria@example.org\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff","notes":"\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeffRoom 12\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff","needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000000d', null, null, null),
  (14, 'A14', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"o''neil+orders@sub.ex-ample.co.uk","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000000e', null, null, null),
  (15, 'R01', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[]}'::jsonb, '0f0e2000-0000-4000-8000-00000000000f', '22023', 'order_invalid', 'lines'),
  (16, 'R02', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000002","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000003","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000004","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000005","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000006","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000007","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000008","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000009","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000000f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000010","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000011","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000012","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000013","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000014","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000015","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000016","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000017","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000018","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000019","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000001f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000020","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000021","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000022","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000023","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000024","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000025","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000026","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000027","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000028","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000029","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000002f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000030","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000031","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000032","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000033","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000034","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000035","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000036","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000037","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000038","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000039","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000003f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000040","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000041","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000042","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000043","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000044","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000045","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000046","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000047","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000048","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000049","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000004f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000050","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000051","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000052","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000053","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000054","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000055","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000056","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000057","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000058","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000059","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005a","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005b","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005c","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005d","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005e","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-00000000005f","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000060","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000061","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000062","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000063","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000064","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000065","quantity":1}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000010', '22023', 'order_invalid', 'lines'),
  (17, 'R03', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":0}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000011', '22023', 'order_invalid', 'quantity'),
  (18, 'R04', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":-3}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000012', '22023', 'order_invalid', 'quantity'),
  (19, 'R05', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":10001}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000013', '22023', 'order_invalid', 'quantity'),
  (20, 'R06', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1.5}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000014', '22023', 'order_invalid', 'quantity'),
  (21, 'R07', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":0.5},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":0.5}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000015', '22023', 'order_invalid', 'quantity'),
  (22, 'R08', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":"2"}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000016', '22023', 'order_invalid', 'quantity'),
  (23, 'R09', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":5000},{"item_id":"0f0e1000-0000-4000-8000-000000000002","quantity":5001}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000017', '22023', 'order_invalid', 'total'),
  (24, 'R10', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":6000},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":5000}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000018', '22023', 'order_invalid', 'quantity'),
  (25, 'R11', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000019', '22023', 'order_invalid', 'notes'),
  (26, 'R12', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","on_behalf_email":"maria@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000001a', '22023', 'order_invalid', 'on_behalf'),
  (27, 'R13', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"   ","on_behalf_email":"maria@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000001b', '22023', 'order_invalid', 'on_behalf'),
  (28, 'R14', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000001c', '22023', 'order_invalid', 'on_behalf'),
  (29, 'R15', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria.example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000001d', '22023', 'order_invalid', 'on_behalf'),
  (30, 'R16', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria@x@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000001e', '22023', 'order_invalid', 'on_behalf'),
  (31, 'R17', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria lopez@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000001f', '22023', 'order_invalid', 'on_behalf'),
  (32, 'R18', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria@localhost","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000020', '22023', 'order_invalid', 'on_behalf'),
  (33, 'R19', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000021', '22023', 'order_invalid', 'on_behalf'),
  (34, 'R20', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"delivery","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000022', '22023', 'delivery_needs_site', null),
  (35, 'R21', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":"0f0e0000-0000-4000-8000-0000000000c1","on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000023', null, null, null),
  (36, 'R22', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"shipping","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000024', '22023', 'order_invalid', 'fulfillment_type'),
  (37, 'R23', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"item-1","quantity":1}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000025', '22023', 'order_invalid', 'lines'),
  (38, 'R24', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"dc4","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000026', '22023', 'order_invalid', 'warehouse'),
  (39, 'R25', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"delivery","delivery_charter_id":"clovis","on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000027', '22023', 'order_invalid', 'site'),
  (43, 'R29', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"me","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000002b', '42501', 'placer_mismatch', null),
  (44, 'R30', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a2","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000002c', '42501', 'placer_mismatch', null),
  (45, 'R31', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, 'shortfall-123', '22023', 'idempotency_key_invalid', null),
  (46, 'R32', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, null, '22023', 'idempotency_key_required', null),
  (49, 'R35', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria\u00a0lopez@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000031', '22023', 'order_invalid', 'on_behalf'),
  (50, 'R36', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria@gmail.c","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000032', '22023', 'order_invalid', 'on_behalf'),
  (51, 'R37', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria..lopez@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000033', '22023', 'order_invalid', 'on_behalf'),
  (52, 'R38', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"\"maria\"@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000034', '22023', 'order_invalid', 'on_behalf'),
  (53, 'R39', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria@-example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000035', '22023', 'order_invalid', 'on_behalf'),
  (54, 'R40', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"mar\u00eda@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000036', '22023', 'order_invalid', 'on_behalf'),
  (55, 'R41', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1},{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000037', '22023', 'order_invalid', 'lines'),
  (56, 'R42', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":3000000000}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000038', '22023', 'order_invalid', 'quantity'),
  (57, 'R43', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":100000000000000000000}]}'::jsonb, '0f0e2000-0000-4000-8000-000000000039', '22023', 'order_invalid', 'quantity'),
  (58, 'R44', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria@example.org\u0085","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000003a', '22023', 'order_invalid', 'on_behalf'),
  (59, 'R45', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":"Maria","on_behalf_email":"maria@example.org\u200b","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000003b', '22023', 'order_invalid', 'on_behalf'),
  (60, 'D01', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"ios","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000003c', '22023', 'order_invalid', 'surface'),
  (61, 'D02', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":"tomorrow","lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000003d', '22023', 'order_invalid', 'needed_by'),
  (62, 'D03', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":1}}'::jsonb, '0f0e2000-0000-4000-8000-00000000003e', '22023', 'order_invalid', 'lines'),
  (63, 'D04', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":"maria@example.org","notes":null,"needed_by":null,"lines":[{"item_id":"0f0e1000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, '0f0e2000-0000-4000-8000-00000000003f', '22023', 'order_invalid', 'on_behalf'),
  (64, 'D05', '{"organization_id":"0f0e0000-0000-4000-8000-00000000000a","placer_user_id":"0f0e0000-0000-4000-8000-0000000000a1","surface":"app","warehouse_id":"0f0e0000-0000-4000-8000-0000000000d1","fulfillment_type":"pickup","delivery_charter_id":null,"on_behalf_name":null,"on_behalf_email":null,"notes":null,"needed_by":null,"lines":[1]}'::jsonb, '0f0e2000-0000-4000-8000-000000000040', '22023', 'order_invalid', 'lines');
-- END GENERATED

create temp table pop_got as
select c.case_no, c.case_id, c.expect_sqlstate, c.expect_hint, c.expect_field,
       pg_temp.place(:pPlacer, c.request, c.p_key) as got
  from pop_case c;
select is(
  (select coalesce(string_agg(g.case_id || ': got ' || g.got, E'\n' order by g.case_no), '')
     from pop_got g
    where case when g.expect_sqlstate is null then g.got like 'ERR:22023:%'
               else g.got is distinct from ('ERR:' || g.expect_sqlstate || ':' || g.expect_hint || ':' || coalesce(g.expect_field, ''))
          end),
  '',
  'N3: parity: every refused shape case of the fixture raises exactly its SQLSTATE, hint and field, and every accepted one gets past step 3 (no 22023)');
select is(
  (select count(*) from pop_case)::text || '|'
  || (select count(*) from pop_case where expect_sqlstate is null)::text || '|'
  || (select count(*) from public.order_submissions s where s.organization_id = :pOrg
        and s.key::text in (select c.p_key from pop_case c where c.expect_sqlstate is not null))::text || '|'
  || (select count(*) from public.order_requests where organization_id = :pOrg)::text,
  '59|15|0|0',
  'N4: the fixture''s cases that reach the database are all here; no refused shape case recorded anything and no case placed an order (mutation: record shape refusals)');

-- ═══ W. Withdraw ═════════════════════════════════════════════════════════
select pg_temp.counts() as "c6" \gset
insert into ans values ('W1a', pg_temp.withdraw(:stf, :orgA, pg_temp.k(60)));
insert into ans values ('W1b', pg_temp.place(:stf, pg_temp.req(:stf, :whA, pg_temp.l1(:iOk)), pg_temp.k(60)));
insert into ans values ('W1c', pg_temp.withdraw(:stf, :orgA, pg_temp.k(60)));
select is(
  (select string_agg(a.r, ' ' order by a.tag) from ans a where a.tag in ('W1a', 'W1b', 'W1c')) || '|'
  || (select s.outcome || '/' || coalesce(s.request_hash, 'null') || '/' || coalesce(s.order_request_id::text, 'null') || '/' || s.surface
        from public.order_submissions s where s.key = pg_temp.k(60)::uuid) || '|'
  || (select count(*) from public.order_requests where organization_id = :orgA)::text,
  '{"outcome": "withdrawn"} {"outcome": "withdrawn"} {"outcome": "withdrawn"}|withdrawn/null/null/web|' || split_part(:'c6', '|', 1),
  'W1: withdrawing an unused key records withdrawn (no hash); a later place under it answers withdrawn and places nothing; a second withdraw answers the same');
select pg_temp.counts() as "c7" \gset
select is(
  (select (pg_temp.withdraw(:stf, :orgA, pg_temp.k(1), 'app')::jsonb#>>'{order,id}') = (a.r::jsonb#>>'{order,id}') from ans a where a.tag = 'P1')::text || '|'
  || pg_temp.withdraw(:stf, :orgA, pg_temp.k(20)) || '|'
  || (pg_temp.counts() = :'c7')::text,
  'true|{"outcome": "refused", "refusal": {"detail": null, "reason": "module_disabled"}}|true',
  'W2: withdrawing a key that placed an order answers that order, and a refused key answers its refusal; neither writes anything');
select is(
  pg_temp.withdraw(:stfNoRq, :orgA, pg_temp.k(61)) || ' '
  || pg_temp.withdraw(:mgrB, :orgA, pg_temp.k(62)) || ' '
  || pg_temp.withdraw(:stf, :orgA, 'nope') || ' '
  || pg_temp.withdraw(:stf, :orgA, pg_temp.k(63), 'ios') || ' '
  || pg_temp.run('authenticated', null, format('select public.withdraw_order_submission(%L, %L, %L)::text', :orgA, pg_temp.k(64), 'web')),
  '{"outcome": "withdrawn"} ERR:42501:not_member: ERR:22023:idempotency_key_invalid: ERR:22023:order_invalid:surface ERR:42501:unauthenticated:',
  'W3: withdraw needs only membership (it works with orders:request revoked); a non-member, a malformed key, an unknown surface and a signed-out call are refused');

-- ═══ S. Status ═══════════════════════════════════════════════════════════
select is(
  pg_temp.status(:stf, :orgA, pg_temp.k(99)) || ' '
  || (pg_temp.status(:stf, :orgA, pg_temp.k(1))::jsonb->>'outcome') || ' '
  || pg_temp.brief(pg_temp.status(:stf, :orgA, pg_temp.k(20))) || ' '
  || pg_temp.status(:stf, :orgA, pg_temp.k(60)) || ' '
  || pg_temp.status(:own, :orgA, pg_temp.k(1)) || ' '
  || pg_temp.status(:mgrB, :orgA, pg_temp.k(1)) || ' '
  || pg_temp.brief(pg_temp.status(:stfNoRq, :orgA, pg_temp.k(21))),
  '{"outcome": "none"} placed refused/-/module_disabled/null {"outcome": "withdrawn"} {"outcome": "none"} ERR:42501:not_member: refused/-/permission/null',
  'S1: the status read answers none, placed, refused or withdrawn for your own key only (the owner sees none for the staff member''s key; a non-member is refused); it needs only membership');

-- ═══ I. The insert policy ════════════════════════════════════════════════
select is(
  pg_temp.run('authenticated', :stf, format($q$insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, order_request_id, refusal, surface)
      values (%L, %L, %L, md5('x'), 'refused', null, '{"reason": "permission"}', 'app') returning outcome$q$, :orgA, :stf, pg_temp.k(70))) || ' '
  || pg_temp.run('authenticated', :stf, format($q$insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, surface)
      values (%L, %L, %L, null, 'withdrawn', 'app') returning outcome$q$, :orgA, :stf, pg_temp.k(71))) || ' '
  || pg_temp.run('authenticated', :stf, format($q$insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, order_request_id, surface)
      select %L, %L, %L, md5('x'), 'placed', o.id, 'app' from public.order_requests o where o.id = %L returning outcome$q$,
      :orgA, :stf, pg_temp.k(72), (select (a.r::jsonb#>>'{order,id}') from ans a where a.tag = 'P8'))),
  'ERR:42501:: ERR:42501:: ERR:42501::',
  'I1: a direct insert of a refused, a withdrawn or a placed row without the flag is refused by row level security');
select is(
  pg_temp.run('authenticated', :stf, format($q$with f as (select set_config('stockpilot.order_submit', 'on', true) as v)
      insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, surface)
      select %L, %L, %L, null, 'withdrawn', 'app' from f returning outcome$q$, :orgA, :stf, pg_temp.k(73))) || ' '
  || pg_temp.run('authenticated', :stf, format($q$with f as (select set_config('stockpilot.order_submit', (pg_current_xact_id()::text::bigint - 1)::text, true) as v)
      insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, surface)
      select %L, %L, %L, null, 'withdrawn', 'app' from f returning outcome$q$, :orgA, :stf, pg_temp.k(74))) || ' '
  || pg_temp.run('authenticated', :stf, format($q$with f as (select set_config('stockpilot.order_submit', pg_current_xact_id()::text, true) as v)
      insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, surface)
      select %L, %L, %L, null, 'withdrawn', 'app' from f returning outcome$q$, :orgA, :mgr, pg_temp.k(75))) || ' '
  || pg_temp.run('authenticated', :stf, format($q$with f as (select set_config('stockpilot.order_submit', pg_current_xact_id()::text, true) as v)
      insert into public.order_submissions (organization_id, user_id, key, request_hash, outcome, surface)
      select %L, %L, %L, null, 'withdrawn', 'app' from f returning outcome$q$, :orgA, :stf, pg_temp.k(76))),
  'ERR:42501:: ERR:42501:: ERR:42501:: withdrawn',
  'I2: the flag counts only when it holds THIS transaction''s id: ''on'' and another transaction''s id are refused (mutation: compare the flag to ''on''), as is another user''s row; the control (this transaction''s id, set_config being unreachable over PostgREST) is accepted');
select is(
  pg_temp.run('authenticated', :stf, $q$select count(*)::text || '/' || count(*) filter (where user_id <> auth.uid())::text from public.order_submissions$q$) || ' '
  || pg_temp.run('authenticated', :mgr, $q$select count(*)::text || '/' || count(*) filter (where user_id <> auth.uid())::text from public.order_submissions$q$) || ' '
  || pg_temp.run('authenticated', :mgrB, $q$select count(*)::text from public.order_submissions$q$),
  (select count(*) from public.order_submissions where user_id = :stf)::text || '/0 '
  || (select count(*) from public.order_submissions where user_id = :mgr)::text || '/0 0',
  'I3: SELECT shows each member only their own rows (the manager sees none of the staff member''s), and a member of another organization none');

-- ═══ D. Deletes ══════════════════════════════════════════════════════════
insert into ans values ('D0', pg_temp.place(:del, pg_temp.req(:del, :whA, pg_temp.l1(:iOk)), pg_temp.k(80)));
insert into ans values ('D1', pg_temp.run('postgres', null, format('delete from auth.users where id = %L returning id::text', :del)));
select is(
  (select r from ans where tag = 'D1') || '|'
  || (select count(*) from public.order_submissions where user_id = :del)::text || '|'
  || (select coalesce(o.requester_user_id::text, 'null') || '/' || (o.requester_deleted_at is not null)::text
        from ans a join public.order_requests o on o.id = (a.r::jsonb#>>'{order,id}')::uuid where a.tag = 'D0') || '|'
  || (select count(*) from auth.users where id = :del)::text,
  :del || '|1|null/true|0',
  'D1: deleting the account of a member who has submissions succeeds (no foreign key on user_id); the row stays, and the order loses its requester as 0388 decides');
insert into ans values ('D2', pg_temp.place(:ownD, jsonb_build_object('organization_id', :orgD, 'placer_user_id', :ownD, 'surface', 'app',
  'warehouse_id', :whD, 'fulfillment_type', 'pickup', 'lines', pg_temp.l1(:iD)), pg_temp.k(81)));
select (select count(*) from public.order_submissions where organization_id = :orgD)::text as "d2before" \gset
insert into ans values ('D2b', pg_temp.run('postgres', null, format('delete from public.order_requests where id = %L returning ''deleted''', (select r::jsonb#>>'{order,id}' from ans where tag = 'D2'))));
select is(
  pg_temp.brief((select r from ans where tag = 'D2')) || '|' || :'d2before' || '|' || (select r from ans where tag = 'D2b') || '|'
  || (select count(*) from public.order_submissions where organization_id = :orgD)::text,
  'placed/false/-/null|1|deleted|0',
  'D2: deleting an order deletes its submission row (cascade)');
insert into ans values ('D3a', pg_temp.withdraw(:ownD, :orgD, pg_temp.k(82)));
select (select count(*) from public.order_submissions where organization_id = :orgD)::text as "d3before" \gset
insert into ans values ('D3b', pg_temp.run('postgres', null, format('delete from public.organizations where id = %L returning ''deleted''', :orgD)));
select is(
  :'d3before' || '|' || (select r from ans where tag = 'D3b') || '|'
  || (select count(*) from public.order_submissions where organization_id = :orgD)::text,
  '1|deleted|0',
  'D3: deleting an organization deletes its submission rows (cascade)');

-- ═══ RR. Recent requesters ═══════════════════════════════════════════════
insert into public.order_requests (organization_id, warehouse_id, status, source, requester_user_id, requester_name, requester_email, fulfillment_type, delivery_charter_id, created_at)
select :orgA, :whA, 'pending_approval', 'internal', null, 'Person ' || g, 'person' || g || '@example.org', 'pickup', null, now() - make_interval(days => g)
  from generate_series(1, 55) g;
insert into public.order_requests (organization_id, warehouse_id, status, source, requester_user_id, requester_name, requester_email, fulfillment_type, delivery_charter_id, created_at) values
  (:orgA, :whA, 'pending_approval', 'internal', null, 'Old name', ' MARIA@example.ORG ', 'delivery', :chA, now() - interval '2 hours'),
  (:orgA, :whA, 'pending_approval', 'internal', null, 'Gone', 'gone@example.org', 'pickup', null, now() - interval '400 days'),
  (:orgB, :whB, 'pending_approval', 'internal', null, 'Org B person', 'orgb@example.org', 'pickup', null, now() - interval '1 hour');
select is(
  pg_temp.run('authenticated', :stf, format('select public.order_recent_requesters(%L)::text', :orgA)) || ' '
  || pg_temp.run('authenticated', :mgrNo, format('select public.order_recent_requesters(%L)::text', :orgA)) || ' '
  || pg_temp.run('authenticated', :mgrB, format('select public.order_recent_requesters(%L)::text', :orgA)),
  '[] [] []',
  'RR1: [] for staff without orders:approve, for the manager whose orders:approve is revoked and for a member of another organization');
select is(
  (select jsonb_array_length(r::jsonb)::text || '|' || (r::jsonb->0->>'name') || '/' || (r::jsonb->0->>'email') || '/' || (r::jsonb->0->>'orders')
          || '/' || (r::jsonb->0->>'lastFulfillment') || '/' || coalesce(r::jsonb->0->>'lastSiteId', 'null') || '|'
          || (select count(*) from jsonb_array_elements(r::jsonb) e where lower(e->>'email') like '%maria%')::text || '|'
          || (select count(*) from jsonb_array_elements(r::jsonb) e where e->>'email' in ('gone@example.org', 'orgb@example.org'))::text || '|'
          || (select string_agg(k, ',' order by k) from jsonb_object_keys(r::jsonb->0) k)
     from (select pg_temp.run('authenticated', :stfAp, format('select public.order_recent_requesters(%L)::text', :orgA)) as r) x),
  '50|Ann/ann@example.org/1/pickup/null|1|0|email,lastFulfillment,lastOrderedAt,lastSiteId,name,orders',
  'RR2: the staff member granted orders:approve gets at most 50 requesters, newest first (the on-behalf order just placed), one row per email ignoring case and spaces, never older than a year or from another organization');
select is(
  (select e->>'name' || '/' || (e->>'orders') || '/' || (e->>'lastFulfillment') || '/' || coalesce(e->>'lastSiteId', 'null')
     from jsonb_array_elements(pg_temp.run('authenticated', :mgr, format('select public.order_recent_requesters(%L)::text', :orgA))::jsonb) e
    where lower(e->>'email') = 'maria@example.org'),
  'Maria Lopez/2/delivery/' || :chA,
  'RR3: Maria''s two orders (two spellings of one email, the older named Old name) are one row: the latest name, 2 orders, the last method and the last delivery site');

-- ═══ Z. Frozen ═══════════════════════════════════════════════════════════
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|'
                     || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner), E'\n'
                     order by p.oid::regprocedure::text)
     from pg_proc p
    where p.oid in ('public.create_order_request(jsonb, jsonb)'::regprocedure,
                    'public.tg_order_requests_insert_guard()'::regprocedure,
                    'public.tg_order_request_lines_guard()'::regprocedure,
                    'public.assign_order_request_number()'::regprocedure,
                    'public._notify_order_request_changes()'::regprocedure,
                    'public._validate_order_request_status_transition()'::regprocedure,
                    'public.cancel_order_request(uuid, text)'::regprocedure,
                    'public.order_request_top_skus_for_warehouse(uuid, integer, integer)'::regprocedure,
                    'public._notify_recipients(uuid)'::regprocedure,
                    'public._dispatch_push_for_notification()'::regprocedure,
                    'public.has_org_role(uuid, text)'::regprocedure,
                    'public.has_permission(uuid, text)'::regprocedure,
                    'public.is_org_member(uuid)'::regprocedure,
                    'public.module_enabled(uuid, text)'::regprocedure,
                    'public.user_can_access_warehouse(uuid, uuid, text)'::regprocedure,
                    'public.tg_order_requests_workflow_guard()'::regprocedure)),
  E'_dispatch_push_for_notification()|17f00da160feb6a7d6609cca4fb6337e|true|{"search_path=public, net, extensions"}|postgres\n'
  '_notify_order_request_changes()|a223ae83810149728156b8e299c7425e|true|{search_path=public}|postgres\n'
  '_notify_recipients(uuid)|679e6193e3dbe5644055e835e8209043|true|{search_path=public}|postgres\n'
  '_validate_order_request_status_transition()|dee8cd4782ec83abdb31a2b48fcd4ef2|false|{search_path=public}|postgres\n'
  'assign_order_request_number()|03097df3cded3d0ea42676855abc6a25|true|{search_path=public}|postgres\n'
  -- 0390 re-pin (was 7a2302dec888970054738b0dad420fd3): slice D's one gate edit.
  'cancel_order_request(uuid,text)|47cabcd1fe4f52fb7b2b6b6b64b68da1|true|{"search_path=public, extensions"}|postgres\n'
  'create_order_request(jsonb,jsonb)|4d65cef6c569a8c2c699fd9d5c8b77d5|false|{search_path=public}|postgres\n'
  'has_org_role(uuid,text)|10422b29a6e15acd003d4f11ed28e90c|true|{search_path=public}|postgres\n'
  'has_permission(uuid,text)|cc0accdad7e2fdf4f88aa82aa887e85f|true|{search_path=public}|postgres\n'
  'is_org_member(uuid)|76492a6556e9f6a7c33d942aa9726f9f|true|{search_path=public}|postgres\n'
  'module_enabled(uuid,text)|df3260cbcd15f986798e5377d1e95dce|true|{"search_path=public, pg_temp"}|postgres\n'
  'order_request_top_skus_for_warehouse(uuid,integer,integer)|b06c0674ae4952cf1942649cdd81e81d|false|{search_path=public}|postgres\n'
  'tg_order_request_lines_guard()|d899924c0f8fc1dfae4e8be7bd4c5cad|false|{search_path=public}|postgres\n'
  'tg_order_requests_insert_guard()|1b109d535811e9a21c43d01dcc344892|false|{search_path=public}|postgres\n'
  'tg_order_requests_workflow_guard()|59481b7651dca818a2266a39868db4f0|false|{search_path=public}|postgres\n'
  'user_can_access_warehouse(uuid,uuid,text)|76b4170f3d393e8a1f293ca3d4895955|true|{search_path=public}|postgres',
  'Z1: the functions place_order_request relies on are the text (production md5 read at build start), SECURITY mode, search_path and owner this build was proven against');
select is(
  (select md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '')
                         || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
     from pg_proc p
    where p.oid in ('public.create_order_request(jsonb, jsonb)'::regprocedure, 'public.tg_order_requests_insert_guard()'::regprocedure,
                    'public.tg_order_request_lines_guard()'::regprocedure, 'public.assign_order_request_number()'::regprocedure,
                    'public._notify_order_request_changes()'::regprocedure, 'public._validate_order_request_status_transition()'::regprocedure,
                    'public.cancel_order_request(uuid, text)'::regprocedure,
                    'public.order_request_top_skus_for_warehouse(uuid, integer, integer)'::regprocedure)),
  '4af4ea31b970b21b27942ed7f8bb36d1|8',
  'Z2: the set fingerprint of the first eight (0385 Z1 form, grants included) equals production''s at build start (it moved from the plan''s 5992f083...|8 only by 0390''s cancel_order_request edit)');
select is(
  (select string_agg(x.relname || '=' || x.v, E'\n' order by x.relname) from (
     select c.relname, md5(string_agg(c.relname || '|' || pol.polname || '|' || pol.polcmd::text || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|'
                                      || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') || '|' || pol.polroles::regrole[]::text, E'\n' order by c.relname, pol.polname)) || '|' || count(*) as v
       from pg_policy pol join pg_class c on c.oid = pol.polrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname in ('order_requests', 'order_request_lines', 'idempotency_keys', 'warehouses', 'warehouse_charters')
      group by c.relname) x),
  E'idempotency_keys=7c0b897aca77ae4e04596b5f08a6f58b|2\n'
  'order_request_lines=3741951ce4f5bce8394bfe6e5d7a8378|4\n'
  'order_requests=28cf8d6f9b07075076b13a24c2d3d984|4\n'
  'warehouse_charters=ca05c428fb9052aedb108faa0e8a6048|2\n'
  'warehouses=5b111ddeaec532e9725f0e3968b819bc|2',
  'Z3: the policies of order_requests, order_request_lines, idempotency_keys, warehouses and warehouse_charters (the 0385 Z2 form with role names, so the value is the same locally and in production) equal production''s at build start, after 0390');
select is(
  (select string_agg(c.relname || ':' || t.tgname, ',' order by c.relname, t.tgname)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
      and c.relname in ('order_requests', 'order_request_lines', 'notifications', 'order_submissions')),
  'notifications:trg_notifications_dispatch_push,order_request_lines:trg_zz_order_request_lines_guard,'
  'order_requests:order_requests_set_updated_at,order_requests:trg_assign_order_request_number,order_requests:trg_order_requests_notify,'
  'order_requests:trg_order_requests_requester_deleted,order_requests:trg_order_requests_validate_transition,'
  'order_requests:trg_order_requests_workflow_guard,order_requests:trg_zz_order_requests_insert_guard',
  'Z4: the triggers on order_requests (7), order_request_lines (1) and notifications (1) are unchanged, and order_submissions has none');

select * from finish();
rollback;
