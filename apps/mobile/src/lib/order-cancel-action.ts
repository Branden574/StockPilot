import { orderCancelOffer } from '@stockpilot/core';

/**
 * Cancel on the phone's order screen (L93). WHO is offered it is core's
 * orderCancelOffer, the web order page's rule and the service's: someone who
 * approves orders at every open status, the person who placed it only while
 * it waits for approval. The confirm carries the web's optional reason
 * (Alert.prompt's text field), sent to /api/v1/orders/[id]/transition.
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
}): PhoneOrderCancel | null {
  if (!input.status) return null;
  const offer = orderCancelOffer({
    status: input.status,
    canApprove: input.canApproveOrders,
    isOwnRequest: input.isOwnRequest,
  });
  if (offer === null) return null;
  if (offer === 'requester') {
    // The web's CancelOrderButton words.
    return {
      label: 'Cancel request',
      confirmTitle: 'Cancel this order request?',
      confirmMessage: `The request is marked cancelled and any stock reservations attached to it are released back to available stock. The request stays on the record for the audit trail. ${REASON_PROMPT}`,
      confirmLabel: 'Cancel request',
      keepLabel: 'Keep request',
    };
  }
  return {
    label: 'Cancel order',
    confirmTitle: 'Cancel this order?',
    confirmMessage:
      input.status === 'backordered'
        ? `The order is voided. Already-delivered items are NOT restocked; the hold on the remaining items is released. ${REASON_PROMPT}`
        : `The order is marked cancelled and the stock held for it is released. Anything already picked goes back into stock. The order stays on the record. ${REASON_PROMPT}`,
    confirmLabel: 'Cancel order',
    keepLabel: 'Keep order',
  };
}

const REASON_MAX = 500;

/** The reason as the transition route takes it: trimmed, at most 500
 *  characters, left out when nothing was typed. */
export function cancelReasonForPost(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').trim();
  return trimmed.length > 0 ? trimmed.slice(0, REASON_MAX) : undefined;
}
