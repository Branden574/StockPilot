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
