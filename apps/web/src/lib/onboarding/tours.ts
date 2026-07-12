import type { TourDefinition } from './types';

/**
 * Tour registry (spec §16) — tours are data. Selector strategy: stable
 * hrefs/name attributes over classes; every targeted step is skippable so
 * disabled modules, missing permissions, or layout variants never break a
 * tour. Copy references renameable labels per the terminology spec (§7).
 */
export const ITEMS_PAGE_TOUR: TourDefinition = {
  id: 'items-page',
  version: 1,
  name: 'Items page',
  steps: [
    {
      title: 'Your inventory lives here',
      body: 'Every physical thing your organization tracks — products, books, assets — is a row on this page, with live quantities and locations.',
    },
    {
      target: 'input[placeholder*="Search name"]',
      title: 'Find anything fast',
      body: 'Search by name, SKU, or barcode. The filter buttons alongside narrow by category, location, or charter (your org can rename that term in Settings).',
    },
    {
      target: 'a[href="/dashboard/inventory/new"]',
      title: 'Add a single item',
      body: 'Create one inventory record by hand. Open it and take the form tour — every field is explained, and most are optional.',
    },
    {
      target: 'a[href="/dashboard/inventory/import"]',
      title: 'Add many at once',
      body: 'Import a spreadsheet or a purchase order to create lots of records in one pass — the usual path when a shipment arrives.',
    },
    {
      target: 'table tbody tr',
      title: 'Dig into any item',
      body: 'Click a row for full detail: quantities on hand vs reserved, rack placement, source purchase orders, and complete movement history.',
      optional: true,
    },
  ],
};

export const NEW_ITEM_TOUR: TourDefinition = {
  id: 'new-item-form',
  version: 1,
  name: 'New item form',
  steps: [
    {
      title: 'Creating an item, in plain terms',
      body: "Only Name is truly required — everything else can be added later. Saving creates an inventory record your team can order, pick, transfer, and count. Here's what the important fields mean.",
    },
    {
      target: 'input[name="name"]',
      title: 'Name (required)',
      body: 'What people will search for and see on orders — e.g. "Acer Chromebook 511". Keep it how your team actually says it.',
    },
    {
      target: 'input[name="sku"]',
      title: 'SKU',
      body: "Your internal code for this product. Leave it blank and StockPilot generates one. Same product in a different charter or bin can be its own record with its own SKU.",
      optional: true,
    },
    {
      target: 'input[name="quantity_on_hand"], input[name="quantityOnHand"], input[name="quantity"]',
      title: 'Quantity on hand',
      body: 'How many units physically exist right now. Orders reserve from this; picking and hand-over subtract from it — always with a movement trail.',
      optional: true,
    },
    {
      target: 'input[name="reorder_point"], input[name="reorderPoint"]',
      title: 'Reorder point',
      body: 'When on-hand dips to this number the item flags as low stock — dashboards, alerts, and reorder planning all key off it.',
      optional: true,
    },
    {
      title: 'Charter, warehouse, and placement',
      body: 'Charter marks who this stock belongs to (a site, school, or program — renameable in Settings). Warehouse and rack say where it physically sits so pickers can find it. All three appear on orders and pick slips.',
    },
  ],
};

export const STAGING_TOUR: TourDefinition = {
  id: 'staging-page',
  version: 1,
  name: 'Staging',
  steps: [
    {
      target: 'main h1',
      title: 'The receiving dock, digitally',
      body: 'Stock that has ARRIVED but has not been put away yet lands here — counted in your totals, but not yet pickable from a rack.',
    },
    {
      title: 'Staged vs active',
      body: 'Staged/unplaced stock cannot be picked for orders — picking only draws from placed rack or crate stock. Putting items away is what makes them usable.',
    },
    {
      target: 'main table',
      title: 'What is waiting',
      body: 'Each row shows the item, quantity, the purchase order it came from, and how long it has been waiting. Old rows usually mean a put-away got missed.',
      optional: true,
    },
    {
      target: '[role="checkbox"][aria-label="Select all placeable rows"]',
      title: 'Put stock away',
      body: 'Select rows (or use the per-row Place button) and assign a rack — that moves stock from staged to placed, ready for picking.',
      optional: true,
    },
  ],
};

export const ORDERS_TOUR: TourDefinition = {
  id: 'orders-page',
  version: 1,
  name: 'Orders',
  steps: [
    {
      target: 'main h1',
      title: 'Every request, one queue',
      body: 'Orders your team (or external requesters) submit flow through here — from approval to picking, packing, staging, delivery, and sign-off.',
    },
    {
      target: 'nav[aria-label="Status"]',
      title: 'The lifecycle, as tabs',
      body: 'Each tab is a stage: Needs approval → Picking → Packing → Staged → In transit → Completed. An order moves left to right; Backordered holds partially-fulfilled orders awaiting stock.',
      optional: true,
    },
    {
      target: 'a[href="/dashboard/orders/new"]',
      title: 'Place an order',
      body: 'Opens the storefront: browse the catalog, set a Needed-by date (it auto-schedules a calendar event with reminders at approval), and submit for review.',
      optional: true,
    },
    {
      title: 'Order numbers',
      body: 'Every order gets a number like SO-000045 — it appears on pick slips, packing slips, emails, and the Schedule, so anyone can reference it unambiguously.',
    },
  ],
};

export const DASHBOARD_TOUR: TourDefinition = {
  id: 'dashboard',
  version: 1,
  name: 'Dashboard',
  steps: [
    {
      title: 'Your home base',
      body: 'The dashboard summarizes stock levels, orders in flight, and recent activity at a glance. Admins can choose and reorder these widgets in Settings.',
    },
    {
      target: '#dashboard-sidebar',
      title: 'Everything lives here',
      body: 'The sidebar is grouped into Inventory, Workspace, Tools, and Admin. You only see what your role can access — and admins can rename labels, so your words may differ from ours.',
    },
    {
      target: '#dashboard-sidebar nav a[href="/dashboard/inventory"]',
      title: 'Items',
      body: 'The heart of the system: every physical thing you track. Start here to add or find stock.',
      optional: true,
    },
    {
      target: 'section[aria-labelledby="get-started-heading"]',
      title: 'Getting started',
      body: 'This checklist walks your first real actions — each step deep-links to the right place and checks itself off as you go.',
      optional: true,
    },
    {
      title: 'Tours everywhere',
      body: 'Every major page has a small “Tour” pill like the one you clicked. Take one whenever a screen is new to you — your progress is remembered across devices.',
    },
  ],
};

export const ORDER_CREATE_TOUR: TourDefinition = {
  id: 'order-create',
  version: 1,
  name: 'Place an order',
  steps: [
    {
      title: 'A storefront for your own stock',
      body: 'Browse the catalog and build a cart. Submitting creates a REQUEST — a manager reviews and approves before any stock is reserved.',
    },
    {
      target: '.sf-setup',
      title: 'Set up the order first',
      body: 'Choose the warehouse and whether this is a pickup or a delivery. Deliveries need a destination site — picking it now avoids a surprise at submit.',
    },
    {
      target: '[aria-label="Order progress"]',
      title: 'Progress, not buttons',
      body: 'This indicator advances on its own as your cart fills and you review. It shows where you are — it is not navigation.',
      optional: true,
    },
    {
      target: 'input[aria-label="Search catalog"]',
      title: 'Find items fast',
      body: 'Search by name or SKU, or use the category pills below to narrow the catalog.',
      optional: true,
    },
    {
      target: '[aria-label="Order cart"]',
      title: 'Your cart',
      body: 'Quantities are capped at what is actually available — when adding stops working, the cart shows you have claimed everything on hand.',
      optional: true,
    },
    {
      target: '#sf-needed-by-input',
      title: 'Needed by = automatic scheduling',
      body: 'Set a date and, once the order is approved, a team Schedule event is created automatically with reminders the day before and an hour ahead.',
      optional: true,
    },
  ],
};

export const ORDER_DETAIL_TOUR: TourDefinition = {
  id: 'order-detail',
  version: 1,
  name: 'Order detail',
  steps: [
    {
      target: 'main h1',
      title: 'One order, its whole story',
      body: 'The order number and live status badge. Everything below — lines, actions, timeline — updates as the order moves through fulfillment.',
    },
    {
      title: 'Requested · Fulfilled · Owed',
      body: 'Fulfilled counts units actually HANDED OVER at pickup/delivery — not merely picked. Owed is requested minus fulfilled. “Backordered” means the order is live but waiting on stock; “Partially fulfilled” means some units already went out.',
    },
    {
      target: '[data-tour="manager-actions"]',
      title: 'Actions change with the stage',
      body: 'This panel offers exactly the next legal steps for the order’s status and your role. The big one: staff must “Claim picking” before they can pick — it locks the order to one picker so two people never pick the same order.',
      optional: true,
    },
    {
      target: 'main aside',
      title: 'Dates and details',
      body: 'Key dates and delivery info live here; the Timeline section is the full audit history of who did what, when.',
      optional: true,
    },
  ],
};

export const PO_IMPORTS_TOUR: TourDefinition = {
  id: 'po-imports',
  version: 1,
  name: 'PO imports',
  steps: [
    {
      target: 'main h1',
      title: 'Expected inbound, staged safely',
      body: 'An import records what a vendor PO says is coming. Nothing touches your stock counts until you actually RECEIVE the purchase order it creates.',
    },
    {
      target: 'a[href="/dashboard/purchase-orders/imports/new"]',
      title: 'Two ways in',
      body: 'Scan a PDF with AI (it extracts lines and shows a confidence score) or upload a CSV. Either way you review every line before approving.',
    },
    {
      target: 'main table',
      title: 'Review before approve',
      body: 'Each import shows its status here. Every line must be mapped to an internal item (or skipped) before approval — suggested matches are advisory, never automatic.',
      optional: true,
    },
    {
      title: 'The two charter dropdowns',
      body: 'On an import you may see two similar pickers: “Charter for items” sets who OWNS the stock being created; “Bill to charter” sets who is billed on the PO document. They are independent on purpose.',
    },
  ],
};

export const SETTINGS_TOUR: TourDefinition = {
  id: 'settings-hub',
  version: 1,
  name: 'Settings',
  steps: [
    {
      target: 'main h1',
      title: 'Make the app speak your language',
      body: 'Settings is where the workspace is shaped: what is enabled, what things are called, and who can do what.',
    },
    {
      target: 'a[href="/dashboard/settings/navigation"]',
      title: 'Rename almost anything',
      body: 'Charters can become Schools, Items can become Inventory, Staging can become Receiving — the sidebar and page titles follow everywhere.',
      optional: true,
    },
    {
      target: 'a[href="/dashboard/settings/modules"]',
      title: 'Turn features on and off',
      body: 'Disable modules you do not use and they disappear app-wide — for every member, on web and mobile.',
      optional: true,
    },
    {
      target: 'a[href="/dashboard/settings/roles"]',
      title: 'Who can do what',
      body: 'Grant or revoke individual permissions per role — or per person. Gates, navigation, and data access all follow.',
      optional: true,
    },
    {
      target: 'a[href="/dashboard/settings/order-statuses"]',
      title: 'Your workflow, your words',
      body: 'Rename order-status labels (like “Staged” or “In transit”) to match how your team already talks.',
      optional: true,
    },
  ],
};

export const ITEM_DETAIL_TOUR: TourDefinition = {
  id: 'item-detail',
  version: 1,
  name: 'Item detail',
  steps: [
    {
      target: 'main h1',
      title: 'Everything about one item',
      body: 'Name, SKU, and a live stock-status badge. Below: placements, serials, activity, cost history, and images — the item’s full record.',
    },
    {
      title: 'On hand vs placed',
      body: 'On hand is the total you own. The placements breakdown shows WHERE it sits — racks, crates, staging, or unplaced. Only placed stock can be picked for orders; anything in staging/unplaced needs a put-away first.',
    },
    {
      target: '[data-tour="item-actions"]',
      title: 'Actions',
      body: 'Edit details, duplicate as a template, print a barcode, adjust quantities, or transfer stock between locations — each button appears only if your role allows it.',
      optional: true,
    },
  ],
};

export const REPORTS_TOUR: TourDefinition = {
  id: 'reports',
  version: 1,
  name: 'Reports',
  steps: [
    {
      target: 'main h1',
      title: 'Pre-built answers',
      body: 'Ready-made reports over your live data — stock value, movement, order history, and more. No setup required.',
    },
    {
      target: 'main a[href^="/dashboard/reports/"]',
      title: 'Open any report',
      body: 'Each card is a full report with filters. Every one exports to CSV, so audits and board decks start here.',
      optional: true,
    },
  ],
};

export const AI_TOUR: TourDefinition = {
  id: 'ai-assistant',
  version: 1,
  name: 'AI assistant',
  steps: [
    {
      target: 'main h1',
      title: 'Ask in plain English',
      body: '“What is running low?” “Total value in Warehouse A?” “Which orders are stuck?” — the assistant answers from your actual data.',
    },
    {
      title: 'Grounded, not guessed',
      body: 'Every number comes from a real query against your inventory — the assistant runs the same reads the app does. Most tools are read-only; it only changes stock when you explicitly confirm.',
    },
    {
      target: '[aria-label="Ask the inventory assistant"]',
      title: 'Start typing',
      body: 'Ask anything — you can also attach a photo of a book or a file of ISBNs and it will identify and look items up for you.',
      optional: true,
    },
  ],
};
