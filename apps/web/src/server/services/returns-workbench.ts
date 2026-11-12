import 'server-only';

import {
  availableReturnActions,
  can,
  DELETED_USER_LABEL,
  exchangeStatusStaffLabel,
  formatRackHoldings,
  parseExchangeStatus,
  inboundStateLabel,
  isDeletedPerson,
  isDeletedRequester,
  originalRowLabel,
  parseRestockOptions,
  resolveRequesterIdentity,
  returnLineLabel,
  returnListFilter,
  RETURN_LIST_PAGE_SIZE,
  variantLabel,
  type ExchangeStatus,
  type InboundLeg,
  type RestockOptionsLine,
  type ReturnActions,
  type ReturnListFilterId,
} from '@stockpilot/core';

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { chunkInFilterValues, IN_FILTER_DEFAULT_CONCURRENCY, mapWithConcurrency } from '@/lib/supabase/in-filter';

import { ServiceError, type ServiceContext } from './context';
import { ItemImagesService } from './item-images';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';
import { buildReturnChainEvents, loadOriginalPicks, type ReturnChainEvent } from './return-history';
import {
  buildExchangeView,
  EXCHANGE_LINES_EMBED,
  exchangeItemIds,
  readDeliverySites,
  readExchangeTier2,
  readReplacementEverHeld,
  readFreeStock,
  readReplacementDetail,
  type RawExchangeLine,
  type ReturnWorkbenchExchange,
} from './returns-exchange-workbench';

/**
 * The RMA workbench and the returns list (returns RX-1, plan section 4 and
 * 3.10). Reads only; the gates are applied by RMAService before these run.
 *
 * WORKBENCH: one call. Tier 1 reads the RMA with its order number and its
 * lines; tier 2 (in parallel) reads the destination options
 * (return_restock_options: provenance and validity now), the decision log
 * (RLS: returns:read or returns:manage), the lines' items, the RMA's own
 * movements (the inbound legs), the viewer's warehouse access and the
 * warehouse name; tier 3 signs the item photos in one batch and names the
 * people. The viewer booleans the core actions table needs are computed
 * HERE, from the effective permissions, the module and write access to the
 * order's warehouse; the screens never decide them from a role.
 *
 * LIST: at most four round trips per page whatever its size: the
 * `return_overview` page (keyset at 25 rows), the items of the page's lines
 * in chunks of 100, one image call for the thumbnails (two per row, then
 * "+N"), and one read of the page's requesters' profiles (B117; skipped when
 * every row carries a typed name).
 */

// ── Shapes ─────────────────────────────────────────────────────────────────

export interface ReturnWorkbenchItem {
  name: string | null;
  sku: string | null;
  /** "Size M" from the item's own variant columns (core variantLabel). */
  variant: string | null;
  deleted: boolean;
  imageUrl: string | null;
  thumbUrl: string | null;
}

export interface ReturnWorkbenchLine {
  id: string;
  orderRequestLineId: string;
  itemId: string;
  quantity: number;
  disposition: 'restock' | 'scrap';
  applied: boolean;
  item: ReturnWorkbenchItem;
  /** The destination answer for an unapplied line (null once applied). */
  restock: RestockOptionsLine | null;
  /** A closed line's legs (its item's return movements). */
  legs: InboundLeg[];
  inboundState: string;
}

export interface ReturnWorkbenchDecision {
  seq: number;
  kind: string;
  channel: string;
  revision: number | null;
  returnLineId: string | null;
  /** RX-2: the exchange line, the items and the replacement order a decision names. */
  exchangeLineId: string | null;
  itemId: string | null;
  previousItemId: string | null;
  quantity: number | null;
  orderRequestId: string | null;
  disposition: string | null;
  restockTarget: string | null;
  locationId: string | null;
  locationName: string | null;
  basis: string | null;
  reason: string | null;
  actorName: string | null;
  actorKind: string;
  createdAt: string;
}

export interface ReturnWorkbenchHeader {
  id: string;
  returnNumber: string | null;
  status: string;
  source: 'internal' | 'requester';
  reasonCode: string | null;
  notes: string | null;
  denialReason: string | null;
  orderRequestId: string;
  orderNumber: number | null;
  warehouseId: string | null;
  warehouseName: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  createdAt: string;
  approvedAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  deniedAt: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  receivedByName: string | null;
  closedByName: string | null;
  deniedByName: string | null;
}

export interface ReturnWorkbench {
  organizationId: string;
  return: ReturnWorkbenchHeader;
  /** The RMA's current revision (approve and cancel send it back). */
  revision: number;
  /** The highest plan seq (process sends it back: return_plan_changed). */
  planSeq: number;
  /** Created with "The item is here": the workbench offers Approve and receive. */
  createdOnCounter: boolean;
  /**
   * True when an unapplied line has no destination answer (the read failed):
   * the screens then send no approval, process or destination change, and say
   * "Couldn't load where the returned item goes. Reload." (never a silent
   * Staging for every line).
   */
  destinationsUnavailable: boolean;
  lines: ReturnWorkbenchLine[];
  decisions: ReturnWorkbenchDecision[];
  /** The timeline from the original pick to the close (return-history buildReturnChainEvents). */
  chain: ReturnChainEvent[];
  viewer: { canManageReturns: boolean; canApproveOrders: boolean; canReadDecisions: boolean };
  actions: ReturnActions;
  /** RX-2: the REPLACEMENT column, the outbound rail and the exchange facts. */
  exchange: ReturnWorkbenchExchange;
}

export interface ReturnListQuery {
  filter?: ReturnListFilterId;
  q?: string | null;
  cursor?: string | null;
}

export interface ReturnListRowItem {
  itemId: string;
  name: string | null;
  variant: string | null;
  quantity: number;
  thumbUrl: string | null;
}

export interface ReturnListRow {
  id: string;
  returnNumber: string | null;
  status: string;
  source: string;
  reasonCode: string | null;
  orderRequestId: string;
  orderNumber: number | null;
  requesterName: string | null;
  requesterEmail: string | null;
  createdAt: string;
  approvedAt: string | null;
  waitingDays: number | null;
  lineCount: number;
  unitCount: number;
  /** The first two returning items; `moreItems` counts the rest. */
  items: ReturnListRowItem[];
  moreItems: number;
  /** RX-2: a return, or an exchange (the view's kind column). */
  type: 'return' | 'exchange';
  /** RX-2: the view's exchange status and its staff words ('none' for a return). */
  exchangeStatus: ExchangeStatus;
  exchangeStatusLabel: string | null;
  /** The live (else newest) replacement's SO number. */
  replacementOrderNumber: number | null;
}

export interface ReturnListPage {
  organizationId: string;
  filter: ReturnListFilterId;
  q: string;
  rows: ReturnListRow[];
  nextCursor: string | null;
  pageSize: number;
  /**
   * How far a search looked for PEOPLE (B117). 'full': every member of this
   * organisation whose profile name or email matches, and whose profile the
   * viewer may read, was matched against the orders they placed for
   * themselves (also the answer when nothing is searched). 'too_many': more
   * than RETURN_SEARCH_MAX_MEMBERS matched, so only the typed columns were
   * searched. 'unavailable': the people read failed, the same fallback. The
   * list says so in both cases.
   */
  requesterSearch: ReturnRequesterSearch;
}

export type ReturnRequesterSearch = 'full' | 'too_many' | 'unavailable';

// ── Helpers ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function numberOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A search term safe inside a PostgREST logic tree: letters, digits and a
 *  few separators only, at most 80 characters. */
export function sanitizeReturnSearch(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[^\p{L}\p{N}\s@._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** "SO-000103", "so103" or "103" -> 103 (an order number search). */
export function orderNumberFromSearch(q: string): number | null {
  const m = /^(?:so-?)?0*(\d{1,9})$/i.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** The keyset cursor: the sort value and the id of the page's last row. */
export function encodeReturnCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: sortValue, i: id }), 'utf8').toString('base64url');
}

export function decodeReturnCursor(raw: string | null | undefined): { k: string; i: string } | null {
  if (!raw || raw.length > 200) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { k?: unknown; i?: unknown };
    if (typeof v.k !== 'string' || typeof v.i !== 'string') return null;
    if (!ISO_RE.test(v.k) || !UUID_RE.test(v.i)) return null;
    return { k: v.k, i: v.i };
  } catch {
    return null;
  }
}

type ItemRow = {
  id: string;
  name: string | null;
  sku: string | null;
  deleted_at: string | null;
  variant_size: string | null;
  variant_width: string | null;
  variant_color: string | null;
  jersey_number: string | null;
};

async function readItems(ctx: ServiceContext, itemIds: string[], tag: string): Promise<Map<string, ItemRow>> {
  const out = new Map<string, ItemRow>();
  if (itemIds.length === 0) return out;
  try {
    const rows = await fetchAllRowsByIds<ItemRow>(itemIds, (batch) => (from, to) =>
      ctx.supabase
        .from('inventory_items')
        .select('id, name, sku, deleted_at, variant_size, variant_width, variant_color, jersey_number')
        .eq('organization_id', ctx.organizationId)
        .in('id', batch)
        .order('id')
        .range(from, to),
    );
    for (const r of rows) out.set(r.id, r);
  } catch (err) {
    // Names are labels: a failed read shows the lines unnamed, reported.
    reportDegradedRead(tag, err, { items: itemIds.length });
  }
  return out;
}

function variantOf(r: ItemRow | undefined): string | null {
  if (!r) return null;
  return variantLabel({
    size: r.variant_size,
    width: r.variant_width,
    color: r.variant_color,
    jerseyNumber: r.jersey_number,
  });
}

async function readImages(
  ctx: ServiceContext,
  itemIds: string[],
  tag: string,
): Promise<Map<string, { url: string; thumbUrl: string | null }>> {
  if (itemIds.length === 0) return new Map();
  try {
    return await new ItemImagesService(ctx).primaryImagesWithThumbsForItems(itemIds);
  } catch (err) {
    reportDegradedRead(tag, err, { items: itemIds.length });
    return new Map();
  }
}

async function readNames(ctx: ServiceContext, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return out;
  try {
    const rows = await fetchAllRowsByIds<{ id: string; full_name: string | null; email: string | null }>(
      ids,
      (batch) => (from, to) =>
        ctx.supabase.from('user_profiles').select('id, full_name, email').in('id', batch).order('id').range(from, to),
    );
    for (const r of rows) {
      const name = r.full_name?.trim() || r.email;
      if (name) out.set(r.id, name);
    }
  } catch (err) {
    reportDegradedRead('returns.workbench.names', err, { users: ids.length });
  }
  return out;
}

/**
 * The requester the header and the list show (0393, security slice A3): the
 * name, else the email, that the RMA or its order recorded (a kept copy keeps
 * showing); else "Deleted user" when the member who asked deleted their
 * account (requested_by null and stamped in deleted_users: the rule of A3's
 * returnRequesterLabel, core isDeletedPerson); else nothing. The screens show
 * `requesterName ?? requesterEmail`, so the label rides in requesterName.
 */
export function requesterNameOf(
  name: string | null,
  email: string | null,
  requestedBy: string | null | undefined,
  marks: unknown,
): string | null {
  if (name !== null || email !== null) return name;
  return isDeletedPerson(requestedBy, marks, 'requested_by') ? DELETED_USER_LABEL : null;
}

/**
 * Whether a row needs its order requester's profile to be named (B117): no
 * typed name, and the order was placed by a member for themselves.
 */
function requesterProfileId(name: string | null, requesterUserId: string | null | undefined): string | null {
  return resolveRequesterIdentity(name, null) === null && typeof requesterUserId === 'string' ? requesterUserId : null;
}

/**
 * The requester the list and the return page name (B117): the person the
 * ORDER was for, never the person who opened the return.
 *
 *  1. the name typed on the RMA or its order (a public link, or an order
 *     placed for someone);
 *  2. else the profile name (else profile email) of the member who placed the
 *     order for themselves. Such an order holds the person only in
 *     `requester_user_id` (0391; core orders/requester-identity), which the
 *     returns screens never followed, so they said "Staff" or "Requester"
 *     where the orders screens named the person. `names` is read through the
 *     viewer's own row access (readNames), so a profile the viewer may not
 *     read stays unnamed;
 *  3. else nothing when an email was typed (the screens show the email);
 *  4. else "Deleted user" when the order's requester deleted their account:
 *     the order was read, and holds no requester and no email (core
 *     isDeletedRequester, the rule the orders screens use);
 *  5. else the older rule (requesterNameOf: the opener's deletion stamp), else
 *     null: the screens then say how the return was opened.
 */
export function requesterLabelOf(input: {
  name: string | null;
  email: string | null;
  /** The order's requester_user_id (undefined when the read did not carry it). */
  requesterUserId: string | null | undefined;
  /** False when the order's row did not come back (the viewer may not read it). */
  orderRead: boolean;
  names: Map<string, string>;
  requestedBy: string | null | undefined;
  marks: unknown;
}): string | null {
  const typed = resolveRequesterIdentity(input.name, null);
  if (typed !== null) return input.name;
  const profileId = requesterProfileId(input.name, input.requesterUserId);
  const fromProfile = profileId ? (input.names.get(profileId) ?? null) : null;
  if (fromProfile !== null) return fromProfile;
  if (profileId) return null;
  if (
    input.orderRead &&
    isDeletedRequester({ requesterUserId: input.requesterUserId, requesterEmail: input.email })
  ) {
    return DELETED_USER_LABEL;
  }
  return requesterNameOf(input.name, input.email, input.requestedBy, input.marks);
}

/**
 * A stamp column's person ("Already closed by ..."): the member's name; for a
 * null column stamped by 0393, "Deleted user"; otherwise null (the sentence's
 * own words).
 */
function personNameOf(
  id: string | null,
  names: Map<string, string>,
  marks: unknown,
  column: string,
): string | null {
  if (id) return names.get(id) ?? null;
  return isDeletedPerson(id, marks, column) ? DELETED_USER_LABEL : null;
}

/** The viewer's write access to a warehouse (advisory; the functions decide). */
async function canWriteWarehouse(ctx: ServiceContext, warehouseId: string | null): Promise<boolean> {
  if (!warehouseId || ctx.role === 'viewer') return false;
  try {
    const access = await getWarehouseAccess(ctx);
    return access.hasAllAccess || access.writableIds.includes(warehouseId);
  } catch {
    return false;
  }
}

// ── Workbench ──────────────────────────────────────────────────────────────

type HeaderOrder = {
  order_number: number | null;
  warehouse_id: string | null;
  requester_name: string | null;
  requester_email: string | null;
  /** The member the order was for; null for a typed requester or a deleted account. */
  requester_user_id?: string | null;
  completed_at: string | null;
  /** The hand-over the history shows (return-history handOverOf). */
  signed_at: string | null;
};

type HeaderRow = {
  id: string;
  return_number: string | null;
  status: string;
  source: 'internal' | 'requester';
  reason_code: string | null;
  notes: string | null;
  denial_reason: string | null;
  order_request_id: string;
  requester_name: string | null;
  requester_email: string | null;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  received_by: string | null;
  received_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  denied_by: string | null;
  denied_at: string | null;
  /** 0393: {requested_by|approved_by|received_by|closed_by|denied_by: when}. */
  deleted_users?: unknown;
  created_at: string;
  order_request?: HeaderOrder | HeaderOrder[] | null;
  lines?: Array<{
    id: string;
    order_request_line_id: string;
    item_id: string;
    quantity: number | string;
    disposition: 'restock' | 'scrap';
    applied: boolean | null;
    created_at: string;
  }> | null;
  exchange_lines?: RawExchangeLine[] | null;
};

type DecisionRow = {
  seq: number | string;
  kind: string;
  channel: string;
  revision: number | null;
  return_line_id: string | null;
  exchange_line_id?: string | null;
  item_id?: string | null;
  previous_item_id?: string | null;
  quantity?: number | string | null;
  order_request_id?: string | null;
  disposition: string | null;
  restock_target: string | null;
  location_id: string | null;
  basis: string | null;
  reason: string | null;
  actor_user_id: string | null;
  actor_kind: string;
  created_at: string;
};

type MovementRow = {
  item_id: string;
  movement_type: string;
  quantity_change: number | string;
  to_location_id: string | null;
  created_at: string;
};

const HEAD_KINDS = new Set(['approved', 'replacement_changed', 'replacement_cancelled', 'cancelled']);

export async function buildReturnWorkbench(ctx: ServiceContext, id: string): Promise<ReturnWorkbench> {
  if (!UUID_RE.test(id)) throw new ServiceError('not_found', "This return isn't available.");

  // Tier 1: the RMA, its order (hinted embed) and its lines.
  const { data: headerData, error: headerError } = await ctx.supabase
    .from('returns')
    .select(
      `id, return_number, status, source, reason_code, notes, denial_reason, order_request_id,
       requester_name, requester_email, requested_by, approved_by, approved_at, received_by, received_at,
       closed_by, closed_at, denied_by, denied_at, deleted_users, created_at,
       order_request:order_requests!order_request_id (order_number, warehouse_id, requester_name, requester_email, requester_user_id, completed_at, signed_at),
       lines:return_lines (id, order_request_line_id, item_id, quantity, disposition, applied, created_at),
       ${EXCHANGE_LINES_EMBED}`,
    )
    .eq('organization_id', ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (headerError) throw new ServiceError('internal_error', headerError.message);
  if (!headerData) throw new ServiceError('not_found', "This return isn't available.");
  const h = headerData as HeaderRow;
  const order = one(h.order_request);
  const rawLines = [...(h.lines ?? [])].sort((a, b) =>
    a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at),
  );
  const itemIds = [...new Set(rawLines.map((l) => l.item_id))];
  const warehouseId = order?.warehouse_id ?? null;
  // RX-2: the exchange lines came with the RMA; their items join the reads.
  const rawExchange = h.exchange_lines ?? [];
  const exchangeIds = exchangeItemIds(rawExchange);
  const allItemIds = [...new Set([...itemIds, ...exchangeIds])];

  // Tier 2, in parallel.
  const [optionsRes, decisionsRes, items, movementsRes, warehouseRes, writeOk, exchangeTier2, freeStock, deliverySites] = await Promise.all([
    ctx.supabase.rpc('return_restock_options', { p_return_id: id }),
    ctx.supabase
      .from('return_decisions')
      .select(
        'seq, kind, channel, revision, return_line_id, exchange_line_id, item_id, previous_item_id, quantity, order_request_id, disposition, restock_target, location_id, basis, reason, actor_user_id, actor_kind, created_at',
      )
      .eq('organization_id', ctx.organizationId)
      .eq('return_id', id)
      .order('seq', { ascending: true }),
    readItems(ctx, allItemIds, 'returns.workbench.items'),
    ctx.supabase
      .from('stock_movements')
      .select('item_id, movement_type, quantity_change, to_location_id, created_at')
      .eq('organization_id', ctx.organizationId)
      .eq('reference_type', 'return')
      .eq('reference_id', id)
      // in-list-bound: the two movement types a return writes
      .in('movement_type', ['return', 'loss'])
      // Ledger rows only: a member may insert a movement naming the RMA
      // directly (via_ledger false); it is no leg of the return (review fix).
      .eq('via_ledger', true)
      .order('created_at', { ascending: true }),
    warehouseId
      ? ctx.supabase.from('warehouses').select('id, name').eq('id', warehouseId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    canWriteWarehouse(ctx, warehouseId),
    readExchangeTier2(ctx, id, rawExchange.length > 0),
    readFreeStock(ctx, exchangeIds),
    // Desk check F6: where a replacement may go when its site is refused (an exchange only).
    rawExchange.length > 0 ? readDeliverySites(ctx, warehouseId) : Promise.resolve([]),
  ]);

  let options: ReturnType<typeof parseRestockOptions> | null = null;
  if (optionsRes.error) {
    // The destination read is staff-only and gated on warehouse read; a
    // refusal or a failure leaves the destinations out (the actions that need
    // them are refused by the database anyway).
    reportDegradedRead('returns.workbench.restock_options', optionsRes.error, { returnId: id });
  } else {
    options = parseRestockOptions(optionsRes.data);
  }
  const optionByLine = new Map((options?.lines ?? []).map((l) => [l.returnLineId, l]));

  if (decisionsRes.error) reportDegradedRead('returns.workbench.decisions', decisionsRes.error, { returnId: id });
  const decisionRows = ((decisionsRes.data as DecisionRow[] | null) ?? []).map((d) => ({ ...d, seq: numberOf(d.seq) }));

  if (movementsRes.error) reportDegradedRead('returns.workbench.movements', movementsRes.error, { returnId: id });
  const movements = (movementsRes.data as MovementRow[] | null) ?? [];

  // Tier 3: photos (one signing batch), people and location names.
  const locationIds = [
    ...new Set(
      [
        ...movements.map((m) => m.to_location_id),
        ...decisionRows.map((d) => d.location_id),
      ].filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)),
    ),
  ];
  const sourceNames = new Map<string, string>();
  for (const l of options?.lines ?? []) for (const s of l.sources) if (s.name) sourceNames.set(s.locationId, s.name);
  const missingLocations = locationIds.filter((lid) => !sourceNames.has(lid));
  const itemNames = new Map<string, string | null>(itemIds.map((iid) => [iid, items.get(iid)?.name ?? null]));
  const liveReplacement =
    exchangeTier2.replacements.find((r) => r.status !== 'cancelled' && r.status !== 'denied') ?? null;
  // The exchange items' labels ("New Hire Shirt, L") for the chain and the picks.
  const exchangeLabels = new Map<string, string>(
    exchangeIds.map((iid) => [iid, returnLineLabel(items.get(iid)?.name ?? null, variantOf(items.get(iid)))]),
  );
  // Fix round 1 (verification L2): a decision may name an item a line already
  // reads (the returned item, approved "Same as returned"): label it too.
  for (const d of decisionRows) {
    for (const iid of [d.item_id, d.previous_item_id]) {
      if (typeof iid === 'string' && items.has(iid) && !exchangeLabels.has(iid)) {
        exchangeLabels.set(iid, returnLineLabel(items.get(iid)?.name ?? null, variantOf(items.get(iid))));
      }
    }
  }
  // Review fix P8: every item an exchange decision names (a replacement chosen
  // at approval and changed since, the item it replaced) is named in the
  // history, never "an item": ONE batched read of those no line names now.
  const decisionItemIds = [
    ...new Set(
      decisionRows
        .flatMap((d) => [d.item_id, d.previous_item_id])
        .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v) && !items.has(v)),
    ),
  ];
  const liveItemIds = liveReplacement
    ? [
        ...new Set(
          rawExchange
            .filter((l) => l.replacement_order_request_id === liveReplacement.id && l.approved_item_id)
            .map((l) => l.approved_item_id as string),
        ),
      ]
    : [];
  // Item 2 (RX-2 verification L12): an exchange cancelled with its RMA shows
  // the cancelled replacement; whether it had held stock decides the rail's
  // stop (one read, beside the others, only for a cancelled exchange).
  const cancelledShown =
    !liveReplacement && exchangeTier2.overview?.exchange_status === 'cancelled' ? (exchangeTier2.replacements[0] ?? null) : null;
  const [images, names, locationRows, picks, replacementDetail, replacementPicks, decisionItems, shownReplacementEverHeld] = await Promise.all([
    readImages(ctx, allItemIds, 'returns.workbench.images'),
    readNames(ctx, [
      // B117: the member the order was for, when no name was typed.
      requesterProfileId(h.requester_name ?? order?.requester_name ?? null, order?.requester_user_id),
      h.requested_by,
      h.approved_by,
      h.received_by,
      h.closed_by,
      h.denied_by,
      ...decisionRows.map((d) => d.actor_user_id),
    ].filter((v): v is string => typeof v === 'string')),
    missingLocations.length > 0
      ? fetchAllRowsByIds<{ id: string; name: string }>(missingLocations, (batch) => (from, to) =>
          ctx.supabase
            .from('locations')
            .select('id, name')
            .eq('organization_id', ctx.organizationId)
            .in('id', batch)
            .order('id')
            .range(from, to),
        ).catch((err) => {
          reportDegradedRead('returns.workbench.locations', err, { locations: missingLocations.length });
          return [] as Array<{ id: string; name: string }>;
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    loadOriginalPicks(ctx, h.order_request_id, itemIds, itemNames),
    liveReplacement
      ? readReplacementDetail(ctx, { id: liveReplacement.id, warehouse_id: liveReplacement.warehouse_id }).catch((err) => {
          reportDegradedRead('returns.workbench.replacement_detail', err, { returnId: id });
          return null;
        })
      : Promise.resolve(null),
    liveReplacement && liveItemIds.length > 0
      ? loadOriginalPicks(
          ctx,
          liveReplacement.id,
          liveItemIds,
          new Map(liveItemIds.map((iid) => [iid, exchangeLabels.get(iid) ?? null])),
        )
      : Promise.resolve([]),
    readItems(ctx, decisionItemIds, 'returns.workbench.decision_items'),
    cancelledShown ? readReplacementEverHeld(ctx, cancelledShown.id) : Promise.resolve(null),
  ]);
  for (const [iid, row] of decisionItems) exchangeLabels.set(iid, returnLineLabel(row.name, variantOf(row)));
  const locationName = new Map<string, string>(sourceNames);
  for (const r of locationRows) locationName.set(r.id, r.name);

  const lines: ReturnWorkbenchLine[] = rawLines.map((l) => {
    const it = items.get(l.item_id);
    const img = images.get(l.item_id);
    const applied = l.applied === true;
    const legs: InboundLeg[] = applied
      ? movements
          .filter((m) => m.movement_type === 'return' && m.item_id === l.item_id && numberOf(m.quantity_change) > 0)
          .map((m) => ({
            locationName: m.to_location_id ? (locationName.get(m.to_location_id) ?? null) : null,
            quantity: numberOf(m.quantity_change),
            rack: m.to_location_id !== null,
          }))
      : [];
    return {
      id: l.id,
      orderRequestLineId: l.order_request_line_id,
      itemId: l.item_id,
      quantity: numberOf(l.quantity),
      disposition: l.disposition === 'scrap' ? 'scrap' : 'restock',
      applied,
      item: {
        name: it?.name ?? null,
        sku: it?.sku ?? null,
        variant: variantOf(it),
        deleted: Boolean(it?.deleted_at),
        imageUrl: img?.url ?? null,
        thumbUrl: img?.thumbUrl ?? null,
      },
      restock: applied ? null : (optionByLine.get(l.id) ?? null),
      legs,
      inboundState: inboundStateLabel({
        returnStatus: h.status,
        applied,
        disposition: l.disposition === 'scrap' ? 'scrap' : 'restock',
        legs,
      }),
    };
  });

  const revision = decisionRows.reduce((m, d) => (HEAD_KINDS.has(d.kind) && d.revision ? Math.max(m, d.revision) : m), 0);
  const planSeq = options?.planSeq ?? decisionRows.reduce((m, d) => (d.kind === 'disposition_planned' ? Math.max(m, d.seq) : m), 0);
  const createdOnCounter = decisionRows.some((d) => d.kind === 'created' && d.channel === 'counter');
  const destinationsUnavailable = lines.some((l) => !l.applied && l.restock === null);

  const canManageReturns =
    ctx.enabledModules.has('returns') && can(ctx, 'returns:manage') && writeOk;
  const viewer = {
    canManageReturns,
    canApproveOrders: can(ctx, 'orders:approve'),
    canReadDecisions: can(ctx, 'returns:read') || can(ctx, 'returns:manage'),
  };

  const named: ReturnWorkbenchDecision[] = decisionRows.map((d) => ({
    seq: d.seq,
    kind: d.kind,
    channel: d.channel,
    revision: d.revision,
    returnLineId: d.return_line_id,
    exchangeLineId: d.exchange_line_id ?? null,
    itemId: d.item_id ?? null,
    previousItemId: d.previous_item_id ?? null,
    quantity: d.quantity === null || d.quantity === undefined ? null : numberOf(d.quantity),
    orderRequestId: d.order_request_id ?? null,
    disposition: d.disposition,
    restockTarget: d.restock_target,
    locationId: d.location_id,
    locationName: d.location_id ? (locationName.get(d.location_id) ?? null) : null,
    basis: d.basis,
    reason: d.reason,
    actorName: d.actor_user_id ? (names.get(d.actor_user_id) ?? null) : null,
    actorKind: d.actor_kind,
    createdAt: d.created_at,
  }));
  // The chain names each destination's line and, for the original rack, its
  // rack(s): from the destination read while the line is open, else from the
  // line's own legs once it closed (returns RX-3 PR stage, polish (b): the
  // destination read has no sources for a processed line, so the counter
  // RMA's history named no rack). The legs are the original rack only when
  // the line's LAST plan was the original rack; an earlier plan another one
  // replaced keeps the bare words, never the later destination's rack.
  const lineLabels = new Map(lines.map((l) => [l.id, returnLineLabel(l.item.name, l.item.variant)]));
  const lastPlanTarget = new Map<string, { seq: number; target: string | null }>();
  for (const d of decisionRows) {
    if (d.kind !== 'disposition_planned' || !d.return_line_id) continue;
    const prev = lastPlanTarget.get(d.return_line_id);
    if (!prev || d.seq > prev.seq) lastPlanTarget.set(d.return_line_id, { seq: d.seq, target: d.restock_target });
  }
  const originalRacks = new Map<string, string>();
  for (const l of lines) {
    if (l.restock && (l.restock.case === 'single_source' || l.restock.case === 'full_remainder') && l.restock.sources.length > 0) {
      originalRacks.set(l.id, originalRowLabel(l.restock).replace(/^Return to original racks?: /, ''));
    } else if (l.applied && lastPlanTarget.get(l.id)?.target === 'original') {
      const racks = l.legs.filter((g) => g.rack && g.quantity > 0 && g.locationName);
      if (racks.length === 1) originalRacks.set(l.id, racks[0]!.locationName!);
      else if (racks.length > 1) {
        const legs = formatRackHoldings(racks.map((g) => ({ name: g.locationName!, quantity: g.quantity })));
        if (legs) originalRacks.set(l.id, legs);
      }
    }
  }
  const chain = buildReturnChainEvents({
    orderNumber: order?.order_number ?? null,
    signedAt: order?.signed_at ?? null,
    completedAt: order?.completed_at ?? null,
    picks,
    itemNames,
    lineLabels,
    originalRacks,
    exchangeNames: {
      items: exchangeLabels,
      orders: new Map(exchangeTier2.replacements.map((r) => [r.id, r.order_number])),
    },
    replacementPicks,
    replacement: liveReplacement
      ? { orderNumber: liveReplacement.order_number, signedAt: liveReplacement.signed_at, completedAt: liveReplacement.completed_at }
      : null,
    decisions: named,
    movements: movements.map((m) => ({
      itemId: m.item_id,
      movementType: m.movement_type,
      quantity: numberOf(m.quantity_change),
      toLocationName: m.to_location_id ? (locationName.get(m.to_location_id) ?? null) : null,
      rack: m.to_location_id !== null,
      createdAt: m.created_at,
    })),
  });

  // RX-2: the REPLACEMENT column and the rail.
  const exchangeItem = (itemId: string | null) => {
    if (!itemId) return null;
    const it = items.get(itemId);
    const img = images.get(itemId);
    return {
      name: it?.name ?? null,
      sku: it?.sku ?? null,
      variant: variantOf(it),
      deleted: Boolean(it?.deleted_at),
      imageUrl: img?.url ?? null,
      thumbUrl: img?.thumbUrl ?? null,
    };
  };
  const exchange = buildExchangeView({
    returnStatus: h.status,
    rawLines: rawExchange,
    overview: exchangeTier2.overview,
    replacements: exchangeTier2.replacements,
    detail: replacementDetail,
    itemOf: exchangeItem,
    freeOf: (itemId) => (itemId && freeStock.has(itemId) ? (freeStock.get(itemId) as number) : null),
    decisions: named.map((d) => ({
      kind: d.kind,
      reason: d.reason,
      actorName: d.actorName,
      createdAt: d.createdAt,
      orderRequestId: d.orderRequestId,
    })),
    deliverySites,
    shownReplacementEverHeld,
  });

  const warehouse = (warehouseRes as { data: { name?: string } | null }).data;
  return {
    organizationId: ctx.organizationId,
    return: {
      id: h.id,
      returnNumber: h.return_number,
      status: h.status,
      source: h.source,
      reasonCode: h.reason_code,
      notes: h.notes,
      denialReason: h.denial_reason,
      orderRequestId: h.order_request_id,
      orderNumber: order?.order_number ?? null,
      warehouseId,
      warehouseName: warehouse?.name ?? null,
      requesterName: requesterLabelOf({
        name: h.requester_name ?? order?.requester_name ?? null,
        email: h.requester_email ?? order?.requester_email ?? null,
        requesterUserId: order?.requester_user_id,
        orderRead: order !== null,
        names,
        requestedBy: h.requested_by,
        marks: h.deleted_users,
      }),
      requesterEmail: h.requester_email ?? order?.requester_email ?? null,
      createdAt: h.created_at,
      approvedAt: h.approved_at,
      receivedAt: h.received_at,
      closedAt: h.closed_at,
      deniedAt: h.denied_at,
      requestedByName: personNameOf(h.requested_by, names, h.deleted_users, 'requested_by'),
      approvedByName: personNameOf(h.approved_by, names, h.deleted_users, 'approved_by'),
      receivedByName: personNameOf(h.received_by, names, h.deleted_users, 'received_by'),
      closedByName: personNameOf(h.closed_by, names, h.deleted_users, 'closed_by'),
      deniedByName: personNameOf(h.denied_by, names, h.deleted_users, 'denied_by'),
    },
    revision,
    planSeq,
    createdOnCounter,
    destinationsUnavailable,
    lines,
    decisions: named,
    chain,
    viewer,
    actions: availableReturnActions({
      status: h.status,
      exchangeStatus: exchange.status,
      hasExchange: exchange.kind === 'exchange',
      replacementClass: exchange.replacement?.class ?? 'none',
      hasApprovedExchange: exchange.hasApprovedExchange,
      viewerCanManageReturns: canManageReturns,
      viewerCanApproveOrders: viewer.canApproveOrders,
      itemIsHere: createdOnCounter,
    }),
    exchange,
  };
}

// ── List ───────────────────────────────────────────────────────────────────

type OverviewRow = {
  id: string;
  return_number: string | null;
  status: string;
  source: string;
  reason_code: string | null;
  order_request_id: string;
  order_number: number | null;
  requester_name: string | null;
  requester_email: string | null;
  /** The order's requester (0396's view column); null for a typed requester or a deleted account. */
  requester_user_id?: string | null;
  created_at: string;
  approved_at: string | null;
  waiting_days: number | null;
  requested_by?: string | null;
  deleted_users?: unknown;
  line_count: number | null;
  unit_count: number | string | null;
  lines: Array<{ line_id: string; item_id: string; quantity: number | string }> | null;
  // RX-2 (0396's appended columns).
  kind?: string | null;
  exchange_status?: string | null;
  replacement_order_number?: number | null;
  replacement_status?: string | null;
  replacement_owed?: number | string | null;
};

/**
 * The most members one search matches by name (B117). 500 people are five
 * reads of the view at 100 a read, one wave (IN_FILTER_DEFAULT_CONCURRENCY).
 * Past it the search keeps to the typed columns and the page says so.
 */
export const RETURN_SEARCH_MAX_MEMBERS = 500;

/**
 * The members a search text names (B117): members of THIS organisation whose
 * profile name or email contains the text. Read with the viewer's own
 * session, so `organization_members` answers only for an organisation the
 * viewer belongs to and the inner profile embed drops every member whose
 * profile the viewer may not read (user_profiles_select_orgmates, 0003): a
 * name the viewer cannot see matches nothing, the same as a name nobody has.
 * The embed and its filter are the platform members search's
 * (platform/orgs.ts). `q` is already sanitizeReturnSearch's output.
 *
 * More than RETURN_SEARCH_MAX_MEMBERS: nobody is matched ('too_many'), not an
 * arbitrary first few. A failed read: nobody ('unavailable'), reported; the
 * list still answers from the typed columns.
 */
async function searchRequesterMembers(
  ctx: ServiceContext,
  q: string,
): Promise<{ ids: string[]; state: ReturnRequesterSearch }> {
  try {
    const { data, error } = await ctx.supabase
      .from('organization_members')
      .select('user_id, user_profiles:user_id!inner (id)')
      .eq('organization_id', ctx.organizationId)
      .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`, { referencedTable: 'user_profiles' })
      .order('user_id', { ascending: true })
      .range(0, RETURN_SEARCH_MAX_MEMBERS);
    if (error) throw new Error(error.message);
    const ids = [
      ...new Set(
        ((data as Array<{ user_id: string | null }> | null) ?? [])
          .map((r) => r.user_id)
          .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)),
      ),
    ];
    if (ids.length > RETURN_SEARCH_MAX_MEMBERS) return { ids: [], state: 'too_many' };
    return { ids, state: 'full' };
  } catch (err) {
    reportDegradedRead('returns.list.requester-search', err, {});
    return { ids: [], state: 'unavailable' };
  }
}

/** A timestamptz as PostgREST prints it, in microseconds; NaN when it is not one. */
function instantMicros(v: string | null | undefined): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(v ?? '');
  if (!m) return Number.NaN;
  return Date.parse(`${m[1]}${m[3]}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/**
 * The list's order, for merging several reads of it: the sort column as an
 * instant (text would put ".5+00:00" and "+00:00" in the wrong order), then
 * the id, both in the list's direction, as `.order(sortCol).order('id')`
 * gives. Ids compare as lowercase text, which is how Postgres orders uuids.
 */
export function compareReturnListRows(
  a: Pick<OverviewRow, 'id' | 'created_at' | 'approved_at'>,
  b: Pick<OverviewRow, 'id' | 'created_at' | 'approved_at'>,
  sortCol: 'created_at' | 'approved_at',
  ascending: boolean,
): number {
  const ka = instantMicros(a[sortCol]);
  const kb = instantMicros(b[sortCol]);
  let c = 0;
  if (Number.isNaN(ka) || Number.isNaN(kb)) {
    const sa = a[sortCol] ?? '';
    const sb = b[sortCol] ?? '';
    c = sa < sb ? -1 : sa > sb ? 1 : 0;
  } else c = ka < kb ? -1 : ka > kb ? 1 : 0;
  if (c === 0) {
    const ia = a.id.toLowerCase();
    const ib = b.id.toLowerCase();
    c = ia < ib ? -1 : ia > ib ? 1 : 0;
  }
  return ascending ? c : -c;
}

export async function buildReturnListPage(ctx: ServiceContext, query: ReturnListQuery): Promise<ReturnListPage> {
  const filterId: ReturnListFilterId = query.filter ?? 'all';
  const filter = returnListFilter(filterId);
  const q = sanitizeReturnSearch(query.q);
  const cursor = decodeReturnCursor(query.cursor);
  const pageSize = RETURN_LIST_PAGE_SIZE;
  const sortCol = filter.sort === 'approved_asc' ? 'approved_at' : 'created_at';
  const ascending = filter.sort === 'approved_asc';

  // B117: the members the search text names, matched below against the
  // orders they placed for themselves.
  const people = q ? await searchRequesterMembers(ctx, q) : { ids: [], state: 'full' as const };

  /** One read of the view; `memberBatch` adds "the order was this member's own". */
  const readOverview = async (memberBatch: readonly string[] | null): Promise<OverviewRow[]> => {
    let req = ctx.supabase
      .from('return_overview')
      .select(
        'id, return_number, status, source, reason_code, order_request_id, order_number, requester_name, requester_email, requester_user_id, created_at, approved_at, waiting_days, line_count, unit_count, lines, requested_by, deleted_users, kind, exchange_status, replacement_order_number, replacement_status, replacement_owed',
      )
      .eq('organization_id', ctx.organizationId);
    if (filter.statuses) {
      // in-list-bound: return statuses are a fixed enum of a few values
      req = req.in('status', [...filter.statuses]);
    }
    if (filter.sort === 'approved_asc') req = req.not('approved_at', 'is', null);
    // RX-2: returns only, exchanges, and the two replacement views (plan 3.10, G5).
    if (filter.kind) req = req.eq('kind', filter.kind);
    if (filter.exchangeStatuses && !filter.orRequestedShort) {
      // in-list-bound: exchange statuses are a fixed enum of fifteen codes
      req = req.in('exchange_status', [...filter.exchangeStatuses]);
    }

    const clauses: string[] = [];
    if (filter.exchangeStatuses && filter.orRequestedShort) {
      // "Replacement unavailable": unavailable, or a requested exchange whose
      // requested item is short right now (advice).
      // in-list-bound: exchange statuses are a fixed enum of fifteen codes
      clauses.push(
        `or(exchange_status.in.(${filter.exchangeStatuses.join(',')}),and(exchange_status.eq.requested,requested_short.is.true))`,
      );
    }
    if (cursor) {
      const op = ascending ? 'gt' : 'lt';
      clauses.push(`or(${sortCol}.${op}."${cursor.k}",and(${sortCol}.eq."${cursor.k}",id.${op}.${cursor.i}))`);
    }
    if (q) {
      // Unquoted %…% like the other searches: the sanitized term holds no
      // comma, parenthesis, quote, percent or backslash.
      const terms = [
        `return_number.ilike.%${q}%`,
        `requester_name.ilike.%${q}%`,
        `requester_email.ilike.%${q}%`,
      ];
      const n = orderNumberFromSearch(q);
      if (n !== null) terms.push(`order_number.eq.${n}`);
      if (memberBatch && memberBatch.length > 0) {
        // B117: an order one of the matching members placed for themselves.
        // Only where no name was typed: a typed name is what the row shows
        // (requesterLabelOf), and the term above already searched it. The
        // ids are uuids read from the database, checked again by shape.
        // in-list-bound: one batch of chunkInFilterValues (below), at most 100 uuids
        terms.push(`and(requester_user_id.in.(${memberBatch.join(',')}),requester_name.is.null)`);
      }
      clauses.push(`or(${terms.join(',')})`);
    }
    if (clauses.length > 0) req = req.or(`and(${clauses.join(',')})`);

    const { data, error } = await req
      .order(sortCol, { ascending })
      .order('id', { ascending })
      .range(0, pageSize);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as OverviewRow[] | null) ?? [];
  };

  // The matching members ride in the request URL, so at most 100 per read
  // (lib/supabase/in-filter). One read is the usual case. With more, each
  // read answers ITS first page (pageSize + 1 rows in the list's order), and
  // the first page of all of them together is the first pageSize + 1 of those
  // rows merged: the page and its cursor are exact, however many people match.
  const memberBatches = chunkInFilterValues(people.ids);
  let fetched: OverviewRow[];
  if (memberBatches.length <= 1) {
    fetched = await readOverview(memberBatches[0] ?? null);
  } else {
    const perBatch = await mapWithConcurrency(memberBatches, IN_FILTER_DEFAULT_CONCURRENCY, (batch) =>
      readOverview(batch),
    );
    const byId = new Map<string, OverviewRow>();
    for (const rows of perBatch) for (const r of rows) byId.set(r.id, r);
    fetched = [...byId.values()]
      .sort((a, b) => compareReturnListRows(a, b, sortCol, ascending))
      .slice(0, pageSize + 1);
  }

  const pageRows = fetched.slice(0, pageSize);
  const last = pageRows.at(-1);
  const lastSort = last ? (ascending ? last.approved_at : last.created_at) : null;
  const nextCursor = fetched.length > pageSize && last && lastSort ? encodeReturnCursor(lastSort, last.id) : null;

  // The first two returning items per row, read and signed in one batch each.
  const shown = new Map<string, Array<{ item_id: string; quantity: number }>>();
  const itemIds = new Set<string>();
  for (const r of pageRows) {
    const ls = (r.lines ?? []).slice(0, 2).map((l) => ({ item_id: l.item_id, quantity: numberOf(l.quantity) }));
    shown.set(r.id, ls);
    for (const l of ls) itemIds.add(l.item_id);
  }
  const ids = [...itemIds];
  // B117: the members the page's orders were for, in one read beside the others.
  const requesterIds = pageRows
    .map((r) => requesterProfileId(r.requester_name, r.requester_user_id))
    .filter((v): v is string => v !== null);
  const [items, images, names] = await Promise.all([
    readItems(ctx, ids, 'returns.list.items'),
    readImages(ctx, ids, 'returns.list.images'),
    readNames(ctx, requesterIds),
  ]);

  return {
    organizationId: ctx.organizationId,
    filter: filterId,
    q,
    pageSize,
    nextCursor,
    requesterSearch: people.state,
    rows: pageRows.map((r) => {
      const total = (r.lines ?? []).length;
      return {
        id: r.id,
        returnNumber: r.return_number,
        status: r.status,
        source: r.source,
        reasonCode: r.reason_code,
        orderRequestId: r.order_request_id,
        orderNumber: r.order_number,
        requesterName: requesterLabelOf({
          name: r.requester_name,
          email: r.requester_email,
          requesterUserId: r.requester_user_id,
          // The view left-joins the order: a hidden order has no number.
          orderRead: r.order_number !== null,
          names,
          requestedBy: r.requested_by,
          marks: r.deleted_users,
        }),
        requesterEmail: r.requester_email,
        createdAt: r.created_at,
        approvedAt: r.approved_at,
        waitingDays: r.waiting_days,
        lineCount: numberOf(r.line_count),
        unitCount: numberOf(r.unit_count),
        items: (shown.get(r.id) ?? []).map((l) => {
          const it = items.get(l.item_id);
          return {
            itemId: l.item_id,
            name: it?.name ?? null,
            variant: variantOf(it),
            quantity: l.quantity,
            thumbUrl: images.get(l.item_id)?.thumbUrl ?? images.get(l.item_id)?.url ?? null,
          };
        }),
        moreItems: Math.max(0, total - 2),
        type: r.kind === 'exchange' ? ('exchange' as const) : ('return' as const),
        exchangeStatus: parseExchangeStatus(r.exchange_status ?? 'none'),
        exchangeStatusLabel:
          r.kind === 'exchange'
            ? exchangeStatusStaffLabel(parseExchangeStatus(r.exchange_status), {
                returnStatus: r.status,
                // Desk check F9: a replacement closed with part never sent says so.
                replacementStatus: r.replacement_status ?? null,
                replacementOwed: r.replacement_owed === undefined || r.replacement_owed === null ? null : Number(r.replacement_owed),
              })
            : null,
        replacementOrderNumber: r.replacement_order_number ?? null,
      };
    }),
  };
}
