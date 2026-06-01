# Returns/RMA (full) + Notifications gap-fill — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

Grounded in workflow w3fbdi5ww. Two features:
- **Returns/RMA (full)** — multi-phase: RMA + restock/scrap disposition (→ `adjust_stock`), EasyPost return label, QBO credit memo, requester-initiated portal + staff approval.
- **Notifications** — NOT a rebuild: the infra exists (notifications/push_tokens/notification_preferences tables, low-stock/PO/order triggers, Expo push, Realtime, web bell + mobile screen, digest). GAP-FILL only.

**Branch:** `feat/returns-rma` (Returns) then a separate branch for Notifications. Conventions: per-task commit; stage only task files (never the WIP `templates.tsx`/`team.ts`/`scripts/*.mjs`); trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; tsc clean; do NOT `supabase db push` (controller applies) or push. Latest migration **0152 → use 0153+**.

**Confirmed seams:** `adjust_stock(p_item_id, p_quantity_change, p_movement_type, p_location_id, p_reason, p_notes)` — RESTOCK = `+qty,'return'`, SCRAP = `-qty,'loss'`; `cancel_order_request` (0137) is the reference pattern. Orders returnable at status `completed`/`delivered` with `quantity_fulfilled>0`. Public portal pattern: `organizations.public_request_token` + `/r/[token]` + double-opt-in + 0048 rate-limit + honeypot; order signature uses a per-order token. QBO connector `handleOutboxEvent` (receipt.posted→Bill) + `publish_outbox` RPC + `subscribedTopics`; account map `org_connections.settings.accountIds`. EasyPost `createShipment({is_return:true})` + `buyShipment`. `carrier_shipments` 0150 unique index is `(org, order_request_id) WHERE status in ('purchasing','purchased')` — a return label needs a `direction` discriminator so one outbound + one return can coexist.

---

# RETURNS/RMA — PHASE A (foundation: schema + staff flow + disposition)

## Task A1: Migration 0153 — returns schema + disposition RPC
- [ ] `supabase/migrations/0153_returns.sql`:
  - `returns` (RMA header): id uuid pk; organization_id (fk orgs cascade); order_request_id (fk order_requests); return_number text; status text check in ('requested','approved','received','closed','denied','cancelled') default 'requested'; source text check in ('internal','requester') default 'internal'; reason_code text check in ('damaged','wrong_item','end_of_year','overage','other'); notes text; requested_by uuid (fk user_profiles, null for requester-initiated); requester_email citext, requester_name text; approved_by/at, received_by/at, closed_by/at, denied_by/at; created_at/updated_at. Indexes (org, order_request_id), (org, status). RLS: member select, manager write (canonical `(select is_org_member/has_org_role(...))`). `tg_set_updated_at`.
  - `return_lines`: id; return_id (fk cascade); order_request_line_id (fk); item_id (fk inventory_items); quantity numeric check >0; disposition text check in ('restock','scrap'); applied boolean default false; created_at. unique(return_id, order_request_line_id).
  - `process_return_disposition(p_return_id uuid)` SECURITY DEFINER RPC (mirror cancel_order_request 0137): for each not-yet-applied return_line, call adjust_stock(+qty,'return',...) for restock or (-qty,'loss',...) for scrap, reference_type='return' reference_id=return_id; mark line applied; idempotent (skip applied lines). Org-scoped; callable by the service-role / via the service.
- [ ] Validate SQL by review + grep FK targets. Commit `feat(db): returns/RMA schema + disposition RPC (0153)`.

## Task A2: RMAService + staff create/approve/receive/close
- [ ] `apps/web/src/server/services/returns.ts` — RMAService.forCurrentUser()/forApiContext(ctx); gated `assertModuleEnabled('returns'|'orders')` (add a 'returns' module to MODULE_REGISTRY, tier optional, perm `returns:manage`, grandfather OFF in 0153 or 0154) + `assertPermission`. Methods: list(filters), get(id), createFromOrder(orderRequestId, {reasonCode, lines:[{orderRequestLineId, quantity, disposition}], notes}) (validate order is returnable + quantities ≤ fulfilled), approve(id), deny(id, reason), receive(id) (transition + call process_return_disposition to apply inventory), close(id) (final; publishes return.closed in Phase B), cancel(id). Status-machine guarded transitions. Audit each.
- [ ] Add the `returns` module to packages/core MODULE_REGISTRY + `returns:manage` permission (owner+admin+manager? decide: manager-level, since warehouse managers handle returns) + grandfather migration.
- [ ] Tests: createFromOrder rejects non-returnable orders + over-quantity; receive applies restock/scrap via the RPC (mock); transitions guarded; gating. Run web vitest + tsc. Commit `feat(web): RMAService + returns module/permission (Phase A)`.

## Task A3: Web staff UI — returns list + create-from-order + approve/receive/close
- [ ] A `/dashboard/returns` list (gated) + a "Create return" action on a completed/delivered order detail (pick lines + quantities + reason + per-line disposition) + the return detail with approve/deny/receive/close actions (manager-actions style). Show disposition results + linked order. tsc. Commit `feat(web): returns staff UI (list, create-from-order, lifecycle) (Phase A)`.

# RETURNS/RMA — PHASE B (connectors + requester portal)

## Task B1: Migration 0154 — carrier_shipments.direction + returnCredit account note + return token
- [ ] Add `carrier_shipments.direction text check in ('outbound','return') default 'outbound'`; change the 0150 partial unique index to include `direction` so one outbound + one return per order can be active. Add `order_requests.return_token uuid` (issued when an order becomes returnable) for the requester portal. (Account mapping `returnCredit` is stored in settings jsonb — no column needed.)

## Task B2: EasyPost return label
- [ ] ShippingService.buyReturnLabel(orderRequestId/returnId) — createShipment with `is_return:true` (to=warehouse, from=charter) + buy; store a `direction='return'` carrier_shipments row; idempotent via the new unique index. A "Buy return label" action on the return detail.

## Task B3: QBO credit memo on return.closed
- [ ] On close(), publish `return.closed` to the outbox (publish_outbox). Extend quickbooksConnector: add 'return.closed' to subscribedTopics; handleOutboxEvent builds a QBO CreditMemo (mirror the Bill builder; uses settings.accountIds.returnCredit) and posts it; map return→CreditMemo.Id via connection_mappings (entity_type='return'); requestid idempotency `return-<id>`. Add a `returnCredit` field to the Integrations account-mapping form.

## Task B4: Requester-initiated return portal
- [ ] Public `/returns/request/[token]` page (token = order_requests.return_token) — unauthenticated; loads the order's returnable lines; requester picks lines + reason; honeypot + 0048 rate-limit; creates a `source='requester'` return in `requested` status → staff approval queue. Email the return-request link to the requester when the order completes (reuse the email/template infra). Staff approve in the existing returns UI.

---

# NOTIFICATIONS — gap-fill (separate small batch; infra already exists)
1. **Missing event triggers:** the order trigger covers approved/denied/packaging/ready_for_delivery/delivered/cancelled but NOT `in_transit` or the newer `completed` (and 14-status names). Add/extend the trigger to notify on `in_transit` + `completed`. *(small)*
2. **PO-received notification:** `receipt.posted` is published to the outbox but no notification row is created on PO receive. Add a writer (trigger on receipts insert, or in receiving.ts) that notifies the PO creator + recipients. *(small)*
3. **Preferences UI:** `notification_preferences` (mute toggles) + the order-pref columns (0113) have NO settings page — `/dashboard/settings/notifications` is referenced but missing. Build it (per-section email/push mute toggles). *(small-medium)*
4. Verify the order-pref columns (0113: email_order_received, etc.) are honored by the triggers/digest. *(small)*

## DoD (per phase)
- tsc clean (core/web/mobile as touched); web + core vitest green; migrations apply on a copy; module grandfathered OFF; org-scoped + permission-gated; public portal rate-limited + honeypot; no WIP committed.
