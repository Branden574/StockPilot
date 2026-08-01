/**
 * Public site constants — used across the marketing footer, legal pages, the
 * contact page, and the support-ticket emails so there's one source of truth.
 *
 * NOTE: support@ / privacy@ should be set up as real inboxes (or forwards to
 * your primary inbox) on stockpilotusa.com. Support tickets are ALSO stored in
 * the database + shown in the admin triage view, so a bounced notification
 * email never loses a ticket.
 */
export const COMPANY_NAME = 'StockPilot';
/** Update if/when a legal entity (LLC/Inc) is formed. */
export const COMPANY_LEGAL_NAME = 'StockPilot';
// Pointed at the existing, working hello@ inbox (no separate support@/privacy@
// mailboxes to set up). Change these if dedicated inboxes are created later.
export const SUPPORT_EMAIL = 'hello@stockpilotusa.com';
export const PRIVACY_EMAIL = 'hello@stockpilotusa.com';
export const SALES_EMAIL = 'sales@stockpilotusa.com';
export const SITE_URL = 'https://stockpilotusa.com';

/**
 * Delivery-request assistant recipients — the ONE definition in the codebase.
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
 * form value, a client-supplied API parameter, or destination-site data. The
 * draft builder takes NO recipient argument — it reads this object — so there
 * is no parameter for a caller to poison. Frozen so a stray assignment throws
 * in strict mode instead of silently redirecting warehouse mail.
 *
 * Not an env var deliberately: `env.client.ts` returns '' and console.errors on
 * a missing NEXT_PUBLIC value rather than crashing, so a mis-plumbed variable
 * would compose mail to an empty address with no build error. A literal cannot
 * fail that way.
 *
 * OPEN (owner): whether this becomes per-org configuration. That is the only
 * option that needs a migration and it is deliberately deferred.
 */
export const DELIVERY_REQUEST_EMAIL = Object.freeze({
  to: 'dc4@learn4life.org',
  cc: 'arosas@cvwest.org',
} as const);

/**
 * Cosmetic display labels for the Outlook compose chips — the human-readable
 * name half of an RFC 6068 name-addr ("Name <addr>"), tenant-verified
 * 2026-08-01: the owner's `mailtouri=` test against the real L4L Microsoft
 * 365 tenant produced OWA compose chips reading 'Fresno Warehouse DC4
 * <dc4@learn4life.org>' (To) and 'Andrew Rosas <arosas@cvwest.org>' (Cc),
 * correct addresses underneath.
 *
 * The ADDRESSES in `DELIVERY_REQUEST_EMAIL` above remain the routing truth —
 * these names are decoration only. They must never replace or be
 * concatenated into any address field outside the Outlook compose URL's
 * inner mailto: URI construction (`buildOutlookComposeUrl` in
 * `storefront-logic.ts`); the popup-blocked `mailto:` fallback
 * (`buildMailtoUrl`) and the clipboard/UI copy (`buildClipboardText` and
 * every on-screen recipient label) stay bare addresses, unaffected by this
 * constant.
 */
export const DELIVERY_REQUEST_EMAIL_NAMES = Object.freeze({
  to: 'Fresno Warehouse DC4',
  cc: 'Andrew Rosas',
} as const);

/** Helper text shown wherever the recipients are displayed. Accuracy, not optimism. */
export const DELIVERY_REQUEST_CC_NOTICE =
  'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.';
