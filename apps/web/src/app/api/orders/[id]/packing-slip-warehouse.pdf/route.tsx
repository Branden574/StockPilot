import QRCode from 'qrcode';
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { createAdminClient } from '@/lib/supabase/admin';
import { isHandOverEntitled, signatureLinkToken } from '@/server/lib/order-secrets';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { env } from '@/lib/env';
import { prefetchImagesAsDataUris } from '@/lib/pdf/image-prefetch';
import { renderWarehousePackingSlipPdf } from '@/lib/pdf/packing-slip-warehouse';
import type { WarehouseInfo } from '@/lib/pdf/packing-slip-shared';
import { ItemImagesService } from '@/server/services/item-images';
import { OrderRequestsService } from '@/server/services/order-requests';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { fetchRackHoldingsByItem } from '@/server/services/rack-holdings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISIBLE_STATUSES = [
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'completed',
];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const svc = new OrderRequestsService(ctx);
    const detail = await svc.get(id);
    // This slip carries the order's hand-over QR (the link that completes
    // it with no sign-in), so it is for the people who may hand the order
    // over: effective orders:approve or the order's assigned driver, the
    // audience of the panel's "Print warehouse slip" button. Any other member
    // could open the order and used to get the QR too (migration 0389).
    if (!isHandOverEntitled(ctx, detail.request)) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only someone who can hand this order over can print its warehouse slip.' },
        { status: 403 },
      );
    }
    if (!VISIBLE_STATUSES.includes(detail.request.status)) {
      return NextResponse.json(
        { error: 'not_yet_generated', message: 'Generate packing slips first.' },
        { status: 400 },
      );
    }
    // The export budget is spent only on an order the caller can open, in a
    // state that has this slip (a refused caller must not spend the shared
    // budget or trip the export abuse alert).
    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    // The QR carries the RAW token (migration 0389): the side table's, when
    // its sha256 is the order's column; else the column itself when no side
    // token hashes to it (minted before 0389, until slice C). A column the
    // side table cannot vouch for, or a failed side read, prints no QR, which
    // is today's no-token branch below. The order column alone is never put
    // in the QR when it is a digest.
    let link: Awaited<ReturnType<typeof signatureLinkToken>> = null;
    if (detail.request.signature_token) {
      try {
        link = await signatureLinkToken(createAdminClient(), id, detail.request.signature_token);
      } catch {
        link = null; // no service-role key: the slip prints without a QR (warned below)
      }
    }
    const token = link?.token ?? null;
    let qrDataUrl: string | null = null;
    if (token) {
      const url = `${env.NEXT_PUBLIC_APP_URL}/orders/sign/${token}`;
      try {
        qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
      } catch (err) {
        // PDF still renders without QR, but log so this isn't silent —
        // a warehouse packing slip without a scannable code is a real
        // problem and we want it in Vercel logs.
        console.error('[packing-slip-warehouse] QR generation failed', {
          orderId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        qrDataUrl = null;
      }
    } else {
      // packing_slip_generated and later all have signature_token minted
      // by the workflow RPCs. Hitting this branch means the token was
      // wiped out-of-band, or the side table could not be read — surface it
      // instead of silently producing a packing slip with no scannable QR.
      // Never the token itself.
      console.warn('[packing-slip-warehouse] missing signature_token', {
        orderId: id,
        status: detail.request.status,
        columnSet: detail.request.signature_token !== null,
      });
    }

    const [whRes, charterRes] = await Promise.all([
      ctx.supabase
        .from('warehouses')
        .select('name, code, address, contact_name, contact_email, contact_phone')
        .eq('id', detail.request.warehouse_id)
        .maybeSingle(),
      detail.request.delivery_charter_id
        ? ctx.supabase
            .from('charters')
            .select('name')
            .eq('id', detail.request.delivery_charter_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const wh = (whRes.data ?? null) as
      | {
          name?: string;
          code?: string;
          address?: WarehouseInfo['address'];
          contact_name?: string;
          contact_email?: string;
          contact_phone?: string;
        }
      | null;
    const warehouse: WarehouseInfo = {
      name: wh?.name ?? null,
      code: wh?.code ?? null,
      address: wh?.address ?? null,
      contactName: wh?.contact_name ?? null,
      contactEmail: wh?.contact_email ?? null,
      contactPhone: wh?.contact_phone ?? null,
    };
    const charterName = ((charterRes.data ?? null) as { name?: string } | null)?.name ?? null;

    const itemIds = detail.lines
      .map((l) => l.item?.id)
      .filter((x): x is string => typeof x === 'string');
    // Telemetry-only warning so we can spot mega-orders in Vercel logs
    // before they OOM. 100+ lines with photos is the worst-case shape
    // for @react-pdf memory (we measured 300-500MB on full 200-line
    // orders). Doesn't bail — vercel.json gives this route 1769MB and
    // we'd rather render a giant slip than refuse a real workflow.
    if (detail.lines.length >= 100) {
      // eslint-disable-next-line no-console
      console.warn(
        '[packing-slip-warehouse] large order',
        JSON.stringify({
          tag: 'pdf.large_order',
          orderId: detail.request.id,
          lineCount: detail.lines.length,
          imageCount: itemIds.length,
          organizationId: ctx.organizationId,
        }),
      );
    }
    // PDF image pipeline — small signed URLs → prefetch to base64
    // data URIs. @react-pdf can't reliably fetch URLs at render time
    // in a serverless function, so we pre-resolve them.
    const urlByItem = await new ItemImagesService(ctx).primaryImagesForServerDecoding(
      itemIds,
      200,
    );
    const dataUriByItem = await prefetchImagesAsDataUris(urlByItem.entries());
    const imageUrlByItemId = new Map<string, string>();
    for (const [itemId, dataUri] of dataUriByItem) {
      if (dataUri) imageUrlByItemId.set(itemId, dataUri);
    }

    // Rack/crate HOLDINGS for every line item, scoped to THIS order's
    // warehouse — mirrors the pick-slip PDF route. Split items (>1
    // holding) get the full breakdown in the LOCATION column instead of
    // a single (possibly stale/misleading) bin_location label — see
    // locationFor in lib/pdf/packing-slip-shared.tsx. A fetch failure
    // degrades to the label (fetchRackHoldingsByItem reports + returns
    // whatever it has rather than throwing), never a broken PDF.
    const rackHoldingsByItemId = await fetchRackHoldingsByItem(
      ctx,
      itemIds,
      detail.request.warehouse_id,
    );

    const orgTimezone = await getCachedOrgTimezone(ctx.organizationId);
    const pdf = await renderWarehousePackingSlipPdf({
      detail,
      warehouse,
      charterName,
      imageUrlByItemId,
      qrDataUrl,
      orgTimezone,
      rackHoldingsByItemId,
    });
    const bytes = new Uint8Array(pdf);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="packing-slip-warehouse-${detail.request.id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    // A ServiceError keeps its real status (an order the caller cannot open
    // is 404, the orders module off is 403); it used to be a 500 carrying the
    // raw message. Anything else is reported and answered generically.
    if (e instanceof ServiceError) {
      if (e.code === 'internal_error') {
        void reportError(e, { tag: 'pdf.packing_slip_warehouse', extra: { detail: e.internalDetail ?? null } });
      }
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'pdf.packing_slip_warehouse' });
    return NextResponse.json(
      { error: 'internal_error', message: 'The PDF could not be made. Please try again.' },
      { status: 500 },
    );
  }
}
