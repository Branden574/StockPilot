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
    const value = valueOverride || ((item.barcode as string | null) ?? (item.sku as string));
    if (!value) return new NextResponse('No barcode value', { status: 400 });

    let png: Buffer;
    if (type === 'qr') {
      const QRCode = (await import('qrcode')).default;
      png = await QRCode.toBuffer(value, { type: 'png', width: 400, margin: 2 });
    } else {
      const bwipjs = (await import('bwip-js')).default;
      png = await bwipjs.toBuffer({
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
    console.error(e);
    return new NextResponse('Internal error', { status: 500 });
  }
}
