-- supabase/tests/0384_schedule_event_order_link.test.sql
-- pgTAP proof for migration 0384: a Schedule event's order link
-- (schedule_events.order_request_id) and its assignee (assigned_user_id) are
-- set only by the server paths that own them, and a linked order is always in
-- the event's own organization.
--
-- L. The link and the assignee refused for every signed-in role: a viewer, a
--    staff member, a manager and the owner of org A inserting an event linked
--    to an order of their org (V1), an org B manager linking an org B event to
--    an org A order (P9) or to an order of their own org, the creator of an
--    event re-linking it (V3), a manager clearing a link, and a viewer or a
--    manager naming an assignee (A1): each is 42501 permission denied, and
--    nothing is written. After them, org A's order still has its slot:
--    the admin path (service_role, autoScheduleFromOrder's insert) creates the
--    order's own event (P9 no longer blocks it with 23505).
-- O. The organization: a manager of both orgs moving a linked org A event to
--    org B is refused by the row policy (42501 row-level security). The
--    policies reuse 0362's order_request_in_org (the maintenance-request
--    guard's predicate, not changed here): true for no order, true for an
--    order of the org asked by a member, false for another org's order, and
--    false to a signed-in caller who is not a member of the org it names (no
--    cross-org oracle).
-- P. The order side of the link (review finding D1): an order's organization
--    is fixed for a signed-in caller. A manager of both orgs moving an org A
--    order that has its org A event to org B (which left the event linked
--    across orgs and gave org B's own event for that order a 23505) is 42501
--    permission denied, and nothing is written. (An order's created_at and
--    warehouse_id stay editable: owner question Q4, pinned by 0379 C1/C2.)
-- I. An event's identity (review finding U4): a viewer re-keying their own
--    event and its creator backdating it are 42501; nothing is written.
-- K. Every legitimate flow still works: a manual event inserted the phone's
--    way (staff) and the Schedule page's way (manager, with RETURNING), and by
--    a viewer (the existing any-member insert rule is unchanged); the order
--    event's creator and a manager editing it the Schedule page's way (title,
--    start, end, description, status, both reminder stamps cleared,
--    updated_by), the link unchanged; the owner too; a viewer who is neither
--    still changes nothing; the creator deletes their own event; the order
--    flows' admin writes (autoScheduleFromOrder's insert with the link and
--    the driver, assignDelivery's assignee sync and syncOrderScheduleEvent's
--    close, both keyed on the link, bringOrderEventInStep's move) and the
--    approver's revise_order_needed_by (0383, DEFINER) moving the order's
--    event. Every order write the web makes through the user client, each in
--    the exact shape it sends (assignDelivery, the internal-notes save, deny,
--    the pick slip, the packing slip with its signature token, staging, in
--    transit), by a manager or a staff approver, with the RETURNING it reads.
-- G. The posture: authenticated may INSERT every schedule_events column but
--    the two server-owned ones and UPDATE every column but those two, id and
--    created_at (computed over the table's columns, so a new column forces a
--    decision), holds no table-level INSERT or UPDATE, keeps SELECT and
--    DELETE, loses TRUNCATE; anon writes nothing; service_role keeps its
--    table grants; the predicate is 0362's body, SECURITY DEFINER, STABLE,
--    search_path pinned, EXECUTE to authenticated and not anon; the four
--    policies are exactly 0384's; both server-owned columns say so in their
--    comments. On order_requests authenticated may UPDATE every column but
--    organization_id (computed the same way; re-pinned by 0387, which also
--    withholds 38 more columns), holds no table-level UPDATE and
--    keeps table INSERT and SELECT; service_role keeps its table grants;
--    organization_id says so in its comment.
--
-- Roles: fixtures as the test superuser; the attacks and the Schedule page as
-- `authenticated` with request.jwt.claim.sub; the admin client as
-- service_role; anon as anon. begin/rollback: nothing leaks. Namespace
-- 03840000.

begin;

select plan(57);

\set orgA   '\'03840000-0000-0000-0000-00000000000a\''
\set orgB   '\'03840000-0000-0000-0000-00000000000b\''
\set own    '\'03840000-0000-0000-0000-0000000000a0\''
\set mgr    '\'03840000-0000-0000-0000-0000000000a1\''
\set stf    '\'03840000-0000-0000-0000-0000000000a3\''
\set stfAp  '\'03840000-0000-0000-0000-0000000000a4\''
\set vwr    '\'03840000-0000-0000-0000-0000000000a6\''
\set dual   '\'03840000-0000-0000-0000-0000000000a9\''
\set mgrB   '\'03840000-0000-0000-0000-0000000000b1\''
\set whA    '\'03840000-0000-0000-0000-0000000000d1\''
\set whB    '\'03840000-0000-0000-0000-0000000000d3\''
\set chA    '\'03840000-0000-0000-0000-0000000000c1\''
\set ordEv  '\'03840000-0000-0000-0000-000000000101\''
\set ordFree '\'03840000-0000-0000-0000-000000000102\''
\set ordNew '\'03840000-0000-0000-0000-000000000103\''
\set ordDual '\'03840000-0000-0000-0000-000000000104\''
\set ordStg '\'03840000-0000-0000-0000-000000000105\''
\set ordPend '\'03840000-0000-0000-0000-000000000106\''
\set ordPk  '\'03840000-0000-0000-0000-000000000107\''
\set ordPack '\'03840000-0000-0000-0000-000000000108\''
\set ordB   '\'03840000-0000-0000-0000-000000000141\''
\set evOrd  '\'03840000-0000-0000-0000-000000000201\''
\set evMan  '\'03840000-0000-0000-0000-000000000202\''
\set evVwr  '\'03840000-0000-0000-0000-000000000203\''
\set evDual '\'03840000-0000-0000-0000-000000000204\''
\set evB    '\'03840000-0000-0000-0000-000000000241\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,   '0384-own@test.local',   '{}'::jsonb),
  (:mgr,   '0384-mgr@test.local',   '{}'::jsonb),
  (:stf,   '0384-stf@test.local',   '{}'::jsonb),
  (:stfAp, '0384-stfap@test.local', '{}'::jsonb),
  (:vwr,   '0384-vwr@test.local',   '{}'::jsonb),
  (:dual,  '0384-dual@test.local',  '{}'::jsonb),
  (:mgrB,  '0384-mgrb@test.local',  '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug) values
  (:orgA, '0384 Link A', '0384-link-a'),
  (:orgB, '0384 Link B', '0384-link-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :stf,   'staff',   now()),
  (:orgA, :stfAp, 'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :dual,  'manager', now()),
  (:orgB, :dual,  'manager', now()),
  (:orgB, :mgrB,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA, :orgA, '0384 Main',  'WH-0384A', 'active'),
  (:whB, :orgB, '0384 Other', 'WH-0384B', 'active');
-- A delivery order carries a charter (order_requests_delivery_target_chk).
insert into public.charters (id, organization_id, name, code, status) values
  (:chA, :orgA, '0384 Charter', 'CH-0384', 'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,   :whA, true),
  (:orgA, :stfAp, :whA, true),
  (:orgA, :vwr,   :whA, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp, 'orders:approve', true);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, needed_by, delivery_charter_id) values
  (:ordEv,   :orgA, :whA, 'approved', 'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days', null),
  (:ordFree, :orgA, :whA, 'approved', 'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '4 days', null),
  (:ordNew,  :orgA, :whA, 'approved', 'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '5 days', null),
  (:ordDual, :orgA, :whA, 'approved', 'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '6 days', null),
  (:ordStg,  :orgA, :whA, 'staged_for_delivery', 'internal', :stf, 'delivery', date_trunc('minute', now()) + interval '8 days', :chA),
  (:ordPend, :orgA, :whA, 'pending_approval',    'internal', :stf, 'pickup',   date_trunc('minute', now()) + interval '9 days', null),
  (:ordPk,   :orgA, :whA, 'approved',            'internal', :stf, 'pickup',   date_trunc('minute', now()) + interval '10 days', null),
  (:ordPack, :orgA, :whA, 'picking_complete',    'internal', :stf, 'delivery', date_trunc('minute', now()) + interval '11 days', :chA),
  (:ordB,    :orgB, :whB, 'approved', 'internal', :mgrB, 'pickup',   date_trunc('minute', now()) + interval '3 days', null);
-- evOrd: ordEv's auto event, made by the admin path for the approving staff
-- member (stfAp, an orders:approve override), so its creator is staff.
-- evMan: a manual event by the manager. evVwr: a manual event by the viewer.
-- evDual: an order event (no warehouse) created for the two-org manager.
-- evB: an org B manual event.
insert into public.schedule_events
  (id, organization_id, title, starts_at, ends_at, warehouse_id, details, status, order_request_id,
   assigned_user_id, created_by, updated_by, reminded_24h_at, reminded_1h_at) values
  (:evOrd,  :orgA, 'SO-000384 delivery', date_trunc('minute', now()) + interval '3 days',
   date_trunc('minute', now()) + interval '3 days 1 hour', :whA,
   'Auto-created from order SO-000384. Needed by Oct 3, 2026, 2:00 PM.', 'scheduled', :ordEv,
   null, :stfAp, :stfAp, now() - interval '1 hour', null),
  (:evMan,  :orgA, 'Manual',  date_trunc('minute', now()) + interval '2 days', null, :whA, null, 'scheduled', null, null, :mgr,  :mgr,  null, null),
  (:evVwr,  :orgA, 'Viewer',  date_trunc('minute', now()) + interval '2 days', null, null, null, 'scheduled', null, null, :vwr,  :vwr,  null, null),
  (:evDual, :orgA, 'SO-000385 pickup', date_trunc('minute', now()) + interval '6 days', null, null,
   'Auto-created from order SO-000385. Needed by Oct 6, 2026, 2:00 PM.', 'scheduled', :ordDual, null, :dual, :dual, null, null),
  (:evB,    :orgB, 'Org B',   date_trunc('minute', now()) + interval '2 days', null, :whB, null, 'scheduled', null, null, :mgrB, :mgrB, null, null);

create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || ':' || v_msg;
end $$;
-- The answer of a statement that returns one value, or its error.
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'null');
exception when others then
  return 'error ' || sqlstate;
end $$;
-- Every fixture event's writable fields and row version (read as the
-- superuser, whoever asks).
create function pg_temp.state() returns text language sql security definer as $$
  select coalesce(string_agg(e.id::text || '/' || e.organization_id::text || '/' || coalesce(e.order_request_id::text, '-') || '/'
                             || coalesce(e.assigned_user_id::text, '-') || '/' || e.title || '/' || e.starts_at::text || '/'
                             || e.status || '/' || e.ctid::text, ',' order by e.id), '')
    from public.schedule_events e
   where e.organization_id in ('03840000-0000-0000-0000-00000000000a', '03840000-0000-0000-0000-00000000000b')
$$;
create temp table snap (k text primary key, v text);
insert into snap values ('before', pg_temp.state());
-- A statement's outcome, then undone whatever it did: its error, or 'no error'
-- when it went through (and was rolled back with its subtransaction). So a
-- write the schema wrongly allows cannot change what the later tests see.
create function pg_temp.try_undo(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
    raise exception using errcode = 'XX384', message = 'undo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  return case when v_state = 'XX384' then 'no error' else v_state || ':' || v_msg end;
end $$;
-- The fixture orders' organization and warehouse (read as the superuser,
-- whoever asks).
create function pg_temp.ostate() returns text language sql security definer as $$
  select coalesce(string_agg(o.id::text || '/' || o.organization_id::text || '/' || coalesce(o.warehouse_id::text, '-'),
                             ',' order by o.id), '')
    from public.order_requests o
   where o.id::text like '03840000-%'
$$;
insert into snap values ('orders', pg_temp.ostate());

-- A link or assignee write as SQL text.
create function pg_temp.ins_linked(p_org uuid, p_order uuid, p_creator uuid) returns text language sql as $$
  select format($q$insert into public.schedule_events (organization_id, title, starts_at, status, order_request_id, created_by, updated_by)
                   values (%L, 'linked', now() + interval '10 days', 'scheduled', %L, %L, %L)$q$, p_org, p_order, p_creator, p_creator)
$$;

-- ══ L. The link and the assignee: refused for every signed-in role ════════
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.err(pg_temp.ins_linked(:orgA, :ordFree, :vwr)), '42501:permission denied for table schedule_events',
  'L1 (V1): a viewer inserting an event linked to an approved order of their org: 42501 permission denied');
set local "request.jwt.claim.sub" to :stf;
select is(pg_temp.err(pg_temp.ins_linked(:orgA, :ordFree, :stf)), '42501:permission denied for table schedule_events',
  'L2: staff inserting a linked event: 42501 permission denied');
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.err(pg_temp.ins_linked(:orgA, :ordFree, :mgr)), '42501:permission denied for table schedule_events',
  'L3: a manager inserting a linked event: 42501 permission denied (only autoScheduleFromOrder links an event)');
set local "request.jwt.claim.sub" to :own;
select is(pg_temp.err(pg_temp.ins_linked(:orgA, :ordFree, :own)), '42501:permission denied for table schedule_events',
  'L4: the owner inserting a linked event: 42501 permission denied');
set local "request.jwt.claim.sub" to :mgrB;
select is(pg_temp.err(pg_temp.ins_linked(:orgB, :ordFree, :mgrB)), '42501:permission denied for table schedule_events',
  'L5 (P9): an org B manager linking an org B event to an org A order: 42501 permission denied');
select is(pg_temp.err(pg_temp.ins_linked(:orgB, :ordB, :mgrB)), '42501:permission denied for table schedule_events',
  'L6: an org B manager linking an event to an order of their own org: 42501 permission denied');
set local "request.jwt.claim.sub" to :stfAp;
select is(pg_temp.err(format('update public.schedule_events set order_request_id = %L where id = %L', :ordFree, :evOrd)),
  '42501:permission denied for table schedule_events',
  'L7 (V3): the creator of an order event re-linking it to another order: 42501 permission denied');
set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.err(format('update public.schedule_events set order_request_id = %L where id = %L', :ordFree, :evVwr)),
  '42501:permission denied for table schedule_events',
  'L8 (V3): a viewer linking their own manual event to an order: 42501 permission denied');
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.err(format('update public.schedule_events set order_request_id = null where id = %L', :evDual)),
  '42501:permission denied for table schedule_events',
  'L9: a manager clearing an order event''s link: 42501 permission denied');
set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.err(format($q$insert into public.schedule_events (organization_id, title, starts_at, status, assigned_user_id, created_by)
                                     values (%L, 'bait', now() + interval '20 hours', 'scheduled', %L, %L)$q$, :orgA, :mgrB, :vwr)),
  '42501:permission denied for table schedule_events',
  'L10 (A1): a viewer naming another org''s user as an event''s assignee (the reminder cron emails the assignee): 42501 permission denied');
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.err(format('update public.schedule_events set assigned_user_id = %L where id = %L', :vwr, :evMan)),
  '42501:permission denied for table schedule_events',
  'L11 (A1): a manager setting an assignee: 42501 permission denied (assignDelivery syncs it through the admin client)');
reset role;
set local role to 'anon';
set local "request.jwt.claim.role" to 'anon';
set local "request.jwt.claim.sub" to '';
select is(pg_temp.err(format($q$insert into public.schedule_events (organization_id, title, starts_at, status, created_by)
                                     values (%L, 'anon', now(), 'scheduled', %L)$q$, :orgA, :vwr)),
  '42501:permission denied for table schedule_events',
  'L12: anon inserting any event: 42501 permission denied (it held table INSERT, stopped only by RLS)');
reset role;
select is(pg_temp.state(), (select v from snap where k = 'before'), 'L13: none of L1 to L12 wrote anything');
-- The slot of ordFree is still free: the admin path creates its own event.
set local "request.jwt.claim.sub" to '';
set local role to 'service_role';
select is(pg_temp.err(pg_temp.ins_linked(:orgA, :ordFree, :stfAp)), 'no error',
  'L14 (P9): after every refused link, the admin path (autoScheduleFromOrder) still creates the order''s own event (no 23505)');
reset role;

-- ══ O. The organization of a linked order ═════════════════════════════════
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :dual;
set local role to 'authenticated';
select is(pg_temp.err(format('update public.schedule_events set organization_id = %L where id = %L', :orgB, :evDual)),
  '42501:new row violates row-level security policy for table "schedule_events"',
  'O1: a manager of both orgs moving a linked org A event to org B (its order stays in org A): 42501 row-level security');
select is(pg_temp.val(format('select public.order_request_in_org(null, %L)::text', :orgA)), 'true',
  'O2: order_request_in_org: no order is always true (null-safe, so a manual event passes)');
select is(pg_temp.val(format('select public.order_request_in_org(%L, %L)::text', :ordDual, :orgA)), 'true',
  'O3: order_request_in_org: an order of the org, asked by a member, is true');
select is(pg_temp.val(format('select public.order_request_in_org(%L, %L)::text', :ordDual, :orgB)), 'false',
  'O4: order_request_in_org: an order of another org is false');
set local "request.jwt.claim.sub" to :mgrB;
select is(pg_temp.val(format('select public.order_request_in_org(%L, %L)::text', :ordEv, :orgA)), 'false',
  'O5: order_request_in_org: false to a caller who is not a member of the org it names (no cross-org existence oracle)');
reset role;

-- ══ P. The order side of the link ═════════════════════════════════════════
-- order_requests_update checks the caller's rights in the old org (USING) and
-- in the new org (WITH CHECK), so a manager of both could move an order, and
-- an order with its org A event then sat in org B (review D1).
-- (L14 added ordFree's event, so the events are snapshotted again here.)
insert into snap values ('beforeP', pg_temp.state());
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :dual;
select is(pg_temp.try_undo(format('update public.order_requests set organization_id = %L, warehouse_id = %L where id = %L', :orgB, :whB, :ordDual)),
  '42501:permission denied for table order_requests',
  'P1 (D1): a manager of both orgs moving an org A order that has its org A event to org B: 42501 permission denied');
reset role;
select is(pg_temp.ostate() || '|' || pg_temp.state(), (select v from snap where k = 'orders') || '|' || (select v from snap where k = 'beforeP'),
  'P2: P1 changed no order and no event (the org A event stays linked to its org A order)');

-- ══ I. An event's identity ════════════════════════════════════════════════
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.try_undo(format('update public.schedule_events set id = gen_random_uuid() where id = %L', :evVwr)),
  '42501:permission denied for table schedule_events',
  'I1 (U4): a viewer re-keying their own event (detaching it from its audit rows and notification links): 42501 permission denied');
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.try_undo(format($q$update public.schedule_events set created_at = now() - interval '400 days' where id = %L$q$, :evMan)),
  '42501:permission denied for table schedule_events',
  'I2: an event''s creator backdating it: 42501 permission denied');
reset role;
select is(pg_temp.state(), (select v from snap where k = 'beforeP'), 'I3: neither I1 nor I2 changed an event');

-- ══ K. Legitimate flows ═══════════════════════════════════════════════════
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
-- The phone's New event (apps/mobile/app/schedule/new.tsx): no created_by
-- (the writer trigger fills it), no link.
set local "request.jwt.claim.sub" to :stf;
select is(pg_temp.err(format($q$insert into public.schedule_events (organization_id, title, starts_at, ends_at, all_day, location_text, warehouse_id, requester_name)
                               values (%L, 'Phone event', now() + interval '1 day', now() + interval '1 day 1 hour', false, 'Dock 2', %L, 'School')$q$, :orgA, :whA)),
  'no error', 'K1: staff inserting a manual event the phone''s way still works');
-- The Schedule page (ScheduleService.create), with its RETURNING read.
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.val(format($q$with ins as (
    insert into public.schedule_events (organization_id, title, starts_at, ends_at, all_day, location_text, warehouse_id, requester_name,
                                        details, status, bundle_id, bundle_quantity, bundle_warehouse_id, created_by, updated_by)
    values (%L, 'Page event', now() + interval '2 days', null, false, null, %L, null, 'notes', 'scheduled', null, null, null, %L, %L)
    returning id, organization_id, title, starts_at, ends_at, all_day, location_text, warehouse_id, requester_name, details, status,
              bundle_id, bundle_quantity, bundle_warehouse_id, order_request_id, created_by, updated_by, created_at, updated_at)
  select (count(*) = 1 and bool_and(order_request_id is null))::text from ins$q$, :orgA, :whA, :mgr, :mgr)),
  'true', 'K2: a manager creating an event the Schedule page''s way (every column it sends, RETURNING) still works');
set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.err(format($q$insert into public.schedule_events (organization_id, title, starts_at, created_by)
                               values (%L, 'Viewer manual', now() + interval '1 day', %L)$q$, :orgA, :vwr)),
  'no error', 'K3: a viewer''s manual event is unchanged by 0384 (the any-member insert rule stays as it was)');
-- The Schedule page's edit of the order's event by its creator (staff).
set local "request.jwt.claim.sub" to :stfAp;
select is(pg_temp.val(format($q$with up as (
    update public.schedule_events
       set title = 'SO-000384 delivery (moved)', starts_at = date_trunc('minute', now()) + interval '4 days',
           ends_at = date_trunc('minute', now()) + interval '4 days 2 hours', all_day = false, location_text = 'Gym',
           warehouse_id = %L, requester_name = 'School', details = 'Auto-created from order SO-000384. Needed by Oct 3, 2026, 2:00 PM. Gate code 12.',
           status = 'scheduled', bundle_id = null, bundle_quantity = null, bundle_warehouse_id = null,
           reminded_24h_at = null, reminded_1h_at = null, updated_by = %L
     where organization_id = %L and id = %L
     returning order_request_id, reminded_24h_at)
  select (count(*) = 1 and bool_and(order_request_id = %L) and bool_and(reminded_24h_at is null))::text from up$q$,
  :whA, :stfAp, :orgA, :evOrd, :ordEv)),
  'true', 'K4: the order event''s creator (staff) edits it the Schedule page''s way (start moved, both stamps cleared); the link is unchanged');
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.val(format($q$with up as (update public.schedule_events set status = 'in_progress', updated_by = %L
                                              where organization_id = %L and id = %L returning order_request_id)
                                select (count(*) = 1 and bool_and(order_request_id = %L))::text from up$q$, :mgr, :orgA, :evOrd, :ordEv)),
  'true', 'K5: a manager (not the creator) changes the order event''s status; the link is unchanged');
set local "request.jwt.claim.sub" to :own;
select is(pg_temp.val(format($q$with up as (update public.schedule_events set status = 'scheduled', details = 'Owner note', updated_by = %L
                                              where organization_id = %L and id = %L returning order_request_id)
                                select (count(*) = 1 and bool_and(order_request_id = %L))::text from up$q$, :own, :orgA, :evOrd, :ordEv)),
  'true', 'K6: the owner edits the order event; the link is unchanged');
set local "request.jwt.claim.sub" to :vwr;
select is(pg_temp.val(format($q$with up as (update public.schedule_events set title = 'hijack' where id = %L returning 1)
                                select count(*)::text from up$q$, :evOrd)),
  '0', 'K7: a viewer who neither created the order event nor manages still changes nothing (schedule_events_update, unchanged)');
select is(pg_temp.val(format($q$with d as (delete from public.schedule_events where id = %L returning 1) select count(*)::text from d$q$, :evVwr)),
  '1', 'K8: the creator deletes their own manual event (DELETE unchanged)');
reset role;
-- The order flows' admin client (service_role).
set local "request.jwt.claim.sub" to '';
set local role to 'service_role';
select is(pg_temp.err(format($q$insert into public.schedule_events (organization_id, title, starts_at, warehouse_id, requester_name, details, status,
                                                                  order_request_id, assigned_user_id, created_by)
                               values (%L, 'SO-000386 pickup', now() + interval '5 days', %L, null,
                                       'Auto-created from order SO-000386. Needed by Oct 5, 2026, 2:00 PM.', 'scheduled', %L, %L, %L)$q$,
                               :orgA, :whA, :ordNew, :stf, :mgr)),
  'no error', 'K9: autoScheduleFromOrder''s insert (admin client, with the link and the driver) still works');
select is(pg_temp.val(format($q$with up as (update public.schedule_events set assigned_user_id = %L where order_request_id = %L returning 1)
                                select count(*)::text from up$q$, :stf, :ordEv)),
  '1', 'K10: assignDelivery''s driver sync (admin client, keyed on the link) still works');
select is(pg_temp.val(format($q$with up as (update public.schedule_events
                                               set starts_at = date_trunc('minute', now()) + interval '5 days', ends_at = null,
                                                   details = 'Auto-created from order SO-000384. Needed by Oct 5, 2026, 2:00 PM.',
                                                   reminded_24h_at = null, reminded_1h_at = null, updated_by = %L
                                             where id = %L and status in ('scheduled', 'in_progress') returning 1)
                                select count(*)::text from up$q$, :mgr, :evOrd)),
  '1', 'K11: bringOrderEventInStep''s move (admin client) still works');
select is(pg_temp.val(format($q$with up as (update public.schedule_events set status = 'cancelled'
                                             where order_request_id = %L and status in ('scheduled', 'in_progress') returning 1)
                                select count(*)::text from up$q$, :ordNew)),
  '1', 'K12: syncOrderScheduleEvent''s close (admin client, keyed on the link) still works');
reset role;
-- The approver's revision (0383, SECURITY DEFINER) moves the order's event.
set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to :stfAp;
set local role to 'authenticated';
select is(pg_temp.val(format($q$select (r->>'eventUpdated') || '/' || (r->>'eventId')
                                  from public.revise_order_needed_by(%L, date_trunc('minute', now()) + interval '7 days',
                                         (select o.needed_by from public.order_requests o where o.id = %L), 'Moved by the school',
                                         'Auto-created from order SO-000384. Needed by Oct 7, 2026, 2:00 PM.') r$q$, :ordEv, :ordEv)),
  'true/' || :evOrd, 'K13: revise_order_needed_by (staff approver, 0383) still moves the order''s own event');
reset role;

-- Every order write the web makes through the user client, in the shape it
-- sends (services/order-requests.ts), with the RETURNING it reads.
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.val(format($q$with up as (
    update public.order_requests
       set assigned_delivery_user_id = %L, assigned_delivery_by = %L, assigned_delivery_at = now()
     where organization_id = %L and id = %L returning *)
  select (count(*) = 1 and bool_and(assigned_delivery_user_id = %L) and bool_and(organization_id = %L))::text from up$q$,
  :stf, :mgr, :orgA, :ordStg, :stf, :orgA)),
  'true', 'KO1: assignDelivery''s write (a manager names a member as the driver, RETURNING *) still works');
select is(pg_temp.val(format($q$with up as (update public.order_requests set internal_notes = 'Gate code 12'
                                              where organization_id = %L and id = %L returning id)
                                select count(*)::text from up$q$, :orgA, :ordPend)),
  '1', 'KO2: the internal-notes save (a manager) still works');
set local "request.jwt.claim.sub" to :stfAp;
select is(pg_temp.val(format($q$with up as (update public.order_requests set status = 'denied', denied_reason = 'Out of season'
                                              where organization_id = %L and id = %L and status = 'pending_approval' returning *)
                                select count(*)::text from up$q$, :orgA, :ordPend)),
  '1', 'KO3: deny (a staff approver, orders:approve) still works');
select is(pg_temp.val(format($q$with up as (update public.order_requests
                                               set status = 'pick_slip_generated', pick_slip_generated_at = now(), pick_slip_generated_by = %L
                                             where organization_id = %L and id = %L and status = 'approved' returning *)
                                select count(*)::text from up$q$, :stfAp, :orgA, :ordPk)),
  '1', 'KO4: the pick slip (a staff approver) still works');
set local "request.jwt.claim.sub" to :mgr;
select is(pg_temp.val(format($q$with up as (update public.order_requests
                                               set status = 'packing_slip_generated', packing_slip_generated_at = now(), packing_slip_generated_by = %L,
                                                   signature_token = md5('0384'), signature_token_expires_at = now() + interval '30 days'
                                             where organization_id = %L and id = %L returning *)
                                select count(*)::text from up$q$, :mgr, :orgA, :ordPack)),
  '1', 'KO5: the packing slip with its signature token (a manager) still works');
select is(pg_temp.val(format($q$with up as (update public.order_requests set status = 'staged_for_delivery', staged_at = now(), staged_by = %L
                                             where organization_id = %L and id = %L and status = 'packing_slip_generated' returning *)
                                select count(*)::text from up$q$, :mgr, :orgA, :ordPack)),
  '1', 'KO6: staging (a manager) still works');
select is(pg_temp.val(format($q$with up as (update public.order_requests set status = 'in_transit', in_transit_at = now(), in_transit_by = %L
                                             where organization_id = %L and id = %L and status = 'staged_for_delivery' returning *)
                                select count(*)::text from up$q$, :mgr, :orgA, :ordStg)),
  '1', 'KO7: in transit (a manager) still works');
reset role;

-- ══ G. The posture ════════════════════════════════════════════════════════
select is(
  (select coalesce(string_agg(a.attname || ':' || p, ',' order by a.attname, p), '')
     from pg_attribute a cross join unnest(array['INSERT', 'UPDATE']) p
    where a.attrelid = 'public.schedule_events'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attname not in ('order_request_id', 'assigned_user_id')
      and not (p = 'UPDATE' and a.attname in ('id', 'created_at'))
      and not has_column_privilege('authenticated', 'public.schedule_events', a.attname, p)),
  '',
  'G1: authenticated may INSERT every schedule_events column but the two server-owned ones, and UPDATE every column but those two, id and created_at (a NEW column must be granted here or added to a list)');
select is(
  (select string_agg(c || ':' || p || '=' || has_column_privilege('authenticated', 'public.schedule_events', c, p)::text, ',' order by c, p)
     from unnest(array['assigned_user_id', 'created_at', 'id', 'order_request_id']) c, unnest(array['INSERT', 'UPDATE']) p),
  'assigned_user_id:INSERT=false,assigned_user_id:UPDATE=false,created_at:INSERT=true,created_at:UPDATE=false,'
  'id:INSERT=true,id:UPDATE=false,order_request_id:INSERT=false,order_request_id:UPDATE=false',
  'G2: authenticated may neither INSERT nor UPDATE order_request_id or assigned_user_id, and may not UPDATE id or created_at (an insert may still name them, as before)');
select is(
  (select string_agg(p || '=' || has_table_privilege('authenticated', 'public.schedule_events', p)::text, ',' order by p)
     from unnest(array['DELETE', 'INSERT', 'SELECT', 'TRUNCATE', 'UPDATE']) p),
  'DELETE=true,INSERT=false,SELECT=true,TRUNCATE=false,UPDATE=false',
  'G3: authenticated holds no table-level INSERT, UPDATE or TRUNCATE, and keeps SELECT and DELETE');
select is(
  (select string_agg(p || '=' || has_any_column_privilege('anon', 'public.schedule_events', p)::text, ',' order by p)
     from unnest(array['INSERT', 'UPDATE']) p)
  || ',' ||
  (select string_agg(p || '=' || has_table_privilege('anon', 'public.schedule_events', p)::text, ',' order by p)
     from unnest(array['DELETE', 'TRUNCATE']) p),
  'INSERT=false,UPDATE=false,DELETE=false,TRUNCATE=false',
  'G4: anon writes nothing (it had table INSERT/UPDATE/DELETE/TRUNCATE with no policy)');
select is(
  (select string_agg(p || '=' || has_table_privilege('service_role', 'public.schedule_events', p)::text, ',' order by p)
     from unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p),
  'DELETE=true,INSERT=true,SELECT=true,UPDATE=true',
  'G5: service_role (the order flows'' admin client and the reminder cron) keeps its table grants');
select ok(
  has_column_privilege('authenticated', 'public.schedule_events', 'starts_at', 'UPDATE')
  and has_column_privilege('authenticated', 'public.schedule_events', 'reminded_24h_at', 'UPDATE')
  and has_column_privilege('authenticated', 'public.schedule_events', 'reminded_1h_at', 'UPDATE')
  and has_column_privilege('authenticated', 'public.schedule_events', 'updated_by', 'UPDATE'),
  'G6: the Schedule page''s re-arm (ScheduleService.update clears both stamps when it moves a start) keeps its column grants (0383 Z3)');
select is(
  (select coalesce(md5(p.prosrc) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|'
                   || has_function_privilege('authenticated', p.oid, 'execute')::text || '|'
                   || has_function_privilege('anon', p.oid, 'execute')::text || '|'
                   || coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a)::text, 'false'), 'missing')
     from pg_proc p where p.oid = to_regprocedure('public.order_request_in_org(uuid,uuid)')),
  '4d88c3f9eef0c34cece9d2d5bdd46b5f|true|s|{search_path=public}|true|false|false',
  'G7: the policies'' predicate is 0362''s order_request_in_org, unchanged (body md5, SECURITY DEFINER, STABLE, search_path pinned, EXECUTE to authenticated, not anon or PUBLIC)');
select is(
  (select string_agg(pol.polname || ' ' || pol.polcmd::text || ' ' || pol.polroles::regrole[]::text || E'\n  USING '
                     || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') || E'\n  CHECK '
                     || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'), E'\n' order by pol.polname)
     from pg_policy pol where pol.polrelid = 'public.schedule_events'::regclass),
  E'schedule_events_delete d {authenticated}\n'
  '  USING (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND ((created_by = auth.uid()) OR ( SELECT has_org_role(schedule_events.organization_id, ''manager''::text) AS has_org_role)))\n'
  '  CHECK -\n'
  'schedule_events_insert a {authenticated}\n'
  '  USING -\n'
  '  CHECK (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND (created_by = auth.uid()) AND ((warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, ''write''::text)) AND ( SELECT warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org) AND ( SELECT order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org))\n'
  'schedule_events_select r {authenticated}\n'
  '  USING (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND ((warehouse_id IS NULL) OR user_can_access_warehouse(auth.uid(), warehouse_id, ''read''::text)))\n'
  '  CHECK -\n'
  'schedule_events_update w {authenticated}\n'
  '  USING (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND ((created_by = auth.uid()) OR ( SELECT has_org_role(schedule_events.organization_id, ''manager''::text) AS has_org_role)))\n'
  '  CHECK (( SELECT is_org_member(schedule_events.organization_id) AS is_org_member) AND ((created_by = auth.uid()) OR ( SELECT has_org_role(schedule_events.organization_id, ''manager''::text) AS has_org_role)) AND ( SELECT warehouse_in_org(schedule_events.warehouse_id, schedule_events.organization_id) AS warehouse_in_org) AND ( SELECT warehouse_in_org(schedule_events.bundle_warehouse_id, schedule_events.organization_id) AS warehouse_in_org) AND ( SELECT order_request_in_org(schedule_events.order_request_id, schedule_events.organization_id) AS order_request_in_org))',
  'G8: the four schedule_events policies are exactly 0384''s: insert and update WITH CHECK gain order_request_in_org and keep every earlier term; USING, select and delete unchanged');
select is(
  (select string_agg(c || ':' || coalesce(col_description('public.schedule_events'::regclass, a.attnum) ~ 'server', false)::text, ',' order by c)
     from unnest(array['assigned_user_id', 'order_request_id']) c
     join pg_attribute a on a.attrelid = 'public.schedule_events'::regclass and a.attname = c),
  'assigned_user_id:true,order_request_id:true',
  'G9: both server-owned columns say so in their column comments');
-- Re-pinned by 0387 (was: every column but organization_id updatable, the
-- query excluding organization_id and expecting ''): 0387 revokes UPDATE on
-- the 21 columns only the order RPCs or the admin client write and on the 17
-- no user-client path writes (owner decision O5), so the columns
-- authenticated may NOT update are now organization_id plus those 38. The
-- web's user-client order writes (KO1-KO7 above) name none of them;
-- created_at and warehouse_id (owner Q4) and delivery_charter_id (owner Q7)
-- stay updatable. 0387's pgTAP A8 writes each of the 38 and A9d pins the 19
-- that remain.
select is(
  (select coalesce(string_agg(a.attname, ',' order by a.attname), '')
     from pg_attribute a
    where a.attrelid = 'public.order_requests'::regclass and a.attnum > 0 and not a.attisdropped
      and not has_column_privilege('authenticated', 'public.order_requests', a.attname, 'UPDATE')),
  'approved_at,approved_by,assigned_picker_id,cancelled_at,cancelled_by,completed_at,completed_by,'
  'confirmation_token_expires_at,confirmation_token_hash,customer_id,delivered_at,fulfillment_type,id,needed_by,notes,'
  'order_number,organization_id,packaging_at,picking_claimed_at,picking_claimed_by,picking_completed_at,'
  'picking_completed_by,pickup_location_notes,public_track_token,ready_at,requester_email,requester_name,'
  'requester_org_label,requester_phone,requester_user_id,return_prompt_sent_at,return_token,signature_data_url,'
  'signature_method,signed_at,signed_by_email,signed_by_name,source,updated_at',
  'GO1: authenticated may UPDATE every order_requests column but organization_id and the 38 columns 0387 revokes (created_at and warehouse_id included: owner Q4; a NEW column the app writes must be granted in its migration, and this fails until it is)');
select is(
  'organization_id=' || has_column_privilege('authenticated', 'public.order_requests', 'organization_id', 'UPDATE')::text
  || ',' ||
  (select string_agg(p || '=' || has_table_privilege('authenticated', 'public.order_requests', p)::text, ',' order by p)
     from unnest(array['INSERT', 'SELECT', 'UPDATE']) p),
  'organization_id=false,INSERT=true,SELECT=true,UPDATE=false',
  'GO2: authenticated may not UPDATE an order''s organization_id, holds no table-level UPDATE, and keeps table INSERT and SELECT');
select is(
  (select string_agg(p || '=' || has_table_privilege('service_role', 'public.order_requests', p)::text, ',' order by p)
     from unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p),
  'DELETE=true,INSERT=true,SELECT=true,UPDATE=true',
  'GO3: service_role (the admin client: the public order link, the portal, the return prompt) keeps its order_requests table grants');
select ok(
  coalesce(col_description('public.order_requests'::regclass,
             (select a.attnum from pg_attribute a where a.attrelid = 'public.order_requests'::regclass and a.attname = 'organization_id'))
           ~ '0384', false),
  'GO4: order_requests.organization_id says in its comment that a signed-in caller cannot change it (0384)');

select * from finish();
rollback;
