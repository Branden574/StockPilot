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
 * Delivery-request assistant recipients — RE-EXPORTED, still ONE definition.
 *
 * MOVED 2026-08-13 to `packages/core/src/orders/delivery-request-recipients.ts`.
 * The delivery-request builder moved to `@stockpilot/core` so that web and
 * mobile compose the identical email instead of drifting apart, and mobile's
 * only workspace dependency is that package — it cannot import from
 * `apps/web`. Leaving the addresses here would have forced a second copy in the
 * Expo app, which is precisely the drift the move exists to prevent.
 *
 * The full record — what each address means, why they are literals and not env
 * vars, the RFC 5322 constraints on the display names, and the deferred
 * per-org-configuration question — travels with them and is now in that file.
 * Its doc comment also states plainly that one tenant's mailboxes in a shared
 * platform package is a smell, and why it is still the smaller wrong.
 *
 * SINCE 2026-08-16 (per-org email routing, migration 0337) NO web surface
 * reads these as "the recipients": routing is resolved per org from
 * `organizations.email_routing` (`getOrgEmailRouting` +
 * `deliveryRecipientsForRouting`), and the constants remain only as the
 * compiled code-before-migration fallback and the migration seed's source of
 * truth — the full record is on the core module.
 *
 * Re-exported rather than re-declared so `Object.freeze` identity, this file's
 * importers, and `site.test.ts` all keep working untouched.
 */
export {
  DELIVERY_REQUEST_EMAIL,
  DELIVERY_REQUEST_EMAIL_NAMES,
  DELIVERY_REQUEST_CC_NOTICE,
  DELIVERY_REQUEST_RECIPIENTS,
} from '@stockpilot/core';
