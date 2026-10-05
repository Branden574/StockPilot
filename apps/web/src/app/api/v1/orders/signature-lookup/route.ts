import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { orderLineItemName } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveSignatureToken, SIGNATURE_TOKEN_RE } from '@/server/lib/order-secrets';
import { isModuleEnabled } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The order behind a scanned warehouse packing-slip QR, for the phone's scan
 * tab (migration 0389). Before the in-app signature pad opens, the scan tab
 * asks "a line was not fully picked, hand it over anyway?" (F2-2), and for
 * that it needs the slip's order and lines. It used to read them itself with
 * `.eq('signature_token', <the QR's token>)`; since 0389 the order column
 * holds the token's sha256, so that read finds nothing. This route hashes the
 * presented raw token instead.
 *
 * Body `{ token }` (the raw token from the QR). Answers the order in the
 * caller's organization as `{ orderId, status, lines }`, the shape the phone's
 * readSignatureOrder returns, with the lines read through the caller's own
 * client (row level security, so a hidden item keeps core's label). A
 * token minted before 0389 matches too: 0392 hashed every older raw column in
 * place. A DIGEST presented here matches nothing (the route hashes again),
 * and every other miss — unknown, another
 * organization, the orders module off — is the same 404. Members can already
 * read every order of their organization; this discloses nothing new.
 */
const bodySchema = z.object({ token: z.string().regex(SIGNATURE_TOKEN_RE) });

function notFound() {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return notFound();
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return notFound();
  if (!isModuleEnabled(ctx, 'orders')) return notFound();

  try {
    const match = await resolveSignatureToken<{ id: string; organization_id: string }>(
      createAdminClient(),
      parsed.data.token,
      'id, organization_id',
    );
    if (!match || match.via === 'member' || match.order.organization_id !== ctx.organizationId) {
      return notFound();
    }

    // The order and its lines through the caller's own client: row level
    // security decides, as it did when the phone read them itself.
    const head = await ctx.supabase
      .from('order_requests')
      .select('id, status')
      .eq('organization_id', ctx.organizationId)
      .eq('id', match.order.id)
      .maybeSingle();
    if (head.error) throw head.error;
    const order = head.data as { id: string; status: string } | null;
    if (!order) return notFound();

    const linesRes = await ctx.supabase
      .from('order_request_lines')
      .select('id, quantity_requested, quantity_fulfilled, quantity_picked, item:inventory_items(name)')
      .eq('order_request_id', order.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (linesRes.error) throw linesRes.error;
    const lines = ((linesRes.data ?? []) as Record<string, unknown>[]).map((l) => {
      const item = Array.isArray(l.item) ? l.item[0] : l.item;
      return {
        orderRequestLineId: typeof l.id === 'string' ? l.id : null,
        name: orderLineItemName((item ?? null) as { name?: string | null } | null),
        requested: Number(l.quantity_requested) || 0,
        fulfilled: Number(l.quantity_fulfilled) || 0,
        picked: Number(l.quantity_picked) || 0,
      };
    });
    return NextResponse.json({ orderId: order.id, status: order.status, lines });
  } catch (e) {
    void reportError(e, { tag: 'api.v1.orders.signature_lookup' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
