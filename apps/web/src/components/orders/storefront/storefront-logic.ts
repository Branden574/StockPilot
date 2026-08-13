// Pure catalog/cart logic for the storefront order page. No React —
// everything in here is unit-testable with plain data. The UI layers
// (cards / toolbar / cart) call these so filtering, sorting, status
// derivation, and totals behave identically everywhere.

import { formatOrderNumber } from '@stockpilot/core';

import { DELIVERY_REQUEST_EMAIL, DELIVERY_REQUEST_EMAIL_NAMES } from '@/lib/site';
import { ORG_TIMEZONE_DEFAULT, formatOrgDateTime } from '@/lib/timezone';

import type { CartLineState, CatalogItem, CharterAddress, StorefrontCharter } from '../v2/types';

/** Derived stock status per item (README state model). */
export type ItemStatus = 'ok' | 'low' | 'out';

/** Availability filter = a set of statuses to keep (empty = all). */
export type AvailabilityFilter = ReadonlySet<ItemStatus>;

export type SortKey =
  | 'featured'
  | 'freq'
  | 'name-asc'
  | 'name-desc'
  | 'stock-desc'
  | 'stock-asc';

export type ViewMode = 'grid' | 'compact';

/** 'all' | 'uncategorized' | categoryId. Mirrors the v2 aisle filter. */
export type CategoryFilter = 'all' | 'uncategorized' | string;

export const SORT_OPTIONS: ReadonlyArray<{ id: SortKey; label: string }> = [
  { id: 'featured', label: 'Featured' },
  { id: 'freq', label: 'Most ordered by you' },
  { id: 'name-asc', label: 'Name · A–Z' },
  { id: 'name-desc', label: 'Name · Z–A' },
  { id: 'stock-desc', label: 'Most available' },
  { id: 'stock-asc', label: 'Least available' },
];

export const AVAILABILITY_LABELS: Record<ItemStatus, string> = {
  ok: 'In stock',
  low: 'Low stock',
  out: 'Out of stock',
};

type StockFields = Pick<CatalogItem, 'quantityOnHand' | 'reservedQuantity'>;
type StatusFields = StockFields & Pick<CatalogItem, 'reorderPoint'>;

/** Available-to-promise = on hand minus open reservations, floored at 0. */
export function availableOf(item: StockFields): number {
  return Math.max(0, item.quantityOnHand - item.reservedQuantity);
}

/**
 * Status derivation: out = nothing available, low = available at or
 * below the reorder point (when one is set), ok otherwise.
 */
export function statusOf(item: StatusFields): ItemStatus {
  const avail = availableOf(item);
  if (avail <= 0) return 'out';
  if (item.reorderPoint > 0 && avail <= item.reorderPoint) return 'low';
  return 'ok';
}

/** Availability pill copy: "107 avail" / "Low · 8 left" / "Out of stock". */
export function availabilityLabel(status: ItemStatus, available: number): string {
  if (status === 'out') return 'Out of stock';
  if (status === 'low') return `Low · ${available} left`;
  return `${available} avail`;
}

/** Two-letter serif glyph for photo-less items ("L4L Water Bottle" → "WB"). */
export function glyphFor(name: string): string {
  return name
    .replace(/^L4L\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase();
}

export interface CatalogFilterInput {
  category: CategoryFilter;
  search: string;
  availability: AvailabilityFilter;
}

/**
 * Composable filter pipeline: category → search → availability.
 * Search matches every whitespace-separated token against the
 * combined name + SKU + category haystack, so "polo w" finds
 * "L4L Polo (Women's)" while single-token queries behave exactly like
 * a substring match on any one field.
 */
export function filterCatalog(
  items: readonly CatalogItem[],
  { category, search, availability }: CatalogFilterInput,
): CatalogItem[] {
  let out = items.slice();

  if (category !== 'all') {
    out =
      category === 'uncategorized'
        ? out.filter((it) => it.categoryId === null)
        : out.filter((it) => it.categoryId === category);
  }

  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    out = out.filter((it) => {
      const hay =
        `${it.name} ${it.sku} ${it.categoryName ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  if (availability.size > 0) {
    out = out.filter((it) => availability.has(statusOf(it)));
  }

  return out;
}

/**
 * Sorts a filtered list. `featured` keeps catalog order; `freq` ranks
 * by the caller-supplied order-frequency map (items the viewer never
 * ordered sink to the bottom, catalog order preserved within ties).
 */
export function sortCatalog(
  items: readonly CatalogItem[],
  sort: SortKey,
  freqByItemId?: ReadonlyMap<string, number>,
): CatalogItem[] {
  const out = items.slice();
  switch (sort) {
    case 'name-asc':
      out.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'name-desc':
      out.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case 'stock-desc':
      out.sort((a, b) => availableOf(b) - availableOf(a));
      break;
    case 'stock-asc':
      out.sort((a, b) => availableOf(a) - availableOf(b));
      break;
    case 'freq': {
      const freqOf = (it: CatalogItem) => freqByItemId?.get(it.id) ?? 0;
      // Array.prototype.sort is stable, so equal-frequency items keep
      // their catalog order.
      out.sort((a, b) => freqOf(b) - freqOf(a));
      break;
    }
    case 'featured':
    default:
      break; // catalog order
  }
  return out;
}

/**
 * "Add full kit" for the New Hire section: one of each item in the
 * category that has stock available. Out-of-stock items are skipped
 * entirely rather than queued at 0.
 */
export function fullKitLines(
  items: readonly CatalogItem[],
): Array<{ itemId: string; quantity: number }> {
  return items
    .filter((it) => statusOf(it) !== 'out')
    .map((it) => ({ itemId: it.id, quantity: 1 }));
}

/**
 * Clamp a typed quantity to what a stepper can legally hold:
 * integers between 0 and the item's available stock. Non-finite input
 * clamps to 0 (the cart reducer removes lines at ≤0).
 */
export function clampQty(value: number, available: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, available), Math.floor(value)));
}

export interface CartTotals {
  lineCount: number;
  unitCount: number;
}

export function cartTotals(lines: readonly CartLineState[]): CartTotals {
  return {
    lineCount: lines.length,
    unitCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

/** itemId → qty map so memoized cards take qty as a scalar prop. */
export function buildQtyMap(
  lines: readonly CartLineState[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of lines) map.set(l.itemId, l.quantity);
  return map;
}

/**
 * Success-state reference line, e.g. "SO-000049 · DC4 · 7 units".
 *
 * This used to be `orderRef()`, which rendered `SO-` plus the first 8 hex
 * characters of the order UUID. That string is visually indistinguishable from
 * the canonical `formatOrderNumber()` output but exists NOWHERE else in the
 * product — not in the orders list, not on the detail page, not in any email,
 * not on a pick or packing slip. An employee who quoted it (and, once the
 * delivery-request assistant ships, an employee who mails it to DC4) quoted a
 * number nobody can look up.
 *
 * The canonical number now reaches the client (createOrderRequestAction returns
 * it), so this renders the real handle. When it is genuinely absent — an old
 * client bundle, or a row the BEFORE-INSERT trigger somehow missed — the
 * fallback is deliberately NOT SO-shaped: a bare uuid prefix reads as an
 * internal id, which is honest, where a fake SO number reads as a searchable
 * order number, which is not.
 */
export function successRefLine(
  orderNumber: number | null,
  orderId: string,
  warehouseName: string,
  unitCount: number,
): string {
  const handle = formatOrderNumber(orderNumber) ?? `Order ${orderId.replace(/-/g, '').slice(0, 8)}`;
  const units = `${unitCount} ${unitCount === 1 ? 'unit' : 'units'}`;
  return `${handle} · ${warehouseName} · ${units}`;
}

/** True when the catalog is in the unfiltered "browse All" state. */
export function isBrowsingAll(input: CatalogFilterInput): boolean {
  return (
    input.category === 'all' &&
    input.search.trim() === '' &&
    input.availability.size === 0
  );
}

/**
 * Collapse anything destined for a plain-text email line: CR, LF, tabs, and
 * every other C0 control character (U+0000-U+001F) plus DEL (U+007F) become a
 * single space, and the result is trimmed.
 *
 * C1 controls (U+0080-U+009F, including NEL, U+0085) are deliberately NOT
 * stripped — they pass through unchanged. That is a scope boundary, not an
 * oversight: every value that reaches here also passes through a
 * percent-encoding transport before it leaves this feature (`encodeDraftQuery`
 * for both compose URLs, the browser's own clipboard write for the copy
 * path), and none of those transports treat a raw C1 control as a delimiter
 * or header marker the way a bare CR/LF would. A C1 character is therefore not
 * weaponizable through any path this feature actually uses, even though this
 * function does not remove it. This matches the server-side twin's narrower
 * behavior below (CR/LF only) rather than widening past what either needs.
 *
 * Two reasons this exists at all, both real. (1) A newline inside a value
 * would break the body's block structure and could forge a header-looking
 * line ("Bcc: ...") in a mail client that parses the pasted text. (2) The
 * repo already has this helper — `sanitizePlainText` in
 * lib/email/order-requests.ts:1247 — but it is module-private and lives in a
 * `server-only` module, so a client builder cannot import it. This is the
 * client-side twin, deliberately named differently so nobody assumes the two
 * are kept in sync.
 */
export function toPlainTextLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Render `charters.address` as zero or more plain-text lines.
 *
 * Returns an EMPTY array whenever there is nothing real to print. The caller
 * must then omit the whole block: 4 of 16 prod charters have `address = null`,
 * and printing "Address:" with nothing under it implies the system captured
 * something it did not.
 *
 * Values are reproduced verbatim, typos included (KVA Tulare's address really
 * says "Calfornia"). Silently correcting a site address inside a delivery
 * instruction would be a worse failure than reproducing the owner's data.
 */
export function formatSiteAddressLines(address: CharterAddress | null): string[] {
  if (!address) return [];
  const clean = (v: string | null | undefined): string =>
    typeof v === 'string' ? toPlainTextLine(v) : '';

  const lines: string[] = [];
  const line1 = clean(address.line1);
  const line2 = clean(address.line2);
  if (line1) lines.push(line1);
  if (line2) lines.push(line2);

  const city = clean(address.city);
  const region = clean(address.region);
  const postal = clean(address.postalCode);
  const cityRegion = [city, region].filter(Boolean).join(', ');
  const cityLine = [cityRegion, postal].filter(Boolean).join(' ');
  if (cityLine) lines.push(cityLine);

  const country = clean(address.country);
  if (country) lines.push(country);

  return lines;
}

/* ---- delivery-request assistant ------------------------------------------ */

/**
 * Everything the draft builder is allowed to see.
 *
 * This is an explicit ALLOW-LIST, not a DTO spread. `internal_notes`,
 * reservations, the assigned picker, `unit_cost_at_request` and
 * `unit_price_at_request` are all staff-only and must never reach a mailbox
 * outside the organisation — the way to guarantee that is for the builder to
 * have no way to reach them.
 *
 * Note what is NOT here, because the data does not exist anywhere in the
 * schema: destination building, room, delivery instructions, priority/urgency,
 * a site contact (0 of 16 charters have a name or email), a requester phone
 * (the internal storefront hardcodes null), a per-line note (0 of 150 prod
 * rows), and unit of measure (present but unselected and messy free text).
 * Adding any of them is a product decision about data CAPTURE and belongs in a
 * separate spec — the assistant must not print a labelled row that implies the
 * system asked a question it never asked.
 */
export interface DeliveryRequestInput {
  /** Order UUID. The detail route is keyed by UUID; there is no route that resolves an SO number. */
  orderId: string;
  /** `order_requests.order_number`, or null when it did not reach the client. */
  orderNumber: number | null;
  fulfillmentType: 'pickup' | 'delivery';
  /** Origin warehouse display name. */
  warehouseName: string;
  /** The delivery site. Null for pickup, and null for the 5 legacy delivery rows with no charter. */
  destination: StorefrontCharter | null;
  /** Who the order is for — on-behalf-of name, else the viewer's name, else their email. */
  requestedFor: string;
  /** The requester's email when known. The one contact DC4 can actually reach. */
  requesterEmail: string | null;
  /** Raw `datetime-local` value ('YYYY-MM-DDTHH:mm') or ''. NOT an ISO instant. */
  neededByLocal: string;
  /** `organizations.timezone`; falls back to America/Los_Angeles. */
  orgTimezone: string;
  /** `order_requests.notes` — the requester-facing message. Safe to include. */
  notes: string;
  lines: readonly CartLineState[];
  /**
   * Only `name` and `sku` — closed at the type level, not merely by
   * convention. A `Map<string, CatalogItem>` remains structurally assignable
   * here (every caller keeps working unchanged), but the builder itself can
   * no longer read `price` or any other staff-only field even by accident:
   * the type checker refuses it.
   */
  itemMap: ReadonlyMap<string, Pick<CatalogItem, 'name' | 'sku'>>;
}

/**
 * The prepared draft. `to` and `cc` are EXPLICIT properties, not merely
 * embedded in a URL, so the preview, both URL builders, the clipboard fallback,
 * the a11y labels and the tests all read one source (addendum requirement 5).
 */
export interface DeliveryRequestDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** True when the address, the notes and the per-line SKUs were dropped to fit a compose link. */
  condensed: boolean;
  lineCount: number;
  unitCount: number;
  /**
   * How many item rows are actually WRITTEN INTO the body — `lineCount` on a
   * full draft, and anywhere from 0 to `lineCount` on a condensed one.
   *
   * This exists because "condensed" used to mean "zero rows", and the UI copy
   * and the analytics both encoded that assumption. Now that condensing fits
   * as many rows as the measured URL allows (see `prepareDeliveryRequest`),
   * the two facts are separate: a draft can be condensed AND still name every
   * line. Anything that tells the employee what the recipient will see has to
   * read this, not `condensed`.
   */
  listedLineCount: number;
}

/**
 * The opening sentence of every shortened-draft disclosure. Split out because
 * all three disclosure shapes below begin with it, and callers (and tests)
 * match on it to detect "this draft was shortened" without caring how far.
 */
const SHORTENED_LEAD =
  'This message was shortened because the full item list did not fit in a compose link.';

/**
 * The disclosure for a draft with ZERO rows listed — the bottom of the ladder,
 * reached only when not even one row fits. Owner-pinned wording, unchanged
 * since 2026-08-01.
 */
const CONDENSED_DISCLOSURE = `${SHORTENED_LEAD} The complete order is in StockPilot under the order number above.`;

/**
 * What the body says about what it left out.
 *
 * ACCURACY IS THE WHOLE POINT (SO-000080, 2026-08-12): DC4 received a delivery
 * request whose item section was the heading `ITEMS (11 lines, 295 units)` and
 * nothing else. The disclosure must name the shortfall precisely — how many
 * lines are here, how many are not, and where the rest live — because the
 * recipient has no other way to tell a complete list from a truncated one.
 *
 * It must NOT instruct the requester to go and paste the list in by hand. That
 * is an available choice (the clipboard path always carries everything) but it
 * is not the only one: the body names the order, and DC4 are org members who
 * can open it in StockPilot — the owner's own position, 2026-08-01.
 *
 * LENGTH IS A REAL COST. Measured 2026-08-13 through both encoding layers, one
 * plain character of body costs, in the Outlook URL: a letter 1, a space 5
 * (`%2520`), a newline 5, an em-dash 15 (`%25E2%2580%2594`). This sentence's
 * partial-list form runs 143 plain characters and costs 255 — 145 more than
 * the zero-row form, which is about two and a half item rows. That is why
 * SO-000080 lands at 10 of 11 rows rather than 11: the honest disclosure is
 * itself worth two rows. `prepareDeliveryRequest` measures the FINISHED body,
 * so the trade is made honestly rather than guessed — but keep this tight.
 *
 * MONOTONICITY CONTRACT: this string must never shrink by more than one item
 * row's worth as `listed` grows, or the binary search in
 * `prepareDeliveryRequest` could step over the true maximum. The only shrinking
 * terms are the omitted-count digits and the "line"/"lines" plural — at most a
 * couple of characters against a row that is never shorter than about twenty.
 * Pinned by the 'encoded URL length grows monotonically' test.
 */
function shortenedDisclosure(listed: number, total: number): string {
  if (listed <= 0) return CONDENSED_DISCLOSURE;
  if (listed >= total) {
    return `${SHORTENED_LEAD} All ${total} ${
      total === 1 ? 'line is' : 'lines are'
    } listed above by name and quantity; item SKUs and the rest of the order detail are in StockPilot under the order number above.`;
  }
  const omitted = total - listed;
  const listedPhrase =
    listed === 1
      ? `Line 1 of ${total} is listed above`
      : `Lines 1-${listed} of ${total} are listed above`;
  return `${SHORTENED_LEAD} ${listedPhrase} by name and quantity; the remaining ${omitted} ${
    omitted === 1 ? 'line' : 'lines'
  } and all item SKUs are in StockPilot under the order number above.`;
}

/**
 * The warning shown above the button when the draft had to be shortened.
 *
 * Lives here rather than in the component so it is a pure function of the
 * draft and can be unit-tested against the exact counts, and so the on-screen
 * claim and the in-body disclosure are written next to each other and cannot
 * drift apart.
 *
 * The zero-row variant keeps its imperative ("Copy the details instead"): with
 * no rows in the message, copying really is the only way to send a list. The
 * other two offer copying as a choice, because the draft already carries real
 * item rows.
 */
export function condensedNoticeText(draft: DeliveryRequestDraft): string {
  const { listedLineCount: listed, lineCount: total } = draft;
  if (listed <= 0) {
    return 'This order is too large to fit in a compose link, so the draft carries a summary. Copy the details instead to include every line.';
  }
  if (listed >= total) {
    return `This order is too large to fit in a compose link, so the draft lists all ${total} lines by name and quantity, without SKUs. Copy the details to put the full list in the message itself.`;
  }
  return `This order is too large to fit in a compose link, so the draft lists the first ${listed} of ${total} lines and says the rest are on the order in StockPilot. Copy the details to put every line in the message itself.`;
}

/** Clamp a requested row cap to [0, lineCount], treating anything non-finite as 0. */
function clampMaxRows(value: number | undefined, lineCount: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), lineCount));
}

/** "SO-000049" when the number is real, else a visibly non-SO handle. */
function orderHandle(orderNumber: number | null, orderId: string): string {
  return formatOrderNumber(orderNumber) ?? orderId.replace(/-/g, '').slice(0, 8);
}

/** "CVW Clovis (CVW-CLO)" / "Mendota" — never "Mendota ()". */
function siteLabel(site: StorefrontCharter): string {
  const name = toPlainTextLine(site.name);
  const code = site.code ? toPlainTextLine(site.code) : '';
  return code ? `${name} (${code})` : name;
}

/**
 * The needed-by line, in the ORG's timezone with the zone named.
 *
 * The value arrives as a `datetime-local` string with no offset, exactly as the
 * cart holds it, and is interpreted in the viewer's zone by `new Date(...)` —
 * the same normalisation `handleConfirmSubmit` performs before submitting. The
 * zone name is printed because a California DC reading a bare time has no way
 * to know whose clock it is. Never `slice(0, 10)` an ISO string here: that
 * shifts the day for any local time after 16:00 PT.
 */
function neededByLine(neededByLocal: string, tz: string): string | null {
  const raw = neededByLocal.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const formatted = formatOrgDateTime(
    d,
    { dateStyle: 'medium', timeStyle: 'short' },
    tz || ORG_TIMEZONE_DEFAULT,
  );
  // formatOrgDateTime only returns '—' when its Date is NaN, and the
  // Number.isNaN guard above already excludes that input — this branch was
  // provably unreachable.
  return `${formatted} (${tz || ORG_TIMEZONE_DEFAULT})`;
}

/**
 * Build the delivery-request draft.
 *
 * Pure: no React, no DOM, no network, no clock beyond formatting the value it
 * was handed. It takes NO recipient argument — it reads DELIVERY_REQUEST_EMAIL
 * — so there is no parameter through which a URL parameter, a stored value, an
 * order note or a site name could redirect the mail.
 *
 * `condensed` exists for RISK R4: Outlook Web compose links and mailto: both
 * carry the body in the query string, practical limits land around 2,000
 * characters, and truncation is SILENT — the client opens with half a body and
 * the employee sends it. Condensed mode drops the street address, the order
 * notes and the per-line SKUs, keeps the counts and the site, and SAYS SO in
 * the body.
 *
 * `maxRows` (condensed only) is the degradation LADDER, added 2026-08-13 after
 * SO-000080. Condensing used to be all-or-nothing: the caller asked for it and
 * every item row vanished, so an 11-line order reached DC4 as the bare heading
 * `ITEMS (11 lines, 295 units)`. Most of those rows would have fit; nothing
 * ever tried. `maxRows` lets `prepareDeliveryRequest` fit as many as the
 * MEASURED url allows and say honestly how many did not — a partial list beats
 * no list. It defaults to 0, so a bare `{ condensed: true }` still produces the
 * old heading-only body byte for byte, which is the bottom rung of the ladder
 * rather than its only rung.
 */
export function buildDeliveryRequestDraft(
  input: DeliveryRequestInput,
  opts: { condensed?: boolean; maxRows?: number } = {},
): DeliveryRequestDraft {
  const condensed = opts.condensed === true;
  const isPickup = input.fulfillmentType === 'pickup';
  // fulfillment_type is the authority. A pickup order's charter is NULL by
  // CHECK constraint; ignoring a stray one keeps us from inventing a
  // destination the order does not have (owner decision D1).
  const site = isPickup ? null : input.destination;

  const { lineCount, unitCount } = cartTotals(input.lines);
  const handle = orderHandle(input.orderNumber, input.orderId);
  const warehouse = toPlainTextLine(input.warehouseName);
  // Honest placeholders, computed once. toPlainTextLine('   ') === '', and an
  // empty value here used to produce a labelled heading with nothing under
  // it — never an invented value, always a visible admission the field is
  // unusable.
  const warehouseLabel = warehouse || '(warehouse not recorded)';
  const requester = toPlainTextLine(input.requestedFor);
  const requesterEmail = input.requesterEmail ? toPlainTextLine(input.requesterEmail) : '';
  const requesterLine = requesterEmail ? `${requester} (${requesterEmail})` : requester;
  const requesterLabel = requesterLine || '(requester not recorded)';

  const siteName = site ? toPlainTextLine(site.name) : '';
  const subjectLocation = siteName || warehouseLabel;
  const subject = toPlainTextLine(`Delivery Request — ${subjectLocation}`);

  // Blocks are assembled as an array and joined with a blank line, so an
  // omitted block leaves no trace — no heading, no stray blank line, and never
  // three newlines in a row.
  //
  // BLOCK ORDER IS A TRUNCATION CONTRACT, not a layout preference. Both
  // transports truncate SILENTLY past ~2,000 characters and `DRAFT_URL_LIMIT`
  // is only a conservative guess at where — a tenant redirect wrapper can
  // still push a "fitting" URL over the real ceiling. So everything that makes
  // the message ACTIONABLE — the order handle, who asked, where it goes, when
  // it is needed — is emitted BEFORE the item rows, which are the longest
  // block by far and the only one that degrades gracefully (the shortened
  // ladder in `prepareDeliveryRequest` cuts rows from the END, and the
  // disclosure says how many). A body cut off mid-item-list still identifies
  // the order and where it goes; a body cut off before the destination does
  // not. Do not move the ITEMS block above any of these.
  const blocks: string[] = [];

  blocks.push(
    [
      'DELIVERY REQUEST — StockPilot',
      '',
      `Order: ${toPlainTextLine(handle)}`,
      `Requested by: ${requesterLabel}`,
      `Fulfillment method: ${isPickup ? 'Pickup / will-call' : 'Delivery'}`,
    ].join('\n'),
  );

  if (isPickup) {
    blocks.push(`PICKUP FROM\n${warehouseLabel} will-call desk`);
    blocks.push(`COLLECTED BY\n${requesterLabel}`);
  } else {
    blocks.push(`FROM (WAREHOUSE)\n${warehouseLabel}`);
    const destinationLabel = site ? siteLabel(site) : '';
    if (site && destinationLabel) {
      const addressLines = condensed ? [] : formatSiteAddressLines(site.address);
      blocks.push(['DELIVERY DESTINATION', destinationLabel, ...addressLines].join('\n'));
    } else {
      // R8: 5 of 41 prod delivery orders have no charter because the CHECK is
      // NOT VALID, and a site whose name is blank after sanitizing is
      // equally unusable — both get the same honest fallback instead of an
      // empty or malformed labelled block.
      blocks.push(
        'DELIVERY DESTINATION\nNot recorded on this order. Please confirm the destination with the requester before delivering.',
      );
    }
  }

  const needed = neededByLine(input.neededByLocal, input.orgTimezone);
  if (needed) blocks.push(`NEEDED BY\n${needed}`);

  // How many rows this body will actually carry. A full draft carries every
  // line; a condensed one carries what `maxRows` allows, which the caller has
  // MEASURED rather than guessed.
  const listedLineCount = condensed ? clampMaxRows(opts.maxRows, lineCount) : lineCount;

  if (lineCount === 0) {
    blocks.push('No line items were recorded on this order.');
  } else {
    const heading = `ITEMS (${lineCount} ${lineCount === 1 ? 'line' : 'lines'}, ${unitCount} ${
      unitCount === 1 ? 'unit' : 'units'
    })`;
    // `?? line.itemId` only catches null/undefined — an empty-string name
    // would sail through and render "1.  — qty 5". `||` catches both a
    // missing item AND a present-but-blank name.
    const nameOf = (line: CartLineState) =>
      toPlainTextLine(input.itemMap.get(line.itemId)?.name || line.itemId);

    if (condensed) {
      // THE SHORTENED ROW FORMAT, and why the SKU is not in it.
      //
      // The full row is `1. Composition Notebook Wide Rule — SP-ZE7TG-XK6 —
      // qty 12`. Those " — " separators are em-dashes: three UTF-8 bytes that
      // become %E2%80%94 and then, once the Outlook `mailtouri` wrapper
      // re-encodes the whole inner mailto, %25E2%2580%2594 — fifteen
      // characters for the dash, plus five for each flanking space: 25 for
      // the separator alone, twice per row. Measured on the SO-000080 shape,
      // one full row costs 126 characters of Outlook URL;
      // `1. Composition Notebook Wide Rule x12` costs 62.
      //
      // Measured end to end through `prepareDeliveryRequest` on SO-000080,
      // disclosure included, 2026-08-13:
      //
      //   `1. Name — SKU — qty 12`  (the full format)   ->  5 of 11 lines
      //   `1. Name — SKU x12`                           ->  6 of 11 lines
      //   `1. Name x12`             (this one)          -> 10 of 11 lines
      //
      // That is the whole argument for dropping the SKU here. DC4 picks by
      // NAME off a shelf, and a SKU cannot disambiguate a line that is not in
      // the message at all — carrying SKUs would cost five of the ten names
      // that now arrive. Two similar titles are a real risk, so it is paid for
      // three ways: the disclosure below states that the SKUs were dropped and
      // where to get them, the FULL row format keeps the SKU untouched, and
      // the clipboard path — which has no URL limit — always carries the full
      // rows. The SKU is dropped ONLY here, in the shortened body.
      const rows = input.lines
        .slice(0, listedLineCount)
        .map((line, i) => `${i + 1}. ${nameOf(line)} x${line.quantity}`);
      blocks.push(rows.length > 0 ? [heading, ...rows].join('\n') : heading);
    } else {
      const rows = input.lines.map((line, i) => {
        const item = input.itemMap.get(line.itemId);
        const sku = item?.sku ? toPlainTextLine(item.sku) : '';
        const label = sku ? `${nameOf(line)} — ${sku}` : nameOf(line);
        return `${i + 1}. ${label} — qty ${line.quantity}`;
      });
      blocks.push([heading, ...rows].join('\n'));
    }
  }

  const notes = toPlainTextLine(input.notes);
  if (notes && !condensed) blocks.push(`ORDER NOTES\n${notes}`);

  if (condensed) {
    // Condensed mode drops ORDER NOTES silently (see above); say so in the
    // same disclosure block rather than letting a real requester note
    // vanish with no signal. The disclosure sentence stays intact and
    // contiguous — callers still assert on it with toContain.
    const disclosure = shortenedDisclosure(listedLineCount, lineCount);
    blocks.push(
      notes
        ? `${disclosure} Order notes were also omitted and are available in StockPilot.`
        : disclosure,
    );
  }

  return {
    to: DELIVERY_REQUEST_EMAIL.to,
    cc: DELIVERY_REQUEST_EMAIL.cc,
    subject,
    body: blocks.join('\n\n'),
    condensed,
    lineCount,
    unitCount,
    listedLineCount,
  };
}

/**
 * Outlook Web compose deep link. Greenfield: the repo had no OWA link, no
 * shared mailto builder and no clipboard helper before this feature.
 *
 * The org runs managed Microsoft 365, so this must be the work-account host
 * (outlook.live.com is the consumer one and would land a work user on the
 * wrong tenant).
 *
 * CORRECTION (2026-08-01): this endpoint originally received plain `to` /
 * `cc` / `subject` / `body` query params. The owner tested that shape
 * against the real L4L tenant and found Outlook Web honors `to`, `subject`
 * and `body` but SILENTLY DROPS `cc` — Andrew (arosas@cvwest.org, a
 * mandatory CC) never landed in the Cc line. Microsoft Q&A confirms a plain
 * `cc=` on `mail/deeplink/compose` is effectively unimplemented. See
 * `buildOutlookComposeUrl` below for the fix (the `mailtouri` form) and its
 * own tenant-verification note.
 *
 * CORRECTION (2026-08-02): the host moved from outlook.office.com to
 * outlook.cloud.microsoft — Microsoft's go-forward unified Outlook Web
 * domain. The owner hit the failure live: office.com now bounces through a
 * domain-migration redirect (an auth-code hop to cloud.microsoft) that DROPS
 * the compose path entirely, landing the user on their bare inbox with no
 * draft. The same mailtouri link on outlook.cloud.microsoft was
 * tenant-verified to open the prefilled compose (candidate E). Landing on
 * the canonical domain also removes the one redirect layer that ate the
 * intent, which is what makes the link survive a cold session.
 *
 * EXTRACTED (2026-08-05, maintenance-requests program, Task 5): this
 * constant, `DRAFT_URL_LIMIT`, and the query-encoding rule (formerly this
 * file's own private `encodeDraftQuery`: %20 for spaces, never '+' —
 * URLSearchParams' form-encoding renders '+' literally in RFC 6068 clients
 * like desktop Outlook, Apple Mail and Thunderbird) now live in
 * `packages/core/src/email/outlook-compose.ts`, because mobile's ONLY
 * workspace dependency is `@stockpilot/core` and the maintenance-requests
 * feature composes Outlook links the same way. `buildOutlookComposeUrl`,
 * `buildMailtoUrl` and `buildClipboardText` below are now thin delegating
 * wrappers around the core `composeOutlookWebUrl` / `composeMailtoUrl` /
 * `composeClipboardText`, supplying this feature's own mandatory `cc` and
 * frozen `DELIVERY_REQUEST_EMAIL_NAMES`. Task 4 proved 13/13 byte-identical
 * output for this exact delivery shape before this file was touched, so
 * every mechanic documented above and below is reproduced verbatim by the
 * core module — the four delivery pinning suites run against these
 * wrappers unchanged, byte-identical.
 */
import {
  OUTLOOK_COMPOSE_BASE as CORE_OUTLOOK_COMPOSE_BASE,
  DRAFT_URL_LIMIT as CORE_DRAFT_URL_LIMIT,
  composeOutlookWebUrl,
  composeMailtoUrl,
  composeClipboardText,
} from '@stockpilot/core';

export const OUTLOOK_COMPOSE_BASE = CORE_OUTLOOK_COMPOSE_BASE;

/**
 * Conservative ceiling for a compose link, in characters.
 *
 * Outlook Web and mailto: both carry the body in the query string. Practical
 * limits land around 2,000 (IE/Edge historically ~2,048; Outlook desktop
 * truncates SILENTLY, which is the dangerous part — the client opens with half
 * a body and the employee sends it). 1,800 leaves headroom for the tenant's own
 * redirect wrapper, which appends to the URL.
 */
export const DRAFT_URL_LIMIT = CORE_DRAFT_URL_LIMIT;

/**
 * Builds its OWN inner mailto: URI — deliberately NOT `buildMailtoUrl`'s
 * output — then wraps it in OWA's `mailtouri` param, NOT plain
 * `to`/`cc`/`subject`/`body` query params.
 *
 * HISTORY: this originally built `${OUTLOOK_COMPOSE_BASE}?to=...&cc=...&
 * subject=...&body=...`, each value encoded once via `encodeDraftQuery`. The
 * owner tested that exact URL against the real L4L Microsoft 365 tenant
 * (2026-08-01): Outlook Web opened the compose window with To, Subject and
 * Body populated correctly, but Cc was EMPTY — Andrew (arosas@cvwest.org, a
 * mandatory CC) silently never received the request. Microsoft Q&A confirms
 * plain `cc=` on `mail/deeplink/compose` is effectively unimplemented; this
 * was not a bug in this codebase, it is how the endpoint behaves.
 *
 * FIX: `mailtouri` is the parameter OWA uses to hand the URL to the
 * browser's registered mailto: protocol handler — that handler's parser
 * must honor `cc` per RFC 6068, and the owner hand-tested this exact form
 * in the same tenant and confirmed BOTH To and Cc populate correctly, with
 * subject and body intact.
 *
 * DISPLAY NAMES (2026-08-01, second tenant test): the owner then verified
 * that this same `mailtouri` parser also handles name-addr forms ("Name
 * <addr>") cleanly IN THE PATH POSITION — his test URL produced OWA compose
 * chips reading 'Fresno Warehouse DC4 <dc4@learn4life.org>' (To) and
 * 'Andrew Rosas <arosas@cvwest.org>' (Cc), correct addresses underneath.
 *
 * CORRECTION on the RFC: name-addr itself is RFC 5322 mailbox syntax, not
 * RFC 6068. RFC 6068 (the mailto: URI scheme) admits a name-addr string
 * only as the VALUE of an hfield like `to=` or `cc=` in the query string —
 * it does not define name-addr in the PATH position at all. Putting a
 * name-addr there, as this function does for the To address, is an OWA
 * `mailtouri` PARSER EXTENSION beyond the RFC, tenant-verified 2026-08-01,
 * not a documented part of RFC 6068 itself. That is exactly why the
 * boundary below exists: nothing says a generic RFC 6068 `mailto:` consumer
 * — including desktop mail clients — would parse a path-position name-addr
 * the same way.
 *
 * So this function builds its own inner mailto: URI rather than reusing
 * `buildMailtoUrl`'s: the To PATH segment is `encodeURIComponent` of
 * `` `${DELIVERY_REQUEST_EMAIL_NAMES.to} <${draft.to}>` `` (spaces become
 * `%20`, angle brackets `%3C`/`%3E`), and the Cc query value — passed
 * through the same %20-not-`+` encoding used for subject/body, so it rides in
 * the RFC-6068-legal hfield-value position — is
 * `` `${DELIVERY_REQUEST_EMAIL_NAMES.cc} <${draft.cc}>` ``. The NAMES come
 * only from the frozen `DELIVERY_REQUEST_EMAIL_NAMES` constant (`@/lib/site`,
 * which also documents why they must stay free of RFC 5322 specials like
 * `,`) — cosmetic labels, never routing truth; `draft.to`/`draft.cc` (from
 * `DELIVERY_REQUEST_EMAIL`) remain the only addresses that actually
 * determine where mail goes.
 *
 * BOUNDARY (deliberate, do not extend): this name-addr treatment is
 * OWA-ONLY. `buildMailtoUrl` — the popup-blocked desktop `mailto:` fallback
 * — stays PLAIN-ADDRESS RFC 6068, because the path-position name-addr this
 * function relies on is an OWA parser extension, and desktop clients'
 * handling of it (Outlook desktop, Apple Mail, Thunderbird) was never
 * tested and is unverified; only the tenant-verified OWA path carries
 * names. `buildClipboardText` and every on-screen recipient label likewise
 * keep bare addresses — those are the owner-pinned strings, unaffected by
 * this constant.
 *
 * The resulting mailto: URI — `mailto:<encoded name-addr To>?cc=<encoded
 * name-addr Cc>&subject=...&body=...` — is wrapped in `encodeURIComponent`
 * EXACTLY ONCE as the `mailtouri` value. That is two encoding layers total
 * — one building this inner URI, one wrapping it here — each applied
 * exactly once; see `decodeCompose` in storefront-logic.test.ts for the
 * reference two-step decode (its `to` needs an explicit
 * `decodeURIComponent` now, since the path segment is no longer a bare,
 * unencoded address).
 *
 * DELEGATED (2026-08-05, Task 5): every mechanic above is now implemented
 * by `composeOutlookWebUrl` in `packages/core/src/email/outlook-compose.ts`.
 * This wrapper supplies the delivery-specific shape only — `draft.to`/
 * `draft.cc` (the routing addresses) and the frozen
 * `DELIVERY_REQUEST_EMAIL_NAMES` (the cosmetic display names) — and the
 * core function performs exactly the steps described above.
 */
export function buildOutlookComposeUrl(draft: DeliveryRequestDraft): string {
  return composeOutlookWebUrl({
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
    toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
    ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
  });
}

/**
 * mailto: fallback for when the popup is blocked or OWA is not the user's
 * client. The To address is the PATH; cc, subject and body are query
 * parameters, built with %20-not-`+` encoding — RFC 6068 gives '+' no space
 * meaning, and this is exactly the client family (desktop Outlook, Apple
 * Mail, Thunderbird) that renders it literally instead of decoding it. Both
 * recipients are still generated — a mailto that drops the CC is
 * non-compliant.
 *
 * DELEGATED (2026-08-05, Task 5): implemented by `composeMailtoUrl` in
 * `packages/core/src/email/outlook-compose.ts`. Bare addresses only, no
 * display names — matching this file's pre-extraction behavior exactly.
 */
export function buildMailtoUrl(draft: DeliveryRequestDraft): string {
  return composeMailtoUrl({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
}

/**
 * Terminal fallback. Safari treats a mailto: navigation with no registered
 * handler as a silent no-op, so the clipboard is the only genuinely reliable
 * path and it must be surfaced explicitly rather than hidden.
 *
 * Labelled blocks so the employee can build the message by hand, INCLUDING the
 * CC. Instructions that omit the CC are non-compliant.
 *
 * DELEGATED (2026-08-05, Task 5): implemented by `composeClipboardText` in
 * `packages/core/src/email/outlook-compose.ts`.
 */
export function buildClipboardText(draft: DeliveryRequestDraft): string {
  return composeClipboardText({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
}

export interface PreparedDeliveryRequest {
  draft: DeliveryRequestDraft;
  outlookUrl: string;
  mailtoUrl: string;
  /** ALWAYS the full body — the clipboard has no URL-length limit. */
  clipboardText: string;
  /**
   * True when the CHOSEN urls — full when they fit, else condensed — both
   * measure at or under `DRAFT_URL_LIMIT`.
   *
   * Site, warehouse and requester names are unbounded database strings.
   * Condensing drops the per-line list, the street address and the order
   * notes, but it does NOT shorten those names — so a pathological name can
   * push even the condensed link past the limit. That is the same silent-
   * truncation failure `condensed` exists to prevent, one step later and
   * with nothing left to drop.
   *
   * When this is false, the UI MUST NOT open either link: the mail client
   * would truncate the body silently, invisible to us and to the employee.
   * It must instead present the clipboard path — which always carries the
   * complete body — as the way to send.
   */
  linkFits: boolean;
}

/**
 * Build everything the UI needs, choosing how much of the item list to carry by
 * MEASURING the encoded URL rather than guessing from the line count. The
 * chosen pair is measured again as `linkFits`, because shortening is not a
 * guarantee — see that field's doc comment.
 *
 * A DEGRADATION LADDER, NOT A CLIFF (2026-08-13, SO-000080). This used to be
 * two rungs: the full body, else a body with the heading and no rows at all.
 * Marissa's 11-line order took the second and DC4 received a delivery request
 * naming no items — while, measured, six of those rows would have fitted and
 * the shortened row format fits all eleven. Nothing ever tried. The rungs now:
 *
 *   1. the full list, SKUs and address and notes included, when it fits;
 *   2. else as many shortened rows as the measured url allows, with the body
 *      saying how many are listed and where the rest are;
 *   3. else the heading-only body, which is rung 2 with zero rows;
 *   4. else `linkFits: false` — nothing is prefilled, unchanged.
 *
 * BOTH TRANSPORTS ARE MEASURED and the longer one binds. The Outlook url wraps
 * an inner mailto in `?mailtouri=` and encodeURIComponent's the whole thing, so
 * the body is url-encoded TWICE: a space costs `%2520` — five characters, not
 * one — and an em-dash `%25E2%2580%2594`, fifteen. On the SO-000080 shape the
 * Outlook url runs 41% longer than the mailto (2232 vs 1580 for the full
 * body), and the mailto alone WOULD have fitted. Never fit rows against a
 * plain-character estimate, and never measure only the cheaper transport.
 *
 * BINARY SEARCH is sound because body length — and therefore url length — is
 * non-decreasing in `maxRows`: each extra row adds its own text, and the only
 * terms of the disclosure that shrink as more rows are listed are the
 * omitted-count digits and a plural 's'. See the monotonicity contract on
 * `shortenedDisclosure`, which a test pins. It costs ceil(log2(n)) + 1 builds
 * instead of n, which matters: this runs inside a render memo.
 *
 * `DRAFT_URL_LIMIT` is deliberately NOT raised to buy rows. Both transports
 * truncate silently past roughly 2,000 characters, and a silently truncated
 * delivery request is worse than an honestly shortened one.
 */
export function prepareDeliveryRequest(input: DeliveryRequestInput): PreparedDeliveryRequest {
  const full = buildDeliveryRequestDraft(input);
  const fullUrl = buildOutlookComposeUrl(full);
  const fullMailto = buildMailtoUrl(full);
  const fits = fullUrl.length <= DRAFT_URL_LIMIT && fullMailto.length <= DRAFT_URL_LIMIT;

  if (fits) {
    return {
      draft: full,
      outlookUrl: fullUrl,
      mailtoUrl: fullMailto,
      clipboardText: buildClipboardText(full),
      linkFits: true,
    };
  }

  const attempt = (maxRows: number) => {
    const draft = buildDeliveryRequestDraft(input, { condensed: true, maxRows });
    const outlookUrl = buildOutlookComposeUrl(draft);
    const mailtoUrl = buildMailtoUrl(draft);
    return {
      draft,
      outlookUrl,
      mailtoUrl,
      fits: outlookUrl.length <= DRAFT_URL_LIMIT && mailtoUrl.length <= DRAFT_URL_LIMIT,
    };
  };

  // Rung 3 first: it is both the floor of the search and the answer when even
  // it does not fit (rung 4). Searching upward from a known-good floor is what
  // keeps `linkFits: false` reachable and honest.
  let best = attempt(0);

  if (best.fits) {
    let lo = 1;
    let hi = full.lineCount;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = attempt(mid);
      if (candidate.fits) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
  }

  return {
    draft: best.draft,
    outlookUrl: best.outlookUrl,
    mailtoUrl: best.mailtoUrl,
    // ALWAYS the full, uncondensed body. The clipboard has no URL-length limit
    // and is the escape hatch — degrading it too would lose detail for no
    // reason. Note this is `full`, never `best.draft`.
    clipboardText: buildClipboardText(full),
    linkFits: best.fits,
  };
}
