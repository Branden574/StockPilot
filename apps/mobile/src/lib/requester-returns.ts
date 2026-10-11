/**
 * A MEMBER'S OWN RETURN OR EXCHANGE ON THE PHONE AND THE IPAD (returns RX-3,
 * plan RX-3 Phone; brief 6, 27, 28, 30, 32).
 *
 * The requester of a completed order (a member who does not manage returns:
 * a returns manager gets the staff "Create return", so there are never two
 * return buttons, the web order page's rule) opens "Return or exchange" on
 * their own order. Per line they choose how many come back and, while
 * exchanges are on, "Return only" or "Exchange for another size": the
 * order's other sizes load once, on the first Exchange (photo, size,
 * "Available" or "Not in stock right now", never a count); a line with no
 * other size offers "Request a different replacement: warehouse will
 * review." with a note. The order screen then shows the requester their own
 * requests in the server's sentences ("Your requests on this order").
 *
 * What the phone holds and sends:
 *   - the three member routes (requester-returns-api.ts): GET the sheet,
 *     POST for the sizes (no input at all, so no oracle), POST the request
 *     (core's requester schema; the server re-checks every line, item and
 *     quantity in one transaction, brief 6, and decides what is eligible);
 *   - ONLINE ONLY: nothing is queued (no outbox kind exists for a return);
 *     offline every send and every size load is disabled with "Needs a
 *     connection.";
 *   - the draft in MEMORY only (rememberRequesterDraft), per account,
 *     organization and order, never written to the device: closing the
 *     sheet keeps the choices for this app session, a sent request clears
 *     them (the plan's "drafts in memory"; the storefront's account-scoped
 *     draft storage is a cart store with its own write-ahead, not a general
 *     draft store);
 *   - ONE request key per draft, minted when the sheet first opens for the
 *     order and kept until the request is answered, so a resend after a lost
 *     answer replays the same RMA; a conflict (the key already used with
 *     other details) mints a new one.
 *
 * Every payload the phone reads is parsed here, defensively: unknown keys are
 * dropped, so nothing the screens draw can carry what a requester may not see
 * (core forbiddenRequesterKeys finds nothing in a parsed answer).
 *
 * Pure (no React, no react-native, no network) so vitest covers every
 * decision the sheet and the order screen make.
 */

import {
  parseExchangeStatus,
  parseReturnBody,
  qtyRequestedLabel,
  randomRequestUuid,
  REQUESTER_AVAILABILITY_WORDS,
  requesterEntryLabel,
  requesterReturnsView,
  requesterTrackingLineWords,
  RETURN_EXCHANGE_NOTE_MAX,
  RETURN_NOTES_MAX,
  RETURN_REASON_CODES,
  RETURNS_COPY,
  returnLineLabel,
  type RequesterExchangeLine,
  type RequesterExchangeOption,
  type RequesterExchangeOptionsAnswer,
  type RequesterPhoto,
  type RequesterReturnableLine,
  type RequesterReturnSheet,
  type RequesterTrackingExchange,
  type RequesterTrackingItem,
  type RequesterTrackingLine,
  type RequesterTrackingReturn,
  type ReturnStatus,
} from '@stockpilot/core';

import { RETURNABLE_ORDER_STATUSES, type OrderReturnView, type ReturnReasonCode } from './order-returns';

// ── Reading the answers (defensive) ─────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_STATES: readonly RequesterTrackingExchange['state'][] = ['requested', 'approved', 'declined', 'cancelled'];

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function wholeCount(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function id(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Only a web address is drawn (the server signs storage URLs; anything else is dropped). */
function webUrl(v: unknown): string | null {
  const t = text(v);
  return t && /^https?:\/\//i.test(t) ? t : null;
}

function present<T>(v: T | null): v is T {
  return v !== null;
}

export function parseRequesterPhoto(raw: unknown): RequesterPhoto | null {
  const o = obj(raw);
  const url = o ? webUrl(o.url) : null;
  if (!o || !url) return null;
  return { url, thumbUrl: webUrl(o.thumbUrl) };
}

/** The photo a list row draws: the stored thumbnail first, else the master. */
export function requesterPhotoUrl(photo: RequesterPhoto | null | undefined): string | null {
  return photo ? (photo.thumbUrl ?? photo.url) : null;
}

function parseReturnableLine(raw: unknown): RequesterReturnableLine | null {
  const o = obj(raw);
  const lineId = o ? id(o.orderRequestLineId) : null;
  if (!o || !lineId) return null;
  const remaining = wholeCount(o.quantityRemaining);
  // A line with nothing left to send back is not offered.
  if (remaining <= 0) return null;
  return {
    orderRequestLineId: lineId,
    name: text(o.name) ?? 'Item',
    sizeLabel: text(o.sizeLabel),
    photo: parseRequesterPhoto(o.photo),
    quantityFulfilled: Math.max(wholeCount(o.quantityFulfilled), remaining),
    quantityRemaining: remaining,
  };
}

function parseTrackingItem(raw: unknown): RequesterTrackingItem | null {
  const o = obj(raw);
  const name = o ? text(o.name) : null;
  if (!o || !name) return null;
  return { name, sizeLabel: text(o.sizeLabel), quantity: wholeCount(o.quantity) };
}

function parseTrackingExchange(raw: unknown): RequesterTrackingExchange | null {
  const o = obj(raw);
  if (!o) return null;
  const state = LINE_STATES.find((s) => s === o.state);
  if (!state) return null;
  return { state, replacement: parseTrackingItem(o.replacement), substituted: o.substituted === true };
}

function parseTrackingLine(raw: unknown): RequesterTrackingLine | null {
  const o = obj(raw);
  const returning = o ? parseTrackingItem(o.returning) : null;
  if (!o || !returning) return null;
  return { returning, exchange: o.exchange == null ? null : parseTrackingExchange(o.exchange) };
}

function parseTrackingReturn(raw: unknown): RequesterTrackingReturn | null {
  const o = obj(raw);
  const createdAt = o ? text(o.createdAt) : null;
  if (!o || !createdAt) return null;
  const sentences = Array.isArray(o.sentences) ? o.sentences.map(text).filter(present).slice(0, 4) : [];
  return {
    returnNumber: text(o.returnNumber),
    createdAt,
    // A status from a newer server passes through as it came: nothing here
    // branches on it (the screen prints the server's sentences).
    returnStatus: (typeof o.returnStatus === 'string' ? o.returnStatus : 'requested') as ReturnStatus,
    exchangeStatus: parseExchangeStatus(o.exchangeStatus),
    sentences,
    replacementOrderNumber: text(o.replacementOrderNumber),
    lines: Array.isArray(o.lines) ? o.lines.map(parseTrackingLine).filter(present) : [],
  };
}

/**
 * GET /api/v1/orders/[id]/return-request, read field by field into core's
 * RequesterReturnSheet (the organization and order ids the route echoes are
 * not kept). Null when the answer is not that shape.
 */
export function parseRequesterReturnSheet(raw: unknown): RequesterReturnSheet | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.lines) || !Array.isArray(o.tracking)) return null;
  const seen = new Set<string>();
  const lines: RequesterReturnableLine[] = [];
  for (const l of o.lines) {
    const line = parseReturnableLine(l);
    if (!line || seen.has(line.orderRequestLineId)) continue;
    seen.add(line.orderRequestLineId);
    lines.push(line);
  }
  return {
    orderNumber: text(o.orderNumber),
    requesterName: text(o.requesterName),
    exchangesEnabled: o.exchangesEnabled === true,
    lines,
    tracking: o.tracking.map(parseTrackingReturn).filter(present),
  };
}

function parseOption(raw: unknown): RequesterExchangeOption | null {
  const o = obj(raw);
  const itemId = o ? id(o.itemId) : null;
  if (!o || !itemId) return null;
  return {
    itemId,
    name: text(o.name) ?? 'Item',
    sizeLabel: text(o.sizeLabel),
    // Two states (D6): anything but "available" reads not in stock.
    availability: o.availability === 'available' ? 'available' : 'not_in_stock',
    photo: parseRequesterPhoto(o.photo),
  };
}

/**
 * POST /api/v1/orders/[id]/return-request/options, read into core's answer.
 * The options keep the server's order (already in size order). Null when the
 * answer is not that shape.
 */
export function parseRequesterExchangeOptions(raw: unknown): RequesterExchangeOptionsAnswer | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.lines)) return null;
  const lines: RequesterExchangeLine[] = [];
  const seenLines = new Set<string>();
  for (const l of o.lines) {
    const lo = obj(l);
    const lineId = lo ? id(lo.orderRequestLineId) : null;
    if (!lo || !lineId || seenLines.has(lineId) || !Array.isArray(lo.options)) continue;
    const seen = new Set<string>();
    const options: RequesterExchangeOption[] = [];
    for (const rawOption of lo.options) {
      const option = parseOption(rawOption);
      if (!option || seen.has(option.itemId)) continue;
      seen.add(option.itemId);
      options.push(option);
    }
    if (options.length === 0) continue;
    seenLines.add(lineId);
    lines.push({ orderRequestLineId: lineId, options });
  }
  return { exchangesEnabled: o.exchangesEnabled === true, lines };
}

/** POST /api/v1/orders/[id]/return-request's answer. Null when not that shape. */
export function parseRequesterReturnCreated(raw: unknown): { id: string; returnNumber: string | null; replay: boolean } | null {
  const o = obj(raw);
  const returnId = o ? id(o.id) : null;
  if (!o || !returnId) return null;
  return { id: returnId, returnNumber: text(o.returnNumber), replay: o.replay === true };
}

// ── Where the order screen's sheet stands ───────────────────────────────────

/**
 * Where the order screen's requester sheet stands (use-requester-return.ts):
 *   off      the viewer is not offered it (requesterReturnGate), nothing read;
 *   loading  being read (the last answer, if any, stays on screen);
 *   ready    the server's sheet: what can come back, the switch, own requests;
 *   failed   the read failed (the last answer, if any, stays): the button
 *            still opens the sheet, which asks again;
 *   closed   the server said the order is not one this person may ask about
 *            from here (signed out, Returns off, the one 404): nothing shows.
 */
export type RequesterSheetLoad =
  | { state: 'off' }
  | { state: 'loading'; sheet: RequesterReturnSheet | null }
  | { state: 'ready'; sheet: RequesterReturnSheet }
  | { state: 'failed'; sheet: RequesterReturnSheet | null; message: string }
  | { state: 'closed' };

/** The sheet the screen may draw now: the latest answer, kept while a read runs or after one failed. */
export function requesterLoadedSheet(load: RequesterSheetLoad): RequesterReturnSheet | null {
  return load.state === 'ready' || load.state === 'loading' || load.state === 'failed' ? load.sheet : null;
}

/**
 * The order screen's button and the sheet's title (core requesterEntryLabel,
 * the web's link, token page and portal): "Request a return" once the server
 * says exchanges are held back, else "Return or exchange" (also before the
 * server answered).
 */
export function requesterEntryWords(load: RequesterSheetLoad): string {
  return requesterEntryLabel(requesterLoadedSheet(load)?.exchangesEnabled ?? true);
}

// ── Who is offered it ──────────────────────────────────────────────────────

/**
 * Whether the viewer is offered the requester's "Return or exchange" on this
 * order: their OWN order (they are its requester), handed over (completed,
 * or the legacy delivered) with something handed over, in an organization
 * with Returns on, and they do not manage returns (a returns manager gets the
 * staff "Create return": never two return buttons, the web order page's
 * rule). Cosmetic: the member routes decide (another member's order, a
 * portal order and an order that cannot come back are the one 404).
 */
export function requesterReturnGate(input: {
  orderStatus: string | null | undefined;
  requesterUserId: string | null | undefined;
  viewerUserId: string | null | undefined;
  viewerCanManageReturns: boolean;
  returnsModuleOn: boolean;
  fulfilledTotal: number;
}): boolean {
  return (
    !!input.viewerUserId &&
    input.requesterUserId === input.viewerUserId &&
    !input.viewerCanManageReturns &&
    input.returnsModuleOn &&
    !!input.orderStatus &&
    RETURNABLE_ORDER_STATUSES.has(input.orderStatus) &&
    Number.isFinite(input.fulfilledTotal) &&
    input.fulfilledTotal > 0
  );
}

/**
 * Whether the "Return or exchange" button shows: never once the server said
 * the order is not one this person may ask about from here (closed); the
 * server's sheet decides once it has answered (something left to send back);
 * before that, offline, and when its read failed, the phone's own returnable
 * lines (the button then opens the sheet, which asks again).
 */
export function requesterButtonShown(input: {
  gate: boolean;
  load: RequesterSheetLoad;
  phoneReturnable: number;
}): boolean {
  if (!input.gate || input.load.state === 'closed') return false;
  const sheet = requesterLoadedSheet(input.load);
  return sheet ? sheet.lines.length > 0 : input.phoneReturnable > 0;
}

/**
 * The order screen's returns, as the requester reads them: core's one rule
 * with the web order page (requesterReturnsView; RX-3 fix round 1, desk
 * checks H1 and M2). The tracking ("Your requests on this order") shows for
 * the requester gate (their own handed-over order, Returns on, not a returns
 * manager), with returns:read too; the order's own card for an RMA the
 * tracking lists is dropped only for a viewer who cannot read returns (it
 * names the reason, the disposition and the staff notes, and would list the
 * same request twice). Returns staff made on their order keep the order's
 * card (the server does not track those for the requester, D15). Without
 * the tracking (the read failed) every return keeps the order's card.
 */
export function requesterOrderReturns(input: {
  returns: readonly OrderReturnView[];
  tracking: readonly RequesterTrackingReturn[] | null;
  requesterGate: boolean;
  canReadReturns: boolean;
}): { orderReturns: OrderReturnView[]; tracking: RequesterTrackingReturn[] } {
  return requesterReturnsView({
    returns: input.returns,
    tracking: input.tracking,
    showTracking: input.requesterGate,
    viewerCanReadReturns: input.canReadReturns,
  });
}

// ── The draft (memory only) ─────────────────────────────────────────────────

export type RequesterLineMode = 'return' | 'exchange';

export interface RequesterDraftLine {
  /** How many come back (0: this line is not part of the request). */
  quantity: number;
  mode: RequesterLineMode;
  /** The size chosen (a line with sizes). Kept while the line is a return only, so switching back restores it. */
  itemId: string | null;
  /** What the warehouse should know (a line with no other size). */
  note: string;
  /**
   * The replacement's quantity, 1 to the return quantity (brief 4); null
   * follows the return quantity (the web form's rule).
   */
  replacementQuantity: number | null;
}

export interface RequesterDraft {
  /** The request key: minted when the sheet first opens for the order, kept until the request is answered. */
  key: string;
  lines: Record<string, RequesterDraftLine>;
  reasonCode: ReturnReasonCode | null;
  notes: string;
}

const EMPTY_LINE: RequesterDraftLine = { quantity: 0, mode: 'return', itemId: null, note: '', replacementQuantity: null };

/**
 * A new draft: nothing coming back and every line a return only, except that
 * an order with ONE line that can still come back starts it at what is left
 * (the web form's and the staff create sheet's rule, web and phone).
 */
export function newRequesterDraft(
  lines: readonly Pick<RequesterReturnableLine, 'orderRequestLineId' | 'quantityRemaining'>[],
  key: string = randomRequestUuid(),
): RequesterDraft {
  const returnable = lines.filter((l) => Math.floor(l.quantityRemaining) > 0);
  const only = returnable.length === 1 ? returnable[0]! : null;
  const out: Record<string, RequesterDraftLine> = {};
  for (const l of lines) {
    out[l.orderRequestLineId] = { ...EMPTY_LINE, quantity: l === only ? Math.floor(l.quantityRemaining) : 0 };
  }
  return { key, lines: out, reasonCode: null, notes: '' };
}

function lineOf(draft: RequesterDraft, lineId: string): RequesterDraftLine {
  return draft.lines[lineId] ?? EMPTY_LINE;
}

function withLine(draft: RequesterDraft, lineId: string, line: RequesterDraftLine): RequesterDraft {
  return { ...draft, lines: { ...draft.lines, [lineId]: line } };
}

/**
 * A remembered draft against the sheet as it is now: only the lines that can
 * still come back, each quantity within what is left, and every line a
 * return only while exchanges are off. The key is kept.
 */
export function reconcileRequesterDraft(
  draft: RequesterDraft,
  sheet: Pick<RequesterReturnSheet, 'lines' | 'exchangesEnabled'>,
): RequesterDraft {
  const lines: Record<string, RequesterDraftLine> = {};
  for (const l of sheet.lines) {
    const d = lineOf(draft, l.orderRequestLineId);
    const quantity = Math.min(Math.max(0, Math.floor(d.quantity) || 0), l.quantityRemaining);
    lines[l.orderRequestLineId] = { ...d, quantity, mode: sheet.exchangesEnabled ? d.mode : 'return' };
  }
  return { ...draft, lines };
}

/**
 * A draft against the sizes the server just answered: a size no longer
 * offered is unchosen (the person picks again), and with exchanges off every
 * line is a return only.
 */
export function reconcileDraftWithOptions(draft: RequesterDraft, answer: RequesterExchangeOptionsAnswer): RequesterDraft {
  const offered = new Map(answer.lines.map((l) => [l.orderRequestLineId, new Set(l.options.map((o) => o.itemId))]));
  const lines: Record<string, RequesterDraftLine> = {};
  for (const [lineId, d] of Object.entries(draft.lines)) {
    const sizes = offered.get(lineId);
    lines[lineId] = {
      ...d,
      mode: answer.exchangesEnabled ? d.mode : 'return',
      itemId: d.itemId && sizes?.has(d.itemId) ? d.itemId : null,
    };
  }
  return { ...draft, lines };
}

/** One tap of a line's stepper: a whole number from 0 to what can come back. */
export function stepRequesterQuantity(
  draft: RequesterDraft,
  line: Pick<RequesterReturnableLine, 'orderRequestLineId' | 'quantityRemaining'>,
  delta: number,
): RequesterDraft {
  const d = lineOf(draft, line.orderRequestLineId);
  const quantity = Math.min(line.quantityRemaining, Math.max(0, (Math.floor(d.quantity) || 0) + delta));
  return withLine(draft, line.orderRequestLineId, { ...d, quantity });
}

export function setRequesterMode(draft: RequesterDraft, lineId: string, mode: RequesterLineMode): RequesterDraft {
  return withLine(draft, lineId, { ...lineOf(draft, lineId), mode });
}

export function chooseRequesterOption(draft: RequesterDraft, lineId: string, itemId: string): RequesterDraft {
  return withLine(draft, lineId, { ...lineOf(draft, lineId), mode: 'exchange', itemId });
}

/** The replacement's quantity as it is sent: the chosen one, never above the return quantity, never below 1. */
export function requesterReplacementQuantityOf(line: Pick<RequesterDraftLine, 'quantity' | 'replacementQuantity'>): number {
  const back = Math.floor(line.quantity) || 0;
  const wanted = line.replacementQuantity ?? back;
  return Math.max(1, Math.min(Math.floor(wanted) || 1, back));
}

/** The replacement quantity's stepper: a whole number from 1 to the line's return quantity. */
export function setRequesterReplacementQuantity(draft: RequesterDraft, lineId: string, quantity: number): RequesterDraft {
  const d = lineOf(draft, lineId);
  const max = Math.max(1, Math.floor(d.quantity) || 0);
  const n = Math.floor(Number(quantity));
  const replacementQuantity = Math.max(1, Math.min(Number.isFinite(n) ? n : 1, max));
  return withLine(draft, lineId, { ...d, replacementQuantity });
}

export function setRequesterNote(draft: RequesterDraft, lineId: string, note: string): RequesterDraft {
  return withLine(draft, lineId, { ...lineOf(draft, lineId), note });
}

/** The reason chips: tapping the chosen one again clears it (the reason is optional). */
export function toggleRequesterReason(draft: RequesterDraft, reason: ReturnReasonCode): RequesterDraft {
  return { ...draft, reasonCode: draft.reasonCode === reason ? null : reason };
}

export function setRequesterNotes(draft: RequesterDraft, notes: string): RequesterDraft {
  return { ...draft, notes };
}

/** A new request key (after a conflict: the old one was used with other details). */
/**
 * Start over after idempotency_conflict (core requesterRefusalRecovery
 * 'restart'; RX-3 fix round 1, desk check F3): a new key and NOTHING chosen
 * on any line (not the only-line rule), so a press alone never sends a second
 * request; the reason and the notes are kept, as the web form keeps them.
 */
export function restartRequesterDraft(draft: RequesterDraft, key: string = randomRequestUuid()): RequesterDraft {
  const lines: Record<string, RequesterDraftLine> = {};
  for (const lineId of Object.keys(draft.lines)) lines[lineId] = { ...EMPTY_LINE };
  return { ...draft, key, lines };
}

/** Some line asks for an exchange (the sizes are then needed). */
export function draftWantsSizes(draft: RequesterDraft): boolean {
  return Object.values(draft.lines).some((l) => l.quantity > 0 && l.mode === 'exchange');
}

/** Some line comes back. */
export function draftHasSelection(draft: RequesterDraft): boolean {
  return Object.values(draft.lines).some((l) => l.quantity > 0);
}

// The drafts, in memory for this app session only (never written to the
// device), per account, organization and order: another account never sees
// one, and a restart forgets them all.
const drafts = new Map<string, RequesterDraft>();
export const REQUESTER_DRAFTS_MAX = 20;

export interface RequesterDraftScope {
  userId: string;
  orgId: string;
}

function draftSlot(scope: RequesterDraftScope, orderId: string): string {
  return `${scope.userId}\u0000${scope.orgId}\u0000${orderId}`;
}

export function rememberRequesterDraft(scope: RequesterDraftScope | null, orderId: string, draft: RequesterDraft): void {
  if (!scope || !orderId) return;
  const slot = draftSlot(scope, orderId);
  // Re-inserted so the Map's order is oldest first.
  drafts.delete(slot);
  drafts.set(slot, draft);
  while (drafts.size > REQUESTER_DRAFTS_MAX) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function recallRequesterDraft(scope: RequesterDraftScope | null, orderId: string): RequesterDraft | null {
  if (!scope || !orderId) return null;
  return drafts.get(draftSlot(scope, orderId)) ?? null;
}

export function forgetRequesterDraft(scope: RequesterDraftScope | null, orderId: string): void {
  if (!scope || !orderId) return;
  drafts.delete(draftSlot(scope, orderId));
}

/** Test seam: forget every draft. */
export function forgetRequesterDrafts(): void {
  drafts.clear();
}

/**
 * The draft the sheet opens on: the one remembered for this account,
 * organization and order (against the sheet as it is now, its key kept),
 * else a new one with a new key.
 */
export function openRequesterDraft(input: {
  scope: RequesterDraftScope | null;
  orderId: string;
  sheet: Pick<RequesterReturnSheet, 'lines' | 'exchangesEnabled'>;
  mintKey?: () => string;
}): RequesterDraft {
  const remembered = recallRequesterDraft(input.scope, input.orderId);
  if (remembered) return reconcileRequesterDraft(remembered, input.sheet);
  return newRequesterDraft(input.sheet.lines, (input.mintKey ?? randomRequestUuid)());
}

// ── The sizes ───────────────────────────────────────────────────────────────

export type RequesterOptionsState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; answer: RequesterExchangeOptionsAnswer };

export interface RequesterOptionRow {
  itemId: string;
  /** "Walk Exchange Tee, L" (the name and the size, never a SKU, D5). */
  label: string;
  /** "Available" or "Not in stock right now" (two states, D6). */
  availability: string;
  available: boolean;
  photoUrl: string | null;
  /** What VoiceOver reads for the row: "Walk Exchange Tee, L. Available". */
  accessibilityLabel: string;
}

export type RequesterLineExchangeView =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string }
  | { kind: 'options'; rows: RequesterOptionRow[] }
  | { kind: 'review' };

export function requesterOptionRows(options: readonly RequesterExchangeOption[]): RequesterOptionRow[] {
  return options.map((o) => {
    const label = returnLineLabel(o.name, o.sizeLabel);
    const availability = REQUESTER_AVAILABILITY_WORDS[o.availability];
    return {
      itemId: o.itemId,
      label,
      availability,
      available: o.availability === 'available',
      photoUrl: requesterPhotoUrl(o.photo),
      accessibilityLabel: `${label}. ${availability}`,
    };
  });
}

/**
 * What a line's REPLACEMENT shows once Exchange is chosen: its sizes, the
 * warehouse-review note when it has none, or where the sizes are (loading,
 * offline, or failed with the words to try again).
 */
export function requesterLineExchangeView(
  options: RequesterOptionsState,
  lineId: string,
  online: boolean,
): RequesterLineExchangeView {
  switch (options.state) {
    case 'ready': {
      const line = options.answer.lines.find((l) => l.orderRequestLineId === lineId);
      return line ? { kind: 'options', rows: requesterOptionRows(line.options) } : { kind: 'review' };
    }
    case 'failed':
      return { kind: 'failed', message: options.message };
    case 'loading':
      return { kind: 'loading' };
    case 'idle':
      return online ? { kind: 'loading' } : { kind: 'offline' };
  }
}

/** Exchanges are offered: the sheet says so, and a sizes answer did not since say they were turned off. */
export function requesterExchangesOn(
  sheet: Pick<RequesterReturnSheet, 'exchangesEnabled'>,
  options: RequesterOptionsState,
): boolean {
  return sheet.exchangesEnabled && !(options.state === 'ready' && !options.answer.exchangesEnabled);
}

// ── The request ─────────────────────────────────────────────────────────────

export interface RequesterReturnBodyLine {
  orderRequestLineId: string;
  quantity: number;
  /** A size ({ itemId }) or the warehouse's review ({ note }); the quantity is the line's own. */
  exchange?: { itemId: string; quantity: number } | { note: string; quantity: number };
}

/** POST /api/v1/orders/[id]/return-request (core's requester schema). */
export interface RequesterReturnBody {
  reasonCode?: ReturnReasonCode;
  notes?: string;
  lines: RequesterReturnBodyLine[];
  idempotencyKey: string;
}

export type RequesterBodyResult =
  | { ok: true; body: RequesterReturnBody; exchange: boolean }
  | { ok: false; error: string };

function chars(s: string): number {
  return Array.from(s).length;
}

/**
 * The request from the draft, checked before it leaves (the obvious
 * mistakes; the server re-checks everything): at least one line, whole
 * quantities within what can come back, a size from the line's own offer or
 * a note for the warehouse, the note and the notes within their limits, then
 * core's requester schema itself. While exchanges are off every line is a
 * return only (the sheet shows it so before anything is sent).
 */
export function buildRequesterReturnBody(input: {
  sheet: Pick<RequesterReturnSheet, 'lines'>;
  draft: RequesterDraft;
  options: RequesterOptionsState;
  exchangesOn: boolean;
}): RequesterBodyResult {
  const lines: RequesterReturnBodyLine[] = [];
  let exchange = false;
  for (const l of input.sheet.lines) {
    const d = lineOf(input.draft, l.orderRequestLineId);
    const qty = d.quantity;
    if (qty === 0) continue;
    const label = returnLineLabel(l.name, l.sizeLabel);
    if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: 'Quantities must be whole numbers.' };
    if (qty > l.quantityRemaining) {
      return { ok: false, error: `Only ${l.quantityRemaining} of "${label}" can still be returned.` };
    }
    if (!input.exchangesOn || d.mode !== 'exchange') {
      lines.push({ orderRequestLineId: l.orderRequestLineId, quantity: qty });
      continue;
    }
    const view = requesterLineExchangeView(input.options, l.orderRequestLineId, true);
    if (view.kind === 'options') {
      if (!d.itemId || !view.rows.some((r) => r.itemId === d.itemId)) {
        return { ok: false, error: RETURNS_COPY.requesterChooseSize(label) };
      }
      lines.push({
        orderRequestLineId: l.orderRequestLineId,
        quantity: qty,
        exchange: { itemId: d.itemId, quantity: requesterReplacementQuantityOf(d) },
      });
    } else if (view.kind === 'review') {
      const note = d.note.trim();
      if (!note) return { ok: false, error: RETURNS_COPY.requesterNoteRequired(label) };
      if (chars(note) > RETURN_EXCHANGE_NOTE_MAX) return { ok: false, error: `At most ${RETURN_EXCHANGE_NOTE_MAX} characters.` };
      lines.push({
        orderRequestLineId: l.orderRequestLineId,
        quantity: qty,
        exchange: { note, quantity: requesterReplacementQuantityOf(d) },
      });
    } else {
      // The sizes never arrived: nothing about the exchange can be sent.
      return { ok: false, error: RETURNS_COPY.requesterOptionsUnavailable };
    }
    exchange = true;
  }
  if (lines.length === 0) return { ok: false, error: RETURNS_COPY.requesterPickAtLeastOne };
  const notes = input.draft.notes.trim();
  if (chars(notes) > RETURN_NOTES_MAX) return { ok: false, error: `At most ${RETURN_NOTES_MAX} characters.` };
  const reasonCode =
    input.draft.reasonCode && (RETURN_REASON_CODES as readonly string[]).includes(input.draft.reasonCode)
      ? input.draft.reasonCode
      : undefined;
  const body: RequesterReturnBody = {
    ...(reasonCode ? { reasonCode } : {}),
    ...(notes ? { notes } : {}),
    lines,
    idempotencyKey: input.draft.key,
  };
  // The server's own schema, run here too, so its words show before a round trip.
  const parsed = parseReturnBody('requester', body);
  if (!parsed.ok) return { ok: false, error: parsed.message };
  return { ok: true, body, exchange };
}

/** The title of the alert after a request is answered (core's words). */
export function requesterSentTitle(exchange: boolean): string {
  return exchange ? RETURNS_COPY.requesterReceivedExchangeRequest : RETURNS_COPY.requesterReceivedReturnRequest;
}

/** Its message: "Your reference is RMA-….", the web's words, when there is a number. */
export function requesterSentMessage(returnNumber: string | null): string | undefined {
  return returnNumber ? RETURNS_COPY.requesterReference(returnNumber) : undefined;
}

// ── The requester's own requests ────────────────────────────────────────────

export interface RequesterTrackingLineView {
  key: string;
  /** "Walk Exchange Tee, M ×1". */
  returning: string;
  /** "Walk Exchange Tee, L ×1", "Warehouse will review", "A different replacement", or null for a return only. */
  replacement: string | null;
  /** "Requested", "Approved", "Declined" or "Cancelled" (core's words for the line). */
  state: string | null;
  /** "Changed by the warehouse" when the warehouse approved another size. */
  changed: string | null;
}

export interface RequesterTrackingCardView {
  key: string;
  /** The RMA number ("RMA-20261011-ABC123"). */
  title: string;
  /** When it was asked for ("Oct 11, 2026"). */
  date: string;
  /** The server's one or two sentences, as they came. */
  sentences: string[];
  lines: RequesterTrackingLineView[];
  /** "Replacement order: SO-000104" once one exists. */
  replacementOrder: string | null;
  /** The card's one VoiceOver label. */
  accessibilityLabel: string;
}

/** "Oct 11, 2026" in the device's zone (or the zone given), the date passed through when unreadable. */
export function requesterRequestDate(iso: string, opts: { timeZone?: string } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * One of the requester's requests as its card reads (brief 28): the RMA
 * number and date, per line what goes back and what comes instead ("Changed
 * by the warehouse" when another size was approved), the server's
 * sentences, and the replacement order's number once it exists. Never a
 * rack, Staging, a disposition, a quantity on record, a cost, a note, a
 * reason or a staff member (the tracking carries none of them).
 */
export function requesterTrackingCard(t: RequesterTrackingReturn, opts: { timeZone?: string } = {}): RequesterTrackingCardView {
  const title = t.returnNumber ?? RETURNS_COPY.requesterRequestTitle;
  const date = requesterRequestDate(t.createdAt, opts);
  // Core's line words, the web's too (RX-3 fix round 1, M3 and L4): a
  // note-only request reads "A different replacement" once declined or
  // cancelled, never "Warehouse will review".
  const lines: RequesterTrackingLineView[] = t.lines.map((l, i) => ({ key: `${i}`, ...requesterTrackingLineWords(l) }));
  const replacementOrder = t.replacementOrderNumber ? `${RETURNS_COPY.replacementOrderHeading}: ${t.replacementOrderNumber}` : null;
  // VoiceOver reads in the screen's order (desk check L2): the title and
  // date, the sentences, the lines, then the replacement order.
  const spoken: string[] = [`${title}, ${date}.`, ...t.sentences];
  for (const l of lines) {
    spoken.push(`Returning: ${l.returning}.`);
    if (l.replacement) {
      spoken.push(`Replacement: ${[l.replacement, l.state, l.changed].filter(present).join(', ')}.`);
    }
  }
  if (replacementOrder) spoken.push(`${replacementOrder}.`);
  return {
    key: t.returnNumber ?? `${t.createdAt}-${t.lines.length}`,
    title,
    date,
    sentences: [...t.sentences],
    lines,
    replacementOrder,
    accessibilityLabel: spoken.join(' '),
  };
}

// ── The sheet's line words ─────────────────────────────────────────────────

/** "Walk Exchange Tee, M" for a returnable line (its name and size). */
export function requesterLineLabel(line: Pick<RequesterReturnableLine, 'name' | 'sizeLabel'>): string {
  return returnLineLabel(line.name, line.sizeLabel);
}

/** "2 of 3 returnable" (the staff sheet's and the token page's words). */
export function requesterLineAvailability(line: Pick<RequesterReturnableLine, 'quantityFulfilled' | 'quantityRemaining'>): string {
  return `${line.quantityRemaining} of ${line.quantityFulfilled} returnable`;
}

/** "Qty requested: 2": the replacement's quantity, the line's own (brief 4: it defaults to and is capped by it). */
export function requesterReplacementQuantity(quantity: number): string {
  return qtyRequestedLabel(quantity);
}
