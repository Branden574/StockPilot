# Connectors / Integrations Triage Runbook

Operator guide for diagnosing connector sync failures (QuickBooks Online export,
EasyPost shipping) and recovering stuck shipments.

## Architecture in one paragraph

StockPilot writes domain events to a transactional outbox (`outbox_events`). A
Vercel Cron route (`/api/cron/drain-outbox`, every 5 min — see
`apps/web/vercel.json`) runs the **drainer** (`apps/web/src/server/connectors/
drainer.ts`), which fans each event out to every active connector. Delivery is
tracked per `(connection_id, outbox_event_id)` in **`connection_sync_log`** so
multiple connectors can each consume the same event independently. The drainer
NEVER touches `outbox_events.published_at`.

## When a sync fails

The drainer is fail-closed and retries with deterministic exponential backoff
(`nextBackoff`). Each failed delivery increments `attempts`; after
`MAX_ATTEMPTS = 8` (or immediately if the connector returns `retryable: false`
for a permanent 4xx) the row is **dead-lettered**: `connection_sync_log.status =
'dead'`, `next_attempt_at = null` — it will never retry on its own.

### Dead-letter view + replay (Settings -> Integrations)

The operator surface is in **Settings -> Integrations**. It lists this org's
failed rows (`connection_sync_log.status in ('error','dead')` via
`ConnectionsService.listFailed`) with the `last_error`. This is an
application-level surface, not a Postgres VIEW.

To retry a failed/dead row, click **Replay** in that panel (or
`POST /api/v1/integrations/sync-log/{id}/replay`). Replay resets the row to
`status='pending'`, `attempts=0`, `next_attempt_at=null` so the next drainer tick
re-picks it. Gated to org admins (`integrations:manage` OR `shipping:manage`) and
org-scoped by the 0152 RLS policy. Before replaying, fix the root cause
(reconnect a revoked token, fix a bad mapping) or it will just dead-letter again.

### Triage checklist

1. Open Settings -> Integrations, read `last_error` on the failed row.
2. Auth error (401/expired)? -> reconnect the provider (re-run OAuth). See token
   notes below.
3. Module disabled? The drainer skips any org whose `integrations` module is off
   (`organization_modules`, fail-closed). Re-enable in Settings -> Modules; the
   drainer auto-resumes with no reactivation logic.
4. Connection missing `secret_id`? The drainer reports and skips it — the OAuth
   flow didn't complete; reconnect.
5. After fixing, click Replay. Confirm it goes `pending -> success` within a few
   ticks (~5 min cadence).

## Token-refresh behavior

- **QuickBooks Online (OAuth):** the drainer refreshes the access token when it
  expires within 5 minutes, calls `connector.refreshAuth`, and re-persists to
  Vault via `putConnectionSecret`, writing the (possibly new) Vault id back to
  `org_connections.secret_id`. QBO **rotates the refresh token on every refresh**
  — the new `refresh_token` from the response is what gets stored. If the app is
  idle past Intuit's refresh-token lifetime, the refresh fails and the user must
  reconnect. Tokens are never logged.
- **EasyPost (shipping):** uses a STATIC API key (HTTP Basic, key as username,
  empty password), read only from Vault. There is no token refresh / rotation —
  if EasyPost auth fails it's a bad/rotated key, not an expiry; update the key in
  Vault.

## Stuck shipments

A shipment can strand in `status='purchasing'` if a crash or serverless timeout
hits between the EasyPost buy claim and the finalize. The 0150 partial unique
index then blocks every future buy for that order until it is reconciled.

- **Reaper cron:** `/api/cron/reap-stuck-shipments` (hourly — `vercel.json`).
  It finds every `carrier_shipments` row stuck in `'purchasing'` for more than
  `STALE_MINUTES = 30` across all orgs and reconciles each against EasyPost:
  a completed (charged) buy is finalized to `'purchased'`; one that never
  completed is reset to `'draft'` so the order can be re-bought. It **never
  re-buys** — it only GETs the EasyPost shipment. Per-row isolation: one org's
  failure can't block the rest. Auth is `Bearer ${CRON_SECRET}` (fail-closed).
- **Manual reconcile:** `POST /api/v1/orders/{id}/shipping/reconcile` does the
  same reconcile for a single order on demand (gated `shipping` enabled +
  `shipping:manage`). Use it when an operator can't wait for the hourly reaper.
  Returns `{ shipment }`, or `{ shipment: null }` when the stranded row was reset
  to `'draft'`.

## Key files

- `apps/web/src/server/connectors/drainer.ts` — drain orchestrator, backoff,
  dead-letter.
- `apps/web/src/server/services/connections.ts` — `listFailed` / `replaySync`.
- `apps/web/src/app/api/cron/drain-outbox/route.ts` — cron entry (5 min).
- `apps/web/src/app/api/cron/reap-stuck-shipments/route.ts` — reaper (hourly).
- `apps/web/src/app/api/v1/integrations/sync-log/[id]/replay/route.ts` — replay.
- `apps/web/src/app/api/v1/orders/[id]/shipping/reconcile/route.ts` — manual
  reconcile.
