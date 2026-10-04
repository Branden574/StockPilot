import 'server-only';

import {
  can,
  deliveryRecipientsForRouting,
  ORDER_CATALOG_ROW_CEILING,
  ORDER_CATALOG_STALE_AFTER_SECONDS,
  ORDER_MFA_REQUIRED_COPY,
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PHONE_AAL2_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_PHOTO_URL_TTL_SECONDS,
  ORDER_STOREFRONT_PART_DEADLINE_MS,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
  type AisleSummary,
  type KitsResult,
  type OrderCatalogAnswer,
  type OrderCatalogItem,
  type OrderCatalogPhotosAnswer,
  type OrderCatalogSite,
  type OrderRecentRequester,
  type OrderRecentRequestersPart,
  type OrderStorefrontAnswer,
  type OrderStorefrontWarehouse,
} from '@stockpilot/core';

import type { CatalogItem, StorefrontCharter } from '@/components/orders/v2/types';
import { orgEmailRoutingFromRead } from '@/lib/dashboard/cached-org';
import { readFrequentlyOrdered } from '@/server/loaders/orders-frequently-ordered';
import { loadOrderKits } from '@/server/loaders/orders-kits';
import {
  CATALOG_ROW_CEILING,
  loadCatalogItemsCached,
  loadChartersForWarehouse,
  resolveCatalogScopeKey,
} from '@/server/loaders/orders-new-catalog';
import { loadPhoneThumbMapCached } from '@/server/loaders/orders-phone-catalog';
import {
  isModuleEnabled,
  mfaGateError,
  ServiceError,
  type ServiceContext,
} from '@/server/services/context';

/**
 * The phone storefront's reads (phone ordering PO-3, plan 3.1 and 3.8): what
 * GET /api/v1/orders/storefront, /catalog and /catalog/photos answer.
 *
 * BEARER-SAFE. Every read made for the caller goes through `ctx.supabase`, the
 * client withApiContext bound to the caller's own token. The cookie client is
 * anonymous on a phone's request: through it a staff member or viewer read as
 * nobody and got an empty warehouse list, an empty catalog, no kits and no
 * Frequently ordered, with no error (plan risk 3). The web's loaders take the
 * caller's client and modules as optional parameters for this; their cached
 * callbacks are untouched. Only the shared, cached reads use the admin client
 * (catalog rows under the caller's scope key, sites, photos), and only after
 * the warehouse perimeter below.
 *
 * GATES, before anything is read: the Orders module, the MFA step-up and
 * orders:request, the rules the create path applies (OrderRequestsService
 * .create), so the phone never shows a storefront that Submit would refuse.
 * Then the kill switch (ORDERS_PHONE_STOREFRONT=off), which covers these reads
 * only: placing and settling an order stay up, so a pending send can always be
 * settled.
 *
 * THE WAREHOUSE PERIMETER comes before any admin-client read: the caller's
 * non-archived warehouses, read with their own client (warehouses_select), and
 * a warehouse id not in that list is refused as warehouse_not_available. The
 * id is compared in its stored, lower-case form (a phone may send capitals).
 * Only the caller's own scope read (their client, their helpers) starts
 * alongside it; every shared read waits for it.
 * assertWarehouseAccess alone is not enough (it returns early for full-access
 * roles), and the sites loader reads with the admin client by warehouse only,
 * so a foreign id would answer another organization's site names and
 * addresses.
 *
 * NO PRICE. The web catalog row carries `price` (retail, falling back to unit
 * cost); the phone's item is built field by field and never spread from it.
 */

/**
 * The values of ORDERS_PHONE_STOREFRONT that turn the phone's storefront reads
 * off (any case, spaces ignored). `off` is the documented one; the others are
 * how a person in a hurry writes it during an incident, and a switch that
 * silently stays on for `false` would fail exactly then.
 */
const PHONE_STOREFRONT_OFF_VALUES: ReadonlySet<string> = new Set([
  'off',
  'false',
  '0',
  'no',
  'disabled',
]);

/** ORDERS_PHONE_STOREFRONT=off (or false, 0, no, disabled) turns the phone's
 *  storefront reads off; anything else, or nothing, leaves them on. Read on
 *  every call; changing it needs a redeploy, which is still faster than an
 *  over-the-air update and its adoption. */
export function phoneStorefrontEnabled(): boolean {
  const value = (process.env.ORDERS_PHONE_STOREFRONT ?? '').trim().toLowerCase();
  return !PHONE_STOREFRONT_OFF_VALUES.has(value);
}

/** The answer when the switch is off (the catalog and photo routes). */
export function phoneStorefrontOffError(): ServiceError {
  // A ServiceError code the routes map to 503 themselves (route helper).
  return new ServiceError('forbidden', ORDER_PHONE_TURNED_OFF_COPY, { reason: 'turned_off' });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `promise`'s value, or `late` once `ms` have passed (counted from this call).
 * The promise is left to settle on its own; it must never reject (every part
 * passed here is wrapped so it cannot).
 */
function withinDeadline<T, L>(promise: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<L>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The aisles of a catalog: named aisles A to Z, then "Uncategorized" when any
 * item has no category. The same rule as the web loader's buildAisles
 * (orders-new-catalog.ts, private to that frozen module); the parity test
 * feeds one catalog to both.
 */
export function buildPhoneAisles(
  items: ReadonlyArray<Pick<CatalogItem, 'categoryId' | 'categoryName'>>,
): AisleSummary[] {
  const countById = new Map<string, number>();
  const nameById = new Map<string, string>();
  let uncategorizedCount = 0;
  for (const it of items) {
    if (it.categoryId === null) {
      uncategorizedCount++;
    } else {
      countById.set(it.categoryId, (countById.get(it.categoryId) ?? 0) + 1);
      if (it.categoryName) nameById.set(it.categoryId, it.categoryName);
    }
  }
  const named: AisleSummary[] = Array.from(countById.entries())
    .map(([id, itemCount]) => ({ id, name: nameById.get(id) ?? id, itemCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (uncategorizedCount > 0) {
    named.push({ id: null, name: 'Uncategorized', itemCount: uncategorizedCount });
  }
  return named;
}

/** The phone's item: built field by field, so no cost can ride along. */
function phoneItem(it: CatalogItem): OrderCatalogItem {
  return {
    id: it.id,
    sku: it.sku,
    name: it.name,
    categoryId: it.categoryId,
    charterId: it.charterId,
    rackLabel: it.rackLabel,
    quantityOnHand: it.quantityOnHand,
    reservedQuantity: it.reservedQuantity,
    reorderPoint: it.reorderPoint,
  };
}

function phoneSite(c: StorefrontCharter): OrderCatalogSite {
  return { id: c.id, name: c.name, code: c.code, address: c.address };
}

/** One row of order_recent_requesters, or null when it is not that shape. */
function recentRequester(raw: unknown): OrderRecentRequester | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.email !== 'string' || typeof r.lastOrderedAt !== 'string') return null;
  const orders = Number(r.orders);
  return {
    name: typeof r.name === 'string' ? r.name : null,
    email: r.email,
    lastOrderedAt: r.lastOrderedAt,
    orders: Number.isFinite(orders) ? orders : 0,
    lastFulfillment:
      r.lastFulfillment === 'pickup' || r.lastFulfillment === 'delivery' ? r.lastFulfillment : null,
    lastSiteId: typeof r.lastSiteId === 'string' ? r.lastSiteId : null,
  };
}

/** A read the answer cannot be built without. Reported by the route, answered
 *  with core's words; the cause stays server side. */
function readFault(what: string, error: { code?: string; message?: string } | null): ServiceError {
  return new ServiceError(
    'internal_error',
    `[order-storefront] ${what} read failed: ${error?.code || 'unknown'} ${error?.message ?? ''}`.trim(),
    { reason: 'failed' },
  );
}

export class OrderStorefrontService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * The Orders module, the MFA step-up and orders:request, in core's words
   * with the reason a screen switches on. Same order as the create path.
   */
  private gate(): void {
    if (!isModuleEnabled(this.ctx, 'orders')) {
      throw new ServiceError('module_disabled', ORDER_MODULE_DISABLED_COPY, {
        reason: 'module_disabled',
      });
    }
    if (this.ctx.mfaRequired && !this.ctx.mfaSatisfied) {
      const reason = mfaGateError(this.ctx).details?.reason;
      throw new ServiceError(
        'forbidden',
        reason === 'aal2_required' ? ORDER_PHONE_AAL2_COPY : ORDER_MFA_REQUIRED_COPY,
        { reason },
      );
    }
    if (!can(this.ctx, 'orders:request')) {
      throw new ServiceError('forbidden', ORDER_PERMISSION_COPY, { reason: 'permission' });
    }
  }

  /** The gates, then the switch (catalog and photos; the storefront read
   *  answers `enabled: false` instead). */
  private gateWithSwitch(): void {
    this.gate();
    if (!phoneStorefrontEnabled()) throw phoneStorefrontOffError();
  }

  /** The caller's non-archived warehouses, by name, read as the caller. A
   *  failed read THROWS: an empty list would say "no warehouses". */
  private async readWarehouses(): Promise<OrderStorefrontWarehouse[]> {
    const { data, error } = await this.ctx.supabase
      .from('warehouses')
      .select('id, name')
      .eq('organization_id', this.ctx.organizationId)
      .neq('status', 'archived')
      .order('name', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw readFault('warehouses', error);
    return ((data ?? []) as Array<{ id: string; name: string }>).map((w) => ({
      id: w.id,
      name: w.name,
    }));
  }

  /**
   * The warehouse id the request names, in the form the database stores it
   * (lower case), or the refusal when it names none. A UUID is the same id in
   * any case, and the phone may send capitals (Swift's UUID prints them, and
   * withApiContext compares X-Organization-Id without case for that reason).
   * Everything downstream compares warehouse ids as text (the perimeter, the
   * scope key, the kits), so the id is made canonical once, here.
   */
  private requestedWarehouse(warehouseId: string | null): string {
    if (!warehouseId) {
      throw new ServiceError('validation_error', ORDER_WAREHOUSE_NOT_AVAILABLE_COPY, {
        reason: 'invalid',
        field: 'warehouseId',
      });
    }
    if (!UUID_RE.test(warehouseId)) throw this.warehouseNotAvailable();
    return warehouseId.toLowerCase();
  }

  /**
   * The perimeter: `warehouseId` (canonical, from requestedWarehouse) must be
   * one of the caller's warehouses, read with their own client. Anything else
   * (another organization's, one their assignments hide, an archived one) is
   * the same refusal, before any admin-client read. Answers the id as the
   * caller's own list holds it.
   */
  private async perimeter(warehouseId: string): Promise<string> {
    const warehouses = await this.readWarehouses();
    const hit = warehouses.find((w) => w.id === warehouseId);
    if (!hit) throw this.warehouseNotAvailable();
    return hit.id;
  }

  private warehouseNotAvailable(): ServiceError {
    return new ServiceError('not_found', ORDER_WAREHOUSE_NOT_AVAILABLE_COPY, {
      reason: 'warehouse_not_available',
    });
  }

  /**
   * The warehouse the request names, through the perimeter, and the caller's
   * catalog there: the scope key from their own client, the rows from the
   * shared 60 s cache (what loadCatalogItems does, in two steps).
   *
   * The scope key STARTS WITH the perimeter read instead of after it: it is
   * the caller's own five helper reads through ctx.supabase (none takes the
   * warehouse id; the id only picks from their answers), so it reads nothing
   * the caller could not, and a staff member or viewer saves a round trip.
   * Every shared read (the cached rows here; sites, kits and photos in the
   * callers) still waits for the perimeter. A refused warehouse leaves the
   * scope read to finish on its own, its failure swallowed, never unhandled.
   */
  private async scopedCatalog(
    warehouseIdParam: string | null,
  ): Promise<{ warehouseId: string; catalog: Promise<CatalogItem[]> }> {
    const requested = this.requestedWarehouse(warehouseIdParam);
    const scopeKey = resolveCatalogScopeKey(this.ctx, requested, this.ctx.supabase);
    scopeKey.catch(() => {});
    const warehouseId = await this.perimeter(requested);
    return {
      warehouseId,
      catalog: scopeKey.then((key) =>
        loadCatalogItemsCached(this.ctx.organizationId, warehouseId, key),
      ),
    };
  }

  /** GET /api/v1/orders/storefront. */
  async storefront(): Promise<OrderStorefrontAnswer> {
    this.gate();
    const organizationId = this.ctx.organizationId;
    const serverNow = new Date().toISOString();
    if (!phoneStorefrontEnabled()) {
      return { organizationId, enabled: false, message: ORDER_PHONE_TURNED_OFF_COPY, serverNow };
    }

    const canOrderOnBehalf = can(this.ctx, 'orders:approve');
    const recentRequestersPromise: Promise<OrderRecentRequestersPart> = canOrderOnBehalf
      ? withinDeadline(this.readRecentRequesters(), ORDER_STOREFRONT_PART_DEADLINE_MS, {
          status: 'error' as const,
        })
      : Promise.resolve(null);

    const [warehouses, profileRes, orgRes, recentRequesters] = await Promise.all([
      this.readWarehouses(),
      this.ctx.supabase
        .from('user_profiles')
        .select('full_name, email')
        .eq('id', this.ctx.userId)
        .maybeSingle(),
      this.ctx.supabase
        .from('organizations')
        .select('timezone, email_routing')
        .eq('id', organizationId)
        .maybeSingle(),
      recentRequestersPromise,
    ]);
    if (profileRes.error) throw readFault('profile', profileRes.error);
    const profile = profileRes.data as { full_name: string | null; email: string | null } | null;

    // The time zone as stored (null when it could not be read: the phone
    // resolves it with core resolveOrgTimezone, the web's fallback); the
    // routing by the web's own rules, from the same row.
    const org = orgRes.error
      ? null
      : (orgRes.data as { timezone?: unknown; email_routing?: unknown } | null);
    const recipients = deliveryRecipientsForRouting(
      orgEmailRoutingFromRead(orgRes.data, orgRes.error, 'delivery_request'),
    );

    return {
      organizationId,
      enabled: true,
      serverNow,
      warehouses,
      viewer: {
        userId: this.ctx.userId,
        role: this.ctx.role,
        name: profile?.full_name ?? null,
        email: profile?.email ?? null,
        canOrderOnBehalf,
        // The order screen's approve gate (security slice D), as the web page
        // states it: the effective orders:approve, never for a viewer.
        canApproveOrders: canOrderOnBehalf && this.ctx.role !== 'viewer',
      },
      kitsEnabled: this.ctx.enabledModules.has('bundles'),
      orgTimezone: typeof org?.timezone === 'string' ? org.timezone : null,
      deliveryRecipients: recipients
        ? {
            to: recipients.to,
            cc: recipients.cc,
            toName: recipients.toName ?? null,
            ccName: recipients.ccName ?? null,
          }
        : null,
      recentRequesters,
    };
  }

  /** order_recent_requesters (0391) as the caller. Never rejects. */
  private async readRecentRequesters(): Promise<Exclude<OrderRecentRequestersPart, null>> {
    try {
      const { data, error } = await this.ctx.supabase.rpc('order_recent_requesters', {
        p_org: this.ctx.organizationId,
      });
      if (error || !Array.isArray(data)) {
        console.warn(
          '[order-storefront] recent requesters could not be read:',
          error?.code || (error ? 'error' : 'shape'),
        );
        return { status: 'error' };
      }
      const people = (data as unknown[]).flatMap((row) => {
        const p = recentRequester(row);
        return p ? [p] : [];
      });
      return { status: 'ok', people };
    } catch {
      console.warn('[order-storefront] recent requesters could not be read: threw');
      return { status: 'error' };
    }
  }

  /** GET /api/v1/orders/catalog?warehouseId=. */
  async catalog(warehouseIdParam: string | null): Promise<OrderCatalogAnswer> {
    this.gateWithSwitch();
    const { warehouseId, catalog: catalogPromise } = await this.scopedCatalog(warehouseIdParam);

    // Everything starts at once; only the catalog is awaited first. Each
    // optional part is wrapped so it can never reject (no unhandled rejection
    // when the catalog fails first).
    // Kits and Frequently ordered match against the caller's own catalog, so
    // neither can name an item the caller is not given.
    const forParts = catalogPromise.then((items) => ({ items }));
    // A failed catalog is answered by the catalog itself; the parts' copy of
    // it must not count as an unhandled rejection.
    forParts.catch(() => {});

    const sitesPromise: Promise<OrderCatalogAnswer['sites']> = loadChartersForWarehouse(warehouseId)
      .then((charters) => ({ status: 'ok' as const, sites: charters.map(phoneSite) }))
      .catch(() => {
        console.warn('[order-storefront] sites could not be loaded');
        return { status: 'error' as const };
      });
    const kitsPromise: Promise<KitsResult> = loadOrderKits(
      this.ctx.organizationId,
      warehouseId,
      forParts,
      { modules: this.ctx.enabledModules, client: this.ctx.supabase },
    ).catch(() => ({ status: 'error' as const }));
    const frequentPromise: Promise<OrderCatalogAnswer['frequentlyOrdered']> = readFrequentlyOrdered(
      warehouseId,
      forParts,
      { client: this.ctx.supabase, imageFallback: false },
    )
      .then((r) =>
        r.status === 'ok'
          ? {
              status: 'ok' as const,
              items: r.entries.map((e) => ({ itemId: e.itemId, orders: e.count })),
            }
          : { status: 'error' as const },
      )
      .catch(() => ({ status: 'error' as const }));

    // The catalog itself throws on failure: the route answers a fault.
    const items = await catalogPromise;

    // 2.5 s from now for every optional part still running.
    const late = { status: 'error' as const };
    const [sites, kits, frequentlyOrdered] = await Promise.all([
      withinDeadline(sitesPromise, ORDER_STOREFRONT_PART_DEADLINE_MS, late),
      withinDeadline(kitsPromise, ORDER_STOREFRONT_PART_DEADLINE_MS, late),
      withinDeadline(frequentPromise, ORDER_STOREFRONT_PART_DEADLINE_MS, late),
    ]);

    const charters: OrderCatalogAnswer['charters'] = {};
    for (const it of items) {
      if (it.charterId && it.charterName && !(it.charterId in charters)) {
        charters[it.charterId] = { name: it.charterName, code: it.charterCode };
      }
    }

    return {
      organizationId: this.ctx.organizationId,
      warehouseId,
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: ORDER_CATALOG_STALE_AFTER_SECONDS,
      rowCeiling: ORDER_CATALOG_ROW_CEILING,
      truncated: items.length >= CATALOG_ROW_CEILING,
      items: items.map(phoneItem),
      aisles: buildPhoneAisles(items),
      charters,
      sites,
      kits,
      frequentlyOrdered,
    };
  }

  /** GET /api/v1/orders/catalog/photos?warehouseId=. The map is the
   *  warehouse's (cached); only the caller's catalog ids leave the server. */
  async photos(warehouseIdParam: string | null): Promise<OrderCatalogPhotosAnswer> {
    this.gateWithSwitch();
    const { warehouseId, catalog } = await this.scopedCatalog(warehouseIdParam);
    const [items, map] = await Promise.all([
      catalog,
      loadPhoneThumbMapCached(this.ctx.organizationId, warehouseId),
    ]);
    const photos: Record<string, string> = {};
    for (const it of items) {
      const url = map.photos[it.id];
      if (url) photos[it.id] = url;
    }
    const signedAtMs = Date.parse(map.signedAt);
    return {
      organizationId: this.ctx.organizationId,
      warehouseId,
      photos,
      signedAt: map.signedAt,
      expiresAt: new Date(signedAtMs + ORDER_PHOTO_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }
}
