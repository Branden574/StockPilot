import 'server-only';

import {
  deliveryRecipientsForRouting,
  formatOrderNumber,
  type DeliveryRequestAddress,
  type DeliveryRequestSite,
  type OrgEmailRoutingReadState,
  type OrgEmailRoutingRecipientsDto,
  type ReturnRequestOrderFacts,
} from '@stockpilot/core';

import { getOrgEmailRouting } from '@/lib/dashboard/cached-org';
import { returnRequestOrderLink, returnRequestReturnLink } from '@/lib/returns/return-request-link';

import { isModuleEnabled, ServiceError, type ServiceContext } from './context';
import { OrderRequestsService } from './order-requests';

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

/** The resolved pair as plain strings, or null: the button's whole gate. */
export function returnRequestRecipientsDto(
  routing: OrgEmailRoutingReadState,
): OrgEmailRoutingRecipientsDto | null {
  const r = deliveryRecipientsForRouting(routing);
  if (!r) return null;
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

function siteFromCharterRow(row: unknown): DeliveryRequestSite | null {
  const c = row as { id?: unknown; name?: unknown; code?: unknown; address?: unknown } | null;
  if (!c || typeof c.id !== 'string') return null;
  const raw = c.address;
  // jsonb: anything that is not a plain object is "no address" (the order
  // page's own mapping of this row).
  const address =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as DeliveryRequestAddress) : null;
  return {
    id: c.id,
    name: typeof c.name === 'string' ? c.name : '',
    code: typeof c.code === 'string' ? c.code : null,
    address,
  };
}

/**
 * The requester's own order (GET /api/v1/orders/[id]/return-request-email).
 * Null, which the route answers as its one 404, unless: the returns module is
 * on, the order is in the caller's organization (OrderRequestsService.get
 * filters on it), and the caller is the order's own requester.
 *
 * The facts are the ones the website's order page passes for the same
 * viewer, from the same service read: the order number, the requester's name
 * (the resolved name, else the display name) and email, the warehouse name,
 * and the delivery site when the order has one.
 */
export async function loadReturnRequestEmailForOrder(
  ctx: ServiceContext,
  orderId: string,
): Promise<ReturnRequestEmailForOrder | null> {
  if (!isModuleEnabled(ctx, 'returns')) return null;
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
