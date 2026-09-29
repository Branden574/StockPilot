-- supabase/tests/0382_book_order_totals_charter_dates.test.sql
-- pgTAP proof for migration 0382 (Book Order Totals: the order's charter and
-- two more date presets).
--
-- S. Structure: six book_order% functions, one signature each (the three
--    0379 identities that changed are gone); all SECURITY INVOKER STABLE with
--    search_path=public and plan_cache_mode=force_custom_plan; EXECUTE to
--    authenticated only; gates in every body, no DML, no 40001/40P01; no body
--    names a charter's address, contact or geocode columns, the item's owning
--    charter or a purchase order; the week preset is today minus its day of
--    week (Sunday start), never an ISO week; E2b-pre and the A3 guard appear
--    where the plan puts them; the A3 probe tests the book per line by the
--    items key and the No-charter option probes book first (the perf lab's
--    probe shapes).
-- CB. The charters block's own gates (it is callable over REST): signed out,
--    another org's manager, a disabled member, a viewer without reports:read,
--    a manager with reports:read revoked, a module off.
-- A-D. The brief's acceptance tests, exactly: charter (A), exact dates (B),
--    charter and dates together (C), distinct orders (D), with the day
--    boundaries (Aug 31 23:59:59 PDT, Sep 30 23:59:59 PDT, Oct 1 00:00 PDT,
--    the 25-hour Nov 1 and the 23-hour Mar 8).
-- E. Security: a charter-limited viewer (only Charter Alder at W1), one
--    limited to a charter archived since, a mixed
--    viewer (all of W2, Alder at W1), warehouse-limited staff, a
--    category-limited viewer and a viewer of an all-chartered warehouse; an
--    out-of-scope, a foreign and an unknown charter id are ONE refusal (same
--    SQLSTATE, hint, message and detail) from every entry point, and the
--    charters block returns no row for them; a manager's inactive or
--    never-serviced charter without history is refused, an archived one with
--    history is accepted; an authorized charter with nothing in range is an
--    honest zero with its name; "no charter" never raises; the gates that
--    exist run before the charter's.
-- O. Ownership and bill-to are not the filter.
-- BC. By charter: buckets add up to the summary (copies and orders) for
--    every persona and filter, each bucket equals the answer for that
--    charter, No charter is last and present exactly when a line without a
--    charter is in scope, and it is null with a charter, with no charter and
--    in export mode.
-- R. Reconciliation for every persona, every charter it may choose, "no
--    charter" and all charters: rows over all pages = summary, drill-downs =
--    rows, union of drill-down orders = summary orders.
-- P. Options and charter-list parity per persona; the same lists and figures
--    with E2b-pre and the A3 guard removed.
-- NB. History with no book: a charter whose only order holds a product line
--    is not offered and is refused; a pickup with only a product line does
--    not offer No charter; with a book line added, both appear (control).
-- Z. Today and This week in four zones; the week arithmetic swept over
--    2025-12-01..2027-01-31.
-- C. Current behaviour pinned: an order moved to another charter moves its
--    copies.
--
-- Roles: fixtures as the test superuser (RLS bypassed); every function call
-- runs as `authenticated` with request.jwt.claim.sub set (pg_temp wrappers
-- switch the role for the call). Delivery orders carry a charter and pickups
-- never do (the delivery-target CHECK still runs on INSERT). begin/rollback:
-- nothing leaks. Namespace 03820000.

begin;
select plan(71);

\set orgA     '\'03820000-0000-0000-0000-00000000000a\''
\set orgB     '\'03820000-0000-0000-0000-00000000000b\''
\set mgr      '\'03820000-0000-0000-0000-0000000000a1\''
\set mgrAB    '\'03820000-0000-0000-0000-0000000000a2\''
\set vCh      '\'03820000-0000-0000-0000-0000000000a3\''
\set vMix     '\'03820000-0000-0000-0000-0000000000a4\''
\set stfW2    '\'03820000-0000-0000-0000-0000000000a5\''
\set vW4      '\'03820000-0000-0000-0000-0000000000a6\''
\set dis      '\'03820000-0000-0000-0000-0000000000a7\''
\set vNoRep   '\'03820000-0000-0000-0000-0000000000a8\''
\set vCat     '\'03820000-0000-0000-0000-0000000000a9\''
\set vOld     '\'03820000-0000-0000-0000-0000000000aa\''
\set mgrB     '\'03820000-0000-0000-0000-0000000000b1\''
\set W1       '\'03820000-0000-0000-0000-0000000000d1\''
\set W2       '\'03820000-0000-0000-0000-0000000000d2\''
\set W3       '\'03820000-0000-0000-0000-0000000000d3\''
\set W4       '\'03820000-0000-0000-0000-0000000000d4\''
\set W5       '\'03820000-0000-0000-0000-0000000000d5\''
\set WB       '\'03820000-0000-0000-0000-0000000000db\''
\set chA      '\'03820000-0000-0000-0000-000000000c01\''
\set chB      '\'03820000-0000-0000-0000-000000000c02\''
\set chC      '\'03820000-0000-0000-0000-000000000c03\''
\set chD      '\'03820000-0000-0000-0000-000000000c04\''
\set chE      '\'03820000-0000-0000-0000-000000000c05\''
\set chF      '\'03820000-0000-0000-0000-000000000c06\''
\set chIdle   '\'03820000-0000-0000-0000-000000000c07\''
\set chOld    '\'03820000-0000-0000-0000-000000000c08\''
\set chNomad  '\'03820000-0000-0000-0000-000000000c09\''
\set chMoved  '\'03820000-0000-0000-0000-000000000c0a\''
\set chZ      '\'03820000-0000-0000-0000-000000000c0b\''
\set rnd      '\'03820000-0000-0000-0000-00000000ffff\''
\set Cat1     '\'03820000-0000-0000-0000-000000000c11\''
\set Cat2     '\'03820000-0000-0000-0000-000000000c12\''
\set bkA      '\'03820000-0000-0000-0000-000000000f01\''
\set bkB      '\'03820000-0000-0000-0000-000000000f02\''
\set bkC      '\'03820000-0000-0000-0000-000000000f03\''
\set bkT      '\'03820000-0000-0000-0000-000000000f04\''
\set bkZ      '\'03820000-0000-0000-0000-000000000f05\''
\set bkU      '\'03820000-0000-0000-0000-000000000f06\''
\set bkD1     '\'03820000-0000-0000-0000-000000000f07\''
\set bkD2     '\'03820000-0000-0000-0000-000000000f08\''
\set bkOwn    '\'03820000-0000-0000-0000-000000000f09\''
\set bkPack   '\'03820000-0000-0000-0000-000000000f0a\''
\set iProd    '\'03820000-0000-0000-0000-000000000f0b\''
\set bkBZ     '\'03820000-0000-0000-0000-000000000f0c\''
\set OA1      '\'03820000-0000-0000-0000-000000000101\''
\set OA2      '\'03820000-0000-0000-0000-000000000102\''
\set OA3      '\'03820000-0000-0000-0000-000000000103\''
\set OAx      '\'03820000-0000-0000-0000-000000000104\''
\set OOld     '\'03820000-0000-0000-0000-000000000105\''
\set OP1      '\'03820000-0000-0000-0000-000000000106\''
\set ODen     '\'03820000-0000-0000-0000-000000000107\''
\set OPk      '\'03820000-0000-0000-0000-000000000108\''
\set OC1      '\'03820000-0000-0000-0000-000000000111\''
\set OC2      '\'03820000-0000-0000-0000-000000000112\''
\set OC3      '\'03820000-0000-0000-0000-000000000113\''
\set OM       '\'03820000-0000-0000-0000-000000000114\''
\set OB1      '\'03820000-0000-0000-0000-000000000121\''
\set OB2      '\'03820000-0000-0000-0000-000000000122\''
\set OB3      '\'03820000-0000-0000-0000-000000000123\''
\set OB0      '\'03820000-0000-0000-0000-000000000124\''
\set OOwn     '\'03820000-0000-0000-0000-000000000131\''
\set OZ1      '\'03820000-0000-0000-0000-000000000141\''
\set OZ2      '\'03820000-0000-0000-0000-000000000142\''
\set OZ3      '\'03820000-0000-0000-0000-000000000143\''
\set OZ4      '\'03820000-0000-0000-0000-000000000144\''
\set OZ5      '\'03820000-0000-0000-0000-000000000145\''
\set OZ6      '\'03820000-0000-0000-0000-000000000146\''
\set OD       '\'03820000-0000-0000-0000-000000000147\''
\set OBZ      '\'03820000-0000-0000-0000-000000000151\''
\set po1      '\'03820000-0000-0000-0000-000000000401\''
-- The two status lists, as literals (the same ones 0379's test and core hold).
\set all13    '\'{pending_approval,approved,pick_slip_generated,picking_in_progress,picking_complete,packing_slip_generated,staged_for_pickup,staged_for_delivery,in_transit,backordered,completed,denied,cancelled}\''
\set def11    '\'{pending_approval,approved,pick_slip_generated,picking_in_progress,picking_complete,packing_slip_generated,staged_for_pickup,staged_for_delivery,in_transit,backordered,completed}\''

-- ══ Fixtures (fictional) ══════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr,    '0382-mgr@test.local',    '{}'::jsonb),
  (:mgrAB,  '0382-mgrab@test.local',  '{}'::jsonb),
  (:vCh,    '0382-vch@test.local',    '{}'::jsonb),
  (:vMix,   '0382-vmix@test.local',   '{}'::jsonb),
  (:stfW2,  '0382-stfw2@test.local',  '{}'::jsonb),
  (:vW4,    '0382-vw4@test.local',    '{}'::jsonb),
  (:dis,    '0382-dis@test.local',    '{}'::jsonb),
  (:vNoRep, '0382-vnorep@test.local', '{}'::jsonb),
  (:vCat,   '0382-vcat@test.local',   '{}'::jsonb),
  (:vOld,   '0382-vold@test.local',   '{}'::jsonb),
  (:mgrB,   '0382-mgrb@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;

-- An org insert enables the default modules (orders and books among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0382 Charters A', '0382-charters-a'),
  (:orgB, '0382 Charters B', '0382-charters-b');
update public.organizations set timezone = 'America/Los_Angeles' where id in (:orgA, :orgB);

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :mgrAB,  'manager', now()),
  (:orgB, :mgrAB,  'manager', now()),
  (:orgA, :vCh,    'viewer',  now()),
  (:orgA, :vMix,   'viewer',  now()),
  (:orgA, :stfW2,  'staff',   now()),
  (:orgA, :vW4,    'viewer',  now()),
  (:orgA, :dis,    'staff',   now()),
  (:orgA, :vNoRep, 'viewer',  now()),
  (:orgA, :vCat,   'viewer',  now()),
  (:orgA, :vOld,   'viewer',  now()),
  (:orgB, :mgrB,   'manager', now());

insert into public.warehouses (id, organization_id, name, code, status) values
  (:W1, :orgA, '0382 North',    'WH-0382-1', 'active'),
  (:W2, :orgA, '0382 South',    'WH-0382-2', 'active'),
  (:W3, :orgA, '0382 East',     'WH-0382-3', 'active'),
  (:W4, :orgA, '0382 West',     'WH-0382-4', 'active'),
  (:W5, :orgA, '0382 Harbor',   'WH-0382-5', 'active'),
  (:WB, :orgB, '0382 B Main',   'WH-0382-B', 'active');
insert into public.charters (id, organization_id, name, code, status) values
  (:chA,     :orgA, 'Charter Alder',   'CH-A', 'active'),
  (:chB,     :orgA, 'Charter Birch',   null,   'active'),
  (:chC,     :orgA, 'Charter Cedar',   'CH-C', 'active'),
  (:chD,     :orgA, 'Charter Dogwood', 'CH-D', 'active'),
  (:chE,     :orgA, 'Charter Elm',     null,   'active'),
  (:chF,     :orgA, 'Charter Fir',     null,   'active'),
  (:chIdle,  :orgA, 'Charter Idle',    null,   'inactive'),
  (:chOld,   :orgA, 'Charter Old',     null,   'active'),
  (:chNomad, :orgA, 'Charter Nomad',   null,   'active'),
  (:chMoved, :orgA, 'Charter Moved',   null,   'active'),
  (:chZ,     :orgB, 'Charter Zed',     'CH-Z', 'active');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :W1, :chA), (:orgA, :W1, :chB), (:orgA, :W1, :chIdle), (:orgA, :W1, :chOld),
  (:orgA, :W2, :chC), (:orgA, :W2, :chD), (:orgA, :W2, :chMoved),
  (:orgA, :W4, :chE), (:orgA, :W4, :chF),
  (:orgB, :WB, :chZ);
insert into public.categories (id, organization_id, name) values
  (:Cat1, :orgA, '0382 Fiction'),
  (:Cat2, :orgA, '0382 History');
-- vCh: only Charter Alder at W1. vOld: only Charter Old (archived since) at
-- W1. vMix: all of W2, only Alder at W1. stfW2: all of W2. vW4: all of W4
-- (every order there has a charter). vCat: all of W1, category Fiction only.
-- dis and vNoRep: all of W1.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :vCh,    :W1, :chA, true),
  (:orgA, :vOld,   :W1, :chOld, true),
  (:orgA, :vMix,   :W2, null, true),
  (:orgA, :vMix,   :W1, :chA, false),
  (:orgA, :stfW2,  :W2, null, true),
  (:orgA, :vW4,    :W4, null, true),
  (:orgA, :vCat,   :W1, null, true),
  (:orgA, :dis,    :W1, null, true),
  (:orgA, :vNoRep, :W1, null, true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vCat, :Cat1);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :vCh,  'reports:read',   true),
  (:orgA, :vCh,  'reports:export', true),
  (:orgA, :vMix, 'reports:read',   true),
  (:orgA, :vW4,  'reports:read',   true),
  (:orgA, :vCat, 'reports:read',   true),
  (:orgA, :vOld, 'reports:read',   true);

-- Every book is generic stock (no owning charter) except bkOwn, owned by
-- Charter Fir: ownership must never act as the order's charter.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, unit_of_measure, category_id, charter_id,
   custom_fields, quantity_on_hand, status) values
  (:bkA,    :orgA, :W1, 'BK-A',    'Book A',       'book',    'unit',       :Cat1, null, '{}'::jsonb, 0, 'active'),
  (:bkB,    :orgA, :W1, 'BK-B',    'Book B',       'book',    'ea',         :Cat1, null, '{}'::jsonb, 0, 'active'),
  (:bkC,    :orgA, :W1, 'BK-C',    'Book C',       'book',    'unit',       :Cat2, null, '{}'::jsonb, 0, 'active'),
  (:bkPack, :orgA, :W1, 'BK-PACK', 'Book Pack',    'book',    'pack of 10', :Cat1, null, '{}'::jsonb, 0, 'active'),
  (:iProd,  :orgA, :W1, 'SUP-1',   'Supplies box', 'product', 'unit',       :Cat1, null, '{}'::jsonb, 0, 'active'),
  (:bkU,    :orgA, :W2, 'BK-U',    'Book U',       'book',    'unit',       :Cat2, null, '{}'::jsonb, 0, 'active'),
  (:bkT,    :orgA, :W3, 'BK-T',    'Book T',       'book',    'unit',       null,  null, '{}'::jsonb, 0, 'active'),
  (:bkOwn,  :orgA, :W4, 'BK-OWN',  'Book Own',     'book',    'unit',       null,  :chF, '{}'::jsonb, 0, 'active'),
  (:bkZ,    :orgA, :W5, 'BK-Z',    'Book Z',       'book',    'unit',       null,  null, '{}'::jsonb, 0, 'active'),
  (:bkD1,   :orgA, :W5, 'BK-D1',   'Book D1',      'book',    'unit',       null,  null, '{}'::jsonb, 0, 'active'),
  (:bkD2,   :orgA, :W5, 'BK-D2',   'Book D2',      'book',    'unit',       null,  null, '{}'::jsonb, 0, 'active'),
  (:bkBZ,   :orgB, :WB, 'BK-BZ',   'Book BZ',      'book',    'unit',       null,  null, '{}'::jsonb, 0, 'active');

insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id, created_at) values
  -- W1: Test A (June), the archived charter's order (May), a pickup (July),
  -- and two opt-in statuses.
  (:OA1,  :orgA, :W1, 'approved',  'internal', :mgr,  'delivery', :chA,   '2026-06-03 18:00+00'),
  (:OA2,  :orgA, :W1, 'completed', 'internal', :mgr,  'delivery', :chA,   '2026-06-04 18:00+00'),
  (:OA3,  :orgA, :W1, 'approved',  'internal', :mgr,  'delivery', :chB,   '2026-06-05 18:00+00'),
  (:OAx,  :orgA, :W1, 'cancelled', 'internal', :mgr,  'delivery', :chB,   '2026-06-06 18:00+00'),
  (:OOld, :orgA, :W1, 'approved',  'internal', :mgr,  'delivery', :chOld, '2026-05-20 18:00+00'),
  (:OP1,  :orgA, :W1, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-07-01 18:00+00'),
  (:ODen, :orgA, :W1, 'denied',    'internal', :mgr,  'pickup',   null,   '2026-07-02 18:00+00'),
  -- W2: Test C.
  (:OC1,  :orgA, :W2, 'approved',  'internal', :mgr,  'delivery', :chC,   '2026-09-05 18:00+00'),
  (:OC2,  :orgA, :W2, 'approved',  'internal', :mgr,  'delivery', :chC,   '2026-10-05 18:00+00'),
  (:OC3,  :orgA, :W2, 'approved',  'internal', :mgr,  'delivery', :chD,   '2026-09-10 18:00+00'),
  -- W2, April: for Charter Moved, which W2 no longer services (below).
  (:OM,   :orgA, :W2, 'approved',  'internal', :mgr,  'delivery', :chMoved, '2026-04-15 18:00+00'),
  -- W3: Test B, pickups. Sep 1 00:00:30 PDT; Sep 15; Oct 1 00:00 PDT; and
  -- Aug 31 23:59:59 PDT, which must stay out of September.
  (:OB1,  :orgA, :W3, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-09-01 07:00:30+00'),
  (:OB2,  :orgA, :W3, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-09-15 18:00+00'),
  (:OB3,  :orgA, :W3, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-10-01 07:00:00+00'),
  (:OB0,  :orgA, :W3, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-09-01 06:59:59+00'),
  -- W4: ownership. Ordered for Charter Elm; the book is owned by Charter Fir.
  (:OOwn, :orgA, :W4, 'approved',  'internal', :mgr,  'delivery', :chE,   '2026-08-10 18:00+00'),
  -- W5: day boundaries (pickups) and Test D.
  (:OZ1,  :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-10-01 06:59:59+00'),  -- Sep 30 23:59:59 PDT
  (:OZ2,  :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-11-01 07:30:00+00'),  -- Nov 1 00:30 PDT
  (:OZ3,  :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-11-02 07:59:00+00'),  -- Nov 1 23:59 PST
  (:OZ4,  :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-11-02 08:00:00+00'),  -- Nov 2 00:00 PST
  (:OZ5,  :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-03-08 09:30:00+00'),  -- Mar 8 01:30 PST
  (:OZ6,  :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-03-09 06:30:00+00'),  -- Mar 8 23:30 PDT
  (:OD,   :orgA, :W5, 'approved',  'internal', :mgr,  'pickup',   null,   '2026-08-15 18:00+00'),
  -- Org B: a foreign charter with a book order.
  (:OBZ,  :orgB, :WB, 'approved',  'internal', :mgrB, 'delivery', :chZ,   '2026-06-10 18:00+00');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:OA1, :bkA, 10), (:OA1, :bkB, 5), (:OA1, :iProd, 50),
  (:OA2, :bkA, 20),
  (:OA3, :bkA, 50), (:OA3, :bkC, 7),
  (:OAx, :bkA, 100),
  (:OOld, :bkA, 4),
  (:OP1, :bkA, 3),
  (:ODen, :bkB, 9),
  (:OC1, :bkU, 10), (:OC2, :bkU, 30), (:OC3, :bkU, 50), (:OM, :bkU, 5),
  (:OB1, :bkT, 10), (:OB2, :bkT, 20), (:OB3, :bkT, 50), (:OB0, :bkT, 7),
  (:OOwn, :bkOwn, 2),
  (:OZ1, :bkZ, 1), (:OZ2, :bkZ, 2), (:OZ3, :bkZ, 4), (:OZ4, :bkZ, 8), (:OZ5, :bkZ, 16), (:OZ6, :bkZ, 32),
  (:OD, :bkD1, 10), (:OD, :bkD2, 20),
  (:OBZ, :bkBZ, 9);
-- Charter Old was retired after its order: archived, with history.
update public.charters set status = 'archived' where id = :chOld;
-- W2 stopped servicing Charter Moved after its order: the database does not
-- tie an order's charter to its warehouse's service list, so its history
-- stays at W2 with no service row (plan trap 22).
delete from public.warehouse_charters where warehouse_id = :W2 and charter_id = :chMoved;

analyze public.order_requests;
analyze public.order_request_lines;
analyze public.inventory_items;
analyze public.warehouses;

-- The disabled member, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ── Helpers ──────────────────────────────────────────────────────────────
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
end $$;
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
end $$;

-- book_order_totals as a persona (the 0379 wrapper plus the charter).
create function pg_temp.bot(
  p_user uuid, p_org uuid, p_statuses text[] default null, p_wh uuid default null, p_cat uuid default null,
  p_uncat boolean default false, p_search text default null, p_keys text[] default null,
  p_sort text default 'copies', p_page int default 1, p_size int default 25,
  p_range text default 'all', p_from date default null, p_to date default null,
  p_all boolean default false, p_max int default null,
  p_charter uuid default null, p_none boolean default false) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.book_order_totals(p_org, p_range, p_from, p_to, p_statuses, p_wh, p_cat, p_uncat,
                                  p_search, p_keys, p_sort, p_page, p_size, p_all, p_max, p_charter, p_none);
  exception when others then
    perform pg_temp.as_owner();
    raise;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- book_order_totals_orders as a persona.
create function pg_temp.bdd(
  p_user uuid, p_org uuid, p_item uuid, p_statuses text[] default null, p_wh uuid default null,
  p_page int default 1, p_size int default 25,
  p_range text default 'all', p_from date default null, p_to date default null,
  p_charter uuid default null, p_none boolean default false) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.book_order_totals_orders(p_org, p_item, p_range, p_from, p_to, p_statuses, p_wh, p_page, p_size,
                                         p_charter, p_none);
  exception when others then
    perform pg_temp.as_owner();
    raise;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- book_order_totals_options as a persona.
create function pg_temp.bopt(p_user uuid, p_org uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.book_order_totals_options(p_org);
  exception when others then
    perform pg_temp.as_owner();
    raise;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- book_order_report_charters as a persona, as a jsonb array (by name).
create function pg_temp.bch(p_user uuid, p_org uuid, p_charter uuid default null) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    select coalesce(jsonb_agg(to_jsonb(c) order by c.name), '[]'::jsonb) into v
      from public.book_order_report_charters(p_org, p_charter) c;
  exception when others then
    perform pg_temp.as_owner();
    raise;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- book_order_report_lines as a persona, as a jsonb array.
create function pg_temp.lines_json(
  p_user uuid, p_org uuid, p_statuses text[] default null, p_wh uuid default null,
  p_range text default 'all', p_from date default null, p_to date default null, p_search text default null,
  p_charter uuid default null, p_none boolean default false) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into v
      from public.book_order_report_lines(p_org, p_range, p_from, p_to, p_statuses, p_wh, null, false,
                                          p_search, null, null, p_charter, p_none) l;
  exception when others then
    perform pg_temp.as_owner();
    raise;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- The error a statement raises as a persona: 'SQLSTATE:hint', or 'no error'.
create function pg_temp.err_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text;
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    perform pg_temp.as_owner();
    return v_state || ':' || coalesce(v_hint, '');
  end;
  perform pg_temp.as_owner();
  return 'no error';
end $$;

-- Everything a caller can read from an error: 'SQLSTATE|hint|message|detail'.
create function pg_temp.errfull_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text; v_detail text;
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint,
                            v_msg = message_text, v_detail = pg_exception_detail;
    perform pg_temp.as_owner();
    return v_state || '|' || coalesce(v_hint, '') || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
  end;
  perform pg_temp.as_owner();
  return 'no error';
end $$;

-- Labels for readable row lists.
create temp table lbl (item_id uuid primary key, label text not null);
insert into lbl values
  (:bkA, 'A'), (:bkB, 'B'), (:bkC, 'C'), (:bkT, 'T'), (:bkZ, 'Z'), (:bkU, 'U'), (:bkD1, 'D1'), (:bkD2, 'D2'),
  (:bkOwn, 'Own'), (:bkPack, 'Pack'), (:iProd, 'Prod'), (:bkBZ, 'BZ');
grant select on lbl to authenticated;

-- "A 30/2, B 5/1": each row's label, copies and orders, in answer order.
create function pg_temp.rs(r jsonb) returns text language sql as $$
  select coalesce(string_agg(coalesce(l.label, t.x->>'itemId') || ' ' || (t.x->>'copies') || '/' || (t.x->>'orders'),
                             ', ' order by t.ord), '')
    from jsonb_array_elements(r->'rows') with ordinality as t(x, ord)
    left join lbl l on l.item_id = (t.x->>'itemId')::uuid
$$;
-- "35/2/2": summary copies / entries / orders.
create function pg_temp.sm(r jsonb) returns text language sql as $$
  select (r#>>'{summary,copies}') || '/' || (r#>>'{summary,entries}') || '/' || (r#>>'{summary,orders}')
$$;
-- "A 30/2, B 5/1 | 35/2/2".
create function pg_temp.rss(r jsonb) returns text language sql as $$
  select pg_temp.rs(r) || ' | ' || pg_temp.sm(r)
$$;
-- One row of an answer.
create function pg_temp.rowof(r jsonb, p_item uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(r->'rows') x where x->>'itemId' = p_item::text
$$;
-- A jsonb answer without its generation time.
create function pg_temp.untimed(r jsonb) returns jsonb language sql as $$
  select r - 'generatedAt' - 'generatedAtLocal'
$$;
-- A charter list (options.charters, byCharter, the charters block) as
-- "Name/status" in list order.
create function pg_temp.cl(r jsonb) returns text language sql as $$
  select coalesce(string_agg(coalesce(t.x->>'name', '(none)') || '/' || coalesce(t.x->>'status', '-'), ',' order by t.ord), '')
    from jsonb_array_elements(r) with ordinality as t(x, ord)
$$;
-- Every key anywhere in a jsonb value.
create function pg_temp.keys(r jsonb) returns setof text language sql as $$
  with recursive walk(v) as (
    select r
    union all
    select c.value
      from walk w
      cross join lateral (
        select e.value from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e
        union all
        select a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a) c
  )
  select k from walk w, jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) k
$$;

-- Full reconciliation for one persona, filter set and charter choice: every
-- page of the report (3 per page) and every page of every drill-down (2 per
-- page), all under the same charter. 'ok', 'skipped' (a warehouse the
-- persona cannot read), or what failed.
create function pg_temp.reconcile(p_user uuid, p_org uuid, p_statuses text[], p_wh uuid, p_search text,
                                  p_charter uuid, p_none boolean)
returns text language plpgsql as $$
declare
  v_first jsonb; v_page jsonb; v_row jsonb; v_dd jsonb; v_ddp jsonb; v_o jsonb;
  v_pages int; v_ddpages int; v_n int := 0; v_copies numeric := 0; v_other numeric := 0;
  v_ids uuid[] := '{}'; v_orders uuid[] := '{}'; v_ddsum numeric; v_ddrows int;
  v_state text; v_hint text;
begin
  begin
    v_first := pg_temp.bot(p_user, p_org, p_statuses, p_wh, null, false, p_search, null, 'copies', 1, 3,
                           p_charter => p_charter, p_none => p_none);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_state = '22023' and v_hint = 'invalid_warehouse' then return 'skipped'; end if;
    return 'error ' || v_state || ' ' || coalesce(v_hint, '');
  end;
  if (v_first#>>'{filters,charter,id}') is distinct from p_charter::text
     or (v_first#>>'{filters,noCharter}')::boolean is distinct from coalesce(p_none, false) then
    return 'charter echo differs';
  end if;
  v_pages := greatest(1, ceil((v_first->>'totalCount')::numeric / 3)::int);
  for p in 1..v_pages loop
    v_page := pg_temp.bot(p_user, p_org, p_statuses, p_wh, null, false, p_search, null, 'copies', p, 3,
                          p_charter => p_charter, p_none => p_none);
    if v_page->'summary' is distinct from v_first->'summary' then return 'summary changed on page ' || p; end if;
    for v_row in select x from jsonb_array_elements(v_page->'rows') x loop
      v_n := v_n + 1;
      v_ids := v_ids || (v_row->>'itemId')::uuid;
      if (v_row->>'countsAsCopies')::boolean then v_copies := v_copies + (v_row->>'copies')::numeric;
      else v_other := v_other + (v_row->>'copies')::numeric; end if;
      v_dd := pg_temp.bdd(p_user, p_org, (v_row->>'itemId')::uuid, p_statuses, p_wh, 1, 2,
                          p_charter => p_charter, p_none => p_none);
      if not (v_dd->>'found')::boolean then return 'drill-down not found: ' || (v_row->>'itemId'); end if;
      if v_dd#>>'{totals,copies}' <> v_row->>'copies' or (v_dd#>>'{totals,orders}')::int <> (v_row->>'orders')::int then
        return 'drill-down header differs from its row: ' || (v_row->>'itemId');
      end if;
      v_ddsum := 0; v_ddrows := 0;
      v_ddpages := greatest(1, ceil((v_dd->>'totalCount')::numeric / 2)::int);
      for q in 1..v_ddpages loop
        v_ddp := pg_temp.bdd(p_user, p_org, (v_row->>'itemId')::uuid, p_statuses, p_wh, q, 2,
                             p_charter => p_charter, p_none => p_none);
        for v_o in select x from jsonb_array_elements(v_ddp->'rows') x loop
          if p_charter is not null and (v_o->>'charterId') is distinct from p_charter::text then
            return 'a drill-down order of another charter';
          end if;
          if coalesce(p_none, false) and (v_o->>'charterId') is not null then
            return 'a chartered drill-down order under no charter';
          end if;
          v_ddsum := v_ddsum + (v_o->>'copies')::numeric;
          v_ddrows := v_ddrows + 1;
          v_orders := v_orders || (v_o->>'orderId')::uuid;
        end loop;
      end loop;
      if v_ddsum <> (v_row->>'copies')::numeric or v_ddrows <> (v_row->>'orders')::int then
        return 'drill-down pages do not add up to the row: ' || (v_row->>'itemId');
      end if;
    end loop;
  end loop;
  if v_n <> (v_first->>'totalCount')::int or v_n <> (v_first#>>'{summary,entries}')::int then
    return 'row count ' || v_n || ' vs ' || (v_first->>'totalCount');
  end if;
  if (select count(distinct x) from unnest(v_ids) x) <> v_n then return 'a row repeated across pages'; end if;
  if v_copies <> (v_first#>>'{summary,copies}')::numeric then return 'copies ' || v_copies || ' vs summary'; end if;
  if v_other <> (v_first#>>'{summary,unresolved,quantity}')::numeric then return 'other units vs summary'; end if;
  if (select count(distinct x) from unnest(v_orders) x) <> (v_first#>>'{summary,orders}')::int then
    return 'union of drill-down orders vs summary orders';
  end if;
  return 'ok';
end $$;

-- The by-charter breakdown for one persona and filter set: buckets add up to
-- the summary (copies and orders), each bucket equals the answer for that
-- charter (or for no charter), every named bucket is one of the persona's
-- options, the No charter bucket is last and present exactly when a line
-- without a charter is in scope.
create function pg_temp.bc_check(p_user uuid, p_org uuid, p_statuses text[], p_wh uuid,
                                 p_range text, p_from date, p_to date, p_search text)
returns text language plpgsql as $$
declare
  v jsonb; v_opt jsonb; v_b jsonb; v_part jsonb; v_lines jsonb;
  v_c numeric := 0; v_o int := 0; v_len int; v_null_at int; v_has_null boolean;
  v_state text; v_hint text;
begin
  begin
    v := pg_temp.bot(p_user, p_org, p_statuses, p_wh, null, false, p_search, null, 'copies', 1, 25,
                     p_range, p_from, p_to);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_state = '22023' and v_hint = 'invalid_warehouse' then return 'skipped'; end if;
    return 'error ' || v_state || ' ' || coalesce(v_hint, '');
  end;
  if jsonb_typeof(v->'byCharter') is distinct from 'array' then return 'byCharter is not a list'; end if;
  v_opt := pg_temp.bopt(p_user, p_org);
  v_len := jsonb_array_length(v->'byCharter');
  for v_b in select x from jsonb_array_elements(v->'byCharter') x loop
    v_c := v_c + (v_b->>'copies')::numeric;
    v_o := v_o + (v_b->>'orders')::int;
    if v_b->>'id' is not null then
      if not exists (select 1 from jsonb_array_elements(v_opt->'charters') c where c->>'id' = v_b->>'id') then
        return 'a bucket that is not one of the options: ' || (v_b->>'id');
      end if;
      v_part := pg_temp.bot(p_user, p_org, p_statuses, p_wh, null, false, p_search, null, 'copies', 1, 25,
                            p_range, p_from, p_to, p_charter => (v_b->>'id')::uuid);
      if (v_part#>>'{filters,charter,name}') is distinct from (v_b->>'name') then return 'bucket name differs'; end if;
    else
      v_part := pg_temp.bot(p_user, p_org, p_statuses, p_wh, null, false, p_search, null, 'copies', 1, 25,
                            p_range, p_from, p_to, p_none => true);
    end if;
    if (v_part#>>'{summary,copies}') <> (v_b->>'copies') or (v_part#>>'{summary,orders}')::int <> (v_b->>'orders')::int then
      return 'bucket differs from the answer for its charter: ' || coalesce(v_b->>'id', 'none');
    end if;
  end loop;
  if v_c <> (v#>>'{summary,copies}')::numeric then return 'bucket copies ' || v_c || ' vs summary'; end if;
  if v_o <> (v#>>'{summary,orders}')::int then return 'bucket orders ' || v_o || ' vs summary'; end if;
  select t.ord into v_null_at from jsonb_array_elements(v->'byCharter') with ordinality t(x, ord)
   where t.x->>'id' is null;
  v_lines := pg_temp.lines_json(p_user, p_org, p_statuses, p_wh, p_range, p_from, p_to, p_search);
  v_has_null := exists (select 1 from jsonb_array_elements(v_lines) e where e->>'order_charter_id' is null);
  if v_has_null is distinct from (v_null_at is not null) then return 'No charter bucket presence differs from the lines'; end if;
  if v_null_at is not null and v_null_at <> v_len then return 'No charter bucket is not last'; end if;
  return 'ok';
end $$;

-- Charter-list parity: options.charters equals (i) the charters on the
-- persona's visible lines (all 13 statuses, all time) plus (ii) the active
-- charters A1/A2 admit, computed here from the base tables (the persona's
-- full-access warehouses and their own pairs); options.noCharter equals "a
-- visible line has no charter".
create function pg_temp.parity(p_user uuid, p_org uuid) returns text language plpgsql as $$
declare
  c_all13 constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  v_opt jsonb; v_lines jsonb; v_role text; v_full uuid[]; v_pairs uuid[]; v_exp uuid[]; v_got uuid[];
begin
  v_opt := pg_temp.bopt(p_user, p_org);
  v_lines := pg_temp.lines_json(p_user, p_org, c_all13);
  select m.role into v_role from public.organization_members m
   where m.organization_id = p_org and m.user_id = p_user;
  v_full := array(select w.id from public.warehouses w
                   where w.organization_id = p_org
                     and (v_role in ('owner', 'admin', 'manager')
                          or exists (select 1 from public.user_warehouse_assignments a
                                      where a.user_id = p_user and a.warehouse_id = w.id and a.charter_id is null)));
  v_pairs := array(select a.charter_id from public.user_warehouse_assignments a
                     join public.warehouses w on w.id = a.warehouse_id
                    where a.user_id = p_user and w.organization_id = p_org and a.charter_id is not null);
  v_exp := array(select s.x from (
             select (e->>'order_charter_id')::uuid x from jsonb_array_elements(v_lines) e
              where e->>'order_charter_id' is not null
             union
             select c.id from public.charters c
              where c.organization_id = p_org and c.status = 'active'
                and (c.id = any (v_pairs)
                     or exists (select 1 from public.warehouse_charters wc
                                 where wc.charter_id = c.id and wc.warehouse_id = any (v_full)))) s
           order by s.x);
  v_got := array(select (x->>'id')::uuid from jsonb_array_elements(v_opt->'charters') x order by 1);
  if v_got is distinct from v_exp then return 'charters ' || v_got::text || ' vs ' || v_exp::text; end if;
  if (v_opt->>'noCharter')::boolean is distinct from
     exists (select 1 from jsonb_array_elements(v_lines) e where e->>'order_charter_id' is null) then
    return 'noCharter differs';
  end if;
  return 'ok ' || cardinality(v_got);
end $$;

-- The warehouse and category lists as the lines helper gives them, as a
-- persona (the 0379 reference, over the 0382 helper).
create function pg_temp.opts_from_lines(p_user uuid, p_org uuid) returns jsonb language plpgsql as $$
declare
  c_all13 constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    with lines as materialized (
           select * from public.book_order_report_lines(p_org, 'all', null, null, c_all13)),
         wh as (select distinct w.id, w.name, w.status
                  from lines l join public.warehouses w on w.id = l.order_warehouse_id),
         cats as (select distinct i.category_id
                    from lines l join public.inventory_items i on i.id = l.item_id)
    select jsonb_build_object(
      'warehouses', coalesce((select jsonb_agg(jsonb_build_object('id', wh.id, 'name', wh.name, 'status', wh.status)
                               order by (wh.status <> 'active'), lower(wh.name), wh.id) from wh), '[]'::jsonb),
      'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                                                                  'deleted', c.deleted_at is not null)
                               order by (c.deleted_at is not null), lower(c.name), c.id)
                                from cats x join public.categories c on c.id = x.category_id), '[]'::jsonb),
      'uncategorized', exists (select 1 from cats x where x.category_id is null))
      into v;
  exception when others then
    perform pg_temp.as_owner();
    raise;
  end;
  perform pg_temp.as_owner();
  return v;
end $$;

-- A persona's whole picture: options, the default, all-status and
-- no-charter answers, and the answer for every charter it may choose.
create function pg_temp.fp(p_user uuid, p_org uuid) returns jsonb language plpgsql as $$
declare
  c_all13 constant text[] := array['pending_approval','approved','pick_slip_generated',
    'picking_in_progress','picking_complete','packing_slip_generated','staged_for_pickup',
    'staged_for_delivery','in_transit','backordered','completed','denied','cancelled'];
  v_opt jsonb; v jsonb; v_c text;
begin
  v_opt := pg_temp.bopt(p_user, p_org);
  v := jsonb_build_object('opt', v_opt - 'v',
                          'def', pg_temp.untimed(pg_temp.bot(p_user, p_org)),
                          'all13', pg_temp.untimed(pg_temp.bot(p_user, p_org, c_all13)),
                          'none', pg_temp.untimed(pg_temp.bot(p_user, p_org, p_none => true)));
  for v_c in select x->>'id' from jsonb_array_elements(v_opt->'charters') x loop
    v := v || jsonb_build_object('c:' || v_c,
                                 pg_temp.untimed(pg_temp.bot(p_user, p_org, c_all13, p_charter => v_c::uuid)));
  end loop;
  return v;
end $$;

-- The range answer for a preset, as a persona, with the org's zone set first.
create function pg_temp.preset(p_org uuid, p_user uuid, p_zone text, p_key text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  update public.organizations set timezone = p_zone where id = p_org;
  perform pg_temp.as_user(p_user);
  select to_jsonb(r) into v from public.book_order_report_range(p_org, p_key) r;
  perform pg_temp.as_owner();
  return v;
end $$;

create temp table res (k text primary key, r jsonb);
grant all on res to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
       where o.organization_id = '03820000-0000-0000-0000-00000000000a') <> 27
     or (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
          where o.organization_id = '03820000-0000-0000-0000-00000000000b') <> 1
     or (select count(*) from public.order_requests
          where organization_id = '03820000-0000-0000-0000-00000000000a' and fulfillment_type = 'delivery'
            and delivery_charter_id is null) <> 0
     or (select status from public.charters where id = '03820000-0000-0000-0000-000000000c08') <> 'archived'
     or exists (select 1 from public.warehouse_charters where charter_id = '03820000-0000-0000-0000-000000000c0a')
     or not exists (select 1 from public.organization_modules where organization_id = '03820000-0000-0000-0000-00000000000a'
                     and module_id = 'books' and enabled)
     or not exists (select 1 from public.user_profiles where id = '03820000-0000-0000-0000-0000000000a7' and disabled_at is not null)
  then raise exception '0382 test fixtures incomplete'; end if;
end $$;

-- ═══ S. Structure ═════════════════════════════════════════════════════════
select is(
  (select string_agg(x.n || ':' || x.c, ',' order by x.n)
     from (select p.proname::text n, count(*) c from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%' group by p.proname) x),
  'book_order_report_charters:1,book_order_report_lines:1,book_order_report_range:1,book_order_totals:1,'
  'book_order_totals_options:1,book_order_totals_orders:1',
  'S1: six book_order% functions, one signature each (no overload of an old identity remains)');

select is(
  array[to_regprocedure('public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer)')::text,
        to_regprocedure('public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer)')::text,
        to_regprocedure('public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid)')::text]
  || array[(to_regprocedure('public.book_order_totals(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], text, integer, integer, boolean, integer, uuid, boolean)') is not null)::text,
           (to_regprocedure('public.book_order_totals_orders(uuid, uuid, text, date, date, text[], uuid, integer, integer, uuid, boolean)') is not null)::text,
           (to_regprocedure('public.book_order_report_lines(uuid, text, date, date, text[], uuid, uuid, boolean, text, text[], uuid, uuid, boolean)') is not null)::text,
           (to_regprocedure('public.book_order_report_charters(uuid, uuid)') is not null)::text,
           (to_regprocedure('public.book_order_report_range(uuid, text, date, date)') is not null)::text,
           (to_regprocedure('public.book_order_totals_options(uuid)') is not null)::text],
  array[null, null, null, 'true', 'true', 'true', 'true', 'true', 'true']::text[],
  'S2: the three 0379 identities that changed are gone; the six 0382 identities exist');

select is(
  (select string_agg(p.proname || ':' || p.prosecdef || ':' || p.provolatile::text || ':'
                     || (p.proconfig @> array['search_path=public', 'plan_cache_mode=force_custom_plan'])::text
                     || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || ':' || exists (select 1 from unnest(p.proacl) a where a::text like '=%'),
                     ',' order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'book_order_report_charters:false:s:true:true:false:false:false,book_order_report_lines:false:s:true:true:false:false:false,'
  'book_order_report_range:false:s:true:true:false:false:false,book_order_totals:false:s:true:true:false:false:false,'
  'book_order_totals_options:false:s:true:true:false:false:false,book_order_totals_orders:false:s:true:true:false:false:false',
  'S3: all six SECURITY INVOKER, STABLE, search_path=public and plan_cache_mode=force_custom_plan; EXECUTE to authenticated only (not anon, service_role or PUBLIC)');

select ok(
  (select bool_and(p.prosrc ~ 'auth\.uid\(\)' and p.prosrc ~ 'is_org_member\(p_organization_id\)'
                   and p.prosrc ~ $re$has_permission\(p_organization_id, 'reports:read'\)$re$
                   and p.prosrc ~ $re$module_enabled\(p_organization_id, 'orders'\)$re$
                   and p.prosrc ~ $re$module_enabled\(p_organization_id, 'books'\)$re$
                   and p.prosrc !~ '40001|40P01'
                   and p.prosrc !~* '\m(insert\s+into|update\s+public|delete\s+from|truncate)\M')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'S4: every function holds the gates in its own body, writes nothing, and never raises 40001/40P01');

select ok(
  (select bool_and(p.prosrc !~* '\m(address|contact_name|contact_email|contact_phone|geocoded_lat|geocoded_lng|geocoded_at|description|notes)\M'
                   and p.prosrc !~ 'i\.charter_id|purchase_orders')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'S5: no body names a charter''s address, contact, geocode, description or notes column, the item''s owning charter, or a purchase order');

select is(
  (select (p.prosrc ~ 'v_from := v_today - extract\(dow from v_today\)::integer; v_to := v_today;')::text
          || '|' || (p.prosrc !~* $re$date_trunc\(\s*'week'$re$)::text
          || '|' || (p.prosrc ~ $re$v_key = 'today' then\s+v_from := v_today; v_to := v_today;$re$)::text
     from pg_proc p where p.oid = 'public.book_order_report_range(uuid, text, date, date)'::regprocedure),
  'true|true|true',
  'S6: This week is today minus its day of week (Sunday start), never an ISO date_trunc week; Today is today to today');

select is(
  (select string_agg(p.proname || ':' || (select count(*) from regexp_matches(p.prosrc, '\(not v_scoped\s+-- E2b-pre', 'g'))
                     || ':' || (select count(*) from regexp_matches(p.prosrc, '\(not v_scoped\s+-- E2b \(exact\)', 'g'))
                     || ':' || (select count(*) from regexp_matches(p.prosrc, '\(not v_scoped or c\.id = any \(v_pairs_ch\) or cardinality\(v_full\) > 0\)', 'g')),
                     ',' order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'book_order_report_charters:1:1:1,book_order_report_lines:1:1:0,book_order_report_range:0:0:0,'
  'book_order_totals:0:0:0,book_order_totals_options:2:2:0,book_order_totals_orders:0:0:0',
  'S7: E2b-pre (leakproof) sits in front of every exact E2b (the lines helper, the charters block''s A3 probe, the two option probes), and the A3 guard is in the charters block');

select is(
  (select (c.prosrc ~ $re$and exists \(select 1\s+from public\.inventory_items i\s+-- items RLS\s+where i\.id = l\.item_id\s+and i\.organization_id = p_organization_id\s+and i\.item_type = 'book' and not i\.is_bundle\s+offset 0\)\s+offset 0\)\)\);$re$)::text
          || '|' || (c.prosrc !~ 'join public\.inventory_items')::text
          || '|' || (o.prosrc ~ $re$'noCharter', exists \(select 1\s+from books b\s+where exists \(select 1\s+from public\.order_request_lines l[^\n]*\n\s+join public\.order_requests o on o\.id = l\.order_request_id[^\n]*\n\s+join public\.warehouses w on w\.id = o\.warehouse_id[^\n]*\n\s+where l\.item_id = b\.id\s+and o\.delivery_charter_id is null$re$)::text
     from pg_proc c, pg_proc o
    where c.oid = 'public.book_order_report_charters(uuid, uuid)'::regprocedure
      and o.oid = 'public.book_order_totals_options(uuid)'::regprocedure),
  'true|true|true',
  'S8: the A3 probe tests the book per line by the items key, fenced (a join scanned every readable book against every line of the charter''s orders), and the No-charter option probes book first');

-- ═══ CB. The charters block's own gates ═══════════════════════════════════
set local "request.jwt.claims" to '';
select is(
  (select array_agg(distinct pg_temp.errfull_as(null, s))
     from unnest(array[
       format('select * from public.book_order_report_charters(%L)', :orgA),
       format('select * from public.book_order_report_charters(%L, %L)', :orgA, :chA)]) s),
  array['42501|unauthenticated|unauthenticated|'],
  'CB1: signed out (claims cleared), the charters block raises 42501 unauthenticated, with or without a charter');

savepoint cb_revoked;
insert into public.user_permission_overrides (organization_id, user_id, permission, granted)
values (:orgA, :mgr, 'reports:read', false);
select is(
  (select array_agg(distinct pg_temp.errfull_as(u, s))
     from unnest(array[:mgrB, :dis, :vNoRep, :mgr]::uuid[]) u,
          unnest(array[
            format('select * from public.book_order_report_charters(%L)', :orgA),
            format('select * from public.book_order_report_charters(%L, %L)', :orgA, :chA),
            format('select * from public.book_order_report_charters(%L, %L)', :orgA, :chZ),
            format('select public.book_order_totals(%L)', :orgA)]) s),
  array['42501|forbidden|forbidden|'],
  'CB2: another org''s manager, a disabled member, a viewer without reports:read and a manager with reports:read revoked get the SAME 42501 forbidden (same message as the report itself), with or without a charter, and no row');
rollback to savepoint cb_revoked;

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'books';
insert into res values ('CB3.books', to_jsonb(pg_temp.errfull_as(:mgr, format('select * from public.book_order_report_charters(%L, %L)', :orgA, :chA))));
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'books';
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
insert into res values ('CB3.orders', to_jsonb(pg_temp.errfull_as(:mgr, format('select * from public.book_order_report_charters(%L)', :orgA))));
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';
select is(
  (select array_agg(distinct r #>> '{}') from res where k like 'CB3.%'),
  array['P0001|module_disabled|module disabled|'],
  'CB3: the books module off, or the orders module off: the charters block raises P0001 module_disabled');

-- ═══ A. Test A: the charter filter ═══════════════════════════════════════
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chA)), 'A 30/2, B 5/1 | 35/2/2',
  'A1: Charter Alder: Book A 30, Book B 5; total 35 copies, 2 books, 2 orders (Book A is not 80; the supplies line never counts)');
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chB)), 'A 50/1, C 7/1 | 57/2/1',
  'A2: Charter Birch: Book A 50, Book C 7; 57 copies, 2 books, 1 order');
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, null, :W1, p_range => 'custom', p_from => '2026-06-01', p_to => '2026-06-30')),
  'A 80/3, C 7/1, B 5/1 | 92/3/3',
  'A3 (control): All charters at W1 in June: Book A 80 across the three orders');

-- ═══ B. Test B: exact dates ══════════════════════════════════════════════
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, null, :W3, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30')),
  'T 30/2 | 30/1/2',
  'B1: Sep 1 to Sep 30: Book T 30 (Sep 1 00:00:30 PDT and Sep 15), 2 orders');
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, null, :W3, p_range => 'custom', p_from => '2026-10-01', p_to => '2026-10-01')),
  'T 50/1 | 50/1/1',
  'B2: Oct 1 to Oct 1: Book T 50 (Oct 1 00:00 PDT)');
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, null, :W3, p_range => 'custom', p_from => '2026-08-31', p_to => '2026-08-31')),
  'T 7/1 | 7/1/1',
  'B3: an order at Aug 31 23:59:59 PDT is Aug 31, so it stays out of Sep 1 to Sep 30 (B1)');

-- ═══ Day boundaries (W5, Book Z, pickups) ════════════════════════════════
select is(
  pg_temp.rss(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30'))
  || ' ; ' || pg_temp.sm(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-10-01', p_to => '2026-10-01')),
  'Z 1/1 | 1/1/1 ; 0/0/0',
  'BD1: Sep 30 23:59:59 PDT is in Sep 1 to Sep 30 and not in Oct 1 to Oct 1 (no 23:59:59 end-of-day cut)');
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-11-01', p_to => '2026-11-01'))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-11-02', p_to => '2026-11-02')),
  'Z 6/2 ; Z 8/1',
  'BD2: Nov 1 (25 hours) holds 00:30 PDT and 23:59 PST (6); Nov 2 00:00 PST is the next day');
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-03-08', p_to => '2026-03-08'))
  || ' ; ' || pg_temp.sm(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-03-09', p_to => '2026-03-09'))
  || ' ; ' || pg_temp.sm(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-03-07', p_to => '2026-03-07')),
  'Z 48/2 ; 0/0/0 ; 0/0/0',
  'BD3: Mar 8 (23 hours) holds 01:30 PST and 23:30 PDT (48); Mar 9 and Mar 7 hold neither');
select is(
  (select string_agg((o->>'orderId') || '=' || (o->>'orderDate')
                     || ':' || (o->>'orderDate' = to_char(q.created_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD'))::text,
                     ',' order by o->>'orderId')
     from jsonb_array_elements(pg_temp.bdd(:mgr, :orgA, :bkZ)->'rows') o
     join public.order_requests q on q.id = (o->>'orderId')::uuid),
  :OZ1::text || '=2026-09-30:true,' || :OZ2::text || '=2026-11-01:true,' || :OZ3::text || '=2026-11-01:true,'
  || :OZ4::text || '=2026-11-02:true,' || :OZ5::text || '=2026-03-08:true,' || :OZ6::text || '=2026-03-08:true',
  'BD4: each drill-down orderDate is the org-local day (to_char(created_at at time zone the zone))');

-- ═══ C. Test C: charter and dates together ═══════════════════════════════
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chC, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30')),
  'U 10/1 | 10/1/1',
  'C1: Charter Cedar, Sep 1 to Sep 30: Book U 10 (not 40, 50 or 90)');
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_charter => :chC))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W2, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30'))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W2))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_charter => :chD, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30')),
  'U 40/2 ; U 60/2 ; U 95/4 ; U 50/1',
  'C2 (control): Cedar all time 40, all charters in September 60, W2 all time 95, Dogwood in September 50');

-- ═══ D. Test D: distinct orders ══════════════════════════════════════════
select is(pg_temp.rss(pg_temp.bot(:mgr, :orgA, null, :W5, p_range => 'custom', p_from => '2026-08-01', p_to => '2026-08-31')),
  'D2 20/1, D1 10/1 | 30/2/1',
  'D1: one order holding Book D1 x10 and Book D2 x20: 1 order (not 2), 2 books, 30 copies');

-- ═══ E. Security ═════════════════════════════════════════════════════════
-- vCh reads only Charter Alder at W1. Charter Birch is in the same org and at
-- the same warehouse, but not theirs.
select is(
  array[pg_temp.err_as(:vCh, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chB)),
        pg_temp.err_as(:vCh, format('select public.book_order_totals(%L, p_all_rows => true, p_charter_id => %L)', :orgA, :chB)),
        pg_temp.err_as(:vCh, format('select public.book_order_totals_orders(%L, %L, p_charter_id => %L)', :orgA, :bkA, :chB)),
        pg_temp.err_as(:vCh, format('select * from public.book_order_report_lines(%L, p_charter_id => %L)', :orgA, :chB))],
  array['22023:invalid_charter', '22023:invalid_charter', '22023:invalid_charter', '22023:invalid_charter'],
  'E1: a charter-limited viewer asking for another charter of the same org and warehouse is refused by the page, the export, the drill-down and the lines helper: no answer, so no name, quantity, count or row');
select is(
  pg_temp.bch(:vCh, :orgA, :chB) || pg_temp.bch(:vCh, :orgA, :chZ) || pg_temp.bch(:vCh, :orgA, :rnd),
  '[]'::jsonb,
  'E2: the charters block returns no row for that charter, another org''s charter or an unknown id');
select is(pg_temp.cl(pg_temp.bopt(:vCh, :orgA)->'charters'), 'Charter Alder/active',
  'E3: the charter-limited viewer''s charter list is exactly their own charter');
-- One refusal for every cause, from every entry point.
select is(
  (select array_agg(distinct pg_temp.errfull_as(x.u, format(x.s, :orgA, x.c)))
     from (select u, c, s
             from (values (:vCh::uuid, :chB::uuid), (:vCh, :chZ), (:vCh, :rnd),
                          (:mgr, :chZ), (:mgr, :rnd), (:mgr, :chNomad), (:mgr, :chIdle),
                          (:stfW2, :chA), (:stfW2, :chZ), (:stfW2, :rnd), (:mgrAB, :chZ), (:vOld, :chA)) p(u, c),
                  unnest(array['select public.book_order_totals(%L, p_charter_id => %L)',
                               'select public.book_order_totals_orders(%L, ''03820000-0000-0000-0000-000000000f01'', p_charter_id => %L)',
                               'select * from public.book_order_report_lines(%L, p_charter_id => %L)']) s
           union all
           select u, c, 'select public.book_order_totals(%L, p_all_rows => true, p_charter_id => %L)'
             from (values (:vCh::uuid, :chB::uuid), (:vCh, :chZ), (:vCh, :rnd), (:mgr, :chZ), (:mgr, :rnd)) e(u, c)) x),
  array['22023|invalid_charter|invalid charter|'],
  'E4: an out-of-scope charter, another org''s charter, an unknown id, an inactive charter without history and an active charter no warehouse services give ONE identical refusal (SQLSTATE, hint, message, detail) from the page, the export, the drill-down and the lines helper, for a charter-limited viewer, a manager, warehouse-limited staff and a two-org manager');
select is(
  pg_temp.rss(pg_temp.bot(:vCh, :orgA, p_charter => :chA))
  || ' ; ' || pg_temp.rss(pg_temp.bot(:vCh, :orgA))
  || ' ; ' || pg_temp.rss(pg_temp.bot(:vCh, :orgA, p_none => true)),
  'A 30/2, B 5/1 | 35/2/2 ; A 33/3, B 5/1 | 38/2/3 ; A 3/1 | 3/1/1',
  'E5: the charter-limited viewer: their charter 30/5; All charters = their charter''s orders plus W1 pickups (38/2/3; Birch''s x57 and the archived charter''s x4 are out, E2b); No charter = the pickup');
select is(
  pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chOld))
  || ' ; ' || (pg_temp.bot(:mgr, :orgA, p_charter => :chOld)#>>'{filters,charter,status}')
  || ' ; ' || (select x->>'status' from jsonb_array_elements(pg_temp.bopt(:mgr, :orgA)->'charters') x where x->>'id' = :chOld::text),
  'A 4/1 | 4/1/1 ; archived ; archived',
  'E6: an archived charter with history is accepted and listed (status archived)');
select is(
  (select jsonb_build_object('sm', pg_temp.sm(r), 'rows', r->'rows', 'charter', r#>'{filters,charter}',
                             'noCharter', r#>'{filters,noCharter}', 'byCharter', r->'byCharter')
     from (select pg_temp.bot(:mgr, :orgA, p_charter => :chA, p_range => 'custom', p_from => '2026-10-01', p_to => '2026-10-31') r) x),
  jsonb_build_object('sm', '0/0/0', 'rows', '[]'::jsonb,
                     'charter', jsonb_build_object('id', :chA::text, 'name', 'Charter Alder', 'code', 'CH-A', 'status', 'active'),
                     'noCharter', false, 'byCharter', null),
  'E7: an authorized charter with nothing in the dates is an honest zero that names it');
select is(
  pg_temp.cl(pg_temp.bopt(:stfW2, :orgA)->'charters')
  || ' ; ' || pg_temp.err_as(:stfW2, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chA))
  || ' ; ' || pg_temp.rss(pg_temp.bot(:stfW2, :orgA)),
  'Charter Cedar/active,Charter Dogwood/active,Charter Moved/active ; 22023:invalid_charter ; U 95/4 | 95/1/4',
  'E8: warehouse-limited staff (W2) may choose only W2''s charters (and one with history there); a W1 charter is refused');
select is(
  pg_temp.cl(pg_temp.bopt(:vMix, :orgA)->'charters')
  || ' ; ' || pg_temp.rss(pg_temp.bot(:vMix, :orgA))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:vMix, :orgA, null, :W1))
  || ' ; ' || pg_temp.err_as(:vMix, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chB)),
  'Charter Alder/active,Charter Cedar/active,Charter Dogwood/active,Charter Moved/active ; U 95/4, A 33/3, B 5/1 | 133/3/7 ; A 33/3, B 5/1 ; 22023:invalid_charter',
  'E9: a viewer with all of W2 and only Alder at W1: every W2 order, and at W1 only Alder''s orders and pickups; Birch is refused');
select is(
  pg_temp.cl(pg_temp.bopt(:vCat, :orgA)->'charters')
  || ' ; ' || pg_temp.rss(pg_temp.bot(:vCat, :orgA, p_charter => :chB))
  || ' ; ' || (pg_temp.bdd(:vCat, :orgA, :bkC, p_charter => :chB)->>'found')
  || ' ; ' || pg_temp.sm(pg_temp.bot(:vCat, :orgA)),
  'Charter Alder/active,Charter Birch/active,Charter Old/archived ; A 50/1 | 50/1/1 ; false ; 92/2/5',
  'E10: a category-limited viewer (Fiction at W1): Birch shows Book A 50 and never Book C (History); its drill-down is found:false');
select is(
  pg_temp.err_as(:mgrAB, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chZ))
  || ' ; ' || pg_temp.cl(pg_temp.bopt(:mgrAB, :orgA)->'charters')
  || ' ; ' || pg_temp.rss(pg_temp.bot(:mgrAB, :orgB, p_charter => :chZ)),
  '22023:invalid_charter ; Charter Alder/active,Charter Birch/active,Charter Cedar/active,Charter Dogwood/active,Charter Elm/active,Charter Fir/active,Charter Moved/active,Charter Old/archived ; BZ 9/1 | 9/1/1',
  'E11: a manager of both orgs cannot use org B''s charter on org A (the org check inside the block) and is never offered it there; on org B it answers');
-- The organization check inside the charters block is defence in depth: A1,
-- A2 and A3 are each bounded to the organization already. It is exercised
-- with a service row no API write can create (W1 of org A servicing org B's
-- charter; the policies refuse it), planted here as the superuser.
savepoint e_crossorg;
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values (:orgB, :W1, :chZ);
select is(
  (select count(*)::int from jsonb_array_elements(pg_temp.bopt(:mgrAB, :orgA)->'charters') x where x->>'id' = :chZ::text)
  || ' ; ' || pg_temp.bch(:mgrAB, :orgA, :chZ)::text
  || ' ; ' || pg_temp.err_as(:mgrAB, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chZ)),
  '0 ; [] ; 22023:invalid_charter',
  'E19: a manager of both orgs asking about org A is never offered or allowed org B''s charter, even if an org A warehouse were recorded as servicing it (the organization check inside the block)');
rollback to savepoint e_crossorg;
select is(
  (select array_agg(distinct pg_temp.err_as(u, format(s, :orgA, c)))
     from unnest(array[:dis, :vNoRep]::uuid[]) u,
          unnest(array[:chZ, :chA]::uuid[]) c,
          unnest(array['select public.book_order_totals(%L, p_charter_id => %L)',
                       'select public.book_order_totals(%L, p_all_rows => true, p_charter_id => %L)',
                       'select public.book_order_totals_orders(%L, ''03820000-0000-0000-0000-000000000f01'', p_charter_id => %L)',
                       'select * from public.book_order_report_lines(%L, p_charter_id => %L)',
                       'select * from public.book_order_report_charters(%L, %L)']) s),
  array['42501:forbidden'],
  'E12: a disabled member and a viewer without reports:read get 42501 forbidden before any charter check, whatever the charter');
select is(
  (select array_agg(distinct pg_temp.err_as(:mgr, format(s, :orgA, :chA)))
     from unnest(array['select public.book_order_totals(%L, p_charter_id => %L, p_no_charter => true)',
                       'select public.book_order_totals(%L, p_all_rows => true, p_charter_id => %L, p_no_charter => true)',
                       'select public.book_order_totals_orders(%L, ''03820000-0000-0000-0000-000000000f01'', p_charter_id => %L, p_no_charter => true)',
                       'select * from public.book_order_report_lines(%L, p_charter_id => %L, p_no_charter => true)']) s),
  array['22023:invalid_charter'],
  'E13: a charter together with "no charter" is refused (invalid_charter) everywhere');
select is(
  (select array_agg(distinct pg_temp.err_as(u, format(s, o)))
     from (values (:mgr::uuid, :orgA::uuid), (:mgrAB, :orgA), (:mgrAB, :orgB), (:vCh, :orgA), (:vMix, :orgA),
                  (:stfW2, :orgA), (:vW4, :orgA), (:vCat, :orgA), (:vOld, :orgA)) p(u, o),
          unnest(array['select public.book_order_totals(%L, p_no_charter => true)',
                       'select public.book_order_totals_orders(%L, ''03820000-0000-0000-0000-000000000f01'', p_no_charter => true)',
                       'select * from public.book_order_report_lines(%L, p_no_charter => true)']) s)
  || (select array_agg(distinct pg_temp.err_as(u, format('select public.book_order_totals(%L, p_all_rows => true, p_no_charter => true)', o)))
        from (values (:mgr::uuid, :orgA::uuid), (:mgrAB, :orgB), (:vCh, :orgA)) p(u, o)),
  array['no error', 'no error'],
  'E14: "no charter" names nothing and never raises, for any persona, in page mode, the drill-down, the lines helper and export mode');
select is(
  (select jsonb_build_object('rows', pg_temp.rs(r), 'mode', r->'mode', 'byCharter', r->'byCharter', 'noCharter', r#>'{filters,noCharter}')
     from (select pg_temp.bot(:vCh, :orgA, p_all => true, p_none => true) r) x),
  '{"rows":"A 3/1","mode":"all","byCharter":null,"noCharter":true}'::jsonb,
  'E15: the charter-limited viewer''s No charter export holds only the W1 pickup (Book A 3)');
select is(
  array[pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_statuses => %L, p_charter_id => %L)', :orgA, '{shipped}', :rnd)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, %L, p_charter_id => %L)', :orgA, 'yesterday', :rnd)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_warehouse_id => %L, p_charter_id => %L)', :orgA, :WB, :rnd)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_category_id => %L, p_charter_id => %L)', :orgA, :rnd, :rnd)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_sort => %L, p_charter_id => %L)', :orgA, 'price', :rnd))],
  array['22023:invalid_status', '22023:invalid_range', '22023:invalid_warehouse', '22023:invalid_category', '22023:invalid_sort'],
  'E16: every existing check runs before the charter''s: status, range, warehouse, category and sort errors win over a bad charter');
select is(
  pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chOld, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30'))
  || ' ; ' || (pg_temp.bot(:mgr, :orgA, p_charter => :chOld, p_range => 'custom', p_from => '2026-09-01', p_to => '2026-09-30')#>>'{filters,charter,name}')
  || ' ; ' || pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_statuses => %L, p_charter_id => %L)', :orgA, '{denied}', :chE)),
  ' | 0/0/0 ; Charter Old ; no error',
  'E17: the charter check is over all statuses and all time, so a chosen charter never turns invalid when the dates or statuses change');
select is(
  pg_temp.cl(pg_temp.bopt(:vOld, :orgA)->'charters')
  || ' ; ' || pg_temp.rss(pg_temp.bot(:vOld, :orgA))
  || ' ; ' || pg_temp.cl(pg_temp.bch(:mgr, :orgA, :chMoved))
  || ' ; ' || pg_temp.rss(pg_temp.bot(:vMix, :orgA, p_charter => :chMoved))
  || ' ; ' || pg_temp.err_as(:vCh, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chMoved)),
  'Charter Old/archived ; A 7/2 | 7/1/2 ; Charter Moved/active ; U 5/1 | 5/1/1 ; 22023:invalid_charter',
  'E18: history keeps a charter reportable: a viewer limited to a charter archived since keeps it (the A3 guard''s own-charter arm), and a charter no warehouse services any more keeps its W2 history for the manager and for a mixed viewer with all of W2 (never "only charters a full warehouse services", plan trap 22); others are refused');

-- ═══ O. Ownership and bill-to are not the filter ═════════════════════════
select is(
  pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chE))
  || ' ; ' || pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chF))
  || ' ; ' || (pg_temp.bot(:mgr, :orgA, p_charter => :chF)#>>'{filters,charter,name}'),
  'Own 2/1 | 2/1/1 ;  | 0/0/0 ; Charter Fir',
  'O1: a book owned by Charter Fir ordered for Charter Elm counts for Elm; Fir is an honest zero with its name');
savepoint o_billto;
insert into public.purchase_orders (id, organization_id, po_number, status, charter_id) values
  (:po1, :orgA, 'PO-0382-1', 'ordered', :chB);
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:orgA, :po1, :bkA, 500, 0, 1);
select is(
  pg_temp.sm(pg_temp.bot(:mgr, :orgA, p_charter => :chB)) || ' ; ' || pg_temp.sm(pg_temp.bot(:mgr, :orgA, p_charter => :chA)),
  '57/2/1 ; 35/2/2',
  'O2: a purchase order billed to Charter Birch for Book A x500 moves nothing');
rollback to savepoint o_billto;

-- ═══ BC. By charter ══════════════════════════════════════════════════════
insert into res values ('mgr.def', pg_temp.bot(:mgr, :orgA));
select is(
  (select string_agg(coalesce(x->>'name', '(none)') || ' ' || (x->>'copies') || '/' || (x->>'orders'), ', ' order by ord)
     from res, jsonb_array_elements(r->'byCharter') with ordinality t(x, ord) where k = 'mgr.def')
  || ' | ' || (select pg_temp.sm(r) from res where k = 'mgr.def'),
  'Charter Birch 57/1, Charter Dogwood 50/1, Charter Cedar 40/2, Charter Alder 35/2, Charter Moved 5/1, Charter Old 4/1, Charter Elm 2/1, (none) 183/12 | 376/9/21',
  'BC1: the manager''s breakdown: charters by copies, No charter (pickups) last; 376 copies in 21 orders across the buckets');
select is(
  (select string_agg(res, ',' order by res)
     from (select distinct pg_temp.bc_check(p.u, p.o, f.s, f.w, f.rk, f.rf, f.rt, f.q) res
             from (values (:mgr::uuid, :orgA::uuid), (:mgrAB, :orgA), (:mgrAB, :orgB), (:vCh, :orgA), (:vMix, :orgA),
                          (:stfW2, :orgA), (:vW4, :orgA), (:vCat, :orgA), (:vOld, :orgA)) p(u, o),
                  (values (null::text[], null::uuid, 'all', null::date, null::date, null::text),
                          (null, :W1::uuid, 'all', null, null, null),
                          (null, null, 'custom', '2026-06-01', '2026-06-30', null),
                          (null, null, 'all', null, null, 'book a'),
                          (:all13::text[], null, 'all', null, null, null)) f(s, w, rk, rf, rt, q)) x),
  'ok,skipped',
  'BC2: for every persona and filter (none, W1, June, a search, denied and cancelled included) the buckets add up to the summary''s copies and orders, each equals the answer for its charter, each is one of the persona''s options, and No charter is last and present exactly when a line without a charter is in scope');
select is(
  jsonb_build_array(pg_temp.bot(:mgr, :orgA, p_charter => :chA)->'byCharter',
                    pg_temp.bot(:mgr, :orgA, p_none => true)->'byCharter',
                    pg_temp.bot(:mgr, :orgA, p_all => true)->'byCharter',
                    jsonb_typeof(pg_temp.bot(:mgr, :orgA)->'byCharter')),
  '[null, null, null, "array"]'::jsonb,
  'BC3: the breakdown is null with a charter chosen, with No charter chosen and in export mode; a list with All charters');
select is(
  (select string_agg(coalesce(x->>'name', '(none)'), ',' order by ord)
     from jsonb_array_elements(pg_temp.bot(:stfW2, :orgA)->'byCharter') with ordinality t(x, ord))
  || ' ; ' || (select string_agg(coalesce(x->>'name', '(none)'), ',' order by ord)
                 from jsonb_array_elements(pg_temp.bot(:vW4, :orgA)->'byCharter') with ordinality t(x, ord))
  || ' ; ' || (select string_agg(coalesce(x->>'name', '(none)') || ' ' || (x->>'copies'), ',' order by ord)
                 from jsonb_array_elements(pg_temp.bot(:vCh, :orgA)->'byCharter') with ordinality t(x, ord)),
  'Charter Dogwood,Charter Cedar,Charter Moved ; Charter Elm ; Charter Alder 35,(none) 3',
  'BC4: no No charter bucket where every visible order has a charter (W2 staff, the W4 viewer); the charter-limited viewer sees their charter and the pickup');
savepoint bc_pack;
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id, created_at)
values (:OPk, :orgA, :W1, 'approved', 'internal', :mgr, 'delivery', :chA, '2026-06-10 18:00+00');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (:OPk, :bkPack, 10);
select is(
  (select x->>'copies' || '/' || (x->>'orders')
     from jsonb_array_elements(pg_temp.bot(:mgr, :orgA)->'byCharter') x where x->>'id' = :chA::text)
  || ' ; ' || pg_temp.sm(pg_temp.bot(:mgr, :orgA))
  || ' ; ' || (pg_temp.bot(:mgr, :orgA)#>>'{summary,unresolved,entries}')
  || ' ; ' || pg_temp.bc_check(:mgr, :orgA, null, null, 'all', null, null, null),
  '35/3 ; 376/10/22 ; 1 ; ok',
  'BC5: a pack-of-10 line on an Alder order adds an order to Alder''s bucket but no copies, exactly like the summary (376 copies, 22 orders)');
-- The lines helper's two new columns, checked while a non-copy unit is in scope.
select is(
  (select count(*)::int || '|' || count(*) filter (where not (e->>'counts_as_copies')::boolean)
          || '|' || bool_and((e->>'order_charter_id') is not distinct from q.delivery_charter_id::text
                             and (e->>'counts_as_copies')::boolean
                                 = (lower(btrim(coalesce(i.unit_of_measure, ''))) in
                                     ('unit','units','ea','each','copy','copies','pc','pcs','piece','pieces')))::text
     from jsonb_array_elements(pg_temp.lines_json(:mgr, :orgA, :all13::text[])) e
     join public.order_requests q on q.id = (e->>'order_id')::uuid
     join public.inventory_items i on i.id = (e->>'item_id')::uuid),
  '27|1|true',
  'BC6: every line''s order_charter_id is its order''s delivery_charter_id and counts_as_copies follows the unit rule (one pack line)');
rollback to savepoint bc_pack;

-- ═══ R. Reconciliation ═══════════════════════════════════════════════════
select is(
  (select string_agg(res, ',' order by res)
     from (select distinct pg_temp.reconcile(p.u, p.o, f.s, f.w, f.q, c.c, c.nc) res
             from (values (:mgr::uuid, :orgA::uuid), (:mgrAB, :orgA), (:mgrAB, :orgB), (:vCh, :orgA), (:vMix, :orgA),
                          (:stfW2, :orgA), (:vW4, :orgA), (:vCat, :orgA), (:vOld, :orgA)) p(u, o)
             cross join lateral (
               select (x->>'id')::uuid c, false nc from jsonb_array_elements(pg_temp.bopt(p.u, p.o)->'charters') x
               union all select null::uuid, true
               union all select null::uuid, false) c
             cross join (values (null::text[], null::uuid, null::text),
                                (:all13::text[], null, null),
                                (null, :W1::uuid, null),
                                (null, null, 'book')) f(s, w, q)) x),
  'ok,skipped',
  'R1: for every persona, every charter it may choose, No charter and All charters, and every filter (default, all statuses, W1, a search): rows over all pages sum to the summary and count to the entries, every drill-down (all pages, only that charter''s orders) equals its row, and the union of drill-down orders is the summary''s orders');
select is(
  (select string_agg((o->>'orderId') || '=' || coalesce(o->>'charterId', '-') || '/' || coalesce(o->>'charterName', '-')
                     || '/' || coalesce(o->>'charterCode', '-'), ',' order by o->>'orderId')
     from jsonb_array_elements(pg_temp.bdd(:mgr, :orgA, :bkA)->'rows') o),
  (select string_agg(q.id::text || '=' || coalesce(q.delivery_charter_id::text, '-') || '/' || coalesce(c.name, '-')
                     || '/' || coalesce(c.code, '-'), ',' order by q.id::text)
     from public.order_requests q
     left join public.charters c on c.id = q.delivery_charter_id
    where q.id in (:OA1, :OA2, :OA3, :OOld, :OP1)),
  'R2: each drill-down order names its own charter (id, name, code), and a pickup none');
select is(
  (select jsonb_build_object('charter', d1->'filters', 'totals', d1#>'{totals}', 'count', d1->'totalCount',
                             'p1', jsonb_array_length(d1->'rows'), 'p2', d2#>>'{rows,0,orderId}', 'p1id', d1#>>'{rows,0,orderId}')
     from (select pg_temp.bdd(:mgr, :orgA, :bkA, p_size => 1, p_charter => :chA) d1,
                  pg_temp.bdd(:mgr, :orgA, :bkA, p_size => 1, p_page => 2, p_charter => :chA) d2) x),
  jsonb_build_object('charter', jsonb_build_object('warehouse', null, 'noCharter', false,
                       'charter', jsonb_build_object('id', :chA::text, 'name', 'Charter Alder', 'code', 'CH-A', 'status', 'active')),
                     'totals', '{"copies":"30","orders":2,"lines":2,"fulfilled":"0","returned":"0"}'::jsonb,
                     'count', 2, 'p1', 1, 'p2', :OA1::text, 'p1id', :OA2::text),
  'R3: the drill-down echoes the charter, and its totals cover every page (30 copies in 2 orders at one order per page)');

-- ═══ P. Options and charter-list parity ══════════════════════════════════
select is(
  (select string_agg(p.label || ':' || (pg_temp.bopt(p.u, p.o)->>'noCharter'), ',' order by p.label)
     from (values ('mgr', :mgr::uuid, :orgA::uuid), ('mgrAB.B', :mgrAB::uuid, :orgB::uuid), ('stfW2', :stfW2::uuid, :orgA::uuid),
                  ('vCat', :vCat::uuid, :orgA::uuid), ('vCh', :vCh::uuid, :orgA::uuid), ('vMix', :vMix::uuid, :orgA::uuid),
                  ('vOld', :vOld::uuid, :orgA::uuid), ('vW4', :vW4::uuid, :orgA::uuid)) p(label, u, o)),
  'mgr:true,mgrAB.B:false,stfW2:false,vCat:true,vCh:true,vMix:true,vOld:true,vW4:false',
  'P1: No charter is offered only where a visible book line has no charter (not to W2 staff, the W4 viewer or on org B)');
select is(
  pg_temp.cl(pg_temp.bopt(:mgr, :orgA)->'charters'),
  'Charter Alder/active,Charter Birch/active,Charter Cedar/active,Charter Dogwood/active,Charter Elm/active,Charter Fir/active,Charter Moved/active,Charter Old/archived',
  'P2: the manager''s list: every active serviced charter (Fir too, with no orders), then the archived one with history; never the inactive charter without history or the one no warehouse services');
select is(
  (select string_agg(p.label || ':' || ((pg_temp.bopt(p.u, p.o) - 'v' - 'orderStatusConfig' - 'charters' - 'noCharter')
                                        = pg_temp.opts_from_lines(p.u, p.o))::text, ',' order by p.label)
     from (values ('mgr', :mgr::uuid, :orgA::uuid), ('mgrAB.A', :mgrAB::uuid, :orgA::uuid), ('mgrAB.B', :mgrAB::uuid, :orgB::uuid),
                  ('stfW2', :stfW2::uuid, :orgA::uuid), ('vCat', :vCat::uuid, :orgA::uuid), ('vCh', :vCh::uuid, :orgA::uuid),
                  ('vMix', :vMix::uuid, :orgA::uuid), ('vOld', :vOld::uuid, :orgA::uuid), ('vW4', :vW4::uuid, :orgA::uuid)) p(label, u, o)),
  'mgr:true,mgrAB.A:true,mgrAB.B:true,stfW2:true,vCat:true,vCh:true,vMix:true,vOld:true,vW4:true',
  'P3: for every persona the probed warehouse and category options still equal the lists the lines helper gives (E2b in the probes)');
select is(
  (select jsonb_build_object('wh', jsonb_path_query_array(o->'warehouses', '$[*].name'),
                             'cats', jsonb_path_query_array(o->'categories', '$[*].name'), 'uncat', o->'uncategorized')
     from (select pg_temp.bopt(:vCh, :orgA) o) x),
  '{"wh":["0382 North"],"cats":["0382 Fiction"],"uncat":false}'::jsonb,
  'P4 (control): the charter-limited viewer is not offered History, whose only book (C) is on Birch''s order although the book itself is readable to them');
select is(
  (select string_agg(p.label || ':' || pg_temp.parity(p.u, p.o), ',' order by p.label)
     from (values ('mgr', :mgr::uuid, :orgA::uuid), ('mgrAB.A', :mgrAB::uuid, :orgA::uuid), ('mgrAB.B', :mgrAB::uuid, :orgB::uuid),
                  ('stfW2', :stfW2::uuid, :orgA::uuid), ('vCat', :vCat::uuid, :orgA::uuid), ('vCh', :vCh::uuid, :orgA::uuid),
                  ('vMix', :vMix::uuid, :orgA::uuid), ('vOld', :vOld::uuid, :orgA::uuid), ('vW4', :vW4::uuid, :orgA::uuid)) p(label, u, o)),
  'mgr:ok 8,mgrAB.A:ok 8,mgrAB.B:ok 1,stfW2:ok 3,vCat:ok 3,vCh:ok 1,vMix:ok 4,vOld:ok 1,vW4:ok 2',
  'P5: for every persona the charter list is exactly the charters on its visible lines plus the active charters its full warehouses service or it is assigned; No charter matches the lines');
-- The same lists and figures with E2b-pre and the A3 guard removed: both are
-- exact consequences of E2b, so they change nothing.
insert into res
select 'fp.' || p.label, pg_temp.fp(p.u, p.o)
  from (values ('mgr', :mgr::uuid, :orgA::uuid), ('mgrAB.A', :mgrAB::uuid, :orgA::uuid), ('mgrAB.B', :mgrAB::uuid, :orgB::uuid),
               ('stfW2', :stfW2::uuid, :orgA::uuid), ('vCat', :vCat::uuid, :orgA::uuid), ('vCh', :vCh::uuid, :orgA::uuid),
               ('vMix', :vMix::uuid, :orgA::uuid), ('vOld', :vOld::uuid, :orgA::uuid), ('vW4', :vW4::uuid, :orgA::uuid)) p(label, u, o);
savepoint no_pre;
do $$
declare f regprocedure; v_def text;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('book_order_report_lines', 'book_order_report_charters', 'book_order_totals_options') loop
    v_def := pg_get_functiondef(f);
    v_def := regexp_replace(v_def, '\(not v_scoped(\s+-- E2b-pre)', '(true or not v_scoped\1', 'g');
    v_def := regexp_replace(v_def, '\(not v_scoped or c\.id = any \(v_pairs_ch\) or cardinality\(v_full\) > 0\)', '(true)', 'g');
    execute v_def;
  end loop;
end $$;
select is(
  (select sum((select count(*) from regexp_matches(p.prosrc, '\(true or not v_scoped\s+-- E2b-pre', 'g')))::int
          || '|' || sum((select count(*) from regexp_matches(p.prosrc, '\(not v_scoped\s+-- E2b-pre', 'g')))::int
          || '|' || sum((select count(*) from regexp_matches(p.prosrc, 'cardinality\(v_full\) > 0', 'g')))::int
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  '4|0|0',
  'P6 (control): the variant really runs without E2b-pre (4 places) and without the A3 guard');
select is(
  (select string_agg(r.k || ':' || (r.r = pg_temp.fp(p.u, p.o))::text, ',' order by r.k)
     from res r
     join (values ('mgr', :mgr::uuid, :orgA::uuid), ('mgrAB.A', :mgrAB::uuid, :orgA::uuid), ('mgrAB.B', :mgrAB::uuid, :orgB::uuid),
                  ('stfW2', :stfW2::uuid, :orgA::uuid), ('vCat', :vCat::uuid, :orgA::uuid), ('vCh', :vCh::uuid, :orgA::uuid),
                  ('vMix', :vMix::uuid, :orgA::uuid), ('vOld', :vOld::uuid, :orgA::uuid), ('vW4', :vW4::uuid, :orgA::uuid)) p(label, u, o) on r.k = 'fp.' || p.label),
  'fp.mgr:true,fp.mgrAB.A:true,fp.mgrAB.B:true,fp.stfW2:true,fp.vCat:true,fp.vCh:true,fp.vMix:true,fp.vOld:true,fp.vW4:true',
  'P7: without E2b-pre and the A3 guard every persona gets the same options, charter lists and figures (default, all statuses, No charter, each charter): both are exact');
rollback to savepoint no_pre;

-- ═══ NB. History with no book ════════════════════════════════════════════
-- Charter Supply (inactive, still on W1's list) has one order, holding only a
-- product: A3 must find no book line, so a manager is not offered it and is
-- refused. W4 gets a product of its own and a pickup holding only that
-- product: vW4 (all of W4, where every other order has a charter) must still
-- not be offered No charter. The control adds a book line to each order.
savepoint nb_products;
\set chSup  '\'03820000-0000-0000-0000-0000000000cc\''
\set iProd4 '\'03820000-0000-0000-0000-000000000f0d\''
\set OSup   '\'03820000-0000-0000-0000-000000000161\''
\set OPk4   '\'03820000-0000-0000-0000-000000000162\''
insert into public.charters (id, organization_id, name, code, status) values
  (:chSup, :orgA, 'Charter Supply', null, 'inactive');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values (:orgA, :W1, :chSup);
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, unit_of_measure, category_id, charter_id,
   custom_fields, quantity_on_hand, status) values
  (:iProd4, :orgA, :W4, 'SUP-4', 'Supplies box W4', 'product', 'unit', null, null, '{}'::jsonb, 0, 'active');
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, delivery_charter_id, created_at) values
  (:OSup, :orgA, :W1, 'approved', 'internal', :mgr, 'delivery', :chSup, '2026-06-20 18:00+00'),
  (:OPk4, :orgA, :W4, 'approved', 'internal', :mgr, 'pickup',   null,   '2026-08-20 18:00+00');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:OSup, :iProd, 12), (:OPk4, :iProd4, 6);
select is(
  (pg_temp.cl(pg_temp.bopt(:mgr, :orgA)->'charters') ~ 'Charter Supply')::text
    || '|' || pg_temp.bch(:mgr, :orgA, :chSup)::text
    || '|' || pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_charter_id => %L)', :orgA, :chSup)),
  'false|[]|22023:invalid_charter',
  'NB1: a charter whose only history is a product line is not offered to a manager and is refused (A3 finds no book line)');
select is(
  (pg_temp.bopt(:vW4, :orgA)->>'noCharter')
    || '|' || jsonb_array_length(pg_temp.lines_json(:vW4, :orgA, :all13, p_none => true))::text,
  'false|0',
  'NB2: a pickup holding only a product does not offer No charter (vW4 sees it, and it has no book line)');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:OSup, :bkA, 1), (:OPk4, :bkOwn, 1);
select is(
  (pg_temp.cl(pg_temp.bopt(:mgr, :orgA)->'charters') ~ 'Charter Supply/inactive')::text
    || '|' || (pg_temp.bopt(:vW4, :orgA)->>'noCharter'),
  'true|true',
  'NB3 (control): with a book line on each order, Charter Supply is offered (inactive, by its history) and No charter is offered to vW4');
rollback to savepoint nb_products;

-- ═══ Z. Today and This week ══════════════════════════════════════════════
savepoint z_zones;
select is(
  (select string_agg(z || ':' || (
            (t->>'range_key') = 'today' and (t->>'from_date')::date = d and (t->>'to_date')::date = d
        and (t->>'starts_at')::timestamptz = d::timestamp at time zone z
        and (t->>'ends_before')::timestamptz = (d + 1)::timestamp at time zone z
        and (t->>'time_zone') = z and not (t->>'time_zone_fallback')::boolean
        and (w->>'range_key') = 'week' and extract(dow from (w->>'from_date')::date) = 0
        and (w->>'from_date')::date <= d and d - (w->>'from_date')::date <= 6 and (w->>'to_date')::date = d
        and (w->>'starts_at')::timestamptz = (w->>'from_date')::date::timestamp at time zone z
        and (w->>'ends_before')::timestamptz = (d + 1)::timestamp at time zone z)::text, ',' order by n)
     from (select u.n, u.z, pg_temp.preset(:orgA, :mgr, u.z, 'today') t, pg_temp.preset(:orgA, :mgr, u.z, 'week') w,
                  (now() at time zone u.z)::date d
             from unnest(array['America/Los_Angeles', 'UTC', 'Pacific/Kiritimati', 'Etc/GMT+12']) with ordinality u(z, n)) x),
  'America/Los_Angeles:true,UTC:true,Pacific/Kiritimati:true,Etc/GMT+12:true',
  'Z1: in Los Angeles, UTC, UTC+14 and UTC-12, Today is today in that zone and This week runs from the latest Sunday to today, as half-open instants of that zone');
select ok(
  ((pg_temp.preset(:orgA, :mgr, 'Pacific/Kiritimati', 'today')->>'from_date')::date
   - (pg_temp.preset(:orgA, :mgr, 'Etc/GMT+12', 'today')->>'from_date')::date) between 1 and 2,
  'Z2: Today follows the organization''s zone (UTC+14 is a day or two ahead of UTC-12 at the same instant)');
rollback to savepoint z_zones;
select is(
  (select jsonb_build_array(bt->'range', bw->'range',
                            bt->'summary' = pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => d, p_to => d)->'summary',
                            bw->'summary' = pg_temp.bot(:mgr, :orgA, p_range => 'custom',
                                                        p_from => d - extract(dow from d)::integer, p_to => d)->'summary',
                            pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, %L)', :orgA, 'Today')))
     from (select pg_temp.bot(:mgr, :orgA, p_range => 'today') bt, pg_temp.bot(:mgr, :orgA, p_range => 'week') bw,
                  (now() at time zone 'America/Los_Angeles')::date d) x),
  (select jsonb_build_array(
            jsonb_build_object('key', 'today', 'from', d, 'to', d, 'timeZone', 'America/Los_Angeles', 'timeZoneFallback', false),
            jsonb_build_object('key', 'week', 'from', d - extract(dow from d)::integer, 'to', d,
                               'timeZone', 'America/Los_Angeles', 'timeZoneFallback', false),
            true, true, '22023:invalid_range')
     from (select (now() at time zone 'America/Los_Angeles')::date d) z),
  'Z3: the report echoes the today and week keys with their resolved days, and answers exactly as the same days chosen as a custom range; a preset is matched exactly (Today is refused)');
select is(
  (select count(*)::int
     from generate_series(date '2025-12-01', date '2027-01-31', interval '1 day') g(t)
     cross join lateral (select g.t::date d) x
     cross join lateral (select x.d - extract(dow from x.d)::integer s) y
    where extract(dow from y.s) = 0 and y.s <= x.d and x.d - y.s <= 6),
  (date '2027-01-31' - date '2025-12-01') + 1,
  'Z4: over every day from 2025-12-01 to 2027-01-31 the week start is a Sunday, never after the day and at most 6 days before it');
select is(
  array[(date '2026-09-27' - extract(dow from date '2026-09-27')::integer),
        (date '2026-01-03' - extract(dow from date '2026-01-03')::integer),
        (date '2027-01-01' - extract(dow from date '2027-01-01')::integer),
        (date '2026-09-29' - extract(dow from date '2026-09-29')::integer),
        date_trunc('week', date '2026-09-29')::date],
  array[date '2026-09-27', date '2025-12-28', date '2026-12-27', date '2026-09-27', date '2026-09-28'],
  'Z5: a Sunday is its own week start; Saturday Jan 3 2026 and Friday Jan 1 2027 start in the year before; Tuesday Sep 29 2026 starts Sunday Sep 27 (an ISO week would start Monday Sep 28)');

-- ═══ M. Private data ═════════════════════════════════════════════════════
select is(
  (select count(*)::int from (
     select pg_temp.keys(pg_temp.bot(:mgr, :orgA, :all13::text[])) k
     union all select pg_temp.keys(pg_temp.bot(:mgr, :orgA, :all13::text[], p_charter => :chA))
     union all select pg_temp.keys(pg_temp.bdd(:mgr, :orgA, :bkA, :all13::text[]))
     union all select pg_temp.keys(pg_temp.bopt(:mgr, :orgA))
     union all select pg_temp.keys(pg_temp.bch(:mgr, :orgA))) x
    where k ~* 'requester|email|user|signature|note|address|contact|geocod|phone'),
  0,
  'M1: no key in any answer (breakdown, charter echoes, charter lists included) names a requester, user, contact, address or note');

-- ═══ C. Current behaviour pinned ═════════════════════════════════════════
-- An approver can change an order's charter through the API (owner question
-- Q7); the report follows the saved value. A superuser update stands in for it.
-- Last in the file and outside any savepoint (pgTAP counts the tests it ran
-- from its stored results, which a savepoint rollback would remove); the
-- final rollback undoes it.
update public.order_requests set delivery_charter_id = :chB where id = :OA2;
select is(
  pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chA)) || ' ; ' || pg_temp.rss(pg_temp.bot(:mgr, :orgA, p_charter => :chB)),
  'A 10/1, B 5/1 | 15/2/1 ; A 70/2, C 7/1 | 77/2/2',
  'C1 pins_current_behaviour_owner_q7: an order moved from Alder to Birch moves its 20 copies with it');

select * from finish();
rollback;
