/**
 * The ORDER's view of its returns — what an order detail page (web) and the
 * order screen (phone) say about units that came back after hand-over.
 *
 * WHY THIS EXISTS (SO-000085, 2026-08-17). A delivered three-line order had a
 * return (RMA) that restocked one line's unit; the order page showed a clean
 * "1 / 1 / 1 fulfilled, owed 0" with nothing about the return, and the swap
 * that motivated it lived only in the return's free-text notes. Two facts had
 * to become visible ON THE ORDER, and both surfaces had to say them the same
 * way:
 *
 *   1. per line, how many of the shipped units were returned (and on which
 *      RMA), stated NEXT TO the shipped count — never folded into it;
 *   2. an order-level summary that states the NET the requester holds per the
 *      records, plus the list of the order's returns with their notes.
 *
 * DO NOT REWRITE HISTORY. `quantity_fulfilled` means SHIPPED and it did ship;
 * a return is a LATER event. Nothing here mutates or re-derives the fulfilled
 * number — every function below only adds the returned figure beside it and
 * derives display strings from the two.
 *
 * WHAT COUNTS AS RETURNED (the rule the surfaces pin). A unit is returned only
 * when the return line was APPLIED: `process_return_disposition` (migration
 * 0197) moves stock, bumps `order_request_lines.returned_quantity` and latches
 * `return_lines.applied = true` in ONE transaction that also flips the header
 * `received -> closed`. So:
 *
 *   • `returned_quantity` on the order line IS the durable per-line returned
 *     total (0153) — the surfaces render that number;
 *   • a return line with `applied = false` — on a requested / approved /
 *     received header still in flight, or on a denied / cancelled one — moved
 *     no stock and counts for NOTHING in the returned figure. It is listed in
 *     the returns panel (with its status) so a manager sees one is in flight,
 *     but the line's returned count and the summary ignore it.
 *
 * Shared in core rather than written per platform because the sentence has to
 * be the same on web and on the phone (see pick-shortfall.ts for the same
 * reasoning); web renders it in a table cell and a strip, the phone in a
 * sub-line and a card, but the numbers and words come from here.
 */

/** Return lifecycle status (mirrors the 0153 `returns.status` CHECK). */
export type ReturnStatus =
  | 'requested'
  | 'approved'
  | 'received'
  | 'closed'
  | 'denied'
  | 'cancelled';

/** The status words the web badge shows — the phone prints the same ones. */
export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  received: 'Received',
  closed: 'Closed',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

/** Human label for a return status; unknown values pass through verbatim. */
export function returnStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return (RETURN_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** Reason-code labels (mirrors the 0153 `returns.reason_code` CHECK). */
export const RETURN_REASON_LABELS: Record<string, string> = {
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  end_of_year: 'End of year',
  overage: 'Overage',
  other: 'Other',
};

export function returnReasonLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return RETURN_REASON_LABELS[code] ?? code;
}

/** Disposition labels (mirrors the 0153 `return_lines.disposition` CHECK). */
export const RETURN_DISPOSITION_LABELS: Record<string, string> = {
  restock: 'Restock',
  scrap: 'Scrap',
};

export function returnDispositionLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return RETURN_DISPOSITION_LABELS[code] ?? code;
}

/** Statuses at which a return is still in flight (nothing moved yet). */
export const PENDING_RETURN_STATUSES: readonly ReturnStatus[] = [
  'requested',
  'approved',
  'received',
];

/** A `return_lines` row as either surface reads it (embedded on the header). */
export interface OrderReturnLineView {
  orderRequestLineId: string;
  /** inventory_items.id — the item that came back (stamped from the source
   *  order line at create; kept so a panel can name it even if the order line
   *  it points at is somehow gone). */
  itemId?: string | null;
  quantity: number | null | undefined;
  disposition: string;
  /** The 0197 latch: true only once stock moved (and returned_quantity was
   *  bumped) in the closing transaction. */
  applied: boolean;
}

/** A `returns` row as either surface reads it, with its lines embedded. */
export interface OrderReturnView {
  id: string;
  returnNumber: string | null;
  status: ReturnStatus | string;
  reasonCode: string | null;
  notes: string | null;
  createdAt: string;
  closedAt: string | null;
  lines: OrderReturnLineView[];
}

function n(v: number | null | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

/**
 * THE RULE: does this return line count as returned stock? Exactly the 0197
 * latch — nothing about the header status is consulted, because `applied` is
 * set in the same transaction that closes the header, and it is never set on
 * any other path. A denied / cancelled / in-flight return therefore has
 * `applied = false` on every line and counts for nothing.
 */
export function returnLineCountsAsReturned(line: Pick<OrderReturnLineView, 'applied'>): boolean {
  return line.applied === true;
}

/** Whether a return header is still in flight (listed as pending, not counted). */
export function isPendingReturn(status: ReturnStatus | string | null | undefined): boolean {
  return PENDING_RETURN_STATUSES.includes(status as ReturnStatus);
}

/** Per order line: which RMAs touched it, split by whether they applied. */
export interface LineReturnRefs {
  /** Applied lines: quantity that came back and the RMA numbers it came back on. */
  applied: { quantity: number; returnNumbers: string[] };
  /** In-flight (unapplied, header requested/approved/received) lines. */
  pending: { quantity: number; returnNumbers: string[] };
}

/** Display handle for a return: its number, or an id prefix for legacy rows. */
export function returnHandle(r: Pick<OrderReturnView, 'id' | 'returnNumber'>): string {
  return r.returnNumber ?? `Return ${r.id.slice(0, 8)}`;
}

/**
 * Join the order's returns back onto its lines by `order_request_line_id`.
 * Supplies the WHICH (RMA numbers) for the per-line returned figure — the
 * NUMBER itself is `returned_quantity` on the order line, which the surfaces
 * already read; the two agree by construction (0197 bumps one and latches the
 * other in the same statement block).
 */
export function returnRefsByLine(returns: readonly OrderReturnView[]): Map<string, LineReturnRefs> {
  const out = new Map<string, LineReturnRefs>();
  for (const r of returns) {
    const handle = returnHandle(r);
    const pendingHeader = isPendingReturn(r.status);
    for (const l of r.lines) {
      const qty = n(l.quantity);
      if (qty <= 0) continue;
      const entry = out.get(l.orderRequestLineId) ?? {
        applied: { quantity: 0, returnNumbers: [] },
        pending: { quantity: 0, returnNumbers: [] },
      };
      if (returnLineCountsAsReturned(l)) {
        entry.applied.quantity += qty;
        if (!entry.applied.returnNumbers.includes(handle)) entry.applied.returnNumbers.push(handle);
      } else if (pendingHeader) {
        entry.pending.quantity += qty;
        if (!entry.pending.returnNumbers.includes(handle)) entry.pending.returnNumbers.push(handle);
      }
      // Unapplied on a denied / cancelled header: history only. The panel
      // lists the return; the line says nothing about it.
      out.set(l.orderRequestLineId, entry);
    }
  }
  return out;
}

/** The three line columns the per-line wording reads. */
export interface LineFulfilmentInput {
  requested: number | null | undefined;
  /** quantity_fulfilled — SHIPPED. Never rewritten by a return. */
  fulfilled: number | null | undefined;
  /** order_request_lines.returned_quantity — the durable applied total. */
  returned: number | null | undefined;
}

/** "1 returned" — the fragment both surfaces print beside the shipped count. */
export function returnedFragment(returned: number | null | undefined): string | null {
  const r = n(returned);
  if (r <= 0) return null;
  return `${r} returned`;
}

/**
 * The phone's per-line sub-line (and the vocabulary web's cell follows).
 * With no returns the strings are byte-identical to what shipped before:
 *   partial   -> "1 provided · 2 owed"
 *   complete  -> "fulfilled"
 *   nothing   -> null
 * A returned figure is APPENDED — " · 1 returned" — never substituted, so
 * "fulfilled · 1 returned" reads as two events in order: it shipped, then one
 * came back. Owed is requested − fulfilled and is untouched by a return: the
 * order does not re-owe a unit that was shipped and then sent back.
 */
export function describeLineFulfilment(input: LineFulfilmentInput): string | null {
  const requested = n(input.requested);
  const fulfilled = n(input.fulfilled);
  const returnedText = returnedFragment(input.returned);
  let base: string | null = null;
  if (fulfilled > 0 && fulfilled < requested) {
    base = `${fulfilled} provided · ${requested - fulfilled} owed`;
  } else if (fulfilled >= requested && requested > 0) {
    base = 'fulfilled';
  }
  if (base === null) {
    // Nothing shipped (or a zero-quantity line): a returned figure here would
    // be a data inconsistency (returns are capped at fulfilled by the 0153
    // trigger); still surface it rather than hide it.
    return returnedText;
  }
  return returnedText ? `${base} · ${returnedText}` : base;
}

/** The order-level roll-up. Null when nothing was returned, so a caller can
 *  render on non-null and an order with no returns renders exactly as before. */
export interface OrderReturnSummary {
  totalFulfilled: number;
  totalReturned: number;
  /** Provided − returned, floored at 0: what the requester holds PER THE
   *  RECORDS. See ORDER_RETURN_SUMMARY_NOTE for the case where that differs
   *  from reality. */
  netHeld: number;
}

export function orderReturnSummary(
  lines: readonly Pick<LineFulfilmentInput, 'fulfilled' | 'returned'>[],
): OrderReturnSummary | null {
  let totalFulfilled = 0;
  let totalReturned = 0;
  for (const l of lines) {
    totalFulfilled += n(l.fulfilled);
    totalReturned += n(l.returned);
  }
  if (totalReturned <= 0) return null;
  return {
    totalFulfilled,
    totalReturned,
    netHeld: Math.max(0, totalFulfilled - totalReturned),
  };
}

/** "3 provided · 1 returned · net 2 with requester" */
export function formatOrderReturnSummary(s: OrderReturnSummary): string {
  return `${s.totalFulfilled} provided · ${s.totalReturned} returned · net ${s.netHeld} with requester`;
}

/**
 * The caveat printed with the summary (title/aria on web, a caption on the
 * phone). The net figure is arithmetic on records: it is right for a plain
 * return and WRONG for an in-person exchange recorded only in a return's notes
 * (the SO-000085 case — the swapped-in Medium exists on no order line). Until
 * an exchange is first-class, the honest thing is to say so and point at the
 * notes, which sit directly beneath.
 */
export const ORDER_RETURN_SUMMARY_NOTE =
  'Net is provided minus returned, counting only returns that were received and closed. A replacement handed over in person and recorded only in a return’s notes is not counted — read the return notes below.';

/** "1 × Women's Polo S — Restock · applied" (the panel's per-line row). */
export function describeReturnLine(input: {
  quantity: number | null | undefined;
  itemName: string | null | undefined;
  disposition: string;
  applied: boolean;
}): string {
  const name = input.itemName?.trim() || 'Unknown item';
  return `${n(input.quantity)} × ${name} — ${returnDispositionLabel(input.disposition)} · ${input.applied ? 'applied' : 'pending'}`;
}

/** Title / accessibility text for the per-line "N returned" figure. */
export function describeLineReturnRefs(
  returned: number | null | undefined,
  refs: LineReturnRefs | undefined,
): string | null {
  const fragment = returnedFragment(returned);
  if (!fragment) return null;
  const on = refs?.applied.returnNumbers ?? [];
  const pending = refs?.pending ?? { quantity: 0, returnNumbers: [] };
  const parts: string[] = [];
  parts.push(on.length > 0 ? `${fragment} on ${on.join(', ')}` : fragment);
  if (pending.quantity > 0) {
    parts.push(`${pending.quantity} pending on ${pending.returnNumbers.join(', ')}`);
  }
  return parts.join('; ');
}
