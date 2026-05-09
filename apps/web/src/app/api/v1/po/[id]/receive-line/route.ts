import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ReceivingService } from '@/server/services/receiving';
import { ServiceError } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  itemId: z.string().uuid(),
  qty: z.coerce.number().positive().max(1_000_000),
  warehouseId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(),
});

/**
 * Mobile scan-to-receive helper. The web flow uses rich multi-line
 * receipts; mobile scans one box at a time, so this endpoint:
 *
 *   • takes { itemId, qty, idempotencyKey }
 *   • finds the matching open purchase_order_items line for the item
 *   • posts a single-line receipt against it via the existing
 *     ReceivingService (full audit, full stock movement)
 *
 * Idempotency-key is honored end-to-end — same key + same payload
 * returns the same receipt; same key + different payload errors. Mobile
 * uses its local pending_actions row id as the key so retries on flaky
 * network never double-receive.
 *
 * If the item isn't on this PO, returns 404 with `code: 'not_on_po'` so
 * the mobile client can surface the "Add as new line" toast action.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id: poId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(poId)) {
    return NextResponse.json({ error: 'invalid_po_id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'validation_error' },
      { status: 400 },
    );
  }
  const { itemId, qty, idempotencyKey } = parsed.data;

  const { data: po, error: poErr } = await ctx.supabase
    .from('purchase_orders')
    .select('id, status, destination_location_id, supplier_id')
    .eq('organization_id', ctx.organizationId)
    .eq('id', poId)
    .maybeSingle();
  if (poErr) {
    void reportError(new Error(poErr.message), {
      tag: 'po.receive-line.lookup_po',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!po) return NextResponse.json({ error: 'po_not_found' }, { status: 404 });
  if (po.status === 'received' || po.status === 'cancelled') {
    return NextResponse.json(
      { error: 'po_closed', message: `PO is ${po.status}` },
      { status: 409 },
    );
  }

  const { data: line, error: lErr } = await ctx.supabase
    .from('purchase_order_items')
    .select('id, item_id, quantity_ordered, quantity_received, unit_cost')
    .eq('organization_id', ctx.organizationId)
    .eq('purchase_order_id', poId)
    .eq('item_id', itemId)
    .maybeSingle();
  if (lErr) {
    void reportError(new Error(lErr.message), {
      tag: 'po.receive-line.lookup_line',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!line) {
    return NextResponse.json(
      { error: 'not_on_po', code: 'not_on_po' },
      { status: 404 },
    );
  }

  const remaining =
    Number(line.quantity_ordered ?? 0) - Number(line.quantity_received ?? 0);
  if (remaining <= 0) {
    return NextResponse.json(
      { error: 'line_already_complete', code: 'line_already_complete' },
      { status: 409 },
    );
  }
  if (qty > remaining) {
    return NextResponse.json(
      {
        error: 'qty_exceeds_remaining',
        code: 'qty_exceeds_remaining',
        remaining,
      },
      { status: 409 },
    );
  }

  // Pick a warehouse: explicit override → caller's request, else the
  // PO's destination location's warehouse mapping. Mobile sends the
  // selected warehouse from the receive screen.
  const warehouseId =
    parsed.data.warehouseId ??
    (await resolveWarehouseFromLocation(ctx, po.destination_location_id ?? null));
  if (!warehouseId) {
    return NextResponse.json(
      {
        error: 'warehouse_unresolvable',
        message:
          'No warehouseId provided and the PO has no destination location to derive one from.',
      },
      { status: 400 },
    );
  }

  try {
    const svc = new ReceivingService(ctx);
    const receipt = await svc.postReceipt({
      purchaseOrderId: poId,
      warehouseId,
      idempotencyKey,
      lines: [
        {
          poLineId: line.id as string,
          qtyReceived: qty,
          qtyAccepted: qty,
          qtyRejected: 0,
          unitCost: Number(line.unit_cost),
        },
      ],
      notes: 'Mobile scan-to-receive',
    });
    return NextResponse.json({
      receiptId: receipt.id,
      receiptNumber: receipt.receipt_number,
      poLineId: line.id,
      qtyReceived: qty,
      remainingAfter: remaining - qty,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'conflict'
          ? 409
          : e.code === 'forbidden'
            ? 403
            : e.code === 'not_found'
              ? 404
              : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    void reportError(e, {
      tag: 'po.receive-line.unhandled',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

async function resolveWarehouseFromLocation(
  ctx: { supabase: import('@supabase/supabase-js').SupabaseClient },
  locationId: string | null,
): Promise<string | null> {
  if (!locationId) return null;
  const { data } = await ctx.supabase
    .from('locations')
    .select('warehouse_id')
    .eq('id', locationId)
    .maybeSingle();
  return (data?.warehouse_id as string | null) ?? null;
}
