# Competitive scan: StockPilot (US, WMS) vs Stockpilot.com (NL, e‑commerce)

**Date:** June 2026 · **Focus:** WMS integrations — what they have, what we can add for free, and how we pull 10× ahead in *our* lane.

---

## TL;DR

- **They are not in our lane.** Stockpilot.com (Netherlands, bootstrapped, "Software for multichannel sellers") is a **multichannel e‑commerce sync** tool. Their ~**112 integrations are overwhelmingly sales channels** — webshops (Shopify, WooCommerce…), marketplaces (Amazon, bol.com, Zalando, Otto, Kaufland, Temu, TikTok Shop…), shipping carriers, accounting, and payment providers. Most are **EU‑specific and irrelevant to a US WMS**.
- **For a WMS, the integration count that matters is small** — accounting/ERP, shipping carriers, label hardware, an automation hub, and (the real differentiator) **EDI**. We already have the hard part built.
- **The "112 integrations" gap is an illusion of effort, not capability.** We already shipped the **integration platform** (public REST API, HMAC webhooks + event engine, an outbox/drainer, and a connector framework with QuickBooks, Sage Intacct, EasyPost, Zendesk). Adding connectors is incremental — and **almost every relevant API is free to build against** (OAuth dev programs, no licensing cost).
- **One move (Zapier/Make/n8n) leapfrogs their entire catalog** by exposing our existing API + webhooks to **8,000+ downstream apps** for near‑zero build cost.
- **We already beat them on everything WMS:** full receiving lifecycle, returns/RMA, cycle counts, lot/serial, pick + signature, warehouse‑scoped multi‑tenant RLS, three real AI features (assistant, shelf‑scan, PO‑import), a native mobile app, and **no per‑user fees** (~$1k/yr infra vs their order‑volume pricing that taxes growth).

---

## 1. Who they are

| | Stockpilot.com (NL) | Our StockPilot (US) |
|---|---|---|
| Category | Multichannel **e‑commerce seller** software | Operational **WMS / inventory platform** |
| Core promise | "All your commerce operations, finally in sync" across sales channels | Run a real warehouse: receive, count, pick, ship, reorder, report |
| Pricing | **Order‑volume:** €79/mo (≤500 orders) → €549/mo (≤10k), + €0.06–0.09 per extra order | **No per‑user, no per‑order fees** — ~$1,000/yr flat infra |
| Mobile | Barcode on a mobile device (web/PWA) | **Native iOS/Android app** (scan, count, adjust, real‑time) |
| AI | AI demand **forecasting** only | **Assistant** (NL chat over real data) + **shelf‑scan** (photo→count) + **PO import** (invoice→draft) + forecasting/insights |
| Extensibility | REST API + "Elements" add‑ons | Public REST API + **HMAC webhook event engine** + connector framework |
| Reach | EU sellers | US (charter schools, distribution, 3PL, multi‑industry) |

Their whole reason to exist is *channel sync*. Ours is *warehouse operations*. The overlap is the integration **plumbing** — which we've already built.

---

## 2. Their 112 integrations, categorized — and what's WMS‑relevant

| Their category | Examples | Relevant to a WMS? |
|---|---|---|
| **Webshops** (~15) | Shopify, WooCommerce, Magento, BigCommerce, PrestaShop, Wix, Squarespace, Ecwid, Shopware, Lightspeed, CCV Shop, Mijnwebwinkel | **Secondary** — only as an *order source* for WMS customers who also sell online |
| **Marketplaces** (~50) | Amazon, eBay, Etsy, Walmart, TikTok Shop, Temu, Faire, Zalando, bol.com, Kaufland, Otto, Allegro, Cdiscount, Fnac, Rakuten… | **Mostly N/A** — EU‑specific channels; a few (Amazon/eBay/Etsy/Walmart) matter if a WMS client fulfills online |
| **Shipping carriers** (~20) | DHL, DPD, FedEx, GLS, PostNL, UPS, Sendcloud, ShipStation, Easyship, MyParcel, Shippo‑style | **Yes** — core WMS. *We already cover this with EasyPost (one connector → USPS/UPS/FedEx/DHL + 100s more).* |
| **Accounting/ERP** (~15) | QuickBooks, Exact, Twinfield, Moneybird, SnelStart, AFAS, Visma, SAP Business One, Odoo | **Yes** — cost/valuation sync. *We have QuickBooks + Sage Intacct.* |
| **Payments** (~5) | Stripe, Mollie, SumUp | **Low** — payments belong to the storefront, not the WMS |
| **Automation / dev** | **Zapier**, REST API, PrintNode | **Yes — highest leverage.** *We have the API + webhooks; Zapier itself is unbuilt.* |
| **WMS/MCF hand‑off** | Monta WMS, Picqer, Lyra WMS, "send orders to WMS/MCF" | They *send to* WMS systems — i.e. **a WMS like us is their downstream**, not their competitor |

**The honest read:** strip out the EU channels and payments, and their WMS‑relevant integration set is **~10–15 things** — and **we already have or trivially cover most of them.**

---

## 3. What we already have (grounded in the codebase)

- **Integration platform:** public REST API (`/api/v1/items`, `/orders`, `/purchase-orders`, scope‑gated API keys), **20 webhook event topics** (`order.*`, `po.*`, `return.*`, `cycle_count.completed`, `stock.low`, `security.*`), an SSRF‑hardened HMAC webhook engine + outbox/drainer, and Slack/Teams alerts.
- **Connectors:** QuickBooks Online (PO push), Sage Intacct + Sage 50 CSV migration, **EasyPost** (multi‑carrier shipping — rate‑shop, buy label, tracking), Zendesk.
- **Connector framework + secret store** already exist (so each new connector is "fill in the API calls," not "build the plumbing").

## 4. What we lack (WMS‑relevant) — all addable for **free**

Every item below has a **free developer program** — the cost is build time, not licensing, and our event engine + API means the plumbing is done.

| # | Integration | Why it matters for a WMS | Effort | Cost |
|---|---|---|---|---|
| 1 | **Zapier + Make + n8n** | One build → **8,000+ apps** (Sheets, Slack, Gmail, Salesforce, Airtable, HubSpot…). Instantly *exceeds* their 112. Sits on our existing API + webhooks. | **S** (we have the API/webhooks) | Free |
| 2 | **EDI (850/856/940/945)** | The real WMS/3PL/distribution differentiator — trading‑partner PO/ASN/warehouse‑shipping docs. **They don't have this.** Build via a modern EDI broker (e.g. Stedi) or native X12. | **L** | Free dev / usage‑based |
| 3 | **Xero** | Completes "all major accounting" alongside QuickBooks + Sage. | **M** | Free dev |
| 4 | **PrintNode (label printing)** | Push pick/pack/receiving + barcode labels straight to networked label printers (Zebra/Dymo). Core WMS hardware glue. | **S–M** | Free tier |
| 5 | **ShipStation / Shippo** | Order‑shipping hubs that complement EasyPost; common in US fulfillment. | **M** each | Free dev |
| 6 | **Amazon SP‑API, Shopify, eBay, Etsy, Walmart, TikTok Shop** | *Order sources* for WMS clients who fulfill online — inbound orders → our pick/pack/ship. (Amazon SP‑API was already our planned P5.) | **M** each | Free dev (OAuth) |
| 7 | **NetSuite / Dynamics 365 / SAP B1 (light)** | Enterprise ERP stock/cost sync for larger 3PL/distribution clients. | **L** each | Free dev sandbox |

**Strategy:** don't chase 112 EU connectors. Ship **#1 (Zapier/Make/n8n)** to instantly out‑reach them, then **#2 (EDI)** to lead where they're absent, then **#3–#6** as first‑class connectors driven by real customer demand.

---

## 5. Where we already win (the 10× story, WMS lane)

| Capability | Us | Them |
|---|---|---|
| Receiving lifecycle (draft→ordered→partial/variance→received, **reversal**, lot/serial) | ✅ deep | ⚠️ basic intake |
| Returns / RMA with stock‑accurate dispositions (restock/scrap/net‑zero) | ✅ | ❌ |
| Cycle counts (selection‑scoped) | ✅ | ❌ |
| Pick + **signature capture**, warehouse‑scoped staff, multi‑warehouse/charter | ✅ | pick/pack only |
| **AI: assistant + shelf‑scan + PO‑import** | ✅ 3 features | forecasting only |
| Native mobile app (real‑time, ~250ms) | ✅ | mobile web/PWA |
| **Security:** DB‑level RLS multi‑tenant, MFA, immutable audit, restore points, auto‑archive cleanup | ✅ | unspecified |
| Public **no‑account order link**, SOP knowledge base, recurring POs, auto‑reorder | ✅ | ❌ |
| Pricing that doesn't punish growth | ✅ flat, no per‑user/per‑order | ❌ order‑volume pricing |

We're **broader and deeper on operations** and **uniquely strong on AI + security**. Their edge is purely *number of sales channels* — which a WMS doesn't need most of.

---

## 6. Recommended build order (all free, ROI‑ranked)

1. **Zapier app** (+ Make/n8n) — biggest reach per hour; turns our existing API + 20 webhook topics into thousands of integrations. *Start here.*
2. **PrintNode** — quick win, real warehouse value (label hardware).
3. **Xero** — rounds out accounting next to QuickBooks/Sage.
4. **EDI (850/856/940/945)** — the moat in 3PL/distribution; **leads where stockpilot.com is absent.**
5. **Amazon SP‑API + Shopify** — the two order sources worth first‑class connectors when a WMS client sells online.
6. **A self‑serve "Integrations" marketplace page + connector SDK** — let partners/community add connectors (their "Elements" model), so the catalog grows without our build time.

---

## 7. Naming note

Same name, different worlds: they're **NL/EU e‑commerce**, we're **US WMS** — low real‑world conflict today (different category, different continent, different buyers). If we ever expand into the EU, plan a rename then; not urgent now.

---

*Sources: stockpilot.com (homepage, /integrations [112 subpages], /pricing) scraped June 2026; our integration surface read directly from the codebase (connectors, public API routes, webhook event topics, module registry).*
