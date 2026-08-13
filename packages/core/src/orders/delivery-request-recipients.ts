/**
 * Delivery-request recipients — ONE TENANT'S MAILBOXES, IN A SHARED PACKAGE.
 *
 * NAME THE SMELL RATHER THAN HIDE IT. `dc4@learn4life.org` and
 * `arosas@cvwest.org` are Learn4Life's addresses. `@stockpilot/core` is the
 * multi-tenant platform package. A customer-specific literal does not belong
 * here, and this file exists in spite of that, not in ignorance of it.
 *
 * WHY IT IS HERE ANYWAY, and why that is the least-bad option:
 *
 *   - The builder in `delivery-request.ts` is tenant-NEUTRAL: it takes
 *     recipients as INPUT and reads no constant. This file is data the
 *     surfaces hand it, never something the builder reaches for.
 *   - The alternative was one copy in `apps/web/src/lib/site.ts` and a second
 *     in the Expo app, because mobile's only workspace dependency is
 *     `@stockpilot/core` and cannot import from `apps/web`. Two literals in
 *     two apps is exactly the drift this whole extraction exists to prevent:
 *     the surfaces would eventually mail two different mailboxes and nobody
 *     would notice, because the failure is a message that arrives somewhere
 *     plausible. One definition, in the only place both surfaces can see, is
 *     the smaller wrong.
 *   - Being in core makes the situation MORE visible, not worse. The literal
 *     already ships to every browser in the client bundle today; what changes
 *     is that it is now filed under a name that says what it is.
 *
 * OPEN (owner, carried over from `apps/web/src/lib/site.ts` verbatim): whether
 * this becomes per-org configuration. That is the only option that needs a
 * migration and it is deliberately deferred. THIS FILE IS THE SEAM for it —
 * when it lands, the surfaces pass a value read from the org row and neither
 * the builder nor its tests change, because the builder already accepts
 * recipients as input.
 *
 * WHAT THE ADDRESSES MEAN (carried over verbatim; the copy rules depend on it):
 *
 * `to` is Learn4Life's DC4 intake mailbox: mail sent there becomes a Zendesk
 * ticket through Zendesk's EMAIL INTAKE, which is entirely outside this
 * application. Nothing in StockPilot talks to that intake, so StockPilot can
 * never confirm a ticket exists and must never say that it does.
 *
 * `cc` is Andrew Rosas, who receives a direct copy. Existing Zendesk rules MAY
 * use the CC to route or assign — but we cannot observe that, so no copy
 * anywhere may promise it. "A copy will also be sent to arosas@cvwest.org" is
 * the allowed sentence; "this ticket will be assigned to him" is not.
 *
 * SECURITY: these values are compile-time literals on purpose. They are never
 * read from a URL parameter, localStorage, order notes, a requester-entered
 * form value, a client-supplied API parameter, or destination-site data.
 * Frozen so a stray assignment throws in strict mode instead of silently
 * redirecting warehouse mail.
 *
 * Not an env var deliberately: `env.client.ts` returns '' and console.errors on
 * a missing NEXT_PUBLIC value rather than crashing, so a mis-plumbed variable
 * would compose mail to an empty address with no build error. A literal cannot
 * fail that way.
 */
export const DELIVERY_REQUEST_EMAIL = Object.freeze({
  to: 'dc4@learn4life.org',
  cc: 'arosas@cvwest.org',
} as const);

/**
 * Cosmetic display labels for the Outlook compose chips — the human-readable
 * name half of a name-addr ("Name <addr>"), tenant-verified 2026-08-01: the
 * owner's `mailtouri=` test against the real L4L Microsoft 365 tenant
 * produced OWA compose chips reading 'Fresno Warehouse DC4
 * <dc4@learn4life.org>' (To) and 'Andrew Rosas <arosas@cvwest.org>' (Cc),
 * correct addresses underneath. (name-addr itself is RFC 5322 mailbox
 * syntax; RFC 6068's mailto: scheme only admits it as an hfield VALUE, not
 * in path position — see `composeOutlookWebUrl`'s doc comment in
 * `../email/outlook-compose.ts` for why the path-position To is an OWA parser
 * extension, not the RFC.)
 *
 * The ADDRESSES in `DELIVERY_REQUEST_EMAIL` above remain the routing truth —
 * these names are decoration only. They must never replace or be
 * concatenated into any address field outside the Outlook compose URL's
 * inner mailto: URI construction; the popup-blocked `mailto:` fallback, the
 * native `ms-outlook://` transport, and the clipboard/UI copy all stay bare
 * addresses, unaffected by this constant.
 *
 * SECURITY: these names must stay free of RFC 5322 specials — `< > , " @ ;`
 * — because the compose builder interpolates them UNQUOTED into the name-addr
 * string (`` `${name} <${address}>` ``) before percent-encoding. A comma in
 * particular can split what a mail parser reads as one recipient into two,
 * silently dropping the mandatory CC — the exact class of failure this whole
 * feature guards against. `assertSafeDisplayName` in `../email/outlook-compose.ts`
 * now enforces that at runtime on every transport, so a future configurable
 * name is a hard throw rather than a silent CC drop.
 */
export const DELIVERY_REQUEST_EMAIL_NAMES = Object.freeze({
  to: 'Fresno Warehouse DC4',
  cc: 'Andrew Rosas',
} as const);

/** Helper text shown wherever the recipients are displayed. Accuracy, not optimism. */
export const DELIVERY_REQUEST_CC_NOTICE =
  'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.';
