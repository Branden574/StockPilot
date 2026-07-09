-- supabase/tests/0244_backorder_fulfillment_accounting.test.sql
-- Proves migration 0244's Model-A accounting:
--
--   A. complete_picking STAGES the batch (writes quantity_picked, hardens stock)
--      and does NOT write quantity_fulfilled.
--   B. confirm_order_signature SHIPS the staged batch (quantity_fulfilled +=
--      quantity_picked, quantity_picked → null) and forks to `backordered` when
--      units are still owed.
--   C. …and forks to `completed` (with completed_at) when owed reaches 0.
--   D. complete_picking's one-click path clamps to the still-owed qty, so a
--      partially-fulfilled (resumed) order never over-hardens.
--
-- Status is advanced through LEGAL transitions as the authenticated manager
-- (the same path generatePickSlip uses), so the transition trigger stays armed.
-- Wrapped in begin/rollback — nothing leaks. Namespace b0244000.

begin;

select plan(13);

\set org  '\'b0244000-0000-0000-0000-000000000001\''
\set usr  '\'b0244000-0000-0000-0000-000000000002\''
\set wh   '\'b0244000-0000-0000-0000-000000000003\''
\set rack '\'b0244000-0000-0000-0000-000000000004\''

\set item_a '\'b0244000-0000-0000-0000-0000000000a0\''
\set ord_a  '\'b0244000-0000-0000-0000-0000000000a1\''
\set line_a '\'b0244000-0000-0000-0000-0000000000a2\''
\set item_c '\'b0244000-0000-0000-0000-0000000000c0\''
\set ord_c  '\'b0244000-0000-0000-0000-0000000000c1\''
\set line_c '\'b0244000-0000-0000-0000-0000000000c2\''
\set item_d '\'b0244000-0000-0000-0000-0000000000d0\''
\set ord_d  '\'b0244000-0000-0000-0000-0000000000d1\''
\set line_d '\'b0244000-0000-0000-0000-0000000000d2\''

-- ── Fixtures (as owner, before the role switch) ──────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values (:usr, 'bo-0244-mgr@test.local', '{}'::jsonb) on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Backorder Accounting Org 0244', 'backorder-acct-0244') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values (:org, :usr, 'manager', now()) on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'BO Acct WH', 'WH-BOA-0244', 'active') on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'BOA-R1', 'shelf', 'rack') on conflict (id) do nothing;

-- Each item: on_hand fully placed in the rack (complete_picking draws PLACED).
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_a, :org, :wh, 'BOA-A', 'Item A', 100, 'active', 'none'),
    (:item_c, :org, :wh, 'BOA-C', 'Item C',  40, 'active', 'none'),
    (:item_d, :org, :wh, 'BOA-D', 'Item D', 100, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels
  where item_id in (:item_a, :item_c, :item_d);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values
    (:org, :item_a, :rack, 100),
    (:org, :item_c, :rack,  40),
    (:org, :item_d, :rack, 100);

-- Orders in pick_slip_generated (INSERT bypasses the UPDATE-only trigger).
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type)
  values
    (:ord_a, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup'),
    (:ord_c, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup'),
    (:ord_d, :org, :wh, 'pick_slip_generated', :usr, 'internal', 'pickup')
  on conflict (id) do nothing;

-- A: req 100, 50 staged (explicit partial). C: req 40, 40 staged (full).
-- D: req 100, 50 already SHIPPED (prior batch), NULL picked (one-click resume).
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_a, :ord_a, :item_a, 100, 0, 50),
    (:line_c, :ord_c, :item_c,  40, 0, 40),
    (:line_d, :ord_d, :item_d, 100, 50, null)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────────
set local "request.jwt.claim.sub" to 'b0244000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO A — complete_picking STAGES, never writes quantity_fulfilled
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.complete_picking('b0244000-0000-0000-0000-0000000000a1'::uuid); end $$;

select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_a),
  0::numeric(14,4),
  'A: complete_picking leaves quantity_fulfilled at 0 (fulfilled = shipped only)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_a),
  50::numeric(14,4),
  'A: complete_picking records the staged batch in quantity_picked (50)');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  50::numeric(14,4),
  'A: complete_picking hardened stock by the staged batch (100 -> 50)');
select is(
  (select status from public.order_requests where id = :ord_a),
  'picking_complete',
  'A: order status = picking_complete');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO B — confirm_order_signature SHIPS + forks to backordered (owed 50)
-- Advance A through legal transitions to staged_for_pickup, then hand over.
-- ════════════════════════════════════════════════════════════════════════════
update public.order_requests set status = 'packing_slip_generated' where id = :ord_a;
update public.order_requests
  set status = 'staged_for_pickup',
      signature_token = 'tok-a-0244',
      signature_token_expires_at = now() + interval '1 day'
  where id = :ord_a;

do $$
begin
  perform public.confirm_order_signature('b0244000-0000-0000-0000-0000000000a1'::uuid,
    'tok-a-0244', 'Jane Signer', 'jane@example.com', 'data:image/png;base64,AAAA');
end $$;

select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_a),
  50::numeric(14,4),
  'B: hand-over shipped the staged batch into quantity_fulfilled (0 -> 50)');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_a),
  null,
  'B: hand-over cleared quantity_picked (staged batch shipped)');
select is(
  (select status from public.order_requests where id = :ord_a),
  'backordered',
  'B: owed 50 > 0 forks the order to backordered');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO C — fully picked → hand-over forks to completed (owed 0)
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.complete_picking('b0244000-0000-0000-0000-0000000000c1'::uuid); end $$;
update public.order_requests set status = 'packing_slip_generated' where id = :ord_c;
update public.order_requests
  set status = 'staged_for_pickup',
      signature_token = 'tok-c-0244',
      signature_token_expires_at = now() + interval '1 day'
  where id = :ord_c;
do $$
begin
  perform public.confirm_order_signature('b0244000-0000-0000-0000-0000000000c1'::uuid,
    'tok-c-0244', 'Carl Signer', 'carl@example.com', 'data:image/png;base64,BBBB');
end $$;

select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_c),
  40::numeric(14,4),
  'C: hand-over shipped the full batch (quantity_fulfilled = 40)');
select is(
  (select status from public.order_requests where id = :ord_c),
  'completed',
  'C: owed 0 forks the order to completed');
select isnt(
  (select completed_at from public.order_requests where id = :ord_c),
  null,
  'C: completed hand-over stamps completed_at');

-- ════════════════════════════════════════════════════════════════════════════
-- SCENARIO D — one-click complete_picking clamps to still-owed (resume batch)
-- Line already shipped 50 of 100; one-click must stage only the remaining 50.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.complete_picking('b0244000-0000-0000-0000-0000000000d1'::uuid); end $$;

select is(
  (select quantity_picked from public.order_request_lines where id = :line_d),
  50::numeric(14,4),
  'D: one-click staged only the owed 50, not the full requested 100');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_d),
  50::numeric(14,4),
  'D: complete_picking hardened only the owed 50 (100 -> 50), no over-draw');
select is(
  (select quantity_fulfilled from public.order_request_lines where id = :line_d),
  50::numeric(14,4),
  'D: prior shipped quantity_fulfilled (50) is left untouched by the new batch');

select * from finish();
rollback;
