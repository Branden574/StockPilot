# Carrier Shipping (EasyPost) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Manual EasyPost shipping labels + tracking for delivery orders to charter campuses; read-only tracking on web + mobile. **Spec:** `docs/superpowers/specs/2026-05-30-carrier-shipping-easypost-design.md`.

**Branch:** `feat/carrier-shipping-easypost`. Conventions: commit per task; stage only task files (unrelated WIP — `apps/web/src/lib/email/templates.tsx`, `server/services/team.ts`, `scripts/*.mjs` — never `git add -A`); trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; `tsc` clean before commit; do NOT push or `supabase db push` (controller applies the migration + ships). Latest migration is `0148` → this adds `0149`.

**Reuses (from Phase 3a, on `main`):** `org_connections`/`connection_mappings`, Vault `connector_secret_put/get/delete` + `apps/web/src/server/connectors/secret-store.ts`, `ConnectionsService` (`apps/web/src/server/services/connections.ts`), `MODULE_REGISTRY` + `CONNECTOR_REGISTRY` + permissions (`packages/core`), `withApiContext` + `assertModuleEnabled`/`assertPermission`, the Stripe webhook (`apps/web/src/app/api/webhooks/stripe`) for the verify+idempotency shape, mobile `api()` + order screen.

---

## PHASE A — foundation

### Task 1: Migration `0149` (charter addresses + shipments + shipping grandfather)
**Files:** `supabase/migrations/0149_carrier_shipping.sql`. READ `0146_connector_framework.sql` (RLS/trigger/grant conventions), `0147_integrations_module_grandfather.sql` (grandfather pattern), the `charters` + `warehouses` + `order_requests` + `organization_modules` schemas.

- [ ] **Step 1: Write `0149`:**
  - `alter table public.charters add column if not exists address jsonb, add column if not exists contact_name text, add column if not exists contact_email citext, add column if not exists contact_phone text;` (+ partial index on `organization_id where address is not null`). (No new RLS — inherits existing `charters` policies.)
  - `create table public.shipments (...)` per the spec (id, organization_id fk orgs cascade, order_request_id fk order_requests cascade, connection_id fk org_connections, carrier, service, rate_cents int, currency default 'USD', tracking_code, tracking_status, tracking_url, label_url, easypost_shipment_id, easypost_rate_id, from_address jsonb, to_address jsonb, parcel jsonb, status text check (status in ('draft','purchased','in_transit','delivered','returned','failure','cancelled')) default 'draft', purchased_at timestamptz, purchased_by uuid references user_profiles(id), created_at default now(), updated_at default now()). Indexes: `(organization_id, order_request_id)`, `(easypost_shipment_id)`. `enable row level security`; member select (`(select public.is_org_member(organization_id))`), manager write (`(select public.has_org_role(organization_id,'manager'))`); `drop policy if exists` guards; `grant select,insert,update,delete ... to authenticated`; `tg_set_updated_at` trigger.
  - Grandfather: `insert into public.organization_modules (organization_id, module_id, enabled, tier, enabled_at) select o.id, 'shipping', false, 'optional', now() from public.organizations o on conflict (organization_id, module_id) do nothing;`
- [ ] **Step 2:** Validate SQL by careful review + grep FK targets exist. Do NOT push.
- [ ] **Step 3: Commit** `feat(db): carrier shipping schema — charter addresses + shipments + shipping module (0149)`.

### Task 2: core — `shipping` module + `shipping:manage` perm + `easypost` connector
**Files:** edit `packages/core/src/modules/registry.ts`, `packages/core/src/constants/permissions.ts`, `packages/core/src/connectors/types.ts` + `registry.ts`; extend `registry.test.ts`.
- [ ] **Step 1:** `permissions.ts` — add `'shipping:manage'` to `PERMISSIONS` + `PERMISSION_META` (mirror `integrations:manage`); ensure owner+admin get it (ALL_PERMISSIONS minus billing already covers admin).
- [ ] **Step 2:** `registry.ts` — add `'shipping'` to `ModuleId` + a `MODULE_REGISTRY.shipping` entry: `tier 'optional', title 'Shipping', dependsOn [], permissions ['shipping:manage'], surfaces ['api'], apiPrefixes ['/api/shipping','/api/webhooks/easypost','/api/v1/orders'], ownsTables ['shipments'], defaultOnFor [], placements []`. (Note `/api/v1/orders` is shared with orders — list it but it's not exclusive; or omit apiPrefixes overlap and rely on per-endpoint asserts. Prefer: apiPrefixes ['/api/webhooks/easypost'] only, to avoid clobbering orders.)
- [ ] **Step 3:** `connectors/types.ts` — add `'easypost'` to `ConnectorProviderId`; `connectors/registry.ts` — add `easypost` `ConnectorMeta` (`modes:['webhook'], subscribedTopics:[], requiresModule:'shipping'`, omit `oauth` → make `oauth` optional on `ConnectorMeta` if currently required).
- [ ] **Step 4:** Extend `registry.test.ts`: `shipping` not in `DEFAULT_MODULE_IDS`; `easypost` registry entry valid (`requiresModule==='shipping'`, has a webhook mode).
- [ ] **Step 5:** `cd packages/core && npx vitest run && npx tsc --noEmit`. Commit `feat(core): shipping module + shipping:manage perm + easypost connector`.

### Task 3: EasyPost client + API-key connect (Vault) + Integrations panel card
**Files:** create `apps/web/src/server/connectors/easypost/client.ts`; edit `apps/web/src/server/services/connections.ts` (+ actions) + `apps/web/src/components/settings/integrations-panel.tsx`. READ `connectors/quickbooks/client.ts` (fetch-wrapper idiom), `secret-store.ts`, `connections.ts` (beginConnect/disconnect to mirror), the integrations panel.
- [ ] **Step 1:** `easypost/client.ts` — `class EasyPostClient(apiKey)` over `fetch`: base `https://api.easypost.com/v2`, HTTP Basic (`Authorization: Basic base64(apiKey + ':')`), JSON; methods `createShipment(body)`, `buyShipment(id, rateId)`, `validateKey()` (a cheap GET that 401s on bad key). Throw with status on non-OK (never log the key).
- [ ] **Step 2:** `ConnectionsService.connectApiKey(provider: 'easypost', apiKey: string, webhookSecret?: string)` — assertModuleEnabled('shipping') + assertPermission('shipping:manage'); validate the key via `EasyPostClient.validateKey()`; `putConnectionSecret(admin, \`connector:\${connectionId}\`, { apiKey, webhookSecret })` (store as a `ConnectorSecrets`-compatible blob — apiKey in place of accessToken or as an extra field); upsert org_connections (provider 'easypost', status 'active', settings `{ mode: keyIsTest?'test':'production' }`); audit `integration.connected`. (Reuse the existing `disconnect` for teardown.) Add the matching server action + a `connectEasyPostAction`.
- [ ] **Step 3:** Integrations panel — add an EasyPost card: paste API key (+ optional webhook secret) → `connectEasyPostAction`; show status; Disconnect. Gate on `shipping:manage`/module like the QBO card uses integrations.
  - NOTE: this card is gated on the **shipping** module + `shipping:manage` (not integrations). Confirm the page loads both modules' connections; `ConnectionsService.list()` returns all org_connections regardless of provider — fine.
- [ ] **Step 4:** Tests: `connectApiKey` validates + stores (mock EasyPostClient + secret-store); forbidden without `shipping:manage`; module_disabled when shipping off. `cd apps/web && npx vitest run src/server/services/connections.test.ts && npx tsc --noEmit`. Commit `feat(web): EasyPost API-key connect (Vault) + Integrations card + client`.

### Task 4: Charter address edit UI (web)
**Files:** the charters management page/form + its service/action. READ the existing charters list/edit UI + `order-requests`/charters service + how warehouse address editing works (mirror it).
- [ ] **Step 1:** Add an address (line1/line2/city/state/postalCode/country) + contact (name/email/phone) section to the charter create/edit form, gated to admins. Persist to the new `charters` columns via the charters service/action (validate email; structured address jsonb mirroring `WarehouseAddress`).
- [ ] **Step 2:** Show address on the charter detail; surface a "missing address" hint where relevant.
- [ ] **Step 3:** `cd apps/web && npx tsc --noEmit` + any charter service test. Commit `feat(web): charter mailing address + contact fields (edit UI)`.

---

## PHASE B — flow

### Task 5: `ShippingService` (rates + buyLabel) + `/api/v1/orders/[id]/shipping*` endpoints
**Files:** create `apps/web/src/server/services/shipping.ts`, `apps/web/src/app/api/v1/orders/[id]/shipping/rates/route.ts`, `.../shipping/label/route.ts`, `.../shipping/route.ts` (GET) + tests. READ `order-requests.ts` (load order + delivery_charter_id + warehouse), `connections.ts` (resolve the active easypost connection + Vault key via `getConnectionSecret`), the cycle-counts `/api/v1` route pattern.
- [ ] **Step 1: Failing tests** (`shipping.test.ts`): `getRates` assembles from(warehouse)/to(charter) + throws a clear `validation_error` when the charter has no address; `buyLabel` returns the existing shipment when one is already `purchased` (idempotent, no second EasyPost buy); webhook-independent unit of address assembly. Mock `EasyPostClient` + admin/supabase.
- [ ] **Step 2: Implement `ShippingService`:** `forApiContext(ctx)`; `getRates(orderId, parcel)` — assertModuleEnabled('shipping')+assertPermission('shipping:manage'); load order (must be fulfillment_type 'delivery' + have delivery_charter_id with an address; else validation_error); resolve the active `easypost` org_connection + Vault key; `EasyPostClient.createShipment({to_address, from_address, parcel})`; upsert a `draft` shipment row (easypost_shipment_id, addresses, parcel); return `{ shipmentId, rates }`. `buyLabel(orderId, rateId)` — if a `purchased` shipment exists, return it; else `buyShipment(easypost_shipment_id, rateId)` → update row `status='purchased'`, label_url, tracking_code, carrier/service/rate_cents, purchased_at/by; return it. `getShipment(orderId)` — member read.
- [ ] **Step 3: Endpoints** — three routes mirroring `/api/v1/cycle-counts` (withApiContext → 401 guard → `ShippingService.forApiContext(ctx)` → method → ServiceError→HTTP map). `runtime nodejs`, `dynamic force-dynamic`.
- [ ] **Step 4:** `cd apps/web && npx vitest run src/server/services/shipping.test.ts src/app/api/v1/orders && npx tsc --noEmit`. Commit `feat(web): ShippingService rate-shop + buy label + /api/v1 order shipping endpoints`.

### Task 6: Web order "Buy label" dialog + tracking display
**Files:** edit `apps/web/src/components/orders/manager-actions-panel.tsx` + a new `apps/web/src/components/orders/shipping-panel.tsx` (or inline). READ the order detail page + manager-actions-panel.
- [ ] **Step 1:** For delivery orders at/after `staged_for_delivery`, show **Buy shipping label** → dialog: parcel weight(oz)+dims(in) inputs → `rates` call → rate list (carrier/service/price/days) → pick → `label` call → show label download + tracking. Block + message if the destination charter has no address (`validation_error` surfaced).
- [ ] **Step 2:** A tracking section on the order: carrier, tracking #, status, label download link, when a shipment exists (`GET shipping`).
- [ ] **Step 3:** `cd apps/web && npx tsc --noEmit`. Commit `feat(web): order Buy-label dialog + tracking display`.

### Task 7: EasyPost tracking webhook
**Files:** create `apps/web/src/app/api/webhooks/easypost/route.ts` + test. READ `apps/web/src/app/api/webhooks/stripe/route.ts` (verify + idempotency + dispatch shape) + `secret-store.ts`.
- [ ] **Step 1: Failing test:** valid HMAC + a `tracker.updated` payload → finds the shipment by `easypost_shipment_id`/tracking_code and updates `tracking_status`/`status`/`tracking_url`; invalid signature → 401/400; unknown shipment → 200 no-op. Mock crypto/admin.
- [ ] **Step 2: Implement:** `runtime nodejs`, `dynamic force-dynamic`. Read raw body; verify HMAC-SHA256 against the stored webhook secret (per-connection: look up the easypost connection + its Vault `webhookSecret`, or a single `EASYPOST_WEBHOOK_SECRET` env if simpler — prefer per-connection secret; use `timingSafeEqual`). Parse the tracker event; map EasyPost tracking status → our `tracking_status`/`status`; update the matching `shipments` row via the admin client. Return 200 on success/no-op, 400/401 on bad signature.
- [ ] **Step 3:** `cd apps/web && npx vitest run src/app/api/webhooks/easypost && npx tsc --noEmit`. Commit `feat(web): EasyPost tracking webhook`.

### Task 8: Mobile read-only tracking on the order screen
**Files:** edit `apps/mobile/app/order/[id].tsx` + add to `apps/mobile/src/lib/integrations-api.ts` (or a new `shipping-api.ts`). READ the mobile order screen + `api()` client.
- [ ] **Step 1:** `getOrderShipment(orderId)` → `GET /api/v1/orders/<id>/shipping` via `api()`.
- [ ] **Step 2:** On the order screen, a read-only **Shipping** section (carrier, tracking #, status, a tap-to-open tracking URL) shown when a shipment exists. No buy action on mobile. Gate softly (only renders if data returns; module-off/no-shipment → hidden).
- [ ] **Step 3:** `cd apps/mobile && npx tsc --noEmit` (confirm NO native dep added → OTA-safe). Commit `feat(mobile): read-only shipping tracking on the order screen`.

---

## Final verification (DoD)
- [ ] `tsc` clean: `packages/core`, `apps/web`, `apps/mobile`.
- [ ] `cd apps/web && npx vitest run src/server/services/shipping.test.ts src/server/services/connections.test.ts src/app/api/v1/orders src/app/api/webhooks/easypost` green; `cd packages/core && npx vitest run` green.
- [ ] Migration `0149` applies cleanly (controller applies to prod); `shipping` module grandfathered OFF (`module_enabled` false); shipments RLS member-read/manager-write.
- [ ] OTA-safety: `apps/mobile/package.json` unchanged.
- [ ] Manual (post-ship): connect EasyPost **test** key, set a charter address, buy a test label on a delivery order → label + tracking; fire a test tracker webhook → status updates; module-off hides shipping UI.

## Self-review
- **Spec coverage:** charter addresses + UI (T1/T4) ✓; module/perm/connector (T2) ✓; connect+client (T3) ✓; service+endpoints (T5) ✓; web buy/track UI (T6) ✓; webhook (T7) ✓; mobile tracking (T8) ✓.
- **Types/consistency:** `shipments` keyed to `order_request_id`; EasyPost key in Vault via the QBO secret-store; gating via `shipping` module + `shipping:manage`; endpoints reuse `withApiContext`.
- **No placeholders:** SQL, client methods, endpoint contracts, webhook verify are concrete; EasyPost REST shapes flagged as verify-at-impl.
