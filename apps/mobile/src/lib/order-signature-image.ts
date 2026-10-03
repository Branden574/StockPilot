/**
 * The captured signature image behind the order screen's "View signature"
 * (migration 0389). The dialog used to select signature_data_url straight from
 * order_requests, which every member reads; slice C moves stored images off
 * that row. It now asks GET /api/v1/orders/<id>/signature, the web panel's
 * route (an alias the firewall lets the app through), with its gate: an order
 * approver or the order's assigned driver. Anyone else gets 403, and the
 * dialog shows its existing empty state (the signer's name and time, no
 * image), as it does for a physical signature.
 *
 * Never throws: any failure is "no image", and only a failure that is not a
 * refusal goes to the device log. Pure: the request function is passed in.
 */

/** GETs a path and resolves its JSON (api() in the app). */
export type SignatureImageGet = (path: string) => Promise<unknown>;

export function orderSignatureImagePath(orderId: string): string {
  return `/api/v1/orders/${encodeURIComponent(orderId)}/signature`;
}

export async function fetchOrderSignatureImage(
  get: SignatureImageGet,
  orderId: string,
): Promise<string | null> {
  try {
    const body = (await get(orderSignatureImagePath(orderId))) as { signatureDataUrl?: unknown } | null;
    const url = body?.signatureDataUrl;
    return typeof url === 'string' && url.startsWith('data:image/') ? url : null;
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status;
    if (status !== 403 && status !== 404) {
      console.warn('[order-signature] the signature image could not be loaded', e instanceof Error ? e.message : String(e));
    }
    return null;
  }
}
