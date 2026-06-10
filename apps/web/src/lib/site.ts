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
