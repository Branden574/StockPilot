/**
 * Every word the returns and exchanges screens print: one set for the web,
 * the phone, the token page and the B2B portal (returns plan section 6).
 * Surfaces never write their own sentence for these states; a guard test
 * (returns-copy.test.ts) refuses words the owner banned ("book" for a
 * recorded quantity, and claims like "verified", "inspected", "certified",
 * "guaranteed").
 *
 * Plain literals and pure functions only: importing this module runs nothing.
 */

import { formatOrderNumber } from '../orders/order-number';

// ── Headings and labels ─────────────────────────────────────────────────────

export const RETURNS_COPY = {
  returning: 'RETURNING',
  replacement: 'REPLACEMENT',
  replacementAvailability: 'REPLACEMENT AVAILABILITY',
  returnDisposition: 'RETURN DISPOSITION',
  returnedItemDestination: 'RETURNED ITEM DESTINATION',
  size: 'Size',
  notVisibleToYou: 'Not visible to you',
  requestedByRequester: 'Requested by the requester',
  createdByStaff: 'Created by staff',
  typeReturn: 'Return',
  typeExchange: 'Exchange',

  // Choice (create and requester forms)
  whatWouldYouLikeToDo: 'What would you like to do?',
  returnOnly: 'Return only',
  exchangeStaff: 'Exchange for another size or item',
  exchangeRequester: 'Exchange for another size',
  warehouseReview: 'Request a different replacement: warehouse will review.',
  warehouseReviewNote: 'Tell the warehouse what you need (up to 500 characters)',
  available: 'Available',
  notInStock: 'Not in stock right now',
  itemIsHere: 'The item is here',
  itemIsHereHelp: 'Switch on only when the returned item is in your hands now.',

  // Destination
  leaveInStaging: 'Leave in Staging',
  scrap: 'Scrap',
  restock: 'Restock',
  oneOfTheOriginalRacks: 'Return to one of the original racks',
  originalNotRecorded:
    'Original rack unavailable. The original pick location was not recorded for this historical order.',
  originalNoLongerAvailable: 'Original rack is no longer available.',
  inspectBeforeChoosing: 'Inspect before choosing.',

  // What happens when you approve (return only; the exchange lines arrive in RX-2)
  approveNothingMoves: 'Nothing moves now. The returned item stays out until it is received.',

  // Buttons
  approveReturnAndExchange: 'Approve return & exchange',
  approveReturn: 'Approve return',
  approveAndReceive: 'Approve and receive',
  approveReplacementOnBackorder: 'Approve, replacement on backorder',
  changeReplacement: 'Change replacement',
  declineExchange: 'Decline the exchange, return only',
  addReplacement: 'Add a replacement',
  receive: 'Receive',
  processReturn: 'Process return',
  changeDestination: 'Change destination',
  getReplacementReady: 'Get replacement ready',
  handOver: 'Hand over',
  releaseEarly: 'Release replacement before return is received',
  cancelReplacement: 'Cancel replacement',
  issueNewReplacement: 'Issue a new replacement',
  closeAsReturnOnly: 'Close as return only',
  deny: 'Deny',
  cancelReturn: 'Cancel return',
  openReplacement: 'Open replacement',
  createReturn: 'Create return',

  // Processing lines
  processToRackHint: (rack: string): string =>
    `Put it back on ${rack} now. StockPilot records it there when you tap this.`,
  processToStagingHint: 'It appears in normal put-away.',
  processScrapHint: 'No usable unit is added. The unit is recorded as received and written off.',

  // Prepare chain (RX-2)
  prepareUnconfirmed: "We couldn't confirm the last step. Check and finish.",

  // Confirms
  releaseEarlyConfirm: 'Release the replacement before the returned item arrives? Add a reason.',
  releasePresetInPerson: 'Customer is completing an in-person exchange today.',
  releasePresetDeliverySwap: 'Swap at delivery: the driver collects the returned item.',
  cancelDrawnReplacement: 'The picked items go back to Staging on record. Put them in the staging area.',
  cancelInTransit: 'Ask the driver to bring it back.',
  stillWaiting: 'Still waiting? Cancel the exchange to free the reserved items.',

  // Deny and cancel
  denyReasonLabel: 'Reason for denying',
  denyReasonHelp: 'Required. The requester is told the request was declined, never the reason.',
  cancelReasonLabel: 'Reason (optional)',
  reasonRequired: 'Add a reason.',

  // Inbound states (per returned line)
  inboundWaiting: 'Waiting',
  inboundReceived: 'Received',
  inboundInStaging: 'In Staging',
  inboundScrapped: 'Scrapped',

  // Offline (phone)
  needsConnection: 'Needs a connection.',

  // Read-only reasons
  noManagePermission: "You don't have permission to manage returns.",
  noOrdersApprovePermission: 'Approving the replacement needs order approval permission.',

  // List
  listEmpty: 'No returns match this view.',
  listSearchPlaceholder: 'Search RMA, SO number or requester',
  waitingDays: (days: number): string => (days === 1 ? 'waiting 1 day' : `waiting ${days} days`),
  moreItems: (n: number): string => `+${n}`,

  // Notifications (staff)
  staffNewReturnTitle: 'New return request',
  staffNewExchangeTitle: 'New exchange request',

  // Notifications (requester). No reason text ever reaches a requester.
  requesterReceivedReturnRequest: 'We received your return request.',
  requesterReceivedExchangeRequest: 'We received your exchange request.',
  requesterReturnApproved: 'Your return was approved.',
  requesterExchangeApprovedReserved: 'Your exchange was approved. Your replacement is reserved.',
  requesterExchangeApprovedShort:
    'Your exchange was approved. Your replacement is not in stock yet. The warehouse will follow up.',
  requesterReplacementChanged: 'Your replacement was changed.',
  requesterReplacementCancelled: 'Your replacement was cancelled. The warehouse will follow up.',
  requesterItemReceived: 'We received your returned item.',
  requesterReplacementReady: 'Your replacement is ready',
  requesterReadyForPickup: 'Ready for pickup.',
  requesterReadyForDelivery: 'Ready for delivery.',
  requesterOnTheWay: 'Your replacement is on the way.',
  requesterPartlyHandedOver: 'Part of your replacement was handed over. The rest will follow.',
  requesterExchangeComplete: 'Your exchange is complete.',
  requesterReplacementHandedOver: 'Your replacement was handed over.',
  requesterReturnDeclined: 'Your return request was declined.',
  requesterReturnCancelled: 'Your return request was cancelled.',
} as const;

// ── Sentences with values ───────────────────────────────────────────────────

/** "Qty returning: 1". */
export function qtyReturningLabel(quantity: number): string {
  return `Qty returning: ${quantity}`;
}

/** "Qty requested: 1". */
export function qtyRequestedLabel(quantity: number): string {
  return `Qty requested: ${quantity}`;
}

/** "Available: 14". */
export function availableLabel(quantity: number): string {
  return `Available: ${quantity}`;
}

/** "Short: 0 available, 1 needed." */
export function shortLabel(available: number, needed: number): string {
  return `Short: ${available} available, ${needed} needed.`;
}

/** "Return to original rack: 31-C". */
export function returnToOriginalRackLabel(rack: string): string {
  return `Return to original rack: ${rack}`;
}

/** "Return to original racks: 31-C ×1 · 32-A ×2" (the legs come from the
 *  shared holdings formatter; see restock-view.ts). */
export function returnToOriginalRacksLabel(legs: string): string {
  return `Return to original racks: ${legs}`;
}

/** "up to 3" beside a manager-chosen source. */
export function upToLabel(quantity: number): string {
  return `up to ${quantity}`;
}

/** "Return to 31-C" (the process button for a one-rack plan). */
export function returnToRackButton(rack: string): string {
  return `Return to ${rack}`;
}

/** "Returned to 31-C" or "Returned to 31-C ×1, 32-A ×2" (inbound state). */
export function returnedToLabel(legs: string): string {
  return `Returned to ${legs}`;
}

/** "When processed, the returned item goes back to 31-C." / "into Staging" / "is scrapped". */
export function whenProcessedSentence(
  destination: { kind: 'rack'; rack: string } | { kind: 'staging' } | { kind: 'scrap' },
): string {
  switch (destination.kind) {
    case 'rack':
      return `When processed, the returned item goes back to ${destination.rack}.`;
    case 'staging':
      return 'When processed, the returned item goes into Staging.';
    case 'scrap':
      return 'When processed, the returned item is scrapped.';
  }
}

/** "Already marked received by Dana at 3:04 PM." */
export function alreadyReceivedSentence(who: string | null, when: string | null): string {
  return `Already marked received${who ? ` by ${who}` : ''}${when ? ` at ${when}` : ''}.`;
}

/** "Already closed by Dana at 3:04 PM." */
export function alreadyClosedSentence(who: string | null, when: string | null): string {
  return `Already closed${who ? ` by ${who}` : ''}${when ? ` at ${when}` : ''}.`;
}

/** The staff push body: "<requester> · RMA-… · SO-…". */
export function staffNewRequestBody(
  requester: string | null,
  returnNumber: string | null,
  orderNumber: number | null,
): string {
  return [requester, returnNumber, formatOrderNumber(orderNumber)].filter(Boolean).join(' · ');
}

/** "Against order SO-000103" for headers and rows. */
export function againstOrderLabel(orderNumber: number | null, orderId: string): string {
  return `Against order ${formatOrderNumber(orderNumber) ?? orderId.slice(0, 8).toUpperCase()}`;
}
