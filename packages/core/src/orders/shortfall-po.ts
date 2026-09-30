/**
 * DRAFT A PO FOR THE SHORT LINES ONLY (F2-5, migration 0385).
 *
 * From an order's readiness, a buyer drafts purchase orders for exactly the
 * part of the order that nothing covers: not the stock on record, not an open
 * PO, not a draft. The database does the drafting
 * (draft_order_shortfall_pos): one draft per supplier plus one for the items
 * with no supplier, all or nothing, idempotent on a key, under the same lock
 * as the reorder drafts. It recomputes what may be drafted after that lock
 * and REFUSES anything above it (shortfall_changed, with the current
 * numbers); it never lowers a quantity on its own.
 *
 * What lives here, shared by the web dialog and the phone sheet:
 *   - who may draft (`canDraftShortfallPo`), the same floors as the database;
 *   - the view (`shortfallPoView`): one row per short item, what may be
 *     drafted for it, what already covers it, and why a row cannot be
 *     drafted;
 *   - the selection: defaults, quantity checks, the lines to send, and what
 *     is kept after a refusal;
 *   - the drafts the selection makes (`shortfallDraftGroups`, the database's
 *     grouping and order) and the footer sentence;
 *   - the idempotency key's lifecycle (minted for a request, reused for its
 *     retries, replaced on any edit);
 *   - the answer's parser, the refusals, and every sentence.
 *
 * The numbers come from readiness (readiness.ts itemQuantities: `draftable`,
 * the twin of order_shortfall_draftable in 0385, held equal by the shared
 * fixture). Honest words: "on record", never the accounting word; a draft is
 * "not sent" and "not ordered"; nothing says a supplier was told.
 */

import { formatOrderNumber } from './order-number';
import {
  READINESS_LINE_CAP,
  type OrderReadinessAssessment,
  type ReadinessItemAssessment,
  type ReadinessVisibleItemFacts,
} from './readiness';
import { formatReadinessQty } from './readiness-copy';

// ── Limits (the database refuses past them too) ─────────────────────────────

/** At most this many lines in one request (22023 line_invalid past it). */
export const SHORTFALL_PO_MAX_LINES = 200;
/** An idempotency key is at most this long (22023 idempotency_key_too_long). */
export const SHORTFALL_PO_KEY_MAX = 200;

const fq = formatReadinessQty;
const EPS = 0.00005;

function q4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

// ── Who may draft ───────────────────────────────────────────────────────────

/**
 * The database's floors, for the screens: a manager (idempotency keys are
 * manager-only), holding purchase_orders:manage, with the orders and
 * purchase_orders modules on. Write access to the order's warehouse is the
 * last floor; every manager has it today (user_can_access_inventory), and the
 * service checks it before calling. Anyone else sees
 * SHORTFALL_PO_FORBIDDEN_COPY instead of the button.
 */
export function canDraftShortfallPo(input: {
  isManager: boolean;
  canManagePurchaseOrders: boolean;
  ordersModule: boolean;
  purchaseOrdersModule: boolean;
}): boolean {
  return input.isManager && input.canManagePurchaseOrders && input.ordersModule && input.purchaseOrdersModule;
}

// ── Words ───────────────────────────────────────────────────────────────────

export const SHORTFALL_PO_BUTTON_LABEL = 'Draft PO for what is short';
export const SHORTFALL_PO_BUTTON_ACCESSIBILITY_LABEL = 'Draft a purchase order for what this order is short';
export const SHORTFALL_PO_TITLE = 'Draft a PO for what is short';
export const SHORTFALL_PO_SUBMIT_LABEL = 'Draft';
/** The order timeline's entry for order_request.shortfall_po_drafted. */
export const SHORTFALL_PO_TIMELINE_LABEL = 'Draft PO created for the shortfall';
/** The audit event the service writes on the order. */
export const SHORTFALL_PO_AUDIT_EVENT = 'order_request.shortfall_po_drafted';
/** The phone opens a draft read-only; it is edited and ordered on the web. */
export const SHORTFALL_PO_PHONE_REVIEW_COPY = 'Review and order this draft on the web.';
export const SHORTFALL_PO_NOT_SENT_COPY =
  'Drafts are not sent. Set the destination and order them on Purchase orders.';
export const SHORTFALL_NO_SUPPLIER_COPY =
  'No supplier: goes on a draft without one; choose a supplier before ordering.';
export const SHORTFALL_SUPPLIER_UNKNOWN_COPY = "Its supplier (the name couldn't be loaded).";

export const SHORTFALL_PO_FORBIDDEN_COPY = 'Drafting a PO needs a manager with purchase-order access.';
export const SHORTFALL_PO_NO_WAREHOUSE_ACCESS_COPY =
  "Drafting a PO for this order needs write access to the order's warehouse.";
export const SHORTFALL_PO_ORDERS_OFF_COPY = 'Orders are turned off for this organization.';
export const SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY = 'Purchase orders are turned off for this organization.';
export const SHORTFALL_PO_NOT_FOUND_COPY = 'Order not found.';
export const SHORTFALL_PO_SIGN_IN_COPY = 'Sign in again to draft a PO.';
/** A refusal after the numbers moved: the screens load the new maxima and
 *  keep what the person chose. */
export const SHORTFALL_PO_CHANGED_COPY =
  'Stock or POs changed since you looked. The most that can be drafted now is shown.';
export const SHORTFALL_PO_BUSY_COPY = 'Purchase orders were being changed at the same time. Try again.';
export const SHORTFALL_PO_NOT_APPLICABLE_COPY =
  "This order has been picked or closed, so there's no shortfall to draft.";
export const SHORTFALL_PO_LINES_CAPPED_COPY = `This order has more than ${READINESS_LINE_CAP} lines, so its shortfall isn't checked.`;
export const SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY =
  "One of these items can't be drafted any more: it was deleted, moved to another warehouse, is a kit, or isn't visible to you. Check again.";
export const SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY = 'One of these items is no longer on this order. Check again.';
export const SHORTFALL_PO_CONFLICT_COPY =
  'This request was already used for different quantities. Press Draft again.';
export const SHORTFALL_PO_INVALID_COPY = 'Choose at least one item, with a quantity above 0 for each.';
export const SHORTFALL_PO_FAILED_COPY = "The draft POs couldn't be created just now. Try again.";
export const SHORTFALL_PO_NOTHING_SHORT_COPY = 'Nothing on this order is short.';
export const SHORTFALL_PO_NOTHING_VISIBLE_SHORT_COPY = 'Nothing you can see on this order is short.';
export const SHORTFALL_PO_NOTHING_LEFT_COPY = 'Nothing is left to draft for this item.';

const KIT_COPY = 'Kits are built from their components, so order the components instead.';
const DELETED_COPY = "This item was deleted, so it can't be ordered. Remove the line.";
const MOVED_COPY = "This item now belongs to another warehouse, so it isn't drafted from this order.";

// ── The view ────────────────────────────────────────────────────────────────

export type ShortfallPoRowState =
  /** Something may be drafted (draftable > 0). */
  | 'draftable'
  /** Short, but open POs or drafts already cover it. */
  | 'covered'
  /** A kit's pre-assembled stock: never bought as a kit. */
  | 'kit'
  | 'deleted'
  /** The item belongs to another warehouse than the order. */
  | 'moved';

export interface ShortfallPoRow {
  itemId: string;
  itemName: string;
  itemSku: string | null;
  supplierId: string | null;
  /** Owed units the stock here does not cover. */
  short: number;
  /** Of `short`, already on an open PO or a draft (after other orders'
   *  committed shortfall took its share). */
  onOrderOrDraft: number;
  /** The most that may be drafted now (0 unless state is 'draftable'). */
  draftable: number;
  state: ShortfallPoRowState;
  /** "Short 12 · already on order or draft 4", "Already on PO-2026-0021 (40
   *  still to arrive)", or why it can't be drafted. */
  detail: string;
}

/** Why there is nothing to draft at all. */
export type ShortfallPoUnavailable = 'not_to_pick' | 'lines_capped' | 'po_module_off' | 'nothing_short';

export interface ShortfallPoView {
  orderId: string;
  /** "SO-000123", or null when the order has no number. */
  orderNumber: string | null;
  observedAt: string;
  /** One row per short item, in the order of the item's first line. */
  rows: ShortfallPoRow[];
  /** Rows with something to draft. */
  draftableCount: number;
  /** Items on the order the reader cannot read: never drafted, never shown. */
  hiddenItems: number;
  hiddenNote: string | null;
  unavailable: ShortfallPoUnavailable | null;
  unavailableCopy: string | null;
}

function unavailableCopy(u: ShortfallPoUnavailable, hidden: number): string {
  switch (u) {
    case 'not_to_pick':
      return SHORTFALL_PO_NOT_APPLICABLE_COPY;
    case 'lines_capped':
      return SHORTFALL_PO_LINES_CAPPED_COPY;
    case 'po_module_off':
      return SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY;
    case 'nothing_short':
      return hidden > 0 ? SHORTFALL_PO_NOTHING_VISIBLE_SHORT_COPY : SHORTFALL_PO_NOTHING_SHORT_COPY;
  }
}

function hiddenNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 item isn't visible to you, so it can't be drafted."
    : `${n} items aren't visible to you, so they can't be drafted.`;
}

/**
 * What already covers a short item that has nothing left to draft, in words:
 *   "Already on PO-2026-0021 (40 still to arrive)"
 *   "Already on 3 POs (52 still to arrive)"
 *   "Already on a PO you can't open"
 *   "Already on draft PO-2026-0043 (not ordered yet)"
 * and several of these joined with "and". A PO's number is named only when
 * the reader could open it (0377 lists those); the rest is a quantity only.
 */
export function shortfallCoveredByCopy(f: ReadinessVisibleItemFacts): string {
  const parts: string[] = [];
  const ib = f.inbound;
  if (ib) {
    const listed = ib.rows.length;
    const toArrive = q4(ib.rows.reduce((s, r) => s + r.remaining, 0) + ib.truncatedRemaining);
    if (listed === 1 && !ib.truncated) {
      parts.push(`${ib.rows[0]!.poNumber} (${fq(ib.rows[0]!.remaining)} still to arrive)`);
    } else if (listed > 0) {
      parts.push(`${ib.truncated ? `more than ${listed}` : listed} POs (${fq(toArrive)} still to arrive)`);
    }
    if (ib.hiddenRemaining > EPS) parts.push("a PO you can't open");
  }
  const dr = f.drafts;
  if (dr) {
    const listed = dr.rows.length;
    if (listed === 1 && !dr.truncated) parts.push(`draft ${dr.rows[0]!.poNumber} (not ordered yet)`);
    else if (listed > 0) parts.push(`${dr.truncated ? `more than ${listed}` : listed} draft POs (not ordered yet)`);
    if (dr.hiddenRemaining > EPS) parts.push("a draft you can't open (not ordered yet)");
  }
  if (parts.length === 0) return 'Already on order';
  return `Already on ${parts.join(' and ')}`;
}

function shortOf(it: ReadinessItemAssessment): number {
  const q = it.quantities;
  if (!q) return 0;
  // short0 = what stock does not cover: the awaited part plus the rest.
  return q4(q.awaiting + q.short);
}

/**
 * The dialog's rows, from an order's readiness assessment. Only items that
 * are short appear; an item the reader cannot read is counted, never named.
 */
export function shortfallPoView(assessment: OrderReadinessAssessment): ShortfallPoView {
  const base = {
    orderId: assessment.order.id,
    orderNumber: formatOrderNumber(assessment.order.orderNumber),
    observedAt: assessment.observedAt,
  };
  const empty = (u: ShortfallPoUnavailable, hidden = 0): ShortfallPoView => ({
    ...base,
    rows: [],
    draftableCount: 0,
    hiddenItems: hidden,
    hiddenNote: hiddenNote(hidden),
    unavailable: u,
    unavailableCopy: unavailableCopy(u, hidden),
  });
  if (assessment.phase !== 'to_pick') return empty('not_to_pick');
  if (assessment.linesCapped) return empty('lines_capped');

  // Items in the order of their first line.
  const firstLine = new Map<string, number>();
  for (const l of assessment.lines) {
    if (!firstLine.has(l.itemId)) firstLine.set(l.itemId, l.position);
  }
  const items = [...assessment.items].sort(
    (a, b) => (firstLine.get(a.itemId) ?? 0) - (firstLine.get(b.itemId) ?? 0),
  );
  const hidden = items.filter((it) => !it.visible || !it.facts).length;
  if (items.some((it) => it.facts && it.facts.inbound === null)) return empty('po_module_off', hidden);

  const rows: ShortfallPoRow[] = [];
  for (const it of items) {
    const f = it.facts;
    const q = it.quantities;
    if (!f || !q) continue;
    const short = shortOf(it);
    if (short <= EPS) continue;
    const common = {
      itemId: it.itemId,
      itemName: f.name,
      itemSku: f.sku,
      supplierId: f.supplierId,
      short,
    };
    if (it.blocked === 'item_deleted') {
      rows.push({ ...common, onOrderOrDraft: 0, draftable: 0, state: 'deleted', detail: DELETED_COPY });
    } else if (it.blocked === 'item_moved') {
      rows.push({ ...common, onOrderOrDraft: 0, draftable: 0, state: 'moved', detail: MOVED_COPY });
    } else if (f.isBundle) {
      rows.push({ ...common, onOrderOrDraft: 0, draftable: 0, state: 'kit', detail: KIT_COPY });
    } else if (q.draftable > EPS) {
      const covered = q4(short - q.draftable);
      rows.push({
        ...common,
        onOrderOrDraft: covered > EPS ? covered : 0,
        draftable: q.draftable,
        state: 'draftable',
        detail: covered > EPS ? `Short ${fq(short)} · already on order or draft ${fq(covered)}` : `Short ${fq(short)}`,
      });
    } else {
      rows.push({
        ...common,
        onOrderOrDraft: short,
        draftable: 0,
        state: 'covered',
        detail: shortfallCoveredByCopy(f),
      });
    }
  }
  const draftableCount = rows.filter((r) => r.state === 'draftable').length;
  return {
    ...base,
    rows,
    draftableCount,
    hiddenItems: hidden,
    hiddenNote: hiddenNote(hidden),
    unavailable: rows.length === 0 ? 'nothing_short' : null,
    unavailableCopy: rows.length === 0 ? unavailableCopy('nothing_short', hidden) : null,
  };
}

/** A row's supplier, as the dialog names it. */
export function shortfallSupplierLabel(
  supplierId: string | null,
  names: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  if (!supplierId) return SHORTFALL_NO_SUPPLIER_COPY;
  const name = names instanceof Map ? names.get(supplierId) : (names as Record<string, string>)[supplierId];
  return name && name.trim() !== '' ? name : SHORTFALL_SUPPLIER_UNKNOWN_COPY;
}

/** A row read aloud (VoiceOver, screen readers): the item, its numbers and
 *  its supplier, in one sentence. */
export function shortfallRowAccessibilityLabel(row: ShortfallPoRow, supplierLabel: string): string {
  const head = row.itemSku ? `${row.itemName}, ${row.itemSku}` : row.itemName;
  const sentence = (t: string) => `${t.replace(/\.$/, '')}.`;
  const parts = [sentence(head), sentence(row.detail)];
  if (row.state === 'draftable') {
    parts.push(`Up to ${fq(row.draftable)} can be drafted.`, sentence(`Supplier: ${supplierLabel}`));
  }
  return parts.join(' ');
}

// ── The selection ───────────────────────────────────────────────────────────

/** One item's choice in the dialog. `quantity` is what the field holds. */
export interface ShortfallChoice {
  checked: boolean;
  quantity: string;
}

export type ShortfallSelection = Readonly<Record<string, ShortfallChoice>>;

/** Every draftable row chosen, at its most. */
export function defaultShortfallSelection(view: ShortfallPoView): ShortfallSelection {
  const out: Record<string, ShortfallChoice> = {};
  for (const r of view.rows) {
    if (r.state === 'draftable') out[r.itemId] = { checked: true, quantity: String(r.draftable) };
  }
  return out;
}

export type ShortfallQuantityProblem = 'not_a_number' | 'not_positive' | 'too_many' | 'too_precise';

/** A quantity field's number, or null when it is not a plain number. */
export function parseShortfallQuantity(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function shortfallQuantityProblem(text: string, max: number): ShortfallQuantityProblem | null {
  const n = parseShortfallQuantity(text);
  if (n === null) return 'not_a_number';
  if (/\.\d{5,}$/.test(text.trim())) return 'too_precise';
  if (n <= 0) return 'not_positive';
  if (n > max + EPS) return 'too_many';
  return null;
}

export function shortfallQuantityProblemCopy(problem: ShortfallQuantityProblem, max: number): string {
  switch (problem) {
    case 'not_a_number':
      return 'Enter a number.';
    case 'too_precise':
      return 'Use at most 4 decimal places.';
    case 'not_positive':
      return 'Enter a quantity above 0.';
    case 'too_many':
      return max > EPS ? `At most ${fq(max)} can be drafted now.` : SHORTFALL_PO_NOTHING_LEFT_COPY;
  }
}

/** One line of the request (the API's and the action's shape). */
export interface ShortfallPoLine {
  itemId: string;
  quantity: number;
}

export interface ShortfallSelectionCheck {
  /** The lines to send, in row order (only when `ok`). */
  lines: ShortfallPoLine[];
  /** Per chosen item, what is wrong with its quantity. */
  problems: Record<string, string>;
  ok: boolean;
}

/** The chosen, draftable rows as request lines, with every problem named. */
export function checkShortfallSelection(view: ShortfallPoView, selection: ShortfallSelection): ShortfallSelectionCheck {
  const lines: ShortfallPoLine[] = [];
  const problems: Record<string, string> = {};
  for (const r of view.rows) {
    const c = selection[r.itemId];
    if (!c?.checked) continue;
    if (r.state !== 'draftable') {
      problems[r.itemId] = SHORTFALL_PO_NOTHING_LEFT_COPY;
      continue;
    }
    const p = shortfallQuantityProblem(c.quantity, r.draftable);
    if (p) {
      problems[r.itemId] = shortfallQuantityProblemCopy(p, r.draftable);
      continue;
    }
    lines.push({ itemId: r.itemId, quantity: q4(parseShortfallQuantity(c.quantity) as number) });
  }
  const ok = lines.length > 0 && lines.length <= SHORTFALL_PO_MAX_LINES && Object.keys(problems).length === 0;
  return { lines: ok ? lines : [], problems, ok };
}

/**
 * After a refusal (shortfall_changed) the screens read readiness again and
 * keep what the person chose: every choice and quantity stays, and the new
 * maxima show as problems to fix (never lowered silently). A chosen row with
 * nothing left to draft is unchosen, since there is nothing to keep; it is
 * listed in `unchosen` so the screen can say so.
 */
export function keepShortfallSelection(
  selection: ShortfallSelection,
  view: ShortfallPoView,
): { selection: ShortfallSelection; unchosen: string[] } {
  const out: Record<string, ShortfallChoice> = {};
  const unchosen: string[] = [];
  const byId = new Map(view.rows.map((r) => [r.itemId, r]));
  for (const [itemId, c] of Object.entries(selection)) {
    const r = byId.get(itemId);
    if (!r || r.state !== 'draftable') {
      if (c.checked) unchosen.push(itemId);
      continue;
    }
    out[itemId] = { ...c };
  }
  // Items that became draftable since: offered, not chosen for the person.
  for (const r of view.rows) {
    if (r.state === 'draftable' && !(r.itemId in out)) out[r.itemId] = { checked: false, quantity: String(r.draftable) };
  }
  return { selection: out, unchosen };
}

/** shortfall_changed's detail (the current draftable per item, `details.current`
 *  from the service), or null when it cannot be read. */
export function parseShortfallChangedDetail(raw: unknown): Record<string, number> | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    out[k.toLowerCase()] = n;
  }
  return out;
}

// ── The drafts a selection makes ────────────────────────────────────────────

export interface ShortfallDraftGroup {
  supplierId: string | null;
  itemIds: string[];
  units: number;
}

/**
 * One draft per supplier, the items with no supplier on one more: the
 * database's grouping, in its order (supplier id, the supplier-less last), so
 * the footer counts exactly the drafts the call will make.
 */
export function shortfallDraftGroups(view: ShortfallPoView, lines: readonly ShortfallPoLine[]): ShortfallDraftGroup[] {
  const supplierOf = new Map(view.rows.map((r) => [r.itemId, r.supplierId]));
  const groups = new Map<string, ShortfallDraftGroup>();
  for (const l of lines) {
    const s = supplierOf.get(l.itemId) ?? null;
    const key = s === null ? '' : s.toLowerCase();
    const g = groups.get(key) ?? { supplierId: s, itemIds: [], units: 0 };
    g.itemIds.push(l.itemId);
    g.units = q4(g.units + l.quantity);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([, g]) => ({ ...g, itemIds: [...g.itemIds].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1)) }));
}

/** The footer under the rows: how many drafts, and that none is sent. */
export function shortfallPoFooterCopy(groups: readonly ShortfallDraftGroup[]): string {
  const k = groups.length;
  if (k === 0) return 'Choose at least one item to draft.';
  const noSupplier = groups.some((g) => g.supplierId === null);
  if (k === 1) {
    return noSupplier
      ? 'Creates 1 draft PO, with no supplier. Drafts are not sent. Set its supplier and destination and order it on Purchase orders.'
      : 'Creates 1 draft PO. Drafts are not sent. Set its destination and order it on Purchase orders.';
  }
  const per = noSupplier ? 'one per supplier and one for the items with no supplier' : 'one per supplier';
  return `Creates ${k} draft POs, ${per}. ${SHORTFALL_PO_NOT_SENT_COPY}`;
}

// ── The idempotency key ─────────────────────────────────────────────────────

function keyQty(n: number): string {
  return String(q4(n));
}

/** What a request is, for its key: the order and its item:quantity pairs in
 *  item order (the database hashes the same). */
export function shortfallRequestSignature(orderId: string, lines: readonly ShortfallPoLine[]): string {
  const pairs = lines
    .map((l) => `${l.itemId.toLowerCase()}:${keyQty(l.quantity)}`)
    .sort()
    .join(',');
  return `${orderId.toLowerCase()}|${pairs}`;
}

export interface ShortfallKeyState {
  signature: string;
  key: string;
}

/**
 * The key for a request: the same request keeps its key (a retry after a lost
 * answer, a double tap, a retry after "try again"), and any edit gets a new
 * one. The database answers a repeated key with the first answer, and refuses
 * it for another request (idempotency_conflict).
 */
export function shortfallIdempotencyKey(
  prev: ShortfallKeyState | null,
  orderId: string,
  lines: readonly ShortfallPoLine[],
  mint: () => string,
): ShortfallKeyState {
  const signature = shortfallRequestSignature(orderId, lines);
  if (prev && prev.signature === signature) return prev;
  const key = mint();
  if (typeof key !== 'string' || key.trim() === '' || key.length > SHORTFALL_PO_KEY_MAX) {
    throw new Error('shortfallIdempotencyKey: mint() must return a key of 1 to 200 characters');
  }
  return { signature, key };
}

// ── The answer ──────────────────────────────────────────────────────────────

export interface ShortfallPoCreated {
  purchaseOrderId: string;
  poNumber: string;
  supplierId: string | null;
  lineCount: number;
  units: number;
  lines: ShortfallPoLine[];
}

/** draft_order_shortfall_pos's answer (0385). */
export interface ShortfallPoResult {
  orderId: string;
  orderNumber: number | null;
  created: ShortfallPoCreated[];
  /** A repeated key: the first call's answer; nothing was written now. */
  replay: boolean;
}

export class ShortfallPoResultShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortfallPoResultShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOf(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new ShortfallPoResultShapeError(`${where} is not an id`);
  return v;
}

function positive(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ShortfallPoResultShapeError(`${where} is not a quantity above 0`);
  }
  return v;
}

/**
 * Reads the answer. Throws ShortfallPoResultShapeError on a wrong shape (it
 * never guesses), and tolerates keys it does not know, so a later additive
 * change never breaks an older phone.
 */
export function parseShortfallPoResult(raw: unknown): ShortfallPoResult {
  if (!isRecord(raw)) throw new ShortfallPoResultShapeError('the answer is not an object');
  const orderNumber = raw.orderNumber;
  if (orderNumber !== null && orderNumber !== undefined && (typeof orderNumber !== 'number' || !Number.isFinite(orderNumber))) {
    throw new ShortfallPoResultShapeError('orderNumber is not a number');
  }
  if (typeof raw.replay !== 'boolean') throw new ShortfallPoResultShapeError('replay is not true or false');
  if (!Array.isArray(raw.created)) throw new ShortfallPoResultShapeError('created is not a list');
  const created = raw.created.map((c, i): ShortfallPoCreated => {
    if (!isRecord(c)) throw new ShortfallPoResultShapeError(`created[${i}] is not an object`);
    if (c.supplierId !== null && c.supplierId !== undefined && typeof c.supplierId !== 'string') {
      throw new ShortfallPoResultShapeError(`created[${i}].supplierId is not an id`);
    }
    if (typeof c.poNumber !== 'string' || c.poNumber.trim() === '') {
      throw new ShortfallPoResultShapeError(`created[${i}].poNumber is missing`);
    }
    const lines = Array.isArray(c.lines)
      ? c.lines.map((l, j) => {
          if (!isRecord(l)) throw new ShortfallPoResultShapeError(`created[${i}].lines[${j}] is not an object`);
          return { itemId: idOf(l.itemId, `created[${i}].lines[${j}].itemId`), quantity: positive(l.quantity, `created[${i}].lines[${j}].quantity`) };
        })
      : [];
    const lineCount = c.lineCount;
    if (typeof lineCount !== 'number' || !Number.isInteger(lineCount) || lineCount < 1) {
      throw new ShortfallPoResultShapeError(`created[${i}].lineCount is not a count`);
    }
    return {
      purchaseOrderId: idOf(c.purchaseOrderId, `created[${i}].purchaseOrderId`),
      poNumber: c.poNumber,
      supplierId: typeof c.supplierId === 'string' ? c.supplierId : null,
      lineCount,
      units: positive(c.units, `created[${i}].units`),
      lines,
    };
  });
  return {
    orderId: idOf(raw.orderId, 'orderId'),
    orderNumber: typeof orderNumber === 'number' ? orderNumber : null,
    created,
    replay: raw.replay,
  };
}

/** What the dialog and the sheet say once the drafts exist (from the answer,
 *  never from what the screen asked for). */
export function shortfallPoCreatedCopy(result: ShortfallPoResult): string {
  const n = result.created.length;
  if (n === 0) return 'No draft was created.';
  if (n === 1) {
    return `Created draft ${result.created[0]!.poNumber}. Drafts are not sent: set its destination and order it on Purchase orders.`;
  }
  return `Created ${n} draft POs: ${result.created.map((c) => c.poNumber).join(', ')}. Drafts are not sent: set their destinations and order them on Purchase orders.`;
}

/** One created draft, as a result row: "PO-2026-0005 · 2 lines, 7 units". */
export function shortfallPoCreatedRowCopy(c: ShortfallPoCreated): string {
  return `${c.poNumber} · ${c.lineCount} ${c.lineCount === 1 ? 'line' : 'lines'}, ${fq(c.units)} ${Math.abs(c.units - 1) < EPS ? 'unit' : 'units'}`;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/** The refusals a draft can meet, as the web action and the phone route carry
 *  them in `details.reason`. */
export type ShortfallPoFailureReason =
  | 'shortfall_changed'
  | 'item_not_draftable'
  | 'line_not_on_order'
  | 'not_applicable'
  | 'idempotency_conflict'
  | 'busy'
  | 'forbidden'
  | 'not_found'
  | 'module_disabled'
  | 'invalid'
  | 'failed';

/** Whether pressing Draft again with the SAME request (and key) can help. */
export function shortfallPoRetryable(reason: ShortfallPoFailureReason): boolean {
  return reason === 'busy' || reason === 'failed';
}
