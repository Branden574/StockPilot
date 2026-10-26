/**
 * The order page's actions panel READS: what it offers that changes nothing.
 *
 * Security slice E (migration 0405) offers an approver outside the order's
 * warehouse none of the panel's steps, because every step asks write access
 * to that warehouse. The panel's reads ask none:
 *   - Print pick slip (pick-slip.pdf) and Print customer slip
 *     (packing-slip-customer.pdf) are any member's who can open the order
 *     (the routes read it through OrderRequestsService.get);
 *   - View signature (/api/orders/[id]/signature) is any approver's, in any
 *     warehouse, or the assigned driver's (isHandOverEntitled); the phone's
 *     View signature card reads the image from the same route.
 * So such an approver keeps the panel at the statuses that have one of them
 * (slice E review): the page shows it there with no step in it. Print
 * warehouse slip is not one: its QR completes the hand-over, and its route
 * asks the hand-over rule (mayHandOverOrder), so the panel offers it only to
 * someone that rule lets through (its canPrintWarehouseSlip).
 *
 * In the picking phase the panel is every member's (claim-before-pick), so
 * this list does not need those two statuses.
 */
import type { OrderRequestStatus } from '@/server/services/order-requests';

/** From the packing slips on: Print customer slip, Print warehouse slip and
 *  View signature (when the order captured one). */
export const DOWNSTREAM_PACKING_STATUSES: readonly OrderRequestStatus[] = [
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'completed',
];

/**
 * Whether the actions panel offers a read at this status to anyone shown it:
 * Print pick slip at picking complete, and from the packing slips on Print
 * customer slip (and View signature once there is one).
 */
export function actionsPanelOffersReads(status: OrderRequestStatus): boolean {
  return status === 'picking_complete' || DOWNSTREAM_PACKING_STATUSES.includes(status);
}
