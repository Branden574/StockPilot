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
  assertRoutableAddress,
  assertSafeDisplayName,
  composeClipboardText,
  composeMailtoUrl,
  composeOutlookMobileUrl,
  composeOutlookWebUrl,
  type ComposeTransport,
} from '../email/outlook-compose';
import { formatOrgDateTime, resolveOrgTimezone } from '../time/org-timezone';

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
 *
 * THE TYPE IS BRANDED, AND THAT IS THE OTHER HALF OF THE ANSWER (2026-08-13).
 * A value-level check cannot see a call site that does not exist yet. Both
 * shipped call sites are pinned hard — a wrong cc fails 11 mobile and 29 web
 * tests, an omitted one is a type error, an empty one throws — but a THIRD call
 * site writing `{ to: DELIVERY_REQUEST_EMAIL.to, cc: 'ops@somewhere.test' }`
 * would have compiled clean, passed the whole suite, and composed a real
 * misrouted URL, because a routable-but-wrong address is exactly what every
 * runtime guard here is designed to accept. The no-parameter design this
 * replaced gave that guarantee structurally, by having nothing to pass.
 *
 * The brand restores it at the type level, and `deliveryRequestRecipients`
 * below is the only constructor, which validates. The seam the deferred per-org
 * work needs is untouched — that work calls the factory with values read from
 * the org row, which is precisely the path the validation is for.
 *
 * WHY THE BRAND IS A PRIVATE CLASS MEMBER AND NOT A `unique symbol` KEY
 * (2026-08-13, third pass). It was a module-private `unique symbol` property
 * first. That stopped a bare object literal, and stopped nothing else, because
 * an object SPREAD reproduces symbol-keyed properties in the resulting type:
 *
 *     const r: DeliveryRequestRecipients = {
 *       ...DELIVERY_REQUEST_RECIPIENTS, cc: 'ops@somewhere.test' };
 *
 * typechecked clean, with no cast, and is far and away the most natural way
 * someone would actually write a wrong recipient — you start from the value
 * that works and change the field you mean to change. Verified: that line
 * compiled with zero errors under the symbol brand.
 *
 * A private class member is the one thing TypeScript's spread does NOT carry
 * over (`isSpreadableProperty` skips private and protected members), so the
 * spread now fails with TS2741 — `Property '__deliveryRecipientsBrand' is
 * missing`. The class is `declare`d, so it emits nothing and exists only in the
 * type space; the interface extends it, so every existing type position,
 * import and cast is unchanged.
 *
 * WHAT IS STILL OPEN, MEASURED, NOT ASSUMED. `Object.assign({},
 * DELIVERY_REQUEST_RECIPIENTS, { cc: 'ops@somewhere.test' })` still typechecks,
 * and NO brand of any shape can stop it: `Object.assign`'s own lib signature
 * returns `T & U & V`, an intersection that includes `DeliveryRequestRecipients`
 * itself, so the brand is re-supplied by the return type by construction —
 * whether the brand is a symbol key, a private member, or a branded `cc` string.
 * That path is not refused at runtime either, because a wrong-but-routable
 * address is exactly what `assertRoutableAddress` is designed to accept. Both
 * facts are pinned as tests below, deliberately including the one that fails to
 * refuse, so nobody reads this brand as stronger than it is. What the brand
 * gives is this: the accidental version is impossible, and the remaining
 * version has to be written on purpose.
 */
export interface DeliveryRequestRecipients extends DeliveryRecipientsBrand {
  /** The intake mailbox. Exactly one plain address. */
  readonly to: string;
  /**
   * The mandatory copy. Required, and required to be non-empty: this
   * workflow's acceptance gate is that this address receives a copy, so
   * "no cc" is not an expressible state.
   */
  readonly cc: string;
  /** Cosmetic OWA compose-chip name for `to`. Literals only; validated. */
  readonly toName?: string;
  /** Cosmetic OWA compose-chip name for `cc`. Literals only; validated. */
  readonly ccName?: string;
}

/**
 * NOMINAL BRAND, and nothing else. `declare class` is ambient — it emits no
 * runtime code and no value is ever constructed from it — so this costs nothing
 * at run time and cannot be imported, named or forged by any other module.
 *
 * A private member rather than a symbol-keyed property because that is the only
 * kind of property TypeScript refuses to reproduce through an object spread;
 * see the long note on `DeliveryRequestRecipients` for the measurement.
 */
declare class DeliveryRecipientsBrand {
  private readonly __deliveryRecipientsBrand: true;
}

/**
 * THE ONLY CONSTRUCTOR for `DeliveryRequestRecipients`.
 *
 * Validates before it brands, so the brand is not merely nominal: a value of
 * this type is a value whose addresses were checked and whose display names
 * were checked. Callers that bypass it with a cast still meet
 * `assertRoutableAddress` inside `buildDeliveryRequestDraft` — the runtime
 * guard is not removed, it is doubled, because the two catch different things.
 * The type catches the wrong-but-well-formed address a new call site types by
 * hand; the runtime catches the malformed one that arrives as data.
 *
 * Frozen for the same reason the recipient constants are: a stray assignment
 * throws in strict mode instead of silently redirecting warehouse mail.
 */
export function deliveryRequestRecipients(input: {
  to: string;
  cc: string;
  toName?: string;
  ccName?: string;
}): DeliveryRequestRecipients {
  const value: Record<string, string> = {
    to: assertRoutableAddress('to', input.to),
    cc: assertRoutableAddress('cc', input.cc),
  };
  if (input.toName !== undefined) value.toName = assertSafeDisplayName(input.toName);
  if (input.ccName !== undefined) value.ccName = assertSafeDisplayName(input.ccName);
  return Object.freeze(value) as unknown as DeliveryRequestRecipients;
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
  // Resolved ONCE and used for BOTH the arithmetic and the label. A stored
  // `organizations.timezone` this runtime does not recognise degrades to the
  // default rather than throwing out of the caller's render — but the label
  // then has to say the zone that was actually used. Formatting in Pacific
  // while printing "(America/Fresno)" beside it would state a specific,
  // checkable falsehood in mail to a warehouse, which is worse than either
  // failing or falling back honestly.
  const zone = resolveOrgTimezone(tz);
  const formatted = formatOrgDateTime(d, { dateStyle: 'medium', timeStyle: 'short' }, zone);
  // formatOrgDateTime only returns '—' when its Date is NaN, and the
  // Number.isNaN guard above already excludes that input — this branch was
  // provably unreachable.
  return `${formatted} (${zone})`;
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
 * NATIVE Outlook app deep link (`ms-outlook://compose`) for the same draft.
 *
 * ADDED alongside `buildDeliveryRequestOutlookUrl`, never instead of it. On a
 * phone, handing the https OWA url to `Linking.openURL` opens a BROWSER on
 * Outlook Web — correct on desktop, wrong on a device where the Outlook app is
 * installed and already signed in. Same draft, same subject, same body, same
 * mandatory CC, same `%20` encoder: only the transport differs.
 *
 * BARE ADDRESSES, deliberately. The name-addr compose chips
 * (`Fresno Warehouse DC4 <dc4@learn4life.org>`) are a VERIFIED OWA-Web
 * `mailtouri` parser extension and stop at that boundary — the native app is a
 * different, unverified parser, and a name-addr it mis-splits costs exactly the
 * silent CC drop this whole feature is built around. `composeOutlookMobileUrl`
 * still runs `assertSafeDisplayName` over the names before dropping them, so an
 * unsafe name is a hard throw on BOTH transports rather than a quiet difference
 * between them. A missing chip is cosmetic; a missing CC breaks the workflow.
 */
export function buildDeliveryRequestOutlookMobileUrl(draft: DeliveryRequestDraft): string {
  return composeOutlookMobileUrl({
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

/**
 * WHICH COMPOSE URL THE CALLING SURFACE WILL ACTUALLY HAND TO THE OS.
 *
 * This is a MEASUREMENT input, not a rendering option: the ladder in
 * `prepareDeliveryRequest` fits item rows against the url that will really be
 * opened, and the two transports have very different budgets for the same body.
 *
 *  - `outlook-web` — the https OWA deep link. Its body rides inside a
 *    `?mailtouri=` wrapper and is therefore percent-encoded TWICE (a space
 *    costs `%2520`, an em-dash `%25E2%2580%2594`), on top of a 52-character
 *    base. This is the expensive one.
 *  - `outlook-native` — `ms-outlook://compose`. A 20-character scheme and ONE
 *    encoding layer. Measured on a realistic 25-line order, the same chosen
 *    draft is 1303 characters here against 1776 on the web url.
 *
 * WHY THIS PARAMETER EXISTS (2026-08-13). It did not, and the phone paid for
 * it. `prepareDeliveryRequest` fitted every rung against the WEB url, but a
 * phone with Outlook installed opens `ms-outlook://` — so on that 25-line order
 * the ladder stopped at 7 rows with 497 characters of native headroom left
 * unused, and DC4 received a delivery request naming 7 items when 15 would have
 * fitted. That is the same complaint that started this work (SO-000080), one
 * layer down: rows dropped because nothing measured the transport that opens.
 *
 * DEFAULT IS `outlook-web`, and that is the SAFE default rather than merely the
 * incumbent one. It is the longest url any surface opens, so a draft fitted for
 * it fits every transport; fitting for `outlook-native` and then opening the web
 * url would silently truncate, which is strictly worse than dropping a row. A
 * caller may only ask for `outlook-native` when it KNOWS the native app is the
 * one that will open — see `deliveryComposeTransport` in
 * apps/mobile/src/lib/delivery-request-actions.ts, which derives this and the
 * open plan from one probe answer so the two cannot disagree.
 *
 * The union itself is the SHARED `ComposeTransport` (../email/outlook-compose)
 * since 2026-08-16, when the maintenance twin gained the same option — one
 * definition, two feature-named views, so the two ladders cannot drift apart
 * on what a transport even is.
 */
export type DeliveryComposeTransport = ComposeTransport;

export interface PrepareDeliveryRequestOptions {
  /** The compose url this surface will open. Defaults to the longest one,
   *  `outlook-web`. See `DeliveryComposeTransport`. */
  transport?: DeliveryComposeTransport;
}

export interface PreparedDeliveryRequest {
  draft: DeliveryRequestDraft;
  /**
   * OWA WEB compose deep link (https). What the web app opens in a new tab,
   * and what mobile falls back to when the native app is not installed.
   *
   * MEASURED ONLY UNDER `transport: 'outlook-web'` (the default). A caller that
   * asked for `outlook-native` has declared that this url is not the one it
   * opens, and this field may then exceed `DRAFT_URL_LIMIT` even while
   * `linkFits` is true — opening it anyway would truncate the body silently.
   * `transport` below records which url the ladder actually fitted.
   */
  outlookUrl: string;
  /**
   * NATIVE Outlook app deep link (`ms-outlook://compose`) for the SAME chosen
   * draft — the one whose length was measured, never a different rung of the
   * ladder. Built here rather than by each surface so that no caller can
   * assemble a native url from a body the limit check never saw.
   *
   * MEASURED ONLY UNDER `transport: 'outlook-native'`. Under the web default it
   * is still safe to open unmeasured, because it is shorter than `outlookUrl`
   * for identical input by construction (a 20-character scheme and one encoding
   * layer, against a 52-character https base and a double-encoded inner
   * mailto), so a draft that fits the web url transitively fits this one. That
   * inequality is pinned by test in `../email/outlook-compose.test.ts`; the
   * reverse direction is NOT true, which is why `outlookUrl` above carries the
   * opposite warning.
   */
  outlookMobileUrl: string;
  /** RFC 6068 `mailto:`. Measured under BOTH transports — every surface offers
   *  it, either as its own button or as the cc-untrusted reroute. */
  mailtoUrl: string;
  /** Which url the ladder was fitted against. Echoed back so a caller can
   *  assert that what it opens is what was measured. */
  transport: DeliveryComposeTransport;
  /** ALWAYS the full body — the clipboard has no URL-length limit. */
  clipboardText: string;
  /**
   * True when the CHOSEN urls — full when they fit, else condensed — both
   * measure at or under `DRAFT_URL_LIMIT`. "The chosen urls" means the
   * `transport` url above and `mailtoUrl`, not all three: see `outlookUrl`.
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
 * THE OPENED TRANSPORT IS THE ONE MEASURED, plus the mailto, and the longer of
 * the pair binds. Which "opened transport" that is comes from
 * `opts.transport` — see `DeliveryComposeTransport` for why the caller has to
 * declare it and why the default is the expensive web url.
 *
 * The Outlook WEB url wraps an inner mailto in `?mailtouri=` and
 * encodeURIComponent's the whole thing, so its body is url-encoded TWICE: a
 * space costs `%2520` — five characters, not one — and an em-dash
 * `%25E2%2580%2594`, fifteen. On the SO-000080 shape it runs 41% longer than
 * the mailto (2232 vs 1580 for the full body), and the mailto alone WOULD have
 * fitted. Never fit rows against a plain-character estimate, and never measure
 * only the cheaper transport.
 *
 * The mailto is measured under BOTH transports because every surface can open
 * it — web as the popup-blocked fallback, mobile as its own button and as the
 * `NATIVE_OUTLOOK_CC_TRUSTED` reroute. It is always shorter than the native
 * url for identical input (`mailto:` + a bare address, against
 * `ms-outlook://compose?to=` + a percent-encoded one), so under
 * `outlook-native` it never binds — but it is measured rather than reasoned
 * about, because that inequality is not the one the tests pin.
 *
 * WHAT THIS DOES NOT MEASURE, per rung: the transport the caller did NOT
 * declare. Under `outlook-web` the native url is safe unmeasured (strictly
 * shorter, pinned by test). Under `outlook-native` the WEB url is not — it can
 * and does exceed the limit — so a caller asking for `outlook-native` is
 * asserting it will not open `outlookUrl`. Mobile discharges that by deriving
 * the transport and the open plan from one probe answer.
 *
 * ONE ENGINE'S BYTES ARE NOT ANOTHER'S. The body is measured, never estimated,
 * which is what makes this correct on Hermes: `formatOrgDateTime` renders the
 * needed-by line as "Aug 18, 2026 at 9:00 AM" there and "Aug 18, 2026, 9:00 AM"
 * under node and Chromium, and the wider form costs more once percent-encoded.
 * A device can therefore land one row lower than a node-run test predicts on a
 * borderline order, and that is correct behaviour rather than drift — each
 * engine fits what it can actually send. Do not hand-roll the date format to
 * chase byte equality between engines: three renderings already reach
 * production today (the web body is built client-side, and Safari's
 * JavaScriptCore already disagrees with Chrome), so there is no single web
 * byte-string to preserve. Tests must pin the RELATIONSHIP (the measured url
 * fits; the native budget yields at least as many rows as the web one), never
 * an absolute row count that only holds on one engine.
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
export function prepareDeliveryRequest(
  input: DeliveryRequestInput,
  opts: PrepareDeliveryRequestOptions = {},
): PreparedDeliveryRequest {
  const transport = opts.transport ?? 'outlook-web';

  /**
   * Compose ONE candidate draft into all three transports and rule on it.
   *
   * All three are built on every rung — not only the chosen one — so that the
   * native url can never be composed from a different rung than the one the
   * limit check saw. That was the shape of the last bug in this function's
   * ancestry, and building three short strings a handful of times is nothing
   * against a silent mismatch between what was measured and what is sent.
   *
   * `composeUrl` is the url this SURFACE will hand to the OS. Measuring it (and
   * not, say, always the longest of the three) is the whole point of
   * `transport`: fitting rows against a url nobody opens throws away real
   * headroom, and the phone was doing exactly that.
   */
  const measure = (draft: DeliveryRequestDraft) => {
    const outlookUrl = buildDeliveryRequestOutlookUrl(draft);
    const outlookMobileUrl = buildDeliveryRequestOutlookMobileUrl(draft);
    const mailtoUrl = buildDeliveryRequestMailtoUrl(draft);
    const composeUrl = transport === 'outlook-native' ? outlookMobileUrl : outlookUrl;
    return {
      draft,
      outlookUrl,
      outlookMobileUrl,
      mailtoUrl,
      fits: composeUrl.length <= DRAFT_URL_LIMIT && mailtoUrl.length <= DRAFT_URL_LIMIT,
    };
  };

  const full = measure(buildDeliveryRequestDraft(input));
  // ALWAYS the full, uncondensed body. The clipboard has no URL-length limit
  // and is the escape hatch — degrading it too would lose detail for no
  // reason. Computed once here, from `full`, and returned on BOTH paths.
  const clipboardText = buildDeliveryRequestClipboardText(full.draft);

  if (full.fits) {
    return {
      draft: full.draft,
      outlookUrl: full.outlookUrl,
      outlookMobileUrl: full.outlookMobileUrl,
      mailtoUrl: full.mailtoUrl,
      transport,
      clipboardText,
      linkFits: true,
    };
  }

  const attempt = (maxRows: number) =>
    measure(buildDeliveryRequestDraft(input, { condensed: true, maxRows }));

  // Rung 3 first: it is both the floor of the search and the answer when even
  // it does not fit (rung 4). Searching upward from a known-good floor is what
  // keeps `linkFits: false` reachable and honest.
  let best = attempt(0);

  if (best.fits) {
    let lo = 1;
    let hi = full.draft.lineCount;
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
    // `best`, never `full` — a native url carrying the FULL body while the web
    // url carried a shortened one would send two different messages depending
    // on which app the phone happened to have installed, and the long one would
    // be the silently truncated one.
    outlookMobileUrl: best.outlookMobileUrl,
    mailtoUrl: best.mailtoUrl,
    transport,
    clipboardText,
    linkFits: best.fits,
  };
}
