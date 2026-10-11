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

import { isOrderStatusKey, ORDER_STATUS_META } from '../customization/order-status';
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
  // Fix round 1 (verification L1): in a change or a re-issue nothing is approved.
  changeReplacementOnBackorder: 'Change, replacement on backorder',
  issueReplacementOnBackorder: 'Issue, replacement on backorder',
  changeReplacement: 'Change replacement',
  declineExchange: 'Decline the exchange, return only',
  addReplacement: 'Add a replacement',
  // Review fix P27: the Add-a-replacement card's undo (an action, not a status).
  keepAsReturnOnly: 'Keep as return only',
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
  replacementDeclined: 'Declined',
  replacementCancelled: 'Cancelled',
  replacementWarehouseReview: 'Warehouse will review',
  /** RX-3 fix round 1 (M3): a replacement asked for with a note, once declined or cancelled. */
  replacementAskedByNote: 'A different replacement',
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
  earlierReplacements: 'Earlier replacements',
  noReplacementYet: 'No replacement order yet. One is created when the exchange is approved.',
  // RX-2 review fix P4: an exchange that ended before any replacement.
  noReplacementDeclined: 'No replacement order: the exchange was declined.',
  noReplacementCancelled: 'No replacement order: the exchange was cancelled with the return.',
  exchangeKillSwitch: 'Exchanges are turned off right now. Request a return only.',
  releaseEarlyReasonLabel: 'Reason for releasing early (required)',
  cancelReplacementReasonLabel: 'Reason for cancelling the replacement (required)',
  // Desk check F6: where the replacement goes when the original delivery site
  // is not one the warehouse serves (replacement_site_not_available).
  siteChoiceTitle: 'Where does the replacement go?',
  siteChoiceHelp: "The original delivery site isn't one this warehouse serves now. Choose a site it serves, or pickup.",
  pickupInstead: 'Pickup instead',
  chooseSite: 'Choose where the replacement goes.',
  // Desk check F9: after a replacement cancel, the exchange ends for good.
  closeAsReturnOnlyHelp: 'No new replacement is issued. The return goes on as a return only.',
  closeAsReturnOnlyReasonLabel: 'Reason for keeping the return only (required)',
  closedAsReturnOnly: 'Kept as a return only.',
  cancelReturnReasonRequired: 'Reason (required: the exchange was approved)',
  // Review fix P18: nothing prints; shown under the button (and as the
  // phone's accessibility hint) before it draws stock and stages the order.
  getReplacementReadyHelp:
    'Makes the pick slip, records the pick, makes the packing slips and stages it. Take the item from the rack shown first. Stops before the signature.',
  changeOrCancelHere: 'Change or cancel this replacement from its RMA.',
  // RX-2 review fix P9: the replacement's requester, who cannot open the RMA.
  replacementChangeContactWarehouse: 'To change or cancel this replacement, contact the warehouse.',
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
  // Each step's state in words (the web step text and both screen readers;
  // review fix P4: after a stop nothing reads "next").
  railProgress: 'Replacement progress',
  railStateDone: 'done',
  railStateNow: 'now',
  railStateNext: 'next',
  railStateStopped: 'stopped',
  railStateNotReached: 'not reached',
  railStateNotStarted: 'not started',

  // Confirms
  releaseEarlyConfirm: 'Release the replacement before the returned item arrives? Add a reason.',
  releasePresetInPerson: 'Customer is completing an in-person exchange today.',
  releasePresetDeliverySwap: 'Swap at delivery: the driver collects the returned item.',
  cancelDrawnReplacement: 'The picked items go back to Staging on record. Put them in the staging area.',
  cancelInTransit: 'Ask the driver to bring it back.',
  // Fix round 1 (verification V1): after the call, from the answer.
  replacementCancelledDone: 'Replacement cancelled.',
  replacementNothingToCancel: 'There is no replacement to cancel any more.',
  // RX-2 review fix P2: what happens to the replacement (web dialogs and phone
  // sheets; return-actions.ts exchangeActionConsequences picks the sentence).
  cancelReturnPartHandedOver:
    'The return closes as cancelled. What was already handed over stays handed over; the rest of the replacement is never sent.',
  cancelReturnAllHandedOver: 'The return closes as cancelled. The replacement was already handed over and stays as it is.',
  cancelReplacementEffect:
    'The replacement order is cancelled and its reserved items are freed. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
  cancelReplacementEffectNothingHeld:
    'The replacement order is cancelled. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
  changeReplacementEffect: 'The current replacement order is cancelled and a new one is created and reserved in the same step.',
  issueReplacementEffect: 'A new replacement order is created and reserved.',
  // RX-2 review fix P17 (built in RX-3): the 14-day prompt names the two
  // buttons that end the wait (plan section 6 had "Still waiting? Cancel the
  // exchange to free the reserved items.", which named no button).
  stillWaiting: 'Still waiting for the returned item? Cancel replacement frees the reserved items; Cancel return ends the return too.',
  stillWaitingNothingHeld:
    'Still waiting for the returned item? Cancel replacement cancels the replacement order; Cancel return ends the return too.',
  /** RX-3 fix round 1 (L5): the same, for a viewer not offered Cancel return. */
  stillWaitingNoCancelReturn: 'Still waiting for the returned item? Cancel replacement frees the reserved items.',
  stillWaitingNothingHeldNoCancelReturn:
    'Still waiting for the returned item? Cancel replacement cancels the replacement order.',

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
  // Fix round 1 (verification L3): once the exchange was approved nothing is
  // being approved; these say what needs order approval.
  noOrdersApproveReplacement: 'Changing, cancelling, releasing, preparing or issuing the replacement needs order approval permission.',
  noOrdersApproveReplacementAndCancel:
    'Changing, cancelling, releasing, preparing or issuing the replacement, and cancelling this return, need order approval permission.',
  // RX-2 review fix P1: a requested exchange, for a viewer with Manage
  // returns but not order approval (the review offers only the decline).
  noOrdersApproveDeclineOnly:
    'Approving the replacement needs order approval permission. You can still approve the return: choose Decline the exchange, return only.',
  needsOrderApproval: 'Needs order approval permission.',

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
  // Review fix P14: the replacement waits for the returned item, so the
  // requester is told to bring or send it back.
  requesterExchangeApprovedReserved:
    'Your replacement is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
  requesterExchangeApprovedShort:
    'Your replacement is not in stock yet. The warehouse will follow up. Bring or send the returned item back as arranged with the warehouse.',
  // Review fix P28: every exchange line was added by staff on a return the
  // requester asked for (they asked for no exchange).
  // Fix round 1 (verification M2): that replacement waits for the returned
  // item too, so it says to bring or send it back, as P14's words do.
  requesterReturnApprovedReplacementAdded:
    'Your return was approved. The warehouse added a replacement for you, and it is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
  requesterReturnApprovedReplacementAddedShort:
    'Your return was approved. The warehouse added a replacement for you; it is not in stock yet, and the warehouse will follow up. Bring or send the returned item back as arranged with the warehouse.',
  requesterReplacementChanged: 'Your replacement was changed.',
  requesterReplacementCancelled: 'Your replacement was cancelled. The warehouse will follow up.',
  // Review fix P15: after a replacement cancel, Close as return only.
  requesterReplacementClosedReturnOnly: 'No replacement will be sent. Your return goes on as a return only.',
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
  // RX-3: a requester's exchange request whose every line the warehouse
  // declined at approval (the return goes on): the 3.10 requester sentence.
  requesterExchangeDeclined: 'Exchange declined. Your return was approved.',

  // RX-3: the requester's tracking, the return's own status in their words
  // (core requesterReturnStatusSentence). The exchange's sentence follows it
  // (exchangeRequesterSentence), never merged into it.
  requesterTrackRequested: 'Return requested. The warehouse will review it.',
  requesterTrackApproved: 'Return approved. Bring or send the item back as arranged with the warehouse.',
  requesterTrackReceived: 'Return received.',
  requesterTrackClosed: 'Return complete.',
  requesterTrackDenied: 'Return request declined.',
  requesterTrackCancelled: 'Return request cancelled.',
  /** RX-3 fix round 1 (L7): the exchange declined, said after the return's own sentence. */
  requesterExchangeDeclinedShort: 'Exchange declined.',
  // RX-3: the requester sheet (token page, portal, member).
  requesterReturnOrExchange: 'Return or exchange',
  requesterYourRequests: 'Your requests on this order',
  requesterOptionsUnavailable: "Couldn't load the other sizes. Try again.",
  // RX-3 merge: the sheet's own words, one set for the token page, the B2B
  // portal and the phone (requesterEntryLabel picks the entry's words).
  requesterRequestReturn: 'Request a return',
  requesterSubmit: 'Submit return request',
  requesterSending: 'Sending…',
  requesterNothingLeft: 'Nothing left to return on this order.',
  requesterPickAtLeastOne: 'Pick at least one item to return.',
  requesterChooseSize: (line: string): string => `Choose a size for ${line}.`,
  requesterNoteRequired: (line: string): string => `Tell the warehouse what you need for ${line}.`,
  requesterNotesLabel: 'Notes for the warehouse',
  requesterNotesPlaceholder: 'Anything the warehouse should know about this return.',
  /** The title of a request that has no RMA number yet. */
  requesterRequestTitle: 'Return request',
  requesterReference: (returnNumber: string): string => `Your reference is ${returnNumber}.`,
  /** RX-3 fix round 1 (M4, F3): after idempotency_conflict, the earlier send went through. */
  requesterEarlierRequestSent:
    'Your earlier request went through. It is listed under Your requests on this order. Choose again only for anything else to send back.',
  /** RX-3 fix round 1 (L4): the sizes loading, the web's words and the phone's spinner name. */
  requesterLoadingSizes: 'Loading the other sizes…',
  /** The sheet itself loading (the portal's words; the phone's spinner name). */
  requesterLoadingForm: 'Loading the return form…',
  requesterWarehouseWillReview: 'The warehouse will review it.',
} as const;

/**
 * The replacement's quantity on a requester sheet when there is no stepper
 * (one comes back): "Quantity: 1", the web form's and the phone's words
 * (RX-3 fix round 1, L4; the phone said "Qty requested: 1", staff words).
 */
export function requesterReplacementQuantityLabel(quantity: number): string {
  return `${RETURNS_COPY.replacementQuantity}: ${quantity}`;
}

/**
 * After a requester's request is in: the reference, then that the warehouse
 * reviews it (the token page's confirmation, the phone's alert; RX-3 fix
 * round 1, L4).
 */
export function requesterSentWords(returnNumber: string | null): string {
  const review = RETURNS_COPY.requesterWarehouseWillReview;
  return returnNumber ? `${RETURNS_COPY.requesterReference(returnNumber)} ${review}` : review;
}

/**
 * The words on the requester's way in (the order's link or button, the token
 * page's heading and title, the portal's button and sheet): "Return or
 * exchange" while exchanges are on, "Request a return" while the kill switch
 * holds them back, so no page promises an exchange it then refuses.
 */
export function requesterEntryLabel(exchangesEnabled: boolean): string {
  return exchangesEnabled ? RETURNS_COPY.requesterReturnOrExchange : RETURNS_COPY.requesterRequestReturn;
}

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
 *  is not repeated. An apostrophe is part of a word here (RX-3): the s of
 *  "Women's" is a possessive, never the size S. */
export function returnLineLabel(name: string | null | undefined, variant: string | null | undefined): string {
  const n = (name ?? '').trim() || 'Item';
  const v = (variant ?? '').trim().replace(/^Size\s+/i, '');
  if (!v) return n;
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9'’])${escaped}($|[^A-Za-z0-9'’])`, 'i').test(n) ? n : `${n}, ${v}`;
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

/**
 * Cancel return with a replacement not yet handed over (review fix P2): "The
 * return closes as cancelled. Its replacement order SO-000012 is cancelled too
 * and the reserved items are freed." (nothing is said to be freed when
 * nothing is held).
 */
export function cancelReturnReplacementSentence(orderNumber: number | null, opts: { held?: number | null } = {}): string {
  const so = formatOrderNumber(orderNumber);
  const order = so ? `Its replacement order ${so}` : 'Its replacement order';
  const freed = opts.held === 0 ? '' : ' and the reserved items are freed';
  return `The return closes as cancelled. ${order} is cancelled too${freed}.`;
}

/** What the gate line knows about the replacement's hold. */
export interface WaitingForReturnFacts {
  /** The view's exchange status: 'unavailable' while something owed is not held. */
  exchangeStatus?: string | null;
  /** What the replacement holds now, when known (it decides over the status). */
  held?: number | null;
}

/**
 * The gated order's line: "Replacement reserved. Waiting for returned item
 * (RMA-…)" only when everything owed is held; for a replacement not in stock
 * (on backorder, nothing held) "Not in stock yet. Picking also waits for the
 * returned item (RMA-…)." (review fix P5); for one held in part (the view
 * reads it unavailable while something is held) "Partly reserved; the rest
 * is not in stock yet. …" (fix round 1, verification L9). Without facts, the
 * reserved words (an older server).
 */
export function waitingForReturnLine(returnNumber: string | null, facts: WaitingForReturnFacts = {}): string {
  const knowsHeld = typeof facts.held === 'number' && Number.isFinite(facts.held);
  const notHeld = knowsHeld ? (facts.held as number) <= 0 : facts.exchangeStatus === 'unavailable';
  const rma = returnNumber ? ` (${returnNumber})` : '';
  if (notHeld) return `Not in stock yet. Picking also waits for the returned item${rma}.`;
  if (facts.exchangeStatus === 'unavailable') {
    return `Partly reserved; the rest is not in stock yet. Picking also waits for the returned item${rma}.`;
  }
  return `Replacement reserved. Waiting for returned item${rma}`;
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

/** A delivery site the replacement can go to (desk check F6). */
export function deliverToSiteLabel(siteName: string): string {
  return `Deliver to ${siteName}`;
}

/** "Only someone who manages returns can change or cancel this replacement
 *  (RMA-…)." (a viewer of the replacement order who cannot open its RMA and
 *  is not its requester; review fix P9). */
export function replacementChangeOthersLine(returnNumber: string | null): string {
  return `Only someone who manages returns can change or cancel this replacement${returnNumber ? ` (${returnNumber})` : ''}.`;
}

/** "Change or cancel in RMA-…" (replaces Cancel, Add items and Edit lines). */
export function changeOrCancelInRmaLabel(returnNumber: string | null): string {
  return `Change or cancel in ${returnNumber ?? 'its RMA'}`;
}

/** "Open RMA-…" (the link to the RMA once its replacement was handed over). */
export function openRmaLabel(returnNumber: string | null): string {
  return `Open ${returnNumber ?? 'its RMA'}`;
}

/** What the replacement order's banner reads (the server's replacement block). */
export interface ReplacementBannerInput {
  returnNumber: string | null;
  originalOrderNumber: number | null;
  /** This order is its RMA's current replacement (not one cancelled earlier). */
  live: boolean;
  /** This order was handed over (completed). Absent from an older server. */
  handedOver?: boolean;
  waitingForReturn: boolean;
  /** The RMA was cancelled or denied under it (desk check F3). Absent from an older server. */
  returnClosed?: boolean;
  releasedEarly: boolean;
  release: { byName: string | null; reason: string | null } | null;
  /** The exchange status in staff words (they say when part was never sent). */
  exchangeStatusLabel: string;
  driverLine: string | null;
  /** The view's exchange status (the gate line's hold words, review fix P5). Absent from an older server. */
  exchangeStatus?: string | null;
  /** What this replacement holds now, when the screen knows it. */
  held?: number | null;
  /** The RMA was received (or closed): nothing for a driver to collect. Absent from an older server. */
  returnReceived?: boolean;
  /** The viewer may open the RMA; the viewer's kind when none is passed. */
  canOpenReturn?: boolean;
  /**
   * The viewer may change and cancel the replacement (returns:manage and
   * orders:approve, server-computed). False: the RMA link reads "Open RMA-…"
   * (fix round 1, verification L5). Absent from an older server.
   */
  canChangeReplacement?: boolean;
}

/**
 * The banner's lines by key. 'rma_link' is the RMA link itself ("Change or
 * cancel in RMA-…"), for a viewer who can open the RMA; 'change' is a sentence
 * for anyone else (review fix P9).
 */
export type ReplacementBannerKey = 'title' | 'handed_over' | 'gate' | 'closed' | 'released' | 'driver' | 'change' | 'rma_link';

/** Who reads the replacement order's banner (review fixes P9 and P10). */
export interface ReplacementBannerViewer {
  /** The viewer may open the RMA (the returns module on, returns:read or returns:manage). */
  canOpenRma: boolean;
  /** The viewer is the order's requester. */
  isRequester: boolean;
}

/**
 * Someone who can open the RMA reads it as staff ('returns', even when they
 * also asked for the order), else the order's requester, else anyone else
 * with order access ('other': order staff without returns permissions, a
 * driver).
 */
export type ReplacementBannerViewerKind = 'returns' | 'requester' | 'other';

export function replacementBannerViewerKind(viewer: ReplacementBannerViewer): ReplacementBannerViewerKind {
  if (viewer.canOpenRma) return 'returns';
  return viewer.isRequester ? 'requester' : 'other';
}

function bannerViewer(info: Pick<ReplacementBannerInput, 'canOpenReturn'>, viewer?: ReplacementBannerViewer): ReplacementBannerViewer {
  return viewer ?? { canOpenRma: info.canOpenReturn === true, isRequester: false };
}

/**
 * The driver's line, in one place (review fix P10): only for a delivery that
 * may leave before the returned item arrives (a manager released it early and
 * the RMA is not received), while it is still to be handed over, and never for
 * the requester (it is an instruction to staff). Null otherwise.
 */
export function replacementDriverLine(
  info: Pick<ReplacementBannerInput, 'live' | 'handedOver' | 'releasedEarly' | 'returnReceived' | 'driverLine' | 'canOpenReturn'>,
  fulfillmentType: 'pickup' | 'delivery' | null,
  viewer?: ReplacementBannerViewer,
): string | null {
  const inFlight = info.live && info.handedOver !== true;
  if (!inFlight || fulfillmentType !== 'delivery' || !info.releasedEarly || info.returnReceived === true) return null;
  if (replacementBannerViewerKind(bannerViewer(info, viewer)) === 'requester') return null;
  return info.driverLine || null;
}

/**
 * The replacement order's banner, line by line (web and phone, one rule;
 * plan 3.6.9). While the replacement is still to be handed over: the
 * return-first gate, an RMA cancelled under it, an early release, the
 * driver's line for an early-released delivery (replacementDriverLine), and
 * where it is changed or cancelled, for who is reading (review fix P9): the
 * RMA link alone for someone who can open it, who to ask for the requester,
 * who can for anyone else. Once it was handed over (its order completed)
 * nothing is left to wait for, pick, collect, change or cancel: the banner
 * says how the exchange ended instead (the staff exchange words, which say
 * when part was never sent and when the return was cancelled) and keeps an
 * early release as history. Without a viewer, the info's canOpenReturn
 * decides.
 */
export function replacementBannerLines(
  info: ReplacementBannerInput,
  fulfillmentType: 'pickup' | 'delivery' | null,
  viewer?: ReplacementBannerViewer,
): Array<{ key: ReplacementBannerKey; text: string }> {
  const who = bannerViewer(info, viewer);
  const out: Array<{ key: ReplacementBannerKey; text: string }> = [
    { key: 'title', text: exchangeReplacementBanner(info.returnNumber, info.originalOrderNumber) },
  ];
  const handedOver = info.live && info.handedOver === true;
  const inFlight = info.live && !handedOver;
  if (handedOver && info.exchangeStatusLabel) out.push({ key: 'handed_over', text: info.exchangeStatusLabel });
  if (inFlight && info.waitingForReturn) {
    out.push({ key: 'gate', text: waitingForReturnLine(info.returnNumber, { exchangeStatus: info.exchangeStatus, held: info.held }) });
  }
  if (inFlight && info.returnClosed === true) {
    out.push({ key: 'closed', text: returnCancelledReplacementLine(info.returnNumber) });
  }
  if (info.releasedEarly) {
    out.push({ key: 'released', text: releasedBeforeReturnLine(info.release?.byName ?? null, info.release?.reason ?? null) });
  }
  const driver = replacementDriverLine(info, fulfillmentType, who);
  if (driver) out.push({ key: 'driver', text: driver });
  if (inFlight) {
    const kind = replacementBannerViewerKind(who);
    if (kind === 'returns') out.push({ key: 'rma_link', text: replacementRmaLinkLabel(info) });
    else if (kind === 'requester') out.push({ key: 'change', text: RETURNS_COPY.replacementChangeContactWarehouse });
    else out.push({ key: 'change', text: replacementChangeOthersLine(info.returnNumber) });
  }
  return out;
}

/** The banner's link to the RMA: where it is changed while in flight, for a
 *  viewer who may change and cancel it; else the RMA itself. */
export function replacementRmaLinkLabel(
  info: Pick<ReplacementBannerInput, 'returnNumber' | 'live' | 'handedOver' | 'canChangeReplacement'>,
): string {
  const handedOver = info.live && info.handedOver === true;
  return handedOver || info.canChangeReplacement === false ? openRmaLabel(info.returnNumber) : changeOrCancelInRmaLabel(info.returnNumber);
}

/** The original order's returns section: "Exchange: Large ×1 → SO-000103 (Waiting for returned item)". */
export function originalExchangeLine(replacement: string, replacementOrderNumber: number | null, statusWords: string | null): string {
  const so = formatOrderNumber(replacementOrderNumber);
  const target = so ? ` → ${so}` : '';
  return `Exchange: ${replacement}${target}${statusWords ? ` (${statusWords})` : ''}`;
}

/** The driver's read-only line: "On delivery, the driver collects the returned
 *  item: New Hire Shirt, M ×1 (RMA-…)." (review fix P10; shown only as
 *  replacementDriverLine decides). */
export function collectReturnedItemLine(returned: string, returnNumber: string | null): string {
  return `On delivery, the driver collects the returned item: ${returned}${returnNumber ? ` (${returnNumber})` : ''}.`;
}

/** The slips' line: "Exchange replacement for RMA-… (returned item: New Hire Shirt, M ×1, received)". */
export function slipExchangeLine(returnNumber: string | null, returned: string | null, received: boolean): string {
  const state = received ? 'received' : 'not yet received';
  const item = returned ? `returned item: ${returned}, ${state}` : `returned item ${state}`;
  return `Exchange replacement for ${returnNumber ?? 'its RMA'} (${item})`;
}

const PICKED_REPLACEMENT_STATUSES: readonly string[] = [
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
];

/**
 * One line of the replacement order block (web and phone; review fix P19):
 * "Walk Exchange Tee - L ×1 · reserved 1"; once picked or staged nothing is
 * reserved any more, so "· picked"; with part handed over "Walk Exchange Tee
 * - XL ×2 · handed over 1 · reserved 0"; all of it handed over, the hand-over
 * alone.
 */
export function replacementLineSummary(line: {
  label: string;
  requested: number;
  fulfilled: number;
  held: number;
  /** The replacement order's status. */
  status: string | null;
}): string {
  const parts = [itemQuantityLabel(line.label, line.requested)];
  if (line.fulfilled > 0) parts.push(`handed over ${line.fulfilled}`);
  if (line.requested - line.fulfilled > 0) {
    parts.push(PICKED_REPLACEMENT_STATUSES.includes(line.status ?? '') ? 'picked' : `reserved ${line.held}`);
  }
  return parts.join(' · ');
}

/** An earlier replacement order of the RMA (cancelled by a change or a cancel). */
export interface EarlierReplacement {
  orderId: string;
  orderNumber: number | null;
  /** Its order status code. */
  status: string;
}

/**
 * Earlier replacements in the order status words (review fix P22, web and
 * phone): the canonical label in lower case inside the brackets ("cancelled",
 * "staged (pickup)"), an organization's own label as typed, and nothing for a
 * status this version does not know (never the raw code). `orderLabel` is the
 * SO number (the order id's first characters without one), for a link.
 */
export function earlierReplacementEntries(
  history: readonly EarlierReplacement[],
  opts: { statusLabels?: Partial<Record<string, string>> } = {},
): Array<{ orderId: string; orderLabel: string; statusWords: string | null; text: string }> {
  return history.map((h) => {
    const orderLabel = formatOrderNumber(h.orderNumber) ?? h.orderId.slice(0, 8).toUpperCase();
    const own = opts.statusLabels?.[h.status]?.trim();
    const statusWords = own ? own : isOrderStatusKey(h.status) ? ORDER_STATUS_META[h.status].label.toLowerCase() : null;
    return { orderId: h.orderId, orderLabel, statusWords, text: statusWords ? `${orderLabel} (${statusWords})` : orderLabel };
  });
}

/** "Earlier replacements: SO-000012 (cancelled), SO-000015 (cancelled)", or null for none. */
export function earlierReplacementsLine(
  history: readonly EarlierReplacement[],
  opts: { statusLabels?: Partial<Record<string, string>> } = {},
): string | null {
  if (history.length === 0) return null;
  return `${RETURNS_COPY.earlierReplacements}: ${earlierReplacementEntries(history, opts)
    .map((e) => e.text)
    .join(', ')}`;
}

/**
 * A prepare step refused for a permission (review fix P24): the step in plain
 * words, never the permission key the service error carries ("Missing
 * permission: items:update"). Steps as the web's prepareForHandover names
 * them; a claim is part of picking.
 */
export const PREPARE_FORBIDDEN_WORDS: Readonly<Record<'pick_slip' | 'claim' | 'pick' | 'packing_slips' | 'stage', string>> = {
  pick_slip: "You don't have permission to make its pick slip.",
  claim: "You don't have permission to pick this replacement.",
  pick: "You don't have permission to pick this replacement.",
  packing_slips: "You don't have permission to make its packing slips.",
  stage: "You don't have permission to stage it.",
};

/** A refused prepare step's words (for the web server's step result): a
 *  forbidden refusal in the step's words, anything else in its own words. */
export function prepareStepRefusalWords(step: string, refusal: { code?: string | null; message?: string | null }): string {
  if (refusal.code === 'forbidden') {
    return Object.prototype.hasOwnProperty.call(PREPARE_FORBIDDEN_WORDS, step)
      ? PREPARE_FORBIDDEN_WORDS[step as keyof typeof PREPARE_FORBIDDEN_WORDS]
      : "You don't have permission for this step.";
  }
  return refusal.message?.trim() ? refusal.message : RETURNS_COPY.prepareStopped;
}

/** The prepare chain's pick hint: "Take Large ×1 from 12-B (3 on hand)". */
export function prepareTakeLine(item: string, quantity: number, rack: string | null, onHand: number | null): string {
  const from = rack ? ` from ${rack}` : '';
  const left = onHand !== null && onHand !== undefined ? ` (${onHand} on hand)` : '';
  return `Take ${item} ×${quantity}${from}${left}`;
}

/** The replacement's timeline: "Created as exchange replacement for RMA-… (after a change)"
 *  for a changed or re-issued one; never the internal revision number (fix round 1, verification L6). */
export function createdAsReplacementLabel(returnNumber: string | null, revision: number | null): string {
  const after = revision && revision > 1 ? ' (after a change)' : '';
  return `Created as exchange replacement for ${returnNumber ?? 'its RMA'}${after}`;
}

/** What the screen says after Cancel replacement, from the database's answer
 *  (fix round 1, verification V1): what to do with what was picked or sent,
 *  whatever the screen showed before the call. */
export function replacementCancelledLines(answer: { changed: boolean; drawn?: boolean; inTransit?: boolean }): string[] {
  if (!answer.changed) return [RETURNS_COPY.replacementNothingToCancel];
  return [
    RETURNS_COPY.replacementCancelledDone,
    ...(answer.drawn === true ? [RETURNS_COPY.cancelDrawnReplacement] : []),
    ...(answer.inTransit === true ? [RETURNS_COPY.cancelInTransit] : []),
  ];
}

/**
 * "What happens when you approve" for an exchange line (plan section 6):
 * "A replacement order is created for New Hire Shirt, L ×1 and 1 is reserved."
 * When short, the plain Approve refuses and asks first (review fix P25), so no
 * order is promised: "Walk Exchange Tee - 2XL ×1 is not in stock right now (0
 * available, 1 needed). Approving asks first: put it on backorder or change
 * the replacement." ("is short right now" when some is in stock). The SO
 * number exists only after the approval, so it is not named here.
 */
export function approveReplacementSentence(replacement: string, quantity: number, available: number | null): string {
  if (available !== null && available < quantity) {
    const held = Math.max(0, available);
    const now = held === 0 ? 'is not in stock right now' : 'is short right now';
    return `${replacement} ×${quantity} ${now} (${held} available, ${quantity} needed). Approving asks first: put it on backorder or change the replacement.`;
  }
  return `A replacement order is created for ${replacement} ×${quantity} and ${quantity} ${quantity === 1 ? 'is' : 'are'} reserved.`;
}

/** The approval's answer as its outcome words read it (approve_return; the
 *  replacement is _return_replacement_summary, null for a return only). */
export interface ApprovalOutcomeAnswer {
  /** The RMA's status after the approval ('received' at the counter). */
  status?: string | null;
  replacement?: {
    orderNumber: number | null;
    /** Something owed is not held: it went on backorder. */
    short?: boolean;
    lines?: ReadonlyArray<{ held: number }>;
  } | null;
}

/**
 * What an approval did, in words (review fix P23, web and phone): "Approved.
 * Replacement order SO-000012 created and 1 reserved.", on backorder
 * "Approved. Replacement order SO-000016 is on backorder.", at the counter
 * "Approved and received. Replacement order SO-000017 created and 1
 * reserved."; with no replacement, "Return approved." or "Approved and
 * received."
 */
export function approvalOutcomeLine(answer: ApprovalOutcomeAnswer, opts: { receiveNow?: boolean } = {}): string {
  const counter = opts.receiveNow === true || answer.status === 'received';
  const r = answer.replacement ?? null;
  if (!r) return counter ? 'Approved and received.' : 'Return approved.';
  const lead = counter ? 'Approved and received.' : 'Approved.';
  const so = formatOrderNumber(r.orderNumber);
  const order = so ? `Replacement order ${so}` : 'Replacement order';
  if (r.short) return `${lead} ${order} is on backorder.`;
  const held = (r.lines ?? []).reduce((sum, l) => sum + (Number.isFinite(l.held) ? l.held : 0), 0);
  return `${lead} ${order} created and ${held} reserved.`;
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

/**
 * The 14-day prompt (plan 3.10, D28; RX-2 review fix P17, built in RX-3):
 * "Waiting 15 days. Still waiting for the returned item? Cancel replacement
 * frees the reserved items; Cancel return ends the return too." When the
 * replacement holds nothing (not in stock), nothing is said to be freed.
 * Nothing expires on its own.
 */
export function stillWaitingLine(days: number, opts: { held?: number | null; cancelReturn?: boolean } = {}): string {
  const age = RETURNS_COPY.waitingDays(days);
  const lead = `${age.charAt(0).toUpperCase()}${age.slice(1)}`;
  // Name Cancel return only when the viewer is offered it (RX-3 fix round 1, L5).
  const withCancelReturn = opts.cancelReturn !== false;
  const tail =
    opts.held === 0
      ? withCancelReturn
        ? RETURNS_COPY.stillWaitingNothingHeld
        : RETURNS_COPY.stillWaitingNothingHeldNoCancelReturn
      : withCancelReturn
        ? RETURNS_COPY.stillWaiting
        : RETURNS_COPY.stillWaitingNoCancelReturn;
  return `${lead}. ${tail}`;
}
