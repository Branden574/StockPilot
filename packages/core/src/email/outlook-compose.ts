/**
 * Shared Outlook Web compose transport — extracted VERBATIM from the
 * delivery-request assistant (apps/web storefront-logic.ts), where every
 * mechanic below was owner-tested against the live L4L Microsoft 365 tenant:
 *
 *  - outlook.cloud.microsoft, never outlook.office.com (2026-08-02: the
 *    office.com domain-migration redirect DROPS the compose path — bare
 *    inbox, no draft). No automated test can catch a host regression; it is
 *    constant-and-comment enforced. DO NOT "update" this URL.
 *  - a single `mailtouri=` param, never plain to=/cc=/subject=/body=
 *    (2026-08-01: OWA silently drops a plain `cc=` — the mandatory CC never
 *    landed).
 *  - %20 encoding via encodeDraftQuery, never URLSearchParams ('+' has no
 *    space meaning in RFC 6068; desktop clients render it literally).
 *  - display names are an OWA-only parser extension in the mailto PATH
 *    position; composeMailtoUrl and composeClipboardText stay BARE-ADDRESS.
 *
 * ADDRESSES ARE VALIDATED AND ENCODED HERE, not at the call sites (2026-08-13).
 * Every function below runs `assertRoutableAddress` on `to` and `cc` before it
 * builds anything, and the one raw interpolation — the `mailto:` path — goes
 * through `mailtoPathAddress`, which validates and percent-encodes in a single
 * call. Those doc comments explain what each layer is for, which of them is
 * load-bearing, and why the CALL is fused rather than written as two
 * statements; the short version is that a poisoned `to` used to be able to
 * steal the mandatory CC through the mailto transport, a guard sitting next to
 * one of four callers is not a guard, and a guard nothing is proven to CALL is
 * not a guard either.
 *
 * Plain TS, no server directives — imported by web client components, web
 * server code, and the Expo app (mobile's only workspace dep is
 * @stockpilot/core).
 *
 * GENERALIZATION FROM THE DELIVERY PRECEDENT (recorded per Task 4's
 * instruction to note real-file-vs-brief divergences): the delivery-request
 * source (`buildOutlookComposeUrl`/`buildMailtoUrl`/`buildClipboardText` in
 * `storefront-logic.ts`) always has a mandatory `cc` and hardcodes the
 * `DELIVERY_REQUEST_EMAIL_NAMES` display names into every call — there is no
 * conditional there because delivery never omits them. This module makes
 * `cc`, `toName` and `ccName` all optional so a second caller (the
 * maintenance builder, Task 7) that has a mandatory cc but no display names,
 * or any future caller with no cc at all, can use the same functions; Task 5
 * will make delivery delegate to these with its own always-present cc and
 * names supplied. The %20 encoding, the single mailtouri param, the two
 * encoding layers, and the bare-address boundary on mailto/clipboard are
 * unchanged from the real file.
 */

export const OUTLOOK_COMPOSE_BASE = 'https://outlook.cloud.microsoft/mail/deeplink/compose';

/**
 * Microsoft's NATIVE Outlook app URL scheme (iOS + Android), used by mobile
 * clients where handing an https URL to the OS opens a BROWSER on Outlook Web
 * instead of the installed app. Deliberately NOT a variant of
 * OUTLOOK_COMPOSE_BASE: it is a different transport with a different parser,
 * not a different host for the same one.
 *
 * The `?mailtouri=` wrapper does NOT apply here — that is an OWA Web deep-link
 * mechanic. This scheme takes plain to/cc/subject/body parameters.
 *
 * Whether a given device actually has Outlook installed is a runtime question
 * (Linking.canOpenURL on the client, which on iOS additionally requires
 * `ms-outlook` in LSApplicationQueriesSchemes and on Android a matching
 * <queries> entry). This module only composes the string.
 */
export const OUTLOOK_MOBILE_COMPOSE_BASE = 'ms-outlook://compose';

/** Conservative compose-link ceiling; both transports truncate SILENTLY past
 *  ~2,000 chars. 1,800 leaves headroom for tenant redirect wrappers. */
export const DRAFT_URL_LIMIT = 1800;

/**
 * WHICH COMPOSE URL THE CALLING SURFACE WILL ACTUALLY HAND TO THE OS.
 *
 * A MEASUREMENT input, not a rendering option: every prepare* builder that
 * degrades a body to fit `DRAFT_URL_LIMIT` (delivery's row ladder, the
 * maintenance condense pass) fits it against the url the caller declares it
 * will open, and the two transports have very different budgets for the same
 * body.
 *
 *  - `outlook-web` — the https OWA deep link. Its body rides inside a
 *    `?mailtouri=` wrapper and is therefore percent-encoded TWICE (a space
 *    costs `%2520`, an em-dash `%25E2%2580%2594`), on top of a 52-character
 *    base. This is the expensive one, and the DEFAULT: it is the longest url
 *    any surface opens, so a body fitted for it fits every transport, and an
 *    undeclared or unknown transport can never cause silent truncation.
 *  - `outlook-native` — `ms-outlook://compose`. A 20-character scheme and ONE
 *    encoding layer, roughly 25-30% shorter for the same body.
 *
 * A caller may only declare `outlook-native` when it KNOWS the native app is
 * the one that will open. On mobile that answer comes from ONE `canOpenURL`
 * probe whose value feeds the prepare call and nothing else; the opener then
 * follows the transport STAMPED on the prepared result, so measure and open
 * cannot diverge. See `deliveryComposeTransport` / `composeTransportForProbe`
 * in apps/mobile/src/lib for the probe rule (`null` = worst case).
 */
export type ComposeTransport = 'outlook-web' | 'outlook-native';

/** %20 for spaces, never '+'. See module doc. */
export function encodeDraftQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

/** RFC 5322 specials that would split an UNQUOTED name-addr into two
 *  recipients (silently dropping the mandatory CC). Display names must be
 *  compile-time literals validated through here.
 *
 *  NOTE (real-file-vs-brief divergence): the delivery precedent
 *  (`apps/web/src/lib/site.ts`) documents this exact character set in a
 *  comment on `DELIVERY_REQUEST_EMAIL_NAMES` but never had a runtime
 *  assertion — safety there came from the names being frozen compile-time
 *  literals only. This module accepts dynamic `toName`/`ccName` input (the
 *  maintenance builder's requester/site names are NOT compile-time
 *  literals), so a real runtime guard is required here; it did not exist
 *  anywhere to extract "verbatim" and is new code written to the brief's
 *  spec, using the same character set the delivery comment already named. */
const UNSAFE_NAME_CHARS = /[<>,"@;]/;

export function assertSafeDisplayName(name: string): string {
  if (UNSAFE_NAME_CHARS.test(name)) {
    throw new Error(
      'Display name contains RFC 5322 specials (< > , " @ ;) and cannot be safely interpolated into a name-addr.',
    );
  }
  return name;
}

/**
 * A display name is PRESENT only when it has visible characters (verifier
 * follow-up, 2026-08-16). `assertSafeDisplayName` accepts `''` and `'   '`
 * clean — no RFC 5322 specials in either — so both recipient factories used
 * to store them, and a whitespace-only name reached the OWA `mailtouri` path
 * as the chip `'  <addr>'`: a name-addr with an invisible name. Empty and
 * whitespace-only names now mean ABSENT (bare address), decided HERE, once,
 * for both factories (recurring pattern #26 — the delivery and maintenance
 * factories are twins and must not drift on this).
 *
 * NON-BLANK NAMES PASS THROUGH BYTE-IDENTICAL — deliberately NOT trimmed.
 * Every currently-valid stored value (the seeded L4L names included) must
 * compose the exact urls it composed before this helper existed; the
 * golden-diff in the factory tests pins that.
 */
export function normalizeDisplayName(name: string | undefined): string | undefined {
  if (name === undefined || name.trim() === '') return undefined;
  return assertSafeDisplayName(name);
}

/**
 * ONE plain mailbox, nothing else — the grammar, and why it is deliberately
 * NARROWER than RFC 5322.
 *
 * MOVED HERE 2026-08-13 from `../orders/delivery-request.ts`, where it guarded
 * exactly one of the four transports' callers. This module composes all four
 * (OWA web, native `ms-outlook:`, `mailto:`, clipboard) and has a second caller
 * — the maintenance builder — which had NO address validation at all. A check
 * that lives beside one caller is recurring pattern #26 waiting to happen; a
 * check that lives beside the STRING CONSTRUCTION cannot be bypassed by adding
 * a caller. Every compose function below runs it on `to` and on `cc`.
 *
 * WHAT THE OLD SPELLING LET THROUGH (measured 2026-08-13). It was a
 * negative-space regex — "anything but whitespace, `<>`, `,`, `;`, `:` and
 * `"`" — which ACCEPTS `? & = % / + # ! $ ' ( ) * | \ ^ { } [ ] ~` and
 * backtick. `a?cc=attacker@evil.test` therefore validated clean, and
 * `composeMailtoUrl` interpolated it into the URL PATH raw. A URL parser then
 * reads that as `to = a`, `cc = attacker@evil.test?cc=arosas@cvwest.org` — the
 * attacker gets the copy and THE MANDATORY CC IS SWALLOWED INTO THEIR VALUE.
 * Not "a second recipient appears"; the acceptance gate silently disappears.
 *
 * WHY A GRAMMAR ALONE CANNOT BE THE FIX, stated plainly so nobody removes the
 * encoder below thinking this covers it: `a?cc=attacker` is a VALID RFC 5322
 * dot-atom local part — `?` and `=` are both `atext`. Any validator faithful to
 * the RFC would admit the injection string. So the grammar below is
 * deliberately narrower than the RFC: the local part is restricted to
 * `A-Za-z0-9._+-`, the practical mailbox set, which keeps plus-addressing
 * (`user+tag@org`) and rejects every character that means something to a URL or
 * to a mail-header parser. Zero of this tenant's addresses use anything else,
 * and the only way a non-literal address ever arrives is the per-org
 * configuration `../orders/delivery-request-recipients.ts` flags as deferred.
 *
 * The domain requires at least one dot, and no label may start or end with a
 * hyphen. The 254-character ceiling is RFC 5321's maximum path length — an
 * address longer than that is not deliverable, and it would eat the compose
 * link's row budget on its way to not being deliverable.
 */
const ROUTABLE_ADDRESS =
  /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const MAX_ADDRESS_LENGTH = 254;

/**
 * Refuse to compose rather than misroute.
 *
 * Every failure mode this rejects is SILENT if allowed through: a comma splits
 * the recipient list, a `?` opens a query string inside the path, an empty
 * string composes mail to nowhere, a name-addr in the address position confuses
 * a parser into dropping the rest. A throw happens before any compose window
 * opens — before the employee can believe a message went out — which is the
 * only point at which the failure is still visible to anybody.
 *
 * The message keeps the wording the delivery builder threw with, because that
 * is what its callers and tests already match on.
 */
export function assertRoutableAddress(field: 'to' | 'cc', value: string): string {
  if (value.length > MAX_ADDRESS_LENGTH || !ROUTABLE_ADDRESS.test(value)) {
    throw new Error(
      `Email recipient "${field}" must be exactly one plain email address ` +
        'with no display name, separator or whitespace.',
    );
  }
  return value;
}

/**
 * Characters that may stand for themselves in a `mailto:` PATH.
 *
 * Unreserved (RFC 3986) plus `@` — the `addr-spec` separator, which RFC 6068
 * puts in the path literally — plus `+`, which is `atext` in RFC 5322 and a
 * `some-delims` in RFC 6068's `qchar`, so plus-addressing survives unmangled.
 * Everything else is percent-encoded, INCLUDING `?` (starts the hfields), `#`
 * (starts a fragment), `,` (RFC 6068 `to = addr-spec *("," addr-spec)` — a
 * literal comma adds a recipient), `%` (double-decoding) and `&`.
 */
const MAILTO_PATH_SAFE = /[A-Za-z0-9\-._~+@]/;

declare const MAILTO_PATH_ENCODED: unique symbol;

/**
 * A mailbox that has been through `encodeMailtoPathAddress` — the ONLY thing
 * `mailtoUrlFromPath` will splice into a `mailto:` path.
 *
 * The brand is module-private, so nothing outside this file can produce a value
 * of this type: `const p: MailtoPathAddress = input.to` does not compile, and
 * neither does `mailtoUrlFromPath(input.to, query)`. That is deliberate and it
 * is the second half of the wiring pin described on `composeMailtoUrl` — the
 * first half (deleting the call outright) fails a test, this half fails
 * `tsc --noEmit`.
 */
export type MailtoPathAddress = string & { readonly [MAILTO_PATH_ENCODED]: true };

/**
 * Percent-encode a mailbox for the `mailto:` PATH position.
 *
 * THIS IS THE LAYER THAT MAKES THE INJECTION IMPOSSIBLE, as distinct from
 * `assertRoutableAddress`, which makes it unreachable. The distinction matters
 * because the two fail differently and one of them already failed once: the
 * validator is a regex that a future edit can loosen — that is exactly how the
 * negative-space spelling came to accept `?` — whereas this removes the
 * MECHANISM. A `?` here becomes `%3F` and cannot start a query string no matter
 * what any validator upstream believes.
 *
 * The other three transports already had this property and were measured to
 * have it: `composeOutlookMobileUrl` and the `cc` of every URL go through
 * `encodeDraftQuery` -> `encodeURIComponent`, and `composeOutlookWebUrl`
 * encodes its path value once and then the whole inner mailto again. The
 * `mailto:` path was the ONE raw interpolation in the module. This closes it at
 * the same layer the others are closed at rather than at the call site that
 * happens to be safe today.
 *
 * IDENTITY ON EVERY ADDRESS THE VALIDATOR ADMITS. The accepted grammar
 * (`A-Za-z0-9._+-` @ `A-Za-z0-9-` and dots) is a strict subset of the safe set
 * above, so for any address that passes `assertRoutableAddress` this function
 * returns its input unchanged — the shipped, owner-tenant-verified URLs are
 * byte-for-byte what they were. Pinned by test in both directions.
 *
 * That identity is also why the CALL SITE needed pinning separately from the
 * behaviour: see `mailtoPathAddress` below.
 */
export function encodeMailtoPathAddress(address: string): MailtoPathAddress {
  let out = '';
  // Iterating by code POINT, not code unit, so an astral character is handed to
  // encodeURIComponent as a whole surrogate pair rather than a lone half.
  for (const ch of address) {
    out += MAILTO_PATH_SAFE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out as MailtoPathAddress;
}

/**
 * VALIDATE AND ENCODE, IN ONE CALL — the whole of what a `mailto:` To address
 * must survive before it can be a path, expressed as one thing that can be
 * called or not called.
 *
 * WHY THIS EXISTS AS A FUNCTION (2026-08-13, second pass). The encoder's
 * BEHAVIOUR was pinned in both directions. The fact that anything CALLED it was
 * pinned by nothing: deleting `encodeMailtoPathAddress(...)` from
 * `composeMailtoUrl` and going back to `` `mailto:${input.to}?...` `` passed
 * 1330/1330 core tests, measured. It could not do otherwise — while the
 * validator stays strict the encoder is the identity on everything that reaches
 * it, so substituting it away is invisible to any test written against the
 * composed URL. This is the third time this exact shape has shipped on this
 * branch's lineage (a rack key in #129, a maintenance upload kind before that),
 * so the answer here is structural rather than another assertion:
 *
 *   - the two layers now share ONE call site. Removing it removes the
 *     VALIDATION too: the same mutation now fails twelve tests — the eleven
 *     `mailto: refuses ... in the TO` cases and the CALL SITE test written for
 *     it. That is the mutation that was silent before.
 *   - the return type is branded and `mailtoUrlFromPath` accepts nothing else,
 *     so keeping the validator and dropping the encoder
 *     (`mailtoUrlFromPath(assertRoutableAddress('to', input.to), q)`) does not
 *     compile.
 *
 * HONEST BOUNDARY: a hand-rewrite that inlines its own `` `mailto:${...}` ``
 * template, bypassing both helpers while keeping the validator, is still
 * invisible — no test can see a string built somewhere else. What is now
 * impossible is the accidental version: deleting a call, or reverting a line.
 */
function mailtoPathAddress(value: string): MailtoPathAddress {
  return encodeMailtoPathAddress(assertRoutableAddress('to', value));
}

/**
 * The ONE place a `mailto:` URL is assembled. Takes only an address that has
 * been through `mailtoPathAddress` — see `MailtoPathAddress`.
 */
export function mailtoUrlFromPath(path: MailtoPathAddress, query: string): string {
  return `mailto:${path}?${query}`;
}

export interface ComposeInput {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Cosmetic OWA compose-chip names. Literals only; validated. */
  toName?: string;
  ccName?: string;
}

export interface ComposedEmail {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  outlookWebUrl: string;
  mailtoUrl: string;
  clipboardText: string;
}

/** OWA deep link: `?mailtouri=<encoded inner mailto URI>`. Two encoding
 *  layers exactly — one building the inner URI, one wrapping it. */
export function composeOutlookWebUrl(input: ComposeInput): string {
  assertRoutableAddress('to', input.to);
  if (input.cc !== undefined) assertRoutableAddress('cc', input.cc);
  const toValue = input.toName
    ? `${assertSafeDisplayName(input.toName)} <${input.to}>`
    : input.to;
  const query: Record<string, string> = {};
  if (input.cc) {
    query.cc = input.ccName
      ? `${assertSafeDisplayName(input.ccName)} <${input.cc}>`
      : input.cc;
  }
  query.subject = input.subject;
  query.body = input.body;
  const innerMailto = `mailto:${encodeURIComponent(toValue)}?${encodeDraftQuery(query)}`;
  return `${OUTLOOK_COMPOSE_BASE}?mailtouri=${encodeURIComponent(innerMailto)}`;
}

/**
 * Native Outlook app deep link: `ms-outlook://compose?to=&cc=&subject=&body=`.
 * ONE encoding layer (there is no inner URI to wrap), through the SAME
 * `encodeDraftQuery` the web transport uses — so `%20`, never `+`.
 *
 * THE CC IS THE POINT. The maintenance workflow depends on a fixed cc address
 * receiving a copy of a ticket the requester creates; a compose screen that
 * opens with the cc missing is a worse failure than not opening at all,
 * because nobody notices. Two consequences, both deliberate:
 *
 *  1. `assertSafeDisplayName` runs here exactly as it does on the web path.
 *     RFC 5322 specials in an unquoted name-addr split it into TWO recipients
 *     and the mandatory cc is what silently disappears — so an unsafe name is
 *     a hard throw on BOTH transports, never a quiet difference between them.
 *  2. Addresses ride BARE, the same boundary `composeMailtoUrl` holds. The
 *     name-addr chip is a VERIFIED OWA-Web parser extension (see module doc);
 *     the native app is a different, unverified parser, and guessing wrong
 *     there costs exactly the silent cc drop above. A missing display-name
 *     chip is cosmetic; a missing cc breaks the business process. Names are
 *     therefore validated and then left out of the wire format.
 *
 * Shorter than `composeOutlookWebUrl` for identical input by construction (a
 * 20-char scheme and one encoding layer, versus a 52-char https base and a
 * double-encoded inner mailto), so callers that already measure the web URL
 * against DRAFT_URL_LIMIT are transitively measuring this one. Pinned by test.
 */
export function composeOutlookMobileUrl(input: ComposeInput): string {
  assertRoutableAddress('to', input.to);
  if (input.cc !== undefined) assertRoutableAddress('cc', input.cc);
  if (input.toName) assertSafeDisplayName(input.toName);
  if (input.ccName) assertSafeDisplayName(input.ccName);
  const query: Record<string, string> = { to: input.to };
  if (input.cc) query.cc = input.cc;
  query.subject = input.subject;
  query.body = input.body;
  return `${OUTLOOK_MOBILE_COMPOSE_BASE}?${encodeDraftQuery(query)}`;
}

/** RFC 6068 mailto fallback. BARE addresses only — the name-addr path trick
 *  is an OWA extension, unverified on desktop clients. Do not extend.
 *
 *  The To address is the only value in this module that sits in a URL PATH
 *  rather than a query parameter, which is why it goes through
 *  `mailtoPathAddress` rather than riding through `encodeDraftQuery` like
 *  everything else. It used to be interpolated RAW; see `mailtoPathAddress`,
 *  `encodeMailtoPathAddress` and `assertRoutableAddress` for what that cost,
 *  which of the two layers does which half of the work, and why the CALL is
 *  structured so that removing it cannot be silent. */
export function composeMailtoUrl(
  input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>,
): string {
  // The ONLY validation of `to` in this function, deliberately: it is fused to
  // the encoding, so a revert to a raw path drops the refusals with it.
  const path = mailtoPathAddress(input.to);
  if (input.cc !== undefined) assertRoutableAddress('cc', input.cc);
  const query: Record<string, string> = {};
  if (input.cc) query.cc = input.cc;
  query.subject = input.subject;
  query.body = input.body;
  return mailtoUrlFromPath(path, encodeDraftQuery(query));
}

/** Terminal fallback: labelled blocks so the user can rebuild the message by
 *  hand INCLUDING the CC. No URL-length limit — always the full body.
 *
 *  VALIDATED TOO, even though nothing here is a URL. This block is LABELLED
 *  LINES, and a line break inside an address forges one: a `to` of
 *  `x@y.test\nCC: attacker@evil.test` renders a second CC line above the real
 *  one, and the human retyping it into their mail client has no way to know
 *  which line the system meant. Same injection, different grammar — so the same
 *  guard, at the same layer, rather than on three of the four transports. */
export function composeClipboardText(
  input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>,
): string {
  assertRoutableAddress('to', input.to);
  if (input.cc !== undefined) assertRoutableAddress('cc', input.cc);
  const lines = [`TO: ${input.to}`];
  if (input.cc) lines.push(`CC: ${input.cc}`);
  lines.push(`SUBJECT: ${input.subject}`, '', 'MESSAGE:', input.body);
  return lines.join('\n');
}

/** The Brief section-30 convenience shape. */
export function createOutlookComposeEmail(input: ComposeInput): ComposedEmail {
  return {
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    outlookWebUrl: composeOutlookWebUrl(input),
    mailtoUrl: composeMailtoUrl(input),
    clipboardText: composeClipboardText(input),
  };
}
