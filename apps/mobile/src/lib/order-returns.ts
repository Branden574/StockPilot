/**
 * Pure helpers for the native "Create return" flow on the order detail screen
 * (app/order/[id].tsx). Kept free of React/react-native imports so the budget
 * math and the payload builder are unit-testable exactly like
 * po-import-approve.ts / movement-note.ts.
 *
 * Server contract these build against (PINNED — 2026-07-20 returns-access plan):
 *   POST /api/v1/orders/[id]/returns
 *     { reasonCode?, notes?, lines: [{ orderRequestLineId, quantity,
 *       disposition: 'restock' | 'scrap' }] }
 *   → { ok: true, return: {...} }
 *
 * The budget math mirrors web's returnableLines derivation exactly
 * (RMAService.returnableLinesForOrder / the order-detail page): a line is
 * returnable only on a completed (or legacy delivered) order, only when it was
 * fulfilled, and only up to the DURABLE remaining budget
 * quantity_fulfilled − returned_quantity. returned_quantity accumulates at
 * apply-time on the immutable order line, so a cancelled prior return never
 * reclaims budget. The service + DB trigger remain authoritative — this is the
 * friendly client-side gate/cap.
 */

import {
  describeLineFulfilment,
  describeReturnLine,
  formatOrderReturnSummary,
  ORDER_RETURN_SUMMARY_NOTE,
  orderReturnSummary,
  returnHandle,
  returnLineCountsAsReturned,
  returnReasonLabel,
  returnRefsByLine,
  returnStatusLabel,
  RETURN_STATUS_LABELS,
  type OrderReturnLineView,
  type OrderReturnSummary,
  type OrderReturnView,
  type ReturnStatus,
} from '@stockpilot/core';

export type ReturnDisposition = 'restock' | 'scrap';
export type ReturnReasonCode = 'damaged' | 'wrong_item' | 'end_of_year' | 'overage' | 'other';

// ── The order's VIEW of its returns (owner report, SO-000085) ──────────────
//
// What the order screen says about units that came back after hand-over. The
// decisions — what counts as returned (the 0197 `applied` latch), the per-line
// sub-line wording, the order-level summary, the status/reason words — live in
// core (`order-returns-view.ts`) and are re-exported here so the screen imports
// ONE module for everything returns-shaped, and so the web suite can import
// THIS module and pin that the phone's decisions equal what the real web page
// renders for the same input. Nothing here is a second implementation.
export {
  describeLineFulfilment,
  describeReturnLine,
  formatOrderReturnSummary,
  ORDER_RETURN_SUMMARY_NOTE,
  orderReturnSummary,
  returnHandle,
  returnLineCountsAsReturned,
  returnReasonLabel,
  returnRefsByLine,
  returnStatusLabel,
  RETURN_STATUS_LABELS,
};
export type { OrderReturnLineView, OrderReturnSummary, OrderReturnView, ReturnStatus };

/**
 * The columns the screen selects for the order's returns — the same read the
 * web page's `loadOrderReturns` performs (returns + embedded return_lines,
 * RLS-scoped to the org member, oldest first). Kept as a constant so the
 * select string is testable and cannot drift from the parser below.
 */
export const ORDER_RETURNS_SELECT =
  'id, return_number, status, reason_code, notes, created_at, closed_at, lines:return_lines (id, order_request_line_id, item_id, quantity, disposition, applied)';

/** Raw PostgREST row shape for ORDER_RETURNS_SELECT (embed may be obj or array). */
export interface RawOrderReturnRow {
  id: string;
  return_number: string | null;
  status: string;
  reason_code: string | null;
  notes: string | null;
  created_at: string;
  closed_at: string | null;
  lines:
    | RawOrderReturnLineRow[]
    | RawOrderReturnLineRow
    | null;
}
export interface RawOrderReturnLineRow {
  id: string;
  order_request_line_id: string;
  item_id: string;
  quantity: number | string | null;
  disposition: string;
  applied: boolean | null;
}

/**
 * Map the raw rows to the shared view. `applied` is coerced with `=== true` —
 * the ONLY thing that makes a line count as returned is that latch, and a
 * null (never written) must read as not applied. Same mapping as web's
 * `loadOrderReturns`.
 */
export function parseOrderReturns(rows: readonly RawOrderReturnRow[] | null | undefined): OrderReturnView[] {
  return (rows ?? []).map((r) => {
    const rawLines = Array.isArray(r.lines) ? r.lines : r.lines ? [r.lines] : [];
    return {
      id: r.id,
      returnNumber: r.return_number ?? null,
      status: r.status,
      reasonCode: r.reason_code ?? null,
      notes: r.notes ?? null,
      createdAt: r.created_at,
      closedAt: r.closed_at ?? null,
      lines: rawLines.map((l) => ({
        orderRequestLineId: l.order_request_line_id,
        itemId: l.item_id,
        quantity: Number(l.quantity) || 0,
        disposition: l.disposition,
        applied: l.applied === true,
      })),
    };
  });
}

/**
 * Whether the screen should read the order's returns at all: only a completed
 * (or legacy delivered) order can carry one — cancel refuses completed orders
 * (0155) — so every other status pays nothing. Same predicate the web page
 * gates its read on (`orderIsReturnable`).
 */
export function shouldLoadOrderReturns(status: string | null | undefined): boolean {
  return Boolean(status) && RETURNABLE_ORDER_STATUSES.has(status as string);
}

/**
 * The returns section on the screen renders when there is anything to show:
 * at least one return to list, or the create affordance. Pure so the gate is
 * pinned rather than retyped in JSX.
 */
export function shouldShowReturnsSection(input: {
  returnsCount: number;
  canCreateReturn: boolean;
}): boolean {
  return input.returnsCount > 0 || input.canCreateReturn;
}

/**
 * The name the panel prints for a return line: the ORDER line's item name
 * (joined by order_request_line_id — the screen already holds the lines), else
 * an id prefix so a line whose order row is somehow gone is still legible.
 */
export function returnLineItemName(
  line: Pick<OrderReturnLineView, 'orderRequestLineId' | 'itemId'>,
  orderLines: readonly { orderRequestLineId: string | null; name: string }[],
): string | null {
  const match = orderLines.find((l) => l.orderRequestLineId === line.orderRequestLineId);
  if (match) return match.name;
  return line.itemId ? `Item ${line.itemId.slice(0, 8)}` : null;
}

/** "Other · Aug 17, 2026" — the reason + date caption under a return number. */
export function describeReturnMeta(r: Pick<OrderReturnView, 'reasonCode' | 'createdAt' | 'closedAt'>): string {
  const when = r.closedAt ?? r.createdAt;
  const d = new Date(when);
  const date = Number.isNaN(d.getTime()) ? when : d.toLocaleDateString();
  return `${returnReasonLabel(r.reasonCode)} · ${date}`;
}

/** Same options + labels as the web CreateReturnDialog's reason select. */
export const RETURN_REASONS: { value: ReturnReasonCode; label: string }[] = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'end_of_year', label: 'End of year' },
  { value: 'overage', label: 'Overage' },
  { value: 'other', label: 'Other' },
];

/** Returnable order statuses: the live terminal 'completed', plus the legacy
 *  'delivered' some older rows still carry (same set the service gates on). */
export const RETURNABLE_ORDER_STATUSES = new Set<string>(['completed', 'delivered']);

/** What the order screen already loads per line (ids + quantities + labels). */
export interface ReturnSourceLine {
  /** order_request_lines.id — null-safe because older cached rows may miss it. */
  orderRequestLineId: string | null;
  name: string;
  sku: string | null;
  quantityFulfilled: number;
  returnedQuantity: number;
}

/** A line with remaining budget > 0 — drives the sheet rows + stepper caps. */
export interface ReturnableLine {
  orderRequestLineId: string;
  name: string;
  sku: string | null;
  quantityFulfilled: number;
  /** Durable budget: quantity_fulfilled − returned_quantity. */
  quantityRemaining: number;
}

/**
 * The still-returnable lines for an order, mirroring web's derivation: empty
 * on any non-terminal status (the affordance hides), and only lines with a
 * positive remaining budget survive. Non-finite/negative inputs are treated
 * as 0 (defensive: cached or partially-loaded rows).
 */
export function returnableLines(
  status: string | null | undefined,
  lines: ReturnSourceLine[],
): ReturnableLine[] {
  if (!status || !RETURNABLE_ORDER_STATUSES.has(status)) return [];
  const out: ReturnableLine[] = [];
  for (const l of lines) {
    if (!l.orderRequestLineId) continue;
    const fulfilled = Number.isFinite(l.quantityFulfilled) ? Math.max(0, l.quantityFulfilled) : 0;
    if (fulfilled <= 0) continue;
    const returned = Number.isFinite(l.returnedQuantity) ? Math.max(0, l.returnedQuantity) : 0;
    const remaining = fulfilled - returned;
    if (remaining <= 0) continue;
    out.push({
      orderRequestLineId: l.orderRequestLineId,
      name: l.name,
      sku: l.sku,
      quantityFulfilled: fulfilled,
      quantityRemaining: remaining,
    });
  }
  return out;
}

/** Per-line sheet state: stepper quantity (0 = not returning) + disposition. */
export interface ReturnDraftLine {
  quantity: number;
  disposition: ReturnDisposition;
}

/** Initial sheet state: nothing selected (qty 0), disposition Restock. */
export function initialReturnDraft(lines: ReturnableLine[]): Record<string, ReturnDraftLine> {
  const out: Record<string, ReturnDraftLine> = {};
  for (const l of lines) {
    out[l.orderRequestLineId] = { quantity: 0, disposition: 'restock' };
  }
  return out;
}

/** Body of POST /api/v1/orders/[id]/returns (the pinned contract). */
export interface CreateReturnBody {
  reasonCode?: ReturnReasonCode;
  notes?: string;
  lines: {
    orderRequestLineId: string;
    quantity: number;
    disposition: ReturnDisposition;
  }[];
}

export type BuildReturnPayloadResult =
  | { ok: true; body: CreateReturnBody }
  | { ok: false; error: string };

/**
 * Validate the sheet state and build the POST body. Client-side mirror of the
 * web dialog's submit checks (≥1 selected line, integer quantities, per-line
 * remaining cap) so obvious mistakes never leave the device; the service's
 * durable-budget validation and the DB trigger stay authoritative.
 */
export function buildReturnPayload(input: {
  lines: ReturnableLine[];
  draft: Record<string, ReturnDraftLine>;
  reasonCode?: ReturnReasonCode | null;
  notes?: string;
}): BuildReturnPayloadResult {
  const selected: CreateReturnBody['lines'] = [];
  for (const l of input.lines) {
    const d = input.draft[l.orderRequestLineId];
    const qty = d?.quantity ?? 0;
    if (qty === 0) continue;
    if (!Number.isInteger(qty) || qty < 0) {
      return { ok: false, error: 'Quantities must be whole numbers.' };
    }
    if (qty > l.quantityRemaining) {
      return {
        ok: false,
        error: `Only ${l.quantityRemaining} of "${l.name}" can still be returned.`,
      };
    }
    selected.push({
      orderRequestLineId: l.orderRequestLineId,
      quantity: qty,
      disposition: d?.disposition ?? 'restock',
    });
  }
  if (selected.length === 0) {
    return { ok: false, error: 'Select at least one item to return.' };
  }
  const notes = input.notes?.trim();
  return {
    ok: true,
    body: {
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(notes ? { notes } : {}),
      lines: selected,
    },
  };
}
