-- supabase/tests/0377_order_readiness_facts.test.sql
-- pgTAP proof for migration 0377 (F2-1: order readiness facts).
--
-- G. Grants and gates: order_readiness_facts is SECURITY DEFINER with a pinned
--    search_path, EXECUTE to authenticated and service_role and not anon or
--    PUBLIC, gated in its own body, never raising 40001/40P01;
--    purchase_order_visible is SECURITY INVOKER. Signed out (and the service
--    role, which has no caller): 42501. Another org's order, a random id, a
--    non-member and a disabled member: the SAME P0002. Orders module off:
--    P0001 module_disabled. 201 lines: linesCapped with no lines and no items;
--    200 lines: answered.
-- V. Visibility: an item outside a warehouse-scoped member's reach, a
--    charter-restricted and a category-restricted item come back as
--    {itemId, visible:false} and nothing else (mutation: drop
--    caller_can_read_item). stagingSources lists only locations the caller's
--    holdings scope covers, the rest is stagingHiddenQty. PO rows only where
--    purchase_order_visible, the rest is hiddenRemaining; more than 10 rows
--    is disclosed. A line whose item belongs to another org is hidden even
--    from a member of both orgs (mutation: drop the item's org filter).
--    purchase_order_visible equals purchase_orders_select for
--    every persona and PO (and the one known widening, the FOR ALL write
--    policy, is pinned in the conservative direction). pendingOthers is null
--    for staff without orders:approve, set for a manager and for staff with
--    an orders:approve override (mutation: drop the gate). inbound and drafts
--    are null with the purchase_orders module off.
-- F. Facts: rental holds are heldRentals (mutation: <> for IS DISTINCT FROM);
--    a NULL-kind Site is here.site, here or elsewhere (mutation:
--    kind <> 'staging'); Unplaced is not Staging; another warehouse's stock is
--    elsewhere, org-level stock is here; released holds are ignored; an
--    over-received PO line floors at 0; cancelled and received POs are
--    ignored, drafts are listed apart; an open PO whose line for the item is
--    fully received brings no row (mutation: drop `having ... > 0`);
--    committedOtherShortfall per status
--    class; pending orders are counted in pendingOthers and never netted;
--    lines in (created_at, id) order; the order carries its org's time zone;
--    picked and closed phases read lines only.
-- P. Parity with the FROZEN RPCs, from the shared fixture
--    packages/core/src/orders/readiness-parity-cases.json (the generated block
--    below; scripts/gen-readiness-parity-sql.mjs). For every case the real
--    facts function returns the facts core is fed, and approve_order_request,
--    approve_partial, resume_fulfillment and complete_picking do exactly what
--    the fixture expects (each call rolled back): C1-C13 (C6c: on record more
--    than the locations hold, nothing in Staging, and complete_picking still
--    raises insufficient_placed_stock).
-- Z. The frozen objects: md5, SECURITY DEFINER, search_path and owner of
--    every function F2 promises not to touch.
--
-- Roles: fixtures as the test superuser (RLS bypassed, the API-role guards
-- exempt); the functions run as `authenticated` with request.jwt.claim.sub.
-- begin/rollback: nothing leaks. Namespaces 03770000 (hand fixtures) and
-- 0377a (the parity org).

begin;

-- ══ Parity tables (filled by the generated block) ═════════════════════════
create temp table rp_case (case_no int primary key, case_id text not null, status text not null,
                           order_id uuid not null, holder_id uuid not null);
create temp table rp_item (case_no int not null, item_key text not null, item_id uuid primary key,
                           name text not null, sku text not null, on_hand numeric not null,
                           item_wh text not null, deleted boolean not null, is_bundle boolean not null);
create temp table rp_holding (item_id uuid not null, kind text not null, wh text not null, qty numeric not null);
create temp table rp_hold (case_no int not null, item_id uuid not null, holder text not null, qty numeric not null);
create temp table rp_line (case_no int not null, line_key text not null, line_id uuid primary key,
                           item_id uuid not null, requested numeric not null, fulfilled numeric not null,
                           picked numeric, created_at timestamptz not null);
create temp table rp_expect_item (case_no int not null, item_key text not null, item_id uuid not null, facts jsonb not null);
create temp table rp_expect (case_no int primary key, phase text not null, lines jsonb not null,
                             approve jsonb, approve_partial jsonb, resume jsonb, complete jsonb);

-- BEGIN GENERATED: scripts/gen-readiness-parity-sql.mjs from packages/core/src/orders/readiness-parity-cases.json. Do not edit by hand.
-- 17 cases: C1a, C1b, C2, C3, C4, C4b, C5, C6, C6c, C6b, C7, C8, C9, C10, C11, C12, C13.
insert into rp_case (case_no, case_id, status, order_id, holder_id) values
  (1, 'C1a', 'pending_approval', '0377a011-0000-4000-8000-000000000000', '0377a012-0000-4000-8000-000000000000'),
  (2, 'C1b', 'pending_approval', '0377a021-0000-4000-8000-000000000000', '0377a022-0000-4000-8000-000000000000'),
  (3, 'C2', 'pending_approval', '0377a031-0000-4000-8000-000000000000', '0377a032-0000-4000-8000-000000000000'),
  (4, 'C3', 'approved', '0377a041-0000-4000-8000-000000000000', '0377a042-0000-4000-8000-000000000000'),
  (5, 'C4', 'backordered', '0377a051-0000-4000-8000-000000000000', '0377a052-0000-4000-8000-000000000000'),
  (6, 'C4b', 'backordered', '0377a061-0000-4000-8000-000000000000', '0377a062-0000-4000-8000-000000000000'),
  (7, 'C5', 'pick_slip_generated', '0377a071-0000-4000-8000-000000000000', '0377a072-0000-4000-8000-000000000000'),
  (8, 'C6', 'pick_slip_generated', '0377a081-0000-4000-8000-000000000000', '0377a082-0000-4000-8000-000000000000'),
  (9, 'C6c', 'pick_slip_generated', '0377a091-0000-4000-8000-000000000000', '0377a092-0000-4000-8000-000000000000'),
  (10, 'C6b', 'pick_slip_generated', '0377a0a1-0000-4000-8000-000000000000', '0377a0a2-0000-4000-8000-000000000000'),
  (11, 'C7', 'pick_slip_generated', '0377a0b1-0000-4000-8000-000000000000', '0377a0b2-0000-4000-8000-000000000000'),
  (12, 'C8', 'pick_slip_generated', '0377a0c1-0000-4000-8000-000000000000', '0377a0c2-0000-4000-8000-000000000000'),
  (13, 'C9', 'picking_in_progress', '0377a0d1-0000-4000-8000-000000000000', '0377a0d2-0000-4000-8000-000000000000'),
  (14, 'C10', 'pending_approval', '0377a0e1-0000-4000-8000-000000000000', '0377a0e2-0000-4000-8000-000000000000'),
  (15, 'C11', 'pending_approval', '0377a0f1-0000-4000-8000-000000000000', '0377a0f2-0000-4000-8000-000000000000'),
  (16, 'C12', 'pending_approval', '0377a101-0000-4000-8000-000000000000', '0377a102-0000-4000-8000-000000000000'),
  (17, 'C13', 'pending_approval', '0377a111-0000-4000-8000-000000000000', '0377a112-0000-4000-8000-000000000000');

insert into rp_item (case_no, item_key, item_id, name, sku, on_hand, item_wh, deleted, is_bundle) values
  (1, 'a', '0377a013-0000-4000-8000-000000000001', 'Parity C1a a', 'P-C1a-a', 10, 'home', false, false),
  (1, 'b', '0377a013-0000-4000-8000-000000000002', 'Parity C1a b', 'P-C1a-b', 6, 'home', false, false),
  (2, 'a', '0377a023-0000-4000-8000-000000000001', 'Parity C1b a', 'P-C1b-a', 10, 'home', false, false),
  (3, 'a', '0377a033-0000-4000-8000-000000000001', 'Parity C2 a', 'P-C2-a', 5, 'home', false, false),
  (4, 'a', '0377a043-0000-4000-8000-000000000001', 'Parity C3 a', 'P-C3-a', 10, 'home', false, false),
  (5, 'a', '0377a053-0000-4000-8000-000000000001', 'Parity C4 a', 'P-C4-a', 5, 'home', false, false),
  (6, 'a', '0377a063-0000-4000-8000-000000000001', 'Parity C4b a', 'P-C4b-a', 2, 'home', false, false),
  (7, 'a', '0377a073-0000-4000-8000-000000000001', 'Parity C5 a', 'P-C5-a', 10, 'home', false, false),
  (7, 'b', '0377a073-0000-4000-8000-000000000002', 'Parity C5 b', 'P-C5-b', 3, 'home', false, false),
  (7, 'c', '0377a073-0000-4000-8000-000000000003', 'Parity C5 c', 'P-C5-c', 6, 'home', false, false),
  (7, 'd', '0377a073-0000-4000-8000-000000000004', 'Parity C5 d', 'P-C5-d', 8, 'home', false, false),
  (8, 'a', '0377a083-0000-4000-8000-000000000001', 'Parity C6 a', 'P-C6-a', 10, 'home', false, false),
  (9, 'a', '0377a093-0000-4000-8000-000000000001', 'Parity C6c a', 'P-C6c-a', 10, 'home', false, false),
  (10, 'a', '0377a0a3-0000-4000-8000-000000000001', 'Parity C6b a', 'P-C6b-a', 10, 'home', false, false),
  (11, 'a', '0377a0b3-0000-4000-8000-000000000001', 'Parity C7 a', 'P-C7-a', 5, 'home', false, false),
  (12, 'a', '0377a0c3-0000-4000-8000-000000000001', 'Parity C8 a', 'P-C8-a', 15, 'home', false, false),
  (13, 'a', '0377a0d3-0000-4000-8000-000000000001', 'Parity C9 a', 'P-C9-a', 10, 'home', false, false),
  (13, 'b', '0377a0d3-0000-4000-8000-000000000002', 'Parity C9 b', 'P-C9-b', 2, 'home', false, false),
  (14, 'a', '0377a0e3-0000-4000-8000-000000000001', 'Parity C10 a', 'P-C10-a', 6, 'home', false, false),
  (15, 'a', '0377a0f3-0000-4000-8000-000000000001', 'Parity C11 a', 'P-C11-a', 5, 'home', false, false),
  (15, 'm', '0377a0f3-0000-4000-8000-000000000002', 'Parity C11 m', 'P-C11-m', 5, 'other', false, false),
  (16, 'a', '0377a103-0000-4000-8000-000000000001', 'Parity C12 a', 'P-C12-a', 8, 'home', false, false),
  (17, 'k', '0377a113-0000-4000-8000-000000000001', 'Parity C13 k', 'P-C13-k', 2, 'home', false, true);

insert into rp_holding (item_id, kind, wh, qty) values
  ('0377a013-0000-4000-8000-000000000001', 'rack', 'home', 10),
  ('0377a013-0000-4000-8000-000000000002', 'rack', 'home', 4),
  ('0377a013-0000-4000-8000-000000000002', 'staging', 'home', 2),
  ('0377a023-0000-4000-8000-000000000001', 'rack', 'home', 10),
  ('0377a033-0000-4000-8000-000000000001', 'rack', 'home', 5),
  ('0377a043-0000-4000-8000-000000000001', 'rack', 'home', 10),
  ('0377a053-0000-4000-8000-000000000001', 'rack', 'home', 5),
  ('0377a063-0000-4000-8000-000000000001', 'rack', 'home', 2),
  ('0377a073-0000-4000-8000-000000000001', 'rack', 'home', 10),
  ('0377a073-0000-4000-8000-000000000002', 'rack', 'home', 3),
  ('0377a073-0000-4000-8000-000000000003', 'site', 'home', 4),
  ('0377a073-0000-4000-8000-000000000003', 'unplaced', 'home', 2),
  ('0377a073-0000-4000-8000-000000000004', 'rack', 'home', 8),
  ('0377a083-0000-4000-8000-000000000001', 'rack', 'home', 6),
  ('0377a083-0000-4000-8000-000000000001', 'staging', 'home', 4),
  ('0377a093-0000-4000-8000-000000000001', 'rack', 'home', 7),
  ('0377a0a3-0000-4000-8000-000000000001', 'rack', 'home', 6),
  ('0377a0a3-0000-4000-8000-000000000001', 'unplaced', 'home', 4),
  ('0377a0b3-0000-4000-8000-000000000001', 'rack', 'other', 5),
  ('0377a0c3-0000-4000-8000-000000000001', 'rack', 'home', 10),
  ('0377a0c3-0000-4000-8000-000000000001', 'staging', 'home', 5),
  ('0377a0d3-0000-4000-8000-000000000001', 'rack', 'home', 10),
  ('0377a0d3-0000-4000-8000-000000000002', 'crate', 'home', 2),
  ('0377a0e3-0000-4000-8000-000000000001', 'site', 'org', 3),
  ('0377a0e3-0000-4000-8000-000000000001', 'rack', 'other', 2),
  ('0377a0e3-0000-4000-8000-000000000001', 'staging', 'other', 1),
  ('0377a0f3-0000-4000-8000-000000000001', 'rack', 'home', 5),
  ('0377a0f3-0000-4000-8000-000000000002', 'rack', 'other', 5),
  ('0377a103-0000-4000-8000-000000000001', 'rack', 'home', 5),
  ('0377a113-0000-4000-8000-000000000001', 'rack', 'home', 2);

insert into rp_hold (case_no, item_id, holder, qty) values
  (1, '0377a013-0000-4000-8000-000000000001', 'otherOrder', 3),
  (1, '0377a013-0000-4000-8000-000000000001', 'rental', 2),
  (2, '0377a023-0000-4000-8000-000000000001', 'otherOrder', 3),
  (2, '0377a023-0000-4000-8000-000000000001', 'rental', 2),
  (4, '0377a043-0000-4000-8000-000000000001', 'own', 10),
  (5, '0377a053-0000-4000-8000-000000000001', 'otherOrder', 2),
  (6, '0377a063-0000-4000-8000-000000000001', 'otherOrder', 2),
  (7, '0377a073-0000-4000-8000-000000000001', 'own', 6),
  (7, '0377a073-0000-4000-8000-000000000001', 'otherOrder', 4),
  (7, '0377a073-0000-4000-8000-000000000002', 'own', 3),
  (7, '0377a073-0000-4000-8000-000000000003', 'own', 5),
  (7, '0377a073-0000-4000-8000-000000000003', 'rental', 1),
  (7, '0377a073-0000-4000-8000-000000000004', 'own', 5),
  (7, '0377a073-0000-4000-8000-000000000004', 'otherOrder', 4),
  (8, '0377a083-0000-4000-8000-000000000001', 'own', 10),
  (9, '0377a093-0000-4000-8000-000000000001', 'own', 10),
  (10, '0377a0a3-0000-4000-8000-000000000001', 'own', 10),
  (11, '0377a0b3-0000-4000-8000-000000000001', 'own', 5),
  (12, '0377a0c3-0000-4000-8000-000000000001', 'own', 10),
  (12, '0377a0c3-0000-4000-8000-000000000001', 'otherOrder', 5),
  (13, '0377a0d3-0000-4000-8000-000000000001', 'own', 6),
  (13, '0377a0d3-0000-4000-8000-000000000002', 'own', 2);

insert into rp_line (case_no, line_key, line_id, item_id, requested, fulfilled, picked, created_at) values
  (1, 'l1', '0377a014-0000-4000-8000-000000000001', '0377a013-0000-4000-8000-000000000001', 5, 0, null, '2026-01-01T00:00:01.000Z'),
  (1, 'l2', '0377a014-0000-4000-8000-000000000002', '0377a013-0000-4000-8000-000000000002', 6, 0, null, '2026-01-01T00:00:02.000Z'),
  (2, 'l1', '0377a024-0000-4000-8000-000000000001', '0377a023-0000-4000-8000-000000000001', 6, 0, null, '2026-01-01T00:00:01.000Z'),
  (3, 'l1', '0377a034-0000-4000-8000-000000000001', '0377a033-0000-4000-8000-000000000001', 3, 0, null, '2026-01-01T00:00:01.000Z'),
  (3, 'l2', '0377a034-0000-4000-8000-000000000002', '0377a033-0000-4000-8000-000000000001', 3, 0, null, '2026-01-01T00:00:02.000Z'),
  (4, 'l1', '0377a044-0000-4000-8000-000000000001', '0377a043-0000-4000-8000-000000000001', 10, 0, null, '2026-01-01T00:00:01.000Z'),
  (5, 'l1', '0377a054-0000-4000-8000-000000000001', '0377a053-0000-4000-8000-000000000001', 6, 2, null, '2026-01-01T00:00:01.000Z'),
  (6, 'l1', '0377a064-0000-4000-8000-000000000001', '0377a063-0000-4000-8000-000000000001', 6, 2, null, '2026-01-01T00:00:01.000Z'),
  (7, 'l1', '0377a074-0000-4000-8000-000000000001', '0377a073-0000-4000-8000-000000000001', 6, 0, null, '2026-01-01T00:00:01.000Z'),
  (7, 'l2', '0377a074-0000-4000-8000-000000000002', '0377a073-0000-4000-8000-000000000002', 5, 0, null, '2026-01-01T00:00:02.000Z'),
  (7, 'l3', '0377a074-0000-4000-8000-000000000003', '0377a073-0000-4000-8000-000000000003', 5, 0, null, '2026-01-01T00:00:03.000Z'),
  (7, 'l4', '0377a074-0000-4000-8000-000000000004', '0377a073-0000-4000-8000-000000000004', 5, 0, null, '2026-01-01T00:00:04.000Z'),
  (8, 'l1', '0377a084-0000-4000-8000-000000000001', '0377a083-0000-4000-8000-000000000001', 10, 0, null, '2026-01-01T00:00:01.000Z'),
  (9, 'l1', '0377a094-0000-4000-8000-000000000001', '0377a093-0000-4000-8000-000000000001', 10, 0, null, '2026-01-01T00:00:01.000Z'),
  (10, 'l1', '0377a0a4-0000-4000-8000-000000000001', '0377a0a3-0000-4000-8000-000000000001', 10, 0, null, '2026-01-01T00:00:01.000Z'),
  (11, 'l1', '0377a0b4-0000-4000-8000-000000000001', '0377a0b3-0000-4000-8000-000000000001', 5, 0, null, '2026-01-01T00:00:01.000Z'),
  (12, 'l1', '0377a0c4-0000-4000-8000-000000000001', '0377a0c3-0000-4000-8000-000000000001', 10, 0, null, '2026-01-01T00:00:01.000Z'),
  (13, 'l1', '0377a0d4-0000-4000-8000-000000000001', '0377a0d3-0000-4000-8000-000000000001', 6, 0, 4, '2026-01-01T00:00:01.000Z'),
  (13, 'l2', '0377a0d4-0000-4000-8000-000000000002', '0377a0d3-0000-4000-8000-000000000002', 2, 0, null, '2026-01-01T00:00:02.000Z'),
  (14, 'l1', '0377a0e4-0000-4000-8000-000000000001', '0377a0e3-0000-4000-8000-000000000001', 3, 0, null, '2026-01-01T00:00:01.000Z'),
  (15, 'l1', '0377a0f4-0000-4000-8000-000000000001', '0377a0f3-0000-4000-8000-000000000001', 2, 0, null, '2026-01-01T00:00:01.000Z'),
  (15, 'l2', '0377a0f4-0000-4000-8000-000000000002', '0377a0f3-0000-4000-8000-000000000002', 2, 0, null, '2026-01-01T00:00:02.000Z'),
  (16, 'l1', '0377a104-0000-4000-8000-000000000001', '0377a103-0000-4000-8000-000000000001', 3, 0, null, '2026-01-01T00:00:01.000Z'),
  (17, 'l1', '0377a114-0000-4000-8000-000000000001', '0377a113-0000-4000-8000-000000000001', 3, 0, null, '2026-01-01T00:00:01.000Z');

insert into rp_expect_item (case_no, item_key, item_id, facts) values
  (1, 'a', '0377a013-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":0,"heldOtherOrders":3,"heldRentals":2,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (1, 'b', '0377a013-0000-4000-8000-000000000002', '{"onHand":6,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":4,"site":0,"unplaced":0,"staging":2},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":2,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (2, 'a', '0377a023-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":0,"heldOtherOrders":3,"heldRentals":2,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (3, 'a', '0377a033-0000-4000-8000-000000000001', '{"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (4, 'a', '0377a043-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (5, 'a', '0377a053-0000-4000-8000-000000000001', '{"onHand":5,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (6, 'a', '0377a063-0000-4000-8000-000000000001', '{"onHand":2,"heldOwn":0,"heldOtherOrders":2,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (7, 'a', '0377a073-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":6,"heldOtherOrders":4,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (7, 'b', '0377a073-0000-4000-8000-000000000002', '{"onHand":3,"heldOwn":3,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":3,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (7, 'c', '0377a073-0000-4000-8000-000000000003', '{"onHand":6,"heldOwn":5,"heldOtherOrders":0,"heldRentals":1,"here":{"rack":0,"site":4,"unplaced":2,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (7, 'd', '0377a073-0000-4000-8000-000000000004', '{"onHand":8,"heldOwn":5,"heldOtherOrders":4,"heldRentals":0,"here":{"rack":8,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (8, 'a', '0377a083-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":6,"site":0,"unplaced":0,"staging":4},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":4,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (9, 'a', '0377a093-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":7,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (10, 'a', '0377a0a3-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":10,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":6,"site":0,"unplaced":4,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (11, 'a', '0377a0b3-0000-4000-8000-000000000001', '{"onHand":5,"heldOwn":5,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":5,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (12, 'a', '0377a0c3-0000-4000-8000-000000000001', '{"onHand":15,"heldOwn":10,"heldOtherOrders":5,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":5},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":5,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (13, 'a', '0377a0d3-0000-4000-8000-000000000001', '{"onHand":10,"heldOwn":6,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":10,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (13, 'b', '0377a0d3-0000-4000-8000-000000000002', '{"onHand":2,"heldOwn":2,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (14, 'a', '0377a0e3-0000-4000-8000-000000000001', '{"onHand":6,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":3,"unplaced":0,"staging":0},"elsewhere":{"pickable":2,"staging":1},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (15, 'a', '0377a0f3-0000-4000-8000-000000000001', '{"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (15, 'm', '0377a0f3-0000-4000-8000-000000000002', '{"onHand":5,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":0,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":5,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d2","visible":true}'::jsonb),
  (16, 'a', '0377a103-0000-4000-8000-000000000001', '{"onHand":8,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":5,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":false,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb),
  (17, 'k', '0377a113-0000-4000-8000-000000000001', '{"onHand":2,"heldOwn":0,"heldOtherOrders":0,"heldRentals":0,"here":{"rack":2,"site":0,"unplaced":0,"staging":0},"elsewhere":{"pickable":0,"staging":0},"stagingHiddenQty":0,"stagingSourcesTotal":0,"committedOtherShortfall":0,"pendingOthers":{"orders":0,"units":0},"inbound":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"drafts":{"rows":[],"hiddenRemaining":0,"truncated":false,"truncatedRemaining":0},"deleted":false,"isBundle":true,"itemWarehouseId":"0377a000-0000-4000-8000-0000000000d1","visible":true}'::jsonb);

insert into rp_expect (case_no, phase, lines, approve, approve_partial, resume, complete) values
  (1, 'to_pick', '[{"lineId":"0377a014-0000-4000-8000-000000000001","itemId":"0377a013-0000-4000-8000-000000000001","requested":5,"fulfilled":0,"picked":null},{"lineId":"0377a014-0000-4000-8000-000000000002","itemId":"0377a013-0000-4000-8000-000000000002","requested":6,"fulfilled":0,"picked":null}]'::jsonb, '{"ok":true}'::jsonb, '{"holds":{"0377a013-0000-4000-8000-000000000001":5,"0377a013-0000-4000-8000-000000000002":6}}'::jsonb, null, null),
  (2, 'to_pick', '[{"lineId":"0377a024-0000-4000-8000-000000000001","itemId":"0377a023-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":null}]'::jsonb, '{"error":"insufficient_stock"}'::jsonb, '{"holds":{"0377a023-0000-4000-8000-000000000001":5}}'::jsonb, null, null),
  (3, 'to_pick', '[{"lineId":"0377a034-0000-4000-8000-000000000001","itemId":"0377a033-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null},{"lineId":"0377a034-0000-4000-8000-000000000002","itemId":"0377a033-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null}]'::jsonb, '{"error":"insufficient_stock"}'::jsonb, '{"holds":{"0377a033-0000-4000-8000-000000000001":5}}'::jsonb, null, null),
  (4, 'to_pick', '[{"lineId":"0377a044-0000-4000-8000-000000000001","itemId":"0377a043-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, null),
  (5, 'to_pick', '[{"lineId":"0377a054-0000-4000-8000-000000000001","itemId":"0377a053-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null}]'::jsonb, null, null, '{"holds":{"0377a053-0000-4000-8000-000000000001":3}}'::jsonb, null),
  (6, 'to_pick', '[{"lineId":"0377a064-0000-4000-8000-000000000001","itemId":"0377a063-0000-4000-8000-000000000001","requested":6,"fulfilled":2,"picked":null}]'::jsonb, null, null, '{"error":"no_fulfillable_stock"}'::jsonb, null),
  (7, 'to_pick', '[{"lineId":"0377a074-0000-4000-8000-000000000001","itemId":"0377a073-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":null},{"lineId":"0377a074-0000-4000-8000-000000000002","itemId":"0377a073-0000-4000-8000-000000000002","requested":5,"fulfilled":0,"picked":null},{"lineId":"0377a074-0000-4000-8000-000000000003","itemId":"0377a073-0000-4000-8000-000000000003","requested":5,"fulfilled":0,"picked":null},{"lineId":"0377a074-0000-4000-8000-000000000004","itemId":"0377a073-0000-4000-8000-000000000004","requested":5,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"picked":{"0377a074-0000-4000-8000-000000000001":6,"0377a074-0000-4000-8000-000000000002":3,"0377a074-0000-4000-8000-000000000003":5,"0377a074-0000-4000-8000-000000000004":4}}'::jsonb),
  (8, 'to_pick', '[{"lineId":"0377a084-0000-4000-8000-000000000001","itemId":"0377a083-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"error":"insufficient_placed_stock"}'::jsonb),
  (9, 'to_pick', '[{"lineId":"0377a094-0000-4000-8000-000000000001","itemId":"0377a093-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"error":"insufficient_placed_stock"}'::jsonb),
  (10, 'to_pick', '[{"lineId":"0377a0a4-0000-4000-8000-000000000001","itemId":"0377a0a3-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"picked":{"0377a0a4-0000-4000-8000-000000000001":10}}'::jsonb),
  (11, 'to_pick', '[{"lineId":"0377a0b4-0000-4000-8000-000000000001","itemId":"0377a0b3-0000-4000-8000-000000000001","requested":5,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"picked":{"0377a0b4-0000-4000-8000-000000000001":5}}'::jsonb),
  (12, 'to_pick', '[{"lineId":"0377a0c4-0000-4000-8000-000000000001","itemId":"0377a0c3-0000-4000-8000-000000000001","requested":10,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"picked":{"0377a0c4-0000-4000-8000-000000000001":10}}'::jsonb),
  (13, 'to_pick', '[{"lineId":"0377a0d4-0000-4000-8000-000000000001","itemId":"0377a0d3-0000-4000-8000-000000000001","requested":6,"fulfilled":0,"picked":4},{"lineId":"0377a0d4-0000-4000-8000-000000000002","itemId":"0377a0d3-0000-4000-8000-000000000002","requested":2,"fulfilled":0,"picked":null}]'::jsonb, null, null, null, '{"picked":{"0377a0d4-0000-4000-8000-000000000001":4,"0377a0d4-0000-4000-8000-000000000002":0}}'::jsonb),
  (14, 'to_pick', '[{"lineId":"0377a0e4-0000-4000-8000-000000000001","itemId":"0377a0e3-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null}]'::jsonb, '{"ok":true}'::jsonb, '{"holds":{"0377a0e3-0000-4000-8000-000000000001":3}}'::jsonb, null, null),
  (15, 'to_pick', '[{"lineId":"0377a0f4-0000-4000-8000-000000000001","itemId":"0377a0f3-0000-4000-8000-000000000001","requested":2,"fulfilled":0,"picked":null},{"lineId":"0377a0f4-0000-4000-8000-000000000002","itemId":"0377a0f3-0000-4000-8000-000000000002","requested":2,"fulfilled":0,"picked":null}]'::jsonb, '{"error":"item_warehouse_mismatch"}'::jsonb, '{"error":"item_warehouse_mismatch"}'::jsonb, null, null),
  (16, 'to_pick', '[{"lineId":"0377a104-0000-4000-8000-000000000001","itemId":"0377a103-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null}]'::jsonb, '{"ok":true}'::jsonb, '{"holds":{"0377a103-0000-4000-8000-000000000001":3}}'::jsonb, null, null),
  (17, 'to_pick', '[{"lineId":"0377a114-0000-4000-8000-000000000001","itemId":"0377a113-0000-4000-8000-000000000001","requested":3,"fulfilled":0,"picked":null}]'::jsonb, '{"error":"insufficient_stock"}'::jsonb, '{"holds":{"0377a113-0000-4000-8000-000000000001":2}}'::jsonb, null, null);

-- END GENERATED

select plan(50);

\set orgA    '\'03770000-0000-0000-0000-00000000000a\''
\set orgB    '\'03770000-0000-0000-0000-00000000000b\''
\set own     '\'03770000-0000-0000-0000-0000000000a0\''
\set mgr     '\'03770000-0000-0000-0000-0000000000a1\''
\set stf     '\'03770000-0000-0000-0000-0000000000a2\''
\set stf2    '\'03770000-0000-0000-0000-0000000000a3\''
\set stfN    '\'03770000-0000-0000-0000-0000000000a4\''
\set stfAp   '\'03770000-0000-0000-0000-0000000000a5\''
\set stfPm   '\'03770000-0000-0000-0000-0000000000a6\''
\set vwr     '\'03770000-0000-0000-0000-0000000000a7\''
\set vwrNp   '\'03770000-0000-0000-0000-0000000000a8\''
\set adm     '\'03770000-0000-0000-0000-0000000000a9\''
\set vwrCat  '\'03770000-0000-0000-0000-0000000000aa\''
\set stfCh   '\'03770000-0000-0000-0000-0000000000ab\''
\set stfX    '\'03770000-0000-0000-0000-0000000000ac\''
\set dis     '\'03770000-0000-0000-0000-0000000000ad\''
\set mgrB    '\'03770000-0000-0000-0000-0000000000b1\''
\set mgrAB   '\'03770000-0000-0000-0000-0000000000b2\''
\set nobody  '\'03770000-0000-0000-0000-0000000000c1\''
\set whA     '\'03770000-0000-0000-0000-0000000000d1\''
\set whA2    '\'03770000-0000-0000-0000-0000000000d2\''
\set whB     '\'03770000-0000-0000-0000-0000000000d3\''
\set rA      '\'03770000-0000-0000-0000-0000000000e1\''
\set cA      '\'03770000-0000-0000-0000-0000000000e2\''
\set siteA   '\'03770000-0000-0000-0000-0000000000e3\''
\set rA2     '\'03770000-0000-0000-0000-0000000000e4\''
\set siteA2  '\'03770000-0000-0000-0000-0000000000e5\''
\set siteOrg '\'03770000-0000-0000-0000-0000000000e6\''
\set chX     '\'03770000-0000-0000-0000-000000000c01\''
\set chY     '\'03770000-0000-0000-0000-000000000c02\''
\set k1      '\'03770000-0000-0000-0000-000000000c11\''
\set k2      '\'03770000-0000-0000-0000-000000000c12\''
\set rentR   '\'03770000-0000-0000-0000-000000000c21\''
\set iMain   '\'03770000-0000-0000-0000-000000000f01\''
\set iAnnex  '\'03770000-0000-0000-0000-000000000f02\''
\set iCharter '\'03770000-0000-0000-0000-000000000f03\''
\set iCatOk  '\'03770000-0000-0000-0000-000000000f04\''
\set iCat    '\'03770000-0000-0000-0000-000000000f05\''
\set iPo     '\'03770000-0000-0000-0000-000000000f06\''
\set iPend   '\'03770000-0000-0000-0000-000000000f07\''
\set iCmt    '\'03770000-0000-0000-0000-000000000f08\''
\set iTrunc  '\'03770000-0000-0000-0000-000000000f09\''
\set iB      '\'03770000-0000-0000-0000-000000000f20\''
\set ordMain '\'03770000-0000-0000-0000-000000000101\''
\set ordOther '\'03770000-0000-0000-0000-000000000102\''
\set ordP1   '\'03770000-0000-0000-0000-000000000103\''
\set ordP2   '\'03770000-0000-0000-0000-000000000104\''
\set ordPx   '\'03770000-0000-0000-0000-000000000105\''
\set ordC1   '\'03770000-0000-0000-0000-000000000111\''
\set ordC2   '\'03770000-0000-0000-0000-000000000112\''
\set ordC3   '\'03770000-0000-0000-0000-000000000113\''
\set ordC4   '\'03770000-0000-0000-0000-000000000114\''
\set ordC5   '\'03770000-0000-0000-0000-000000000115\''
\set ordC6   '\'03770000-0000-0000-0000-000000000116\''
\set ordC7   '\'03770000-0000-0000-0000-000000000117\''
\set ordC8   '\'03770000-0000-0000-0000-000000000118\''
\set ordPicked '\'03770000-0000-0000-0000-000000000121\''
\set ordClosed '\'03770000-0000-0000-0000-000000000122\''
\set ordBig  '\'03770000-0000-0000-0000-000000000131\''
\set ordBig2 '\'03770000-0000-0000-0000-000000000132\''
\set ordB    '\'03770000-0000-0000-0000-000000000141\''
\set ordForeign '\'03770000-0000-0000-0000-000000000142\''
\set lMain   '\'03770000-0000-0000-0000-000000000201\''
\set lAnnex  '\'03770000-0000-0000-0000-000000000202\''
\set lCharter '\'03770000-0000-0000-0000-000000000203\''
\set lCatOk  '\'03770000-0000-0000-0000-000000000204\''
\set lCat    '\'03770000-0000-0000-0000-000000000205\''
\set lPo     '\'03770000-0000-0000-0000-000000000206\''
\set lPend   '\'03770000-0000-0000-0000-000000000207\''
\set lTieB   '\'03770000-0000-0000-0000-000000000208\''
\set lTieA   '\'03770000-0000-0000-0000-000000000209\''
\set lCmt    '\'03770000-0000-0000-0000-00000000020a\''
\set lTrunc  '\'03770000-0000-0000-0000-00000000020b\''
\set poA     '\'03770000-0000-0000-0000-000000000301\''
\set poA2    '\'03770000-0000-0000-0000-000000000302\''
\set poNull  '\'03770000-0000-0000-0000-000000000303\''
\set poOrg   '\'03770000-0000-0000-0000-000000000304\''
\set poOver  '\'03770000-0000-0000-0000-000000000305\''
\set poCan   '\'03770000-0000-0000-0000-000000000306\''
\set poRec   '\'03770000-0000-0000-0000-000000000307\''
\set poDraft '\'03770000-0000-0000-0000-000000000308\''
\set poDraftA2 '\'03770000-0000-0000-0000-000000000309\''
\set poDone  '\'03770000-0000-0000-0000-00000000030a\''
\set pOrg    '\'0377a000-0000-4000-8000-00000000000a\''
\set pMgr    '\'0377a000-0000-4000-8000-0000000000a1\''
\set pHome   '\'0377a000-0000-4000-8000-0000000000d1\''
\set pOther  '\'0377a000-0000-4000-8000-0000000000d2\''

-- ══ Fixtures: org A ═══════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  (:own,    '0377-own@test.local',    '{}'::jsonb),
  (:adm,    '0377-adm@test.local',    '{}'::jsonb),
  (:mgr,    '0377-mgr@test.local',    '{}'::jsonb),
  (:stf,    '0377-stf@test.local',    '{}'::jsonb),
  (:stf2,   '0377-stf2@test.local',   '{}'::jsonb),
  (:stfN,   '0377-stfn@test.local',   '{}'::jsonb),
  (:stfAp,  '0377-stfap@test.local',  '{}'::jsonb),
  (:stfPm,  '0377-stfpm@test.local',  '{}'::jsonb),
  (:vwr,    '0377-vwr@test.local',    '{}'::jsonb),
  (:vwrNp,  '0377-vwrnp@test.local',  '{}'::jsonb),
  (:vwrCat, '0377-vwrcat@test.local', '{}'::jsonb),
  (:stfCh,  '0377-stfch@test.local',  '{}'::jsonb),
  (:stfX,   '0377-stfx@test.local',   '{}'::jsonb),
  (:dis,    '0377-dis@test.local',    '{}'::jsonb),
  (:mgrB,   '0377-mgrb@test.local',   '{}'::jsonb),
  (:mgrAB,  '0377-mgrab@test.local',  '{}'::jsonb),
  (:nobody, '0377-nobody@test.local', '{}'::jsonb),
  (:pMgr,   '0377-pmgr@test.local',   '{}'::jsonb)
  on conflict (id) do nothing;
-- An org insert enables the default modules (orders and purchase_orders among
-- them); the warehouse insert creates its Staging and Unplaced.
insert into public.organizations (id, name, slug) values
  (:orgA, '0377 Readiness A', '0377-readiness-a'),
  (:orgB, '0377 Readiness B', '0377-readiness-b'),
  (:pOrg, '0377 Parity',      '0377-parity');
-- Org A works in Chicago (the facts carry the org's own zone, F11).
update public.organizations set timezone = 'America/Chicago' where id = :orgA;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:orgA, :own,    'owner',   now()),
  (:orgA, :adm,    'admin',   now()),
  (:orgA, :mgr,    'manager', now()),
  (:orgA, :stf,    'staff',   now()),
  (:orgA, :stf2,   'staff',   now()),
  (:orgA, :stfN,   'staff',   now()),
  (:orgA, :stfAp,  'staff',   now()),
  (:orgA, :stfPm,  'staff',   now()),
  (:orgA, :vwr,    'viewer',  now()),
  (:orgA, :vwrNp,  'viewer',  now()),
  (:orgA, :vwrCat, 'viewer',  now()),
  (:orgA, :stfCh,  'staff',   now()),
  (:orgA, :stfX,   'staff',   now()),
  (:orgA, :dis,    'staff',   now()),
  (:orgB, :mgrB,   'manager', now()),
  -- A manager of BOTH orgs: org B's items are readable to them, so only the
  -- facts' own org filter keeps org B's item off an org A order (V16).
  (:orgA, :mgrAB,  'manager', now()),
  (:orgB, :mgrAB,  'manager', now()),
  (:pOrg, :pMgr,   'manager', now());
insert into public.warehouses (id, organization_id, name, code, status) values
  (:whA,    :orgA, '0377 Main',   'WH-0377A',  'active'),
  (:whA2,   :orgA, '0377 Annex',  'WH-0377A2', 'active'),
  (:whB,    :orgB, '0377 Other',  'WH-0377B',  'active'),
  (:pHome,  :pOrg, 'Parity home', 'WH-0377PH', 'active'),
  (:pOther, :pOrg, 'Parity other','WH-0377PO', 'active');
insert into public.charters (id, organization_id, name) values
  (:chX, :orgA, '0377 Charter X'),
  (:chY, :orgA, '0377 Charter Y');
insert into public.warehouse_charters (organization_id, warehouse_id, charter_id) values
  (:orgA, :whA, :chX),
  (:orgA, :whA, :chY);
insert into public.categories (id, organization_id, name) values
  (:k1, :orgA, '0377 Cat 1'),
  (:k2, :orgA, '0377 Cat 2');
-- stfX's assignment row carries the WRONG organization (org B) for a
-- warehouse of org A (the 0374 persona): the item read scope joins through
-- the warehouse's org and lets stfX read warehouse A's items, while
-- my_warehouse_ids() requires the row's own org and gives stfX no warehouse,
-- so no holding in warehouse A is in stfX's holdings scope.
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id, charter_id, is_primary) values
  (:orgA, :stf,    :whA,  null, true),
  (:orgA, :stf2,   :whA2, null, true),
  (:orgA, :stfAp,  :whA,  null, true),
  (:orgA, :stfPm,  :whA2, null, true),
  (:orgA, :vwr,    :whA,  null, true),
  (:orgA, :vwrNp,  :whA,  null, true),
  (:orgA, :vwrCat, :whA,  null, true),
  (:orgA, :stfCh,  :whA,  :chY, true),
  (:orgB, :stfX,   :whA,  null, true),
  (:orgA, :dis,    :whA,  null, true);
insert into public.user_category_assignments (organization_id, user_id, category_id) values
  (:orgA, :vwrCat, :k1);
insert into public.user_permission_overrides (organization_id, user_id, permission, granted) values
  (:orgA, :stfAp, 'orders:approve',         true),
  (:orgA, :stfPm, 'purchase_orders:manage', true),
  (:orgA, :vwrNp, 'purchase_orders:read',   false);

insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  (:rA,      :orgA, :whA,  '0377-A-1',   'shelf',     'rack'),
  (:cA,      :orgA, :whA,  '0377-CR-1',  'bin',       'crate'),
  (:siteA,   :orgA, :whA,  '0377 Site',  'warehouse', null),
  (:rA2,     :orgA, :whA2, '0377-N-1',   'shelf',     'rack'),
  (:siteA2,  :orgA, :whA2, '0377 Annex Site', 'warehouse', null),
  (:siteOrg, :orgA, null,  '0377 Job site', 'jobsite', null);
select public.ensure_org_placement_locations(:orgA) as "_ignored" \gset
select id as "stA"   from public.locations where warehouse_id = :whA  and kind = 'staging' and deleted_at is null \gset
select id as "unA"   from public.locations where warehouse_id = :whA  and kind = 'unplaced' and deleted_at is null \gset
select id as "stA2"  from public.locations where warehouse_id = :whA2 and kind = 'staging' and deleted_at is null \gset
select id as "stOrg" from public.locations where organization_id = :orgA and warehouse_id is null
                                             and kind = 'staging' and deleted_at is null \gset

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, charter_id, category_id) values
  (:iMain,    :orgA, :whA,  'X0377-MAIN',  'Main item',        41, 'active', null, null),
  (:iAnnex,   :orgA, :whA2, 'X0377-ANNEX', 'Annex item',       0,  'active', null, null),
  (:iCharter, :orgA, :whA,  'X0377-CHX',   'Charter X item',   0,  'active', :chX, null),
  (:iCatOk,   :orgA, :whA,  'X0377-CAT1',  'Category 1 item',  0,  'active', null, :k1),
  (:iCat,     :orgA, :whA,  'X0377-CAT2',  'Category 2 item',  0,  'active', null, :k2),
  (:iPo,      :orgA, :whA,  'X0377-PO',    'On order item',    0,  'active', null, null),
  (:iPend,    :orgA, :whA,  'X0377-PEND',  'Wanted item',      0,  'active', null, null),
  (:iCmt,     :orgA, :whA,  'X0377-CMT',   'Committed item',   0,  'active', null, null),
  (:iTrunc,   :orgA, :whA,  'X0377-TRUNC', 'Many POs item',    0,  'active', null, null),
  (:iB,       :orgB, :whB,  'X0377-B',     'Org B item',       0,  'active', null, null);

-- iMain's 41 on record, all accounted for: rack 10 + crate 2 (rack 12),
-- Site 3 + org-level Site 2 (site 5), Unplaced 4, Staging 5 + org-level
-- Staging 1 (staging 6) here; the annex rack 6 and the annex's NULL-kind Site
-- 1 (pickable 7) and Staging 7 elsewhere. The item's opening stock was seeded
-- at its Unplaced; the upsert sets it to 4.
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:orgA, :iMain, :rA,      10),
  (:orgA, :iMain, :cA,      2),
  (:orgA, :iMain, :siteA,   3),
  (:orgA, :iMain, :siteOrg, 2),
  (:orgA, :iMain, :'unA',   4),
  (:orgA, :iMain, :'stA',   5),
  (:orgA, :iMain, :'stOrg', 1),
  (:orgA, :iMain, :rA2,     6),
  (:orgA, :iMain, :siteA2,  1),
  (:orgA, :iMain, :'stA2',  7)
  on conflict (item_id, location_id) do update set quantity = excluded.quantity;

insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type) values
  (:ordMain,   :orgA, :whA, 'approved',             'internal', :stf, 'pickup'),
  (:ordOther,  :orgA, :whA, 'approved',             'internal', :stf, 'pickup'),
  (:ordP1,     :orgA, :whA, 'pending_approval',     'internal', :stf, 'pickup'),
  (:ordP2,     :orgA, :whA, 'pending_approval',     'internal', :stf, 'pickup'),
  (:ordPx,     :orgA, :whA, 'cancelled',            'internal', :stf, 'pickup'),
  (:ordC1,     :orgA, :whA, 'approved',             'internal', :stf, 'pickup'),
  (:ordC2,     :orgA, :whA, 'backordered',          'internal', :stf, 'pickup'),
  (:ordC3,     :orgA, :whA, 'picking_complete',     'internal', :stf, 'pickup'),
  (:ordC4,     :orgA, :whA, 'in_transit',           'internal', :stf, 'pickup'),
  (:ordC5,     :orgA, :whA, 'pending_approval',     'internal', :stf, 'pickup'),
  (:ordC6,     :orgA, :whA, 'pending_confirmation', 'internal', :stf, 'pickup'),
  (:ordC7,     :orgA, :whA, 'completed',            'internal', :stf, 'pickup'),
  (:ordC8,     :orgA, :whA, 'pick_slip_generated',  'internal', :stf, 'pickup'),
  (:ordPicked, :orgA, :whA, 'staged_for_pickup',    'internal', :stf, 'pickup'),
  (:ordClosed, :orgA, :whA, 'completed',            'internal', :stf, 'pickup'),
  (:ordBig,    :orgA, :whA, 'pending_approval',     'internal', :stf, 'pickup'),
  (:ordBig2,   :orgA, :whA, 'pending_approval',     'internal', :stf, 'pickup'),
  (:ordB,      :orgB, :whB, 'pending_approval',     'internal', :mgrB, 'pickup'),
  (:ordForeign, :orgA, :whA, 'pending_approval',    'internal', :mgr, 'pickup');

-- ordMain's lines, created_at set so the order is known; the two tie lines
-- share a moment and are ordered by id (lTieB, ...208, before lTieA, ...209).
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked, created_at) values
  (:lMain,    :ordMain, :iMain,    4,  0, null, '2026-09-01 10:00:00+00'),
  (:lAnnex,   :ordMain, :iAnnex,   1,  0, null, '2026-09-01 10:00:01+00'),
  (:lCharter, :ordMain, :iCharter, 1,  0, null, '2026-09-01 10:00:02+00'),
  (:lCatOk,   :ordMain, :iCatOk,   1,  0, null, '2026-09-01 10:00:03+00'),
  (:lCat,     :ordMain, :iCat,     1,  0, null, '2026-09-01 10:00:04+00'),
  (:lPo,      :ordMain, :iPo,      50, 0, null, '2026-09-01 10:00:05+00'),
  (:lPend,    :ordMain, :iPend,    2,  0, null, '2026-09-01 10:00:06+00'),
  (:lTieA,    :ordMain, :iMain,    1,  0, null, '2026-09-01 10:00:07+00'),
  (:lTieB,    :ordMain, :iMain,    1,  0, null, '2026-09-01 10:00:07+00'),
  (:lCmt,     :ordMain, :iCmt,     1,  0, null, '2026-09-01 10:00:08+00'),
  (:lTrunc,   :ordMain, :iTrunc,   1,  0, null, '2026-09-01 10:00:09+00');
insert into public.order_request_lines
  (order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked) values
  (:ordOther,  :iMain, 3,   0, null),
  (:ordP1,     :iPend, 5,   0, null),
  (:ordP2,     :iPend, 3,   0, null),
  (:ordPx,     :iPend, 9,   0, null),
  -- committedOtherShortfall for iCmt, per status class:
  (:ordC1,     :iCmt,  10,  0, null),  -- approved, 10 owed, 6 held: 4
  (:ordC2,     :iCmt,  8,   3, null),  -- backordered, 5 owed, 0 held: 5
  (:ordC3,     :iCmt,  6,   0, 2),     -- picking_complete, 6 owed, 2 picked: 4
  (:ordC4,     :iCmt,  5,   5, 0),     -- in_transit, 0 owed: 0
  (:ordC5,     :iCmt,  100, 0, null),  -- pending_approval: not committed (pendingOthers)
  (:ordC6,     :iCmt,  50,  0, null),  -- pending_confirmation: not committed
  (:ordC7,     :iCmt,  30,  0, null),  -- completed: closed
  (:ordC8,     :iCmt,  3,   0, null),  -- pick_slip_generated, 3 owed, 3 held: 0
  (:ordPicked, :iMain, 1,   0, 1),
  (:ordClosed, :iMain, 1,   1, null),
  (:ordB,      :iB,    1,   0, null),
  -- A line whose item is another org's (no constraint stops it: defence in
  -- depth, V16).
  (:ordForeign, :iB,   1,   0, null);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select :ordBig, :iMain, 1 from generate_series(1, 201);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select :ordBig2, :iMain, 1 from generate_series(1, 200);

insert into public.rentals (id, organization_id, warehouse_id, borrower_name, expected_return_at, status)
values (:rentR, :orgA, :whA, 'Borrower 0377', now() + interval '7 days', 'out');
insert into public.stock_reservations
  (organization_id, item_id, warehouse_id, order_request_id, rental_id, quantity, released_at) values
  (:orgA, :iMain, :whA, :ordMain,  null,   4,   null),
  (:orgA, :iMain, :whA, :ordOther, null,   3,   null),
  (:orgA, :iMain, :whA, null,      :rentR, 2,   null),
  (:orgA, :iMain, :whA, :ordOther, null,   100, now() - interval '1 day'),  -- released: ignored
  (:orgA, :iCmt,  :whA, :ordC1,    null,   6,   null),
  (:orgA, :iCmt,  :whA, :ordC8,    null,   3,   null);

-- Purchase orders for iPo (remaining per PO: poOrg 3 Oct 1, poA 12 Oct 3,
-- poOver 7 Oct 5, poA2 5 Oct 10, poNull 6 no date; drafts poDraft 4 and
-- poDraftA2 2; poCan and poRec ignored).
insert into public.purchase_orders (id, organization_id, po_number, destination_location_id, status, expected_at) values
  (:poA,       :orgA, 'PO-0377-A',  :rA,      'ordered',            '2026-10-03 16:00+00'),
  (:poA2,      :orgA, 'PO-0377-A2', :rA2,     'ordered',            '2026-10-10 16:00+00'),
  (:poNull,    :orgA, 'PO-0377-N',  null,     'partially_received', null),
  (:poOrg,     :orgA, 'PO-0377-O',  :siteOrg, 'expected_inbound',   '2026-10-01 16:00+00'),
  (:poOver,    :orgA, 'PO-0377-V',  :rA,      'ordered',            '2026-10-05 16:00+00'),
  (:poCan,     :orgA, 'PO-0377-C',  :rA,      'cancelled',          '2026-10-02 16:00+00'),
  (:poRec,     :orgA, 'PO-0377-R',  :rA,      'received',           '2026-10-02 16:00+00'),
  (:poDraft,   :orgA, 'PO-0377-D',  null,     'draft',              null),
  (:poDraftA2, :orgA, 'PO-0377-D2', :rA2,     'draft',              null),
  -- Open, but its only line for iPo is fully received: nothing remaining,
  -- so no row (F15). Not PO-0377-%: the visibility sweep's list is fixed.
  (:poDone,    :orgA, 'PX-0377-DONE', null,   'partially_received', '2026-10-02 00:00+00');
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost) values
  (:orgA, :poA,       :iPo, 12, 0,   1),
  (:orgA, :poA2,      :iPo, 5,  0,   1),
  (:orgA, :poNull,    :iPo, 10, 4,   1),
  (:orgA, :poOrg,     :iPo, 3,  0,   1),
  (:orgA, :poOver,    :iPo, 10, 520, 1),  -- over-received by 510: floors at 0
  (:orgA, :poOver,    :iPo, 7,  0,   1),
  (:orgA, :poCan,     :iPo, 50, 0,   1),
  (:orgA, :poRec,     :iPo, 9,  0,   1),
  (:orgA, :poDraft,   :iPo, 4,  0,   1),
  (:orgA, :poDraftA2, :iPo, 2,  0,   1),
  (:orgA, :poDone,    :iPo, 4,  4,   1);
-- iTrunc: 11 open POs with no destination (visible to every PO reader), one
-- a day; the 11th (5 units) is past the 10-row cap.
insert into public.purchase_orders (id, organization_id, po_number, destination_location_id, status, expected_at)
select ('03770000-0000-0000-0000-0000000004' || lpad(g::text, 2, '0'))::uuid, :orgA,
       'PO-0377-T' || lpad(g::text, 2, '0'), null, 'ordered', timestamptz '2026-11-01 16:00+00' + (g || ' days')::interval
  from generate_series(1, 11) g;
insert into public.purchase_order_items (organization_id, purchase_order_id, item_id, quantity_ordered, quantity_received, unit_cost)
select :orgA, ('03770000-0000-0000-0000-0000000004' || lpad(g::text, 2, '0'))::uuid, :iTrunc,
       case when g = 11 then 5 else 1 end, 0, 1
  from generate_series(1, 11) g;

-- The disabled member, disabled the way the service does it.
set local role to 'service_role';
update public.user_profiles set disabled_at = now(), disabled_reason = 'policy_violation' where id = :dis;
reset role;

-- ══ Fixtures: the parity org (from the generated block) ══════════════════
insert into public.locations (id, organization_id, warehouse_id, name, type, kind) values
  ('0377a000-0000-4000-8000-0000000000e1', :pOrg, :pHome,  'P-H-R', 'shelf',     'rack'),
  ('0377a000-0000-4000-8000-0000000000e2', :pOrg, :pHome,  'P-H-C', 'bin',       'crate'),
  ('0377a000-0000-4000-8000-0000000000e3', :pOrg, :pHome,  'P-H-S', 'warehouse', null),
  ('0377a000-0000-4000-8000-0000000000e4', :pOrg, :pOther, 'P-O-R', 'shelf',     'rack'),
  ('0377a000-0000-4000-8000-0000000000e5', :pOrg, :pOther, 'P-O-C', 'bin',       'crate'),
  ('0377a000-0000-4000-8000-0000000000e6', :pOrg, :pOther, 'P-O-S', 'warehouse', null),
  ('0377a000-0000-4000-8000-0000000000e7', :pOrg, null,    'P-G-R', 'shelf',     'rack'),
  ('0377a000-0000-4000-8000-0000000000e8', :pOrg, null,    'P-G-S', 'jobsite',   null);
select public.ensure_org_placement_locations(:pOrg) as "_ignored" \gset
create temp table rp_loc (kind text not null, wh text not null, location_id uuid not null, primary key (kind, wh));
insert into rp_loc values
  ('rack',  'home',  '0377a000-0000-4000-8000-0000000000e1'),
  ('crate', 'home',  '0377a000-0000-4000-8000-0000000000e2'),
  ('site',  'home',  '0377a000-0000-4000-8000-0000000000e3'),
  ('rack',  'other', '0377a000-0000-4000-8000-0000000000e4'),
  ('crate', 'other', '0377a000-0000-4000-8000-0000000000e5'),
  ('site',  'other', '0377a000-0000-4000-8000-0000000000e6'),
  ('rack',  'org',   '0377a000-0000-4000-8000-0000000000e7'),
  ('crate', 'org',   '0377a000-0000-4000-8000-0000000000e7'),
  ('site',  'org',   '0377a000-0000-4000-8000-0000000000e8');
insert into rp_loc
select l.kind, case when l.warehouse_id = :pHome then 'home' when l.warehouse_id = :pOther then 'other' else 'org' end, l.id
  from public.locations l
 where l.organization_id = :pOrg and l.kind in ('staging', 'unplaced') and l.deleted_at is null;

insert into public.inventory_items (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, is_bundle)
select i.item_id, :pOrg, case i.item_wh when 'other' then :pOther::uuid else :pHome::uuid end, i.sku, i.name, i.on_hand, 'active', i.is_bundle
  from rp_item i;
-- The opening stock was seeded at each item's Unplaced: zero it, then write
-- the fixture's holdings.
update public.item_stock_levels set quantity = 0 where item_id in (select item_id from rp_item);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
select :pOrg, h.item_id, l.location_id, sum(h.qty)
  from rp_holding h join rp_loc l on l.kind = h.kind and l.wh = h.wh
 group by h.item_id, l.location_id
    on conflict (item_id, location_id) do update set quantity = excluded.quantity;
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select c.order_id, :pOrg, :pHome, c.status, 'internal', :pMgr, 'pickup' from rp_case c;
insert into public.order_requests (id, organization_id, warehouse_id, status, source, requester_user_id, fulfillment_type)
select c.holder_id, :pOrg, :pHome, 'approved', 'internal', :pMgr, 'pickup'
  from rp_case c
 where exists (select 1 from rp_hold h where h.case_no = c.case_no and h.holder = 'otherOrder');
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked, created_at)
select l.line_id, c.order_id, l.item_id, l.requested, l.fulfilled, l.picked, l.created_at
  from rp_line l join rp_case c using (case_no);
insert into public.order_request_lines (order_request_id, item_id, quantity_requested)
select c.holder_id, h.item_id, h.qty from rp_hold h join rp_case c using (case_no) where h.holder = 'otherOrder';
update public.inventory_items set deleted_at = now() where id in (select item_id from rp_item where deleted);
insert into public.stock_reservations (organization_id, item_id, warehouse_id, order_request_id, quantity)
select :pOrg, h.item_id, :pHome,
       case h.holder when 'own' then c.order_id when 'otherOrder' then c.holder_id end, h.qty
  from rp_hold h join rp_case c using (case_no);

-- ── Helpers ──────────────────────────────────────────────────────────────
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_hint text; v_msg text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
  return v_state || ':' || coalesce(v_hint, '') || ':' || v_msg;
end $$;

-- One item of an answer.
create function pg_temp.item(p_facts jsonb, p_item uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_facts->'items') x where x->>'itemId' = p_item::text
$$;

-- The facts pgTAP compares for a parity item (comparedItemFacts in the generator).
create function pg_temp.rp_subset(x jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'onHand', x->'onHand', 'heldOwn', x->'heldOwn', 'heldOtherOrders', x->'heldOtherOrders',
    'heldRentals', x->'heldRentals', 'here', x->'here', 'elsewhere', x->'elsewhere',
    'stagingHiddenQty', x->'stagingHiddenQty',
    'stagingSourcesTotal', (select coalesce(sum((s->>'quantity')::numeric), 0)
                              from jsonb_array_elements(x->'stagingSources') s),
    'committedOtherShortfall', x->'committedOtherShortfall', 'pendingOthers', x->'pendingOthers',
    'inbound', x->'inbound', 'drafts', x->'drafts', 'deleted', x->'deleted', 'isBundle', x->'isBundle',
    'itemWarehouseId', x->'itemWarehouseId', 'visible', x->'visible')
$$;

-- Run one frozen RPC for a parity case inside a subtransaction, capture what
-- it did, and ALWAYS roll it back (every case starts from the fixture).
create function pg_temp.rp_call(p_rpc text, p_case int) returns jsonb language plpgsql as $$
declare v_order uuid; v_out jsonb; v_msg text;
begin
  select c.order_id into v_order from rp_case c where c.case_no = p_case;
  begin
    if p_rpc = 'approve' then
      perform public.approve_order_request(v_order);
      v_out := '{"ok": true}'::jsonb;
    elsif p_rpc in ('approve_partial', 'resume') then
      if p_rpc = 'approve_partial' then perform public.approve_partial(v_order);
      else perform public.resume_fulfillment(v_order); end if;
      select jsonb_build_object('holds', jsonb_object_agg(i.item_id::text, coalesce((
               select sum(r.quantity) from public.stock_reservations r
                where r.order_request_id = v_order and r.item_id = i.item_id and r.released_at is null), 0)))
        into v_out from rp_item i where i.case_no = p_case;
    elsif p_rpc = 'complete' then
      perform public.complete_picking(v_order);
      select jsonb_build_object('picked', jsonb_object_agg(l.line_id::text, ol.quantity_picked))
        into v_out
        from rp_line l join public.order_request_lines ol on ol.id = l.line_id
       where l.case_no = p_case;
    else
      raise exception 'unknown rpc %', p_rpc;
    end if;
    raise exception 'rp_rollback';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg = 'rp_rollback' then return v_out; end if;
    return jsonb_build_object('error', v_msg);
  end;
end $$;

create temp table fx (who text not null, ord uuid not null, r jsonb not null);
create temp table pv (who text not null, po uuid not null, fn boolean, rls boolean);
create temp table rp_facts (case_no int primary key, facts jsonb not null);
create temp table rp_run (case_no int not null, rpc text not null, result jsonb);
grant all on fx, pv, rp_facts, rp_run to authenticated;
grant select on rp_case, rp_item, rp_line, rp_expect to authenticated;
-- The POs the visibility sweep asks about, listed as the superuser: a list
-- read as the persona would hold only the POs RLS already shows.
create temp table pv_po as
select id from public.purchase_orders where po_number like 'PO-0377-%' and po_number not like 'PO-0377-T%';
grant select on pv_po to authenticated;

-- Guard the fixtures: a silently missing row would let an assertion pass for
-- the wrong reason.
do $$ begin
  if (select count(*) from public.order_request_lines where order_request_id = '03770000-0000-0000-0000-000000000101') <> 11
     or (select count(*) from public.order_request_lines where order_request_id = '03770000-0000-0000-0000-000000000131') <> 201
     or (select sum(quantity) from public.item_stock_levels where item_id = '03770000-0000-0000-0000-000000000f01') <> 41
     or (select count(*) from public.purchase_orders where po_number like 'PO-0377-%') <> 20
     or (select count(*) from rp_case) < 14
     or (select count(*) from rp_line) <> (select count(*) from public.order_request_lines l
                                            join rp_case c on c.order_id = l.order_request_id)
  then raise exception '0377 test fixtures incomplete'; end if;
end $$;

-- ═══ G. Structure, grants and gates ═══════════════════════════════════════
select ok(
  (select p.prosecdef and p.provolatile = 's'
          and p.proconfig @> array['search_path=public, pg_temp']
     from pg_proc p where p.oid = 'public.order_readiness_facts(uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.order_readiness_facts(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.order_readiness_facts(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.order_readiness_facts(uuid)', 'EXECUTE')
  and not exists (select 1 from pg_proc p, unnest(p.proacl) a
                   where p.oid = 'public.order_readiness_facts(uuid)'::regprocedure and a::text like '=%'),
  'G1: order_readiness_facts is SECURITY DEFINER, STABLE, search_path pinned to public, pg_temp; EXECUTE to authenticated and service_role, not anon or PUBLIC');
select ok(
  (select p.prosrc ~ 'auth\.uid\(\)' and p.prosrc ~ 'is_org_member\(v_org\)'
          and p.prosrc ~ 'caller_can_read_item\(i\.id\)' and p.prosrc ~ 'purchase_order_visible\('
          and p.prosrc ~ 'location_holdings_visible\(' and p.prosrc ~ $re$has_permission\(v_org, 'orders:approve'\)$re$
          and p.prosrc !~ '40001|40P01' and p.prosrc !~* '\m(insert|update|delete)\M\s'
     from pg_proc p where p.oid = 'public.order_readiness_facts(uuid)'::regprocedure),
  'G2: its gates are in its own body (signed in, member, readable item, visible PO and holdings, approver-only pending demand), it writes nothing and never raises 40001/40P01');
select ok(
  (select not p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=public']
     from pg_proc p where p.oid = 'public.purchase_order_visible(uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.purchase_order_visible(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.purchase_order_visible(uuid)', 'EXECUTE'),
  'G3: purchase_order_visible is SECURITY INVOKER, STABLE, search_path pinned, EXECUTE to authenticated and not anon');

set local "request.jwt.claim.role" to 'authenticated';
set local "request.jwt.claim.sub" to '';
set local role to 'authenticated';
select is(
  pg_temp.err(format('select public.order_readiness_facts(%L)', :ordMain)),
  '42501::unauthenticated',
  'G4: no signed-in caller: 42501 unauthenticated');
reset role;
set local role to 'service_role';
select is(
  pg_temp.err(format('select public.order_readiness_facts(%L)', :ordMain)),
  '42501::unauthenticated',
  'G5: the service role (no caller) gets 42501 too, never an answer');
reset role;

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :nobody;
insert into fx select 'nobody', :ordMain, to_jsonb(pg_temp.err(format('select public.order_readiness_facts(%L)', :ordMain)));
set local "request.jwt.claim.sub" to :mgrB;
insert into fx select 'mgrB', :ordMain, to_jsonb(pg_temp.err(format('select public.order_readiness_facts(%L)', :ordMain)));
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'random', :ordMain, to_jsonb(pg_temp.err('select public.order_readiness_facts(gen_random_uuid())'));
insert into fx select 'null', :ordMain, to_jsonb(pg_temp.err('select public.order_readiness_facts(null)'));
set local "request.jwt.claim.sub" to :dis;
insert into fx select 'disabled', :ordMain, to_jsonb(pg_temp.err(format('select public.order_readiness_facts(%L)', :ordMain)));
reset role;
select is(
  (select array_agg(distinct r #>> '{}') from fx where who in ('nobody', 'mgrB', 'random', 'null', 'disabled')),
  array['P0002::order_request_not_found'],
  'G6: a non-member, another org''s manager, a random id, a null id and a disabled member all get the SAME P0002 order_request_not_found (existence is not disclosed)');
delete from fx;

update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'orders';
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
select is(
  pg_temp.err(format('select public.order_readiness_facts(%L)', :ordMain)),
  'P0001:module_disabled:module_disabled',
  'G7: the orders module off: P0001 module_disabled');
reset role;
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'orders';

set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'big',  :ordBig,  public.order_readiness_facts(:ordBig);
insert into fx select 'big2', :ordBig2, public.order_readiness_facts(:ordBig2);
reset role;
select is(
  (select jsonb_build_object('linesCapped', r->'linesCapped', 'lines', r->'lines', 'items', r->'items',
                             'phase', r->'phase', 'v', r->'v', 'orderId', r#>'{order,id}')
     from fx where who = 'big'),
  jsonb_build_object('linesCapped', true, 'lines', '[]'::jsonb, 'items', '[]'::jsonb,
                     'phase', 'to_pick', 'v', 1, 'orderId', :ordBig::text),
  'G8: 201 lines: linesCapped, no lines and no items (never a partial answer), the order still named');
select is(
  (select row((r->>'linesCapped')::boolean, jsonb_array_length(r->'lines'), jsonb_array_length(r->'items'))::text
     from fx where who = 'big2'),
  row(false, 200, 1)::text,
  'G9: 200 lines are answered in full');
delete from fx;

-- ═══ Answers per persona for ordMain ═════════════════════════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'mgr', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :stf;
insert into fx select 'stf', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :stfAp;
insert into fx select 'stfAp', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :stfCh;
insert into fx select 'stfCh', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :vwrCat;
insert into fx select 'vwrCat', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :stfX;
insert into fx select 'stfX', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :vwrNp;
insert into fx select 'vwrNp', :ordMain, public.order_readiness_facts(:ordMain);
set local "request.jwt.claim.sub" to :mgrAB;
insert into fx select 'mgrABforeign', :ordForeign, public.order_readiness_facts(:ordForeign);
insert into fx select 'mgrABownB', :ordB, public.order_readiness_facts(:ordB);
set local "request.jwt.claim.sub" to :mgr;
insert into fx select 'mgrPicked', :ordPicked, public.order_readiness_facts(:ordPicked);
insert into fx select 'mgrClosed', :ordClosed, public.order_readiness_facts(:ordClosed);
reset role;
update public.organization_modules set enabled = false where organization_id = :orgA and module_id = 'purchase_orders';
set local role to 'authenticated';
insert into fx select 'mgrNoPo', :ordMain, public.order_readiness_facts(:ordMain);
reset role;
update public.organization_modules set enabled = true where organization_id = :orgA and module_id = 'purchase_orders';

-- ═══ V. Visibility ═══════════════════════════════════════════════════════
-- Mutation: drop caller_can_read_item -> the annex item comes back with
-- every number.
select is(
  (select pg_temp.item(r, :iAnnex) from fx where who = 'stf'),
  jsonb_build_object('itemId', :iAnnex::text, 'visible', false),
  'V1: staff scoped to warehouse A get the annex item as {itemId, visible:false} and nothing else');
select is(
  (select (pg_temp.item(r, :iMain)->>'visible')::boolean and (pg_temp.item(r, :iMain)->>'onHand')::numeric = 41
     from fx where who = 'stf'),
  true,
  'V2: ... while their own warehouse''s item carries its numbers');
select is(
  (select jsonb_build_array(pg_temp.item(r, :iCharter), pg_temp.item(r, :iMain)->'visible') from fx where who = 'stfCh'),
  jsonb_build_array(jsonb_build_object('itemId', :iCharter::text, 'visible', false), true),
  'V3: a member scoped to charter Y gets charter X''s item hidden (and a no-charter item visible)');
select is(
  (select jsonb_build_array(pg_temp.item(r, :iCat), pg_temp.item(r, :iCatOk)->'visible') from fx where who = 'vwrCat'),
  jsonb_build_array(jsonb_build_object('itemId', :iCat::text, 'visible', false), true),
  'V4: a viewer restricted to category 1 gets category 2''s item hidden (and category 1''s visible)');
select is(
  (select jsonb_build_object('sources', pg_temp.item(r, :iMain)->'stagingSources',
                             'hidden', pg_temp.item(r, :iMain)->'stagingHiddenQty')
     from fx where who = 'mgr'),
  jsonb_build_object('sources', jsonb_build_array(
                       jsonb_build_object('locationId', :'stA'::text, 'quantity', 5),
                       jsonb_build_object('locationId', :'stOrg'::text, 'quantity', 1)),
                     'hidden', 0),
  'V5: a manager gets every Staging source here (warehouse A''s and the org-level one), largest first, none hidden');
select is(
  (select jsonb_build_object('sources', pg_temp.item(r, :iMain)->'stagingSources',
                             'hidden', pg_temp.item(r, :iMain)->'stagingHiddenQty',
                             'staging', pg_temp.item(r, :iMain)#>'{here,staging}')
     from fx where who = 'stfX'),
  jsonb_build_object('sources', jsonb_build_array(jsonb_build_object('locationId', :'stOrg'::text, 'quantity', 1)),
                     'hidden', 5, 'staging', 6),
  'V6: a member who reads the item but not warehouse A''s holdings gets only the org-level source; warehouse A''s 5 are stagingHiddenQty (the total still counts them)');
select is(
  (select pg_temp.item(r, :iPo)->'inbound' from fx where who = 'mgr'),
  jsonb_build_object(
    'rows', jsonb_build_array(
      jsonb_build_object('poId', :poOrg::text,  'poNumber', 'PO-0377-O',  'status', 'expected_inbound',
                         'expectedAt', '2026-10-01T16:00:00+00:00', 'remaining', 3),
      jsonb_build_object('poId', :poA::text,    'poNumber', 'PO-0377-A',  'status', 'ordered',
                         'expectedAt', '2026-10-03T16:00:00+00:00', 'remaining', 12),
      jsonb_build_object('poId', :poOver::text, 'poNumber', 'PO-0377-V',  'status', 'ordered',
                         'expectedAt', '2026-10-05T16:00:00+00:00', 'remaining', 7),
      jsonb_build_object('poId', :poA2::text,   'poNumber', 'PO-0377-A2', 'status', 'ordered',
                         'expectedAt', '2026-10-10T16:00:00+00:00', 'remaining', 5),
      jsonb_build_object('poId', :poNull::text, 'poNumber', 'PO-0377-N',  'status', 'partially_received',
                         'expectedAt', null, 'remaining', 6)),
    'hiddenRemaining', 0, 'truncated', false, 'truncatedRemaining', 0),
  'V7: a manager sees every open PO for the item, earliest expected first and no date last; cancelled and received POs are left out (F6)');
select is(
  (select jsonb_build_object(
            'poIds', (select jsonb_agg(x->'poId') from jsonb_array_elements(pg_temp.item(r, :iPo)#>'{inbound,rows}') x),
            'hidden', pg_temp.item(r, :iPo)#>'{inbound,hiddenRemaining}',
            'draftIds', (select jsonb_agg(x->'poId') from jsonb_array_elements(pg_temp.item(r, :iPo)#>'{drafts,rows}') x),
            'draftHidden', pg_temp.item(r, :iPo)#>'{drafts,hiddenRemaining}')
     from fx where who = 'stf'),
  jsonb_build_object('poIds', jsonb_build_array(:poOrg::text, :poA::text, :poOver::text, :poNull::text),
                     'hidden', 5,
                     'draftIds', jsonb_build_array(:poDraft::text),
                     'draftHidden', 2),
  'V8: staff in warehouse A see only the POs they could open (A''s, the org-level and the no-destination ones); the annex PO and the annex draft are quantities only');
select is(
  (select jsonb_build_object('rows', pg_temp.item(r, :iPo)#>'{inbound,rows}',
                             'hidden', pg_temp.item(r, :iPo)#>'{inbound,hiddenRemaining}',
                             'draftRows', pg_temp.item(r, :iPo)#>'{drafts,rows}',
                             'draftHidden', pg_temp.item(r, :iPo)#>'{drafts,hiddenRemaining}')
     from fx where who = 'vwrNp'),
  jsonb_build_object('rows', '[]'::jsonb, 'hidden', 33, 'draftRows', '[]'::jsonb, 'draftHidden', 6),
  'V9: a viewer without purchase_orders:read sees no PO at all, only how many units are on them');
select is(
  (select jsonb_build_object('n', jsonb_array_length(pg_temp.item(r, :iTrunc)#>'{inbound,rows}'),
                             'last', pg_temp.item(r, :iTrunc)#>'{inbound,rows,9,poNumber}',
                             'truncated', pg_temp.item(r, :iTrunc)#>'{inbound,truncated}',
                             'truncatedRemaining', pg_temp.item(r, :iTrunc)#>'{inbound,truncatedRemaining}',
                             'hidden', pg_temp.item(r, :iTrunc)#>'{inbound,hiddenRemaining}')
     from fx where who = 'mgr'),
  jsonb_build_object('n', 10, 'last', 'PO-0377-T10', 'truncated', true, 'truncatedRemaining', 5, 'hidden', 0),
  'V10: more than 10 visible POs: the 10 earliest are listed and the rest is disclosed (truncated, truncatedRemaining), never dropped');
select is(
  (select jsonb_build_array(pg_temp.item(r, :iPo)->'inbound', pg_temp.item(r, :iPo)->'drafts') from fx where who = 'mgrNoPo'),
  '[null, null]'::jsonb,
  'V11: the purchase_orders module off: inbound and drafts are null (unknown, never "nothing on order")');
-- Mutation: drop the approver gate -> staff get the other pending orders.
select is(
  (select jsonb_build_object('stf', pg_temp.item(s.r, :iPend)->'pendingOthers',
                             'mgr', pg_temp.item(m.r, :iPend)->'pendingOthers',
                             'stfAp', pg_temp.item(a.r, :iPend)->'pendingOthers')
     from fx s, fx m, fx a where s.who = 'stf' and m.who = 'mgr' and a.who = 'stfAp'),
  jsonb_build_object('stf', null, 'mgr', jsonb_build_object('orders', 2, 'units', 8),
                     'stfAp', jsonb_build_object('orders', 2, 'units', 8)),
  'V12: other pending demand (2 orders, 8 units; the cancelled one and this order left out) goes to a manager and to staff with an orders:approve override, never to other staff (null)');

-- Mutation: drop `and i.organization_id = v_org` from the items the answer
-- reads -> a member of both orgs gets org B's item, with its numbers, on an
-- org A order.
select is(
  (select r->'items' from fx where who = 'mgrABforeign'),
  jsonb_build_array(jsonb_build_object('itemId', :iB::text, 'visible', false)),
  'V16: a line whose item belongs to another org is {itemId, visible:false}, even for a member of both orgs who may read that item');
select is(
  (select (pg_temp.item(r, :iB)->>'visible')::boolean from fx where who = 'mgrABownB'),
  true,
  'V17 (control): the same member reads that item''s numbers on its own org''s order, so V16 is the org filter, not a lack of access');

-- purchase_order_visible vs purchase_orders_select, every persona x PO.
do $$
declare
  v_who text; v_uid uuid;
begin
  for v_who, v_uid in
    select * from (values
      ('own',   '03770000-0000-0000-0000-0000000000a0'::uuid), ('adm',   '03770000-0000-0000-0000-0000000000a9'),
      ('mgr',   '03770000-0000-0000-0000-0000000000a1'), ('stf',   '03770000-0000-0000-0000-0000000000a2'),
      ('stf2',  '03770000-0000-0000-0000-0000000000a3'), ('stfN',  '03770000-0000-0000-0000-0000000000a4'),
      ('vwr',   '03770000-0000-0000-0000-0000000000a7'), ('vwrNp', '03770000-0000-0000-0000-0000000000a8'),
      ('stfCh', '03770000-0000-0000-0000-0000000000ab'), ('stfX',  '03770000-0000-0000-0000-0000000000ac'),
      ('dis',   '03770000-0000-0000-0000-0000000000ad'), ('mgrB',  '03770000-0000-0000-0000-0000000000b1'),
      ('nobody','03770000-0000-0000-0000-0000000000c1'), ('stfPm', '03770000-0000-0000-0000-0000000000a6')) v(w, u)
  loop
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    set local role to 'authenticated';
    insert into pv
    select v_who, p.id, public.purchase_order_visible(p.id),
           exists (select 1 from public.purchase_orders x where x.id = p.id)
      from pv_po p;
    reset role;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
select is(
  (select coalesce(string_agg(who || ':' || po, ', '), '') from pv
    where who <> 'stfPm' and fn is distinct from rls),
  '',
  'V13: purchase_order_visible says exactly which POs purchase_orders RLS shows, for the owner, an admin, a manager, staff in A, in the annex and in no warehouse, viewers with and without purchase_orders:read, charter-scoped staff, a wrong-org assignment, a disabled member, another org''s manager and a non-member');
select is(
  (select row(count(*) filter (where fn), count(*) filter (where not fn), count(distinct who))::text
     from pv where who <> 'stfPm'),
  row(59, 58, 13)::text,
  'V14 (control): the sweep is not vacuous: 13 personas x 9 POs, 117 answers, both true and false');
select is(
  (select string_agg(po::text || '=' || fn || '/' || rls, ',' order by po) from pv
    where who = 'stfPm' and po in (:poA, :poA2)),
  :poA::text || '=false/true,' || :poA2::text || '=true/true',
  'V15 (known gap, pinned in the safe direction): annex staff with a purchase_orders:manage override read warehouse A''s PO through the FOR ALL write policy; readiness still treats it as a PO they cannot open (quantity only)');

-- ═══ F. Facts ════════════════════════════════════════════════════════════
select is(
  (select jsonb_build_object('onHand', x->'onHand', 'heldOwn', x->'heldOwn', 'heldOtherOrders', x->'heldOtherOrders',
                             'heldRentals', x->'heldRentals', 'here', x->'here', 'elsewhere', x->'elsewhere')
     from fx, lateral (select pg_temp.item(r, :iMain) x) i where who = 'mgr'),
  jsonb_build_object('onHand', 41, 'heldOwn', 4, 'heldOtherOrders', 3, 'heldRentals', 2,
                     'here', jsonb_build_object('rack', 12, 'site', 5, 'unplaced', 4, 'staging', 6),
                     'elsewhere', jsonb_build_object('pickable', 7, 'staging', 7)),
  'F1: holds split three ways (own 4, other orders 3, the rental 2; the released 100 ignored); here: rack+crate 12, NULL-kind Sites 5 (warehouse and org level), Unplaced 4 apart from Staging 6 (warehouse and org level); elsewhere: the annex rack and NULL-kind Site 7, its Staging 7');
select is(
  (select (x->>'heldRentals')::numeric from fx, lateral (select pg_temp.item(r, :iMain) x) i where who = 'mgr'),
  2::numeric,
  'F2: a rental''s hold (no order) is heldRentals (mutation: `<>` for IS DISTINCT FROM reads 0)');
select is(
  (select (x#>>'{here,site}')::numeric + (x#>>'{elsewhere,pickable}')::numeric
     from fx, lateral (select pg_temp.item(r, :iMain) x) i where who = 'mgr'),
  12::numeric,
  'F3: NULL-kind Sites count, here (5) and elsewhere (1 of 7) (mutation: kind <> ''staging'' drops them)');
select is(
  (select (x#>>'{here,rack}')::numeric + (x#>>'{here,site}')::numeric + (x#>>'{here,unplaced}')::numeric
          + (x#>>'{here,staging}')::numeric + (x#>>'{elsewhere,pickable}')::numeric + (x#>>'{elsewhere,staging}')::numeric
          = (x->>'onHand')::numeric
     from fx, lateral (select pg_temp.item(r, :iMain) x) i where who = 'mgr'),
  true,
  'F4: every holding lands in exactly one bucket: here plus elsewhere equals on hand (so on record and locations agree)');
select is(
  (select jsonb_build_object('drafts', pg_temp.item(r, :iPo)->'drafts') from fx where who = 'mgr'),
  jsonb_build_object('drafts', jsonb_build_object(
    'rows', jsonb_build_array(
      jsonb_build_object('poId', :poDraft::text,   'poNumber', 'PO-0377-D',  'remaining', 4),
      jsonb_build_object('poId', :poDraftA2::text, 'poNumber', 'PO-0377-D2', 'remaining', 2)),
    'hiddenRemaining', 0, 'truncated', false, 'truncatedRemaining', 0)),
  'F5: draft POs are listed apart from open ones (never supply)');
select is(
  (select (select sum((x->>'remaining')::numeric) from jsonb_array_elements(pg_temp.item(r, :iPo)#>'{inbound,rows}') x)
     from fx where who = 'mgr'),
  33::numeric,
  'F6: an over-received line floors at 0 per line: PO-0377-V still brings its other line''s 7 (mutation: no floor, the PO nets to -503 and its 7 vanish)');
select is(
  (select (pg_temp.item(r, :iCmt)->>'committedOtherShortfall')::numeric from fx where who = 'mgr'),
  13::numeric,
  'F7: committedOtherShortfall per status class: approved owed 10 less its hold 6 (4) + backordered owed 5 (5) + picking_complete owed 6 less 2 picked (4) + in_transit and pick_slip_generated fully covered (0); pending, pending_confirmation and completed left out');
select is(
  (select pg_temp.item(r, :iCmt)->'pendingOthers' from fx where who = 'mgr'),
  jsonb_build_object('orders', 1, 'units', 100),
  'F8: a pending order is counted in pendingOthers, never netted into committedOtherShortfall');
select is(
  (select jsonb_agg(x->>'lineId' order by n) from fx, jsonb_array_elements(r->'lines') with ordinality t(x, n)
    where who = 'mgr'),
  jsonb_build_array(:lMain::text, :lAnnex::text, :lCharter::text, :lCatOk::text, :lCat::text, :lPo::text,
                    :lPend::text, :lTieB::text, :lTieA::text, :lCmt::text, :lTrunc::text),
  'F9: lines come in (created_at, id) order: two lines of one moment by id');
select is(
  (select x from fx, jsonb_array_elements(r->'lines') x where who = 'mgr' and x->>'lineId' = :lMain::text),
  jsonb_build_object('lineId', :lMain::text, 'itemId', :iMain::text, 'requested', 4, 'fulfilled', 0,
                     'picked', null, 'createdAt', '2026-09-01T10:00:00+00:00'),
  'F10: a line carries its id, item, requested, fulfilled, picked and created_at');
select is(
  (select r - 'observedAt' - 'lines' - 'items' || jsonb_build_object('lineCount', jsonb_array_length(r->'lines'),
                                                                     'itemCount', jsonb_array_length(r->'items'))
     from fx where who = 'mgr'),
  jsonb_build_object('v', 1, 'phase', 'to_pick', 'linesCapped', false,
                     'order', jsonb_build_object('id', :ordMain::text, 'status', 'approved', 'warehouseId', :whA::text,
                                                 'neededBy', null, 'fulfillmentType', 'pickup',
                                                 'timeZone', 'America/Chicago',
                                                 'orderNumber', (select order_number from public.order_requests where id = :ordMain)),
                     'lineCount', 11, 'itemCount', 9),
  'F11: the answer''s head: version 1, the to_pick phase, the order''s id, number, status, warehouse, needed-by, fulfilment and its org''s time zone, one item per distinct item');
select is(
  (select (r->>'observedAt')::timestamptz = now() from fx where who = 'mgr'),
  true,
  'F12: observedAt is the moment the facts were read');
select is(
  (select jsonb_build_array(p.r->'phase', jsonb_array_length(p.r->'lines'), p.r->'items',
                            c.r->'phase', jsonb_array_length(c.r->'lines'), c.r->'items')
     from fx p, fx c where p.who = 'mgrPicked' and c.who = 'mgrClosed'),
  jsonb_build_array('picked', 1, '[]'::jsonb, 'closed', 1, '[]'::jsonb),
  'F13: a picked order (staged_for_pickup) and a closed one (completed) get their lines and no stock read');
select is(
  (select x->'committedOtherShortfall' from fx, lateral (select pg_temp.item(r, :iMain) x) i where who = 'mgr'),
  '0'::jsonb,
  'F14: an approved order holding all it owes, and a picked order that picked all it owes, add no committed shortfall');
select is(
  (select jsonb_build_object(
            'rows', (select count(*) from jsonb_array_elements(pg_temp.item(r, :iPo)#>'{inbound,rows}') x
                      where x->>'poId' = :poDone::text),
            'zeroRows', (select count(*) from jsonb_array_elements(pg_temp.item(r, :iPo)#>'{inbound,rows}') x
                          where (x->>'remaining')::numeric = 0))
     from fx where who = 'mgr'),
  jsonb_build_object('rows', 0, 'zeroRows', 0),
  'F15: an open PO whose line for the item is fully received brings no row: nothing remaining is never "on order" (mutation: drop `having ... > 0`, and it takes a row as "0 expected")');

-- ═══ P. Parity with the frozen RPCs (the shared fixture) ═════════════════
set local role to 'authenticated';
set local "request.jwt.claim.sub" to :pMgr;
insert into rp_facts select c.case_no, public.order_readiness_facts(c.order_id) from rp_case c;
insert into rp_run select e.case_no, 'approve', pg_temp.rp_call('approve', e.case_no) from rp_expect e where e.approve is not null;
insert into rp_run select e.case_no, 'approve_partial', pg_temp.rp_call('approve_partial', e.case_no) from rp_expect e where e.approve_partial is not null;
insert into rp_run select e.case_no, 'resume', pg_temp.rp_call('resume', e.case_no) from rp_expect e where e.resume is not null;
insert into rp_run select e.case_no, 'complete', pg_temp.rp_call('complete', e.case_no) from rp_expect e where e.complete is not null;
reset role;
set local "request.jwt.claim.sub" to '';

select is(
  (select coalesce(string_agg(c.case_id || ':' || e.item_key, ', ' order by c.case_no, e.item_key), '')
     from rp_expect_item e
     join rp_case c using (case_no)
     join rp_facts f using (case_no)
    where pg_temp.rp_subset(pg_temp.item(f.facts, e.item_id)) is distinct from e.facts),
  '',
  'P1: for every fixture item, order_readiness_facts returns exactly the facts core is fed (on hand, the three holds, here and elsewhere by kind, Staging sources, committed and pending demand, POs, kit, deleted, warehouse)');
select is(
  (select coalesce(string_agg(c.case_id, ', ' order by c.case_no), '')
     from rp_expect e join rp_case c using (case_no) join rp_facts f using (case_no)
    where f.facts->>'phase' is distinct from e.phase
       or (select jsonb_agg(x - 'createdAt' order by n) from jsonb_array_elements(f.facts->'lines') with ordinality t(x, n))
          is distinct from e.lines
       or jsonb_array_length(f.facts->'items') <> (select count(*) from rp_item i where i.case_no = c.case_no)),
  '',
  'P2: for every case, the phase and the lines (in fixture order) are the fixture''s');
select is(
  (select coalesce(string_agg(c.case_id || '=' || r.result::text, ', ' order by c.case_no), '')
     from rp_run r join rp_expect e using (case_no) join rp_case c using (case_no)
    where r.rpc = 'approve' and r.result is distinct from e.approve),
  '',
  'P3: approve_order_request succeeds exactly where every item has D <= A and refuses the rest with the fixture''s reason (C1a, C1b rental hold, C2 duplicates, C10, C11 moved, C12, C13)');
select is(
  (select coalesce(string_agg(c.case_id || '=' || r.result::text, ', ' order by c.case_no), '')
     from rp_run r join rp_expect e using (case_no) join rp_case c using (case_no)
    where r.rpc = 'approve_partial' and r.result is distinct from e.approve_partial),
  '',
  'P4: approve_partial holds exactly min(requested, free) per item (C2: exactly 5 for 3 + 3 against 5)');
select is(
  (select coalesce(string_agg(c.case_id || '=' || r.result::text, ', ' order by c.case_no), '')
     from rp_run r join rp_expect e using (case_no) join rp_case c using (case_no)
    where r.rpc = 'resume' and r.result is distinct from e.resume),
  '',
  'P5: resume_fulfillment holds exactly min(owed, free) (C4: 3 of 4 owed), and refuses with nothing free (C4b)');
select is(
  (select coalesce(string_agg(c.case_id || '=' || r.result::text, ', ' order by c.case_no), '')
     from rp_run r join rp_expect e using (case_no) join rp_case c using (case_no)
    where r.rpc = 'complete' and r.result is distinct from e.complete),
  '',
  'P6: complete_picking picks exactly the projection (C5 one-click, C9 explicit), fails exactly where it projects a failure (C6 Staging; C6c on record more than the locations hold, nothing in Staging), and succeeds from another warehouse (C7) and past other holds (C8)');
select is(
  (select row(count(*) filter (where rpc = 'approve' and result ? 'ok'),
              count(*) filter (where rpc = 'approve' and result ? 'error'),
              count(*) filter (where rpc = 'approve_partial' and result ? 'error'),
              count(*) filter (where rpc = 'resume' and result ? 'holds'),
              count(*) filter (where rpc = 'resume' and result ? 'error'),
              count(*) filter (where rpc = 'complete' and result ? 'picked'),
              count(*) filter (where rpc = 'complete' and result ? 'error'))::text
     from rp_run),
  row(3, 4, 1, 1, 1, 5, 2)::text,
  'P7 (control): every outcome was exercised: approvals that pass and fail, partial approvals, resumes that hold and refuse, picks that complete and fail');
select is(
  (select count(*)::int from public.stock_reservations r join rp_case c on c.order_id = r.order_request_id)
  + (select count(*)::int from public.order_request_lines ol join rp_line l on l.line_id = ol.id where ol.quantity_picked is distinct from l.picked)
  + (select count(*)::int from public.order_requests o join rp_case c on c.order_id = o.id where o.status <> c.status),
  (select count(*)::int from rp_hold where holder = 'own'),
  'P8 (control): every RPC call was rolled back: statuses, picks and holds are the fixture''s');

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
      ('public', 'caller_can_read_item'), ('public', 'location_holdings_visible'))),
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
  -- Re-pinned by 0392 (was 1b109d535811e9a21c43d01dcc344892, 0365's body): the
  -- insert guard also refuses an admin-client (service_role) insert carrying
  -- a return token, a track token or a signature image (0392 suite G23);
  -- unchanged for the API roles.
  'tg_order_requests_insert_guard()|caf69f8a23d03b9bfa6ea87a9cf94077|false|{search_path=public}|postgres',
  'Z1: the frozen functions (fulfilment, PO, ledger, guards, read helpers) are the text, SECURITY DEFINER, search_path and owner F2 was proven against. If this fails, re-prove parity (P) before updating the pins');

select * from finish();
rollback;
