import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns a PNG barcode (Code 128) or QR code for the given item.
 * Query: ?type=qr|code128 (default code128)
 *        ?value=<override> (defaults to barcode || sku)
 *
 * Auth note: API routes don't run the proxy middleware, so the validated
 * x-pathname / user-id headers we usually rely on aren't present. Use
 * withApiContext() — it auths via Supabase cookies and returns null on
 * failure so we can respond with a real 401 PNG-less response instead
 * of redirecting (the previous code redirected to /signin, and the
 * <img> tag rendered as a broken-image icon in the Print Label dialog).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const type = url.searchParams.get('type') ?? 'code128';
    const valueOverride = url.searchParams.get('value');

    const ctx = await withApiContext();
    if (!ctx) return new NextResponse('unauthenticated', { status: 401 });
    const svc = new InventoryService(ctx);
    const item = await svc.get(id);

    // Resolve a printable value with sensible fallbacks. Order:
    //   1. ?value=<override>           (explicit caller override)
    //   2. item.barcode                (real linear barcode from vendor)
    //   3. item.sku                    (auto-generated on create)
    //   4. item.id                     (always present — last-resort
    //                                   so label printing never fails
    //                                   on items missing SKU/barcode)
    // For QR codes we ignore the value lookup entirely below — the QR
    // encodes the public item URL — so the only failure mode here is
    // a Code-128 barcode for an item with literally nothing to encode,
    // which we now also avoid by falling back to the id.
    const itemBarcode =
      typeof item.barcode === 'string' && item.barcode.trim().length > 0
        ? item.barcode.trim()
        : null;
    const itemSku =
      typeof item.sku === 'string' && item.sku.trim().length > 0
        ? item.sku.trim()
        : null;
    const value =
      (valueOverride && valueOverride.trim().length > 0
        ? valueOverride.trim()
        : null) ??
      itemBarcode ??
      itemSku ??
      String((item as { id?: string }).id ?? id);

    let png: Buffer;
    if (type === 'qr') {
      // QR encodes a PUBLIC, unauthenticated URL so anyone with a phone
      // camera can scan the sticker and see basic item info — no
      // StockPilot account required. The /p/items/[id] page strips
      // quantities, costs, supplier, location, and internal notes
      // before rendering (see server/services/public-items.ts). Team
      // members signed in to the dashboard can still navigate to the
      // full editable view from inside the app. The mobile scanner
      // detects either URL shape — see apps/mobile/app/(tabs)/scan.tsx.
      // Code 128 below stays as the bare value because linear barcodes
      // can't reliably carry long URLs.
      const origin =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? req.nextUrl.origin;
      const itemUrl = `${origin}/p/items/${id}`;
      const mod = (await import('qrcode')) as unknown as {
        default?: { toBuffer: (text: string, opts: object) => Promise<Buffer> };
        toBuffer?: (text: string, opts: object) => Promise<Buffer>;
      };
      const toBuffer = mod.default?.toBuffer ?? mod.toBuffer;
      if (!toBuffer) throw new Error('qrcode module has no toBuffer export');
      png = await toBuffer(itemUrl, {
        type: 'png',
        width: 400,
        margin: 2,
        // Higher error-correction so partial smudges/curls on the
        // physical sticker still resolve cleanly.
        errorCorrectionLevel: 'M',
      });
    } else {
      // bwip-js v3+ requires the /node subpath for raster (PNG) output
      // on Node runtime — the bare 'bwip-js' import resolves to the
      // browser build that doesn't ship a Node Canvas implementation,
      // which is why toBuffer was throwing here.
      const mod = (await import('bwip-js/node')) as unknown as {
        default?: { toBuffer: (opts: object) => Promise<Buffer> };
        toBuffer?: (opts: object) => Promise<Buffer>;
      };
      const toBuffer = mod.default?.toBuffer ?? mod.toBuffer;
      if (!toBuffer) throw new Error('bwip-js/node module has no toBuffer export');
      png = await toBuffer({
        bcid: 'code128',
        text: value,
        scale: 3,
        height: 14,
        includetext: true,
        textxalign: 'center',
      });
    }

    return new NextResponse(png as unknown as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return new NextResponse(e.message, { status: e.code === 'not_found' ? 404 : 403 });
    }
    console.error('barcode route error', e);
    // Surface the real error to the caller. The Label dialog only
    // renders for authenticated dashboard users, so leaking the
    // message back is fine and makes the broken-image bug actually
    // diagnosable.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : 'Unknown error';
    return new NextResponse(msg, { status: 500 });
  }
}
