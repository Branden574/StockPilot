import 'server-only';

import { generateSku } from '@/lib/utils';
import {
  assertWarehouseAccess,
  forcedWarehouseId,
  getWarehouseAccess,
  ForbiddenError,
} from '@/lib/auth/warehouse';
import type { PlaceDest } from '@/lib/locations/destination-option';
import { isRackShelfLocation, isSystemLocation } from '@/lib/locations/groups';
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
import type { RackHoldingLike } from '@stockpilot/core';
import type {
  BookCrateAcknowledgedChange,
  BookCrateChangeItem,
  BookRackAcknowledgedChange,
  BookRackChangeItem,
  BookStorageInfo,
} from '@stockpilot/core';
import {
  BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION,
  BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION,
  bookCrateAcknowledgementIndex,
  bookCrateFingerprint,
  bookCratePlacementWillSync,
  bookRackAcknowledgementIndex,
  buildVariantKey,
  normalizeCrateColorForWrite,
  describeBookCrateConflict,
  describeBookRackClear,
  describeRackChange,
  rackOutcomeBasis,
  isBookCrateChangeAcknowledged,
  isBookRackChangeAcknowledged,
  isCrateDestination,
  formatArchiveStockBlockMessage,
  formatBulkArchiveStockBlockMessage,
  formatHoldingLabel,
  formatRackLabel,
  formatRackPosition,
  formatStockQuantity,
  hasRackPosition,
  historyNote,
  collectLegacyRefIdsByKind,
  normalizeRackFields,
  normalizeSizeValue,
  orderNumberLabels,
  returnNumberLabels,
  parseRackLabel,
  readBookStorage,
  RACK_WRITE_OFF_MOVEMENT_TYPE,
  RECEIPT_NOTE_SENTINEL_RE,
  RESERVED_CUSTOM_FIELD_KEYS,
  trackingTypeForMode,
  validateCustomFields,
} from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, assertPlanLimit, ServiceError, withContext, type PlanLimitSlot, type ServiceContext } from './context';
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
 * The searchable barcode for a staging row: `inventory_items.barcode` (where a
 * book's ISBN is stored), falling back to the legacy isbn/isbn13/isbn10
 * custom-field keys exactly as the inventory export does. Pure + exported for
 * tests. Returns null when nothing is recorded.
 */
export function readStagingBarcode(item: {
  barcode?: string | null;
  custom_fields?: Record<string, unknown> | null;
}): string | null {
  const direct = typeof item.barcode === 'string' ? item.barcode.trim() : '';
  if (direct) return direct;
  const cf = item.custom_fields;
  if (!cf || typeof cf !== 'object') return null;
  for (const key of ['isbn', 'isbn13', 'isbn10'] as const) {
    const v = cf[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
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
 *  as a receipt reference — anything else is an operator's typed note. That is
 *  the same judgement the display surfaces make, so it uses the same regex:
 *  @stockpilot/core `movement-note-sentinel`, the one definition in the repo. */
const UUID_RE = RECEIPT_NOTE_SENTINEL_RE;

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

/**
 * The free-text `q` OR-clause, built once and reused by BOTH the main list
 * query and the parallel value-footer sum query so the two can never disagree
 * about which rows the search matched.
 *
 * `isbnVariants` (opt-in, see ItemListFilters) appends the equivalent ISBN
 * forms as an exact `barcode.in.(…)` disjunct INSIDE the same clause — a
 * second `.or()` call would AND against the first and match nothing. Absent
 * it, the returned string is byte-for-byte the four-field clause this has
 * always produced.
 *
 * Returns null when the sanitized term is empty (nothing to filter on).
 */
function buildItemSearchClause(rawQ: string, isbnVariants?: string[]): string | null {
  // PostgREST's .or() takes a raw filter string. Strip characters
  // that would let a search term escape its clause and fan out the
  // filter tree (commas, parens, asterisks, percent signs). Also
  // cap at a sane length so a 10MB search term can't be ingested.
  const term = rawQ.trim().slice(0, 120).replace(/[,()%*]/g, ' ');
  if (!term) return null;
  const clause =
    `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%,model_number.ilike.%${term}%`;
  // ISBNs are digits plus a trailing 'X' check character — anything else is
  // not an ISBN and must never reach the filter string.
  const variants = (isbnVariants ?? [])
    .map((v) => v.replace(/[^0-9Xx]/g, '').toUpperCase())
    .filter((v) => v.length === 10 || v.length === 13);
  if (variants.length === 0) return clause;
  return `${clause},barcode.in.(${variants.map((v) => `"${v}"`).join(',')})`;
}

// How many items' rack transfers may be in flight at once during a create-time
// auto-place (placeManualCreateOnRack). Deliberately the SAME cap
// placeItemsOntoRackByName picked for bulk "Set rack" (its local CONCURRENCY),
// for the same two reasons stated there: sequential RPC round trips are what
// made a 13-item place "take forever", and a cap keeps the connection pool sane
// at the ceiling (60 sizes for a size run, 500 items for bulk Set rack). Kept
// as one named constant so the create path cannot silently drift to a different
// number than the bulk path.
const RACK_PLACE_CONCURRENCY = 20;

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
  /**
   * Equivalent ISBN forms to ALSO accept as a barcode match, folded into
   * the same `q` OR-clause (never a separate `.or()`, which would AND
   * against it and return nothing). Build them with
   * `isbnVariants()` — a book is stocked under whichever of its ISBN-10 /
   * ISBN-13 forms was captured at creation (barcode = ISBN), so typing the
   * other form finds nothing without this.
   *
   * Opt-in and only consulted alongside `q`: absent (EVERY existing caller)
   * the OR clause is byte-identical to what it has always been. Values are
   * sanitized to [0-9X] here, so nothing a user types can escape the clause.
   */
  isbnVariants?: string[];
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
 * A put-away destination. Defined in `@/lib/locations/destination-option`
 * beside its client-facing twin (both describe the same `locations` row, fed
 * by the same column list) and re-exported here because this service's
 * placement methods are its main consumer.
 */
export type { PlaceDest } from '@/lib/locations/destination-option';

/**
 * Thrown when a placement would OVERWRITE a book's recorded crate and the
 * caller has not acknowledged THAT change. Carried on ServiceError.details so
 * the action layer can forward it verbatim; the client retries the SAME
 * request with `acknowledgedCrateChanges` built from this payload — id plus
 * crate fingerprint per line, never a blanket boolean.
 *
 * Every field here is safe to show a user: two rendered labels, the item's own
 * name, and a fingerprint of the crate that name is recorded in. No raw DB
 * text.
 *
 * DECLARED IN @stockpilot/core, re-exported here. The client component that
 * renders this refusal cannot import a `server-only` service, and a second
 * copy of the reason string would drift the moment one side was edited — so
 * both halves of the contract read the same declaration
 * (packages/core/src/inventory/book-crate-placement.ts). Existing importers of
 * these names from this module keep working.
 */
export { BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION } from '@stockpilot/core';
export type { BookCrateChangeDetail } from '@stockpilot/core';

/**
 * The RACK half of the same refusal — see
 * packages/core/src/inventory/book-rack-placement.ts for why it is its own
 * channel rather than a wider crate fingerprint.
 */
export { BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION } from '@stockpilot/core';
export type { BookRackChangeDetail } from '@stockpilot/core';

/**
 * ═══ ONE PAYLOAD, TWO QUESTIONS — NEVER TWO STACKED REFUSALS ═══
 *
 * A placement can change the crate, erase the rack, or both, and the operator
 * must read that as ONE confirmation. So the gate throws ONE `details` blob:
 * `items` carries the crate lines and `rackItems` the rack ones.
 *
 * `reason` KEEPS NAMING THE CRATE CONSTANT whenever there is at least one crate
 * line. That is the compatibility hinge: every already-shipped client matches on
 * that string, and `parseBookCrateChangeDetail` ignores keys it does not know,
 * so a combined payload reads to an old client exactly as it always did. A
 * rack-ONLY refusal is the one shape that carries the rack reason — and it can
 * only ever be sent to a caller that declared it can answer one (see
 * `assertBookCratePlacementAllowed`), so no shipped client can receive a payload
 * it cannot act on.
 */
interface BookPlacementChangeDetail {
  reason:
    | typeof BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION
    | typeof BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION;
  items: BookCrateChangeItem[];
  rackItems?: BookRackChangeItem[];
}

/**
 * A book's crate SUMMARY as read from `inventory_items` at one instant.
 *
 * The gate reads one of these per book BEFORE the stock moves and the
 * reconciliation reads a fresh one AFTER, and the pair is what proves nobody
 * re-crated the book in between — see `syncBookCratePlacement`.
 */
export interface BookCrateSummary {
  name: string;
  crateColor: string | null;
  crateNumber: string | null;
  /**
   * The rack this book is recorded on today (book_rack_number / book_rack_row).
   *
   * NOT COMPARED AND NOT FINGERPRINTED — but it IS synchronised. The pair is a
   * projection of the same fact as the crate pair (which single location the
   * book's stock resolves to), so `syncBookCratePlacement` rewrites it from the
   * live holdings alongside the crate. What it is not is part of the
   * ACKNOWLEDGEMENT: the operator is asked about a crate, `changed` is decided
   * on the crate pair alone, and the rack is its own non-blocking sentence
   * (`describeRackChange`). Fingerprinting it here would refuse a placement
   * because someone edited a key nobody was asked about.
   *
   * Its job on THIS type is still label-only: it lets the gate's refusal say
   * "recorded in Blue 4 on rack 40-B" instead of naming a crate that exists five
   * times over, and it gives the audit trail a real `before` for the pair.
   *
   * OPTIONAL for that reason: a caller that hands `syncBookCratePlacement` a
   * freshness proof it built by hand is attesting to the CRATE it showed, and
   * the rack is no part of that attestation.
   */
  rackNumber?: string | null;
  rackRow?: string | null;
}

/**
 * What the GATE cleared, per book: the summary it verified, plus the one
 * authorisation it can grant.
 *
 * ═══ WHY AN AUTHORISATION TRAVELS WITH THE FRESHNESS PROOF ═══
 *
 * The reconciliation runs after the stock has moved and derives both pairs from
 * the location the live holdings resolve to. Three of its four outcomes replace
 * a value with another TRUE value the operator could read off the destination
 * they picked. The fourth — CLEARING a rack a human typed, because the
 * destination states no position — is the one write that destroys a fact and
 * leaves nothing behind that remembers it. So the sync is allowed to perform it
 * only for a book whose erasure the operator was actually shown, and this flag
 * is how the gate says which. Everything else about the placement is unchanged.
 *
 * It rides on the verified map rather than in a second argument for the same
 * reason `verified` exists at all: the gate's read and the gate's verdict are
 * one fact about one book at one instant, and a caller that could pass one
 * without the other would eventually pass a mismatched pair.
 */
export interface BookPlacementVerdict extends BookCrateSummary {
  /**
   * The operator was SHOWN this book's rack pair being erased by this
   * placement, and agreed to it. FALSE is the safe answer and the default:
   * absent authorisation the sync keeps the recorded pair and reports it,
   * because a stale rack label is recoverable and a wiped one is not.
   */
  rackClearAcknowledged: boolean;
  /**
   * The operator was SHOWN this book's CRATE pair being CLEARED by this
   * placement — a rack-only destination for a book that records a crate — and
   * agreed to it. Its twin above; same FALSE default, same reason.
   *
   * ═══ WHY THE CRATE HALF NEEDS THIS TOO — MAUS I, 2026-08-17 ═══
   *
   * The reconciliation derives the crate half from the destination row. A plain
   * rack row has no crate columns, so a put-away onto a bare rack derives
   * (null, null) — and for a book whose crate is LABEL-ONLY (113 of L4L's 124
   * books: the crate exists as the item's summary and has no locations row at
   * all) writing that null pair destroys the only record of the crate there is.
   * Maus I went from {yellow, 6, 38, B} to {NULL, NULL, 38, B} on a ten-unit
   * put-away and had to be re-typed by hand. The rack half already refused to
   * do this unasked; the crate half had no twin, so it did.
   *
   * GRANTED by the gate only for a conflict that IS a clear (`nextLabel` null —
   * the destination names no crate) and that the caller acknowledged with the
   * matching crate fingerprint. An acknowledged crate CHANGE (Blue 4 → Green 2)
   * grants nothing here: that write replaces a value with a true value and no
   * clear was ever shown. Fingerprint shapes are unchanged — the existing
   * acknowledgement channel already carries "the operator chose no crate".
   */
  crateClearAcknowledged: boolean;
}

/**
 * What the create-time auto-place actually managed to do.
 *
 * The whole point of returning this is that the create SUCCEEDS regardless —
 * placement is deliberately fail-soft, because a placement hiccup must never
 * undo an item the operator already made. That fail-soft design is correct and
 * is NOT what changed; what changed is that it used to be fail-soft AND
 * silent, so the item was created carrying a rack label whose stock sat
 * somewhere else and nobody was told. A picker then walks to the rack the
 * label names and finds nothing.
 *
 * `rackName` is the NORMALISED label (what `formatRackLabel` produced), so the
 * sentence an operator reads names the same rack the label writes rather than
 * whatever casing they typed.
 */
export interface ManualPlacementOutcome {
  rackName: string;
  /** Items whose stock demonstrably did NOT reach the rack. */
  failedItemIds: string[];
}

/**
 * What a reconciliation did, per bucket. Every caller must surface every one of
 * them: the stock moved in every case, so a silent bucket is a placement the
 * operator believes relabelled something it did not.
 */
export interface BookCrateSyncResult {
  /**
   * The summary was rewritten to match the holdings — BOTH pairs, in one
   * statement. A plain rack CLEARS the crate; a crate that states no position
   * CLEARS the rack pair; a positioned crate writes both.
   */
  syncedItemIds: string[];
  /** The write was attempted and FAILED — the printed label may now be stale. */
  failedItemIds: string[];
  /**
   * Deliberately left alone: this title now holds stock in more than one place.
   * NEITHER pair is written — the rack pair a partial put-away leaves behind is
   * still TRUE of the copies that stayed put, and the crate cannot be stamped
   * over a split for the same reason.
   */
  skippedItemIds: string[];
  /**
   * The row CHANGED between the gate and the write — someone re-crated the book
   * (or deleted it, or flipped it out of `item_type='book'`) while the stock was
   * moving. Left alone rather than overwritten: the acknowledgement the operator
   * gave was about a different crate.
   */
  staleItemIds: string[];
  /**
   * NO PLACED HOLDING LEFT — every unit this book still has sits in a
   * staging/unplaced system bucket, or it has no positive holding at all.
   *
   * There is nothing authoritative to synchronize to (the honest value would be
   * "no crate", but a book with zero stock anywhere is a book whose recorded
   * crate is a human's restocking intent, and wiping that on a read that came
   * back empty is a data-loss bug wearing a tidy-up costume). So the summary is
   * left alone — and REPORTED, because the label may now name a crate that
   * holds none of it.
   *
   * This bucket used to be a bare `continue`: the operator was shown a plain
   * success, the crate still read "Blue 4", and a picker walked to an empty
   * crate. That is the one outcome this module exists to prevent, so it is
   * never silent again — for any entry point.
   */
  unplacedItemIds: string[];
  /**
   * The crate half was written and the RACK half was deliberately NOT — the
   * derivation would have CLEARED a rack a human recorded, and nobody was shown
   * that erasure, so the recorded pair was kept exactly as it stood.
   *
   * ═══ THIS IS THE "FAIL SAFE, NOT FAIL CLOSED" BUCKET ═══
   *
   * It is reached by a caller that could not be asked the rack question (an old
   * client that predates the channel, or a forged request that omitted it), and
   * by a placement whose rack outcome the gate could not predict in time to ask.
   * Refusing those would recreate the exact Critical the first review of this
   * feature found — a gate with no client able to answer it, which made put-away
   * impossible. So the placement SUCCEEDS, the stock is where the operator put
   * it, the crate label follows it, and the rack label stays as it was.
   *
   * WHICH MEANS THE LABEL MAY NOW BE STALE, and every caller must say so. That
   * is the whole trade: a stale rack label is visibly wrong, the reader guards
   * downrank it, and the audit row records what it was — a wiped one is gone,
   * the count still reads healthy, and nobody on the floor knows where to stand.
   * Reporting is what makes "recoverable" true rather than aspirational.
   *
   * NOT mutually exclusive with `syncedItemIds`: the item IS in both, because
   * the write happened and only the rack half was held back.
   */
  rackPreservedItemIds: string[];
  /**
   * The rack half was written and the CRATE half was deliberately NOT — the
   * derivation would have CLEARED a crate a human recorded, and nobody was
   * shown that erasure, so the recorded pair was kept exactly as it stood.
   *
   * ═══ THE OTHER FAIL-SAFE BUCKET — MAUS I, 2026-08-17 ═══
   *
   * Reached by every caller that cannot put the crate question in front of a
   * human — bulk Set rack, a write-off drain, an old client, a forged body —
   * and by a race where the gate predicted a split (and so asked nothing) and
   * the stock then resolved to one plain rack anyway. For a label-only crate
   * (the common case in this warehouse: 113 of 124 books, one crate row) the
   * label IS the crate, so clearing it unasked is not tidying, it is data loss.
   *
   * WHICH MEANS THE LABEL MAY NOW BE STALE, and every caller must say so —
   * the same trade as `rackPreservedItemIds`, for the same reason. A caller
   * that CAN ask (the placement dialogs, the mobile sheet) will have asked, the
   * gate will have granted `crateClearAcknowledged`, and the clear happens; this
   * bucket is for everyone else.
   *
   * NOT mutually exclusive with `syncedItemIds`, and never for a book that
   * recorded no crate (nothing was withheld).
   */
  cratePreservedItemIds: string[];
}

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
        'id, sku, barcode, model_number, name, description, status, quantity_on_hand, reorder_point, reorder_quantity, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, is_rental, auto_archived, awaiting_first_receipt, custom_fields, group_id, variant_size, variant_size_system, jersey_number, variant_key, created_at, updated_at, created_by, updated_by',
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
      const clause = buildItemSearchClause(filters.q, filters.isbnVariants);
      if (clause) query = query.or(clause);
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
        const clause = buildItemSearchClause(filters.q, filters.isbnVariants);
        if (clause) sumQuery = sumQuery.or(clause);
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
    // The SAME rows, carrying `locations.kind`. This scan already had the kind
    // in hand and dropped it; without it no list-fed surface can tell "the
    // stock is in a crate" from "the stock is on a rack", and every one of them
    // keeps printing the rack an item's custom_fields still (deliberately) name
    // after a position-less put-away. See placement-resolution.ts. Keyed by
    // location_id so two same-named racks in different warehouses stay two
    // holdings, matching rackHoldingsCount rather than placed_racks.
    const placedHoldingsByItem = new Map<string, Map<string, RackHoldingLike>>();
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

          const byLoc = placedHoldingsByItem.get(lvl.item_id) ?? new Map<string, RackHoldingLike>();
          const prior = byLoc.get(lvl.location_id);
          byLoc.set(lvl.location_id, {
            name: lvl.locations.name,
            quantity: (prior?.quantity ?? 0) + Number(lvl.quantity),
            kind,
          });
          placedHoldingsByItem.set(lvl.item_id, byLoc);
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
        placed_holdings: [...(placedHoldingsByItem.get(id)?.values() ?? [])].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
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
        // inventory_items.reorder_quantity is numeric(14,4) not null default 0,
        // same as reorder_point — never SQL NULL, so 0 is a genuine configured
        // value and must be read straight through (no `?? 0` masking a
        // missing column, see lib/inventory-export.ts).
        reorder_quantity: number;
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
        /** The same holdings as `placed_racks`, but carrying QUANTITY and
         *  `locations.kind` and deduped by location_id like rackHoldingsCount.
         *  This is the input `resolvePlacement` needs: without `kind` no
         *  consumer can apply the crate rule, and `placed_racks` (names only,
         *  name-deduped) cannot supply it. */
        placed_holdings: RackHoldingLike[];
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
    // established mirroring pattern in this file. `q` now goes through the
    // SAME builder both of those use, so the badge can never disagree with
    // the rows it counts. The Expected chip has no ISBN-variant caller, so
    // it passes none — the clause is the plain four-field one.
    if (opts.q && opts.q.trim()) {
      const qClause = buildItemSearchClause(opts.q);
      if (qClause) query = query.or(qClause);
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
    opts: {
      awaitingFirstReceipt?: boolean;
      source?: 'import';
      /**
       * A plan slot the CALLER already reserved off a per-file
       * `planLimitBudget` (see `importItemsAction`). Its presence is proof the
       * plan check ran for this row — not a way to skip it — and it lets a
       * loop pay the plan's two reads once for the whole file instead of twice
       * per row. Server-only, like the rest of this bag: no request schema
       * parses into it, so a payload cannot conjure one.
       */
      planSlot?: PlanLimitSlot;
    } = {},
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

    // Two reads, and every caller but one still makes them per create. A caller
    // looping this method over a whole file reserves the row's slot itself off
    // one per-file budget and hands it in, which is the same check with the
    // reads amortised — see `opts.planSlot`.
    if (!opts.planSlot) await assertPlanLimit(this.ctx, 'items');

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

    // MANUAL-create-only guards, computed here so both the placement block
    // below AND its doc comment can reference them. `opts.awaitingFirstReceipt`
    // marks the PO-driven creation paths (createItemsFromPoLines / the PO
    // custom-line branches in PurchaseOrdersService), `opts.source === 'import'`
    // marks the PO-import approve path (po-imports-lines.ts, which also always
    // sets awaitingFirstReceipt), and `opts.planSlot` marks the CSV bulk
    // importer (server/actions/import.ts — it never sends `source`, so
    // planSlot is its only tell). None of those get auto-place: PO/receiving
    // keep their put-away step, and bulk/import paths are unchanged for now.
    const isManualCreatePath =
      !opts.awaitingFirstReceipt && opts.source !== 'import' && !opts.planSlot;
    const typedBinLabel = typeof input.binLocation === 'string' ? input.binLocation.trim() : '';

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

    // ── Manual auto-place (owner request 2026-08-04) ────────────────────────
    // "type a rack, enter a starting quantity, the stock lands on that rack"
    // — no Unplaced/awaiting-put-away chip for a hand-typed item.
    //
    // Deliberately does NOT touch `primary_location_id` or the 'initial'
    // movement's `to_location_id` above — both stay exactly what they were
    // before this feature existed. `primary_location_id` is read far beyond
    // the seeding trigger: the location FILTER (instant-mode.ts) checks it
    // against a SITES-ONLY set, exports resolve it unscoped into a "Primary
    // location" column, and pickers/forms all assume a site. Stamping a rack
    // id onto it made auto-placed items vanish from every location-filtered
    // view and leak a duplicate rack label into exports — caught in review.
    //
    // Instead: let `tg_seed_initial_level` (migration 0199, the AFTER INSERT
    // trigger that actually seeds the item's first item_stock_levels row)
    // seed the level exactly as it does today — at `primary_location_id` if
    // the caller set a real one, else the warehouse's Unplaced bucket — and
    // THEN reuse the bulk "Set rack" placement path: resolve-or-create the
    // typed rack (findOrCreateRackLocation — the SAME helper, SAME dedup,
    // SAME 23505-race retry the bulk fix uses) and transferStock the
    // freshly-seeded holding onto it. One shared placement code path, a
    // truthful ledger ('initial' → 'transfer', exactly what a human put-away
    // writes), and zero change to what primary_location_id means anywhere
    // else in the app.
    //
    // FAIL-SOFT: awaited with a catch-all — any failure (rack resolve/create,
    // the holdings read, or the transfer itself) leaves the item created with
    // its stock exactly where the trigger put it (today's behavior). A
    // placement hiccup must never undo or block a create that already
    // succeeded.
    let placement: ManualPlacementOutcome | null = null;
    if (isManualCreatePath && input.quantityOnHand > 0 && typedBinLabel) {
      placement = await this.placeManualCreateOnRack(
        [data.id as string],
        resolvedWarehouseId,
        typedBinLabel,
      ).catch((e) => {
        console.error('[manual create] auto-place failed', {
          itemId: data.id,
          error: e instanceof Error ? e.message : String(e),
        });
        // The helper absorbs its own per-item failures, so reaching here means
        // the whole pass died and nothing about it can be claimed. Report the
        // item as not placed — erring toward the warning, since the silent
        // version of this is the defect.
        return {
          rackName: typedBinLabel,
          failedItemIds: [data.id as string],
        } satisfies ManualPlacementOutcome;
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

    // The row, PLUS what the auto-place managed — on one object rather than a
    // wrapper, because every consumer reads `.id` off this and a reshape would
    // ripple for no gain. `placementFailed` is a synthetic field and not a
    // column: it is named distinctly from anything `inventory_items` carries
    // so it cannot be mistaken for one if this object is ever spread.
    return {
      ...data,
      placementFailed:
        placement && placement.failedItemIds.length > 0
          ? { rackName: placement.rackName, count: placement.failedItemIds.length }
          : null,
    };
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
      // NORMALISE on write — the item summary's crate color is compared and
      // rendered through the CRATE_COLORS registry, so mixed case must not
      // enter it any more than it may enter locations.crate_color.
      overrides.book_crate_color = normalizeCrateColorForWrite(input.crateColor);
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
  }): Promise<{
    rows: Array<{ id: string; name: string; sku: string }>;
    /**
     * Non-null ONLY when a typed rack was asked for and some of the run's
     * stock did not reach it. `null` covers both "everything placed" and "no
     * rack was typed", which are the same thing to a caller: nothing to warn
     * about.
     */
    placementFailed: { rackName: string; count: number } | null;
  }> {
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
      //
      // AN OWNERSHIP CHECK, NOT A STATUS CHECK — deliberately. The pickers that
      // offer a group to attach to (`candidates`, `listForPicker`) are active-
      // only, so an archived group id here was named by the caller; attaching to
      // one is the reversible state ProductGroupsService.archive() already
      // permits under acknowledgement, and restoring the group brings the whole
      // run back. Only `deleted_at` disqualifies a group from being written to.
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

    // ── Size-run auto-place (owner report 2026-08-10) ────────────────────────
    // "type a rack, enter quantities per size, the stock lands on that rack" —
    // the exact promise create() has kept since 2026-08-04, which this path
    // never implemented. PR #69 wired auto-place into manual SINGLE create and
    // bulk "Set rack" and skipped the size run entirely, so a 13-size shoe run
    // typed onto rack 28-A produced 13 variants all reading "Unplaced /
    // awaiting put-away": the rows carried `bin_location` (the text LABEL) and
    // nothing ever moved the holding `tg_seed_initial_level` (0199) seeded at
    // `primary_location_id` / the warehouse's Unplaced bucket. A GAP, not a
    // regression.
    //
    // Same helper, same semantics as create()'s call site — read the long
    // comment there for the full rationale. The three that matter most:
    //
    //  1. `primary_location_id` and the 'initial' movements' `to_location_id`
    //     above are BYTE-UNCHANGED. A rack id must never be written into
    //     `primary_location_id`: the location FILTER (instant-mode.ts) tests it
    //     against a SITES-ONLY set and exports resolve it into a "Primary
    //     location" column, so stamping a rack there makes auto-placed rows
    //     vanish from location-filtered views and duplicates the rack label
    //     into exports. Let the trigger seed wherever it seeds, then MOVE the
    //     holding with transferStock.
    //  2. AFTER the opening movements, never before. That block can throw and
    //     compensate back to zero on-hand + zero levels; placing first would
    //     write 'transfer' rows describing stock that the compensation then
    //     erased. This ordering also matches create()'s (insert → 'initial' →
    //     place), so the ledger reads as a human put-away on both paths.
    //  3. Only the STOCKED variants. A size the user left at 0 has no holding
    //     at all (0199 returns early on qty <= 0), so including it would buy a
    //     wider read for nothing.
    //
    // `typedBinLabel` is derived by the SAME expression create() uses, off the
    // SAME field: `input.binLocation` is what the Add Item form composes with
    // `formatRackLabel(rackNumber, rackRow)` for a size run and with the
    // identical `num`/`num-row` composition for a single item, so the two
    // paths cannot disagree about what counts as a typed rack. There is no
    // `isManualCreatePath` twin to check: this method has no `opts` at all and
    // every caller of it — the web Add Item form, Expo's Add Item screen and
    // POST /api/v1/items/sized-variants — is a hand-typed create. PO,
    // receiving and CSV import never reach it.
    //
    // FAIL-SOFT, and per-variant inside the helper: the variants and their
    // ledger are already committed, so no placement failure may undo or block
    // them, and one variant's failed transfer must not cost the others theirs.
    const typedBinLabel = typeof input.binLocation === 'string' ? input.binLocation.trim() : '';
    const stockedForPlacement = inserted.filter((r) => r.quantity_on_hand > 0).map((r) => r.id);
    let placement: ManualPlacementOutcome | null = null;
    if (typedBinLabel && stockedForPlacement.length > 0) {
      placement = await this.placeManualCreateOnRack(
        stockedForPlacement,
        resolvedWarehouseId,
        typedBinLabel,
      ).catch((e) => {
        console.error('[sized variants] auto-place failed', {
          itemIds: stockedForPlacement,
          error: e instanceof Error ? e.message : String(e),
        });
        // Whole pass died — nothing can be claimed for any variant, so every
        // one that was meant to be placed is reported as not placed.
        return {
          rackName: typedBinLabel,
          failedItemIds: [...stockedForPlacement],
        } satisfies ManualPlacementOutcome;
      });
    }

    return {
      rows: inserted.map((r) => ({ id: r.id, name: r.name, sku: r.sku })),
      // Per-RUN, not per-variant: a size run is one operator action against one
      // typed rack, so "3 of 8 sizes did not reach 28-A" is the sentence that
      // helps. Naming eight variants would bury it.
      placementFailed:
        placement && placement.failedItemIds.length > 0
          ? { rackName: placement.rackName, count: placement.failedItemIds.length }
          : null,
    };
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

    // ═══ SETTING A RACK ON THE EDIT FORM MOVES THE STOCK ═══
    //
    // It did not, and that was the whole bug (owner report, 2026-08-20, "6 foot
    // table"): typing 7 / B here wrote bin_location '7-B' and
    // custom_fields.rack_number/_row, the detail page then read "DC4 7-B", and
    // all ten units stayed in Unplaced with no movement written. The label said
    // one thing and the stock said another.
    //
    // THE INCONSISTENCY IS WHAT MADE IT A TRAP. The same two boxes already MOVE
    // stock on manual create (placeManualCreateOnRack) and in bulk Set rack
    // (placeItemsOntoRackByName). Only single-item edit relabelled, which is
    // not a distinction anybody could infer from the form.
    //
    // REUSES THE BULK HELPER rather than cloning stock logic, so all three
    // paths keep one definition of what placing means — including the rule
    // that matters most here: an item whose stock is SPLIT across several
    // placements is relabelled and NEVER moved, because there is no honest way
    // to decide which rack the operator meant. Stock that is not yet placed
    // (Staging, Unplaced, a bare site) is auto-placed; a single existing rack
    // holding is moved wholesale.
    //
    // BOOKS ARE DELIBERATELY EXCLUDED. A book records a crate as well as a
    // rack, and silently placing one onto a bare rack from this form is exactly
    // the crate erasure that bit Maus I on 2026-08-17. Books have their own
    // placement path with a confirmation gate; it should stay the only way.
    let placementFailed: { rackName: string } | undefined;
    const isBookRow = ((current as { item_type?: string | null }).item_type ?? null) === 'book';
    if (!isBookRow && changedKeys.includes('custom_fields')) {
      const rackOf = (row: Record<string, unknown>) => {
        const cf = (row.custom_fields ?? {}) as Record<string, unknown>;
        const parsed = normalizeRackFields({
          number: typeof cf.rack_number === 'string' ? cf.rack_number : null,
          row: typeof cf.rack_row === 'string' ? cf.rack_row : null,
        });
        const num = parsed.number || null;
        return { num, row: num ? parsed.row?.toUpperCase() ?? null : null };
      };
      const before = rackOf(beforeRow);
      const after = rackOf(afterRow);
      // Only on a real CHANGE to a real rack. Re-placing on every save would
      // drag stock back onto the label after somebody had deliberately
      // transferred it away, and clearing the rack is a relabel, not a move —
      // there is nowhere to move stock TO.
      const rackChanged = after.num !== null && (after.num !== before.num || after.row !== before.row);
      if (rackChanged) {
        const rackName = formatRackLabel({ number: after.num!, row: after.row });
        try {
          const outcome = await this.placeItemsOntoRackByName(
            [id],
            after.num,
            after.row,
            rackName,
          );
          if (outcome.failedItemIds.length > 0) placementFailed = { rackName };
        } catch (e) {
          // FAIL-SOFT, LOUD. The edit itself already succeeded and must not be
          // undone by a placement hiccup — but the caller is told, because the
          // silent version of this is the defect being fixed.
          console.error('[item update] rack auto-place failed', {
            itemId: id,
            rackName,
            error: e instanceof Error ? e.message : String(e),
          });
          placementFailed = { rackName };
        }
      }
    }

    return placementFailed ? { ...(data as object), placementFailed } : data;
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
  }): Promise<{
    ok: number;
    skipped: number;
    placed?: number;
    /**
     * Set rack only: items whose stock demonstrably did NOT reach the rack —
     * every transfer for them was refused, or the destination rack could not be
     * resolved in their warehouse. The rack LABEL and pair were still written,
     * because that is what the operator typed and this op does not revert a
     * human instruction on their behalf; so the label is now ahead of the
     * stock, and saying so is the whole point of the count.
     *
     * `placed` cannot carry this: 0 also means "everything was already there",
     * so a batch where every move was refused was indistinguishable from one
     * that needed no moves — both printed a plain "Updated N items."
     *
     * Excludes the deliberate non-moves (already on the rack, split placement,
     * no stock) — see `placeItemsOntoRackByName`.
     */
    placeFailed?: number;
    /**
     * Set rack only: BOOKS whose crate summary was cleared because their stock
     * now sits on the rack and nowhere else. Reported so the toast can say it —
     * a crate label silently surviving a physical move is what sent pickers to
     * empty crates.
     *
     * PROVED by re-reading the row and comparing fingerprints, never inferred
     * from "the sync wrote it": a rewrite to the same crate is not a clear.
     */
    crateCleared?: number;
    /** Set rack only: books whose crate label could NOT be reconciled (split
     *  holdings, a concurrent edit, a failed write, or stock that never reached
     *  the rack), plus those rewritten to the value they already held. Their
     *  label is provably the same one it was. */
    crateUnchanged?: number;
    /**
     * Set rack only: books whose crate label was rewritten to a DIFFERENT crate.
     * Only reachable when the stock never reached the rack, so the summary
     * followed it to the crate that still holds it — a change the operator did
     * not ask for, which is neither a clear nor a no-op.
     */
    crateChanged?: number;
    /**
     * Set rack only: books whose crate label was deliberately KEPT because this
     * op moved their stock onto a plain rack and nobody was asked about
     * clearing the crate — bulk Set rack has no per-book confirmation channel,
     * so it can never grant `crateClearAcknowledged`. Most crates here are
     * label-only, so the label is the only record of the crate; wiping it under
     * a "Set rack" nobody read as "and forget the crate" is the Maus I incident.
     * The label may now be stale and the toast must say so. This is where
     * `crateCleared` used to land for those books; `crateCleared` now counts
     * only a clear that was actually performed.
     */
    cratePreserved?: number;
  }> {
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
      // not-yet-placed stock onto that rack — so bulk "Set rack" moves stock
      // in ONE action (the label alone never moved anything, which is the
      // reported bug). Only when a rack is given (clearing the rack just
      // clears the label). Best-effort: a placement hiccup must not undo the
      // label set, so failures are logged and `placed` just stays 0.
      let placed = 0;
      let placeFailed = 0;
      let crateCleared = 0;
      let crateUnchanged = 0;
      let crateChanged = 0;
      let cratePreserved = 0;
      if (composedBin) {
        // The crate summary as it stands BEFORE the stock moves. Read here for
        // two reasons: it is the `verified` freshness proof syncBookCratePlacement
        // requires, and reading it after the move would compare the row against
        // itself and prove nothing.
        const before = await this.readBookCrateSummaries(allowedIds).catch(() => null);
        const placement = await this.placeItemsOntoRackByName(
          allowedIds,
          num,
          row,
          composedBin,
        ).catch((e) => {
          // The helper swallows its own per-holding failures, so reaching here
          // means the whole placement pass died. Nothing about it can be
          // claimed, so NOTHING is: every selected item is reported as not
          // placed. Erring toward a warning is the only safe direction — the
          // silent version of this is the bug being fixed.
          console.error('[bulkUpdate set_rack] bulk placement failed', e);
          return { placed: 0, failedItemIds: [...allowedIds] };
        });
        placed = placement.placed;
        placeFailed = placement.failedItemIds.length;
        // ═══ THE CRATE SUMMARY MUST FOLLOW THE STOCK — DEFECT 3(4) ═══
        // inventory_set_rack above writes the RACK keys only (migration 0068).
        // This branch then PHYSICALLY RELOCATES every selected item's stock onto
        // that rack, so a book that read "Blue 4" carried on reading "Blue 4"
        // while crate Blue 4 held zero of its units — a picker walks to an
        // empty crate. The reconciliation clears it, because a book on a rack is
        // in no crate.
        //
        // NOT GATED, and that is a decision rather than an omission. The gate
        // (assertBookCratePlacementAllowed) REFUSES and asks a client to
        // confirm; this op has no per-book confirmation channel — the toolbar
        // fires one all-or-nothing "Set rack" for up to 500 mixed items — so
        // wiring it here would newly reject a shipped flow for the 114 books
        // that carry book_crate_*, with no way for the operator to answer. The
        // trade is bounded and defensible: the physical move is the operator's
        // own explicit instruction (they typed the rack), the sync still
        // refuses to touch a split or concurrently-edited book, every write is
        // audited before→after, and the counts come back so the toast can say
        // what happened to each label.
        //
        // WHAT "NOT GATED" NOW MEANS FOR THE CRATE (Maus I, 2026-08-17): because
        // this op can never put the crate question in front of a human, it can
        // never grant `crateClearAcknowledged`, so for a book that RECORDS a
        // crate the reconciliation KEEPS that label and reports it
        // (`cratePreserved`). The old rationale — "the summary's only true value
        // afterwards is no crate" — assumed the crate was a derived label; in
        // this warehouse most crates are label-only (no locations row), so the
        // label IS the crate and wiping it under "Set rack" is data loss. The
        // rack pair the operator typed is written exactly as before.
        if (before) {
          // NO `audit.toLocationId`: this op resolves a rack PER WAREHOUSE, so
          // there is no single destination id to record, and stamping the rack
          // NAME into a field every other caller fills with a uuid would put a
          // lie in the trail. The before→after diff and the `bulk_op:'set_rack'`
          // row emitted above already say what happened.
          // `rackWrittenByCaller` — the operator TYPED this pair and
          // `inventory_set_rack` already wrote it above. Handing it to the sync
          // is what stops the holdings-derivation from reverting it when the
          // physical move failed; see the option's doc for the full defect.
          // Both writers therefore emit the identical decomposed, upper-cased
          // pair, so the row can never end up labelled "28-A" on no rack.
          const sync = await this.syncBookCratePlacement(allowedIds, {
            verified: before,
            rackWrittenByCaller: { number: num, row },
          });
          // Count only books that HAD a crate recorded — those are the ones a
          // label change is visible for. A book with no crate is written the
          // same way and changes nothing anyone can see.
          const hadCrate = (id: string) => {
            const s = before.get(id);
            return !!s && (s.crateColor !== null || s.crateNumber !== null);
          };
          // EVERY not-written bucket, including `unplacedItemIds` — a book
          // whose stock never reached the rack (its per-holding transfer
          // failed) keeps the crate it had, and the count must say so rather
          // than quietly treating "changed nothing" as "nothing to change".
          crateUnchanged = [
            ...sync.failedItemIds,
            ...sync.skippedItemIds,
            ...sync.staleItemIds,
            ...sync.unplacedItemIds,
          ].filter(hadCrate).length;

          // ═══ THE COUNTS ARE PROVED, NOT INFERRED ═══
          // `syncedItemIds` says a write RAN, never that the value moved — and
          // these counts drive sentences an operator reads. The gap is real:
          // `placeItemsOntoRackByName` is per-holding best-effort, so when a
          // book's transfer fails and its one remaining holding is a CRATE, the
          // reconciliation rewrites that crate. The book is on no rack and its
          // label was not cleared, yet it lands in `syncedItemIds` all the same
          // — and "Cleared the crate label on 1 book now on the rack" was then
          // printed for a label that still exists, on a book that never moved.
          //
          // So re-read the rows the sync wrote and compare fingerprints, the
          // same proof `removeStockFromLocation` uses for `crateSyncUpdated`.
          // One read for the whole batch, only when something was written.
          const written = sync.syncedItemIds;
          const preserved = new Set(sync.cratePreservedItemIds);
          const after =
            written.length > 0
              ? await this.readBookCrateSummaries(written).catch((e: unknown) => {
                  console.error(
                    '[bulkUpdate set_rack] crate labels written but unreadable — not counted',
                    { error: e instanceof Error ? e.message : String(e) },
                  );
                  return null;
                })
              : new Map<string, BookCrateSummary>();
          for (const id of after ? written : []) {
            const was = before.get(id);
            const now = after!.get(id);
            // A row that vanished (deleted, or no longer item_type='book')
            // between the write and this read proves nothing either way.
            if (!was || !now) continue;
            const moved =
              bookCrateFingerprint(was.crateColor, was.crateNumber) !==
              bookCrateFingerprint(now.crateColor, now.crateNumber);
            if (!moved) {
              // Rewritten to the value it already held. Two distinct reasons,
              // and the operator is owed the difference:
              //   • PRESERVED — the stock reached the plain rack and the sync
              //     would have cleared the crate, but this op has no way to ask
              //     and so the label was KEPT (Maus I). It is now probably
              //     stale, and that is a different sentence from "could not be
              //     reconciled".
              //   • otherwise — the write ran and changed nothing visible (the
              //     stock never left its crate, say); if it HAD a crate, that
              //     crate is still on the label, which is what the "left
              //     unchanged" warning is for.
              if (preserved.has(id)) cratePreserved += 1;
              else if (hadCrate(id)) crateUnchanged += 1;
            } else if (now.crateColor === null && now.crateNumber === null) {
              // Cleared: the label named a crate and now names none, which on
              // this path means the stock reached the rack.
              crateCleared += 1;
            } else {
              // Rewritten to a DIFFERENT crate. Only reachable when the stock
              // never got to the rack, so the summary followed it to whatever
              // crate still holds it. A change the operator did not ask for and
              // would otherwise never hear about — it is neither "cleared" nor
              // "unchanged", and folding it into either one is the same lie in
              // a different sentence.
              crateChanged += 1;
            }
          }
        } else {
          // No freshness proof, so nothing may be written — see
          // syncBookCratePlacement's contract. The stock still moved and the
          // rack label was still written; only the crate summary is untouched.
          console.error(
            '[bulkUpdate set_rack] crate summaries unreadable — crate labels left as they were',
          );
        }
      }
      // RLS filtered the gap (if any). Surface it in `skipped` so the
      // "Updated X · Skipped Y" toast remains truthful. `placed` reports how
      // many holdings actually physically moved, for callers that want to
      // confirm Set rack did more than relabel.
      return {
        ok,
        skipped: skipped + (allowedIds.length - ok),
        placed,
        ...(placeFailed > 0 ? { placeFailed } : {}),
        ...(crateCleared > 0 ? { crateCleared } : {}),
        ...(crateUnchanged > 0 ? { crateUnchanged } : {}),
        ...(crateChanged > 0 ? { crateChanged } : {}),
        ...(cratePreserved > 0 ? { cratePreserved } : {}),
      };
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

    // A MANUAL removal with no location draws in mode 'any' (0341): the shelf
    // first (racks/areas/crates, then Unplaced — exactly the 'placed' order),
    // and only if the shelf does not cover the delta, Staging. The default
    // 'placed' mode is the pick/ship contract (staged stock is never picked)
    // and it refused a full write-off of an item that had one unit sitting in
    // Staging after a return — L4L, 2026-08-17, four "internal error"s. Positive
    // deltas and explicit locations never reach this branch of the RPC.
    const drawMode = locationId == null && input.quantityChange < 0 ? 'any' : undefined;

    const { data, error } = await this.ctx.supabase.rpc('adjust_stock', {
      p_item_id: input.itemId,
      p_quantity_change: input.quantityChange,
      p_movement_type: input.movementType,
      p_location_id: locationId,
      p_reason: input.reason ?? null,
      p_notes: input.notes ?? null,
      ...(drawMode ? { p_mode: drawMode } : {}),
    });
    if (error) {
      // 'insufficient_placed_stock' does NOT contain the substring
      // 'insufficient_stock', so it used to fall through to internal_error and
      // reach the user as "Something went wrong". Match the specific class first.
      if (error.message.includes('insufficient_placed_stock')) {
        throw new ServiceError(
          'validation_error',
          "This item's stock by location does not cover that quantity. Its holdings (racks, crates, unplaced and staging) add up to less than the amount removed — run a cycle count or place the missing stock first.",
        );
      }
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
   *
   * ═══ IT RECONCILES THE BOOK CRATE SUMMARY TOO — AND IT MUST ═══
   *
   * This path used to be the one write that emptied a crate and never looked at
   * `book_crate_*`. Draining crate Blue 4 of every copy of a title left that
   * title reading "Blue 4" in the Books list, on printed labels, in the CSV and
   * in Export Builder, with no flag of any kind — a picker walks to an empty
   * crate. It is the same falsehood the placement paths were fixed for; it was
   * out of scope there only because a write-off shares none of their code.
   *
   * WHY RECONCILE RATHER THAN LEAVE IT ALONE: book-crate-placement.ts makes the
   * summary a DERIVED view of the holdings. A write-off changes the holdings, so
   * it changes what the summary should say. Leaving it is not "not touching the
   * operator's data" — it is publishing a location the stock has left.
   *
   * NOT GATED, for the same reason the bulk "Set rack" branch is not: the gate
   * (assertBookCratePlacementAllowed) asks "placing here will change the
   * recorded crate — confirm?", and there is no destination here to ask about.
   * The stock leaving is the operator's own explicit instruction, typed with a
   * mandatory reason. What is owed is not a prompt but an honest report, which
   * is what the return value carries.
   *
   * ONLY WHEN THE DRAW-DOWN EMPTIES THE HOLDING. A partial removal leaves the
   * same set of locations holding this item, so the correct summary is
   * unchanged by construction — reconciling then could only rewrite a label
   * from state that PREDATES this operation, which would be a surprise write
   * the operator did not cause, plus an audit row per partial pick. So the
   * common path pays nothing: no extra read, no write, no flag.
   */
  async removeStockFromLocation(input: RemoveStockFromLocationInput): Promise<{
    /** The authoritative row adjust_stock returned. Unchanged from before. */
    item: unknown;
    /**
     * What the crate reconciliation did, or null when none was attempted — a
     * non-book, a partial draw-down (see above), or a pre-read that failed.
     * Every bucket must be surfaced; see BookCrateSyncResult.
     */
    crateSync: BookCrateSyncResult | null;
    /**
     * The summary was rewritten AND its value actually changed. A rewrite to
     * the same crate is invisible to the operator, and claiming a label changed
     * when it did not is its own small lie — so this is checked, not assumed
     * from `syncedItemIds`.
     */
    crateSyncUpdated: boolean;
  }> {
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

    // The crate summary as it stands BEFORE the stock leaves. Read here, not
    // after, for the same two reasons the bulk "Set rack" branch reads it here:
    // it is the freshness proof `syncBookCratePlacement` requires, and a read
    // taken after the draw-down would compare the row against itself and prove
    // nothing. A NON-BOOK comes back as an empty map, which is the cheapest
    // possible "nothing to do".
    const drainsHolding = qty >= onHandAtLocation;
    const verified = drainsHolding
      ? await this.readBookCrateSummaries([input.itemId]).catch((e: unknown) => {
          // Same posture as the Set rack branch: no freshness proof means
          // nothing may be written. The stock still leaves; only the crate
          // summary is untouched.
          console.error('[remove-from-location] crate summary unreadable — label left as it was', {
            error: e instanceof Error ? e.message : String(e),
          });
          return null;
        })
      : null;

    // Delegate the mutation: adjustStock re-asserts stock:adjust + warehouse
    // write access, blocks archived items, and emits the movement + audit row.
    const item = await this.adjustStock({
      itemId: input.itemId,
      quantityChange: -qty,
      movementType: RACK_WRITE_OFF_MOVEMENT_TYPE,
      locationId: input.locationId,
      reason,
    });

    if (!verified || verified.size === 0) {
      return { item, crateSync: null, crateSyncUpdated: false };
    }

    // NO `audit.toLocationId`: a write-off has no destination, and stamping one
    // would put a lie in the trail. The reconciliation's own before→after rows
    // (and the 'remove' movement adjustStock just wrote) already say what
    // happened.
    const crateSync = await this.syncBookCratePlacement([input.itemId], { verified });

    // Did the label actually MOVE? Only worth asking when the summary was
    // rewritten at all — every other bucket left the row exactly as it was.
    // One tiny read, on a path that already runs several, and only for a book
    // whose holding was fully drained.
    let crateSyncUpdated = false;
    if (crateSync.syncedItemIds.includes(input.itemId)) {
      const after = await this.readBookCrateSummaries([input.itemId]).catch(() => null);
      const before = verified.get(input.itemId)!;
      const now = after?.get(input.itemId);
      crateSyncUpdated =
        !!now &&
        bookCrateFingerprint(before.crateColor, before.crateNumber) !==
          bookCrateFingerprint(now.crateColor, now.crateNumber);
    }
    return { item, crateSync, crateSyncUpdated };
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
   * TWO WRITERS, one label. A destination that states a rack position goes
   * through inventory_set_rack, which writes the pair and the label together. A
   * crate that states none goes through inventory_set_bin_location (0335),
   * which writes the label alone — because inventory_set_rack DELETES the pair
   * when both rack arguments are null, and the pair may still be true. See the
   * block comment on that branch.
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
    // ═══ A CRATE SITS ON A RACK — BOTH FACTS, OR NEITHER ═══
    //
    // This used to branch on `dest.kind === 'rack'` and pass rack_number NULL
    // for ANY crate. Because inventory_set_rack DELETES the rack keys when both
    // are null (0068), a book put away into crate 13 came out recorded in
    // "Blue 13" with NO rack — the half-empty row the owner reported, and the
    // reason the Books list showed a crate with an empty RACK column.
    //
    // A crate destination now carries its own POSITION (locations.rack_number /
    // rack_row on the crate row — the columns have been there since 0188), so
    // the pair is read off the destination WHATEVER its kind. One accessor for
    // both kinds is the point: reaching for the pair only when kind==='rack' is
    // exactly how the crate's rack came to be dropped.
    //
    // DECOMPOSE first. `dest` is copied straight off the locations row (or the
    // inline new-location input), so a legacy composite — ("22-B", null) —
    // would otherwise be stamped verbatim onto every item put away there and go
    // invisible to the "22-B" filter. That is the 2026-07-23 incident.
    const parsed = normalizeRackFields({ number: dest.rackNumber, row: dest.rackRow });
    const num = parsed.number || null;
    const row = num ? parsed.row?.toUpperCase() ?? null : null;
    const isRack = dest.kind === 'rack';

    // ═══ A CRATE WITH NO POSITION WRITES THE LABEL, AND ONLY THE LABEL ═══
    //
    // THE PAIR IS LEFT ALONE HERE — because THIS function cannot tell whether
    // clearing it would be true. All it knows is the DESTINATION, and a
    // position-less crate asserts NOTHING about a rack, so writing NULL over the
    // pair from here would ERASE data the operator never mentioned: a PARTIAL
    // put-away moves some copies into the crate while the rest stay on rack
    // 40-B, and clearing would publish "this book is on no rack" about a book
    // that demonstrably is. Production also holds the shape that must survive
    // untouched: blue "Blue Shelf", 5 books, rack NULL.
    //
    // THE FULL-MOVE CASE IS NOT LEFT STALE, it is answered one layer up.
    // `syncBookCratePlacement` runs after the stock has moved, reads the LIVE
    // holdings, and derives BOTH pairs from the single location they resolve to
    // — so a full move into a position-less crate really does clear the rack
    // pair, and a partial one really does keep it. Deciding it here, from the
    // destination alone, is what forced the choice between two unconditional
    // answers (main cleared always; 0335 preserved always) and made one of them
    // wrong every time. Do not "complete" this branch by clearing the pair.
    //
    // THE LABEL IS STILL WRITTEN, and briefly was not — this path used to
    // `return` here and write nothing at all, which is a worse bug than the one
    // it avoided. EVERY crate location in production today is position-less, so
    // that left every put-away into an existing crate with a `bin_location`
    // describing the item's PREVIOUS location: a book moved into "Gray #BIN"
    // still labelled '40-B'. bin_location is PICKER-FACING — the pick slip, the
    // warehouse packing slip, the cycle-count sheet, the inventory-snapshot
    // report, the orders catalog loader and the mobile lookup all read it — so
    // "crate placed, rack column empty" became "crate placed, label WRONG".
    // And for a NON-BOOK the label is the ONLY record of the crate anywhere:
    // inventory_set_book_storage (0334) is `item_type = 'book'` only, so a
    // Chromebook put away into "Blue Shelf" is otherwise recorded in that crate
    // NOWHERE.
    //
    // inventory_set_rack cannot say "set the label, keep the pair" — it DELETES
    // the pair when both rack arguments are null (0068), and passing each item's
    // existing pair back would need a per-item read, i.e. 200 RPCs for a
    // 200-book bulk. That objection is about PRESERVING THE PAIR; it never
    // applied to writing the LABEL, which needs no read at all. Migration 0335
    // exposes exactly that narrow writer: inventory_set_bin_location sets one
    // column and never mentions custom_fields, so the rack pair AND the crate
    // summary survive by construction rather than by careful argument passing.
    if (!isRack && !num) {
      // No name means no label. "This destination has nothing to say" is a
      // different intent from "clear the label", and the RPC honours a NULL by
      // erasing whatever the item already carries — so don't send one.
      const label = dest.name?.trim() || null;
      if (!label) return;
      const { data, error } = await this.ctx.supabase.rpc('inventory_set_bin_location', {
        p_item_ids: itemIds,
        p_bin_location: label,
      });
      // Best-effort, exactly like the rack branch below: the stock is already
      // placed. The row count is the cheap half of not failing open — RLS
      // filtering every row returns 0, not an error, and a silent 0 is
      // indistinguishable from a write that worked.
      if (error) {
        console.warn('[placement] crate label stamp failed (stock still placed):', error.message);
      } else if (data === 0) {
        console.warn('[placement] crate label stamp matched no rows (stock still placed)');
      }
      return;
    }

    // A positioned crate stamps like a rack does, and its bin_location is the
    // crate's own name, which now READS "Blue #13 on rack 38-B" — so the label
    // names the position rather than contradicting it.
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

  // ─────────────────────────────────────────────────────────────────────────
  // BOOK CRATE PLACEMENT
  //
  // Physical truth is item_stock_levels -> locations. The item-level
  // book_crate_* keys are a SUMMARY. The ONE rule that decides when a
  // placement may re-synchronize that summary — and what counts as an
  // overwrite worth confirming — lives in
  // packages/core/src/inventory/book-crate-placement.ts. Read it before
  // changing anything below; these three methods only do the DB reads and
  // writes that rule requires.
  //
  // PERMISSIONS: none of this asserts items:update or locations:manage. The
  // summary sync is part of the physical placement, which is already gated on
  // 'stock:transfer' inside transferStock(). A warehouse employee who is
  // allowed to put stock away must stay able to place books.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read the crate SUMMARY currently recorded on each of these items, straight
   * from the DB. Non-books and unknown ids are simply absent from the map.
   *
   * This is the only trustworthy source for "what does the item say today".
   * A client may send its own idea of the current crate for display, but that
   * value is a stale snapshot — the row can have changed since the page
   * rendered, or the request can be forged outright. Callers re-read through
   * here immediately before writing, which also closes the concurrent-change
   * window to a single round-trip.
   */
  async readBookCrateSummaries(itemIds: string[]): Promise<Map<string, BookCrateSummary>> {
    const out = new Map<string, BookCrateSummary>();
    if (itemIds.length === 0) return out;
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name, item_type, custom_fields')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds)
      .is('deleted_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
    for (const row of (data ?? []) as Array<{
      id: string;
      name: string | null;
      item_type: string | null;
      custom_fields: Record<string, unknown> | null;
    }>) {
      if (row.item_type !== 'book') continue;
      const storage = readBookStorage(row.custom_fields);
      out.set(row.id, {
        name: row.name ?? '',
        crateColor: storage.crateColor,
        crateNumber: storage.crateNumber,
        rackNumber: storage.rackNumber,
        rackRow: storage.rackRow,
      });
    }
    return out;
  }

  /**
   * THE CONFIRMATION GATE. Called BEFORE any stock moves.
   *
   * Order matters, and it is the whole fix:
   *
   *   1. COMPUTE the conflict set from the rows just read. Always. There is no
   *      argument that skips this step.
   *   2. DROP the conflicts the reconciliation provably will not perform (see
   *      `bookCratePlacementWillSync`) — a prompt for a change that cannot
   *      happen is a false alarm, and this org gets it on the common path.
   *   2b. ATTACH the RACK outcome to each surviving line. The same holdings
   *      read that answers "will it write" also answers "and what does it do to
   *      the rack pair", and this is the only place both are known. See the
   *      block at the call site: a full move into a position-less crate really
   *      does clear a rack a human typed, and saying nothing about it is how the
   *      owner lost 38-A while approving a crate change.
   *   2c. COMPUTE THE RACK ERASURES, from the same two inputs. A rack the
   *      derivation will WIPE is its own question with its own fingerprint — the
   *      crate fingerprint cannot carry it (every shipped client computes that
   *      one from the crate pair alone) and the crate comparison cannot raise it
   *      (the reported defect had `changed: false`, because the crate was
   *      identical and only the rack died). See book-rack-placement.ts.
   *   3. WAIVE only the conflicts the caller was actually SHOWN, matched by item
   *      id AND fingerprint — each question against its OWN fingerprint. The
   *      rack SENTENCE on a crate line stays pure disclosure, unfingerprinted,
   *      exactly as before (see `BookCrateChangeItem.rackLine`).
   *   4. REFUSE the rest with the fresh payload — one payload carrying both
   *      questions, so the operator answers once. NO STOCK MOVES on that path.
   *
   * `opts.acknowledged` used to be a bare boolean, and step 1 was skipped
   * whenever it was set — so "the user approved this change" and "do not
   * compare at all" were the same request. Combined with a client that derived
   * the flag from its render-time snapshot, the first and only request already
   * carried it: a book edited to Red 7 after the page rendered was silently
   * erased by a confirmation that named Blue 4. An acknowledgement now proves
   * the client was looking at the value that is in the row NOW.
   *
   * First assignment (the book has no crate recorded) and a placement into the
   * same crate both pass silently: nothing is being destroyed.
   *
   * `opts.moves` is what makes step 2 possible — the source holding and
   * quantity per item, so the gate can tell whether this placement leaves the
   * destination as the book's only placement. FAIL-CLOSED: an item with no
   * entry (or a holdings read that errors) is treated as "the sync will write",
   * i.e. it still asks.
   *
   * ═══ THE RACK QUESTION NEVER REFUSES A CALLER THAT CANNOT ANSWER IT ═══
   *
   * `opts.acknowledgedRacks` is the caller's answer AND, by its mere presence,
   * the caller's declaration that it understands the question — an EMPTY array
   * is a capability declaration, `undefined` is "cannot answer". Nothing else
   * could serve: the client cannot predict a rack erasure locally (only a reader
   * of the live holdings can), so a capable client's first request carries an
   * empty list and answers the refusal on the retry.
   *
   * For a caller that cannot answer, the placement is NOT refused. A refusal no
   * client can answer is not a safety feature, it is an outage — this feature's
   * first review found exactly that shape and put-away was impossible until it
   * was caught, and the mobile OTA in the field today has no rack channel at
   * all. Instead the rack pair is withheld from the write: the gate returns
   * `rackClearAcknowledged: false`, the reconciliation keeps the recorded pair,
   * and the result reports `rackPreservedItemIds` so the operator is told the
   * label may now be stale. Fail safe, not fail closed.
   *
   * RETURNS ITS VERDICT PER BOOK, and the caller MUST pass it on to
   * `syncBookCratePlacement` as `verified`. That is not a convenience: it is
   * the other half of the freshness guarantee. The summaries say "these are the
   * crates the gate cleared", and the reconciliation compares its own fresh
   * read against them, so a crate someone edited while the stock was moving is
   * left alone instead of being overwritten by an acknowledgement that was
   * about a different crate. `rackClearAcknowledged` rides along for the one
   * write the reconciliation may not perform unasked.
   */
  async assertBookCratePlacementAllowed(
    itemIds: string[],
    dest: PlaceDest,
    opts: {
      acknowledged?: ReadonlyArray<BookCrateAcknowledgedChange>;
      /**
       * The answer to the RACK question — and, by its PRESENCE alone, the
       * caller's declaration that it can be asked one. An EMPTY array declares
       * capability with nothing yet acknowledged; `undefined` means "cannot
       * answer" and is the correct reading for both an old client and a forged
       * request. See the header: a caller that cannot answer is never refused,
       * it simply does not get the erasure.
       */
      acknowledgedRacks?: ReadonlyArray<BookRackAcknowledgedChange>;
      moves?: ReadonlyMap<string, { fromLocationId: string; quantity: number }>;
      /**
       * The resolved destination `locations.id`. Required for step 2.
       *
       * NULL when the destination is about to be CREATED and has not been minted
       * yet — the "+ New rack / crate" branch consults this gate BEFORE it mints,
       * so that backing out of the confirmation leaves no orphaned empty location
       * behind. A row that does not exist can hold no stock, so the prediction is
       * exact rather than degraded. `undefined` still means "not supplied", which
       * fails closed to asking.
       */
      toLocationId?: string | null;
    } = {},
  ): Promise<Map<string, BookPlacementVerdict>> {
    const summaries = await this.readBookCrateSummaries(itemIds);
    // The verdict every book gets unless something below grants more. FALSE is
    // the safe default for the rack erasure and the only default that can be:
    // an authorisation nobody granted must never be inferred from silence.
    const verdicts = new Map<string, BookPlacementVerdict>();
    for (const [itemId, s] of summaries) {
      verdicts.set(itemId, { ...s, rackClearAcknowledged: false, crateClearAcknowledged: false });
    }
    if (summaries.size === 0) return verdicts;

    // 1. THE CONFLICT SET, from the row just read — never from the caller.
    const conflicts: BookCrateChangeItem[] = [];
    for (const [itemId, current] of summaries) {
      const conflict = describeBookCrateConflict({
        itemId,
        itemName: current.name,
        currentColor: current.crateColor,
        currentNumber: current.crateNumber,
        // LABELS ONLY, on both sides — see BookCratePlacementInput. The
        // destination's pair is its own for a rack and the crate's POSITION for
        // a crate, so the refusal reads "recorded in Blue 4 on rack 40-B …
        // will change that to Blue 13 on rack 38-B" rather than naming a crate
        // that exists on five different racks. `changed` is still decided by
        // the crate pair alone.
        currentPosition: { rackNumber: current.rackNumber, rackRow: current.rackRow },
        nextColor: dest.crateColor ?? null,
        nextNumber: dest.crateNumber ?? null,
        nextPosition: { rackNumber: dest.rackNumber, rackRow: dest.rackRow },
      });
      if (conflict) conflicts.push(conflict);
    }

    // ═══ THE RACK ERASURE IS A SEPARATE QUESTION, ASKED FOR SEPARATE BOOKS ═══
    //
    // The reported defect reached this line with `conflicts.length === 0`. A book
    // recorded in crate "Blue Shelf" placed into the position-less crate
    // ('blue','Shelf') is going into THE SAME CRATE — the comparison is right to
    // be silent — and rack 38-A was erased anyway. So the rack half is computed
    // over every book the gate read, not over the crate conflicts, and the early
    // return below covers both or it re-creates the exact bug.
    //
    // CANDIDATES ARE NARROWED FIRST, and that narrowing is what keeps the cost
    // at zero on the ordinary path: only a PLACED destination that states NO
    // rack position can erase anything (`describeBookRackClear` re-checks both,
    // it is not trusted from here), and only a book that RECORDS a rack has
    // anything to lose. A put-away onto a rack — the commonest operation in this
    // warehouse — produces no candidates and therefore no extra query.
    const destPosition = { rackNumber: dest.rackNumber, rackRow: dest.rackRow };
    const destIsPlaced = !isSystemLocation({ type: null, kind: dest.kind });
    const rackCandidateIds =
      destIsPlaced && !hasRackPosition(destPosition)
        ? [...summaries]
            .filter(([, s]) => hasRackPosition({ rackNumber: s.rackNumber, rackRow: s.rackRow }))
            .map(([id]) => id)
        : [];

    if (conflicts.length === 0 && rackCandidateIds.length === 0) return verdicts;

    // 2. Drop the ones whose summary the reconciliation will deliberately
    //    leave alone. Only reached when something genuinely conflicts, so the
    //    common placement still costs exactly one query.
    const willSync = await this.readBookCrateSyncPrediction(
      [...new Set([...conflicts.map((c) => c.itemId), ...rackCandidateIds])],
      opts,
    );
    const kept = conflicts.filter((c) => willSync.get(c.itemId) !== false);

    // ═══ 2b. THE RACK OUTCOME — SAID HERE BECAUSE ONLY HERE IS IT KNOWN ═══
    //
    // The rack pair is the other projection of the fact the reconciliation
    // establishes: which SINGLE location the book's live stock resolves to. So
    // the sentence is derived from the same two inputs `syncBookCratePlacementInner`
    // derives the pair from — the destination's own rack position, and whether
    // this move leaves the destination as the only placement — and it is
    // attached HERE because step 2 is the only point in the system that has
    // both. A client re-deriving it from a render-time snapshot is the mistake
    // that caused the original data-loss bug.
    //
    // THE DESTINATION MUST BE A PLACED LOCATION. A move into a staging/unplaced
    // bucket leaves the book with no placed holding at all, and the sync then
    // reports `unplacedItemIds` and writes NEITHER pair — so "the rack will be
    // cleared" would be a promise about a write that never happens.
    // `bookCratePlacementWillSync` answers "no rival placement survives", which
    // is true of that move and is not the same question.
    //
    // Anything short of an explicit `true` from the prediction — a missing move,
    // a failed holdings read, a genuine split — yields `'unknown'` and says
    // nothing (see `rackOutcomeBasis`). Fail-closed for asking, silent for
    // asserting.
    const real: BookCrateChangeItem[] = kept.map((c) => {
      const current = summaries.get(c.itemId);
      const rackLine = current
        ? describeRackChange(
            { rackNumber: current.rackNumber, rackRow: current.rackRow },
            destPosition,
            destIsPlaced ? rackOutcomeBasis(willSync.get(c.itemId)) : 'unknown',
          )
        : null;
      return rackLine ? { ...c, rackLine } : c;
    });

    // ═══ 2c. THE RACK ERASURES, WITH THEIR OWN FINGERPRINTS ═══
    //
    // Same two inputs as 2b and the same helper underneath (`describeRackChange`
    // via `describeBookRackClear`), so the QUESTION and the DISCLOSURE are
    // provably the same sentence and a client can dedupe them by string. The
    // difference is that this one is answerable: it carries a fingerprint of the
    // rack pair being destroyed.
    //
    // `destIsPlaced` is already true for every candidate, so the basis here is
    // the prediction alone — and an unknown prediction yields no sentence, hence
    // no question, hence no authorisation, hence a preserved rack. That chain is
    // the fail-safe: silence never becomes permission.
    const rackConflicts: BookRackChangeItem[] = [];
    for (const itemId of rackCandidateIds) {
      const current = summaries.get(itemId)!;
      const clear = describeBookRackClear({
        itemId,
        itemName: current.name,
        current: { rackNumber: current.rackNumber, rackRow: current.rackRow },
        next: destPosition,
        basis: rackOutcomeBasis(willSync.get(itemId)),
      });
      if (clear) rackConflicts.push(clear);
    }

    // 3. Waive ONLY what was shown, item by item — each question against its
    //    OWN fingerprint.
    const ackIndex = bookCrateAcknowledgementIndex(opts.acknowledged);
    const unacknowledged = real.filter((c) => !isBookCrateChangeAcknowledged(ackIndex, c));

    // ═══ GRANT THE CRATE CLEAR — FOR EXACTLY THE BOOKS SHOWN ONE ═══
    //
    // A `real` conflict whose destination names NO crate is a CLEAR: the sync
    // will derive (null, null) from that rack row and, absent this grant, will
    // now KEEP the recorded pair instead (see `cratePreservedItemIds`). The
    // grant is the operator's answer to "Crate color Red will be cleared. Crate
    // number 4 will be cleared. [Continue placement]" — the acknowledgement
    // fingerprint-matched against the crate pair the row holds NOW, exactly as
    // the waiver above. A conflict that is a CHANGE (Green 2 → Blue 4) grants
    // nothing: no clear was shown, and the write that follows is a replacement.
    //
    // Deliberately keyed off the DESTINATION's crate pair rather than the
    // conflict's `nextLabel` string: the label is presentation (it can carry the
    // rack position and a field breakdown), the pair is the fact the sync writes.
    const destClearsCrate = !isCrateDestination({
      crateColor: dest.crateColor ?? null,
      crateNumber: dest.crateNumber ?? null,
    });
    if (destClearsCrate) {
      for (const c of real) {
        if (!isBookCrateChangeAcknowledged(ackIndex, c)) continue;
        const verdict = verdicts.get(c.itemId);
        if (verdict) verdict.crateClearAcknowledged = true;
      }
    }

    // CAPABILITY IS INFERRED FROM THE REQUEST. A caller that sent the list —
    // even an empty one — understands the rack question; one that sent nothing
    // cannot be asked it and must never be refused for it (see the header).
    const canAnswerRack = opts.acknowledgedRacks !== undefined;
    const rackAckIndex = bookRackAcknowledgementIndex(opts.acknowledgedRacks);
    const unacknowledgedRacks = canAnswerRack
      ? rackConflicts.filter((c) => !isBookRackChangeAcknowledged(rackAckIndex, c))
      : [];
    // GRANT the erasure for exactly the books whose erasure was shown and
    // agreed. Everything else keeps the safe default, so an unasked, unanswered
    // or unanswerable rack survives the placement.
    if (canAnswerRack) {
      for (const c of rackConflicts) {
        if (!isBookRackChangeAcknowledged(rackAckIndex, c)) continue;
        const verdict = verdicts.get(c.itemId);
        if (verdict) verdict.rackClearAcknowledged = true;
      }
    }

    if (unacknowledged.length === 0 && unacknowledgedRacks.length === 0) return verdicts;

    // 4. Refuse — carrying EVERY real conflict, not just the unacknowledged
    //    ones, and BOTH questions in ONE payload. The client rebuilds its
    //    acknowledgement from this payload, so a partial payload would drop the
    //    lines it already answered and refuse the retry forever; and two
    //    payloads would be two stacked modals for one decision.
    //
    // `reason` STAYS THE CRATE CONSTANT whenever there is a crate line, because
    // that string is what every shipped client matches on. `rackItems` rides
    // alongside and is ignored by anything that has not heard of it. Only a
    // rack-ONLY refusal carries the rack reason — and `canAnswerRack` is what
    // makes that reachable exclusively for a caller that can answer it.
    const detail: BookPlacementChangeDetail = {
      reason:
        real.length > 0
          ? BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION
          : BOOK_RACK_CLEAR_REQUIRES_CONFIRMATION,
      items: real,
      ...(canAnswerRack && rackConflicts.length > 0 ? { rackItems: rackConflicts } : {}),
    };
    // THE MESSAGE CARRIES THE RACK SENTENCE TOO, for the single-item case. Not
    // every surface renders the structured lines — the web confirmation shows
    // this string as its lead paragraph, and a caller with no payload handling
    // at all shows only this — so a consequence that lives exclusively in
    // `details` is a consequence some operators never see. The bulk message
    // stays counts-only: N books have N current racks, and the per-item lines
    // are where those belong.
    const singleRack = real.length === 1 && real[0]!.rackLine ? ` ${real[0]!.rackLine}` : '';
    throw new ServiceError(
      'conflict',
      real.length === 1
        ? `${real[0]!.itemName} is recorded in ${real[0]!.currentLabel ?? 'no crate'}. Placing it here will change that to ${real[0]!.nextLabel ?? 'no crate'}.${singleRack}`
        : real.length > 1
          ? `${real.length} books are recorded in a different crate. Placing them here will change that.`
          : // RACK-ONLY. The crate is unchanged (that is the whole defect: the
            // reported case had an identical crate), so a message about crates
            // would name a change that is not happening.
            rackConflicts.length === 1
            ? `${rackConflicts[0]!.itemName} is recorded on rack ${rackConflicts[0]!.currentLabel}. Placing it here will clear that.`
            : `${rackConflicts.length} books are recorded on a rack. Placing them here will clear it.`,
      detail as unknown as Record<string, unknown>,
    );
  }

  /**
   * Per item: will `syncBookCratePlacement` actually rewrite the summary after
   * this placement, or will it skip because the book stays split?
   *
   * Reads the same holdings the reconciliation will read, with the SAME
   * discipline: no `.in('locations.kind', …)` filter (recurring pattern #23 —
   * that drops NULL-kind rows, and a NULL-kind Site holding is precisely the
   * "this book is also somewhere else" evidence the split rule needs), and
   * staging/unplaced classified out in JS.
   *
   * FAIL-CLOSED everywhere: no `toLocationId`, no per-item move, or a failed
   * read all answer "assume it writes", which keeps the confirmation. The one
   * thing that must never happen is waiving a prompt for a write that then
   * happens.
   *
   * RACE, accepted and bounded: a concurrent pick could drain the rival holding
   * between this read and the sync, so a waived placement could end up writing.
   * The window is one request, and what it writes is the location the stock
   * demonstrably now sits in — the summary follows physical truth, which is the
   * module's whole rule. The opposite trade (asking on every split placement
   * forever, for an org where the split is the normal case) trains operators to
   * click through the prompt that matters.
   */
  private async readBookCrateSyncPrediction(
    itemIds: string[],
    opts: {
      moves?: ReadonlyMap<string, { fromLocationId: string; quantity: number }>;
      toLocationId?: string | null;
    },
  ): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const { moves, toLocationId } = opts;
    // `undefined` = the caller supplied no destination, which fails closed to
    // "assume it writes". `null` = the destination is about to be CREATED and
    // does not exist yet (the gate now runs BEFORE the mint, so backing out
    // leaves no orphan) — a row that does not exist holds nothing, so every
    // surviving holding really is a rival placement and the prediction below is
    // exact. Compared against `undefined` explicitly: `!toLocationId` would
    // collapse the two opposite answers into one.
    if (toLocationId === undefined || !moves || moves.size === 0) return out;
    const known = itemIds.filter((id) => moves.has(id));
    if (known.length === 0) return out;

    const { data, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(id, kind, type)')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', known)
      .gt('quantity', 0);
    if (error) return out;

    const placedByItem = new Map<string, Array<{ locationId: string; quantity: number }>>();
    for (const row of (data ?? []) as unknown as Array<{
      item_id: string;
      location_id: string;
      quantity: number;
      locations: { kind: string | null; type: string | null } | null;
    }>) {
      const loc = row.locations;
      if (!loc) continue;
      if (isSystemLocation({ type: loc.type, kind: loc.kind })) continue;
      const list = placedByItem.get(row.item_id) ?? [];
      list.push({ locationId: row.location_id, quantity: row.quantity });
      placedByItem.set(row.item_id, list);
    }

    for (const itemId of known) {
      const move = moves.get(itemId)!;
      out.set(
        itemId,
        bookCratePlacementWillSync({
          placedHoldings: placedByItem.get(itemId) ?? [],
          destinationLocationId: toLocationId,
          fromLocationId: move.fromLocationId,
          quantity: move.quantity,
        }),
      );
    }
    return out;
  }

  /**
   * RECONCILIATION, run AFTER the stock physically moved.
   *
   * Applies the summary rule (book-crate-placement.ts): one bounded read of
   * every positive holding for these items, then per item —
   *   • all PLACED holdings in exactly one rack/crate → synchronize the
   *     summary to that location's columns (a rack clears the crate),
   *   • holdings SPLIT across locations → leave the summary alone, because
   *     stamping the newest crate would assert something false about the rest.
   *
   * ═══ THE SUMMARY IS BOTH PAIRS, FROM ONE LOCATION ═══
   *
   * "The summary" means all four keys: book_crate_color / book_crate_number AND
   * book_rack_number / book_rack_row. They are not independent facts, they are
   * two projections of the one fact this method establishes — WHICH SINGLE
   * LOCATION the book's live stock resolves to — so they are derived from the
   * same row, in the same branch, and written by one statement (migration 0336).
   *
   * That closes a bug that existed in both directions. main CLEARED the rack
   * pair on every put-away into a position-less crate: right for a FULL move,
   * wrong for a PARTIAL one, which erases a rack the remaining copies really
   * are on. Migration 0335 then PRESERVED it unconditionally: right for the
   * partial move, wrong for the full one — the pair names a rack the stock has
   * entirely left, and the pick slip, the warehouse packing slip and the mobile
   * scan sheet all reprint it. Deriving gives the right half of each: a full
   * move into a position-less crate CLEARS the pair, a positioned crate sets it
   * to the crate's position, a plain rack sets it to that rack, and a split
   * writes neither pair and says so.
   *
   * ═══ …EXCEPT THAT THE CLEAR NOW NEEDS PERMISSION ═══
   *
   * Of those four outcomes, three replace a value with another TRUE value the
   * operator could read off the destination they picked. The CLEAR is different:
   * it destroys a rack a human typed and leaves nothing that remembers it. So it
   * is performed only for a book whose erasure the gate says was shown and
   * agreed (`BookPlacementVerdict.rackClearAcknowledged`). Absent that, the
   * recorded pair is kept VERBATIM and the item is reported in
   * `rackPreservedItemIds` — a stale rack label is recoverable and a wiped one
   * is not.
   *
   * ═══ …AND SO DOES THE CRATE CLEAR (MAUS I, 2026-08-17) ═══
   *
   * The same rule now governs the crate half, for a stronger reason: most
   * crates in this warehouse are LABEL-ONLY (no locations row), so the item
   * summary is the only place they exist. A put-away onto a plain rack derives
   * "no crate" from a row that never said anything about crates, and writing
   * that null pair over a label-only crate erased Maus I's yellow 6 and The Joy
   * Luck Club's red 4 in prod. The clear is performed only for a book whose
   * clear the gate says was shown and agreed
   * (`BookPlacementVerdict.crateClearAcknowledged`); otherwise the recorded
   * pair is kept VERBATIM and reported in `cratePreservedItemIds`. A different
   * crate is not an erasure and is written as before.
   *
   * ═══ THE SECOND READ IS THE FRESHNESS PROOF, NOT A FORMALITY ═══
   *
   * `opts.verified` is what `assertBookCratePlacementAllowed` returned at T0,
   * before the stock moved. This method re-reads the same rows at T2 and writes
   * ONLY where the two agree. It used to re-read and then use the fresh row for
   * nothing but the item-type filter and the audit `before`, stamping the
   * destination over whatever it found — so a crate edited during the placement
   * (a colleague on the mobile item screen, another put-away in flight) was
   * destroyed with no confirmation at all. That is the exact silent overwrite
   * the gate in front of it exists to refuse, arriving through the back door.
   *
   * A row that changed is reported as STALE and left alone. Not written and not
   * failed: the acknowledgement the operator gave named a different crate, and
   * the honest response to "this is no longer the thing you agreed to" is to
   * stop, keep both facts (the stock moved; the label still says what a human
   * last put there) and say so.
   *
   * `verified` is a REQUIRED argument on purpose. An optional freshness proof
   * that defaults to "trust me" is the same shape as the blanket
   * acknowledgement boolean this module already had to delete once.
   *
   * Returns three buckets, and the caller must surface all three: the placement
   * itself is still true (the stock really moved, and rolling a real movement
   * back by hand is never the answer), but FAILED means the printed label may
   * now be stale, SKIPPED means it was intentionally left describing a
   * different location, and STALE means someone else's edit won. Skipping is
   * not an error, yet a silent skip is indistinguishable from a silent
   * success — and split holdings are the COMMON case for an org whose books
   * also sit directly on a Site (405 units on DC4 alone, per migration 0292),
   * so "worked, changed nothing, said nothing" would be the normal outcome.
   * This deliberately does NOT follow stampPlacementBin's console.warn-and-
   * forget.
   *
   * NEVER THROWS. Every caller runs it AFTER transferStock has committed, so
   * an escaping exception would surface as "placement failed" for a placement
   * that demonstrably succeeded — and the operator would retry and move the
   * stock twice. Any unexpected failure degrades to `failedItemIds`.
   *
   * `opts.audit` carries the placement facts the trail needs (which location,
   * how much). The event NAME is the existing `inventory.item.updated` that
   * every other custom_fields write already uses — the bulk "Set rack" branch
   * emits the same one with a `bulk_op` discriminator. No parallel event.
   */
  async syncBookCratePlacement(
    itemIds: string[],
    opts: {
      /**
       * The verdict `assertBookCratePlacementAllowed` returned BEFORE the stock
       * moved — the crates the operator was actually shown and cleared, plus
       * whether a rack ERASURE was among the things they agreed to. Required;
       * see the header.
       *
       * `rackClearAcknowledged` is OPTIONAL on the read side so a caller that
       * builds its own freshness proof by hand — `removeStockFromLocation` reads
       * the summaries directly, there being no destination to gate on — stays
       * valid without claiming an authorisation nobody gave. Absent reads as
       * FALSE, which keeps the recorded rack; that is the safe direction, and the
       * only one that can be a default.
       *
       * `crateClearAcknowledged` is its twin for the crate pair, optional for the
       * same reason and defaulting the same way: absent, a recorded crate is
       * KEPT rather than cleared (see `cratePreservedItemIds`).
       */
      verified: ReadonlyMap<
        string,
        BookCrateSummary & { rackClearAcknowledged?: boolean; crateClearAcknowledged?: boolean }
      >;
      audit?: {
        toLocationId: string;
        /** Units placed per item; omitted keys simply record no quantity. */
        quantityByItemId?: Map<string, number>;
      };
      /**
       * ═══ THE RACK PAIR THE CALLER ALREADY WROTE, IN THIS SAME OPERATION ═══
       *
       * Set ONLY by bulk "Set rack", which is the one caller that does not
       * discover the destination — the operator TYPED it, and
       * `inventory_set_rack` has already stamped that pair (and the matching
       * `bin_location`) onto every selected row before the stock is touched.
       * When present, the rack half of the summary is this pair instead of the
       * derived one; the crate half still derives from the holdings.
       *
       * WHY THE DERIVATION MUST NOT WIN HERE. The derivation answers "where
       * does this book's live stock resolve to", which is the right question
       * for a put-away, where the destination and the holdings are the same
       * fact seen twice. Bulk Set rack is different: it also PHYSICALLY MOVES
       * the stock, per holding, best-effort — and when that move fails
       * (`placeItemsOntoRackByName` logs and continues) the holdings still name
       * the crate the book never left. Deriving from them then wrote
       * `p_rack_number: null` straight over the pair the operator had just
       * typed: the book dropped out of the very "28-A" filter they set, the
       * toast said "Updated 1", and `bin_location` went on reading "28-A" — a
       * row saying "labelled 28-A, on no rack", which is the exact
       * self-contradiction migration 0336 exists to make unreachable.
       *
       * Two writes of one key, and the second one silently reverting the
       * first, is not a reconciliation; it is the operation undoing itself. So
       * the pair stays what the human said, BOTH writers agree byte-for-byte,
       * and the thing that actually went wrong — the stock never reached the
       * rack — is reported as `placeFailed` and said out loud, instead of being
       * expressed as a mutation nobody can see.
       *
       * Normalised here as well as by the caller (see the top of Inner): the
       * two writers must produce the SAME item-side spelling of one rack, and
       * a guarantee that lives only in the caller is not a guarantee.
       */
      rackWrittenByCaller?: { number: string | null; row: string | null };
    },
  ): Promise<BookCrateSyncResult> {
    try {
      return await this.syncBookCratePlacementInner(itemIds, opts);
    } catch (e) {
      // The stock is already placed. Report, never rethrow — see the contract
      // above. `readBookCrateSummaries` throws on a query error, and an
      // unhandled throw here would be indistinguishable from a failed
      // placement to the caller.
      console.error('[placement] book crate summary sync threw (stock still placed)', {
        error: e instanceof Error ? e.message : String(e),
        items: itemIds.length,
      });
      return {
        syncedItemIds: [],
        failedItemIds: [...itemIds],
        skippedItemIds: [],
        staleItemIds: [],
        unplacedItemIds: [],
        rackPreservedItemIds: [],
        cratePreservedItemIds: [],
      };
    }
  }

  private async syncBookCratePlacementInner(
    itemIds: string[],
    opts: {
      verified: ReadonlyMap<
        string,
        BookCrateSummary & { rackClearAcknowledged?: boolean; crateClearAcknowledged?: boolean }
      >;
      audit?: {
        toLocationId: string;
        quantityByItemId?: Map<string, number>;
      };
      rackWrittenByCaller?: { number: string | null; row: string | null };
    },
  ): Promise<BookCrateSyncResult> {
    if (itemIds.length === 0)
      return {
        syncedItemIds: [],
        failedItemIds: [],
        skippedItemIds: [],
        staleItemIds: [],
        unplacedItemIds: [],
        rackPreservedItemIds: [],
        cratePreservedItemIds: [],
      };
    // The operator's own typed rack, decomposed and upper-cased with the SAME
    // helper every other writer of these keys uses — so the pair this statement
    // writes is byte-identical to the one `inventory_set_rack` already wrote,
    // and the books rack filter never sees two spellings of one rack. A caller
    // that passes an EMPTY number is saying nothing, and falls back to the
    // derivation rather than clearing the pair by accident.
    const typedRack = (() => {
      const t = opts.rackWrittenByCaller;
      if (!t) return null;
      const n = normalizeRackFields({ number: t.number, row: t.row });
      const number = n.number || null;
      if (!number) return null;
      return { number, row: n.row?.toUpperCase() ?? null };
    })();

    // THE FRESH READ. Everything below compares against it; nothing trusts the
    // caller's snapshot.
    const summaries = await this.readBookCrateSummaries(itemIds);
    const bookIds = [...summaries.keys()];

    // A book the gate cleared that is NO LONGER a readable book — soft-deleted,
    // or its item_type flipped away from 'book' — between the two reads. This
    // used to fall straight through the `bookIds.length === 0` early return and
    // report a fully synchronized placement with neither a failure nor a skip:
    // a silent no-op dressed as success.
    const staleItemIds = itemIds.filter((id) => opts.verified.has(id) && !summaries.has(id));
    if (bookIds.length === 0)
      return {
        syncedItemIds: [],
        failedItemIds: [],
        skippedItemIds: [],
        staleItemIds,
        unplacedItemIds: [],
        rackPreservedItemIds: [],
        cratePreservedItemIds: [],
      };

    // ONE bounded read of every positive holding for these books. No kind
    // filter in the query: `.in('locations.kind', [...])` silently drops
    // NULL-kind rows (recurring pattern #23 — the bug migration 0292 fixed for
    // the placed draw-down), and a NULL-kind SITE holding is exactly the kind
    // of "this book is also somewhere else" evidence the split rule needs.
    const { data, error } = await this.ctx.supabase
      .from('item_stock_levels')
      .select(
        'item_id, location_id, quantity, locations!inner(id, kind, type, crate_color, crate_number, rack_number, rack_row)',
      )
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', bookIds)
      .gt('quantity', 0);
    if (error)
      return {
        syncedItemIds: [],
        failedItemIds: bookIds,
        skippedItemIds: [],
        staleItemIds,
        unplacedItemIds: [],
        rackPreservedItemIds: [],
        cratePreservedItemIds: [],
      };

    type HoldingRow = {
      item_id: string;
      location_id: string;
      locations: {
        id: string;
        kind: string | null;
        type: string | null;
        crate_color: string | null;
        crate_number: string | null;
        // The location's OWN rack position. A rack row carries its number/row
        // here; a CRATE row carries the position it sits on (the columns have
        // been on `locations` since 0188, for both kinds); a Site carries
        // neither. One read, both halves of the summary — see the derivation
        // below for why they cannot come from two places.
        rack_number: string | null;
        rack_row: string | null;
      };
    };
    const placedByItem = new Map<string, Map<string, HoldingRow['locations']>>();
    for (const row of (data ?? []) as unknown as HoldingRow[]) {
      const loc = row.locations;
      if (!loc) continue;
      // Staging/Unplaced are stock WAITING to be put away, not a location the
      // book "is in" — they never count toward the split decision.
      if (isSystemLocation({ type: loc.type, kind: loc.kind })) continue;
      const perItem = placedByItem.get(row.item_id) ?? new Map<string, HoldingRow['locations']>();
      perItem.set(row.location_id, loc);
      placedByItem.set(row.item_id, perItem);
    }

    // Group by the SUMMARY the sync would write, so N books landing in one
    // place cost ONE RPC call instead of N.
    const batches = new Map<
      string,
      {
        color: string | null;
        number: string | null;
        rackNumber: string | null;
        rackRow: string | null;
        ids: string[];
      }
    >();
    const skippedItemIds: string[] = [];
    const unplacedItemIds: string[] = [];
    const rackPreservedItemIds: string[] = [];
    const cratePreservedItemIds: string[] = [];
    for (const itemId of bookIds) {
      const placed = placedByItem.get(itemId);
      // ═══ NO PLACED HOLDING — LEFT ALONE, BUT NEVER SILENTLY ═══
      // Everything this book still has is in a staging/unplaced bucket, or it
      // has no positive holding at all. There is nothing authoritative to
      // synchronize to, so the summary is not written (see the bucket's doc on
      // BookCrateSyncResult for why "clear it" is the wrong repair).
      //
      // This used to be a BARE `continue` — neither a skip nor a failure. A
      // move that emptied crate Blue 4 came back `{ ok: true }` with no flag at
      // all, the item went on reading "Blue 4", and the operator was shown a
      // plain success toast. The reviewer reproduced exactly that by
      // transferring all 40 units of The Outsiders into Staging: zero
      // inventory_set_book_storage calls, zero flags, and a picker walking to
      // an empty crate. Reporting costs one array push and is the difference
      // between a warning and a lie — for every entry point, including the
      // acknowledged put-away paths that share this loop.
      if (!placed || placed.size === 0) {
        unplacedItemIds.push(itemId);
        continue;
      }
      // SPLIT: holdings authoritative, summary untouched — and REPORTED, so
      // the caller can say so instead of showing a plain success toast for a
      // sync that deliberately changed nothing.
      if (placed.size > 1) {
        skippedItemIds.push(itemId);
        continue;
      }
      const [loc] = [...placed.values()];
      // Normalised, not raw: this value is copied onto the ITEM summary, where
      // it is compared against the destination's crate on the next placement.
      // Copying a legacy "Blue" through verbatim would seed the item with a
      // spelling the write path no longer produces.
      let color = normalizeCrateColorForWrite(loc!.crate_color);
      let number = loc!.crate_number?.trim() || null;

      // ═══ THE RACK PAIR IS DERIVED FROM THE SAME HOLDING — DEFECT: TWO
      //     UNCONDITIONAL ANSWERS TO A CONDITIONAL QUESTION ═══
      //
      // The rack pair is not an independent fact about the item; it is the
      // OTHER PROJECTION of the fact this loop has already established — the
      // single location the book's live stock resolves to. So it is read off
      // `loc`, the same row the crate pair comes from, inside the same
      // single-placement branch, after the same split and unplaced tests.
      // There is deliberately no second notion of "placed" here: adding one is
      // how the two summaries came to disagree in the first place.
      //
      // TWO PREVIOUS RULES, each right about one case and wrong about the other:
      //
      //   main CLEARED the pair on every put-away into a position-less crate
      //   (inventory_set_rack deletes it when both rack arguments are null,
      //   0068). Correct for a FULL move — no stock is left on any rack —
      //   and WRONG for a PARTIAL one, which erases a true fact: the rest of
      //   the copies really are still on rack 40-B.
      //
      //   Migration 0335 then PRESERVED it unconditionally. Correct for the
      //   partial move and WRONG for the full one: the pair goes on naming a
      //   rack the stock has entirely left, and NINE surfaces reprint it —
      //   including the pick slip and the warehouse packing slip a picker
      //   physically carries, and the mobile scan sheet, which printed
      //   "Bin/shelf: Blue Shelf" directly above "Rack: 38-A".
      //
      // Deriving answers all four cases with one rule, and the answers are the
      // right halves of both previous ones:
      //   • all stock in a POSITION-LESS crate -> no stock on any rack -> the
      //     pair CLEARS (main's behaviour, for the case where it was right);
      //   • all stock in a POSITIONED crate    -> the pair becomes the crate's
      //     own position (a crate SITS ON a rack: one place, two keys);
      //   • all stock on a plain RACK          -> the pair is that rack;
      //   • all stock on a NULL-kind SITE      -> in no crate and on no rack,
      //     so both pairs clear. That holding is REAL (405 units on DC4 per
      //     migration 0292) and is never filtered out of the read above —
      //     recurring pattern #23, which has bitten this exact area.
      //   • SPLIT or UNPLACED                  -> handled above; neither pair
      //     is written and the caller is told which.
      //
      // DECOMPOSE, like every other writer of these keys. `locations.rack_number`
      // can hold a legacy COMPOSITE ("22-B" with a null row — the 2026-07-23
      // incident), and stamping that verbatim onto the item makes it invisible
      // to its own rack filter. The row is upper-cased for the same reason
      // `stampPlacementBin` upper-cases it: both writers must produce the SAME
      // item-side value for the same location, or the books rack filter sees two
      // spellings of one rack.
      const position = normalizeRackFields({ number: loc!.rack_number, row: loc!.rack_row });
      const derivedRackNumber = position.number || null;
      const derivedRackRow = derivedRackNumber ? position.row?.toUpperCase() ?? null : null;

      // ═══ A DIRECT HUMAN INSTRUCTION OUTRANKS THE DERIVATION ═══
      // The derivation is right about a put-away, where the destination and the
      // holdings are one fact seen twice. It is WRONG about bulk "Set rack",
      // where the operator typed the pair and the physical move is separately
      // fallible: a swallowed transfer failure left the holdings naming the
      // crate the book never left, and deriving from them reverted the pair the
      // operator had just set — silently, under an "Updated 1" toast, on a row
      // whose `bin_location` still read "28-A". See `rackWrittenByCaller`.
      //
      // The crate half is NOT overridden by the typed rack. Nobody typed a crate
      // here; that half is derived — and then, like the rack half, its CLEAR is
      // withheld unless the operator was shown it (see the crate guard below;
      // bulk Set rack cannot ask, so for a crated book it preserves).
      let rackNumber = typedRack ? typedRack.number : derivedRackNumber;
      let rackRow = typedRack ? typedRack.row : derivedRackRow;

      // ═══ THE FRESHNESS CHECK — DEFECT 5 ═══
      // The gate compared the row at T0 and the operator answered about THAT
      // crate. If the row says something else now, the answer we hold is not an
      // answer to this question. Only refuse when the fresh value would
      // actually be OVERWRITTEN: a concurrent edit that happens to agree with
      // the destination is not a conflict, and reporting it as stale would cry
      // wolf on a write that changes nothing.
      //
      // STILL CRATE-ONLY, now that the rack pair is written here too, and that
      // is deliberate rather than an oversight. The staleness test asks "is the
      // thing the operator was SHOWN still true", and the operator is shown a
      // crate: `describeBookCrateConflict` decides `changed` on the crate pair
      // alone and the rack is a separate, non-blocking sentence
      // (`describeRackChange`). Fingerprinting the rack pair as well would newly
      // REFUSE a placement because someone edited a key nobody was asked about.
      // The pair still cannot be written behind a stale crate: it rides in the
      // same statement, so a stale row skips both halves together.
      const fresh = summaries.get(itemId)!;
      const cleared = opts.verified.get(itemId);
      const rowMoved =
        !cleared ||
        bookCrateFingerprint(cleared.crateColor, cleared.crateNumber) !==
          bookCrateFingerprint(fresh.crateColor, fresh.crateNumber);
      if (
        rowMoved &&
        describeBookCrateConflict({
          itemId,
          itemName: fresh.name,
          currentColor: fresh.crateColor,
          currentNumber: fresh.crateNumber,
          nextColor: color,
          nextNumber: number,
        }) !== null
      ) {
        staleItemIds.push(itemId);
        continue;
      }

      // ═══ AN ERASURE NOBODY WAS SHOWN IS NOT PERFORMED ═══
      //
      // THE DEFECT: a book recorded in crate "Blue Shelf" ON RACK 38-A, placed
      // into the position-less crate ('blue','Shelf'). The crate is IDENTICAL,
      // so the crate gate is right to stay silent — and the statement below then
      // wrote `p_rack_number: null` and 38-A was gone. Nobody was asked, nothing
      // remembers what it said, the on-hand count still reads healthy, and the
      // next picker has nowhere to stand.
      //
      // Three of this derivation's four outcomes replace a value with another
      // TRUE value the operator could read off the destination they picked
      // (a rack, a positioned crate, the crate half). The CLEAR is the only one
      // that destroys a fact, so it is the only one that needs permission —
      // granted per book by the gate, which is the only place that both reads
      // the live holdings and can put the sentence in front of a human.
      //
      // WITHHELD, NOT FAILED. The stock really moved and the crate label really
      // should follow it, so the write still happens; only the rack half keeps
      // what the row already said, VERBATIM (not re-normalised — "preserved"
      // must mean the bytes that are there, or a preserve becomes its own quiet
      // edit). The item is then reported in `rackPreservedItemIds` so the
      // operator hears that the label may now be stale, which is what makes
      // "recoverable" true rather than aspirational.
      //
      // Reached by an old client with no rack channel, by a forged request that
      // omitted it, and by a placement whose rack outcome the gate could not
      // predict in time to ask. All three are answered the same way, because in
      // all three the operator was shown nothing.
      const recordedRack = formatRackPosition({
        rackNumber: fresh.rackNumber,
        rackRow: fresh.rackRow,
      });
      const erasesRecordedRack = rackNumber === null && recordedRack !== '';
      const mayErase = opts.verified.get(itemId)?.rackClearAcknowledged === true;
      if (erasesRecordedRack && !mayErase) {
        rackNumber = fresh.rackNumber ?? null;
        rackRow = fresh.rackRow ?? null;
        rackPreservedItemIds.push(itemId);
      }

      // ═══ AND NEITHER IS A CRATE ERASURE — MAUS I, 2026-08-17 17:50:52 ═══
      //
      // THE DEFECT: Maus I recorded {yellow 6, rack 38-B}. Ten units put away
      // from Staging onto the plain rack "38-B" — its ONLY holding afterwards.
      // `loc` was that rack row, which has no crate columns, so `color`/`number`
      // derived (null, null) and the statement below wrote them: the prod audit
      // row reads before {yellow,6,38,B} → after {NULL,NULL,38,B}. The owner
      // re-typed it 36 seconds later. Then The Joy Luck Club, red 4, the same
      // way. The rack guard just above could not help: the rack half derived
      // 38/B correctly. The crate half simply had no such guard — the comment
      // that used to sit on `rackNumber` said "the crate half stays derived on
      // every path", and that sentence was the bug.
      //
      // WHY "DERIVED FROM THE HOLDING" IS NOT ENOUGH HERE. For a crate that has
      // a locations row, the holding IS the crate and the derivation is exact.
      // But most crates in this warehouse have NO row — 113 of L4L's 124 books
      // carry a crate label and the org has exactly one crate row — so the item
      // summary is the only place the crate exists. A rack holding says "the
      // stock is on 38-B"; it does not say "and in no crate". Reading "no crate"
      // off it and writing that over the label destroys the only record.
      //
      // THE RULE, the rack rule's exact twin: the CLEAR of a recorded crate is
      // performed only for a book whose clear the gate says was SHOWN and agreed
      // (`crateClearAcknowledged` — the operator chose a rack-only destination
      // and pressed Continue on "crate Red 4 will be cleared"). Absent that, the
      // recorded pair is kept VERBATIM and reported in `cratePreservedItemIds`.
      // A DIFFERENT crate is not an erasure and is written as before: that is a
      // true value the gate already asked about. A book that records no crate
      // has nothing to preserve and is written as before.
      //
      // Reached by bulk Set rack and the write-off drain (neither can ask), by
      // an old client, by a forged body, and by the race where the gate predicted
      // a split and the stock resolved to one plain rack anyway. All answered
      // the same way, because in all of them nobody was shown a clear.
      const erasesRecordedCrate =
        color === null && number === null && (fresh.crateColor !== null || fresh.crateNumber !== null);
      const mayEraseCrate = opts.verified.get(itemId)?.crateClearAcknowledged === true;
      if (erasesRecordedCrate && !mayEraseCrate) {
        color = fresh.crateColor;
        number = fresh.crateNumber;
        cratePreservedItemIds.push(itemId);
      }

      // JSON, not a space-joined string. `crate_number` is FREE TEXT and
      // production already stores values containing a space ("Blue Shelf"), so
      // ('Blue', 'Shelf 2') and ('Blue Shelf', '2') collide on a joined key —
      // and the first pair to claim it would be stamped onto the other's books.
      // That is precisely the silent wrong-label this module exists to prevent.
      //
      // ALL FOUR VALUES ARE IN THE KEY. They are written by one statement, so
      // two books may only share a batch when their WHOLE summary agrees — two
      // books in crate Gray BIN on different racks are two different summaries,
      // and keying on the crate alone would stamp the first book's rack onto the
      // second. The rack pair is decomposed, so neither half can contain the
      // JSON delimiters either.
      const key = JSON.stringify([color, number, rackNumber, rackRow]);
      const batch = batches.get(key) ?? { color, number, rackNumber, rackRow, ids: [] };
      batch.ids.push(itemId);
      batches.set(key, batch);
    }

    const failedItemIds: string[] = [];
    const syncedItemIds: string[] = [];
    for (const batch of batches.values()) {
      // ONE STATEMENT FOR ONE FACT (migration 0336). Both pairs are projections
      // of the single location above, so they are written together: two calls
      // admit a half-updated row — crate written, rack write lost to RLS or a
      // dropped connection — that says "recorded in Blue 13, on no rack". That
      // self-contradicting row is the exact shape this whole line of work has
      // been fixing, so it is made unreachable rather than merely unlikely.
      //
      // This REPLACES the call to inventory_set_book_storage (0334), which can
      // only write the crate half. 0334 is left in the database, untouched and
      // still correct; it simply has no caller now. 0335 is NOT superseded —
      // `bin_location` is a separate fact, written by `stampPlacementBin` on a
      // put-away, and this statement cannot reach it.
      const { data: updated, error: rpcError } = await this.ctx.supabase.rpc(
        'inventory_set_book_placement',
        {
          p_item_ids: batch.ids,
          p_crate_color: batch.color,
          p_crate_number: batch.number,
          p_rack_number: batch.rackNumber,
          p_rack_row: batch.rackRow,
        },
      );
      // FAIL-CLOSED ON THE REPORT, not on the stock (recurring pattern #2: a
      // write whose affected-row count is never checked fails open). The RPC
      // returns its real row count, so 0 rows means the summary did NOT change
      // — RLS filtered them, or they were archived underneath us — and the
      // caller must be told rather than shown a green toast.
      if (rpcError || typeof updated !== 'number' || updated < batch.ids.length) {
        if (rpcError) {
          console.error('[placement] book crate summary sync failed (stock still placed)', {
            error: rpcError.message,
            items: batch.ids.length,
          });
        }
        failedItemIds.push(...batch.ids);
        continue;
      }
      syncedItemIds.push(...batch.ids);
      // Trail: one row per item, before→after, on the SAME event the other
      // custom_fields writers use. `summaries` was read before the RPC, so
      // `before` is genuinely the previous crate rather than an echo.
      for (const id of batch.ids) {
        const previous = summaries.get(id);
        void audit(
          {
            event: 'inventory.item.updated',
            entityType: 'inventory_item',
            entityId: id,
            // ALL FOUR KEYS, because all four were written. An audit row that
            // shows the crate moving and stays silent about a rack pair the same
            // statement CLEARED is how a reviewer reconstructs the wrong history
            // — and clearing the pair is precisely the outcome that needs to be
            // findable later. `previous` was read before the RPC, so `before` is
            // genuinely the old summary rather than an echo of the new one.
            before: {
              book_crate_color: previous?.crateColor ?? null,
              book_crate_number: previous?.crateNumber ?? null,
              book_rack_number: previous?.rackNumber ?? null,
              book_rack_row: previous?.rackRow ?? null,
            },
            after: {
              book_crate_color: batch.color,
              book_crate_number: batch.number,
              book_rack_number: batch.rackNumber,
              book_rack_row: batch.rackRow,
            },
            extra: {
              placement: 'book_crate',
              changed_keys: [
                'book_crate_color',
                'book_crate_number',
                'book_rack_number',
                'book_rack_row',
              ],
              ...(opts.audit
                ? {
                    to_location_id: opts.audit.toLocationId,
                    quantity: opts.audit.quantityByItemId?.get(id) ?? null,
                  }
                : {}),
            },
          },
          this.ctx,
        );
      }
    }
    // The preserve is reported only for books whose write actually LANDED, so
    // `rackPreservedItemIds ⊆ syncedItemIds` holds. A batch the RPC refused
    // wrote neither half, and "we kept your rack" alongside "the label could not
    // be written" is two answers to one question — the failure is the louder and
    // more actionable of the two, and it already wins every precedence chain.
    const synced = new Set(syncedItemIds);
    return {
      syncedItemIds,
      failedItemIds,
      skippedItemIds,
      staleItemIds,
      unplacedItemIds,
      rackPreservedItemIds: rackPreservedItemIds.filter((id) => synced.has(id)),
      cratePreservedItemIds: cratePreservedItemIds.filter((id) => synced.has(id)),
    };
  }

  /**
   * Bulk "Set rack" placement: moves each item's stock onto the rack named
   * `name` in that item's own warehouse. Used so bulk Set rack physically
   * places stock instead of only writing a label. Per-holding best-effort —
   * one failed transfer (e.g. a permission floor) is logged and skipped so
   * the rest still place.
   *
   * Two cases, both driven off ONE holdings query:
   *  - NOT already a rack/crate/area/shelf/bin placement (staging, unplaced,
   *    OR a plain SITE holding — `locations.kind` NULL, per
   *    `isRackShelfLocation`/groups.ts) — the item's NOT-YET-PLACED stock.
   *    Always moved (this was the original fix — Set rack used to only
   *    write the label). Owner report 2026-08-03: three DC4 items with
   *    2/2/3 units sitting directly on the DC4 SITE (a NULL-kind location,
   *    not the dedicated 'unplaced' bucket) stayed put after "Set rack
   *    28-A" — the query used to filter `.in('locations.kind', ['staging',
   *    'unplaced', 'rack', 'crate'])`, which silently drops NULL-kind rows
   *    (`kind IN (...)` is never true for a NULL column — the same class of
   *    bug fixed for the placed draw-down query by migration 0292). Fixed by
   *    dropping the DB-side kind filter (fetch every holding, `.gt('quantity',
   *    0)` only) and bucketing in JS with the shared classifier instead, so a
   *    NULL/site holding is never silently excluded again.
   *  - rack/crate/area/shelf/bin (Unit B) — stock ALREADY placed on a fine-
   *    grained placement (`isRackShelfLocation`). Moved ONLY when the item
   *    has exactly one such holding (its whole in-stock quantity sits on a
   *    single placement, so retargeting it is unambiguous). An item with >1
   *    such holding (a split placement) is left completely alone here — the
   *    bulk op carries no fromLocationId, so guessing which placement (or
   *    how much) to move would be wrong. The label write in the caller
   *    still applies; the client warns the user to use Transfer for those.
   *    NEVER move a split item's stock.
   *
   * Returns the number of holdings actually moved (0 if nothing needed
   * placing, or every move failed/no-opped) so the caller can report it —
   * AND `failedItemIds`, the items whose stock demonstrably did NOT reach the
   * rack.
   *
   * THE FAILURE LIST IS NOT OPTIONAL BOOKKEEPING. Every transfer here is
   * per-holding best-effort: a permission floor, a stock guard or a DB hiccup
   * is logged to the server console and skipped so the other 499 items still
   * place. That is the right behaviour for the batch and a silent one for the
   * operator — `placed` alone cannot distinguish "nothing needed placing" from
   * "every move was refused", so a whole batch could fail to move a single unit
   * and still report `{ ok: 500, placed: 0 }` under a green toast. The caller
   * surfaces this as `placeFailed`.
   *
   * NOT counted as a failure, because neither is a thing that went wrong:
   *  - a holding ALREADY on the destination rack (`toLoc === location_id`) —
   *    the stock is where the operator asked for it;
   *  - an item with a SPLIT fine-grained placement, which this method refuses
   *    to move by design and the toolbar already warns about BEFORE the run
   *    (bulk-actions' "use Transfer for those" dialog copy);
   *  - an item with no positive holding at all — there is nothing to place.
   */
  private async placeItemsOntoRackByName(
    itemIds: string[],
    num: string | null,
    row: string | null,
    name: string,
  ): Promise<{ placed: number; failedItemIds: string[] }> {
    if (itemIds.length === 0 || !num) return { placed: 0, failedItemIds: [] };

    const { data: items } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    const rows = (items ?? []) as Array<{ id: string; warehouse_id: string | null }>;
    const whByItem = new Map(rows.map((i) => [i.id, i.warehouse_id]));

    // ONE query covers both cases above — the `locations` embed carries
    // `kind`/`type` (to bucket "not yet placed" vs "already on a fine-grained
    // placement" via isRackShelfLocation) and `warehouse_id` (so an already-
    // placed holding resolves its destination against the warehouse it's
    // PHYSICALLY in, not necessarily the item's declared warehouse_id).
    // Deliberately NO `.in('locations.kind', …)` filter here — see the
    // method doc: that pattern silently drops NULL-kind (site) rows.
    const { data: holdings } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(kind, type, warehouse_id)')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .gt('quantity', 0);
    const allHoldings = (holdings ?? []) as unknown as Array<{
      item_id: string;
      location_id: string;
      quantity: number;
      locations: { kind: string | null; type: string | null; warehouse_id: string | null } | null;
    }>;

    const isAlreadyPlaced = (h: (typeof allHoldings)[number]) =>
      h.locations != null && isRackShelfLocation(h.locations);

    const levels = allHoldings.filter((h) => !isAlreadyPlaced(h));

    // Group already-placed holdings by item so a split placement (>1
    // distinct holding with qty>0) can be told apart from a single one.
    const rackHoldingsByItem = new Map<string, typeof allHoldings>();
    for (const h of allHoldings) {
      if (!isAlreadyPlaced(h)) continue;
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

    if (levels.length === 0 && singleRackMoves.length === 0)
      return { placed: 0, failedItemIds: [] };

    // Resolve (find or create) the destination rack ONCE per warehouse —
    // shared by both the not-yet-placed auto-place and the single-holding
    // move below.
    const warehouseIds = new Set<string>();
    for (const wh of rows.map((r) => r.warehouse_id)) if (wh) warehouseIds.add(wh);
    for (const mv of singleRackMoves) if (mv.warehouseId) warehouseIds.add(mv.warehouseId);
    const rackByWh = new Map<string, string>();
    for (const wh of warehouseIds) {
      const rackId = await this.findOrCreateRackLocation(wh, num, row, name);
      if (rackId) rackByWh.set(wh, rackId);
    }

    let placedCount = 0;
    // A SET, not a count: one item can own several not-yet-placed holdings, and
    // "this item's stock did not all reach the rack" is true once, no matter how
    // many of its transfers were refused.
    const failedItemIds = new Set<string>();

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
          // No destination: the item has no warehouse, or findOrCreateRackLocation
          // could not resolve or mint the rack in it (it logged why). Either way
          // this holding is not going anywhere, and that is a failure to place —
          // it used to share a `return` with the already-on-the-rack case below,
          // which is the opposite outcome.
          if (!toLoc) {
            failedItemIds.add(h.item_id);
            return;
          }
          if (toLoc === h.location_id) return;
          try {
            await this.transferStock({
              itemId: h.item_id,
              fromLocationId: h.location_id,
              toLocationId: toLoc,
              quantity: Number(h.quantity),
              notes: `Placed on rack ${name} (bulk Set rack)`,
            });
            placedCount += 1;
          } catch (e) {
            failedItemIds.add(h.item_id);
            console.error('[set_rack place] transfer failed', {
              item: h.item_id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }),
      );
    }

    // Single-placement fine-grained holdings (Unit B): the item's whole
    // in-stock quantity already sits on exactly one such placement, so
    // retarget it — PHYSICALLY MOVE via transfer_stock (never a raw
    // stock-level write), same as the not-yet-placed path above.
    // Idempotent: already on the resolved target → no-op.
    for (let i = 0; i < singleRackMoves.length; i += CONCURRENCY) {
      await Promise.all(
        singleRackMoves.slice(i, i + CONCURRENCY).map(async (mv) => {
          const toLoc = mv.warehouseId ? rackByWh.get(mv.warehouseId) : undefined;
          if (!toLoc) {
            failedItemIds.add(mv.item_id);
            return;
          }
          if (toLoc === mv.location_id) return;
          try {
            await this.transferStock({
              itemId: mv.item_id,
              fromLocationId: mv.location_id,
              toLocationId: toLoc,
              quantity: mv.quantity,
              notes: `Moved to rack ${name} (bulk Set rack)`,
            });
            placedCount += 1;
          } catch (e) {
            failedItemIds.add(mv.item_id);
            console.error('[set_rack move] transfer failed', {
              item: mv.item_id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }),
      );
    }

    return { placed: placedCount, failedItemIds: [...failedItemIds] };
  }

  /** Find an existing rack/crate location named `name` in the warehouse, or
   *  create a rack (rack_number/row set) if absent. Returns its id, or null on
   *  a create failure so placement degrades — racks are exempt from the
   *  plan's site-count limit (isSiteLocation, see locations.planLimit.test.ts
   *  and the 2026-07-07 fix), so the realistic failures here are a missing
   *  `locations:manage` grant, a malformed label, or a DB hiccup, and NONE of
   *  them may ever fail the caller (bulk "Set rack" or manual item create).
   *  Delegates to LocationsService.findOrCreateRackOrCrate — the SAME
   *  case-insensitive dedup used by the interactive Transfer/Put-away
   *  "new rack" actions and by InventoryService.create()'s manual auto-place,
   *  so every rack-creating surface agrees with each other and with the
   *  unique index added by migration 0270.
   *
   *  RACE: findOrCreateRackOrCrate resolves-then-creates, not atomically, so
   *  two concurrent callers minting the identical (warehouse, name, kind) can
   *  both miss the resolve step and both attempt the insert — the loser
   *  23505s against migration 0270's `locations_unique_active_name` unique
   *  index. That is not a real failure (both callers wanted the same rack),
   *  so this retries the WHOLE resolve-or-create exactly once; by then the
   *  winner's row is committed and visible, so the retry's resolve step
   *  finds it instead of attempting a second insert (same idiom as
   *  ProductGroupsService.findOrCreate re-reading on a 23505). Any OTHER
   *  error, on either attempt, gives up and returns null rather than
   *  looping. */
  private async findOrCreateRackLocation(
    warehouseId: string,
    num: string,
    row: string | null,
    name: string,
  ): Promise<string | null> {
    const attempt = async () => {
      const loc = await new LocationsService(this.ctx).findOrCreateRackOrCrate({
        name,
        type: 'shelf',
        kind: 'rack',
        warehouseId,
        rackNumber: num,
        rackRow: row,
      });
      return (loc as { id: string }).id;
    };
    try {
      return await attempt();
    } catch (e) {
      // `internal_error` scrubs the raw Postgres text off `.message` (S13 —
      // see ServiceError's constructor) so the constraint name has to be
      // read off `.internalDetail` instead, not `.message`.
      const isDedupRace =
        e instanceof ServiceError &&
        e.code === 'internal_error' &&
        (e.internalDetail ?? '').includes('locations_unique_active_name');
      if (isDedupRace) {
        try {
          return await attempt();
        } catch (e2) {
          console.error('[rack place] rack create retry failed', {
            warehouseId,
            name,
            error: e2 instanceof Error ? e2.message : String(e2),
          });
          return null;
        }
      }
      console.error('[rack place] rack create failed', {
        warehouseId,
        name,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Manual item creation's auto-place (owner request 2026-08-04) — called
   * AFTER the item rows and their 'initial' stock_movements ledger entries
   * all already committed successfully. `tg_seed_initial_level` has, by this
   * point, already seeded each item's item_stock_levels holding (at
   * `primary_location_id` if the caller set a real one, else the
   * warehouse's Unplaced bucket) — this method finds those holdings and
   * PHYSICALLY MOVES them onto the typed rack via transferStock, mirroring
   * exactly what `placeItemsOntoRackByName` (the bulk "Set rack" auto-place)
   * does for existing items: resolve-or-create through the SAME
   * `findOrCreateRackLocation`, then transfer, never a raw level write.
   *
   * TAKES A LIST (2026-08-10). It was single-item, which is why the SIZE-RUN
   * create path (`bulkCreateSizedVariants`) shipped with no placement at all
   * — a 13-size shoe run typed onto rack 28-A left every variant "Unplaced /
   * awaiting put-away". Generalising the ONE helper both create paths share
   * was the alternative to giving the size run its own second placement
   * implementation. The single-item caller passes a one-element array and is
   * otherwise unchanged; `.in('item_id', [id])` is the same query `.eq` was.
   *
   * Never touches `primary_location_id` or any other item column — the
   * item's declared primary location is a separate concern from where its
   * physical stock currently sits (the same separation the rest of the app
   * already relies on since migration 0192 moved stock accounting off
   * primary_location_id and onto item_stock_levels).
   *
   * Callers MUST treat this as fail-soft (see the .catch() at each call
   * site): every failure here — the rack not resolving, the holdings read
   * coming back empty, a transfer throwing — simply leaves the affected
   * item's stock wherever the trigger originally put it.
   *
   * PER-ITEM ISOLATION: a transfer that throws is caught and logged HERE,
   * against the item it belongs to, so one variant of a size run failing can
   * never stop the other twelve from being placed (the same per-unit
   * best-effort `placeItemsOntoRackByName` applies per holding). The call
   * sites keep their own catch-all for what is NOT per-item: the rack
   * resolve and the holdings read.
   */
  private async placeManualCreateOnRack(
    itemIds: string[],
    warehouseId: string,
    rawLabel: string,
  ): Promise<ManualPlacementOutcome> {
    if (itemIds.length === 0) return { rackName: rawLabel, failedItemIds: [] };
    const parts = parseRackLabel(rawLabel);
    const rackName = formatRackLabel(parts) || rawLabel;
    const rackId = await this.findOrCreateRackLocation(
      warehouseId,
      parts.number,
      parts.row,
      rackName,
    );
    // The rack could not be resolved OR created, so nothing can have reached
    // it. EVERY requested item is reported as not placed rather than none:
    // the item exists, its label says this rack, and its stock is somewhere
    // else — which is precisely the state the caller has to be able to tell
    // the operator about.
    if (!rackId) return { rackName, failedItemIds: [...itemIds] };

    // ONE holdings read for the whole batch, not one per item: a 60-size run
    // (the schema's ceiling) would otherwise pay 60 round trips to read what a
    // single `.in` answers.
    const { data: holdings } = await this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .gt('quantity', 0);
    const rows = (holdings ?? []) as Array<{
      item_id: string;
      location_id: string;
      quantity: number;
    }>;
    // Group by OWNING item — `item_id` is now part of the projection above
    // precisely because one read serves many items and a holding has to be
    // attributable to exactly one of them. Anything not in the requested set is
    // dropped rather than trusted: that turns a future edit to the projection
    // (or a filter that somehow returned a foreign row) into "nothing placed"
    // instead of a transfer issued against an undefined/foreign item id.
    const requested = new Set(itemIds);
    const byItem = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!requested.has(row.item_id)) continue;
      const arr = byItem.get(row.item_id) ?? [];
      arr.push(row);
      byItem.set(row.item_id, arr);
    }

    // Transfers run CONCURRENTLY across items in capped waves — 60 sequential
    // RPC round trips is the "took forever" the bulk Set rack path already
    // measured and fixed (see the CONCURRENCY note in
    // placeItemsOntoRackByName, same cap for the same reason). Safe to
    // parallelise ACROSS items and never within one: transfer_stock takes a
    // `for update` row lock on inventory_items keyed by item, so two items
    // never contend, while two holdings of the SAME item both draw down that
    // one row and stay ordered.
    // EVERY caller filters to items it believes hold stock, so an item the
    // holdings read did not return is NOT "nothing to do" — it is stock that
    // is not where the caller thinks it is (or a read that failed and
    // returned no rows at all, which lands every item here). Reported as not
    // placed. Silence is the bug being fixed, and over-warning is the safe
    // direction: a warning about stock that turned out fine costs a glance,
    // while a missed one costs a label pointing at a rack the books never
    // reached.
    const failedItemIds: string[] = itemIds.filter((id) => !byItem.has(id));

    // Transfers run CONCURRENTLY across items in capped waves — 60 sequential
    // RPC round trips is the "took forever" the bulk Set rack path already
    // measured and fixed (see the CONCURRENCY note in
    // placeItemsOntoRackByName, same cap for the same reason). Safe to
    // parallelise ACROSS items and never within one: transfer_stock takes a
    // `for update` row lock on inventory_items keyed by item, so two items
    // never contend, while two holdings of the SAME item both draw down that
    // one row and stay ordered.
    const groups = [...byItem.entries()];
    for (let i = 0; i < groups.length; i += RACK_PLACE_CONCURRENCY) {
      await Promise.all(
        groups.slice(i, i + RACK_PLACE_CONCURRENCY).map(async ([itemId, itemHoldings]) => {
          try {
            for (const row of itemHoldings) {
              // Already on the resolved rack (e.g. the caller's own
              // primaryLocationId happened to BE this rack) — nothing to move.
              if (row.location_id === rackId) continue;
              await this.transferStock({
                itemId,
                fromLocationId: row.location_id,
                toLocationId: rackId,
                quantity: Number(row.quantity),
                notes: `Placed on rack ${rackName} at creation`,
              });
            }
          } catch (e) {
            console.error('[rack place] create-time transfer failed', {
              item: itemId,
              rack: rackName,
              error: e instanceof Error ? e.message : String(e),
            });
            // The loop above is per-HOLDING, so a throw part-way leaves this
            // item's stock split across the old location and the rack. It is
            // reported as failed either way: "some of it moved" is still not
            // the placement the operator asked for, and the honest report is
            // the one that sends them to look.
            failedItemIds.push(itemId);
          }
        }),
      );
    }
    return { rackName, failedItemIds };
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
    /**
     * Searchable identifiers for the staging table's client-side search: the
     * item's barcode (a book's ISBN lives here; legacy isbn/isbn13/isbn10
     * custom-field keys are the fallback, same as the export) and its model
     * number. Two columns on the SAME inventory_items embed — no extra query.
     */
    barcode: string | null;
    modelNumber: string | null;
    /**
     * A BOOK's current rack/crate SUMMARY (custom_fields book_* keys), so the
     * put-away dialog can show "currently in Blue 4" without a second fetch.
     * `null` for every non-book row.
     *
     * Derived from the SAME inventory_items embed the query already ran —
     * `custom_fields` was simply added to its projection, so there is no extra
     * query and no N+1. The raw `custom_fields` blob is deliberately NOT
     * returned: it carries the org's own custom-field values and has no
     * business crossing to a staging client.
     *
     * Reminder: this is a SUMMARY. The authoritative crate is the destination
     * `locations` row — see packages/core/src/inventory/book-crate-placement.ts.
     */
    bookStorage: BookStorageInfo | null;
  }>> {
    // 1. Not-yet-placed levels (qty>0) joined to item + the staging/unplaced location.
    let q = this.ctx.supabase
      .from('item_stock_levels')
      .select('item_id, location_id, quantity, locations!inner(id, kind, warehouse_id), inventory_items!inner(id, name, sku, item_type, deleted_at, custom_fields, barcode, model_number)')
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
        barcode: readStagingBarcode(r.inventory_items),
        modelNumber: (r.inventory_items.model_number as string | null) ?? null,
        quantity: Number(r.quantity),
        sourceReceiptId: src?.receiptId ?? null,
        sourcePoNumber: meta?.poNumber ?? null,
        receiptNumber: meta?.receiptNumber ?? null,
        receivedAt,
        ageDays: deriveAgeDays(receivedAt, nowMs),
        // Books only: the neutral rack_* keys belong to non-books and mean
        // something different (0068), so reading them here would mislabel.
        bookStorage:
          r.inventory_items.item_type === 'book'
            ? readBookStorage(
                r.inventory_items.custom_fields as Record<string, unknown> | null,
              )
            : null,
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

    // 5b. Some reasons stringify a RECORD'S UUID into the words a human reads:
    //     pre-0306 pick/cancel rows ('Order pick (order_request b3c7390a-…)',
    //     written before order_requests.order_number arrived in 0254) and the
    //     return rows the shipped RMA RPCs write to this day ('Return restock
    //     (return …)', 0153/0154/0197). The ledger is append-only so both are
    //     resolved at read time, not rewritten. Chunked and org-scoped for
    //     exactly the reasons the two lookups above are, and degrading to an
    //     empty map on error — historyNote then falls back to the bare "Order
    //     pick" / "Return restock" it has always rendered. Resolving BOTH here
    //     is what keeps this dialog and the Movements page saying the same
    //     words about the same event.
    const refLabelById = new Map<string, string>();
    const legacyRefIds = collectLegacyRefIdsByKind(
      raw.map((r) => ({ reason: (r.reason as string | null) ?? null })),
    );
    for (const idChunk of chunkIdsForInFilter(legacyRefIds.order_request)) {
      const { data: orders, error: oErr } = await this.ctx.supabase
        .from('order_requests')
        .select('id, order_number')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', idChunk);
      if (oErr) console.error('item history: order number lookup failed', { error: oErr.message });
      for (const [id, label] of orderNumberLabels(
        (orders ?? []) as Array<{ id: string; order_number: number | null }>,
      )) {
        refLabelById.set(id, label);
      }
    }
    for (const idChunk of chunkIdsForInFilter(legacyRefIds.return)) {
      const { data: returns, error: rErr } = await this.ctx.supabase
        .from('returns')
        .select('id, return_number')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', idChunk);
      if (rErr) console.error('item history: return number lookup failed', { error: rErr.message });
      for (const [id, label] of returnNumberLabels(
        (returns ?? []) as Array<{ id: string; return_number: string | null }>,
      )) {
        refLabelById.set(id, label);
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
        note: historyNote(
          (r.reason as string | null) ?? null,
          (r.notes as string | null) ?? null,
          refLabelById,
        ),
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
