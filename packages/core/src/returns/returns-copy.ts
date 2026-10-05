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
  itemIsHereHelp:
    'Switch on only when the returned item is handed to you at the counter now. A requester is not sent the approved and received messages.',

  // Destination
  leaveInStaging: 'Leave in Staging',
  scrap: 'Scrap',
  restock: 'Restock',
  oneOfTheOriginalRacks: 'Return to one of the original racks',
  originalNotRecorded:
    'Original rack unavailable. The original pick location was not recorded for this historical order.',
  originalNoLongerAvailable: 'Original rack is no longer available.',
  originalLocationsChanged: 'The original locations changed.',
  chooseDestination: 'Choose a destination.',
  destinationsUnavailable: "Couldn't load where the returned item goes. Reload.",
  inspectBeforeChoosing: 'Inspect before choosing.',

  // What happens when you approve (return only; the exchange lines arrive in RX-2)
  approveNothingMoves: 'Nothing moves now. The returned item stays out until the return is processed.',

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
  createReturnHelp:
    'Pick how many of each item is coming back. Restock puts it back in stock when the return is processed; Scrap writes it off.',
  createReturnQueueNote: 'Goes to the returns approval queue. Stock moves only when the return is processed.',

  // Processing lines
  processToRackHint: (rack: string): string =>
    `Put it back on ${rack} now. StockPilot records it there when you tap this.`,
  processToStagingHint: 'It appears in normal put-away.',
  processScrapHint: 'No usable unit is added. The unit is recorded as received and written off.',

  // Prepare chain (RX-2)
  prepareUnconfirmed: "We couldn't confirm the last step. Check and finish.",
  prepareStaged: 'The replacement is staged. Hand it over on its order.',
  prepareStagedDelivery: 'The replacement is staged for delivery. Assign the driver on its order.',
  prepareStopped: 'Stopped before the next step.',

  // The replacement (RX-2)
  replacementRequested: 'Requested',
  replacementApproved: 'Approved',
  replacementWarehouseReview: 'Warehouse will review',
  replacementNoteFromRequester: 'Note from the requester',
  replacementChangedByWarehouse: 'Changed by the warehouse',
  approveAsRequested: 'Approve as requested',
  chooseReplacement: 'Choose the replacement',
  changeReplacementEllipsis: 'Change replacement…',
  replacementReasonLabel: 'Reason (required)',
  replacementReasonHelp: 'Kept on the return. The requester is never shown it.',
  declineReasonLabel: 'Reason for declining the exchange (required)',
  whenShortLabel: 'If it is not in stock',
  whenShortRefuse: "Don't approve: show me what is short",
  whenShortBackorder: 'Approve, replacement on backorder',
  replacementSiblings: 'Other sizes',
  replacementOtherItems: 'Other items',
  replacementSearchPlaceholder: 'Search by name or SKU',
  replacementSearchHint: 'Type at least two characters.',
  replacementNoMatches: 'No items match.',
  replacementSameAsReturned: 'Same as returned',
  replacementQuantity: 'Quantity',
  exchangeStatusHeading: 'EXCHANGE',
  returnStatusHeading: 'RETURN',
  replacementOrderHeading: 'Replacement order',
  noReplacementYet: 'No replacement order yet. One is created when the exchange is approved.',
  exchangeKillSwitch: 'Exchanges are turned off right now. Request a return only.',
  releaseEarlyReasonLabel: 'Reason for releasing early (required)',
  cancelReplacementReasonLabel: 'Reason for cancelling the replacement (required)',
  // Desk check F9: after a replacement cancel, the exchange ends for good.
  closeAsReturnOnlyHelp: 'No new replacement is issued. The return goes on as a return only.',
  closeAsReturnOnlyReasonLabel: 'Reason for keeping the return only (required)',
  closedAsReturnOnly: 'Kept as a return only.',
  cancelReturnReasonRequired: 'Reason (required: the exchange was approved)',
  getReplacementReadyHelp: 'Prints the pick slip, picks, prints the packing slips and stages it. Stops before the signature.',
  changeOrCancelHere: 'Change or cancel this replacement from its RMA.',
  releaseBeforeReturn: 'Release before return is received',
  releasedForPicking: 'Released for picking.',
  releaseNotNeeded: 'The return was already received.',
  releaseAlreadyDone: 'Already released.',

  // The outbound rail (RX-2)
  railRequested: 'Requested',
  railReserved: 'Reserved',
  railNotInStock: 'Not in stock',
  railWaitingForReturn: 'Waiting for return',
  railReleasedEarly: 'Released early',
  railReturnReceived: 'Return received',
  railPicking: 'Picking',
  railReadyForPickup: 'Ready for pickup',
  railOutForDelivery: 'Out for delivery',
  railHandedOver: 'Handed over',
  railPartlyHandedOver: 'Partly handed over',
  railDeclined: 'Declined',
  railCancelled: 'Cancelled',

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
  denyReasonHelpInternal: 'Required. The reason is kept on the return. Nobody is notified.',
  cancelReasonLabel: 'Reason (optional)',
  reasonRequired: 'Add a reason.',

  // Inbound states (per returned line)
  inboundWaiting: 'Waiting',
  inboundReceived: 'Received',
  inboundInStaging: 'In Staging',
  inboundScrapped: 'Scrapped',
  inboundNotReturned: 'Not returned',

  // Offline (phone)
  needsConnection: 'Needs a connection.',
  offlineActionsWait: 'Offline: every action waits for a connection.',

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

/** Where a returned line goes when processed; 'choose' while no valid
 *  destination is chosen (with why). */
export type ProcessDestination =
  | { kind: 'rack'; rack: string }
  | { kind: 'staging' }
  | { kind: 'scrap' }
  | { kind: 'choose'; reason: string };

/**
 * "When processed, New Hire Shirt, M goes back to 31-C." / "goes into
 * Staging" / "is scrapped" (the item named when given, else "the returned
 * item"); for a line with no valid destination: "New Hire Shirt, M: Original
 * rack is no longer available: 31-C (archived). Choose a destination."
 */
export function whenProcessedSentence(destination: ProcessDestination, item?: string | null): string {
  const subject = item && item.trim() ? item.trim() : 'the returned item';
  switch (destination.kind) {
    case 'rack':
      return `When processed, ${subject} goes back to ${destination.rack}.`;
    case 'staging':
      return `When processed, ${subject} goes into Staging.`;
    case 'scrap':
      return `When processed, ${subject} is scrapped.`;
    case 'choose':
      return choiceNeededSentence(item ?? null, destination.reason);
  }
}

/** "New Hire Shirt, M: Original rack is no longer available: 31-C (archived).
 *  Choose a destination." (the reason alone when no item is given). */
export function choiceNeededSentence(item: string | null, reason: string): string {
  const prefix = item && item.trim() ? `${item.trim()}: ` : '';
  const tail = reason === RETURNS_COPY.destinationsUnavailable ? '' : ` ${RETURNS_COPY.chooseDestination}`;
  return `${prefix}${reason}${tail}`;
}

/** "New Hire Shirt, M" or "New Hire Shirt" for the sentences that name a
 *  line; a name that already carries the size ("Walk New Hire Shirt - 2XL")
 *  is not repeated. */
export function returnLineLabel(name: string | null | undefined, variant: string | null | undefined): string {
  const n = (name ?? '').trim() || 'Item';
  const v = (variant ?? '').trim().replace(/^Size\s+/i, '');
  if (!v) return n;
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, 'i').test(n) ? n : `${n}, ${v}`;
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

/** The Staging worklist's source for a unit a return restocked there:
 *  "Returned (RMA-20261005-ABC123)" (plan RX-1, inventory.ts worklist). */
export function stagingReturnedSourceLabel(returnNumber: string | null): string {
  return returnNumber ? `Returned (${returnNumber})` : 'Returned';
}

// ── RX-2: the replacement in sentences ──────────────────────────────────────

/** "New Hire Shirt, L ×1" (the item's name and size, then the quantity). */
export function itemQuantityLabel(label: string, quantity: number): string {
  return `${label} ×${quantity}`;
}

/** "Exchange replacement for RMA-… · Original order SO-…" (the order page banner). */
export function exchangeReplacementBanner(returnNumber: string | null, originalOrderNumber: number | null): string {
  const rma = returnNumber ?? 'its RMA';
  const so = formatOrderNumber(originalOrderNumber);
  return so ? `Exchange replacement for ${rma} · Original order ${so}` : `Exchange replacement for ${rma}`;
}

/** "Replacement reserved. Waiting for returned item (RMA-…)" (the gated order). */
export function waitingForReturnLine(returnNumber: string | null): string {
  return `Replacement reserved. Waiting for returned item${returnNumber ? ` (${returnNumber})` : ''}`;
}

/**
 * A replacement whose RMA was cancelled or denied (desk check F3): the gate
 * never lets it into picking, so neither the pick slip nor Resume is offered.
 */
export function returnCancelledReplacementLine(returnNumber: string | null): string {
  return `${returnNumber ?? 'Its return'} was cancelled. This replacement isn't picked.`;
}

/**
 * The words after "Release before return is received" (web and phone, one
 * rule): released now, not needed (the returned item already arrived), or
 * a repeat of a release already made.
 */
export function releaseOutcomeLine(answer: { changed?: boolean | null; notNeeded?: boolean | null }): string {
  if (answer.changed) return RETURNS_COPY.releasedForPicking;
  return answer.notNeeded ? RETURNS_COPY.releaseNotNeeded : RETURNS_COPY.releaseAlreadyDone;
}

/** "Released before the return by Dana: Swap at delivery." (the reason only for staff who read returns). */
export function releasedBeforeReturnLine(who: string | null, reason: string | null): string {
  const by = who ? ` by ${who}` : '';
  return reason ? `Released before the return${by}: ${reason}` : `Released before the return${by}.`;
}

/** "Change or cancel in RMA-…" (replaces Cancel, Add items and Edit lines). */
export function changeOrCancelInRmaLabel(returnNumber: string | null): string {
  return `Change or cancel in ${returnNumber ?? 'its RMA'}`;
}

/** The original order's returns section: "Exchange: Large ×1 → SO-000103 (Waiting for returned item)". */
export function originalExchangeLine(replacement: string, replacementOrderNumber: number | null, statusWords: string | null): string {
  const so = formatOrderNumber(replacementOrderNumber);
  const target = so ? ` → ${so}` : '';
  return `Exchange: ${replacement}${target}${statusWords ? ` (${statusWords})` : ''}`;
}

/** The driver's read-only line: "Collect the returned item: New Hire Shirt, M ×1 (RMA-…)". */
export function collectReturnedItemLine(returned: string, returnNumber: string | null): string {
  return `Collect the returned item: ${returned}${returnNumber ? ` (${returnNumber})` : ''}`;
}

/** The slips' line: "Exchange replacement for RMA-… (returned item: New Hire Shirt, M ×1, received)". */
export function slipExchangeLine(returnNumber: string | null, returned: string | null, received: boolean): string {
  const state = received ? 'received' : 'not yet received';
  const item = returned ? `returned item: ${returned}, ${state}` : `returned item ${state}`;
  return `Exchange replacement for ${returnNumber ?? 'its RMA'} (${item})`;
}

/** The prepare chain's pick hint: "Take Large ×1 from 12-B (3 on hand)". */
export function prepareTakeLine(item: string, quantity: number, rack: string | null, onHand: number | null): string {
  const from = rack ? ` from ${rack}` : '';
  const left = onHand !== null && onHand !== undefined ? ` (${onHand} on hand)` : '';
  return `Take ${item} ×${quantity}${from}${left}`;
}

/** The replacement's timeline: "Created as exchange replacement for RMA-… (revision 2)". */
export function createdAsReplacementLabel(returnNumber: string | null, revision: number | null): string {
  const rev = revision && revision > 1 ? ` (revision ${revision})` : '';
  return `Created as exchange replacement for ${returnNumber ?? 'its RMA'}${rev}`;
}

/**
 * "What happens when you approve" for an exchange line (plan section 6):
 * "A replacement order is created for New Hire Shirt, L ×1 and 1 is reserved."
 * or, when short, "... none is in stock right now (0 available, 1 needed)."
 * The SO number exists only after the approval, so it is not named here.
 */
export function approveReplacementSentence(replacement: string, quantity: number, available: number | null): string {
  if (available !== null && available < quantity) {
    const held = Math.max(0, available);
    const now = held === 0 ? 'none is in stock right now' : `only ${held} can be reserved now`;
    return `A replacement order is created for ${replacement} ×${quantity}; ${now} (${held} available, ${quantity} needed).`;
  }
  return `A replacement order is created for ${replacement} ×${quantity} and ${quantity} ${quantity === 1 ? 'is' : 'are'} reserved.`;
}

/** "Picking waits until New Hire Shirt, M is received." (or, at the counter, it can start). */
export function pickingWaitsSentence(returned: string | null, itemIsHere: boolean, plural = false): string {
  if (itemIsHere) return plural ? 'The returned items are here, so picking can start.' : 'The returned item is here, so picking can start.';
  if (plural) return 'Picking waits until the returned items are received.';
  return `Picking waits until ${returned && returned.trim() ? returned.trim() : 'the returned item'} is received.`;
}

/** "Short: Large 0 available, 1 needed." for a refused approval, one per short item. */
export function replacementShortLine(item: string, available: number, needed: number): string {
  return `${item}: ${available} available, ${needed} needed.`;
}

/** "waiting 15 days. Still waiting? Cancel the exchange to free the reserved items." (from 14 days). */
export function stillWaitingLine(days: number): string {
  return `${RETURNS_COPY.waitingDays(days)}. ${RETURNS_COPY.stillWaiting}`;
}
