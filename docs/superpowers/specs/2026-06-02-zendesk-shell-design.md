# Zendesk Integration — Shell (Phase 1) design

**Date:** 2026-06-02
**Status:** approved (owner picked: new `zendesk` module + real logo + connector+handler+clean-seam triggers, 2026-06-02). Builds on the existing connector framework (migrations 0146–0148).

## Goal
Wire a **dormant** Zendesk integration that activates the moment an org pastes its API token. Ship: a gated, off-by-default **`zendesk`** module with a **nav item bearing the Zendesk logo** → an in-app Zendesk page (connect/status now; the full agent console is Phase 2). A **`zendesk` connector** on the existing outbox/connector framework creates Zendesk **tickets** from StockPilot events (the triggers with clean seams). Admin on/off via the module; nothing fires until a token is connected.

## What exists (reuse — verified)
- **Connector framework** (migrations 0146–0148): `CONNECTOR_REGISTRY` (`packages/core/src/connectors/registry.ts`), `Connector`/`ConnectorMeta`/`OutboxEvent`/`PushResult`/`ConnectorDeps`/`ConnectorSecrets` (`packages/core/src/connectors/types.ts`), the outbox drainer (`apps/web/src/server/connectors/drainer.ts` + `/api/cron/drain-outbox`), `connector_drain_candidates` RPC (routes one `outbox_events` row to each active connection whose `subscribedTopics` include the topic), the Vault secret store (`apps/web/src/server/connectors/secret-store.ts` → `connector_secret_put/get/delete`), and `ConnectionsService` (`apps/web/src/server/services/connections.ts`).
- **`org_connections`** table (migration 0146): `provider_id text not null` — **NO CHECK constraint enumerating providers**, so `'zendesk'` rows need no schema change. Columns: `organization_id, provider_id, status('pending'|'active'|'error'|'disconnected'), external_account_id, settings(jsonb), secret_id, oauth_state, created_by, last_connected_at, last_synced_at, last_error`. UNIQUE `(organization_id, provider_id)`.
- **Outbox emit** = `supabase.rpc('publish_outbox', { p_org_id, p_topic, p_aggregate_type, p_aggregate_id, p_payload, p_dedupe_key })` (best-effort; see `returns.ts` `publishReturnClosed`).
- **`publish_outbox`** today fires `receipt.posted` (receiving.ts) + `return.closed` (returns.ts). QuickBooks subscribes only to those two → new Zendesk topics will NOT cross-route to QBO.
- **`integrations:manage`** permission exists (owners/admins) — reused as the Zendesk connect/disconnect gate (no new Permission, no RLS change).
- **Module registry** (`packages/core/src/modules/registry.ts`): `ModuleId` union + `MODULE_REGISTRY` + `NavPlacement` (web_sidebar placements drive the sidebar). `seed_org_modules()` grandfather pattern (migrations 0161–0164). Nav icon strings → lucide components in `apps/web/src/components/dashboard/icons.ts` (`NAV_ICONS`).
- **Trigger seams (verified):**
  - *returns/RMA* → `returns.ts` `createFromOrder` (service, has ctx) — emit `return.created`.
  - *public requests* → `apps/web/src/app/api/v1/public/order-requests/route.ts` (admin client; header insert `source:'public_link'` ≈ line 446–467, lines insert ≈ 485) — emit `public_request.created` after a successful submit.
  - *order problems* → `order-requests.ts` `deny(id, reason)` (≈ line 1316) — emit `order.problem`.
  - *critical alerts* → **FOLLOW-UP** (no clean outbox seam; the notifications system is separate). Flagged, not built in the shell.

## Decisions (locked)
1. **New `zendesk` OPTIONAL module** (migration 0165, grandfathered OFF, `defaultOnFor []`). Own nav item + own admin on/off. Self-contained — does NOT require the `integrations` module.
2. **Real Zendesk logo** as the nav icon (custom SVG component compatible with the `LucideIcon` props shape, registered in `NAV_ICONS` under key `'Zendesk'`).
3. **Connector + REST ticket handler + the 3 clean-seam triggers** (`return.created`, `public_request.created`, `order.problem`). Critical-alerts trigger = follow-up. Inbound webhooks = Phase 2.
4. **Push-only connector** (`modes: ['push']`); Zendesk auth = an **API token** (Basic `base64(email/token:apiToken)`), stored in Vault. Inbound webhook ingest deferred to Phase 2.
5. **Connect surface = the Zendesk page itself** (not Settings → Integrations), so the feature is fully self-contained under the `zendesk` module. The connect form shows to `integrations:manage` holders; the page is visible to any org role when the module is on (the agent console is for staff).

## Data model — migration `0165_zendesk_module.sql`
- Grandfather `zendesk` OFF for existing orgs + append it to `seed_org_modules()` (byte-identical to 0164 + one row `('zendesk','optional', false)`).
- **No new tables** — Zendesk rides `org_connections` + `connection_mappings` (already exist; `provider_id` is free-text). The outbox topics are runtime strings; no schema.

## Components & boundaries

### Core (`packages/core`)
- `connectors/types.ts`: add `'zendesk'` to `ConnectorProviderId`.
- `connectors/registry.ts`: add `zendesk` `ConnectorMeta` — `{ id:'zendesk', title:'Zendesk', modes:['push'], subscribedTopics:['return.created','public_request.created','order.problem'], requiresModule:'zendesk' }`.
- `modules/registry.ts`: add `'zendesk'` to `ModuleId`; add a `MODULE_REGISTRY.zendesk` entry — `{ id:'zendesk', tier:'optional', title:'Zendesk', dependsOn:[], permissions:['integrations:manage'], surfaces:['web'], apiPrefixes:[], ownsTables:[], defaultOnFor:[], placements:[ web_sidebar item: section 'tools', label 'Zendesk', href '/dashboard/zendesk', iconName 'Zendesk', a sort order after the other tools, no `requires` ] }`. (`dependsOn:[]` — the connector framework tables it uses are owned by `integrations`/0146 which already exist for every org regardless of module state.)

### Web — Zendesk REST client (`apps/web/src/server/connectors/zendesk/client.ts`)
A thin fetch wrapper mirroring `EasyPostClient`. Constructed with `{ subdomain, email, apiToken }`. Auth header `Basic base64(`${email}/token:${apiToken}`)`. Base `https://{subdomain}.zendesk.com/api/v2`. Methods: `validateToken()` (GET `/users/me.json`; throws `ZendeskApiError(status)` on non-2xx) and `createTicket({ subject, body, tags, requesterName?, requesterEmail?, priority? })` (POST `/tickets.json` → returns the new ticket id). The token is only ever in the header, never logged/thrown.

### Web — connector impl (`apps/web/src/server/connectors/zendesk/index.ts`)
`zendeskConnector: Connector` — `id:'zendesk'`, `modes:['push']`, `subscribedTopics:[…3…]`, `handleOutboxEvent(event, conn, secrets, deps)`: builds a ticket from the topic (subject/body/tags/priority + requester from the payload), constructs `ZendeskClient` from `secrets.accessToken` (apiToken) + `conn.settings.subdomain`/`.email`, calls `createTicket`, returns `{ ok:true, externalId: ticketId }`; a 4xx (bad request) → `{ ok:false, retryable:false, error }` (dead-letter, don't spin), a 5xx/network → `{ ok:false, retryable:true, error }`. Registered in `apps/web/src/server/connectors/index.ts` `CONNECTORS`.

### Web — connect/read (extend `ConnectionsService`)
- `connectZendesk({ subdomain, email, apiToken })`: gate `assertModuleEnabled(this.ctx,'zendesk')` + `assertPermission(this.ctx,'integrations:manage')`; validate via `ZendeskClient.validateToken()` (bad → `validation_error`); `putConnectionSecret` with `{ accessToken: apiToken, refreshToken:'', expiresAt:'' }`; upsert `org_connections` (provider_id `'zendesk'`, status `'active'`, `settings:{ subdomain, email }`, `external_account_id: subdomain`); audit `integration.connected`. Mirrors `connectApiKey` (separate method because that one is hardwired to `easypost`/`shipping`).
- `getZendeskConnection()`: gate `assertModuleEnabled('zendesk')`; read the org's `org_connections` row where `provider_id='zendesk'` → `{ status, subdomain, lastConnectedAt, lastError } | null`. Member-level read (RLS).
- `disconnect('zendesk')` already works for any provider — but it gates on the easypost/integrations branch; add a `zendesk` branch (module `zendesk` + `integrations:manage`) so disconnect is consistent.

### Web — actions (`apps/web/src/server/actions/zendesk.ts`)
`connectZendeskAction({subdomain,email,apiToken})` + `disconnectZendeskAction()` — `'use server'`, zod-validated, `ok`/`err`/`ServiceError` pattern, `revalidatePath('/dashboard/zendesk')` on success.

### Web — the Zendesk page (`apps/web/src/app/(dashboard)/dashboard/zendesk/page.tsx`)
RSC. `checkModuleAccess('zendesk')` → `ModuleNotEnabled` if off. Loads `getZendeskConnection()`. Renders: a header with the Zendesk logo; a **status card** (Connected to {subdomain} · last connected … / Not connected / Error: …); a **connect card** (`ZendeskConnectCard` client island: subdomain + agent email + API token inputs → `connectZendeskAction`; Disconnect when active) shown only to `integrations:manage` holders; and a **"Agent console — arriving next"** stub describing what Phase 2 brings. The page is the home of the nav logo.

### Web — trigger emits (additive, best-effort)
- `returns.ts` `createFromOrder`: after the return is created, `publish_outbox` `return.created` (`p_aggregate_type:'return'`, payload `{ returnId, returnNumber, orderRequestId, requesterEmail?, reason? }`, dedupe `return.created:{id}`).
- public POST route: after a successful submit, `admin.rpc('publish_outbox', …)` `public_request.created` (payload `{ orderRequestId, requesterEmail, requesterName, status }`, dedupe `public_request.created:{id}`). (Caveat: fires on submit, before email confirmation — acceptable for v1; could move to the confirm RPC later.)
- `order-requests.ts` `deny`: after deny succeeds, `publish_outbox` `order.problem` (payload `{ orderRequestId, requesterEmail?, reason }`, dedupe `order.problem:{id}:{deniedAt}`).
All wrapped best-effort (a publish failure never fails the underlying action), exactly like `publishReturnClosed`.

### Custom nav icon
`apps/web/src/components/dashboard/zendesk-logo.tsx` — a `forwardRef<SVGSVGElement>` SVG component matching lucide's prop signature (`size`/`className`/color via `currentColor`), so it slots into `NAV_ICONS` (`Zendesk: ZendeskLogo`) without widening the type. The simplified Zendesk mark (two filled wedges) in `currentColor`.

## Security & privacy
- API token only in Vault (service-role) + the Basic header; never logged/returned to the browser. Connect/disconnect gated on `integrations:manage` (+ module). The token input is `type="password"`.
- The drainer already module-gates delivery and skips orgs with no active connection — so emitted topics are inert until a token is connected. Outbound only (no inbound webhook in the shell). Ticket payloads carry minimal, already-org-visible data (order/return ids, requester contact).

## Error handling
- Bad token at connect → `validation_error` (clear UI message), nothing persisted. Connector 4xx → dead-letter (non-retryable); 5xx/network → retryable with the drainer's existing backoff. publish_outbox failure → swallowed (best-effort). Page reads fail-closed to "Not connected".

## Testing
- Core: registry test stays green (new module + connector ids).
- `ZendeskClient`: `validateToken` (2xx ok / 401 throws) + `createTicket` (posts correct body/auth, returns id) with a mocked `fetch`.
- `zendeskConnector.handleOutboxEvent`: each of the 3 topics → correct ticket shape; 4xx → non-retryable, 5xx → retryable (mock client).
- `ConnectionsService.connectZendesk`: module-off → `module_disabled`; non-admin → `forbidden`; bad token → `validation_error`; happy → Vault put + upsert.
- `connectZendeskAction`: invalid input → failure; valid → delegates + ok.
- Emits: unit-assert each seam calls `publish_outbox` with the right topic/dedupe (where the method is unit-testable; the public-route emit verified by reasoning + a light check).

## Ship
Web merge → Vercel. **Apply migration 0165 to prod** (agent's job). No mobile → no OTA. Admin enables `zendesk` in Settings → Modules, opens the Zendesk nav item, pastes subdomain + agent email + API token → connected; the 3 triggers begin creating tickets for future events. **Phase 2 (next):** the native agent console (ticket list/views, open ticket, public+internal replies, status/priority/assignee/tags, requester + order/inventory context, search, macros, attachments) + inbound webhook (`/api/webhooks/zendesk`) + the critical-alerts trigger.
