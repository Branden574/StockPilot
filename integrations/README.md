# StockPilot integrations

External automation + connector code lives here. They all sit on the **public
API** (`/api/public/v1/*`, Bearer `sk_live_…` keys, scope-gated) and the
**automation webhook** endpoints below — no new bespoke plumbing per tool.

## Automation: Zapier / Make / n8n

All three connect the same way — they subscribe to StockPilot events and
receive HMAC-signed, SSRF-guarded deliveries from our existing event engine.

**Endpoints** (scope: `webhooks:manage`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/public/v1/hooks` | Subscribe: `{ target_url, event_types: [...] }` → `{ id, secret, event_types }` |
| `GET` | `/api/public/v1/hooks` | List this org's automation webhooks |
| `DELETE` | `/api/public/v1/hooks/:id` | Unsubscribe (idempotent) |

**Event types:** `stock.low`, `order.created`/`approved`/`denied`/`in_transit`/`cancelled`/`status_changed`/`completed`, `po.created`/`updated`/`received`/`cancelled`, `return.created`/`approved`/`closed`/`denied`, `cycle_count.completed`.

**Delivery:** each event POSTs `{ id, event, organization_id, data: {...} }` to the
`target_url`, signed `X-StockPilot-Signature: t=<unix>,v1=<hmac-sha256(secret, "t.body")>`
(the `secret` returned at subscribe). Verify it before trusting a payload.

### Zapier
Full Platform CLI app in [`zapier/`](./zapier) — instant triggers + Find Item search. See its README to publish.

### Make (Integromat)
No app needed to start: in Make, add a **Custom webhook** module → copy its URL →
`POST /api/public/v1/hooks { target_url: <make url>, event_types: [...] }` (or use
the HTTP module with the API key). A first-class Make app can wrap this later.

### n8n
Use an **n8n Webhook** node as the `target_url`, or the **HTTP Request** node with
`Authorization: Bearer sk_live_…` to read (`GET /items|/orders|/purchase-orders`)
and subscribe. Self-hosted n8n needs no account.

## Connectors (to the credential wall)

Built on the connector framework (`apps/web/src/server/connectors`): each is ready
and flips live when its credentials are added.

- **QuickBooks Online** — live (PO push).
- **Sage** (Intacct + 50 CSV) — live to the credential wall.
- **EasyPost** — multi-carrier shipping (USPS/UPS/FedEx/DHL).
- **PrintNode / Xero / Shopify / Amazon SP-API** — see each connector's folder.
