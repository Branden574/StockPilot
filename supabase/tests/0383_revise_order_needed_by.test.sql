-- supabase/tests/0383_revise_order_needed_by.test.sql
-- pgTAP proof for migration 0383 (F2-4: revise_order_needed_by).
--
-- G. Grants and gates: SECURITY DEFINER, VOLATILE, search_path and
--    lock_timeout pinned, EXECUTE to authenticated only (not anon,
--    service_role or PUBLIC), gated in its own body, refusing only with
--    42501, P0001, P0002 or 22023, never 40001/40P01, and writing only the
--    order's needed-by and its event. Signed out: 42501. A non-member,
--    another org's manager, a random or null id and a disabled member: the
--    SAME P0002. Orders module off: P0001 module_disabled. A viewer and staff
--    without orders:approve: 42501 (hint orders_approve). An orders:approve
--    override without write access to the order's warehouse (staff assigned
--    to another warehouse; a viewer): 42501 (hint warehouse_write). Staff WITH
--    an orders:approve override in the order's warehouse SUCCEED (pattern #4:
--    schedule_events_update alone would refuse them the event), as do a
--    manager, a manager whose orders:approve was revoked, a manager whose
--    only assignment row is another warehouse (the database, like the app,
--    gives managers every warehouse: there is no warehouse-scoped manager),
--    an admin and the owner. No refusal writes anything.
-- S. Status: pending_confirmation, completed, denied and cancelled give P0001
--    order_closed with the status as its detail, and write nothing; every
--    open status is answered.
-- A. Arguments: a needed-by now or in the past (22023 needed_by_in_past), a
--    null one (22023 needed_by_required), infinity or later than five years
--    from now (22023 needed_by_out_of_range; just inside five years is
--    accepted), a reason empty, blank or over 500
--    characters (22023 reason_required; 500 is accepted); the stale version
--    (P0001 needed_by_changed, detail = the current value as ISO 8601, '' for
--    none), in both directions (expected null when set, expected a value
--    when none).
-- E. The event: starts_at, details and ends_at (shifted, keeping the
--    duration) move, BOTH reminder stamps are cleared (mutation: keep
--    reminded_24h_at), updated_by is the caller, its status stays; an
--    in-progress event moves too; a completed or cancelled event is untouched;
--    an order without an event changes only the order (no event is created
--    here); an equal value writes nothing (no new row version of the order or
--    the event); the answer is exactly {changed, previous, neededBy, eventId,
--    eventUpdated, eventStatus, status}; the order's status never changes and
--    no notification row is written. THE DESCRIPTION: only core's own
--    sentence is taken ("Auto-created from order SO-…. Needed by …."; control
--    characters stripped first), and only that sentence in the event's
--    description is replaced: a line someone added on the Schedule page is
--    kept (mutation: overwrite the whole description), the sentence is
--    swapped where it sits (the old numeric format included), a description
--    rewritten by hand with no such sentence is kept whole, an empty one gets
--    the sentence, and a description that is not core's sentence (any other
--    text) is ignored; a null one keeps the event's.
-- Z. The frozen objects: md5, SECURITY DEFINER, search_path and owner of the
--    functions F2-4 promises not to touch, fingerprints of ledger.*, the 0380
--    report functions, the 0381 photo functions and policies, the 0382 book
--    functions, the
--    order_requests and schedule_events policies, and the column grants the
--    Schedule page's re-arm (ScheduleService.update) relies on.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt); the function runs as `authenticated` with request.jwt.claim.sub.
-- begin/rollback: nothing leaks. Namespace 03830000. The two-session race
-- (exactly one of two revisions with the same expected value wins) is
-- scripts/db-concurrency/0383_needed_by_race.sh.

begin;

select plan(46);

\set orgA    '\'03830000-0000-0000-0000-00000000000a\''
\set orgB    '\'03830000-0000-0000-0000-00000000000b\''
\set own     '\'03830000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03830000-0000-0000-0000-0000000000a1\''
\set mgrNo   '\'03830000-0000-0000-0000-0000000000a2\''
\set stf     '\'03830000-0000-0000-0000-0000000000a3\''
\set stfAp   '\'03830000-0000-0000-0000-0000000000a4\''
\set stfApX  '\'03830000-0000-0000-0000-0000000000a5\''
\set vwr     '\'03830000-0000-0000-0000-0000000000a6\''
\set vwrAp   '\'03830000-0000-0000-0000-0000000000a7\''
\set dis     '\'03830000-0000-0000-0000-0000000000a8\''
\set adm     '\'03830000-0000-0000-0000-0000000000a9\''
\set mgrX    '\'03830000-0000-0000-0000-0000000000aa\''
\set mgrB    '\'03830000-0000-0000-0000-0000000000b1\''
\set nobody  '\'03830000-0000-0000-0000-0000000000c1\''
\set whA     '\'03830000-0000-0000-0000-0000000000d1\''
\set whA2    '\'03830000-0000-0000-0000-0000000000d2\''
\set whB     '\'03830000-0000-0000-0000-0000000000d3\''
\set ordAppr '\'03830000-0000-0000-0000-000000000101\''
\set ordPend '\'03830000-0000-0000-0000-000000000102\''
\set ordPip  '\'03830000-0000-0000-0000-000000000103\''
\set ordDone '\'03830000-0000-0000-0000-000000000104\''
\set ordCanc '\'03830000-0000-0000-0000-000000000105\''
\set ordNoEv '\'03830000-0000-0000-0000-000000000106\''
\set ordNull '\'03830000-0000-0000-0000-000000000107\''
\set ordGate '\'03830000-0000-0000-0000-000000000108\''
\set ordEq   '\'03830000-0000-0000-0000-000000000109\''
\set ordArg  '\'03830000-0000-0000-0000-00000000010a\''
\set ordTxt  '\'03830000-0000-0000-0000-00000000010b\''
\set ordB    '\'03830000-0000-0000-0000-000000000141\''
\set evAppr  '\'03830000-0000-0000-0000-000000000201\''
\set evPip   '\'03830000-0000-0000-0000-000000000203\''
\set evDone  '\'03830000-0000-0000-0000-000000000204\''
\set evCanc  '\'03830000-0000-0000-0000-000000000205\''
\set evGate  '\'03830000-0000-0000-0000-000000000208\''
\set evEq    '\'03830000-0000-0000-0000-000000000209\''
\set evTxt   '\'03830000-0000-0000-0000-00000000020b\''
\set sent    '\'Auto-created from order SO-000383. Needed by Oct 9, 2026, 2:00 PM.\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0383-own@test.local',    '{}'::jsonb),
  (:adm,    '0383-adm@test.local',    '{}'::jsonb),
  (:mgr,    '0383-mgr@test.local',    '{}'::jsonb),
  (:mgrNo,  '0383-mgrno@test.local',  '{}'::jsonb),
  (:mgrX,   '0383-mgrx@test.local',   '{}'::jsonb),
  (:stf,    '0383-stf@test.local',    '{}'::jsonb),
  (:stfAp,  '0383-stfap@test.local',  '{}'::jsonb),
  (:stfApX, '0383-stfapx@test.local', '{}'::jsonb),
  (:vwr,    '0383-vwr@test.local',    '{}'::jsonb),
  (:vwrAp,  '0383-vwrap@test.local',  '{}'::jsonb),
  (:dis,    '0383-dis@test.local',    '{}'::jsonb),
  (:mgrB,   '0383-mgrb@test.local',   '{}'::jsonb),
  (:nobody, '0383-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0383 Needed-by A', '0383-needed-by-a'),
  (:orgB, '0383 Needed-by B', '0383-needed-by-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,    'owner',   now()),
  (:orgA, :adm,    'admin',   now()),
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :mgrNo,  'manager', now()),
  (:orgA, :mgrX,   'manager', now()),
  (:orgA, :stf,    'staff',   now()),
  (:orgA, :stfAp,  'staff',   now()),
  (:orgA, :stfApX, 'staff',   now()),
  (:orgA, :vwr,    'viewer',  now()),
  (:orgA, :vwrAp,  'viewer',  now()),
  (:orgA, :dis,    'staff',   now()),
  (:orgB, :mgrB,   'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0383 Main',  'WH-0383A',  'active'),
  (:whA2, :orgA, '0383 Annex', 'WH-0383A2', 'active'),
  (:whB,  :orgB, '0383 Other', 'WH-0383B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,    :whA,  true),
  (:orgA, :stfAp,  :whA,  true),
  (:orgA, :stfApX, :whA2, true),
  (:orgA, :vwr,    :whA,  true),
  (:orgA, :vwrAp,  :whA,  true),
  (:orgA, :dis,    :whA,  true),
  -- A manager whose only assignment row is the annex (G13).
  (:orgA, :mgrX,   :whA2, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp,  'orders:approve', true),
  (:orgA, :stfApX, 'orders:approve', true),
  (:orgA, :vwrAp,  'orders:approve', true),
  (:orgA, :dis,    'orders:approve', true),
  -- A manager whose orders:approve was revoked still approves (0348 keeps the
  -- has_org_role term), so they may still change the date.
  (:orgA, :mgrNo,  'orders:approve', false);

-- Orders. Every open one has a needed-by 3 days out, except ordNull (none).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, needed_by) values
  (:ordAppr, :orgA, :whA, 'approved',            'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordPend, :orgA, :whA, 'pending_approval',    'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordPip,  :orgA, :whA, 'picking_in_progress', 'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordDone, :orgA, :whA, 'approved',            'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordCanc, :orgA, :whA, 'backordered',         'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordNoEv, :orgA, :whA, 'approved',            'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordNull, :orgA, :whA, 'pending_approval',    'internal', :stf,  'pickup',   null),
  (:ordGate, :orgA, :whA, 'approved',            'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordEq,   :orgA, :whA, 'staged_for_pickup',   'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordArg,  :orgA, :whA, 'approved',            'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordTxt,  :orgA, :whA, 'approved',            'internal', :stf,  'pickup',   date_trunc('minute', now()) + interval '3 days'),
  (:ordB,    :orgB, :whB, 'approved',            'internal', :mgrB, 'pickup',   date_trunc('minute', now()) + interval '3 days');
-- One order per closed status (S1) and per remaining open status (S4).
create temp table st_order (status text primary key, id uuid not null, closed boolean not null);
insert into st_order (status, id, closed) values
  ('pending_confirmation',   '03830000-0000-0000-0000-000000000111', true),
  ('completed',              '03830000-0000-0000-0000-000000000112', true),
  ('denied',                 '03830000-0000-0000-0000-000000000113', true),
  ('cancelled',              '03830000-0000-0000-0000-000000000114', true),
  ('pick_slip_generated',    '03830000-0000-0000-0000-000000000121', false),
  ('picking_complete',       '03830000-0000-0000-0000-000000000122', false),
  ('packing_slip_generated', '03830000-0000-0000-0000-000000000123', false),
  ('staged_for_delivery',    '03830000-0000-0000-0000-000000000124', false),
  ('in_transit',             '03830000-0000-0000-0000-000000000125', false);
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, needed_by)
select s.id, :orgA, :whA, s.status, 'internal', :stf, 'pickup', date_trunc('minute', now()) + interval '3 days'
  from st_order s;

-- Events: ordAppr's is scheduled, was reminded a day ahead AND an hour ahead
-- (both stamps set), lasts an hour, and carries the old description.
insert into public.schedule_events
  (id, organization_id, title, starts_at, ends_at, warehouse_id, details, status, order_request_id,
   created_by, updated_by, reminded_24h_at, reminded_1h_at) values
  (:evAppr, :orgA, 'SO appr pickup', date_trunc('minute', now()) + interval '3 days',
   date_trunc('minute', now()) + interval '3 days 1 hour', :whA,
   'Auto-created from order SO-APPR. Needed by the old date.', 'scheduled', :ordAppr, :mgr, :mgr,
   now() - interval '2 hours', now() - interval '1 hour'),
  (:evPip,  :orgA, 'SO pip pickup',  date_trunc('minute', now()) + interval '3 days', null, :whA,
   'old pip', 'in_progress', :ordPip, :mgr, :mgr, now() - interval '2 hours', null),
  (:evDone, :orgA, 'SO done pickup', date_trunc('minute', now()) + interval '3 days', null, :whA,
   'old done', 'completed', :ordDone, :mgr, :mgr, now() - interval '2 hours', null),
  (:evCanc, :orgA, 'SO canc pickup', date_trunc('minute', now()) + interval '3 days', null, :whA,
   'old canc', 'cancelled', :ordCanc, :mgr, :mgr, now() - interval '2 hours', null),
  (:evGate, :orgA, 'SO gate pickup', date_trunc('minute', now()) + interval '3 days', null, :whA,
   'old gate', 'scheduled', :ordGate, :mgr, :mgr, now() - interval '2 hours', null),
  (:evEq,   :orgA, 'SO eq pickup',   date_trunc('minute', now()) + interval '3 days', null, :whA,
   'old eq', 'scheduled', :ordEq, :mgr, :mgr, now() - interval '2 hours', now() - interval '1 hour'),
  (:evTxt,  :orgA, 'SO txt pickup',  date_trunc('minute', now()) + interval '3 days', null, :whA,
   'Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM.', 'scheduled', :ordTxt, :mgr, :mgr, null, null);

-- The disabled member, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
  return v_state || ':' || coalesce(v_hint, '') || ':' || v_msg;
end $$;
create function pg_temp.err_detail(p_sql text) returns text language plpgsql as $$
declare v_detail text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return v_detail;
end $$;
-- A revision call as SQL text: the order, the new value, the expected value
-- (each an SQL expression), the reason and the description.
create function pg_temp.rev(p_order uuid, p_new text, p_expected text, p_reason text default 'Moved by the school',
                            p_details text default 'Auto-created from order SO-000383. Needed by the new date.')
returns text language sql as $$
  select format('select public.revise_order_needed_by(%L, %s, %s, %L, %L)',
                p_order, p_new, p_expected, p_reason, p_details)
$$;
-- The needed-by the fixture orders have now, as an SQL expression. Read as
-- the test superuser (SECURITY DEFINER) whoever calls it, so a caller the
-- order is hidden from still sends a well-formed call.
create function pg_temp.cur(p_order uuid) returns text language sql security definer as $$
  select coalesce(quote_literal(o.needed_by::text) || '::timestamptz', 'null::timestamptz')
    from public.order_requests o where o.id = p_order
$$;
-- Every fixture order's needed-by, status and row version, and every
-- fixture event's writable fields and row version, as a fingerprint.
create function pg_temp.state() returns text language sql as $$
  select coalesce((select string_agg(o.id::text || '/' || coalesce(o.needed_by::text, '-') || '/' || o.status || '/' || o.ctid::text,
                                     ',' order by o.id)
                     from public.order_requests o where o.organization_id in ('03830000-0000-0000-0000-00000000000a', '03830000-0000-0000-0000-00000000000b')), '')
      || ' | ' ||
         coalesce((select string_agg(e.id::text || '/' || e.starts_at::text || '/' || coalesce(e.ends_at::text, '-') || '/'
                                     || coalesce(e.details, '-') || '/' || e.status || '/'
                                     || coalesce(e.reminded_24h_at::text, '-') || '/' || coalesce(e.reminded_1h_at::text, '-')
                                     || '/' || e.ctid::text, ',' order by e.id)
                     from public.schedule_events e where e.organization_id in ('03830000-0000-0000-0000-00000000000a', '03830000-0000-0000-0000-00000000000b')), '')
$$;
create function pg_temp.notes() returns int language sql as $$
  select count(*)::int from public.notifications
   where organization_id in ('03830000-0000-0000-0000-00000000000a', '03830000-0000-0000-0000-00000000000b')
$$;

create temp table fx (who text not null, r text);
create temp table ans (who text primary key, r jsonb);
grant all on fx, ans to authenticated;
grant select on st_order to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.schedule_events where organization_id = '03830000-0000-0000-0000-00000000000a') <> 7 then
    raise exception 'fixture: events';
  end if;
  if (select count(*) from st_order s join public.order_requests o on o.id = s.id and o.status = s.status) <> 9 then
    raise exception 'fixture: status orders';
  end if;
end $$;

select pg_temp.notes() as "notes0" \gset

-- ═══ G. Structure, grants and gates ═══════════════════════════════════════
select ok(
  (select p.prosecdef and p.provolatile = 'v'
          and p.proconfig @> array['search_path=public, pg_temp', 'lock_timeout=5s']
     from pg_proc p where p.oid = 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, unnest(p.proacl) a
                   where p.oid = 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)'::regprocedure
                     and a::text like '=%'),
  'G1: revise_order_needed_by is SECURITY DEFINER, VOLATILE, search_path public, pg_temp and lock_timeout 5s pinned; EXECUTE to authenticated only (not anon, service_role or PUBLIC)');
select ok(
  (select p.prosrc ~ 'auth\.uid\(\)' and p.prosrc ~ 'is_org_member\(v_org\)'
          and p.prosrc ~ $re$module_enabled\(v_org, 'orders'\)$re$
          and p.prosrc ~ $re$has_org_role\(v_org, 'manager'\)$re$
          and p.prosrc ~ $re$has_permission\(v_org, 'orders:approve'\)$re$
          and p.prosrc ~ $re$user_can_access_inventory\(v_uid, v_wh, null, 'write'\)$re$
          and p.prosrc ~ 'where o\.id = p_id\s+for update;'
          and p.prosrc !~ '40001|40P01'
     from pg_proc p where p.oid = 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)'::regprocedure),
  'G2: its gates are in its own body (signed in, member, the orders module, the 0348 approve gate, warehouse write), it locks the order FOR UPDATE, and it never raises 40001/40P01');
select is(
  (select array_agg(distinct m[1] order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)'::regprocedure),
  array['22023', '42501', 'P0001', 'P0002'],
  'G3: it refuses only with 22023, 42501, P0001 or P0002');
select ok(
  (select (select count(*) from regexp_matches(p.prosrc, '\mupdate\s+public\.order_requests\s+set\s+needed_by\s*=\s*p_needed_by\s+where\s+id\s*=\s*p_id;', 'gi')) = 1
          and (select count(*) from regexp_matches(p.prosrc, '\mupdate\s+public\.schedule_events\M', 'gi')) = 1
          and (select count(*) from regexp_matches(p.prosrc, '\mupdate\s+public\.', 'gi')) = 2
          and p.prosrc !~* '\m(insert\s+into|delete\s+from|truncate|merge\s+into)\M'
          and p.prosrc !~* '\mstatus\s*='
          and p.prosrc !~* 'notifications|audit_logs|outbox'
     from pg_proc p where p.oid = 'public.revise_order_needed_by(uuid, timestamptz, timestamptz, text, text)'::regprocedure),
  'G4: it writes the order''s needed-by and its event and nothing else: no INSERT (it never creates an event), no DELETE, no status, no notification, audit or outbox row');

select pg_temp.state() as "state0" \gset

set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '';
set local role to 'authenticated';
select is(
  pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr))),
  '42501::unauthenticated',
  'G5: no signed-in caller: 42501 unauthenticated');
reset role;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :nobody;
insert into fx select 'nobody', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
set local "request.jwt.claim.sub" to :mgrB;
insert into fx select 'mgrB', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'random', pg_temp.err(pg_temp.rev(gen_random_uuid(), $$now() + interval '5 days'$$, 'null'));
insert into fx select 'null', pg_temp.err($$select public.revise_order_needed_by(null, now() + interval '5 days', null, 'r', null)$$);
set local "request.jwt.claim.sub" to :dis;
insert into fx select 'disabled', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
reset role;
select is(
  (select array_agg(distinct r) from fx where who in ('nobody', 'mgrB', 'random', 'null', 'disabled')),
  array['P0002::order_request_not_found'],
  'G6: a non-member, another org''s manager, a random id, a null id and a disabled member (with an orders:approve override) all get the SAME P0002 order_request_not_found');
delete from fx;

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
select is(
  pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr))),
  'P0001:module_disabled:module_disabled',
  'G7: the orders module off: P0001 module_disabled');
reset role;
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :vwr;
insert into fx select 'vwr', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
set local "request.jwt.claim.sub" to :stf;
insert into fx select 'stf (the requester)', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
set local "request.jwt.claim.sub" to :stfApX;
insert into fx select 'stfApX', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
set local "request.jwt.claim.sub" to :vwrAp;
insert into fx select 'vwrAp', pg_temp.err(pg_temp.rev(:ordAppr, $$now() + interval '5 days'$$, pg_temp.cur(:ordAppr)));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who in ('vwr', 'stf (the requester)')),
  'stf (the requester)=42501:orders_approve:forbidden, vwr=42501:orders_approve:forbidden',
  'G8: a viewer and the order''s own requester (staff without orders:approve) get 42501 forbidden (hint orders_approve)');
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who in ('stfApX', 'vwrAp')),
  'stfApX=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden',
  'G9: an orders:approve override without write access to the order''s warehouse (staff assigned to another warehouse; a viewer, who never writes) gets 42501 forbidden (hint warehouse_write)');
delete from fx;
select is(pg_temp.state(), :'state0',
  'G10: no refusal wrote anything (every order''s needed-by and row version, every event unchanged)');

-- Success: staff with an orders:approve override in the order's warehouse.
-- schedule_events_update (creator or manager) would refuse them the event;
-- the function moves it (pattern #4).
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :stfAp;
insert into ans select 'stfAp', public.revise_order_needed_by(
  :ordGate, date_trunc('minute', now()) + interval '4 days',
  (select needed_by from public.order_requests where id = :ordGate), 'Gate proof', 'gate details');
reset role;
select is(
  (select jsonb_build_object('changed', r->'changed', 'eventUpdated', r->'eventUpdated',
                             'starts', (select e.starts_at = date_trunc('minute', now()) + interval '4 days' and e.updated_by = :stfAp
                                          from public.schedule_events e where e.id = :evGate))
     from ans where who = 'stfAp'),
  jsonb_build_object('changed', true, 'eventUpdated', true, 'starts', true),
  'G11: staff WITH an orders:approve override in the order''s warehouse change the date and the event moves (updated_by = them)');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'mgr', pg_temp.err(pg_temp.rev(:ordGate, $$date_trunc('minute', now()) + interval '5 days'$$, pg_temp.cur(:ordGate)));
set local "request.jwt.claim.sub" to :mgrNo;
insert into fx select 'mgrNo', pg_temp.err(pg_temp.rev(:ordGate, $$date_trunc('minute', now()) + interval '6 days'$$, pg_temp.cur(:ordGate)));
set local "request.jwt.claim.sub" to :mgrX;
insert into fx select 'mgrX', pg_temp.err(pg_temp.rev(:ordGate, $$date_trunc('minute', now()) + interval '7 days'$$, pg_temp.cur(:ordGate)));
set local "request.jwt.claim.sub" to :adm;
insert into fx select 'adm', pg_temp.err(pg_temp.rev(:ordGate, $$date_trunc('minute', now()) + interval '8 days'$$, pg_temp.cur(:ordGate)));
set local "request.jwt.claim.sub" to :own;
insert into fx select 'own', pg_temp.err(pg_temp.rev(:ordGate, $$date_trunc('minute', now()) + interval '9 days'$$, pg_temp.cur(:ordGate)));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'adm=no error, mgr=no error, mgrNo=no error, mgrX=no error, own=no error',
  'G12: a manager, a manager whose orders:approve was revoked (the 0348 has_org_role term), a manager whose only assignment row is another warehouse (managers write every warehouse), an admin and the owner are answered');
select is(
  (select needed_by from public.order_requests where id = :ordGate),
  date_trunc('minute', now()) + interval '9 days',
  'G13: and each of them moved the date in turn (the last one stands)');
delete from fx;

-- ═══ S. Status ═══════════════════════════════════════════════════════════
select pg_temp.state() as "state1" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select s.status, pg_temp.err(pg_temp.rev(s.id, $$now() + interval '5 days'$$, pg_temp.cur(s.id)))
  from st_order s where s.closed;
insert into fx select 'detail:' || s.status, pg_temp.err_detail(pg_temp.rev(s.id, $$now() + interval '5 days'$$, pg_temp.cur(s.id)))
  from st_order s where s.closed;
reset role;
select is(
  (select string_agg(who, ', ' order by who) from fx
    where who not like 'detail:%' and r = 'P0001:order_closed:order_closed'),
  'cancelled, completed, denied, pending_confirmation',
  'S1: a closed order (completed, denied, cancelled, and a public request not yet confirmed) gives P0001 order_closed');
select is(
  (select count(*)::int from fx f join st_order s on f.who = 'detail:' || s.status where f.r = s.status),
  4,
  'S2: its detail names the status');
select is(pg_temp.state(), :'state1',
  'S3: and nothing was written');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select s.status, pg_temp.err(pg_temp.rev(s.id, $$now() + interval '5 days'$$, pg_temp.cur(s.id)))
  from st_order s where not s.closed;
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'in_transit=no error, packing_slip_generated=no error, pick_slip_generated=no error, picking_complete=no error, staged_for_delivery=no error',
  'S4: every open status is answered (pending, approved, picking, staged, backordered: E1-E5; the rest here)');
delete from fx;

-- ═══ A. Arguments ═══════════════════════════════════════════════════════
select pg_temp.state() as "state2" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'past', pg_temp.err(pg_temp.rev(:ordArg, $$now() - interval '1 minute'$$, pg_temp.cur(:ordArg)));
insert into fx select 'now', pg_temp.err(pg_temp.rev(:ordArg, 'now()', pg_temp.cur(:ordArg)));
insert into fx select 'null', pg_temp.err(pg_temp.rev(:ordArg, 'null', pg_temp.cur(:ordArg)));
insert into fx select 'empty reason', pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, pg_temp.cur(:ordArg), ''));
insert into fx select 'blank reason', pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, pg_temp.cur(:ordArg), E'  \t\n '));
insert into fx select 'null reason', pg_temp.err(format('select public.revise_order_needed_by(%L, now() + interval ''5 days'', %s, null, null)', :ordArg, pg_temp.cur(:ordArg)));
insert into fx select 'long reason', pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, pg_temp.cur(:ordArg), repeat('x', 501)));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'blank reason=22023:reason_required:reason_required, empty reason=22023:reason_required:reason_required, '
  'long reason=22023:reason_required:reason_required, now=22023:needed_by_in_past:needed_by_in_past, '
  'null=22023:needed_by_required:needed_by_required, null reason=22023:reason_required:reason_required, '
  'past=22023:needed_by_in_past:needed_by_in_past',
  'A1: a needed-by now or in the past (needed_by_in_past), a null one (needed_by_required: clearing is not supported), and a reason empty, blank, null or over 500 characters (reason_required) are refused with 22023');
select is(pg_temp.state(), :'state2',
  'A2: and nothing was written');
delete from fx;

-- The stale version, both directions.
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'expected null, value set',
  pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, 'null'));
insert into fx select 'detail expected null',
  pg_temp.err_detail(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, 'null'));
insert into fx select 'expected old, value set',
  pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, $$now() + interval '1 day'$$));
insert into fx select 'expected a value, none set',
  pg_temp.err(pg_temp.rev(:ordNull, $$now() + interval '5 days'$$, $$now() + interval '3 days'$$));
insert into fx select 'detail none set',
  pg_temp.err_detail(pg_temp.rev(:ordNull, $$now() + interval '5 days'$$, $$now() + interval '3 days'$$));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who not like 'detail%'),
  'expected a value, none set=P0001:needed_by_changed:needed_by_changed, '
  'expected null, value set=P0001:needed_by_changed:needed_by_changed, '
  'expected old, value set=P0001:needed_by_changed:needed_by_changed',
  'A3: a revision made against a value that is no longer the order''s is refused: P0001 needed_by_changed (expected none when one is set, an old value, a value when none is set)');
select is(
  (select jsonb_build_object(
     'set', (select (r::timestamptz = (select needed_by from public.order_requests where id = :ordArg))::text || ',' || (r ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')::text from fx where who = 'detail expected null'),
     'none', (select r from fx where who = 'detail none set'))),
  jsonb_build_object('set', 'true,true', 'none', ''),
  'A4: its detail is the current value, ISO 8601 (so a screen can load it and say so), or empty when the order has none');
select is(pg_temp.state(), :'state2',
  'A5: and nothing was written');
delete from fx;

-- A 500-character reason is accepted (the bound is inclusive).
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select '500', pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 days'$$, pg_temp.cur(:ordArg), '  ' || repeat('y', 500) || '  '));
reset role;
select is((select r from fx where who = '500'), 'no error',
  'A6: a reason of exactly 500 characters after trimming is accepted');
delete from fx;

-- A needed-by no screen can show: infinity, or years away. JavaScript's Date
-- cannot hold year 290000, and the reminder cron's date arithmetic would
-- carry either onto the event.
select pg_temp.state() as "state4" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'infinity', pg_temp.err(pg_temp.rev(:ordArg, $$'infinity'::timestamptz$$, pg_temp.cur(:ordArg)));
insert into fx select 'year 290000', pg_temp.err(pg_temp.rev(:ordArg, $$'290000-01-01 00:00+00'::timestamptz$$, pg_temp.cur(:ordArg)));
insert into fx select 'five years and a minute', pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 years 1 minute'$$, pg_temp.cur(:ordArg)));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'five years and a minute=22023:needed_by_out_of_range:needed_by_out_of_range, '
  'infinity=22023:needed_by_out_of_range:needed_by_out_of_range, '
  'year 290000=22023:needed_by_out_of_range:needed_by_out_of_range',
  'A7: infinity, a year no screen can show and anything later than five years from now are refused: 22023 needed_by_out_of_range');
select is(pg_temp.state(), :'state4',
  'A8: and nothing was written (the order and its event keep their dates)');
delete from fx;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'just inside', pg_temp.err(pg_temp.rev(:ordArg, $$now() + interval '5 years' - interval '1 minute'$$, pg_temp.cur(:ordArg)));
reset role;
select is((select r from fx where who = 'just inside'), 'no error',
  'A9: a needed-by a minute inside five years from now is accepted');
delete from fx;

-- ═══ E. The event ═════════════════════════════════════════════════════════
create temp table before_appr as
  select e.starts_at, e.ends_at, e.status, e.title, e.created_by, e.order_request_id, e.warehouse_id
    from public.schedule_events e where e.id = :evAppr;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'appr', public.revise_order_needed_by(
  :ordAppr, date_trunc('minute', now()) + interval '5 days',
  (select needed_by from public.order_requests where id = :ordAppr), '  The school moved the day  ',
  E'  Auto-created from order SO-000383. Needed by Oct 9, 2026,\t 2:00 PM.\u0007\n');
reset role;
select is(
  (select r from ans where who = 'appr'),
  jsonb_build_object('changed', true,
                     'previous', to_jsonb(date_trunc('minute', now()) + interval '3 days'),
                     'neededBy', to_jsonb(date_trunc('minute', now()) + interval '5 days'),
                     'eventId', :evAppr::text, 'eventUpdated', true, 'eventStatus', 'scheduled',
                     'status', 'approved'),
  'E1: the answer is exactly {changed, previous, neededBy, eventId, eventUpdated, eventStatus, status}');
select is(
  (select jsonb_build_object(
     'order', (select o.needed_by = date_trunc('minute', now()) + interval '5 days' and o.status = 'approved'
                 from public.order_requests o where o.id = :ordAppr),
     'starts', e.starts_at = date_trunc('minute', now()) + interval '5 days',
     'ends', e.ends_at = date_trunc('minute', now()) + interval '5 days 1 hour',
     'details', e.details,
     'status', e.status,
     'updatedBy', e.updated_by = :mgr,
     'unchanged', (e.title, e.created_by, e.order_request_id, e.warehouse_id)
                  = (select b.title, b.created_by, b.order_request_id, b.warehouse_id from before_appr b))
     from public.schedule_events e where e.id = :evAppr),
  jsonb_build_object('order', true, 'starts', true, 'ends', true,
                     'details', :sent::text,
                     'status', 'scheduled', 'updatedBy', true, 'unchanged', true),
  'E2: the order and its scheduled event move together: starts_at = the new needed-by, ends_at keeps its hour, the description''s sentence is the one given (control characters stripped), still scheduled, updated_by = the caller; title, creator, link and warehouse unchanged; the order''s status unchanged');
select is(
  (select e.reminded_24h_at from public.schedule_events e where e.id = :evAppr),
  null::timestamptz,
  'E3: the day-ahead stamp is cleared, so the cron reminds the new time a day ahead (mutation: keep reminded_24h_at)');
select is(
  (select e.reminded_1h_at from public.schedule_events e where e.id = :evAppr),
  null::timestamptz,
  'E4: and the one-hour stamp is cleared too');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'pip', public.revise_order_needed_by(
  :ordPip, date_trunc('minute', now()) + interval '5 days',
  (select needed_by from public.order_requests where id = :ordPip), 'Picking runs late', null);
reset role;
select is(
  (select jsonb_build_object('updated', (select r->'eventUpdated' from ans where who = 'pip'),
                             'eventStatus', (select r->'eventStatus' from ans where who = 'pip'),
                             'starts', e.starts_at = date_trunc('minute', now()) + interval '5 days',
                             'details', e.details, 'status', e.status,
                             'stamps', coalesce(e.reminded_24h_at::text, '-') || coalesce(e.reminded_1h_at::text, '-'))
     from public.schedule_events e where e.id = :evPip),
  jsonb_build_object('updated', true, 'eventStatus', 'in_progress', 'starts', true, 'details', 'old pip',
                     'status', 'in_progress', 'stamps', '--'),
  'E5: an in-progress event moves too, stamps cleared, and the answer names its status; a null description keeps the event''s own');

create temp table before_closed as
  select e.id, e.starts_at, e.details, e.reminded_24h_at, e.ctid as row_ctid from public.schedule_events e where e.id in (:evDone, :evCanc);
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'done', public.revise_order_needed_by(
  :ordDone, date_trunc('minute', now()) + interval '5 days',
  (select needed_by from public.order_requests where id = :ordDone), 'r', 'new done');
insert into ans select 'canc', public.revise_order_needed_by(
  :ordCanc, date_trunc('minute', now()) + interval '5 days',
  (select needed_by from public.order_requests where id = :ordCanc), 'r', 'new canc');
reset role;
select is(
  (select jsonb_build_object(
     'answers', (select jsonb_agg(jsonb_build_object('changed', r->'changed', 'eventId', r->'eventId', 'eventUpdated', r->'eventUpdated',
                                                     'eventStatus', r->'eventStatus') order by who)
                   from ans where who in ('canc', 'done')),
     'orders', (select bool_and(o.needed_by = date_trunc('minute', now()) + interval '5 days')
                  from public.order_requests o where o.id in (:ordDone, :ordCanc)),
     'events', (select bool_and((e.starts_at, e.details, e.reminded_24h_at, e.ctid) = (b.starts_at, b.details, b.reminded_24h_at, b.row_ctid))
                  from public.schedule_events e join before_closed b on b.id = e.id))),
  jsonb_build_object(
    'answers', jsonb_build_array(
      jsonb_build_object('changed', true, 'eventId', :evCanc::text, 'eventUpdated', false, 'eventStatus', 'cancelled'),
      jsonb_build_object('changed', true, 'eventId', :evDone::text, 'eventUpdated', false, 'eventStatus', 'completed')),
    'orders', true, 'events', true),
  'E6: a completed or cancelled event is untouched (not even a new row version), and the order still moves');

select count(*)::int as "events_before" from public.schedule_events where organization_id = :orgA \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'pend', public.revise_order_needed_by(
  :ordPend, date_trunc('minute', now()) + interval '5 days',
  (select needed_by from public.order_requests where id = :ordPend), 'r', 'details');
insert into ans select 'noev', public.revise_order_needed_by(
  :ordNoEv, date_trunc('minute', now()) + interval '5 days',
  (select needed_by from public.order_requests where id = :ordNoEv), 'r', 'details');
insert into ans select 'null', public.revise_order_needed_by(
  :ordNull, date_trunc('minute', now()) + interval '5 days', null, 'First date', 'details');
reset role;
select is(
  (select jsonb_build_object(
     'answers', (select jsonb_agg(jsonb_build_object('changed', r->'changed', 'previous', r->'previous', 'eventId', r->'eventId',
                                                     'eventUpdated', r->'eventUpdated', 'eventStatus', r->'eventStatus',
                                                     'status', r->'status') order by who)
                   from ans where who in ('noev', 'null', 'pend')),
     'orders', (select bool_and(o.needed_by = date_trunc('minute', now()) + interval '5 days')
                  from public.order_requests o where o.id in (:ordPend, :ordNoEv, :ordNull)),
     'events', (select count(*)::int from public.schedule_events where organization_id = :orgA))),
  jsonb_build_object(
    'answers', jsonb_build_array(
      jsonb_build_object('changed', true, 'previous', to_jsonb(date_trunc('minute', now()) + interval '3 days'),
                         'eventId', null, 'eventUpdated', false, 'eventStatus', null, 'status', 'approved'),
      jsonb_build_object('changed', true, 'previous', null, 'eventId', null, 'eventUpdated', false, 'eventStatus', null,
                         'status', 'pending_approval'),
      jsonb_build_object('changed', true, 'previous', to_jsonb(date_trunc('minute', now()) + interval '3 days'),
                         'eventId', null, 'eventUpdated', false, 'eventStatus', null, 'status', 'pending_approval')),
    'orders', true, 'events', :events_before),
  'E7: an order without an event (pending, an approved one whose event is missing, and a first date on an order that had none) changes only the order: no event is created here (the service creates a missing one through autoScheduleFromOrder), and the status tells it whether to');

select pg_temp.state() as "state3" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'eq', public.revise_order_needed_by(
  :ordEq, (select needed_by from public.order_requests where id = :ordEq),
  (select needed_by from public.order_requests where id = :ordEq), 'Same again', 'changed details');
reset role;
select is(
  (select r from ans where who = 'eq'),
  jsonb_build_object('changed', false,
                     'previous', to_jsonb(date_trunc('minute', now()) + interval '3 days'),
                     'neededBy', to_jsonb(date_trunc('minute', now()) + interval '3 days'),
                     'eventId', :evEq::text, 'eventUpdated', false, 'eventStatus', 'scheduled',
                     'status', 'staged_for_pickup'),
  'E8: an equal value answers {changed: false}');
select is(pg_temp.state(), :'state3',
  'E9: and writes nothing: no new row version of the order or the event, its stamps and description kept');

-- THE DESCRIPTION. Only core's sentence in it is replaced; everything else
-- a person wrote on the Schedule page stays. Each case sets evTxt's
-- description as the test superuser, then revises ordTxt a day further.
create function pg_temp.txt(p_details text, p_days int, p_given text default :sent) returns text language plpgsql as $$
declare v text;
begin
  update public.schedule_events set details = p_details where id = '03830000-0000-0000-0000-00000000020b';
  set local role to 'authenticated';
  perform set_config('request.jwt.claim.sub', '03830000-0000-0000-0000-0000000000a1', true);
  perform public.revise_order_needed_by(
    '03830000-0000-0000-0000-00000000010b', date_trunc('minute', now()) + make_interval(days => p_days),
    (select needed_by from public.order_requests where id = '03830000-0000-0000-0000-00000000010b'),
    'Description case', p_given);
  reset role;
  select coalesce(e.details, '<null>') || ' @' || (e.starts_at = date_trunc('minute', now()) + make_interval(days => p_days))::text
    into v from public.schedule_events e where e.id = '03830000-0000-0000-0000-00000000020b';
  return v;
end $$;
select is(
  pg_temp.txt(E'Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM.\nGate code 4411; call Maria on arrival.', 4),
  :sent || E'\nGate code 4411; call Maria on arrival. @true',
  'E10: a line someone added on the Schedule page is kept: only the sentence changes (mutation: overwrite the whole description)');
select is(
  pg_temp.txt('Deliver to the gym. Auto-created from order SO-000383. Needed by 9/11/2026, 2:00:00 AM. Bring the cart.', 5),
  'Deliver to the gym. ' || :sent || ' Bring the cart. @true',
  'E14: the sentence is swapped where it sits, the old numeric format (before SP-043) included');
select is(
  pg_temp.txt('Call Maria first; the side door is locked.', 6),
  'Call Maria first; the side door is locked. @true',
  'E15: a description rewritten by hand, with no sentence of core''s in it, is kept whole (the event still moves)');
select is(
  (select string_agg(r, ' | ' order by k) from (
     select 1 as k, pg_temp.txt('Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM.', 7,
                                'Refunds: call 555-0100 today. Auto-created from order SO-000383. Needed by x.') as r
     union all
     select 2, pg_temp.txt('Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM.', 8, repeat('d', 1500))
     union all
     select 3, pg_temp.txt('Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM.', 9,
                           'Auto-created from order SO-TEST. Needed by Oct 9, 2026, 2:00 PM.')) t),
  'Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM. @true | '
  'Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM. @true | '
  'Auto-created from order SO-000383. Needed by Oct 3, 2026, 2:00 PM. @true',
  'E16: a description that is not core''s sentence (other text, 1500 characters, a malformed order number) is ignored: the event keeps its own and still moves');
select is(
  (select string_agg(r, ' | ' order by k) from (
     select 1 as k, pg_temp.txt(null, 10) as r
     union all
     select 2, pg_temp.txt('   ', 11)) t),
  :sent || ' @true | ' || :sent || ' @true',
  'E17: an empty description gets the sentence');

-- An event with an end: the move keeps its duration (the end-after-start
-- CHECK would refuse a start past the old end).
update public.schedule_events set ends_at = starts_at + interval '90 minutes' where id = :evEq;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'later than end', pg_temp.err(pg_temp.rev(:ordEq, $$date_trunc('minute', now()) + interval '20 days'$$, pg_temp.cur(:ordEq)));
reset role;
select is(
  (select jsonb_build_object('r', (select r from fx where who = 'later than end'),
                             'ends', e.ends_at - e.starts_at,
                             'starts', e.starts_at = date_trunc('minute', now()) + interval '20 days')
     from public.schedule_events e where e.id = :evEq),
  jsonb_build_object('r', 'no error', 'ends', '01:30:00'::interval, 'starts', true),
  'E11: moving an event past its old end keeps its 90 minutes (no end-after-start violation)');
delete from fx;

select is(pg_temp.notes(), :notes0,
  'E12: no revision wrote a notification (the order''s status never changed, and nothing else notifies)');

-- Another org's order is revised by its own manager only.
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgrB;
insert into fx select 'mgrB on B', pg_temp.err(pg_temp.rev(:ordB, $$now() + interval '5 days'$$, pg_temp.cur(:ordB)));
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'mgrA on B', pg_temp.err(pg_temp.rev(:ordB, $$now() + interval '6 days'$$, pg_temp.cur(:ordB)));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'mgrA on B=P0002::order_request_not_found, mgrB on B=no error',
  'E13: org B''s manager revises org B''s order; org A''s manager gets P0002 for it');
delete from fx;

-- ═══ Z. The frozen objects ═══════════════════════════════════════════════
select is(
  (select string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|'
                     || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner), E'\n'
                     order by p.oid::regprocedure::text)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (
      ('public', 'approve_order_request'), ('public', 'approve_partial'), ('public', 'resume_fulfillment'),
      ('public', 'close_partial'), ('public', 'complete_picking'), ('public', 'partial_pick_line'),
      ('public', 'reopen_picking'), ('public', 'cancel_order_request'), ('public', 'hold_order_stock'),
      ('public', 'order_readiness_facts'), ('public', 'confirm_order_signature'),
      ('public', 'confirm_physical_signature'), ('public', 'create_order_request'),
      ('public', 'save_purchase_order_draft'), ('public', 'next_po_number'), ('public', 'post_receipt_v2'),
      ('public', 'tg_order_requests_insert_guard'), ('public', 'tg_order_request_lines_guard'),
      ('public', 'caller_can_read_item'))),
  E'approve_order_request(uuid)|96e5f7c8b4cdd6b7e4ffcc994c9ed642|true|{search_path=public}|postgres\n'
  'approve_partial(uuid)|64bb847ffc8681adeed4b881c1b6a4ab|true|{search_path=public}|postgres\n'
  'caller_can_read_item(uuid)|80523d2cc0fafe7fc6b3599903d7f014|true|{search_path=public}|postgres\n'
  'cancel_order_request(uuid,text)|7a2302dec888970054738b0dad420fd3|true|{"search_path=public, extensions"}|postgres\n'
  'close_partial(uuid)|2d873a049a5584df7d3a168fb2b45e34|true|{search_path=public}|postgres\n'
  'complete_picking(uuid)|b8f1ef1fb01efa5c04c916c178129541|true|{"search_path=public, extensions"}|postgres\n'
  'confirm_order_signature(uuid,text,text,text,text)|8afdbb68f11dd4e8dcff3283b42f3b13|true|{search_path=public}|postgres\n'
  'confirm_physical_signature(uuid,text)|f7a14a46d2c70f635c3da844c786ce67|true|{search_path=public}|postgres\n'
  'create_order_request(jsonb,jsonb)|4d65cef6c569a8c2c699fd9d5c8b77d5|false|{search_path=public}|postgres\n'
  'hold_order_stock(uuid)|c38fe9b12af77fdaa2d372f4fd324a43|true|{"search_path=public, pg_temp",lock_timeout=5s}|postgres\n'
  'next_po_number(uuid)|b6bebc9ae8b1ec3a9ba6d89b73e39d91|false|{search_path=public}|postgres\n'
  'order_readiness_facts(uuid)|5ac332d439117e498096fc9b1098cf04|true|{"search_path=public, pg_temp"}|postgres\n'
  'partial_pick_line(uuid,numeric)|b52a9877d54f13fb17ba44dafe5645c9|true|{search_path=public}|postgres\n'
  'post_receipt_v2(uuid,uuid,jsonb,text,text,text)|efc01e2e0ea98531c92c7db27f17695c|false|{search_path=public}|postgres\n'
  'reopen_picking(uuid,text)|a7fabd5fb3d07467135006b56581e46c|true|{"search_path=public, extensions"}|postgres\n'
  'resume_fulfillment(uuid)|e0f2ae5d7d3564cdad3b36ba4cf5aa8c|true|{search_path=public}|postgres\n'
  'save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamp with time zone,text,jsonb,uuid[],uuid,boolean)|2b6eefbefb914cc71ecde820f215b477|false|{"search_path=public, pg_temp"}|postgres\n'
  'tg_order_request_lines_guard()|d899924c0f8fc1dfae4e8be7bd4c5cad|false|{search_path=public}|postgres\n'
  'tg_order_requests_insert_guard()|1b109d535811e9a21c43d01dcc344892|false|{search_path=public}|postgres',
  'Z1: the frozen functions (fulfilment, holds, readiness facts, PO, guards, read helper) are the text, SECURITY DEFINER, search_path and owner F2-4 was proven against');
select is(
  (select string_agg(k || '|' || v, E'\n' order by k) from (
    select 'ledger.*' as k, md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*) as v
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ledger'
    union all
    select '0380 report functions', md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('report_bundle_activity', 'report_bundle_component_value', 'report_item_out_movements', 'report_movement_type_summary', 'report_shrinkage_totals', 'report_top_movers')
    union all
    select '0381 photo functions', md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('item_image_item_writable', 'item_image_path_item_id', 'item_image_path_org_id', 'item_image_row_path_ok', 'rls_item_image_shared_paths')
    union all
    select '0381 photo policies', md5(string_agg(c.relname || '|' || pol.polname || '|' || pol.polcmd::text || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') || '|' || pol.polroles::text, E'\n' order by c.relname, pol.polname)) || '|' || count(*)
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where (c.relname = 'item_images') or (c.relname = 'objects' and pol.polname like 'item-images %')
    union all
    select '0382 book functions', md5(string_agg(p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.oid::regprocedure::text)) || '|' || count(*)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('book_order_report_charters', 'book_order_report_lines', 'book_order_report_range', 'book_order_totals', 'book_order_totals_options', 'book_order_totals_orders')
    union all
    select 'order_requests + schedule_events policies', md5(string_agg(c.relname || '|' || pol.polname || '|' || pol.polcmd::text || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') || '|' || pol.polroles::text, E'\n' order by c.relname, pol.polname)) || '|' || count(*)
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where c.relnamespace = 'public'::regnamespace and c.relname in ('order_requests', 'schedule_events')
  ) g),
  E'0380 report functions|13e9b93da345dd302ad93629ff2d1690|6\n'
  '0381 photo functions|cf3324efe7b21cab2352568f0b600675|5\n'
  '0381 photo policies|7e259c299ec06a104c10121f80c143e7|8\n'
  '0382 book functions|860fa55515d74980ce1c1d0a4a6f3e18|6\n'
  'ledger.*|8b442829be30fd47ab5cfef87da6a962|14\n'
  -- Re-pinned by 0384 (was c388801c0cca0196bed7d51dc7df2096): the
  -- schedule_events insert and update WITH CHECK gained
  -- order_request_in_org(order_request_id, organization_id); every earlier
  -- term is kept (0384's pgTAP G8 pins the exact text). F2-4's function
  -- never changes the link, so what it was proven against still holds.
  'order_requests + schedule_events policies|a85d7406f48ad916cb5fcdb2193fa201|8',
  'Z2: ledger.*, the 0380 report functions, the 0381 photo functions and policies, the 0382 book functions, and the order_requests and schedule_events policies are the ones F2-4 was proven against (schedule_events as 0384 left them)');
select ok(
  (select bool_and(has_column_privilege('authenticated', 'public.schedule_events', c, 'UPDATE'))
     from unnest(array['starts_at', 'reminded_24h_at', 'reminded_1h_at', 'updated_by']) c),
  'Z3: authenticated may UPDATE schedule_events.starts_at and both reminder stamps: ScheduleService.update clears the stamps through the user client when it moves a start (the Schedule page re-arm, D23), so a revoke here would silently undo it');

select * from finish();
rollback;
