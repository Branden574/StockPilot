/**
 * DRAFT A PO FOR WHAT AN ORDER IS SHORT, ON THE PHONE (F2-5, migration
 * 0385): every decision the order screen's readiness card and the draft sheet
 * make, pure and tested here (the sheet and the screen import native modules,
 * so vitest cannot render them; order-f2-5-wiring.test.ts pins them to this
 * module).
 *
 * The rules are core's (orders/shortfall-po.ts), the web dialog's own: who
 * may draft (canDraftShortfallPo: a manager holding purchase_orders:manage,
 * with the orders and purchase_orders modules on), the rows (shortfallPoView
 * over readiness), the selection and its checks, the drafts it makes and the
 * footer, the idempotency key (the same request keeps its key, any edit
 * mints a new one), the answer's parser and every sentence. Only the phone's
 * own control words (Cancel, Close, the quantity field's name, what a created
 * draft's row does) and the sentences for failures only the phone meets (an
 * answer this build cannot read, the route's rate limit) are worded here.
 *
 * The request goes through POST /api/v1/orders/[id]/shortfall-po (Bearer),
 * the web action's twin: the database drafts one PO per supplier plus one for
 * the items with no supplier, all or nothing, and REFUSES a quantity above
 * what may be drafted now (shortfall_changed, with the current numbers); it
 * never lowers one. After such a refusal the sheet reads readiness again and
 * keeps what the person chose, with the new maxima shown as problems.
 *
 * Drafts are not sent and nothing here composes mail. Offline, Draft is off
 * and says it needs a connection. Pure: no React Native import, no Supabase
 * client (the screen and the sheet pass their clients in).
 */

import {
  canDraftShortfallPo,
  checkShortfallSelection,
  formatReadinessQty,
  keepShortfallSelection,
  parseShortfallChangedDetail,
  READINESS_NEEDS_CONNECTION_COPY,
  readinessCheckedAtCopy,
  SHORTFALL_PO_BUTTON_ACCESSIBILITY_LABEL,
  SHORTFALL_PO_BUTTON_LABEL,
  SHORTFALL_PO_BUSY_COPY,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_PO_CONFLICT_COPY,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_FORBIDDEN_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY,
  SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY,
  SHORTFALL_PO_NOT_APPLICABLE_COPY,
  SHORTFALL_PO_NOT_FOUND_COPY,
  SHORTFALL_PO_NOTHING_LEFT_COPY,
  SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY,
  SHORTFALL_PO_SIGN_IN_COPY,
  shortfallDraftGroups,
  shortfallPoCreatedCopy,
  shortfallPoCreatedRowCopy,
  shortfallPoFooterCopy,
  ShortfallPoResultShapeError,
  shortfallPoRetryable,
  shortfallPoView,
  shortfallRowAccessibilityLabel,
  shortfallSupplierLabel,
  type OrderReadinessResult,
  type ShortfallChoice,
  type ShortfallKeyState,
  type ShortfallPoFailureReason,
  type ShortfallPoLine,
  type ShortfallPoResult,
  type ShortfallPoRow,
  type ShortfallPoView,
  type ShortfallSelection,
} from '@stockpilot/core';

// ── The phone's own words ───────────────────────────────────────────────────

/** The quantity field's visible name (the web dialog's column header). */
export const SHORTFALL_QUANTITY_LABEL = 'Quantity';
/** The web dialog's buttons, before and after drafting. */
export const SHORTFALL_CANCEL_LABEL = 'Cancel';
export const SHORTFALL_CLOSE_LABEL = 'Close';
/** A created draft's row, for VoiceOver: what tapping it does. */
export const SHORTFALL_OPEN_DRAFT_HINT = 'Opens this draft PO';
/** The route answered 200, but not in a shape this build can read (an app
 *  older or newer than the server): the drafts may exist. The web action
 *  never meets this. Readiness is read again, so what is on a draft shows. */
export const SHORTFALL_UNREADABLE_COPY =
  "The drafts may have been created, but the answer couldn't be read. What is already on a draft is shown; check it before drafting again.";
/** The route's rate limit (20 a minute per person; the web action has none). */
export const SHORTFALL_TOO_MANY_COPY = 'Too many requests. Wait a moment and try again.';

// ── Who is offered it, on the readiness card ────────────────────────────────

export type ShortfallPoOffer =
  | { kind: 'none' }
  /** "Draft PO for what is short": opens the sheet. */
  | { kind: 'button'; label: string; accessibilityLabel: string }
  /** Core's sentence, for someone who sees the panel but may not draft. */
  | { kind: 'needs_permission'; message: string };

/**
 * What the readiness card offers, the web strip's rule
 * (readinessStripShortfallPo): nothing unless something on the order may be
 * drafted (a picked or closed order, a failed or capped check, nothing short,
 * everything short already on a PO or a draft, purchase orders off: nothing);
 * then the button for a manager holding purchase_orders:manage with both
 * modules on, and core's sentence ("Drafting a PO needs a manager with
 * purchase-order access.") for anyone else on the full panel. A module the
 * phone has not confirmed is not a missing permission: it offers nothing
 * rather than the wrong reason. The server checks all of it again.
 */
export function shortfallPoOffer(input: {
  readiness: OrderReadinessResult | null;
  /** The full readiness panel is shown (core readinessAudience 'full'). */
  fullPanel: boolean;
  isManager: boolean;
  canManagePurchaseOrders: boolean;
  ordersModule: boolean;
  purchaseOrdersModule: boolean;
}): ShortfallPoOffer {
  const r = input.readiness;
  if (!input.fullPanel || !r || r.state !== 'ok' || r.assessment.phase !== 'to_pick') return { kind: 'none' };
  const view = shortfallPoView(r.assessment);
  if (view.unavailable !== null || view.draftableCount === 0) return { kind: 'none' };
  if (canDraftShortfallPo(input)) {
    return {
      kind: 'button',
      label: SHORTFALL_PO_BUTTON_LABEL,
      accessibilityLabel: SHORTFALL_PO_BUTTON_ACCESSIBILITY_LABEL,
    };
  }
  if (!(input.isManager && input.canManagePurchaseOrders)) {
    return { kind: 'needs_permission', message: SHORTFALL_PO_FORBIDDEN_COPY };
  }
  return { kind: 'none' };
}

// ── Opening ─────────────────────────────────────────────────────────────────

/** Whether two views offer different things to draft (a row's state or its
 *  most): the web dialog's test for saying the numbers moved. */
export function shortfallViewsDiffer(a: ShortfallPoView, b: ShortfallPoView): boolean {
  const key = (v: ShortfallPoView) =>
    v.rows
      .map((r) => `${r.itemId.toLowerCase()}:${r.state}:${r.draftable}`)
      .sort()
      .join('|');
  return key(a) !== key(b);
}

/**
 * The rows the sheet opens on. The screen's readiness is what the button was
 * offered from; readiness read again as the sheet opens (the web dialog reads
 * it on open too) is used when it answered, and when it offers something else
 * the sheet says core's "Stock or POs changed since you looked. The most that
 * can be drafted now is shown." A failed re-read opens on the screen's rows.
 * Null when there is nothing to open on. Frozen once open: a reload behind the
 * sheet never swaps the rows in front of the person.
 */
export function shortfallSheetOpening(
  shown: OrderReadinessResult | null,
  fresh: OrderReadinessResult | null,
): { view: ShortfallPoView; notice: string | null; changed: boolean } | null {
  if (!shown || shown.state !== 'ok' || shown.assessment.phase !== 'to_pick') return null;
  const before = shortfallPoView(shown.assessment);
  if (before.unavailable !== null) return null;
  if (!fresh || fresh.state !== 'ok') return { view: before, notice: null, changed: false };
  const now = shortfallPoView(fresh.assessment);
  const changed = now.unavailable !== null || shortfallViewsDiffer(before, now);
  return { view: now, notice: changed ? SHORTFALL_PO_CHANGED_COPY : null, changed };
}

// ── The sheet's rows ────────────────────────────────────────────────────────

export interface ShortfallSheetRow {
  itemId: string;
  name: string;
  sku: string | null;
  /** "Short 12 · already on order or draft 4", or what covers it, or why not. */
  detail: string;
  /** The supplier as core names it; null for a row that is not draftable. */
  supplier: string | null;
  draftable: boolean;
  checked: boolean;
  /** The quantity field (draftable rows only). */
  quantity: string;
  /** What is wrong with a chosen row's quantity (core's words), or null. */
  problem: string | null;
  /** The checkbox, read aloud: the item, its numbers and its supplier. */
  accessibilityLabel: string;
  /** The quantity field's spoken name and hint. */
  quantityAccessibilityLabel: string;
  quantityAccessibilityHint: string;
}

export interface ShortfallSheetView {
  rows: ShortfallSheetRow[];
  /** "1 item isn't visible to you, so it can't be drafted." */
  hiddenNote: string | null;
  /** Why nothing is short any more (core's sentence), or null. */
  unavailable: string | null;
  /** "Checked at 2:14 PM. Stock can change after this." */
  checkedAt: string;
  /** "Creates 2 draft POs, one per supplier. Drafts are not sent. ...";
   *  null when nothing on the order can be drafted. */
  footer: string | null;
  /** Something on the order may be drafted (a row can be chosen). */
  offersDraft: boolean;
  /** Draft may be pressed now. */
  canDraft: boolean;
  /** Why Draft is off (its VoiceOver hint), or null. */
  draftBlockedBy: string | null;
  /** The request Draft sends (only when `canDraft`). */
  lines: ShortfallPoLine[];
}

/** A supplier as the sheet names it: core's words for none, the name read
 *  when the sheet opened, or core's "couldn't be loaded". */
export function shortfallSupplierText(supplierId: string | null, names: ReadonlyMap<string, string>): string {
  return shortfallSupplierLabel(supplierId, names);
}

/**
 * What the sheet shows for a selection: every short item (the draftable ones
 * with a checkbox and a quantity, the rest unchecked and disabled with what
 * covers them or why not), each chosen quantity's problem in core's words,
 * the footer counting exactly the drafts the call will make, and whether
 * Draft may be pressed (and why not: offline first, then the first problem,
 * then nothing chosen).
 */
export function shortfallSheetView(input: {
  view: ShortfallPoView;
  selection: ShortfallSelection;
  supplierNames: ReadonlyMap<string, string>;
  timeZone?: string | null;
  offline: boolean;
  busy: boolean;
  /** Nothing in the sheet can help any more (a refusal that closes it). */
  closed: boolean;
}): ShortfallSheetView {
  const { view, selection, supplierNames } = input;
  const check = checkShortfallSelection(view, selection);
  const rows: ShortfallSheetRow[] = view.rows.map((r) => {
    const draftable = r.state === 'draftable';
    const choice: ShortfallChoice | undefined = selection[r.itemId];
    const supplier = draftable ? shortfallSupplierText(r.supplierId, supplierNames) : null;
    return {
      itemId: r.itemId,
      name: r.itemName,
      sku: r.itemSku,
      detail: r.detail,
      supplier,
      draftable,
      checked: draftable && !!choice?.checked,
      quantity: draftable ? (choice?.quantity ?? String(r.draftable)) : '',
      problem: draftable && choice?.checked ? (check.problems[r.itemId] ?? null) : null,
      accessibilityLabel: shortfallRowAccessibilityLabel(r, supplier ?? ''),
      quantityAccessibilityLabel: `${SHORTFALL_QUANTITY_LABEL}, ${r.itemName}`,
      quantityAccessibilityHint: `Up to ${formatReadinessQty(r.draftable)} can be drafted.`,
    };
  });
  const offersDraft = view.draftableCount > 0;
  // The drafts the chosen rows make (the database's grouping), counted from
  // every chosen row, a quantity still being fixed included (the grouping
  // reads only the supplier).
  const chosen: ShortfallPoLine[] = rows.filter((r) => r.checked).map((r) => ({ itemId: r.itemId, quantity: 0 }));
  const footer = offersDraft ? shortfallPoFooterCopy(shortfallDraftGroups(view, chosen)) : null;
  const firstProblem = rows.find((r) => r.problem !== null)?.problem ?? null;
  const draftBlockedBy = !offersDraft
    ? null
    : input.offline
      ? READINESS_NEEDS_CONNECTION_COPY
      : firstProblem !== null
        ? firstProblem
        : !check.ok
          ? SHORTFALL_PO_INVALID_COPY
          : null;
  const canDraft = offersDraft && !input.offline && !input.busy && !input.closed && check.ok;
  return {
    rows,
    hiddenNote: view.hiddenNote,
    unavailable: view.unavailableCopy,
    checkedAt: readinessCheckedAtCopy(view.observedAt, { timeZone: input.timeZone ?? undefined }),
    footer,
    offersDraft,
    canDraft,
    draftBlockedBy,
    lines: canDraft ? check.lines : [],
  };
}

/** The checkbox pressed: chosen or not, the quantity kept as typed. */
export function toggleShortfallChoice(
  selection: ShortfallSelection,
  view: ShortfallPoView,
  itemId: string,
): ShortfallSelection {
  const row = view.rows.find((r) => r.itemId === itemId);
  if (!row || row.state !== 'draftable') return selection;
  const prev = selection[itemId];
  return {
    ...selection,
    [itemId]: { checked: !prev?.checked, quantity: prev?.quantity ?? String(row.draftable) },
  };
}

/** A quantity typed (kept exactly as typed; the check says what is wrong). */
export function setShortfallQuantity(
  selection: ShortfallSelection,
  view: ShortfallPoView,
  itemId: string,
  text: string,
): ShortfallSelection {
  const row = view.rows.find((r) => r.itemId === itemId);
  if (!row || row.state !== 'draftable') return selection;
  const prev = selection[itemId];
  return { ...selection, [itemId]: { checked: prev?.checked ?? true, quantity: text } };
}

/**
 * The server's current maxima (shortfall_changed's `details.current`) laid
 * over the view the sheet shows, for when readiness could not be read again:
 * a row may be drafted up to the server's number and no further, and a row
 * with nothing left is no longer offered. Never raises a maximum.
 */
export function applyShortfallMaxima(view: ShortfallPoView, current: Readonly<Record<string, number>>): ShortfallPoView {
  const rows = view.rows.map((r): ShortfallPoRow => {
    if (r.state !== 'draftable') return r;
    const now = current[r.itemId.toLowerCase()];
    const max = typeof now === 'number' && Number.isFinite(now) ? Math.max(0, Math.min(now, r.draftable)) : 0;
    if (max > 0) return { ...r, draftable: max };
    return { ...r, draftable: 0, state: 'covered', detail: SHORTFALL_PO_NOTHING_LEFT_COPY };
  });
  return { ...view, rows, draftableCount: rows.filter((r) => r.state === 'draftable').length };
}

/**
 * After a refusal that re-read readiness: the new view with the person's
 * choices kept (core keepShortfallSelection: quantities never lowered, the
 * new maxima shown as problems; a row with nothing left unchosen).
 */
export function adoptShortfallView(
  selection: ShortfallSelection,
  view: ShortfallPoView,
): { view: ShortfallPoView; selection: ShortfallSelection } {
  return { view, selection: keepShortfallSelection(selection, view).selection };
}

// ── The idempotency key ─────────────────────────────────────────────────────

/** A fresh key for one request (a replay identity, not a secret). */
export function mintShortfallKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `shortfall-${c.randomUUID()}`;
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return `shortfall-${hex}`;
}

// ── Drafting ────────────────────────────────────────────────────────────────

/** POST /api/v1/orders/[id]/shortfall-po's body. */
export interface DraftShortfallPoBody {
  lines: ShortfallPoLine[];
  idempotencyKey: string;
}

export interface ShortfallPoDeps {
  draft: (orderId: string, body: DraftShortfallPoBody) => Promise<ShortfallPoResult>;
  /** Readiness read again (the phone's readOrderReadiness; never throws). */
  reread: (orderId: string) => Promise<OrderReadinessResult>;
}

/** The phone's PO screen for a draft (read-only for a draft: po-draft-review.ts). */
export interface ShortfallDraftRoute {
  pathname: '/po/[id]';
  params: { id: string };
}

/** A created draft, as the sheet lists it. */
export interface ShortfallCreatedRow {
  purchaseOrderId: string;
  /** "PO-2026-0005 · 2 lines, 7 units" */
  label: string;
  /** Its supplier (core's words; the web dialog shows it under the link). */
  supplier: string;
  /** Both, for VoiceOver. */
  accessibilityLabel: string;
  route: ShortfallDraftRoute;
}

export type ShortfallSubmitResult =
  | { kind: 'created'; result: ShortfallPoResult; message: string }
  | {
      kind: 'refused';
      reason: ShortfallPoFailureReason | 'unreadable' | 'rate_limited' | 'unauthenticated';
      message: string;
      /** The key stands for nothing now: mint a new one next time. */
      dropKey: boolean;
      /** Nothing in the sheet can help: Draft goes, Close stays. */
      closed: boolean;
      /** Readiness read again, when the refusal means the numbers or the
       *  order moved: the sheet shows it and keeps what the person chose. */
      view?: ShortfallPoView;
      /** Read the order again behind the sheet. */
      refresh: boolean;
    };

const REASONS: ReadonlySet<string> = new Set<ShortfallPoFailureReason>([
  'shortfall_changed',
  'item_not_draftable',
  'line_not_on_order',
  'not_applicable',
  'idempotency_conflict',
  'busy',
  'forbidden',
  'not_found',
  'module_disabled',
  'invalid',
  'failed',
]);

/** Refusals after which readiness is read again: the numbers, the order or
 *  its items moved under the sheet (the web dialog's set). */
const REREAD: ReadonlySet<string> = new Set([
  'shortfall_changed',
  'item_not_draftable',
  'line_not_on_order',
  'not_applicable',
]);

/** Refusals nothing in the sheet can fix. */
const CLOSING: ReadonlySet<string> = new Set(['not_applicable', 'forbidden', 'not_found', 'module_disabled']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A sentence a person can read (the route's messages are core's); a lone
 *  snake_case token or an empty string is not one. */
function sentence(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const m = message.trim();
  if (m === '' || /^[a-z0-9_]+$/.test(m)) return null;
  return m;
}

/** Core's sentence for a refusal the server named without one it sent. */
function fallbackCopy(reason: ShortfallPoFailureReason): string {
  switch (reason) {
    case 'shortfall_changed':
      return SHORTFALL_PO_CHANGED_COPY;
    case 'item_not_draftable':
      return SHORTFALL_PO_ITEM_NOT_DRAFTABLE_COPY;
    case 'line_not_on_order':
      return SHORTFALL_PO_LINE_NOT_ON_ORDER_COPY;
    case 'not_applicable':
      return SHORTFALL_PO_NOT_APPLICABLE_COPY;
    case 'idempotency_conflict':
      return SHORTFALL_PO_CONFLICT_COPY;
    case 'busy':
      return SHORTFALL_PO_BUSY_COPY;
    case 'forbidden':
      return SHORTFALL_PO_FORBIDDEN_COPY;
    case 'not_found':
      return SHORTFALL_PO_NOT_FOUND_COPY;
    case 'module_disabled':
      return SHORTFALL_PO_PURCHASE_ORDERS_OFF_COPY;
    case 'invalid':
      return SHORTFALL_PO_INVALID_COPY;
    default:
      return SHORTFALL_PO_FAILED_COPY;
  }
}

/** The created drafts as rows that open the phone's PO screen, each with its
 *  supplier as the web dialog shows it. */
export function shortfallCreatedRows(
  result: ShortfallPoResult,
  supplierNames: ReadonlyMap<string, string>,
): ShortfallCreatedRow[] {
  return result.created.map((c) => {
    const label = shortfallPoCreatedRowCopy(c);
    const supplier = shortfallSupplierText(c.supplierId, supplierNames);
    return {
      purchaseOrderId: c.purchaseOrderId,
      label,
      supplier,
      accessibilityLabel: `${label}. ${supplier.replace(/\.$/, '')}.`,
      route: { pathname: '/po/[id]', params: { id: c.purchaseOrderId } },
    };
  });
}

async function rereadView(deps: ShortfallPoDeps, orderId: string): Promise<ShortfallPoView | null> {
  try {
    const r = await deps.reread(orderId);
    if (r.state !== 'ok') return null;
    return shortfallPoView(r.assessment);
  } catch {
    return null;
  }
}

/**
 * Draft: POST the chosen lines with the request's key, and say what
 * happened (the web dialog's rules).
 *   - Created (or a replay of the same request): core's sentence from the
 *     ANSWER, never from what was asked.
 *   - shortfall_changed, item_not_draftable, line_not_on_order,
 *     not_applicable: the numbers or the order moved. Readiness is read again
 *     and returned, so the sheet shows the new maxima and keeps the person's
 *     choices; when it cannot be read, the server's own maxima
 *     (details.current) are laid over the rows. An order that moved past
 *     drafting closes the sheet.
 *   - No answer (offline mid-request, a timeout): core's "couldn't be
 *     created just now. Try again.", as the web says, and the key is KEPT:
 *     the same request again either makes the drafts or answers with the ones
 *     already made, never both.
 *   - busy and a fault keep the key too (core shortfallPoRetryable); every
 *     other refusal drops it, so the next Draft is a new request.
 *   - An answer this build cannot read: the drafts may exist; readiness is
 *     read again so what is on a draft shows, and the key is kept.
 * Never throws.
 */
export async function submitShortfallPo(
  deps: ShortfallPoDeps,
  input: { orderId: string; lines: ShortfallPoLine[]; key: ShortfallKeyState; shown: ShortfallPoView },
): Promise<ShortfallSubmitResult> {
  try {
    const result = await deps.draft(input.orderId, { lines: input.lines, idempotencyKey: input.key.key });
    return { kind: 'created', result, message: shortfallPoCreatedCopy(result) };
  } catch (e) {
    const status = isRecord(e) && typeof e.status === 'number' ? e.status : null;

    if (e instanceof ShortfallPoResultShapeError) {
      const view = await rereadView(deps, input.orderId);
      return {
        kind: 'refused',
        reason: 'unreadable',
        message: SHORTFALL_UNREADABLE_COPY,
        dropKey: false,
        closed: false,
        ...(view ? { view } : {}),
        refresh: true,
      };
    }
    if (status === null) {
      return { kind: 'refused', reason: 'failed', message: SHORTFALL_PO_FAILED_COPY, dropKey: false, closed: false, refresh: false };
    }
    if (status === 429) {
      return { kind: 'refused', reason: 'rate_limited', message: SHORTFALL_TOO_MANY_COPY, dropKey: false, closed: false, refresh: false };
    }
    if (status === 401) {
      return { kind: 'refused', reason: 'unauthenticated', message: SHORTFALL_PO_SIGN_IN_COPY, dropKey: true, closed: true, refresh: false };
    }

    const details = isRecord(e) && isRecord(e.details) ? e.details : null;
    const named =
      details && typeof details.reason === 'string' && REASONS.has(details.reason)
        ? (details.reason as ShortfallPoFailureReason)
        : null;
    const said = sentence(isRecord(e) ? e.message : null);

    if (named) {
      const message = named === 'failed' ? SHORTFALL_PO_FAILED_COPY : (said ?? fallbackCopy(named));
      const base = {
        kind: 'refused' as const,
        reason: named,
        message,
        dropKey: !shortfallPoRetryable(named),
        closed: CLOSING.has(named),
        refresh: CLOSING.has(named) || REREAD.has(named),
      };
      if (!REREAD.has(named)) return base;
      let view = await rereadView(deps, input.orderId);
      if (!view && named === 'shortfall_changed') {
        const current = parseShortfallChangedDetail(details?.current ?? null);
        if (current) view = applyShortfallMaxima(input.shown, current);
      }
      // The order moved past drafting (picked, closed, nothing short now).
      const gone = view !== null && view.unavailable !== null;
      return { ...base, closed: base.closed || gone, ...(view ? { view } : {}) };
    }

    // An answer with no named refusal: the MFA step-up (403, the server's
    // sentence), a server fault, or a server from before F2-5 (no route).
    if (status === 403) {
      return { kind: 'refused', reason: 'forbidden', message: said ?? SHORTFALL_PO_FORBIDDEN_COPY, dropKey: true, closed: true, refresh: false };
    }
    return { kind: 'refused', reason: 'failed', message: SHORTFALL_PO_FAILED_COPY, dropKey: false, closed: false, refresh: false };
  }
}

// ── Supplier names ──────────────────────────────────────────────────────────

export interface SupplierNamesClient {
  from(table: string): unknown;
}

interface SupplierNamesChain {
  select(columns: string): SupplierNamesChain;
  eq(column: string, value: string): SupplierNamesChain;
  is(column: string, value: null): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * The organization's supplier names, as the web dialog reads them
 * (SuppliersService.listForLookups: its suppliers that are not archived, and
 * none when the suppliers module is off), read beside readiness when the
 * sheet opens. Never throws: a failed read is an empty map, and a row whose
 * supplier it does not name says core's "Its supplier (the name couldn't be
 * loaded)."
 */
export async function readShortfallSupplierNames(
  client: SupplierNamesClient,
  input: { organizationId: string; suppliersModule: boolean },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!input.suppliersModule) return out;
  try {
    const res = await (client.from('suppliers') as SupplierNamesChain)
      .select('id, name')
      .eq('organization_id', input.organizationId)
      .is('deleted_at', null);
    if (!res || res.error || !Array.isArray(res.data)) return out;
    for (const row of res.data as unknown[]) {
      if (!isRecord(row)) continue;
      if (typeof row.id === 'string' && typeof row.name === 'string' && row.name.trim() !== '') {
        out.set(row.id, row.name);
      }
    }
    return out;
  } catch {
    return out;
  }
}
