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
 * The read goes through POST /api/v1/orders/signature-lookup (migration
 * 0389), in the signed-in organization (api() sends it). It used to be a
 * direct member read `.eq('signature_token', <the QR's token>)`, but since
 * 0389 the order row holds the token's sha256, not the token, so the server
 * hashes the scanned token and answers the order and its lines (read under
 * the member's own row level security). It never blocks the hand-over for
 * want of facts: a slip of another organization (404), a failed read or no
 * connection opens the pad as before, and the reason goes to the device log.
 * UI only (F2 decision D17): the server stays permissive, because shipping
 * short is the backorder model.
 *
 * Pure: no React Native import, and the request function is passed in.
 */

import { type DepartureRisk } from '@stockpilot/core';

import { orderDepartureRisk, type DepartureOrderLine } from './order-departure';

/** POSTs `body` to the lookup route and resolves its JSON (api() in the app). */
export type SignatureLookupPost = (path: string, body: { token: string }) => Promise<unknown>;

export const SIGNATURE_LOOKUP_PATH = '/api/v1/orders/signature-lookup';

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

function statusOf(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/**
 * The order behind a scanned signature token, in the signed-in organization,
 * with its lines in the order screen's order ((created_at, id)); null when it
 * cannot be read here. Never throws.
 */
export async function readSignatureOrder(
  post: SignatureLookupPost,
  token: string,
): Promise<ScannedSignatureOrder | null> {
  let answer: unknown;
  try {
    answer = await post(SIGNATURE_LOOKUP_PATH, { token });
  } catch (e) {
    // Another organization's slip, or one no longer valid: the pad decides.
    if (statusOf(e) === 404) return null;
    return warn(e instanceof Error ? e.message : String(e));
  }
  const a = answer as { orderId?: unknown; status?: unknown; lines?: unknown } | null;
  if (!a || typeof a.orderId !== 'string' || typeof a.status !== 'string' || !Array.isArray(a.lines)) {
    return warn('an unreadable order');
  }
  const lines: DepartureOrderLine[] = [];
  for (const raw of a.lines as unknown[]) {
    const l = raw as Record<string, unknown> | null;
    if (!l || typeof l.name !== 'string') return warn('an unreadable line');
    lines.push({
      orderRequestLineId: typeof l.orderRequestLineId === 'string' ? l.orderRequestLineId : null,
      name: l.name,
      requested: Number(l.requested) || 0,
      fulfilled: Number(l.fulfilled) || 0,
      picked: Number(l.picked) || 0,
    });
  }
  return { orderId: a.orderId, status: a.status, lines };
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
