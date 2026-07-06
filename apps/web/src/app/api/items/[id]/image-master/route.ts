import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/items/:id/image-master — on-demand signed URL for an item's
 * PRIMARY master (2048px) image.
 *
 * WHY (cold-start plan rank 5): instant-mode dataset rows no longer ship
 * the master signed URL inline (the table cell only renders the ~200px
 * thumb; the master is used solely by the hover-preview/lightbox). The
 * client fetches it here on hover intent instead.
 *
 * SECURITY: session/bearer-authed via withApiContext; the lookup runs
 * through the caller's OWN RLS-scoped client with an explicit
 * organization_id filter inside ItemImagesService (perm floor = RLS
 * floor — no admin reads, no cross-org paths). URL STABILITY: the sign
 * goes through the same per-path 25-day cache every other surface uses,
 * so this returns the SAME URL the dataset used to carry inline.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_item_id' }, { status: 400 });
  }
  try {
    const imagesSvc = new ItemImagesService(ctx);
    const urls = await imagesSvc.primaryImagesForItems([id]);
    // null (not 404) when the item has no image / isn't visible to the
    // caller — the client treats both identically (no preview) and a
    // probing caller learns nothing beyond "no image for you".
    return NextResponse.json({ url: urls.get(id) ?? null });
  } catch {
    return NextResponse.json({ url: null });
  }
}
