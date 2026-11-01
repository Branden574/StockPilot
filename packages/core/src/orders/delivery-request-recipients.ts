import { ccNotice } from '../email/cc-notice';
import type { OrgEmailRoutingReadState } from '../email/org-email-routing';
import { deliveryRequestRecipients, type DeliveryRequestRecipients } from './delivery-request';

/**
 * Delivery-request recipients: the COMPILED SAMPLE PAIR, not what any
 * surface reads.
 *
 * HISTORY. Until 2026-08-16 every org's delivery-request surfaces read the
 * first tenant's intake and CC mailboxes from here: one tenant's mailboxes in
 * the multi-tenant platform package, named as a smell by this file's own
 * previous header. The per-org seam that header promised has landed: routing
 * now lives in `organizations.email_routing` (migration 0337, which seeded
 * that tenant's org row), surfaces pass a value read from the org row, and
 * neither the builder nor its tests changed, because the builder already
 * accepted recipients as input. Since 2026-10-25 the compiled pair is a
 * SAMPLE pair on reserved `.test` domains (RFC 6761): the repository is
 * public, so no tenant's real mailboxes, and no real person's, live here.
 *
 * WHAT REMAINS FOR THESE CONSTANTS, exactly two roles and nothing else:
 *
 *  1. THE CODE-BEFORE-MIGRATION FALLBACK. Deploy-order safety for this
 *     feature is FAIL OPEN: code that reads a missing `email_routing` column
 *     (Postgres 42703) composes with this pair instead of failing the page.
 *     That is the ONLY path that ever returns these constants; once the
 *     column exists it is never taken, and every database has had the column
 *     since migration 0337. A `.test` address reaches no mailbox, so even
 *     that window can mail no one. See `deliveryRecipientsForRouting` below.
 *  2. ONE VALIDATED PAIR FOR THE TESTS, built through the same factory every
 *     stored value passes.
 *
 * An org WITHOUT a stored value gets NEITHER of these: its email action is
 * hidden ('unset'), and an org with an INVALID stored value fails closed the
 * same way. Falling back to a compiled pair for an org would compose with
 * mailboxes that org never configured, the exact leak the per-org feature
 * exists to end.
 *
 * WHAT THE ROLES MEAN (unchanged; the copy rules depend on it): `to` is a
 * warehouse intake mailbox, which for the first tenant becomes a Zendesk
 * ticket through Zendesk's EMAIL INTAKE, entirely outside this application,
 * so StockPilot can never confirm a ticket exists and must never say that it
 * does. `cc` is a person, the warehouse lead, who receives a direct copy;
 * Zendesk rules MAY use it to route or assign, but we cannot observe that, so
 * no copy anywhere may promise it.
 *
 * SECURITY: frozen compile-time literals, never read from a URL parameter,
 * localStorage, order notes, a requester-entered form value, a
 * client-supplied API parameter, or destination-site data. The PER-ORG path
 * is different by design: a stored value IS client-influenced data, which is
 * why it must pass the branded factory (`deliveryRequestRecipients`) before
 * any surface will compose with it.
 */
export const DELIVERY_REQUEST_EMAIL = Object.freeze({
  to: 'dc4@sampleorg.test',
  cc: 'jstone@site1.test',
} as const);

/**
 * Cosmetic display labels for the Outlook compose chips: the human-readable
 * name half of a name-addr ("Name <addr>"). The name-addr shape was
 * tenant-verified 2026-08-01 against the first tenant's real Microsoft 365
 * tenant (OWA compose showed one chip for the intake and one for the
 * warehouse lead, each a display name over its address).
 *
 * Same two roles as the addresses above: the compiled fallback's names, and
 * the tests'. The ADDRESSES remain the routing truth; these are decoration,
 * dropped by every transport except the tenant-verified OWA `mailtouri`
 * path.
 *
 * SECURITY: names must stay free of RFC 5322 specials (`< > , " @ ;`):
 * `assertSafeDisplayName` enforces that at runtime on every transport, and
 * the branded factory runs it on every configured name, so a per-org name
 * that could split the name-addr (and silently drop the mandatory CC) is a
 * hard throw rather than a silent misroute.
 */
export const DELIVERY_REQUEST_EMAIL_NAMES = Object.freeze({
  to: 'Fresno Warehouse DC4',
  cc: 'Jordan Stone',
} as const);

/**
 * THE COMPILED VALUE, built once through the only constructor there is.
 *
 * No surface imports this as "the recipients" any more: surfaces resolve
 * the org row and construct through the factory at their own seam. This
 * value exists so the fallback mapping below and the tests share one
 * already-validated instance of the compiled pair.
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
 * mailbox: where the mail is addressed. The previous fixed notice's "The
 * DC4 address creates the delivery-request ticket" sentence was knowledge of
 * one tenant's Zendesk the platform cannot truthfully claim for an arbitrary
 * org, so it is gone everywhere, that tenant's screens included (a
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
 *   'fallback' -> the COMPILED sample pair. DEPLOY-ORDER SAFETY: this state
 *                 means the `email_routing` column does not exist yet (code
 *                 deployed before migration 0337), and the fallback exists
 *                 solely so that window cannot outage anything. Once the
 *                 column exists this arm is never taken.
 *   'valid'    -> the stored recipients, re-branded through the factory. The
 *                 parser already validated them, so the construction cannot
 *                 throw for a value the parser produced; the try/catch is
 *                 belt-and-braces for a caller that hand-built the state,
 *                 and it fails CLOSED (null), never open.
 *   'unset'    -> null: the action is HIDDEN for this org.
 *   'invalid'  -> null: FAIL CLOSED for this org. Never the constants:
 *                 the org never configured them.
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
