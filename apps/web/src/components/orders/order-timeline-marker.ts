/**
 * The marker Liquid Glass draws for each order timeline event
 * (Order-Detail.dc.html's .tl-dot: a 26 px circle in the event's tone with a
 * 14 px icon). The board draws five kinds of event, and those keep its tone
 * and icon: "Order submitted" a send icon on the neutral fill, "Approved" a
 * circled check on the accent, "Denied" a circled cross in the warning tone,
 * "Pick slip generated" a clipboard list on the accent, "Delivery request
 * drafted" a mail icon in the info tone. Every other event is an inferred
 * extension in the same tones: done steps in the ok tone, a step that holds
 * or reverses the order in the warning tone, an order on its way in the info
 * tone, and bookkeeping on the neutral fill.
 *
 * The result rides on the timeline entry as two inert hook attributes
 * (data-glass-tone, data-glass-icon), read only by
 * styles/liquid-glass/pages/order-detail.css under the glass root; the
 * Classic marker (the neutral dot) is unchanged, and the classic proof drops
 * the attributes. An event not listed here gets no hooks, so glass keeps the
 * neutral dot for it.
 */

export type OrderTimelineTone = 'neutral' | 'acc' | 'ok' | 'warn' | 'info';

/** The icons order-detail.css draws (Lucide, at the glass 1.8 stroke). */
export const ORDER_TIMELINE_ICONS = [
  'send',
  'circle-check',
  'circle-x',
  'clipboard-list',
  'mail',
  'check',
  'users',
  'user',
  'truck',
  'package',
  'pen-line',
  'link',
  'lock',
  'rotate-ccw',
  'key',
  'calendar-clock',
  'file-plus',
  'printer',
] as const;
export type OrderTimelineIcon = (typeof ORDER_TIMELINE_ICONS)[number];

export interface OrderTimelineMarker {
  tone: OrderTimelineTone;
  icon: OrderTimelineIcon;
}

const MARKERS: Readonly<Record<string, OrderTimelineMarker>> = {
  // Drawn on the board.
  'order_request.created': { tone: 'neutral', icon: 'send' },
  'order_request.approved': { tone: 'acc', icon: 'circle-check' },
  'order_request.denied': { tone: 'warn', icon: 'circle-x' },
  'order.pick_slip_generated': { tone: 'acc', icon: 'clipboard-list' },
  'order.delivery_request_drafted': { tone: 'info', icon: 'mail' },
  // F14: the same kind of entry, for a return on the order.
  'order.return_request_drafted': { tone: 'info', icon: 'mail' },
  // Inferred, in the board's tones.
  'order_request.cancelled': { tone: 'warn', icon: 'circle-x' },
  'order_request.delivered': { tone: 'ok', icon: 'circle-check' },
  'order_request.public_link_rotated': { tone: 'neutral', icon: 'link' },
  'order_request.needed_by_revised': { tone: 'warn', icon: 'calendar-clock' },
  'order_request.shortfall_po_drafted': { tone: 'info', icon: 'file-plus' },
  'order_request.released_early': { tone: 'warn', icon: 'key' },
  'order_request.return_received': { tone: 'ok', icon: 'rotate-ccw' },
  'order.picking_claimed': { tone: 'neutral', icon: 'user' },
  'order.picker_assigned': { tone: 'neutral', icon: 'users' },
  'order.picking_released': { tone: 'neutral', icon: 'user' },
  'order.picking_complete': { tone: 'ok', icon: 'check' },
  'order.packing_slip_generated': { tone: 'neutral', icon: 'printer' },
  'order.staged_for_pickup': { tone: 'info', icon: 'package' },
  'order.staged_for_delivery': { tone: 'info', icon: 'truck' },
  'order.delivery_assigned': { tone: 'neutral', icon: 'users' },
  'order.in_transit': { tone: 'info', icon: 'truck' },
  'order.signature_collected': { tone: 'ok', icon: 'pen-line' },
  'order.completed': { tone: 'ok', icon: 'circle-check' },
  'order.stock_held': { tone: 'neutral', icon: 'lock' },
  'order.closed_partial': { tone: 'warn', icon: 'check' },
};

/** B22: a paper hand-over is the only status_changed written today. */
const PAPER_HAND_OVER: OrderTimelineMarker = { tone: 'ok', icon: 'pen-line' };

/** The glass marker of one event, or null to keep the neutral dot. */
export function orderTimelineMarker(
  event: string,
  metadata: Record<string, unknown> | null,
): OrderTimelineMarker | null {
  if (event === 'order_request.status_changed') {
    return metadata?.signatureMethod === 'physical' ? PAPER_HAND_OVER : null;
  }
  return MARKERS[event] ?? null;
}

/** The marker as the entry's inert hook attributes (none for the neutral dot). */
export function orderTimelineMarkerHooks(
  event: string,
  metadata: Record<string, unknown> | null,
): { 'data-glass-tone'?: OrderTimelineTone; 'data-glass-icon'?: OrderTimelineIcon } {
  const marker = orderTimelineMarker(event, metadata);
  return marker ? { 'data-glass-tone': marker.tone, 'data-glass-icon': marker.icon } : {};
}
