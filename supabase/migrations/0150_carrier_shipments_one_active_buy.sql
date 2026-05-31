-- ============================================================================
-- 0150_carrier_shipments_one_active_buy.sql — airtight double-buy prevention.
--
-- Hardens the carrier_shipments buy flow against a concurrent multi-draft race
-- that could charge EasyPost twice for ONE order. Two getRates sessions create
-- two distinct 'draft' rows; under the previous per-draft compare-and-swap two
-- buyLabel calls claiming DIFFERENT drafts could BOTH reach EasyPost's buy
-- endpoint. This migration adds:
--
--   1. A 'purchasing' intermediate status — buyLabel transitions the chosen
--      draft to 'purchasing' (the claim) BEFORE the billable EasyPost buy, so a
--      mid-buy row is distinguishable from a draft and from a completed buy.
--
--   2. A PARTIAL UNIQUE INDEX on (organization_id, order_request_id) WHERE
--      status in ('purchasing','purchased') — at most ONE active buy per order
--      at the DATABASE level. Two concurrent claims for the same order can no
--      longer both succeed: the second claim's transition into 'purchasing'
--      raises a unique violation (SQLSTATE 23505), which the service catches and
--      resolves idempotently rather than reaching EasyPost a second time.
--
-- SAFETY: carrier_shipments is EMPTY on prod, so re-asserting the status CHECK
-- and adding the partial unique index can never fail on existing data.
-- ============================================================================

-- 1. Extend the status CHECK to include the new 'purchasing' claim state. -----
--    The 0149 inline `check (status in (...))` is auto-named
--    carrier_shipments_status_check by Postgres. Drop-if-exists keeps this
--    idempotent and tolerant of any environment where the constraint was
--    renamed; re-add the full enumeration including 'purchasing'.
alter table public.carrier_shipments
  drop constraint if exists carrier_shipments_status_check;
alter table public.carrier_shipments
  add constraint carrier_shipments_status_check
  check (status in ('draft','purchasing','purchased','in_transit','delivered','returned','failure','cancelled'));

-- 2. At most ONE active buy (in-flight OR completed) per order. ---------------
--    A draft that has been CLAIMED ('purchasing') or COMPLETED ('purchased')
--    occupies the single active slot for its (organization_id, order_request_id).
--    A second concurrent claim attempting to enter 'purchasing' for the same
--    order hits this index and raises 23505; the service treats that as "a buy
--    already won the race" and never charges EasyPost again. Drafts and terminal
--    states (in_transit/delivered/returned/failure/cancelled) are intentionally
--    excluded so rate-shopping and post-buy lifecycle rows are unconstrained.
create unique index if not exists carrier_shipments_one_active_per_order
  on public.carrier_shipments (organization_id, order_request_id)
  where status in ('purchasing','purchased');
