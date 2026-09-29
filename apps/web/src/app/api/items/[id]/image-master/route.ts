import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
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
 * SECURITY: session/bearer-authed via withApiContext, then the ITEM is
 * authorized before anything is signed: one read of `inventory_items` on the
 * caller's OWN RLS client, so the warehouse, charter and category scoping of
 * `inventory_items_select` decides. An item the caller cannot read answers
 * 404, exactly like an id that does not exist or belongs to another org, so
 * the answer never reveals that the item exists. Only then does
 * ItemImagesService select the path (itself joined to the item under RLS)
 * and sign it with the service-role client.
 *
 * Until 2026-09-28 this route asked ItemImagesService directly, and the only
 * gate on that path was `item_images_select`, which is org-member wide: any
 * member, however scoped, got a working signed URL for any item of the org
 * by id (proven locally with a category-scoped viewer and a warehouse-scoped
 * staff member).
 *
 * Answers: 401 unauthenticated; 400 not a uuid; 404 not readable; 500 when
 * the authorization read itself failed (never a URL); 200 `{ url }`, where
 * `url` is null for a readable item with no photo. The client
 * (inventory-table.tsx loadMasterImageUrl) treats every non-200 as "no
 * preview", as it always has.
 *
 * URL STABILITY: the sign goes through the same per-path 25-day cache every
 * other surface uses, so this returns the SAME URL the dataset used to carry
 * inline.
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

  // Authorize the item FIRST, on the caller's own client. A failed read is a
  // denial (no URL), never "readable".
  const { data: item, error: itemErr } = await ctx.supabase
    .from('inventory_items')
    .select('id')
    .eq('organization_id', ctx.organizationId)
    .eq('id', id)
    .maybeSingle();
  if (itemErr) {
    void reportError(new Error(itemErr.message), {
      tag: 'items.image_master.authorize',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const imagesSvc = new ItemImagesService(ctx);
    const urls = await imagesSvc.primaryImagesForItems([id]);
    // null when the (readable) item has no image; the client shows no preview.
    return NextResponse.json({ url: urls.get(id) ?? null });
  } catch {
    return NextResponse.json({ url: null });
  }
}
