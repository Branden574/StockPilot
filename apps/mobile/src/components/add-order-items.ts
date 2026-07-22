import { can, type Permission, type Role } from '@stockpilot/core';

import { searchWordGroups } from '../lib/count-picker';
import { listStatusPredicate } from '../lib/expected-items';
import { extractApiErrorMessage } from '../lib/po-import-approve';

/**
 * Pure decision/validation helpers for the native "add items to an existing
 * order" sheet (components/add-order-items-sheet.tsx). Kept free of
 * React/react-native imports so the gate, the picker query plan, the payload
 * builder and the error mapping are unit-testable exactly like
 * count-picker.ts / order-returns.ts.
 *
 * Server contract these build against (PINNED — apps/web .../orders/[id]/lines):
 *   POST /api/v1/orders/[id]/lines  { lines: [{ itemId, quantity }] }
 *     → 200 { ok: true, added, merged, pickSlipStale }
 * The route hands straight to OrderRequestsService.addLines, the SAME method
 * the web server action calls, so every rule below is a COSMETIC mirror of a
 * server-enforced one — never the boundary.
 */

// ── Gate ────────────────────────────────────────────────────────────────────

/**
 * Statuses that freeze an order's contents. addLines throws `conflict` on
 * every one of them: once the goods are out the door (or the order is dead)
 * the extra items belong on a NEW order.
 */
export const ADD_LINES_BLOCKED_STATUSES = [
  'in_transit',
  'completed',
  'denied',
  'cancelled',
] as const;

/** zod caps on the route body — clamped client-side so a pointless 400 is
 *  never round-tripped. */
export const ADD_LINES_MAX_LINES = 200;
export const ADD_LINES_MAX_QUANTITY = 100_000;

/** Load-more page size, matching COUNT_PICKER_PAGE_SIZE. */
export const ADD_ITEMS_PAGE_SIZE = 50;

/** Whether the order's contents are frozen. Also gates the stale-pick-slip
 *  prompt: on a shipped or dead order a reprint is moot. */
export function isAddLinesBlockedStatus(status: string | null): boolean {
  if (status === null) return true;
  return (ADD_LINES_BLOCKED_STATUSES as readonly string[]).includes(status);
}

export interface AddItemsGateInput {
  /** order_requests.status, or null while the order is still loading. */
  status: string | null;
  /** order_requests.requester_user_id — the id, not the rendered label. */
  requesterUserId: string | null;
  viewerUserId: string | null;
  viewerRole: Role | null;
  /** Effective permission set; `undefined` while it loads (falls back to the
   *  static role defaults inside `can`, same as every other mobile gate). */
  permissions: ReadonlySet<Permission> | undefined;
  ordersModuleEnabled: boolean;
}

/**
 * Whether to offer "Add items" — the cosmetic mirror of addLines' own gates:
 * orders module on, status not frozen, and the viewer is either the order's
 * requester or holds orders:approve. `orders:request` alone is deliberately
 * NOT enough: it would let any requester grow somebody else's order.
 */
export function canAddOrderItems(input: AddItemsGateInput): boolean {
  if (!input.ordersModuleEnabled) return false;
  if (isAddLinesBlockedStatus(input.status)) return false;
  const isRequester =
    input.requesterUserId !== null &&
    input.viewerUserId !== null &&
    input.requesterUserId === input.viewerUserId;
  if (isRequester) return true;
  if (input.viewerRole === null) return false;
  return can({ role: input.viewerRole, permissions: input.permissions }, 'orders:approve');
}

/**
 * Whether a pick slip printed earlier no longer matches the order — any line
 * created after the slip was generated. Derived, never stored, using the same
 * rule OrderRequestsService.get() applies for the web page, because
 * GET /api/v1/orders/[id] does not forward the service's `pickSlipStale`.
 */
export function derivePickSlipStale(
  pickSlipGeneratedAt: string | null,
  lines: readonly { createdAt: string | null }[],
): boolean {
  if (pickSlipGeneratedAt === null) return false;
  return lines.some((l) => l.createdAt !== null && l.createdAt > pickSlipGeneratedAt);
}

/**
 * Whether the stale-pick-slip banner belongs on screen.
 *
 * derivePickSlipStale alone is not enough. When an add only TOPS UP items
 * already on the order, addLines UPDATEs quantity_requested on the existing
 * rows and inserts nothing — no created_at moves, so the derived rule reports
 * false even though the printed slip now understates the quantities. The route
 * says so (its own pickSlipStale is simply "a slip was printed"), and the
 * post-add alert repeats it; without this the very next load() wiped that
 * warning within a second and the picker worked from the stale sheet.
 *
 * The route's verdict is therefore carried forward against the SLIP IT WAS
 * ABOUT: once pick_slip_generated_at moves, the slip has been reprinted and the
 * warning has to clear on its own, which a plain sticky boolean would never do.
 */
export function shouldShowStalePickSlip(input: {
  /** derivePickSlipStale over the freshly loaded lines. */
  derived: boolean;
  /** order_requests.pick_slip_generated_at as of the last load. */
  pickSlipGeneratedAt: string | null;
  /** The slip stamp that was current when an add reported pickSlipStale. */
  staleReportedForSlipAt: string | null;
  status: string | null;
}): boolean {
  // On a shipped or dead order a reprint is moot.
  if (isAddLinesBlockedStatus(input.status)) return false;
  if (input.derived) return true;
  return (
    input.staleReportedForSlipAt !== null &&
    input.pickSlipGeneratedAt === input.staleReportedForSlipAt
  );
}

// ── Picker query plan ───────────────────────────────────────────────────────

/**
 * Declarative plan for one page of the picker list. The sheet applies this to
 * the Supabase builder verbatim; keeping it as data means the predicate set is
 * asserted in tests without mocking PostgREST.
 */
export interface AddItemsPickerPlan {
  /** `.eq('awaiting_first_receipt', …)` — always false: addLines explicitly
   *  rejects mig-0277 phantoms, so offering one is a guaranteed 400. */
  awaitingFirstReceipt: boolean;
  /** `.eq('status', …)` — always 'active'; you cannot order archived stock. */
  lifecycle: 'active' | 'archived' | null;
  /** One PostgREST `.or()` group per query word; PostgREST ANDs the groups,
   *  giving the Items tab's word-AND search across name/sku/barcode. */
  orGroups: string[];
  /** `.range(from, to)` for 50-per-page load-more paging. */
  range: { from: number; to: number };
}

/**
 * Build the query plan for one page of the picker.
 *
 * Visibility is derived from the SAME `listStatusPredicate('all')` the Items
 * tabs and the cycle-count picker use, so the three can never drift. The
 * warehouse predicate is NOT in here on purpose: it is the ORDER's warehouse
 * (a caller argument), not the workspace's active one, and conflating the two
 * would offer items addLines is certain to reject.
 */
export function addItemsPickerPlan(query: string, offset: number): AddItemsPickerPlan {
  const pred = listStatusPredicate('all');
  return {
    awaitingFirstReceipt: pred.awaitingFirstReceipt,
    lifecycle: pred.lifecycle,
    orGroups: searchWordGroups(query),
    range: { from: offset, to: offset + ADD_ITEMS_PAGE_SIZE - 1 },
  };
}

// ── Draft quantities → request body ─────────────────────────────────────────

/** Step one item's draft quantity, clamped to [0, ADD_LINES_MAX_QUANTITY].
 *  Zero means "not selected" — the row drops out of the payload. */
export function stepAddQuantity(current: number, delta: number): number {
  const next = Math.floor(current) + delta;
  return Math.max(0, Math.min(ADD_LINES_MAX_QUANTITY, next));
}

export interface AddLinesRequestLine {
  itemId: string;
  quantity: number;
}

export type AddLinesPayload =
  | { ok: true; lines: AddLinesRequestLine[] }
  | { ok: false; error: string };

/**
 * Turn the sheet's per-item draft into the route body, refusing locally what
 * the route's zod schema would reject anyway (empty selection, over 200 lines)
 * so the user gets an instant, actionable message instead of a 400.
 */
export function buildAddLinesPayload(draft: Readonly<Record<string, number>>): AddLinesPayload {
  const lines: AddLinesRequestLine[] = [];
  for (const [itemId, raw] of Object.entries(draft)) {
    const quantity = Math.max(0, Math.min(ADD_LINES_MAX_QUANTITY, Math.floor(raw)));
    if (quantity > 0) lines.push({ itemId, quantity });
  }
  if (lines.length === 0) {
    return { ok: false, error: 'Choose at least one item and set a quantity above zero.' };
  }
  if (lines.length > ADD_LINES_MAX_LINES) {
    return {
      ok: false,
      error: `You can add up to ${ADD_LINES_MAX_LINES} items at a time. Remove some and submit again.`,
    };
  }
  return { ok: true, lines };
}

// ── Result + error copy ─────────────────────────────────────────────────────

export interface AddLinesResult {
  added: number;
  merged: number;
  pickSlipStale: boolean;
}

/**
 * Post-add confirmation. `merged` is the count of items that were ALREADY on
 * the order and got topped up rather than duplicated — surfacing it is the
 * only way the user can tell why the line count did not grow.
 */
export function addedSummary(result: AddLinesResult): string {
  const parts: string[] = [];
  if (result.added > 0) {
    parts.push(`${result.added} new ${result.added === 1 ? 'line' : 'lines'}`);
  }
  if (result.merged > 0) {
    parts.push(`${result.merged} existing ${result.merged === 1 ? 'line' : 'lines'} topped up`);
  }
  const head = parts.length > 0 ? `Added ${parts.join(' and ')}.` : 'The order was updated.';
  return result.pickSlipStale
    ? `${head} The pick slip printed earlier no longer matches this order. Generate it again before picking.`
    : head;
}

/**
 * Server error → copy the user can act on. addLines returns a friendly
 * `message` for every 4xx, so that wins; this map only covers responses that
 * carry a BARE code (500 is `{"error":"internal_error"}` with no message, and
 * 401 is `{"error":"unauthenticated"}`), where extractApiErrorMessage would
 * otherwise surface the raw slug to the user.
 */
const ADD_LINES_CODE_COPY = new Map<string, string>([
  ['unauthenticated', 'Your session has expired. Sign in again to add items.'],
  ['forbidden', 'Only the requester or someone who can approve orders may add items to it.'],
  ['module_disabled', 'Orders are turned off for this workspace.'],
  ['not_found', 'This order no longer exists. Go back and refresh the orders list.'],
  ['validation_error', 'One of the items cannot be added to this order. Remove it and try again.'],
  ['conflict', 'This order has moved on and can no longer be changed. Pull to refresh.'],
  ['plan_limit_exceeded', 'This workspace has reached its plan limit. Contact an administrator.'],
  ['rate_limited', 'Too many requests. Wait a moment and try again.'],
  ['internal_error', 'Something went wrong on our side. Try again in a moment.'],
]);

export function describeAddLinesError(e: unknown): string {
  const msg = extractApiErrorMessage(e, 'Could not add the items. Please try again.');
  // A Map, not an object literal: a server body echoing something like
  // "constructor" must not resolve through Object.prototype.
  return ADD_LINES_CODE_COPY.get(msg) ?? msg;
}

/**
 * HTTP status carried by an api() failure — it throws
 * `Error("API <status>: <body>")`. Returns null for a network/timeout error,
 * which never reached the server.
 */
export function addLinesErrorStatus(e: unknown): number | null {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = /^API (\d{3}):/.exec(raw);
  if (!m || m[1] === undefined) return null;
  return Number(m[1]);
}

/**
 * Whether the failure means the viewer's picture of the order is stale — it
 * shipped, was cancelled, vanished, or their role changed mid-session. Those
 * cannot be fixed by editing the draft, so the sheet closes and the screen
 * reloads (which re-runs the gate and drops the button). A 400/429/500/timeout
 * is recoverable in place, so the draft is kept.
 */
export function addLinesErrorIsTerminal(e: unknown): boolean {
  const status = addLinesErrorStatus(e);
  return status === 401 || status === 403 || status === 404 || status === 409;
}

/**
 * Whether the failure carried NO HTTP status — api()'s 20s timeout aborted the
 * request, or the socket dropped, so we never heard the server's answer.
 *
 * This is NOT a plain retry case. addLines applies one UPDATE per merged item
 * plus one INSERT with no surrounding transaction, and it is not idempotent: a
 * request that committed just after the client gave up would be applied a
 * SECOND time on retry, silently doubling every quantity on the order. So the
 * sheet must not sit there inviting the same submit — the user has to look at
 * the order first.
 */
export function addLinesErrorIsIndeterminate(e: unknown): boolean {
  return addLinesErrorStatus(e) === null;
}

/** Copy for the indeterminate case. States the uncertainty and the next step. */
export const ADD_LINES_INDETERMINATE_TITLE = 'Check the order before adding again';
export const ADD_LINES_INDETERMINATE_COPY =
  'We did not hear back from the server, so these items may already have been added. ' +
  'The order has been refreshed — check its lines, and add only what is missing.';
