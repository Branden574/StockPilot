# Warehouse OS — Phase 3a: Connector Framework + QuickBooks Export — Design Spec

**Date:** 2026-05-30
**Status:** Approved for planning
**Parent:** Phase 3 (Integrations) of `docs/strategy/2026-05-29-stockpilot-warehouse-os-review.md`. Builds on shipped Phase 1 (module registry + entitlements) and Phase 2 (owner control plane). This is **sub-project A** of Phase 3; carriers → Amazon follow on the same framework; Square/Shopify deferred.

---

## Goal

Build a reusable, multi-connector **integration framework** and prove it with a **QuickBooks Online push-only export**: when a PO receipt posts, push a **Bill** (accounts-payable) to QuickBooks; on a monthly schedule, push an **inventory-valuation journal entry**. StockPilot remains the system-of-record for all physical stock; QuickBooks only ever *receives* financial records.

## Non-negotiable guarantees (preserve current behavior)
- **One-way export only.** No QuickBooks → StockPilot writes. No mutation of `inventory_items`, books (`item_type='book'`), quantities, or `stock_movements`.
- **No QBO Item objects.** Bill lines are account-based (GL), so QuickBooks never becomes a second inventory system-of-record.
- **Off by default.** A new entitlement-gated module, grandfathered **disabled** for existing orgs (L4L). Invisible until an owner/admin connects QuickBooks.
- **Out-of-band.** Runs on the existing transactional outbox + a cron drainer — never in the receive/stock write path. A QBO failure retries in the background and never affects the receipt or stock.

## Scope

**In scope (sub-project A):**
1. Connector framework: `org_connections`, `connection_mappings`, `connection_sync_log` tables (migration `0146`); Supabase Vault secret storage + two `SECURITY DEFINER` RPCs; a `Connector` interface + registry in `packages/core`; the outbox **drainer** cron (`/api/cron/drain-outbox`).
2. A new entitlement module `integrations` (grandfathered off) + `integrations:manage` permission; `/dashboard/settings/integrations` page + `ConnectionsService` (connect/disconnect/status).
3. QuickBooks connector (`apps/web/src/server/connectors/quickbooks.ts`): OAuth2 connect/callback/refresh; supplier→Vendor mapping; **receipt → Bill** (account-based) on `receipt.posted`; **monthly inventory-valuation JournalEntry** (delta).

**Out of scope (later sub-projects / phases):** carriers, Amazon, Square, Shopify; pull / bi-directional / webhook-ingest connectors (interface seams only, no impl); QBO→StockPilot writes; item→QBO Item sync; per-item Bill lines; an ecommerce sales-order model.

## Operational prerequisites (the user provides)
- An **Intuit Developer** account + App; **Client ID/Secret** (sandbox set for dev, production set after Intuit app review); a registered **Redirect URI** = the connector OAuth callback; the **QBO company** to connect (consent yields `realmId`); and the **QBO Chart-of-Accounts ids** to post against: the inventory-asset account, a valuation-offset account, and the expense/inventory account for Bills. Stored as server-only secrets/settings; never sent to the browser.

---

## Architecture

### Data model — migration `0146_connector_framework.sql`
All tables org-scoped; RLS per the `0012`/`0144` convention (select = `is_org_member`, write = `has_org_role`, policies wrapped `(select …)`), explicit grants to `authenticated`. The connector worker uses `createAdminClient()` (service-role, bypasses RLS) like the existing crons.

- **`org_connections`** — one row per `(organization_id, provider_id)` (UNIQUE). Columns: `id`, `organization_id` (fk, cascade), `provider_id` text (`'quickbooks'`), `status` text default `'pending'` check in (`pending`,`active`,`error`,`disconnected`), `external_account_id` text (QBO `realmId`, null until callback), `secret_id` uuid (Vault pointer, null when disconnected — **never the token**), `settings` jsonb default `'{}'` (non-secret: `{ env:'sandbox'|'production', accountIds:{inventoryAsset, valuationOffset, billExpense}, lastValuationSnapshotValue }`), `oauth_state` text (transient CSRF, cleared post-callback), `last_connected_at`, `last_synced_at`, `last_error` text, timestamps, `created_by`. Index `(organization_id) where status='active'`. **RLS: no policy exposes `secret_id`→token; it's just a UUID.**
- **`connection_mappings`** — `id`, `connection_id` (fk cascade), `organization_id` (denormalized for RLS), `entity_type` text (`'supplier'|'account'|…`), `local_id` uuid null, `external_id` text, `external_meta` jsonb (e.g. QBO `SyncToken`), timestamps. `UNIQUE(connection_id, entity_type, local_id)` and `UNIQUE(connection_id, entity_type, external_id)`. Index `(connection_id, entity_type)`.
- **`connection_sync_log`** — the per-`(connection, outbox_event)` delivery ledger (drives idempotency + retry; **NOT `outbox_events.published_at`**). Columns: `id`, `connection_id` (fk cascade), `organization_id`, `outbox_event_id` (fk → `outbox_events`, cascade), `topic` text, `status` text default `'pending'` check in (`pending`,`success`,`error`,`dead`), `attempts` int default 0, `external_id` text, `last_error` text, `next_attempt_at` timestamptz, `completed_at`, timestamps. **`UNIQUE(connection_id, outbox_event_id)`** = idempotency anchor. Index `(status, next_attempt_at) where status in ('pending','error')`. RLS select = member (settings UI shows sync health); writes by service-role worker only.

> **Why not `outbox_events.published_at`:** that single column would let one connector (or another consumer) mark an event delivered and starve the rest. The outbox stays a fan-out source; delivery state is per-`(connection, event)` in `connection_sync_log`. The outbox/producer side (`publish_outbox`, `receiving.ts:188`) is unchanged — the drainer only *consumes*.

### Secrets — Supabase Vault
Store each connection's token blob (`{ access_token, refresh_token, expires_at, realmId }`) as one Vault secret; keep only the Vault `secret_id` on `org_connections`. Two `SECURITY DEFINER` RPCs, **execute revoked from `authenticated`/`anon`, granted to `service_role` only**:
- `connector_secret_put(p_org uuid, p_secret jsonb) returns uuid` (vault create/update)
- `connector_secret_get(p_secret_id uuid) returns jsonb` (reads `vault.decrypted_secrets`)
The worker (admin client) calls these; browser/RLS clients have no path to tokens. **Verify Vault is enabled** on the project at implementation (enable via migration if needed). *Documented fallback if Vault is unavailable:* app-level AES-256-GCM with a `CONNECTOR_SECRETS_KEY` env (validated in `lib/env.ts` like `CRON_SECRET`), ciphertext column, encrypt/decrypt in a server-only `lib/connectors/crypto.ts`.

### Connector interface + registry — `packages/core/src/connectors/`
Pure types + registry (no I/O), mirroring `MODULE_REGISTRY`:
```ts
export type ConnectorMode = 'push' | 'pull' | 'bidi' | 'webhook';
export interface OutboxEvent { id; organizationId; topic; aggregateType; aggregateId; payload; dedupeKey; createdAt; }
export interface ConnectionRef { id; organizationId; providerId; status; externalAccountId; settings; }
export interface ConnectorSecrets { accessToken; refreshToken; expiresAt; [k:string]: unknown; }
export interface PushResult { ok: boolean; externalId?: string; retryable?: boolean; error?: string; }
export interface Connector {
  readonly id: ConnectorProviderId;          // 'quickbooks'
  readonly modes: ConnectorMode[];           // ['push']
  readonly subscribedTopics: string[];       // ['receipt.posted']
  handleOutboxEvent(event, conn, secrets, deps): Promise<PushResult>;
  refreshAuth?(conn, secrets): Promise<ConnectorSecrets>;
  // optional seams, UNIMPLEMENTED for QBO (YAGNI): scheduledPull?, verifyWebhook?, handleWebhook?
}
export const CONNECTOR_REGISTRY: Record<ConnectorProviderId, ConnectorMeta>; // id, title, modes, subscribedTopics, requiresModule, oauth config shape
```
Concrete impls live in `apps/web/src/server/connectors/` (server-only, import the admin client + service layer via an injected `deps`). The QBO impl implements only `handleOutboxEvent` + `refreshAuth`. Do **not** scaffold pull/bidi/webhook handlers.

### Drainer — `apps/web/src/app/api/cron/drain-outbox/route.ts`
Copy the `weekly-digest`/`purge-ai-chat-history` shape: `runtime='nodejs'`, `dynamic='force-dynamic'`, `maxDuration=60`, fail-closed `timingSafeEqual` against `Bearer ${CRON_SECRET}`, `createAdminClient()`. Add to `apps/web/vercel.json` crons at `*/5 * * * *` (5-min cadence; valuation JE is monthly, see below). Per run:
1. For each org with ≥1 `active` connection, select a bounded batch (≤200, oldest first) of `outbox_events` whose `topic ∈ connector.subscribedTopics` with **no `success` `connection_sync_log`** row (or an `error`/`pending` row with `attempts<max` and `next_attempt_at<=now()`).
2. Upsert the `connection_sync_log` row (`pending`, `attempts++`), resolve secrets via `connector_secret_get`, refresh OAuth if near expiry (`refreshAuth`, persist rotated token to Vault, **serialized per connection**), call `handleOutboxEvent`.
3. `ok` → `success` + `external_id` + `completed_at`; failure → `error` + `last_error` + `next_attempt_at = now()+backoff` (exponential + jitter, like the mobile cycle-count-sync backoff); after ~8 attempts → `dead` + `reportError`.
4. `UNIQUE(connection_id, outbox_event_id)` makes overlapping runs safe; each `(event,connection)` is wrapped in try/catch so one failure never aborts the batch. Return `{ok, processed, succeeded, failed, deadlettered}`.

### QuickBooks connector — `apps/web/src/server/connectors/quickbooks.ts`
- **OAuth2** via `intuit-oauth` (token lifecycle only): connect → callback captures `code`+`realmId`, exchanges once, writes the blob to Vault, `status='active'`. Scope `com.intuit.quickbooks.accounting`. **Token rotation:** access token 60 min; refresh token rotates ~daily and must be persisted from each refresh; refresh lazily on 401/near-expiry, serialized per connection (never two concurrent refreshes). Pin `?minorversion=75` on all API calls. Raw `fetch` for entity creates (explicit `requestid` for idempotency).
- **Supplier → Vendor mapping:** query `select * from Vendor where DisplayName = '<supplier.name>'`; if none, create `{DisplayName}`; store the `Vendor.Id` + `SyncToken` in `connection_mappings(entity_type='supplier')`.
- **Receipt → Bill** (on `receipt.posted`): `POST /v3/company/<realmId>/bill?minorversion=75&requestid=<deriv. of receipt id>`. Body: `VendorRef` = mapped Vendor; one **`AccountBasedExpenseLineDetail`** line (or per-receipt-line) to `settings.accountIds.billExpense`, `Amount = Σ(qty_accepted_base × unit_cost)` (2-dp rounded). Use only `qty_accepted_base` (rejected stock isn't billed). `requestid` tied to the receipt id (same anchor as the existing `dedupe_key 'receipt.posted:<id>'`) so retries replay the original create. Record `Bill.Id` in `connection_sync_log.external_id`.
- **Monthly inventory-valuation JournalEntry:** a separate scheduled path (the drainer cron checks, once/day, whether the org is due for a month-end snapshot — or a dedicated `*/… monthly` check). Compute total value via `ReportsService.inventoryValuation()` (`Σ qty_on_hand × unit_cost`); post the **delta** vs `settings.lastValuationSnapshotValue`: a balanced JE — Debit `inventoryAsset` / Credit `valuationOffset` (swap if delta negative), `Amount = |delta|`, `TxnDate` = period end. Never post against A/P or A/R accounts. Update `lastValuationSnapshotValue`. Idempotent via a `requestid` derived from `(realmId, 'valuation', period)`.
- **Error handling:** 401 → refresh once + retry; 429 → wait 60 s + idempotent retry (serialize per realm); 6240 duplicate → re-query. Log Intuit `intuit_tid` on every call.

### Settings → Integrations + entitlement
- New `integrations` `ModuleId` in `MODULE_REGISTRY` (tier `optional`; `surfaces:['api']`; `placements:[]` — it's surfaced via the Integrations settings page, not the main nav; `defaultOnFor: []`). New permission `integrations:manage` (owner+admin) in the permission matrix. **Grandfather migration** inserts `organization_modules(module_id='integrations', enabled=false)` for all existing orgs.
- New `/dashboard/settings/integrations/page.tsx` (gated `hasPermission(ctx.role,'integrations:manage')` → else redirect) + a settings-landing tile gated the same way. Lists QuickBooks with Connect/Disconnect + status + last-sync + recent `connection_sync_log` health.
- `ConnectionsService` (extends `Service.forCurrentUser()`/`ServiceContext`): `beginConnect(provider)` (creates `pending` row + CSRF state → returns authorize URL), `disconnect()` (deletes Vault secret, `status='disconnected'`, `audit()` — consider `assertCurrentAal2`), `status()`. OAuth callback route `apps/web/src/app/api/integrations/quickbooks/callback/route.ts` (user session verifies `state`, admin client writes Vault). `assertModuleEnabled(ctx,'integrations')` + `assertPermission(ctx,'integrations:manage')` on mutations. `audit()` connect/disconnect.

### New env (validated in `lib/env.ts`, optionalSecret pattern)
`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` (server-only); `QBO_ENV` (`sandbox`/`production`, default sandbox); `CONNECTOR_SECRETS_KEY` only if the Vault fallback is used.

---

## Testing strategy
- **Unit (core):** connector registry integrity; the `Connector`/`OutboxEvent` types compile; drainer eligibility/backoff logic (pure helper) with a fake connector — verifies idempotency (no double-deliver), retry/backoff, dead-letter.
- **Unit (QBO builders):** `buildBillFromReceipt(receiptPayload, mappings, settings)` produces the verified Bill body (VendorRef, account-based line, `Amount=Σ qty×cost`, requestid); `buildInventoryValuationJE(delta, settings)` produces a balanced JE (debits==credits, correct accounts, sign handling); supplier-match-then-create logic.
- **Integration:** drainer over a seeded `outbox_events` + `org_connections(active)` with a fake connector → writes `connection_sync_log` success; failure path → backoff/dead-letter; `UNIQUE` prevents double-delivery on re-run.
- **Auth/secrets:** `connector_secret_get`/`put` callable only by service-role (RLS/grant test); no `authenticated` SELECT path to tokens.
- **Settings:** Integrations page redirects non-`integrations:manage`; connect creates a `pending` row + state; disconnect deletes the secret + audits.
- **Sandbox e2e (manual):** connect a QBO sandbox company; post a receipt → a Bill appears; trigger a valuation snapshot → a balanced JE appears; re-drain → no duplicates.
- **Backwards-compat:** L4L with `integrations` off → no Integrations tile, drainer no-ops (no active connection), zero change to receiving/items/books.

## Suggested internal build order (for the plan)
Framework first (migration + Vault RPCs + connector interface/registry + drainer with a no-op/echo connector + `integrations` module/grandfather/permission) → Integrations settings + ConnectionsService → QBO OAuth connect/callback/refresh → receipt→Bill → monthly valuation JE. Each is a separable, testable slice; the valuation JE is the last.

## Open items to resolve during planning
1. **Verify Supabase Vault is enabled** on the project; if not, the enabling migration or the AES fallback.
2. **`intuit-oauth` dependency** add to `apps/web` (confirm license/size); raw `fetch` for entity creates.
3. **Monthly trigger mechanism**: a date check inside the 5-min drainer vs a separate dated cron — decide in the plan (lean: a `last_valuation_at` check in the drainer so we don't add a second cron).
4. **Exact `vault.*` API** (`vault.create_secret`/`vault.update_secret`/`vault.decrypted_secrets`) signatures against the installed Vault version.
5. **Production go-live** needs Intuit app review (lead time) — sandbox first.
