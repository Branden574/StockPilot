/**
 * Shared row type + formatter for an ITEM'S STOCK-MOVEMENT HISTORY — the
 * "what came from where, on what date and time, and why, and who" story behind
 * a staging row (owner ask, 2026-07-22).
 *
 * WHY A HISTORY AND NOT A "SOURCE" LABEL. Two earlier attempts tried to infer a
 * single winning source per holding by picking one movement out of the ledger.
 * That needs a tie-break rule for every edge case, and both got it confidently
 * wrong (one widened a query into the PostgREST 1000-row cap and could erase PO
 * attribution; the other labelled internally-cancelled order picks as "Customer
 * return processed by X" and let the winning movement overwrite the staging
 * row's date, resetting a month-old row to "0d" and deleting its Stale badge).
 * A history renders the ledger rows AS THEY ARE: there is no winner to choose,
 * so there is no rule to get wrong.
 *
 * WHY THE FORMATTER LIVES IN packages/core. Web (staging table dialog) and
 * mobile (staging sheet) must read the SAME rows in the SAME words. Any
 * per-platform copy of this vocabulary drifts, and "the two surfaces disagreed
 * about where stock came from" is the original incident.
 *
 * TRUTHFULNESS RULES ENCODED HERE:
 *  1. Describe each movement as what it IS; never guess intent. In particular
 *     `movement_type='return'` is written by BOTH the RMA restock path and
 *     `cancel_order_request`, so it is titled "Returned to stock" and the
 *     record's own reason ("Order cancelled", "Return restock") carries the
 *     rest. We never assert a customer returned anything.
 *  2. Machine-written reasons (`receipt_line`, `receipt_reversal`,
 *     `duplicate_initial_count`, bare `PO {number}`) and raw UUIDs are NEVER
 *     rendered as if an operator typed them. When there are no human words we
 *     render nothing.
 *  3. Reversal pairs are marked, because in the owner's real data most of the
 *     receive_po volume on this SKU is received-then-reversed pairs that net to
 *     zero; a reader who cannot see that misreads the whole history.
 *  4. Timestamps are returned as RAW ISO and formatted by each surface in the
 *     VIEWER's timezone (web: <LocalDateTime>; mobile: toLocaleString). This
 *     module deliberately does no date formatting.
 *  5. No actor is rendered as no actor — never "System" dressed up as a person.
 */

import { RECEIPT_NOTE_SENTINEL_RE } from './movement-note-sentinel';
import { resolveMovementRefReason } from './movement-order-ref';

/** One stock_movements row, joined out to display-ready names and numbers. */
export interface ItemHistoryMovement {
  /** stock_movements.id */
  id: string;
  /** RAW ISO timestamp (stock_movements.created_at). Surfaces format it in the
   *  viewer's timezone — see rule 4 above. */
  at: string;
  /** stock_movements.movement_type, verbatim. */
  movementType: string;
  /** Signed change to quantity_on_hand. ALWAYS 0 for transfers (the ledger has
   *  to sum to on-hand) — render `movedQuantity` for those instead. */
  quantityChange: number;
  /** Physical qty moved by a net-zero transfer (mig 0231). null on pre-0231
   *  rows and on non-transfer movements. */
  movedQuantity: number | null;
  previousQuantity: number;
  newQuantity: number;
  /** Display name of the user who wrote the row: full_name, else email.
   *  null for system/trigger writes (no auth.uid context) — rule 5. */
  actorName: string | null;
  /** The actor's email when it is a genuinely SECOND fact (i.e. actorName is
   *  not already the email). null otherwise. */
  actorEmail: string | null;
  /** Resolved location NAMES, not ids. Either side may be null: a receipt only
   *  sets a destination, a removal only a source, a transfer sets both. */
  fromLocationName: string | null;
  toLocationName: string | null;
  /** The operator's own words — reason when it is human prose, else notes when
   *  THOSE are human prose, else null. Never a token, never a UUID (rule 2). */
  note: string | null;
  /** Receiving context, present only when the movement came from a receipt. */
  receiptNumber: string | null;
  /** receipts.status: 'posted' | 'reversed' | 'reversal'. */
  receiptStatus: string | null;
  poNumber: string | null;
  /** purchase_orders.status, e.g. 'received' | 'cancelled'. */
  poStatus: string | null;
  /** The human reversal_reason typed on the reversing receipt, when there is
   *  one. Carried separately from `note` because it lives on the receipt, not
   *  the movement. */
  reversalReason: string | null;
  /** Set when this movement is one half of a received-then-reversed pair
   *  (rule 3). `role: 'reversed'` = this receipt was later undone;
   *  `role: 'reversal'` = this movement is the undo. `counterpartMovementId`
   *  is best-effort: null when the other half fell outside the loaded page. */
  reversal: {
    role: 'reversed' | 'reversal';
    counterpartMovementId: string | null;
    counterpartReceiptNumber: string | null;
  } | null;
}

/** One page of history, plus what the caller needs to ask for more. */
export interface ItemHistoryPage {
  itemId: string;
  itemName: string;
  itemSku: string;
  rows: ItemHistoryMovement[];
  /** Total movements for this item under the same filters (exact count). */
  total: number;
  /** Echo of the window that produced `rows`. */
  limit: number;
  offset: number;
  /** True when more rows exist past this window. */
  hasMore: boolean;
}

/**
 * Reasons written by CODE, not by a person. Never shown as a note (rule 2).
 *
 * This list is not guesswork: it is every bare-identifier value any writer in
 * this repo puts into `stock_movements.reason`, found by grepping the RPCs in
 * supabase/migrations (the only writers that set the column to a constant) and
 * the insert paths in apps/web/src/server/services. The writers and their
 * literals:
 *
 *   receipt_line            post_receipt_v2 (0013/0015/0069/0190)
 *   receipt_reversal        reverse_receipt (0013/0183/0193/0195)
 *   duplicate_initial_count duplicate_inventory_item (0125)
 *   order_delivered         deliver_order_request (0044/0045/0055/0057)
 *   bundle_assembly         assemble_bundle (0040/0101/0198)
 *   bundle_distribution     distribute_bundle (0040/0070/0101/0198)
 *   no_stock                distribute_bundle's `bundle_shortage` row
 *   item_archived           historic lifecycle rows, purged by 0271
 *   item_deleted            historic lifecycle rows, purged by 0271
 *
 * `order_delivered` is the one that shipped wrong: the owner's org has five of
 * them, and every one rendered in curly quotes in the WHY field as though an
 * operator had typed the words "order_delivered".
 *
 * The remaining four entries predate this list and are kept: they cost nothing
 * and cover older/adjacent writers.
 *
 * NOT suppressed, deliberately — machine-COMPOSED reasons that are the only
 * carrier of a fact the row cannot otherwise state, so hiding them would make
 * the screen less true rather than more: `Order pick (order_request …)`,
 * `Order cancelled (order_request …)` and `Return {disposition} (return …)`
 * (rule 1 above depends on the last two to distinguish an RMA restock from an
 * internally-cancelled pick, both of which are movement_type='return'),
 * `Shipment {work_order_number}` (the shipment number appears nowhere else on
 * the row) and `Cycle count adjustment` (these are movement_type='adjust', so
 * the title cannot say a cycle count produced them). Their trailing raw ids are
 * stripped by TRAILING_REF_RE, which is a separate concern — except for
 * `order_request` and `return` ids, which `historyNote` now RESOLVES to
 * "(SO-000060)" / the return's own number via movement-order-ref.ts when the
 * caller supplies a label map, and only strips when it cannot. See that module for why the ledger's own rows still carry
 * the uuid.
 */
const INTERNAL_REASON_TOKENS = new Set([
  'receipt_line',
  'receipt_reversal',
  'duplicate_initial_count',
  'order_delivered',
  'bundle_assembly',
  'bundle_distribution',
  'no_stock',
  'item_archived',
  'item_deleted',
  'initial_count',
  'opening_count',
  'adjust_stock',
  'system',
]);

/**
 * Backstop for the NEXT writer nobody remembers to add above: a reason that is
 * a single lower_snake_case identifier — no spaces, no punctuation — is a code
 * token, not something a person typed into a reason box. Enumerating the known
 * literals is the fix; this shape rule is what stops the same defect returning
 * the next time an RPC invents one.
 */
const MACHINE_TOKEN_RE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

/** A note/reason that is nothing but a bare uuid is an identifier, not prose.
 *  Same shape — and now literally the same regex — as the receipt sentinel in
 *  `movement-note-sentinel.ts`, which is the one definition in the repo. */
const UUID_RE = RECEIPT_NOTE_SENTINEL_RE;

/** `PO CVW-002201` — machine-composed by the receipt writer. The PO number is
 *  already carried structurally in `poNumber`, so echoing it as a "note" both
 *  duplicates and misrepresents it as typed prose. */
const PO_REASON_RE = /^PO\s+[\w-]+$/i;

/** Trailing internal reference a reason writer appends, e.g.
 *  "Order pick (order_request 51516354-4efe-40e5-89bd-95164cbef2f7)".
 *  The prefix is real prose; the parenthetical is a raw id and must go. */
const TRAILING_REF_RE =
  /\s*\((?:order_request|order|return|receipt|purchase_order|cycle_count|item)\s+[0-9a-f-]{36}\)\s*$/i;

/**
 * Strips the internal reference parenthetical and normalises whitespace.
 * Returns null when nothing human is left.
 */
function cleanProse(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').replace(TRAILING_REF_RE, '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (UUID_RE.test(trimmed)) return null;
  if (INTERNAL_REASON_TOKENS.has(trimmed.toLowerCase())) return null;
  if (MACHINE_TOKEN_RE.test(trimmed)) return null;
  if (PO_REASON_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Rule 2, as a pure function: show the operator's typed words when there are
 * any, and otherwise show NOTHING rather than a UUID or an internal token.
 *
 * `reason` LEADS because the writers that set both put the human text in
 * `reason` and an internal id in `notes` (post_receipt_v2 stores receipts.id
 * there) — but when BOTH survive cleaning, both are shown. The owner asked for
 * "when where notes why everything"; an operator who took the trouble to type a
 * reason AND a note wrote two different things, and returning only the first
 * silently deletes the second. They are labelled rather than run together so
 * the reader can see which field each came from.
 *
 * Exported for unit tests.
 */
export function historyNote(
  reason: string | null | undefined,
  notes: string | null | undefined,
  refLabelById?: ReadonlyMap<string, string> | null,
): string | null {
  // Resolve a legacy `(order_request <uuid>)` / `(return <uuid>)` parenthetical
  // to `(SO-000060)` / `(RMA-0007)` BEFORE cleaning. This is what makes the
  // item-history dialog and the Movements page say the same words about the
  // same event — they used to disagree, because this formatter stripped the
  // parenthetical to a bare "Order pick" while the Movements page printed the
  // raw uuid.
  //
  // Two properties make the ordering safe. A resolved `(SO-000060)` is not a
  // 36-char hex id, so `TRAILING_REF_RE` below leaves it alone. And when
  // nothing resolves, `resolveMovementRefReason` drops the parenthetical
  // itself, landing on exactly the "Order pick" this function has always
  // returned — so callers that pass no map (or hit a degraded lookup) keep
  // today's behaviour byte for byte.
  const r = cleanProse(resolveMovementRefReason(reason, refLabelById));
  const n = cleanProse(notes);
  if (r && n && r.toLowerCase() !== n.toLowerCase()) return `${r} (note: ${n})`;
  return r ?? n;
}

/** Movement kind → the words BOTH surfaces use. Vocabulary matches the
 *  existing activity feed where the feed is honest ("Stock transferred",
 *  "Stock received"), and is narrowed by movement_type where the feed guessed
 *  from the sign of the delta (an `add` is not a receipt). */
const MOVEMENT_TITLES: Record<string, string> = {
  initial: 'Opening count',
  add: 'Stock added',
  remove: 'Stock removed',
  adjust: 'Stock adjusted',
  correction: 'Correction',
  transfer: 'Stock transferred',
  receive_po: 'Stock received',
  cycle_count: 'Cycle count posted',
  // Rule 1: `cancel_order_request` writes movement_type='return' for an
  // internally-cancelled pick, so this must NOT say a customer returned it.
  // "Returned to stock" is what the record supports; the row's own reason
  // ("Order cancelled" / "Return restock") supplies the rest.
  return: 'Returned to stock',
};

/** Fallback for a movement_type this build has never seen: title-case the raw
 *  token rather than inventing a meaning for it. */
function titleCaseType(type: string): string {
  const words = type.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Stock movement';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function movementTitle(movementType: string): string {
  return MOVEMENT_TITLES[movementType] ?? titleCaseType(movementType);
}

function groupThousands(n: number): string {
  const rounded = Math.round(n * 10_000) / 10_000;
  const [int = '0', frac] = Math.abs(rounded).toString().split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded < 0 ? '-' : '';
  return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** Display-ready strings for one history row. Every field is nullable and a
 *  null means "we have nothing to say here" — surfaces must render nothing,
 *  not a placeholder claim. */
export interface FormattedHistoryMovement {
  /** e.g. "Stock received". */
  title: string;
  /** Signed change, e.g. "+20" / "-10". null for transfers (always 0) and
   *  whenever there is no number worth showing. */
  deltaLabel: string | null;
  /** Physical qty for a net-zero transfer, e.g. "10 moved". null otherwise. */
  movedLabel: string | null;
  /** "134 -> 144 on hand". */
  onHandLabel: string;
  /** "Staging -> 37-B", "-> Staging", "Staging ->", or null when neither side
   *  resolves to a name. */
  routeLabel: string | null;
  /** The person, or null when the row has no actor (rule 5). */
  actorLabel: string | null;
  /** Second-fact email, or null. */
  actorEmailLabel: string | null;
  /** RAW ISO — formatted by the surface in the VIEWER's timezone (rule 4). */
  whenIso: string;
  /** The operator's typed words, or null (rule 2). */
  noteLabel: string | null;
  /** "Receipt R-20260722-175600-e56648 - PO CVW-002201 (cancelled)" style
   *  provenance, or null when the movement did not come from receiving. */
  sourceLabel: string | null;
  /** "Reversed later by R-...-REV" / "Reverses R-..." plus the typed reversal
   *  reason when there is one. null when this is not half of a pair (rule 3). */
  reversalLabel: string | null;
  /** Coarse visual tone; mirrors the activity feed's vocabulary. */
  tone: 'pos' | 'neg' | 'neutral' | 'warn';
}

/**
 * The ONE formatter both surfaces call. Pure: no dates are formatted here and
 * no facts are invented — every string is derived from a field on the row.
 */
export function formatHistoryMovement(row: ItemHistoryMovement): FormattedHistoryMovement {
  // Show the +/- delta whenever there IS one, and the physical moved qty
  // whenever the row records one. Deliberately NOT keyed off
  // movementType === 'transfer': the activity feed assumes a transfer's
  // quantity_change is always 0, but the fulfilment writer records an order
  // pick as movement_type='transfer' with a real negative delta and no
  // moved_quantity (e.g. the owner's 2026-07-06 pick of -5). Suppressing the
  // number for "transfers" would hide five units leaving the building.
  const deltaLabel =
    row.quantityChange !== 0
      ? `${row.quantityChange > 0 ? '+' : ''}${groupThousands(row.quantityChange)}`
      : null;
  const movedLabel =
    row.movedQuantity !== null ? `${groupThousands(row.movedQuantity)} moved` : null;

  const routeLabel =
    row.fromLocationName && row.toLocationName
      ? `${row.fromLocationName} -> ${row.toLocationName}`
      : row.toLocationName
        ? `-> ${row.toLocationName}`
        : row.fromLocationName
          ? `${row.fromLocationName} ->`
          : null;

  let sourceLabel: string | null = null;
  if (row.receiptNumber || row.poNumber) {
    const parts: string[] = [];
    if (row.receiptNumber) {
      // Receipt status is only worth saying when it is NOT the ordinary case;
      // "posted" adds nothing to a row that plainly added stock.
      parts.push(
        row.receiptStatus && row.receiptStatus !== 'posted'
          ? `Receipt ${row.receiptNumber} (${row.receiptStatus})`
          : `Receipt ${row.receiptNumber}`,
      );
    }
    if (row.poNumber) {
      // PO status matters even when ordinary: the owner's real case has stock
      // received against a PO that was later CANCELLED, and hiding that is
      // exactly the kind of omission that sent them to SQL.
      parts.push(row.poStatus ? `PO ${row.poNumber} (${row.poStatus})` : `PO ${row.poNumber}`);
    }
    sourceLabel = parts.join(' - ');
  }

  let reversalLabel: string | null = null;
  if (row.reversal) {
    const counterpart = row.reversal.counterpartReceiptNumber;
    const head =
      row.reversal.role === 'reversed'
        ? counterpart
          ? `Reversed later by ${counterpart}`
          : 'Reversed later'
        : counterpart
          ? `Reverses ${counterpart}`
          : 'Reverses an earlier receipt';
    reversalLabel = row.reversalReason ? `${head}: ${row.reversalReason}` : head;
  }

  const tone: FormattedHistoryMovement['tone'] = row.reversal
    ? 'warn'
    : row.quantityChange === 0
      ? 'neutral'
      : row.quantityChange > 0
        ? 'pos'
        : 'neg';

  return {
    title: movementTitle(row.movementType),
    deltaLabel,
    movedLabel,
    onHandLabel: `${groupThousands(row.previousQuantity)} -> ${groupThousands(row.newQuantity)} on hand`,
    routeLabel,
    actorLabel: row.actorName,
    actorEmailLabel: row.actorEmail,
    whenIso: row.at,
    noteLabel: row.note,
    sourceLabel,
    reversalLabel,
    tone,
  };
}
