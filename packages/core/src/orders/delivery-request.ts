/**
 * The delivery-request draft builder.
 *
 * WHY THIS IS IN CORE (moved 2026-08-13 from
 * `apps/web/src/components/orders/storefront/storefront-logic.ts`):
 *
 * Both surfaces have to send the SAME email. The web storefront has composed
 * delivery requests since 2026-08-01; the mobile order screen is about to. Two
 * copies of a message builder drift — not in theory, this is the exact failure
 * class this codebase has been fighting all week (recurring pattern #26: a fix
 * applied to one copy of a duplicated function is not a fix). The observable
 * cost of drift here is unusually high, because the failure is SILENT: a
 * delivery request that reaches DC4 with a stale item format, a shortened body
 * that no longer discloses what it dropped, or — worst — without the mandatory
 * CC, still looks like a delivered message to the employee who sent it.
 *
 * So the message is defined once, here, and each surface renders and transports
 * what this returns. Pure TS: no React, no DOM, no network, no clock beyond
 * formatting the value it was handed, no `server-only`. Safe under Hermes.
 *
 * TENANT-NEUTRAL BY CONSTRUCTION. Unlike its web ancestor, nothing in this
 * module reads a recipient constant. Recipients arrive on the input, are
 * validated, and travel on the draft. See `DeliveryRequestRecipients`.
 */

import {
  DRAFT_URL_LIMIT,
  composeClipboardText,
  composeMailtoUrl,
  composeOutlookWebUrl,
} from '../email/outlook-compose';
import { ORG_TIMEZONE_DEFAULT, formatOrgDateTime } from '../time/org-timezone';

import { cartTotals, type OrderLineQuantity } from './cart-totals';
import { formatOrderNumber } from './order-number';

/**
 * Collapse anything destined for a plain-text email line: CR, LF, tabs, and
 * every other C0 control character (U+0000-U+001F) plus DEL (U+007F) become a
 * single space, and the result is trimmed.
 *
 * C1 controls (U+0080-U+009F, including NEL, U+0085) are deliberately NOT
 * stripped — they pass through unchanged. That is a scope boundary, not an
 * oversight: every value that reaches here also passes through a
 * percent-encoding transport before it leaves this feature (`encodeDraftQuery`
 * for all three compose URLs, the browser's own clipboard write for the copy
 * path), and none of those transports treat a raw C1 control as a delimiter
 * or header marker the way a bare CR/LF would. A C1 character is therefore not
 * weaponizable through any path this feature actually uses, even though this
 * function does not remove it. This matches the server-side twin's narrower
 * behavior (CR/LF only) rather than widening past what either needs.
 *
 * Two reasons this exists at all, both real. (1) A newline inside a value
 * would break the body's block structure and could forge a header-looking
 * line ("Bcc: ...") in a mail client that parses the pasted text. (2) The
 * repo already has this helper — `sanitizePlainText` in
 * apps/web/src/lib/email/order-requests.ts — but it is module-private and
 * lives in a `server-only` module, so a client builder cannot import it. This
 * is the client-side twin, deliberately named differently so nobody assumes
 * the two are kept in sync.
 */
export function toPlainTextLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `charters.address` is a jsonb blob, not a typed column set. Every key is
 * optional and any of them can be null or an empty string in prod.
 *
 * The regional key is **`region`**, NOT `state`. Reading `state` returns
 * undefined for every row in the database.
 *
 * Structurally identical to the storefront's own `CharterAddress`
 * (`apps/web/src/components/orders/v2/types.ts`), which is left in place and
 * untouched: every existing storefront object satisfies this shape with no
 * change at any call site.
 */
export interface DeliveryRequestAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/**
 * A delivery site. The UI calls a charter a "site". `address` is present for
 * 12 of 16 prod charters; null for the rest, and the renderer must print
 * NOTHING rather than an empty labelled block when it is.
 */
export interface DeliveryRequestSite {
  id: string;
  name: string;
  code: string | null;
  address: DeliveryRequestAddress | null;
}

/**
 * All the builder is allowed to know about an item.
 *
 * Closed at the type level, not merely by convention. A richer catalog record
 * (web's 17-field `CatalogItem`) remains structurally assignable, so every
 * caller keeps working unchanged, but the builder itself cannot read `price`
 * or any other staff-only field even by accident: the type checker refuses it.
 */
export interface DeliveryRequestItemRef {
  name: string;
  sku: string;
}

/**
 * Where the mail goes, supplied by the SURFACE rather than read from a
 * constant in here.
 *
 * THIS IS A DELIBERATE REVERSAL of the web ancestor, which took no recipient
 * argument and read `DELIVERY_REQUEST_EMAIL` directly, on the reasoning that
 * "there is no parameter for a caller to poison". Two things make an explicit
 * parameter the stronger position now that the builder is shared:
 *
 *  1. HONESTY ABOUT TENANCY. `dc4@learn4life.org` is one customer's mailbox.
 *     A shared platform package silently mailing every org's delivery requests
 *     to one tenant's intake is a worse property than a parameter. The literal
 *     still has exactly one home (`./delivery-request-recipients.ts`) so the
 *     surfaces cannot drift, but the BUILDER no longer depends on it, which is
 *     what makes per-org configuration a call-site change instead of a rewrite.
 *  2. THE CC BECOMES EXPLICIT AND ENFORCED. `cc` is required by the type and
 *     validated at runtime below. The delivery workflow's acceptance gate is
 *     that a fixed CC receives a copy; under the old shape, losing the CC was
 *     a one-character edit to a constant that no type or check would catch.
 *     Now a missing, empty or malformed CC is a hard throw at draft time —
 *     before anything is composed, opened or sent.
 *
 * The poisoning concern the old comment named is answered by
 * `assertRoutableAddress`, not by the absence of a parameter: both addresses
 * must be a single, plain, unadorned mailbox, or the builder refuses to build.
 * That is a real runtime check where the old design had none — safety there
 * rested entirely on the values happening to be literals.
 */
export interface DeliveryRequestRecipients {
  /** The intake mailbox. Exactly one plain address. */
  to: string;
  /**
   * The mandatory copy. Required, and required to be non-empty: this
   * workflow's acceptance gate is that this address receives a copy, so
   * "no cc" is not an expressible state.
   */
  cc: string;
  /** Cosmetic OWA compose-chip name for `to`. Literals only; validated. */
  toName?: string;
  /** Cosmetic OWA compose-chip name for `cc`. Literals only; validated. */
  ccName?: string;
}

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
  /** Where the mail goes. See `DeliveryRequestRecipients`. */
  recipients: DeliveryRequestRecipients;
  /** Order UUID. The detail route is keyed by UUID; there is no route that resolves an SO number. */
  orderId: string;
  /** `order_requests.order_number`, or null when it did not reach the client. */
  orderNumber: number | null;
  fulfillmentType: 'pickup' | 'delivery';
  /** Origin warehouse display name. */
  warehouseName: string;
  /** The delivery site. Null for pickup, and null for the 5 legacy delivery rows with no charter. */
  destination: DeliveryRequestSite | null;
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
  lines: readonly OrderLineQuantity[];
  /** Only `name` and `sku` — see `DeliveryRequestItemRef`. */
  itemMap: ReadonlyMap<string, DeliveryRequestItemRef>;
}

/**
 * The prepared draft. `to` and `cc` are EXPLICIT properties, not merely
 * embedded in a URL, so the preview, the URL builders, the clipboard fallback,
 * the a11y labels and the tests all read one source.
 */
export interface DeliveryRequestDraft {
  to: string;
  cc: string;
  /**
   * Cosmetic display names, carried through from the recipients so the OWA
   * url builder needs no second argument and no constant of its own. Routing
   * truth is `to`/`cc` above; these are chip decoration and are dropped by
   * every transport except the tenant-verified OWA `mailtouri` path.
   */
  toName?: string;
  ccName?: string;
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
 * ONE plain mailbox, nothing else.
 *
 * No whitespace (a space would let a second address ride along after
 * percent-encoding survives the transport), no `<>` (name-addr syntax, which
 * belongs only in the cosmetic display-name half), no `,` or `;` (the RFC 5322
 * recipient separators — the characters that split one recipient into two and
 * silently drop the mandatory CC), no `"` (quoted-string escaping), and exactly
 * one `@` with a dot-bearing domain.
 */
const ROUTABLE_ADDRESS = /^[^\s<>,;:"@]+@[^\s<>,;:"@]+\.[^\s<>,;:"@]+$/;

/**
 * Refuse to build rather than misroute.
 *
 * The delivery workflow's acceptance gate is that a fixed CC receives a copy.
 * Every failure mode this rejects is SILENT if allowed through: a comma splits
 * the recipient list, an empty string composes mail to nowhere, a name-addr in
 * the address position confuses a parser into dropping the rest. A throw
 * happens at draft time — before any compose window opens, before the employee
 * can believe a message went out — which is the only point where the failure
 * is still visible.
 *
 * With compile-time literals (every caller today) this can never fire. It is
 * here for the per-org configuration that `delivery-request-recipients.ts`
 * flags as deferred: on the day an address becomes data, this is what stands
 * between a bad row and warehouse mail going somewhere nobody checks.
 */
function assertRoutableAddress(field: 'to' | 'cc', value: string): string {
  if (!ROUTABLE_ADDRESS.test(value)) {
    throw new Error(
      `Delivery-request recipient "${field}" must be exactly one plain email address ` +
        'with no display name, separator or whitespace.',
    );
  }
  return value;
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
export function formatSiteAddressLines(address: DeliveryRequestAddress | null): string[] {
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

/**
 * The warning shown above the button when the draft had to be shortened.
 *
 * Lives here rather than in the component so it is a pure function of the
 * draft and can be unit-tested against the exact counts, and so the on-screen
 * claim and the in-body disclosure are written next to each other and cannot
 * drift apart. That property is now load-bearing across two surfaces rather
 * than one: mobile renders this same string.
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
function siteLabel(site: DeliveryRequestSite): string {
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
 * was handed. Recipients arrive on `input.recipients` and are validated by
 * `assertRoutableAddress` before anything is composed — a value that could
 * redirect the mail or split off the mandatory CC throws here rather than
 * riding into a compose window.
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
  const to = assertRoutableAddress('to', input.recipients.to);
  const cc = assertRoutableAddress('cc', input.recipients.cc);

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
    const nameOf = (line: OrderLineQuantity) =>
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
    to,
    cc,
    toName: input.recipients.toName,
    ccName: input.recipients.ccName,
    subject,
    body: blocks.join('\n\n'),
    condensed,
    lineCount,
    unitCount,
    listedLineCount,
  };
}

/**
 * Outlook Web compose deep link for a delivery-request draft.
 *
 * HISTORY (the record lives here because git is the only other place it
 * exists). This originally built `${OUTLOOK_COMPOSE_BASE}?to=...&cc=...&
 * subject=...&body=...`, each value encoded once. The owner tested that exact
 * URL against the real L4L Microsoft 365 tenant (2026-08-01): Outlook Web
 * opened the compose window with To, Subject and Body populated correctly, but
 * Cc was EMPTY — Andrew (arosas@cvwest.org, a mandatory CC) silently never
 * received the request. Microsoft Q&A confirms plain `cc=` on
 * `mail/deeplink/compose` is effectively unimplemented; this was not a bug in
 * this codebase, it is how the endpoint behaves.
 *
 * FIX: `mailtouri` is the parameter OWA uses to hand the URL to the browser's
 * registered mailto: protocol handler — that handler's parser must honor `cc`
 * per RFC 6068, and the owner hand-tested this exact form in the same tenant
 * and confirmed BOTH To and Cc populate correctly, with subject and body
 * intact.
 *
 * HOST (2026-08-02): outlook.cloud.microsoft, never outlook.office.com.
 * office.com now bounces through a domain-migration redirect (an auth-code hop
 * to cloud.microsoft) that DROPS the compose path entirely, landing the user on
 * their bare inbox with no draft. The owner hit that live. The same mailtouri
 * link on outlook.cloud.microsoft was tenant-verified to open the prefilled
 * compose. Landing on the canonical domain also removes the one redirect layer
 * that ate the intent, which is what makes the link survive a cold session.
 *
 * DISPLAY NAMES (2026-08-01, second tenant test): the owner verified that this
 * same `mailtouri` parser handles name-addr forms ("Name <addr>") cleanly IN
 * THE PATH POSITION — his test URL produced OWA compose chips reading 'Fresno
 * Warehouse DC4 <dc4@learn4life.org>' (To) and 'Andrew Rosas
 * <arosas@cvwest.org>' (Cc), correct addresses underneath.
 *
 * CORRECTION on the RFC: name-addr itself is RFC 5322 mailbox syntax, not RFC
 * 6068. RFC 6068 (the mailto: URI scheme) admits a name-addr string only as the
 * VALUE of an hfield like `to=` or `cc=` in the query string — it does not
 * define name-addr in the PATH position at all. Putting a name-addr there is an
 * OWA `mailtouri` PARSER EXTENSION beyond the RFC, tenant-verified 2026-08-01.
 * That is exactly why the boundary below exists: nothing says a generic RFC
 * 6068 `mailto:` consumer — including desktop mail clients — would parse a
 * path-position name-addr the same way.
 *
 * BOUNDARY (deliberate, do not extend): the name-addr treatment is OWA-ONLY.
 * `buildDeliveryRequestMailtoUrl` — the popup-blocked desktop fallback — stays
 * PLAIN-ADDRESS RFC 6068, and so does the native `ms-outlook://` transport,
 * because both are different, unverified parsers and guessing wrong there costs
 * exactly the silent CC drop above. `buildDeliveryRequestClipboardText` and
 * every on-screen recipient label likewise keep bare addresses.
 *
 * The mechanics — the single `mailtouri` param, the two encoding layers each
 * applied exactly once, `%20`-not-`+` encoding, and the `assertSafeDisplayName`
 * guard on the chip names — are implemented by `composeOutlookWebUrl` in
 * `../email/outlook-compose.ts` (extracted 2026-08-05, proved byte-identical
 * for this exact delivery shape before the web file was touched). This function
 * supplies the delivery shape only.
 */
export function buildDeliveryRequestOutlookUrl(draft: DeliveryRequestDraft): string {
  return composeOutlookWebUrl({
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
    toName: draft.toName,
    ccName: draft.ccName,
  });
}

/**
 * mailto: fallback for when the popup is blocked or OWA is not the user's
 * client. The To address is the PATH; cc, subject and body are query
 * parameters, built with %20-not-`+` encoding — RFC 6068 gives '+' no space
 * meaning, and this is exactly the client family (desktop Outlook, Apple
 * Mail, Thunderbird) that renders it literally instead of decoding it. Both
 * recipients are still generated — a mailto that drops the CC is
 * non-compliant. Bare addresses only, no display names.
 */
export function buildDeliveryRequestMailtoUrl(draft: DeliveryRequestDraft): string {
  return composeMailtoUrl({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
}

/**
 * Terminal fallback. Safari treats a mailto: navigation with no registered
 * handler as a silent no-op, so the clipboard is the only genuinely reliable
 * path and it must be surfaced explicitly rather than hidden.
 *
 * Labelled blocks so the employee can build the message by hand, INCLUDING the
 * CC. Instructions that omit the CC are non-compliant.
 */
export function buildDeliveryRequestClipboardText(draft: DeliveryRequestDraft): string {
  return composeClipboardText({
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body,
  });
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
 * Build everything a surface needs, choosing how much of the item list to carry
 * by MEASURING the encoded URL rather than guessing from the line count. The
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
 * The native `ms-outlook://` url is deliberately NOT measured here: it is
 * shorter than the web url for identical input by construction (a 20-character
 * scheme and one encoding layer, against a 52-character https base and a
 * double-encoded inner mailto), so a draft that fits the web url transitively
 * fits the native one. That relationship is pinned by a test in
 * `../email/outlook-compose.test.ts`; do not replace it with an assumption.
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
  const fullUrl = buildDeliveryRequestOutlookUrl(full);
  const fullMailto = buildDeliveryRequestMailtoUrl(full);
  const fits = fullUrl.length <= DRAFT_URL_LIMIT && fullMailto.length <= DRAFT_URL_LIMIT;

  if (fits) {
    return {
      draft: full,
      outlookUrl: fullUrl,
      mailtoUrl: fullMailto,
      clipboardText: buildDeliveryRequestClipboardText(full),
      linkFits: true,
    };
  }

  const attempt = (maxRows: number) => {
    const draft = buildDeliveryRequestDraft(input, { condensed: true, maxRows });
    const outlookUrl = buildDeliveryRequestOutlookUrl(draft);
    const mailtoUrl = buildDeliveryRequestMailtoUrl(draft);
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
    clipboardText: buildDeliveryRequestClipboardText(full),
    linkFits: best.fits,
  };
}
