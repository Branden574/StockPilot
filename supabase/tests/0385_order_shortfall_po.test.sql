-- supabase/tests/0385_order_shortfall_po.test.sql
-- pgTAP proof for migration 0385 (F2-5: draft a PO for the short lines only).
--
-- G. Structure and grants: draft_order_shortfall_pos is SECURITY INVOKER (RLS
--    and the PO guards apply), VOLATILE, search_path and lock_timeout 5s
--    pinned, EXECUTE to authenticated only; order_line_owed,
--    order_available_to_order and order_shortfall_draftable are IMMUTABLE
--    INVOKER helpers for authenticated and service_role, never anon or
--    PUBLIC. The body carries its floors, takes the reorder drafts' advisory
--    lock (the very key 0366 takes), reads stock only through
--    order_readiness_facts (no function of 0385 names the holdings table:
--    INV-33), refuses only with 22023, 42501, P0001 or P0002 (never
--    40001/40P01), and catches no exception (all or nothing). The two
--    floors core uses answer as core does.
-- F. Floors: signed out 42501; a non-member, another org's manager, a random
--    or null id and a disabled manager the SAME P0002; the orders module or
--    the purchase_orders module off P0001 module_disabled (detail: which);
--    staff WITH a purchase_orders:manage override (manager_required) and a
--    viewer: 42501; a manager whose purchase_orders:manage was revoked: 42501
--    (purchase_orders_manage). No refusal writes a PO or a key, or takes the
--    lock. A manager whose only assignment row is another warehouse, an
--    admin and the owner are answered: there is no warehouse-scoped manager
--    (user_can_access_inventory gives managers every warehouse, 0383 G12), so
--    the warehouse floor refuses no manager today.
-- A. Arguments: the key (required, at most 200 characters); the lines (an
--    array of 1 to 200 objects, a uuid string item and a JSON number above 0
--    after rounding to 4 places, one line per item); an item not on the
--    order (22023 line_not_on_order); an order past picking or closed (P0001
--    readiness_not_applicable, detail the status); a kit, a deleted item, an
--    item of another warehouse and an item the caller cannot read (P0001
--    item_not_draftable, detail {item: refusal}), with nothing written even
--    beside a draftable line.
-- D. Draftable: 10 short; a second buyer's reorder draft (2) and an open PO's
--    remaining (3) reduce it (8, then 5); a cancelled and a received PO do
--    not; another approved order's unheld 4 nets against them (9). Every ask
--    above it is refused with shortfall_changed and the current numbers, and
--    writes NOTHING (mutation: clamp silently); exactly the draftable is
--    drafted, and nothing is left after.
-- S. Selected lines stay selected: 1 of 3 short items gives exactly 1 PO line
--    (mutation: draft every short item).
-- R. Grouping: two suppliers and one item with none give 3 drafts in
--    supplier-id order, the supplier-less last; each a draft created by the
--    caller, notes "Short on SO-… when drafted" only, no destination, charter
--    or expected date, each line at the item's cost; the answer's exact
--    shape; no notification.
-- T. All or nothing: a refusal of the SECOND draft by save_purchase_order_draft
--    (its item's recorded cost below 0: po_line_invalid) aborts the call and
--    leaves no draft and no key (mutation: a per-group exception handler);
--    the same key then succeeds.
-- N. The PO number: live POs numbered ahead of the count (typed on the
--    manual form) are stepped past, a cancelled PO's number is reused, and
--    both drafts of the call get free numbers (mutation: no stepping gives
--    23505 on every try). An item whose supplier is archived is drafted onto
--    that supplier, as recorded (the reorder drafts do the same; the screens
--    name it as archived).
-- I. Idempotency: a replay (4 and 4.0 are the same request; another manager
--    too) returns the first answer with replay true and writes nothing; the
--    key with another request, or for another order: P0001
--    idempotency_conflict; the key row as stored, each draft named by its
--    id only (a viewer reads the row but no PO number or supplier in it),
--    while a replay still answers each draft's number and supplier, read
--    from the PO; a refused call leaves no key and the key can be used again.
-- L. The lock: a successful call holds the reorder drafts' advisory lock
--    until commit; a reorder draft after it leaves the item off (it sees the
--    shortfall draft's line), and the shortfall sees a reorder draft (D).
--    The two-session proof is scripts/db-concurrency/0385_shortfall_race.sh.
-- P. Parity: order_shortfall_draftable equals core's draftable over every
--    case of packages/core/src/orders/readiness-parity-cases.json and its
--    draftable cases (the generated block below; D14, other orders' committed
--    shortfall exactly equal to the supply, added by the review fix).
-- Z. The frozen objects: md5, SECURITY DEFINER, search_path and owner of the
--    functions F2-5 promises not to touch, and fingerprints of ledger.*, the
--    0380/0381/0382 objects, the order, schedule, PO and idempotency policies,
--    the PO triggers and the 0384 column grants.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt); the functions run as `authenticated` with request.jwt.claim.sub.
-- begin/rollback: nothing leaks. Namespace 03850000.

begin;

select plan(54);

\set orgA    '\'03850000-0000-0000-0000-00000000000a\''
\set orgB    '\'03850000-0000-0000-0000-00000000000b\''
\set own     '\'03850000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03850000-0000-0000-0000-0000000000a1\''
\set mgr2    '\'03850000-0000-0000-0000-0000000000a2\''
\set mgrNo   '\'03850000-0000-0000-0000-0000000000a3\''
\set stfPo   '\'03850000-0000-0000-0000-0000000000a4\''
\set vwr     '\'03850000-0000-0000-0000-0000000000a6\''
\set dis     '\'03850000-0000-0000-0000-0000000000a8\''
\set adm     '\'03850000-0000-0000-0000-0000000000a9\''
\set mgrX    '\'03850000-0000-0000-0000-0000000000aa\''
\set mgrB    '\'03850000-0000-0000-0000-0000000000b1\''
\set nobody  '\'03850000-0000-0000-0000-0000000000c1\''
\set whA     '\'03850000-0000-0000-0000-0000000000d1\''
\set whA2    '\'03850000-0000-0000-0000-0000000000d2\''
\set whB     '\'03850000-0000-0000-0000-0000000000d3\''
\set supA1   '\'03850000-0000-0000-0000-0000000000e1\''
\set supA2   '\'03850000-0000-0000-0000-0000000000e2\''
\set supArch '\'03850000-0000-0000-0000-0000000000e3\''
\set iG      '\'03850000-0000-0000-0000-000000000f01\''
\set iS1     '\'03850000-0000-0000-0000-000000000f11\''
\set iS1b    '\'03850000-0000-0000-0000-000000000f12\''
\set iS2     '\'03850000-0000-0000-0000-000000000f13\''
\set iN      '\'03850000-0000-0000-0000-000000000f14\''
\set iP      '\'03850000-0000-0000-0000-000000000f21\''
\set iQ      '\'03850000-0000-0000-0000-000000000f22\''
\set iR      '\'03850000-0000-0000-0000-000000000f23\''
\set iD      '\'03850000-0000-0000-0000-000000000f31\''
\set iKit    '\'03850000-0000-0000-0000-000000000f41\''
\set iDel    '\'03850000-0000-0000-0000-000000000f42\''
\set iMov    '\'03850000-0000-0000-0000-000000000f43\''
\set iHid    '\'03850000-0000-0000-0000-000000000f44\''
\set iOk     '\'03850000-0000-0000-0000-000000000f45\''
\set iAt1    '\'03850000-0000-0000-0000-000000000f51\''
\set iAt2    '\'03850000-0000-0000-0000-000000000f52\''
\set iI      '\'03850000-0000-0000-0000-000000000f61\''
\set iLk     '\'03850000-0000-0000-0000-000000000f71\''
\set iB      '\'03850000-0000-0000-0000-000000000f81\''
\set iNm1    '\'03850000-0000-0000-0000-000000000f91\''
\set iNm2    '\'03850000-0000-0000-0000-000000000f92\''
\set ordGate '\'03850000-0000-0000-0000-000000000101\''
\set ordGrp  '\'03850000-0000-0000-0000-000000000102\''
\set ordSel  '\'03850000-0000-0000-0000-000000000103\''
\set ordD    '\'03850000-0000-0000-0000-000000000104\''
\set ordOth  '\'03850000-0000-0000-0000-000000000105\''
\set ordBad  '\'03850000-0000-0000-0000-000000000106\''
\set ordPick '\'03850000-0000-0000-0000-000000000107\''
\set ordCanc '\'03850000-0000-0000-0000-000000000108\''
\set ordAtom '\'03850000-0000-0000-0000-000000000109\''
\set ordIdem '\'03850000-0000-0000-0000-00000000010a\''
\set ordIdm2 '\'03850000-0000-0000-0000-00000000010b\''
\set ordLk   '\'03850000-0000-0000-0000-00000000010c\''
\set ordNum  '\'03850000-0000-0000-0000-00000000010d\''
\set ordB    '\'03850000-0000-0000-0000-000000000141\''
\set poCanc  '\'03850000-0000-0000-0000-000000000201\''
\set poRecv  '\'03850000-0000-0000-0000-000000000202\''
\set poOpen  '\'03850000-0000-0000-0000-000000000203\''
\set poAh1   '\'03850000-0000-0000-0000-000000000205\''
\set poAh2   '\'03850000-0000-0000-0000-000000000206\''
\set poAhX   '\'03850000-0000-0000-0000-000000000207\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0385-own@test.local',    '{}'::jsonb),
  (:adm,    '0385-adm@test.local',    '{}'::jsonb),
  (:mgr,    '0385-mgr@test.local',    '{}'::jsonb),
  (:mgr2,   '0385-mgr2@test.local',   '{}'::jsonb),
  (:mgrNo,  '0385-mgrno@test.local',  '{}'::jsonb),
  (:mgrX,   '0385-mgrx@test.local',   '{}'::jsonb),
  (:stfPo,  '0385-stfpo@test.local',  '{}'::jsonb),
  (:vwr,    '0385-vwr@test.local',    '{}'::jsonb),
  (:dis,    '0385-dis@test.local',    '{}'::jsonb),
  (:mgrB,   '0385-mgrb@test.local',   '{}'::jsonb),
  (:nobody, '0385-nobody@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders and purchase_orders
-- among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0385 Shortfall A', '0385-shortfall-a'),
  (:orgB, '0385 Shortfall B', '0385-shortfall-b');
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,   'owner',   now()),
  (:orgA, :adm,   'admin',   now()),
  (:orgA, :mgr,   'manager', now()),
  (:orgA, :mgr2,  'manager', now()),
  (:orgA, :mgrNo, 'manager', now()),
  (:orgA, :mgrX,  'manager', now()),
  (:orgA, :stfPo, 'staff',   now()),
  (:orgA, :vwr,   'viewer',  now()),
  (:orgA, :dis,   'manager', now()),
  (:orgB, :mgrB,  'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,  :orgA, '0385 Main',  'WH-0385A',  'active'),
  (:whA2, :orgA, '0385 Annex', 'WH-0385A2', 'active'),
  (:whB,  :orgB, '0385 Other', 'WH-0385B',  'active');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, is_primary) values
  (:orgA, :stfPo, :whA,  true),
  (:orgA, :vwr,   :whA,  true),
  -- A manager whose only assignment row is the annex (F7).
  (:orgA, :mgrX,  :whA2, true);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  -- Staff who may manage purchase orders, but are not managers: the
  -- idempotency_keys_write floor (pattern #4).
  (:orgA, :stfPo, 'purchase_orders:manage', true),
  (:orgA, :mgrNo, 'purchase_orders:manage', false);
insert into public.suppliers (id, organization_id, name, deleted_at) values
  (:supA1,   :orgA, '0385 Supplier One',      null),
  (:supA2,   :orgA, '0385 Supplier Two',      null),
  -- Archived (SuppliersService.archive sets deleted_at and leaves items'
  -- supplier_id as it was).
  (:supArch, :orgA, '0385 Archived Supplier', now());

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, supplier_id, unit_cost, is_bundle, deleted_at) values
  (:iG,   :orgA, :whA,  'X0385-G',   'Gate item',       0, 'active', :supA1, 1.25, false, null),
  (:iS1,  :orgA, :whA,  'X0385-S1',  'Supplier one A',  0, 'active', :supA1, 1.25, false, null),
  (:iS1b, :orgA, :whA,  'X0385-S1B', 'Supplier one B',  0, 'active', :supA1, 3,    false, null),
  (:iS2,  :orgA, :whA,  'X0385-S2',  'Supplier two',    0, 'active', :supA2, 2.5,  false, null),
  (:iN,   :orgA, :whA,  'X0385-N',   'No supplier',     0, 'active', null,   0,    false, null),
  (:iP,   :orgA, :whA,  'X0385-P',   'Pick P',          0, 'active', :supA1, 1,    false, null),
  (:iQ,   :orgA, :whA,  'X0385-Q',   'Pick Q',          0, 'active', :supA1, 1,    false, null),
  (:iR,   :orgA, :whA,  'X0385-R',   'Pick R',          0, 'active', :supA1, 1,    false, null),
  (:iD,   :orgA, :whA,  'X0385-D',   'Draftable item',  2, 'active', :supA1, 4,    false, null),
  (:iKit, :orgA, :whA,  'X0385-KIT', 'Kit stock',       0, 'active', :supA1, 9,    true,  null),
  (:iDel, :orgA, :whA,  'X0385-DEL', 'Deleted item',    0, 'active', :supA1, 1,    false, now()),
  (:iMov, :orgA, :whA2, 'X0385-MOV', 'Moved item',      0, 'active', :supA1, 1,    false, null),
  -- No warehouse: no member reads it (inventory_items_select), a manager
  -- included, so readiness has no numbers for it.
  (:iHid, :orgA, null,  'X0385-HID', 'Hidden item',     0, 'active', :supA1, 1,    false, null),
  (:iOk,  :orgA, :whA,  'X0385-OK',  'Fine item',       0, 'active', :supA1, 1,    false, null),
  (:iAt1, :orgA, :whA,  'X0385-AT1', 'Atomic one',      0, 'active', :supA1, 1,    false, null),
  (:iAt2, :orgA, :whA,  'X0385-AT2', 'Atomic two',      0, 'active', :supA2, 1,    false, null),
  (:iI,   :orgA, :whA,  'X0385-I',   'Idempotent item', 0, 'active', :supA1, 1,    false, null),
  (:iLk,  :orgA, :whA,  'X0385-LK',  'Lock item',       0, 'active', :supA1, 1,    false, null),
  (:iNm1, :orgA, :whA,  'X0385-NM1', 'Number one',      0, 'active', :supA1,   1,  false, null),
  (:iNm2, :orgA, :whA,  'X0385-NM2', 'Number two',      0, 'active', :supArch, 1,  false, null),
  (:iB,   :orgB, :whB,  'X0385-B',   'Org B item',      0, 'active', null,   1,    false, null);

insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:ordGate, :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordGrp,  :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordSel,  :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordD,    :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  -- Pending at first (not committed); approved in D4.
  (:ordOth,  :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordBad,  :orgA, :whA, 'approved',         'internal', :stfPo, 'pickup'),
  (:ordPick, :orgA, :whA, 'picking_complete', 'internal', :stfPo, 'pickup'),
  (:ordCanc, :orgA, :whA, 'cancelled',        'internal', :stfPo, 'pickup'),
  (:ordAtom, :orgA, :whA, 'backordered',      'internal', :stfPo, 'pickup'),
  (:ordIdem, :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordIdm2, :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordLk,   :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordNum,  :orgA, :whA, 'pending_approval', 'internal', :stfPo, 'pickup'),
  (:ordB,    :orgB, :whB, 'pending_approval', 'internal', :mgrB,  'pickup');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested, created_at) values
  (:ordGate, :iG,   100, '2026-09-01 10:00:00+00'),
  (:ordGrp,  :iS1,  5,   '2026-09-01 10:00:00+00'),
  (:ordGrp,  :iS1b, 2,   '2026-09-01 10:00:01+00'),
  (:ordGrp,  :iS2,  4,   '2026-09-01 10:00:02+00'),
  (:ordGrp,  :iN,   3,   '2026-09-01 10:00:03+00'),
  (:ordSel,  :iP,   2,   '2026-09-01 10:00:00+00'),
  (:ordSel,  :iQ,   3,   '2026-09-01 10:00:01+00'),
  (:ordSel,  :iR,   4,   '2026-09-01 10:00:02+00'),
  (:ordD,    :iD,   12,  '2026-09-01 10:00:00+00'),
  (:ordOth,  :iD,   4,   '2026-09-01 10:00:00+00'),
  (:ordBad,  :iKit, 1,   '2026-09-01 10:00:00+00'),
  (:ordBad,  :iDel, 1,   '2026-09-01 10:00:01+00'),
  (:ordBad,  :iMov, 1,   '2026-09-01 10:00:02+00'),
  (:ordBad,  :iHid, 1,   '2026-09-01 10:00:03+00'),
  (:ordBad,  :iOk,  1,   '2026-09-01 10:00:04+00'),
  (:ordPick, :iOk,  1,   '2026-09-01 10:00:00+00'),
  (:ordCanc, :iOk,  1,   '2026-09-01 10:00:00+00'),
  (:ordAtom, :iAt1, 2,   '2026-09-01 10:00:00+00'),
  (:ordAtom, :iAt2, 2,   '2026-09-01 10:00:01+00'),
  (:ordIdem, :iI,   6,   '2026-09-01 10:00:00+00'),
  (:ordIdm2, :iI,   1,   '2026-09-01 10:00:00+00'),
  (:ordLk,   :iLk,  5,   '2026-09-01 10:00:00+00'),
  (:ordNum,  :iNm1, 2,   '2026-09-01 10:00:00+00'),
  (:ordNum,  :iNm2, 2,   '2026-09-01 10:00:01+00'),
  (:ordB,    :iB,   1,   '2026-09-01 10:00:00+00');

-- A cancelled and a fully received PO for the draftable item: neither is
-- supply, neither blocks a draft.
insert into public.purchase_orders (id, organization_id, po_number, supplier_id, status) values
  (:poCanc, :orgA, 'PO-0385-CANC', :supA1, 'cancelled'),
  (:poRecv, :orgA, 'PO-0385-RECV', :supA1, 'received');
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:orgA, :poCanc, :iD, 50, 0,  4),
  (:orgA, :poRecv, :iD, 50, 50, 4);

-- The disabled manager, disabled the way the service does it.
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
-- A draft call as SQL text.
create function pg_temp.draft(p_order uuid, p_lines text, p_key text) returns text language sql as $$
  select format('select public.draft_order_shortfall_pos(%L, %L::jsonb, %L)', p_order, p_lines, p_key)
$$;
-- One line, as JSON text.
create function pg_temp.l1(p_item uuid, p_qty text) returns text language sql as $$
  select format('[{"item_id": "%s", "quantity": %s}]', p_item, p_qty)
$$;
create function pg_temp.pos() returns int language sql as $$
  select count(*)::int from public.purchase_orders
   where organization_id in ('03850000-0000-0000-0000-00000000000a', '03850000-0000-0000-0000-00000000000b')
$$;
create function pg_temp.keys() returns int language sql as $$
  select count(*)::int from public.idempotency_keys
   where organization_id in ('03850000-0000-0000-0000-00000000000a', '03850000-0000-0000-0000-00000000000b')
$$;
-- Whether THIS session holds the reorder drafts' advisory lock for an org
-- (0366: hashtextextended('save_purchase_order_draft:reorder:' || org, 0)).
create function pg_temp.lock_held(p_org uuid) returns boolean language sql as $$
  select exists (
    select 1 from pg_locks k
     where k.locktype = 'advisory'
       and k.pid = pg_backend_pid()
       and k.granted
       and ((k.classid::bigint << 32) | k.objid::bigint)
           = hashtextextended('save_purchase_order_draft:reorder:' || p_org::text, 0))
$$;
-- What may be drafted per item for an order, as the caller.
create function pg_temp.draftable(p_order uuid) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(c.key, c.value->'draftable'), '{}'::jsonb)
    from jsonb_each(public.order_shortfall_draftable(public.order_readiness_facts(p_order))) c
$$;

create temp table fx (who text not null, r text);
create temp table ans (who text primary key, r jsonb);
create temp table dp_case (case_id text primary key, facts jsonb not null, expected jsonb not null);
grant all on fx, ans to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
       where o.organization_id in ('03850000-0000-0000-0000-00000000000a', '03850000-0000-0000-0000-00000000000b')) <> 25 then
    raise exception 'fixture: lines';
  end if;
  if not public.module_enabled('03850000-0000-0000-0000-00000000000a', 'purchase_orders')
     or not public.module_enabled('03850000-0000-0000-0000-00000000000a', 'orders') then
    raise exception 'fixture: modules';
  end if;
end $$;

select pg_temp.pos() as "pos0" \gset

-- ═══ G. Structure and grants ══════════════════════════════════════════════
select ok(
  (select not p.prosecdef and p.provolatile = 'v'
          and p.proconfig @> array['search_path=public, pg_temp', 'lock_timeout=5s']
     from pg_proc p where p.oid = 'public.draft_order_shortfall_pos(uuid, jsonb, text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.draft_order_shortfall_pos(uuid, jsonb, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.draft_order_shortfall_pos(uuid, jsonb, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.draft_order_shortfall_pos(uuid, jsonb, text)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, unnest(p.proacl) a
                   where p.oid = 'public.draft_order_shortfall_pos(uuid, jsonb, text)'::regprocedure
                     and a::text like '=%'),
  'G1: draft_order_shortfall_pos is SECURITY INVOKER (RLS and the PO guards apply), VOLATILE, search_path and lock_timeout 5s pinned; EXECUTE to authenticated only (not anon, service_role or PUBLIC)');
select is(
  (select string_agg(p.proname || '=' || p.provolatile::text || '/' || p.prosecdef || '/' || coalesce(p.proconfig::text, '')
                     || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || '/' || exists (select 1 from unnest(p.proacl) a where a::text like '=%'), ', ' order by p.proname)
     from pg_proc p
    where p.oid in ('public.order_line_owed(numeric, numeric)'::regprocedure,
                    'public.order_available_to_order(numeric, numeric)'::regprocedure,
                    'public.order_shortfall_draftable(jsonb)'::regprocedure)),
  'order_available_to_order=i/false/{search_path=public}/true/true/false/false, '
  'order_line_owed=i/false/{search_path=public}/true/true/false/false, '
  'order_shortfall_draftable=i/false/{search_path=public}/true/true/false/false',
  'G2: the helpers are IMMUTABLE and SECURITY INVOKER with search_path pinned, EXECUTE to authenticated and service_role, never anon or PUBLIC');
select ok(
  (select p.prosrc ~ 'auth\.uid\(\)'
          and p.prosrc ~ 'is_org_member\(v_org\)'
          and p.prosrc ~ $re$module_enabled\(v_org, 'orders'\)$re$
          and p.prosrc ~ $re$module_enabled\(v_org, 'purchase_orders'\)$re$
          and p.prosrc ~ $re$has_org_role\(v_org, 'manager'\)$re$
          and p.prosrc ~ $re$has_permission\(v_org, 'purchase_orders:manage'\)$re$
          and p.prosrc ~ $re$user_can_access_inventory\(v_uid, v_wh, null, 'write'\)$re$
          and p.prosrc ~ 'public\.order_readiness_facts\(p_order_id\)'
          and p.prosrc ~ 'public\.order_shortfall_draftable\(v_facts\)'
          and p.prosrc ~ 'public\.next_po_number\(v_org\)'
          and p.prosrc ~ 'public\.save_purchase_order_draft\('
          and p.prosrc !~ '40001|40P01'
          and p.prosrc !~* '\mexception\s+when\M'
     from pg_proc p where p.oid = 'public.draft_order_shortfall_pos(uuid, jsonb, text)'::regprocedure),
  'G3: its floors are in its own body (signed in, member, both modules, manager, purchase_orders:manage, warehouse write), it recomputes from order_readiness_facts, drafts through next_po_number and save_purchase_order_draft, never raises 40001/40P01, and catches no exception (all or nothing: mutation, a per-group handler)');
select is(
  (select array_agg(distinct m[1] order by m[1])
     from pg_proc p, regexp_matches(p.prosrc, $re$errcode\s*=\s*'([^']+)'$re$, 'g') m
    where p.oid = 'public.draft_order_shortfall_pos(uuid, jsonb, text)'::regprocedure),
  array['22023', '42501', 'P0001', 'P0002'],
  'G4: it refuses only with 22023, 42501, P0001 or P0002');
select is(
  (select array_agg(p.proname::text || ':' || (regexp_match(p.prosrc, $re$hashtextextended\(\s*'(save_purchase_order_draft:reorder:)'\s*\|\|\s*[a-z_]+::text,\s*0\)$re$))[1]
                    order by p.proname)
     from pg_proc p
    where p.oid in ('public.draft_order_shortfall_pos(uuid, jsonb, text)'::regprocedure,
                    'public.save_purchase_order_draft(uuid, uuid, text, uuid, uuid, uuid, timestamptz, text, jsonb, uuid[], uuid, boolean)'::regprocedure)),
  array['draft_order_shortfall_pos:save_purchase_order_draft:reorder:', 'save_purchase_order_draft:save_purchase_order_draft:reorder:'],
  'G5: it takes the reorder drafts'' advisory lock, the very key save_purchase_order_draft takes (0366), so shortfall and reorder drafts of an org run one at a time');
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p
    where p.proname in ('draft_order_shortfall_pos', 'order_shortfall_draftable', 'order_line_owed', 'order_available_to_order')
      and regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') ~* '\mitem_stock_levels\M'),
  '',
  'G6: no function of 0385 names the holdings table (INV-33): stock numbers come from order_readiness_facts');
select is(
  array[public.order_line_owed(10, 4), public.order_line_owed(4, 10), public.order_line_owed(null, 2),
        public.order_line_owed(5, null), public.order_line_owed(0.3, 0.1),
        public.order_available_to_order(10, 3), public.order_available_to_order(3, 10),
        public.order_available_to_order(null, null), public.order_available_to_order(7.5, null)],
  array[6, 0, 0, 5, 0.2, 7, 0, 0, 7.5]::numeric[],
  'G7: order_line_owed and order_available_to_order are greatest(a - b, 0) with nulls as 0 (core lineOwedUnits and available)');

-- ═══ F. Floors ════════════════════════════════════════════════════════════
select ok(not pg_temp.lock_held(:orgA), 'L1: before any draft this session holds no reorder lock for the org');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to '';
select is(
  pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-1')),
  '42501::unauthenticated',
  'F1: no signed-in caller: 42501 unauthenticated');
reset role;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :nobody;
insert into fx select 'nobody', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-2'));
set local "request.jwt.claim.sub" to :mgrB;
insert into fx select 'mgrB', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-2'));
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'random', pg_temp.err(pg_temp.draft(gen_random_uuid(), pg_temp.l1(:iG, '1'), 'f-2'));
insert into fx select 'null', pg_temp.err($$select public.draft_order_shortfall_pos(null, '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": 1}]'::jsonb, 'f-2')$$);
insert into fx select 'mgrA on B', pg_temp.err(pg_temp.draft(:ordB, pg_temp.l1(:iB, '1'), 'f-2'));
set local "request.jwt.claim.sub" to :dis;
insert into fx select 'disabled', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-2'));
reset role;
select is(
  (select array_agg(distinct r) from fx),
  array['P0002::order_request_not_found'],
  'F2: a non-member, another org''s manager, a random id, a null id, org A''s manager on org B''s order and a disabled manager all get the SAME P0002 order_request_not_found');
delete from fx;

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'orders', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-3'))
                                 || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-3'));
reset role;
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'purchase_orders';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'purchase_orders', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-3'))
                                 || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-3'));
reset role;
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'purchase_orders';
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'orders=P0001:module_disabled:module_disabled / orders, purchase_orders=P0001:module_disabled:module_disabled / purchase_orders',
  'F3: the orders module off, or the purchase_orders module off: P0001 module_disabled, the detail naming the module');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :stfPo;
insert into fx select 'stfPo', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-4'));
set local "request.jwt.claim.sub" to :vwr;
insert into fx select 'vwr', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-4'));
set local "request.jwt.claim.sub" to :mgrNo;
insert into fx select 'mgrNo', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-4'));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who in ('stfPo', 'vwr')),
  'stfPo=42501:manager_required:forbidden, vwr=42501:manager_required:forbidden',
  'F4: staff WITH a purchase_orders:manage override (not a manager: idempotency_keys_write is manager-only, pattern #4) and a viewer get 42501 forbidden, hint manager_required');
select is(
  (select r from fx where who = 'mgrNo'),
  '42501:purchase_orders_manage:forbidden',
  'F5: a manager whose purchase_orders:manage was revoked gets 42501 forbidden, hint purchase_orders_manage');
delete from fx;
select is(
  pg_temp.pos() || '/' || pg_temp.keys() || '/' || pg_temp.lock_held(:orgA),
  :pos0 || '/0/false',
  'F6: no refusal wrote a purchase order or an idempotency key, or took the reorder lock (every floor comes first)');

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgrX;
insert into fx select 'mgrX', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-7a'));
set local "request.jwt.claim.sub" to :adm;
insert into fx select 'adm', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-7b'));
set local "request.jwt.claim.sub" to :own;
insert into fx select 'own', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), 'f-7c'));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'adm=no error, mgrX=no error, own=no error',
  'F7: a manager whose only assignment row is another warehouse (managers write every warehouse: no warehouse-scoped manager exists, 0383 G12), an admin and the owner draft');
delete from fx;
select ok(pg_temp.lock_held(:orgA), 'L2: a successful draft holds the reorder drafts'' advisory lock to commit');
select is(
  (select string_agg(p.created_by::text, ',' order by p.created_by)
     from public.purchase_orders p where p.organization_id = :orgA and p.notes like 'Short on %'),
  :own || ',' || :adm || ',' || :mgrX,
  'F8: each of those drafts is recorded as created by its caller (the 0364 guard stamps auth.uid())');

-- ═══ A. Arguments ═════════════════════════════════════════════════════════
select pg_temp.pos() as "posA" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'key null',  pg_temp.err(format('select public.draft_order_shortfall_pos(%L, %L::jsonb, null)', :ordGate, pg_temp.l1(:iG, '1')));
insert into fx select 'key blank', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), '   '));
insert into fx select 'key 201',   pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iG, '1'), repeat('k', 201)));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'key 201=22023:idempotency_key_too_long:idempotency_key_too_long, key blank=22023:idempotency_key_required:idempotency_key_required, key null=22023:idempotency_key_required:idempotency_key_required',
  'A1: the idempotency key is required (null or blank) and at most 200 characters');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx (who, r)
select v.who, pg_temp.err(pg_temp.draft(:ordGate, v.lines, 'a-2'))
  from (values
    ('01 null',          'null'),
    ('02 object',        '{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": 1}'),
    ('03 empty',         '[]'),
    ('04 201 lines',     (select jsonb_agg(jsonb_build_object('item_id', gen_random_uuid(), 'quantity', 1))::text
                            from generate_series(1, 201))),
    ('05 not an object', '["03850000-0000-0000-0000-000000000f01"]'),
    ('06 item a number', '[{"item_id": 5, "quantity": 1}]'),
    ('07 item not uuid', '[{"item_id": "not-a-uuid", "quantity": 1}]'),
    ('08 qty a string',  '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": "5"}]'),
    ('09 qty NaN',       '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": "NaN"}]'),
    ('10 qty 0',         '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": 0}]'),
    ('11 qty negative',  '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": -1}]'),
    ('12 qty rounds 0',  '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": 0.00004}]'),
    ('13 qty missing',   '[{"item_id": "03850000-0000-0000-0000-000000000f01"}]'),
    ('14 item twice',    '[{"item_id": "03850000-0000-0000-0000-000000000f01", "quantity": 1}, {"item_id": "03850000-0000-0000-0000-000000000F01", "quantity": 2}]')
  ) v(who, lines);
reset role;
select is(
  (select coalesce(string_agg(who || '=' || r, ', ' order by who), '')
     from fx where r <> '22023:line_invalid:line_invalid'),
  '',
  'A2: lines that are null, an object, empty, 201 long, not objects, an item that is not a uuid string, a quantity that is a string, "NaN", 0, negative, rounds to 0 or is missing, and one item twice (any case): each 22023 line_invalid');
select is((select count(*)::int from fx), 14, 'A2b: all 14 malformed requests were tried');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'not on order', pg_temp.err(pg_temp.draft(:ordGate, pg_temp.l1(:iS2, '1'), 'a-3'))
                               || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordGate, pg_temp.l1(:iS2, '1'), 'a-3'));
insert into fx select 'picking_complete', pg_temp.err(pg_temp.draft(:ordPick, pg_temp.l1(:iOk, '1'), 'a-4'))
                               || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordPick, pg_temp.l1(:iOk, '1'), 'a-4'));
insert into fx select 'cancelled', pg_temp.err(pg_temp.draft(:ordCanc, pg_temp.l1(:iOk, '1'), 'a-5'))
                               || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordCanc, pg_temp.l1(:iOk, '1'), 'a-5'));
reset role;
select is(
  (select r from fx where who = 'not on order'),
  '22023:line_not_on_order:line_not_on_order / ' || :iS2,
  'A3: an item that is not on the order: 22023 line_not_on_order, detail the item');
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx where who in ('picking_complete', 'cancelled')),
  'cancelled=P0001:readiness_not_applicable:readiness_not_applicable / cancelled, picking_complete=P0001:readiness_not_applicable:readiness_not_applicable / picking_complete',
  'A4: an order already picked, or closed, has no shortfall to draft: P0001 readiness_not_applicable, detail the status');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx (who, r)
select v.who, pg_temp.err(pg_temp.draft(:ordBad, pg_temp.l1(v.item, '1'), 'a-6')) || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordBad, pg_temp.l1(v.item, '1'), 'a-6'))
  from (values ('1 kit', :iKit::uuid), ('2 deleted', :iDel::uuid), ('3 moved', :iMov::uuid), ('4 hidden', :iHid::uuid)) v(who, item);
insert into fx select '5 kit beside a draftable line',
  pg_temp.err(pg_temp.draft(:ordBad, format('[{"item_id": "%s", "quantity": 1}, {"item_id": "%s", "quantity": 1}]', :iOk, :iKit), 'a-7'));
reset role;
select is(
  (select string_agg(who || '=' || r, E'\n' order by who) from fx),
  '1 kit=P0001:item_not_draftable:item_not_draftable / {"' || :iKit || E'": "kit_stock"}\n'
  '2 deleted=P0001:item_not_draftable:item_not_draftable / {"' || :iDel || E'": "item_deleted"}\n'
  '3 moved=P0001:item_not_draftable:item_not_draftable / {"' || :iMov || E'": "item_moved"}\n'
  '4 hidden=P0001:item_not_draftable:item_not_draftable / {"' || :iHid || E'": "not_visible"}\n'
  '5 kit beside a draftable line=P0001:item_not_draftable:item_not_draftable',
  'A5: a kit''s stock, a deleted item, an item that belongs to another warehouse and an item the caller cannot read: P0001 item_not_draftable, detail {item: why}; beside a draftable line too');
select is(pg_temp.pos(), :posA,
  'A6: no argument refusal wrote a purchase order (the draftable line beside the kit was not drafted either)');
delete from fx;

-- ═══ D. Draftable (ordD: 12 owed, 2 on hand, nothing held) ═══════════════
select pg_temp.pos() as "posD" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'D1 ask 11', pg_temp.err(pg_temp.draft(:ordD, pg_temp.l1(:iD, '11'), 'd-1'))
                           || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordD, pg_temp.l1(:iD, '11'), 'd-1'));
reset role;
select is(
  (select r from fx where who = 'D1 ask 11'),
  'P0001:shortfall_changed:shortfall_changed / {"' || :iD || '": 10}',
  'D1: 10 short (12 owed, 2 on hand; a cancelled and a received PO are not supply): asking 11 is refused with shortfall_changed and the current draftable, never clamped to 10');

-- Another buyer's reorder draft (the "Draft PO from suggestions" path).
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr2;
insert into ans select 'reorder', public.save_purchase_order_draft(
  :orgA, null, 'PO-0385-REORDER', :supA1, null, null, null, 'reorder', format('[{"item_id": "%s", "quantity_ordered": 2, "unit_cost": 4}]', :iD)::jsonb,
  '{}'::uuid[], null, true);
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'D2 ask 9', pg_temp.err(pg_temp.draft(:ordD, pg_temp.l1(:iD, '9'), 'd-2'))
                          || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordD, pg_temp.l1(:iD, '9'), 'd-2'));
reset role;
select is(
  (select (ans.r->>'id' is not null)::text from ans where who = 'reorder') || ' ' || (select r from fx where who = 'D2 ask 9'),
  'true P0001:shortfall_changed:shortfall_changed / {"' || :iD || '": 8}',
  'D2: another buyer''s reorder draft of 2 counts against it (8): drafts are never supply, but block drafting again');

-- An open PO: 5 ordered, 2 received, 3 still to arrive.
insert into public.purchase_orders (id, organization_id, po_number, supplier_id, status) values
  (:poOpen, :orgA, 'PO-0385-OPEN', :supA1, 'ordered');
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:orgA, :poOpen, :iD, 5, 2, 4);
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'D3 ask 6', pg_temp.err(pg_temp.draft(:ordD, pg_temp.l1(:iD, '6'), 'd-3'))
                          || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordD, pg_temp.l1(:iD, '6'), 'd-3'));
reset role;
select is(
  (select r from fx where who = 'D3 ask 6'),
  'P0001:shortfall_changed:shortfall_changed / {"' || :iD || '": 5}',
  'D3: an open PO''s 3 still to arrive count too (5)');

-- Another order commits to the item: approved, 4 owed, nothing held.
update public.order_requests set status = 'approved' where id = :ordOth;
-- (Approving it notifies; drafting must not: R5 counts from here.)
select count(*) as "notes1" from public.notifications where organization_id = :orgA \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'D4 ask 10', pg_temp.err(pg_temp.draft(:ordD, pg_temp.l1(:iD, '10'), 'd-4'))
                           || ' / ' || pg_temp.err_detail(pg_temp.draft(:ordD, pg_temp.l1(:iD, '10'), 'd-4'));
reset role;
select is(
  (select r from fx where who = 'D4 ask 10'),
  'P0001:shortfall_changed:shortfall_changed / {"' || :iD || '": 9}',
  'D4: netted against other orders'' committed shortfall (4 owed on an approved order with nothing held): 10 - max(0, 3 + 2 - 4) = 9');
select is(
  pg_temp.pos() || '/' || (select count(*) from public.purchase_order_items i join public.purchase_orders p on p.id = i.purchase_order_id
                            where p.organization_id = :orgA and p.notes like 'Short on %' and i.item_id = :iD),
  (:posD + 2) || '/0',
  'D5: every ask above the draftable wrote nothing (only the fixture''s reorder draft and open PO are new): never clamped');
delete from fx;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'D6', public.draft_order_shortfall_pos(:ordD, pg_temp.l1(:iD, '9')::jsonb, 'd-6');
insert into fx select 'D6 after', pg_temp.draftable(:ordD)::text;
reset role;
select is(
  (select jsonb_build_object(
            'lines', (select jsonb_agg(jsonb_build_object('item', i.item_id, 'qty', i.quantity_ordered))
                        from public.purchase_order_items i
                       where i.purchase_order_id = ((select r from ans where who = 'D6')->'created'->0->>'purchaseOrderId')::uuid),
            'after', (select r::jsonb from fx where who = 'D6 after'))),
  jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('item', :iD, 'qty', 9)),
                     'after', jsonb_build_object(:iD, 0)),
  'D6: exactly the draftable (9) is drafted, on one line, and nothing is left to draft');
delete from fx;

-- ═══ S. Selected lines stay selected ══════════════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'S', public.draft_order_shortfall_pos(:ordSel, pg_temp.l1(:iQ, '3')::jsonb, 's-1');
insert into fx select 'S after', pg_temp.draftable(:ordSel)::text;
reset role;
select is(
  (select jsonb_build_object(
            'pos', jsonb_array_length(r->'created'),
            'lines', (select jsonb_agg(jsonb_build_object('item', i.item_id, 'qty', i.quantity_ordered))
                        from public.purchase_order_items i
                       where i.purchase_order_id = (r->'created'->0->>'purchaseOrderId')::uuid),
            'after', (select f.r::jsonb from fx f where f.who = 'S after'))
     from ans where who = 'S'),
  jsonb_build_object('pos', 1,
                     'lines', jsonb_build_array(jsonb_build_object('item', :iQ, 'qty', 3)),
                     'after', jsonb_build_object(:iP, 2, :iQ, 0, :iR, 4)),
  'S1: 1 of 3 short items selected gives exactly 1 PO with exactly that line; the other two stay draftable (mutation: draft every short item)');
delete from fx;

-- ═══ R. Grouping (ordGrp: supplier one x2, supplier two, no supplier) ═════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'R', public.draft_order_shortfall_pos(:ordGrp,
  format('[{"item_id": "%s", "quantity": 3}, {"item_id": "%s", "quantity": 4}, {"item_id": "%s", "quantity": 2}, {"item_id": "%s", "quantity": 5}]',
         :iN, :iS2, :iS1b, :iS1)::jsonb, 'r-1');
reset role;
select is(
  (select jsonb_agg(jsonb_build_object('supplier', c->'supplierId', 'lines', c->'lines', 'lineCount', c->'lineCount', 'units', c->'units') order by o)
     from ans, jsonb_array_elements(ans.r->'created') with ordinality e(c, o) where ans.who = 'R'),
  jsonb_build_array(
    jsonb_build_object('supplier', :supA1, 'lineCount', 2, 'units', 7,
                       'lines', jsonb_build_array(jsonb_build_object('itemId', :iS1, 'quantity', 5), jsonb_build_object('itemId', :iS1b, 'quantity', 2))),
    jsonb_build_object('supplier', :supA2, 'lineCount', 1, 'units', 4,
                       'lines', jsonb_build_array(jsonb_build_object('itemId', :iS2, 'quantity', 4))),
    jsonb_build_object('supplier', null, 'lineCount', 1, 'units', 3,
                       'lines', jsonb_build_array(jsonb_build_object('itemId', :iN, 'quantity', 3)))),
  'R1: two suppliers and an item with none give 3 drafts, in supplier-id order with the supplier-less one last, each with exactly its items');
select is(
  (select string_agg(concat_ws('|', p.status, p.created_by = :mgr, p.updated_by = :mgr, p.notes,
                               p.destination_location_id is null and p.charter_id is null and p.expected_at is null,
                               coalesce(p.supplier_id::text, 'none'), p.subtotal, p.total,
                               p.po_number = c->>'poNumber'), E'\n' order by o)
     from ans, jsonb_array_elements(ans.r->'created') with ordinality e(c, o)
     join public.purchase_orders p on p.id = (c->>'purchaseOrderId')::uuid
    where ans.who = 'R'),
  (select string_agg(x, E'\n') from (values
     (concat_ws('|', 'draft', true, true, 'Short on SO-' || lpad((select order_number::text from public.order_requests where id = :ordGrp), 6, '0') || ' when drafted', true, :supA1, 12.2500, 12.2500, true)),
     (concat_ws('|', 'draft', true, true, 'Short on SO-' || lpad((select order_number::text from public.order_requests where id = :ordGrp), 6, '0') || ' when drafted', true, :supA2, 10.0000, 10.0000, true)),
     (concat_ws('|', 'draft', true, true, 'Short on SO-' || lpad((select order_number::text from public.order_requests where id = :ordGrp), 6, '0') || ' when drafted', true, 'none', 0.0000, 0.0000, true))) v(x)),
  'R2: each is a draft created by the caller, its notes only "Short on SO-… when drafted", with no destination, charter or expected date, and totals from the items'' costs');
select is(
  (select string_agg(i.item_id::text || '=' || i.quantity_ordered || '@' || i.unit_cost || '/' || i.quantity_received, ', ' order by i.item_id)
     from ans, jsonb_array_elements(ans.r->'created') e(c)
     join public.purchase_order_items i on i.purchase_order_id = (c->>'purchaseOrderId')::uuid
    where ans.who = 'R'),
  :iS1 || '=5.0000@1.2500/0.0000, ' || :iS1b || '=2.0000@3.0000/0.0000, ' || :iS2 || '=4.0000@2.5000/0.0000, ' || :iN || '=3.0000@0.0000/0.0000',
  'R3: every line is at the item''s own cost, nothing received');
select is(
  (select jsonb_build_object(
            'keys', (select jsonb_agg(k order by k) from jsonb_object_keys(r) k),
            'created', (select jsonb_agg(k order by k) from jsonb_object_keys(r->'created'->0) k),
            'orderId', r->'orderId', 'replay', r->'replay',
            'orderNumber', (r->'orderNumber') = to_jsonb((select order_number from public.order_requests where id = :ordGrp)),
            'numbers', (select bool_and(c->>'poNumber' like 'PO-%') from jsonb_array_elements(r->'created') c))
     from ans where who = 'R'),
  jsonb_build_object(
    'keys', jsonb_build_array('created', 'orderId', 'orderNumber', 'replay'),
    'created', jsonb_build_array('lineCount', 'lines', 'poNumber', 'purchaseOrderId', 'supplierId', 'units'),
    'orderId', :ordGrp, 'replay', false, 'orderNumber', true, 'numbers', true),
  'R4: the answer is exactly {orderId, orderNumber, created: [{purchaseOrderId, poNumber, supplierId, lineCount, units, lines}], replay: false}: ids and numbers, no cost or name');

-- ═══ T. All or nothing ════════════════════════════════════════════════════
-- The SECOND draft of ordAtom (supplier two) is refused by
-- save_purchase_order_draft: its item's recorded cost is below 0, which the
-- save refuses (po_line_invalid) and nothing before it checks. The first
-- draft (supplier one) is written, then the second fails. (Until the review
-- fix this took the second draft's PO number instead; the number is now
-- stepped past numbers live POs carry, section N.)
select pg_temp.pos() as "posT" \gset
update public.inventory_items set unit_cost = -1 where id = :iAt2;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'T1', pg_temp.err(pg_temp.draft(:ordAtom,
  format('[{"item_id": "%s", "quantity": 2}, {"item_id": "%s", "quantity": 2}]', :iAt1, :iAt2), 't-1'));
reset role;
select is(
  (select left(r, 24) from fx where who = 'T1'),
  '22023:po_line_invalid:Ea',
  'T1: a refusal of the second draft (supplier two) by save_purchase_order_draft aborts the call');
select is(
  pg_temp.pos() || '/' || (select count(*) from public.purchase_order_items where item_id in (:iAt1, :iAt2))
    || '/' || (select count(*) from public.idempotency_keys where organization_id = :orgA and key = 't-1'),
  :posT || '/0/0',
  'T2: the first draft (supplier one) was rolled back with it, and so was the key: all or nothing (mutation: a per-group exception handler keeps the first)');
update public.inventory_items set unit_cost = 1 where id = :iAt2;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'T3', public.draft_order_shortfall_pos(:ordAtom,
  format('[{"item_id": "%s", "quantity": 2}, {"item_id": "%s", "quantity": 2}]', :iAt1, :iAt2)::jsonb, 't-1');
reset role;
select is(
  (select jsonb_array_length(r->'created') || '/' || (r->>'replay') from ans where who = 'T3'),
  '2/false',
  'T3: once the cause is fixed, the same key drafts both (a retry after a failure is safe)');
delete from fx;

-- ═══ N. The PO number (ordNum: supplier one, and the archived supplier) ═══
-- Three POs numbered ahead of the count, as the manual form allows: two live
-- (ordered, draft) and a cancelled one. next_po_number gives count + 1.
select (select count(*) from public.purchase_orders where organization_id = :orgA) as "cntN" \gset
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:poAh1, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 4)::text, 4, '0'), 'ordered'),
  (:poAh2, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 5)::text, 4, '0'), 'draft'),
  (:poAhX, :orgA, 'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 6)::text, 4, '0'), 'cancelled');
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'N1', pg_temp.err(pg_temp.draft(:ordNum,
  format('[{"item_id": "%s", "quantity": 2}, {"item_id": "%s", "quantity": 2}]', :iNm1, :iNm2), 'n-1'));
insert into fx select 'N1 again', pg_temp.err(pg_temp.draft(:ordNum,
  format('[{"item_id": "%s", "quantity": 2}, {"item_id": "%s", "quantity": 2}]', :iNm1, :iNm2), 'n-2'));
reset role;
select is(
  (select r from fx where who = 'N1'),
  'no error',
  'N1: live POs numbered ahead of the count do not block the draft (mutation: no stepping, 23505 on every try)');
select is(
  (select string_agg(p.po_number || '=' || coalesce(p.supplier_id::text, 'none'), ', ' order by p.po_number)
     from public.purchase_orders p
    where p.organization_id = :orgA
      and p.notes = 'Short on SO-' || lpad((select order_number::text from public.order_requests where id = :ordNum), 6, '0') || ' when drafted'),
  'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 6)::text, 4, '0') || '=' || :supA1 || ', '
    || 'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 7)::text, 4, '0') || '=' || :supArch,
  'N2: the first draft steps past two live numbers to the cancelled PO''s (free), the second past the first; the archived supplier''s item goes on a draft for that supplier, as recorded');
select is(
  (select r from fx where who = 'N1 again'),
  'P0001:shortfall_changed:shortfall_changed',
  'N3: and nothing is left to draft (the numbers moved, the shortfall did not)');
select is(
  (select string_agg(p.po_number || '/' || p.status, ', ' order by p.po_number)
     from public.purchase_orders p where p.id in (:poAh1, :poAh2, :poAhX)),
  'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 4)::text, 4, '0') || '/ordered, '
    || 'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 5)::text, 4, '0') || '/draft, '
    || 'PO-' || to_char(now(), 'YYYY') || '-' || lpad((:cntN + 6)::text, 4, '0') || '/cancelled',
  'N4: the POs it stepped past are untouched');
delete from fx;

-- ═══ I. Idempotency (ordIdem: 6 owed of iI) ═══════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'I1', public.draft_order_shortfall_pos(:ordIdem, pg_temp.l1(:iI, '4')::jsonb, 'idem-1');
reset role;
select pg_temp.pos() as "posI" \gset
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'I2', public.draft_order_shortfall_pos(:ordIdem, pg_temp.l1(:iI, '4.0000')::jsonb, 'idem-1');
set local "request.jwt.claim.sub" to :mgr2;
insert into ans select 'I3', public.draft_order_shortfall_pos(:ordIdem, pg_temp.l1(:iI, '4')::jsonb, 'idem-1');
reset role;
select is(
  (select jsonb_build_object(
            'sameAnswer', (select r - 'replay' from ans where who = 'I2') = (select r - 'replay' from ans where who = 'I1')
                      and (select r - 'replay' from ans where who = 'I3') = (select r - 'replay' from ans where who = 'I1'),
            'replay', jsonb_build_array((select r->'replay' from ans where who = 'I1'), (select r->'replay' from ans where who = 'I2'),
                                        (select r->'replay' from ans where who = 'I3')),
            'pos', pg_temp.pos() = :posI)),
  jsonb_build_object('sameAnswer', true, 'replay', jsonb_build_array(false, true, true), 'pos', true),
  'I1: a replay (4 and 4.0000 are the same request; another manager of the org too) returns the first answer, the same POs, with replay true, and writes nothing');
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'other lines', pg_temp.err(pg_temp.draft(:ordIdem, pg_temp.l1(:iI, '1'), 'idem-1'));
insert into fx select 'other order', pg_temp.err(pg_temp.draft(:ordIdm2, pg_temp.l1(:iI, '1'), 'idem-1'));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'other lines=P0001:idempotency_conflict:idempotency_conflict, other order=P0001:idempotency_conflict:idempotency_conflict',
  'I2: the key with another request (other quantities, another order) is P0001 idempotency_conflict');
delete from fx;
select is(
  (select jsonb_build_object('scope', k.scope, 'status', k.status, 'type', k.resource_type, 'resource', k.resource_id,
                             'hash', k.request_hash = md5('order_shortfall_po|' || :ordIdem || '|' || :iI || ':4'),
                             'response', k.response = (select jsonb_set(r - 'replay', '{created}',
                                                                  (select jsonb_agg(c - 'poNumber' - 'supplierId' order by o)
                                                                     from jsonb_array_elements(r->'created') with ordinality e(c, o)))
                                                         from ans where who = 'I1'))
     from public.idempotency_keys k where k.organization_id = :orgA and k.key = 'idem-1'),
  jsonb_build_object('scope', 'order_shortfall_po', 'status', 'completed', 'type', 'order_request', 'resource', :ordIdem,
                     'hash', true, 'response', true),
  'I3: the key is stored completed (scope order_shortfall_po, the order as its resource), with the request''s hash and the first answer, each draft named by its id only');
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :vwr;
insert into fx select 'I5', (
  select count(*) || '/' || bool_or(k.response::text like '%poNumber%'
                                    or k.response::text like '%supplierId%'
                                    or k.response::text like '%' || (select r->'created'->0->>'poNumber' from ans where who = 'I1') || '%'
                                    or k.response::text like '%' || :supA1 || '%')
    from public.idempotency_keys k where k.organization_id = :orgA and k.key = 'idem-1');
reset role;
select is(
  (select r from fx where who = 'I5') || '/' || (select (r->'created'->0->>'poNumber' is not null
                                                       and r->'created'->0->>'supplierId' = :supA1) from ans where who = 'I2')::text,
  '1/false/true',
  'I5: a viewer reads the key row (idempotency_keys_select) but no PO number or supplier in it, while the replay still answers both, read from the PO');
delete from fx;
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'refused', pg_temp.err(pg_temp.draft(:ordIdem, pg_temp.l1(:iI, '3'), 'idem-2'));
insert into fx select 'key left', (select count(*)::text from public.idempotency_keys where organization_id = :orgA and key = 'idem-2');
insert into fx select 'reused', pg_temp.err(pg_temp.draft(:ordIdem, pg_temp.l1(:iI, '2'), 'idem-2'));
reset role;
select is(
  (select string_agg(who || '=' || r, ', ' order by who) from fx),
  'key left=0, refused=P0001:shortfall_changed:shortfall_changed, reused=no error',
  'I4: a refused call (3 asked, 2 left) leaves no key, so the same key drafts the 2 afterwards');
delete from fx;

-- ═══ L. The lock and the reorder drafts ═══════════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into ans select 'L', public.draft_order_shortfall_pos(:ordLk, pg_temp.l1(:iLk, '5')::jsonb, 'l-1');
set local "request.jwt.claim.sub" to :mgr2;
insert into ans select 'L reorder', public.save_purchase_order_draft(
  :orgA, null, 'PO-0385-REORDER-2', :supA1, null, null, null, 'reorder', format('[{"item_id": "%s", "quantity_ordered": 7, "unit_cost": 1}]', :iLk)::jsonb,
  '{}'::uuid[], null, true);
reset role;
select is(
  (select jsonb_build_object('id', r->'id', 'skipped', r->'skipped_item_ids') from ans where who = 'L reorder'),
  jsonb_build_object('id', null, 'skipped', jsonb_build_array(:iLk)),
  'L3: a reorder draft after a shortfall draft leaves the item off (it is on the shortfall''s draft): no item is drafted twice either way (D2 is the other direction)');

select is(
  (select count(*) from public.notifications where organization_id = :orgA),
  :notes1::bigint,
  'R5: no draft (D6, S, R, T, I, L) wrote a notification');

-- ═══ P. Parity with core over the shared fixture ══════════════════════════
-- BEGIN GENERATED DRAFTABLE: scripts/gen-readiness-parity-sql.mjs from packages/core/src/orders/readiness-parity-cases.json. Do not edit by hand.
-- 31 cases: C1a, C1b, C2, C3, C4, C4b, C5, C6, C6c, C6b, C7, C8, C9, C10, C11, C12, C13, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, D14.
insert into dp_case (case_id, facts, expected) values
  ('C1a', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a011-0000-4000-8000-000000000000","orderNumber":1,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a014-0000-4000-8000-000000000001","itemId":"0377a013-0000-4000-8000-000000000001","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a014-0000-4000-8000-000000000002","itemId":"0377a013-0000-4000-8000-000000000002","requested":6,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"}],"items":[{"itemId":"0377a013-0000-4000-8000-000000000001","visible":true,"name":"Parity C1a a","sku":"P-C1a-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":0,"heldOtherOrders":3,"heldRentals":2,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a013-0000-4000-8000-000000000002","visible":true,"name":"Parity C1a b","sku":"P-C1a-b","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":6,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":4,"site":0,"unplaced":0,"staging":2},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[{"locationId":"staging-here","quantity":2}],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a013-0000-4000-8000-000000000001":0,"0377a013-0000-4000-8000-000000000002":0}'::jsonb),
  ('C1b', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a021-0000-4000-8000-000000000000","orderNumber":2,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a024-0000-4000-8000-000000000001","itemId":"0377a023-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a023-0000-4000-8000-000000000001","visible":true,"name":"Parity C1b a","sku":"P-C1b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":0,"heldOtherOrders":3,"heldRentals":2,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a023-0000-4000-8000-000000000001":1}'::jsonb),
  ('C2', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a031-0000-4000-8000-000000000000","orderNumber":3,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a034-0000-4000-8000-000000000001","itemId":"0377a033-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a034-0000-4000-8000-000000000002","itemId":"0377a033-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"}],"items":[{"itemId":"0377a033-0000-4000-8000-000000000001","visible":true,"name":"Parity C2 a","sku":"P-C2-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a033-0000-4000-8000-000000000001":1}'::jsonb),
  ('C3', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a041-0000-4000-8000-000000000000","orderNumber":4,"status":"approved","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a044-0000-4000-8000-000000000001","itemId":"0377a043-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a043-0000-4000-8000-000000000001","visible":true,"name":"Parity C3 a","sku":"P-C3-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a043-0000-4000-8000-000000000001":0}'::jsonb),
  ('C4', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a051-0000-4000-8000-000000000000","orderNumber":5,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a054-0000-4000-8000-000000000001","itemId":"0377a053-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a053-0000-4000-8000-000000000001","visible":true,"name":"Parity C4 a","sku":"P-C4-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a053-0000-4000-8000-000000000001":1}'::jsonb),
  ('C4b', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":4}'::jsonb),
  ('C5', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a071-0000-4000-8000-000000000000","orderNumber":7,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a074-0000-4000-8000-000000000001","itemId":"0377a073-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a074-0000-4000-8000-000000000002","itemId":"0377a073-0000-4000-8000-000000000002","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"},{"lineId":"0377a074-0000-4000-8000-000000000003","itemId":"0377a073-0000-4000-8000-000000000003","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:03.000Z"},{"lineId":"0377a074-0000-4000-8000-000000000004","itemId":"0377a073-0000-4000-8000-000000000004","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:04.000Z"}],"items":[{"itemId":"0377a073-0000-4000-8000-000000000001","visible":true,"name":"Parity C5 a","sku":"P-C5-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":6,"heldOtherOrders":4,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a073-0000-4000-8000-000000000002","visible":true,"name":"Parity C5 b","sku":"P-C5-b","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":3,"heldOwn":3,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":3,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a073-0000-4000-8000-000000000003","visible":true,"name":"Parity C5 c","sku":"P-C5-c","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":6,"heldOwn":5,"heldOtherOrders":0,"heldRentals":1,"here":{"rack":0,"site":4,"unplaced":2,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a073-0000-4000-8000-000000000004","visible":true,"name":"Parity C5 d","sku":"P-C5-d","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":8,"heldOwn":5,"heldOtherOrders":4,"heldRentals":0,"here":{"rack":8,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a073-0000-4000-8000-000000000001":0,"0377a073-0000-4000-8000-000000000002":2,"0377a073-0000-4000-8000-000000000003":0,"0377a073-0000-4000-8000-000000000004":1}'::jsonb),
  ('C6', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a081-0000-4000-8000-000000000000","orderNumber":8,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a084-0000-4000-8000-000000000001","itemId":"0377a083-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a083-0000-4000-8000-000000000001","visible":true,"name":"Parity C6 a","sku":"P-C6-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":6,"site":0,"unplaced":0,"staging":4},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[{"locationId":"staging-here","quantity":4}],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a083-0000-4000-8000-000000000001":0}'::jsonb),
  ('C6c', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a091-0000-4000-8000-000000000000","orderNumber":9,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a094-0000-4000-8000-000000000001","itemId":"0377a093-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a093-0000-4000-8000-000000000001","visible":true,"name":"Parity C6c a","sku":"P-C6c-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":7,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a093-0000-4000-8000-000000000001":0}'::jsonb),
  ('C6b', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0a1-0000-4000-8000-000000000000","orderNumber":10,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0a4-0000-4000-8000-000000000001","itemId":"0377a0a3-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a0a3-0000-4000-8000-000000000001","visible":true,"name":"Parity C6b a","sku":"P-C6b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":6,"site":0,"unplaced":4,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0a3-0000-4000-8000-000000000001":0}'::jsonb),
  ('C7', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0b1-0000-4000-8000-000000000000","orderNumber":11,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0b4-0000-4000-8000-000000000001","itemId":"0377a0b3-0000-4000-8000-000000000001","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a0b3-0000-4000-8000-000000000001","visible":true,"name":"Parity C7 a","sku":"P-C7-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":5,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":5,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0b3-0000-4000-8000-000000000001":0}'::jsonb),
  ('C8', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0c1-0000-4000-8000-000000000000","orderNumber":12,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0c4-0000-4000-8000-000000000001","itemId":"0377a0c3-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a0c3-0000-4000-8000-000000000001","visible":true,"name":"Parity C8 a","sku":"P-C8-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":15,"heldOwn":10,"heldOtherOrders":5,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":5},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[{"locationId":"staging-here","quantity":5}],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0c3-0000-4000-8000-000000000001":0}'::jsonb),
  ('C9', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0d1-0000-4000-8000-000000000000","orderNumber":13,"status":"picking_in_progress","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0d4-0000-4000-8000-000000000001","itemId":"0377a0d3-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":4,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a0d4-0000-4000-8000-000000000002","itemId":"0377a0d3-0000-4000-8000-000000000002","requested":2,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"}],"items":[{"itemId":"0377a0d3-0000-4000-8000-000000000001","visible":true,"name":"Parity C9 a","sku":"P-C9-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":6,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a0d3-0000-4000-8000-000000000002","visible":true,"name":"Parity C9 b","sku":"P-C9-b","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":2,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0d3-0000-4000-8000-000000000001":0,"0377a0d3-0000-4000-8000-000000000002":0}'::jsonb),
  ('C10', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0e1-0000-4000-8000-000000000000","orderNumber":14,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0e4-0000-4000-8000-000000000001","itemId":"0377a0e3-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a0e3-0000-4000-8000-000000000001","visible":true,"name":"Parity C10 a","sku":"P-C10-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":6,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":3,"unplaced":0,"staging":0},"elsewhere":{"pickable":2,"staging":1},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0e3-0000-4000-8000-000000000001":0}'::jsonb),
  ('C11', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0f1-0000-4000-8000-000000000000","orderNumber":15,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0f4-0000-4000-8000-000000000001","itemId":"0377a0f3-0000-4000-8000-000000000001","requested":2,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a0f4-0000-4000-8000-000000000002","itemId":"0377a0f3-0000-4000-8000-000000000002","requested":2,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"}],"items":[{"itemId":"0377a0f3-0000-4000-8000-000000000001","visible":true,"name":"Parity C11 a","sku":"P-C11-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a0f3-0000-4000-8000-000000000002","visible":true,"name":"Parity C11 m","sku":"P-C11-m","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d2","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":5,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0f3-0000-4000-8000-000000000001":0,"0377a0f3-0000-4000-8000-000000000002":0}'::jsonb),
  ('C12', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a101-0000-4000-8000-000000000000","orderNumber":16,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a104-0000-4000-8000-000000000001","itemId":"0377a103-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a103-0000-4000-8000-000000000001","visible":true,"name":"Parity C12 a","sku":"P-C12-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":8,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a103-0000-4000-8000-000000000001":0}'::jsonb),
  ('C13', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a111-0000-4000-8000-000000000000","orderNumber":17,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a114-0000-4000-8000-000000000001","itemId":"0377a113-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a113-0000-4000-8000-000000000001","visible":true,"name":"Parity C13 k","sku":"P-C13-k","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":true,"onHand":2,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a113-0000-4000-8000-000000000001":0}'::jsonb),
  ('D1', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[{"poId":"0385d001-0000-4000-8000-000000000001","poNumber":"PO-D1-1","status":"ordered","expectedAt":null,"remaining":2}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":2}'::jsonb),
  ('D2', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[{"poId":"0385d002-0000-4000-8000-000000000001","poNumber":"PO-D2-1","status":"ordered","expectedAt":null,"remaining":2}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[{"poId":"0385d002-0000-4000-8000-000000000032","poNumber":"PO-D2-50","remaining":1}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":1}'::jsonb),
  ('D3', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":2,"inbound":{"rows":[{"poId":"0385d003-0000-4000-8000-000000000001","poNumber":"PO-D3-1","status":"ordered","expectedAt":null,"remaining":2}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[{"poId":"0385d003-0000-4000-8000-000000000032","poNumber":"PO-D3-50","remaining":1}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":3}'::jsonb),
  ('D4', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":1,"truncated":true,"truncatedRemaining":1},"drafts":{"rows":[],"hiddenRemaining":1,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":1}'::jsonb),
  ('D5', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[{"poId":"0385d005-0000-4000-8000-000000000001","poNumber":"PO-D5-1","status":"ordered","expectedAt":null,"remaining":3},{"poId":"0385d005-0000-4000-8000-000000000002","poNumber":"PO-D5-2","status":"ordered","expectedAt":null,"remaining":5}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":0}'::jsonb),
  ('D6', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":6,"inbound":{"rows":[{"poId":"0385d006-0000-4000-8000-000000000001","poNumber":"PO-D6-1","status":"ordered","expectedAt":null,"remaining":1}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":4}'::jsonb),
  ('D7', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a071-0000-4000-8000-000000000000","orderNumber":7,"status":"pick_slip_generated","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a074-0000-4000-8000-000000000001","itemId":"0377a073-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a074-0000-4000-8000-000000000002","itemId":"0377a073-0000-4000-8000-000000000002","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"},{"lineId":"0377a074-0000-4000-8000-000000000003","itemId":"0377a073-0000-4000-8000-000000000003","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:03.000Z"},{"lineId":"0377a074-0000-4000-8000-000000000004","itemId":"0377a073-0000-4000-8000-000000000004","requested":5,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:04.000Z"}],"items":[{"itemId":"0377a073-0000-4000-8000-000000000001","visible":true,"name":"Parity C5 a","sku":"P-C5-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":10,"heldOwn":6,"heldOtherOrders":4,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a073-0000-4000-8000-000000000002","visible":true,"name":"Parity C5 b","sku":"P-C5-b","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":3,"heldOwn":3,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":3,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[{"poId":"0385d007-0000-4000-8000-000000000032","poNumber":"PO-D7-50","remaining":1}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a073-0000-4000-8000-000000000003","visible":true,"name":"Parity C5 c","sku":"P-C5-c","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":6,"heldOwn":5,"heldOtherOrders":0,"heldRentals":1,"here":{"rack":0,"site":4,"unplaced":2,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a073-0000-4000-8000-000000000004","visible":true,"name":"Parity C5 d","sku":"P-C5-d","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":8,"heldOwn":5,"heldOtherOrders":4,"heldRentals":0,"here":{"rack":8,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a073-0000-4000-8000-000000000001":0,"0377a073-0000-4000-8000-000000000002":1,"0377a073-0000-4000-8000-000000000003":0,"0377a073-0000-4000-8000-000000000004":1}'::jsonb),
  ('D8', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a111-0000-4000-8000-000000000000","orderNumber":17,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a114-0000-4000-8000-000000000001","itemId":"0377a113-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a113-0000-4000-8000-000000000001","visible":true,"name":"Parity C13 k","sku":"P-C13-k","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":true,"onHand":2,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[{"poId":"0385d008-0000-4000-8000-000000000001","poNumber":"PO-D8-1","status":"ordered","expectedAt":null,"remaining":1}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a113-0000-4000-8000-000000000001":0}'::jsonb),
  ('D9', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a0f1-0000-4000-8000-000000000000","orderNumber":15,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a0f4-0000-4000-8000-000000000001","itemId":"0377a0f3-0000-4000-8000-000000000001","requested":2,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a0f4-0000-4000-8000-000000000002","itemId":"0377a0f3-0000-4000-8000-000000000002","requested":2,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"}],"items":[{"itemId":"0377a0f3-0000-4000-8000-000000000001","visible":true,"name":"Parity C11 a","sku":"P-C11-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}},{"itemId":"0377a0f3-0000-4000-8000-000000000002","visible":true,"name":"Parity C11 m","sku":"P-C11-m","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d2","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":5,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a0f3-0000-4000-8000-000000000001":0,"0377a0f3-0000-4000-8000-000000000002":0}'::jsonb),
  ('D10', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":null,"drafts":null}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":0}'::jsonb),
  ('D11', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a021-0000-4000-8000-000000000000","orderNumber":2,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a024-0000-4000-8000-000000000001","itemId":"0377a023-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a023-0000-4000-8000-000000000001","visible":false}]}'::jsonb, '{"0377a023-0000-4000-8000-000000000001":0}'::jsonb),
  ('D12', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":true,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":0}'::jsonb),
  ('D13', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a031-0000-4000-8000-000000000000","orderNumber":3,"status":"pending_approval","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a034-0000-4000-8000-000000000001","itemId":"0377a033-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"},{"lineId":"0377a034-0000-4000-8000-000000000002","itemId":"0377a033-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null,"createdAt":"2026-01-01T00:00:02.000Z"}],"items":[{"itemId":"0377a033-0000-4000-8000-000000000001","visible":true,"name":"Parity C2 a","sku":"P-C2-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":0,"inbound":{"rows":[{"poId":"0385d00d-0000-4000-8000-000000000001","poNumber":"PO-D13-1","status":"ordered","expectedAt":null,"remaining":0.25}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a033-0000-4000-8000-000000000001":0.75}'::jsonb),
  ('D14', '{"v":1,"observedAt":"2026-01-01T12:00:00.000Z","phase":"to_pick","linesCapped":false,"order":{"id":"0377a061-0000-4000-8000-000000000000","orderNumber":6,"status":"backordered","warehouseId":"0377a000-0000-4000-8000-0000000000d1","neededBy":null,"fulfillmentType":"pickup"},"lines":[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null,"createdAt":"2026-01-01T00:00:01.000Z"}],"items":[{"itemId":"0377a063-0000-4000-8000-000000000001","visible":true,"name":"Parity C4b a","sku":"P-C4b-a","supplierId":null,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","deleted":false,"archived":false,"isBundle":false,"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingSources":[],"stagingHiddenQty":0,"pendingOthers":{"orders":0,"units":0},"committedOtherShortfall":4,"inbound":{"rows":[{"poId":"0385d00e-0000-4000-8000-000000000001","poNumber":"PO-D14-1","status":"ordered","expectedAt":null,"remaining":2}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[{"poId":"0385d00e-0000-4000-8000-000000000032","poNumber":"PO-D14-50","remaining":2}],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0}}]}'::jsonb, '{"0377a063-0000-4000-8000-000000000001":4}'::jsonb);
-- END GENERATED DRAFTABLE

select is(
  (select coalesce(string_agg(d.case_id || ': got ' || coalesce(got.v::text, 'null') || ', want ' || d.expected::text, E'\n' order by d.case_id), '')
     from dp_case d
     cross join lateral (
       select jsonb_object_agg(c.key, c.value->'draftable') as v
         from jsonb_each(public.order_shortfall_draftable(d.facts)) c) got
    where got.v is distinct from d.expected),
  '',
  'P1: order_shortfall_draftable equals core''s draftable for every case and draftable case of readiness-parity-cases.json');
select is(
  (select count(*)::int from dp_case where case_id like 'D%') || '/' || (select count(*)::int from dp_case),
  '14/31',
  'P2: the block holds the 17 cases and the 14 draftable cases');
select is(
  (select string_agg(d.case_id || '=' || (select string_agg(coalesce(c.value->>'refusal', '-'), ',' order by c.key)
                                            from jsonb_each(public.order_shortfall_draftable(d.facts)) c), ', ' order by d.case_id)
     from dp_case d where d.case_id in ('D8', 'D9', 'D10', 'D11', 'D12')),
  'D10=po_module_off, D11=not_visible, D12=item_deleted, D8=kit_stock, D9=-,item_moved',
  'P3: why an item is not draftable: kit stock, moved, the purchase_orders module off, not visible, deleted');

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
      ('public', 'order_readiness_facts'), ('public', 'revise_order_needed_by'), ('public', 'confirm_order_signature'),
      ('public', 'confirm_physical_signature'), ('public', 'create_order_request'),
      ('public', 'save_purchase_order_draft'), ('public', 'next_po_number'), ('public', 'post_receipt_v2'),
      ('public', 'tg_order_requests_insert_guard'), ('public', 'tg_order_request_lines_guard'),
      ('public', 'caller_can_read_item'), ('public', 'purchase_order_visible'), ('public', 'location_holdings_visible'),
      ('public', 'tg_purchase_orders_guard'), ('public', 'tg_purchase_order_items_guard'),
      ('public', 'po_status_for_line_write'), ('public', 'po_status_in_org'), ('public', 'po_line_items_not_orderable'),
      ('public', '_po_approval_threshold'), ('public', 'po_over_approval_threshold'), ('public', 'order_request_in_org'))),
  E'_po_approval_threshold(uuid)|1aa85f6413087b2e57d6b5581f7d291e|true|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was 96e5f7c8b4cdd6b7e4ffcc994c9ed642): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'approve_order_request(uuid)|7883f466ae2642cbb4664ebc473e571b|true|{search_path=public}|postgres\n'
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
  -- Re-pinned by 0390 (was c38fe9b12af77fdaa2d372f4fd324a43): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'hold_order_stock(uuid)|3b0691d604823164daaa7f248616f00f|true|{"search_path=public, pg_temp",lock_timeout=5s}|postgres\n'
  'location_holdings_visible(uuid)|fb5dc7aa7d0acd81e7752f0b163a9002|false|{search_path=public}|postgres\n'
  'next_po_number(uuid)|b6bebc9ae8b1ec3a9ba6d89b73e39d91|false|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was 5ac332d439117e498096fc9b1098cf04): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'order_readiness_facts(uuid)|2f3fb057bacda8143377ecd9c2c5e6e2|true|{"search_path=public, pg_temp"}|postgres\n'
  'order_request_in_org(uuid,uuid)|4d88c3f9eef0c34cece9d2d5bdd46b5f|true|{search_path=public}|postgres\n'
  'partial_pick_line(uuid,numeric)|b52a9877d54f13fb17ba44dafe5645c9|true|{search_path=public}|postgres\n'
  'po_line_items_not_orderable(uuid,uuid[])|dd3565f51edcc9b84e2b00b853ba8c2a|true|{"search_path=public, pg_temp"}|postgres\n'
  'po_over_approval_threshold(uuid,numeric)|9175487be2556e9c0fb23812e0ec6503|true|{search_path=public}|postgres\n'
  'po_status_for_line_write(uuid,uuid)|38c35a2979bbe0a924ea353155074c4c|true|{search_path=public}|postgres\n'
  'po_status_in_org(uuid,uuid)|9087d7c2caffb59d4eb4e9eb51a9b400|true|{search_path=public}|postgres\n'
  'post_receipt_v2(uuid,uuid,jsonb,text,text,text)|efc01e2e0ea98531c92c7db27f17695c|false|{search_path=public}|postgres\n'
  'purchase_order_visible(uuid)|0f26ab9fb9e7f74d966de79d4e354163|false|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was a7fabd5fb3d07467135006b56581e46c): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'reopen_picking(uuid,text)|293ce0e76d195bb13105cfd1c067de82|true|{"search_path=public, extensions"}|postgres\n'
  -- Re-pinned by 0390 (was e0f2ae5d7d3564cdad3b36ba4cf5aa8c): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'resume_fulfillment(uuid)|2e2d5aab1db5392250879bfa9ff4bccd|true|{search_path=public}|postgres\n'
  -- Re-pinned by 0390 (was c2ce20a076301c95b2b9ef968db1b206): the manager-by-role term removed from the
  -- gate and nothing else (0390 R-section proves it); posture unchanged.
  'revise_order_needed_by(uuid,timestamp with time zone,timestamp with time zone,text,text)|dd11c6a10d4ec6fe3543e86680130347|true|{"search_path=public, pg_temp",lock_timeout=5s}|postgres\n'
  'save_purchase_order_draft(uuid,uuid,text,uuid,uuid,uuid,timestamp with time zone,text,jsonb,uuid[],uuid,boolean)|2b6eefbefb914cc71ecde820f215b477|false|{"search_path=public, pg_temp"}|postgres\n'
  'tg_order_request_lines_guard()|d899924c0f8fc1dfae4e8be7bd4c5cad|false|{search_path=public}|postgres\n'
  -- Re-pinned by 0392 (was 1b109d535811e9a21c43d01dcc344892, 0365's body): the
  -- insert guard also refuses an admin-client (service_role) insert carrying
  -- a return token, a track token or a signature image (0392 suite G23);
  -- unchanged for the API roles.
  'tg_order_requests_insert_guard()|caf69f8a23d03b9bfa6ea87a9cf94077|false|{search_path=public}|postgres\n'
  'tg_purchase_order_items_guard()|8c335327b4bd0337fbb9d608ef15dc34|false|{search_path=public}|postgres\n'
  'tg_purchase_orders_guard()|6f47ee97dbbace6e1249aa20eda48c96|false|{search_path=public}|postgres',
  'Z1: the frozen functions (fulfilment, holds, readiness facts and PO visibility, the needed-by revision, the PO draft save and number, receiving, the order and PO guards, the read helpers) are the text, SECURITY DEFINER, search_path and owner F2-5 was proven against');
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
    union all
    select 'purchase_orders + purchase_order_items + idempotency_keys policies', md5(string_agg(c.relname || '|' || pol.polname || '|' || pol.polcmd::text || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') || '|' || pol.polroles::text, E'\n' order by c.relname, pol.polname)) || '|' || count(*)
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where c.relnamespace = 'public'::regnamespace and c.relname in ('purchase_orders', 'purchase_order_items', 'idempotency_keys')
    union all
    select 'PO triggers', md5(string_agg(c.relname || '|' || t.tgname || '|' || t.tgfoid::regproc::text || '|' || t.tgenabled::text || '|' || t.tgtype::text, E'\n' order by c.relname, t.tgname)) || '|' || count(*)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname in ('purchase_orders', 'purchase_order_items')
    union all
    select '0384 column grants (order_requests, schedule_events)', md5(string_agg(cp.table_name || '.' || cp.column_name || '|' || cp.grantee || '|' || cp.privilege_type, E'\n' order by cp.table_name, cp.column_name, cp.grantee, cp.privilege_type)) || '|' || count(*)
      from information_schema.column_privileges cp
     where cp.table_schema = 'public' and cp.table_name in ('order_requests', 'schedule_events') and cp.grantee in ('anon', 'authenticated')
  ) g),
  E'0380 report functions|13e9b93da345dd302ad93629ff2d1690|6\n'
  '0381 photo functions|cf3324efe7b21cab2352568f0b600675|5\n'
  '0381 photo policies|7e259c299ec06a104c10121f80c143e7|8\n'
  '0382 book functions|860fa55515d74980ce1c1d0a4a6f3e18|6\n'
  -- Re-pinned by 0387 (was 951362776d6d97800ba9d458c0642484|589): 0387
  -- revokes every anon privilege on order_requests (232 rows here),
  -- authenticated's table REFERENCES (58) and its UPDATE on 38 columns (38);
  -- schedule_events is unchanged. F2-5's function writes none of those
  -- columns (it does not write order_requests), so what it was proven
  -- against still holds. Computed on the local stack after 0387 (equal to
  -- the value predicted from production's own column_privileges rows minus
  -- exactly the rows 0387's revokes remove).
  -- Re-pinned by 0388 (was 34395ad1d1d38ebf688f8c0b9c6f150c|261): 0388
  -- replaces authenticated's table INSERT on order_requests with INSERT on
  -- the 13 columns create_order_request names (45 INSERT rows fewer) and
  -- adds requester_deleted_at, which authenticated may only SELECT (one
  -- SELECT row more). F2-5's function inserts no order, so what it was
  -- proven against still holds. Computed on the local stack after 0388.
  -- Re-pinned by 0392 (was 963d3a00efec2f702ff628845abd4056|217): 0392
  -- revokes authenticated's UPDATE on nine order_requests columns (the
  -- signature token, its expiry and the packing-slip stamps, slice C; the
  -- delivery assignment and in-transit stamps, slice E): nine UPDATE rows
  -- fewer. F2-5's function writes none of them. Computed from production's
  -- own column_privileges rows minus exactly those nine (2026-10-04; the
  -- local stack gave production's value for every earlier pin); verify on
  -- the stack.
  '0384 column grants (order_requests, schedule_events)|17eb8a3457ab0a8d9cffcab1db42d50e|208\n'
  'ledger.*|8b442829be30fd47ab5cfef87da6a962|14\n'
  -- Re-pinned by 0390 (was a85d7406f48ad916cb5fcdb2193fa201|8): order_requests_update
  -- (USING and WITH CHECK) and order_requests_insert lost the has_org_role
  -- manager term; every other term and both schedule_events policies are
  -- unchanged. Computed from production's policy text minus that term with
  -- the local authenticated role's OID (16444, the OID that reproduces the
  -- old pin from the same text); verify on the stack.
  'order_requests + schedule_events policies|bff8a9854b1856ae3fefe1a3dcf702a8|8\n'
  'PO triggers|b8cf49572ed3d9556416e8d4b89a7094|4\n'
  'purchase_orders + purchase_order_items + idempotency_keys policies|4d66c95449ef3c5127f8d19974023c70|6',
  'Z2: ledger.*, the 0380/0381/0382 objects, the order, schedule, PO and idempotency-key policies, the PO triggers and the 0384 column grants are the ones F2-5 was proven against');

select * from finish();
rollback;
