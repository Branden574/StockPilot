import {
  mapReturnError,
  parseExchangeCandidates,
  parseRestockOptions,
  randomRequestUuid,
  type ExchangeCandidatesAnswer,
  type ExchangeStatus,
  type InboundLeg,
  type RailStep,
  type ReplacementClass,
  type RestockOptionsLine,
  type ReturnActions,
  type ReturnLineDecision,
  type ReturnListFilterId,
} from '@stockpilot/core';

import { api, ApiError } from './api';
import { NO_EXCHANGE } from './returns-view';

export { NO_EXCHANGE };

/**
 * The phone's returns client (returns RX-1): thin typed wrappers over the
 * /api/v1/returns routes, Bearer like every other *-api.ts here. The shapes
 * mirror the web service's (server/services/returns-workbench.ts), which the
 * phone cannot import, field for field.
 *
 * ONLINE ONLY. No return action is ever queued (no outbox kind exists for
 * one; queue.ts is unchanged and a wiring test pins that): approving,
 * receiving and processing move or promise stock, so each needs the server's
 * answer before the screen may say it happened. Offline, the screens disable
 * every action with "Needs a connection.".
 *
 * Refusals are mapped by `details.reason` (the database hint) through core's
 * return-error-map, never by message text (pattern 28). The routes send their
 * own words for an internal error (`details.reason: 'failed'`), because the
 * phone's api() drops details for internal_error.
 */

// ── Shapes (mirrors of the web service) ────────────────────────────────────

export interface MobileReturnListRowItem {
  itemId: string;
  name: string | null;
  variant: string | null;
  quantity: number;
  thumbUrl: string | null;
}

export interface MobileReturnListRow {
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
  items: MobileReturnListRowItem[];
  moreItems: number;
  /** RX-2: a return or an exchange (older servers send 'return' only). */
  type: 'return' | 'exchange';
  exchangeStatus?: ExchangeStatus;
  exchangeStatusLabel?: string | null;
  replacementOrderNumber?: number | null;
}

export interface MobileReturnListPage {
  organizationId: string;
  filter: ReturnListFilterId;
  q: string;
  rows: MobileReturnListRow[];
  nextCursor: string | null;
  pageSize: number;
}

export interface MobileReturnWorkbenchLine {
  id: string;
  orderRequestLineId: string;
  itemId: string;
  quantity: number;
  disposition: 'restock' | 'scrap';
  applied: boolean;
  item: {
    name: string | null;
    sku: string | null;
    variant: string | null;
    deleted: boolean;
    imageUrl: string | null;
    thumbUrl: string | null;
  };
  restock: RestockOptionsLine | null;
  legs: InboundLeg[];
  inboundState: string;
}

// ── RX-2: the exchange half (mirrors server/services/returns-exchange-workbench.ts) ──

export interface MobileExchangeItem {
  name: string | null;
  sku: string | null;
  variant: string | null;
  deleted: boolean;
  imageUrl: string | null;
  thumbUrl: string | null;
}

export interface MobileExchangeLine {
  id: string;
  returnLineId: string;
  status: 'requested' | 'approved' | 'declined' | 'cancelled';
  requestedItemId: string | null;
  requestedQuantity: number;
  requestNote: string | null;
  requestedByKind: string;
  requestedItem: MobileExchangeItem | null;
  requestedFree: number | null;
  approvedItemId: string | null;
  approvedQuantity: number | null;
  approvedItem: MobileExchangeItem | null;
  approvedFree: number | null;
  changedByWarehouse: boolean;
  revision: number;
}

export interface MobileReplacementLine {
  orderLineId: string;
  itemId: string;
  label: string;
  item: MobileExchangeItem | null;
  requested: number;
  fulfilled: number;
  held: number;
  take: string | null;
}

export interface MobileReplacement {
  orderId: string;
  orderNumber: number | null;
  status: string;
  fulfillmentType: 'pickup' | 'delivery';
  live: boolean;
  class: ReplacementClass;
  owed: number;
  held: number;
  short: boolean;
  lines: MobileReplacementLine[];
}

export interface MobileReturnExchange {
  kind: 'return' | 'exchange';
  status: ExchangeStatus;
  statusLabel: string;
  lines: MobileExchangeLine[];
  replacement: MobileReplacement | null;
  history: { orderId: string; orderNumber: number | null; status: string }[];
  releasedEarly: boolean;
  release: { byName: string | null; reason: string | null; at: string } | null;
  counter: boolean;
  rail: RailStep[];
  hasApprovedExchange: boolean;
  createEnabled: boolean;
  /** Desk check F6: the sites the warehouse serves (absent from an older server). */
  deliverySites?: { id: string; name: string }[];
}

export interface MobileReturnChainEvent {
  at: string;
  kind: string;
  label: string;
  actorName: string | null;
}

export interface MobileReturnWorkbench {
  organizationId: string;
  return: {
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
  };
  revision: number;
  planSeq: number;
  createdOnCounter: boolean;
  /**
   * An unapplied line has no destination answer (the server's read failed):
   * nothing is approved, processed or re-planned until a reload brings it
   * (returns review; never a silent Staging). Derived when an older server
   * omits it.
   */
  destinationsUnavailable: boolean;
  lines: MobileReturnWorkbenchLine[];
  chain: MobileReturnChainEvent[];
  viewer: { canManageReturns: boolean; canApproveOrders: boolean; canReadDecisions: boolean };
  actions: ReturnActions;
  /** RX-1 shape; absent means 'none' (RX-2 servers send `exchange`). */
  exchangeStatus?: ExchangeStatus;
  /** RX-2: the REPLACEMENT column, the rail and the exchange facts
   *  (normalizeWorkbench fills it; read through returns-view exchangeOf). */
  exchange?: MobileReturnExchange;
}

export interface MobileReturnStepResult {
  step: 'approve' | 'receive' | 'process';
  outcome: 'done' | 'already' | 'refused';
  reason?: string;
  message?: string;
  /** RX-2: a refusal's structured detail (replacement_unavailable: [{itemId, needed, available}]). */
  detail?: unknown;
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function listReturns(query: {
  filter?: ReturnListFilterId;
  q?: string | null;
  cursor?: string | null;
}): Promise<MobileReturnListPage> {
  const params: string[] = [];
  if (query.filter && query.filter !== 'all') params.push(`filter=${encodeURIComponent(query.filter)}`);
  if (query.q && query.q.trim()) params.push(`q=${encodeURIComponent(query.q.trim())}`);
  if (query.cursor) params.push(`cursor=${encodeURIComponent(query.cursor)}`);
  return api<MobileReturnListPage>(`/api/v1/returns${params.length ? `?${params.join('&')}` : ''}`);
}

/** The workbench, with each line's destination answer read defensively. */
export async function getReturnWorkbench(id: string): Promise<MobileReturnWorkbench> {
  const raw = await api<MobileReturnWorkbench>(`/api/v1/returns/${encodeURIComponent(id)}`);
  return normalizeWorkbench(raw);
}

export function normalizeWorkbench(raw: MobileReturnWorkbench): MobileReturnWorkbench {
  const lines = (raw.lines ?? []).map((l) => {
    if (!l.restock) return l;
    // The same defensive reader the web uses (core restock-view).
    const parsed = parseRestockOptions({ lines: [l.restock] }).lines[0] ?? null;
    return { ...l, restock: parsed };
  });
  const destinationsUnavailable =
    typeof raw.destinationsUnavailable === 'boolean' ? raw.destinationsUnavailable : lines.some((l) => !l.applied && !l.restock);
  const exchange = raw.exchange ?? { ...NO_EXCHANGE, status: raw.exchangeStatus ?? 'none' };
  return { ...raw, lines, chain: raw.chain ?? [], destinationsUnavailable, exchange };
}

// ── Writes (online only) ───────────────────────────────────────────────────

export interface ReturnStepsBody {
  steps: ('approve' | 'receive' | 'process')[];
  expectedRevision: number | null;
  expectedPlanSeq: number | null;
  approve?: {
    lines: ReturnLineDecision[];
    /** RX-2: one decision per requested exchange line, and adds (G9). */
    exchange?: Record<string, unknown>[];
    replacement?: { whenShort: 'refuse' | 'backorder' };
  } | null;
  receiveNow?: boolean;
  process?: { lines: ReturnLineDecision[] } | null;
}

export async function runReturnSteps(
  id: string,
  body: ReturnStepsBody,
): Promise<{ ran: MobileReturnStepResult[]; workbench: MobileReturnWorkbench }> {
  const res = await api<{ ran: MobileReturnStepResult[]; workbench: MobileReturnWorkbench }>(
    `/api/v1/returns/${encodeURIComponent(id)}/steps`,
    { method: 'POST', body },
  );
  return { ran: res.ran ?? [], workbench: normalizeWorkbench(res.workbench) };
}

export async function denyReturn(id: string, reason: string): Promise<{ changed: boolean }> {
  return api<{ changed: boolean }>(`/api/v1/returns/${encodeURIComponent(id)}/deny`, {
    method: 'POST',
    body: { reason },
  });
}

export async function cancelReturn(
  id: string,
  body: { expectedRevision: number | null; reason: string | null },
): Promise<{ changed: boolean }> {
  return api<{ changed: boolean }>(`/api/v1/returns/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body,
  });
}

export async function planReturnDispositions(
  id: string,
  lines: ReturnLineDecision[],
): Promise<{ changed: boolean; appended: number; planSeq: number }> {
  return api<{ changed: boolean; appended: number; planSeq: number }>(
    `/api/v1/returns/${encodeURIComponent(id)}/dispositions`,
    { method: 'POST', body: { lines } },
  );
}

// ── RX-2: the exchange (online only) ────────────────────────────────────────

export interface ReplacementAnswer<A> {
  answer: A;
  workbench: MobileReturnWorkbench;
}

async function replacementCall<A>(id: string, path: string, body: unknown): Promise<ReplacementAnswer<A>> {
  const res = await api<{ answer: A; workbench: MobileReturnWorkbench }>(
    `/api/v1/returns/${encodeURIComponent(id)}/replacement${path}`,
    { method: 'POST', body },
  );
  return { answer: res.answer, workbench: normalizeWorkbench(res.workbench) };
}

/** Change the replacement, or issue a new one after a cancel (C-1). */
export function changeReturnReplacement(
  id: string,
  body: {
    expectedRevision: number;
    lines: { exchangeLineId: string; itemId: string | null; quantity: number }[];
    reason: string;
    whenShort: 'refuse' | 'backorder';
    /** Desk check F6: where it goes when the original site is refused. */
    replacement?: { fulfillmentType: 'pickup' | 'delivery'; deliveryCharterId: string | null };
  },
): Promise<ReplacementAnswer<{ changed: boolean; mode: 'substitute' | 'reissue' | null }>> {
  return replacementCall(id, '', body);
}

/** The revision the screen shows is required (desk check F7): a stale one is return_changed. */
export function cancelReturnReplacement(
  id: string,
  body: { expectedRevision: number; reason: string },
): Promise<ReplacementAnswer<{ changed: boolean; drawn: boolean; inTransit: boolean }>> {
  return replacementCall(id, '/cancel', body);
}

/**
 * Whether a new exchange may be asked for right now (the kill switch), read
 * when the create-return sheet opens (desk check F9: never the whole order
 * for every completed order the screen opens). Any failure answers false:
 * the sheet then offers a return only, and the server decides anyway.
 */
export async function getExchangeSwitch(): Promise<boolean> {
  try {
    const res = await api<{ exchangesEnabled?: boolean }>('/api/v1/returns/exchange-switch');
    return res.exchangesEnabled === true;
  } catch {
    return false;
  }
}

/**
 * "Close as return only" after a replacement cancel (desk check F9): the
 * exchange ends for good. The revision the screen shows is required.
 */
export function declineReturnReplacement(
  id: string,
  body: { expectedRevision: number; reason: string },
): Promise<ReplacementAnswer<{ changed: boolean; declined: number }>> {
  return replacementCall(id, '/decline', body);
}

/**
 * Release the replacement order the screen shows (desk check F7): after a
 * substitution or a re-issue the server answers return_changed rather than
 * releasing an order the user has not seen.
 */
export function releaseReturnReplacement(
  id: string,
  orderId: string,
  reason: string,
): Promise<ReplacementAnswer<{ changed: boolean; replay: boolean; notNeeded: boolean; orderId: string | null }>> {
  return replacementCall(id, '/release', { orderId, reason });
}

export interface MobilePrepareAnswer {
  orderId: string;
  ran: { step: string; outcome: 'done' | 'already' | 'refused'; reason?: string; message?: string }[];
  status: string;
  fulfillmentType: 'pickup' | 'delivery';
}

export function prepareReturnReplacement(id: string): Promise<ReplacementAnswer<MobilePrepareAnswer>> {
  return replacementCall(id, '/prepare', {});
}

function candidatesPath(base: string, line: string, q: string): string {
  const params = [`line=${encodeURIComponent(line)}`];
  if (q.trim().length >= 2) params.push(`q=${encodeURIComponent(q.trim())}`);
  return `${base}?${params.join('&')}`;
}

/** The replacement picker for one returned line of an RMA. */
export async function getReturnCandidates(id: string, line: string, q: string): Promise<ExchangeCandidatesAnswer> {
  return parseExchangeCandidates(await api<unknown>(candidatesPath(`/api/v1/returns/${encodeURIComponent(id)}/candidates`, line, q)));
}

/** The same before the RMA exists (the create sheet's Exchange choice). */
export async function getOrderExchangeCandidates(orderId: string, line: string, q: string): Promise<ExchangeCandidatesAnswer> {
  return parseExchangeCandidates(
    await api<unknown>(candidatesPath(`/api/v1/orders/${encodeURIComponent(orderId)}/exchange-candidates`, line, q)),
  );
}

/** One key per opened create sheet (the server replays a resend of it). */
export function mintReturnKey(): string {
  return randomRequestUuid();
}

// ── Words for a refusal ────────────────────────────────────────────────────

/**
 * The sentence for a failed request: by `details.reason` through core's
 * error map; a network failure or a timeout says so; anything else the
 * route's own message, else a generic sentence.
 */
export function describeReturnError(e: unknown): string {
  if (e instanceof ApiError) {
    const details = e.details as { reason?: unknown; detail?: unknown } | undefined;
    const reason = details?.reason;
    if (typeof reason === 'string' && reason !== 'failed') {
      // The refusal's structured detail goes to core too: some words come
      // from it (exchange_already_sent: what the original line has left,
      // review fix S1).
      const detail = details?.detail;
      const mapped = mapReturnError({ hint: reason, details: detail && typeof detail === 'object' ? JSON.stringify(detail) : null });
      if (mapped.reason !== 'internal_error') return mapped.message;
    }
    if (e.status === 401) return mapReturnError({ hint: 'unauthenticated' }).message;
    if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
    return e.message || 'Something went wrong. Try again.';
  }
  if (e instanceof Error && /network|fetch|timed? ?out/i.test(e.message)) {
    return "Couldn't reach StockPilot. Check your connection and try again.";
  }
  return 'Something went wrong. Try again.';
}

/** The refusal's database reason, when the server sent one. */
export function returnErrorReason(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const reason = (e.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : null;
}
