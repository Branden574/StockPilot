# StockPilot integrations — credential setup walkthrough

How to get every credential for the 5 free integrations. "Free" = no license fees; each provider still needs a developer account **you** (the account holder) create. Work top‑to‑bottom; **start Amazon first** — its approval is the slowest.

For each provider you'll end up with one or two values. **Send those to me and I flip the connector live** (each is built to the "credential wall," same as QuickBooks/Sage).

Callback/redirect URLs all follow the pattern `https://stockpilotusa.com/api/integrations/<provider>/callback`.

---

## 0. Amazon SP‑API — *start this first (slowest approval)*

1. You need a **Professional Amazon Seller Central** account (or a standalone developer registration).
2. Seller Central → **Apps & Services → Develop Apps**.
3. Click **Register as a developer** → accept the Amazon Developer Agreement and fill in the business + data‑security questionnaire. **This review can take several days to a couple of weeks** — that's why it's first.
4. Once approved → **Add new app client**:
   - App name: `StockPilot`
   - OAuth Login URI: `https://stockpilotusa.com/api/integrations/amazon/login`
   - OAuth Redirect URI: `https://stockpilotusa.com/api/integrations/amazon/callback`
   - Roles: **Inventory and Order Tracking** (avoid PII/restricted roles unless needed — they require extra approval).
5. Copy the **LWA client ID** and **LWA client secret**.
6. **Send me:** LWA client ID + client secret (+ which marketplace, e.g. US).

---

## 1. Zapier — publish the StockPilot app (one‑time)

Zapier is the reverse of the others: there's no Zapier "credential" to paste into StockPilot. Instead each user creates a **StockPilot API key** and pastes *that* into Zapier.

**A. Publish the app (one‑time, needs your Zapier account):**
1. Create a free account at **zapier.com**.
2. Install the CLI: `npm install -g zapier-platform-cli`
3. From the repo: `cd integrations/zapier && npm install`
4. `zapier login` (uses your Zapier account)
5. `zapier register "StockPilot"` then `zapier push`
6. Share the **private app invite link** with your team now; submit for **public listing** later (Zapier reviews public apps).

**B. Each user connects (no dev account needed):**
1. In StockPilot → **Settings → Integrations → API keys → Create key**.
2. Tick **Manage automation webhooks** (required) + the read scopes their Zaps use. Copy the `sk_live_…` key (shown once).
3. In Zapier → add a **StockPilot** connection → paste the key. Done — build Zaps.

> **Make / n8n** work today with *no* account: point a Make "Custom webhook" or an n8n "Webhook" node's URL at us via `POST /api/public/v1/hooks`, or read with the HTTP module using the API key.

---

## 2. PrintNode — label printing (simplest, ~1 day to live)

1. Sign up at **printnode.com** (free tier).
2. Download + install the **PrintNode client** on the computer attached to your label printer (Zebra/Dymo/etc.). It auto‑registers the printer.
3. PrintNode dashboard → **API Keys → Create API Key**. Copy it.
4. **Send me:** the PrintNode **API key**. (Then in StockPilot → Settings → Integrations → PrintNode you'll pick which printer gets pick/pack/receiving labels.)

---

## 3. Xero — accounting (alongside QuickBooks/Sage)

1. Go to **developer.xero.com** → sign in (free Xero developer account).
2. **My Apps → New app**:
   - App name: `StockPilot`
   - Integration type: **Web app**
   - Company or application URL: `https://stockpilotusa.com`
   - Redirect URI: `https://stockpilotusa.com/api/integrations/xero/callback`
3. Copy the **Client ID**, then **Generate a secret** and copy the **Client Secret**.
4. **Send me:** Xero **Client ID** + **Client Secret**. (StockPilot then runs the "Connect to Xero" OAuth handshake; you approve it once in Xero.)

---

## 4. Shopify — order source (for clients who also sell online)

1. Create a free **Shopify Partner** account at **partners.shopify.com**.
2. **Apps → Create app → Create app manually**:
   - App name: `StockPilot`
   - App URL: `https://stockpilotusa.com`
   - Allowed redirection URL: `https://stockpilotusa.com/api/integrations/shopify/callback`
3. In the app's **API access / Configuration**, set scopes: `read_orders`, `read_products`, `read_inventory` (+ `write_inventory` if we'll push counts back).
4. Copy the **Client ID (API key)** and **Client secret**.
5. **Send me:** Shopify **Client ID** + **Client secret**. (For a single store, a custom app created inside that store's admin works too — same two values.)

---

## Where each lands in StockPilot

| Provider | You send me | Goes into |
|---|---|---|
| Amazon SP‑API | LWA client ID + secret (+ marketplace) | Amazon connector (OAuth) |
| Zapier | *(nothing — you publish the app; users paste a StockPilot API key)* | Zapier app + API keys panel |
| PrintNode | API key | PrintNode connector |
| Xero | Client ID + secret | Xero connector (OAuth) |
| Shopify | Client ID + secret | Shopify connector (OAuth) |

All secrets are stored in StockPilot's encrypted **secret store** (the same one QuickBooks/Sage use) — never in plaintext, never in the repo.

---

### EDI (850/856/940/945) — the big one, separate track
EDI needs either an **EDI broker account** (e.g. **Stedi** — usage‑based, free dev tier) or a trading partner's **AS2/SFTP** details. It's a multi‑week build (X12 parse/generate + transport + mapping to our PO/receiving/shipping). We'll scope it on its own once the five above are moving.
