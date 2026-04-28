import { NextResponse, type NextRequest } from 'next/server';

import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';

/**
 * Returns a PNG barcode (Code 128) or QR code for the given item.
 * Query: ?type=qr|code128 (default code128)
 *        ?value=<override> (defaults to barcode || sku)
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

    const svc = await InventoryService.forCurrentUser();
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
