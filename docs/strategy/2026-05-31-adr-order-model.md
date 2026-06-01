# ADR: `sales_orders` vs `order_requests` for ecommerce order ingestion

- **Date:** 2026-05-31
- **Status:** Accepted (decision record only — no code/schema change in this PR)
- **Context tag:** Roadmap P1 #2 ("Order-model ADR: `order_requests` vs `sales_orders`")
- **Decision owner:** StockPilot platform
- **Related:** [`2026-05-31-roadmap.md`](./2026-05-31-roadmap.md), migrations `0044_order_requests.sql` (source enum + identity constraint), `0109_orders_workflow_foundation.sql` (expanded fulfillment status machine), `0146_connector_framework.sql` (connector tables + Vault secret seam).

## Context

We want to ingest **external sales orders** from ecommerce / POS channels — Square POS, Shopify, Amazon Seller — so that a sale on one of those channels deducts inventory in StockPilot and (optionally) drives a fulfillment workflow. These inbound connectors are currently **blocked** on a single unresolved question: *what local domain object does an external sales order map to?*

Today the only "order" concept is `order_requests`, and it is **not** a sales-order model. It is an **internal / public-request, charter-oriented** flow:

- **Purpose:** a member (or a public-link requester) asks the warehouse to release stock to a charter / school. It is a *request to fulfill*, not a *record of a commercial sale*.
- **Identity** (`0044` `order_requests_identity_chk`): exactly one of `requester_user_id` (when `source = 'internal'`) or `requester_email` (when `source = 'public_link'`). There is no external customer of record, no payment, no commercial counterparty.
- **`source` enum** (`0044`): `'internal' | 'public_link'`. Both values describe *who inside our trust boundary asked*, not *which external channel sold*.
- **State machine** (`0044` + `0109`): a ~14-state charter-fulfillment machine — `pending_approval → approved → pick_slip_generated → picking_in_progress → picking_complete → packing_slip_generated → staged_for_pickup | staged_for_delivery → in_transit → delivered → completed`, plus `denied`, `cancelled`, `pending_confirmation`. Stock is held via `stock_reservations` on **approval** and decremented on fulfillment. The transition guard (`0076`/`0109`) and the `_notify_order_request_changes` trigger are written around exactly these states.
- **Money semantics:** essentially none. `order_request_lines.unit_cost_at_request` is an internal cost snapshot, not a customer-facing price/tax/discount/total. There is no paid / refunded / charge concept.

The connector framework (`0146`) is, today, deliberately **one-way export only** (StockPilot → provider); its header comment states "Nothing in here writes provider data back into StockPilot." So inbound ingestion needs both (a) a target domain object and (b) a webhook-ingest seam. This ADR settles (a).

## Decision

**Introduce a distinct `sales_orders` domain (new table + service), rather than overloading `order_requests.source` with ecommerce channels.** (Option B below.)

## Options considered

### Option A — Extend `order_requests` (`source` enum + nullable sales fields)

Add `'square' | 'shopify' | 'amazon' | ...` to the `source` enum, relax `order_requests_identity_chk`, and bolt on nullable columns for external customer, channel id, price/tax/total, payment status, etc.

**Pros**
- One queue / one UI / one report surface; no new RLS or service to write.
- Reuses the existing picking/packing/staging fulfillment machine as-is for channel orders that we physically fulfill.

**Cons**
- **State-machine corruption.** A paid Shopify order has a fundamentally different lifecycle (`paid → fulfilled → partially_refunded → refunded`, plus channel cancel/hold) than the charter approval flow. Forcing it through `pending_approval → approved` is semantically wrong (nobody approves a sale that already happened and was already paid for), and adds states/branches the charter guard was never designed for. Every new channel risks a transition-guard regression in the most safety-critical write path we have.
- **Identity model breaks.** `order_requests_identity_chk` enforces a member-or-public-link requester. An external customer is neither; relaxing the constraint to a 3-way (or n-way) check weakens an invariant the charter flow depends on and that RLS / notifications assume.
- **Money semantics leak in.** Price, tax, discount, totals, currency, payment/refund status are first-class for a sale and absent for a request. Adding ~10 nullable columns that are meaningful for *some* sources and null for others produces a wide, mode-switched table that is hard to constrain and easy to misuse.
- **RLS + reporting blast radius.** `0044`'s insert policy ties a row to `requester_user_id = auth.uid()`; public-link inserts go through the admin client. A channel order has no such author. Every report, notification template, and the realtime queue assumes "request" semantics and would need conditional logic on `source`.
- **Reservation timing mismatch.** Charter reservations are placed on *approval*; a channel sale is already committed at ingest, so the hold/decrement timing differs and would need a `source`-branched code path inside the SECURITY DEFINER functions.

### Option B — Separate `sales_orders` table/domain  ✅ (chosen)

A new per-org `sales_orders` (+ `sales_order_lines`) domain owned by the connector framework, with its own lifecycle, its own RLS, and a typed link to fulfillment when we physically ship a channel order.

**Pros**
- Keeps the charter `order_requests` state machine, identity constraint, RLS, and reports **clean and unchanged** — zero risk to the existing safety-critical fulfillment path.
- Models sale-native concerns directly: external customer, channel/order ids, line prices + totals, currency, and a paid/fulfilled/refunded lifecycle.
- Natural home for the connector identity already in `0146` (`org_connections`, `connection_mappings`, `connection_sync_log`) — a sales order is *of a connection*.
- Clear separation lets channel orders that we *do* fulfill reuse the existing pick/pack/stage machine by **creating a linked `order_request`**, instead of mutating the sales order's lifecycle.

**Cons**
- A second order-ish surface to build and maintain (table, RLS, service, settings/UI, reports). Mitigated by the connector framework already providing the per-org plumbing.
- Need a deliberate link object between a `sales_order` and any fulfillment `order_request` it spawns (handled in the flow below).

## Why B

The deciding factor is that a **sales order and a charter request are different aggregates with different invariants**:

1. **Different lifecycle.** Charter: approval → physical fulfillment. Sale: payment → fulfillment → refund. They share *physical fulfillment* but nothing else; overloading one machine to express both guarantees branch-by-`source` logic in the exact functions (`approve/deliver/cancel`, the transition guard, the notify trigger) we least want to destabilize.
2. **Different identity + trust boundary.** `order_requests` is authored by someone inside the org (member or public-link). A sales order originates from an external channel and an external customer — a different RLS author model entirely (member-read, service-role-write at ingest).
3. **Different money semantics.** Sales carry price/tax/total/payment/refund as first-class data; requests don't. Keeping them apart keeps each table well-constrained.

Separation is the lower-risk, more honest model and it is what actually **unblocks** the ecommerce connectors.

## What this unblocks

- **Square / Shopify / Amazon inbound connectors** can land against a real target. Each connector's webhook handler maps an external order to a `sales_orders` row + `sales_order_lines`, resolving SKUs to local `inventory_items` via the existing `connection_mappings` (`entity_type = 'item'`).
- It defines the **inbound counterpart** to the currently export-only connector framework (`0146`): a webhook-ingest seam that writes `sales_orders` (service-role only), with delivery/idempotency recorded in `connection_sync_log` exactly as exports are.
- It keeps the P1 roadmap's "Parked: Square / Shopify / Amazon connectors (gated by the order-model ADR)" item ungated.

## High-level `sales_orders` schema sketch (illustrative — not the migration)

```text
sales_orders
  id                uuid pk
  organization_id   uuid not null  -> organizations(id)            -- org-scoped, RLS
  connection_id     uuid not null  -> org_connections(id)          -- which channel/connection
  provider_id       text not null                                  -- 'square' | 'shopify' | 'amazon'
  external_id       text not null                                  -- provider's order id
  external_number   text                                           -- human order # shown by the channel
  status            text not null                                  -- 'open' | 'paid' | 'partially_fulfilled'
                                                                    -- | 'fulfilled' | 'cancelled'
                                                                    -- | 'refunded' | 'partially_refunded'
  -- external customer (NOT a member, NOT a charter)
  customer_name     text
  customer_email    citext
  customer_external_id text
  ship_to           jsonb                                          -- channel-provided address
  -- money (sale-native, currency-aware)
  currency          text not null default 'USD'
  subtotal          numeric(14,4) not null default 0
  tax_total         numeric(14,4) not null default 0
  discount_total    numeric(14,4) not null default 0
  shipping_total    numeric(14,4) not null default 0
  grand_total       numeric(14,4) not null default 0
  amount_refunded   numeric(14,4) not null default 0
  -- fulfillment link (nullable; set when we physically fulfill via the charter machine)
  fulfillment_order_request_id uuid -> order_requests(id)
  placed_at         timestamptz
  raw_payload       jsonb                                          -- last provider snapshot for audit/replay
  created_at        timestamptz not null default now()
  updated_at        timestamptz not null default now()
  unique (connection_id, external_id)                              -- idempotent ingest key

sales_order_lines
  id                uuid pk
  sales_order_id    uuid not null -> sales_orders(id) on delete cascade
  organization_id   uuid not null                                  -- denormalized for RLS
  item_id           uuid          -> inventory_items(id)           -- nullable until SKU is mapped
  external_sku      text                                           -- channel SKU as received
  description       text
  quantity          numeric(14,4) not null check (quantity > 0)
  unit_price        numeric(14,4) not null default 0
  line_total        numeric(14,4) not null default 0
  quantity_fulfilled numeric(14,4) not null default 0
```

RLS posture (mirrors `0146`): member **read**, **no authenticated write** — ingestion is service-role only via the webhook seam; org-scope every table and policy with `is_org_member(organization_id)`. The `unique (connection_id, external_id)` key makes re-delivered webhooks idempotent.

## Connector → `sales_orders` → fulfillment flow

1. **Webhook ingest (service-role).** Channel fires `order.created` / `order.updated` → connector webhook handler verifies the signature, looks up the `org_connections` row, and upserts a `sales_orders` row + lines (idempotent on `connection_id, external_id`). Delivery + retries recorded in `connection_sync_log` (same ledger as exports).
2. **SKU resolution.** Each line's `external_sku` is resolved to a local `inventory_items.id` via `connection_mappings` (`entity_type = 'item'`). Unmapped lines surface in the connector settings UI for an operator to map (or auto-create).
3. **Inventory effect.** On a paid/committed sale, decrement stock through the existing audited stock-movement path (referencing `reference_type = 'sales_order'`), keeping ledger parity with `order_requests` deliveries. Refund webhooks reverse the movement and advance `status` → `refunded` / `partially_refunded`.
4. **Optional physical fulfillment.** If the org fulfills the channel order out of the warehouse, the service **creates a linked `order_request`** (charter machine) and stamps `sales_orders.fulfillment_order_request_id`. The charter pick/pack/stage/deliver flow runs **unchanged**; the sales order simply tracks the channel-facing status.
5. **Status echo-back (optional, later).** Once fulfilled, the existing **export** side of the connector framework can push fulfillment/tracking back to the channel — reusing `0146` rather than inventing a new path.

This keeps each aggregate authoritative for its own concern: `sales_orders` owns the commercial/channel lifecycle; `order_requests` owns physical fulfillment; the connector framework owns identity + delivery in both directions.

## Consequences

- **Next implementation step** (separate PR): a migration adding `sales_orders` + `sales_order_lines` with the RLS posture above, an inbound webhook seam on the connector framework, and a `SalesOrderService.forApiContext(ctx)`. Square is the first concrete connector (smallest order shape).
- `order_requests` is untouched — no enum change, no constraint relaxation, no new branches in the charter functions/guard/trigger.
- The `order_requests.source` enum stays `'internal' | 'public_link'`; channel provenance lives on `sales_orders.provider_id` / `connection_id`.
