-- supabase/tests/0289_reopen_picking.test.sql
-- Proves migration 0289's manager reopen-picking override:
--
--   A. THE LOAD-BEARING INVARIANT — pick 10 → complete_picking → reopen_picking
--      → correct the line to 8 → re-complete leaves on_hand at 2, NOT -6. The
--      reversal must undo complete_picking's adjust_stock draw AND leave the
--      units drawable again (they go to Unplaced, not Staging — a Staging
--      reversal raises insufficient_placed_stock on the re-pick).
--   B. Reopening from packing_slip_generated voids the packing-slip /
--      signature-token cycle and restores the drawn stock.
--   C. Reservations: only the CURRENT picking cycle's holds are un-released; a
--      superseded generation (left by a backorder resume) stays released.
--   D. Guards: blank reason, a signed order, a wrong-status order, a non-manager.
--
-- Lines are picked through partial_pick_line, the real product path —
-- order_request_lines carries an RLS `UPDATE using(false)` policy, so every line
-- write goes through a SECURITY DEFINER RPC. Wrapped in begin/rollback —
-- nothing leaks. Namespace d0289000.

begin;

select plan(18);

\set org   '\'d0289000-0000-0000-0000-000000000001\''
\set mgr   '\'d0289000-0000-0000-0000-000000000002\''
\set staff '\'d0289000-0000-0000-0000-000000000003\''
\set wh    '\'d0289000-0000-0000-0000-000000000004\''
\set rack  '\'d0289000-0000-0000-0000-000000000005\''

\set item_a '\'d0289000-0000-0000-0000-0000000000a0\''
\set ord_a  '\'d0289000-0000-0000-0000-0000000000a1\''
\set line_a '\'d0289000-0000-0000-0000-0000000000a2\''
\set resv_a '\'d0289000-0000-0000-0000-0000000000a3\''
\set item_b '\'d0289000-0000-0000-0000-0000000000b0\''
\set ord_b  '\'d0289000-0000-0000-0000-0000000000b1\''
\set line_b '\'d0289000-0000-0000-0000-0000000000b2\''
\set item_c '\'d0289000-0000-0000-0000-0000000000c0\''
\set ord_c  '\'d0289000-0000-0000-0000-0000000000c1\''
\set line_c '\'d0289000-0000-0000-0000-0000000000c2\''
\set resv_c_old '\'d0289000-0000-0000-0000-0000000000c3\''
\set resv_c_new '\'d0289000-0000-0000-0000-0000000000c4\''
\set ord_s  '\'d0289000-0000-0000-0000-0000000000e1\''
\set ord_w  '\'d0289000-0000-0000-0000-0000000000f1\''

-- ── Fixtures (as owner, before the role switch) ──────────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
  values
    (:mgr,   'reopen-0289-mgr@test.local',   '{}'::jsonb),
    (:staff, 'reopen-0289-staff@test.local', '{}'::jsonb)
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug)
  values (:org, 'Reopen Picking Org 0289', 'reopen-picking-0289') on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role, accepted_at)
  values
    (:org, :mgr,   'manager', now()),
    (:org, :staff, 'staff',   now())
  on conflict do nothing;
insert into public.warehouses (id, organization_id, name, code, status)
  values (:wh, :org, 'Reopen WH', 'WH-RO-0289', 'active') on conflict (id) do nothing;
insert into public.locations (id, organization_id, warehouse_id, name, type, kind)
  values (:rack, :org, :wh, 'RO-R1', 'shelf', 'rack') on conflict (id) do nothing;

-- Items fully PLACED in the rack: complete_picking draws PLACED stock, so the
-- Unplaced level auto-seeded by trg_seed_initial_level (0199) is replaced with
-- an explicit rack level (same pattern as 0244) to keep Σlevels = on_hand.
insert into public.inventory_items
  (id, organization_id, warehouse_id, sku, name, quantity_on_hand, status, tracking_type)
  values
    (:item_a, :org, :wh, 'RO-A', 'Item A', 10, 'active', 'none'),
    (:item_b, :org, :wh, 'RO-B', 'Item B',  5, 'active', 'none'),
    (:item_c, :org, :wh, 'RO-C', 'Item C', 10, 'active', 'none')
  on conflict (id) do nothing;
delete from public.item_stock_levels where item_id in (:item_a, :item_b, :item_c);
insert into public.item_stock_levels (organization_id, item_id, location_id, quantity)
  values
    (:org, :item_a, :rack, 10),
    (:org, :item_b, :rack,  5),
    (:org, :item_c, :rack, 10);

-- Orders (INSERT bypasses the UPDATE-only transition trigger).
--   A: live pick cycle, ready to be picked and completed.
--   B: already packed — its 5 units were drawn off the shelf by an earlier
--      complete_picking (item_b on_hand is the post-draw 5), packing slip and
--      signature token issued.
--   C: a resumed backorder cycle, ready to be picked and completed.
--   S: signed at a pre-hand-over status — must be refused (defence in depth).
--   W: wrong status (approved) — must be refused.
insert into public.order_requests
  (id, organization_id, warehouse_id, status, requester_user_id, source, fulfillment_type,
   picking_completed_at, picking_completed_by,
   packing_slip_generated_at, packing_slip_generated_by,
   signature_token, signature_token_expires_at, signed_at)
  values
    (:ord_a, :org, :wh, 'pick_slip_generated',    :mgr, 'internal', 'pickup',
     null, null, null, null, null, null, null),
    (:ord_b, :org, :wh, 'packing_slip_generated', :mgr, 'internal', 'pickup',
     now(), :mgr, now(), :mgr, 'tok-b-0289', now() + interval '1 day', null),
    (:ord_c, :org, :wh, 'pick_slip_generated',    :mgr, 'internal', 'pickup',
     null, null, null, null, null, null, null),
    (:ord_s, :org, :wh, 'packing_slip_generated', :mgr, 'internal', 'pickup',
     now(), :mgr, now(), :mgr, 'tok-s-0289', now() + interval '1 day', now()),
    (:ord_w, :org, :wh, 'approved',               :mgr, 'internal', 'pickup',
     null, null, null, null, null, null, null)
  on conflict (id) do nothing;

insert into public.order_request_lines
  (id, order_request_id, item_id, quantity_requested, quantity_fulfilled, quantity_picked)
  values
    (:line_a, :ord_a, :item_a, 10, 0, null),
    (:line_b, :ord_b, :item_b, 10, 0, 5),
    (:line_c, :ord_c, :item_c, 10, 0, null)
  on conflict (id) do nothing;

-- A's active hold: the one complete_picking releases and reopen must restore.
-- C carries TWO generations: an older hold already released by the pre-backorder
-- picking cycle (must STAY released) plus the current active one.
insert into public.stock_reservations
  (id, organization_id, item_id, warehouse_id, order_request_id, quantity, released_at)
  values
    (:resv_a,     :org, :item_a, :wh, :ord_a, 10, null),
    (:resv_c_old, :org, :item_c, :wh, :ord_c, 10, now() - interval '1 day'),
    (:resv_c_new, :org, :item_c, :wh, :ord_c, 10, null)
  on conflict (id) do nothing;

-- ── Become the manager (auth.uid() + has_org_role + RLS) ─────────────────────
set local "request.jwt.claim.sub" to 'd0289000-0000-0000-0000-000000000002';
set local "request.jwt.claim.role" to 'authenticated';
set local role to 'authenticated';

-- ════════════════════════════════════════════════════════════════════════════
-- A — the stock round-trip. pick 10 → complete → reopen → fix to 8 → re-complete
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0289000-0000-0000-0000-0000000000a2'::uuid, 10); end $$;
do $$ begin perform public.complete_picking('d0289000-0000-0000-0000-0000000000a1'::uuid); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  0::numeric(14,4),
  'A: complete_picking drew on_hand to 0');
select is(
  (select status from public.order_requests where id = :ord_a),
  'picking_complete',
  'A: order is picking_complete');

-- A blank reason is refused before anything moves.
select throws_like(
  $$ select public.reopen_picking('d0289000-0000-0000-0000-0000000000a1'::uuid, '   ') $$,
  '%reopen_reason_required%',
  'A: blank reason refused');

do $$ begin perform public.reopen_picking('d0289000-0000-0000-0000-0000000000a1'::uuid,
  'Miscount on line 1'); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  10::numeric(14,4),
  'A: reopen restored on_hand to 10 (no orphaned draw)');
select is(
  (select status from public.order_requests where id = :ord_a),
  'picking_in_progress',
  'A: order rewound to picking_in_progress');
select is(
  (select quantity_picked from public.order_request_lines where id = :line_a),
  10::numeric(14,4),
  'A: quantity_picked preserved for the recount');
select is(
  (select released_at from public.stock_reservations where id = :resv_a),
  null,
  'A: reservation restored (released_at back to NULL)');
-- The reversed units must be drawable, i.e. anywhere BUT Staging.
select is(
  (select coalesce(sum(s.quantity), 0) from public.item_stock_levels s
     join public.locations l on l.id = s.location_id
    where s.item_id = :item_a and l.kind <> 'staging'),
  10::numeric(14,4),
  'A: the 10 reversed units are placed (not stranded in Staging)');

-- The gate: correct the miscount to 8 through the real pick RPC and re-complete.
-- on_hand must be 2 — a double-decrement would land at -6.
do $$ begin perform public.partial_pick_line('d0289000-0000-0000-0000-0000000000a2'::uuid, 8); end $$;
do $$ begin perform public.complete_picking('d0289000-0000-0000-0000-0000000000a1'::uuid); end $$;

select is(
  (select quantity_on_hand from public.inventory_items where id = :item_a),
  2::numeric(14,4),
  'A: round-trip leaves on_hand 2 after the corrected re-pick (no double-decrement)');

-- ════════════════════════════════════════════════════════════════════════════
-- B — reopening from packing_slip_generated voids the slip + token cycle
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.reopen_picking('d0289000-0000-0000-0000-0000000000b1'::uuid,
  'Packer found a short count'); end $$;

select is(
  (select status from public.order_requests where id = :ord_b),
  'picking_in_progress',
  'B: packing_slip_generated rewinds to picking_in_progress');
select is(
  (select packing_slip_generated_at from public.order_requests where id = :ord_b),
  null,
  'B: packing slip voided (packing_slip_generated_at cleared)');
select is(
  (select signature_token from public.order_requests where id = :ord_b),
  null,
  'B: signature token cleared (a stale sign link cannot be replayed)');
select is(
  (select quantity_on_hand from public.inventory_items where id = :item_b),
  10::numeric(14,4),
  'B: the packed batch of 5 is back on hand (5 -> 10)');

-- ════════════════════════════════════════════════════════════════════════════
-- C — only the current picking cycle's reservations are un-released
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform public.partial_pick_line('d0289000-0000-0000-0000-0000000000c2'::uuid, 10); end $$;
do $$ begin perform public.complete_picking('d0289000-0000-0000-0000-0000000000c1'::uuid); end $$;
do $$ begin perform public.reopen_picking('d0289000-0000-0000-0000-0000000000c1'::uuid,
  'Recount the resumed batch'); end $$;

select isnt(
  (select released_at from public.stock_reservations where id = :resv_c_old),
  null,
  'C: the superseded (pre-resume) hold stays released');
select is(
  (select coalesce(sum(quantity), 0) from public.stock_reservations
    where order_request_id = :ord_c and released_at is null),
  10::numeric(14,4),
  'C: exactly one generation of holds is active (10, not a double-reserved 20)');

-- ════════════════════════════════════════════════════════════════════════════
-- D — guards
-- ════════════════════════════════════════════════════════════════════════════
select throws_like(
  $$ select public.reopen_picking('d0289000-0000-0000-0000-0000000000e1'::uuid, 'too late') $$,
  '%already_signed%',
  'D: a signed order is never rewound (signed_at is the is-signed predicate)');

select throws_like(
  $$ select public.reopen_picking('d0289000-0000-0000-0000-0000000000f1'::uuid, 'wrong state') $$,
  '%invalid_status_transition%',
  'D: an approved (never-picked) order is refused');

-- Non-manager: ord_a is back at picking_complete, so only the role gate can fail.
set local "request.jwt.claim.sub" to 'd0289000-0000-0000-0000-000000000003';
select throws_like(
  $$ select public.reopen_picking('d0289000-0000-0000-0000-0000000000a1'::uuid, 'let me in') $$,
  '%forbidden%',
  'D: a staff member cannot reopen picking');

select * from finish();
rollback;
