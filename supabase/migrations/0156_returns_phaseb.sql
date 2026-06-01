-- ============================================================================
-- 0156_returns_phaseb.sql — Returns/RMA Phase B schema seams.
--
-- Phase A (0153–0155) shipped the returns/return_lines tables, the RMAService,
-- the process_return_disposition RPC, and the staff /dashboard/returns flow.
-- Phase B layers on the connector + requester-portal seams. This migration
-- prepares the schema for two of them:
--
--   1. carrier_shipments.direction — distinguishes an OUTBOUND delivery label
--      from a RETURN label (EasyPost is_return:true). The 0150 partial unique
--      index "carrier_shipments_one_active_per_order" enforced at most ONE
--      active (purchasing|purchased) label per (org, order). A return label is
--      a SECOND active label for the same order, so the index must widen to key
--      on direction too — one active OUTBOUND and one active RETURN can coexist
--      per order, but never two of the same direction (preserving the
--      double-buy guard per direction). See ShippingService.buyReturnLabel (B2).
--
--   2. order_requests.return_token — the per-order opaque token for the
--      requester-initiated return portal (/returns/request/[token], B4). Mirrors
--      organizations.public_request_token (0044): nullable, with a PARTIAL
--      unique index (WHERE not null) so the column stays NULL until an order
--      becomes returnable and B4 issues a token. uuid (not text) per the Phase B
--      spec — order signatures already use a per-record token; this is the
--      return analogue.
--
-- SAFETY:
--   • carrier_shipments is EMPTY on prod, so adding a NOT NULL column with a
--     default + a CHECK and rebuilding the partial unique index can never fail
--     on existing data. The default 'outbound' backfills any (none) existing
--     rows as outbound, matching their pre-Phase-B meaning.
--   • order_requests.return_token is nullable with no default, so the add +
--     partial unique index are no-ops against existing rows.
--   • Every statement is idempotent (if not exists / drop ... if exists).
-- ============================================================================

-- 1. carrier_shipments.direction — outbound (default) vs return label. --------
alter table public.carrier_shipments
  add column if not exists direction text not null default 'outbound'
    check (direction in ('outbound','return'));

-- 2. Widen the 0150 one-active-buy guard to be per-direction. ------------------
--    0150 created (exact name) carrier_shipments_one_active_per_order on
--    (organization_id, order_request_id) WHERE status in ('purchasing',
--    'purchased'). Drop it and recreate keyed on direction as well, so ONE
--    active outbound AND ONE active return label can coexist per order while a
--    second concurrent buy of the SAME direction still raises 23505 (the
--    service resolves that idempotently — never charging EasyPost twice).
drop index if exists public.carrier_shipments_one_active_per_order;
create unique index if not exists carrier_shipments_one_active_per_order
  on public.carrier_shipments (organization_id, order_request_id, direction)
  where status in ('purchasing','purchased');

-- 3. order_requests.return_token — per-order requester-return-portal token. ----
--    Issued (B4) when an order becomes returnable; NULL until then. Partial
--    unique index mirrors organizations_public_request_token_idx (0044).
alter table public.order_requests
  add column if not exists return_token uuid;

create unique index if not exists order_requests_return_token_idx
  on public.order_requests(return_token)
  where return_token is not null;
