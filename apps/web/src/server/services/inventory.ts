import 'server-only';

import { generateSku } from '@/lib/utils';
import {
  assertWarehouseAccess,
  forcedWarehouseId,
  getWarehouseAccess,
  ForbiddenError,
} from '@/lib/auth/warehouse';
import { createAdminClient } from '@/lib/supabase/admin';

import type {
  AdjustStockInput,
  CreateItemInput,
  DuplicateItemInput,
  MovementType,
  TransferStockInput,
  UpdateItemInput,
} from '@stockpilot/core';
import { RESERVED_CUSTOM_FIELD_KEYS, validateCustomFields } from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, assertPlanLimit, ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';
import { audit, type AuditEvent } from './audit';
import { dispatchEvent } from './integration-events';
import { CustomFieldsService } from './custom-fields';
import { LocationsService } from './locations';
import { TagsService } from './tags';
import { UserCategoriesService } from './user-categories';

/**
 * Whole days between an ISO timestamp and `nowMs` (floor). Null if no timestamp.
 * Pure helper — exported so tests can import it directly.
 */
export function deriveAgeDays(receivedAtIso: string | null, nowMs: number): number | null {
  if (!receivedAtIso) return null;
  const then = new Date(receivedAtIso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((nowMs - then) / 86_400_000));
}

/**
 * Maps an adjustStock movement_type to the closest existing AuditEvent so
 * the resulting audit row groups sensibly on the global audit page. Only
 * ever returns members of the AuditEvent union (audit.ts) — no new event
 * strings are introduced here (would require a migration-free but still
 * out-of-scope union change). Exported so tests can assert the mapping
 * directly without exercising the whole adjustStock RPC path.
 */
export function mapMovementTypeToAuditEvent(movementType: MovementType): AuditEvent {
  switch (movementType) {
    case 'receive_po':
      return 'stock.received';
    case 'remove':
    case 'damage':
      return 'stock.removed';
    default:
      return 'stock.adjusted';
  }
}

// Charter ids arrive from a user-controlled URL param (?charter=) via
// parseIdList, which does NOT validate them, and get interpolated into a raw
// `.or(charter_id.in.("…"))` PostgREST filter string — so a crafted value could
// inject filter syntax (within-org only: RLS + the org-eq bound it, no
// cross-tenant escape). Drop anything that isn't a clean UUID before it reaches
// the filter string. Security audit 2026-06-09.
const CHARTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Model B — "one product = one SKU": these are the SHARED product columns.
// Editing any of them on ONE placement (inventory_items row) of a SKU must
// fan out the same value to every OTHER non-deleted row sharing that item's
// (organization_id, sku) — see InventoryService.update(). Everything else
// (charter_id, warehouse_id, primary_location_id, bin_location,
// quantity_on_hand, status, rack custom_fields) is PER-PLACEMENT and must
// never be propagated. Names match the snake_case columns already used as
// keys in update()'s `updates` object, so building the propagated subset is
// a plain key pick — no camelCase→column mapping needed here.
const SHARED_ITEM_FIELDS = [
  'name',
  'sku',
  'unit_cost',
  'retail_price',
  'description',
  'category_id',
  'barcode',
  'reorder_point',
  'reorder_quantity',
  'item_type',
] as const;

export type ItemListSort =
  | 'updated_desc'
  | 'updated_asc'
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'qty_desc'
  | 'qty_asc'
  | 'cost_asc'
  | 'cost_desc'
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
  /**
   * Charter multi-select. Pass the special string 'generic' (NOT a UUID)
   * to match items with charter_id IS NULL (generic stock that any
   * charter the warehouse services can use). Mix freely with UUIDs.
   */
  charterIds?: string[];
  /** Optional filter for managers/admins. Ignored for warehouse-scoped users (forced). */
  warehouseId?: string | null;
  /** Restrict to these item ids — used by 'export selected'. */
  ids?: string[];
  /**
   * Filter by item_type. Common values:
   *   - 'product' (default for the inventory tab)
   *   - 'book' (books tab)
   *   - 'all' (no filter — used by reports / dashboard rollups)
   */
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  /**
   * Restrict to a SET of item types (`.in('item_type', …)`). Takes precedence
   * over `itemType` when non-empty.
   *
   * Exists because a picker can legitimately span several types on ONE
   * paginated list: the order add-items dialog's "Inventory" tab has to cover
   * product + asset + consumable, because the order-creation catalog applies no
   * item_type filter at all and a consumable ordered at creation must stay
   * top-uppable afterwards. Splitting the types client-side instead would make
   * `total` (and therefore the Load-more affordance) describe a different set
   * than the one being rendered.
   */
  itemTypes?: Array<'product' | 'book' | 'asset' | 'consumable'>;
  /**
   * Drop bundle (kit) SKUs. Mirrors the order-creation catalog's
   * `.or('is_bundle.is.null,is_bundle.eq.false')` — a bundle is a container,
   * not pickable stock, so it must never reach an order. Opt-in so every other
   * caller keeps its current result set.
   */
  excludeBundles?: boolean;
  lowStock?: boolean;
  outOfStock?: boolean;
  /**
   * When true, only return rows with `unit_cost > 0`. Used by the AI
   * "cheapest item" path to skip rows with no cost recorded (NULL or
   * 0) — those almost always represent items where the user hasn't
   * filled in the cost yet, so surfacing them as the "cheapest"
   * answer is misleading. Defaults false so existing callers see no
   * change.
   */
  hasUnitCost?: boolean;
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
  /**
   * Include rental items in the result. Default false — every regular
   * inventory surface (/dashboard/inventory, /dashboard/books, the
   * order picker, AI search, reports) should leave this off so
   * circulating assets (canopies, supplies) don't show up alongside
   * sellable items. /dashboard/rentals/items passes true.
   */
  includeRentals?: boolean;
  /**
   * When true, restricts to rows the system auto-archived on zero stock
   * (`inventory_items.auto_archived = true`, migration 0266) — backs the
   * Archived view's "Auto-archived only" filter chip. Meaningless
   * combined with an active-only status filter (auto_archived is always
   * cleared on restore), so callers only ever pass this alongside
   * status='archived'.
   */
  autoArchived?: boolean;
  /**
   * Expected-items visibility (migration 0277). `inventory_items.
   * awaiting_first_receipt` marks items auto-created from an inbound PO
   * that have never received any stock — "phantoms" that must not look
   * like real out-of-stock inventory.
   *
   *   - undefined / false (EVERY existing caller): the list EXCLUDES
   *     flagged rows — the default-hidden behavior for the Items/Books
   *     lists, order pickers, exports, /api/items/search.
   *   - true: the list returns ONLY flagged rows — backs the Items/Books
   *     pages' "Expected" chip view (`?expected=1`).
   *   - 'any': NO predicate — both populations. For surfaces that must
   *     be able to reference a not-yet-received item: the PO create/edit/
   *     recurring item pickers (re-ordering an expected SKU must reuse
   *     the row, not invite a duplicate), vendor-mapping targets, the
   *     ids-narrowed "export selected" path, and AI item search (which
   *     annotates flagged rows). Ordering surfaces (orders catalog,
   *     storefront) STAY on the default exclusion.
   *
   * The column is NOT NULL DEFAULT false and is cleared by a DB trigger
   * the moment any stock arrives, so `.eq()` on it is total. Established
   * zero-stock items are never flagged and stay visible by default.
   */
  expected?: boolean | 'any';
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
  cost_desc: { col: 'unit_cost', asc: false },
  cost_asc: { col: 'unit_cost', asc: true },
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

/**
 * Split total on-hand into placed vs staged. staged = qty in Staging locations.
 *
 * Phase 1 caveat: this is accurate AT REST and after receiving (which writes the
 * Staging item_stock_levels row) and after a receipt reversal (mig 0193 keeps it
 * symmetric). It is NOT yet maintained by other on-hand mutators — picking,
 * shipping, cycle count, returns, cancel-restore, bundles, manual adjust all
 * change quantity_on_hand without touching item_stock_levels. So an item that
 * holds Staging stock and is then decremented by one of those paths will show a
 * stale (inflated) `staged`. Phase 2 ("Place from Staging") makes every mutator
 * location-aware; until then treat staged as an at-rest figure. See the spec's
 * "Phase 1 shipped state + Phase 2 follow-ups" section.
 */
export function derivePlacement(
  quantityOnHand: number,
  stagedQuantity: number,
  unplacedQuantity = 0,
): { staged_quantity: number; unplaced_quantity: number; placed_quantity: number } {
  const staged = stagedQuantity || 0;
  const unplaced = unplacedQuantity || 0;
  // PLACED = on-hand that lives in a real rack/crate. Staging AND Unplaced are
  // both "not yet put away" buckets, so neither counts as placed — otherwise an
  // item whose stock sits entirely in Unplaced shows as "in stock / placed" in
  // the table while the Transfer tool (which only moves placed stock) refuses it.
  return {
    staged_quantity: staged,
    unplaced_quantity: unplaced,
    placed_quantity: Math.max(0, quantityOnHand - staged - unplaced),
  };
}

/**
 * The bits of a put-away destination needed to stamp an item's placement
 * LABEL (bin_location + rack_* custom_fields). Built by the callers from the
 * chosen/created location — an existing rack/crate or an inline-created one.
 */
export type PlaceDest = {
  kind: string | null;
  rackNumber: string | null;
  rackRow: string | null;
  name: string | null;
};

export class InventoryService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new InventoryService(await withContext());
  }

  /**
   * Validate the item's custom_fields against the org's ACTIVE custom field
   * definitions (the per-org registry from migration 0159). Authoritative
   * server-side gate — the item form runs the same pure validator for instant
   * feedback, but a crafted payload can't store a value that violates a
   * definition. Only DEFINED keys are checked; reserved/hardcoded keys
   * (rack number/row, size, author, etc.) and any stray keys are left untouched, so this
   * never breaks existing data. A no-definitions org is a cheap no-op (one
   * RLS-scoped read returning zero rows).
   */
  private async assertCustomFieldsValid(
    customFields: Record<string, unknown> | null | undefined,
  ): Promise<void> {
    if (!customFields || Object.keys(customFields).length === 0) return;
    const defs = await new CustomFieldsService(this.ctx).listDefinitions('item');
    if (defs.length === 0) return;
    const result = validateCustomFields(defs, customFields);
    if (!result.ok) throw new ServiceError('validation_error', result.error);
  }

  async list(filters: ItemListFilters = {}) {
    // Default page is 50; the hard cap is 1000 (PostgREST's max_rows) so explicit
    // high-limit callers — chiefly the inventory export, which asks for the whole
    // filtered set — aren't silently truncated to 200. (>1000-item orgs still cap
    // at 1000 here and the export discloses "first N of M"; full pagination is a
    // follow-up.)
    const limit = Math.min(filters.limit ?? 50, 1000);
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
        'id, sku, barcode, model_number, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, is_rental, auto_archived, awaiting_first_receipt, custom_fields, created_at, updated_at, created_by, updated_by',
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
        return { items: [], total: 0, valueOnHand: 0 };
      }
      query = query.in('warehouse_id', access.readableIds);
    } else if (filters.warehouseId) {
      query = query.eq('warehouse_id', filters.warehouseId);
    }

    // Category visibility for restricted viewers (migration 0128).
    // RLS already enforces this at the row level, but applying the
    // filter here means a future RLS misconfig can't silently leak.
    //
    // Short-circuit: only viewers can be category-restricted (all other
    // roles return `null` / unrestricted from the helper anyway). Skip
    // the organization_members + user_category_assignments round-trips
    // entirely when ctx.role isn't 'viewer' — that's ~99% of list calls.
    // Wrapped in try/catch so test stubs without these tables still
    // fall through to "no filter" — production always has them.
    if (this.ctx.role === 'viewer') {
      try {
        const accessibleCats = await new UserCategoriesService(this.ctx)
          .getAccessibleCategoryIds(this.ctx.userId);
        if (accessibleCats !== null) {
          if (accessibleCats.size === 0) {
            return { items: [], total: 0, valueOnHand: 0 };
          }
          query = query.in('category_id', [...accessibleCats]);
        }
      } catch {
        // Defense in depth: if the lookup itself crashes, fall through.
        // The DB RLS policy still enforces the same visibility, so this
        // service-layer filter is belt-and-suspenders only.
      }
    }

    if (!filters.status || filters.status === 'active') {
      query = query.eq('status', 'active');
    } else if (filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }
    if (filters.autoArchived) {
      query = query.eq('auto_archived', true);
    }
    // Expected-items visibility (mig 0277): default = hide phantoms
    // awaiting their first receipt; expected=true = ONLY them (the
    // "Expected" chip view); expected='any' = no predicate (PO pickers /
    // ids-narrowed exports / AI search — see the ItemListFilters doc).
    // Column is NOT NULL so eq() is total.
    if (filters.expected !== 'any') {
      query = query.eq('awaiting_first_receipt', filters.expected === true);
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
          `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%,model_number.ilike.%${term}%`,
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
    // Charter filter — UUID list filters charter_id IN (...) and the
    // sentinel 'generic' translates to charter_id IS NULL (items that
    // any charter can pull from). When BOTH are present we OR them so
    // a user can pick "Generic + Acme" together.
    if (filters.charterIds && filters.charterIds.length > 0) {
      const includesGeneric = filters.charterIds.includes('generic');
      const realIds = filters.charterIds.filter((id) => id !== 'generic' && CHARTER_ID_RE.test(id));
      if (includesGeneric && realIds.length > 0) {
        const list = realIds.map((id) => `"${id}"`).join(',');
        query = query.or(`charter_id.is.null,charter_id.in.(${list})`);
      } else if (includesGeneric) {
        query = query.is('charter_id', null);
      } else if (realIds.length > 0) {
        query = query.in('charter_id', realIds);
      }
    }
    // Additional narrowing for 'export selected'. This sits ON TOP of the
    // warehouse-access scoping above, so a user still can't export items
    // outside their RLS/warehouse access — ids only ever subtracts.
    if (filters.ids && filters.ids.length > 0) {
      query = query.in('id', filters.ids);
    }
    if (filters.outOfStock) query = query.lte('quantity_on_hand', 0);
    if (filters.hasUnitCost) {
      // Exclude rows where unit_cost is NULL or 0. Used by AI cost-
      // ranking so "cheapest" doesn't surface the (typically large)
      // pool of items whose cost just hasn't been recorded yet.
      query = query.gt('unit_cost', 0);
    }
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
    // doesn't accidentally show books/assets. Pass 'all' to disable, or
    // itemTypes for a multi-type set (which wins when present).
    if (filters.itemTypes && filters.itemTypes.length > 0) {
      query = query.in('item_type', filters.itemTypes);
    } else if (filters.itemType === undefined) {
      query = query.eq('item_type', 'product');
    } else if (filters.itemType !== 'all') {
      query = query.eq('item_type', filters.itemType);
    }

    // Bundles are containers, not pickable stock. Only callers that say so
    // (the order add-items picker, matching loadCatalogItems) drop them.
    if (filters.excludeBundles) {
      query = query.or('is_bundle.is.null,is_bundle.eq.false');
    }

    // Rentals (circulating assets like canopies) are a separate
    // inventory class. Every regular surface (this list method is
    // used by /dashboard/inventory, /dashboard/books, the orders
    // picker, AI search, etc.) leaves includeRentals undefined,
    // which means is_rental=false — rental items never leak in.
    // Only /dashboard/rentals/items explicitly opts in by passing
    // includeRentals: true.
    if (!filters.includeRentals) {
      query = query.eq('is_rental', false);
    }

    if (filters.createdSince) query = query.gte('created_at', filters.createdSince);
    if (filters.createdUntil) query = query.lt('created_at', filters.createdUntil);
    if (filters.updatedSince) query = query.gte('updated_at', filters.updatedSince);
    if (filters.updatedUntil) query = query.lt('updated_at', filters.updatedUntil);

    // Build a parallel skinny query that mirrors every filter applied
    // above but selects only the three columns needed for the org-wide
    // value sum. We need the FULL filtered rowset to sum across all
    // pages, not just the visible 50. The previous implementation summed
    // only the current page's rows in the browser, which made the
    // "$N on hand" footer wrong any time the total exceeded one page
    // (215 SKUs / page=50 → undercounted by 4 pages of items).
    //
    // PostgREST clamps any single response to `[api] max_rows = 1000`, so
    // even though we select only three numeric columns we must PAGINATE in
    // 1000-row `.range()` windows with a stable `.order('id')` and
    // accumulate — otherwise the footer silently undercounts for orgs with
    // >1000 in-scope items, while `total` (count:'exact' on the main query)
    // stays accurate, making the mismatch visible. (Same 1000-row cap class
    // fixed in forecasting.ts / order-requests.ts.) The filters below mirror
    // the main list query exactly; only the column projection and the
    // pagination differ. Build per page so each `.range()` is applied to a
    // fresh query (reusing one builder would stack range headers).
    const buildSumPage = (from: number, to: number) => {
      let sumQuery = this.ctx.supabase
        .from('inventory_items')
        .select('quantity_on_hand, unit_cost, reorder_point')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null);
      if (!access.hasAllAccess) {
        if (access.readableIds.length === 0) {
          // Same early-return logic as the main query path above. We
          // already returned earlier in this case; keep this guard for
          // safety if the access guard moves.
        } else {
          sumQuery = sumQuery.in('warehouse_id', access.readableIds);
        }
      } else if (filters.warehouseId) {
        sumQuery = sumQuery.eq('warehouse_id', filters.warehouseId);
      }
      if (!filters.status || filters.status === 'active') {
        sumQuery = sumQuery.eq('status', 'active');
      } else if (filters.status !== 'all') {
        sumQuery = sumQuery.eq('status', filters.status);
      }
      if (filters.autoArchived) {
        sumQuery = sumQuery.eq('auto_archived', true);
      }
      // Mirror the main query's expected-items predicate (mig 0277),
      // including the tri-state 'any' escape hatch (no predicate).
      if (filters.expected !== 'any') {
        sumQuery = sumQuery.eq('awaiting_first_receipt', filters.expected === true);
      }
      if (filters.q && filters.q.trim()) {
        const term = filters.q.trim().slice(0, 120).replace(/[,()%*]/g, ' ');
        if (term) {
          sumQuery = sumQuery.or(
            `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%,model_number.ilike.%${term}%`,
          );
        }
      }
      if (filters.barcode && filters.barcode.trim()) {
        sumQuery = sumQuery.eq('barcode', filters.barcode.trim());
      }
      if (filters.categoryIds && filters.categoryIds.length > 0) {
        sumQuery = sumQuery.in('category_id', filters.categoryIds);
      } else if (filters.categoryId) {
        sumQuery = sumQuery.eq('category_id', filters.categoryId);
      }
      if (filters.locationIds && filters.locationIds.length > 0) {
        sumQuery = sumQuery.in('primary_location_id', filters.locationIds);
      } else if (filters.locationId) {
        sumQuery = sumQuery.eq('primary_location_id', filters.locationId);
      }
      if (filters.supplierIds && filters.supplierIds.length > 0) {
        sumQuery = sumQuery.in('supplier_id', filters.supplierIds);
      } else if (filters.supplierId) {
        sumQuery = sumQuery.eq('supplier_id', filters.supplierId);
      }
      if (filters.charterIds && filters.charterIds.length > 0) {
        const includesGeneric = filters.charterIds.includes('generic');
        const realIds = filters.charterIds.filter((id) => id !== 'generic' && CHARTER_ID_RE.test(id));
        if (includesGeneric && realIds.length > 0) {
          const list = realIds.map((id) => `"${id}"`).join(',');
          sumQuery = sumQuery.or(`charter_id.is.null,charter_id.in.(${list})`);
        } else if (includesGeneric) {
          sumQuery = sumQuery.is('charter_id', null);
        } else if (realIds.length > 0) {
          sumQuery = sumQuery.in('charter_id', realIds);
        }
      }
      if (filters.outOfStock) sumQuery = sumQuery.lte('quantity_on_hand', 0);
      if (filters.lowStock) {
        sumQuery = sumQuery.or('reorder_point.gt.0,quantity_on_hand.lte.0');
      }
      if (filters.itemTypes && filters.itemTypes.length > 0) {
        sumQuery = sumQuery.in('item_type', filters.itemTypes);
      } else if (filters.itemType === undefined) {
        sumQuery = sumQuery.eq('item_type', 'product');
      } else if (filters.itemType !== 'all') {
        sumQuery = sumQuery.eq('item_type', filters.itemType);
      }
      if (filters.excludeBundles) {
        sumQuery = sumQuery.or('is_bundle.is.null,is_bundle.eq.false');
      }
      if (!filters.includeRentals) {
        sumQuery = sumQuery.eq('is_rental', false);
      }
      if (filters.createdSince) sumQuery = sumQuery.gte('created_at', filters.createdSince);
      if (filters.createdUntil) sumQuery = sumQuery.lt('created_at', filters.createdUntil);
      if (filters.updatedSince) sumQuery = sumQuery.gte('updated_at', filters.updatedSince);
      if (filters.updatedUntil) sumQuery = sumQuery.lt('updated_at', filters.updatedUntil);
      // Stable sort keeps each row on exactly one page across the loop.
      return sumQuery.order('id', { ascending: true }).range(from, to);
    };

    const [mainRes, sumRowsRaw] = await Promise.all([
      query,
      fetchAllRows<{ quantity_on_hand: number; unit_cost: number; reorder_point: number }>(
        (from, to) => buildSumPage(from, to),
      ),
    ]);
    const { data, error, count } = mainRes;
    if (error) throw new ServiceError('internal_error', error.message);

    let rows = data ?? [];
    let totalCount = count ?? 0;
    let sumRows = sumRowsRaw;
    if (filters.lowStock) {
      const filtered = rows.filter(
        (r: { quantity_on_hand: number; reorder_point: number }) =>
          // Below or at reorder line, OR critically out of stock even
          // when no reorder line was set. Matches the dashboard alert
          // count (lowStockCount + outOfStockCount).
          r.quantity_on_hand <= r.reorder_point || r.quantity_on_hand <= 0,
      );
      rows = filtered;
      // Apply the same JS-side filter to the sum rowset so the value
      // footer matches what the user actually sees in the table.
      sumRows = sumRows.filter(
        (r) => r.quantity_on_hand <= r.reorder_point || r.quantity_on_hand <= 0,
      );
      // totalCount must reflect the full org-wide filtered set (sumRows), not
      // the current page (`filtered` is ≤ page size) — otherwise "Page X of Y"
      // is wrong whenever the low-stock set spans more than one page.
      totalCount = sumRows.length;
    }

    const valueOnHand = sumRows.reduce(
      (acc, r) => acc + (Number(r.quantity_on_hand) || 0) * (Number(r.unit_cost) || 0),
      0,
    );

    // Per-item placement, derived from the ACTUAL holdings (item_stock_levels),
    // NOT the free-text bin_location label (which can go stale — an item placed
    // into rack 1-A/2-C still shows a leftover "1-C" label otherwise). We sum
    // the staging + unplaced buckets AND collect the real rack/crate location
    // names the stock sits in, so the table's RACK column shows where the stock
    // truly is.
    const ids = (rows ?? []).map((r) => (r as { id: string }).id);
    const stagedByItem = new Map<string, number>();
    const unplacedByItem = new Map<string, number>();
    const placedRacksByItem = new Map<string, string[]>();
    // Distinct rack/crate HOLDINGS per item, keyed by location_id (never
    // name) — the same grouping placeItemsOntoRackByName's
    // rackHoldingsByItem uses to decide whether a bulk Set-rack may
    // physically move an item's stock. placed_racks dedupes by NAME, so a
    // rack called "1-A" in two different warehouses collapses to one
    // entry there but must still count as 2 holdings here — the client's
    // split warning reads THIS field, not placed_racks.length.
    const rackHoldingsByItem = new Map<string, Set<string>>();
    if (ids.length > 0) {
      const { data: levels } = await this.ctx.supabase
        .from('item_stock_levels')
        .select('item_id, location_id, quantity, locations!inner(name, kind)')
        .eq('organization_id', this.ctx.organizationId)
        .in('item_id', ids)
        .gt('quantity', 0);
      // `locations` is a to-one embed → a single object at runtime; the
      // generated PostgREST types model it as an array, so cast via unknown
      // (same convention as placements() below).
      for (const lvl of (levels ?? []) as unknown as Array<{
        item_id: string;
        location_id: string;
        quantity: number;
        locations: { name: string; kind: string };
      }>) {
        const kind = lvl.locations?.kind;
        if (kind === 'staging') {
          stagedByItem.set(lvl.item_id, (stagedByItem.get(lvl.item_id) ?? 0) + Number(lvl.quantity));
        } else if (kind === 'unplaced') {
          unplacedByItem.set(lvl.item_id, (unplacedByItem.get(lvl.item_id) ?? 0) + Number(lvl.quantity));
        } else if (kind === 'rack' || kind === 'crate') {
          // A real placement — record the location name (dedup, an item could
          // have two levels in the same rack via different code paths).
          const arr = placedRacksByItem.get(lvl.item_id) ?? [];
          if (lvl.locations.name && !arr.includes(lvl.locations.name)) arr.push(lvl.locations.name);
          placedRacksByItem.set(lvl.item_id, arr);

          const set = rackHoldingsByItem.get(lvl.item_id) ?? new Set<string>();
          set.add(lvl.location_id);
          rackHoldingsByItem.set(lvl.item_id, set);
        }
      }
    }
    const rowsWithPlacement = (rows ?? []).map((r) => {
      const id = (r as { id: string }).id;
      return {
        ...(r as object),
        ...derivePlacement(
          Number((r as { quantity_on_hand: number }).quantity_on_hand),
          stagedByItem.get(id) ?? 0,
          unplacedByItem.get(id) ?? 0,
        ),
        // Sorted for stable display ("1-A, 2-C" not "2-C, 1-A").
        placed_racks: (placedRacksByItem.get(id) ?? []).sort((a, b) => a.localeCompare(b)),
        rackHoldingsCount: rackHoldingsByItem.get(id)?.size ?? 0,
      };
    });

    return {
      items: rowsWithPlacement as Array<{
        id: string;
        sku: string;
        barcode: string | null;
        model_number: string | null;
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
        /** True only when the SYSTEM auto-archived this item on zero
         *  stock (migration 0266) — backs the Archived view's
         *  "Auto-archived" badge + filter chip. */
        auto_archived: boolean;
        /** True while an item auto-created from an inbound PO has never
         *  received any stock (migration 0277) — hidden from default
         *  lists/ordering; shown under the "Expected" chip with a pill. */
        awaiting_first_receipt: boolean;
        custom_fields: Record<string, unknown>;
        created_at: string;
        updated_at: string;
        staged_quantity: number;
        unplaced_quantity: number;
        placed_quantity: number;
        /** Actual rack/crate location names this item's stock sits in (from
         *  holdings), sorted. Drives the table's RACK column so it reflects
         *  real placement, not the stale bin_location label. */
        placed_racks: string[];
        /** Distinct rack/crate holdings by location_id (NOT name) — see the
         *  rackHoldingsByItem comment above. Drives the bulk Set-rack split
         *  warning; must agree with the server's move/no-move gate. */
        rackHoldingsCount: number;
      }>,
      total: totalCount,
      /** Sum of (unit_cost × quantity_on_hand) over the FULL filtered
       *  rowset (across all pages), not just the current page. Backs
       *  the "$N on hand" footer on the inventory + books list pages
       *  so the figure stays consistent with `total` (which is also
       *  org-wide) instead of changing when the user paginates. */
      valueOnHand,
    };
  }

  /**
   * HEAD count of items awaiting their first receipt (migration 0277)
   * for one view — the badge on the Items/Books pages' "Expected" chip.
   * Mirrors the Expected view's own predicate (org, not deleted,
   * non-rental, item_type, optional warehouse, plus whatever q/category/
   * location/charter/rack filters are active on the page — the chip's
   * VIEW applies them, so the badge must too or the N lies about the
   * rows) and the same warehouse-access scoping list() applies for
   * staff/viewer, so the count always equals the rows the chip's view
   * would list. NO lifecycle filter: the Expected view spans lifecycles
   * (mobile's listStatusPredicate returns lifecycle:null) so a flagged
   * item someone manually archived is still reachable — and counted.
   * Cheap: rides the 0277 partial index (`where awaiting_first_receipt`)
   * over a tiny, transient row slice.
   */
  async countExpected(
    opts: {
      itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
      warehouseId?: string | null;
      q?: string;
      categoryIds?: string[];
      locationIds?: string[];
      charterIds?: string[];
      rack?: string;
    } = {},
  ): Promise<number> {
    const access = await getWarehouseAccess(this.ctx);
    let query = this.ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('is_rental', false)
      .eq('awaiting_first_receipt', true);
    if (!access.hasAllAccess) {
      if (access.readableIds.length === 0) return 0;
      query = query.in('warehouse_id', access.readableIds);
    } else if (opts.warehouseId) {
      query = query.eq('warehouse_id', opts.warehouseId);
    }
    // Same item_type defaulting as list(): undefined → 'product'.
    if (opts.itemType === undefined) {
      query = query.eq('item_type', 'product');
    } else if (opts.itemType !== 'all') {
      query = query.eq('item_type', opts.itemType);
    }
    // The clauses below mirror list()'s q / rack / category / location /
    // charter filters verbatim (same sanitization, same fail-open
    // edges) — third copy alongside list()'s main + sum builders, the
    // established mirroring pattern in this file.
    if (opts.q && opts.q.trim()) {
      const term = opts.q.trim().slice(0, 120).replace(/[,()%*]/g, ' ');
      if (term) {
        query = query.or(
          `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%,model_number.ilike.%${term}%`,
        );
      }
    }
    if (opts.rack && opts.rack.trim()) {
      const sanitize = (s: string | undefined): string =>
        (s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      const [rawNum, rawRow] = opts.rack.trim().split('-', 2);
      const num = sanitize(rawNum);
      const row = sanitize(rawRow);
      if (num) {
        if (opts.itemType === 'book') {
          query = query.filter('custom_fields->>book_rack_number', 'eq', num);
          if (row) query = query.filter('custom_fields->>book_rack_row', 'eq', row);
        } else if (opts.itemType === 'all') {
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
    if (opts.categoryIds && opts.categoryIds.length > 0) {
      query = query.in('category_id', opts.categoryIds);
    }
    if (opts.locationIds && opts.locationIds.length > 0) {
      query = query.in('primary_location_id', opts.locationIds);
    }
    if (opts.charterIds && opts.charterIds.length > 0) {
      const includesGeneric = opts.charterIds.includes('generic');
      const realIds = opts.charterIds.filter((id) => id !== 'generic' && CHARTER_ID_RE.test(id));
      if (includesGeneric && realIds.length > 0) {
        const list = realIds.map((id) => `"${id}"`).join(',');
        query = query.or(`charter_id.is.null,charter_id.in.(${list})`);
      } else if (includesGeneric) {
        query = query.is('charter_id', null);
      } else if (realIds.length > 0) {
        query = query.in('charter_id', realIds);
      }
    }
    const { count, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  /**
   * Loads only the (id, sku, name, barcode, tracking_type) tuple for a list
   * of item ids. Lets callers like the PO detail page and the label printer
   * render rows without over-fetching the entire inventory just for name/sku
   * lookups. Unlike list(), this does NOT exclude rental items — a direct-id
   * caller (labels, PO lines) legitimately references them. Order is not
   * guaranteed; callers should index by id.
   */
  async byIds(
    ids: string[],
    opts: { includeDeleted?: boolean } = {},
  ): Promise<
    Array<{
      id: string;
      sku: string;
      name: string;
      barcode: string | null;
      tracking_type: 'none' | 'lot' | 'serial';
    }>
  > {
    if (ids.length === 0) return [];
    let query = this.ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, barcode, tracking_type')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', ids);
    // Live surfaces (lists, pickers) exclude soft-deleted items. Historical
    // read-only display (past POs/receipts) opts in to includeDeleted so an
    // item deleted AFTER the document was created still shows its real name
    // instead of "Unknown item" — keeps the auto-delete feature's promise that
    // history is preserved.
    if (!opts.includeDeleted) query = query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      sku: r.sku as string,
      name: r.name as string,
      barcode: (r.barcode as string | null) ?? null,
      tracking_type: ((r.tracking_type as string | null) ?? 'none') as
        | 'none'
        | 'lot'
        | 'serial',
    }));
  }

  /**
   * Lean, UNCAPPED listing for match pickers (PO-import line matching).
   *
   * list() serves paged tables — its limit tops out at 1000 (PostgREST
   * max_rows) and the imports page's `list({ limit: 500 })` call silently
   * truncated the match dropdown for >500-item orgs (recurring pattern #3:
   * disclose or paginate every silent cap). This variant selects only the
   * columns the matcher needs and paginates to exhaustion via fetchAllRows.
   *
   * Read posture mirrors the list() defaults the imports page relied on:
   * org-scoped, non-deleted, active, non-rental, warehouse-scoped for
   * non-all-access roles, viewer category restriction — but ALL item types
   * (a PO can restock books and products alike).
   */
  async listForMatching(): Promise<
    Array<{
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      created_at: string;
    }>
  > {
    const access = await getWarehouseAccess(this.ctx);
    // Same fail-closed early return as list(): a warehouse-scoped user with
    // no assignments sees nothing.
    if (!access.hasAllAccess && access.readableIds.length === 0) return [];

    // Category visibility for restricted viewers — belt-and-suspenders on
    // top of RLS, mirroring list() (including its fall-through on error).
    let accessibleCats: Set<string> | null = null;
    if (this.ctx.role === 'viewer') {
      try {
        accessibleCats = await new UserCategoriesService(this.ctx)
          .getAccessibleCategoryIds(this.ctx.userId);
        if (accessibleCats !== null && accessibleCats.size === 0) return [];
      } catch {
        // Defense in depth: the DB RLS policy still enforces visibility.
      }
    }

    // Build per page so each `.range()` applies to a fresh query; stable
    // `.order('id')` keeps every row on exactly one page across the loop
    // (fetchAllRows' documented contract).
    return fetchAllRows<{
      id: string;
      sku: string;
      name: string;
      quantity_on_hand: number;
      created_at: string;
    }>((from, to) => {
      let query = this.ctx.supabase
        .from('inventory_items')
        .select('id, sku, name, quantity_on_hand, created_at')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        .eq('is_rental', false);
      if (!access.hasAllAccess) {
        query = query.in('warehouse_id', access.readableIds);
      }
      if (accessibleCats !== null) {
        query = query.in('category_id', [...accessibleCats]);
      }
      return query.order('id', { ascending: true }).range(from, to);
    });
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

  /**
   * Returns the warehouse + primary location of the most recent item
   * this user created — used to pre-fill the "new item" / "new book"
   * form so a user who's always adding to the same warehouse + bin
   * doesn't have to re-pick those fields every time.
   *
   * Filters:
   *   • created_by = current user — the defaults follow each person's
   *     habits, not the org's.
   *   • itemType — optional. The books form passes 'book' so the
   *     defaults don't bleed across the products / books tabs.
   *
   * Returns null when the user has never created an item (yet) so the
   * caller can fall back to the active-warehouse cookie or leave the
   * fields blank.
   */
  async getRecentDefaults(
    itemType?: 'product' | 'book' | 'asset' | 'consumable',
  ): Promise<{ warehouseId: string | null; primaryLocationId: string | null } | null> {
    let q = this.ctx.supabase
      .from('inventory_items')
      .select('warehouse_id, primary_location_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('created_by', this.ctx.userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (itemType) q = q.eq('item_type', itemType);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return {
      warehouseId: (data.warehouse_id as string | null) ?? null,
      primaryLocationId: (data.primary_location_id as string | null) ?? null,
    };
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
    const { data: holdingRows } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('quantity, locations!inner(kind)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', id)
      .in('locations.kind', ['staging', 'unplaced']);
    let staged = 0;
    let unplaced = 0;
    // `locations` is a to-one embed → object at runtime; cast via unknown
    // (the generated PostgREST types model it as an array).
    for (const r of (holdingRows ?? []) as unknown as Array<{
      quantity: number;
      locations: { kind: string };
    }>) {
      if (r.locations?.kind === 'unplaced') unplaced += Number(r.quantity);
      else staged += Number(r.quantity);
    }
    const placement = derivePlacement(
      Number((data as { quantity_on_hand: number }).quantity_on_hand),
      staged,
      unplaced,
    );
    return Object.assign(data, placement);
  }

  /**
   * Returns every non-empty stock level for `itemId`, annotated with the
   * location's name, kind, and warehouse so callers can build per-location
   * transfer source lists.
   *
   * Fail-closed: returns [] on any Supabase error rather than throwing, so a
   * transient read failure degrades the transfer dialog (empty source list)
   * rather than breaking the whole item-detail page.
   *
   * Org-scoped: `.eq('organization_id', …)` is mandatory — belt-and-suspenders
   * on top of RLS so a service-role context can't accidentally leak rows.
   */
  async placements(itemId: string): Promise<Array<{
    locationId: string;
    name: string;
    kind: string | null;
    warehouseId: string | null;
    quantity: number;
  }>> {
    const { data, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('location_id, quantity, locations!inner(id, name, kind, warehouse_id)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .gt('quantity', 0);

    if (error || !data) return [];

    return data.map((row) => {
      const loc = row.locations as unknown as {
        id: string; name: string; kind: string | null; warehouse_id: string | null;
      };
      return {
        locationId: row.location_id,
        name: loc.name,
        kind: loc.kind,
        warehouseId: loc.warehouse_id,
        quantity: Number(row.quantity),
      };
    });
  }

  /**
   * Per-(item, location) placement breakdown for many items at once — backs the
   * inventory list's "one line per rack" expansion. For each item id, returns
   * every non-empty holding with a display label (the rack/crate name, or the
   * system-bucket words "Staging" / "Unplaced") and its kind, sorted so real
   * racks/crates come first (alphabetical), then Staging, then Unplaced.
   *
   * Org-scoped + RLS; returns an empty map for an empty id list (no round-trip).
   * Fail-closed: an empty map on any read error (the list degrades to no
   * placement lines rather than throwing the whole page).
   */
  async placementBreakdown(itemIds: string[]): Promise<
    Map<string, Array<{ locationId: string; label: string; kind: string; quantity: number }>>
  > {
    const out = new Map<
      string,
      Array<{ locationId: string; label: string; kind: string; quantity: number }>
    >();
    if (itemIds.length === 0) return out;

    const { data, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(name, kind)')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .gt('quantity', 0);
    if (error || !data) return out;

    for (const row of data as unknown as Array<{
      item_id: string;
      location_id: string;
      quantity: number;
      locations: { name: string; kind: string | null };
    }>) {
      const kind = row.locations?.kind ?? 'unplaced';
      const label =
        kind === 'staging' ? 'Staging' : kind === 'unplaced' ? 'Unplaced' : row.locations.name;
      const arr = out.get(row.item_id) ?? [];
      arr.push({ locationId: row.location_id, label, kind, quantity: Number(row.quantity) });
      out.set(row.item_id, arr);
    }

    // racks/crates first (A→Z), then Staging, then Unplaced.
    const rank = (k: string) => (k === 'staging' ? 1 : k === 'unplaced' ? 2 : 0);
    for (const arr of out.values()) {
      arr.sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label));
    }
    return out;
  }

  /**
   * Sum of ACTIVE (not-yet-released) stock_reservations per item, keyed by
   * item id. Mirrors the exact reservation math the /rentals/new catalog
   * uses (no reference_type filter — total active reservations across every
   * source so available-to-promise = quantity_on_hand − reserved). Items
   * with no active reservations are omitted from the map, so callers should
   * default a missing key to 0.
   *
   * RLS already scopes stock_reservations to the org; the explicit
   * organization_id filter is belt-and-suspenders. Returns an empty map for
   * an empty id list (no round-trip).
   */
  async reservedQuantityByItemIds(itemIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (itemIds.length === 0) return out;
    const { data, error } = await this.ctx.supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .is('released_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
    for (const r of (data ?? []) as Array<{ item_id: string; quantity: number }>) {
      out.set(r.item_id, (out.get(r.item_id) ?? 0) + r.quantity);
    }
    return out;
  }

  /**
   * `opts.awaitingFirstReceipt` (migration 0277): PO-driven creation
   * paths — createItemsFromPoLines (PO-import approve) and the custom
   * `newItemName` lines on PurchaseOrdersService.create/update — pass
   * true so the new item is born hidden ("Expected") until its first
   * stock arrives (a DB trigger clears the flag the moment
   * quantity_on_hand rises above 0). It is deliberately a SEPARATE
   * options bag, NOT a CreateItemInput field: the item form / API
   * schemas parse user payloads into CreateItemInput, and manual item
   * creation (even at qty 0) and CSV import must never be able to set
   * the flag.
   */
  async create(input: CreateItemInput, opts: { awaitingFirstReceipt?: boolean } = {}) {
    assertPermission(this.ctx, 'items:create');

    // Phase 5: lot/serial tracking + shelf-life/expiry are gated behind the
    // lot_serial module. Fail closed — a disabled org cannot make an item
    // lot/serial-tracked or set expiry config.
    if (
      input.trackingType !== 'none' ||
      input.shelfLifeDays != null ||
      (input.expiryPolicy !== undefined && input.expiryPolicy !== 'warn')
    ) {
      assertModuleEnabled(this.ctx, 'lot_serial');
    }
    // Only WRITE the lot_serial columns (migration 0162) when the module is
    // enabled. With it off (prod default before 0162 is applied), the columns
    // may not exist, so normal item CRUD must never reference them. Enabling
    // the module is an operational opt-in that applies 0162 first.
    const lotSerialEnabled = this.ctx.enabledModules.has('lot_serial');

    await assertPlanLimit(this.ctx, 'items');

    // Reject any custom_fields value that violates the org's field definitions
    // before we touch the DB (mirrors the form's client-side check).
    await this.assertCustomFieldsValid(input.customFields);

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
        model_number: input.modelNumber ?? null,
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
        ...(lotSerialEnabled
          ? {
              shelf_life_days: input.shelfLifeDays ?? null,
              expiry_policy: input.expiryPolicy ?? 'warn',
            }
          : {}),
        item_type: input.itemType,
        custom_fields: input.customFields,
        status: input.status,
        is_rental: input.isRental ?? false,
        // Only PO-driven creation paths pass this (see the method doc);
        // omit otherwise so the column's DB default (false) applies.
        // Guarded on qty <= 0: the clearing trigger fires on UPDATE only,
        // so an insert born WITH stock must never carry the flag.
        ...(opts.awaitingFirstReceipt && !(input.quantityOnHand > 0)
          ? { awaiting_first_receipt: true }
          : {}),
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
       
      await embedInventoryItem(data.id as string, this.ctx as any);
    })();

    return data;
  }

  /**
   * Clone an existing item to a new physical location. Passes the
   * original SKU straight through — the (org, sku, bin_location)
   * partial unique index from migration 0126 lets the same SKU live
   * at multiple racks, so we don't need to mangle it with a suffix.
   * Same SKU at the SAME bin_location still 23505s (rendered to the
   * user as a friendly "already exists at this rack" error).
   */
  async duplicateItem(input: DuplicateItemInput): Promise<string> {
    assertPermission(this.ctx, 'items:create');

    // Load the original SKU so we can pass it through to the RPC.
    const { data: original, error: origErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('sku')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', input.originalId)
      .maybeSingle();
    if (origErr || !original) {
      throw new ServiceError('not_found', 'Original item no longer exists.');
    }
    const sku = (original as { sku: string }).sku;

    // Compose bin_location label + RPC overrides per branch.
    const overrides: Record<string, unknown> = {
      sku,
      quantity: input.quantity,
    };
    if (input.itemType === 'book') {
      const rackLabel = input.rackRow
        ? `${input.rackNumber}-${input.rackRow}`
        : input.rackNumber;
      overrides.book_rack_number = input.rackNumber;
      overrides.book_rack_row = input.rackRow ?? null;
      overrides.book_crate_color = input.crateColor;
      overrides.book_crate_number = input.crateNumber;
      overrides.bin_location = `${rackLabel} · ${input.crateColor}${input.crateNumber}`;
    } else {
      const rackLabel = input.rackRow
        ? `${input.rackNumber}-${input.rackRow}`
        : input.rackNumber;
      overrides.rack_number = input.rackNumber;
      overrides.rack_row = input.rackRow ?? null;
      overrides.bin_location = rackLabel;
    }

    const { data: newId, error: rpcErr } = await this.ctx.supabase.rpc(
      'duplicate_inventory_item',
      { p_original_id: input.originalId, p_overrides: overrides },
    );
    if (rpcErr) {
      if (rpcErr.code === 'P0002') {
        throw new ServiceError('not_found', 'Original item no longer exists.');
      }
      if (rpcErr.code === '23505') {
        throw new ServiceError(
          'conflict',
          'This SKU already exists at the chosen rack. Pick a different rack or row.',
        );
      }
      throw new ServiceError('internal_error', rpcErr.message);
    }

    void audit(
      {
        event: 'inventory.item.duplicated',
        entityType: 'inventory_item',
        entityId: newId as string,
        extra: { source_item_id: input.originalId, sku },
      },
      this.ctx,
    );

    return newId as string;
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
    /**
     * Per-org custom field values applied to EVERY created variant. Reserved
     * keys (size, rack_number, rack_row, ...) are stripped — the variant
     * builder owns those.
     */
    customFields?: Record<string, unknown> | null;
    variants: Array<{
      size: 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL' | 'XXXXXL';
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

    // Per-org custom fields shared by every variant. Strip any reserved key the
    // variant builder owns (size/rack_*) so a stray payload can't clobber them,
    // then run the authoritative server-side gate so REQUIRED custom fields are
    // enforced on this write path too (parity with create/update). Validation
    // runs once against the merged-with-size shape so a required `size`-like
    // definition would also be checked — but `size` is reserved and never
    // definable, so in practice only the org's own keys are validated.
    const sharedCustomFields: Record<string, unknown> = {};
    if (input.customFields) {
      for (const [k, v] of Object.entries(input.customFields)) {
        if (RESERVED_CUSTOM_FIELD_KEYS.has(k)) continue;
        sharedCustomFields[k] = v;
      }
    }
    await this.assertCustomFieldsValid(sharedCustomFields);

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
      // Org custom fields first; the reserved variant keys (size/rack_*) are
      // applied last so they always win even if a stray key slipped through.
      const cf: Record<string, unknown> = { ...sharedCustomFields, size };
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

    // Phase 5: gate lot/serial + expiry edits behind the lot_serial module.
    if (
      (patch.trackingType !== undefined && patch.trackingType !== 'none') ||
      patch.shelfLifeDays != null ||
      (patch.expiryPolicy !== undefined && patch.expiryPolicy !== 'warn')
    ) {
      assertModuleEnabled(this.ctx, 'lot_serial');
    }
    // Only WRITE the lot_serial columns (0162) when the module is enabled — see
    // create(). With it off (prod before 0162), the columns may not exist, so a
    // normal item edit (the form submits expiryPolicy:'warn' by default) must
    // not reference them.
    const lotSerialEnabled = this.ctx.enabledModules.has('lot_serial');

    // Load current row to enforce warehouse-write access and to lock down
    // moves. Warehouse-scoped users cannot move an item to another warehouse;
    // managers/admins can only move it if they have write access to both.
    const current = await this.get(id);
    const currentWarehouseId = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (currentWarehouseId) await assertWarehouseAccess(currentWarehouseId, 'write', this.ctx);

    // Model B: capture the ORIGINAL sku BEFORE the patch is applied. This is
    // the key used to find this item's other placements — capturing it now
    // (not after `updates.sku` is set below) means an edit that changes the
    // sku re-keys the WHOLE group together, rather than orphaning siblings
    // under the old sku.
    const originalSku = (current as { sku?: string | null }).sku ?? null;

    const updates: Record<string, unknown> = { updated_by: this.ctx.userId };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.sku !== undefined) updates.sku = patch.sku;
    if (patch.barcode !== undefined) updates.barcode = patch.barcode ?? null;
    if (patch.modelNumber !== undefined) updates.model_number = patch.modelNumber ?? null;
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
    if (lotSerialEnabled) {
      if (patch.shelfLifeDays !== undefined) updates.shelf_life_days = patch.shelfLifeDays;
      if (patch.expiryPolicy !== undefined) updates.expiry_policy = patch.expiryPolicy;
    }
    if (patch.itemType !== undefined) updates.item_type = patch.itemType;
    if (patch.isRental !== undefined) updates.is_rental = patch.isRental;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.customFields !== undefined) {
      // Authoritative server-side validation against the org's field defs.
      await this.assertCustomFieldsValid(patch.customFields);
      updates.custom_fields = patch.customFields;
    }

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

    // Model B: the subset of this edit that is a SHARED product field (vs.
    // per-placement). Picked from `updates` (already snake_case columns) so
    // there's no separate camelCase→column mapping to keep in sync.
    const sharedUpdates: Record<string, unknown> = {};
    for (const key of SHARED_ITEM_FIELDS) {
      if (key in updates) sharedUpdates[key] = updates[key];
    }

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      // Duplicate SKU at the same PLACEMENT trips the partial unique index
      // inventory_items_org_sku_charter_bin_unique (organization_id, sku,
      // charter_id, bin_location) WHERE deleted_at IS NULL (migration 0234).
      // The same SKU is ALLOWED across different charters/racks (Model B: one
      // row per placement) — a collision only means this exact charter + rack
      // already carries that SKU. Surface it as a clear, actionable message
      // instead of the opaque "internal error" the raw rethrow produced.
      if (error.code === '23505') {
        throw new ServiceError(
          'conflict',
          'Another item in the same charter and rack already uses that SKU. The same SKU can live under different charters — change the SKU, the charter, or the rack/location.',
        );
      }
      throw new ServiceError('internal_error', error.message);
    }

    // Model B: fan out shared product fields to every OTHER placement of
    // this SKU. Keyed on the ORIGINAL sku (captured above, before the patch)
    // so that a sku edit re-keys the whole group together. Per-placement
    // fields (charter/warehouse/location/bin/on-hand/status, rack
    // custom_fields) are never in sharedUpdates, so a charter/qty-only edit
    // never reaches this block. Blank/whitespace skus are never grouped
    // (matches groupPlacementsBySku's "blank sku = its own placement").
    // On-hand is per-row and is NEVER touched here — no adjust_stock call.
    let propagatedToSku: string | null = null;
    if (originalSku && originalSku.trim().length > 0 && Object.keys(sharedUpdates).length > 0) {
      // KNOWN LIMITATION: the target row was already updated (and committed)
      // in the prior statement above, in a SEPARATE statement from this
      // sibling fan-out — there is no shared transaction wrapping the two.
      // If this edit is a `sku` re-key and the NEW sku collides with an
      // existing row at one sibling's (org, sku, charter_id, bin_location)
      // (migration 0234), this UPDATE fails with 23505 below and the group is
      // left SPLIT: the target row
      // now sits on the new sku while its siblings are still on the old one.
      // This is surfaced to the caller as the `conflict` error (not silent,
      // not cross-tenant — organization_id stays scoped throughout — and
      // on-hand quantities / stock ledger are untouched), but it is a real
      // data-shape limitation until this fan-out is done. A fully-atomic
      // group re-key would require moving target+siblings into one
      // transactional RPC (tracked follow-up, not yet built).
      //
      // Deliberately the SERVICE-ROLE admin client, not this.ctx.supabase:
      // the RLS-scoped client is subject to inventory_items_update →
      // user_can_access_inventory(warehouse_id, charter_id, 'write') (mig
      // 0008), so a warehouse-scoped staff user editing a shared field would
      // have this UPDATE silently RLS-filter out sibling placements sitting
      // in warehouses/charters they can't write to. PostgREST reports a
      // zero-row-matched UPDATE as success (no error), so that would leave
      // the "shared" field SILENTLY DIVERGED across placements — exactly the
      // invariant this fan-out exists to guarantee. Product-level fields are
      // org-wide by design, so propagation must be all-or-nothing regardless
      // of the editor's warehouse scope. The target row above stays on
      // this.ctx.supabase (RLS-guarded) — only this sibling fan-out is
      // privileged, and the explicit organization_id filter below is the
      // mandatory tenant-isolation floor now that RLS is bypassed.
      const { error: sibErr } = await createAdminClient()
        .from('inventory_items')
        .update({ ...sharedUpdates, updated_by: this.ctx.userId })
        .eq('organization_id', this.ctx.organizationId)
        .eq('sku', originalSku)
        .is('deleted_at', null)
        .neq('id', id);
      if (sibErr) {
        if (sibErr.code === '23505') {
          throw new ServiceError(
            'conflict',
            'Another placement (same charter and rack) already uses that SKU. Change the SKU, or resolve the conflicting placement first.',
          );
        }
        throw new ServiceError('internal_error', sibErr.message);
      }
      // If sku itself changed, the group's new identity is the new sku;
      // otherwise it's unchanged (still originalSku).
      propagatedToSku = (sharedUpdates.sku as string | undefined) ?? originalSku;
    }

    // before/after for the P1 diff drawer — restricted to the CHANGED keys
    // on the TARGET row only (current = pre-patch, data = post-patch).
    // Deliberately does NOT reach into the Model-B sibling fan-out above —
    // that's a separate set of rows this audit event isn't about.
    const beforeRow = current as Record<string, unknown>;
    const afterRow = data as Record<string, unknown>;
    // Record only keys whose VALUE actually changed. The edit form submits
    // the full patch, so submitted keys alone made every save read as
    // "Fields changed: <all 19 fields>" (owner report 2026-07-15). Both
    // sides are DB rows (same type representation); jsonb columns compare
    // via stringify (Postgres normalizes jsonb key order, so it's stable).
    // `updated_by` stays excluded as cosmetic.
    const jsonEq = (a: unknown, b: unknown) =>
      a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changedKeys = Object.keys(updates)
      .filter((k) => k !== 'updated_by')
      .filter((k) => !jsonEq(beforeRow[k], afterRow[k]));
    void audit(
      {
        event: 'inventory.item.updated',
        entityType: 'inventory_item',
        entityId: id,
        warehouseId: (data as { warehouse_id?: string | null }).warehouse_id ?? null,
        before: Object.fromEntries(changedKeys.map((k) => [k, beforeRow[k]])),
        after: Object.fromEntries(changedKeys.map((k) => [k, afterRow[k]])),
        extra: {
          changed_keys: changedKeys,
          ...(propagatedToSku ? { propagated_to_sku: propagatedToSku } : {}),
        },
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

    // Movement/Activity P3 Task 1: archiving an item deliberately PRESERVES
    // quantity_on_hand (no stock physically moves), so no stock_movements
    // row is written here. A previous version emitted a fictional
    // `adjust`/`reason:'item_archived'` row driving on-hand to 0 — nothing
    // ever reversed it on restore, which double-counted historical qty in
    // the dashboard-history reconstruction (currentQty − SUM(future Δ))
    // once the item re-entered scope. See migration 0271 for the one-time
    // cleanup of rows written by the old code.

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

      // Batch-read the OLD rack label before the RPC overwrites it, so the
      // per-item audit rows below can carry a real before→after diff
      // instead of just the new value.
      const { data: oldRackRows } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, bin_location')
        .in('id', allowedIds);
      const oldBinById = new Map(
        ((oldRackRows ?? []) as Array<{ id: string; bin_location: string | null }>).map((r) => [
          r.id,
          r.bin_location ?? null,
        ]),
      );

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
            before: { bin_location: oldBinById.get(id) ?? null },
            after: { bin_location: composedBin },
            extra: {
              bulk_op: 'set_rack',
              rack_number: num,
              rack_row: row,
              changed_keys: ['bin_location'],
            },
          },
          this.ctx,
        );
      }
      // Beyond writing the rack LABEL above, ACTUALLY PLACE the selected items'
      // not-yet-placed (staging/unplaced) stock onto that rack — so bulk
      // "Set rack" moves stock out of staging in ONE action (the label alone
      // never moved anything, which is the reported bug). Only when a rack is
      // given (clearing the rack just clears the label). Best-effort: a
      // placement hiccup must not undo the label set, so failures are logged.
      if (composedBin) {
        await this.placeItemsOntoRackByName(allowedIds, num, row, composedBin).catch((e) => {
          console.error('[bulkUpdate set_rack] bulk placement failed', e);
        });
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
        // A human-initiated bulk archive is never a SYSTEM archive —
        // clear the flag so it can't be mistaken for one the zero-stock
        // cron made (guards against staleness if this row was
        // auto-archived, manually restored, and is now being
        // re-archived by hand). Mirrors the DB's own restore trigger
        // (_auto_restock_restore, migration 0266), which clears the
        // same flag on restock.
        update.auto_archived = false;
        break;
      case 'unarchive':
        update.status = 'active';
        // Same rationale as 'archive' above: a manual restore is never
        // a system one, so the flag must not survive it — otherwise a
        // later PO receipt (which only revives auto_archived=true rows,
        // see receiving.ts's maybeAutoUnarchive) could act on a row a
        // human already decided about.
        update.auto_archived = false;
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

    // Drop the cosmetic `updated_by` from the changed-keys list, same as
    // the single-item update() path — this is both the column set to
    // batch-read the OLD values for, and what lands in `extra.changed_keys`.
    const changedKeys = Object.keys(update).filter((k) => k !== 'updated_by');

    // Batch-read old values BEFORE the update so the per-item audit rows
    // below can carry a real before→after diff. One query covers every
    // affected item — no N+1.
    const { data: oldRows } = await this.ctx.supabase
      .from('inventory_items')
      .select(['id', ...changedKeys].join(', '))
      .in('id', allowedIds);
    const oldById = new Map<string, Record<string, unknown>>(
      ((oldRows ?? []) as unknown as Array<Record<string, unknown>>).map((r) => [String(r.id), r]),
    );

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
        : input.op.kind === 'unarchive'
          ? ('inventory.item.restored' as const)
          : ('inventory.item.updated' as const);
    for (const id of allowedIds) {
      const oldRow = oldById.get(id) ?? {};
      void audit(
        {
          event: bulkEvent,
          entityType: 'inventory_item',
          entityId: id,
          before: Object.fromEntries(changedKeys.map((k) => [k, oldRow[k] ?? null])),
          after: Object.fromEntries(changedKeys.map((k) => [k, update[k]])),
          extra: { bulk_op: input.op.kind, changed_keys: changedKeys },
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

    // Movement/Activity P3 Task 1: same rationale as archive() — soft-delete
    // deliberately PRESERVES quantity_on_hand, so no stock_movements row is
    // written here. See the comment in archive() and migration 0271.

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

  /**
   * Where should a location-less POSITIVE stock adjustment land? Staging is
   * reserved for PO receipts awaiting put-away, so a manual add must never go
   * there. Prefer the item's dominant PLACED holding (rack/crate) so the added
   * units stay on the shelf; otherwise the warehouse's Unplaced location.
   * Returns null only when neither exists (a warehouse with no Unplaced loc),
   * in which case adjust_stock's default routing is the last resort.
   */
  private async resolveAdjustLocation(
    itemId: string,
    warehouseId: string | null,
  ): Promise<string | null> {
    const { data: levels } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('location_id, quantity')
      .eq('item_id', itemId)
      .gt('quantity', 0);
    const rows = (levels ?? []) as Array<{ location_id: string; quantity: number }>;
    if (rows.length > 0) {
      const { data: locs } = await this.ctx.supabase
        .from('locations')
        .select('id, kind')
        .in('id', rows.map((r) => r.location_id));
      const kindById = new Map(
        ((locs ?? []) as Array<{ id: string; kind: string | null }>).map((l) => [l.id, l.kind]),
      );
      const placed = rows
        .filter((r) => {
          const k = kindById.get(r.location_id);
          return k === 'rack' || k === 'crate';
        })
        .sort((a, b) => Number(b.quantity) - Number(a.quantity))[0];
      if (placed) return placed.location_id;
    }
    if (warehouseId) {
      const { data: unplaced } = await this.ctx.supabase
        .from('locations')
        .select('id')
        .eq('warehouse_id', warehouseId)
        .eq('kind', 'unplaced')
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      const id = (unplaced as { id?: string } | null)?.id;
      if (id) return id;
    }
    return null;
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

    // A manual ADD with no explicit location must NOT land in Staging: the
    // adjust_stock RPC routes a null positive delta there (Staging is only for
    // PO receipts awaiting put-away). Default it to the item's current rack so
    // an adjustment stays on the shelf; fall back to the warehouse Unplaced
    // location. Negative deltas keep the null path (adjust_stock draws down from
    // placed stock, which correctly removes from the rack).
    let locationId = input.locationId ?? null;
    if (locationId == null && input.quantityChange > 0) {
      locationId = await this.resolveAdjustLocation(input.itemId, wh);
    }

    const { data, error } = await this.ctx.supabase.rpc('adjust_stock', {
      p_item_id: input.itemId,
      p_quantity_change: input.quantityChange,
      p_movement_type: input.movementType,
      p_location_id: locationId,
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
    // adjust_stock is atomic and RETURNS the authoritative updated row (see
    // 0004_phase2_helpers.sql — `returns public.inventory_items`). Derive the
    // new qty from that returned row, not the pre-RPC read, so concurrent
    // adjustments don't make the crossing detection / audit before-value
    // miss/double-fire. `prev` is reconstructed as new - delta (the RPC
    // computed new = prev + delta).
    const it = item as {
      quantity_on_hand?: number;
      reorder_point?: number;
      name?: string;
      sku?: string;
    };
    const ret = (data ?? {}) as { quantity_on_hand?: number; reorder_point?: number };
    const next = Number(ret.quantity_on_hand ?? it.quantity_on_hand ?? 0);
    const prev = next - Number(input.quantityChange);

    // Capture-gap fix (Movement/Activity P2 Task 1c): adjustStock used to
    // emit NO audit row at all, so the P1 before/after diff drawer had
    // nothing to render for manual stock adjustments. This event is
    // SUPPRESSED from the item Activity feed (Task 2, activity.ts forItem)
    // because the stock_movements row already represents it there — it
    // still surfaces on the global audit pages with full before/after.
    void audit(
      {
        event: mapMovementTypeToAuditEvent(input.movementType),
        entityType: 'inventory_item',
        entityId: input.itemId,
        warehouseId: wh,
        before: { quantity_on_hand: prev },
        after: { quantity_on_hand: next },
        reason: input.reason ?? undefined,
        extra: {
          quantity_change: input.quantityChange,
          movement_type: input.movementType,
          location_id: locationId,
        },
      },
      this.ctx,
    );

    // Low-stock alert — fire to webhooks/Slack/Teams only when this adjustment
    // crosses the item BELOW its reorder point (prev > rp, new <= rp), so it
    // alerts once on the crossing rather than on every subsequent pick.
    try {
      const rp = Number(ret.reorder_point ?? it.reorder_point ?? 0);
      if (rp > 0 && next <= rp && prev > rp) {
        void dispatchEvent(this.ctx.organizationId, 'stock.low', {
          id: input.itemId,
          name: it.name ?? null,
          sku: it.sku ?? null,
          quantity: next,
          reorderPoint: rp,
        });
      }
    } catch {
      /* best-effort: an alert must never fail a stock adjustment */
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

    // Capture-gap fix (Task 1d): same rationale as adjustStock above — this
    // event is suppressed from the item feed (Task 2) since the movement
    // row already shows it there, but drives the global audit page's
    // before/after diff. No extra query for location NAMES here — ids are
    // acceptable per the plan; the service layer shouldn't pay for a lookup
    // the caller may not need.
    void audit(
      {
        event: 'stock.transferred',
        entityType: 'inventory_item',
        entityId: input.itemId,
        before: { location_id: input.fromLocationId },
        after: { location_id: input.toLocationId },
        extra: {
          quantity: input.quantity,
          from_location_id: input.fromLocationId,
          to_location_id: input.toLocationId,
        },
      },
      this.ctx,
    );

    return data;
  }

  /**
   * After a put-away physically moves stock onto a rack/crate (transfer_stock),
   * stamp the item's placement LABEL so it matches the "Set rack" path. Set rack
   * writes bin_location + rack_* custom_fields via inventory_set_rack; the
   * Staging put-away only moved the holding and used to leave bin_location
   * stale/NULL (owner-reported gap 2026-07-14: a Chromebook put away to rack
   * 1-A kept bin_location NULL). Reuse the SAME RPC so both paths write the
   * identical label — composing "num-row" exactly like the bulkUpdate set_rack
   * branch above (crate or number-less rack → the location's display name).
   *
   * Best-effort: the stock is already placed, so a label-stamp failure must NOT
   * fail the caller — it degrades to the pre-existing no-label state, which the
   * holdings-derived RACK column already covers. inventory_set_rack (mig
   * 0064/0068) only updates inventory_items, never item_stock_levels, so this
   * re-stamps the label without re-moving stock. Multi-rack items get the LAST
   * placement as their single label — the same single-label semantics Set rack
   * already has (the accurate per-rack view is the holdings RACK column).
   */
  async stampPlacementBin(itemIds: string[], dest: PlaceDest): Promise<void> {
    if (itemIds.length === 0) return;
    const isRack = dest.kind === 'rack';
    const num = isRack ? dest.rackNumber?.trim() || null : null;
    const row = isRack ? dest.rackRow?.trim().toUpperCase() || null : null;
    const bin =
      isRack && num ? (row ? `${num}-${row}` : num) : dest.name?.trim() || null;
    const { error } = await this.ctx.supabase.rpc('inventory_set_rack', {
      p_item_ids: itemIds,
      p_rack_number: num,
      p_rack_row: row,
      p_bin_location: bin,
      p_scope: 'auto',
    });
    if (error) {
      console.warn('[placement] bin_location stamp failed (stock still placed):', error.message);
    }
  }

  /**
   * Bulk "Set rack" placement: moves each item's stock onto the rack named
   * `name` in that item's own warehouse. Used so bulk Set rack physically
   * places stock instead of only writing a label. Per-holding best-effort —
   * one failed transfer (e.g. a permission floor) is logged and skipped so
   * the rest still place.
   *
   * Two cases, both driven off ONE holdings query:
   *  - staging/unplaced — the item's NOT-YET-PLACED stock. Always moved
   *    (this was the original fix — Set rack used to only write the label).
   *  - rack/crate (Unit B) — stock ALREADY placed on a rack/crate. Moved
   *    ONLY when the item has exactly one such holding (its whole in-stock
   *    quantity sits on a single rack, so retargeting it is unambiguous).
   *    An item with >1 rack/crate holding (a split placement) is left
   *    completely alone here — the bulk op carries no fromLocationId, so
   *    guessing which placement (or how much) to move would be wrong. The
   *    label write in the caller still applies; the client warns the user
   *    to use Transfer for those. NEVER move a split item's stock.
   */
  private async placeItemsOntoRackByName(
    itemIds: string[],
    num: string | null,
    row: string | null,
    name: string,
  ): Promise<void> {
    if (itemIds.length === 0 || !num) return;

    const { data: items } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    const rows = (items ?? []) as Array<{ id: string; warehouse_id: string | null }>;
    const whByItem = new Map(rows.map((i) => [i.id, i.warehouse_id]));

    // ONE query covers both cases above — the `locations` embed carries the
    // `kind` (to bucket staging/unplaced vs rack/crate) and `warehouse_id`
    // (so a rack/crate holding resolves its destination against the
    // warehouse it's PHYSICALLY in, not necessarily the item's declared
    // warehouse_id).
    const { data: holdings } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(kind, warehouse_id)')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .in('locations.kind', ['staging', 'unplaced', 'rack', 'crate'])
      .gt('quantity', 0);
    const allHoldings = (holdings ?? []) as unknown as Array<{
      item_id: string;
      location_id: string;
      quantity: number;
      locations: { kind: string; warehouse_id: string | null } | null;
    }>;

    const levels = allHoldings.filter(
      (h) => h.locations?.kind === 'staging' || h.locations?.kind === 'unplaced',
    );

    // Group rack/crate holdings by item so a split placement (>1 distinct
    // holding with qty>0) can be told apart from a single one.
    const rackHoldingsByItem = new Map<string, typeof allHoldings>();
    for (const h of allHoldings) {
      if (h.locations?.kind !== 'rack' && h.locations?.kind !== 'crate') continue;
      const arr = rackHoldingsByItem.get(h.item_id) ?? [];
      arr.push(h);
      rackHoldingsByItem.set(h.item_id, arr);
    }
    const singleRackMoves: Array<{
      item_id: string;
      location_id: string;
      quantity: number;
      warehouseId: string | null;
    }> = [];
    for (const [itemId, hs] of rackHoldingsByItem) {
      if (hs.length !== 1) continue; // split placement — NEVER move, label-only
      const h = hs[0]!;
      singleRackMoves.push({
        item_id: itemId,
        location_id: h.location_id,
        quantity: Number(h.quantity),
        warehouseId: h.locations?.warehouse_id ?? whByItem.get(itemId) ?? null,
      });
    }

    if (levels.length === 0 && singleRackMoves.length === 0) return;

    // Resolve (find or create) the destination rack ONCE per warehouse —
    // shared by both the staging/unplaced auto-place and the single-rack
    // move below.
    const warehouseIds = new Set<string>();
    for (const wh of rows.map((r) => r.warehouse_id)) if (wh) warehouseIds.add(wh);
    for (const mv of singleRackMoves) if (mv.warehouseId) warehouseIds.add(mv.warehouseId);
    const rackByWh = new Map<string, string>();
    for (const wh of warehouseIds) {
      const rackId = await this.findOrCreateRackLocation(wh, num, row, name);
      if (rackId) rackByWh.set(wh, rackId);
    }

    // Run the per-holding transfers CONCURRENTLY (in capped chunks) instead of
    // one-at-a-time — a 13-item bulk Set rack was ~13 sequential RPC round-trips
    // ("took forever"). Different items touch different stock-level rows, so
    // there's no lock contention; the cap keeps the connection pool sane for the
    // 500-item ceiling.
    const CONCURRENCY = 20;
    for (let i = 0; i < levels.length; i += CONCURRENCY) {
      await Promise.all(
        levels.slice(i, i + CONCURRENCY).map(async (h) => {
          const wh = whByItem.get(h.item_id) ?? null;
          const toLoc = wh ? rackByWh.get(wh) : undefined;
          if (!toLoc || toLoc === h.location_id) return;
          try {
            await this.transferStock({
              itemId: h.item_id,
              fromLocationId: h.location_id,
              toLocationId: toLoc,
              quantity: Number(h.quantity),
              notes: `Placed on rack ${name} (bulk Set rack)`,
            });
          } catch (e) {
            console.error('[set_rack place] transfer failed', {
              item: h.item_id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }),
      );
    }

    // Single-placement rack/crate holdings (Unit B): the item's whole
    // in-stock quantity already sits on exactly one rack/crate, so retarget
    // it — PHYSICALLY MOVE via transfer_stock (never a raw stock-level
    // write), same as the staging/unplaced path above. Idempotent: already
    // on the resolved target → no-op.
    for (let i = 0; i < singleRackMoves.length; i += CONCURRENCY) {
      await Promise.all(
        singleRackMoves.slice(i, i + CONCURRENCY).map(async (mv) => {
          const toLoc = mv.warehouseId ? rackByWh.get(mv.warehouseId) : undefined;
          if (!toLoc || toLoc === mv.location_id) return;
          try {
            await this.transferStock({
              itemId: mv.item_id,
              fromLocationId: mv.location_id,
              toLocationId: toLoc,
              quantity: mv.quantity,
              notes: `Moved to rack ${name} (bulk Set rack)`,
            });
          } catch (e) {
            console.error('[set_rack move] transfer failed', {
              item: mv.item_id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }),
      );
    }
  }

  /** Find an existing rack/crate location named `name` in the warehouse, or
   *  create a rack (rack_number/row set) if absent. Returns its id, or null on
   *  a create failure (e.g. missing locations:manage) so placement degrades.
   *  Delegates to LocationsService.findOrCreateRackOrCrate — the SAME
   *  case-insensitive dedup used by the interactive Transfer/Put-away
   *  "new rack" actions, so both creation paths agree with each other and
   *  with the unique index added by migration 0270. */
  private async findOrCreateRackLocation(
    warehouseId: string,
    num: string,
    row: string | null,
    name: string,
  ): Promise<string | null> {
    try {
      const loc = await new LocationsService(this.ctx).findOrCreateRackOrCrate({
        name,
        type: 'shelf',
        kind: 'rack',
        warehouseId,
        rackNumber: num,
        rackRow: row,
      });
      return (loc as { id: string }).id;
    } catch (e) {
      console.error('[set_rack place] rack create failed', {
        warehouseId,
        name,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Returns not-yet-placed stock grouped by item, with source PO/receipt + age.
   * Backs the Staging worklist screen.
   *
   * Covers BOTH "not yet put away" buckets:
   *  - kind='staging'  — received from a PO into the staging buffer (carries a
   *    source PO/receipt + age).
   *  - kind='unplaced' — on hand but never placed into a rack (e.g. imported or
   *    manually adjusted stock). No PO source — source/age columns show "—".
   * Both are placeable into a rack/crate via the same placeStockAction path, so
   * surfacing unplaced here is the only way that stock can be put away (and then
   * rack-to-rack transferred — the Transfer tool only moves placed stock).
   *
   * Schema notes:
   * - stock_movements written by post_receipt_v2 (mig 0190) via adjust_stock store
   *   the receipts.id as the `notes` column (6th arg = p_notes), NOT reference_id
   *   (adjust_stock does not write reference_id). So we derive the source receipt
   *   from sm.notes (which holds the UUID text) rather than sm.reference_id.
   * - receipts has purchase_order_id FK → purchase_orders; PostgREST embed
   *   purchase_orders(po_number) resolves correctly.
   *
   * Fail-closed / graceful degradation: the primary levels query returns [] on
   * error/null (no staged stock to show). The source-movement and receipt/PO
   * sub-queries degrade gracefully — on error they log and continue with an empty
   * map, so staged items still surface (just without the source/age badge) rather
   * than hiding staged stock. Never throws.
   * Belt-and-suspenders: .eq('organization_id', …) on every query on top of RLS.
   */
  async stagedWorklist(
    opts: { itemType?: 'book' | 'non-book'; warehouseId?: string | null } = {},
  ): Promise<Array<{
    itemId: string; name: string; sku: string; itemType: string; warehouseId: string | null;
    sourceLocationId: string; sourceKind: 'staging' | 'unplaced'; quantity: number;
    sourceReceiptId: string | null; sourcePoNumber: string | null; receiptNumber: string | null;
    receivedAt: string | null; ageDays: number | null;
  }>> {
    // 1. Not-yet-placed levels (qty>0) joined to item + the staging/unplaced location.
    let q = this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(id, kind, warehouse_id), inventory_items!inner(id, name, sku, item_type, deleted_at)')
      .eq('organization_id', this.ctx.organizationId)
      .in('locations.kind', ['staging', 'unplaced'])
      .gt('quantity', 0);
    if (opts.warehouseId) q = q.eq('locations.warehouse_id', opts.warehouseId);
    if (opts.itemType === 'book') q = q.eq('inventory_items.item_type', 'book');
    if (opts.itemType === 'non-book') q = q.neq('inventory_items.item_type', 'book');
    // Exclude soft-deleted items at the DB (works with the inventory_items!inner embed)
    // so they're never fetched over the wire.
    q = q.is('inventory_items.deleted_at', null);
    const { data: levels, error } = await q;
    if (error || !levels) return [];

    const rows = (levels as Array<Record<string, any>>).filter((r) => r.inventory_items);
    if (rows.length === 0) return [];
    // De-dupe: an item with BOTH a staging and an unplaced holding contributes
    // two rows but only needs one movement/receipt lookup.
    const itemIds = [...new Set(rows.map((r) => r.item_id))];

    // 2. The receive_po movement that actually put THIS stock into staging —
    //    the MOST RECENT one whose receipt is still posted.
    //
    // This used to take the item's EARLIEST receive_po movement ever, with no
    // regard for the receipt's status, and that produced flatly wrong rows
    // (owner report 2026-07-22). Science Dimensions Earth & Space Science had
    // been received on 2026-06-24 against CVW-002202 — a receipt later REVERSED,
    // on a PO later CANCELLED — and again today against CVW-002201. Its 20
    // staged units came from today's posted receipt, but the worklist showed the
    // June receipt: wrong PO, wrong receipt number, "4 weeks ago", and a false
    // "27d Stale" badge. Once an item had any receive history, every future
    // staging row inherited that first receipt forever.
    //
    // Newest-posted-first is the honest answer to "where did the stock sitting
    // here now come from": earlier receipts were either put away already or
    // reversed, and a REVERSED receipt's stock was explicitly taken back out, so
    // it can never be the source of what is in staging. Stock that genuinely has
    // sat untouched still resolves to its own old receipt and still reads stale.
    //
    // Note: post_receipt_v2 (mig 0190) passes receipts.id as `notes` (p_notes arg),
    // not as reference_id — so we read from sm.notes to get the source receipt ID.
    const { data: moves, error: movesErr } = await this.ctx.supabase
      .from('stock_movements')
      .select('item_id, created_at, notes, movement_type')
      .eq('organization_id', this.ctx.organizationId)
      .eq('movement_type', 'receive_po')
      .in('item_id', itemIds)
      .order('created_at', { ascending: false });
    // Graceful degradation: a source-lookup failure still returns the staged items
    // (just without the source/age badge) — log so the silent failure is diagnosable.
    if (movesErr) console.error('staging worklist: source-movement lookup failed', { error: movesErr.message });
    const candidates = (moves ?? []) as Array<Record<string, any>>;

    // 3. Resolve receipt -> status / PO number / receipt number. Every candidate
    //    receipt is fetched (not just one per item) because the status decides
    //    which candidate wins, and that is only knowable after this lookup.
    const candidateReceiptIds = [...new Set(
      candidates.map((m) => (m.notes as string | null)?.trim() || null).filter(Boolean),
    )] as string[];
    const receiptMeta = new Map<string, { poNumber: string | null; receiptNumber: string | null; receivedAt: string | null; status: string | null }>();
    if (candidateReceiptIds.length > 0) {
      const { data: receipts, error: receiptsErr } = await this.ctx.supabase
        .from('receipts')
        .select('id, receipt_number, received_at, status, purchase_orders(po_number)')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', candidateReceiptIds);
      // Graceful degradation: a receipt/PO-lookup failure still returns the staged
      // items (without PO/receipt numbers) — log so it's diagnosable.
      if (receiptsErr) console.error('staging worklist: receipt/PO lookup failed', { error: receiptsErr.message });
      for (const r of (receipts ?? []) as Array<Record<string, any>>) {
        receiptMeta.set(r.id, {
          poNumber: r.purchase_orders?.po_number ?? null,
          receiptNumber: r.receipt_number ?? null,
          receivedAt: r.received_at ?? null,
          status: (r.status as string | null) ?? null,
        });
      }
    }

    // 4. Walk each item's movements newest-first and keep the first one backed by
    //    a POSTED receipt. No posted receipt means the staged stock did not come
    //    from a live receipt (adjustment, or every receipt reversed) — the source
    //    and age columns then honestly render "—" instead of naming a dead one.
    const sourceByItem = new Map<string, { receivedAt: string; receiptId: string | null }>();
    for (const m of candidates) {
      if (sourceByItem.has(m.item_id)) continue;
      const receiptId = (m.notes as string | null)?.trim() || null;
      if (!receiptId) continue;
      if (receiptMeta.get(receiptId)?.status !== 'posted') continue;
      sourceByItem.set(m.item_id, { receivedAt: m.created_at, receiptId });
    }

    const nowMs = Date.now();
    return rows.map((r) => {
      const sourceKind: 'staging' | 'unplaced' =
        r.locations.kind === 'unplaced' ? 'unplaced' : 'staging';
      // PO/receipt source + age only apply to PO-staged stock. Unplaced stock has
      // no receive_po movement, so it carries no source (columns render "—").
      const src = sourceKind === 'staging' ? (sourceByItem.get(r.item_id) ?? null) : null;
      const meta = src?.receiptId ? receiptMeta.get(src.receiptId) : undefined;
      // Prefer receipts.received_at for the displayed date; fall back to sm.created_at.
      const receivedAt = meta?.receivedAt ?? src?.receivedAt ?? null;
      return {
        itemId: r.item_id,
        name: r.inventory_items.name,
        sku: r.inventory_items.sku,
        itemType: r.inventory_items.item_type,
        warehouseId: r.locations.warehouse_id ?? null,
        sourceLocationId: r.location_id,
        sourceKind,
        quantity: Number(r.quantity),
        sourceReceiptId: src?.receiptId ?? null,
        sourcePoNumber: meta?.poNumber ?? null,
        receiptNumber: meta?.receiptNumber ?? null,
        receivedAt,
        ageDays: deriveAgeDays(receivedAt, nowMs),
      };
    });
  }
}
