import { orderCancelOffer, orderCancelWords } from '@stockpilot/core';

/**
 * Cancel on the phone's order screen (L93). WHO is offered it is core's
 * orderCancelOffer, the web order page's rule and the service's: someone who
 * approves orders at every open status, the person who placed it only while
 * it waits for approval, and nobody without orders:request, which the service
 * asserts for every cancel (desk check F3). The confirm carries the web's optional reason
 * (Alert.prompt's text field), sent to /api/v1/orders/[id]/transition.
 * Its words are core orderCancelWords, the web's (B51).
 *
 * Pure, so vitest pins it; the screen reads the result.
 */
export interface PhoneOrderCancel {
  label: string;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
  keepLabel: string;
}

const REASON_PROMPT = 'Reason (optional):';

export function phoneOrderCancel(input: {
  status: string | null | undefined;
  /** The effective orders:approve. */
  canApproveOrders: boolean;
  /** The viewer placed this order. */
  isOwnRequest: boolean;
  /** The effective orders:request. */
  canRequestOrders: boolean;
  /** Any line was delivered (quantity_fulfilled above zero): an approver's
   *  confirm then says delivered items are not put back in stock. */
  anythingDelivered: boolean;
}): PhoneOrderCancel | null {
  if (!input.status) return null;
  const offer = orderCancelOffer({
    status: input.status,
    canApprove: input.canApproveOrders,
    isOwnRequest: input.isOwnRequest,
    canRequest: input.canRequestOrders,
  });
  if (offer === null) return null;
  // B51: the words are the web's CancelOrderButton's, from one place. The
  // delivered sentence follows what was delivered, not the status (it was
  // said only while backordered, so a resumed backorder lost it).
  const words = orderCancelWords(offer, {
    status: input.status,
    anythingDelivered: input.anythingDelivered,
  });
  return {
    label: words.label,
    confirmTitle: words.title,
    confirmMessage: `${words.body} ${REASON_PROMPT}`,
    confirmLabel: words.confirmLabel,
    keepLabel: words.keepLabel,
  };
}

const REASON_MAX = 500;

/** The reason as the transition route takes it: trimmed, at most 500
 *  characters, left out when nothing was typed. */
export function cancelReasonForPost(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, REASON_MAX) : undefined;
}
