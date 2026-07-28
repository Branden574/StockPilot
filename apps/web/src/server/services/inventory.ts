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
  CreateProductGroupInput,
  DuplicateItemInput,
  MovementType,
  TrackingMode,
  TrackingTypeValue,
  TransferStockInput,
  UpdateItemInput,
} from '@stockpilot/core';
import type { ItemHistoryMovement, ItemHistoryPage } from '@stockpilot/core';
import type { RemoveStockFromLocationInput } from '@stockpilot/core';
import type { CountingUnit } from '@stockpilot/core';
import {
  buildVariantKey,
  formatArchiveStockBlockMessage,
  formatBulkArchiveStockBlockMessage,
  formatHoldingLabel,
  formatRackLabel,
  formatStockQuantity,
  historyNote,
  normalizeRackFields,
  normalizeSizeValue,
  parseRackLabel,
  RACK_WRITE_OFF_MOVEMENT_TYPE,
  RESERVED_CUSTOM_FIELD_KEYS,
  trackingTypeForMode,
  validateCustomFields,
} from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, assertPlanLimit, ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';
import { audit, type AuditEvent } from './audit';
import { dispatchEvent } from './integration-events';
import { CustomFieldsService } from './custom-fields';
import { ProductGroupsService } from './product-groups';
import {
  assertVariantAttributesValid,
  resolveModeOverride,
  resolveTrackingProfile,
  type ResolvedTrackingProfile,
  type TrackingProfileCache,
} from './sports-profiles';
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
 * Builds the PostgREST predicate for the Items rack filter.
 *
 * Pure + exported so both filter call sites (list() and the expected-count
 * builder) share ONE definition and tests can assert the emitted clause
 * without a live query.
 *
 * LEGACY TOLERANCE (incident 2026-07-23): a rack is *supposed* to be stored
 * decomposed — custom_fields.rack_number "22" + rack_row "B" — but a composite
 * row (the whole label "22-B" parked in the number key, row NULL) can reappear
 * from an import, a restored backup, or a writer that skips the parser. The
 * old filter required the decomposed pair and matched nothing against such a
 * row, so the rack went blind while the Rack COLUMN still printed "22-B". We
 * now match EITHER shape, so the filter degrades to "still finds the items"
 * rather than "returns No items yet".
 *
 * SANITIZE: `num`/`row`/`label` are interpolated into PostgREST's .or() string.
 * The allow-list keeps alphanumerics and the single dash a label legitimately
 * contains — never a comma, paren, dot or percent, which is what would let a
 * hostile value escape the and(...) clause and inject a sibling predicate.
 */
export function buildRackFilterClause(
  rawRack: string,
  itemType: string | undefined,
):
  | { kind: 'none' }
  | { kind: 'eq'; column: string; value: string }
  | { kind: 'or'; expr: string } {
  const sanitize = (s: string | null | undefined): string =>
    (s ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);

  const label = sanitize(rawRack.trim());
  const parts = parseRackLabel(label);
  const num = sanitize(parts.number);
  const row = sanitize(parts.row);
  if (!num) return { kind: 'none' };

  const isBook = itemType === 'book';
  const numKey = isBook ? 'custom_fields->>book_rack_number' : 'custom_fields->>rack_number';
  const rowKey = isBook ? 'custom_fields->>book_rack_row' : 'custom_fields->>rack_row';

  // One rack, either shape: (number AND row) OR the whole label in the number.
  const tolerant = (nk: string, rk: string): string =>
    row ? `or(and(${nk}.eq.${num},${rk}.eq.${row}),${nk}.eq.${label})` : `${nk}.eq.${num}`;

  if (itemType === 'all') {
    // OR-of-ANDs: (item is a book AND book keys match) OR (item is not a book
    // AND rack keys match) — so each row matches against its OWN type's keys.
    const bookClause = `and(item_type.eq.book,${tolerant('custom_fields->>book_rack_number', 'custom_fields->>book_rack_row')})`;
    const itemClause = `and(item_type.neq.book,${tolerant('custom_fields->>rack_number', 'custom_fields->>rack_row')})`;
    return { kind: 'or', expr: `${bookClause},${itemClause}` };
  }
  if (!row) return { kind: 'eq', column: numKey, value: num };
  return {
    kind: 'or',
    expr: `and(${numKey}.eq.${num},${rowKey}.eq.${row}),${numKey}.eq.${label}`,
  };
}

/** stock_movements.notes carries a receipts.id as TEXT for receipt-written rows
 *  (post_receipt_v2 / adjust_stock p_notes). Only a well-formed uuid is treated
 *  as a receipt reference — anything else is an operator's typed note. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // SPORTS VARIANT IDENTITY (0298/0303). "Size 10 Wide, number 7" answers WHICH
  // PRODUCT this is, exactly like the sku does — it is not a property of the
  // rack the row happens to sit on. Leaving these out meant a size corrected on
  // the placement a counter was standing at FORKED that sku's identity: the
  // other bins kept the old size and the old (derived) variant_key, so
  // product_group_rollups counted two variants for one physical size and the
  // import matcher, finding no key match for the corrected size, created a
  // third row for it. `variant_key` travels WITH them for the same reason it is
  // recomputed at all — a key that describes a size the row no longer has is
  // worse than no key. `player_name` is deliberately NOT here (and is not in
  // any variant key): a name is an assignment, not identity.
  'variant_size',
  'variant_size_original',
  'variant_size_system',
  'variant_width',
  'variant_fit',
  'variant_color',
  'jersey_number',
  'variant_key',
  'group_id',
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

  /**
   * Per-INSTANCE memo for `resolveTrackingProfile`. A service instance is built
   * per request (`forCurrentUser()`), and `po-imports` deliberately builds ONE
   * and loops `create()` over every import line — without this each line paid
   * one or two `categories` reads for the same handful of category ids. A
   * category's tracking policy cannot change inside a request, so a hit is
   * always sound. Never share an instance across requests.
   */
  private readonly trackingProfiles: TrackingProfileCache = new Map();

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
        'id, sku, barcode, model_number, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, is_rental, auto_archived, awaiting_first_receipt, custom_fields, group_id, variant_size, variant_size_system, jersey_number, variant_key, created_at, updated_at, created_by, updated_by',
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
      // Books use the legacy book_rack_* keys; everything else the neutral
      // rack_* keys. buildRackFilterClause owns the split, the sanitization and
      // the legacy-composite tolerance — see its doc comment.
      const clause = buildRackFilterClause(filters.rack, filters.itemType);
      if (clause.kind === 'eq') query = query.filter(clause.column, 'eq', clause.value);
      else if (clause.kind === 'or') query = query.or(clause.expr);
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
        tracking_type: 'none' | 'lot' | 'serial' | 'serial_optional';
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
        /** Sports variant identity (0298). NULL on every ungrouped item, which
         *  is every item in every org until an opt-in link is made. Kept in
         *  lockstep with ITEM_SELECT_COLUMNS in loaders/inventory-list.ts —
         *  that list is a verbatim copy of this select, so the cached and live
         *  paths must gain columns together or the two rows drift. */
        group_id: string | null;
        variant_size: string | null;
        variant_size_system: string | null;
        jersey_number: string | null;
        variant_key: string | null;
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
      // Same shared clause builder as list() — including the legacy-composite
      // tolerance, so the expected-count never disagrees with the list itself.
      const clause = buildRackFilterClause(opts.rack, opts.itemType);
      if (clause.kind === 'eq') query = query.filter(clause.column, 'eq', clause.value);
      else if (clause.kind === 'or') query = query.or(clause.expr);
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
   * Loads only the identity tuple (id, sku, name, barcode, tracking_type) plus
   * the two sports variant columns for a list of item ids. Lets callers like
   * the PO detail page and the label printer render rows without over-fetching
   * the entire inventory just for name/sku lookups. Unlike list(), this does
   * NOT exclude rental items — a direct-id caller (labels, PO lines)
   * legitimately references them. Order is not guaranteed; callers should
   * index by id.
   *
   * `group_id` / `variant_size` (0298) are NULL for every item in every
   * non-sports org, so callers that ignore them are unaffected. The PO receive
   * dialog reads them to lay a size run out as one block (Task 16).
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
      tracking_type: 'none' | 'lot' | 'serial' | 'serial_optional';
      group_id: string | null;
      variant_size: string | null;
    }>
  > {
    if (ids.length === 0) return [];
    let query = this.ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, barcode, tracking_type, group_id, variant_size')
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
        | 'serial'
        | 'serial_optional',
      group_id: (r.group_id as string | null) ?? null,
      variant_size: (r.variant_size as string | null) ?? null,
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
   * Uncapped, group-scoped item read for the "Add size run" picker (Task 16
   * review fix).
   *
   * The PO create/edit pages built the picker's variant grouping out of
   * `list({ limit: 1000 })` — the SAME capped read used for the plain item
   * picker. In an org with more than 1000 items, a group whose 1001st+
   * variant fell past that cap simply never appeared, so the size run looked
   * complete but silently under-counted, and the buyer ordered an incomplete
   * run. This method takes the group ids the caller already resolved and
   * reads EVERY variant under them via `fetchAllRows`, so a group's size
   * count is correct no matter how large the rest of the catalog is.
   *
   * Read posture mirrors `listForMatching()`: org-scoped, non-deleted,
   * active, non-rental, warehouse-scoped for non-all-access roles, viewer
   * category restriction. `group_id` is sent in `chunkIdsForInFilter`
   * batches rather than one `.in()` — the same batching precedent as the
   * portal catalog fix (23e319f6): a large sports catalog can carry hundreds
   * of product groups, and a single `.in()` risks the same URL-length /
   * row-cap failure mode chunking already guards elsewhere in this file.
   */
  async listGroupVariants(groupIds: string[]): Promise<
    Array<{
      id: string;
      sku: string;
      name: string;
      unit_cost: number;
      group_id: string | null;
      variant_size: string | null;
    }>
  > {
    const uniqueGroupIds = Array.from(new Set(groupIds.filter(Boolean)));
    if (uniqueGroupIds.length === 0) return [];

    const access = await getWarehouseAccess(this.ctx);
    if (!access.hasAllAccess && access.readableIds.length === 0) return [];

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

    type Row = {
      id: string;
      sku: string;
      name: string;
      unit_cost: number;
      group_id: string | null;
      variant_size: string | null;
    };
    const out: Row[] = [];
    for (const idChunk of chunkIdsForInFilter(uniqueGroupIds)) {
      const rows = await fetchAllRows<Row>((from, to) => {
        let query = this.ctx.supabase
          .from('inventory_items')
          .select('id, sku, name, unit_cost, group_id, variant_size')
          .eq('organization_id', this.ctx.organizationId)
          .in('group_id', idChunk)
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
      out.push(...rows);
    }
    return out;
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
  async create(
    input: CreateItemInput,
    opts: { awaitingFirstReceipt?: boolean; source?: 'import' } = {},
  ) {
    assertPermission(this.ctx, 'items:create');

    // Phase 5: lot/serial tracking + shelf-life/expiry are gated behind the
    // lot_serial module. Fail closed — a disabled org cannot make an item
    // lot/serial-tracked or set expiry config.
    //
    // SPORTS (Task 8): this gate reads `input.trackingType` — what the CALLER
    // asked for — and it is deliberately unchanged. The sports serial exception
    // is not a wider input contract, it is a CATEGORY-DRIVEN STAMP: a sports
    // category resolves its own tracking_type further down (see the profile
    // block) and is gated there against the `sports` module instead of
    // `lot_serial`, per the owner decision that `sports` carries no lot_serial
    // dependency. A caller posting `serial_optional` DIRECTLY still needs
    // lot_serial exactly as before, because at this point nothing has been
    // proven about the category and the form is never the authority.
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

    // ── Sports profile resolution (server-side; the form is never trusted) ──
    // For every category that has never been given a tracking_mode — which is
    // every category in every org today — this returns QUANTITY / 'none' /
    // 'unit' with `modeIsExplicit: false`, and the whole block below is inert.
    const profile = resolveModeOverride(
      this.ctx,
      await resolveTrackingProfile(this.ctx, input.categoryId ?? null, this.trackingProfiles),
      input.trackingModeOverride,
    );
    assertVariantAttributesValid(profile.profile, input);

    let resolvedGroupId: string | null = input.groupId ?? null;
    // Attaching to a group is the `sports` entitlement, whatever the category
    // says. RLS already pins the group to this org (product_group_in_org, 0298)
    // but says nothing about the module, so gate it here too.
    if (resolvedGroupId) assertModuleEnabled(this.ctx, 'sports');
    if (profile.isSports) {
      assertModuleEnabled(this.ctx, 'sports');
      if (!resolvedGroupId && input.productGroup) {
        const groups = new ProductGroupsService(this.ctx);
        const { group } = await groups.findOrCreate({
          ...input.productGroup,
          subcategoryKey: profile.subcategoryKey ?? 'other_sports_equipment',
          categoryId: input.categoryId ?? null,
          defaultCountingUnit: (input.productGroup.defaultCountingUnit ??
            profile.countingUnit) as CountingUnit,
          // The group INHERITS the category's size scale, exactly as it inherits
          // the counting unit on the line above. No caller ever sent
          // `sizeScaleId`, so `product_groups.size_scale_id` was NULL on EVERY
          // group ever created — and a group-scoped size count with no scale
          // falls back to the built-in apparel letters, offering XS..5XL to
          // count a numeric shoe run (observed in prod 2026-07-28).
          // `profile.sizeScaleId` is the category's own scale with the parent's
          // inherited (resolveTrackingProfile) — the same scale the size
          // validation below runs against, so the group and its variants can
          // never disagree about the vocabulary.
          sizeScaleId: input.productGroup.sizeScaleId ?? profile.sizeScaleId ?? null,
        });
        resolvedGroupId = group.id;
      }
    }

    // ── Size normalization + the category's size scale ──────────────────────
    // IDENTICAL to what bulkCreateSizedVariants and the PO-import matcher have
    // always done. create() used to feed the RAW client string into the key AND
    // persist it raw, so '  xl  ' typed on the item form minted `size=  xl  `
    // while the same shirt arriving on a PO minted `size=xl`. Two keys for one
    // physical size means the import matcher finds no match and creates a
    // SECOND variant — which is precisely the duplicate the key exists to stop.
    //
    // The scale is only read when there IS a size, so a sizeless row (every
    // item in every non-sports org) pays for nothing.
    const rawVariantSize = input.variantSize ?? null;
    let normalizedVariantSize: string | null = null;
    let resolvedSizeSystem: string | null = input.variantSizeSystem ?? null;
    if (rawVariantSize && rawVariantSize.trim().length > 0) {
      const { sizeSystem: scaleSizeSystem, allowedSizes } = await this.loadSizeScale(
        profile.sizeScaleId,
      );
      // The caller's system wins; the scale fills an omission. Whatever is
      // chosen is ALSO what gets persisted below, because `recomputeVariantKey`
      // rebuilds the key from the COLUMNS — a key carrying a system the column
      // dropped would silently re-key the row on the next duplicate.
      resolvedSizeSystem = input.variantSizeSystem ?? scaleSizeSystem ?? null;
      normalizedVariantSize = normalizeSizeValue(rawVariantSize, resolvedSizeSystem);
      // inventory_items_variant_size_check (0298) caps this at 24 characters —
      // refuse it here so the caller gets a sentence, not a constraint name.
      if (!normalizedVariantSize || normalizedVariantSize.length > 24) {
        throw new ServiceError(
          'validation_error',
          `"${rawVariantSize}" is not a usable size. Sizes are 1 to 24 characters.`,
          { code: 'SHOE_SIZE_REQUIRED' },
        );
      }
      if (allowedSizes && !allowedSizes.has(normalizedVariantSize.toUpperCase())) {
        throw new ServiceError(
          'validation_error',
          `"${rawVariantSize}" is not a size in this category's size scale.`,
          { code: 'SHOE_SIZE_REQUIRED' },
        );
      }
    }

    // variant_key is SERVER-COMPUTED identity, ALWAYS. `createItemSchema` does
    // not even carry the field (zod strips a client-supplied one), and it is
    // rebuilt here from the parsed attributes: the key decides which physical
    // stock an item merges with, so a caller choosing its own would be choosing
    // that merge.
    //
    // Computed whenever the row is SPORTS **or GROUPED** (review fix). It used
    // to be sports-only, but `groupId` is accepted independently of the
    // category: a caller could attach a variant to a group under a non-sports,
    // unresolvable or archived category and land a grouped row with
    // `variant_key = NULL`. That row is invisible to `product_group_rollups`
    // (which counts DISTINCT variant_key) and to the import matcher, so the
    // next import would create a second variant for the same physical size.
    const resolvedVariantKey =
      profile.isSports || resolvedGroupId
        ? buildVariantKey({
            size: normalizedVariantSize,
            sizeSystem: resolvedSizeSystem,
            width: input.variantWidth,
            fit: input.variantFit,
            color: input.variantColor,
            jerseyNumber: input.jerseyNumber,
          })
        : null;

    // The category mode STAMPS tracking_type. An explicit `input.trackingType`
    // still wins wherever the category expresses no policy, so every existing
    // caller is bit-for-bit unaffected; a category that DOES carry a mode (a
    // sports subcategory, or any category an admin gave an explicit
    // tracking_mode) overrides it, because the category is the authority
    // (requirement 11: server-side, never trust the form).
    const stampedTrackingType =
      profile.isSports || profile.modeIsExplicit ? profile.trackingType : input.trackingType;
    if (stampedTrackingType !== input.trackingType && stampedTrackingType !== 'none') {
      // The CATEGORY asked for this, not the caller, so the lot_serial gate at
      // the top of this method never saw it. 'serial' / 'serial_optional' on a
      // Sports subcategory are granted by the `sports` module itself (already
      // asserted above); every other case — 'lot' anywhere, a serial mode on a
      // non-sports category — still belongs to lot_serial, unchanged.
      const grantedBySports =
        profile.isSports &&
        (stampedTrackingType === 'serial' || stampedTrackingType === 'serial_optional');
      if (!grantedBySports) assertModuleEnabled(this.ctx, 'lot_serial');
    }

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
        // Counting unit: an EXPLICIT input always wins, including an explicit
        // 'unit'; the category default (PAIR for shoes) applies only when the
        // caller omitted the field entirely. The old spelling compared against
        // 'unit' as a stand-in for "unset", which quietly re-wrote a sibling
        // copied off a real 'unit' row. DISPLAY convention only — there is no
        // conversion anywhere, and `profile.countingUnit` falls back to 'unit',
        // so a category with no default is byte-identical to before.
        unit_of_measure: input.unitOfMeasure ?? profile.countingUnit,
        bin_location: input.binLocation ?? null,
        tracking_type: stampedTrackingType,
        group_id: resolvedGroupId,
        // NORMALIZED for matching; the ORIGINAL keeps what was actually typed,
        // verbatim and never cleaned up (0298's contract, same as the bulk path).
        variant_size: normalizedVariantSize,
        variant_size_original: input.variantSizeOriginal ?? rawVariantSize,
        variant_size_system: resolvedSizeSystem,
        variant_width: input.variantWidth ?? null,
        variant_fit: input.variantFit ?? null,
        variant_color: input.variantColor ?? null,
        jersey_number: input.jerseyNumber ?? null,
        player_name: input.playerName ?? null,
        variant_key: resolvedVariantKey,
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

    // VARIANT PROVENANCE. 'sports.variant.created' / '.imported' were declared
    // in the audit union and emitted by nothing — vocabulary no reviewer could
    // ever see. A minted `variant_key` is exactly the moment a variant's
    // IDENTITY comes into existence, and "did a person add this size or did an
    // import invent it?" is the first question asked when a group later looks
    // wrong. `opts.source` is the only thing that separates the two, because
    // both surfaces reach this one method.
    if (resolvedVariantKey) {
      void audit(
        {
          event: opts.source === 'import' ? 'sports.variant.imported' : 'sports.variant.created',
          entityType: 'inventory_item',
          entityId: data.id as string,
          warehouseId: resolvedWarehouseId,
          extra: {
            group_id: resolvedGroupId,
            variant_key: resolvedVariantKey,
            variant_size: normalizedVariantSize,
          },
        },
        this.ctx,
      );
    }

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
    // DECOMPOSE the duplicate dialog's rack fields — a user duplicating an item
    // onto "22-B" types the label they read off the shelf.
    const dupRack = normalizeRackFields({ number: input.rackNumber, row: input.rackRow });
    const rackLabel = formatRackLabel(dupRack);
    if (input.itemType === 'book') {
      overrides.book_rack_number = dupRack.number;
      overrides.book_rack_row = dupRack.row;
      overrides.book_crate_color = input.crateColor;
      overrides.book_crate_number = input.crateNumber;
      overrides.bin_location = `${rackLabel} · ${input.crateColor}${input.crateNumber}`;
    } else {
      overrides.rack_number = dupRack.number;
      overrides.rack_row = dupRack.row;
      overrides.bin_location = rackLabel;
    }

    // Variant overrides (migration 0299). The RPC distinguishes an ABSENT key
    // (inherit the original) from a key PRESENT WITH null (clear the field),
    // so only set one the caller actually supplied. `undefined` would be
    // dropped by JSON serialisation anyway, but leaving the key out keeps the
    // two states explicit at this seam.
    if (input.variantSize !== undefined) overrides.variant_size = input.variantSize;
    if (input.variantSizeOriginal !== undefined)
      overrides.variant_size_original = input.variantSizeOriginal;
    if (input.variantSizeSystem !== undefined)
      overrides.variant_size_system = input.variantSizeSystem;
    if (input.variantWidth !== undefined) overrides.variant_width = input.variantWidth;
    if (input.variantFit !== undefined) overrides.variant_fit = input.variantFit;
    if (input.variantColor !== undefined) overrides.variant_color = input.variantColor;
    if (input.jerseyNumber !== undefined) overrides.jersey_number = input.jerseyNumber;
    if (input.playerName !== undefined) overrides.player_name = input.playerName;
    // variant_key is SERVER-COMPUTED only (buildVariantKey) — never accepted
    // from the client, so the RPC deliberately ignores any variant_key in
    // p_overrides. When a variant attribute IS overridden the copied key would
    // be stale, so 0299 CLEARS it to NULL and leaves the recompute to this
    // service. Track whether that happened so we can do exactly that below.
    const variantOverrideKeys = [
      'variant_size',
      'variant_size_system',
      'variant_width',
      'variant_fit',
      'variant_color',
      'jersey_number',
    ] as const;
    const variantAttributesOverridden = variantOverrideKeys.some((k) => k in overrides);

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

    // Recompute the identity 0299 cleared. `buildVariantKey` lives in
    // packages/core and is the ONE place a key is built, so the recompute reads
    // the row's FINAL column values back (the RPC merged overrides with the
    // original's) rather than re-deriving them from the request. Leaving the
    // key NULL would take the duplicate out of every variant lookup and let a
    // later import create a second row for the same physical variant.
    if (variantAttributesOverridden) {
      await this.recomputeVariantKey(newId as string);
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
   * Load a size scale's system and its legal values.
   *
   * Returns `allowedSizes: null` when the category has no scale — that is
   * every category in every org today, and it means "accept any size" rather
   * than "accept none". Both the printed `value` and the stored `normalized`
   * form are admitted, upper-cased, because `normalizeSizeValue` upper-cases
   * alpha sizes and leaves numerics alone.
   */
  private async loadSizeScale(
    sizeScaleId: string | null,
  ): Promise<{ sizeSystem: string | null; allowedSizes: Set<string> | null }> {
    if (!sizeScaleId) return { sizeSystem: null, allowedSizes: null };
    const { data: scale, error: scaleErr } = await this.ctx.supabase
      .from('size_scales')
      .select('id, size_system')
      .eq('id', sizeScaleId)
      .is('deleted_at', null)
      .maybeSingle();
    if (scaleErr) throw new ServiceError('internal_error', scaleErr.message);
    if (!scale) return { sizeSystem: null, allowedSizes: null };

    const { data: values, error: valErr } = await this.ctx.supabase
      .from('size_scale_values')
      .select('value, normalized')
      .eq('size_scale_id', sizeScaleId);
    if (valErr) throw new ServiceError('internal_error', valErr.message);
    const rows = (values ?? []) as Array<{ value: string; normalized: string }>;
    // A scale with no values yet must not lock the whole category out.
    if (rows.length === 0) {
      return { sizeSystem: (scale as { size_system: string | null }).size_system, allowedSizes: null };
    }
    const allowed = new Set<string>();
    for (const r of rows) {
      if (r.value) allowed.add(r.value.toUpperCase());
      if (r.normalized) allowed.add(r.normalized.toUpperCase());
    }
    return {
      sizeSystem: (scale as { size_system: string | null }).size_system,
      allowedSizes: allowed,
    };
  }

  /**
   * Rebuild `variant_key` for one item from its own persisted attributes.
   *
   * The single recompute seam. Called after `duplicate_inventory_item` clears
   * the key on an attribute override (0299); a variant with a NULL key is
   * invisible to the group roll-up's `count(distinct variant_key)` and to the
   * import matcher, so the row is repaired rather than left half-identified.
   *
   * Best-effort by design: the duplicate itself already exists and is correct
   * in every other respect, so a failure here is logged, not thrown — the same
   * posture as the movement-log writeback below.
   */
  private async recomputeVariantKey(itemId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select(
        'variant_size, variant_size_system, variant_width, variant_fit, variant_color, jersey_number, player_name',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (error || !data) {
      console.warn('[recomputeVariantKey] read failed', error?.message ?? 'row not found');
      return;
    }
    const row = data as Record<string, string | null>;
    const variantKey = buildVariantKey({
      size: row.variant_size,
      sizeSystem: row.variant_size_system,
      width: row.variant_width,
      fit: row.variant_fit,
      color: row.variant_color,
      jerseyNumber: row.jersey_number,
    });
    const { error: updErr } = await this.ctx.supabase
      .from('inventory_items')
      .update({ variant_key: variantKey })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId);
    if (updErr) console.warn('[recomputeVariantKey] update failed', updErr.message);
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
    /** Omit to take the category's counting unit (PAIR for shoes); an explicit
     *  value — including 'unit' — always wins. Mirrors create(). */
    unitOfMeasure?: string;
    /** Structured rack stamp written to every variant's custom_fields.rack_number/rack_row. */
    rackNumber?: string | null;
    rackRow?: string | null;
    /**
     * Per-org custom field values applied to EVERY created variant. Reserved
     * keys (size, rack_number, rack_row, ...) are stripped — the variant
     * builder owns those.
     */
    customFields?: Record<string, unknown> | null;
    /**
     * The group these variants belong to. Optional and NULL by default: an
     * ungrouped size run behaves exactly as it did before the sports program.
     * Never inferred from the name (owner decision: no name-heuristic
     * grouping) — the caller either knows the group or there isn't one.
     */
    groupId?: string | null;
    /**
     * Sports (Task 11 review fix). The exact twin of `create()`'s field: when
     * the category resolves to a sports subcategory and no `groupId` was given,
     * the group is found-or-created from these attributes and its id stamped on
     * every row. `group_key` is computed by `ProductGroupsService`, never
     * accepted from a caller.
     */
    productGroup?: CreateProductGroupInput;
    /** An authorized mode override, gated by the same `resolveModeOverride`
     *  path `create()` uses (`sports:manage` + the subcategory's allowedModes). */
    trackingModeOverride?: TrackingMode;
    /**
     * Variant attributes SHARED by every row in the run. A jersey number is
     * worn in M and in XL (regression R3) and a colour is one colour across the
     * run, so these are per-RUN, unlike `size` which is per-row. All of them
     * feed the server-computed `variant_key` except `playerName`, which
     * `create()` also leaves out of variant identity.
     */
    variantWidth?: string | null;
    variantFit?: string | null;
    variantColor?: string | null;
    jerseyNumber?: string | null;
    playerName?: string | null;
    /**
     * A size is now free TEXT, not one of nine apparel letters. A shoe run is
     * '7'..'15' with halves and an apparel run is 'XS'..'5XL'; the authority is
     * the category's size scale (migration 0294), validated below.
     */
    variants: Array<{ size: string; quantity: number }>;
  }): Promise<Array<{ id: string; name: string; sku: string }>> {
    assertPermission(this.ctx, 'items:create');
    if (input.variants.length === 0) {
      throw new ServiceError(
        'validation_error',
        'Pick at least one size or change the category.',
      );
    }
    await assertPlanLimit(this.ctx, 'items', input.variants.length);

    // ── Size vocabulary + variant identity ──────────────────────────────────
    // The category decides the size system and, when it carries a size scale,
    // which sizes are legal at all. With no scale configured — every category
    // in every org today — any non-empty size is accepted and the behaviour is
    // unchanged apart from the nine-letter cap being gone.
    //
    // The mode override rides the SAME `resolveModeOverride` gate create()
    // uses — `sports:manage` plus the subcategory's own allowedModes — so the
    // sized path can never become the cheap way around a permission check.
    const profile = resolveModeOverride(
      this.ctx,
      await resolveTrackingProfile(this.ctx, input.categoryId, this.trackingProfiles),
      input.trackingModeOverride,
    );
    const { sizeSystem, allowedSizes } = await this.loadSizeScale(profile.sizeScaleId);

    // The category STAMPS tracking_type here exactly as it does in create().
    // This fan-out is sports-only sized apparel, so hardcoding 'none' meant a
    // SERIALIZED (or OPTIONAL_SERIALIZED) category produced untracked rows
    // through this path and tracked ones through create() — the same physical
    // product with two different receive-time contracts. There is no caller
    // trackingType on this path at all, so 'none' remains the answer for every
    // category that expresses no policy: unchanged for every org today.
    const stampedTrackingType =
      profile.isSports || profile.modeIsExplicit ? profile.trackingType : 'none';
    if (profile.isSports) assertModuleEnabled(this.ctx, 'sports');
    if (stampedTrackingType !== 'none') {
      // Same handoff as create(): a sports subcategory's serial modes are
      // granted by the `sports` module (asserted just above); everything else
      // — 'lot' anywhere, a serial mode from a non-sports category — is still
      // lot_serial's.
      const grantedBySports =
        profile.isSports &&
        (stampedTrackingType === 'serial' || stampedTrackingType === 'serial_optional');
      if (!grantedBySports) assertModuleEnabled(this.ctx, 'lot_serial');
    }

    let resolvedGroupId: string | null = input.groupId ?? null;
    if (resolvedGroupId) {
      // Attaching to a group is the `sports` entitlement — same gate create()
      // applies, so the two create paths cannot disagree.
      assertModuleEnabled(this.ctx, 'sports');
      // Confirm the group is ours BEFORE the insert. The RLS WITH CHECK arm
      // (product_group_in_org, 0298) would refuse a foreign group anyway, but
      // it surfaces as an opaque row-level-security error rather than a
      // sentence a user can act on.
      const { data: g, error: gErr } = await this.ctx.supabase
        .from('product_groups')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', resolvedGroupId)
        .is('deleted_at', null)
        .maybeSingle();
      if (gErr) throw new ServiceError('internal_error', gErr.message);
      if (!g) throw new ServiceError('not_found', 'That product group no longer exists.');
    }
    // Inline new-group creation, byte-for-byte the branch create() runs. Add
    // Item shows a "this will be saved as / Product group" preview BEFORE the
    // user picks sizes, and a sized sports category (shoes) leaves through this
    // method — without this the preview promised a group that was never saved.
    // Only for a SPORTS category, and only when no group was chosen already.
    if (profile.isSports && !resolvedGroupId && input.productGroup) {
      const groups = new ProductGroupsService(this.ctx);
      const { group } = await groups.findOrCreate({
        ...input.productGroup,
        subcategoryKey: profile.subcategoryKey ?? 'other_sports_equipment',
        categoryId: input.categoryId,
        defaultCountingUnit: (input.productGroup.defaultCountingUnit ??
          profile.countingUnit) as CountingUnit,
        // Same inheritance create() applies — see the comment there. This is the
        // path a SHOE run takes, which is exactly the group whose size count was
        // rendering XS..5XL instead of 9 / 9.5 / 10.
        sizeScaleId: input.productGroup.sizeScaleId ?? profile.sizeScaleId ?? null,
      });
      resolvedGroupId = group.id;
    }

    const seenVariantKeys = new Set<string>();
    /**
     * `variant_key` is SERVER-COMPUTED identity, always — the key decides which
     * physical stock a row merges with. Built ONCE here so the duplicate check
     * below and the insert further down can never disagree, and shaped exactly
     * like create()'s call: `playerName` is deliberately absent from both, or
     * the same jersey would land as two variants depending on which path
     * created it.
     */
    const variantKeyFor = (normalizedSize: string) =>
      buildVariantKey({
        size: normalizedSize,
        sizeSystem,
        width: input.variantWidth,
        fit: input.variantFit,
        color: input.variantColor,
        jerseyNumber: input.jerseyNumber,
      });

    for (const v of input.variants) {
      const raw = v.size?.trim() ?? '';
      if (raw.length === 0) {
        throw new ServiceError('validation_error', 'Every variant needs a size.', {
          code: 'SHOE_SIZE_REQUIRED',
        });
      }
      const normalized = normalizeSizeValue(raw, sizeSystem);
      // The inventory_items_variant_size_check constraint (0298) caps this at
      // 24 characters; refuse it here so the batch fails with a sentence
      // instead of a constraint name.
      if (!normalized || normalized.length > 24) {
        throw new ServiceError(
          'validation_error',
          `"${raw}" is not a usable size. Sizes are 1 to 24 characters.`,
          { code: 'SHOE_SIZE_REQUIRED' },
        );
      }
      if (allowedSizes && !allowedSizes.has(normalized.toUpperCase())) {
        throw new ServiceError(
          'validation_error',
          `"${raw}" is not a size in this category's size scale.`,
          { code: 'SHOE_SIZE_REQUIRED' },
        );
      }
      // The subcategory's own attribute rules, same helper create() calls. A
      // no-op for every non-sports category (it returns immediately on a null
      // profile), so nothing that exists today changes.
      assertVariantAttributesValid(profile.profile, {
        variantSize: normalized,
        variantSizeSystem: sizeSystem,
        jerseyNumber: input.jerseyNumber,
      });
      const key = variantKeyFor(normalized);
      if (seenVariantKeys.has(key)) {
        throw new ServiceError('validation_error', `Size "${raw}" is listed twice.`, {
          code: 'VARIANT_ALREADY_EXISTS',
        });
      }
      seenVariantKeys.add(key);
    }

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

    // Rack stamp shared by every variant. DECOMPOSE first (so "22-B" typed in
    // the number box becomes ("22","B") instead of being reduced to "22" with
    // the row silently dropped), THEN strip to the shapes the form input
    // enforces (digits-only number, A-Z0-9 row uppercase).
    const parsedVariantRack = normalizeRackFields({
      number: input.rackNumber,
      row: input.rackRow,
    });
    const rackNum = parsedVariantRack.number.replace(/[^0-9]/g, '') || null;
    const rackRow =
      (rackNum && parsedVariantRack.row?.toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;
    const variantCustomFields = (size: string) => {
      // Org custom fields first; the reserved variant keys (size/rack_*) are
      // applied last so they always win even if a stray key slipped through.
      const cf: Record<string, unknown> = { ...sharedCustomFields, size };
      if (rackNum) cf.rack_number = rackNum;
      if (rackRow) cf.rack_row = rackRow;
      return cf;
    };

    const rows = input.variants.map((v) => {
      const normalizedSize = normalizeSizeValue(v.size, sizeSystem) as string;
      return {
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
      // Explicit caller value wins; the category default fills an omission.
      // Same rule as create() so the two create paths cannot disagree.
      unit_of_measure: input.unitOfMeasure ?? profile.countingUnit,
      item_type: 'product',
      status: 'active',
      tracking_type: stampedTrackingType,
      // First-class variant columns (0298). custom_fields.size is STILL
      // written above: the legacy size readers (display heuristics, the
      // existing filters) have not moved yet, and Task 19 owns the dual-write
      // backfill that retires them. Writing both keeps this path consistent
      // with every row those readers already depend on.
      group_id: resolvedGroupId,
      variant_size: normalizedSize,
      variant_size_original: v.size,
      variant_size_system: sizeSystem,
      // Shared across the whole run: a jersey number is worn in M and in XL
      // (regression R3), and a colour/width/fit is one value for the run.
      variant_width: input.variantWidth ?? null,
      variant_fit: input.variantFit ?? null,
      variant_color: input.variantColor ?? null,
      jersey_number: input.jerseyNumber ?? null,
      player_name: input.playerName ?? null,
      variant_key: variantKeyFor(normalizedSize),
      custom_fields: variantCustomFields(v.size),
      created_by: this.ctx.userId,
      updated_by: this.ctx.userId,
      };
    });

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

    const inserted = (data ?? []) as Array<{
      id: string;
      name: string;
      sku: string;
      quantity_on_hand: number;
      primary_location_id: string | null;
    }>;

    // Audited FIRST: the rows exist from here on whatever happens to the
    // movement write below, and an item that exists with no 'created' event is
    // a hole in the trail no later step can fill.
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

    // Opening stock_movements for the non-zero variants.
    //
    // THE LEDGER INVARIANT IS ABSOLUTE: for every item,
    // SUM(stock_movements.quantity_change) = quantity_on_hand. This block used
    // to console.warn a failed insert and RETURN SUCCESS, which left rows
    // carrying stock that no movement anywhere explains — invisible to the item
    // Activity feed and to the 14-day sparklines, and silently wrong for every
    // reconciliation, restore point and audit that sums the ledger. "The items
    // exist, the gap is recoverable" was true of the ROWS and false of the
    // BOOKS.
    //
    // So: COMPENSATE, then fail loudly. Zeroing the on-hand of exactly the rows
    // we just inserted restores 0 = 0 — the variants survive (their skus, sizes
    // and keys are all correct) and the operator re-enters the quantities as a
    // normal stock adjustment, which writes its own movement. Rolling the ITEMS
    // back instead would be a hard DELETE on a table whose whole convention is
    // soft-delete, and a fail-open .delete().eq() under RLS would leave the
    // worst of both.
    //
    // TWO INVARIANTS, NOT ONE (re-review). `trg_seed_initial_level` (0199) is an
    // AFTER INSERT trigger on inventory_items: by the time this movement insert
    // is even attempted, it has ALREADY written one `item_stock_levels` row per
    // stocked variant, at the same quantity. Nothing syncs levels on UPDATE, so
    // zeroing only `quantity_on_hand` left Σlevels = N against on_hand = 0 —
    // PHANTOM PLACED STOCK. That is not a cosmetic mismatch: the archive
    // stock-guard takes max(on_hand, Σholdings) and would refuse to archive the
    // variant forever, and the placed draw-down would happily pick those units,
    // driving on_hand NEGATIVE against a ledger that says nothing ever arrived.
    // The compensation therefore restores BOTH: levels 0 = on_hand 0 = no
    // movements.
    //
    // ORDER: levels FIRST. If the second write then fails, the intermediate is
    // "stock on the row, not placed" — the pre-0199 shape, which blocks picking
    // and is caught by the same max() the guard uses. The reverse order's
    // intermediate is the phantom-placed one, which is the state that picks
    // negative. Either way this throws, but the worse intermediate is not worth
    // choosing.
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
        const stockedIds = inserted.filter((r) => r.quantity_on_hand > 0).map((r) => r.id);

        // (a) The PLACEMENTS the 0199 trigger seeded.
        const { error: levelErr } = await this.ctx.supabase
          .from('item_stock_levels')
          .update({ quantity: 0 })
          .eq('organization_id', this.ctx.organizationId)
          .in('item_id', stockedIds);

        // (b) The row quantity.
        const { data: zeroed, error: zeroErr } = await this.ctx.supabase
          .from('inventory_items')
          .update({ quantity_on_hand: 0, updated_by: this.ctx.userId })
          .eq('organization_id', this.ctx.organizationId)
          .in('id', stockedIds)
          .select('id');
        // .update().eq() is FAIL-OPEN under RLS: no error, no row. A partial
        // compensation is still a broken ledger, so it is treated as a failure.
        const compensated = ((zeroed ?? []) as Array<{ id: string }>).length;

        // (c) PROVE the placements are gone. Both writes above are filtered
        // updates, so "no error" is not evidence that anything was matched —
        // and the level write cannot even use the returned-row trick, because
        // zero level rows is a LEGITIMATE outcome (the 0199 trigger swallows
        // its own failures by design). A re-read is the only unambiguous
        // answer, and it is the answer that matters: any surviving placement is
        // exactly the phantom-stock state this compensation exists to prevent.
        const { data: leftovers, error: verifyErr } = await this.ctx.supabase
          .from('item_stock_levels')
          .select('id')
          .eq('organization_id', this.ctx.organizationId)
          .in('item_id', stockedIds)
          .gt('quantity', 0);
        const survivingPlacements = ((leftovers ?? []) as unknown[]).length;

        if (
          levelErr ||
          zeroErr ||
          verifyErr ||
          compensated !== stockedIds.length ||
          survivingPlacements > 0
        ) {
          console.error(
            '[bulkCreateSizedVariants] opening movements failed AND the rollback failed',
            {
              movementError: movementErr.message,
              levelError: levelErr?.message,
              rollbackError: zeroErr?.message,
              verifyError: verifyErr?.message,
              survivingPlacements,
              stockedIds,
            },
          );
          throw new ServiceError(
            'internal_error',
            'These variants were created, but their opening stock could not be recorded and the quantities could not be rolled back. Contact support to reconcile them before receiving, picking or counting against them.',
          );
        }
        console.error(
          '[bulkCreateSizedVariants] opening movements failed; on-hand and placements rolled back to 0',
          { movementError: movementErr.message, stockedIds },
        );
        throw new ServiceError(
          'internal_error',
          'These variants were created, but their opening stock could not be recorded, so they were saved with zero on hand. Add the quantities with a stock adjustment.',
        );
      }
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
      trackingType?: 'none' | 'lot' | 'serial' | 'serial_optional';
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

    // The SAME gate matrix create() applies, which this path never had: it
    // accepted `trackingType` — including 'serial_optional' — with no module
    // check at all, making it the cheapest way in the app to mint lot/serial
    // rows in an org that never enabled lot_serial, 500 at a time.
    //
    // Nothing here can be SPORTS-granted. create()'s carve-out is
    // category-driven (a Sports subcategory stamps its own serial mode and the
    // `sports` module grants it); bulkCreate rows carry no categoryId at all,
    // so no profile exists to grant anything and the matrix reduces to
    // "non-'none' belongs to lot_serial". Checked once for the whole batch,
    // before any read or write.
    if (input.items.some((i) => (i.trackingType ?? 'none') !== 'none')) {
      assertModuleEnabled(this.ctx, 'lot_serial');
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
    //
    // Deliberately BEFORE the module gates (it used to be after). The Task 8
    // lot_serial carve-out is CATEGORY-DRIVEN, and the category is a property
    // of the row — there is nothing to resolve it from until the row is loaded.
    // The only visible consequence is that an id the caller cannot see now
    // surfaces as not_found rather than module_disabled, which is the better
    // ordering anyway.
    const current = await this.get(id);
    const currentWarehouseId = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (currentWarehouseId) await assertWarehouseAccess(currentWarehouseId, 'write', this.ctx);

    // ── Sports profile for the row's FINAL category ─────────────────────────
    // The category the row will HAVE after this patch, so moving an item into
    // (or out of) a sports category is judged by where it lands. For every
    // category that has never been given a tracking_mode — every category in
    // every org today — this is QUANTITY / 'none' / not-sports and everything
    // below is inert.
    const nextCategoryId =
      patch.categoryId !== undefined
        ? (patch.categoryId ?? null)
        : ((current as { category_id?: string | null }).category_id ?? null);
    const profile = await resolveTrackingProfile(
      this.ctx,
      nextCategoryId,
      this.trackingProfiles,
    );

    // Phase 5: gate lot/serial + expiry edits behind the lot_serial module —
    // now carrying create()'s Task 8 carve-out, which never shipped here.
    //
    // THE BUG THIS CLOSES: the item form re-submits the row's own tracking_type
    // on every save, so in a sports-only org (the owner decision is that
    // `sports` carries NO lot_serial dependency) every serial_optional item was
    // UNEDITABLE — a rack correction, a price fix, anything, threw
    // module_disabled before the first column was written.
    //
    // The carve-out is deliberately narrow and matches create()'s exactly: only
    // the two SERIAL modes, only on a Sports subcategory, and only while the
    // `sports` module that grants them is actually on. 'lot' anywhere, and any
    // serial mode on a non-sports category, still belong to lot_serial.
    if (patch.trackingType !== undefined && patch.trackingType !== 'none') {
      const grantedBySports =
        profile.isSports &&
        this.ctx.enabledModules.has('sports') &&
        (patch.trackingType === 'serial' || patch.trackingType === 'serial_optional');
      if (!grantedBySports) assertModuleEnabled(this.ctx, 'lot_serial');
    }
    // Shelf life / expiry are lot_serial's alone — sports grants nothing here.
    if (
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

    // ── Rewriting tracking_type in place ────────────────────────────────────
    const currentTrackingType = ((current as { tracking_type?: string | null }).tracking_type ??
      'none') as TrackingTypeValue;
    const nextTrackingType = patch.trackingType as TrackingTypeValue | undefined;
    const trackingTypeChanged =
      nextTrackingType !== undefined && nextTrackingType !== currentTrackingType;
    if (trackingTypeChanged) {
      await this.assertTrackingTypeChangeAllowed(id, nextTrackingType!, profile);
    }

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

    // DUAL-WRITE (transition window, migration 0303). variant_size is the
    // durable column — indexed, length-CHECKed, and what the group roll-up and
    // the import matcher read. custom_fields.size is the shape every row
    // bulkCreateSizedVariants ever wrote still carries, and it is the source
    // 0303's backfill copies from and its rollback restores from. Writing one
    // without the other lets them disagree, so update() always writes both:
    // otherwise a size edited on the item form drifts from the size a re-run
    // of the backfill would recover. Remove the custom_fields half only when
    // every writer and reader has moved — tracked in the migration report.
    //
    // Before 0303 this method ignored patch.variantSize entirely, so a size
    // edit on the item form was silently dropped.
    const currentVariantSize =
      (current as { variant_size?: string | null }).variant_size ?? null;
    let variantSizeChanged = false;
    if (patch.variantSize !== undefined) {
      const rawSize = patch.variantSize ?? null;
      // NORMALIZE, exactly as bulkCreateSizedVariants and the PO-import matcher
      // do — same helper, same scale resolution. update() used to persist and
      // key off the raw typed string, so a size corrected on the item form
      // ('  l  ') disagreed with the same size arriving on a PO ('L') and the
      // import matcher created a second variant for it.
      let nextSize: string | null = null;
      let nextSizeSystem: string | null =
        patch.variantSizeSystem ??
        ((current as { variant_size_system?: string | null }).variant_size_system ?? null);
      if (rawSize && rawSize.trim().length > 0) {
        const { sizeSystem: scaleSizeSystem, allowedSizes } = await this.loadSizeScale(
          profile.sizeScaleId,
        );
        nextSizeSystem = nextSizeSystem ?? scaleSizeSystem ?? null;
        nextSize = normalizeSizeValue(rawSize, nextSizeSystem);
        if (!nextSize || nextSize.length > 24) {
          throw new ServiceError(
            'validation_error',
            `"${rawSize}" is not a usable size. Sizes are 1 to 24 characters.`,
            { code: 'SHOE_SIZE_REQUIRED' },
          );
        }
        if (allowedSizes && !allowedSizes.has(nextSize.toUpperCase())) {
          throw new ServiceError(
            'validation_error',
            `"${rawSize}" is not a size in this category's size scale.`,
            { code: 'SHOE_SIZE_REQUIRED' },
          );
        }
      }
      variantSizeChanged = nextSize !== currentVariantSize;
      updates.variant_size = nextSize;
      // Re-record the ORIGINAL only when the size actually moved. The item form
      // submits every field on every save and now seeds the row's stored size,
      // so an unrelated edit (a reorder point, a rack) re-sends the SAME size —
      // and rewriting the original on that would replace 0303's verbatim source
      // record ('  xl  ') with the normalized column value ('XL'), destroying
      // the audit trail against custom_fields.size that the rollback statement
      // and the migration's own assertion depend on. The original is the source
      // of the size, so it changes only when the size does.
      if (variantSizeChanged) {
        updates.variant_size_original = patch.variantSizeOriginal ?? rawSize;
        // Persist the system the key below is BUILT FROM whenever it differs
        // from what the row carries — `recomputeVariantKey` (the duplicate
        // path) rebuilds the key from the COLUMNS, so a key carrying a system
        // the column never learned would silently re-key the copy.
        const storedSizeSystem =
          (current as { variant_size_system?: string | null }).variant_size_system ?? null;
        if (nextSizeSystem !== storedSizeSystem) {
          updates.variant_size_system = nextSizeSystem;
        }
        // variant_key is DERIVED from the size (plus the other variant
        // attributes), so it is rebuilt HERE, in the same statement as the size
        // it describes — not after the write. That is what lets the Model B
        // fan-out below carry the new identity to every OTHER placement of this
        // sku in one go; a post-write recompute only ever repaired the row the
        // editor happened to be looking at, leaving its siblings keyed under a
        // size they no longer have. Same builder, same slots as create() and
        // bulkCreateSizedVariants — player_name is absent from all three.
        updates.variant_key = buildVariantKey({
          size: nextSize,
          sizeSystem: nextSizeSystem,
          width: (current as { variant_width?: string | null }).variant_width,
          fit: (current as { variant_fit?: string | null }).variant_fit,
          color: (current as { variant_color?: string | null }).variant_color,
          jerseyNumber: (current as { jersey_number?: string | null }).jersey_number,
        });
      }
      if (nextSize) {
        // Merge onto whatever custom_fields THIS patch is already writing.
        // Reading the stored object instead would revert a custom-field edit
        // submitted in the same form post — the item form always sends both.
        // No re-validation is needed: `size` is a RESERVED_CUSTOM_FIELD_KEY, so
        // no org can have defined it and validateCustomFields only walks defs.
        const baseCustomFields =
          (updates.custom_fields as Record<string, unknown> | undefined) ??
          ((current as { custom_fields?: Record<string, unknown> | null }).custom_fields ?? {});
        updates.custom_fields = { ...baseCustomFields, size: nextSize };
      }
      // Clearing the size deliberately does NOT delete custom_fields.size. It
      // is the only surviving record of what the size was, and 0303's rollback
      // statement reads it; the reader migration retires the key wholesale.
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

    // A tracking_type move is its OWN event, not a line in a generic edit's
    // changed_keys list: it changes what receiving DEMANDS of every unit from
    // here on (serials required, optional, or refused), and "when did this
    // product stop needing serials, and who decided that?" has to be answerable
    // on its own. The event type and the Activity-feed label for it already
    // existed; nothing had ever emitted it.
    if (trackingTypeChanged) {
      void audit(
        {
          event: 'item.tracking_type.changed',
          entityType: 'inventory_item',
          entityId: id,
          warehouseId: (data as { warehouse_id?: string | null }).warehouse_id ?? null,
          before: { tracking_type: currentTrackingType },
          after: { tracking_type: nextTrackingType },
        },
        this.ctx,
      );
    }

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

  /**
   * The guard on rewriting `inventory_items.tracking_type` in place.
   *
   * WHY THIS EXISTS AT ALL. `tracking_type` is the ONE column post_receipt_v2
   * reads to decide whether a receipt must capture a serial per unit, may
   * capture 0..qty of them, or must refuse them. Flipping it on a product that
   * already has a stock history retro-actively changes the contract the units
   * ALREADY counted were received under: units booked as serialized keep their
   * serial_registry rows while the item claims it never needed any, and units
   * booked untracked suddenly answer to an item that says every one of them has
   * an identifier. Nothing reconciles that afterwards.
   *
   * Plan open question 5's default, now implemented: a product WITH
   * stock_movements cannot change tracking mode in place. Everything before
   * this was `TRACKING_MODE_CHANGE_REQUIRES_MIGRATION` declared in
   * SPORTS_ERROR_CODES, rendered in SPORTS_ERROR_META, and thrown from nowhere
   * — while any `items:update` caller could rewrite the column freely, with
   * 'none' carrying no gate whatsoever.
   *
   * FAIL CLOSED on a read error: a flaky count must never be read as "no
   * history, go ahead".
   *
   * For a product with NO history the change is allowed, but a SPORTS category
   * still gets the last word: the subcategory profile's `allowedModes` is the
   * same list `resolveModeOverride` enforces at create time, so the two seams
   * cannot disagree about what a shoe is allowed to be. A non-sports category
   * expresses no policy and is left exactly as it was.
   */
  private async assertTrackingTypeChangeAllowed(
    id: string,
    next: TrackingTypeValue,
    profile: ResolvedTrackingProfile,
  ): Promise<void> {
    const { count, error } = await this.ctx.supabase
      .from('stock_movements')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', id);
    if (error) {
      throw new ServiceError(
        'internal_error',
        'Could not check this item’s stock history before changing how it is tracked. Please try again.',
      );
    }
    if ((count ?? 0) > 0) {
      throw new ServiceError(
        'validation_error',
        'This product already has stock movements, so how it is tracked cannot be changed in place. Contact support to migrate it, or create a new product with the tracking you need.',
        { code: 'TRACKING_MODE_CHANGE_REQUIRES_MIGRATION' },
      );
    }
    if (!profile.isSports || !profile.profile) return;
    const allowed = new Set(profile.profile.allowedModes.map(trackingTypeForMode));
    if (!allowed.has(next)) {
      throw new ServiceError(
        'validation_error',
        `This category's Sports subcategory does not allow "${next}" tracking.`,
        { code: 'TRACKING_MODE_NOT_ALLOWED' },
      );
    }
  }

  /**
   * Per-location holdings for the ARCHIVE STOCK-GUARD. Reads the SAME shape as
   * placements() (item_stock_levels joined to the location for its display
   * name, non-empty holdings only) but is FAIL-CLOSED where placements() is
   * fail-open: a read error THROWS instead of degrading to [], because the
   * guard must BLOCK an archive it cannot prove is safe — refusing a legitimate
   * archive is recoverable, silently orphaning stock is not.
   */
  private async holdingsForGuard(
    id: string,
  ): Promise<Array<{ locationId: string; label: string; quantity: number }>> {
    const { data, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('location_id, quantity, locations!inner(id, name, kind)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', id)
      .gt('quantity', 0);
    if (error) {
      throw new ServiceError(
        'internal_error',
        'Could not verify this item has no stock before archiving. Please try again.',
      );
    }
    return ((data ?? []) as unknown as Array<{
      location_id: string;
      quantity: number;
      locations: { name: string; kind: string | null };
    }>).map((row) => ({
      locationId: row.location_id,
      label: formatHoldingLabel(row.locations?.kind ?? null, row.locations?.name ?? ''),
      quantity: Number(row.quantity),
    }));
  }

  /**
   * Throws a NAMED validation error when an item still holds stock — the guard
   * that stops archive() from silently orphaning it. `total` is the greater of
   * the item row's quantity_on_hand and the sum of its holdings, so stock that
   * exists on the row but isn't (yet) split into item_stock_levels still blocks.
   */
  private async assertArchivableOrThrow(id: string, item: unknown): Promise<void> {
    const holdings = await this.holdingsForGuard(id);
    const placedTotal = holdings.reduce((sum, h) => sum + h.quantity, 0);
    const onHand = Number((item as { quantity_on_hand?: number }).quantity_on_hand ?? 0);
    const total = Math.max(onHand, placedTotal);
    if (total > 0) {
      throw new ServiceError(
        'validation_error',
        formatArchiveStockBlockMessage(
          total,
          holdings.map((h) => ({ label: h.label, quantity: h.quantity })),
        ),
      );
    }
  }

  /**
   * Bulk twin of assertArchivableOrThrow. ONE query reads every non-empty
   * holding across `ids`; a single-item batch that still holds stock reuses the
   * detailed archive() message (so bulk-of-one matches the item-detail dialog),
   * a multi-item batch names the count of affected items. FAIL-CLOSED: a read
   * error blocks the batch rather than risk orphaning stock.
   */
  private async assertBulkArchivableOrThrow(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { data, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(id, name, kind)')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', ids)
      .gt('quantity', 0);
    if (error) {
      throw new ServiceError(
        'internal_error',
        'Could not verify these items have no stock before archiving. Please try again.',
      );
    }
    const byItem = new Map<string, Array<{ label: string; quantity: number }>>();
    for (const row of (data ?? []) as unknown as Array<{
      item_id: string;
      quantity: number;
      locations: { name: string; kind: string | null };
    }>) {
      const arr = byItem.get(row.item_id) ?? [];
      arr.push({
        label: formatHoldingLabel(row.locations?.kind ?? null, row.locations?.name ?? ''),
        quantity: Number(row.quantity),
      });
      byItem.set(row.item_id, arr);
    }
    if (byItem.size === 0) return;

    // Single-item batch → the detailed, location-naming message (bulk-of-one
    // must read exactly like the item-detail archive dialog).
    if (byItem.size === 1) {
      const [holdings] = [...byItem.values()];
      const total = holdings!.reduce((sum, h) => sum + h.quantity, 0);
      throw new ServiceError('validation_error', formatArchiveStockBlockMessage(total, holdings!));
    }
    throw new ServiceError('validation_error', formatBulkArchiveStockBlockMessage(byItem.size));
  }

  /**
   * @param opts.acknowledgeStock When true, SKIP the stock guard — a deliberate
   *   archive-with-stock (a discontinued line written off wholesale). The guard
   *   kills the SILENT orphan, not the ability to archive stock on purpose.
   */
  async archive(id: string, opts: { acknowledgeStock?: boolean } = {}) {
    assertPermission(this.ctx, 'items:update');
    const current = await this.get(id);
    const wh = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);

    // STOCK GUARD (hazard fix): archiving flips status to 'archived' and
    // DELIBERATELY preserves quantity_on_hand — so an item archived while it
    // still holds stock vanishes from every active screen while
    // item_stock_levels/quantity_on_hand keep counting its units in valuation
    // and reconciliation. That stock is orphaned: invisible but still counted.
    // Refuse by default, naming the total and where it sits, unless the caller
    // explicitly acknowledges. The zero-stock auto-archive cron never reaches
    // here (it archives via auto-archive.ts's own UPDATE), so this guard cannot
    // affect it.
    if (!opts.acknowledgeStock) {
      await this.assertArchivableOrThrow(id, current);
    }

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
    /**
     * When true, SKIP the archive stock-guard for an 'archive' /
     * set_status:'archived' batch — the bulk twin of archive()'s
     * acknowledgeStock. Ignored for every other op.
     */
    acknowledgeStock?: boolean;
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

    // STOCK GUARD (hazard fix), bulk twin of archive()'s: a bulk archive (or a
    // bulk set_status to 'archived') hides every selected item while their
    // stock keeps counting — the same silent-orphan hazard. Refuse the whole
    // batch when any selected item still holds stock, unless the caller
    // acknowledges. Naming every location across up to 500 items is noise, so a
    // multi-item block names the COUNT; a single-item block reuses the detailed
    // archive() message so bulk-of-one reads identically to the item-detail
    // archive dialog. set_status to a non-archived status never triggers this.
    const isBulkArchive =
      input.op.kind === 'archive' ||
      (input.op.kind === 'set_status' && input.op.status === 'archived');
    if (isBulkArchive && !input.acknowledgeStock) {
      await this.assertBulkArchivableOrThrow(allowedIds);
    }

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
      // DECOMPOSE: bulk "Set rack" takes free text, so "22-B" typed into the
      // number box must land as ("22","B") — the shape the rack FILTER reads.
      const parsedRack = normalizeRackFields({
        number: input.op.rackNumber,
        row: input.op.rackRow,
      });
      const num = parsedRack.number || null;
      const row = num ? parsedRack.row?.toUpperCase() ?? null : null;
      const composedBin = num ? formatRackLabel({ number: num, row }) : null;

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

  /**
   * Remove (write off) a quantity of one item from ONE specific location,
   * leaving its stock in every OTHER location untouched. THE tool Andrew needed
   * when he consolidated a rack and reached for archive instead: archive hides
   * the whole item (all locations); this clears exactly one holding.
   *
   * Built entirely on adjustStock — a NEGATIVE delta scoped to `locationId`
   * draws down exactly that holding via the adjust_stock RPC (which decrements
   * the matching item_stock_levels row and writes a stock_movements row with
   * from_location_id = that location), atomically. No new RPC, no direct write
   * to item_stock_levels / quantity_on_hand. movement_type is 'remove' (a
   * write-off is a removal, not a transfer — see RACK_WRITE_OFF_MOVEMENT_TYPE),
   * and the mandatory reason is stored verbatim so the history reads truthfully.
   *
   * The quantity defaults to the whole holding at the call site; here it is
   * CAPPED at the holding — adjust_stock guards the GLOBAL on-hand against going
   * negative but NOT the per-location quantity (its on-conflict just adds the
   * signed delta), so over-drawing one rack while the item has stock elsewhere
   * would push that location negative. We pre-read the level and refuse an
   * over-draw with a clear message rather than let it happen.
   */
  async removeStockFromLocation(input: RemoveStockFromLocationInput) {
    assertPermission(this.ctx, 'stock:adjust');
    const reason = input.reason.trim();
    if (!reason) {
      throw new ServiceError('validation_error', 'A reason is required to remove stock.');
    }
    const qty = Number(input.quantity);
    if (!(qty > 0)) {
      throw new ServiceError('validation_error', 'Enter a quantity greater than zero to remove.');
    }

    // Read the specific holding being drawn down. Fail-closed: a read error
    // blocks the write-off rather than risk pushing a location negative.
    const { data: level, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('quantity')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', input.itemId)
      .eq('location_id', input.locationId)
      .maybeSingle();
    if (error) {
      throw new ServiceError(
        'internal_error',
        'Could not read the stock in that location. Please try again.',
      );
    }
    const onHandAtLocation = Number((level as { quantity?: number } | null)?.quantity ?? 0);
    if (onHandAtLocation <= 0) {
      throw new ServiceError('validation_error', 'That location holds no stock for this item.');
    }
    if (qty > onHandAtLocation) {
      throw new ServiceError(
        'validation_error',
        `Cannot remove ${formatStockQuantity(qty)} — only ${formatStockQuantity(
          onHandAtLocation,
        )} in this location.`,
      );
    }

    // Delegate the mutation: adjustStock re-asserts stock:adjust + warehouse
    // write access, blocks archived items, and emits the movement + audit row.
    return this.adjustStock({
      itemId: input.itemId,
      quantityChange: -qty,
      movementType: RACK_WRITE_OFF_MOVEMENT_TYPE,
      locationId: input.locationId,
      reason,
    });
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
    // DECOMPOSE the destination's rack pair before stamping it onto the item.
    // `dest` is copied straight off the locations row (or the inline new-rack
    // input), so a legacy composite location — ("22-B", null) — would otherwise
    // be stamped verbatim onto every item put away there and go invisible to
    // the "22-B" filter. That is exactly the 2026-07-23 incident.
    const parsed = isRack
      ? normalizeRackFields({ number: dest.rackNumber, row: dest.rackRow })
      : { number: '', row: null };
    const num = parsed.number || null;
    const row = num ? parsed.row?.toUpperCase() ?? null : null;
    const bin = isRack && num ? formatRackLabel({ number: num, row }) : dest.name?.trim() || null;
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

  /**
   * Full stock-movement HISTORY for ONE item, newest-first — the "what came
   * from where, on what date and time, and why, and who" read behind the
   * staging row (owner ask, 2026-07-22).
   *
   * DELIBERATELY SEPARATE FROM stagedWorklist(). Two earlier attempts answered
   * this ask by INFERRING a single winning source movement per holding, inside
   * the worklist query. Both regressed the worklist itself: one widened the
   * movement query into the PostgREST 1000-row cap (which can erase PO
   * attribution that renders correctly today), the other let the winning
   * movement overwrite the row's date, resetting a month-old staging row to
   * "today / 0d" and deleting its Stale badge. This method reads the ledger
   * rows AS THEY ARE and touches nothing stagedWorklist() computes — its
   * fields, its source attribution and its ageDays are unchanged by this work,
   * which is the whole safety property of the history approach.
   *
   * PAGINATION. The window is explicit (`limit`/`offset`) and the page fetch
   * goes through fetchAllRows, so a caller asking for more than one PostgREST
   * page gets every row instead of a silent truncation at `[api] max_rows`.
   * Three separate defects in this codebase came from a client-side constant
   * guessing the server cap; there is no such constant here. `hasMore` is
   * derived by over-fetching ONE row past the window, and `total` is an exact
   * head count, so the surface never has to guess either.
   *
   * BATCHED JOINS, never N+1: the actor comes from the user_profiles embed
   * (same embed MovementsService.list uses), and location names + receipts are
   * each an `in(...)` query over the ids on the page — CHUNKED at 500, because
   * `limit` clamps at 2000 and a single `in(...)` would be silently truncated
   * at PostgREST's 1000-row cap, losing route and PO attribution on the rows
   * past the cut (see chunkIdsForInFilter).
   *
   * TRUTHFULNESS. Rendering vocabulary lives in @stockpilot/core
   * (formatHistoryMovement) so web and mobile say the same words; this method
   * only supplies facts. Notably it never infers intent from movement_type —
   * `return` rows are handed over as-is because cancel_order_request writes
   * that type for an internally-cancelled pick — and never promotes an
   * internal token or a raw UUID into `note` (historyNote decides).
   */
  async itemMovementHistory(params: {
    itemId: string;
    /** Page size. Defaults to 50. Clamped to 2000 — deliberately ABOVE the
     *  PostgREST `[api] max_rows` ceiling of 1000, because the window is
     *  assembled by fetchAllRows and so is not bounded by that cap. A caller
     *  wanting a whole busy item's ledger in one read gets it. */
    limit?: number;
    /** Rows to skip, newest-first. */
    offset?: number;
  }): Promise<ItemHistoryPage> {
    assertPermission(this.ctx, 'items:read');
    const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 50)), 2000);
    const offset = Math.max(0, Math.floor(params.offset ?? 0));

    // 1. The item itself — also the access anchor. Org-scoped on top of RLS.
    const { data: itemRow, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name, sku, warehouse_id, deleted_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', params.itemId)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
    const item = itemRow as
      | { id: string; name: string; sku: string; warehouse_id: string | null; deleted_at: string | null }
      | null;
    if (!item || item.deleted_at) throw new ServiceError('not_found', 'Item not found');

    // 2. Warehouse scoping. Pass our own ctx so the helper never falls back to
    //    requireOrgContext() — that path throws NEXT_REDIRECT inside /api and
    //    surfaces as a generic 500 (recurring trap #23).
    const access = await getWarehouseAccess(this.ctx);
    if (!access.hasAllAccess && (!item.warehouse_id || !access.readableIds.includes(item.warehouse_id))) {
      throw new ForbiddenError('No access to this item’s warehouse.');
    }

    // 3. Exact total so the surface can say "50 of 214" instead of guessing.
    const { count, error: countErr } = await this.ctx.supabase
      .from('stock_movements')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', item.id);
    if (countErr) throw new ServiceError('internal_error', countErr.message);
    const total = count ?? 0;

    // 4. The window itself. created_at DESC is the reading order; id DESC is
    //    the tiebreak that makes paging deterministic — without a stable
    //    secondary sort the same row can land on two pages or none (two of the
    //    owner's movements share created_at to the microsecond).
    const window = await fetchAllRows<Record<string, unknown>>(
      (from, to) =>
        this.ctx.supabase
          .from('stock_movements')
          .select(
            `
            id, movement_type, quantity_change, previous_quantity, new_quantity,
            moved_quantity, from_location_id, to_location_id, reason, notes,
            created_at, user_id,
            actor:user_profiles!user_id (id, full_name, email)
          `,
          )
          .eq('organization_id', this.ctx.organizationId)
          .eq('item_id', item.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset + from, offset + to),
      // Over-fetch exactly one row so hasMore is a fact, not an inference from
      // a page being "full".
      { cap: limit + 1 },
    );
    const hasMore = window.length > limit;
    const raw = window.slice(0, limit);

    // 5. Batched joins over the ids ON THIS PAGE only — one query each.
    const locationIds = [
      ...new Set(
        raw.flatMap((r) => [r.from_location_id, r.to_location_id]).filter(Boolean) as string[],
      ),
    ];
    const locationNames = new Map<string, string>();
    // CHUNKED, not one `.in()`. These lookups are bounded by the number of
    // distinct ids ON THIS PAGE, and `limit` clamps to 2000 (deliberately above
    // PostgREST's 1000-row `[api] max_rows` ceiling, see the param doc) — so a
    // large page can ask for more than 1000 rows here and PostgREST would
    // silently return the first 1000. The rows past the cut would render with
    // no route and no receipt/PO attribution, which is the SAME defect (a
    // widened query hitting the 1000-row cap and erasing PO attribution) that
    // got the first attempt at this feature reverted. Chunking is preferred
    // over lowering the route's limit because the limit's whole purpose is
    // "give me this busy item's entire ledger in one read".
    for (const idChunk of chunkIdsForInFilter(locationIds)) {
      const { data: locs, error: locErr } = await this.ctx.supabase
        .from('locations')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', idChunk);
      // Graceful degradation: an unresolvable location renders no route rather
      // than hiding the movement (or leaking a raw uuid as a "name").
      if (locErr) console.error('item history: location lookup failed', { error: locErr.message });
      for (const l of (locs ?? []) as Array<{ id: string; name: string }>) {
        locationNames.set(l.id, l.name);
      }
    }

    // post_receipt_v2 (mig 0190) stores receipts.id in stock_movements.notes
    // (the p_notes arg of adjust_stock), NOT reference_id — the same schema
    // quirk stagedWorklist documents. That is why receipt provenance is keyed
    // off `notes` here.
    const receiptIds = [
      ...new Set(
        raw
          .map((r) => ((r.notes as string | null) ?? '').trim())
          .filter((n) => UUID_RE.test(n)),
      ),
    ];
    type ReceiptMeta = {
      receiptNumber: string | null;
      status: string | null;
      poNumber: string | null;
      poStatus: string | null;
      reversedReceiptId: string | null;
      reversalReason: string | null;
    };
    const receiptMeta = new Map<string, ReceiptMeta>();
    // Chunked for the same reason as the location lookup above: a 2000-row page
    // can carry more than 1000 distinct receipt ids, and a single `.in()` would
    // silently drop the receipt/PO provenance of everything past PostgREST's
    // 1000-row cap.
    for (const idChunk of chunkIdsForInFilter(receiptIds)) {
      const { data: receipts, error: rErr } = await this.ctx.supabase
        .from('receipts')
        .select(
          'id, receipt_number, status, reversed_receipt_id, reversal_reason, purchase_orders(po_number, status)',
        )
        .eq('organization_id', this.ctx.organizationId)
        .in('id', idChunk);
      // Graceful degradation: the movement still renders, just without its
      // receipt/PO provenance, rather than the whole history failing.
      if (rErr) console.error('item history: receipt/PO lookup failed', { error: rErr.message });
      for (const r of (receipts ?? []) as Array<Record<string, unknown>>) {
        const poField = r.purchase_orders as
          | { po_number?: string | null; status?: string | null }
          | Array<{ po_number?: string | null; status?: string | null }>
          | null;
        const po = Array.isArray(poField) ? (poField[0] ?? null) : poField;
        receiptMeta.set(r.id as string, {
          receiptNumber: (r.receipt_number as string | null) ?? null,
          status: (r.status as string | null) ?? null,
          poNumber: po?.po_number ?? null,
          poStatus: po?.status ?? null,
          reversedReceiptId: (r.reversed_receipt_id as string | null) ?? null,
          reversalReason: (r.reversal_reason as string | null) ?? null,
        });
      }
    }

    // 6. Reversal pairing. `receipts.reversed_receipt_id` is the RECORDED link
    //    between an undo and what it undid — we read it rather than matching on
    //    the "-REV" suffix or on equal-and-opposite quantities, either of which
    //    would be a guess. Both halves write their own movement, so both
    //    receipts are normally already in `receiptMeta`; when the counterpart
    //    falls outside the loaded page we still state the ROLE (which comes
    //    from this receipt's own status) and simply omit the counterpart.
    const movementByReceiptId = new Map<string, string>();
    for (const r of raw) {
      const rid = ((r.notes as string | null) ?? '').trim();
      if (UUID_RE.test(rid) && !movementByReceiptId.has(rid)) {
        movementByReceiptId.set(rid, r.id as string);
      }
    }
    const reversalByOriginalId = new Map<string, string>();
    for (const [rid, meta] of receiptMeta) {
      if (meta.reversedReceiptId) reversalByOriginalId.set(meta.reversedReceiptId, rid);
    }

    const rows: ItemHistoryMovement[] = raw.map((r) => {
      const actorField = r.actor as
        | { id: string; full_name: string | null; email: string | null }
        | Array<{ id: string; full_name: string | null; email: string | null }>
        | null
        | undefined;
      const actorRaw = Array.isArray(actorField) ? (actorField[0] ?? null) : (actorField ?? null);
      // Rule 5: a row with no user_id was written by a trigger/system process.
      // It gets NO actor — never "System" dressed up as a person.
      const actorName = actorRaw ? (actorRaw.full_name?.trim() || actorRaw.email || null) : null;
      // Only surface the email when it is a genuinely second fact.
      const actorEmail =
        actorRaw?.email && actorRaw.email !== actorName ? actorRaw.email : null;

      const rid = ((r.notes as string | null) ?? '').trim();
      const meta = UUID_RE.test(rid) ? (receiptMeta.get(rid) ?? null) : null;

      let reversal: ItemHistoryMovement['reversal'] = null;
      let reversalReason: string | null = null;
      if (meta?.status === 'reversal' && meta.reversedReceiptId) {
        const original = receiptMeta.get(meta.reversedReceiptId) ?? null;
        reversal = {
          role: 'reversal',
          counterpartMovementId: movementByReceiptId.get(meta.reversedReceiptId) ?? null,
          counterpartReceiptNumber: original?.receiptNumber ?? null,
        };
        // The typed reason lives on the REVERSING receipt.
        reversalReason = meta.reversalReason?.trim() || null;
      } else if (meta?.status === 'reversed') {
        const revId = reversalByOriginalId.get(rid) ?? null;
        const rev = revId ? (receiptMeta.get(revId) ?? null) : null;
        reversal = {
          role: 'reversed',
          counterpartMovementId: revId ? (movementByReceiptId.get(revId) ?? null) : null,
          counterpartReceiptNumber: rev?.receiptNumber ?? null,
        };
        reversalReason = rev?.reversalReason?.trim() || null;
      }

      return {
        id: r.id as string,
        at: r.created_at as string,
        movementType: r.movement_type as string,
        quantityChange: Number(r.quantity_change ?? 0),
        movedQuantity: r.moved_quantity === null || r.moved_quantity === undefined
          ? null
          : Number(r.moved_quantity),
        previousQuantity: Number(r.previous_quantity ?? 0),
        newQuantity: Number(r.new_quantity ?? 0),
        actorName,
        actorEmail,
        fromLocationName: r.from_location_id
          ? (locationNames.get(r.from_location_id as string) ?? null)
          : null,
        toLocationName: r.to_location_id
          ? (locationNames.get(r.to_location_id as string) ?? null)
          : null,
        note: historyNote((r.reason as string | null) ?? null, (r.notes as string | null) ?? null),
        receiptNumber: meta?.receiptNumber ?? null,
        receiptStatus: meta?.status ?? null,
        poNumber: meta?.poNumber ?? null,
        poStatus: meta?.poStatus ?? null,
        reversalReason,
        reversal,
      };
    });

    return {
      itemId: item.id,
      itemName: item.name,
      itemSku: item.sku,
      rows,
      total,
      limit,
      offset,
      hasMore,
    };
  }
}

/**
 * Splits a list of ids into batches small enough that a PostgREST `.in()`
 * filter can return ALL of the matches.
 *
 * PostgREST truncates any single response at `[api] max_rows` (1000 on this
 * project) WITHOUT an error — the client just gets fewer rows than it asked
 * about, which reads as "those ids do not exist". For a lookup that decorates
 * rows (location names, receipt/PO provenance) that silent truncation shows up
 * as missing attribution on real movements, not as a failure. 500 leaves
 * headroom for a row-per-id join fanning out (a receipt embeds its PO).
 *
 * Returns an empty array for an empty input, so callers can simply `for…of` it.
 */
function chunkIdsForInFilter(ids: readonly string[], size = 500): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
