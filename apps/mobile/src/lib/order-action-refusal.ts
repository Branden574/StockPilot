import { wasAnswered } from './adjust-outbox';

/**
 * Whether the order screen reads the order again after one of its actions
 * failed (Approve, Deny, Mark picked, Hand over, Cancel and the rest, all
 * through the screen's runAction; and the two return sheets' Release
 * replacement and Create return, which say why in the sheet).
 *
 * A REFUSAL is the server's answer that the order on screen is not the one it
 * holds: someone else moved it on (409), the viewer's role or warehouse
 * changed (403), it is gone (404), or the request no longer fits its status
 * (400). The screen used to say why and keep showing the old status and the
 * old buttons until a pull to refresh (docket B10; seen on the simulator,
 * 2026-10-05), so the next tap was refused the same way. After a refusal the
 * order is read again.
 *
 * NO ANSWER (a timeout, a dropped connection) is not a refusal: the order is
 * left as shown. A read would most likely fail the same way, and a failed read
 * replaces the order with its error (the load fails closed).
 */
export function reloadAfterFailedOrderAction(err: unknown): boolean {
  return wasAnswered(err);
}
