/**
 * The requester's side of returns and exchanges (returns RX-3, plan 3.9 and
 * 3.10): what the token page, the B2B portal and a member's own order (web,
 * iPhone, iPad) receive. One contract for every surface.
 *
 * WHAT A REQUESTER MAY SEE (brief 28, 32; the PublicCatalogItem pattern):
 * their own order's returnable lines, the eligible sizes of each line's own
 * product group, and their own requests' progress. Every field below is one
 * of: a name, a size (variant words), a photo URL signed for exactly these
 * items, an id the requester sends back (an order line, an option item), the
 * requester's own quantities, a status code, a sentence, an RMA or SO
 * number, a date. No field can carry a SKU, a cost or price, a location, a
 * rack, Staging, a disposition or destination, a charter, a warehouse, a
 * group id, a quantity on record or a free count, a note, a reason, a
 * supplier or a staff member: the key lists below are pinned by tests on
 * every payload the server builds, and isForbiddenRequesterKey names what
 * may never appear.
 *
 * AVAILABILITY IS TWO STATES (D6): the server turns a free count (on hand
 * minus every active hold) into "Available" or "Not in stock right now";
 * the count itself never leaves the server.
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import type { ReturnStatus } from '../orders/order-returns-view';
import { sortBySizeOrder } from '../sports/size-order';

import type { ExchangeStatus } from './exchange-status';
import { exchangeLineStatusLabel } from './exchange-view';
import { itemQuantityLabel, returnLineLabel, RETURNS_COPY } from './returns-copy';

// ── Availability (two states, D6) ───────────────────────────────────────────

export type RequesterAvailability = 'available' | 'not_in_stock';

/** The words for each state ("Available", "Not in stock right now"). */
export const REQUESTER_AVAILABILITY_WORDS: Readonly<Record<RequesterAvailability, string>> = {
  available: RETURNS_COPY.available,
  not_in_stock: RETURNS_COPY.notInStock,
};

/**
 * The server's projection of a free count to the two states a requester
 * sees: anything in stock now is "available"; zero, a negative count or an
 * unreadable value is "not in stock right now". The count is never sent.
 */
export function requesterAvailability(free: unknown): RequesterAvailability {
  const n = typeof free === 'number' ? free : typeof free === 'string' && free.trim() !== '' ? Number(free) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? 'available' : 'not_in_stock';
}

// ── The sheet: returnable lines and their options ───────────────────────────

/** An item's photo, signed for this item only (null when it has none or
 *  signing failed: the screen shows its placeholder and goes on). */
export interface RequesterPhoto {
  /** The primary photo's signed URL (the master; screens downsize it). */
  url: string;
  /** Its stored thumbnail's signed URL, when it has one (lists prefer it). */
  thumbUrl: string | null;
}

/** One line of the requester's own order that can still come back
 *  (the RETURNING card). */
export interface RequesterReturnableLine {
  /** The id the requester sends back with a quantity. */
  orderRequestLineId: string;
  name: string;
  /** The variant words ("Size M", "#12 · Size XL"), null for an item with none. */
  sizeLabel: string | null;
  photo: RequesterPhoto | null;
  /** What the requester received on this line. */
  quantityFulfilled: number;
  /** What can still come back: received, less returned, less requests in flight. */
  quantityRemaining: number;
}

/** One size a requester may ask for instead of the returned one. */
export interface RequesterExchangeOption {
  /** The id the requester sends back as `exchange.itemId`. */
  itemId: string;
  name: string;
  sizeLabel: string | null;
  availability: RequesterAvailability;
  photo: RequesterPhoto | null;
}

/**
 * A returnable line's sizes, in size order. A line with no product group, or
 * with no other size the requester may ask for, is not listed: its only
 * exchange is "Request a different replacement: warehouse will review." with
 * a note.
 */
export interface RequesterExchangeLine {
  orderRequestLineId: string;
  options: RequesterExchangeOption[];
}

/** POST .../options (the token page, the portal, a member). */
export interface RequesterExchangeOptionsAnswer {
  /** The kill switch (RETURNS_EXCHANGE_CREATE=off): false hides "Exchange". */
  exchangesEnabled: boolean;
  lines: RequesterExchangeLine[];
}

// ── Tracking: the requester's own requests on the order ─────────────────────

/** A returning or replacement item in the tracking. */
export interface RequesterTrackingItem {
  name: string;
  sizeLabel: string | null;
  /** The requester's own quantity (returning, or asked or approved). */
  quantity: number;
}

/** The stored state of one line's exchange. */
export type RequesterExchangeLineState = 'requested' | 'approved' | 'declined' | 'cancelled';

export interface RequesterTrackingExchange {
  state: RequesterExchangeLineState;
  /** What comes back: the approved item once approved, else the item asked
   *  for; null while the warehouse reviews a request made with a note. */
  replacement: RequesterTrackingItem | null;
  /** The warehouse approved another item than the one asked for (the
   *  screens say "Changed by the warehouse"). */
  substituted: boolean;
}

export interface RequesterTrackingLine {
  returning: RequesterTrackingItem;
  /** Null for a return only. */
  exchange: RequesterTrackingExchange | null;
}

/** One of the requester's own requests (an RMA they made) on the order. */
export interface RequesterTrackingReturn {
  returnNumber: string | null;
  /** When it was requested (ISO 8601). */
  createdAt: string;
  returnStatus: ReturnStatus;
  exchangeStatus: ExchangeStatus;
  /** One or two short sentences (core requesterTrackingSentences). */
  sentences: string[];
  /** "SO-000103" once a replacement order exists and is not cancelled. */
  replacementOrderNumber: string | null;
  lines: RequesterTrackingLine[];
}

/**
 * The requester sheet: GET .../return-request (a member), the token page and
 * the B2B portal's order. Served only for an order that was handed over, in
 * an organization with the returns module on: every other order is a closed
 * door (the public surfaces answer one 404 for all of them).
 */
export interface RequesterReturnSheet {
  /** "SO-000103", or null for an order with no number. */
  orderNumber: string | null;
  /** The name on the order (the requester's own). */
  requesterName: string | null;
  /** The kill switch (RETURNS_EXCHANGE_CREATE=off): false hides "Exchange". */
  exchangesEnabled: boolean;
  lines: RequesterReturnableLine[];
  /** The requester's own requests, newest first (requester-made RMAs only: a
   *  return staff created is not shown, D15). */
  tracking: RequesterTrackingReturn[];
}

// ── The keys every payload may carry (pinned by the server's tests) ─────────

export const REQUESTER_PHOTO_KEYS = ['url', 'thumbUrl'] as const;
export const REQUESTER_RETURNABLE_LINE_KEYS = [
  'orderRequestLineId',
  'name',
  'sizeLabel',
  'photo',
  'quantityFulfilled',
  'quantityRemaining',
] as const;
export const REQUESTER_EXCHANGE_OPTION_KEYS = ['itemId', 'name', 'sizeLabel', 'availability', 'photo'] as const;
export const REQUESTER_EXCHANGE_LINE_KEYS = ['orderRequestLineId', 'options'] as const;
export const REQUESTER_EXCHANGE_OPTIONS_ANSWER_KEYS = ['exchangesEnabled', 'lines'] as const;
export const REQUESTER_TRACKING_ITEM_KEYS = ['name', 'sizeLabel', 'quantity'] as const;
export const REQUESTER_TRACKING_EXCHANGE_KEYS = ['state', 'replacement', 'substituted'] as const;
export const REQUESTER_TRACKING_LINE_KEYS = ['returning', 'exchange'] as const;
export const REQUESTER_TRACKING_RETURN_KEYS = [
  'returnNumber',
  'createdAt',
  'returnStatus',
  'exchangeStatus',
  'sentences',
  'replacementOrderNumber',
  'lines',
] as const;
export const REQUESTER_RETURN_SHEET_KEYS = ['orderNumber', 'requesterName', 'exchangesEnabled', 'lines', 'tracking'] as const;

/** Words no requester payload key may contain (brief 28, 32; plan 3.9). */
const FORBIDDEN_KEY_WORDS: Readonly<Record<string, true>> = {
  sku: true,
  cost: true,
  price: true,
  location: true,
  rack: true,
  bin: true,
  staging: true,
  disposition: true,
  destination: true,
  charter: true,
  warehouse: true,
  group: true,
  variant: true,
  free: true,
  held: true,
  reserved: true,
  reservation: true,
  note: true,
  reason: true,
  supplier: true,
  staff: true,
  actor: true,
  email: true,
  organization: true,
  internal: true,
};

/** Word pairs no key may contain ("quantityOnHand", "approved_by"). */
const FORBIDDEN_KEY_PAIRS: readonly string[] = ['on hand', 'on record', 'approved by', 'denied by', 'received by', 'closed by'];

/** A key's words: camelCase and snake_case split, lower case. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Whether a key name could carry what no requester may see: a SKU, a cost
 * or price, a location, rack or bin, Staging, a disposition or destination,
 * a charter, a warehouse, a group or variant key, a quantity on record or a
 * free, held or reserved count, a note or reason, a supplier, or anyone's
 * identity but the requester's own name.
 */
export function isForbiddenRequesterKey(key: string): boolean {
  const words = keyWords(key);
  const forbidden = (w: string): boolean => Object.prototype.hasOwnProperty.call(FORBIDDEN_KEY_WORDS, w);
  if (words.some((w) => forbidden(w) || forbidden(w.replace(/s$/, '')))) return true;
  const joined = ` ${words.join(' ')} `;
  return FORBIDDEN_KEY_PAIRS.some((pair) => joined.includes(` ${pair} `));
}

/**
 * Every key path in a payload (objects and arrays, any depth) whose name
 * isForbiddenRequesterKey refuses: [] for a payload a requester may receive.
 * The servers' tests run it over everything they build for a requester.
 */
export function forbiddenRequesterKeys(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (isForbiddenRequesterKey(k)) out.push(p);
        walk(x, p);
      }
    }
  };
  walk(value, '');
  return out;
}

// ── Option order ────────────────────────────────────────────────────────────

/**
 * Options in size order (the existing sortBySizeOrder: the category's scale
 * when given, else numeric, else the letter ladder), then by name for a tie.
 * `sizeOf` reads each option's stored size (variant_size), never a size
 * guessed from its name (brief 3).
 */
export function orderRequesterOptions<T extends { name: string }>(
  options: readonly T[],
  sizeOf: (option: T) => string | null | undefined,
): T[] {
  const byName = [...options].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sortBySizeOrder(byName, sizeOf);
}

// ── The order screen: tracking beside the order's own return cards ──────────

/**
 * The order screen's returns as the order's own requester reads them: the web
 * order page and the phone's order screen, one rule (returns RX-3 fix round
 * 1, desk check H1 and M2).
 *
 *   - "Your requests on this order" (the tracking) shows for every viewer the
 *     requester gate admits (their own handed-over order, Returns on, not a
 *     returns manager): `showTracking`. The server tracks only requests the
 *     requester made (D15).
 *   - The order's own card for an RMA the tracking already lists is dropped
 *     only for a viewer who cannot read returns: that card names the reason,
 *     the disposition (Restock, pending) and the staff notes, which the
 *     requester's words never do (plan section 6, brief 28), and it would
 *     list the same request twice. A viewer with returns:read keeps it, since
 *     their card opens the RMA.
 *
 * Matched by RMA number, the one key both reads carry; a return with no
 * number is never dropped. Without tracking (a returns manager, someone
 * else's order, or the read failed) every return keeps the order's card.
 */
export function requesterReturnsView<R extends { returnNumber: string | null }>(input: {
  returns: readonly R[];
  tracking: readonly RequesterTrackingReturn[] | null;
  showTracking: boolean;
  viewerCanReadReturns: boolean;
}): { orderReturns: R[]; tracking: RequesterTrackingReturn[] } {
  if (!input.showTracking || !input.tracking) return { orderReturns: [...input.returns], tracking: [] };
  if (input.viewerCanReadReturns) return { orderReturns: [...input.returns], tracking: [...input.tracking] };
  const tracked = new Set(
    input.tracking.map((t) => t.returnNumber).filter((n): n is string => typeof n === 'string' && n.length > 0),
  );
  return {
    orderReturns: input.returns.filter((r) => !r.returnNumber || !tracked.has(r.returnNumber)),
    tracking: [...input.tracking],
  };
}

/** One tracking line in words (the web's tracking and the phone's card). */
export interface RequesterTrackingLineWords {
  /** "Women's Polo, M ×1". */
  returning: string;
  /** What comes back instead; null for a return only. */
  replacement: string | null;
  /** The line's exchange state ("Requested", "Approved", "Declined", "Cancelled"); null for a return only. */
  state: string | null;
  /** "Changed by the warehouse" when another item than the one asked for was approved. */
  changed: string | null;
}

function trackingItemWords(item: RequesterTrackingItem): string {
  return itemQuantityLabel(returnLineLabel(item.name, item.sizeLabel), item.quantity);
}

/**
 * One returned line of the requester's tracking, in the words both screens
 * show (returns RX-3 fix round 1, desk check M3 and L4). A request made with
 * a note has no replacement item until the warehouse approves one: it reads
 * "Warehouse will review" while it is under review, and "A different
 * replacement" once it was declined or cancelled, so it never says the
 * warehouse will review what it already declined.
 */
export function requesterTrackingLineWords(line: RequesterTrackingLine): RequesterTrackingLineWords {
  const x = line.exchange;
  if (!x) return { returning: trackingItemWords(line.returning), replacement: null, state: null, changed: null };
  const replacement = x.replacement
    ? trackingItemWords(x.replacement)
    : x.state === 'requested'
      ? RETURNS_COPY.replacementWarehouseReview
      : RETURNS_COPY.replacementAskedByNote;
  return {
    returning: trackingItemWords(line.returning),
    replacement,
    state: exchangeLineStatusLabel(x.state),
    changed: x.substituted ? RETURNS_COPY.replacementChangedByWarehouse : null,
  };
}

// ── After a refusal (token page, portal, phone) ─────────────────────────────

/**
 * What a requester form does after the server refused a request (RX-3 fix
 * round 1, desk checks M4, F3 and F4), one rule for every surface:
 *
 *   - 'reload': the form is behind the server (what can come back, an
 *     earlier exchange, a size no longer offered, exchanges switched off).
 *     Read the lines and the sizes again, check the draft against them, and
 *     KEEP the request key: the refused transaction rolled back its key row,
 *     so the same key still means this request.
 *   - 'restart': idempotency_conflict. This key was already used by a request
 *     that went through with other details (an answer lost, then the draft
 *     changed, or a re-read clamped it). Read the lines and the tracking
 *     again, start the draft over with NOTHING chosen and a new key, and say
 *     so (RETURNS_COPY.requesterEarlierRequestSent). Nothing is sent again by
 *     a press alone: a second request needs the person to choose again.
 *   - null: anything else; the form stays as it is.
 */
export type RequesterRefusalRecovery = 'reload' | 'restart';

export function requesterRefusalRecovery(reason: string | null | undefined): RequesterRefusalRecovery | null {
  switch (reason) {
    case 'return_exceeds_fulfilled':
    case 'exchange_already_sent':
    case 'exchange_item_not_eligible':
    case 'exchange_not_available':
      return 'reload';
    case 'idempotency_conflict':
      return 'restart';
    default:
      return null;
  }
}
