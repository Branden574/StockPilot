import { ccNotice } from '../email/cc-notice';
import type { OrgEmailRoutingReadState } from '../email/org-email-routing';
import { deliveryRequestRecipients, type DeliveryRequestRecipients } from './delivery-request';

/**
 * Delivery-request recipients — L4L's mailboxes, now the COMPILED FALLBACK
 * rather than what every surface reads.
 *
 * HISTORY. `dc4@learn4life.org` and `arosas@cvwest.org` are Learn4Life's
 * addresses, and until 2026-08-16 every org's delivery-request surfaces read
 * them from here — one tenant's mailboxes in the multi-tenant platform
 * package, named as a smell by this file's own previous header. The per-org
 * seam that header promised has landed: routing now lives in
 * `organizations.email_routing` (migration 0337), surfaces pass a value read
 * from the org row, and neither the builder nor its tests changed, because
 * the builder already accepted recipients as input.
 *
 * WHAT REMAINS FOR THESE CONSTANTS — exactly two roles, and nothing else:
 *
 *  1. THE CODE-BEFORE-MIGRATION FALLBACK. Deploy-order safety for this
 *     feature is FAIL OPEN to the pre-feature behavior: code that reads a
 *     missing `email_routing` column (Postgres 42703) must degrade to
 *     exactly what shipped before it — these values — so deploying code
 *     before the migration cannot outage anything. That is the ONLY path
 *     that ever returns these constants; once the column exists it is never
 *     taken. See `deliveryRecipientsForRouting` below.
 *  2. THE SEED'S SOURCE OF TRUTH. Migration 0337 seeds L4L's org row with
 *     these exact values, so nothing changes for the tenant whose acceptance
 *     gate (the mandatory CC) they encode.
 *
 * An org WITHOUT a stored value gets NEITHER of these: its email action is
 * hidden ('unset'), and an org with an INVALID stored value fails closed the
 * same way. Falling back to these constants for another org would silently
 * mail L4L's warehouse — the exact leak the per-org feature exists to end.
 *
 * WHAT THE ADDRESSES MEAN (unchanged; the copy rules depend on it): `to` is
 * Learn4Life's DC4 intake mailbox, which becomes a Zendesk ticket through
 * Zendesk's EMAIL INTAKE — entirely outside this application, so StockPilot
 * can never confirm a ticket exists and must never say that it does. `cc` is
 * Andrew Rosas, who receives a direct copy; Zendesk rules MAY use it to
 * route or assign, but we cannot observe that, so no copy anywhere may
 * promise it.
 *
 * SECURITY: frozen compile-time literals, never read from a URL parameter,
 * localStorage, order notes, a requester-entered form value, a
 * client-supplied API parameter, or destination-site data. The PER-ORG path
 * is different by design: a stored value IS client-influenced data, which is
 * why it must pass the branded factory (`deliveryRequestRecipients`) before
 * any surface will compose with it.
 */
export const DELIVERY_REQUEST_EMAIL = Object.freeze({
  to: 'dc4@learn4life.org',
  cc: 'arosas@cvwest.org',
} as const);

/**
 * Cosmetic display labels for the Outlook compose chips — the human-readable
 * name half of a name-addr ("Name <addr>"), tenant-verified 2026-08-01
 * against the real L4L Microsoft 365 tenant (OWA compose chips 'Fresno
 * Warehouse DC4 <dc4@learn4life.org>' / 'Andrew Rosas <arosas@cvwest.org>').
 *
 * Same two roles as the addresses above: the compiled fallback's names, and
 * the seed's. The ADDRESSES remain the routing truth — these are decoration,
 * dropped by every transport except the tenant-verified OWA `mailtouri`
 * path.
 *
 * SECURITY: names must stay free of RFC 5322 specials (`< > , " @ ;`) —
 * `assertSafeDisplayName` enforces that at runtime on every transport, and
 * the branded factory runs it on every configured name, so a per-org name
 * that could split the name-addr (and silently drop the mandatory CC) is a
 * hard throw rather than a silent misroute.
 */
export const DELIVERY_REQUEST_EMAIL_NAMES = Object.freeze({
  to: 'Fresno Warehouse DC4',
  cc: 'Andrew Rosas',
} as const);

/**
 * THE COMPILED VALUE, built once through the only constructor there is.
 *
 * No surface imports this as "the recipients" any more — surfaces resolve
 * the org row and construct through the factory at their own seam. This
 * value exists so the fallback mapping below, the migration's seed
 * assertions, and the tests all share one already-validated instance of the
 * compiled pair.
 */
export const DELIVERY_REQUEST_RECIPIENTS: DeliveryRequestRecipients = deliveryRequestRecipients({
  to: DELIVERY_REQUEST_EMAIL.to,
  cc: DELIVERY_REQUEST_EMAIL.cc,
  toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
  ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
});

/**
 * The recipients notice as a PURE FUNCTION of the recipients — required now
 * that recipients are per-org data: a fixed sentence naming one tenant's
 * mailbox would state a checkable falsehood on every other org's screens.
 *
 * The sentence claims only what StockPilot can observe about ANY configured
 * mailbox — where the mail is addressed. The previous fixed notice's "The
 * DC4 address creates the delivery-request ticket" sentence was
 * L4L-Zendesk-specific knowledge the platform cannot truthfully claim for an
 * arbitrary org, so it is gone everywhere, L4L's screens included (a
 * deliberate copy change, recorded in the per-org routing design).
 */
export function deliveryRequestCcNotice(recipients: { to: string; cc: string }): string {
  return ccNotice(recipients);
}

/**
 * The notice for the COMPILED pair — kept because the pre-feature surfaces
 * and tests import it by this name, redefined as the function applied to the
 * compiled values so it can never again drift from the addresses the way a
 * hand-typed sentence once could.
 */
export const DELIVERY_REQUEST_CC_NOTICE = deliveryRequestCcNotice(DELIVERY_REQUEST_EMAIL);

/**
 * Map a routing READ to the recipients a delivery surface may compose with —
 * the whole per-org fallback matrix, in one place:
 *
 *   'fallback' -> the COMPILED constants. DEPLOY-ORDER SAFETY: this state
 *                 means the `email_routing` column does not exist yet (code
 *                 deployed before migration 0337), and the fallback exists
 *                 solely so that window cannot outage anything — behavior is
 *                 byte-identical to pre-feature. Once the column exists this
 *                 arm is never taken.
 *   'valid'    -> the stored recipients, re-branded through the factory. The
 *                 parser already validated them, so the construction cannot
 *                 throw for a value the parser produced; the try/catch is
 *                 belt-and-braces for a caller that hand-built the state,
 *                 and it fails CLOSED (null), never open.
 *   'unset'    -> null: the action is HIDDEN for this org.
 *   'invalid'  -> null: FAIL CLOSED for this org. Never the constants —
 *                 that would silently mail another tenant's warehouse.
 */
export function deliveryRecipientsForRouting(
  read: OrgEmailRoutingReadState,
): DeliveryRequestRecipients | null {
  switch (read.state) {
    case 'fallback':
      return DELIVERY_REQUEST_RECIPIENTS;
    case 'valid':
      try {
        return deliveryRequestRecipients(read.recipients);
      } catch {
        return null;
      }
    default:
      return null;
  }
}
