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
  type OrderStorefrontWarehouse,
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

/**
 * What the success screen shows beside the order (PO-4 review): the
 * warehouse's name, whether this person approves orders (Review and approve),
 * the email's routing, who is placing it, the organization's zone, the
 * delivery sites and the names of the lines sent. Taken from the storefront
 * answer and the catalog AS THEY WERE WHEN THE ORDER WAS PLACED (session.ts
 * keeps it on PlacedContext), so a read on return from the mail app that comes
 * back turned off or refused never takes the email, Review and approve or the
 * warehouse's name away from a screen about an order already placed.
 */
export interface SuccessContext {
  warehouseName: string;
  canApproveOrders: boolean;
  recipients: OrderStorefrontDeliveryRecipients | null;
  viewer: Pick<OrderStorefrontViewer, 'name' | 'email'>;
  orgTimezone: string | null;
  sites: readonly OrderCatalogSite[];
  /** The name and SKU of each line sent, as the catalog named it. */
  items: ReadonlyMap<string, { name: string; sku: string }>;
}

export function successContextFrom(input: {
  answer: {
    warehouses: readonly OrderStorefrontWarehouse[];
    viewer: Pick<OrderStorefrontViewer, 'name' | 'email' | 'canApproveOrders'>;
    deliveryRecipients: OrderStorefrontDeliveryRecipients | null;
    orgTimezone: string | null;
  };
  warehouseId: string;
  sites: readonly OrderCatalogSite[];
  itemMap: ReadonlyMap<string, StorefrontItem>;
  lines: readonly { itemId: string }[];
}): SuccessContext {
  const items = new Map<string, { name: string; sku: string }>();
  for (const l of input.lines) {
    const it = input.itemMap.get(l.itemId);
    if (it) items.set(l.itemId, { name: it.name, sku: it.sku });
  }
  return {
    warehouseName: input.answer.warehouses.find((w) => w.id === input.warehouseId)?.name ?? '',
    canApproveOrders: input.answer.viewer.canApproveOrders,
    recipients: input.answer.deliveryRecipients,
    viewer: { name: input.answer.viewer.name, email: input.answer.viewer.email },
    orgTimezone: input.answer.orgTimezone,
    sites: input.sites,
    items,
  };
}

/** The context the success screen draws from: the one taken when the order
 *  was placed; only when none could be taken (placed while the storefront
 *  was turned off or refused: a settle with no answer), the answer shown now. */
export function successContextFor(placed: Pick<PlacedContext, 'context'>, live: SuccessContext | null): SuccessContext | null {
  return placed.context ?? live;
}

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

/**
 * A placed order on a storefront home or browse view that comes into focus
 * (desk check F10): one the success screen has not shown yet (a status read
 * on its own, or "Don't send it" finding it placed) opens the success
 * screen; one it has shown is done with (the person left by View order and
 * on), so it is cleared and never shown again.
 */
export function placedOnStorefrontFocus(placed: Pick<PlacedContext, 'shown'> | null): 'show' | 'finish' | null {
  if (!placed) return null;
  return placed.shown ? 'finish' : 'show';
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
export function successEmailInput(input: { placed: PlacedContext; context: SuccessContext }): DeliveryRequestInput | null {
  const { placed, context } = input;
  if (!context.recipients || !placed.body) return null;
  let recipients;
  try {
    recipients = deliveryRequestRecipients({
      to: context.recipients.to,
      cc: context.recipients.cc,
      ...(context.recipients.toName ? { toName: context.recipients.toName } : {}),
      ...(context.recipients.ccName ? { ccName: context.recipients.ccName } : {}),
    });
  } catch {
    return null;
  }
  const site = context.sites.find((s) => s.id === placed.body!.deliveryCharterId) ?? null;
  const email = context.viewer.email ?? null;
  return deliveryRequestInputFromSubmission(
    placed.order,
    {
      warehouseName: context.warehouseName,
      destination: site ? { id: site.id, name: site.name, code: site.code, address: site.address } : null,
      viewerLabel: context.viewer.name?.trim() || email || '',
      viewerEmail: email,
      orgTimezone: context.orgTimezone,
      notes: placed.body.notes ?? null,
      lines: placed.body.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      itemMap: context.items,
    },
    recipients,
  );
}
