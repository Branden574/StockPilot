import 'server-only';

import {
  availableReturnActions,
  can,
  inboundStateLabel,
  parseRestockOptions,
  returnListFilter,
  RETURN_LIST_PAGE_SIZE,
  variantLabel,
  type InboundLeg,
  type RestockOptionsLine,
  type ReturnActions,
  type ReturnListFilterId,
} from '@stockpilot/core';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { ServiceError, type ServiceContext } from './context';
import { ItemImagesService } from './item-images';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';
import { buildReturnChainEvents, loadOriginalPicks, type ReturnChainEvent } from './return-history';

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
 * LIST: three round trips per page whatever its size: the `return_overview`
 * page (keyset at 25 rows), the items of the page's lines in chunks of 100,
 * and one image call for the thumbnails (two per row, then "+N").
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
  lines: ReturnWorkbenchLine[];
  decisions: ReturnWorkbenchDecision[];
  /** The timeline from the original pick to the close (ReturnHistoryService). */
  chain: ReturnChainEvent[];
  viewer: { canManageReturns: boolean; canApproveOrders: boolean; canReadDecisions: boolean };
  actions: ReturnActions;
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
  /** RX-1: every RMA is a return (RX-2 adds exchanges). */
  type: 'return';
}

export interface ReturnListPage {
  organizationId: string;
  filter: ReturnListFilterId;
  q: string;
  rows: ReturnListRow[];
  nextCursor: string | null;
  pageSize: number;
}

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
  created_at: string;
  order_request?:
    | { order_number: number | null; warehouse_id: string | null; requester_name: string | null; requester_email: string | null; completed_at: string | null }
    | Array<{ order_number: number | null; warehouse_id: string | null; requester_name: string | null; requester_email: string | null; completed_at: string | null }>
    | null;
  lines?: Array<{
    id: string;
    order_request_line_id: string;
    item_id: string;
    quantity: number | string;
    disposition: 'restock' | 'scrap';
    applied: boolean | null;
    created_at: string;
  }> | null;
};

type DecisionRow = {
  seq: number | string;
  kind: string;
  channel: string;
  revision: number | null;
  return_line_id: string | null;
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
       closed_by, closed_at, denied_by, denied_at, created_at,
       order_request:order_requests!order_request_id (order_number, warehouse_id, requester_name, requester_email, completed_at),
       lines:return_lines (id, order_request_line_id, item_id, quantity, disposition, applied, created_at)`,
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

  // Tier 2, in parallel.
  const [optionsRes, decisionsRes, items, movementsRes, warehouseRes, writeOk] = await Promise.all([
    ctx.supabase.rpc('return_restock_options', { p_return_id: id }),
    ctx.supabase
      .from('return_decisions')
      .select(
        'seq, kind, channel, revision, return_line_id, disposition, restock_target, location_id, basis, reason, actor_user_id, actor_kind, created_at',
      )
      .eq('organization_id', ctx.organizationId)
      .eq('return_id', id)
      .order('seq', { ascending: true }),
    readItems(ctx, itemIds, 'returns.workbench.items'),
    ctx.supabase
      .from('stock_movements')
      .select('item_id, movement_type, quantity_change, to_location_id, created_at')
      .eq('organization_id', ctx.organizationId)
      .eq('reference_type', 'return')
      .eq('reference_id', id)
      // in-list-bound: the two movement types a return writes
      .in('movement_type', ['return', 'loss'])
      .order('created_at', { ascending: true }),
    warehouseId
      ? ctx.supabase.from('warehouses').select('id, name').eq('id', warehouseId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    canWriteWarehouse(ctx, warehouseId),
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
  const [images, names, locationRows, picks] = await Promise.all([
    readImages(ctx, itemIds, 'returns.workbench.images'),
    readNames(ctx, [
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
  ]);
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
  const chain = buildReturnChainEvents({
    orderNumber: order?.order_number ?? null,
    completedAt: order?.completed_at ?? null,
    picks,
    itemNames,
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
      requesterName: h.requester_name ?? order?.requester_name ?? null,
      requesterEmail: h.requester_email ?? order?.requester_email ?? null,
      createdAt: h.created_at,
      approvedAt: h.approved_at,
      receivedAt: h.received_at,
      closedAt: h.closed_at,
      deniedAt: h.denied_at,
      requestedByName: h.requested_by ? (names.get(h.requested_by) ?? null) : null,
      approvedByName: h.approved_by ? (names.get(h.approved_by) ?? null) : null,
      receivedByName: h.received_by ? (names.get(h.received_by) ?? null) : null,
      closedByName: h.closed_by ? (names.get(h.closed_by) ?? null) : null,
      deniedByName: h.denied_by ? (names.get(h.denied_by) ?? null) : null,
    },
    revision,
    planSeq,
    createdOnCounter,
    lines,
    decisions: named,
    chain,
    viewer,
    actions: availableReturnActions({
      status: h.status,
      exchangeStatus: 'none',
      viewerCanManageReturns: canManageReturns,
      viewerCanApproveOrders: viewer.canApproveOrders,
      itemIsHere: createdOnCounter,
    }),
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
  created_at: string;
  approved_at: string | null;
  waiting_days: number | null;
  line_count: number | null;
  unit_count: number | string | null;
  lines: Array<{ line_id: string; item_id: string; quantity: number | string }> | null;
};

export async function buildReturnListPage(ctx: ServiceContext, query: ReturnListQuery): Promise<ReturnListPage> {
  const filterId: ReturnListFilterId = query.filter ?? 'all';
  const filter = returnListFilter(filterId);
  const q = sanitizeReturnSearch(query.q);
  const cursor = decodeReturnCursor(query.cursor);
  const pageSize = RETURN_LIST_PAGE_SIZE;
  const sortCol = filter.sort === 'approved_asc' ? 'approved_at' : 'created_at';
  const ascending = filter.sort === 'approved_asc';

  let req = ctx.supabase
    .from('return_overview')
    .select(
      'id, return_number, status, source, reason_code, order_request_id, order_number, requester_name, requester_email, created_at, approved_at, waiting_days, line_count, unit_count, lines',
    )
    .eq('organization_id', ctx.organizationId);
  if (filter.statuses) {
    // in-list-bound: return statuses are a fixed enum of a few values
    req = req.in('status', [...filter.statuses]);
  }
  if (filter.sort === 'approved_asc') req = req.not('approved_at', 'is', null);

  const clauses: string[] = [];
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
    clauses.push(`or(${terms.join(',')})`);
  }
  if (clauses.length > 0) req = req.or(`and(${clauses.join(',')})`);

  const { data, error } = await req
    .order(sortCol, { ascending })
    .order('id', { ascending })
    .range(0, pageSize);
  if (error) throw new ServiceError('internal_error', error.message);

  const fetched = (data as OverviewRow[] | null) ?? [];
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
  const [items, images] = await Promise.all([
    readItems(ctx, ids, 'returns.list.items'),
    readImages(ctx, ids, 'returns.list.images'),
  ]);

  return {
    organizationId: ctx.organizationId,
    filter: filterId,
    q,
    pageSize,
    nextCursor,
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
        requesterName: r.requester_name,
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
        type: 'return' as const,
      };
    }),
  };
}
