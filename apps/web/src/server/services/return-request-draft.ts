import 'server-only';

import { z } from 'zod';

import { can, canSendReturnRequest, isReturnNumberShape } from '@stockpilot/core';

import { rethrowControlFlow } from '@/lib/control-flow';
import { checkRateLimit } from '@/lib/rate-limit';

import { audit } from './audit';
import { isModuleEnabled, type ServiceContext } from './context';

const ONE_HOUR_MS = 60 * 60 * 1000;
/** One member opens a handful of drafts; 60 an hour is far above any real use. */
export const RETURN_REQUEST_DRAFTED_PER_HOUR = 60;

const schema = z.object({
  // Lower case, as the member requester gate hands its routes the id
  // (orders/[id]/return-request/http.ts): a uuid column matches either case,
  // but the audit row's entity id is jsonb text stored as given, and the
  // order's timeline finds its rows by a text match on it
  // (metadata->>entity_id, components/orders/order-timeline.tsx), so a row
  // keyed in upper case would never show beside the others.
  orderId: z
    .string()
    .uuid()
    .transform((id) => id.toLowerCase()),
  returnNumber: z.string().refine(isReturnNumberShape),
  isCondensed: z.boolean(),
  surface: z.enum(['order', 'return']),
});

/**
 * Record that a return request DRAFT was opened (F14). One audit row, keyed to
 * the order so it shows in the order's timeline beside "Delivery request
 * drafted", and nothing else: no column, no mail, no ticket. StockPilot cannot
 * see whether the person pressed Send, so the row says "drafted" and never
 * more (the rule of order.delivery_request_drafted).
 *
 * One function for the website's action and the phone's route. It decides
 * everything on the server, from the caller's own context:
 *
 *  - the returns module is on for the caller's organization;
 *  - the caller does not owe a two-step sign-in (the MFA floor every other
 *    member write has: assertPermission, and the member return request's
 *    POST): a session that owes it records nothing, by either branch below;
 *  - no more than 60 an hour by one member (fail-closed), counted here so
 *    the website's action and the phone's route share one limit and neither
 *    can fill the audit log;
 *  - the order is in the caller's organization (an explicit organization
 *    filter on top of row level security, so another organization's id finds
 *    no row);
 *  - the caller is the order's own requester, or holds returns:read or
 *    returns:manage;
 *  - a return with that number is on that order, in that organization, and
 *    is still open (core canSendReturnRequest); and a requester without a
 *    returns permission records only a return they asked for themselves (the
 *    only returns their order page offers the draft for).
 *
 * The stored metadata is an allow-list: the return number, whether the draft
 * was shortened, and which screen opened it. No address, no message text and
 * no link (the reasons are in actions/delivery-request.ts). The actor and the
 * organization come from the context, never from the input.
 *
 * Anything that fails a check is a silent no-op, and it never throws: it runs
 * after the person already has their draft, so bookkeeping must not surface
 * as an error.
 */
export async function recordReturnRequestDrafted(
  ctx: ServiceContext,
  input: unknown,
): Promise<{ recorded: boolean }> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { recorded: false };
  const { orderId, returnNumber, isCondensed, surface } = parsed.data;

  try {
    if (!isModuleEnabled(ctx, 'returns')) return { recorded: false };
    if (ctx.mfaRequired && !ctx.mfaSatisfied) return { recorded: false };
    const rl = await checkRateLimit(
      `return-request-drafted:${ctx.userId}`,
      RETURN_REQUEST_DRAFTED_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    );
    if (!rl.allowed) return { recorded: false };

    const { data: order } = await ctx.supabase
      .from('order_requests')
      .select('id, requester_user_id')
      .eq('id', orderId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();
    const orderRow = order as { id: string; requester_user_id: string | null } | null;
    if (!orderRow) return { recorded: false };

    const readsReturns = can(ctx, 'returns:read') || can(ctx, 'returns:manage');
    const isRequester = orderRow.requester_user_id !== null && orderRow.requester_user_id === ctx.userId;
    if (!readsReturns && !isRequester) return { recorded: false };

    const { data: ret } = await ctx.supabase
      .from('returns')
      .select('id, status, source, return_number')
      .eq('organization_id', ctx.organizationId)
      .eq('order_request_id', orderId)
      .eq('return_number', returnNumber)
      .maybeSingle();
    const returnRow = ret as { id: string; status: string; source: string | null; return_number: string | null } | null;
    if (!returnRow) return { recorded: false };
    if (!canSendReturnRequest(returnRow.status, returnRow.return_number)) return { recorded: false };
    if (!readsReturns && returnRow.source !== 'requester') return { recorded: false };

    await audit(
      {
        event: 'order.return_request_drafted',
        entityType: 'order_request',
        entityId: orderId,
        extra: { return_number: returnNumber, is_condensed: isCondensed, surface },
      },
      ctx,
    );
    return { recorded: true };
  } catch (e) {
    rethrowControlFlow(e);
    return { recorded: false };
  }
}
