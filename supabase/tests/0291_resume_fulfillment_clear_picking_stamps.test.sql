-- supabase/tests/0291_resume_fulfillment_clear_picking_stamps.test.sql
-- Proves migration 0291: resume_fulfillment clears picking_completed_at /
-- picking_completed_by, in addition to everything it already cleared.
--
--   R1. Drive an order to backordered carrying a STALE picking_completed_at /
--       picking_completed_by from a prior (superseded) pick cycle, plus a
--       stale signature cycle and picker claim. Call resume_fulfillment and
--       assert:
--         - status rewinds to pick_slip_generated (unchanged 0247 behaviour).
--         - picking_completed_at / picking_completed_by are now NULL (the
--           0291 fix — previously these survived untouched).
--         - quantity_picked is cleared for the fresh pick cycle (unchanged).
--         - a reservation for min(owed, available) is created (unchanged).
--         - the signature cycle and assigned_picker_id are cleared, and
--           pick_slip_generated_at/_by are stamped fresh (unchanged 0247).
--   R2. resume_fulfillment still refuses a non-backordered order (guard
--       untouched by this migration — quick regression check).
--
-- Wrapped in begin/rollback — nothing leaks. Namespace f0291000.

begin;

select plan(16);

\set org    '\'f0291000-0000-0000-0000-000000000001\''
\set mgr    '\'f0291000-0000-0000-0000-000000000002\''
\set picker '\'f0291000-0000-0000-0000-000000000003\''
\set wh     '\'f0291000-0000-0000-0000-000000000004\''

\set item_r1 '\'f0291000-0000-0000-0000-0000000000a0\''
\set ord_r1  '\'f0291000-0000-0000-0000-0000000000a1\''
\set line_r1 '\'f0291000-0000-0000-0000-0000000000a2\''
\set item_g1 '\'f0291000-0000-0000-0000-0000000000b0\''
\set ord_g1  '\'f0291000-0000-0000-0000-0000000000b1\''
\set line_g1 '\'f0291000-0000-0000-0000-0000000000b2\''

-- ── Fixtures (as owner, before the role switch) ──────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values
    (:mgr,    'resume-stamps-0291-mgr@test.local',    '{}'::jsonb),
    (:picker, 'resume-stamps-0291-picker@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Resume Stamps Org 0291', 'resume-stamps-0291') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values
    (:org, :mgr,    'manager', now()),
    (:org, :picker, 'staff',   now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Resume Stamps WH', 'WH-RS-0291', 'active') on conflict (id) do nothing;

-- R1 item: owed 50 (requested 100, already shipped 50), 30 fulfillable on
-- hand -> resume reserves min(50, 30) = 30.
-- G1 item: stock is irrelevant to the status guard.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_r1, :org, :wh, 'RS-R1', 'R1', 30, 'active', 'none'),
    (:item_g1, :org, :wh, 'RS-G1', 'G1', 10, 'active', 'none')
  on conflict (id) do nothing;

-- Orders (INSERT bypasses the UPDATE-only transition trigger).
--   R1: a backordered order carrying every stamp a completed pick cycle plus a
--       hand-over would have left behind — assigned_picker_id, a full
--       signature cycle, and (the bug) picking_completed_at/_by from that
--       superseded cycle. This is exactly the shape resume_fulfillment
--       produced before 0291: everything else cleared, these two untouched.
--   G1: wrong status (approved) — the guard must still reject it.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type,
   assigned_picker_id, picking_completed_at, picking_completed_by,
   signed_at, signature_token, signature_token_expires_at,
   signed_by_name, signed_by_email, signature_data_url)
  values
    (:ord_r1, :org, :wh, 'backordered', :mgr, 'internal', 'pickup',
     :picker, now() - interval '2 hours', :picker,
     now() - interval '1 hour', 'stale-token-r1', now() + interval '1 day',
     'Stale Signer', 'stale-signer@test.local', 'data:image/png;base64,stale'),
    (:ord_g1, :org, :wh, 'approved', :mgr, 'internal', 'pickup',
     null, null, null, null, null, null, null, null, null)
  on conflict (id) do nothing;

-- Line carries a stale quantity_picked from the superseded cycle too, to prove
-- resume_fulfillment's unconditional clear (not just "was already null").
insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_r1, :ord_r1, :item_r1, 100, 50, 6),
    (:line_g1, :ord_g1, :item_g1, 100,  0, null)
  on conflict (id) do nothing;

-- ── Become the manager ───────────────────────────────────────────────────────
set local "request.jwt.claim.sub" to 'f0291000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- R1 — resume_fulfillment clears the stale picking-completion stamps
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.resume_fulfillment('f0291000-0000-0000-0000-0000000000a1'::uuid); end $$;

-- The 0291 fix.
select is(
  (select picking_completed_at from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears the stale picking_completed_at from the superseded cycle');
select is(
  (select picking_completed_by from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears the stale picking_completed_by from the superseded cycle');

-- Everything 0247 already did, still holding.
select is(
  (select status from public.order_requests where id = :ord_r1),
  'pick_slip_generated',
  'R1: resume moves backordered -> pick_slip_generated');
select isnt(
  (select pick_slip_generated_at from public.order_requests where id = :ord_r1),
  null,
  'R1: resume stamps a fresh pick_slip_generated_at');
select is(
  (select pick_slip_generated_by from public.order_requests where id = :ord_r1),
  :mgr,
  'R1: pick_slip_generated_by is the manager who resumed');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_r1),
  null,
  'R1: quantity_picked cleared for the fresh pick cycle');
select is(
  (select coalesce(sum(quantity), 0) from public.stock_reservations
     where order_request_id = :ord_r1 and released_at is null),
  30::numeric(14,4),
  'R1: resume reserved min(owed 50, available 30) = 30');
select is(
  (select assigned_picker_id from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears assigned_picker_id (fresh, unassigned claim)');
select is(
  (select signed_at from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signed_at');
select is(
  (select signature_token from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signature_token');
select is(
  (select signature_token_expires_at from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signature_token_expires_at');
select is(
  (select signed_by_name from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signed_by_name');
select is(
  (select signed_by_email from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signed_by_email');
select is(
  (select signature_data_url from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears signature_data_url');
select is(
  (select completed_by from public.order_requests where id = :ord_r1),
  null,
  'R1: resume clears completed_by');

-- ════════════════════════════════════════════════════════════════════════════
-- G1 — the guard is untouched: still rejects a non-backordered order
-- ════════════════════════════════════════════════════════════════════════════
select throws_ok(
  $$ select public.resume_fulfillment('f0291000-0000-0000-0000-0000000000b1'::uuid) $$,
  'P0001', null,
  'G1: resume_fulfillment still rejects a non-backordered (approved) order');

select * from finish();
rollback;
