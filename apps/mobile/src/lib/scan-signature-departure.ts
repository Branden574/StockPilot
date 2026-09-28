/**
 * CAUGHT BEFORE IT LEAVES, FROM THE SCAN TAB (F2-2, review 2026-09-28).
 *
 * Scanning a warehouse packing slip's QR opens the in-app signature pad, which
 * hands the order over (POST /api/v1/orders/sign). On the order screen,
 * Collect signature and Physical signature ask first when a line was not fully
 * picked (core describeDepartureRisk, lib/order-departure.ts); the scan path
 * went straight to the pad. Before the pad opens, the scan tab now reads the
 * order the slip belongs to and asks the same question in the same words.
 * "Fix the order" opens the order, where the line fixes are; once the order
 * is out for delivery the lines are final and the button is "Go back".
 *
 * The read is an RLS member read in the signed-in organization, by the slip's
 * signature token (the token the QR itself carries, and the one the public
 * sign page's own URL carries; nothing new is disclosed by asking with it).
 * It never blocks the hand-over for want of facts: a slip of another
 * organization, a failed read or no connection opens the pad as before, and
 * the reason goes to the device log. UI only (F2 decision D17): the server
 * stays permissive, because shipping short is the backorder model.
 *
 * Pure: no React Native import, and the Supabase client is passed in.
 */

import { orderLineItemName, type DepartureRisk } from '@stockpilot/core';

import { orderDepartureRisk, type DepartureOrderLine } from './order-departure';

/** The slice of the Supabase client the read uses. */
export interface SignatureOrderClient {
  from(table: string): unknown;
}

interface HeaderChain {
  select(columns: string): HeaderChain;
  eq(column: string, value: string): HeaderChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

interface LinesChain extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): LinesChain;
  eq(column: string, value: string): LinesChain;
  order(column: string, options: { ascending: boolean }): LinesChain;
}

/** The order a scanned packing slip belongs to, as the departure confirm reads it. */
export interface ScannedSignatureOrder {
  orderId: string;
  status: string;
  lines: DepartureOrderLine[];
}

function warn(detail: string): null {
  console.warn('[scan-signature] the order could not be checked before signing', detail);
  return null;
}

/**
 * The order behind a scanned signature token, in `orgId`, with its lines in
 * the order screen's order ((created_at, id)); null when it cannot be read
 * here. Never throws.
 */
export async function readSignatureOrder(
  client: SignatureOrderClient,
  orgId: string,
  token: string,
): Promise<ScannedSignatureOrder | null> {
  try {
    const head = await (client.from('order_requests') as HeaderChain)
      .select('id, status')
      .eq('organization_id', orgId)
      .eq('signature_token', token)
      .maybeSingle();
    if (!head) return warn('no answer');
    if (head.error) return warn('the order read failed');
    const h = head.data as { id?: unknown; status?: unknown } | null;
    // Another organization's slip, or one no longer valid: the pad decides.
    if (!h) return null;
    if (typeof h.id !== 'string' || typeof h.status !== 'string')
      return warn('an unreadable order');

    const res = await (client.from('order_request_lines') as LinesChain)
      .select(
        'id, quantity_requested, quantity_fulfilled, quantity_picked, item:inventory_items(name)',
      )
      .eq('order_request_id', h.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (!res || res.error || !Array.isArray(res.data)) return warn('the lines read failed');
    const lines = (res.data as Record<string, unknown>[]).map((l) => {
      const item = Array.isArray(l.item) ? l.item[0] : l.item;
      return {
        orderRequestLineId: typeof l.id === 'string' ? l.id : null,
        // Core's label when the viewer's access hides the item (the order
        // screen and the web page say the same).
        name: orderLineItemName((item ?? null) as { name?: string | null } | null),
        requested: Number(l.quantity_requested) || 0,
        fulfilled: Number(l.quantity_fulfilled) || 0,
        picked: Number(l.quantity_picked) || 0,
      };
    });
    return { orderId: h.id, status: h.status, lines };
  } catch (e) {
    return warn(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The confirm before a scanned slip's signature is taken, or null when the
 * pad may open at once: nothing is short, or the order could not be read
 * (never blocked for want of facts). The order screen's own rule and words
 * (core describeDepartureRisk, action 'signature').
 */
export function scanSignatureDeparture(order: ScannedSignatureOrder | null): DepartureRisk | null {
  return order ? orderDepartureRisk(order, 'signature') : null;
}
