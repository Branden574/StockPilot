# StockPilot — Zapier app

A [Zapier Platform CLI](https://platform.zapier.com/) app that connects StockPilot to 8,000+ apps.

- **Auth:** StockPilot API key (`sk_live_…`) with the `webhooks:manage` scope (+ read scopes for samples).
- **Triggers (instant, REST hooks):** Purchase Order Received, Purchase Order Created, Order Created, Low Stock, Return Created. Each subscribes via `POST /api/public/v1/hooks` and is delivered by StockPilot's existing webhook engine (SSRF-guarded, HMAC-signed, retried).
- **Searches:** Find Item (by SKU/name).
- **Creates (actions):** v1.1 — pending the public write API (`inventory:write`).

## Local development

```bash
cd integrations/zapier
npm install
npm install -g zapier-platform-cli   # one-time
zapier login                          # uses your Zapier account
# Point at a non-prod deployment while developing:
export STOCKPILOT_BASE_URL="https://<preview>.vercel.app"
zapier validate
zapier test                           # if/when tests are added
```

## Publish

```bash
zapier register "StockPilot"   # first time only — creates the app in your Zapier account
zapier push                    # upload this version
zapier promote 1.0.0           # make it the public version
```

Then submit for Zapier's public-app review (or share the private invite link with users). Production base URL is `https://stockpilotusa.com` (override only via `STOCKPILOT_BASE_URL` for dev).

## How a user connects it

1. In StockPilot → **Settings → Integrations → API keys**, create a key with **Manage automation webhooks** (and the read scopes their Zaps need).
2. In Zapier, add a **StockPilot** connection and paste the key.
3. Build a Zap: pick a StockPilot trigger (e.g. *Low Stock*) → any action app (Slack, Sheets, Gmail, …).
