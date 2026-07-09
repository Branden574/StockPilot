-- B2B portal accounting fix: separate SELL price from COST on order lines.
--
-- order_request_lines.unit_cost_at_request is a COST snapshot — the Sage/QBO
-- connectors read it as cost for return-journal valuation, and internal/public
-- orders store the item's cost there. The portal checkout was writing the
-- customer's SELL price into that column, which would misvalue any portal-order
-- return in the accounting export.
--
-- Fix: portal lines now store the item's cost in unit_cost_at_request (like
-- every other source) and the customer's sell price in this new nullable
-- unit_price_at_request. Only the portal sets it; everything else leaves it
-- NULL, so no existing reader changes.

alter table public.order_request_lines
  add column if not exists unit_price_at_request numeric(14,4)
  check (unit_price_at_request is null or unit_price_at_request >= 0);

comment on column public.order_request_lines.unit_price_at_request is
  'Customer SELL price at order time (B2B portal orders only; NULL otherwise). unit_cost_at_request stays the cost snapshot for accounting.';
