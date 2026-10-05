/**
 * Why an order's slips (pick slip, warehouse and customer packing slips) cannot
 * be printed when it is closed or backordered (L132, owner decision Q17:
 * wording only, nothing changes who may print). The slip routes used to answer
 * "Generate ... first" for these, which the person could never do. A status
 * before the slip is generated keeps that answer, and every other status is
 * null (the route carries on as before).
 */
export interface ClosedOrderSlipAnswer {
  error: 'order_closed' | 'order_backordered';
  message: string;
}

export function closedOrderSlipAnswer(status: string): ClosedOrderSlipAnswer | null {
  if (status === 'cancelled' || status === 'denied') {
    return {
      error: 'order_closed',
      message: `This order is ${status}, so its slips are no longer available.`,
    };
  }
  if (status === 'backordered') {
    return {
      error: 'order_backordered',
      message: 'This order is on backorder; its slips print again when it is resumed.',
    };
  }
  return null;
}
