// The answers of the phone storefront's three read routes (phone ordering
// PO-3): GET /api/v1/orders/storefront, GET /api/v1/orders/catalog and GET
// /api/v1/orders/catalog/photos. The web server builds them
// (apps/web/src/server/services/order-storefront.ts) and the phone reads them
// (PO-4), so the shapes live here, once. Types and constants only.
//
// ═══ NO COST, NO SECRET ═══
//
// Nothing here carries a price: the web catalog row's `price` falls back to
// unit cost, so the phone's item is built field by field from a narrower shape
// (OrderCatalogItem) and never spread from the web row. No token, no order
// secret, no other person's data except the on-behalf requesters a manager can
// already read on the web.

import type { Role } from '../../constants/roles';
import type { AisleSummary, CharterAddress } from './item';
import type { KitsResult } from './kits';

/** How long the phone may show a catalog answer before it reads it again.
 *  The server's own catalog cache is 60 s, so a fresher read would not be
 *  fresher. */
export const ORDER_CATALOG_STALE_AFTER_SECONDS = 60;

/** The catalog's safety ceiling (apps/web CATALOG_ROW_CEILING): every
 *  orderable row up to this many; `truncated` says when it was reached. */
export const ORDER_CATALOG_ROW_CEILING = 10_000;

/**
 * The deadline of every optional part of an answer: the sites, the kits and
 * Frequently ordered (counted from the moment the catalog itself arrived) and
 * the recent requesters (counted from the start). A part still running then
 * answers `{ status: 'error' }`; the answer is never held for it.
 */
export const ORDER_STOREFRONT_PART_DEADLINE_MS = 2_500;

/** Photo URLs are signed for 30 days; the server re-signs its map every 4 h. */
export const ORDER_PHOTO_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface OrderStorefrontWarehouse {
  id: string;
  name: string;
}

export interface OrderStorefrontViewer {
  userId: string;
  role: Role;
  name: string | null;
  email: string | null;
  /** May order for someone else: the effective orders:approve (security
   *  slice D), the rule the database's insert policy applies. */
  canOrderOnBehalf: boolean;
  /** The order screen's approve gate: orders:approve, never a viewer. */
  canApproveOrders: boolean;
  /** May open Manage order items (ordering visibility, 0413): the effective
   *  orders:manage_catalog_visibility and the rollout switch. The server
   *  always sets it; it is optional so an answer from a server without the
   *  feature still parses, and the phone shows the entry only when it is
   *  exactly true (hidden while the answer loads). */
  canManageOrderItems?: boolean;
}

/** One on-behalf requester of the last year (order_recent_requesters, 0391),
 *  newest first, at most 50. */
export interface OrderRecentRequester {
  name: string | null;
  email: string;
  lastOrderedAt: string;
  orders: number;
  lastFulfillment: 'pickup' | 'delivery' | null;
  lastSiteId: string | null;
}

/** null when the caller cannot order on behalf (nothing was read). */
export type OrderRecentRequestersPart =
  | { status: 'ok'; people: OrderRecentRequester[] }
  | { status: 'error' }
  | null;

/** core deliveryRecipientsForRouting, flattened: the mailboxes the pickup or
 *  delivery request email is addressed to, or null (the action is hidden). */
export interface OrderStorefrontDeliveryRecipients {
  to: string;
  cc: string;
  toName: string | null;
  ccName: string | null;
}

/** GET /api/v1/orders/storefront: what the phone needs once, on open. */
export type OrderStorefrontAnswer =
  | {
      organizationId: string;
      /** ORDERS_PHONE_STOREFRONT=off on the server: show `message` and offer
       *  nothing to submit. Nothing else was read. */
      enabled: false;
      message: string;
      serverNow: string;
    }
  | {
      organizationId: string;
      enabled: true;
      /** The needed-by picker's "now": a phone with a wrong clock never
       *  offers a past slot. */
      serverNow: string;
      /** Not archived, readable by the caller, by name. */
      warehouses: OrderStorefrontWarehouse[];
      viewer: OrderStorefrontViewer;
      /** The Bundles module is on: the Kits row keeps its place. */
      kitsEnabled: boolean;
      /** organizations.timezone as stored (null when it could not be read);
       *  the phone resolves it with core resolveOrgTimezone. */
      orgTimezone: string | null;
      deliveryRecipients: OrderStorefrontDeliveryRecipients | null;
      recentRequesters: OrderRecentRequestersPart;
    };

/** One orderable row as the phone receives it. No price, no photo. */
export interface OrderCatalogItem {
  id: string;
  sku: string;
  name: string;
  categoryId: string | null;
  charterId: string | null;
  rackLabel: string | null;
  quantityOnHand: number;
  reservedQuantity: number;
  reorderPoint: number;
}

export interface OrderCatalogSite {
  id: string;
  name: string;
  code: string | null;
  address: CharterAddress | null;
}

/** GET /api/v1/orders/catalog?warehouseId=: on open and on a warehouse
 *  change. Category names come from `aisles`, charter names from `charters`. */
export interface OrderCatalogAnswer {
  organizationId: string;
  warehouseId: string;
  generatedAt: string;
  staleAfterSeconds: number;
  rowCeiling: number;
  /** The catalog reached `rowCeiling`: items past it are not in the answer. */
  truncated: boolean;
  items: OrderCatalogItem[];
  /** Named aisles A to Z, then "Uncategorized" when any item has no category. */
  aisles: AisleSummary[];
  /** The earmark chips: every charter an item names. */
  charters: Record<string, { name: string; code: string | null }>;
  sites: { status: 'ok'; sites: OrderCatalogSite[] } | { status: 'error' };
  /** Only ids the caller was given in `items` (the web rule). */
  kits: KitsResult;
  frequentlyOrdered:
    | { status: 'ok'; items: Array<{ itemId: string; orders: number }> }
    | { status: 'error' };
}

/** GET /api/v1/orders/catalog/photos?warehouseId=: one photo URL per item of
 *  the caller's catalog that has one (the thumbnail when it was made, else
 *  the master). */
export interface OrderCatalogPhotosAnswer {
  organizationId: string;
  warehouseId: string;
  photos: Record<string, string>;
  signedAt: string;
  expiresAt: string;
}

// ── Manage order items (ordering visibility, migration 0413) ───────────────
//
// GET /api/v1/orders/catalog-visibility?q&visibility&type&warehouseId&
// categoryId&page (core parseOrderCatalogManageQuery), GET .../family/
// [groupId] and POST /api/v1/orders/catalog-visibility. The web page reads the
// same service. Only records the caller may READ are ever listed (Inventory's
// row level security), hidden ones included so they can be shown again;
// archived, deleted, rental and kit records are not manageable.

/** One record in Manage order items. No cost, no stock figure. */
export interface OrderCatalogManageRow {
  id: string;
  name: string;
  sku: string;
  /** A book's ISBN or an item's barcode; null when it has none. */
  identifier: string | null;
  /** 'book' for item_type book, 'item' for every other type. */
  itemType: 'item' | 'book';
  /** A sized record's size, or a book's author (books have no edition
   *  field); null when neither applies. */
  sizeOrEdition: string | null;
  warehouseId: string;
  warehouseName: string | null;
  categoryName: string | null;
  /** The product family (group_id) and its name, for "Select family". */
  familyId: string | null;
  familyName: string | null;
  /** Not received yet: orderable from its first receipt, so it can be hidden
   *  ahead of time. */
  expected: boolean;
  /** order_catalog_visible: true = Shown in Orders. */
  visible: boolean;
  /** When it was hidden (order_catalog_visibility_changed_at); null when shown. */
  hiddenSince: string | null;
  /** A signed thumbnail, or a book's stored cover; null for none. */
  thumbUrl: string | null;
}

/** One page of Manage order items (core ORDER_CATALOG_MANAGE_PAGE_SIZE a page;
 *  `total` is exact over everything the caller can read). */
export interface OrderCatalogManageListAnswer {
  organizationId: string;
  /** Only ever answered to a caller who may manage (others get a refusal). */
  viewer: { canManage: true };
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  rows: OrderCatalogManageRow[];
}

/** Every record of one product family the caller can read (the explicit
 *  "Select family" disclosure), at most core ORDER_CATALOG_FAMILY_MAX. */
export interface OrderCatalogFamilyAnswer {
  organizationId: string;
  familyId: string;
  familyName: string | null;
  rows: OrderCatalogManageRow[];
  /** The family has more readable records than are listed. */
  truncated: boolean;
}

/** POST /api/v1/orders/catalog-visibility: Show or Hide exactly these ids
 *  (1 to core ORDER_CATALOG_VISIBILITY_MAX_ITEMS). Keep `operationId` for a
 *  retry of the same change: a retry answers every id as unchanged. */
export interface OrderCatalogVisibilityWriteBody {
  itemIds: string[];
  visible: boolean;
  operationId: string;
}

/** A Show or Hide that committed, all or nothing. */
export interface OrderCatalogVisibilityWriteAnswer {
  organizationId: string;
  operationId: string;
  visible: boolean;
  /** Exactly the ids this call changed (one audit row each). */
  changed: string[];
  /** Ids already in that state (no audit row). */
  unchanged: string[];
}
