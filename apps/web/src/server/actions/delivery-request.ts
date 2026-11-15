'use server';

import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { audit } from '@/server/services/audit';
import { withContext } from '@/server/services/context';

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
 * The actor and the organisation come from the caller's context, never from the
 * input, so a client cannot attribute a draft to somebody else.
 *
 * Under a policy that requires an authenticator, a session that has not
 * satisfied it records nothing, as recordReturnRequestDrafted does for a
 * return request draft.
 *
 * Before writing anything, this confirms `orderId` actually names a row the
 * CALLER can see: the context's cookie-bound, user-authed client reads
 * `order_requests` by id. RLS (migration 0044) already scopes that SELECT to
 * the caller's own organization, so one round trip answers both "does it
 * exist" and "can this caller see it." A well-formed but unknown or
 * not-visible id is a silent no-op, same as a failed zod parse — it is not an
 * error, just nothing worth auditing.
 *
 * Best-effort: it is called AFTER window.open, and a logging failure — the
 * existence check included — must never surface as a broken action to an
 * employee who has already got their draft. It never rejects, except for a
 * redirect (the session ended), which the router is already following, as
 * recordReturnRequestDraftedAction does.
 */
export async function recordDeliveryRequestDraftedAction(input: {
  orderId: string;
  isCondensed: boolean;
}): Promise<void> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return;

  try {
    const ctx = await withContext();
    if (ctx.mfaRequired && !ctx.mfaSatisfied) return;
    const { data: order } = await ctx.supabase
      .from('order_requests')
      .select('id')
      .eq('id', parsed.data.orderId)
      .maybeSingle();
    if (!order) return;

    await audit(
      {
        event: 'order.delivery_request_drafted',
        entityType: 'order_request',
        entityId: parsed.data.orderId,
        extra: {
          recipient_type: 'dc4-delivery-request',
          included_cc_recipient: true,
          is_condensed: parsed.data.isCondensed,
        },
      },
      ctx,
    );
  } catch (e) {
    rethrowControlFlow(e);
    // audit() is already best-effort; this is belt and braces so the client
    // promise never rejects. Also covers the existence check above: a flaky
    // read must not surface as a broken action either.
  }
}
