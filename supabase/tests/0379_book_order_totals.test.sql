-- supabase/tests/0379_book_order_totals.test.sql
-- pgTAP proof for migration 0379 (Book Order Totals).
--
-- G. Structure, grants, gates: five SECURITY INVOKER STABLE functions with
--    search_path=public and plan_cache_mode=force_custom_plan pinned; EXECUTE
--    to authenticated only (not anon, not service_role, not PUBLIC); their
--    gates are in their bodies and none writes or raises 40001/40P01. Signed
--    out (claims cleared): 42501 unauthenticated from every function. A
--    member of another org, a disabled member, a viewer without reports:read
--    and a manager whose reports:read is revoked: the SAME 42501 forbidden.
--    Orders or books module off: P0001 module_disabled.
-- A. The brief's acceptance fixture, exactly: Order 1 Book A x10 + Book B x4
--    + supplies, Order 2 Book A x15, Order 3 Book A x5 awaiting approval, a
--    cancelled Book A x20, a denied Book B x7 (and an unconfirmed Book A x100
--    that never counts). Default scope: A 30 in 3 orders, B 4 in 1, grand
--    total 34, 2 distinct book entries, 3 orders (not 4). O1's Book A line
--    has 8 fulfilled and 2 returned: requested stays 30. Three images, two
--    holdings, two reservations, two return rows, three approval audit rows,
--    a supplier PO and a stock change on Book A move nothing.
-- S. Statuses: denied and cancelled opt-in (A 50/4, B 11/2, 61, 5 orders);
--    pending_confirmation, an unknown status or an empty list: 22023; the SQL
--    allowed (13) and default (11) lists equal the literals core's test holds.
-- L. Lines: a second legitimate Book A line on O2 counts (33, still 3 orders)
--    and the drill-down combines it per order with both line ids kept; a
--    mixed order counts only its book lines; public-link and portal orders
--    count like internal ones; a kit (bundle) never counts.
-- U. Units: a 'pack of 10' book is a row, counts in entries and orders, is
--    left out of the copy total and disclosed (unresolved); the copies sort
--    ranks it after every copy row even at x500.
-- I. Identity: grouped by inventory record; three 'Book A' records stay three
--    rows; the identifier chain; an archived, soft-deleted book keeps its
--    history; retyping a book to a product drops it (pinned).
-- D. Dates: org-local day boundaries with DST (Feb 28 / Mar 1, Mar 31 /
--    Apr 1 PDT, Mar 8 and Nov 1), presets against now(), invalid zones fall
--    back to America/Los_Angeles (never the POSIX-inverted 'UTC+5'), valid
--    ones and all 20 ORG_TIMEZONE_OPTIONS accepted, Pacific/Auckland days,
--    local date strings equal to_char(created_at at time zone <zone>).
-- Q. Search: name, SKU, ISBN keys both ways (hyphenated ISBN-13 barcode,
--    ISBN-10 barcode, legacy custom_fields isbn13), '%' and '_' literal, a
--    5,000-character search truncated, malformed keys 22023.
-- P. Sort and paging: each sort with item-id ties, page clamp, page size
--    clamp, identical summary on every page, union of pages = the set.
-- X. More than max_rows: 1,100 grouped rows and a book on 1,200 orders, as
--    one jsonb; export mode equals the concatenated pages; tooMany above the
--    ceiling with no rows; the ceiling clamped to 50,000.
-- R. Options and filter ids (an archived warehouse, a deleted category, no
--    category) from eligible lines under RLS; invalid ids 22023; for every
--    persona the per-warehouse and per-category copies partition the total;
--    for every persona and filter: sum of rows over all pages = summary
--    copies, rows = entries, union of drill-down orders = summary orders,
--    each drill-down = its row.
-- K. Scope: warehouse-, category- and charter-scoped members see only their
--    books and warehouses (the four joins); a member of two orgs never sees
--    the other org's lines (a cross-org line is planted in each direction);
--    a hidden, non-book or missing item is the same found:false.
-- M. Private data: `mine` is true only on the caller's own order; no answer
--    carries a requester, email, user, signature or note key.
-- C. Current behaviour pinned: a manager can edit an order's created_at and
--    warehouse_id after submission (owner question Q4) and the report follows
--    the saved values; a backorder lowered to its fulfilled quantity reads
--    the saved quantity; a book turned into a rental item keeps its history.
--
-- Roles: fixtures as the test superuser (RLS bypassed, API-role guards
-- exempt); every function call runs as `authenticated` with
-- request.jwt.claim.sub set (pg_temp wrappers switch the role for the call).
-- begin/rollback: nothing leaks. Namespace 03790000.

begin;
select plan(88);

\set orgA     '\'03790000-0000-0000-0000-00000000000a\''
\set orgB     '\'03790000-0000-0000-0000-00000000000b\''
\set orgC     '\'03790000-0000-0000-0000-00000000000c\''
\set own      '\'03790000-0000-0000-0000-0000000000a0\''
\set mgr      '\'03790000-0000-0000-0000-0000000000a1\''
\set stfW1    '\'03790000-0000-0000-0000-0000000000a2\''
\set stfW2    '\'03790000-0000-0000-0000-0000000000a3\''
\set vwrC1    '\'03790000-0000-0000-0000-0000000000a4\''
\set vwrNoRep '\'03790000-0000-0000-0000-0000000000a5\''
\set dis      '\'03790000-0000-0000-0000-0000000000a6\''
\set mgrAB    '\'03790000-0000-0000-0000-0000000000a7\''
\set vwrCh    '\'03790000-0000-0000-0000-0000000000a8\''
\set mgrNoRep '\'03790000-0000-0000-0000-0000000000a9\''
\set mgrB     '\'03790000-0000-0000-0000-0000000000b1\''
\set mgrC     '\'03790000-0000-0000-0000-0000000000b2\''
\set W1       '\'03790000-0000-0000-0000-0000000000d1\''
\set W2       '\'03790000-0000-0000-0000-0000000000d2\''
\set W3       '\'03790000-0000-0000-0000-0000000000d3\''
\set WB       '\'03790000-0000-0000-0000-0000000000d4\''
\set WC       '\'03790000-0000-0000-0000-0000000000d5\''
\set L1       '\'03790000-0000-0000-0000-0000000000e1\''
\set L2       '\'03790000-0000-0000-0000-0000000000e2\''
\set chX      '\'03790000-0000-0000-0000-000000000c01\''
\set chY      '\'03790000-0000-0000-0000-000000000c02\''
\set C1       '\'03790000-0000-0000-0000-000000000c11\''
\set C2       '\'03790000-0000-0000-0000-000000000c12\''
\set C3       '\'03790000-0000-0000-0000-000000000c13\''
\set iA       '\'03790000-0000-0000-0000-000000000f01\''
\set iB       '\'03790000-0000-0000-0000-000000000f02\''
\set iSup     '\'03790000-0000-0000-0000-000000000f03\''
\set iA2      '\'03790000-0000-0000-0000-000000000f04\''
\set iA2nd    '\'03790000-0000-0000-0000-000000000f05\''
\set iOld     '\'03790000-0000-0000-0000-000000000f06\''
\set iPack    '\'03790000-0000-0000-0000-000000000f07\''
\set iBad     '\'03790000-0000-0000-0000-000000000f08\''
\set iPct     '\'03790000-0000-0000-0000-000000000f09\''
\set iC       '\'03790000-0000-0000-0000-000000000f0a\''
\set iU       '\'03790000-0000-0000-0000-000000000f0b\''
\set iX       '\'03790000-0000-0000-0000-000000000f0c\''
\set iSouth   '\'03790000-0000-0000-0000-000000000f0d\''
\set iBA      '\'03790000-0000-0000-0000-000000000f20\''
\set iKit     '\'03790000-0000-0000-0000-000000000f0e\''
\set OPub     '\'03790000-0000-0000-0000-000000000161\''
\set OPor     '\'03790000-0000-0000-0000-000000000162\''
\set OKit     '\'03790000-0000-0000-0000-000000000163\''
\set O1       '\'03790000-0000-0000-0000-000000000101\''
\set O2       '\'03790000-0000-0000-0000-000000000102\''
\set O3       '\'03790000-0000-0000-0000-000000000103\''
\set O4       '\'03790000-0000-0000-0000-000000000104\''
\set O5       '\'03790000-0000-0000-0000-000000000105\''
\set O6       '\'03790000-0000-0000-0000-000000000106\''
\set O7       '\'03790000-0000-0000-0000-000000000107\''
\set O8       '\'03790000-0000-0000-0000-000000000108\''
\set O9       '\'03790000-0000-0000-0000-000000000109\''
\set OW3      '\'03790000-0000-0000-0000-00000000010a\''
\set OU       '\'03790000-0000-0000-0000-00000000010b\''
\set OW2      '\'03790000-0000-0000-0000-00000000010c\''
\set OX       '\'03790000-0000-0000-0000-00000000010d\''
\set O10      '\'03790000-0000-0000-0000-00000000010e\''
\set OB1      '\'03790000-0000-0000-0000-000000000141\''
\set OB2      '\'03790000-0000-0000-0000-000000000142\''
\set ODa      '\'03790000-0000-0000-0000-000000000151\''
\set ODb      '\'03790000-0000-0000-0000-000000000152\''
\set ODc      '\'03790000-0000-0000-0000-000000000153\''
\set ODd      '\'03790000-0000-0000-0000-000000000154\''
\set lO1A     '\'03790000-0000-0000-0000-000000000201\''
\set lO1B     '\'03790000-0000-0000-0000-000000000202\''
\set lO1S     '\'03790000-0000-0000-0000-000000000203\''
\set lO2A     '\'03790000-0000-0000-0000-000000000204\''
\set lO3A     '\'03790000-0000-0000-0000-000000000205\''
\set lO4A     '\'03790000-0000-0000-0000-000000000206\''
\set lO5B     '\'03790000-0000-0000-0000-000000000207\''
\set lO6A     '\'03790000-0000-0000-0000-000000000208\''
\set lOXB     '\'03790000-0000-0000-0000-000000000209\''
\set lOB1     '\'03790000-0000-0000-0000-00000000020a\''
\set lOB2     '\'03790000-0000-0000-0000-00000000020b\''
\set lO2A2    '\'03790000-0000-0000-0000-00000000020c\''
\set lO8B     '\'03790000-0000-0000-0000-00000000020d\''
\set ret1     '\'03790000-0000-0000-0000-000000000301\''
\set ret2     '\'03790000-0000-0000-0000-000000000302\''
\set po1      '\'03790000-0000-0000-0000-000000000401\''
\set cBook1   '\'03790000-0000-0000-0001-000000000001\''
-- The two status lists, as literals. packages/core/src/reports/book-order-totals.test.ts
-- holds the same two literals: if either list changes, both files change.
\set all13    '\'{pending_approval,approved,pick_slip_generated,picking_in_progress,picking_complete,packing_slip_generated,staged_for_pickup,staged_for_delivery,in_transit,backordered,completed,denied,cancelled}\''
\set def11    '\'{pending_approval,approved,pick_slip_generated,picking_in_progress,picking_complete,packing_slip_generated,staged_for_pickup,staged_for_delivery,in_transit,backordered,completed}\''

-- ══ Fixtures ══════════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,      '0379-own@test.local',      '{}'::jsonb),
  (:mgr,      '0379-mgr@test.local',      '{}'::jsonb),
  (:stfW1,    '0379-stfw1@test.local',    '{}'::jsonb),
  (:stfW2,    '0379-stfw2@test.local',    '{}'::jsonb),
  (:vwrC1,    '0379-vwrc1@test.local',    '{}'::jsonb),
  (:vwrNoRep, '0379-vwrnorep@test.local', '{}'::jsonb),
  (:dis,      '0379-dis@test.local',      '{}'::jsonb),
  (:mgrAB,    '0379-mgrab@test.local',    '{}'::jsonb),
  (:vwrCh,    '0379-vwrch@test.local',    '{}'::jsonb),
  (:mgrNoRep, '0379-mgrnorep@test.local', '{}'::jsonb),
  (:mgrB,     '0379-mgrb@test.local',     '{}'::jsonb),
  (:mgrC,     '0379-mgrc@test.local',     '{}'::jsonb)
  on conflict (id) do nothing;

-- An org insert enables the default modules (orders and books among them).
insert into public.organizations (id, name, slug) values
  (:orgA, '0379 Books A', '0379-books-a'),
  (:orgB, '0379 Books B', '0379-books-b'),
  (:orgC, '0379 Books C', '0379-books-c');
update public.organizations set timezone = 'America/Los_Angeles' where id in (:orgA, :orgB, :orgC);
update public.organizations set order_status_config = '{"completed":{"label":"Handed over"}}'::jsonb where id = :orgA;

insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,      'owner',   now()),
  (:orgA, :mgr,      'manager', now()),
  (:orgA, :stfW1,    'staff',   now()),
  (:orgA, :stfW2,    'staff',   now()),
  (:orgA, :vwrC1,    'viewer',  now()),
  (:orgA, :vwrNoRep, 'viewer',  now()),
  (:orgA, :dis,      'staff',   now()),
  (:orgA, :mgrAB,    'manager', now()),
  (:orgB, :mgrAB,    'manager', now()),
  (:orgA, :vwrCh,    'viewer',  now()),
  (:orgA, :mgrNoRep, 'manager', now()),
  (:orgB, :mgrB,     'manager', now()),
  (:orgC, :mgrC,     'manager', now());

insert into public.warehouses (id, organization_id, name, code, status) values
  (:W1, :orgA, '0379 North',     'WH-0379-1', 'active'),
  (:W2, :orgA, '0379 South',     'WH-0379-2', 'active'),
  (:W3, :orgA, '0379 Old Annex', 'WH-0379-3', 'active'),
  (:WB, :orgB, '0379 B Main',    'WH-0379-B', 'active'),
  (:WC, :orgC, '0379 C Main',    'WH-0379-C', 'active');
insert into public.charters (id, organization_id, name) values
  (:chX, :orgA, '0379 Charter X'),
  (:chY, :orgA, '0379 Charter Y');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :W1, :chX),
  (:orgA, :W1, :chY);
insert into public.categories (id, organization_id, name) values
  (:C1, :orgA, '0379 Fiction'),
  (:C2, :orgA, '0379 History'),
  (:C3, :orgA, '0379 Retired');
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stfW1,    :W1, null, true),
  (:orgA, :stfW2,    :W2, null, true),
  (:orgA, :vwrC1,    :W1, null, true),
  (:orgA, :vwrNoRep, :W1, null, true),
  (:orgA, :dis,      :W1, null, true),
  (:orgA, :vwrCh,    :W1, :chY, true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwrC1, :C1);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :vwrC1,    'reports:read', true),
  (:orgA, :vwrCh,    'reports:read', true),
  (:orgA, :mgrNoRep, 'reports:read', false);

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, unit_of_measure, barcode, bin_location,
   category_id, charter_id, custom_fields, quantity_on_hand, status) values
  (:iA,     :orgA, :W1, 'BK-A',    'Book A',       'book',    'unit',       '978-0-14-044913-6', 'R1-A', :C1, null, '{}'::jsonb, 0, 'active'),
  (:iB,     :orgA, :W1, 'BK-B',    'Book B',       'book',    'ea',         '0306406152',        'R1-B', :C2, null, '{}'::jsonb, 0, 'active'),
  (:iSup,   :orgA, :W1, 'SUP-1',   'Supplies box', 'product', 'unit',       null,                null,   :C1, null, '{}'::jsonb, 0, 'active'),
  (:iA2,    :orgA, :W1, 'BK-A',    'Book A',       'book',    'unit',       '9780140449136',     'R2-B', :C1, null, '{}'::jsonb, 0, 'active'),
  (:iA2nd,  :orgA, :W1, 'BK-A-2E', 'Book A',       'book',    'unit',       null,                'R3-C', :C1, null, '{"isbn13":"9780143039433"}'::jsonb, 0, 'active'),
  (:iOld,   :orgA, :W1, 'BK-OLD',  'Book Old',     'book',    'unit',       '9780141439518',     'R4-D', :C2, null, '{}'::jsonb, 0, 'active'),
  (:iPack,  :orgA, :W1, 'BK-PACK', 'Book Pack',    'book',    'pack of 10', '9780679783268',     'R5-E', :C2, null, '{}'::jsonb, 0, 'active'),
  (:iBad,   :orgA, :W1, 'BK-BAD',  'Book Bad',     'book',    'unit',       '9780140449137',     'R6-F', :C2, null, '{}'::jsonb, 0, 'active'),
  (:iPct,   :orgA, :W1, 'BK-PCT',  'Discount 50% off_now', 'book', 'unit', null,                'R7-G', :C2, null, '{}'::jsonb, 0, 'active'),
  (:iC,     :orgA, :W1, 'BK-C',    'Book C',       'book',    'unit',       null,                'R8-H', :C3, null, '{}'::jsonb, 0, 'active'),
  (:iU,     :orgA, :W1, 'BK-U',    'Book U',       'book',    'unit',       null,                'R9-I', null, null, '{}'::jsonb, 0, 'active'),
  (:iX,     :orgA, :W1, 'BK-X',    'Book X',       'book',    'unit',       null,                'R9-J', :C2, :chX, '{}'::jsonb, 0, 'active'),
  (:iSouth, :orgA, :W2, 'BK-S',    'Book South',   'book',    'unit',       null,                'S1-A', :C2, null, '{}'::jsonb, 0, 'active'),
  (:iBA,    :orgB, :WB, 'BK-A',    'Book A',       'book',    'unit',       '9780140449136',     'B1-A', null, null, '{}'::jsonb, 0, 'active');
-- A kit whose type is book: a bundle is never a copy (E5).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, unit_of_measure, category_id, custom_fields,
   quantity_on_hand, status, is_bundle) values
  (:iKit, :orgA, :W1, 'KIT-BOOKS', 'Book Kit', 'book', 'unit', :C1, '{}'::jsonb, 0, 'active', true);
-- Book Old: archived, then soft-deleted. Its history must still count.
update public.inventory_items set status = 'archived' where id = :iOld;
update public.inventory_items set deleted_at = now() where id = :iOld;

-- The brief's orders, all in W1. Dates chosen for the zone tests:
-- O2 at 2026-03-01 07:30Z is Feb 28 23:30 in Los Angeles; O3 at
-- 2026-04-01 06:59Z is Mar 31 23:59 PDT; O4 at 07:00Z is Apr 1 00:00 PDT.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_email, fulfillment_type, created_at) values
  (:O1,  :orgA, :W1, 'approved',             'internal',    :mgr,   null, 'pickup', '2026-02-10 18:00+00'),
  (:O2,  :orgA, :W1, 'completed',            'internal',    :mgr,   null, 'pickup', '2026-03-01 07:30+00'),
  (:O3,  :orgA, :W1, 'pending_approval',     'internal',    :stfW1, null, 'pickup', '2026-04-01 06:59+00'),
  (:O4,  :orgA, :W1, 'cancelled',            'internal',    :mgr,   null, 'pickup', '2026-04-01 07:00+00'),
  (:O5,  :orgA, :W1, 'denied',               'internal',    :mgr,   null, 'pickup', '2026-03-15 18:00+00'),
  (:O6,  :orgA, :W1, 'pending_confirmation', 'public_link', null,   'public-0379@test.local', 'pickup', '2026-03-20 18:00+00'),
  -- Cross-org lines, one in each direction (no constraint stops them):
  -- an org A order carrying org B's look-alike book, and an org B order
  -- carrying org A's Book A. Only the functions' own org filters keep them
  -- out of a two-org manager's totals.
  (:OX,  :orgA, :W1, 'approved',             'internal',    :mgrAB, null, 'pickup', '2026-02-11 18:00+00'),
  (:OB1, :orgB, :WB, 'approved',             'internal',    :mgrB,  null, 'pickup', '2026-02-12 18:00+00'),
  (:OB2, :orgB, :WB, 'approved',             'internal',    :mgrB,  null, 'pickup', '2026-02-12 19:00+00');
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, returned_quantity) values
  (:lO1A, :O1,  :iA,   10,   8, 2),
  (:lO1B, :O1,  :iB,   4,    0, 0),
  (:lO1S, :O1,  :iSup, 50,   0, 0),
  (:lO2A, :O2,  :iA,   15,   0, 0),
  (:lO3A, :O3,  :iA,   5,    0, 0),
  (:lO4A, :O4,  :iA,   20,   0, 0),
  (:lO5B, :O5,  :iB,   7,    0, 0),
  (:lO6A, :O6,  :iA,   100,  0, 0),
  (:lOXB, :OX,  :iBA,  1000, 0, 0),
  (:lOB1, :OB1, :iBA,  9,    0, 0),
  (:lOB2, :OB2, :iA,   1000, 0, 0);

-- Fan-out that must never multiply a sum: 3 images, 2 holdings, 2 active
-- reservations, two returns of one unit each, 3 approval audit rows, a supplier
-- PO and a stock change, all on Book A.
insert into public.item_images (organization_id, item_id, storage_path, is_primary, sort_order) values
  (:orgA, :iA, '03790000-0000-0000-0000-00000000000a/03790000-0000-0000-0000-000000000f01/cover.jpg', true,  0),
  (:orgA, :iA, '03790000-0000-0000-0000-00000000000a/03790000-0000-0000-0000-000000000f01/p2.jpg',    false, 1),
  (:orgA, :iA, '03790000-0000-0000-0000-00000000000a/03790000-0000-0000-0000-000000000f01/p3.jpg',    false, 2);
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:L1, :orgA, :W1, '0379-R1', 'shelf', 'rack'),
  (:L2, :orgA, :W1, '0379-R2', 'shelf', 'rack');
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :iA, :L1, 40),
  (:orgA, :iA, :L2, 60)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity) values
  (:orgA, :iA, :W1, :O1, 2),
  (:orgA, :iA, :W1, :O3, 5);
insert into public.returns (id, organization_id, order_request_id, status, source, requested_by) values
  (:ret1, :orgA, :O1, 'received', 'internal', :mgr),
  (:ret2, :orgA, :O1, 'received', 'internal', :mgr);
insert into public.return_lines (return_id, organization_id, order_request_line_id, item_id, quantity, disposition) values
  (:ret1, :orgA, :lO1A, :iA, 1, 'restock'),
  (:ret2, :orgA, :lO1A, :iA, 1, 'scrap');
insert into public.audit_logs (organization_id, user_id, event, metadata)
select :orgA, :mgr, 'order.approved', jsonb_build_object('order_request_id', :O1::text, 'n', g)
  from generate_series(1, 3) g;
insert into public.purchase_orders (id, organization_id, po_number, status) values
  (:po1, :orgA, 'PO-0379-1', 'ordered');
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:orgA, :po1, :iA, 500, 0, 1);
update public.item_stock_levels set quantity = quantity + 25 where item_id = :iA and location_id = :L1;

-- Org C: 1,100 book records and 1,200 orders. Every order carries book 1
-- (x1); orders 1..1099 also carry book g+1 (x(g % 5 + 1)). More grouped
-- rows than PostgREST's max_rows (1000) and one book on 1,200 orders.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, item_type, unit_of_measure, custom_fields, quantity_on_hand, status)
select ('03790000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid, :orgC, :WC,
       'C-' || lpad(g::text, 4, '0'), 'C Book ' || lpad(g::text, 4, '0'), 'book', 'unit', '{}'::jsonb, 0, 'active'
  from generate_series(1, 1100) g;
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, created_at)
select ('03790000-0000-0000-0002-' || lpad(to_hex(g), 12, '0'))::uuid, :orgC, :WC, 'approved', 'internal', :mgrC,
       'pickup', timestamptz '2026-01-01 18:00+00' + (g || ' minutes')::interval
  from generate_series(1, 1200) g;
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select ('03790000-0000-0000-0002-' || lpad(to_hex(g), 12, '0'))::uuid, :cBook1, 1
  from generate_series(1, 1200) g;
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select ('03790000-0000-0000-0002-' || lpad(to_hex(g), 12, '0'))::uuid,
       ('03790000-0000-0000-0001-' || lpad(to_hex(g + 1), 12, '0'))::uuid, (g % 5) + 1
  from generate_series(1, 1099) g;

-- Fresh statistics for the rows just loaded (rolled back with the rest), so
-- the planner sees 2,300 lines rather than an empty table and the run time
-- does not swing with whatever autovacuum last saw.
analyze public.order_requests;
analyze public.order_request_lines;
analyze public.inventory_items;
analyze public.warehouses;

-- The disabled member, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ── Helpers ──────────────────────────────────────────────────────────────
-- Run as a persona: role authenticated with the caller's sub, for this call.
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
end $$;
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
end $$;

-- book_order_totals as a persona.
create function pg_temp.bot(
  p_user uuid, p_org uuid, p_statuses text[] default null, p_wh uuid default null, p_cat uuid default null,
  p_uncat boolean default false, p_search text default null, p_keys text[] default null,
  p_sort text default 'copies', p_page int default 1, p_size int default 25,
  p_range text default 'all', p_from date default null, p_to date default null,
  p_all boolean default false, p_max int default null) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.book_order_totals(p_org, p_range, p_from, p_to, p_statuses, p_wh, p_cat, p_uncat,
                                  p_search, p_keys, p_sort, p_page, p_size, p_all, p_max);
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
  p_range text default 'all', p_from date default null, p_to date default null) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  begin
    v := public.book_order_totals_orders(p_org, p_item, p_range, p_from, p_to, p_statuses, p_wh, p_page, p_size);
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

-- The message a statement raises as a persona, or 'no error'.
create function pg_temp.errmsg_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_msg text;
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.as_owner();
    return v_msg;
  end;
  perform pg_temp.as_owner();
  return 'no error';
end $$;

-- Labels for readable row lists.
create temp table lbl (item_id uuid primary key, label text not null);
insert into lbl values
  (:iA, 'A'), (:iB, 'B'), (:iSup, 'Sup'), (:iA2, 'A2'), (:iA2nd, 'A2nd'), (:iOld, 'Old'), (:iPack, 'Pack'),
  (:iBad, 'Bad'), (:iPct, 'Pct'), (:iC, 'C'), (:iU, 'U'), (:iX, 'X'), (:iSouth, 'South'), (:iBA, 'BA'), (:iKit, 'Kit');
grant select on lbl to authenticated;

-- "A 30/3, B 4/1": each row's label, copies and orders, in answer order.
create function pg_temp.rs(r jsonb) returns text language sql as $$
  select coalesce(string_agg(coalesce(l.label, t.x->>'itemId') || ' ' || (t.x->>'copies') || '/' || (t.x->>'orders'),
                             ', ' order by t.ord), '')
    from jsonb_array_elements(r->'rows') with ordinality as t(x, ord)
    left join lbl l on l.item_id = (t.x->>'itemId')::uuid
$$;
-- Labels only, in answer order.
create function pg_temp.rl(r jsonb) returns text language sql as $$
  select coalesce(string_agg(coalesce(l.label, t.x->>'itemId'), ',' order by t.ord), '')
    from jsonb_array_elements(r->'rows') with ordinality as t(x, ord)
    left join lbl l on l.item_id = (t.x->>'itemId')::uuid
$$;
-- "34/2/3": summary copies / entries / orders.
create function pg_temp.sm(r jsonb) returns text language sql as $$
  select (r#>>'{summary,copies}') || '/' || (r#>>'{summary,entries}') || '/' || (r#>>'{summary,orders}')
$$;
-- One row of an answer.
create function pg_temp.rowof(r jsonb, p_item uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(r->'rows') x where x->>'itemId' = p_item::text
$$;
-- A jsonb answer without its generation time.
create function pg_temp.untimed(r jsonb) returns jsonb language sql as $$
  select r - 'generatedAt' - 'generatedAtLocal'
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

-- Full reconciliation for one persona and filter set: every page of the
-- report (3 per page) and every page of every drill-down (2 per page).
-- 'ok', 'skipped' (a filter id the persona cannot read), or what failed.
create function pg_temp.reconcile(p_user uuid, p_org uuid, p_statuses text[], p_wh uuid, p_cat uuid, p_search text)
returns text language plpgsql as $$
declare
  v_first jsonb; v_page jsonb; v_row jsonb; v_dd jsonb; v_ddp jsonb; v_o jsonb;
  v_pages int; v_ddpages int; v_n int := 0; v_copies numeric := 0; v_other numeric := 0;
  v_ids uuid[] := '{}'; v_orders uuid[] := '{}'; v_ddsum numeric; v_ddrows int;
  v_state text; v_hint text;
begin
  begin
    v_first := pg_temp.bot(p_user, p_org, p_statuses, p_wh, p_cat, false, p_search, null, 'copies', 1, 3);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_state = '22023' and v_hint in ('invalid_warehouse', 'invalid_category') then return 'skipped'; end if;
    return 'error ' || v_state || ' ' || coalesce(v_hint, '');
  end;
  v_pages := greatest(1, ceil((v_first->>'totalCount')::numeric / 3)::int);
  for p in 1..v_pages loop
    v_page := pg_temp.bot(p_user, p_org, p_statuses, p_wh, p_cat, false, p_search, null, 'copies', p, 3);
    if v_page->'summary' is distinct from v_first->'summary' then return 'summary changed on page ' || p; end if;
    for v_row in select x from jsonb_array_elements(v_page->'rows') x loop
      v_n := v_n + 1;
      v_ids := v_ids || (v_row->>'itemId')::uuid;
      if (v_row->>'countsAsCopies')::boolean then v_copies := v_copies + (v_row->>'copies')::numeric;
      else v_other := v_other + (v_row->>'copies')::numeric; end if;
      v_dd := pg_temp.bdd(p_user, p_org, (v_row->>'itemId')::uuid, p_statuses, p_wh, 1, 2);
      if not (v_dd->>'found')::boolean then return 'drill-down not found: ' || (v_row->>'itemId'); end if;
      if v_dd#>>'{totals,copies}' <> v_row->>'copies' or (v_dd#>>'{totals,orders}')::int <> (v_row->>'orders')::int then
        return 'drill-down header differs from its row: ' || (v_row->>'itemId');
      end if;
      v_ddsum := 0; v_ddrows := 0;
      v_ddpages := greatest(1, ceil((v_dd->>'totalCount')::numeric / 2)::int);
      for q in 1..v_ddpages loop
        v_ddp := pg_temp.bdd(p_user, p_org, (v_row->>'itemId')::uuid, p_statuses, p_wh, q, 2);
        for v_o in select x from jsonb_array_elements(v_ddp->'rows') x loop
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

-- Per-warehouse and per-category copies (and per-warehouse orders) add up to
-- the unfiltered answer, over the persona's own options.
create function pg_temp.partition(p_user uuid, p_org uuid) returns text language plpgsql as $$
declare
  v_opt jsonb; v_all jsonb; v_x jsonb; v_part jsonb; v_wc numeric := 0; v_wo int := 0; v_cc numeric := 0;
begin
  v_opt := pg_temp.bopt(p_user, p_org);
  v_all := pg_temp.bot(p_user, p_org);
  for v_x in select x from jsonb_array_elements(v_opt->'warehouses') x loop
    v_part := pg_temp.bot(p_user, p_org, null, (v_x->>'id')::uuid);
    v_wc := v_wc + (v_part#>>'{summary,copies}')::numeric;
    v_wo := v_wo + (v_part#>>'{summary,orders}')::int;
  end loop;
  for v_x in select x from jsonb_array_elements(v_opt->'categories') x loop
    v_part := pg_temp.bot(p_user, p_org, null, null, (v_x->>'id')::uuid);
    v_cc := v_cc + (v_part#>>'{summary,copies}')::numeric;
  end loop;
  if (v_opt->>'uncategorized')::boolean then
    v_part := pg_temp.bot(p_user, p_org, null, null, null, true);
    v_cc := v_cc + (v_part#>>'{summary,copies}')::numeric;
  end if;
  if v_wc <> (v_all#>>'{summary,copies}')::numeric then return 'warehouse copies ' || v_wc; end if;
  if v_wo <> (v_all#>>'{summary,orders}')::int then return 'warehouse orders ' || v_wo; end if;
  if v_cc <> (v_all#>>'{summary,copies}')::numeric then return 'category copies ' || v_cc; end if;
  return 'ok ' || (v_all#>>'{summary,copies}');
end $$;

-- The range answer for a zone, as a persona, with the org's zone set first.
create function pg_temp.zone_range(p_org uuid, p_user uuid, p_zone text, p_from date, p_to date) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  update public.organizations set timezone = p_zone where id = p_org;
  perform pg_temp.as_user(p_user);
  select to_jsonb(r) into v from public.book_order_report_range(p_org, 'custom', p_from, p_to) r;
  perform pg_temp.as_owner();
  return v;
end $$;

create temp table res (k text primary key, r jsonb);
grant all on res to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
       where o.organization_id = '03790000-0000-0000-0000-00000000000a') <> 9
     or (select count(*) from public.order_request_lines l join public.order_requests o on o.id = l.order_request_id
          where o.organization_id = '03790000-0000-0000-0000-00000000000c') <> 2299
     or (select count(*) from public.inventory_items where organization_id = '03790000-0000-0000-0000-00000000000c') <> 1100
     or (select count(*) from public.item_images where item_id = '03790000-0000-0000-0000-000000000f01') <> 3
     or (select count(*) from public.item_stock_levels where item_id = '03790000-0000-0000-0000-000000000f01' and quantity > 0) < 2
     or (select count(*) from public.stock_reservations where item_id = '03790000-0000-0000-0000-000000000f01' and released_at is null) <> 2
     or (select count(*) from public.return_lines where order_request_line_id = '03790000-0000-0000-0000-000000000201') <> 2
     or (select count(*) from public.audit_logs where organization_id = '03790000-0000-0000-0000-00000000000a' and event = 'order.approved') <> 3
     or (select count(*) from public.purchase_order_items where item_id = '03790000-0000-0000-0000-000000000f01') <> 1
     or not exists (select 1 from public.organization_modules where organization_id = '03790000-0000-0000-0000-00000000000a'
                     and module_id = 'books' and enabled)
     or not exists (select 1 from public.user_profiles where id = '03790000-0000-0000-0000-0000000000a6' and disabled_at is not null)
  then raise exception '0379 test fixtures incomplete'; end if;
end $$;

-- ═══ G. Structure, grants and gates ═══════════════════════════════════════
select is(
  (select string_agg(p.proname || ':' || p.prosecdef || ':' || p.provolatile::text || ':'
                     || (p.proconfig @> array['search_path=public', 'plan_cache_mode=force_custom_plan'])::text,
                     ',' order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'book_order_report_lines:false:s:true,book_order_report_range:false:s:true,book_order_totals:false:s:true,'
  'book_order_totals_options:false:s:true,book_order_totals_orders:false:s:true',
  'G1: five functions, each SECURITY INVOKER, STABLE, with search_path=public and plan_cache_mode=force_custom_plan pinned');

select is(
  (select string_agg(p.proname || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')
                     || ':' || exists (select 1 from unnest(p.proacl) a where a::text like '=%'),
                     ',' order by p.proname)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'book_order_report_lines:true:false:false:false,book_order_report_range:true:false:false:false,'
  'book_order_totals:true:false:false:false,book_order_totals_options:true:false:false:false,'
  'book_order_totals_orders:true:false:false:false',
  'G2: EXECUTE to authenticated only; anon, service_role and PUBLIC hold none (a dropped service_role revoke fails this)');

select ok(
  (select bool_and(p.prosrc ~ 'auth\.uid\(\)' and p.prosrc ~ 'is_org_member\(p_organization_id\)'
                   and p.prosrc ~ $re$has_permission\(p_organization_id, 'reports:read'\)$re$
                   and p.prosrc ~ $re$module_enabled\(p_organization_id, 'orders'\)$re$
                   and p.prosrc ~ $re$module_enabled\(p_organization_id, 'books'\)$re$
                   and p.prosrc !~ '40001|40P01'
                   and p.prosrc !~* '\m(insert\s+into|update\s+public|delete\s+from|truncate)\M')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'book_order%'),
  'G3: every function holds its gates in its own body (signed in, member with reports:read, orders and books modules), writes nothing, and never raises 40001/40P01');

-- Signed out: both claim forms cleared.
set local "request.jwt.claims" to '';
select is(
  (select array_agg(distinct pg_temp.err_as(null, s))
     from unnest(array[
       format('select public.book_order_totals(%L)', :orgA),
       format('select public.book_order_totals_orders(%L, %L)', :orgA, :iA),
       format('select public.book_order_totals_options(%L)', :orgA),
       format('select * from public.book_order_report_lines(%L)', :orgA),
       format('select * from public.book_order_report_range(%L)', :orgA)]) s),
  array['42501:unauthenticated'],
  'G4: with the request claims cleared, every function raises 42501 unauthenticated');

select is(
  (select array_agg(distinct pg_temp.err_as(u, format('select public.book_order_totals(%L)', :orgA)))
     from unnest(array[:mgrB, :dis, :vwrNoRep, :mgrNoRep]::uuid[]) u),
  array['42501:forbidden'],
  'G5: another org''s manager, a disabled member, a viewer without reports:read and a manager with reports:read revoked all get the SAME 42501 forbidden');

select is(
  (select array_agg(distinct pg_temp.err_as(u, s))
     from unnest(array[:mgrB, :vwrNoRep]::uuid[]) u,
          unnest(array[
            format('select public.book_order_totals_orders(%L, %L)', :orgA, :iA),
            format('select public.book_order_totals_options(%L)', :orgA),
            format('select * from public.book_order_report_lines(%L)', :orgA),
            format('select * from public.book_order_report_range(%L)', :orgA)]) s),
  array['42501:forbidden'],
  'G6: the drill-down, options and both building blocks refuse the same callers the same way');

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
insert into res values ('G7.orders', to_jsonb(pg_temp.err_as(:mgr, format('select public.book_order_totals(%L)', :orgA))));
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'books';
insert into res values ('G7.books', to_jsonb(pg_temp.err_as(:mgr, format('select public.book_order_totals_orders(%L, %L)', :orgA, :iA))));
insert into res values ('G7.opts', to_jsonb(pg_temp.err_as(:mgr, format('select public.book_order_totals_options(%L)', :orgA))));
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'books';
select is(
  (select array_agg(distinct r #>> '{}') from res where k like 'G7.%'),
  array['P0001:module_disabled'],
  'G7: the orders module off, or the books module off: P0001 module_disabled');

-- ═══ A. The brief's acceptance fixture ═══════════════════════════════════
insert into res values ('base.mgr', pg_temp.bot(:mgr, :orgA));
select is(pg_temp.rs(r), 'A 30/3, B 4/1',
  'A1: Book A 30 copies requested across 3 orders; Book B 4 across 1 (most copies first)')
  from res where k = 'base.mgr';
select is(pg_temp.sm(r) || '|' || (r->>'totalCount') || '|' || (r#>>'{summary,lines}'), '34/2/3|2|4',
  'A2: grand total 34 copies, 2 distinct book entries, 3 orders containing books (not 4), 4 eligible lines')
  from res where k = 'base.mgr';
select is(
  (select jsonb_build_object('copies', x->'copies', 'fulfilled', x->'fulfilled', 'returned', x->'returned',
                             'lines', x->'lines', 'countsAsCopies', x->'countsAsCopies')
     from res, jsonb_array_elements(r->'rows') x where k = 'base.mgr' and x->>'itemId' = :iA::text),
  '{"copies":"30","fulfilled":"8","returned":"2","lines":3,"countsAsCopies":true}'::jsonb,
  'A3: 8 fulfilled and 2 returned on O1 are separate facts; Book A''s requested total stays 30');
select is(
  (select count(*)::int from public.item_images where item_id = :iA)
  || '|' || (select count(*) from public.item_stock_levels where item_id = :iA and quantity > 0)
  || '|' || (select count(*) from public.stock_reservations where item_id = :iA)
  || '|' || (select count(*) from public.return_lines where item_id = :iA)
  || '|' || (select count(*) from public.audit_logs where organization_id = :orgA and event = 'order.approved')
  || '|' || (select count(*) from public.purchase_order_items where item_id = :iA),
  '3|2|2|2|3|1',
  'A4 (control): the fan-out is planted (3 images, 2 holdings, 2 reservations, 2 return lines, 3 approval audit rows, a supplier PO line), so A1-A3 prove none of it multiplies a sum');
select is(
  jsonb_build_object('first', r#>'{summary,firstOrderDate}', 'last', r#>'{summary,lastOrderDate}',
    'aLatest', pg_temp.rowof(r, :iA)->'latestOrderDate', 'bLatest', pg_temp.rowof(r, :iB)->'latestOrderDate',
    'range', r->'range', 'unresolved', r#>'{summary,unresolved}'),
  '{"first":"2026-02-10","last":"2026-03-31","aLatest":"2026-03-31","bLatest":"2026-02-10",
    "range":{"key":"all","from":null,"to":null,"timeZone":"America/Los_Angeles","timeZoneFallback":false},
    "unresolved":{"entries":0,"quantity":"0"}}'::jsonb,
  'A5: org-local dates (O3 at 06:59Z on Apr 1 is Mar 31 in Los Angeles), the all-time range and the zone are echoed')
  from res where k = 'base.mgr';
select is(
  jsonb_build_object('v', r->'v', 'statuses', r->'statuses', 'mode', r->'mode', 'page', r->'page',
                     'pageSize', r->'pageSize', 'sort', r->'sort', 'tooMany', r->'tooMany', 'maxRows', r->'maxRows',
                     'restricted', r#>'{scope,restricted}', 'filters', r->'filters'),
  jsonb_build_object('v', 1, 'statuses', to_jsonb(:def11::text[]), 'mode', 'page', 'page', 1, 'pageSize', 25,
                     'sort', 'copies', 'tooMany', false, 'maxRows', null, 'restricted', false,
                     'filters', '{"warehouse":null,"category":null,"uncategorized":false}'::jsonb),
  'A6: the default answer echoes the 11 default statuses (the literal core holds), page 1 of 25, most copies, unrestricted for a manager')
  from res where k = 'base.mgr';
select is(
  pg_temp.untimed(pg_temp.bot(:own, :orgA)),
  (select pg_temp.untimed(r) from res where k = 'base.mgr'),
  'A7: the owner gets the manager''s answer exactly');

-- ═══ S. Statuses ═════════════════════════════════════════════════════════
insert into res values ('all13.mgr', pg_temp.bot(:mgr, :orgA, :all13::text[]));
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 50/4, B 11/2 | 61/2/5',
  'S1: with denied and cancelled included: A 50 in 4 orders, B 11 in 2, total 61 in 5 orders; the unconfirmed x100 never counts')
  from res where k = 'all13.mgr';
select is(r->'statuses', to_jsonb(:all13::text[]),
  'S2: the 13 selectable statuses echo back in canonical order (the literal core holds)')
  from res where k = 'all13.mgr';
select is(
  array[pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_statuses => %L)', :orgA, '{approved,pending_confirmation}')),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_statuses => %L)', :orgA, '{shipped}')),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_statuses => %L)', :orgA, '{}')),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_statuses => %L)', :orgA, '{approved,NULL}'))],
  array['22023:invalid_status', '22023:invalid_status', '22023:invalid_status', '22023:invalid_status'],
  'S3: pending_confirmation, an unknown status, an empty list and a null element are all 22023 invalid_status');
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, '{denied,cancelled}'::text[])), 'A 20/1, B 7/1',
  'S4: denied and cancelled alone: the cancelled A x20 and the denied B x7');
select is(pg_temp.sm(pg_temp.bot(:mgr, :orgA, '{completed}'::text[])), '15/1/1',
  'S5: a completed order stays in the report (O2, A x15)');

-- ═══ L. Lines ════════════════════════════════════════════════════════════
savepoint l_dup;
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested)
values (:lO2A2, :O2, :iA, 3);
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 33/3, B 4/1 | 37/2/3',
  'L1: a second legitimate Book A line on O2 counts: A 33, still 3 orders')
  from (select pg_temp.bdd(:mgr, :orgA, :iA) d, pg_temp.bot(:mgr, :orgA) r) x;
select is(
  (select jsonb_build_object('copies', o->'copies', 'lines', o->'lines', 'lineIds', o->'lineIds')
     from jsonb_array_elements(pg_temp.bdd(:mgr, :orgA, :iA)->'rows') o where o->>'orderId' = :O2::text),
  jsonb_build_object('copies', '18', 'lines', 2, 'lineIds', jsonb_build_array(:lO2A::text, :lO2A2::text)),
  'L2: the drill-down combines O2''s two lines into one row of 18 copies and keeps both line ids');
select is(
  (select jsonb_build_object('found', d->'found', 'totals', d->'totals', 'totalCount', d->'totalCount')
     from (select pg_temp.bdd(:mgr, :orgA, :iA) d) x),
  '{"found":true,"totals":{"copies":"33","orders":3,"lines":4,"fulfilled":"8","returned":"2"},"totalCount":3}'::jsonb,
  'L3: the drill-down header is the book''s full total: 33 copies in 3 orders from 4 lines');
rollback to savepoint l_dup;
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, null, null, false, null, null, 'copies', 1, 25)), 'A 30/3, B 4/1',
  'L4: a mixed order counts only its book lines (O1''s 50 supplies never appear)');
savepoint l_sources;
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, requester_email, fulfillment_type, created_at) values
  (:OPub, :orgA, :W1, 'approved', 'public_link', null, 'public-0379@test.local', 'pickup', '2026-05-20 18:00+00'),
  (:OPor, :orgA, :W1, 'approved', 'portal',      :mgr, null,                     'pickup', '2026-05-21 18:00+00'),
  (:OKit, :orgA, :W1, 'approved', 'internal',    :mgr, null,                     'pickup', '2026-05-22 18:00+00');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:OPub, :iB, 2), (:OPor, :iB, 1), (:OKit, :iKit, 9);
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 30/3, B 7/3 | 37/2/5',
  'L5: a confirmed public-link order and a portal order count like internal ones; a kit (a bundle, even of type book) never counts')
  from (select pg_temp.bot(:mgr, :orgA) r) x;
rollback to savepoint l_sources;

-- ═══ K. Scope ════════════════════════════════════════════════════════════
select is(pg_temp.sm(r) || '|' || (r#>>'{scope,restricted}'), '34/2/3|true',
  'K1: staff assigned to W1 see every W1 order (34/2/3) and are told their scope is restricted')
  from (select pg_temp.bot(:stfW1, :orgA) r) x;
select is(pg_temp.sm(r) || '|' || jsonb_array_length(r->'rows') || '|' || (r#>>'{scope,restricted}'), '0/0/0|0|true',
  'K2: staff assigned only to W2 get an empty, restricted answer (no W1 order or book)')
  from (select pg_temp.bot(:stfW2, :orgA) r) x;
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r) || '|' || (r#>>'{scope,restricted}'), 'A 30/3 | 30/1/3|true',
  'K3: a viewer limited to category C1 sees Book A only (never Book B, category C2)')
  from (select pg_temp.bot(:vwrC1, :orgA) r) x;
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 30/3, B 4/1 | 34/2/3',
  'K4: a manager of orgs A and B asking about A: the org B order carrying Book A (x1000) and the org A order carrying org B''s book (x1000) are both left out')
  from (select pg_temp.bot(:mgrAB, :orgA) r) x;
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'BA 9/1 | 9/1/1',
  'K5: the same manager asking about B sees only org B''s book on org B''s order')
  from (select pg_temp.bot(:mgrAB, :orgB) r) x;
select is(pg_temp.sm(pg_temp.bot(:vwrCh, :orgA)), '34/2/3',
  'K6: a charter-scoped viewer with reports:read sees W1''s uncharted books');
select ok(
  (select count(distinct pg_temp.untimed(d))
     from unnest(array[
       pg_temp.bdd(:vwrC1, :orgA, :iB),
       pg_temp.bdd(:vwrC1, :orgA, :iSup),
       pg_temp.bdd(:vwrC1, :orgA, '03790000-0000-0000-0000-00000000ffff')]) d) = 1
  and (pg_temp.bdd(:vwrC1, :orgA, :iB)->>'found') = 'false'
  and pg_temp.bdd(:vwrC1, :orgA, :iB)->'rows' = '[]'::jsonb
  and pg_temp.bdd(:vwrC1, :orgA, :iB)->'book' = 'null'::jsonb
  and pg_temp.bdd(:vwrC1, :orgA, :iB)#>>'{totals,copies}' = '0',
  'K7: a book hidden from the caller, a product and a random id give the SAME found:false answer with no rows');
select is(
  pg_temp.err_as(:mgr, format('select public.book_order_totals_orders(%L, null)', :orgA)),
  '22023:invalid_item',
  'K8: a drill-down without an item is refused (it would otherwise answer for every book)');

-- ═══ M. Private data ═════════════════════════════════════════════════════
select is(
  (select string_agg((o->>'orderNumber') || ':' || (o->>'mine'), ',' order by (o->>'createdAt'))
     from jsonb_array_elements(pg_temp.bdd(:stfW1, :orgA, :iA)->'rows') o),
  (select string_agg(order_number || ':' || (id = :O3)::text, ',' order by created_at)
     from public.order_requests where id in (:O1, :O2, :O3)),
  'M1: mine is true only on the caller''s own order (O3, placed by this staff member)');
select is(
  (select count(*)::int from (
     select pg_temp.keys(pg_temp.bot(:mgr, :orgA, :all13::text[])) k
     union all select pg_temp.keys(pg_temp.bdd(:mgr, :orgA, :iA, :all13::text[]))
     union all select pg_temp.keys(pg_temp.bopt(:mgr, :orgA))) x
    where k ~* 'requester|email|user|signature|note'),
  0,
  'M2: no key anywhere in the totals, drill-down or options answers names a requester, email, user, signature or note');

-- ═══ D. Dates and time zones ═════════════════════════════════════════════
select is(
  (select jsonb_build_object('from', r->'from_date', 'to', r->'to_date', 'starts', r->'starts_at', 'ends', r->'ends_before',
                             'tz', r->'time_zone', 'fb', r->'time_zone_fallback')
     from (select pg_temp.zone_range(:orgA, :mgr, 'America/Los_Angeles', '2026-02-01', '2026-02-28') r) x),
  '{"from":"2026-02-01","to":"2026-02-28","starts":"2026-02-01T08:00:00+00:00","ends":"2026-03-01T08:00:00+00:00",
    "tz":"America/Los_Angeles","fb":false}'::jsonb,
  'D1: February in Los Angeles is [Feb 1 08:00Z, Mar 1 08:00Z): the end is the day after the last day, exclusive');
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 25/2, B 4/1 | 29/2/2',
  'D2: February includes O2 (2026-03-01 07:30Z is Feb 28 23:30 PST)')
  from (select pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-02-01', p_to => '2026-02-28') r) x;
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 5/1 | 5/1/1',
  'D3: March (default statuses) holds only O3 (Apr 1 06:59Z = Mar 31 23:59 PDT) and not O2')
  from (select pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-03-01', p_to => '2026-03-31') r) x;
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'B 7/1, A 5/1 | 12/2/2',
  'D4: March with every status includes 06:59Z (O3) and excludes 07:00Z (O4, Apr 1 00:00 PDT)')
  from (select pg_temp.bot(:mgr, :orgA, :all13::text[], p_range => 'custom', p_from => '2026-03-01', p_to => '2026-03-31') r) x;
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, :all13::text[], p_range => 'custom', p_from => '2026-04-01', p_to => '2026-04-30')),
  'A 20/1', 'D5: April with every status starts at 07:00Z and holds O4');
select is(
  (select string_agg((r->>'starts_at') || '..' || (r->>'ends_before'), ' ; ' order by n)
     from (select 1 n, pg_temp.zone_range(:orgA, :mgr, 'America/Los_Angeles', '2026-03-08', '2026-03-08') r
           union all
           select 2, pg_temp.zone_range(:orgA, :mgr, 'America/Los_Angeles', '2026-11-01', '2026-11-01')) x),
  '2026-03-08T08:00:00+00:00..2026-03-09T07:00:00+00:00 ; 2026-11-01T07:00:00+00:00..2026-11-02T08:00:00+00:00',
  'D6: DST days: Mar 8 runs 08:00Z..07:00Z (23 hours), Nov 1 runs 07:00Z..08:00Z (25 hours)');
savepoint d_dst;
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, created_at) values
  (:ODa, :orgA, :W1, 'approved', 'internal', :mgr, 'pickup', '2026-03-09 06:30+00'),  -- Mar 8 23:30 PDT
  (:ODb, :orgA, :W1, 'approved', 'internal', :mgr, 'pickup', '2026-03-08 07:30+00'),  -- Mar 7 23:30 PST
  (:ODc, :orgA, :W1, 'approved', 'internal', :mgr, 'pickup', '2026-11-02 07:30+00'),  -- Nov 1 23:30 PST
  (:ODd, :orgA, :W1, 'approved', 'internal', :mgr, 'pickup', '2026-11-01 06:30+00');  -- Oct 31 23:30 PDT
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:ODa, :iB, 1), (:ODb, :iB, 2), (:ODc, :iB, 3), (:ODd, :iB, 4);
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-03-08', p_to => '2026-03-08'))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-11-01', p_to => '2026-11-01')),
  'B 1/1 ; B 3/1',
  'D7: orders on either side of a DST day''s edges land on the right local day');
rollback to savepoint d_dst;
select is(
  (select string_agg(k || '=' || (r->>'from') || '..' || (r->>'to'), ' ' order by k)
     from (select k, pg_temp.bot(:mgr, :orgA, p_range => k)->'range' r
             from unnest(array['month', '30d', '90d', 'year']) k) x),
  (select string_agg(k || '=' || f || '..' || t, ' ' order by k)
     from (select 'month' k, date_trunc('month', d)::date::text f, d::text t from (select (now() at time zone 'America/Los_Angeles')::date d) z
           union all select '30d', (d - 29)::text, d::text from (select (now() at time zone 'America/Los_Angeles')::date d) z
           union all select '90d', (d - 89)::text, d::text from (select (now() at time zone 'America/Los_Angeles')::date d) z
           union all select 'year', date_trunc('year', d)::date::text, d::text from (select (now() at time zone 'America/Los_Angeles')::date d) z) y),
  'D8: presets resolve against today in the org''s zone: This month, Last 30 days, Last 90 days, This year');
savepoint d_zones;
select is(
  (select array_agg(distinct pg_temp.err_as(:mgr, s))
     from unnest(array[
       format('select public.book_order_totals(%L, %L)', :orgA, 'yesterday'),
       format('select public.book_order_totals(%L, %L, %L, %L)', :orgA, 'custom', '2026-03-02', '2026-03-01'),
       format('select public.book_order_totals(%L, %L, %L, null)', :orgA, 'custom', '2026-03-01'),
       format('select public.book_order_totals(%L, %L, %L, %L)', :orgA, 'custom', '1999-12-31', '2026-03-01'),
       format('select public.book_order_totals_orders(%L, %L, %L, %L, %L)', :orgA, :iA, 'custom', '2026-03-02', '2026-03-01')]) s),
  array['22023:invalid_range'],
  'D9: an unknown preset, from after to, a missing end and a date before 2000 are 22023 invalid_range');
select is(
  (select string_agg(z || '>' || (r->>'time_zone') || ':' || (r->>'time_zone_fallback') || ':' || (r->>'starts_at'), ' ; ' order by z)
     from (select z, pg_temp.zone_range(:orgA, :mgr, z, '2026-02-01', '2026-02-28') r
             from unnest(array['UTC+5', '', 'America/Fresno', 'PST', 'Not a zone; drop table x']) z) x),
  '>America/Los_Angeles:true:2026-02-01T08:00:00+00:00 ; America/Fresno>America/Los_Angeles:true:2026-02-01T08:00:00+00:00 ; '
  'Not a zone; drop table x>America/Los_Angeles:true:2026-02-01T08:00:00+00:00 ; PST>America/Los_Angeles:true:2026-02-01T08:00:00+00:00 ; '
  'UTC+5>America/Los_Angeles:true:2026-02-01T08:00:00+00:00',
  'D10: a POSIX offset (never read with its inverted sign), a blank, an unknown IANA name, an abbreviation and junk fall back to Los Angeles days, flagged');
select is(
  (select string_agg(z || ':' || (r->>'time_zone_fallback') || ':' || (r->>'starts_at'), ' ; ' order by z)
     from (select z, pg_temp.zone_range(:orgA, :mgr, z, '2026-02-01', '2026-02-28') r
             from unnest(array['Etc/GMT+5', 'UTC', 'Pacific/Auckland', 'America/Argentina/Buenos_Aires']) z) x),
  'America/Argentina/Buenos_Aires:false:2026-02-01T03:00:00+00:00 ; Etc/GMT+5:false:2026-02-01T05:00:00+00:00 ; '
  'Pacific/Auckland:false:2026-01-31T11:00:00+00:00 ; UTC:false:2026-02-01T00:00:00+00:00',
  'D11: real zone names are used as they are, including three-part and Etc names');
-- apps/web/src/lib/timezone-options.ts ORG_TIMEZONE_OPTIONS, as a literal
-- (20 zones; apps/web/src/lib/reports/book-order-totals-zones.test.ts holds
-- the same list against the web constant).
select is(
  (select count(*)::int
     from unnest(array['UTC','America/New_York','America/Chicago','America/Denver','America/Phoenix',
                       'America/Los_Angeles','America/Anchorage','Pacific/Honolulu','America/Toronto',
                       'America/Vancouver','America/Mexico_City','Europe/London','Europe/Paris','Europe/Berlin',
                       'Europe/Madrid','Asia/Tokyo','Asia/Singapore','Asia/Hong_Kong','Asia/Manila',
                       'Australia/Sydney']) z
    where (pg_temp.zone_range(:orgA, :mgr, z, '2026-02-01', '2026-02-28')->>'time_zone') = z
      and (pg_temp.zone_range(:orgA, :mgr, z, '2026-02-01', '2026-02-28')->>'time_zone_fallback') = 'false'),
  20,
  'D12: every zone the organization settings offer (all 20) is accepted as is');
rollback to savepoint d_zones;
savepoint d_akl;
update public.organizations set timezone = 'Pacific/Auckland' where id = :orgA;
select is(
  jsonb_build_object('first', r#>'{summary,firstOrderDate}', 'bLatest', pg_temp.rowof(r, :iB)->'latestOrderDate',
                     'aLatest', pg_temp.rowof(r, :iA)->'latestOrderDate', 'tz', r#>'{range,timeZone}',
                     'feb28', pg_temp.sm(pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-02-28', p_to => '2026-02-28')),
                     'mar1', pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-03-01', p_to => '2026-03-01'))),
  '{"first":"2026-02-11","bLatest":"2026-02-11","aLatest":"2026-04-01","tz":"Pacific/Auckland","feb28":"0/0/0","mar1":"A 15/1"}'::jsonb,
  'D13: an organization in Pacific/Auckland gets its own days: O1 is Feb 11 there, and O2 is Mar 1, not Feb 28')
  from (select pg_temp.bot(:mgr, :orgA) r) x;
rollback to savepoint d_akl;
select is(
  (select count(*)::int
     from jsonb_array_elements(pg_temp.bdd(:mgr, :orgA, :iA, :all13::text[])->'rows') o
     join public.order_requests q on q.id = (o->>'orderId')::uuid
    where o->>'orderDate' = to_char(q.created_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD')),
  4,
  'D14: every drill-down orderDate equals to_char(created_at at time zone <the zone used>) (Feb 28 for O2, Mar 31 for O3, Apr 1 for O4)');

-- ═══ C. Current behaviour pinned ═════════════════════════════════════════
savepoint c_q4;
select is(
  pg_temp.err_as(:mgr, format($$update public.order_requests set created_at = '2026-01-15T18:00Z' where id = %L$$, :O2))
  || '|' || pg_temp.err_as(:mgr, format($$update public.order_requests set warehouse_id = %L where id = %L$$, :W2, :O3)),
  'no error|no error',
  'C1 pins_current_behaviour_owner_q4: a manager can still edit an order''s created_at and warehouse_id after submission');
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_range => 'custom', p_from => '2026-01-01', p_to => '2026-01-31'))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W2))
  || ' ; ' || (pg_temp.rowof(pg_temp.bot(:mgr, :orgA, null, :W2), :iA)->>'warehouseId'),
  'A 15/1 ; A 5/1 ; ' || :W1::text,
  'C2 pins_current_behaviour_owner_q4: the report follows the saved values (O2 moves into January, O3''s x5 into the W2 filter) while the row still shows Book A''s own warehouse');
rollback to savepoint c_q4;
savepoint c_lower;
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, created_at)
values (:O8, :orgA, :W1, 'backordered', 'internal', :mgr, 'pickup', '2026-05-10 18:00+00');
insert into public.order_request_lines (id, order_request_id, item_id, quantity_requested, quantity_fulfilled)
values (:lO8B, :O8, :iB, 20, 12);
set local role to 'service_role';
update public.order_request_lines set quantity_requested = 12 where id = :lO8B;
reset role;
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA))
  || ' ; ' || (select (o->>'copies') || '/' || (o->>'fulfilled')
                 from jsonb_array_elements(pg_temp.bdd(:mgr, :orgA, :iB)->'rows') o where o->>'orderId' = :O8::text),
  'A 30/3, B 16/2 ; 12/12',
  'C3 lowered_line_reads_saved_quantity: a backorder closed by lowering 20 to its 12 fulfilled reads 12 requested, 12 fulfilled');
rollback to savepoint c_lower;
savepoint c_rental;
update public.inventory_items set is_rental = true where id = :iA;
select is(
  (pg_temp.rowof(pg_temp.bot(:mgr, :orgA), :iA)->>'copies') || '|' || (pg_temp.rowof(pg_temp.bot(:mgr, :orgA), :iA)->>'nowRental')
  || '|' || (pg_temp.errmsg_as(:mgr, format('insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (%L, %L, 1)', :O3, :iA)) ~ 'a rental item')::text,
  '30|true|true',
  'C4: a book turned into a rental item keeps its 30 copies (flagged nowRental), and the existing guard still refuses a new line for it');
rollback to savepoint c_rental;
savepoint c_retype;
update public.inventory_items set item_type = 'product' where id = :iB;
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r), 'A 30/3 | 30/1/3',
  'C5: a book retyped to a product leaves the report with all its history (current classification, disclosed)')
  from (select pg_temp.bot(:mgr, :orgA) r) x;
rollback to savepoint c_retype;

-- ═══ U. Units at x500 ════════════════════════════════════════════════════
savepoint u_pack;
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, created_at)
values (:O10, :orgA, :W1, 'approved', 'internal', :mgr, 'pickup', '2026-05-11 18:00+00');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values (:O10, :iPack, 500);
select is(
  pg_temp.rs(r) || ' | ' || pg_temp.sm(r) || ' | ' || (r#>>'{summary,unresolved,entries}') || '/' || (r#>>'{summary,unresolved,quantity}'),
  'A 30/3, B 4/1, Pack 500/1 | 34/3/4 | 1/500',
  'U1: 500 packs rank after every copy row under Most copies, count as an entry and an order, and stay out of the 34 copies (disclosed as unresolved)')
  from (select pg_temp.bot(:mgr, :orgA) r) x;
select is(pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_sort => 'title')), 'A,B,Pack',
  'U2: under Title the pack row sits alphabetically');
select is(
  (select jsonb_build_object('unit', x->'unit', 'countsAsCopies', x->'countsAsCopies')
     from jsonb_array_elements(pg_temp.bot(:mgr, :orgA)->'rows') x where x->>'itemId' = :iPack::text),
  '{"unit":"pack of 10","countsAsCopies":false}'::jsonb,
  'U3: the row carries its unit so the screens can word it');
rollback to savepoint u_pack;

-- ═══ The rich fixture: every other filter, identity and sort case ════════
savepoint rich;
insert into public.order_requests
  (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type, created_at) values
  (:O7,  :orgA, :W1, 'approved',    'internal', :mgr,   'pickup', '2026-05-02 18:00+00'),
  (:OW3, :orgA, :W3, 'approved',    'internal', :mgr,   'pickup', '2026-05-03 18:00+00'),
  (:OU,  :orgA, :W1, 'completed',   'internal', :mgr,   'pickup', '2026-05-04 18:00+00'),
  (:OW2, :orgA, :W2, 'approved',    'internal', :stfW2, 'pickup', '2026-05-05 18:00+00'),
  (:O9,  :orgA, :W1, 'backordered', 'internal', :mgr,   'pickup', '2026-05-06 18:00+00');
insert into public.order_request_lines (order_request_id, item_id, quantity_requested) values
  (:O7,  :iC,     1),
  (:OW3, :iA,     2),
  (:OU,  :iU,     3),
  (:OW2, :iSouth, 4),
  (:O9,  :iA2,    6),
  (:O9,  :iA2nd,  7),
  (:O9,  :iOld,   2),
  (:O9,  :iBad,   1),
  (:O9,  :iPct,   1),
  (:O9,  :iX,     5),
  (:O9,  :iPack,  12);
-- After the orders were placed: W3 archived, category C3 soft-deleted.
update public.warehouses set status = 'archived' where id = :W3;
update public.categories set deleted_at = now() where id = :C3;

insert into res values ('rich.mgr', pg_temp.bot(:mgr, :orgA));
select is(pg_temp.rs(r) || ' | ' || pg_temp.sm(r) || ' | ' || (r#>>'{summary,unresolved,entries}') || '/' || (r#>>'{summary,unresolved,quantity}'),
  'A 32/4, A2nd 7/1, A2 6/1, X 5/1, B 4/1, South 4/1, U 3/1, Old 2/1, Bad 1/1, Pct 1/1, C 1/1, Pack 12/1 | 66/12/8 | 1/12',
  'R1: the full picture: copy rows by copies (ties by item id), the pack row last and out of the 66 copies')
  from res where k = 'rich.mgr';

-- I. Identity
select is(
  (select string_agg((x->>'itemId') || '=' || (x->>'name') || '/' || coalesce(x->>'identifier', '-') || '/' || coalesce(x->>'binLocation', '-'),
                     ' ; ' order by x->>'itemId')
     from res, jsonb_array_elements(r->'rows') x where k = 'rich.mgr' and x->>'name' = 'Book A'),
  :iA::text || '=Book A/978-0-14-044913-6/R1-A ; ' || :iA2::text || '=Book A/9780140449136/R2-B ; '
  || :iA2nd::text || '=Book A/9780143039433/R3-C',
  'I1: three records named Book A stay three rows, told apart by identifier and rack; the identifier falls back to custom_fields isbn13');
select is(
  (select jsonb_build_object('status', x->'itemStatus', 'deleted', x->'deleted', 'copies', x->'copies', 'nowRental', x->'nowRental')
     from res, jsonb_array_elements(r->'rows') x where k = 'rich.mgr' and x->>'itemId' = :iOld::text),
  '{"status":"archived","deleted":true,"copies":"2","nowRental":false}'::jsonb,
  'I2: an archived, soft-deleted book keeps its history and is flagged');

-- P. Sorts
select is(pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_sort => 'title')),
  'A,A2,A2nd,B,Bad,C,Old,Pack,South,U,X,Pct',
  'P1: Title (A-Z), ties by item id');
select is(pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_sort => 'orders')),
  'A,B,A2,A2nd,Old,Pack,Bad,Pct,C,U,X,South',
  'P2: Most orders, ties by item id');
select is(pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_sort => 'latest')),
  'A2,A2nd,Old,Pack,Bad,Pct,X,South,U,A,C,B',
  'P3: Latest order, ties by item id');
select is(pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_sort => %L)', :orgA, 'price')),
  '22023:invalid_sort', 'P4: an unknown sort is 22023 invalid_sort');
select is(
  (select string_agg((p->>'page') || '/' || (p->>'pageSize') || '/' || jsonb_array_length(p->'rows'), ' ' order by n)
     from (select 1 n, pg_temp.bot(:mgr, :orgA, p_page => 99, p_size => 5) p
           union all select 2, pg_temp.bot(:mgr, :orgA, p_page => 1, p_size => 0)
           union all select 3, pg_temp.bot(:mgr, :orgA, p_page => 1, p_size => 10000)
           union all select 4, pg_temp.bot(:mgr, :orgA, p_page => -3, p_size => 5)) x),
  '3/5/2 1/1/1 1/100/12 1/5/5',
  'P5: page 99 is answered with the last page (3 of 5 per page), size 0 is 1, size 10,000 is 100, page -3 is page 1');
select is(
  (select count(distinct p->'summary')::int || '|' || count(distinct x->>'itemId') || '|' || count(x)
     from (select pg_temp.bot(:mgr, :orgA, p_page => g, p_size => 5) p from generate_series(1, 3) g) pp,
          jsonb_array_elements(pp.p->'rows') x),
  '1|12|12',
  'P6: the summary is identical on every page, and pages 1-3 hold all 12 rows once each');

-- Q. Search
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_search => 'book b')), 'B 4/1, Bad 1/1',
  'Q1: a title search is a case-insensitive substring over every eligible book');
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_search => 'bk-pct')), 'Pct 1/1', 'Q2: by SKU');
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_keys => '{0140449132,9780140449136}'::text[])), 'A 32/4, A2 6/1',
  'Q3: ISBN keys from an ISBN-10 input find the hyphenated ISBN-13 barcode and the plain one (never org B''s look-alike)');
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_keys => '{9780306406157,0306406152}'::text[])), 'B 4/1',
  'Q4: keys from an ISBN-13 input find an ISBN-10 barcode');
select is(pg_temp.rs(pg_temp.bot(:mgr, :orgA, p_keys => '{9780143039433,0143039431}'::text[])), 'A2nd 7/1',
  'Q5: keys match the legacy custom_fields isbn13');
select is(
  pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_search => '%')) || ' ; ' || pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_search => '_'))
  || ' ; ' || pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_search => '50%')),
  'Pct ; Pct ; Pct',
  'Q6: % and _ are literal characters, not wildcards');
select is(pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_search => '978-0-14')) || ' ; '
          || pg_temp.rl(pg_temp.bot(:mgr, :orgA, p_search => '9780140449137')),
  'A ; Bad',
  'Q7: text search reads the raw barcode, so a hyphenated fragment and a checksum-failing barcode are still found');
select is((r->>'totalCount') || '|' || (r#>>'{summary,copies}'), '0|0',
  'Q8: a 5,000-character search is cut to 200 and answered, not refused')
  from (select pg_temp.bot(:mgr, :orgA, p_search => repeat('x', 5000)) r) x;
select is(
  (select array_agg(distinct pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_isbn_keys => %L)', :orgA, k)))
     from unnest(array['{123}', '{abcdefghij}', '{0140449132,9780140449136,0306406152,9780306406157,0143039431}', '{014044913x}']) k),
  array['22023:invalid_search'],
  'Q9: malformed ISBN keys (short, letters, more than 4, lower-case x) are 22023 invalid_search');

-- R. Options and filter ids
select is(
  (select jsonb_build_object(
            'warehouses', (select jsonb_agg(jsonb_build_object('id', w->'id', 'status', w->'status')) from jsonb_array_elements(o->'warehouses') w),
            'categories', (select jsonb_agg(jsonb_build_object('id', c->'id', 'deleted', c->'deleted')) from jsonb_array_elements(o->'categories') c),
            'uncategorized', o->'uncategorized', 'orderStatusConfig', o->'orderStatusConfig')
     from (select pg_temp.bopt(:mgr, :orgA) o) x),
  jsonb_build_object(
    'warehouses', jsonb_build_array(jsonb_build_object('id', :W1::text, 'status', 'active'),
                                    jsonb_build_object('id', :W2::text, 'status', 'active'),
                                    jsonb_build_object('id', :W3::text, 'status', 'archived')),
    'categories', jsonb_build_array(jsonb_build_object('id', :C1::text, 'deleted', false),
                                    jsonb_build_object('id', :C2::text, 'deleted', false),
                                    jsonb_build_object('id', :C3::text, 'deleted', true)),
    'uncategorized', true,
    'orderStatusConfig', '{"completed":{"label":"Handed over"}}'::jsonb),
  'R2: options come from eligible lines: the archived warehouse and the deleted category stay (listed last), no-category is offered, and the org''s status labels ride along');
select is(
  pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, :W3)) || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, null, :C3))
  || ' ; ' || pg_temp.rs(pg_temp.bot(:mgr, :orgA, null, null, null, true))
  || ' ; ' || (pg_temp.bot(:mgr, :orgA, null, :W3)#>>'{filters,warehouse,status}')
  || ' ; ' || (pg_temp.bot(:mgr, :orgA, null, null, :C3)#>>'{filters,category,deleted}'),
  'A 2/1 ; C 1/1 ; U 3/1 ; archived ; true',
  'R3: the archived warehouse, the deleted category and "No category" all filter, and the echo names their state');
select is(
  array[pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_warehouse_id => %L)', :orgA, '03790000-0000-0000-0000-00000000ffff')),
        pg_temp.err_as(:stfW1, format('select public.book_order_totals(%L, p_warehouse_id => %L)', :orgA, :W2)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_warehouse_id => %L)', :orgA, :WB)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_category_id => %L)', :orgA, '03790000-0000-0000-0000-00000000ffff')),
        pg_temp.err_as(:vwrC1, format('select public.book_order_totals(%L, p_category_id => %L)', :orgA, :C2)),
        pg_temp.err_as(:mgr, format('select public.book_order_totals(%L, p_category_id => %L, p_uncategorized => true)', :orgA, :C1))],
  array['22023:invalid_warehouse', '22023:invalid_warehouse', '22023:invalid_warehouse',
        '22023:invalid_category', '22023:invalid_category', '22023:invalid_category'],
  'R4: a random warehouse, one the caller cannot read, another org''s, a random category, one the caller cannot read, and a category with "No category" are refused');
select is(
  (select jsonb_agg(w->'id') from jsonb_array_elements(pg_temp.bopt(:stfW1, :orgA)->'warehouses') w),
  jsonb_build_array(:W1::text),
  'R5: options follow RLS: staff assigned to W1 are never offered W2 or W3');
select is(
  pg_temp.partition(:own, :orgA) || ' ; ' || pg_temp.partition(:mgr, :orgA) || ' ; ' || pg_temp.partition(:stfW1, :orgA)
  || ' ; ' || pg_temp.partition(:stfW2, :orgA) || ' ; ' || pg_temp.partition(:vwrC1, :orgA)
  || ' ; ' || pg_temp.partition(:vwrCh, :orgA) || ' ; ' || pg_temp.partition(:mgrAB, :orgA),
  'ok 66 ; ok 66 ; ok 60 ; ok 4 ; ok 43 ; ok 55 ; ok 66',
  'R6: for every persona the per-warehouse and per-category copies (and per-warehouse orders) add up to the unfiltered total');
select is(
  pg_temp.sm(pg_temp.bot(:stfW1, :orgA)) || ' ; ' || pg_temp.rs(pg_temp.bot(:stfW1, :orgA, p_search => 'bk-a'))
  || ' ; ' || pg_temp.sm(pg_temp.bot(:vwrCh, :orgA)) || ' ; ' || pg_temp.sm(pg_temp.bot(:vwrC1, :orgA))
  || ' ; ' || pg_temp.sm(pg_temp.bot(:stfW2, :orgA)),
  '60/11/6 ; A 30/3, A2nd 7/1, A2 6/1 ; 55/10/6 ; 43/3/4 ; 4/1/1',
  'R7: the four joins at work: staff on W1 lose the W3 order''s x2 though Book A is theirs (warehouse RLS), the charter viewer loses Book X (charter), the C1 viewer keeps C1 books only (category)');
select is(
  (select string_agg(res, ',' order by res)
     from (select distinct pg_temp.reconcile(u, :orgA, s, w, c, q) res
             from unnest(array[:own, :mgr, :stfW1, :stfW2, :vwrC1, :vwrCh, :mgrAB]::uuid[]) u,
                  (values (null::text[], null::uuid, null::uuid, null::text),
                          (:all13::text[], null, null, null),
                          (null, :W1::uuid, null, null),
                          (null, null, :C1::uuid, null),
                          (null, null, null, 'book')) f(s, w, c, q)) x),
  'ok,skipped',
  'R8: for every persona and filter (default, all statuses, W1, C1, a search): the rows over all pages sum to the summary, count to the entries, and their drill-downs (all pages) reconcile row by row and add up to the summary''s orders');
rollback to savepoint rich;

-- ═══ X. More than max_rows; export mode ══════════════════════════════════
insert into res values ('c.p1', pg_temp.bot(:mgrC, :orgC, p_page => 1, p_size => 100));
select is(
  (r->>'totalCount') || '|' || pg_temp.sm(r),
  '1100|' || (select trim_scale(sum(l.quantity_requested))::text from public.order_request_lines l
                join public.order_requests o on o.id = l.order_request_id where o.organization_id = :orgC)
  || '/1100/1200',
  'X1: 1,100 grouped rows (more than max_rows) in one answer; copies equal a direct sum of the lines; 1,200 orders')
  from res where k = 'c.p1';
select is(
  (r->>'page') || '|' || jsonb_array_length(r->'rows'),
  '44|25',
  'X2: page 99 of 25 is answered with page 44, a full 25 rows')
  from (select pg_temp.bot(:mgrC, :orgC, p_page => 99, p_size => 25) r) x;
insert into res values ('c.all', pg_temp.bot(:mgrC, :orgC, p_all => true));
select is(
  (select r->'rows' from res where k = 'c.all'),
  (select jsonb_agg(x order by g, ord)
     from generate_series(1, 11) g,
          jsonb_array_elements(pg_temp.bot(:mgrC, :orgC, p_page => g, p_size => 100)->'rows') with ordinality t(x, ord)),
  'X3: export mode returns all 1,100 rows, identical to pages 1..11 of 100 concatenated');
select is(
  jsonb_build_object('mode', r->'mode', 'pageSize', r->'pageSize', 'maxRows', r->'maxRows', 'tooMany', r->'tooMany',
                     'summarySame', r->'summary' = (select r2.r->'summary' from res r2 where r2.k = 'c.p1')),
  '{"mode":"all","pageSize":null,"maxRows":50000,"tooMany":false,"summarySame":true}'::jsonb,
  'X4: export mode carries the same summary, no page size, and the 50,000 ceiling')
  from res where k = 'c.all';
select is(
  (select string_agg((p->>'tooMany') || '/' || jsonb_array_length(p->'rows') || '/' || (p->>'maxRows') || '/' || (p->>'totalCount')
                     || '/' || (p#>>'{summary,entries}'), ' ' order by n)
     from (select 1 n, pg_temp.bot(:mgrC, :orgC, p_all => true, p_max => 1000) p
           union all select 2, pg_temp.bot(:mgrC, :orgC, p_all => true, p_max => 1099)
           union all select 3, pg_temp.bot(:mgrC, :orgC, p_all => true, p_max => 1100)
           union all select 4, pg_temp.bot(:mgrC, :orgC, p_all => true, p_max => 99999)) x),
  'true/0/1000/1100/1100 true/0/1099/1100/1100 false/1100/1100/1100/1100 false/1100/50000/1100/1100',
  'X5: above the ceiling: tooMany with the summary and no rows (never truncated); at the ceiling: every row; the ceiling is clamped to 50,000');
insert into res values ('c.dd1', pg_temp.bdd(:mgrC, :orgC, :cBook1, p_page => 1, p_size => 100));
select is(
  (r->>'totalCount') || '|' || (r#>>'{totals,copies}') || '|' || (pg_temp.rowof((select r2.r from res r2 where r2.k = 'c.p1'), :cBook1)->>'copies'),
  '1200|1200|1200',
  'X6: one book on 1,200 orders: the drill-down counts 1,200 orders and its header equals the report row')
  from res where k = 'c.dd1';
select is(
  (select count(distinct x->>'orderId')::int || '|' || sum((x->>'copies')::numeric)::text
     from generate_series(1, 12) g,
          jsonb_array_elements(pg_temp.bdd(:mgrC, :orgC, :cBook1, p_page => g, p_size => 100)->'rows') x),
  '1200|1200',
  'X7: its 12 drill-down pages hold 1,200 distinct orders adding up to the row');

select * from finish();
rollback;
