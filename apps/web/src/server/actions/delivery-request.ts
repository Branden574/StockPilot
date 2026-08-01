'use server';

import { z } from 'zod';

import { audit } from '@/server/services/audit';

const schema = z.object({
  orderId: z.string().uuid(),
  isCondensed: z.boolean(),
});

/**
 * Record that a delivery-request draft was opened for an order.
 *
 * This writes ONE audit row and nothing else. It does not create an order, does
 * not mutate the order, does not send mail, and does not talk to Zendesk.
 *
 * The metadata is an explicit ALLOW-LIST. The compose URL, the message body,
 * the destination address, the order notes and the requester phone are all
 * deliberately excluded: an audit row is read by more people than the email is,
 * and none of that detail is needed to answer the only question this row
 * exists to answer — "did somebody draft a request for this order, and when".
 * The recipient ADDRESSES are excluded too; `recipient_type` and
 * `included_cc_recipient` record the fact without copying the addresses into a
 * second store.
 *
 * The actor and the organisation come from the audit service's own context, not
 * from the caller, so a client cannot attribute a draft to somebody else.
 *
 * Best-effort and never throws: it is called AFTER window.open, and a logging
 * failure must never surface as a broken action to an employee who has already
 * got their draft.
 */
export async function recordDeliveryRequestDraftedAction(input: {
  orderId: string;
  isCondensed: boolean;
}): Promise<void> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return;

  try {
    await audit({
      event: 'order.delivery_request_drafted',
      entityType: 'order_request',
      entityId: parsed.data.orderId,
      extra: {
        recipient_type: 'dc4-delivery-request',
        included_cc_recipient: true,
        is_condensed: parsed.data.isCondensed,
      },
    });
  } catch {
    // audit() is already best-effort; this is belt and braces so the client
    // promise never rejects.
  }
}
