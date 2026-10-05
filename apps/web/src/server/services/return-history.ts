import 'server-only';

import { can, formatOrderNumber, formatRackHoldings } from '@stockpilot/core';

import { ServiceError, assertModuleEnabled, assertPermission, type ServiceContext } from './context';
import { fetchAllRowsByIds, reportDegradedRead } from './lib/fetch-by-ids';

/**
 * The RMA's chain (brief 35, plan RX-1 `ReturnHistoryService.chain`): one
 * timeline from the original pick to the close, so anyone can see where the
 * returned unit came from and where it went.
 *
 *   picked       the original order's pick of each returned item, with the
 *                racks its recorded draw took from (0373 provenance)
 *   handed_over  the original order's completion
 *   the RMA's decisions (created, planned, approved, received, closed,
 *                denied, cancelled), from the append-only log
 *   the inbound legs (returned to a rack, into Staging, scrapped), from the
 *                RMA's own movements
 *
 * RX-2 adds the replacement order, its holds and its pick to the same list.
 * Staff-only words (reasons, racks): the requester tracking page never reads
 * this (RX-3 has its own redacted payload).
 */

export type ReturnChainKind =
  | 'picked'
  | 'handed_over'
  | 'created'
  | 'disposition_planned'
  | 'approved'
  | 'received'
  | 'closed'
  | 'denied'
  | 'cancelled'
  | 'returned_to_rack'
  | 'into_staging'
  | 'scrapped';

export interface ReturnChainEvent {
  at: string;
  kind: ReturnChainKind;
  label: string;
  actorName: string | null;
}

/** A decision as the chain needs it (the workbench's named decision). */
export interface ChainDecision {
  seq: number;
  kind: string;
  channel: string;
  revision: number | null;
  /** The line a plan is for (names the item in "Destination for ..."). */
  returnLineId?: string | null;
  disposition: string | null;
  restockTarget: string | null;
  locationName: string | null;
  reason: string | null;
  actorName: string | null;
  actorKind: string;
  createdAt: string;
}

/** One of the RMA's own movements (return legs and the scrap write-off). */
export interface ChainMovement {
  itemId: string;
  movementType: string;
  quantity: number;
  toLocationName: string | null;
  rack: boolean;
  createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function numberOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function decisionLabel(
  d: ChainDecision,
  lineLabels: Map<string, string> | undefined,
  originalRacks: Map<string, string> | undefined,
): string | null {
  const counter = d.channel === 'counter' ? ' at the counter' : '';
  switch (d.kind) {
    case 'created':
      return d.actorKind === 'staff' ? `Return created by staff${counter}` : 'Return requested by the requester';
    case 'disposition_planned': {
      // "Destination for New Hire Shirt, M: Return to original rack 31-C"
      // (review fix: name the line and the rack, not just the kind).
      const item = d.returnLineId ? lineLabels?.get(d.returnLineId) : undefined;
      const head = item ? `Destination for ${item}` : 'Destination';
      if (d.disposition === 'scrap') return `${head}: Scrap`;
      if (d.restockTarget === 'original') {
        const racks = d.returnLineId ? originalRacks?.get(d.returnLineId) : undefined;
        return `${head}: Return to original rack${racks ? ` ${racks}` : ''}`;
      }
      if (d.restockTarget === 'source') return `${head}: Return to ${d.locationName ?? 'a chosen rack'}`;
      return `${head}: Leave in Staging`;
    }
    case 'approved':
      // The revision is internal bookkeeping (review fix): never shown.
      return 'Approved';
    case 'received':
      return `Received${counter}`;
    case 'closed':
      return 'Processed';
    case 'denied':
      return d.reason ? `Denied: ${d.reason}` : 'Denied';
    case 'cancelled':
      return d.reason ? `Cancelled: ${d.reason}` : 'Cancelled';
    default:
      return null;
  }
}

/** Pure: the chain from what was read (sorted by time, then a stable order). */
export function buildReturnChainEvents(input: {
  orderNumber: number | null;
  completedAt: string | null;
  picks: Array<{ at: string; itemName: string | null; quantity: number; racks: Array<{ name: string; quantity: number }> }>;
  decisions: ChainDecision[];
  movements: ChainMovement[];
  itemNames: Map<string, string | null>;
  /** Line id -> "New Hire Shirt, M" (destination events name their line). */
  lineLabels?: Map<string, string>;
  /** Line id -> the original rack(s) a plan of "original" means. */
  originalRacks?: Map<string, string>;
}): ReturnChainEvent[] {
  const so = formatOrderNumber(input.orderNumber);
  const events: Array<ReturnChainEvent & { order: number }> = [];
  let order = 0;
  for (const p of input.picks) {
    const from = formatRackHoldings(p.racks);
    events.push({
      at: p.at,
      kind: 'picked',
      label: `Picked: ${p.itemName ?? 'item'} ×${p.quantity}${from ? ` from ${from}` : ''}${so ? ` (${so})` : ''}`,
      actorName: null,
      order: order++,
    });
  }
  if (input.completedAt) {
    events.push({ at: input.completedAt, kind: 'handed_over', label: `Handed over${so ? ` (${so})` : ''}`, actorName: null, order: order++ });
  }
  for (const d of input.decisions) {
    const label = decisionLabel(d, input.lineLabels, input.originalRacks);
    if (!label) continue;
    events.push({ at: d.createdAt, kind: d.kind as ReturnChainKind, label, actorName: d.actorName, order: order++ });
  }
  // A scrap is written as +q return (no rack) then -q loss in the same close
  // (net zero). Read as ONE event, "Scrapped", never "Into Staging" first
  // (review fix): each loss consumes the matching Staging return of its item
  // and close.
  const scrapPairs = new Map<string, number>();
  for (const m of input.movements) {
    if (m.movementType !== 'loss') continue;
    const k = `${m.itemId}|${m.createdAt}|${Math.abs(m.quantity)}`;
    scrapPairs.set(k, (scrapPairs.get(k) ?? 0) + 1);
  }
  for (const m of input.movements) {
    const name = input.itemNames.get(m.itemId) ?? 'item';
    if (m.movementType === 'loss') {
      events.push({ at: m.createdAt, kind: 'scrapped', label: `Scrapped: ${name} ×${Math.abs(m.quantity)}`, actorName: null, order: order++ });
    } else if (m.movementType === 'return' && m.quantity > 0) {
      const k = `${m.itemId}|${m.createdAt}|${m.quantity}`;
      const pending = scrapPairs.get(k) ?? 0;
      if (!m.rack && pending > 0) {
        scrapPairs.set(k, pending - 1);
        continue;
      }
      events.push(
        m.rack
          ? { at: m.createdAt, kind: 'returned_to_rack', label: `Returned to ${m.toLocationName ?? 'a rack'}: ${name} ×${m.quantity}`, actorName: null, order: order++ }
          : { at: m.createdAt, kind: 'into_staging', label: `Into Staging: ${name} ×${m.quantity}`, actorName: null, order: order++ },
      );
    }
  }
  return events
    .sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1))
    .map(({ order: _o, ...e }) => e);
}

/**
 * The original order's picks of the returned items with the racks each
 * recorded draw took from (two reads, then the location names in one).
 */
export async function loadOriginalPicks(
  ctx: ServiceContext,
  orderRequestId: string,
  itemIds: string[],
  itemNames: Map<string, string | null>,
): Promise<Array<{ at: string; itemName: string | null; quantity: number; racks: Array<{ name: string; quantity: number }> }>> {
  if (itemIds.length === 0) return [];
  try {
    const moves = await fetchAllRowsByIds<{ id: string; item_id: string; quantity_change: number | string; created_at: string }>(
      itemIds,
      (batch) => (from, to) =>
        ctx.supabase
          .from('stock_movements')
          .select('id, item_id, quantity_change, created_at')
          .eq('organization_id', ctx.organizationId)
          .eq('reference_type', 'order_request')
          .eq('reference_id', orderRequestId)
          .eq('movement_type', 'transfer')
          .lt('quantity_change', 0)
          // The ledger's picks only (review fix): a member's direct insert
          // (via_ledger false) is no pick of the order.
          .eq('via_ledger', true)
          .in('item_id', batch)
          .order('id')
          .range(from, to),
    );
    if (moves.length === 0) return [];
    const holdings = await fetchAllRowsByIds<{ movement_id: string; location_id: string; quantity: number | string }>(
      moves.map((m) => m.id),
      (batch) => (from, to) =>
        ctx.supabase
          .from('stock_movement_holdings')
          .select('movement_id, location_id, quantity')
          .eq('organization_id', ctx.organizationId)
          .in('movement_id', batch)
          .lt('quantity', 0)
          .order('movement_id')
          .range(from, to),
    );
    const locIds = [...new Set(holdings.map((h) => h.location_id).filter((v) => UUID_RE.test(v ?? '')))];
    const locs =
      locIds.length > 0
        ? await fetchAllRowsByIds<{ id: string; name: string }>(locIds, (batch) => (from, to) =>
            ctx.supabase.from('locations').select('id, name').eq('organization_id', ctx.organizationId).in('id', batch).order('id').range(from, to),
          )
        : [];
    const locName = new Map(locs.map((l) => [l.id, l.name]));
    return moves
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((m) => ({
        at: m.created_at,
        itemName: itemNames.get(m.item_id) ?? null,
        quantity: Math.abs(numberOf(m.quantity_change)),
        racks: holdings
          .filter((h) => h.movement_id === m.id)
          .map((h) => ({ name: locName.get(h.location_id) ?? 'an unnamed location', quantity: Math.abs(numberOf(h.quantity)) })),
      }));
  } catch (err) {
    reportDegradedRead('returns.chain.picks', err, { items: itemIds.length });
    return [];
  }
}

/**
 * ReturnHistoryService.chain(returnId): the standalone read (the workbench
 * builds the same chain from the reads it already made).
 */
export class ReturnHistoryService {
  constructor(private readonly ctx: ServiceContext) {}

  async chain(returnId: string): Promise<ReturnChainEvent[]> {
    assertModuleEnabled(this.ctx, 'returns');
    assertPermission(this.ctx, can(this.ctx, 'returns:manage') ? 'returns:manage' : 'returns:read');
    if (!UUID_RE.test(returnId)) throw new ServiceError('not_found', "This return isn't available.");
    const ctx = this.ctx;

    const { data: header, error } = await ctx.supabase
      .from('returns')
      .select(
        'id, order_request_id, order_request:order_requests!order_request_id (order_number, completed_at), lines:return_lines (id, item_id)',
      )
      .eq('organization_id', ctx.organizationId)
      .eq('id', returnId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!header) throw new ServiceError('not_found', "This return isn't available.");
    const h = header as {
      order_request_id: string;
      order_request?: { order_number: number | null; completed_at: string | null } | Array<{ order_number: number | null; completed_at: string | null }> | null;
      lines?: Array<{ id: string; item_id: string }> | null;
    };
    const order = Array.isArray(h.order_request) ? (h.order_request[0] ?? null) : (h.order_request ?? null);
    const itemIds = [...new Set((h.lines ?? []).map((l) => l.item_id))];

    const [decisionsRes, movesRes, items] = await Promise.all([
      ctx.supabase
        .from('return_decisions')
        .select('seq, kind, channel, revision, return_line_id, disposition, restock_target, location_id, reason, actor_user_id, actor_kind, created_at')
        .eq('organization_id', ctx.organizationId)
        .eq('return_id', returnId)
        .order('seq', { ascending: true }),
      ctx.supabase
        .from('stock_movements')
        .select('item_id, movement_type, quantity_change, to_location_id, created_at')
        .eq('organization_id', ctx.organizationId)
        .eq('reference_type', 'return')
        .eq('reference_id', returnId)
        // Ledger rows only (review fix; the workbench reads the same way).
        .eq('via_ledger', true)
        .order('created_at', { ascending: true }),
      itemIds.length > 0
        ? fetchAllRowsByIds<{ id: string; name: string | null }>(itemIds, (batch) => (from, to) =>
            ctx.supabase.from('inventory_items').select('id, name').eq('organization_id', ctx.organizationId).in('id', batch).order('id').range(from, to),
          )
        : Promise.resolve([] as Array<{ id: string; name: string | null }>),
    ]);
    if (decisionsRes.error) throw new ServiceError('internal_error', decisionsRes.error.message);
    const itemNames = new Map(items.map((i) => [i.id, i.name]));
    type D = { seq: number; kind: string; channel: string; revision: number | null; return_line_id: string | null; disposition: string | null; restock_target: string | null; location_id: string | null; reason: string | null; actor_user_id: string | null; actor_kind: string; created_at: string };
    type M = { item_id: string; movement_type: string; quantity_change: number | string; to_location_id: string | null; created_at: string };
    const decisions = (decisionsRes.data as D[] | null) ?? [];
    const moves = (movesRes.data as M[] | null) ?? [];

    const userIds = [...new Set(decisions.map((d) => d.actor_user_id).filter((v): v is string => !!v && UUID_RE.test(v)))];
    const locIds = [
      ...new Set([...decisions.map((d) => d.location_id), ...moves.map((m) => m.to_location_id)].filter((v): v is string => !!v && UUID_RE.test(v))),
    ];
    const [users, locs, picks] = await Promise.all([
      userIds.length > 0
        ? fetchAllRowsByIds<{ id: string; full_name: string | null; email: string | null }>(userIds, (batch) => (from, to) =>
            ctx.supabase.from('user_profiles').select('id, full_name, email').in('id', batch).order('id').range(from, to),
          ).catch(() => [] as Array<{ id: string; full_name: string | null; email: string | null }>)
        : Promise.resolve([] as Array<{ id: string; full_name: string | null; email: string | null }>),
      locIds.length > 0
        ? fetchAllRowsByIds<{ id: string; name: string }>(locIds, (batch) => (from, to) =>
            ctx.supabase.from('locations').select('id, name').eq('organization_id', ctx.organizationId).in('id', batch).order('id').range(from, to),
          ).catch(() => [] as Array<{ id: string; name: string }>)
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      loadOriginalPicks(ctx, h.order_request_id, itemIds, itemNames),
    ]);
    const userName = new Map(users.map((u) => [u.id, u.full_name?.trim() || u.email || null]));
    const locName = new Map(locs.map((l) => [l.id, l.name]));
    // A line's name, and the rack(s) its own return legs went to once closed.
    const lineLabels = new Map((h.lines ?? []).map((l) => [l.id, itemNames.get(l.item_id) ?? 'Item']));
    const originalRacks = new Map<string, string>();
    for (const l of h.lines ?? []) {
      const racks = moves
        .filter((m) => m.item_id === l.item_id && m.movement_type === 'return' && m.to_location_id)
        .map((m) => ({ name: locName.get(m.to_location_id!) ?? 'a rack', quantity: numberOf(m.quantity_change) }));
      const label = racks.length === 1 ? racks[0]!.name : formatRackHoldings(racks);
      if (label) originalRacks.set(l.id, label);
    }

    return buildReturnChainEvents({
      orderNumber: order?.order_number ?? null,
      completedAt: order?.completed_at ?? null,
      picks,
      itemNames,
      lineLabels,
      originalRacks,
      decisions: decisions.map((d) => ({
        seq: numberOf(d.seq),
        kind: d.kind,
        channel: d.channel,
        revision: d.revision,
        returnLineId: d.return_line_id,
        disposition: d.disposition,
        restockTarget: d.restock_target,
        locationName: d.location_id ? (locName.get(d.location_id) ?? null) : null,
        reason: d.reason,
        actorName: d.actor_user_id ? (userName.get(d.actor_user_id) ?? null) : null,
        actorKind: d.actor_kind,
        createdAt: d.created_at,
      })),
      movements: moves.map((m) => ({
        itemId: m.item_id,
        movementType: m.movement_type,
        quantity: numberOf(m.quantity_change),
        toLocationName: m.to_location_id ? (locName.get(m.to_location_id) ?? null) : null,
        rack: m.to_location_id !== null,
        createdAt: m.created_at,
      })),
    });
  }
}
