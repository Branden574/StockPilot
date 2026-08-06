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

/** Conservative compose-link ceiling; both transports truncate SILENTLY past
 *  ~2,000 chars. 1,800 leaves headroom for tenant redirect wrappers. */
export const DRAFT_URL_LIMIT = 1800;

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

/** RFC 6068 mailto fallback. BARE addresses only — the name-addr path trick
 *  is an OWA extension, unverified on desktop clients. Do not extend. */
export function composeMailtoUrl(
  input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>,
): string {
  const query: Record<string, string> = {};
  if (input.cc) query.cc = input.cc;
  query.subject = input.subject;
  query.body = input.body;
  return `mailto:${input.to}?${encodeDraftQuery(query)}`;
}

/** Terminal fallback: labelled blocks so the user can rebuild the message by
 *  hand INCLUDING the CC. No URL-length limit — always the full body. */
export function composeClipboardText(
  input: Pick<ComposeInput, 'to' | 'cc' | 'subject' | 'body'>,
): string {
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
