-- ============================================================================
-- 0160_order_status_config.sql — Per-org ORDER STATUS label/color overrides.
--
-- A SOFT presentation override: it lets an org rename an order status (e.g.
-- "Pending" -> "Awaiting principal sign-off") and recolor its badge. It does
-- NOT touch the order_requests.status CHECK constraint nor the transition guard
-- — the canonical 13-value status union and the state machine are unchanged.
-- This column only influences how a status is LABELED + COLORED in the UI.
--
-- Shape (validated by @stockpilot/core's resolveOrderStatusConfig, the single
-- source of truth — fails CLOSED to the canonical defaults on null/garbage):
--   { "<statusKey>": { "label"?: string, "color"?: token, "sortOrder"?: int } }
-- Unknown status keys are ignored; missing keys fall back to ORDER_STATUS_META.
--
-- Stored on organizations (a config jsonb column, like 0158's nav_overrides /
-- dashboard_layout) so the dashboard render reads it off the already-cached org
-- row — zero extra round-trips. Admin-managed via a server action; the column
-- has no RLS of its own beyond the existing organizations row policies.
-- ============================================================================

alter table public.organizations
  add column if not exists order_status_config jsonb;

comment on column public.organizations.order_status_config is
  'Per-org SOFT override for order status presentation (label/color/sortOrder per status key). Does NOT alter the order_requests.status CHECK or the transition state machine — purely how a status is labeled + colored in the UI. Validated by @stockpilot/core resolveOrderStatusConfig (fails closed to canonical ORDER_STATUS_META on null/garbage). Admin-managed via the order-status settings action.';
