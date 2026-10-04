-- supabase/tests/0378_order_hold_stock.test.sql
-- pgTAP proof for migration 0378 (F2-2: hold_order_stock).
--
-- G. Grants and gates: SECURITY DEFINER, VOLATILE, search_path and
--    lock_timeout pinned, EXECUTE to authenticated and service_role and not
--    anon or PUBLIC, gated in its own body, refusing only with P0001, P0002 or
--    42501, never 40001/40P01, and writing nothing but holds. Signed out (and
--    the service role, which has no caller): 42501. A non-member, another
--    org's manager, a random or null id and a disabled member: the SAME P0002.
--    Orders module off: P0001 module_disabled. A viewer, staff without
--    orders:approve and the order's own requester: 42501 (hint
--    orders_approve). Staff with an orders:approve override in another
--    warehouse, and a viewer with an orders:approve override: 42501 (hint
--    warehouse_write). Staff with an orders:approve override in the order's
--    warehouse SUCCEED (pattern #4: the approve gate), as do a manager, a
--    manager whose orders:approve was revoked (approve keeps has_org_role),
--    an admin and the owner. No refusal writes anything. A staff approver
--    scoped to one charter holds an order carrying another charter's item
--    (held the same), but the answer gives numbers only for items they can
--    read (caller_can_read_item); the other is only counted.
-- S. Status: every status but approved, pick_slip_generated and
--    picking_in_progress gives P0001 hold_not_applicable with the status as
--    its detail, and writes nothing; the three hold statuses are answered.
-- A. Arithmetic: tops up only the gap (mutation: insert the full need);
--    never beyond on hand less EVERY active hold, other orders' and rentals'
--    included, released ones ignored (mutations: skip the availability read;
--    count only order holds); owed is floored per line (mutation: floor per
--    item); duplicate lines hold their total once; an over-held item is left
--    alone (never shrunk); deleted, moved and other-org items are skipped
--    (never held, never reported); the answer is exactly {held, stillShort},
--    item ids ascending; the holds are this order's, in its warehouse; a
--    re-run adds 0 (idempotent by convergence).
-- L. Lock order: the order row is locked before the items, the items in id
--    order, the order approve_order_request, approve_partial,
--    resume_fulfillment and complete_picking take them in. pgTAP runs in ONE
--    session, so here the two start orders run one after the other and must
--    compose (neither takes units the other holds); the concurrent proof, in
--    both start orders, and the race for the last units are
--    scripts/db-concurrency/0378_hold_race.sh.
-- Z. The frozen objects (F2's list plus F2-1's order_readiness_facts): md5,
--    SECURITY DEFINER, search_path and owner.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt); the function runs as `authenticated` with request.jwt.claim.sub.
-- begin/rollback: nothing leaks. Namespace 03780000.

begin;

select plan(38);

\set orgA    '\'03780000-0000-0000-0000-00000000000a\''
\set orgB    '\'03780000-0000-0000-0000-00000000000b\''
\set own     '\'03780000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03780000-0000-0000-0000-0000000000a1\''
\set mgrNo   '\'03780000-0000-0000-0000-0000000000a2\''
\set stf     '\'03780000-0000-0000-0000-0000000000a3\''
\set stfAp   '\'03780000-0000-0000-0000-0000000000a4\''
\set stfApX  '\'03780000-0000-0000-0000-0000000000a5\''
\set vwr     '\'03780000-0000-0000-0000-0000000000a6\''
\set vwrAp   '\'03780000-0000-0000-0000-0000000000a7\''
\set dis     '\'03780000-0000-0000-0000-0000000000a8\''
\set adm     '\'03780000-0000-0000-0000-0000000000a9\''
\set mgrB    '\'03780000-0000-0000-0000-0000000000b1\''
\set nobody  '\'03780000-0000-0000-0000-0000000000c1\''
\set whA     '\'03780000-0000-0000-0000-0000000000d1\''
\set whA2    '\'03780000-0000-0000-0000-0000000000d2\''
\set whB     '\'03780000-0000-0000-0000-0000000000d3\''
\set rentR   '\'03780000-0000-0000-0000-0000000000e1\''
\set iGap    '\'03780000-0000-0000-0000-000000000f01\''
\set iShort  '\'03780000-0000-0000-0000-000000000f02\''
\set iFull   '\'03780000-0000-0000-0000-000000000f03\''
\set iOver   '\'03780000-0000-0000-0000-000000000f04\''
\set iDup    '\'03780000-0000-0000-0000-000000000f05\''
\set iDel    '\'03780000-0000-0000-0000-000000000f06\''
\set iMoved  '\'03780000-0000-0000-0000-000000000f07\''
\set iB      '\'03780000-0000-0000-0000-000000000f08\''
\set iRes    '\'03780000-0000-0000-0000-000000000f09\''
\set iLk1    '\'03780000-0000-0000-0000-000000000f0a\''
\set iLk2    '\'03780000-0000-0000-0000-000000000f0b\''
\set iLk3    '\'03780000-0000-0000-0000-000000000f0c\''
\set iLk4    '\'03780000-0000-0000-0000-000000000f0d\''
\set iSt     '\'03780000-0000-0000-0000-000000000f0e\''
\set iBinA   '\'03780000-0000-0000-0000-000000000f10\''
\set ordTop  '\'03780000-0000-0000-0000-000000000101\''
\set ordOther '\'03780000-0000-0000-0000-000000000102\''
\set ordRes  '\'03780000-0000-0000-0000-000000000103\''
\set ordPip  '\'03780000-0000-0000-0000-000000000104\''
\set ordGate '\'03780000-0000-0000-0000-000000000105\''
\set ordB    '\'03780000-0000-0000-0000-000000000141\''
\set ordLkP1 '\'03780000-0000-0000-0000-000000000151\''
\set ordLkX1 '\'03780000-0000-0000-0000-000000000152\''
\set ordLkP2 '\'03780000-0000-0000-0000-000000000153\''
\set ordLkX2 '\'03780000-0000-0000-0000-000000000154\''
\set stfCh   '\'03780000-0000-0000-0000-0000000000aa\''
\set chX     '\'03780000-0000-0000-0000-0000000000e2\''
\set chY     '\'03780000-0000-0000-0000-0000000000e3\''
\set iChX    '\'03780000-0000-0000-0000-000000000f11\''
\set iChY    '\'03780000-0000-0000-0000-000000000f12\''
\set ordCh   '\'03780000-0000-0000-0000-000000000106\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0378-own@test.local',    '{}'::jsonb),
  (:adm,    '0378-adm@test.local',    '{}'::jsonb),
  (:mgr,    '0378-mgr@test.local',    '{}'::jsonb),
  (:mgrNo,  '0378-mgrno@test.local',  '{}'::jsonb),
  (:stf,    '0378-stf@test.local',    '{}'::jsonb),
  (:stfAp,  '0378-stfap@test.local',  '{}'::jsonb),
  (:stfApX, '0378-stfapx@test.local', '{}'::jsonb),
  (:vwr,    '0378-vwr@test.local',    '{}'::jsonb),
  (:vwrAp,  '0378-vwrap@test.local',  '{}'::jsonb),
  (:dis,    '0378-dis@test.local',    '{}'::jsonb),
  (:mgrB,   '0378-mgrb@test.local',   '{}'::jsonb),
  (:nobody, '0378-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0378 Hold A', '0378-hold-a'),
  (:orgB, '0378 Hold B', '0378-hold-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,    'owner',   now()),
  (:orgA, :adm,    'admin',   now()),
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :mgrNo,  'manager', now()),
  (:orgA, :stf,    'staff',   now()),
  (:orgA, :stfAp,  'staff',   now()),
  (:orgA, :stfApX, 'staff',   now()),
  (:orgA, :vwr,    'viewer',  now()),
  (:orgA, :vwrAp,  'viewer',  now()),
  (:orgA, :dis,    'staff',   now()),
  (:orgB, :mgrB,   'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0378 Main',  'WH-0378A',  'active'),
  (:whA2, :orgA, '0378 Annex', 'WH-0378A2', 'active'),
  (:whB,  :orgB, '0378 Other', 'WH-0378B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stf,    :whA,  true),
  (:orgA, :stfAp,  :whA,  true),
  (:orgA, :stfApX, :whA2, true),
  (:orgA, :vwr,    :whA,  true),
  (:orgA, :vwrAp,  :whA,  true),
  (:orgA, :dis,    :whA,  true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp,  'orders:approve', true),
  (:orgA, :stfApX, 'orders:approve', true),
  (:orgA, :vwrAp,  'orders:approve', true),
  (:orgA, :dis,    'orders:approve', true),
  -- A manager whose orders:approve was revoked: before 0390 the has_org_role
  -- term let them hold; since 0390 they are refused (G13).
  (:orgA, :mgrNo,  'orders:approve', false);

-- A staff approver scoped to ONE charter of warehouse A (a charter-scoped
-- assignment passes the warehouse write gate, user_can_access_inventory with
-- a null charter, as it does for approve), and an order carrying an item of
-- another charter, which they cannot read (G15, G16).
insert into auth.users (id, email, raw_user_meta_data) values
  (:stfCh, '0378-stfch@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :stfCh, 'staff', now());
insert into public.charters (id, organization_id, name) values
  (:chX, :orgA, '0378 Charter X'),
  (:chY, :orgA, '0378 Charter Y');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chX),
  (:orgA, :whA, :chY);
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stfCh, :whA, :chX, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfCh, 'orders:approve', true);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, deleted_at) values
  (:iGap,   :orgA, :whA,  'X0378-GAP',   'Gap item',       30, 'active', null),
  (:iShort, :orgA, :whA,  'X0378-SHORT', 'Short item',     10, 'active', null),
  (:iFull,  :orgA, :whA,  'X0378-FULL',  'Held item',      10, 'active', null),
  (:iOver,  :orgA, :whA,  'X0378-OVER',  'Over-held item', 10, 'active', null),
  (:iDup,   :orgA, :whA,  'X0378-DUP',   'Twice item',     5,  'active', null),
  (:iDel,   :orgA, :whA,  'X0378-DEL',   'Deleted item',   9,  'active', null),
  (:iMoved, :orgA, :whA2, 'X0378-MOVED', 'Moved item',     9,  'active', null),
  (:iB,     :orgB, :whB,  'X0378-B',     'Org B item',     9,  'active', null),
  -- Another org's item recorded in warehouse A (nothing stops it: defence in
  -- depth, A6): only the item's own org filter keeps it off org A's holds.
  (:iBinA,  :orgB, :whA,  'X0378-BINA',  'Org B item in A', 9,  'active', null),
  (:iRes,   :orgA, :whA,  'X0378-RES',   'Resumed item',   20, 'active', null),
  (:iLk1,   :orgA, :whA,  'X0378-LK1',   'Lock item 1',    8,  'active', null),
  (:iLk2,   :orgA, :whA,  'X0378-LK2',   'Lock item 2',    8,  'active', null),
  (:iLk3,   :orgA, :whA,  'X0378-LK3',   'Lock item 3',    8,  'active', null),
  (:iLk4,   :orgA, :whA,  'X0378-LK4',   'Lock item 4',    8,  'active', null),
  (:iSt,    :orgA, :whA,  'X0378-ST',    'Status item',    50, 'active', null);
insert into public.inventory_items
  (id, organization_id, warehouse_id, charter_id, sku, name, quantity_on_hand, status) values
  (:iChX, :orgA, :whA, :chX, 'X0378-CHX', 'Charter X item', 4, 'active'),
  (:iChY, :orgA, :whA, :chY, 'X0378-CHY', 'Charter Y item', 7, 'active');

insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:ordTop,   :orgA, :whA, 'approved',            'internal', :stf,  'pickup'),
  (:ordOther, :orgA, :whA, 'approved',            'internal', :stf,  'pickup'),
  (:ordRes,   :orgA, :whA, 'pick_slip_generated', 'internal', :stf,  'pickup'),
  (:ordPip,   :orgA, :whA, 'picking_in_progress', 'internal', :stf,  'pickup'),
  (:ordGate,  :orgA, :whA, 'approved',            'internal', :stf,  'pickup'),
  (:ordB,     :orgB, :whB, 'approved',            'internal', :mgrB, 'pickup'),
  (:ordLkP1,  :orgA, :whA, 'pending_approval',    'internal', :stf,  'pickup'),
  (:ordLkX1,  :orgA, :whA, 'approved',            'internal', :stf,  'pickup'),
  (:ordLkP2,  :orgA, :whA, 'pending_approval',    'internal', :stf,  'pickup'),
  (:ordLkX2,  :orgA, :whA, 'approved',            'internal', :stf,  'pickup'),
  (:ordCh,    :orgA, :whA, 'approved',            'internal', :stfCh, 'pickup');
-- One order per status that is NOT a hold status (S1), each with a line.
create temp table st_order (status text primary key, id uuid not null);
insert into st_order (status, id) values
  ('pending_confirmation',   '03780000-0000-0000-0000-000000000111'),
  ('pending_approval',       '03780000-0000-0000-0000-000000000112'),
  ('backordered',            '03780000-0000-0000-0000-000000000113'),
  ('picking_complete',       '03780000-0000-0000-0000-000000000114'),
  ('packing_slip_generated', '03780000-0000-0000-0000-000000000115'),
  ('staged_for_pickup',      '03780000-0000-0000-0000-000000000116'),
  ('staged_for_delivery',    '03780000-0000-0000-0000-000000000117'),
  ('in_transit',             '03780000-0000-0000-0000-000000000118'),
  ('completed',              '03780000-0000-0000-0000-000000000119'),
  ('denied',                 '03780000-0000-0000-0000-00000000011a'),
  ('cancelled',              '03780000-0000-0000-0000-00000000011b');
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select s.id, :orgA, :whA, s.status, 'internal', :stf, 'pickup' from st_order s;
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select s.id, :iSt, 1 from st_order s;

-- ordTop (approved): the SO-4 shape, lines added after approval and unheld.
--   iGap:   5 held at approval + 8 added            -> owed 13, own 5, need 8;
--           on hand 30 less every active hold (own 5, other order 3,
--           rental 2; the released 100 ignored) = 20 free -> adds 8.
--   iShort: 12 owed, 4 held; on hand 10 less 4 + 3 + 1 = 2 free
--           -> adds 2, 6 still short.
--   iFull:  4 owed, 4 held -> nothing.
--   iOver:  4 owed, 6 held (a lowered line) -> nothing, and never shrunk.
--   iDup:   two lines 3 + 3, nothing held, on hand 5 -> adds 5, 1 short.
--   iDel, iMoved, iB, iBinA: deleted, another warehouse's, another org's
--           (in its own warehouse, and in warehouse A) -> skipped.
insert into public.order_request_lines
  (order_request_id, item_id, quantity_requested, quantity_fulfilled, created_at) values
  (:ordTop, :iGap,   5,  0, '2026-09-01 10:00:00+00'),
  (:ordTop, :iGap,   8,  0, '2026-09-01 10:00:01+00'),
  (:ordTop, :iShort, 12, 0, '2026-09-01 10:00:02+00'),
  (:ordTop, :iFull,  4,  0, '2026-09-01 10:00:03+00'),
  (:ordTop, :iOver,  4,  0, '2026-09-01 10:00:04+00'),
  (:ordTop, :iDup,   3,  0, '2026-09-01 10:00:05+00'),
  (:ordTop, :iDup,   3,  0, '2026-09-01 10:00:06+00'),
  (:ordTop, :iDel,   2,  0, '2026-09-01 10:00:07+00'),
  (:ordTop, :iMoved, 2,  0, '2026-09-01 10:00:08+00'),
  (:ordTop, :iB,     2,  0, '2026-09-01 10:00:09+00'),
  (:ordTop, :iBinA,  2,  0, '2026-09-01 10:00:10+00'),
  (:ordOther, :iGap,   3, 0, '2026-09-01 10:00:00+00'),
  (:ordOther, :iShort, 3, 0, '2026-09-01 10:00:00+00'),
  -- ordRes (resumed, pick_slip_generated): one line over-received (8 of 5
  -- handed over), one owing 4 of 10 with 1 held. Owed floors per line: 0 + 4
  -- - 1 held = need 3 (mutation: floor per item gives -3 + 4 - 1 = 0).
  (:ordRes, :iRes, 5,  8, '2026-09-01 10:00:00+00'),
  (:ordRes, :iRes, 10, 6, '2026-09-01 10:00:01+00'),
  (:ordPip,  :iSt, 2, 0, '2026-09-01 10:00:00+00'),
  (:ordGate, :iSt, 3, 0, '2026-09-01 10:00:00+00'),
  (:ordB,    :iB,  1, 0, '2026-09-01 10:00:00+00'),
  (:ordLkP1, :iLk1, 5, 0, '2026-09-01 10:00:00+00'),
  (:ordLkP1, :iLk2, 5, 0, '2026-09-01 10:00:01+00'),
  (:ordLkX1, :iLk1, 5, 0, '2026-09-01 10:00:00+00'),
  (:ordLkX1, :iLk2, 5, 0, '2026-09-01 10:00:01+00'),
  (:ordLkP2, :iLk3, 5, 0, '2026-09-01 10:00:00+00'),
  (:ordLkP2, :iLk4, 5, 0, '2026-09-01 10:00:01+00'),
  (:ordLkX2, :iLk3, 5, 0, '2026-09-01 10:00:00+00'),
  (:ordLkX2, :iLk4, 5, 0, '2026-09-01 10:00:01+00'),
  -- ordCh: 10 of the unreadable charter Y item (7 on hand) and 6 of the
  -- readable charter X item (4 on hand).
  (:ordCh, :iChY, 10, 0, '2026-09-01 10:00:00+00'),
  (:ordCh, :iChX, 6,  0, '2026-09-01 10:00:01+00');
-- The deleted and the moved item were fine when their lines were added.
update public.inventory_items set deleted_at = now() where id = :iDel;

insert into public.rentals (id, organization_id, warehouse_id, borrower_name, expected_return_at, status)
values (:rentR, :orgA, :whA, 'Borrower 0378', now() + interval '7 days', 'out');
insert into public.stock_reservations
  (organization_id, item_id, warehouse_id, order_request_id, rental_id, quantity, released_at) values
  (:orgA, :iGap,   :whA, :ordTop,   null,   5,   null),
  (:orgA, :iGap,   :whA, :ordOther, null,   3,   null),
  (:orgA, :iGap,   :whA, null,      :rentR, 2,   null),
  (:orgA, :iGap,   :whA, :ordOther, null,   100, now() - interval '1 day'),  -- released: ignored
  (:orgA, :iShort, :whA, :ordTop,   null,   4,   null),
  (:orgA, :iShort, :whA, :ordOther, null,   3,   null),
  (:orgA, :iShort, :whA, null,      :rentR, 1,   null),
  (:orgA, :iFull,  :whA, :ordTop,   null,   4,   null),
  (:orgA, :iOver,  :whA, :ordTop,   null,   6,   null),
  (:orgA, :iRes,   :whA, :ordRes,   null,   1,   null);

-- The disabled member, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ══ Helpers ═══════════════════════════════════════════════════════════════
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
-- Every active hold in the fixture orgs, as a fingerprint.
create function pg_temp.holds() returns text language sql as $$
  select coalesce(string_agg(r.item_id::text || '/' || coalesce(r.order_request_id::text, 'rental') || '/' || r.quantity::text,
                             ',' order by r.item_id, r.order_request_id, r.quantity), '')
    from public.stock_reservations r
   where r.organization_id in ('03780000-0000-0000-0000-00000000000a', '03780000-0000-0000-0000-00000000000b')
     and r.released_at is null
$$;
-- This order's active holds on one item.
create function pg_temp.own(p_order uuid, p_item uuid) returns numeric language sql as $$
  select coalesce(sum(r.quantity), 0) from public.stock_reservations r
   where r.order_request_id = p_order and r.item_id = p_item and r.released_at is null
$$;

create temp table fx (who text not null, r text);
create temp table ans (who text primary key, r jsonb);
create temp table snap (k text primary key, v text);
grant all on fx, ans, snap to authenticated;
grant select on st_order to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.order_request_lines
       where order_request_id = '03780000-0000-0000-0000-000000000101') <> 11 then
    raise exception 'fixture: ordTop lines';
  end if;
  if (select count(*) from st_order s join public.order_requests o on o.id = s.id and o.status = s.status) <> 11 then
    raise exception 'fixture: status orders';
  end if;
end $$;

-- ═══ G. Structure, grants and gates ═══════════════════════════════════════
select ok(
  (select p.prosecdef and p.provolatile = 'v'
          and p.proconfig @> array['search_path=public, pg_temp', 'lock_timeout=5s']
     from pg_proc p where p.oid = 'public.hold_order_stock(uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.hold_order_stock(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hold_order_stock(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.hold_order_stock(uuid)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, unnest(p.proacl) a
                   where p.oid = 'public.hold_order_stock(uuid)'::regprocedure and a::text like '=%'),
  'G1: hold_order_stock is SECURITY DEFINER, VOLATILE, search_path public, pg_temp and lock_timeout 5s pinned; EXECUTE to authenticated and service_role, not anon or PUBLIC');
select ok(
  (select p.prosrc ~ 'auth\.uid\(\)' and p.prosrc ~ 'is_org_member\(v_org\)'
          and p.prosrc ~ $re$module_enabled\(v_org, 'orders'\)$re$
          -- Changed on purpose by 0390 (was: the body names has_org_role(v_org,
          -- 'manager'), the 0348 manager-or-approve gate): the role term is
          -- gone and orders:approve alone decides (0390 R6/R10, C9/C10).
          and p.prosrc !~ $re$has_org_role\(v_org, 'manager'\)$re$
          and p.prosrc ~ $re$has_permission\(v_org, 'orders:approve'\)$re$
          and p.prosrc ~ $re$user_can_access_inventory\(v_uid, v_wh, null, 'write'\)$re$
          and p.prosrc !~ '40001|40P01'
     from pg_proc p where p.oid = 'public.hold_order_stock(uuid)'::regprocedure),
  'G2: its gates are in its own body (signed in, member, the orders module, the approve gate (orders:approve alone since 0390), warehouse write) and it never raises 40001/40P01');
select is(
  (select array_agg(distinct m[1] order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.hold_order_stock(uuid)'::regprocedure),
  array['42501', 'P0001', 'P0002'],
  'G3: it refuses only with 42501, P0001 or P0002');
select ok(
  (select (select count(*) from regexp_matches(p.prosrc, '\minsert\s+into\s+public\.stock_reservations\M', 'gi')) = 1
          and (select count(*) from regexp_matches(p.prosrc, '\minsert\s+into\M', 'gi')) = 1
          and p.prosrc !~* '\mupdate\s+(public\.|only\M)'
          and p.prosrc !~* '\m(delete\s+from|truncate|merge\s+into)\M'
          and p.prosrc !~* 'adjust_stock|apply_level_delta|transfer_stock|quantity_on_hand\s*='
     from pg_proc p where p.oid = 'public.hold_order_stock(uuid)'::regprocedure),
  'G4: it writes holds and nothing else: one INSERT into stock_reservations, no UPDATE or DELETE, no stock movement (F2 writes no stock)');

select pg_temp.holds() as "holds0" \gset

set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '';
set local role to 'authenticated';
select is(
  pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop)),
  '42501::unauthenticated',
  'G5: no signed-in caller: 42501 unauthenticated');
reset role;
set local role to 'service_role';
select is(
  pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop)),
  '42501::unauthenticated',
  'G6: the service role (no caller) gets 42501 too, never a hold');
reset role;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :nobody;
insert into fx select 'nobody', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
set local "request.jwt.claim.sub" to :mgrB;
insert into fx select 'mgrB', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'random', pg_temp.err('select public.hold_order_stock(gen_random_uuid())');
insert into fx select 'null', pg_temp.err('select public.hold_order_stock(null)');
set local "request.jwt.claim.sub" to :dis;
insert into fx select 'disabled', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
reset role;
select is(
  (select array_agg(distinct r) from fx where who in ('nobody', 'mgrB', 'random', 'null', 'disabled')),
  array['P0002::order_request_not_found'],
  'G7: a non-member, another org''s manager, a random id, a null id and a disabled member (with an orders:approve override) all get the SAME P0002 order_request_not_found');
delete from fx;

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
select is(
  pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop)),
  'P0001:module_disabled:module_disabled',
  'G8: the orders module off: P0001 module_disabled');
reset role;
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :vwr;
insert into fx select 'vwr', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
set local "request.jwt.claim.sub" to :stf;
insert into fx select 'stf (the requester)', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
set local "request.jwt.claim.sub" to :stfApX;
insert into fx select 'stfApX', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
set local "request.jwt.claim.sub" to :vwrAp;
insert into fx select 'vwrAp', pg_temp.err(format('select public.hold_order_stock(%L)', :ordTop));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who in ('vwr', 'stf (the requester)')),
  'stf (the requester)=42501:orders_approve:forbidden, vwr=42501:orders_approve:forbidden',
  'G9: a viewer and the order''s own requester (staff without orders:approve) get 42501 forbidden (hint orders_approve): a non-approver never creates commitments');
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who in ('stfApX', 'vwrAp')),
  'stfApX=42501:warehouse_write:forbidden, vwrAp=42501:warehouse_write:forbidden',
  'G10: an orders:approve override without write access to the order''s warehouse (staff assigned elsewhere; a viewer, who never writes) gets 42501 forbidden (hint warehouse_write)');
delete from fx;
select is(pg_temp.holds(), :'holds0',
  'G11: no refusal wrote anything');

-- Success: staff with an override in the order's warehouse holds (pattern #4:
-- whoever approve lets approve may hold). ordGate owes 3 of a free 50.
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :stfAp;
insert into ans select 'stfAp', public.hold_order_stock(:ordGate);
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'mgr', pg_temp.err(format('select public.hold_order_stock(%L)', :ordGate));
set local "request.jwt.claim.sub" to :mgrNo;
insert into fx select 'mgrNo', pg_temp.err(format('select public.hold_order_stock(%L)', :ordGate));
set local "request.jwt.claim.sub" to :adm;
insert into fx select 'adm', pg_temp.err(format('select public.hold_order_stock(%L)', :ordGate));
set local "request.jwt.claim.sub" to :own;
insert into fx select 'own', pg_temp.err(format('select public.hold_order_stock(%L)', :ordGate));
reset role;
select is(
  (select r from ans where who = 'stfAp'),
  jsonb_build_object('held', jsonb_build_array(jsonb_build_object('itemId', :iSt::text, 'added', 3)),
                     'stillShort', '[]'::jsonb, 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
  'G12: staff with an orders:approve override in the order''s warehouse hold (3 of a free 50), as approve lets them');
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  -- Changed on purpose by 0390 (was mgrNo=no error): the revoked manager is
  -- refused now that has_permission alone decides.
  'adm=no error, mgr=no error, mgrNo=42501:orders_approve:forbidden, own=no error',
  'G13: a manager, an admin and the owner are answered; a manager whose orders:approve was revoked is refused (42501, hint orders_approve: 0390 removed the 0348 has_org_role term)');
select is(pg_temp.own(:ordGate, :iSt), 3::numeric,
  'G14: and those later calls held nothing more (the need was met)');
delete from fx;

-- Numbers only for items the caller can read (F2-1's rule): the
-- charter-scoped approver holds the order, the item they cannot read
-- included, but its quantities (7 held, 3 short: its free stock) are never
-- in the answer, only counted.
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :stfCh;
insert into fx select 'stfCh reads', public.caller_can_read_item(:iChY)::text || ',' || public.caller_can_read_item(:iChX)::text;
insert into ans select 'stfCh', public.hold_order_stock(:ordCh);
reset role;
select is(
  (select jsonb_build_object('reads', (select r from fx where who = 'stfCh reads'),
                             'answer', (select r from ans where who = 'stfCh'))),
  jsonb_build_object(
    'reads', 'false,true',
    'answer', jsonb_build_object(
      'held', jsonb_build_array(jsonb_build_object('itemId', :iChX::text, 'added', 4)),
      'stillShort', jsonb_build_array(jsonb_build_object('itemId', :iChX::text, 'quantity', 2)),
      'hiddenHeldItems', 1, 'hiddenShortItems', 1)),
  'G15: a staff approver scoped to one charter (who cannot read the other charter''s item) gets numbers only for the item they can read (4 held, 2 short); the unreadable item is only counted (1 held for, 1 still short), never its 7 and 3 (mutation: no caller_can_read_item filter gives its numbers)');
select is(
  array[pg_temp.own(:ordCh, :iChY), pg_temp.own(:ordCh, :iChX)],
  array[7, 4]::numeric[],
  'G16: and the unreadable item is held all the same (7 of 7, as approve would hold it): only the answer is withheld, never the commitment');
delete from fx;

-- ═══ S. Status ═══════════════════════════════════════════════════════════
select pg_temp.holds() as "holds1" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select s.status, pg_temp.err(format('select public.hold_order_stock(%L)', s.id)) from st_order s;
insert into fx select 'detail:' || s.status, pg_temp.err_detail(format('select public.hold_order_stock(%L)', s.id)) from st_order s;
reset role;
select is(
  (select string_agg(who, ', ' order by who) from fx
    where who not like 'detail:%' and r = 'P0001:hold_not_applicable:hold_not_applicable'),
  'backordered, cancelled, completed, denied, in_transit, packing_slip_generated, pending_approval, pending_confirmation, picking_complete, staged_for_delivery, staged_for_pickup',
  'S1: every status but the three hold statuses gives P0001 hold_not_applicable (pending is held by approve, backordered by resume, picked ones no longer hold)');
select is(
  (select count(*)::int from fx f join st_order s on f.who = 'detail:' || s.status where f.r = s.status),
  11,
  'S2: its detail names the status');
select is(pg_temp.holds(), :'holds1',
  'S3: and nothing was written');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'pip', public.hold_order_stock(:ordPip);
reset role;
select is(
  (select r from ans where who = 'pip'),
  jsonb_build_object('held', jsonb_build_array(jsonb_build_object('itemId', :iSt::text, 'added', 2)),
                     'stillShort', '[]'::jsonb, 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
  'S4: approved (G12), pick_slip_generated (A8) and picking_in_progress are answered: picking_in_progress holds its 2');

-- ═══ A. Arithmetic ═══════════════════════════════════════════════════════
create temp table before_top as
select r.id from public.stock_reservations r where r.order_request_id = :ordTop;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'top', public.hold_order_stock(:ordTop);
reset role;
select is(
  (select r->'held' from ans where who = 'top'),
  jsonb_build_array(
    jsonb_build_object('itemId', :iGap::text,   'added', 8),
    jsonb_build_object('itemId', :iShort::text, 'added', 2),
    jsonb_build_object('itemId', :iDup::text,   'added', 5)),
  'A1: held, item ids ascending: the gap only (8 added to the 5 already held, of 20 free: mutation "insert the full need" adds 13), the free 2 of a need of 8 (on hand 10 less the order''s 4, another order''s 3 and a rental''s 1: mutations "skip the availability read" and "count only order holds" add more), and duplicate lines 3 + 3 once, 5 of 5');
select is(
  (select r->'stillShort' from ans where who = 'top'),
  jsonb_build_array(
    jsonb_build_object('itemId', :iShort::text, 'quantity', 6),
    jsonb_build_object('itemId', :iDup::text,   'quantity', 1)),
  'A2: stillShort is what could not be held (6 and 1), ascending; the fully held and the over-held item are in neither list');
select is(
  (select array_agg(k order by k) from ans, jsonb_object_keys(r) k where who = 'top'),
  array['held', 'hiddenHeldItems', 'hiddenShortItems', 'stillShort'],
  'A3: the answer is exactly {held, stillShort, hiddenHeldItems, hiddenShortItems}');
select is(
  array[pg_temp.own(:ordTop, :iGap), pg_temp.own(:ordTop, :iShort), pg_temp.own(:ordTop, :iFull),
        pg_temp.own(:ordTop, :iOver), pg_temp.own(:ordTop, :iDup)],
  array[13, 6, 4, 6, 5]::numeric[],
  'A4: the order now holds 13, 6, 4, 6 and 5: the over-held item keeps its 6 (a hold is never shrunk here) and the held one is untouched');
select is(
  (select coalesce(sum(r.quantity), 0) from public.stock_reservations r
    where r.item_id = :iShort and r.released_at is null)
  + (select coalesce(sum(r.quantity), 0) from public.stock_reservations r
      where r.item_id = :iDup and r.released_at is null),
  (select sum(quantity_on_hand) from public.inventory_items where id in (:iShort, :iDup)),
  'A5: never beyond on hand: every active hold on the short item and the twice-ordered item now adds up to exactly what is on hand');
select is(
  (select count(*)::int from public.stock_reservations r
    where r.order_request_id = :ordTop and r.item_id in (:iDel, :iMoved, :iB, :iBinA)),
  0,
  'A6: the deleted item, the item now in another warehouse and another org''s items (in its own warehouse, and one recorded in this order''s warehouse) are skipped: never held (and never reported, A1/A2)');
select is(
  (select string_agg(r.item_id::text || ':' || trim_scale(r.quantity)::text || ':' || (r.organization_id = :orgA)::text
                     || ':' || (r.warehouse_id = :whA)::text || ':' || (r.rental_id is null)::text,
                     ',' order by r.item_id)
     from public.stock_reservations r
    where r.order_request_id = :ordTop and r.id not in (select id from before_top)),
  format('%s:8:true:true:true,%s:2:true:true:true,%s:5:true:true:true', :iGap, :iShort, :iDup),
  'A7: one new hold per item, the order''s own, in its org and its warehouse, never a rental''s');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'res', public.hold_order_stock(:ordRes);
reset role;
select is(
  (select r from ans where who = 'res'),
  jsonb_build_object('held', jsonb_build_array(jsonb_build_object('itemId', :iRes::text, 'added', 3)),
                     'stillShort', '[]'::jsonb, 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
  'A8: a resumed order (pick_slip_generated) owes per line: an over-received line owes 0, never less, so 0 + 4 less the 1 held = 3 (mutation: floor per item gives -3 + 4 - 1 = 0)');

select pg_temp.holds() as "holds2" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'top2', public.hold_order_stock(:ordTop);
insert into ans select 'res2', public.hold_order_stock(:ordRes);
reset role;
select is(
  (select jsonb_build_object('top', (select r from ans where who = 'top2'), 'res', (select r from ans where who = 'res2'))),
  jsonb_build_object(
    'top', jsonb_build_object('held', '[]'::jsonb, 'stillShort', jsonb_build_array(
             jsonb_build_object('itemId', :iShort::text, 'quantity', 6),
             jsonb_build_object('itemId', :iDup::text,   'quantity', 1)), 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
    'res', jsonb_build_object('held', '[]'::jsonb, 'stillShort', '[]'::jsonb, 'hiddenHeldItems', 0, 'hiddenShortItems', 0)),
  'A9: a re-run adds 0 (idempotent by convergence) and still says what is short');
select is(pg_temp.holds(), :'holds2',
  'A10: and writes nothing');

-- Stock arrives: the next call holds it (a later hold call converges).
update public.inventory_items set quantity_on_hand = 14 where id = :iShort;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'top3', public.hold_order_stock(:ordTop);
reset role;
select is(
  (select r from ans where who = 'top3'),
  jsonb_build_object(
    'held', jsonb_build_array(jsonb_build_object('itemId', :iShort::text, 'added', 4)),
    'stillShort', jsonb_build_array(
      jsonb_build_object('itemId', :iShort::text, 'quantity', 2),
      jsonb_build_object('itemId', :iDup::text,   'quantity', 1)), 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
  'A11: when 4 more come in, the next call holds those 4 and no more');

-- Another org's order with the same shape is answered for its own manager
-- only (G7 refused org A's manager... and org B's manager on org A's order).
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgrB;
insert into ans select 'orgB', public.hold_order_stock(:ordB);
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'mgrA on B', pg_temp.err(format('select public.hold_order_stock(%L)', :ordB));
reset role;
select is(
  (select jsonb_build_object('b', (select r from ans where who = 'orgB'), 'a', (select r from fx where who = 'mgrA on B'))),
  jsonb_build_object('b', jsonb_build_object('held', jsonb_build_array(jsonb_build_object('itemId', :iB::text, 'added', 1)),
                                             'stillShort', '[]'::jsonb, 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
                     'a', 'P0002::order_request_not_found'),
  'A12: org B''s manager holds on org B''s order; org A''s manager gets P0002 for it');
delete from fx;

-- ═══ L. Lock order ════════════════════════════════════════════════════════
select ok(
  (select position('for update' in substring(p.prosrc from position('from public.order_requests o' in p.prosrc)))
          < position('from public.inventory_items ii' in substring(p.prosrc from position('from public.order_requests o' in p.prosrc)))
          and p.prosrc ~ 'where o\.id = p_order_id\s+for update;'
          and p.prosrc ~ 'order by ii\.id\s+for update'
          and position('where o.id = p_order_id' || E'\n' || '     for update;' in p.prosrc)
              < position('order by ii.id' in p.prosrc)
     from pg_proc p where p.oid = 'public.hold_order_stock(uuid)'::regprocedure),
  'L1: hold_order_stock locks the order row, then the items FOR UPDATE in id order');
select is(
  (select string_agg(p.proname, ',' order by p.proname)
     from pg_proc p
    where p.oid in ('public.approve_order_request(uuid)'::regprocedure, 'public.approve_partial(uuid)'::regprocedure,
                    'public.resume_fulfillment(uuid)'::regprocedure, 'public.complete_picking(uuid)'::regprocedure)
      and p.prosrc ~ 'where id = p_(order_)?id for update;'
      and p.prosrc ~ 'order by l\.item_id\s+for update of ii'
      and position('for update;' in p.prosrc) < position('order by l.item_id' in p.prosrc)),
  'approve_order_request,approve_partial,complete_picking,resume_fulfillment',
  'L2: approve_order_request, approve_partial, resume_fulfillment and complete_picking take the same order: the order row, then the items in id order (so no two of them cross)');

-- Start order 1: approve P1 first, then hold X1 on the same two items
-- (on hand 8 each). Approve holds 5 + 5; the hold sees them: 3 free each.
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'approve P1', pg_temp.err(format('select (public.approve_order_request(%L)).status', :ordLkP1));
insert into ans select 'hold X1', public.hold_order_stock(:ordLkX1);
-- Start order 2: hold X2 first, then approve P2 on the same two items. The
-- hold takes 5 + 5; approve then refuses (5 wanted, 3 free), and
-- approve_partial holds exactly the 3 + 3 left.
insert into ans select 'hold X2', public.hold_order_stock(:ordLkX2);
insert into fx select 'approve P2', pg_temp.err(format('select (public.approve_order_request(%L)).status', :ordLkP2));
insert into fx select 'approve_partial P2', pg_temp.err(format('select (public.approve_partial(%L)).status', :ordLkP2));
reset role;
select is(
  (select jsonb_build_object('approve', (select r from fx where who = 'approve P1'),
                             'hold', (select r from ans where who = 'hold X1'))),
  jsonb_build_object('approve', 'no error',
                     'hold', jsonb_build_object(
                       'held', jsonb_build_array(jsonb_build_object('itemId', :iLk1::text, 'added', 3),
                                                 jsonb_build_object('itemId', :iLk2::text, 'added', 3)),
                       'stillShort', jsonb_build_array(jsonb_build_object('itemId', :iLk1::text, 'quantity', 2),
                                                       jsonb_build_object('itemId', :iLk2::text, 'quantity', 2)), 'hiddenHeldItems', 0, 'hiddenShortItems', 0)),
  'L3: approve first, then hold, on the same items: the hold takes only what approve left (3 of 8 each)');
select is(
  (select jsonb_build_object('hold', (select r from ans where who = 'hold X2'),
                             'approve', (select split_part(r, ':', 3) from fx where who = 'approve P2'),
                             'partial', (select r from fx where who = 'approve_partial P2'),
                             'p2holds', to_jsonb(array[trim_scale(pg_temp.own(:ordLkP2, :iLk3)), trim_scale(pg_temp.own(:ordLkP2, :iLk4))]))),
  jsonb_build_object('hold', jsonb_build_object(
                       'held', jsonb_build_array(jsonb_build_object('itemId', :iLk3::text, 'added', 5),
                                                 jsonb_build_object('itemId', :iLk4::text, 'added', 5)),
                       'stillShort', '[]'::jsonb, 'hiddenHeldItems', 0, 'hiddenShortItems', 0),
                     'approve', 'insufficient_stock',
                     'partial', 'no error',
                     'p2holds', jsonb_build_array(3, 3)),
  'L4: hold first, then approve, on the same items: approve sees the hold (insufficient_stock, 5 wanted, 3 free) and approve_partial holds exactly the 3 + 3 left');
select is(
  (select count(*)::int from public.inventory_items ii
    where ii.id in (:iLk1, :iLk2, :iLk3, :iLk4)
      and (select coalesce(sum(r.quantity), 0) from public.stock_reservations r
            where r.item_id = ii.id and r.released_at is null) <> ii.quantity_on_hand),
  0,
  'L5: in both start orders every unit is held once: the holds on each item add up to exactly its 8 on hand');
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
      ('public', 'reopen_picking'), ('public', 'cancel_order_request'), ('public', 'confirm_order_signature'),
      ('public', 'confirm_physical_signature'), ('public', 'create_order_request'),
      ('public', 'save_purchase_order_draft'), ('public', 'next_po_number'),
      ('public', 'post_receipt_v2'), ('ledger', 'post_receipt_v2'),
      ('ledger', 'apply_level_delta_for'), ('ledger', 'adjust_stock'), ('ledger', 'transfer_stock'),
      ('public', 'tg_order_requests_insert_guard'), ('public', 'tg_order_request_lines_guard'),
      ('public', 'caller_can_read_item'), ('public', 'location_holdings_visible'),
      ('public', 'order_readiness_facts'))),
  -- Re-pinned by 0390 (was 96e5f7c8b4cdd6b7e4ffcc994c9ed642): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  E'approve_order_request(uuid)|7883f466ae2642cbb4664ebc473e571b|true|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was 64bb847ffc8681adeed4b881c1b6a4ab): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'approve_partial(uuid)|40ca0878733b08a649773fe9b7efd4e0|true|{search_path=public}|postgres\n'
  'caller_can_read_item(uuid)|80523d2cc0fafe7fc6b3599903d7f014|true|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was 7a2302dec888970054738b0dad420fd3): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'cancel_order_request(uuid,text)|47cabcd1fe4f52fb7b2b6b6b64b68da1|true|{"search_path=public, extensions"}|postgres\n'
  -- Re-pinned by 0390 (was 2d873a049a5584df7d3a168fb2b45e34): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'close_partial(uuid)|a519c3e58fb577c3ff1b30fb3a6cc0ad|true|{search_path=public}|postgres\n'
  'complete_picking(uuid)|b8f1ef1fb01efa5c04c916c178129541|true|{"search_path=public, extensions"}|postgres\n'
  'confirm_order_signature(uuid,text,text,text,text)|8afdbb68f11dd4e8dcff3283b42f3b13|true|{search_path=public}|postgres\n'
  'confirm_physical_signature(uuid,text)|f7a14a46d2c70f635c3da844c786ce67|true|{search_path=public}|postgres\n'
  'create_order_request(jsonb,jsonb)|4d65cef6c569a8c2c699fd9d5c8b77d5|false|{search_path=public}|postgres\n'
  'ledger.adjust_stock(uuid,numeric,text,uuid,text,text,text)|e78aa783a243eebbda087eb2cbbb9647|false|{search_path=public}|postgres\n'
  'ledger.apply_level_delta_for(uuid,numeric,text,boolean,uuid)|9c3301fedd607398dccc72c7b4cfe371|true|{search_path=public}|postgres\n'
  'ledger.post_receipt_v2(uuid,uuid,jsonb,text,text,text)|f044c3a1ea7b125a094a42f736db77c8|false|{"search_path=public, extensions"}|postgres\n'
  'ledger.transfer_stock(uuid,uuid,uuid,numeric,text)|c7863c809eab4fc8e7698b421bf37587|false|{search_path=public}|postgres\n'
  'location_holdings_visible(uuid)|fb5dc7aa7d0acd81e7752f0b163a9002|false|{search_path=public}|postgres\n'
  'next_po_number(uuid)|b6bebc9ae8b1ec3a9ba6d89b73e39d91|false|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was 5ac332d439117e498096fc9b1098cf04): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'order_readiness_facts(uuid)|2f3fb057bacda8143377ecd9c2c5e6e2|true|{"search_path=public, pg_temp"}|postgres\n'
  'partial_pick_line(uuid,numeric)|b52a9877d54f13fb17ba44dafe5645c9|true|{search_path=public}|postgres\n'
  'post_receipt_v2(uuid,uuid,jsonb,text,text,text)|efc01e2e0ea98531c92c7db27f17695c|false|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was a7fabd5fb3d07467135006b56581e46c): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'reopen_picking(uuid,text)|293ce0e76d195bb13105cfd1c067de82|true|{"search_path=public, extensions"}|postgres\n'
  -- Re-pinned by 0390 (was e0f2ae5d7d3564cdad3b36ba4cf5aa8c): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'resume_fulfillment(uuid)|2e2d5aab1db5392250879bfa9ff4bccd|true|{search_path=public}|postgres\n'
  'save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamp with time zone,text,jsonb,uuid[],uuid,boolean)|2b6eefbefb914cc71ecde820f215b477|false|{"search_path=public, pg_temp"}|postgres\n'
  'tg_order_request_lines_guard()|d899924c0f8fc1dfae4e8be7bd4c5cad|false|{search_path=public}|postgres\n'
  'tg_order_requests_insert_guard()|1b109d535811e9a21c43d01dcc344892|false|{search_path=public}|postgres',
  'Z1: the frozen functions (fulfilment, PO, ledger, guards, read helpers and F2-1''s readiness facts) are the text, SECURITY DEFINER, search_path and owner F2-2 was proven against');

select * from finish();
rollback;
