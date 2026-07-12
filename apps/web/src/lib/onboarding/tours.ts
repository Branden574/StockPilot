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
