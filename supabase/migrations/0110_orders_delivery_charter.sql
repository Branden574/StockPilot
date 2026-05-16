-- 0110_orders_delivery_charter.sql
--
-- Refines the Phase 2 delivery data model. Phase 1's migration 0109
-- added a free-text `delivery_address jsonb` column to capture
-- arbitrary shipping addresses on order_requests. Product call
-- (2026-05-15): we don't deliver to arbitrary addresses — every
-- delivery is to a known **site** (= charter row) that the warehouse
-- already services via the `warehouse_charters` junction. The driver
-- knows each charter's physical address internally; the requester
-- just needs to pick which site this order goes to.
--
-- Net change:
--   * ADD `delivery_charter_id` FK -> public.charters(id)
--   * DROP the free-text `delivery_address` jsonb column (live ~30 min,
--     zero rows wrote to it — safe to remove)
--   * Add a CHECK: delivery orders MUST have a charter; pickup orders
--     MUST NOT have one. Mirrors the fulfillment-type ↔ destination
--     correlation enforced by the transition guard for staging.
--
-- One transaction.

begin;

-- 1. New charter reference. ON DELETE RESTRICT so an admin can't
--    archive a charter that has live orders pointing at it — they
--    have to drain those first.
alter table public.order_requests
  add column if not exists delivery_charter_id uuid
    references public.charters(id) on delete restrict;

-- 2. Index for the dashboard "orders headed to <site>" filter that
--    phase 6 will surface.
create index if not exists order_requests_delivery_charter_idx
  on public.order_requests(delivery_charter_id)
  where delivery_charter_id is not null;

-- 3. Drop the now-orphan free-text address column. No rows in prod
--    have a non-null value yet (the form change shipped < 1h ago and
--    the public surface required confirmation-click which hadn't
--    completed for any test row using the new field).
alter table public.order_requests
  drop column if exists delivery_address;

-- 4. Coherence check: delivery ⇒ delivery_charter_id IS NOT NULL,
--    pickup ⇒ delivery_charter_id IS NULL.
--
--    Drop any prior version of the constraint (idempotent re-run)
--    before adding the new one.
alter table public.order_requests
  drop constraint if exists order_requests_delivery_target_chk;

alter table public.order_requests
  add constraint order_requests_delivery_target_chk
  check (
    (fulfillment_type = 'delivery' and delivery_charter_id is not null)
    or
    (fulfillment_type = 'pickup' and delivery_charter_id is null)
  )
  -- Phase-2 forward: every row written from this point on will pick
  -- a charter when delivery is selected. Existing rows are all
  -- backfilled `fulfillment_type='delivery'` from 0109 + no charter,
  -- so they violate the check. NOT VALID + a future cleanup pass is
  -- the right move — leaves the constraint live for new INSERT/UPDATE
  -- but doesn't reject the legacy rows that have no way to backfill
  -- without manager input.
  not valid;

commit;

comment on column public.order_requests.delivery_charter_id is
  'Site/charter the order ships to. Required when fulfillment_type=delivery; '
  'null when pickup. Joined via warehouse_charters to enforce that only sites '
  'the picked warehouse services can be chosen.';
