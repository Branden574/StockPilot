-- supabase/tests/0306_pick_movement_order_number.test.sql
-- Proves migration 0306: complete_picking names the ORDER, not the row's uuid.
--
--   N1. The pick movement's reason reads 'Order pick (SO-000060)' — the human
--       order number, zero-padded to six exactly like formatOrderNumber().
--   N2. …and no pick movement anywhere still stringifies an order_request uuid.
--   N3. A one-digit order number is padded the same way (SO-000007).
--   N4. reference_type='order_request' + reference_id=<order id>: the machine
--       link lives in the columns built for it, not inside prose.
--   N5. The stamp is SCOPED — a movement that already existed for the same item
--       in the same org is left untouched (the predicate cannot over-reach).
--   N6. A non-positive/absent order number falls back to the pre-0306 text
--       rather than writing a broken 'Order pick (SO-)'.
--   C1. REGRESSION (0247): one-click on a SHORT order stages what's available
--       and does not crash.
--   C2. REGRESSION (0247): …clamped to on_hand net of OTHER orders' holds.
--   L1. REGRESSION (0237/0238): a staffer who is not the assigned picker is
--       still refused (not_assigned_picker).
--   L2. REGRESSION (0237/0238): the assigned picker can still complete.
--   B1. REGRESSION (0244): quantity_fulfilled is NOT written at pick time —
--       complete_picking only stages quantity_picked.
--
-- Wrapped in begin/rollback. Namespace c0306000.

begin;

select plan(14);

\set org  '\'c0306000-0000-0000-0000-000000000001\''
\set mgr  '\'c0306000-0000-0000-0000-000000000002\''
\set stf  '\'c0306000-0000-0000-0000-000000000003\''
\set wh   '\'c0306000-0000-0000-0000-000000000004\''
\set rack '\'c0306000-0000-0000-0000-000000000005\''

-- N1/N2/N4/N5/B1: the headline order, forced to number 60 so the assertion is
-- the owner's real string, SO-000060.
\set item_n '\'c0306000-0000-0000-0000-0000000000a0\''
\set ord_n  '\'c0306000-0000-0000-0000-0000000000a1\''
\set line_n '\'c0306000-0000-0000-0000-0000000000a2\''
\set mv_pre '\'c0306000-0000-0000-0000-0000000000a3\''
-- N3: single-digit padding.
\set item_p '\'c0306000-0000-0000-0000-0000000000c0\''
\set ord_p  '\'c0306000-0000-0000-0000-0000000000c1\''
\set line_p '\'c0306000-0000-0000-0000-0000000000c2\''
-- N6: no usable number -> legacy text.
\set item_f '\'c0306000-0000-0000-0000-0000000000e0\''
\set ord_f  '\'c0306000-0000-0000-0000-0000000000e1\''
\set line_f '\'c0306000-0000-0000-0000-0000000000e2\''
-- C1/C2: the 0247 clamp regressions.
\set item_c1 '\'c0306000-0000-0000-0000-0000000000b0\''
\set ord_c1  '\'c0306000-0000-0000-0000-0000000000b1\''
\set line_c1 '\'c0306000-0000-0000-0000-0000000000b2\''
\set item_c2 '\'c0306000-0000-0000-0000-0000000000d0\''
\set ord_c2  '\'c0306000-0000-0000-0000-0000000000d1\''
\set line_c2 '\'c0306000-0000-0000-0000-0000000000d2\''
\set ord_oth '\'c0306000-0000-0000-0000-0000000000df\''
-- L1/L2: the 0237/0238 claim lock.
\set item_l '\'c0306000-0000-0000-0000-0000000000f0\''
\set ord_l  '\'c0306000-0000-0000-0000-0000000000f1\''
\set line_l '\'c0306000-0000-0000-0000-0000000000f2\''

insert into auth.users (id, email, raw_user_meta_data) values
  (:mgr, 'mgr-0306@test.local', '{}'::jsonb),
  (:stf, 'stf-0306@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Pick Note Org 0306', 'pick-note-0306') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at) values
  (:org, :mgr, 'manager', now()),
  (:org, :stf, 'staff',   now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'PN WH', 'WH-PN-0306', 'active') on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'PN-R1', 'shelf', 'rack') on conflict (id) do nothing;
insert into public.user_warehouse_assignments (organization_id, user_id, warehouse_id)
  values (:org, :stf, :wh) on conflict do nothing;

insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_n,  :org, :wh, 'PN-N',  'N',  40, 'active', 'none'),
    (:item_p,  :org, :wh, 'PN-P',  'P',  40, 'active', 'none'),
    (:item_f,  :org, :wh, 'PN-F',  'F',  40, 'active', 'none'),
    (:item_c1, :org, :wh, 'PN-C1', 'C1', 30, 'active', 'none'),
    (:item_c2, :org, :wh, 'PN-C2', 'C2', 50, 'active', 'none'),
    (:item_l,  :org, :wh, 'PN-L',  'L',  40, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels
  where item_id in (:item_n, :item_p, :item_f, :item_c1, :item_c2, :item_l);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity) values
  (:org, :item_n, :rack, 40), (:org, :item_p, :rack, 40), (:org, :item_f, :rack, 40),
  (:org, :item_c1, :rack, 30), (:org, :item_c2, :rack, 50), (:org, :item_l, :rack, 40);

-- order_number is assigned by the 0254 BEFORE INSERT trigger, but explicit
-- values pass through ("imports/restores") — so the numbers under test are
-- pinned here rather than left to the per-org sequence.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type, order_number)
  values
    (:ord_n,   :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', 60),
    (:ord_p,   :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', 7),
    (:ord_f,   :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', 0),
    (:ord_c1,  :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', 101),
    (:ord_c2,  :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', 102),
    (:ord_oth, :org, :wh, 'approved',            :mgr, 'internal', 'pickup', 103),
    (:ord_l,   :org, :wh, 'pick_slip_generated', :mgr, 'internal', 'pickup', 104)
  on conflict (id) do nothing;

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_n,  :ord_n,  :item_n,   10, 0, null),
    (:line_p,  :ord_p,  :item_p,   10, 0, null),
    (:line_f,  :ord_f,  :item_f,   10, 0, null),
    (:line_c1, :ord_c1, :item_c1, 100, 0, null),
    (:line_c2, :ord_c2, :item_c2, 100, 0, null),
    (:line_l,  :ord_l,  :item_l,   10, 0, null)
  on conflict (id) do nothing;

-- C2: a competing order holds 20 of item_c2, so only 30 of the 50 is available.
insert into public.stock_reservations
  (organization_id, item_id, warehouse_id, order_request_id, quantity)
  values (:org, :item_c2, :wh, :ord_oth, 20);

-- N5: a movement that ALREADY exists for the pick's own item. The stamp must
-- not reach backwards and claim it. Same org, same item, same movement_type,
-- same user — everything but "this transaction wrote it".
insert into public.stock_movements
  (id, organization_id, item_id, movement_type, quantity_change,
   previous_quantity, new_quantity, reason, user_id, created_at)
  values (:mv_pre, :org, :item_n, 'transfer', 0, 40, 40,
          'Pre-existing transfer', :mgr, now() - interval '1 day');

-- L1: lock the L order to the manager so the staffer is a non-assigned picker.
update public.order_requests set assigned_picker_id = :mgr where id = :ord_l;

set local "request.jwt.claim.sub" to 'c0306000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- N — the note a human reads
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.complete_picking('c0306000-0000-0000-0000-0000000000a1'::uuid); end $$;

select is(
  (select reason from public.stock_movements
    where item_id = :item_n and id <> :mv_pre),
  'Order pick (SO-000060)',
  'N1: the pick movement names the order (SO-000060), zero-padded to six');

select is(
  (select count(*)::int from public.stock_movements
    where organization_id = :org and reason like '%order_request %'),
  0,
  'N2: no pick movement stringifies an order_request uuid any more');

do $$ begin perform public.complete_picking('c0306000-0000-0000-0000-0000000000c1'::uuid); end $$;
select is(
  (select reason from public.stock_movements where item_id = :item_p),
  'Order pick (SO-000007)',
  'N3: a one-digit order number is zero-padded to six as well');

select results_eq(
  $$ select reference_type, reference_id from public.stock_movements
      where item_id = 'c0306000-0000-0000-0000-0000000000a0'
        and id <> 'c0306000-0000-0000-0000-0000000000a3' $$,
  $$ values ('order_request', 'c0306000-0000-0000-0000-0000000000a1'::uuid) $$,
  'N4: the machine link is in reference_type/reference_id, not in the prose');

select is(
  (select reference_type from public.stock_movements where id = :mv_pre),
  null,
  'N5: the stamp does not reach backwards onto a pre-existing movement');

-- N6 — no usable order number: keep the old, still-traceable text.
do $$ begin perform public.complete_picking('c0306000-0000-0000-0000-0000000000e1'::uuid); end $$;
select is(
  (select reason from public.stock_movements where item_id = :item_f),
  'Order pick (order_request c0306000-0000-0000-0000-0000000000e1)',
  'N6: a non-positive order number falls back to the pre-0306 text, not "SO-"');
select is(
  (select reference_type from public.stock_movements where item_id = :item_f),
  'order_request',
  'N6: …and the reference columns are stamped regardless of the label');

-- ════════════════════════════════════════════════════════════════════════════
-- C — 0247 backorder clamp, unchanged
-- ════════════════════════════════════════════════════════════════════════════
select lives_ok(
  $$ select public.complete_picking('c0306000-0000-0000-0000-0000000000b1'::uuid) $$,
  'C1: one-click complete_picking on a short order still does not raise');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_c1),
  30::numeric(14,4),
  'C1: still stages the available 30 (owed 100 clamped to on_hand 30)');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_c1),
  0::numeric(14,4),
  'C1: still hardens exactly the available 30 (30 -> 0)');

do $$ begin perform public.complete_picking('c0306000-0000-0000-0000-0000000000d1'::uuid); end $$;
select is(
  (select quantity_picked from public.order_request_lines where id = :line_c2),
  30::numeric(14,4),
  'C2: still clamps to on_hand 50 minus the other order''s 20-unit hold');

-- B1 — 0244: fulfillment is written at hand-over, never at pick time.
select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_c1),
  0::numeric(14,4),
  'B1: quantity_fulfilled is still NOT written by complete_picking (0244)');

-- ════════════════════════════════════════════════════════════════════════════
-- L — 0237/0238 claim lock, unchanged
-- ════════════════════════════════════════════════════════════════════════════
set local "request.jwt.claim.sub" to 'c0306000-0000-0000-0000-000000000003';
select throws_ok(
  $$ select public.complete_picking('c0306000-0000-0000-0000-0000000000f1'::uuid) $$,
  '42501', null,
  'L1: a staffer who is not the assigned picker is still refused');

set local "request.jwt.claim.sub" to 'c0306000-0000-0000-0000-000000000002';
select lives_ok(
  $$ select public.complete_picking('c0306000-0000-0000-0000-0000000000f1'::uuid) $$,
  'L2: the assigned picker can still complete the pick');

reset role;
select * from finish();
rollback;
