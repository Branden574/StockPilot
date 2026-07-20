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

export type ReturnDisposition = 'restock' | 'scrap';
export type ReturnReasonCode = 'damaged' | 'wrong_item' | 'end_of_year' | 'overage' | 'other';

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
