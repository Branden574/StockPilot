import {
  mapReturnError,
  parseRestockOptions,
  randomRequestUuid,
  type ExchangeStatus,
  type InboundLeg,
  type RestockOptionsLine,
  type ReturnActions,
  type ReturnLineDecision,
  type ReturnListFilterId,
} from '@stockpilot/core';

import { api, ApiError } from './api';

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
  type: 'return';
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
  /** RX-2 adds it; absent means 'none'. */
  exchangeStatus?: ExchangeStatus;
}

export interface MobileReturnStepResult {
  step: 'approve' | 'receive' | 'process';
  outcome: 'done' | 'already' | 'refused';
  reason?: string;
  message?: string;
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
  return { ...raw, lines, chain: raw.chain ?? [], destinationsUnavailable };
}

// ── Writes (online only) ───────────────────────────────────────────────────

export interface ReturnStepsBody {
  steps: ('approve' | 'receive' | 'process')[];
  expectedRevision: number | null;
  expectedPlanSeq: number | null;
  approve?: { lines: ReturnLineDecision[] } | null;
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
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === 'string' && reason !== 'failed') {
      const mapped = mapReturnError({ hint: reason });
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
