/**
 * The link a return request draft carries back into StockPilot (F14). The
 * APP_URL convention of the maintenance request email
 * (server/services/maintenance-requests.ts): the public address from the
 * build's configuration, never window.location (the draft is built on the
 * server for the phone too), with the production address as the fallback.
 */
const APP_URL = ((process.env.NEXT_PUBLIC_APP_URL ?? '').trim() || 'https://stockpilotusa.com').replace(/\/+$/, '');

/** The requester's own request on their order ("Your requests on this order"). */
export function returnRequestOrderLink(orderId: string): string {
  return `${APP_URL}/dashboard/orders/${orderId}#your-requests`;
}

/** The return page (returns:read or returns:manage). */
export function returnRequestReturnLink(returnId: string): string {
  return `${APP_URL}/dashboard/returns/${returnId}`;
}
