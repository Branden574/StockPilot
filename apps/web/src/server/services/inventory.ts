import 'server-only';

import { generateSku } from '@/lib/utils';
import {
  assertWarehouseAccess,
  forcedWarehouseId,
  getWarehouseAccess,
  ForbiddenError,
} from '@/lib/auth/warehouse';

import type {
  AdjustStockInput,
  CreateItemInput,
  TransferStockInput,
  UpdateItemInput,
} from '@stockpilot/core';

import { assertPermission, assertPlanLimit, ServiceError, withContext, type ServiceContext } from './context';
import { audit } from './audit';
import { TagsService } from './tags';

export type ItemListSort =
  | 'updated_desc'
  | 'updated_asc'
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'qty_desc'
  | 'qty_asc'
  | 'created_desc'
  | 'created_asc';

export interface ItemListFilters {
  q?: string;
  /**
   * Exact-match filter on inventory_items.barcode. Used by the
   * scan-to-search flow on /dashboard/books — the scanner emits the
   * ISBN and we want a single deterministic match, not the prefix
   * ilike that `q` would do.
   */
  barcode?: string;
  /**
   * Rack / bin filter. Dispatched per item-type:
   *   - itemType === 'book'  → custom_fields.book_rack_number / _row
   *                            (legacy keys, kept so book data keeps
   *                            matching without re-saving).
   *   - itemType === 'all'   → OR-of-ANDs: book-row matches book keys,
   *                            non-book matches the neutral rack_* keys.
   *   - otherwise            → custom_fields.rack_number / rack_row
   *                            (neutral keys, used by items).
   * "Any rack" is signaled by omitting the filter entirely. "{number}-
   * {row}" is split on the first dash; "{number}" alone matches just
   * the number.
   */
  rack?: string;
  status?: 'active' | 'archived' | 'discontinued' | 'all';
  /** Legacy single-select. New callers should prefer categoryIds. */
  categoryId?: string | null;
  /** Multi-select. When non-empty, takes precedence over categoryId. */
  categoryIds?: string[];
  /** Legacy single-select. New callers should prefer locationIds. */
  locationId?: string | null;
  locationIds?: string[];
  /** Legacy single-select. New callers should prefer supplierIds. */
  supplierId?: string | null;
  supplierIds?: string[];
  /** Optional filter for managers/admins. Ignored for warehouse-scoped users (forced). */
  warehouseId?: string | null;
  /**
   * Filter by item_type. Common values:
   *   - 'product' (default for the inventory tab)
   *   - 'book' (books tab)
   *   - 'all' (no filter — used by reports / dashboard rollups)
   */
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  lowStock?: boolean;
  outOfStock?: boolean;
  cursor?: string | null;
  limit?: number;
  /** Zero-based offset for page-based pagination. Combined with `limit`. */
  offset?: number;
  /** Sort order. Defaults to 'updated_desc' to keep recently-edited rows on top. */
  sort?: ItemListSort;
  /**
   * Time-window filters. Used by AI tools for "what was added/updated
   * yesterday/this week" questions. `createdSince` / `createdUntil`
   * match `inventory_items.created_at`; `updatedSince` / `updatedUntil`
   * match `inventory_items.updated_at`. All ISO timestamps.
   */
  createdSince?: string;
  createdUntil?: string;
  updatedSince?: string;
  updatedUntil?: string;
}

const SORT_MAP: Record<ItemListSort, { col: string; asc: boolean }> = {
  updated_desc: { col: 'updated_at', asc: false },
  updated_asc: { col: 'updated_at', asc: true },
  name_asc: { col: 'name', asc: true },
  name_desc: { col: 'name', asc: false },
  sku_asc: { col: 'sku', asc: true },
  sku_desc: { col: 'sku', asc: false },
  qty_desc: { col: 'quantity_on_hand', asc: false },
  qty_asc: { col: 'quantity_on_hand', asc: true },
  created_desc: { col: 'created_at', asc: false },
  created_asc: { col: 'created_at', asc: true },
};

/**
 * Numeric-aware rack comparator. Rack labels come in two shapes:
 *   "NUM" (e.g. "38") and "NUM-ROW" (e.g. "38-A"). Lex-sorting puts
 * "10" before "2" which is wrong for any user reading a stockroom map
 * top-to-bottom. Parse the leading int, compare numerically, then fall
 * back to lex order for the row segment. Exported only for tests.
 */
export function rackCmp(a: string, b: string): number {
  const [aNum, aRow] = a.split('-', 2);
  const [bNum, bRow] = b.split('-', 2);
  const aN = parseInt(aNum ?? '0', 10);
  const bN = parseInt(bNum ?? '0', 10);
  const aFinite = Number.isFinite(aN);
  const bFinite = Number.isFinite(bN);
  if (aFinite && bFinite && aN !== bN) return aN - bN;
  if (!aFinite || !bFinite) {
    const cmp = (aNum ?? '').localeCompare(bNum ?? '');
    if (cmp !== 0) return cmp;
  }
  return (aRow ?? '').localeCompare(bRow ?? '');
}

export class InventoryService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new InventoryService(await withContext());
  }

  async list(filters: ItemListFilters = {}) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = Math.max(0, filters.offset ?? 0);
    // Pass our ctx so getWarehouseAccess doesn't fall through to
    // requireOrgContext() — same NEXT_REDIRECT trap that broke
    // /api/v1/items/[id]/barcode when called from an API route.
    const access = await getWarehouseAccess(this.ctx);

    const sortKey = filters.sort ?? 'updated_desc';
    const sort = SORT_MAP[sortKey] ?? SORT_MAP.updated_desc;

    let query = this.ctx.supabase
      .from('inventory_items')
      .select(
        'id, sku, barcode, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, custom_fields, created_at, updated_at, created_by, updated_by',
        // Exact count: pagination needs precise totals so "Page X of Y"
        // math doesn't lie, and the empty-state heuristics
        // (`inventory.total === 0`) don't false-fire on stale
        // pg_class.reltuples after a fresh import. Sub-50ms even on
        // 50k+ row tables with the existing org_id index.
        { count: 'exact' },
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .order(sort.col, { ascending: sort.asc })
      // Stable secondary sort so paginated rows don't shuffle when the
      // primary key has duplicates (e.g. many items with qty_on_hand=0).
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    // Warehouse scoping: defense against URL/API tampering. Warehouse-scoped
    // users (staff/viewer) never see items outside their assignments — even
    // if the request omits or forges warehouseId. Managers/admins may pass
    // an optional warehouseId filter; otherwise see everything.
    if (!access.hasAllAccess) {
      if (access.readableIds.length === 0) {
        return { items: [], total: 0 };
      }
      query = query.in('warehouse_id', access.readableIds);
    } else if (filters.warehouseId) {
      query = query.eq('warehouse_id', filters.warehouseId);
    }

    if (!filters.status || filters.status === 'active') {
      query = query.eq('status', 'active');
    } else if (filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.q && filters.q.trim()) {
      // PostgREST's .or() takes a raw filter string. Strip characters
      // that would let a search term escape its clause and fan out the
      // filter tree (commas, parens, asterisks, percent signs). Also
      // cap at a sane length so a 10MB search term can't be ingested.
      const term = filters.q
        .trim()
        .slice(0, 120)
        .replace(/[,()%*]/g, ' ');
      if (term) {
        query = query.or(
          `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%`,
        );
      }
    }
    if (filters.barcode && filters.barcode.trim()) {
      query = query.eq('barcode', filters.barcode.trim());
    }
    if (filters.rack && filters.rack.trim()) {
      const rack = filters.rack.trim();
      // Books use the legacy book_rack_* keys; everything else uses the
      // neutral rack_* keys. Both are inside custom_fields and matched
      // exactly. "38-A" splits into number/row; "38" alone matches just
      // the number. When itemType is 'all' (the dashboard "Review low
      // stock" link uses this), we OR both key sets so each row matches
      // against its OWN type's keys.
      //
      // Sanitize: `num` and `row` are interpolated into PostgREST's .or()
      // string for the 'all' branch. Without an alphanumeric allow-list a
      // hostile rack value (e.g. "20),or(deleted_at.not.is.null") could
      // escape the and(...) clause and inject a sibling predicate. Form
      // and bulk inputs already digits-only / [A-Z0-9]; this is
      // defense-in-depth at the service layer.
      const sanitize = (s: string | undefined): string =>
        (s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      const [rawNum, rawRow] = rack.split('-', 2);
      const num = sanitize(rawNum);
      const row = sanitize(rawRow);
      if (num) {
        if (filters.itemType === 'book') {
          query = query.filter('custom_fields->>book_rack_number', 'eq', num);
          if (row) query = query.filter('custom_fields->>book_rack_row', 'eq', row);
        } else if (filters.itemType === 'all') {
          // OR-of-ANDs: (item is a book AND book keys match) OR
          // (item is not a book AND rack keys match).
          const bookClause = row
            ? `and(item_type.eq.book,custom_fields->>book_rack_number.eq.${num},custom_fields->>book_rack_row.eq.${row})`
            : `and(item_type.eq.book,custom_fields->>book_rack_number.eq.${num})`;
          const itemClause = row
            ? `and(item_type.neq.book,custom_fields->>rack_number.eq.${num},custom_fields->>rack_row.eq.${row})`
            : `and(item_type.neq.book,custom_fields->>rack_number.eq.${num})`;
          query = query.or(`${bookClause},${itemClause}`);
        } else {
          query = query.filter('custom_fields->>rack_number', 'eq', num);
          if (row) query = query.filter('custom_fields->>rack_row', 'eq', row);
        }
      }
    }
    // Multi-select takes precedence; fall back to legacy single-id when
    // the array is empty/missing so AI tools and any prior caller keep
    // working unchanged.
    if (filters.categoryIds && filters.categoryIds.length > 0) {
      query = query.in('category_id', filters.categoryIds);
    } else if (filters.categoryId) {
      query = query.eq('category_id', filters.categoryId);
    }
    if (filters.locationIds && filters.locationIds.length > 0) {
      query = query.in('primary_location_id', filters.locationIds);
    } else if (filters.locationId) {
      query = query.eq('primary_location_id', filters.locationId);
    }
    if (filters.supplierIds && filters.supplierIds.length > 0) {
      query = query.in('supplier_id', filters.supplierIds);
    } else if (filters.supplierId) {
      query = query.eq('supplier_id', filters.supplierId);
    }
    if (filters.outOfStock) query = query.lte('quantity_on_hand', 0);
    // PostgREST can't express qty_on_hand <= reorder_point in a single
    // filter, so narrow with an OR pre-filter and do the final
    // cross-column compare in JS below:
    //   - reorder_point > 0 → traditional "low": qty <= reorder_point
    //   - qty <= 0           → critical regardless of reorder_point
    // The OR catches items with reorder_point = 0 AND qty = 0, which
    // were previously hidden from the "Review low stock" dashboard
    // alert because the dashboard count = lowStock + outOfStock but
    // ?stock=low only returned the lowStock half.
    if (filters.lowStock) {
      query = query.or('reorder_point.gt.0,quantity_on_hand.lte.0');
    }

    // item_type defaults to 'product' so the legacy /dashboard/inventory tab
    // doesn't accidentally show books/assets. Pass 'all' to disable.
    if (filters.itemType === undefined) {
      query = query.eq('item_type', 'product');
    } else if (filters.itemType !== 'all') {
      query = query.eq('item_type', filters.itemType);
    }

    if (filters.createdSince) query = query.gte('created_at', filters.createdSince);
    if (filters.createdUntil) query = query.lt('created_at', filters.createdUntil);
    if (filters.updatedSince) query = query.gte('updated_at', filters.updatedSince);
    if (filters.updatedUntil) query = query.lt('updated_at', filters.updatedUntil);

    const { data, error, count } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    let rows = data ?? [];
    let totalCount = count ?? 0;
    if (filters.lowStock) {
      const filtered = rows.filter(
        (r: { quantity_on_hand: number; reorder_point: number }) =>
          // Below or at reorder line, OR critically out of stock even
          // when no reorder line was set. Matches the dashboard alert
          // count (lowStockCount + outOfStockCount).
          r.quantity_on_hand <= r.reorder_point || r.quantity_on_hand <= 0,
      );
      totalCount = filtered.length;
      rows = filtered;
    }

    return {
      items: rows as Array<{
        id: string;
        sku: string;
        barcode: string | null;
        name: string;
        description: string | null;
        status: 'active' | 'archived' | 'discontinued';
        quantity_on_hand: number;
        reorder_point: number;
        unit_cost: number;
        retail_price: number;
        category_id: string | null;
        supplier_id: string | null;
        primary_location_id: string | null;
        warehouse_id: string | null;
        charter_id: string | null;
        tracking_type: 'none' | 'lot' | 'serial';
        item_type: 'product' | 'book' | 'asset' | 'consumable';
        custom_fields: Record<string, unknown>;
        created_at: string;
        updated_at: string;
      }>,
      total: totalCount,
    };
  }

  /**
   * Loads only the (id, sku, name, tracking_type) tuple for a list of item
   * ids. Lets callers like the PO detail page render line rows without
   * over-fetching the entire inventory just for name/sku lookups. Order
   * is not guaranteed; callers should index by id.
   */
  async byIds(
    ids: string[],
  ): Promise<Array<{ id: string; sku: string; name: string; tracking_type: 'none' | 'lot' | 'serial' }>> {
    if (ids.length === 0) return [];
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, tracking_type')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', ids)
      .is('deleted_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      sku: r.sku as string,
      name: r.name as string,
      tracking_type: ((r.tracking_type as string | null) ?? 'none') as
        | 'none'
        | 'lot'
        | 'serial',
    }));
  }

  /**
   * Distinct rack labels for the rack-filter dropdown. Reads JSONB
   * custom_fields directly (per-scope key set):
   *   - 'items' → {rack_number}{-rack_row?} from non-book items
   *   - 'books' → {book_rack_number}{-book_rack_row?} from books
   * Returns sorted, de-duplicated strings; empty when nothing has a
   * rack set yet. (Pre-existing items that only have bin_location set
   * are mirrored into custom_fields.rack_number by migration 0065 so
   * they surface here without the user re-saving.)
   */
  async listDistinctRacks(opts: { scope: 'items' | 'books' | 'all' }): Promise<string[]> {
    // Server-side DISTINCT via the public.inventory_distinct_racks
    // function (migration 0066). RLS scopes the read to the caller's
    // org. Returns a pre-sorted, deduped text[] so we don't ship
    // every row's custom_fields over the wire just to compute the
    // dropdown options.
    //
    // The RPC's ORDER BY is alphabetic ("10" < "2"), so we re-sort
    // numerically in JS regardless of scope. Keeps the dropdown
    // ordered top-to-bottom the way a user reads the stockroom map
    // without a new migration for a presentation-only fix.
    if (opts.scope !== 'all') {
      const { data, error } = await this.ctx.supabase.rpc(
        'inventory_distinct_racks',
        { p_scope: opts.scope },
      );
      if (error) throw new ServiceError('internal_error', error.message);
      return ((data ?? []) as string[]).slice().sort(rackCmp);
    }
    // 'all' — the RPC only knows the two scoped key-sets, so fetch
    // both and merge client-side. Dedupe + numeric-sort to keep the
    // dropdown identical in shape to the single-scope path.
    const [items, books] = await Promise.all([
      this.ctx.supabase.rpc('inventory_distinct_racks', { p_scope: 'items' }),
      this.ctx.supabase.rpc('inventory_distinct_racks', { p_scope: 'books' }),
    ]);
    if (items.error) throw new ServiceError('internal_error', items.error.message);
    if (books.error) throw new ServiceError('internal_error', books.error.message);
    const set = new Set<string>([
      ...((items.data ?? []) as string[]),
      ...((books.data ?? []) as string[]),
    ]);
    return Array.from(set).sort(rackCmp);
  }

  async get(id: string) {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Item not found');

    // Re-check warehouse access on the loaded row in case RLS was bypassed
    // (e.g. service-role contexts). For warehouse-scoped users this enforces
    // their assignment list.
    //
    // Pass our own ctx so the helper doesn't fall back to
    // requireOrgContext() — that path redirects to /signin and inside an
    // API route the redirect throws NEXT_REDIRECT, surfacing as a 500
    // (which broke the Print Label endpoint until this was fixed).
    const wh = (data as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) {
      try {
        await assertWarehouseAccess(wh, 'read', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) throw new ServiceError('not_found', 'Item not found');
        throw e;
      }
    }
    return data;
  }

  async create(input: CreateItemInput) {
    assertPermission(this.ctx, 'items:create');
    await assertPlanLimit(this.ctx, 'items');

    const sku = (input.sku && input.sku.trim()) || generateSku();

    // Resolve warehouse: warehouse-scoped users (staff/viewer) get their
    // assignment forced regardless of input. Managers/admins must specify
    // one (we can't pick "any" silently — items must belong to a warehouse).
    // Pass our ctx so the helpers don't fall back to requireOrgContext()
    // (NEXT_REDIRECT trap when called from /api/* routes).
    const forced = await forcedWarehouseId(this.ctx);
    const resolvedWarehouseId = forced ?? input.warehouseId ?? null;
    if (!resolvedWarehouseId) {
      throw new ServiceError(
        'validation_error',
        'A warehouse must be selected before creating an item.',
      );
    }
    if (!forced) {
      // Manager/admin path: validate they have write access to the chosen warehouse.
      await assertWarehouseAccess(resolvedWarehouseId, 'write', this.ctx);
    }

    // Resolve charter: null = generic stock; otherwise (warehouse, charter)
    // must be a real pairing in warehouse_charters. The composite FK enforces
    // it on insert, but a friendlier error here saves a round trip.
    const resolvedCharterId = input.charterId ?? null;
    if (resolvedCharterId) {
      const { data: pair } = await this.ctx.supabase
        .from('warehouse_charters')
        .select('charter_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', resolvedWarehouseId)
        .eq('charter_id', resolvedCharterId)
        .maybeSingle();
      if (!pair) {
        throw new ServiceError(
          'validation_error',
          'This charter is not serviced by the chosen warehouse. Pick a different one or mark the item as Generic.',
        );
      }
    }

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: resolvedWarehouseId,
        charter_id: resolvedCharterId,
        sku,
        barcode: input.barcode ?? null,
        name: input.name,
        description: input.description ?? null,
        category_id: input.categoryId ?? null,
        supplier_id: input.supplierId ?? null,
        primary_location_id: input.primaryLocationId ?? null,
        unit_cost: input.unitCost,
        retail_price: input.retailPrice,
        quantity_on_hand: input.quantityOnHand,
        reorder_point: input.reorderPoint,
        reorder_quantity: input.reorderQuantity,
        unit_of_measure: input.unitOfMeasure,
        bin_location: input.binLocation ?? null,
        tracking_type: input.trackingType,
        item_type: input.itemType,
        custom_fields: input.customFields,
        status: input.status,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A item with that SKU already exists');
      }
      throw new ServiceError('internal_error', error.message);
    }

    if (input.quantityOnHand && input.quantityOnHand > 0) {
      await this.ctx.supabase.from('stock_movements').insert({
        organization_id: this.ctx.organizationId,
        item_id: data.id,
        movement_type: 'initial',
        quantity_change: input.quantityOnHand,
        previous_quantity: 0,
        new_quantity: input.quantityOnHand,
        user_id: this.ctx.userId,
        to_location_id: input.primaryLocationId ?? null,
      });
    }

    void audit(
      {
        event: 'inventory.item.created',
        entityType: 'inventory_item',
        entityId: data.id as string,
        warehouseId: resolvedWarehouseId,
      },
      this.ctx,
    );

    // Fire-and-forget embedding so the new row participates in semantic
    // search. Failures are swallowed inside the helper — never block
    // create on a Gemini hiccup.
    void (async () => {
      const { embedInventoryItem } = await import('@/lib/ai/embeddings');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await embedInventoryItem(data.id as string, this.ctx as any);
    })();

    return data;
  }

  /**
   * Batch-create N inventory items in one transaction-ish flow. Hoists the
   * permission / plan-limit / warehouse-access / charter-pair checks out of
   * the per-row loop and does ONE INSERT for inventory_items + ONE for
   * stock_movements.
   *
   * Compared to looping `create()` per book this drops ~5N round-trips down
   * to ~7 total for a 100-row import, which is the difference between
   * "Vercel 504 around row 50" and "comfortably under 60s." See
   * BooksImportService.execute for the AI-tools equivalent path.
   *
   * Collisions on barcode are detected via a pre-flight lookup and counted
   * as `skipped`, NOT thrown — matches the existing per-row action's
   * "conflict = skip" semantic. A Postgres-level 23505 still aborts the
   * whole batch (defensive), since the pre-flight is a snapshot read.
   */
  /**
   * Bulk-creates one inventory_items row per selected size in a single
   * insert. Used by the Items form when the selected category has
   * supports_sizes = true. Name + SKU + custom_fields.size are computed
   * per variant; all other fields are copied verbatim. Plan-limit check
   * runs once against the total variant count.
   *
   * Mirrors create()'s guards: warehouse resolution (forced for staff/
   * viewer, asserted for managers), charter-pair validation, and
   * stock_movements writeback after the insert so the audit trail +
   * dashboard sparklines stay accurate.
   */
  async bulkCreateSizedVariants(input: {
    baseName: string;
    baseSku: string | null;
    baseBarcode: string | null;
    description: string | null;
    categoryId: string;
    supplierId: string | null;
    warehouseId: string;
    charterId: string | null;
    primaryLocationId: string | null;
    binLocation: string | null;
    retailPrice: number;
    unitCost: number;
    reorderPoint: number;
    reorderQuantity: number;
    unitOfMeasure: string;
    /** Structured rack stamp written to every variant's custom_fields.rack_number/rack_row. */
    rackNumber?: string | null;
    rackRow?: string | null;
    variants: Array<{
      size: 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
      quantity: number;
    }>;
  }): Promise<Array<{ id: string; name: string; sku: string }>> {
    assertPermission(this.ctx, 'items:create');
    if (input.variants.length === 0) {
      throw new ServiceError(
        'validation_error',
        'Pick at least one size or change the category.',
      );
    }
    await assertPlanLimit(this.ctx, 'items', input.variants.length);

    // Resolve warehouse: warehouse-scoped users get their assignment
    // forced; managers must specify a warehouse they can write to.
    // Mirrors create() exactly so the security gates are identical.
    const forced = await forcedWarehouseId(this.ctx);
    const resolvedWarehouseId = forced ?? input.warehouseId ?? null;
    if (!resolvedWarehouseId) {
      throw new ServiceError(
        'validation_error',
        'A warehouse must be selected before creating variants.',
      );
    }
    if (!forced) {
      await assertWarehouseAccess(resolvedWarehouseId, 'write', this.ctx);
    }

    // Validate (warehouse, charter) pair when a charter is set.
    const resolvedCharterId = input.charterId ?? null;
    if (resolvedCharterId) {
      const { data: pair } = await this.ctx.supabase
        .from('warehouse_charters')
        .select('charter_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', resolvedWarehouseId)
        .eq('charter_id', resolvedCharterId)
        .maybeSingle();
      if (!pair) {
        throw new ServiceError(
          'validation_error',
          'This charter is not serviced by the chosen warehouse. Pick a different one or mark the variants as Generic.',
        );
      }
    }

    // Auto-generate ONE shared base when the user didn't type a SKU
    // (matches the spec: "auto-gen base, then suffix per size"). Skipping
    // this would NOT-NULL-violate the inventory_items.sku constraint.
    const sharedBase = (input.baseSku && input.baseSku.trim()) || generateSku();

    // Rack stamp shared by every variant. Stripped to the same shapes
    // the form input enforces (digits-only number, A-Z0-9 row uppercase).
    const rackNum = input.rackNumber?.trim().replace(/[^0-9]/g, '') || null;
    const rackRow =
      input.rackRow?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    const variantCustomFields = (size: string) => {
      const cf: Record<string, unknown> = { size };
      if (rackNum) cf.rack_number = rackNum;
      if (rackRow) cf.rack_row = rackRow;
      return cf;
    };

    const rows = input.variants.map((v) => ({
      organization_id: this.ctx.organizationId,
      name: `${input.baseName} - ${v.size}`,
      sku: `${sharedBase}-${v.size}`,
      barcode: input.baseBarcode,
      description: input.description,
      category_id: input.categoryId,
      supplier_id: input.supplierId,
      warehouse_id: resolvedWarehouseId,
      charter_id: resolvedCharterId,
      primary_location_id: input.primaryLocationId,
      bin_location: input.binLocation,
      retail_price: input.retailPrice,
      unit_cost: input.unitCost,
      reorder_point: input.reorderPoint,
      reorder_quantity: input.reorderQuantity,
      quantity_on_hand: v.quantity,
      unit_of_measure: input.unitOfMeasure,
      item_type: 'product',
      status: 'active',
      tracking_type: 'none',
      custom_fields: variantCustomFields(v.size),
      created_by: this.ctx.userId,
      updated_by: this.ctx.userId,
    }));

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .insert(rows)
      .select('id, name, sku, quantity_on_hand, primary_location_id');
    if (error) {
      // 23505 = unique_violation — typically SKU collision.
      if ((error as { code?: string }).code === '23505') {
        throw new ServiceError(
          'conflict',
          'One or more variant SKUs already exist. Pick a different base SKU.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }

    // Stock_movements for non-zero variants so the audit trail and the
    // 14-day sparklines pick up the initial qty event. Mirrors the
    // same pattern as bulkCreate; a movement-log failure does NOT roll
    // back the items insert (items exist, gap is recoverable).
    const inserted = (data ?? []) as Array<{
      id: string;
      name: string;
      sku: string;
      quantity_on_hand: number;
      primary_location_id: string | null;
    }>;
    const movementRows = inserted
      .filter((r) => r.quantity_on_hand > 0)
      .map((r) => ({
        organization_id: this.ctx.organizationId,
        item_id: r.id,
        movement_type: 'initial',
        quantity_change: r.quantity_on_hand,
        previous_quantity: 0,
        new_quantity: r.quantity_on_hand,
        user_id: this.ctx.userId,
        to_location_id: r.primary_location_id,
      }));
    if (movementRows.length > 0) {
      const { error: movementErr } = await this.ctx.supabase
        .from('stock_movements')
        .insert(movementRows);
      if (movementErr) {
        console.warn(
          '[bulkCreateSizedVariants] stock_movements insert failed',
          movementErr.message,
        );
      }
    }

    for (const r of inserted) {
      void audit(
        {
          event: 'inventory.item.created',
          entityType: 'inventory_item',
          entityId: r.id as string,
          warehouseId: resolvedWarehouseId,
          extra: { bulk_op: 'sized_variants' },
        },
        this.ctx,
      );
    }

    return inserted.map((r) => ({ id: r.id, name: r.name, sku: r.sku }));
  }

  async bulkCreate(input: {
    warehouseId: string;
    charterId?: string | null;
    items: Array<{
      name: string;
      barcode: string;
      itemType: 'book' | 'product' | 'asset' | 'consumable';
      sku?: string | null;
      description?: string | null;
      quantityOnHand: number;
      unitCost: number;
      retailPrice: number;
      reorderPoint?: number;
      reorderQuantity?: number;
      unitOfMeasure?: string;
      trackingType?: 'none' | 'lot' | 'serial';
      customFields?: Record<string, unknown> | null;
      status?: 'active' | 'archived' | 'discontinued';
    }>;
  }): Promise<{
    created: number;
    skipped: number;
    errors: Array<{ barcode: string; reason: string }>;
    createdIds: string[];
  }> {
    assertPermission(this.ctx, 'items:create');
    if (input.items.length === 0) {
      return { created: 0, skipped: 0, errors: [], createdIds: [] };
    }
    if (input.items.length > 500) {
      throw new ServiceError(
        'validation_error',
        'Bulk import is limited to 500 items per call.',
      );
    }

    // Resolve warehouse ONCE (was per-row).
    const forced = await forcedWarehouseId(this.ctx);
    const resolvedWarehouseId = forced ?? input.warehouseId;
    if (!resolvedWarehouseId) {
      throw new ServiceError(
        'validation_error',
        'A warehouse must be selected before creating items.',
      );
    }
    if (!forced) {
      await assertWarehouseAccess(resolvedWarehouseId, 'write', this.ctx);
    }

    // Validate the (warehouse, charter) pair ONCE — same pair applies to
    // every row in the batch.
    const resolvedCharterId = input.charterId ?? null;
    if (resolvedCharterId) {
      const { data: pair } = await this.ctx.supabase
        .from('warehouse_charters')
        .select('charter_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', resolvedWarehouseId)
        .eq('charter_id', resolvedCharterId)
        .maybeSingle();
      if (!pair) {
        throw new ServiceError(
          'validation_error',
          'This charter is not serviced by the chosen warehouse. Pick a different one or mark the items as Generic.',
        );
      }
    }

    // Plan-limit aware of batch size — was per-row (would only catch the
    // last row crossing the limit and fail the rest after partial inserts).
    const { data: org } = await this.ctx.supabase
      .from('organizations')
      .select('plan')
      .eq('id', this.ctx.organizationId)
      .single();
    const { PLANS, isUnlimited } = await import('@stockpilot/core');
    const plan = ((org?.plan as string | undefined) ?? 'free') as keyof typeof PLANS;
    const limit = PLANS[plan]?.limits.items ?? PLANS.free.limits.items;
    if (!isUnlimited(limit)) {
      const { count: currentCount } = await this.ctx.supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null);
      if ((currentCount ?? 0) + input.items.length > limit) {
        throw new ServiceError(
          'plan_limit_exceeded',
          `Importing ${input.items.length} items would exceed your ${PLANS[plan].name} plan limit of ${limit} items.`,
        );
      }
    }

    // Pre-flight: which barcodes already exist? Count those as skipped,
    // build payloads only for the survivors.
    const allBarcodes = input.items.map((i) => i.barcode);
    const { data: existing } = await this.ctx.supabase
      .from('inventory_items')
      .select('barcode')
      .eq('organization_id', this.ctx.organizationId)
      .in('barcode', allBarcodes);
    const existingSet = new Set(
      (existing ?? []).map((r: { barcode: string }) => r.barcode),
    );

    const survivors = input.items.filter((i) => !existingSet.has(i.barcode));
    const skipped = input.items.length - survivors.length;

    if (survivors.length === 0) {
      return {
        created: 0,
        skipped,
        errors: [],
        createdIds: [],
      };
    }

    // Build the batch INSERT payload. Generate SKUs in JS.
    const rows = survivors.map((i) => ({
      organization_id: this.ctx.organizationId,
      warehouse_id: resolvedWarehouseId,
      charter_id: resolvedCharterId,
      sku: (i.sku && i.sku.trim()) || generateSku(),
      barcode: i.barcode,
      name: i.name,
      description: i.description ?? null,
      unit_cost: i.unitCost,
      retail_price: i.retailPrice,
      quantity_on_hand: i.quantityOnHand,
      reorder_point: i.reorderPoint ?? 0,
      reorder_quantity: i.reorderQuantity ?? 0,
      unit_of_measure: i.unitOfMeasure ?? 'unit',
      tracking_type: i.trackingType ?? 'none',
      item_type: i.itemType,
      custom_fields: i.customFields ?? {},
      status: i.status ?? 'active',
      created_by: this.ctx.userId,
      updated_by: this.ctx.userId,
    }));

    const { data: inserted, error } = await this.ctx.supabase
      .from('inventory_items')
      .insert(rows)
      .select('id, quantity_on_hand');

    if (error) {
      if (error.code === '23505') {
        // A duplicate slipped past the pre-flight (race with a concurrent
        // import). Whole batch rejected — Postgres rolled it back.
        throw new ServiceError(
          'conflict',
          'A duplicate SKU or barcode was inserted by another caller during this import. Try again.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }

    const createdIds = (inserted ?? []).map((r: { id: string }) => r.id);

    // Batch stock_movements for non-zero quantities (was per-row).
    const movementRows = (inserted ?? [])
      .filter((r: { quantity_on_hand: number }) => r.quantity_on_hand > 0)
      .map((r: { id: string; quantity_on_hand: number }) => ({
        organization_id: this.ctx.organizationId,
        item_id: r.id,
        movement_type: 'initial',
        quantity_change: r.quantity_on_hand,
        previous_quantity: 0,
        new_quantity: r.quantity_on_hand,
        user_id: this.ctx.userId,
      }));

    if (movementRows.length > 0) {
      const { error: movementErr } = await this.ctx.supabase
        .from('stock_movements')
        .insert(movementRows);
      // Don't roll back the items insert on a movement-log failure —
      // the items exist, the audit gap is recoverable. Log and continue.
      if (movementErr) {
        console.warn(
          '[bulkCreate] stock_movements insert failed after inventory_items insert',
          movementErr.message,
        );
      }
    }

    for (const id of createdIds) {
      void audit(
        {
          event: 'inventory.item.created',
          entityType: 'inventory_item',
          entityId: id,
          warehouseId: input.warehouseId,
          extra: { bulk_op: 'bulk_create' },
        },
        this.ctx,
      );
    }

    return {
      created: createdIds.length,
      skipped,
      errors: [],
      createdIds,
    };
  }

  async update(id: string, patch: UpdateItemInput) {
    assertPermission(this.ctx, 'items:update');

    // Load current row to enforce warehouse-write access and to lock down
    // moves. Warehouse-scoped users cannot move an item to another warehouse;
    // managers/admins can only move it if they have write access to both.
    const current = await this.get(id);
    const currentWarehouseId = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (currentWarehouseId) await assertWarehouseAccess(currentWarehouseId, 'write', this.ctx);

    const updates: Record<string, unknown> = { updated_by: this.ctx.userId };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.sku !== undefined) updates.sku = patch.sku;
    if (patch.barcode !== undefined) updates.barcode = patch.barcode ?? null;
    if (patch.description !== undefined) updates.description = patch.description ?? null;
    if (patch.categoryId !== undefined) updates.category_id = patch.categoryId ?? null;
    if (patch.supplierId !== undefined) updates.supplier_id = patch.supplierId ?? null;
    if (patch.primaryLocationId !== undefined) updates.primary_location_id = patch.primaryLocationId ?? null;
    if (patch.unitCost !== undefined) updates.unit_cost = patch.unitCost;
    if (patch.retailPrice !== undefined) updates.retail_price = patch.retailPrice;
    if (patch.reorderPoint !== undefined) updates.reorder_point = patch.reorderPoint;
    if (patch.reorderQuantity !== undefined) updates.reorder_quantity = patch.reorderQuantity;
    if (patch.unitOfMeasure !== undefined) updates.unit_of_measure = patch.unitOfMeasure;
    if (patch.binLocation !== undefined) updates.bin_location = patch.binLocation ?? null;
    if (patch.trackingType !== undefined) updates.tracking_type = patch.trackingType;
    if (patch.itemType !== undefined) updates.item_type = patch.itemType;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.customFields !== undefined) updates.custom_fields = patch.customFields;

    if (patch.warehouseId !== undefined && patch.warehouseId !== currentWarehouseId) {
      const forced = await forcedWarehouseId(this.ctx);
      if (forced) {
        throw new ServiceError(
          'forbidden',
          'Warehouse-scoped users cannot move items to another warehouse.',
        );
      }
      if (!patch.warehouseId) {
        throw new ServiceError('validation_error', 'Item must remain assigned to a warehouse.');
      }
      await assertWarehouseAccess(patch.warehouseId, 'write', this.ctx);
      updates.warehouse_id = patch.warehouseId;
    }

    if (patch.charterId !== undefined) {
      // Validate the (final) (warehouse, charter) pair if non-null
      const finalWarehouseId =
        (updates.warehouse_id as string | undefined) ?? currentWarehouseId ?? null;
      if (patch.charterId && finalWarehouseId) {
        const { data: pair } = await this.ctx.supabase
          .from('warehouse_charters')
          .select('charter_id')
          .eq('organization_id', this.ctx.organizationId)
          .eq('warehouse_id', finalWarehouseId)
          .eq('charter_id', patch.charterId)
          .maybeSingle();
        if (!pair) {
          throw new ServiceError(
            'validation_error',
            'This charter is not serviced by the chosen warehouse.',
          );
        }
      }
      updates.charter_id = patch.charterId ?? null;
    }

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new ServiceError('internal_error', error.message);

    // Drop the cosmetic `updated_by` from the changed-keys list so the
    // audit row reflects what the caller actually edited.
    const changedKeys = Object.keys(updates).filter((k) => k !== 'updated_by');
    void audit(
      {
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: id,
        warehouseId: (data as { warehouse_id?: string | null }).warehouse_id ?? null,
        extra: { changed_keys: changedKeys },
      },
      this.ctx,
    );

    // Re-embed only when an embedding-relevant field changed — saves a
    // Gemini call when the user only edited price / reorder thresholds.
    const EMBED_RELEVANT_KEYS = new Set([
      'name',
      'sku',
      'barcode',
      'description',
      'custom_fields',
    ]);
    if (changedKeys.some((k) => EMBED_RELEVANT_KEYS.has(k))) {
      void (async () => {
        const { embedInventoryItem } = await import('@/lib/ai/embeddings');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await embedInventoryItem(id, this.ctx as any);
      })();
    }

    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'items:update');
    const current = await this.get(id);
    const wh = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);
    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update({ status: 'archived', updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);

    // Emit a stock_movements row so the dashboard's on-hand-count math
    // doesn't silently lose qty when an item with stock is archived.
    // movement_type enum doesn't have 'archived' (see migration 0040 — valid
    // values: add/remove/adjust/transfer/receive_po/return/damage/loss/
    // correction/initial/bundle_*), so we use 'adjust' and stash the
    // lifecycle hint in `reason`. Best-effort: failure does NOT roll back
    // the archive — same pattern as bulkCreate.
    const onHand = Number((current as { quantity_on_hand?: number }).quantity_on_hand ?? 0);
    if (onHand > 0) {
      const { error: mvErr } = await this.ctx.supabase.from('stock_movements').insert({
        organization_id: this.ctx.organizationId,
        item_id: id,
        movement_type: 'adjust',
        quantity_change: -onHand,
        previous_quantity: onHand,
        new_quantity: 0,
        user_id: this.ctx.userId,
        reason: 'item_archived',
      });
      if (mvErr) {
        console.warn('[archive] stock_movements writeback failed:', mvErr.message);
      }
    }

    void audit(
      {
        event: 'inventory.item.archived',
        entityType: 'inventory_item',
        entityId: id,
        warehouseId: wh,
      },
      this.ctx,
    );
  }

  /**
   * Bulk-applies one of a small whitelist of mutations across multiple
   * items. Validates per-item warehouse access (so a manager can't batch-
   * mutate an item in a warehouse they can't write to). Returns counts.
   *
   * Why one method instead of bulkArchive / bulkSetCategory / etc.: the
   * permission check + per-item warehouse-access loop is identical for
   * all of them, and bundling keeps that loop in one place.
   */
  async bulkUpdate(input: {
    ids: string[];
    op:
      | { kind: 'archive' }
      | { kind: 'unarchive' }
      | { kind: 'set_category'; categoryId: string | null }
      | { kind: 'set_supplier'; supplierId: string | null }
      | { kind: 'set_location'; locationId: string | null }
      | { kind: 'set_status'; status: 'active' | 'archived' | 'discontinued' }
      | { kind: 'add_tags'; tagIds: string[] }
      | { kind: 'remove_tags'; tagIds: string[] }
      | {
          /**
           * Bulk Set rack — merges rack_number / rack_row into each row's
           * custom_fields (preserving anything else stored there) and
           * derives bin_location from the composed '{number}-{row}' label
           * so order pick + cycle-count PDFs keep their location signal.
           * Pass null for either piece to clear it.
           */
          kind: 'set_rack';
          rackNumber: string | null;
          rackRow: string | null;
        };
  }): Promise<{ ok: number; skipped: number }> {
    assertPermission(this.ctx, 'items:update');
    if (input.ids.length === 0) return { ok: 0, skipped: 0 };
    if (input.ids.length > 500) {
      throw new ServiceError(
        'validation_error',
        'Bulk operations are limited to 500 items at a time.',
      );
    }

    const { data: rows, error: loadErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', input.ids)
      .is('deleted_at', null);
    if (loadErr) throw new ServiceError('internal_error', loadErr.message);

    const access = await getWarehouseAccess(this.ctx);
    const writableSet = new Set(access.writableIds);
    const allowedIds: string[] = [];
    let skipped = 0;
    for (const r of rows ?? []) {
      const wh = (r.warehouse_id as string | null) ?? null;
      if (access.hasAllAccess || wh === null || writableSet.has(wh)) {
        allowedIds.push(r.id as string);
      } else {
        skipped += 1;
      }
    }
    if (allowedIds.length === 0) return { ok: 0, skipped };

    // Rack ops merge into custom_fields server-side via a SECURITY
    // INVOKER Postgres function (migrations 0064/0068). The function
    // does a single atomic UPDATE with
    // `custom_fields - keys || jsonb_build_object(...)` so concurrent
    // edits to other keys (author, book_grade, thumbnail_url) aren't
    // clobbered. p_scope='auto' branches per row on item_type so books
    // get the legacy book_rack_* keys and items get the neutral rack_*.
    // The RPC returns the actual row_count, which we surface as `ok`
    // so a UI like "Updated N items" doesn't lie when RLS filtered
    // some rows out.
    if (input.op.kind === 'set_rack') {
      const num = input.op.rackNumber?.trim() || null;
      const row = input.op.rackRow?.trim().toUpperCase() || null;
      const composedBin = num ? (row ? `${num}-${row}` : num) : null;

      const { data: updatedCount, error } = await this.ctx.supabase.rpc(
        'inventory_set_rack',
        {
          p_item_ids: allowedIds,
          p_rack_number: num,
          p_rack_row: row,
          p_bin_location: composedBin,
          p_scope: 'auto',
        },
      );
      if (error) throw new ServiceError('internal_error', error.message);
      const ok = typeof updatedCount === 'number' ? updatedCount : 0;
      // Emit a per-item audit row for the set_rack mutation. We don't
      // know which of `allowedIds` survived RLS, so this slightly
      // over-counts when ok < allowedIds.length — acceptable cost for
      // a queryable trail.
      for (const id of allowedIds) {
        void audit(
          {
            event: 'inventory.item.updated',
            entityType: 'inventory_item',
            entityId: id,
            extra: { bulk_op: 'set_rack', rack_number: num, rack_row: row },
          },
          this.ctx,
        );
      }
      // RLS filtered the gap (if any). Surface it in `skipped` so the
      // "Updated X · Skipped Y" toast remains truthful.
      return { ok, skipped: skipped + (allowedIds.length - ok) };
    }

    // Tag ops bypass the inventory_items row update — they only touch
    // the item_tags junction. Delegate to TagsService so the audit
    // events + tag-id validation stay in one place.
    if (input.op.kind === 'add_tags' || input.op.kind === 'remove_tags') {
      const tags = new TagsService(this.ctx);
      if (input.op.kind === 'add_tags') {
        await tags.bulkAddToItems(allowedIds, input.op.tagIds);
      } else {
        await tags.bulkRemoveFromItems(allowedIds, input.op.tagIds);
      }
      return { ok: allowedIds.length, skipped };
    }

    const update: Record<string, unknown> = { updated_by: this.ctx.userId };
    switch (input.op.kind) {
      case 'archive':
        update.status = 'archived';
        break;
      case 'unarchive':
        update.status = 'active';
        break;
      case 'set_status':
        update.status = input.op.status;
        break;
      case 'set_category':
        update.category_id = input.op.categoryId;
        break;
      case 'set_supplier':
        update.supplier_id = input.op.supplierId;
        break;
      case 'set_location':
        update.primary_location_id = input.op.locationId;
        break;
    }

    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update(update)
      .eq('organization_id', this.ctx.organizationId)
      .in('id', allowedIds);
    if (error) throw new ServiceError('internal_error', error.message);

    // Emit one audit row per affected item so the per-item history
    // surfaces in the "View history" link on the Recovery page and in
    // the audit log's entity filter. Map archive/unarchive to the
    // matching lifecycle events; everything else funnels into
    // `inventory.item.updated` with the bulk op kind in `extra` so the
    // audit reader can tell apart "edited via single form" from
    // "edited via bulk action".
    const bulkEvent =
      input.op.kind === 'archive'
        ? ('inventory.item.archived' as const)
        : ('inventory.item.updated' as const);
    for (const id of allowedIds) {
      void audit(
        {
          event: bulkEvent,
          entityType: 'inventory_item',
          entityId: id,
          extra: { bulk_op: input.op.kind },
        },
        this.ctx,
      );
    }

    return { ok: allowedIds.length, skipped };
  }

  async softDelete(id: string) {
    assertPermission(this.ctx, 'items:delete');
    const current = await this.get(id);
    const wh = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);
    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);

    // Same rationale as archive() — emit a movement row so the dashboard's
    // on-hand-count math reflects the qty going to zero. 'deleted' isn't a
    // valid movement_type (see migration 0040); use 'adjust' with the
    // lifecycle reason. Best-effort.
    const onHand = Number((current as { quantity_on_hand?: number }).quantity_on_hand ?? 0);
    if (onHand > 0) {
      const { error: mvErr } = await this.ctx.supabase.from('stock_movements').insert({
        organization_id: this.ctx.organizationId,
        item_id: id,
        movement_type: 'adjust',
        quantity_change: -onHand,
        previous_quantity: onHand,
        new_quantity: 0,
        user_id: this.ctx.userId,
        reason: 'item_deleted',
      });
      if (mvErr) {
        console.warn('[softDelete] stock_movements writeback failed:', mvErr.message);
      }
    }

    void audit(
      {
        event: 'inventory.item.deleted',
        entityType: 'inventory_item',
        entityId: id,
        warehouseId: wh,
      },
      this.ctx,
    );
  }

  async adjustStock(input: AdjustStockInput) {
    assertPermission(this.ctx, 'stock:adjust');
    // Verify the item is in a warehouse the user can write to before
    // delegating to the RPC. The RPC also enforces this server-side.
    // Pass ctx so the helper doesn't fall back to requireOrgContext()
    // (NEXT_REDIRECT trap when called from /api/* routes).
    const item = await this.get(input.itemId);
    if ((item as { status?: string }).status === 'archived') {
      throw new ServiceError(
        'validation_error',
        'Cannot adjust stock on an archived item. Unarchive it first.',
      );
    }
    const wh = (item as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);
    const { data, error } = await this.ctx.supabase.rpc('adjust_stock', {
      p_item_id: input.itemId,
      p_quantity_change: input.quantityChange,
      p_movement_type: input.movementType,
      p_location_id: input.locationId ?? null,
      p_reason: input.reason ?? null,
      p_notes: input.notes ?? null,
    });
    if (error) {
      if (error.message.includes('insufficient_stock')) {
        throw new ServiceError('validation_error', 'Insufficient stock for this adjustment');
      }
      if (error.message.includes('forbidden')) {
        throw new ServiceError('forbidden', 'Permission denied');
      }
      throw new ServiceError('internal_error', error.message);
    }
    return data;
  }

  async transferStock(input: TransferStockInput) {
    assertPermission(this.ctx, 'stock:transfer');
    const { data, error } = await this.ctx.supabase.rpc('transfer_stock', {
      p_item_id: input.itemId,
      p_from_location_id: input.fromLocationId,
      p_to_location_id: input.toLocationId,
      p_quantity: input.quantity,
      p_notes: input.notes ?? null,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }
}
