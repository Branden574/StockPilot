/**
 * Who sees which order action on the phone's order screen (the MANAGER
 * ACTIONS section), security slice D (migration 0390).
 *
 * The screen used to gate the whole section, and every button in it, on role
 * rank (owner, admin or manager). The database decides approval-class actions
 * with the effective orders:approve permission alone since 0390, and the web
 * order page already followed the permission (`showActionsPanel`), so:
 *   - a staff member granted orders:approve saw no Approve or Deny on the
 *     phone, although the web and the database allowed them;
 *   - a manager whose orders:approve was revoked saw them, and every tap was
 *     refused.
 * Each gate below is the rule the server applies to that action, so the
 * screen offers exactly what the server accepts. Old bundles keep showing
 * actions by role; the server still refuses what they may not do.
 *
 * Pure (no React, no native modules), so vitest can pin it; the screen reads
 * the result. The picking phase has its own section (claim, pick, release)
 * and is not decided here.
 */

/** What decides the section; every flag is the viewer's EFFECTIVE answer. */
export interface OrderManagerActionsInput {
  status: string | null | undefined;
  fulfillmentType: string | null | undefined;
  /** can(orders:approve): the effective set, static role defaults while it loads. */
  canApproveOrders: boolean;
  /** can(orders:assign_delivery): the permission assignDelivery checks. */
  canAssignDelivery: boolean;
  /** Owner, admin or manager by role: only confirm_physical_signature still
   *  asks this (a manager or the assigned driver), so only Physical signature
   *  reads it. */
  isManagerByRole: boolean;
  /** The order's assigned delivery driver is the viewer. */
  isAssignedDriver: boolean;
  /** The order has a delivery driver at all. */
  hasAssignedDriver: boolean;
  /** The shared order state machine offers reopen_picking to this viewer
   *  (core availableOrderActions with canApproveOrders, the web panel's own
   *  answer). */
  machineOffersReopen: boolean;
}

export interface OrderManagerActions {
  /** Render the section at all (never an empty one). */
  showSection: boolean;
  approve: boolean;
  /** Offered at pending approval; the stock gates still decide enabled. */
  approvePartial: boolean;
  deny: boolean;
  generatePickSlip: boolean;
  generatePackingSlips: boolean;
  stageForPickup: boolean;
  stageForDelivery: boolean;
  reopenPicking: boolean;
  assignDelivery: boolean;
  markInTransit: boolean;
  /** Collect signature (the digital sign page). */
  digitalSignature: boolean;
  physicalSignature: boolean;
  /** Resume fulfillment, Close as delivered-partial and Cancel order at
   *  backordered. */
  backorderedActions: boolean;
}

/** The statuses whose actions are orders:approve actions: the web page's
 *  canApprove side of showActionsPanel, less the picking phase. */
const APPROVER_STATUSES: ReadonlySet<string> = new Set([
  'pending_approval',
  'approved',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_delivery',
  'staged_for_pickup',
  'in_transit',
  'backordered',
]);

/** Where an assigned driver's own actions live (the web page's
 *  isAssignedDriver side of showActionsPanel). */
const DRIVER_STATUSES: ReadonlySet<string> = new Set(['staged_for_delivery', 'in_transit']);

export function orderManagerActions(input: OrderManagerActionsInput): OrderManagerActions {
  const st = input.status ?? '';
  const ft = input.fulfillmentType ?? '';
  const approver = input.canApproveOrders && APPROVER_STATUSES.has(st);
  const driverHere = input.isAssignedDriver && DRIVER_STATUSES.has(st);
  // The web's showActionsPanel audience for these statuses.
  const audience = approver || driverHere;

  const at = (s: string) => audience && st === s;
  const handOver = st === 'staged_for_pickup' || st === 'in_transit';

  const gates: Omit<OrderManagerActions, 'showSection'> = {
    approve: approver && st === 'pending_approval',
    approvePartial: approver && st === 'pending_approval',
    deny: approver && st === 'pending_approval',
    generatePickSlip: approver && st === 'approved',
    generatePackingSlips: approver && st === 'picking_complete',
    stageForPickup: approver && st === 'packing_slip_generated' && ft === 'pickup',
    stageForDelivery: approver && st === 'packing_slip_generated' && ft === 'delivery',
    // reopen_picking asks orders:approve; the shared machine decides the
    // statuses and, given canApproveOrders, the same permission (0390).
    reopenPicking:
      approver &&
      (st === 'picking_complete' || st === 'packing_slip_generated') &&
      input.machineOffersReopen,
    // assign_order_delivery's own gate.
    assignDelivery: approver && st === 'staged_for_delivery' && input.canAssignDelivery,
    // mark_order_in_transit (owner decision O3, default): orders:approve, the
    // driver included. A staff driver without it is refused by the server, so
    // the button is not offered.
    markInTransit:
      at('staged_for_delivery') && input.hasAssignedDriver && input.canApproveOrders,
    // The sign route's member path admits an approver or the assigned driver:
    // exactly this section's audience at a hand-over status.
    digitalSignature: audience && handOver,
    // confirm_physical_signature: a manager by role or the assigned driver.
    physicalSignature: audience && handOver && (input.isManagerByRole || input.isAssignedDriver),
    backorderedActions: approver && st === 'backordered',
  };
  const showSection = audience && Object.values(gates).some(Boolean);
  return { showSection, ...gates };
}
