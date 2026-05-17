-- ============================================================================
-- 0119_order_workflow_rls_defense_in_depth.sql
-- ============================================================================
-- Defense-in-depth + a missing query index. Does NOT fix an active
-- vulnerability — the 2026-05-16 multi-agent audit flagged "missing
-- DELETE policy → data leak" as critical, but verifying against current
-- source showed that Postgres RLS already denies by default when no
-- policy matches an operation. Migration 0049 even comments:
--   "No UPDATE/DELETE policies means those operations are blocked for
--    end users; SECURITY DEFINER functions still work."
--
-- However, mirroring the explicit-deny pattern from 0104
-- (mfa_recovery_codes) is still worthwhile:
--   • Self-documenting — a reader doesn't have to reason about
--     "no policy = denied"; the deny is right there.
--   • Insurance — if a future migration accidentally creates a permissive
--     FOR ALL policy on these tables, the explicit denies remain in
--     force as long as they aren't dropped first.
--   • Audit posture — tighter on automated scans.
--
-- Also adds the index on (organization_id, fulfillment_type) that the
-- workflow audit flagged. Phase 5 dashboards filter pickup-vs-delivery
-- queues; today that's an org-wide scan plus filter.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. stock_reservations — INSERT / UPDATE / DELETE explicitly denied
-- ─────────────────────────────────────────────────────────────────────
-- 0044 created the table with a SELECT policy only and a comment
-- stating SECURITY DEFINER functions (approve_order_request,
-- complete_picking, cancel_order_request) are the only writers. Make
-- that intent explicit as deny-by-default policies — DEFINER functions
-- bypass RLS so this doesn't break the workflow.

drop policy if exists stock_reservations_no_insert on public.stock_reservations;
create policy stock_reservations_no_insert on public.stock_reservations
  for insert to authenticated
  with check (false);

drop policy if exists stock_reservations_no_update on public.stock_reservations;
create policy stock_reservations_no_update on public.stock_reservations
  for update to authenticated
  using (false)
  with check (false);

drop policy if exists stock_reservations_no_delete on public.stock_reservations;
create policy stock_reservations_no_delete on public.stock_reservations
  for delete to authenticated
  using (false);

comment on table public.stock_reservations is
  'Soft holds against inventory. Writes are SOLELY through '
  'approve_order_request(), complete_picking(), and '
  'cancel_order_request() SECURITY DEFINER functions; '
  'deny-by-default RLS policies block all other paths.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. order_requests — DELETE explicitly denied
-- ─────────────────────────────────────────────────────────────────────
-- Orders are state-managed via the transition trigger
-- (_validate_order_request_status_transition). Deletion is never part
-- of the workflow — cancel_order_request flips to status='cancelled'
-- instead. Be explicit so a future "convenience delete" policy can't
-- get added by accident.

drop policy if exists order_requests_no_delete on public.order_requests;
create policy order_requests_no_delete on public.order_requests
  for delete to authenticated
  using (false);

-- ─────────────────────────────────────────────────────────────────────
-- 3. order_request_lines — UPDATE / DELETE explicitly denied
-- ─────────────────────────────────────────────────────────────────────
-- 0049 already dropped any historical UPDATE/DELETE policies on this
-- table; the comment notes mutations should only happen through
-- SECURITY DEFINER functions (partial_pick_line, complete_picking).
-- Make the deny explicit for the same reasons as above.

drop policy if exists order_request_lines_no_update on public.order_request_lines;
create policy order_request_lines_no_update on public.order_request_lines
  for update to authenticated
  using (false)
  with check (false);

drop policy if exists order_request_lines_no_delete on public.order_request_lines;
create policy order_request_lines_no_delete on public.order_request_lines
  for delete to authenticated
  using (false);

-- ─────────────────────────────────────────────────────────────────────
-- 4. Missing index — (organization_id, fulfillment_type)
-- ─────────────────────────────────────────────────────────────────────
-- Phase 5 dashboard filter queries "show me delivery orders at this
-- charter" and "pickup queue at this warehouse" hit the table with a
-- fulfillment_type predicate. 0109 added fulfillment_type as NOT NULL
-- default 'delivery' but didn't index it. Partial index on the
-- discriminating value keeps it cheap.

create index if not exists order_requests_fulfillment_delivery_idx
  on public.order_requests(organization_id, status, created_at desc)
  where fulfillment_type = 'delivery';

create index if not exists order_requests_fulfillment_pickup_idx
  on public.order_requests(organization_id, status, created_at desc)
  where fulfillment_type = 'pickup';
