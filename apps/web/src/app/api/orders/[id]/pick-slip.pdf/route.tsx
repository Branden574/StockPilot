import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { renderPickSlipPdf } from '@/lib/pdf/pick-slip';
import { ItemImagesService } from '@/server/services/item-images';
import { OrderRequestsService } from '@/server/services/order-requests';

// @react-pdf/renderer needs Node APIs (Buffer, fs-style streams) — Edge
// runtime is a non-starter. `force-dynamic` keeps Vercel from trying to
// pre-render the route at build time.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // API routes bypass the (dashboard) middleware that powers
  // requireOrgContext() — using withApiContext here means the auth
  // failure path returns a clean 401 instead of throwing NEXT_REDIRECT
  // (which the try/catch below would mis-classify as internal_error).
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const svc = new OrderRequestsService(ctx);
    const detail = await svc.get(id);
    if (
      detail.request.status !== 'pick_slip_generated' &&
      detail.request.status !== 'picking_in_progress' &&
      detail.request.status !== 'picking_complete'
    ) {
      return NextResponse.json(
        { error: 'not_yet_generated', message: 'Generate the pick slip first.' },
        { status: 400 },
      );
    }

    // Primary image per item, served as small (~200px) PDF-optimized
    // signed URLs. The PDF-rendering variant resizes via Supabase
    // transform on the way out so @react-pdf can actually fetch the
    // bytes at render time — the 2048px master that primaryImagesForItems
    // returns is too big for serverless render to embed reliably. Also
    // falls back to custom_fields.thumbnail_url so bulk-imported books
    // (Google Books / Open Library covers) show up too.
    const itemIds = detail.lines
      .map((l) => l.item?.id)
      .filter((x): x is string => typeof x === 'string');
    const imagesSvc = new ItemImagesService(ctx);
    const imageUrlByItemId = await imagesSvc.primaryImagesForPdfRendering(
      itemIds,
      200,
    );

    const pdf = await renderPickSlipPdf(detail, { imageUrlByItemId });
    const body = new Uint8Array(pdf.byteLength);
    body.set(pdf);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="pick-slip-${detail.request.id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'pdf failed' },
      { status: 500 },
    );
  }
}
