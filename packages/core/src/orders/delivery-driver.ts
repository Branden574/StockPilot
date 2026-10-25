/**
 * An order's delivery driver after the driver deleted their account (B23).
 *
 * Migration 0393 lets every member delete their account. The order stays; the
 * driver column does not: the deletion's release step clears
 * `assigned_delivery_user_id` on every open order, and the foreign key nulls
 * it on the rest. order_requests carries no `deleted_users` marker for the
 * driver, so the order's own facts say it instead, and they are proof, never
 * a guess:
 *   - only a delivery ever has a driver;
 *   - nothing goes in transit without one (mark_order_in_transit refuses
 *     `no_driver` and stamps `in_transit_at`, 0390; the order RPCs alone write
 *     both columns, 0392);
 *   - `in_transit_at` is never cleared, and only the deletion clears the
 *     driver.
 * So a delivery that went in transit and names no driver lost its driver to
 * an account deletion. A delivery that never went in transit needed no driver
 * yet, and reads as unassigned, as before.
 *
 * Nothing here blocks the order: an approver hands it over as for any
 * in-transit delivery (the sign route's member path and
 * confirm_physical_signature admit an approver without a driver). The words
 * below only say who is left to do it.
 */

import { DELETED_USER_LABEL } from '../people/deleted-user';

/** The order columns the answer reads, as both apps name them. */
export interface DeliveryDriverFacts {
  /** order_requests.fulfillment_type ('pickup' | 'delivery'). */
  fulfillmentType: string | null | undefined;
  /** order_requests.in_transit_at: set once, when the order went out. */
  inTransitAt: string | null | undefined;
  /** order_requests.assigned_delivery_user_id. */
  assignedDeliveryUserId: string | null | undefined;
}

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** Whether this delivery's driver deleted their account (see the file note). */
export function isDeliveryDriverDeleted(facts: DeliveryDriverFacts): boolean {
  return (
    facts.fulfillmentType === 'delivery' &&
    present(facts.inTransitAt) &&
    !present(facts.assignedDeliveryUserId)
  );
}

/**
 * The Driver cell for an order:
 *   - a pickup: null (no driver, ever);
 *   - a driver who deleted their account: "Deleted user" (the id is gone, so
 *     no name was resolved for it);
 *   - otherwise the name the reader resolved for the driver (trimmed), else
 *     null (an unassigned delivery, or a profile the reader cannot see).
 * The raw id is never returned.
 */
export function deliveryDriverLabel(
  facts: DeliveryDriverFacts & { driverName: string | null | undefined },
): string | null {
  if (facts.fulfillmentType !== 'delivery') return null;
  if (isDeliveryDriverDeleted(facts)) return DELETED_USER_LABEL;
  const name = typeof facts.driverName === 'string' ? facts.driverName.trim() : '';
  return name || null;
}

/**
 * The line an approver reads at an in-transit delivery whose driver deleted
 * their account: nobody else is coming to finish it, and these are the
 * buttons that do. Physical signature is named only for a viewer who is
 * offered it (a manager by role, as confirm_physical_signature decides).
 */
export function deletedDriverHandOverLine(input: { offersPhysicalSignature: boolean }): string {
  const buttons = input.offersPhysicalSignature
    ? 'Collect signature or Physical signature'
    : 'Collect signature';
  return `The driver of this delivery deleted their account. Record the hand-over here with ${buttons}.`;
}
