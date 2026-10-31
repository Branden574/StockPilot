import 'server-only';

import { revalidateTag } from 'next/cache';

import {
  can,
  ORDER_CATALOG_FAMILY_MAX,
  ORDER_CATALOG_MANAGE_PAGE_SIZE,
  ORDER_CATALOG_VISIBILITY_MAX_ITEMS,
  ORDER_CATALOG_VISIBILITY_PERMISSION,
  ORDER_ITEMS_AAL2_REQUIRED_COPY,
  ORDER_ITEMS_BUSY_COPY,
  ORDER_ITEMS_FEATURE_DISABLED_COPY,
  ORDER_ITEMS_FORBIDDEN_COPY,
  ORDER_ITEMS_INVALID_COPY,
  ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY,
  ORDER_ITEMS_MFA_REQUIRED_COPY,
  ORDER_ITEMS_MODULE_DISABLED_COPY,
  type OrderCatalogFamilyAnswer,
  type OrderCatalogManageListAnswer,
  type OrderCatalogManageQuery,
  type OrderCatalogManageRow,
  type OrderCatalogVisibilitySurface,
  type OrderCatalogVisibilityWriteAnswer,
} from '@stockpilot/core';

import { isbnVariants, isIsbnSearch } from '@/lib/books/isbn-variants';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';

import { isModuleEnabled, mfaGateError, ServiceError, type ServiceContext } from './context';
import { buildItemSearchClause } from './inventory';
import { ItemImagesService } from './item-images';
import { ordersCatalogTag, ordersCatalogWarehouseTag } from './lib/order-catalog-hidden';
import { isOrderBusyError } from './lib/order-busy';
import { expireOrgPublicCatalogs } from './public-catalog';

/**
 * MANAGE ORDER ITEMS (ordering visibility, migration 0413; design 4.1 to 4.3,
 * 7.2 item 4, 10.2): which items and books appear in Place an Order.
 *
 * GATES, in order, on every call (list, family and Show or Hide):
 *   1. the Orders module            module_disabled  403, final
 *   2. the rollout switch           forbidden 403, details.reason
 *      ORDER_ITEMS_MANAGE_ORGS      'feature_disabled', final
 *   3. MFA (assertPermission's       forbidden 403, details.reason
 *      rule: required and not        'mfa_required' | 'aal2_required'
 *      satisfied)
 *   4. orders:manage_catalog_       forbidden 403, details.reason 'forbidden',
 *      visibility (effective,       final
 *      platform-managed)
 * The database function repeats 1, 3 and 4 for a direct call.
 *
 * READS use the caller's own client, so inventory_items_select RLS is the
 * scope: a delegated staff member or viewer sees exactly what Inventory shows
 * them, never another warehouse, charter or category. Base: the organization,
 * not deleted, active, not a rental, not a kit. Expected items are listed (a
 * manager may hide one before it arrives); archived items are not.
 *
 * THE WRITE is set_order_catalog_visibility through the caller's client
 * (auth.uid() is the actor): all or nothing, at most 500 distinct ids, one
 * audit row per changed record. Refusals are mapped by hint and SQLSTATE,
 * never by message text. After a write that returned (a no-op included, which
 * repairs a failed refresh): the ordering catalog tag of each warehouse the
 * named records sit in (the organization's tag when the answer does not name
 * them) and every public link catalog of the organization are expired with
 * { expire: 0 }. The
 * Items and Books list cache is NOT expired: the write keeps updated_at (a
 * derived write) and neither list renders the column
 * (inventory-list-invalidation guard ALLOWLIST).
 *
 * NO PREWARM FROM HERE (a deviation from design 7.2 item 4, which asked for a
 * deferred prewarmOrdersNewCatalog of the changed warehouses): the
 * no-request-path-prewarm guard (app/api/cron/prewarm-orders-catalog) allows
 * the cron-only warmers to be named by the cron route alone, after warming
 * from request paths ran the hot tier's service-role reads 1,300 times in a
 * day (2026-09-21). The next requester of a changed warehouse recomputes its
 * catalog once, which the design accepts as correct, and the 30-minute cron
 * warms the hot organizations again.
 */

/** The rollout switch (design 10.2), read on every call: unset or empty is
 *  off everywhere, '*' is on for all, otherwise a comma list of organization
 *  ids. Server only. The requester filter, the overlay and the line gate are
 *  never behind it. */
export function orderItemsManageEnabled(organizationId: string): boolean {
  const raw = (process.env.ORDER_ITEMS_MANAGE_ORGS ?? '').trim();
  if (raw === '') return false;
  if (raw === '*') return true;
  const want = organizationId.trim().toLowerCase();
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((id) => id !== '' && id === want);
}

/**
 * Whether to OFFER Manage order items (the web button, the phone storefront's
 * viewer.canManageOrderItems): the Orders module, the switch and the effective
 * permission. MFA is not part of the offer: an AAL1 session sees the entry and
 * the step-up prompt on use, like every other privileged action.
 */
export function canManageOrderItems(
  ctx: Pick<ServiceContext, 'organizationId' | 'enabledModules'> & Parameters<typeof can>[0],
): boolean {
  return (
    isModuleEnabled(ctx, 'orders') &&
    orderItemsManageEnabled(ctx.organizationId) &&
    can(ctx, ORDER_CATALOG_VISIBILITY_PERMISSION)
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Writes per user per minute (the storefront limiter pattern). */
export const ORDER_CATALOG_VISIBILITY_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export const ORDER_ITEMS_RATE_LIMITED_COPY =
  'Too many changes in a minute. Wait a moment, then try again.';

/** The columns of one management row. One literal (PostgREST's typing reads
 *  it). The three embeds name their foreign key column, each unambiguous in
 *  the relationship snapshot. Books keep their author and cover in
 *  custom_fields, read as two text paths, never the whole object. */
const MANAGE_COLUMNS =
  'id, name, sku, barcode, item_type, variant_size, warehouse_id, category_id, group_id, order_catalog_visible, order_catalog_visibility_changed_at, awaiting_first_receipt, author:custom_fields->>author, cover:custom_fields->>thumbnail_url, warehouse:warehouses!warehouse_id (name), category:categories!category_id (name), family:product_groups!group_id (name)';

type ManageRow = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  item_type: string | null;
  variant_size: string | null;
  warehouse_id: string;
  category_id: string | null;
  group_id: string | null;
  order_catalog_visible: boolean | null;
  order_catalog_visibility_changed_at: string | null;
  awaiting_first_receipt: boolean | null;
  author: string | null;
  cover: string | null;
  warehouse: { name: string | null } | null;
  category: { name: string | null } | null;
  family: { name: string | null } | null;
};

function nonEmpty(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function httpUrlOrNull(v: string | null | undefined): string | null {
  const t = nonEmpty(v);
  return t && /^https?:\/\//i.test(t) ? t : null;
}

function toManageRow(r: ManageRow, photo: string | null): OrderCatalogManageRow {
  const isBook = r.item_type === 'book';
  const visible = r.order_catalog_visible !== false;
  return {
    id: r.id,
    name: r.name,
    sku: r.sku,
    identifier: nonEmpty(r.barcode),
    itemType: isBook ? 'book' : 'item',
    sizeOrEdition: isBook ? nonEmpty(r.author) : nonEmpty(r.variant_size),
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse?.name ?? null,
    categoryName: r.category?.name ?? null,
    familyId: r.group_id,
    familyName: r.group_id ? (r.family?.name ?? null) : null,
    expected: r.awaiting_first_receipt === true,
    visible,
    hiddenSince: visible ? null : r.order_catalog_visibility_changed_at,
    thumbUrl: photo ?? (isBook ? httpUrlOrNull(r.cover) : null),
  };
}

export interface SetOrderCatalogVisibilityInput {
  itemIds: unknown;
  visible: unknown;
  operationId: unknown;
  surface: OrderCatalogVisibilitySurface;
}

export class OrderCatalogVisibilityService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Gates 1 to 4 (see the header). */
  private gate(): void {
    if (!isModuleEnabled(this.ctx, 'orders')) {
      throw new ServiceError('module_disabled', ORDER_ITEMS_MODULE_DISABLED_COPY, {
        reason: 'module_disabled',
      });
    }
    if (!orderItemsManageEnabled(this.ctx.organizationId)) {
      throw new ServiceError('forbidden', ORDER_ITEMS_FEATURE_DISABLED_COPY, {
        reason: 'feature_disabled',
      });
    }
    if (this.ctx.mfaRequired && !this.ctx.mfaSatisfied) {
      throw this.mfaRefusal(mfaGateError(this.ctx).details?.reason);
    }
    if (!can(this.ctx, ORDER_CATALOG_VISIBILITY_PERMISSION)) {
      throw this.forbidden();
    }
  }

  private forbidden(): ServiceError {
    return new ServiceError('forbidden', ORDER_ITEMS_FORBIDDEN_COPY, { reason: 'forbidden' });
  }

  /** mfaGateError's shape (details.reason), in core's words. */
  private mfaRefusal(reason: unknown): ServiceError {
    return reason === 'aal2_required'
      ? new ServiceError('forbidden', ORDER_ITEMS_AAL2_REQUIRED_COPY, { reason: 'aal2_required' })
      : new ServiceError('forbidden', ORDER_ITEMS_MFA_REQUIRED_COPY, { reason: 'mfa_required' });
  }

  /** The base read every management query starts from (caller's client). */
  private baseQuery(options?: { count?: 'exact' }) {
    return this.ctx.supabase
      .from('inventory_items')
      .select(MANAGE_COLUMNS, options)
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .eq('is_rental', false)
      .or('is_bundle.is.null,is_bundle.eq.false');
  }

  /** One batched photo read for a page (thumb when there is one, else the
   *  master). A failed read degrades to no photos, reported: the list is
   *  still right without them. */
  private async photos(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    try {
      const images = await new ItemImagesService(this.ctx).primaryImagesWithThumbsForItems(ids);
      for (const [id, img] of images) out.set(id, img.thumbUrl ?? img.url);
    } catch (e) {
      void reportError(
        e instanceof ServiceError && e.internalDetail ? new Error(e.internalDetail) : e,
        { tag: 'order_catalog_visibility.photos', organizationId: this.ctx.organizationId },
      );
    }
    return out;
  }

  private readFault(what: string, error: { message?: string; code?: string }): ServiceError {
    return new ServiceError(
      'internal_error',
      `[order-catalog-visibility] ${what} read failed: ${error.code ?? ''} ${error.message ?? ''}`.trim(),
    );
  }

  /** GET /api/v1/orders/catalog-visibility (design 4.1). */
  async list(query: OrderCatalogManageQuery): Promise<OrderCatalogManageListAnswer> {
    this.gate();
    const pageSize = ORDER_CATALOG_MANAGE_PAGE_SIZE;
    const page = Math.max(1, Math.floor(query.page) || 1);

    let q = this.baseQuery({ count: 'exact' });
    if (query.visibility === 'shown') q = q.eq('order_catalog_visible', true);
    else if (query.visibility === 'hidden') q = q.eq('order_catalog_visible', false);
    if (query.type === 'books') q = q.eq('item_type', 'book');
    else if (query.type === 'items') q = q.or('item_type.is.null,item_type.neq.book');
    // A warehouse or category the caller cannot read only narrows to nothing:
    // RLS still decides every row.
    if (query.warehouseId) q = q.eq('warehouse_id', query.warehouseId);
    if (query.categoryId) q = q.eq('category_id', query.categoryId);
    const term = query.q.trim();
    if (term) {
      const variants = isIsbnSearch(term) ? isbnVariants(term) : [];
      const clause = buildItemSearchClause(term, variants);
      if (clause) q = q.or(clause);
    }
    const from = (page - 1) * pageSize;
    const { data, error, count } = await q
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw this.readFault('manage list', error);
    const rows = (data ?? []) as unknown as ManageRow[];
    const photos = await this.photos(rows.map((r) => r.id));
    return {
      organizationId: this.ctx.organizationId,
      viewer: { canManage: true },
      page,
      pageSize,
      total: typeof count === 'number' ? count : rows.length,
      rows: rows.map((r) => toManageRow(r, photos.get(r.id) ?? null)),
    };
  }

  /** GET /api/v1/orders/catalog-visibility/family/[groupId] (design 4.1):
   *  the family's records the caller can read, at most 200. Never reads
   *  display groups. */
  async familyMembers(groupId: string): Promise<OrderCatalogFamilyAnswer> {
    this.gate();
    const id = (groupId ?? '').trim().toLowerCase();
    if (!UUID_RE.test(id)) {
      throw new ServiceError('validation_error', ORDER_ITEMS_INVALID_COPY, {
        reason: 'invalid',
        field: 'groupId',
      });
    }
    const { data, error } = await this.baseQuery()
      .eq('group_id', id)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      // One past the cap tells whether there are more.
      .range(0, ORDER_CATALOG_FAMILY_MAX);
    if (error) throw this.readFault('family', error);
    const all = (data ?? []) as unknown as ManageRow[];
    const rows = all.slice(0, ORDER_CATALOG_FAMILY_MAX);
    const photos = await this.photos(rows.map((r) => r.id));
    return {
      organizationId: this.ctx.organizationId,
      familyId: id,
      familyName: rows[0]?.family?.name ?? null,
      rows: rows.map((r) => toManageRow(r, photos.get(r.id) ?? null)),
      truncated: all.length > ORDER_CATALOG_FAMILY_MAX,
    };
  }

  /** Show or Hide exactly these records, all or nothing (design 4.2). */
  async setVisibility(input: SetOrderCatalogVisibilityInput): Promise<OrderCatalogVisibilityWriteAnswer> {
    this.gate();

    const rl = await checkRateLimit(
      `order-catalog-visibility:${this.ctx.userId}`,
      ORDER_CATALOG_VISIBILITY_RATE_LIMIT,
      RATE_WINDOW_MS,
    );
    if (!rl.allowed) {
      throw new ServiceError('conflict', ORDER_ITEMS_RATE_LIMITED_COPY, {
        reason: 'rate_limited',
        retryable: true,
        retryAfterSeconds: Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)),
      });
    }

    const { itemIds, visible, operationId } = this.parseWrite(input);

    const { data, error } = await this.ctx.supabase.rpc('set_order_catalog_visibility', {
      p_organization_id: this.ctx.organizationId,
      p_item_ids: itemIds,
      p_visible: visible,
      p_operation_id: operationId,
      p_surface: input.surface,
    });
    if (error) throw this.refusal(error, itemIds, operationId);

    // The call returned, so whatever it changed is committed: refresh first,
    // then check the answer.
    const answer = this.parseAnswer(data, { visible, operationId });
    await this.invalidate(this.parseWarehouseIds(data));
    if (!answer) {
      throw new ServiceError(
        'internal_error',
        `[order-catalog-visibility] unexpected answer shape: ${JSON.stringify(data)?.slice(0, 200)}`,
      );
    }
    return answer;
  }

  private parseWrite(input: SetOrderCatalogVisibilityInput): {
    itemIds: string[];
    visible: boolean;
    operationId: string;
  } {
    const invalid = (field: string) =>
      new ServiceError('validation_error', ORDER_ITEMS_INVALID_COPY, { reason: 'invalid', field });
    if (typeof input.visible !== 'boolean') throw invalid('visible');
    if (typeof input.operationId !== 'string' || !UUID_RE.test(input.operationId)) {
      throw invalid('operationId');
    }
    if (!Array.isArray(input.itemIds)) throw invalid('itemIds');
    if (input.itemIds.length > ORDER_CATALOG_VISIBILITY_MAX_ITEMS) throw invalid('itemIds');
    const ids = new Set<string>();
    for (const raw of input.itemIds) {
      if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw invalid('itemIds');
      ids.add(raw.toLowerCase());
    }
    if (ids.size < 1) throw invalid('itemIds');
    return {
      itemIds: [...ids].sort(),
      visible: input.visible,
      operationId: input.operationId.toLowerCase(),
    };
  }

  /** The function's answer, checked: it must name this organization, this
   *  operation and this state, with two id lists. Null when it does not. */
  private parseAnswer(
    data: unknown,
    want: { visible: boolean; operationId: string },
  ): OrderCatalogVisibilityWriteAnswer | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const d = data as Record<string, unknown>;
    const ids = (v: unknown): string[] | null =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
    const changed = ids(d.changed);
    const unchanged = ids(d.unchanged);
    if (
      d.organizationId !== this.ctx.organizationId ||
      typeof d.operationId !== 'string' ||
      d.operationId.toLowerCase() !== want.operationId ||
      d.visible !== want.visible ||
      !changed ||
      !unchanged
    ) {
      return null;
    }
    return {
      organizationId: this.ctx.organizationId,
      operationId: want.operationId,
      visible: want.visible,
      changed,
      unchanged,
    };
  }

  /** The warehouses of the records the call named (the function's
   *  `warehouseIds`, 0413 review fix round), or null when the answer does not
   *  carry a readable list: then the whole organization is expired. */
  private parseWarehouseIds(data: unknown): string[] | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const v = (data as Record<string, unknown>).warehouseIds;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && UUID_RE.test(x))) return null;
    return [...new Set((v as string[]).map((x) => x.toLowerCase()))].sort();
  }

  /** Hint and SQLSTATE to a refusal; the database's text is never shown. */
  private refusal(
    error: { message?: string; code?: string; hint?: string; details?: string },
    sentIds: string[],
    operationId: string,
  ): ServiceError {
    switch (error.hint) {
      case 'unauthenticated':
      case 'order_catalog_forbidden':
        return this.forbidden();
      case 'module_disabled':
        return new ServiceError('module_disabled', ORDER_ITEMS_MODULE_DISABLED_COPY, {
          reason: 'module_disabled',
        });
      case 'mfa_required':
      case 'aal2_required':
        return this.mfaRefusal(error.hint);
      case 'order_catalog_items_unavailable': {
        // The caller's own failing ids, and only ids this call sent.
        let named: string[] = [];
        try {
          const parsed = JSON.parse(error.details ?? '[]') as unknown;
          if (Array.isArray(parsed)) {
            const sent = new Set(sentIds);
            named = parsed
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.toLowerCase())
              .filter((x) => sent.has(x));
          }
        } catch {
          named = [];
        }
        return new ServiceError('conflict', ORDER_ITEMS_ITEMS_UNAVAILABLE_COPY, {
          reason: 'items_unavailable',
          itemIds: named,
        });
      }
      case 'order_catalog_invalid':
        return new ServiceError('validation_error', ORDER_ITEMS_INVALID_COPY, {
          reason: 'invalid',
          field: error.details ?? null,
        });
      default:
        break;
    }
    if (isOrderBusyError(error)) {
      return new ServiceError('conflict', ORDER_ITEMS_BUSY_COPY, {
        reason: 'busy',
        retryable: true,
        operationId,
      });
    }
    return new ServiceError(
      'internal_error',
      `[order-catalog-visibility] set_order_catalog_visibility failed: ${error.code ?? ''} ${error.message ?? ''}`.trim(),
    );
  }

  /**
   * After a write that returned (design 7.2 item 4): expire the ordering
   * catalog of each warehouse the named records sit in, and every public link
   * catalog of the organization, NOW. Only those warehouses (review F1): the
   * organization's other warehouses stay warm, so their open Place an Order
   * tabs, which the realtime event no longer refreshes either, rebuild
   * nothing. The organization's tag only when the answer named no readable
   * warehouses. Never the global catalog tag with expire 0 (every
   * organization's next load would be cold), never 'max', never the Items
   * list cache, and no prewarm (see the header).
   */
  private async invalidate(warehouseIds: string[] | null): Promise<void> {
    const organizationId = this.ctx.organizationId;
    if (warehouseIds) {
      for (const warehouseId of warehouseIds) {
        revalidateTag(ordersCatalogWarehouseTag(organizationId, warehouseId), { expire: 0 });
      }
    } else {
      revalidateTag(ordersCatalogTag(organizationId), { expire: 0 });
    }
    try {
      await expireOrgPublicCatalogs(organizationId);
    } catch (e) {
      // The write committed; a public link page still overlays every render.
      console.warn(
        '[order-catalog-visibility] public link catalogs could not be expired:',
        e instanceof ServiceError ? (e.internalDetail ?? e.message) : e,
      );
    }
  }
}
