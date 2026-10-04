import {
  ORDER_REPLAY_COPY,
  ORDER_STATUS_META,
  deliveryRequestInputFromSubmission,
  deliveryRequestRecipients,
  isOrderStatusKey,
  orderAlreadyPlacedCopy,
  successRefLine,
  successSentForApprovalCopy,
  type DeliveryRequestInput,
  type OrderCatalogSite,
  type OrderStorefrontDeliveryRecipients,
  type OrderStorefrontViewer,
  type StorefrontItem,
} from '@stockpilot/core';

import type { PlacedContext } from './session';

/**
 * THE SUCCESS SCREEN (phone ordering PO-4): what it says and which email draft
 * it can open. Pure.
 *
 * The pickup or delivery request email is offered to EVERY placer when the
 * organization's routing resolves (the web success overlay does the same,
 * storefront-overlays.tsx), managers ordering on behalf included: it is built
 * from the submission (core deliveryRequestInputFromSubmission: the real
 * method, the stored needed-by INSTANT), never gated by the order screen's
 * canRequestDelivery (requester-only, a policy the owner keeps for that
 * screen). It opens a draft on this phone; nothing is sent.
 */

/** "SO-000123 · DC4 · 12 units". */
export function successReference(placed: PlacedContext, warehouseName: string): string {
  return successRefLine(placed.order.orderNumber, placed.order.id, warehouseName, placed.order.unitCount);
}

/** The order's status in core's words (customization defaults). */
export function orderStatusLabel(status: string): string {
  return isOrderStatusKey(status) ? ORDER_STATUS_META[status].label : status.replace(/_/g, ' ');
}

/** The lines under the title: the replay or "already placed" sentence first
 *  when it applies, then who hears about it. */
export function successSentences(placed: PlacedContext): string[] {
  const out: string[] = [];
  if (placed.viaWithdraw) out.push(orderAlreadyPlacedCopy(placed.order));
  else if (placed.replay) out.push(ORDER_REPLAY_COPY);
  out.push(successSentForApprovalCopy(placed.order.requestedFor));
  return out;
}

/** "Review and approve" for someone who holds the effective orders:approve
 *  (the server's answer, never a viewer), else "View order". */
export function successOrderHref(orderId: string, canApproveOrders: boolean): string {
  return canApproveOrders ? `/order/${orderId}?focus=approve` : `/order/${orderId}`;
}

/**
 * The email draft's input, or null when there is nothing to build it from:
 * no routing (the action is hidden), routing core's factory refuses (fail
 * closed: never mail an address nothing validated), or a body an earlier
 * build wrote that this one cannot read.
 */
export function successEmailInput(input: {
  placed: PlacedContext;
  recipients: OrderStorefrontDeliveryRecipients | null;
  warehouseName: string;
  sites: readonly OrderCatalogSite[];
  viewer: Pick<OrderStorefrontViewer, 'name' | 'email'>;
  orgTimezone: string | null;
  itemMap: ReadonlyMap<string, StorefrontItem>;
}): DeliveryRequestInput | null {
  const { placed } = input;
  if (!input.recipients || !placed.body) return null;
  let recipients;
  try {
    recipients = deliveryRequestRecipients({
      to: input.recipients.to,
      cc: input.recipients.cc,
      ...(input.recipients.toName ? { toName: input.recipients.toName } : {}),
      ...(input.recipients.ccName ? { ccName: input.recipients.ccName } : {}),
    });
  } catch {
    return null;
  }
  const site = input.sites.find((s) => s.id === placed.body!.deliveryCharterId) ?? null;
  const items = new Map<string, { name: string; sku: string }>();
  for (const l of placed.body.lines) {
    const it = input.itemMap.get(l.itemId);
    if (it) items.set(l.itemId, { name: it.name, sku: it.sku });
  }
  const email = input.viewer.email ?? null;
  return deliveryRequestInputFromSubmission(
    placed.order,
    {
      warehouseName: input.warehouseName,
      destination: site ? { id: site.id, name: site.name, code: site.code, address: site.address } : null,
      viewerLabel: input.viewer.name?.trim() || email || '',
      viewerEmail: email,
      orgTimezone: input.orgTimezone,
      notes: placed.body.notes ?? null,
      lines: placed.body.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      itemMap: items,
    },
    recipients,
  );
}
