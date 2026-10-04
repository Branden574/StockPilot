-- supabase/tests/0388_order_number_and_requester_deletion.test.sql
-- pgTAP proof for migration 0388: explicit order numbers are refused on
-- insert, an account that placed orders can be deleted, and the server can ask
-- first whether an account can go.
--
-- N. Item 15 (authenticated INSERT only on the 13 columns create_order_request
--    names):
--    N1  no table-level INSERT; the INSERT column set is exactly the 13; anon
--        holds no INSERT;
--    N2  a viewer's raw insert of their own pending order with order_number =
--        bigint max is 42501, and the organization's highest number is
--        unchanged;
--    N3  after N2 the manager's create_order_request numbers max + 1;
--    N4  one line per column NOT in the 13 (46 today, read from the catalog,
--        so a new column changes the plan count): a viewer's raw insert naming
--        that column (DEFAULT as the value) is 42501;
--    N5  a viewer's raw insert naming only granted columns still goes through
--        the policy and the insert guard, numbered, created_at = now();
--    N6  create_order_request (RETURNING *) as staff for themself and as the
--        manager on behalf of someone returns the full row, marker null;
--    N7  an upsert naming id is 42501 (ON CONFLICT DO NOTHING and DO UPDATE);
--    N8  service_role and postgres still insert explicit numbers (imports,
--        restores), and the public-link and portal shapes still insert as
--        service_role.
-- P. account_deletion_check (always undone):
--    P1  an account with no blocker: deletable, and nothing changed;
--    P2  an account with a PO import: blocked 23503 po_imports_uploaded_by_fkey;
--    P3  a requester of orders with no email: deletable;
--    P4  unknown id: not_found; null: no_user;
--    P5  EXECUTE for postgres and service_role only; an authenticated or anon
--        JWT is refused by the body even with EXECUTE granted;
--    P6  the body raises only 42501 and P0001 (never 40001 or 40P01);
--    P7  a user named by platform_admin_audit (SET NULL on a NOT NULL column):
--        blocked 23502, the generic path;
--    P8  no constraint in public or auth is DEFERRABLE and no constraint
--        trigger is deferrable (a deferred check would run at commit, outside
--        the check's subtransaction).
--    P8b the only NOT VALID constraint in public or auth is
--        order_requests_delivery_target_chk (review R6, 2026-10-03): Postgres
--        re-checks a NOT VALID CHECK on every update of a row, the FK's
--        SET NULL included, so a legacy row that breaks it refuses the
--        deletion of anyone it names (5 such orders and 2 accounts in
--        production, both already refused by RESTRICT keys). A new NOT VALID
--        constraint changes who can be deleted and is reviewed with the A3
--        census; P8c proves the refusal.
--    P8c a row that breaks the NOT VALID CHECK makes the check answer blocked
--        23514 order_requests_delivery_target_chk, and nothing changes (at
--        the end of the file: it drops and re-adds that CHECK, undone by the
--        file's rollback).
--    (P9, a row lock held by another session, is in
--    scripts/db-concurrency/0388_requester_delete_race.sh: pgTAP has one
--    session.)
-- C. C1 the only function in any schema whose body deletes from auth.users or
--    user_profiles is account_deletion_check; C2 its posture (body md5,
--    DEFINER, search_path and lock_timeout 900ms, owner, EXECUTE list); C3
--    deadlock_timeout on this stack is above that lock_timeout (review R3;
--    production's is read at R0).
-- D. Item 16 (requester_deleted_at, its trigger, identity_chk relaxed):
--    D5-D10 the marker is stamped only when a non-API role nulls a requester
--        whose profile is gone; D8, D9, D9b posture;
--    D0, D1, D12-D14 deleting a requester's account end to end: the orders
--        stay with their status, lines and holds, lose the person, gain the
--        marker; nothing else changes and nothing about the person is
--        copied; D15 a manager can still approve and cancel those orders;
--    D1b a requester who left the organization; D2 a portal customer; D4 a
--        legacy row that already held the email and name (kept);
--    D16 deleting an approver, picker, pick-slip author, canceller and
--        cycle-count counter (who also requested one order): deletable, every
--        user column nulled, only their own order marked;
--    D3  on-behalf and public-link orders never change.
-- K. Comments name 0388.
--
-- Roles: fixtures as the test superuser. Attempts run through pg_temp.attempt
-- (always undone) or pg_temp.call_as (kept), which switch role and claims with
-- set_config inside a subtransaction (the 0387 helpers). Accounts are deleted
-- as postgres (delete from auth.users); the FK actions run as the referencing
-- table's owner either way (0387 AL6b). begin/rollback: nothing leaks.
-- Namespace 03880000.

begin;

select plan(95);

\set orgA   '\'03880000-0000-0000-0000-00000000000a\''
\set own    '\'03880000-0000-0000-0000-0000000000a0\''
\set mgr    '\'03880000-0000-0000-0000-0000000000a1\''
\set stfAp  '\'03880000-0000-0000-0000-0000000000a4\''
\set vwr    '\'03880000-0000-0000-0000-0000000000a6\''
\set rq1    '\'03880000-0000-0000-0000-0000000000b1\''
\set rqLeft '\'03880000-0000-0000-0000-0000000000b2\''
\set rqLeg  '\'03880000-0000-0000-0000-0000000000b3\''
\set cust   '\'03880000-0000-0000-0000-0000000000b4\''
\set poU    '\'03880000-0000-0000-0000-0000000000b5\''
\set paU    '\'03880000-0000-0000-0000-0000000000b6\''
\set free   '\'03880000-0000-0000-0000-0000000000b7\''
\set mult   '\'03880000-0000-0000-0000-0000000000b8\''
\set whA    '\'03880000-0000-0000-0000-0000000000d1\''
\set itG    '\'03880000-0000-0000-0000-0000000000f0\''
\set custC  '\'03880000-0000-0000-0000-0000000000c5\''
\set poImp  '\'03880000-0000-0000-0000-0000000000c6\''
\set ccM    '\'03880000-0000-0000-0000-0000000000c7\''
\set ccLM   '\'03880000-0000-0000-0000-0000000000c8\''
\set oR1a   '\'03880000-0000-0000-0000-000000000101\''
\set oR1b   '\'03880000-0000-0000-0000-000000000102\''
\set oLeft  '\'03880000-0000-0000-0000-000000000103\''
\set oLeg   '\'03880000-0000-0000-0000-000000000104\''
\set oPor   '\'03880000-0000-0000-0000-000000000105\''
\set oPub   '\'03880000-0000-0000-0000-000000000106\''
\set oOB    '\'03880000-0000-0000-0000-000000000107\''
\set oLive  '\'03880000-0000-0000-0000-000000000108\''
\set oM1    '\'03880000-0000-0000-0000-000000000111\''
\set oM2    '\'03880000-0000-0000-0000-000000000112\''
\set oM3    '\'03880000-0000-0000-0000-000000000113\''
\set oM4    '\'03880000-0000-0000-0000-000000000114\''
\set lR1a   '\'03880000-0000-0000-0000-000000000201\''
\set lR1b   '\'03880000-0000-0000-0000-000000000202\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
-- full_name feeds D14: no order row may gain a deleted person's email or name.
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0388-own@test.local',    '{"full_name": "Own Er 0388"}'::jsonb),
  (:mgr,    '0388-mgr@test.local',    '{"full_name": "Man Ager 0388"}'::jsonb),
  (:stfAp,  '0388-stfap@test.local',  '{"full_name": "Staff Approver 0388"}'::jsonb),
  (:vwr,    '0388-vwr@test.local',    '{"full_name": "View Er 0388"}'::jsonb),
  (:rq1,    '0388-rq1@test.local',    '{"full_name": "Rq One 0388"}'::jsonb),
  (:rqLeft, '0388-rqleft@test.local', '{"full_name": "Rq Left 0388"}'::jsonb),
  (:rqLeg,  '0388-rqleg@test.local',  '{"full_name": "Rq Legacy 0388"}'::jsonb),
  (:cust,   '0388-cust@test.local',   '{"full_name": "Cust Person 0388"}'::jsonb),
  (:poU,    '0388-pou@test.local',    '{"full_name": "Po Uploader 0388"}'::jsonb),
  (:paU,    '0388-pau@test.local',    '{"full_name": "Platform Actor 0388"}'::jsonb),
  (:free,   '0388-free@test.local',   '{"full_name": "Free Person 0388"}'::jsonb),
  (:mult,   '0388-mult@test.local',   '{"full_name": "Multi Role 0388"}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values (:orgA, '0388 Deletion A', '0388-deletion-a');
-- rqLeft placed an order and has left (no membership): a manager's RLS hides
-- their profile (D7b), and their account is deleted in D1b. cust is a portal
-- customer, never a member.
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :stfAp, 'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :rq1,   'staff',   now()),
  (:orgA, :rqLeg, 'staff',   now()),
  (:orgA, :poU,   'manager', now()),
  (:orgA, :free,  'staff',   now()),
  (:orgA, :mult,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0388 Main', 'WH-0388A', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stfAp, :whA, true),
  (:orgA, :vwr,   :whA, true),
  (:orgA, :rq1,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp, 'orders:approve', true);
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type) values
  (:itG, :orgA, :whA, '0388-G', 'Deletion general', 100, 'active', 'none');
insert into public.customers (id, organization_id, name) values (:custC, :orgA, 'Cust Co 0388');
insert into public.customer_users (customer_id, user_id, email) values (:custC, :cust, '0388-cust@test.local');
insert into public.po_imports (id, organization_id, uploaded_by, source_type, file_name, file_mime_type, file_size, storage_path, sha256)
  values (:poImp, :orgA, :poU, 'csv', '0388.csv', 'text/csv', 10, '0388/po.csv', repeat('a', 64));
insert into public.platform_admin_audit (actor_user_id, actor_email, action) values (:paU, '0388-pau@test.local', 'viewed_org');

-- Orders, inserted by the superuser at their status (the insert guard holds
-- API roles only). oR1a starts a day old so D12 sees updated_at move.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_email, requester_name, requester_phone,
   customer_id, fulfillment_type, approved_by, approved_at, assigned_picker_id, picking_claimed_by, picking_claimed_at,
   pick_slip_generated_by, pick_slip_generated_at, cancelled_by, cancelled_at, updated_at) values
  (:oR1a,  :orgA, :whA, 'pending_approval',     'internal',    :rq1,    null, null, null, null, 'pickup',
           null, null, null, null, null, null, null, null, null, now() - interval '1 day'),
  (:oR1b,  :orgA, :whA, 'pending_approval',     'internal',    :rq1,    null, null, null, null, 'pickup',
           null, null, null, null, null, null, null, null, null, now()),
  (:oLeft, :orgA, :whA, 'completed',            'internal',    :rqLeft, null, null, null, null, 'pickup',
           :mgr, now(), null, null, null, null, null, null, null, now()),
  (:oLeg,  :orgA, :whA, 'completed',            'internal',    :rqLeg,  '0388-rqleg@test.local', 'Rq Legacy 0388', null, null, 'pickup',
           :mgr, now(), null, null, null, null, null, null, null, now()),
  (:oPor,  :orgA, :whA, 'pending_approval',     'portal',      :cust,   '0388-cust@test.local', 'Cust Co 0388', null, :custC, 'pickup',
           null, null, null, null, null, null, null, null, null, now()),
  (:oPub,  :orgA, :whA, 'pending_approval',     'public_link', null,    '0388-pub@test.local', 'Pub Person', '555-0100', null, 'pickup',
           null, null, null, null, null, null, null, null, null, now()),
  (:oOB,   :orgA, :whA, 'pending_approval',     'internal',    null,    '0388-ob@test.local', 'On Behalf', '555-0101', null, 'pickup',
           null, null, null, null, null, null, null, null, null, now()),
  (:oLive, :orgA, :whA, 'pending_approval',     'internal',    :mgr,    null, null, null, null, 'pickup',
           null, null, null, null, null, null, null, null, null, now()),
  (:oM1,   :orgA, :whA, 'approved',             'internal',    :vwr,    null, null, null, null, 'pickup',
           :mult, now(), null, null, null, null, null, null, null, now()),
  (:oM2,   :orgA, :whA, 'picking_in_progress',  'internal',    :vwr,    null, null, null, null, 'pickup',
           :mgr, now(), :mult, :mult, now(), :mult, now(), null, null, now()),
  (:oM3,   :orgA, :whA, 'cancelled',            'internal',    :vwr,    null, null, null, null, 'pickup',
           null, null, null, null, null, null, null, :mult, now(), now()),
  (:oM4,   :orgA, :whA, 'picking_in_progress',  'internal',    :mult,   null, null, null, null, 'pickup',
           :mult, now(), :mult, null, null, :mult, now(), null, null, now());
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested) values
  (:lR1a, :oR1a, :itG, 2),
  (:lR1b, :oR1b, :itG, 3);
-- mult is also a cycle-count counter (D16).
insert into public.cycle_counts (id, organization_id, warehouse_id, status, scope, started_by, started_at, assigned_to)
  values (:ccM, :orgA, :whA, 'in_progress', 'warehouse', :mgr, now(), :mult);
insert into public.cycle_count_lines (id, cycle_count_id, item_id, expected_quantity, counted_quantity, counted_by, warehouse_id)
  values (:ccLM, :ccM, :itG, 5, 5, :mult, :whA);

-- ══ Helpers (the 0387 helpers, sentinel XX388) ════════════════════════════
create function pg_temp.hint(p_hint text) returns text language sql immutable as $$
  select case when p_hint is null or p_hint = ''
                or p_hint like 'Grant the required privileges to the current role with:%'
              then '-' else p_hint end
$$;
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
    raise exception using errcode = 'XX388', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_state = 'XX388' then
    return 'ok:' || v_n::text || coalesce(':' || v_seen, '');
  end if;
  return v_state || ':' || pg_temp.hint(v_hint) || ':' || v_msg;
end $$;
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
-- N4: one TAP line per order_requests column authenticated may NOT insert.
create function pg_temp.n4_tests(p_vwr uuid, p_org uuid, p_wh uuid) returns setof text language plpgsql as $$
declare c record;
begin
  for c in
    select a.attname::text as col
      from pg_attribute a
     where a.attrelid = 'public.order_requests'::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname not in ('organization_id', 'warehouse_id', 'requester_user_id', 'requester_name', 'requester_email',
                             'notes', 'needed_by', 'fulfillment_type', 'requester_phone', 'delivery_charter_id',
                             'pickup_location_notes', 'source', 'status')
     order by a.attname collate "C"
  loop
    return next is(
      pg_temp.attempt('authenticated', p_vwr,
                      format($q$insert into public.order_requests
                                  (organization_id, warehouse_id, requester_user_id, source, status, fulfillment_type, %I)
                                values (%L, %L, %L, 'internal', 'pending_approval', 'pickup', default)$q$,
                             c.col, p_org, p_wh, p_vwr)),
      '42501:-:permission denied for table order_requests',
      format('N4 %s: a viewer''s raw insert naming %s (even as DEFAULT) is refused by the column privilege, 42501', c.col, c.col));
  end loop;
end $$;
-- The user FK columns of order_requests (D13, D16), read from the catalog.
create temp view or_user_cols as
select a.attname::text as col
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
 where c.conrelid = 'public.order_requests'::regclass and c.contype = 'f'
   and c.confrelid = 'public.user_profiles'::regclass;
-- C1 scans every schema but pg_catalog and information_schema, leaving out
-- extension members and session temp schemas (0387 AL9's fn_scope).
create temp view fn_scope as
select n.nspname || '.' || p.proname as fn, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.prosrc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and n.nspname !~ '^pg_(toast_)?temp_'
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

-- ══ N. Item 15: explicit order numbers and server-owned insert columns ════
select is(
  has_table_privilege('authenticated', 'public.order_requests', 'INSERT')::text || '|'
  || (select string_agg(a.attname, ',' order by a.attname)
        from pg_attribute a
       where a.attrelid = 'public.order_requests'::regclass and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('authenticated', 'public.order_requests', a.attname, 'INSERT')) || '|'
  || has_any_column_privilege('anon', 'public.order_requests', 'INSERT')::text,
  'false|delivery_charter_id,fulfillment_type,needed_by,notes,organization_id,pickup_location_notes,requester_email,'
  'requester_name,requester_phone,requester_user_id,source,status,warehouse_id|false',
  'N1: authenticated holds no table-level INSERT on order_requests and may INSERT exactly the 13 columns create_order_request names; anon may insert nothing');

select coalesce(max(order_number), 0) as n_max from public.order_requests where organization_id = :orgA \gset

select is(
  pg_temp.attempt('authenticated', :vwr,
                  format($q$insert into public.order_requests
                              (organization_id, warehouse_id, requester_user_id, source, status, fulfillment_type, order_number)
                            values (%L, %L, %L, 'internal', 'pending_approval', 'pickup', 9223372036854775807)$q$, :orgA, :whA, :vwr))
  || '|' || (select coalesce(max(order_number), 0)::text from public.order_requests where organization_id = :orgA),
  '42501:-:permission denied for table order_requests|' || :n_max,
  'N2: a viewer''s raw insert of their own pending order with order_number = bigint max is refused (42501), and the organization''s highest number is unchanged');
select is(
  pg_temp.call_as('authenticated', :mgr,
                  format($q$select r.order_number::text
                              from public.create_order_request(
                                     jsonb_build_object('organization_id', %L, 'warehouse_id', %L, 'requester_user_id', %L,
                                                        'fulfillment_type', 'pickup'),
                                     jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1))) r$q$, :orgA, :whA, :mgr, :itG)),
  (:n_max + 1)::text,
  'N3: after N2 the manager''s create_order_request still numbers the next order max + 1 (plan item 15''s own pgTAP)');

select * from pg_temp.n4_tests(:vwr, :orgA, :whA);

select is(
  pg_temp.attempt('authenticated', :vwr,
                  format($q$insert into public.order_requests
                              (organization_id, warehouse_id, requester_user_id, source, status, fulfillment_type, notes)
                            values (%L, %L, %L, 'internal', 'pending_approval', 'pickup', '0388 N5 note')$q$, :orgA, :whA, :vwr),
                  null,
                  format($q$select (o.order_number = %s)::text || '/' || (o.created_at = now())::text || '/'
                                   || coalesce(o.requester_deleted_at::text, 'null')
                              from public.order_requests o where o.organization_id = %L and o.notes = '0388 N5 note'$q$,
                         :n_max + 2, :orgA)),
  'ok:1:true/true/null',
  'N5: a viewer''s raw insert naming only granted columns still passes the policy and the insert guard: numbered max + 1, created_at = now(), no marker');

select is(
  pg_temp.call_as('authenticated', :stfAp,
                  format($q$select r.status || '/' || (r.requester_user_id = %L)::text || '/' || coalesce(r.requester_deleted_at::text, 'null')
                                   || '/' || (r.order_number = %s)::text
                              from public.create_order_request(
                                     jsonb_build_object('organization_id', %L, 'warehouse_id', %L, 'requester_user_id', %L,
                                                        'fulfillment_type', 'pickup'),
                                     jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1))) r$q$,
                         :stfAp, :n_max + 2, :orgA, :whA, :stfAp, :itG)),
  'pending_approval/true/null/true',
  'N6a: create_order_request (RETURNING *) as staff for themself returns the full row, numbered, marker null');
select is(
  pg_temp.call_as('authenticated', :mgr,
                  format($q$select r.status || '/' || coalesce(r.requester_user_id::text, 'null') || '/' || r.requester_email || '/'
                                   || coalesce(r.requester_deleted_at::text, 'null') || '/' || (r.order_number = %s)::text
                              from public.create_order_request(
                                     jsonb_build_object('organization_id', %L, 'warehouse_id', %L, 'requester_name', 'N6 Person',
                                                        'requester_email', '0388-n6@test.local', 'fulfillment_type', 'pickup'),
                                     jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 1))) r$q$,
                         :n_max + 3, :orgA, :whA, :itG)),
  'pending_approval/null/0388-n6@test.local/null/true',
  'N6b: create_order_request as the manager on behalf of someone (no requester id, an email) returns the full row, marker null');

select is(
  pg_temp.attempt('authenticated', :vwr,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, requester_user_id, source, status, fulfillment_type)
                            values (%L, %L, %L, %L, 'internal', 'pending_approval', 'pickup') on conflict (id) do nothing$q$,
                         :oLive, :orgA, :whA, :vwr))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr,
                  format($q$insert into public.order_requests (id, organization_id, warehouse_id, requester_user_id, source, status, fulfillment_type)
                            values (%L, %L, %L, %L, 'internal', 'pending_approval', 'pickup')
                            on conflict (id) do update set status = excluded.status$q$, :oLive, :orgA, :whA, :mgr)),
  '42501:-:permission denied for table order_requests | 42501:-:permission denied for table order_requests',
  'N7: an upsert naming id is refused by the id INSERT privilege, with ON CONFLICT DO NOTHING (viewer) and DO UPDATE of a granted column (manager)');

select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.order_requests
                              (organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, order_number)
                            values (%L, %L, 'pending_approval', 'internal', %L, 'pickup', 900001)$q$, :orgA, :whA, :mgr),
                  null, format('select max(order_number)::text from public.order_requests where organization_id = %L', :orgA)),
  'ok:1:900001',
  'N8a: service_role (the admin client: imports and restores) still inserts an explicit order number');
select is(
  pg_temp.attempt('postgres', null,
                  format($q$insert into public.order_requests
                              (organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, order_number)
                            values (%L, %L, 'pending_approval', 'internal', %L, 'pickup', 900002)$q$, :orgA, :whA, :mgr),
                  null, format('select max(order_number)::text from public.order_requests where organization_id = %L', :orgA)),
  'ok:1:900002',
  'N8b: postgres (migrations, fixtures, DEFINER bodies) still inserts an explicit order number');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.order_requests
                              (organization_id, warehouse_id, status, source, requester_user_id, requester_email, requester_name,
                               requester_org_label, notes, fulfillment_type, requester_phone, delivery_charter_id, pickup_location_notes,
                               confirmation_token_hash, confirmation_token_expires_at)
                            values (%L, %L, 'pending_confirmation', 'public_link', null, '0388-pub2@test.local', 'Pub Two',
                                    'Some School', null, 'pickup', null, null, null,
                                    repeat('c', 64), now() + interval '1 day')$q$, :orgA, :whA)),
  -- Re-pinned by 0392 (was the same insert with public_track_token on the
  -- row): the public submit writes its track token to order_request_secrets
  -- since 0389 (api/v1/public/order-requests/route.ts), and 0392's insert
  -- guard refuses one on the row for the admin client (0392 suite G23).
  'ok:1',
  'N8c: the public link''s insert shape (the confirmation token, requester_org_label; the track token goes to order_request_secrets) still inserts as service_role');
select is(
  pg_temp.attempt('service_role', null,
                  format($q$insert into public.order_requests
                              (organization_id, warehouse_id, status, source, customer_id, requester_user_id, requester_email,
                               requester_name, notes, fulfillment_type)
                            values (%L, %L, 'pending_approval', 'portal', %L, %L, '0388-cust@test.local', 'Cust Co 0388', null, 'pickup')$q$,
                         :orgA, :whA, :custC, :cust)),
  'ok:1',
  'N8d: the portal''s insert shape (customer_id) still inserts as service_role');

-- ══ P. account_deletion_check ═════════════════════════════════════════════
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :free),
                  format($q$select (select count(*) from auth.users where id = %1$L) || '/'
                                   || (select count(*) from public.user_profiles where id = %1$L) || '/'
                                   || (select count(*) from public.organization_members where user_id = %1$L)$q$, :free)),
  '{"deletable": true}|1/1/1',
  'P1: an account with no blocker is deletable, and the check changed nothing (auth user, profile and membership still there)');
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :poU),
                  format($q$select (select count(*) from auth.users where id = %1$L) || '/'
                                   || (select count(*) from public.po_imports where uploaded_by = %1$L)$q$, :poU)),
  '{"table": "public.po_imports", "reason": "blocked", "sqlstate": "23503", "deletable": false, "constraint": "po_imports_uploaded_by_fkey"}|1/1',
  'P2: an account with a PO import is blocked by the RESTRICT key (23503 po_imports_uploaded_by_fkey on public.po_imports), and nothing persisted');
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :rq1),
                  format($q$select (select count(*) from auth.users where id = %1$L) || '/'
                                   || (select count(*) from public.order_requests where requester_user_id = %1$L) || '/'
                                   || (select count(*) from public.order_requests where requester_deleted_at is not null)$q$, :rq1)),
  '{"deletable": true}|1/2/0',
  'P3: a requester whose orders carry no email is deletable now (it was 23514 identity_chk before 0388), and the dry run left both orders linked and unmarked');
select is(
  pg_temp.call_as('service_role', null,
                  'select public.account_deletion_check(gen_random_uuid())::text || '' '' || public.account_deletion_check(null)::text'),
  '{"reason": "not_found", "deletable": false} {"reason": "no_user", "deletable": false}',
  'P4: an unknown id answers not_found and a null id no_user');
select is(
  (select string_agg(a::text, ',' order by a::text collate "C")
     from pg_proc p, unnest(p.proacl) a where p.oid = 'public.account_deletion_check(uuid)'::regprocedure)
  || '|' || has_function_privilege('authenticated', 'public.account_deletion_check(uuid)', 'EXECUTE')::text
  || ',' || has_function_privilege('anon', 'public.account_deletion_check(uuid)', 'EXECUTE')::text,
  'postgres=X/postgres,service_role=X/postgres|false,false',
  'P5a: only postgres and service_role may EXECUTE account_deletion_check');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select public.account_deletion_check(%L)', :rq1))
  || ' | ' || pg_temp.attempt('authenticated', :mgr, format('select public.account_deletion_check(%L)', :rq1),
                              'grant execute on function public.account_deletion_check(uuid) to authenticated')
  || ' | ' || pg_temp.attempt('anon', null, format('select public.account_deletion_check(%L)', :rq1),
                              'grant execute on function public.account_deletion_check(uuid) to anon'),
  '42501:-:permission denied for function account_deletion_check'
  ' | 42501:-:account_deletion_check_service_only | 42501:-:account_deletion_check_service_only',
  'P5b: an authenticated caller is refused EXECUTE, and with EXECUTE granted (inside the undone subtransaction) the body still refuses an authenticated or anon JWT');
select is(
  (select string_agg(distinct m[1], ',' order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.account_deletion_check(uuid)'::regprocedure)
  || '/' ||
  (select (p.prosrc !~* '40001|40p01|serialization_failure|deadlock_detected')::text
     from pg_proc p where p.oid = 'public.account_deletion_check(uuid)'::regprocedure),
  '42501,P0001/true',
  'P6: account_deletion_check raises only 42501 and P0001 (its own undo, caught), never 40001 or 40P01 (PostgREST retries those forever)');
select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :paU)),
  '{"table": "public.platform_admin_audit", "reason": "blocked", "sqlstate": "23502", "deletable": false, "constraint": null}',
  'P7: a user named by platform_admin_audit (SET NULL on a NOT NULL column) is blocked 23502: any refusal in the cascade is reported, not only FKs and CHECKs');
select is(
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('public', 'auth') and c.condeferrable)::text
  || '/' ||
  (select count(*) from pg_trigger t join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace
    where n.nspname in ('public', 'auth') and t.tgconstraint <> 0 and t.tgdeferrable)::text
  || '/' ||
  (select count(*) from pg_constraint c
    where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.user_profiles'::regclass) and c.condeferrable)::text,
  '0/0/0',
  'P8: no constraint in public or auth is DEFERRABLE, no constraint trigger there is deferrable, and no key in any schema that references a user is: every check of a deletion fires inside account_deletion_check''s subtransaction');
select is(
  (select coalesce(string_agg(c.conrelid::regclass::text || '.' || c.conname, ',' order by c.conname collate "C"), '')
     from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname in ('public', 'auth') and not c.convalidated),
  'order_requests.order_requests_delivery_target_chk',
  'P8b: the only NOT VALID constraint in public or auth is order_requests_delivery_target_chk (a legacy row breaking it refuses the FK''s SET NULL, P8c): a new one changes who can be deleted and is reviewed with the A3 census');

-- ══ C. The check is the only deleter of accounts, and its posture ═════════
select is(
  (select coalesce(string_agg(f.fn || ':' || f.owner || ':' || f.prosecdef::text, ',' order by f.fn collate "C"), '')
     from fn_scope f
    where f.prosrc ~* $re$delete\s+from\s+(only\s+)?("?auth"?\s*\.\s*"?users\M"?|("?public"?\s*\.\s*)?"?user_profiles\M"?)$re$),
  'public.account_deletion_check:postgres:true',
  'C1: in every schema, the only function whose body deletes from auth.users or user_profiles is account_deletion_check (a SECURITY DEFINER writer of order_requests through the FK cascade, always undone): a new one fails here and is reviewed');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner)
     from pg_proc p where p.oid = to_regprocedure('public.account_deletion_check(uuid)')),
  '15968336d457e56544f3a2421e807b35|true|{"search_path=public, pg_temp",lock_timeout=900ms}|postgres',
  'C2: account_deletion_check is 0388''s body, SECURITY DEFINER, search_path pinned, lock_timeout 900ms (below deadlock_timeout 1s), owned by postgres (its EXECUTE list is P5a)');
select cmp_ok(
  (select setting::int from pg_settings where name = 'deadlock_timeout'),
  '>',
  900,
  'C3: deadlock_timeout (ms) on this stack is above account_deletion_check''s lock_timeout 900ms, so a row lock ends the check with 55P03 before its wait can make an order write the deadlock victim (production''s value is read at R0)');

-- ══ D. Item 16: the marker ════════════════════════════════════════════════
select is(
  pg_temp.attempt('service_role', null, format('update public.order_requests set requester_user_id = null where id = %L', :oLive))
  || ' | ' || pg_temp.attempt('postgres', null, format('update public.order_requests set requester_user_id = null where id = %L', :oLive)),
  '23514:-:new row for relation "order_requests" violates check constraint "order_requests_identity_chk"'
  ' | 23514:-:new row for relation "order_requests" violates check constraint "order_requests_identity_chk"',
  'D5: service_role or postgres nulling a LIVE requester (no email on the row) still fails identity_chk: the marker is stamped only when the profile is gone');
select is(
  pg_temp.attempt('service_role', null, format('update public.order_requests set requester_deleted_at = now() where id = %L', :oLive)),
  '23514:-:new row for relation "order_requests" violates check constraint "order_requests_requester_deleted_chk"',
  'D6: the marker cannot sit on an order that still has a requester (requester_deleted_chk)');
select is(
  has_column_privilege('authenticated', 'public.order_requests', 'requester_deleted_at', 'INSERT')::text || ','
  || has_column_privilege('authenticated', 'public.order_requests', 'requester_deleted_at', 'UPDATE')::text || ','
  || has_column_privilege('authenticated', 'public.order_requests', 'requester_deleted_at', 'SELECT')::text || '|'
  || pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set requester_deleted_at = null where id = %L', :oLive))
  || '|' || pg_temp.attempt('authenticated', :vwr, format('select requester_deleted_at from public.order_requests where id = %L', :oLive)),
  'false,false,true|42501:-:permission denied for table order_requests|ok:1',
  'D7: authenticated may read requester_deleted_at and may not insert or update it');
select is(
  pg_temp.attempt('authenticated', :mgr, format('select 1 from public.user_profiles where id = %L', :rqLeft))
  || ' | ' ||
  pg_temp.attempt('authenticated', :mgr, format('update public.order_requests set requester_user_id = null where id = %L', :oLeft),
                  'grant update (requester_user_id) on table public.order_requests to authenticated'),
  'ok:0 | 23514:-:new row for relation "order_requests" violates check constraint "order_requests_identity_chk"',
  'D7b: an API role never stamps: the former member''s profile is hidden from the manager by RLS, and even with UPDATE (requester_user_id) granted back the manager''s null is refused, unmarked');
select is(
  pg_temp.attempt('service_role', null, format($q$update public.order_requests set notes = 'Gate 0388' where id = %L$q$, :oLive), null,
                  format($q$select coalesce(requester_deleted_at::text, 'null') from public.order_requests where id = %L$q$, :oLive))
  || ' | ' ||
  pg_temp.attempt('service_role', null, format('update public.order_requests set requester_user_id = null where id = %L', :oOB), null,
                  format($q$select coalesce(requester_deleted_at::text, 'null') from public.order_requests where id = %L$q$, :oOB))
  || ' | ' ||
  pg_temp.attempt('postgres', null, format('update public.order_requests set requester_user_id = %L where id = %L', :stfAp, :oLive), null,
                  format($q$select coalesce(requester_deleted_at::text, 'null') from public.order_requests where id = %L$q$, :oLive)),
  'ok:1:null | ok:1:null | ok:1:null',
  'D10: no stamp for a notes save, for a requester id that was already null, or for a requester moved to another live member');
select is(
  (select string_agg(c.conname || '|' || md5(pg_get_constraintdef(c.oid)) || '|' || c.convalidated::text, ',' order by c.conname)
     from pg_constraint c
    where c.conrelid = 'public.order_requests'::regclass
      and c.conname in ('order_requests_identity_chk', 'order_requests_requester_deleted_chk')),
  'order_requests_identity_chk|028224bf51d831c5d5b6626c1b37f1b8|true,order_requests_requester_deleted_chk|e08f6a0a46d6d98aea3781e92a6131eb|true',
  'D8: identity_chk (internal: a requester id, an email or the marker; public link: an email; portal: a requester id or the marker) and requester_deleted_chk are 0388''s text and both validated');
select is(
  (select md5(p.prosrc) || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|'
          || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|'
          || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false')
     from pg_proc p where p.oid = to_regprocedure('public.tg_order_requests_requester_deleted()'))
  || '#' ||
  (select md5(pg_get_triggerdef(t.oid)) || '|' || t.tgtype::text || '|' || t.tgenabled::text || '|' || t.tgfoid::regproc::text || '|'
          || (t.tgattr::text = (select a.attnum::text from pg_attribute a where a.attrelid = t.tgrelid and a.attname = 'requester_user_id'))::text
     from pg_trigger t where t.tgrelid = 'public.order_requests'::regclass and t.tgname = 'trg_order_requests_requester_deleted'),
  '9933f6e354f831d7090f5b524cc722d3|false|{search_path=public}|postgres|false|false|false'
  '#6f7b1f4e5cbb01e186b606ed73797a31|19|O|tg_order_requests_requester_deleted|true',
  'D9: the marker trigger function is 0388''s body, SECURITY INVOKER (under DEFINER every caller would look like postgres), search_path pinned, owned by postgres, not executable by PUBLIC, anon or authenticated; its trigger is BEFORE UPDATE OF requester_user_id FOR EACH ROW, enabled');
select is(
  (select string_agg(c.relname || '=' || c.relforcerowsecurity::text, ',' order by c.relname)
     from pg_class c where c.oid in ('public.user_profiles'::regclass, 'public.order_requests'::regclass))
  || '|' ||
  (select string_agg(r.rolname || '=' || r.rolbypassrls::text, ',' order by r.rolname)
     from pg_roles r where r.rolname in ('postgres', 'service_role')),
  'order_requests=false,user_profiles=false|postgres=true,service_role=true',
  'D9b: no FORCE RLS on user_profiles or order_requests, and postgres and service_role bypass RLS: the trigger''s "profile is gone" test reads every profile for the roles it trusts');

-- ══ D. Deleting a requester's account end to end ══════════════════════════
select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.approve_order_request(%L) r', :oR1b),
                  format('select count(*)::text from public.stock_reservations where order_request_id = %L and released_at is null', :oR1b)),
  'approved|1',
  'D0: fixture: the manager approves rq1''s second order (one hold placed) before rq1''s account is deleted');

create temp table snap_orders as
select o.id, md5(to_jsonb(o)::text) as h, to_jsonb(o) as j, o.updated_at, o.status
  from public.order_requests o where o.organization_id = :orgA;
create temp table snap_notif as
select n.user_id, count(*) as n from public.notifications n group by n.user_id;
create temp table gone as
select p.id, p.email::text as email, p.full_name
  from public.user_profiles p where p.id in (:rq1, :rqLeft, :rqLeg, :cust, :mult);
create temp table held_before as
select distinct o.id
  from public.order_requests o, gone g
 where strpos(lower(to_jsonb(o)::text), lower(g.email)) > 0
    or (g.full_name is not null and strpos(lower(to_jsonb(o)::text), lower(g.full_name)) > 0);
create temp table pii_before as
select count(*) filter (where requester_email is not null) as e,
       count(*) filter (where requester_name is not null) as n,
       count(*) filter (where requester_phone is not null) as ph
  from public.order_requests;

select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :rq1),
                  format($q$select string_agg(o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/'
                                              || coalesce(o.requester_email, 'null') || '/' || coalesce(o.requester_name, 'null') || '/'
                                              || coalesce((o.requester_deleted_at = now())::text, 'null'), ' ' order by o.id)
                              from public.order_requests o where o.id in (%L, %L)$q$, :oR1a, :oR1b)),
  :rq1 || '|pending_approval/null/null/null/true approved/null/null/null/true',
  'D1: deleting the account of a requester whose orders carry no email succeeds; both orders keep their status, lose the requester, carry no email or name, and are marked at the transaction''s now()');
select is(
  (select count(*) from public.order_request_lines where order_request_id in (:oR1a, :oR1b))::text || '/'
  || (select count(*) from public.stock_reservations where order_request_id in (:oR1a, :oR1b) and released_at is null)::text || '/'
  || (select count(*) from public.user_profiles where id = :rq1)::text || '/'
  || (select count(*) from public.organization_members where user_id = :rq1)::text,
  '2/1/0/0',
  'D1L: the orders keep their 2 lines and the hold; the profile and the membership are gone');
select is(
  (select count(*)
     from (select n.user_id, count(*) as n from public.notifications n where n.user_id <> :rq1 group by n.user_id) a
     full join (select s.user_id, s.n from snap_notif s where s.user_id <> :rq1) b using (user_id)
    where a.n is distinct from b.n)::text
  || '|' || (select (o.updated_at = now() and s.updated_at < now())::text
               from public.order_requests o join snap_orders s using (id) where o.id = :oR1a)
  || '|' || (select string_agg((o.status = s.status)::text, ',' order by o.id)
               from public.order_requests o join snap_orders s using (id) where o.id in (:oR1a, :oR1b)),
  '0|true|true,true',
  'D12: the deletion notified nobody else (no new notification for any other user), the workflow guard did not refuse it, the statuses are unchanged, and updated_at moved (plan F6)');
select is(
  (select count(*) from snap_orders s left join public.order_requests o on o.id = s.id
    where not exists (select 1 from jsonb_each_text(s.j) e where e.key in (select col from or_user_cols) and e.value = :rq1)
      and (o.id is null or md5(to_jsonb(o)::text) <> s.h))::text
  || '/' || ((select count(*) from snap_orders s
               where not exists (select 1 from jsonb_each_text(s.j) e where e.key in (select col from or_user_cols) and e.value = :rq1)) > 10)::text
  || '/' || (select count(*) from snap_orders s
              where exists (select 1 from jsonb_each_text(s.j) e where e.key in (select col from or_user_cols) and e.value = :rq1))::text,
  '0/true/2',
  'D13: every order of the organization that names rq1 in no user column is byte-identical after the deletion (only rq1''s 2 orders changed)');

select is(
  pg_temp.call_as('authenticated', :mgr, format('select r.status from public.approve_order_request(%L) r', :oR1a),
                  format($q$select (select count(*) from public.stock_reservations where order_request_id = %1$L and released_at is null) || '/'
                                   || (select coalesce(o.requester_user_id::text, 'null') || '/' || (o.requester_deleted_at is not null)::text
                                         from public.order_requests o where o.id = %1$L)$q$, :oR1a)),
  'approved|1/null/true',
  'D15a: a manager can still approve the pending order of a deleted requester (hold placed, still marked; the requester notification has no recipient and is skipped)');
select is(
  pg_temp.call_as('authenticated', :mgr, format($q$select r.status from public.cancel_order_request(%L, 'Requester left') r$q$, :oR1b),
                  format('select count(*)::text from public.stock_reservations where order_request_id = %L and released_at is null', :oR1b)),
  'cancelled|0',
  'D15b: a manager can still cancel the approved order of a deleted requester, and its hold is released');

select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :rqLeft),
                  format($q$select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || coalesce(o.requester_email, 'null')
                                   || '/' || coalesce((o.requester_deleted_at = now())::text, 'null') || '/' || coalesce(o.approved_by::text, 'null')
                              from public.order_requests o where o.id = %L$q$, :oLeft)),
  :rqLeft || '|completed/null/null/true/' || :mgr,
  'D1b: a requester who left the organization before deleting their account: the delete succeeds, the completed order is kept and marked, its approver untouched');
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :cust),
                  format($q$select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || coalesce(o.requester_email, 'null')
                                   || '/' || coalesce(o.requester_name, 'null') || '/' || coalesce((o.requester_deleted_at = now())::text, 'null')
                                   || '/' || (o.customer_id = %L)::text || '/'
                                   || (select count(*) from public.customer_users cu where cu.user_id = %L)::text
                              from public.order_requests o where o.id = %L$q$, :custC, :cust, :oPor)),
  :cust || '|pending_approval/null/0388-cust@test.local/Cust Co 0388/true/true/0',
  'D2: deleting a portal customer''s account: the portal order is kept with the email and name it already held, marked, still linked to the customer; the customer_users row cascades');
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :rqLeg),
                  format($q$select o.status || '/' || coalesce(o.requester_user_id::text, 'null') || '/' || coalesce(o.requester_email, 'null')
                                   || '/' || coalesce(o.requester_name, 'null') || '/' || coalesce((o.requester_deleted_at = now())::text, 'null')
                              from public.order_requests o where o.id = %L$q$, :oLeg)),
  :rqLeg || '|completed/null/0388-rqleg@test.local/Rq Legacy 0388/true',
  'D4: a legacy internal order that already held the requester''s email and name keeps them; the requester id is nulled and the order is marked');

select is(
  pg_temp.call_as('service_role', null, format('select public.account_deletion_check(%L)::text', :mult)),
  '{"deletable": true}',
  'D16a: an approver, picker, pick-slip author, canceller and cycle-count counter (who also requested one order) is deletable');
select is(
  pg_temp.call_as('postgres', null, format('delete from auth.users where id = %L returning id::text', :mult),
                  format($q$select string_agg(o.status || '/' || coalesce((o.requester_user_id = %L)::text, 'null') || '/'
                                              || coalesce((o.requester_deleted_at = now())::text, 'null'), ' ' order by o.id)
                                   || '|' || (select count(*) from public.order_requests r, jsonb_each_text(to_jsonb(r)) e
                                               where e.key in (select col from or_user_cols) and e.value = %L)
                              from public.order_requests o where o.id in (%L, %L, %L, %L)$q$, :vwr, :mult, :oM1, :oM2, :oM3, :oM4)),
  :mult || '|approved/true/null picking_in_progress/true/null cancelled/true/null picking_in_progress/null/true|0',
  'D16b: deleting that account nulls it from every user column of every order (approver, picker, claimer, pick-slip author, canceller); only the order they requested is marked; the others keep their requester');
select is(
  (select coalesce(c.assigned_to::text, 'null') || '/' || c.status from public.cycle_counts c where c.id = :ccM)
  || '/' || (select coalesce(l.counted_by::text, 'null') || '/' || trim_scale(l.counted_quantity)::text
               from public.cycle_count_lines l where l.id = :ccLM),
  'null/in_progress/null/5',
  'D16c: the counter''s cycle count and counted line are kept with the assignee and counter nulled and the count unchanged');

select is(
  (select string_agg((md5(to_jsonb(o)::text) = s.h)::text || '/' || coalesce(o.requester_deleted_at::text, 'null'), ' ' order by o.id)
     from public.order_requests o join snap_orders s using (id) where o.id in (:oPub, :oOB)),
  'true/null true/null',
  'D3: the public-link order and the on-behalf order (no requester id, an email) never changed and carry no marker');
select is(
  (select count(*) from public.order_requests o, gone g
    where (strpos(lower(to_jsonb(o)::text), lower(g.email)) > 0
           or (g.full_name is not null and strpos(lower(to_jsonb(o)::text), lower(g.full_name)) > 0))
      and o.id not in (select id from held_before))::text
  || '|' || (select (p.e = x.e and p.n = x.n and p.ph = x.ph)::text
               from pii_before p,
                    (select count(*) filter (where requester_email is not null) as e,
                            count(*) filter (where requester_name is not null) as n,
                            count(*) filter (where requester_phone is not null) as ph
                       from public.order_requests) x)
  || '|' || (select count(*) from held_before)::text,
  '0|true|2',
  'D14: privacy: after the five deletions no order row holds a deleted person''s email or name unless it already did (the legacy row and the portal row), and no row gained a requester email, name or phone');

-- ══ K. Comments ═══════════════════════════════════════════════════════════
select is(
  (obj_description('public.account_deletion_check(uuid)'::regprocedure, 'pg_proc') ~ '0388')::text || ','
  || (obj_description('public.tg_order_requests_requester_deleted()'::regprocedure, 'pg_proc') ~ '0388')::text || ','
  || (col_description('public.order_requests'::regclass,
                      (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'requester_deleted_at'))
      ~ '0388')::text || ','
  || (select string_agg(coalesce(obj_description(c.oid, 'pg_constraint') ~ '0388', false)::text, ',' order by c.conname)
        from pg_constraint c
       where c.conrelid = 'public.order_requests'::regclass
         and c.conname in ('order_requests_identity_chk', 'order_requests_requester_deleted_chk')),
  'true,true,true,true,true',
  'K: both functions, the new column and both CHECKs say in their comments what 0388 does');

-- ══ P8c. A row that breaks the NOT VALID CHECK refuses the deletion ═══════
-- Last in the file: it drops and re-adds order_requests_delivery_target_chk
-- (NOT VALID, the same definition), undone by the file's rollback. The free
-- staff member (no orders, deletable in P1) gets one closed delivery order
-- with no charter, the shape of production's 5 legacy rows.
alter table public.order_requests drop constraint order_requests_delivery_target_chk;
insert into public.order_requests
  (organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id)
values (:orgA, :whA, 'cancelled', 'internal', :free, 'delivery', null);
alter table public.order_requests add constraint order_requests_delivery_target_chk check (
  (fulfillment_type = 'delivery' and delivery_charter_id is not null)
  or (fulfillment_type = 'pickup' and delivery_charter_id is null)) not valid;
select is(
  (select r->>'deletable' || '/' || (r->>'reason') || '/' || (r->>'sqlstate') || '/' || (r->>'constraint') || '/' || (r->>'table')
     from (select pg_temp.call_as('service_role', null,
                    format('select public.account_deletion_check(%L)::text', :free))::jsonb as r) x)
  || '/' || (select count(*) from auth.users where id = :free)::text
  || '/' || (select count(*) from public.order_requests where requester_user_id = :free)::text,
  'false/blocked/23514/order_requests_delivery_target_chk/public.order_requests/1/1',
  'P8c: a row breaking the NOT VALID delivery_target_chk refuses the FK''s SET NULL: the check answers blocked 23514 (an integrity refusal, "linked records"), and the account and its order are unchanged');

select * from finish();
rollback;
