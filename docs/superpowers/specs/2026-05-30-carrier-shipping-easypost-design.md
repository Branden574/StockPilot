# Carrier Shipping (EasyPost) — Design

**Goal:** Generate a shipping **label** + surface **tracking** for delivery orders going to charter campuses, via **EasyPost** (multi-carrier aggregator), riding the connector framework. v1 = **manual** label purchase on the web order page (rate-shop → pick → confirm) + **read-only tracking on web and mobile**, with tracking updates arriving by **webhook**.

**Decisions (brainstorm 2026-05-30):** EasyPost aggregator; manual "Buy label" (money spent only on explicit confirm); new `shipping` module **OFF by default (opt-in)**; mobile gets **read-only tracking** in v1.

## Scope

**IN:** charter address/contact fields + edit UI; `shipping` module + `shipping:manage` perm; `easypost` connector (API-key connect via Vault — **no OAuth**); `shipments` table; `ShippingService` (rate-shop + buy label, synchronous); web order "Buy label" dialog + tracking display; EasyPost tracking webhook; mobile read-only tracking; web `/api/v1/orders/[id]/shipping*` endpoints.

**OUT (deferred):** auto-buy on status change (manual only); multi-package / international / customs / returns; per-line shipments (whole-order, one parcel); re-uploading the label PDF to our storage (store EasyPost's hosted URL); mobile buy-label (mobile is read-only tracking).

## Architecture (reuses the connector framework)

- **`shipping` module** (tier optional, `defaultOnFor: []` → grandfathered OFF) + **`shipping:manage`** permission (owner+admin) in `packages/core`.
- **`easypost` connector** in `CONNECTOR_REGISTRY` (`modes: ['webhook']`, `requiresModule: 'shipping'`, **no `oauth`** — API key only). Reuses `org_connections` (provider_id `'easypost'`, `external_account_id` null, `settings` holds non-secret config like the webhook-secret presence + test/prod mode) and the Vault `connector_secret_*` RPCs for the **EasyPost API key** (secret name `connector:<connectionId>`).
- **Connect = paste API key** (no OAuth dance): `ConnectionsService.connectApiKey(provider, apiKey, webhookSecret?)` validates the key (a cheap EasyPost call), stores it in Vault via the service-role admin client, sets the connection `active`. Surfaced on the existing **Settings → Integrations** page as an EasyPost card. Disconnect reuses the existing path (delete Vault secret + status disconnected).
- **`ShippingService` (synchronous — NO outbox/drainer)**: `getRates(orderId, parcel)` and `buyLabel(orderId, rateId)` call EasyPost directly using the Vault key. A label purchase is a user action, not an event.
- **Tracking webhook**: `/api/webhooks/easypost` (POST, `runtime nodejs`) — HMAC-SHA256 verify against the stored webhook secret (mirror the Stripe webhook's verify+idempotency shape), parse the `tracker` event, find the shipment by `easypost_shipment_id`/`tracking_code`, update `tracking_status`. No user session.
- **Gating:** every `ShippingService`/endpoint asserts `assertModuleEnabled('shipping')` + (for mutations) `assertPermission('shipping:manage')`. The webhook is signature-gated (no session/permission).

## Critical prerequisite — charter addresses

Delivery destinations are **charters**, which currently have **no address fields**. Add them + an edit UI:
- Migration: `ALTER TABLE public.charters ADD COLUMN address jsonb, ADD COLUMN contact_name text, ADD COLUMN contact_email citext, ADD COLUMN contact_phone text;` (address jsonb mirrors `WarehouseAddress`: `{line1,line2,city,state,postalCode,country}`).
- Web edit UI: a charter address/contact form (in the charters management area) so admins set each campus's mailing address. **Buy label is blocked with a clear message if the destination charter has no address.**
- Origin/FROM address: reuse `warehouses.address` (already structured) + warehouse contact.

## Data model

- **`charters`** += `address jsonb`, `contact_name text`, `contact_email citext`, `contact_phone text` (partial index on org where address not null).
- **`shipments`** (new, per-org, migration `0149`):
  `id, organization_id (fk orgs, cascade), order_request_id (fk order_requests, cascade), connection_id (fk org_connections), carrier text, service text, rate_cents int, currency text default 'USD', tracking_code text, tracking_status text, tracking_url text, label_url text, easypost_shipment_id text, easypost_rate_id text, from_address jsonb, to_address jsonb, parcel jsonb (weight_oz/length/width/height_in), status text check (draft|purchased|in_transit|delivered|returned|failure|cancelled) default 'draft', purchased_at, purchased_by (fk user_profiles), created_at, updated_at`. Unique `(order_request_id)` is NOT enforced (allow re-ship after failure) but the UI/service blocks a second active purchase. Index on `easypost_shipment_id` + `(organization_id, order_request_id)`. Canonical RLS: member read; manager write. `tg_set_updated_at` trigger.
- **`shipping` module grandfather** (migration `0149` or a sibling): NOT seeded on (OFF) — match the integrations grandfather (`enabled=false` for existing orgs) so `module_enabled` returns false + the settings UI shows a clean state; new-org trigger does not seed it.

## Flows

**Connect (web, Settings → Integrations):** admin pastes EasyPost API key (test or prod) + optional webhook secret → `connectApiKey` validates + stores in Vault → connection active. EasyPost test keys (`EZTK...`) vs prod (`EZAK...`); `settings.mode` records which.

**Buy label (web order page, delivery orders, status ≥ staged_for_delivery):**
1. Manager opens the "Buy shipping label" dialog → enters parcel weight (oz) + dims (in) [prefilled defaults editable].
2. `POST /api/v1/orders/[id]/shipping/rates` → `ShippingService.getRates`: builds from (warehouse) + to (charter) addresses, creates an EasyPost Shipment (`POST /v2/shipments`), returns the `rates[]` (carrier, service, rate, delivery_days) + the `easypost_shipment_id`. (Persist a `draft` shipment row capturing the EasyPost shipment id + addresses + parcel.)
3. Manager picks a rate → `POST /api/v1/orders/[id]/shipping/label` `{ rateId }` → `ShippingService.buyLabel`: `POST /v2/shipments/:id/buy` with the selected rate → EasyPost returns `postage_label.label_url` + `tracking_code`. Update the shipment row → `status='purchased'`, label_url, tracking_code, carrier/service/rate, purchased_at/by. **Idempotency:** if a `purchased` shipment already exists for the order, return it (no double-buy).
4. UI shows the label (download link) + tracking number/status on the order. 

**Tracking (webhook):** EasyPost posts tracker updates → `/api/webhooks/easypost` verifies HMAC → updates the shipment's `tracking_status` + `tracking_url` (and `status` in_transit/delivered). Idempotent (status is last-write-wins on the matching shipment).

**Read tracking (web + mobile):** `GET /api/v1/orders/[id]/shipping` → the shipment (carrier, tracking_code, tracking_status, tracking_url, label_url). Web order page + mobile order screen render it read-only when present.

## Endpoints

| Method + path | Purpose | Gates |
|---|---|---|
| `POST /api/v1/orders/[id]/shipping/rates` | create EasyPost shipment, return rates | module + `shipping:manage` |
| `POST /api/v1/orders/[id]/shipping/label` | buy selected rate → label + tracking | module + `shipping:manage` |
| `GET /api/v1/orders/[id]/shipping` | fetch the order's shipment (read) | module enabled (member read) |
| EasyPost connect/disconnect | via `ConnectionsService` on Settings → Integrations | module + `shipping:manage` |
| `POST /api/webhooks/easypost` | tracking updates | HMAC signature only |

`withApiContext` for the `/api/v1` routes (Bearer/cookie). EasyPost client = **raw `fetch`** (HTTP Basic with the API key as username; base `https://api.easypost.com/v2`) for consistency with the QBO connector + zero new deps — endpoints used: `POST /v2/shipments` (create+rate), `POST /v2/shipments/:id/buy` (buy). Confirm EasyPost API shapes at impl.

## Web/mobile UI

- **Web charter form:** address (line1/line2/city/state/postalCode/country) + contact fields, gated to admins, in the charters management area.
- **Web Integrations panel:** EasyPost card (paste API key + webhook secret → connect; status; disconnect) beside the QBO card.
- **Web order page (`manager-actions-panel`):** "Buy shipping label" for delivery orders post-staging → the parcel→rates→buy dialog; a tracking section (carrier, tracking #, status, label download) once purchased; "destination charter has no address" guard.
- **Mobile order screen (`app/order/[id].tsx`):** a read-only "Shipping" section (carrier, tracking #, status, tracking link) when a shipment exists, fetched via `GET /api/v1/orders/[id]/shipping`. OTA-safe (no native dep).

## Safety / correctness

- Money: a label is bought only on explicit rate selection + confirm; a `purchased` shipment blocks re-buy (idempotent); EasyPost buy is per-shipment.
- Secrets: the EasyPost API key + webhook secret live in Vault (key) / settings — never returned to a client or logged.
- Module-gate the engine: the buy/rates endpoints assert module+permission; the webhook is signature-gated. (No cron engine here — synchronous + webhook only.)
- One-way: we push label requests + receive tracking; nothing mutates inventory from EasyPost.

## Build order (two phases)

**Phase A (foundation):** (1) migration `0149` (charters address/contact + `shipments` table + `shipping` module grandfather OFF); (2) core (`shipping` module + `shipping:manage` perm + `easypost` connector registry); (3) EasyPost client + `connectApiKey`/disconnect (Vault) + Integrations EasyPost card; (4) charter address edit UI. → verify + apply migration to prod.

**Phase B (flow):** (5) `ShippingService` rates+buyLabel + `/api/v1/orders/[id]/shipping*` endpoints; (6) web order Buy-label dialog + tracking display; (7) EasyPost tracking webhook; (8) mobile read-only tracking. → verify + merge + push web + iOS OTA.

## Testing

- Service/unit: address assembly (warehouse→from, charter→to; missing-address guard), rate mapping, buyLabel idempotency (existing `purchased` → no second buy), webhook HMAC verify + shipment status update, endpoint gating (401/403/module-disabled). EasyPost HTTP mocked.
- `tsc` clean web + mobile + core.
- Manual (post-ship): connect an EasyPost **test** key, set a charter address, buy a test label on a delivery order, confirm label + tracking, fire a test webhook → status updates; confirm module-off hides the UI.

## Verify at implementation

1. EasyPost REST shapes (`/v2/shipments` create response `rates[]` fields; `/v2/shipments/:id/buy` body `{rate:{id}}` + `postage_label.label_url` + `tracking_code`; tracker webhook payload + the HMAC header name/algorithm). Use the EasyPost docs.
2. The charters management/edit surface location on web (where to add the address form) + RLS for the new charter columns (inherited by the existing charters policies).
3. `ConnectionsService` extension for an API-key connector (vs the OAuth `beginConnect`) — add `connectApiKey` without breaking the QBO path.
4. EasyPost API key validation call (cheap GET, e.g. `/v2/api_keys` or `/v2/users` — pick one that 401s on a bad key).

## Self-review
- **Placeholders:** none — tables, endpoints, gates, flows concrete; verify-at-impl are explicit checks.
- **Consistency:** reuses `org_connections`/Vault/`ConnectionsService`/module registry/withApiContext; shipments keyed to `order_request_id`; charter address is the TO source (gap closed by the migration + UI).
- **Scope:** cohesive single sub-project; decomposed into 8 tasks across 2 build phases; deferrals explicit.
