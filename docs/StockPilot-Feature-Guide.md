# StockPilot — Complete Feature Guide

**A detailed reference to every feature: what it is, what it's for, and how to use it.**

_Last updated: 2026-06-29 · Audience: owners, admins, staff, onboarding, support, and investors._

---

## Table of Contents

1. [What StockPilot Is](#1-what-stockpilot-is)
2. [Core Concepts (read this first)](#2-core-concepts-read-this-first)
3. [Inventory Management](#3-inventory-management)
4. [Stock & Placement](#4-stock--placement)
5. [Counting & Accuracy](#5-counting--accuracy)
6. [Orders & Fulfillment](#6-orders--fulfillment)
7. [Purchasing & Replenishment](#7-purchasing--replenishment)
8. [Rentals](#8-rentals)
9. [Procedures & Scheduling](#9-procedures--scheduling)
10. [Reports & Analytics](#10-reports--analytics)
11. [AI Features](#11-ai-features)
12. [Integrations](#12-integrations)
13. [Settings & Administration](#13-settings--administration)
14. [Platform Super-Admin Console](#14-platform-super-admin-console)
15. [The Mobile App](#15-the-mobile-app)
16. [Glossary](#16-glossary)

---

## 1. What StockPilot Is

StockPilot is a **multi-tenant inventory and order-operations platform**. It runs as a **web app** (the dashboard at `stockpilotusa.com`) and a **native mobile app** (iPhone, iPad, Mac via "Designed for iPad", and Android), sharing the same data and accounts.

**Who it's for:** any team that physically runs a warehouse, stockroom, or distribution operation — schools, apparel, food/ag, retail back-of-house, and 3PLs. It is built as a **horizontal, configurable platform**, not a single-industry tool: features are turned on and off per organization through a **module/entitlement system** (see [Modules](#modules--entitlements)), so two customers can see two very different apps from the same codebase.

**What makes it different:**
- Every quantity change is an **append-only audit ledger** entry — you can always answer "who changed this, when, and why."
- A precise **placement model** (rack / crate / staging / unplaced) so you know not just *how much* you have but *exactly where it physically sits*.
- First-class **multi-warehouse**, **multi-organization**, and **charter** (bill-to vs. ownership) support.
- Native **integrations** (webhooks, Slack/Teams, public API, QuickBooks, Sage) and **AI** (insights, chat, shelf-scan counting).

---

## 2. Core Concepts (read this first)

These ideas appear everywhere in the app. Understanding them makes every feature obvious.

### Organizations & Workspaces
An **organization** (org) is a tenant — a company's isolated data world. A user can belong to **multiple orgs**; the **workspace switcher** (top-left of the dashboard / the mobile drawer) chooses which org you're acting in. All data is strictly isolated per org (enforced at the database level).

- **How to use:** click the org name (top-left) to switch workspaces. The whole app — inventory, orders, reports — re-scopes to that org.

### Warehouses (multi-warehouse)
An org can have **multiple warehouses** (physical sites). Most screens have an **"All warehouses" filter** in the top bar; pick a warehouse to narrow everything (inventory, staging, reports) to that site.

- **Purpose:** run several sites under one org without mixing their stock.

### Charters (bill-to vs. ownership)
A **charter** is a billing/ownership entity attached to stock and purchase orders. StockPilot deliberately separates **two** charter ideas:
- A purchase order's **bill-to charter** (who's invoiced — appears on the PO's "Bill to").
- An item's **ownership charter** (who owns the stock).

These can differ — e.g., items owned by "Marconi" but billed under "CVS." Keep them independent; don't merge them.

- **Purpose:** support reseller / managed-inventory arrangements where the payer and the owner aren't the same.

### Locations & the Placement Model
Within a warehouse, stock lives in **locations**, each with a `kind`:
- **rack** / **crate** — a real, pickable shelf or bin where placed stock lives.
- **staging** — a holding buffer for stock just received from a PO, waiting to be put away.
- **unplaced** — stock that is on hand but has **never been assigned** to a rack (e.g., imported quantities, manual adjustments).

There is also a separate, **cosmetic** text field on each item called **`bin_location`** (a "home rack" *label*). **Setting the label does NOT move stock** — only a placement/transfer moves stock between locations. The two can drift apart, which is why the inventory list now reads the **RACK column from the real holdings**, not the label.

> **Golden rule:** "How much" (quantity on hand) and "exactly where" (per-location holdings) are tracked separately. The **Transfer** tool only moves *placed* (rack/crate) stock. Stock in **staging** or **unplaced** must be **placed** first.

### Roles & Permissions
Five built-in roles: **owner → admin → manager → staff → viewer**. `owner` and `admin` are "admin" roles. On top of the roles, owners/admins can **grant or revoke individual permissions** per role and per user (a permission matrix), so access is as fine-grained as you need. The owner is immutable and can't be downgraded.

### Modules / Entitlements
Almost every feature area is a **module** that can be turned **on or off** per org (Settings → Modules / Industry). This is the platform's "moat": the same app becomes a school-book tracker, an apparel stockroom, or a 3PL console depending on which modules are enabled. Modules also gate the navigation, the API, and the database rules.

### Movements (the audit ledger)
Every quantity change — receive, sell, transfer, adjust, return, scrap, count correction — writes a **stock movement** row. The ledger is **append-only and audited** (who, when, delta, resulting on-hand, note). A **transfer** shows a delta of **0** because the *total* on-hand doesn't change — only the location does.

---

## 3. Inventory Management

### Items (the catalog)
**Purpose:** the master list of everything you stock — SKUs, costs, prices, and stock levels.

**What it is:** each item has a name, SKU, barcode, category, supplier, charter, reorder point, unit cost, retail price, photos, and optional **custom fields**. Items can be **lot- or serial-tracked** with shelf-life/expiry (when the `lot_serial` module is on).

**How to use:**
- **Inventory → Items.** Search by name/SKU/barcode; filter by category, location, charter, stock status (low / out). Sort and paginate.
- The list shows a **per-rack line for each placement** — an item split across two racks appears as two lines (e.g., `1-A · 250` and `2-C · 250`), with unplaced/staged stock as their own lines. The **ON HAND** column shows the real quantity (total at item level) with a small "+N unplaced/staged" hint.
- **+ New item** to add one; **Import CSV** for bulk; open an item to edit, see its placement breakdown, movement history, photos, and cost history.
- **Inventory → Labels** prints barcode/QR labels for items.

### Books
**Purpose:** a book-specific view of inventory (the `books` module), tuned for ISBN, grade level, and crate/color storage.

**How to use:** **Books** in the nav. Add via ISBN (photo → ISBN lookup), set grade and crate color/number, and import in bulk. Books reuse the same powerful inventory table but expose book columns.

### Categories & Tags
- **Categories** (`categories` module): a single classification per item, with an optional color. Use for top-level grouping and filtering.
- **Tags** (`tags` module): many free-form labels per item for cross-cutting grouping (e.g., "fragile", "seasonal").
- **How to use:** **Categories** / **Tags** in the nav to manage them; assign on the item form.

### Bundles (kits)
**Purpose:** sell or move a **set of items as one** (a kit/assembly).

**What it is:** a bundle is a parent item composed of component items in fixed quantities. Assembling a bundle consumes components and produces bundle stock; distributing does the reverse. Bundle shortages (not enough components) are tracked.

**How to use:** **Bundles** → define components → assemble/distribute. See **Reports → Bundle activity / Bundle shortages**.

### Importing & custom fields
- **Inventory → Import** and **Books → Import**: bring items in from CSV/spreadsheets.
- **Settings → Custom fields**: define org-specific fields (text, number, etc.) that then appear on the item form and validate on save.

---

## 4. Stock & Placement

This is the heart of warehouse accuracy. (See [the placement model](#locations--the-placement-model) above.)

### Movements
**Purpose:** the complete, auditable history of every stock change.

**How to use:** **Movements** in the nav. Each row shows when, item, type (receive/sell/transfer/adjust/return/etc.), delta, resulting on-hand, who did it, and a note. Filter and page through. This is your source of truth in any dispute or audit.

### Staging & Put-away (placement)
**Purpose:** move newly received or unassigned stock onto real racks/crates so it becomes pickable and transferable.

**What it is:** the **Staging** page lists every **not-yet-placed** unit — both **staging** (received from POs, awaiting put-away) and **unplaced** (on hand but never racked) — each tagged so you can tell them apart.

**How to use:**
- **Inventory → Staging.**
- **Place a single item:** click **Place** on its row → pick an existing rack/crate or create a new one → set quantity → **Place stock**. The stock moves out of staging/unplaced into that rack and becomes transferable.
- **Place many at once (bulk):** tick the checkboxes on multiple rows → **Place selected** → choose one destination rack/crate → it places the full quantity of each selected item into that rack. (Selected items must share one warehouse.)

### Transfers
**Purpose:** move placed stock from one rack/crate to another (or split it across racks).

**How to use:** open an item → **Transfer** → choose the **From** location (only racks/crates with stock appear), the **To** location, and the quantity. The total on-hand is unchanged; the movement is logged as a **transfer** (delta 0).

> **Why a transfer can be "blocked":** if all of an item's stock is in **staging/unplaced**, there's nothing *placed* to transfer. Place it first (above), then transfer.

---

## 5. Counting & Accuracy

### Cycle Counts
**Purpose:** verify physical stock against the system and correct discrepancies — without shutting down for a full inventory.

**What it is:** a count session (`cycle_counts` module) that can be **warehouse-scoped** or **by-selection** (pick specific items/books to count). Counting writes correction movements so the ledger stays honest.

**How to use:**
- **Cycle counts → New** → choose scope (warehouse or a selection) → count each line (system qty vs. counted qty) → finalize. Variances post as movements.
- **Mobile / AI shelf-scan:** count on the floor by scanning, or use the **AI shelf scan** to count from a photo of the shelf.

### Inventory Cleanup
**Purpose:** find and resolve data hygiene problems (duplicates, orphans, mismatches). **Settings → Inventory cleanup.**

---

## 6. Orders & Fulfillment

### Orders
**Purpose:** fulfill internal or customer requests end-to-end: **request → approve → pick → pack → ship → deliver**, with proof.

**How to use:**
- **Orders → New** (or a request comes in from the requester portal). Add line items.
- **Pick** (`/orders/[id]/pick`): a pick list to pull stock; **Print** a packing slip/label.
- Capture **proof of delivery** — a **signature** and photo attachments are stored with the order.
- **Order statuses** are configurable (**Settings → Order statuses**) so the workflow matches your operation.

### Shipping & Live Tracking
**Purpose:** buy a carrier label and track the parcel.

**What it is:** the `shipping` module rate-shops carriers, buys a label, and returns tracking; the `live_tracking` module shows the order **moving on a map** in real time (web + native background tracking on mobile), updated via carrier webhooks and crons.

### Returns / RMA
**Purpose:** take stock back correctly, with a durable audit trail and money handling.

**What it is:** the `returns` module supports a return-label flow, a **requester portal** for self-service returns, QuickBooks **credit** on refund, and a strict inventory model (durable returned-quantity budget, net-zero scrap, item-identity checks). Restocked units re-enter inventory; scrapped units don't.

**How to use:** **Returns → open a return →** receive, inspect, restock or scrap. See `/returns/[id]`.

### Public Requests (requester portal)
**Purpose:** let people outside the core team submit order/return requests via a tokenized link without a full login. **Settings → Public requests** configures it (`public_requests` module).

---

## 7. Purchasing & Replenishment

### Purchase Orders (POs)
**Purpose:** order stock from suppliers and receive it cleanly.

**What it is:** a PO moves **draft → approved → in transit → received**, with **three-way matching** against receipts/counts and configurable **approval thresholds** (orders above a dollar limit need a manager's approval). The PO PDF shows a **Bill-to charter**.

**How to use:**
- **Purchase orders → New** → pick supplier + charter, add lines.
- Approve (if over threshold), mark in-transit, then **receive** — received stock lands in **Staging** for put-away.

### Recurring POs
**Purpose:** auto-generate POs on a schedule for predictable replenishment. **Purchase orders → Recurring** (`purchase_orders` module). Define a template + cadence; a cron creates the POs.

### PO Imports (scan / OCR)
**Purpose:** turn a supplier's PDF/photo PO into a StockPilot PO automatically. **Purchase orders → Imports → New** (`po_imports` module) → upload/scan → review the extracted lines → create the PO.

### Receiving
**Purpose:** record stock arriving against a PO (`receiving` module). Received quantities go to **Staging**, then you **Place** them (see [Put-away](#staging--put-away-placement)).

### Suppliers & Supplier Scorecard
- **Suppliers** (`suppliers` module): your vendor list with contacts and terms.
- **Reports → Supplier scorecard**: on-time %, fill rate, and price performance per supplier.

### Reorder Planning / Forecast
**Purpose:** know what to buy before you run out. **Planning** in the nav (`planning` module) and **Reports → Reorder forecast** project demand vs. reorder points so you can act early.

---

## 8. Rentals

**Purpose:** lend stock out and get it back, without losing track of availability.

**What it is:** the `rentals` module uses a **reserve-not-decrement** model — checking an item out **reserves** it (lowering available-to-promise) but does **not** lower on-hand, because the item physically returns. Rental items and rental orders are managed separately.

**How to use:** **Rentals → Items** to define rentable stock; **Rentals → New** to check out; the catalog shows **available** (on-hand − reserved) and **out on rental**.

---

## 9. Procedures & Scheduling

### Procedures
**Purpose:** standard operating procedures (SOPs) and training, including **video** walkthroughs, attached to your operation (`procedures` module). **Procedures → New.**

### Schedule
**Purpose:** plan and assign time-based work (`schedule` module). **Schedule → New** to create entries; open one to edit.

---

## 10. Reports & Analytics

**Reports** (`reports` / `reports_advanced` modules) turn the ledger into decisions. Available reports:

| Report | What it tells you |
|---|---|
| **Inventory valuation** | Total value of stock on hand (qty × cost), sliceable by warehouse/category/charter. |
| **Dead stock** | Items with no movement over a period — candidates to liquidate. |
| **Item cost history** | How an item's cost changed over time. |
| **Lot expiry** | Lots approaching/over expiry (lot/serial module). |
| **Lot trace** | Full forward/back trace of a lot (recall support). |
| **Reorder forecast** | Projected demand vs. reorder points — what to buy. |
| **Shrinkage** | Unexplained loss (counts vs. system). |
| **Stock movements** | The movement ledger as a report, filterable/exportable. |
| **Supplier scorecard** | Supplier on-time/fill/price performance. |
| **Velocity class** | ABC-style fast/slow movers. |
| **Bundle activity** | Assembly/distribution of kits. |
| **Bundle shortages** | Where you can't build a bundle for lack of components. |

**How to use:** **Reports →** pick a report → set the date range/filters → view or **export** (Excel/PDF/CSV).

---

## 11. AI Features

- **AI Insights briefing** (**Insights** / `ai` module): a daily, plain-language read on what needs attention — low stock, overdue POs, pending approvals. **Dashboard → Insights.**
- **AI chat** (`ai` module): ask questions about your inventory in natural language; supports attaching a **book photo → ISBN** lookup, and vector/semantic search over items.
- **AI shelf scan** (`ai_shelf_scan` module): count a shelf from a **photo** during a cycle count (mobile).

> AI is **read-only assistance** by default — it surfaces and answers, it does not silently change stock.

---

## 12. Integrations

The `integrations` module powers a webhook/event engine (`integration_endpoints` + deliveries, HMAC-signed, SSRF-hardened, retried by a cron). Configure under **Settings → Integrations**.

- **Webhooks + Slack / Teams alerts:** POST events (order.created, po.created, po.received, …) to your endpoints, or post alerts into Slack/Teams channels.
- **Public API** (`api_access` module): hashed **API keys** (Settings → Integrations → API keys) authorize scoped, read access to `/api/public/v1/{items, orders, purchase-orders}`. Great for BI tools and custom integrations.
- **QuickBooks Online:** push a PO to QBO as a PurchaseOrder when it's ordered (the outbox → connector → drainer pipeline). (Sales invoices are intentionally **not** mapped — StockPilot has no sales-invoice concept.)
- **Sage:** a **Sage 50 CSV migration kit** (zero-credential, chunked import wizard; **Settings → Migrate → Sage 50**) and a Sage **Intacct** connector. _No competitor offers native Sage of any edition — a genuine differentiator._
- **Zendesk** (`zendesk` module): support-desk integration (agent console / ticketing), gated off by default until configured.

---

## 13. Settings & Administration

Everything below lives under **Settings** (the `settings` module).

### Organization, Profile & Team
- **Organization:** org name, defaults, and org-wide preferences.
- **Profile:** your own account.
- **Team** (`team` module): invite users, assign roles, and assign **multi-charter** access per user.

### Roles & Permissions
**Settings → Roles:** the **permission matrix**. Grant/revoke individual permissions per role and per user on top of the base role. Changes apply **live** to open sessions. The owner is immutable and can't grant beyond what they hold.

### Security
**Settings → Security:**
- **MFA policy** per org: `optional`, `admins_required` (admins must enroll TOTP), or `all_required`.
- **Active sessions / devices:** see every device signed into your account and **sign any of them out** with one click — the force-logout is **live** (web + mobile). New-device logins trigger an **email alert**.

### Modules & Industry
- **Settings → Modules:** turn feature modules on/off for the org.
- **Settings → Industry:** apply an industry preset (school / apparel / food-ag / retail / distribution) that flips a sensible bundle of modules at once.

### Customization
- **Custom fields:** org-specific item fields.
- **Navigation:** customize which nav items show.
- **Order statuses:** define your own order workflow stages.
- **Dashboard:** configure the overview/dashboard.
- **Notifications:** which events notify whom, and how.

### Data Safety
- **Audit log** (**Settings → Audit**): every sensitive admin action, recorded.
- **Restore points / Recovery:** snapshots/backups you can restore from.
- **Billing:** plan, tier, and subscription management for the org.

### Admin tools (`admin_tools` module)
A set of operational admin screens: **charters, warehouses, bins, users, UoM (unit-of-measure) conversions, vendor mappings, reconciliation, and an admin audit/support view.** Use these to maintain the structural data your operation depends on.

---

## 14. Platform Super-Admin Console

**Audience: StockPilot operators only (not customers).**

A "god-mode" console (`/platform`) for running the whole SaaS across **every** organization:
- **See and control every org**, their billing/tiers, comped/trial status.
- **Provision** new orgs.
- **Password resets** and an **RLS-safe "Act as"** impersonation (support without leaking across tenants).
- A platform-wide **audit** and **support** view.

This is separate from a customer's own Settings → Admin tools, and is restricted to platform staff.

---

## 15. The Mobile App

**Purpose:** run the warehouse from your pocket — scan, receive, count, and look things up on the floor. Native iOS (iPhone + iPad + Mac via "Designed for iPad") and Android.

**Key screens:** Inventory, Books, **Scan** (`scan` module), **Receive** (receiving), **Cycle counts** (incl. AI shelf-scan), Movements, Orders, Purchase orders, PO imports, Suppliers, Locations, Tags, Categories, Bundles, Rentals, Procedures, Schedule, Notifications, AI chat, Team, and Settings.

**How it works:**
- Sign in with the same account; the **drawer** switches workspace (org) — respecting the org switcher everywhere.
- Enforces **TOTP 2FA** (AAL1→AAL2) just like the web when your org/role requires it.
- Uses the Bearer-token `/api/v1` API and `useEnabledModules`, so the mobile app shows exactly the modules your org has enabled.
- Ships **over-the-air (OTA)** JS updates for fast fixes between full store builds.

---

## 16. Glossary

| Term | Meaning |
|---|---|
| **Organization (org)** | A tenant — one company's isolated data world. |
| **Workspace** | The currently-active org you're working in. |
| **Warehouse** | A physical site within an org. |
| **Charter** | A billing/ownership entity; a PO's *bill-to* and an item's *owner* can differ. |
| **Location** | A place stock sits; `kind` = rack / crate / staging / unplaced. |
| **Rack / Crate** | A real, pickable shelf/bin (placed stock). |
| **Staging** | Buffer for PO-received stock awaiting put-away. |
| **Unplaced** | On-hand stock never assigned to a rack. |
| **`bin_location`** | A cosmetic "home rack" *label* on an item — does **not** move stock. |
| **Placement / Put-away** | Moving staging/unplaced stock onto a rack/crate. |
| **Transfer** | Moving *placed* stock between racks (total on-hand unchanged → ledger delta 0). |
| **Movement** | An append-only audit row for any quantity/location change. |
| **Module / Entitlement** | A feature area that can be toggled on/off per org. |
| **Reserve-not-decrement** | Rentals lower *available* but not *on-hand* (stock returns). |
| **OTA** | Over-the-air mobile JS update between native store builds. |
| **RLS** | Row-Level Security — database-enforced tenant isolation. |

---

_This guide reflects the StockPilot platform as of June 2026. Feature availability depends on which **modules** your organization has enabled (Settings → Modules)._
