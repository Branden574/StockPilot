/**
 * Whether one of the order screen's reason dialogs (Deny, Reopen picking)
 * stays open once its action has finished.
 *
 * A success closes it. A failure keeps the typed reason, so that a retry does
 * not mean typing it again, but only while the order on screen still offers
 * the action. After a refusal runAction reads the order again
 * (reloadAfterFailedOrderAction): when someone else has moved the order on
 * (approved it on another phone), the action is gone, and a dialog left open
 * offers a button the server refuses the same way (docket B60; simulator walk,
 * 2026-10-31). No answer (a timeout) reads nothing, so the order as shown
 * still offers the action and the reason stays. Either way the alert has
 * already said why.
 *
 * `stillOffered` is the condition that shows the action's button, read from
 * the order as the screen shows it after the failure, or null when there is
 * no order to read it from because reading it again failed ("Could not load
 * this order"). Unknown keeps the reason, as no answer does (review of B60):
 * that read fails most often for the same server trouble that failed the
 * action (a 5xx is an answer, so the order is read again), and the order has
 * then most likely not moved, so one more tap goes through once the server is
 * back. If it did move, the server refuses that tap and says why.
 */
export function keepReasonDialogOpen(succeeded: boolean, stillOffered: boolean | null): boolean {
  return !succeeded && stillOffered !== false;
}
