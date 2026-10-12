import {
  RETURN_EXCHANGE_NOTE_MAX,
  RETURNS_COPY,
  returnLineLabel,
  type ActionResult,
  type RequesterExchangeOption,
  type RequesterExchangeOptionsAnswer,
  type RequesterReturnableLine,
  type ReturnReasonCodeValue,
} from '@stockpilot/core';

/**
 * The requester's "Return or exchange" form, as pure rules (returns RX-3,
 * web): the token page and the B2B portal fill in the same form through
 * components/returns/requester-return-sheet.tsx, and this module decides what
 * it starts with, what it sends and how each answer reads. Nothing here runs
 * on import, and nothing here is a client reference, so a server module may
 * import it too (pattern 8).
 *
 * WHAT IS SENT is only what a requester may choose (plan RX-3 API; brief 6,
 * 31): an order line, a whole quantity, and for an exchange either one of the
 * line's own sizes (an option's item id) or a note for the warehouse, with
 * the replacement's quantity. Never a disposition, a status, a warehouse, an
 * organization, a location or an order id: the server strips those anyway,
 * and core's exchange object is strict.
 */

/** The reasons a requester may give, in the words the requester pages used
 *  before RX-3 (one list for the token page and the portal). */
export const REQUESTER_REASON_OPTIONS: ReadonlyArray<{ value: ReturnReasonCodeValue; label: string }> = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'overage', label: 'Too many / overage' },
  { value: 'end_of_year', label: 'End of year' },
  { value: 'other', label: 'Other' },
];

export type RequesterLineMode = 'return' | 'exchange';

/** What the requester has chosen for one line of their order. */
export interface RequesterLineDraft {
  selected: boolean;
  /** Whole units to send back: 1 to what can still come back. */
  quantity: number;
  mode: RequesterLineMode;
  /** The chosen size (one of the line's options), for a line with sizes. */
  itemId: string | null;
  /** The replacement's quantity; null follows the return quantity (brief 4). */
  replacementQuantity: number | null;
  /** "Tell the warehouse what you need", for a line without sizes. */
  note: string;
}

/**
 * The form as it opens: every line unticked at what can come back, except
 * that an order with ONE returnable line starts it ticked (the staff create
 * sheet's rule since the RX-2 review, web and phone).
 */
export function initialRequesterDrafts(lines: readonly RequesterReturnableLine[]): Record<string, RequesterLineDraft> {
  const returnable = lines.filter((l) => l.quantityRemaining > 0);
  const only = returnable.length === 1 ? returnable[0]!.orderRequestLineId : null;
  const out: Record<string, RequesterLineDraft> = {};
  for (const l of lines) {
    out[l.orderRequestLineId] = {
      selected: l.orderRequestLineId === only,
      quantity: Math.max(1, Math.floor(l.quantityRemaining)),
      mode: 'return',
      itemId: null,
      replacementQuantity: null,
      note: '',
    };
  }
  return out;
}

function blankDraft(l: RequesterReturnableLine): RequesterLineDraft {
  return {
    selected: false,
    quantity: Math.max(1, Math.floor(l.quantityRemaining)),
    mode: 'return',
    itemId: null,
    replacementQuantity: null,
    note: '',
  };
}

/**
 * The drafts against lines read again (RX-3 fix round 1, desk checks M4 and
 * F4; the phone's reconcileRequesterDraft rule): a line keeps its choices with
 * its quantity inside what is left, a line with nothing left is unticked, and
 * a line new to the form gets its own unticked row (it was hidden before).
 */
export function reconcileRequesterDrafts(
  drafts: Readonly<Record<string, RequesterLineDraft>>,
  lines: readonly RequesterReturnableLine[],
): Record<string, RequesterLineDraft> {
  const out: Record<string, RequesterLineDraft> = {};
  for (const l of lines) {
    const d = drafts[l.orderRequestLineId];
    const left = Math.floor(l.quantityRemaining);
    if (!d) out[l.orderRequestLineId] = blankDraft(l);
    else if (!(left >= 1)) out[l.orderRequestLineId] = { ...d, selected: false, quantity: 1 };
    else out[l.orderRequestLineId] = { ...d, quantity: Math.max(1, Math.min(Math.floor(d.quantity) || 1, left)) };
  }
  return out;
}

/**
 * Start over after idempotency_conflict (core requesterRefusalRecovery
 * 'restart'): every line unticked and nothing chosen, NOT the only-line rule,
 * so a press alone never sends a second request.
 */
export function restartRequesterDrafts(lines: readonly RequesterReturnableLine[]): Record<string, RequesterLineDraft> {
  return Object.fromEntries(lines.map((l) => [l.orderRequestLineId, blankDraft(l)]));
}

/** The drafts against a sizes answer: a size no longer offered is unchosen. */
export function reconcileDraftsWithOptions(
  drafts: Readonly<Record<string, RequesterLineDraft>>,
  answer: RequesterExchangeOptionsAnswer,
): Record<string, RequesterLineDraft> {
  const offered = new Map(answer.lines.map((l) => [l.orderRequestLineId, new Set(l.options.map((o) => o.itemId))]));
  const out: Record<string, RequesterLineDraft> = {};
  for (const [lineId, d] of Object.entries(drafts)) {
    out[lineId] = d.itemId && !offered.get(lineId)?.has(d.itemId) ? { ...d, itemId: null } : d;
  }
  return out;
}

/** A whole number between min and max (min for anything unreadable). */
export function clampWhole(raw: unknown, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** The replacement's quantity: the return quantity unless chosen lower, and
 *  never above it. */
export function effectiveReplacementQuantity(draft: Pick<RequesterLineDraft, 'quantity' | 'replacementQuantity'>): number {
  const wanted = draft.replacementQuantity ?? draft.quantity;
  return Math.max(1, Math.min(wanted, draft.quantity));
}

/** The sizes call, once per form (brief 44: only when Exchange is chosen). */
export type RequesterOptionsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; answer: RequesterExchangeOptionsAnswer }
  | { status: 'failed'; message: string };

/**
 * A line's sizes once loaded: its options in size order, or [] for a line the
 * answer leaves out (no product group, or no other size: the warehouse
 * reviews it from a note). Null while nothing is loaded.
 */
export function optionsForLine(state: RequesterOptionsState, orderRequestLineId: string): RequesterExchangeOption[] | null {
  if (state.status !== 'loaded') return null;
  return state.answer.lines.find((l) => l.orderRequestLineId === orderRequestLineId)?.options ?? [];
}

/** One line of the request body. */
export interface RequesterSubmitLine {
  orderRequestLineId: string;
  quantity: number;
  exchange?: { itemId?: string; quantity: number; note?: string };
}

/** The request body every requester surface sends (core's requester schema). */
export interface RequesterSubmitBody {
  reasonCode?: ReturnReasonCodeValue;
  notes?: string;
  lines: RequesterSubmitLine[];
  /** Minted when the form opens and resent as it is (plan RX-3). */
  idempotencyKey: string;
}

export type RequesterLinesResult =
  | { ok: true; lines: RequesterSubmitLine[]; hasExchange: boolean }
  | { ok: false; message: string; lineId: string | null };

/** The server's own words for a body it cannot read (the public route's). */
const CHECK_ITEMS = 'Check the items and quantities, then try again.';

/**
 * The lines to send, or the first thing to fix (said in the form, never only
 * in a toast: pattern 20). The inputs already clamp quantities and the server
 * re-checks everything; these refusals keep the common path off a 400.
 */
export function requesterLinesFromDrafts(
  lines: readonly RequesterReturnableLine[],
  drafts: Readonly<Record<string, RequesterLineDraft>>,
  ctx: { exchangesEnabled: boolean; options: RequesterOptionsState },
): RequesterLinesResult {
  const out: RequesterSubmitLine[] = [];
  let hasExchange = false;
  for (const l of lines) {
    const d = drafts[l.orderRequestLineId];
    if (!d?.selected) continue;
    const id = l.orderRequestLineId;
    if (!Number.isInteger(d.quantity) || d.quantity < 1 || d.quantity > l.quantityRemaining) {
      return { ok: false, message: CHECK_ITEMS, lineId: id };
    }
    if (d.mode !== 'exchange') {
      out.push({ orderRequestLineId: id, quantity: d.quantity });
      continue;
    }
    const off = !ctx.exchangesEnabled || (ctx.options.status === 'loaded' && !ctx.options.answer.exchangesEnabled);
    if (off) return { ok: false, message: RETURNS_COPY.exchangeKillSwitch, lineId: id };
    if (ctx.options.status === 'failed') return { ok: false, message: ctx.options.message, lineId: id };
    const options = optionsForLine(ctx.options, id);
    if (options === null) return { ok: false, message: RETURNS_COPY.requesterOptionsUnavailable, lineId: id };
    const quantity = effectiveReplacementQuantity(d);
    const label = returnLineLabel(l.name, l.sizeLabel);
    if (options.length > 0) {
      if (!d.itemId || !options.some((o) => o.itemId === d.itemId)) {
        return { ok: false, message: RETURNS_COPY.requesterChooseSize(label), lineId: id };
      }
      out.push({ orderRequestLineId: id, quantity: d.quantity, exchange: { itemId: d.itemId, quantity } });
    } else {
      const note = d.note.trim();
      if (!note) return { ok: false, message: RETURNS_COPY.requesterNoteRequired(label), lineId: id };
      if (note.length > RETURN_EXCHANGE_NOTE_MAX) {
        return { ok: false, message: `At most ${RETURN_EXCHANGE_NOTE_MAX} characters.`, lineId: id };
      }
      out.push({ orderRequestLineId: id, quantity: d.quantity, exchange: { note, quantity } });
    }
    hasExchange = true;
  }
  if (out.length === 0) return { ok: false, message: RETURNS_COPY.requesterPickAtLeastOne, lineId: null };
  return { ok: true, lines: out, hasExchange };
}

// ── Answers, whichever way they arrived ─────────────────────────────────────

export type RequesterOptionsOutcome = { ok: true; answer: RequesterExchangeOptionsAnswer } | { ok: false; message: string };

export type RequesterSubmitOutcome =
  | { ok: true; returnNumber: string | null; replay: boolean }
  | { ok: false; message: string; reason: string | null };

const SUBMIT_FAILED = 'Could not submit your request. Try again.';

function isOptionsAnswer(v: unknown): v is RequesterExchangeOptionsAnswer {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.exchangesEnabled === 'boolean' &&
    Array.isArray(a.lines) &&
    a.lines.every(
      (l) =>
        l !== null &&
        typeof l === 'object' &&
        typeof (l as Record<string, unknown>).orderRequestLineId === 'string' &&
        Array.isArray((l as Record<string, unknown>).options),
    )
  );
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await res.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function messageOf(data: Record<string, unknown> | null, fallback: string): string {
  const m = data?.message;
  return typeof m === 'string' && m.trim() ? m : fallback;
}

function reasonOf(details: unknown): string | null {
  const r = details && typeof details === 'object' ? (details as Record<string, unknown>).reason : null;
  return typeof r === 'string' ? r : null;
}

/** POST /api/v1/public/returns/options, read. */
export async function readPublicOptionsResponse(res: Response): Promise<RequesterOptionsOutcome> {
  const data = await readJson(res);
  if (!res.ok) return { ok: false, message: messageOf(data, RETURNS_COPY.requesterOptionsUnavailable) };
  return isOptionsAnswer(data) ? { ok: true, answer: data } : { ok: false, message: RETURNS_COPY.requesterOptionsUnavailable };
}

/** POST /api/v1/public/returns, read. */
export async function readPublicSubmitResponse(res: Response): Promise<RequesterSubmitOutcome> {
  const data = await readJson(res);
  if (!res.ok) return { ok: false, message: messageOf(data, SUBMIT_FAILED), reason: reasonOf(data?.details) };
  const returnNumber = typeof data?.returnNumber === 'string' ? data.returnNumber : null;
  return { ok: true, returnNumber, replay: data?.replay === true };
}

/** The portal's options action, read. */
export function readActionOptions(res: ActionResult<RequesterExchangeOptionsAnswer>): RequesterOptionsOutcome {
  if (!res.ok) return { ok: false, message: res.error.message || RETURNS_COPY.requesterOptionsUnavailable };
  return isOptionsAnswer(res.data) ? { ok: true, answer: res.data } : { ok: false, message: RETURNS_COPY.requesterOptionsUnavailable };
}

/** The portal's request action, read. */
export function readActionSubmit(
  res: ActionResult<{ id: string; status: 'requested'; returnNumber: string | null; replay: boolean }>,
): RequesterSubmitOutcome {
  if (!res.ok) return { ok: false, message: res.error.message || SUBMIT_FAILED, reason: reasonOf(res.error.details) };
  return { ok: true, returnNumber: res.data.returnNumber ?? null, replay: res.data.replay === true };
}
