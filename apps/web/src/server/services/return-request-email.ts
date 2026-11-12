import 'server-only';

import {
  brandDeliveryRecipients,
  formatOrderNumber,
  type DeliveryRequestAddress,
  type OrgEmailRoutingReadState,
  type OrgEmailRoutingRecipientsDto,
  type ReturnRequestOrderFacts,
  type ReturnRequestSite,
} from '@stockpilot/core';

import { getOrgEmailRouting } from '@/lib/dashboard/cached-org';
import { createAdminClient } from '@/lib/supabase/admin';
import { returnRequestOrderLink, returnRequestReturnLink } from '@/lib/returns/return-request-link';

import { isModuleEnabled, ServiceError, type ServiceContext } from './context';
import { OrderRequestsService } from './order-requests';
import { resolveMemberOrder } from './returns';

/**
 * What the phone needs to offer "Email return request" (F14), resolved on the
 * server so the phone decides nothing about mailboxes or links:
 *
 *  - the organization's delivery-request mailboxes as a plain pair, or null
 *    when they are not set, the saved value is invalid or the read failed
 *    (the section is then not shown: the delivery request's fail-closed
 *    rule; never another organization's mailbox);
 *  - the link the draft carries back into StockPilot.
 *
 * The website's two pages do the same from their own page reads
 * (orders/[id]/page.tsx and returns/[id]/page.tsx); returnRequestRecipientsDto
 * is shared with the return page.
 */

/**
 * The resolved pair as plain strings, or null: the button's whole gate.
 *
 * Only a pair the organization SAVED and that passes the validating factory.
 * Unlike the delivery request (core deliveryRecipientsForRouting), the
 * 'fallback' state gives nothing: that state exists for a database that
 * predates the routing column, where the delivery request falls back to
 * compiled sample addresses it shipped with. The return request is newer
 * than the column and has no compiled pair to fall back to, so it never
 * addresses a draft to a mailbox the organization did not save.
 */
export function returnRequestRecipientsDto(
  routing: OrgEmailRoutingReadState,
): OrgEmailRoutingRecipientsDto | null {
  if (routing.state !== 'valid') return null;
  let r;
  try {
    r = brandDeliveryRecipients(routing.recipients);
  } catch {
    return null;
  }
  const dto: OrgEmailRoutingRecipientsDto = { to: r.to, cc: r.cc };
  if (r.toName) dto.toName = r.toName;
  if (r.ccName) dto.ccName = r.ccName;
  return dto;
}

/** A failed mailbox read is "not set": the section hides, the screen opens. */
async function readRecipients(organizationId: string): Promise<OrgEmailRoutingRecipientsDto | null> {
  try {
    return returnRequestRecipientsDto(await getOrgEmailRouting(organizationId, 'delivery_request'));
  } catch {
    return null;
  }
}

export interface ReturnRequestEmailForReturn {
  recipients: OrgEmailRoutingRecipientsDto | null;
  link: string;
}

/**
 * The return screen (GET /api/v1/returns/[id]). The caller already passed the
 * returns gate (module on, returns:read or returns:manage) and read the
 * return inside their own organization; this adds the mailboxes of that same
 * organization (the context's, never an id from the request).
 */
export async function loadReturnRequestEmailForReturn(
  ctx: Pick<ServiceContext, 'organizationId'>,
  returnId: string,
): Promise<ReturnRequestEmailForReturn> {
  return { recipients: await readRecipients(ctx.organizationId), link: returnRequestReturnLink(returnId) };
}

export interface ReturnRequestEmailForOrder {
  recipients: OrgEmailRoutingRecipientsDto | null;
  order: ReturnRequestOrderFacts;
}

/** Name, code and address only: the draft prints no id, so none is sent. */
function siteFromCharterRow(row: unknown): ReturnRequestSite | null {
  const c = row as { id?: unknown; name?: unknown; code?: unknown; address?: unknown } | null;
  if (!c || typeof c.id !== 'string') return null;
  const raw = c.address;
  // jsonb: anything that is not a plain object is "no address" (the order
  // page's own mapping of this row).
  const address =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as DeliveryRequestAddress) : null;
  return {
    name: typeof c.name === 'string' ? c.name : '',
    code: typeof c.code === 'string' ? c.code : null,
    address,
  };
}

/**
 * The requester's own order (GET /api/v1/orders/[id]/return-request-email).
 * Null, which the route answers as its one 404, on every closed door.
 *
 * THE DOOR is the member return request's own (returns.ts resolveMemberOrder,
 * the one GET .../return-request opens with): the order of the caller's
 * organization whose requester is the caller, never a B2B portal order, in a
 * status that can come back, with the returns module on. So this route opens
 * for exactly the orders the sheet beside it opens for, and for nobody else.
 *
 * WHAT IT ANSWERS is an allow-list (pinned by test): the mailboxes, and six
 * facts about the caller's own order. Each is a fact this member already
 * reads about this order with their own session: their own name and email,
 * the order number, the warehouse name (the order page's header) and the
 * delivery site they chose when they placed it (the delivery request draft
 * for this same order printed it for them, orders/[id]/page.tsx
 * `destination`). The requester SHEET keeps emails, warehouses and sites out
 * (core forbiddenRequesterKeys) because the public return link and the
 * portal serve it to people with no member session; this route is never
 * served there. No id beyond the order's own, no notes, no costs, no staff
 * names.
 *
 * The facts come from the service read the website's order page uses, so
 * both apps say the same thing: the requester's name (the resolved name,
 * else the display name) and email, the warehouse name, the order number.
 *
 * A read, like the sheet's GET: it asks no two-step sign-in (the record of
 * an opened draft does, services/return-request-draft.ts).
 */
export async function loadReturnRequestEmailForOrder(
  ctx: ServiceContext,
  orderId: string,
): Promise<ReturnRequestEmailForOrder | null> {
  if (!isModuleEnabled(ctx, 'returns')) return null;
  const door = await resolveMemberOrder(createAdminClient(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    orderRequestId: orderId,
  });
  if (!door) return null;
  let detail;
  try {
    detail = await new OrderRequestsService(ctx).get(orderId);
  } catch (e) {
    if (e instanceof ServiceError && e.code !== 'internal_error') return null;
    throw e;
  }
  const request = detail.request as {
    requester_user_id?: string | null;
    order_number?: number | null;
    delivery_charter_id?: string | null;
  };
  if (!request.requester_user_id || request.requester_user_id !== ctx.userId) return null;

  const [recipients, site] = await Promise.all([
    readRecipients(ctx.organizationId),
    request.delivery_charter_id
      ? Promise.resolve(
          ctx.supabase
            .from('charters')
            .select('id, name, code, address')
            .eq('organization_id', ctx.organizationId)
            .eq('id', request.delivery_charter_id)
            .maybeSingle(),
        ).then(
          (res) => siteFromCharterRow((res as { data?: unknown }).data ?? null),
          () => null,
        )
      : Promise.resolve(null),
  ]);

  return {
    recipients,
    order: {
      orderNumber: formatOrderNumber(request.order_number ?? null),
      requestedBy: detail.requesterName ?? detail.requesterDisplay ?? null,
      requesterEmail: detail.requesterEmail ?? null,
      site,
      warehouseName: detail.warehouseName ?? null,
      link: returnRequestOrderLink(orderId),
    },
  };
}
