import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
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
 *
 * OVER-RECEIPT IS ALLOWED (migration 0285, owner decision 2026-07-21):
 * vendors over-ship, so receiving more than was ordered is a legitimate
 * outcome and `remainingAfter` may come back NEGATIVE ("N over"). This
 * endpoint must not reinstate a remaining-qty refusal — see the note at the
 * line-selection block.
 *
 * NOTE ON REACHABILITY: nothing in the shipped mobile app enqueues
 * `receive_po_line` today (the PO screen posts post_receipt_v2 directly);
 * apps/mobile/src/lib/sync.ts has the drain-side branch waiting for the
 * offline receive flow to be wired up. The route is kept — and kept correct —
 * as the Bearer twin that wiring will use.
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

  // WHY this is not `.maybeSingle()`: purchase_order_items has NO unique
  // index on (purchase_order_id, item_id) — only plain indexes (0002:257,
  // 0139) — and one item legitimately appears on two lines of one PO (a
  // re-order line, a backorder release, the same SKU on two pages of a vendor
  // sheet). Both PurchaseOrdersService.create() and PoImportsService.approve()
  // insert one row per document line ON PURPOSE (PO-document fidelity), so
  // duplicates are data, not corruption. supabase-js maybeSingle() turns >1
  // matching row into a PGRST116 *error*, which this route reported as a bare
  // 500 internal_error — so exactly those POs could never be received from a
  // client of this endpoint while the web multi-line dialog handled them
  // fine, and a queued mobile retry would fail forever. Read every matching
  // line and choose one deterministically instead. (SP-064)
  const { data: lineRows, error: lErr } = await ctx.supabase
    .from('purchase_order_items')
    .select('id, item_id, quantity_ordered, quantity_received, unit_cost')
    .eq('organization_id', ctx.organizationId)
    .eq('purchase_order_id', poId)
    .eq('item_id', itemId)
    // NOT created_at — purchase_order_items has no such column (0002:100-110);
    // ordering by it would 42703 the whole lookup. `id` is stable and present.
    .order('id', { ascending: true });
  if (lErr) {
    void reportError(new Error(lErr.message), {
      tag: 'po.receive-line.lookup_line',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  const lines = (lineRows ?? []) as {
    id: string;
    item_id: string;
    quantity_ordered: number | string | null;
    quantity_received: number | string | null;
    unit_cost: number | string | null;
  }[];
  if (lines.length === 0) {
    return NextResponse.json(
      { error: 'not_on_po', code: 'not_on_po' },
      { status: 404 },
    );
  }

  const remainingOf = (l: (typeof lines)[number]) =>
    Number(l.quantity_ordered ?? 0) - Number(l.quantity_received ?? 0);
  // Prefer a line that still has quantity outstanding; if every line for this
  // item is already complete, fall back to the first one so an OVER-receipt
  // still lands somewhere real (see the over-receipt note below).
  const line = lines.find((l) => remainingOf(l) > 0) ?? lines[0]!;
  const remaining = remainingOf(line);

  // WHY there is no `remaining <= 0` / `qty > remaining` refusal here:
  // migration 0285_allow_over_receipt removed the DB's `over_receive_blocked`
  // guard — vendors sometimes ship MORE than was ordered and receiving the
  // extras is legitimate (owner decision 2026-07-21); the receipt Notes field
  // records why. ReceivingService.postReceipt and the web receive flow have no
  // such check either. This route used to answer 409 line_already_complete /
  // qty_exceeds_remaining, which (a) contradicted 0285 and (b) is fatal to the
  // mobile outbox: drain-failure.ts treats only a 401 as terminal, so a 409
  // would be re-sent on every drain tick, forever, and the units would never
  // be received from the phone. `remainingAfter` below is intentionally
  // UNCLAMPED — negative means "N over", the same variance the web shows.
  // (SP-124)

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
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({
      receiptId: receipt.id,
      receiptNumber: receipt.receipt_number,
      poLineId: line.id,
      qtyReceived: qty,
      remainingAfter: remaining - qty,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      // validation_error and module_disabled used to fall through to 500:
      // a lot/serial validation refusal from post_receipt_v2, or receiving
      // being switched off for the org, read to the caller as "the server is
      // broken, retry" — and the mobile outbox does exactly that, forever.
      // Map every code the service can actually raise. (SP-124)
      const status =
        e.code === 'conflict'
          ? 409
          : e.code === 'forbidden' ||
              e.code === 'module_disabled' ||
              e.code === 'plan_limit_exceeded'
            ? 403
            : e.code === 'not_found'
              ? 404
              : e.code === 'validation_error'
                ? 400
                : e.code === 'unauthenticated'
                  ? 401
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
