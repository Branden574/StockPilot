import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { ItemImagesService } from '@/server/services/item-images';

/**
 * The order storefront's "Frequently ordered" strip, resolved ON THE SERVER and
 * streamed with the page, instead of fetched by the browser after hydration.
 *
 * WHY. The strip is the first row of photos on the storefront. It used to be
 * filled by `GET /api/orders/freq` from a mount effect, which can only run
 * after the catalog stream has arrived and React has hydrated. That request
 * then resolved the whole API context again and walked five Supabase waves
 * (top SKUs, items + reservations, categories, photo rows, signing). Measured
 * in production on 2026-09-21 (Perf Lab, harness 2026-09-21.1, n=20): the
 * storefront was usable at p50 729 ms and the strip's photos arrived at p50
 * 1493 ms, p95 3907 ms, with every photo already in the browser's cache.
 *
 * The storefront only ever used three things from that answer: the item id, the
 * count, and a photo URL for the rare catalog row that has none. Everything
 * else (name, SKU, availability, category) it takes from the catalog it already
 * holds. So this asks the database ONE question, in parallel with the catalog.
 *
 * AUTHORIZATION is unchanged. `order_request_top_skus_for_warehouse` is
 * SECURITY INVOKER and is called with the visitor's own session client, exactly
 * as the route does, so row level security decides which orders are counted.
 * The answer is then narrowed to items present in the visitor's own catalog:
 * the browser receives no id it was not already given.
 *
 * NOT CACHED, on purpose: it is per visitor (row level security), cheap, and
 * "what was ordered lately" should not be minutes old after placing an order.
 *
 * NEVER REJECTS. The strip hides itself when there is nothing to show; a fault
 * here must not take the storefront down with it.
 */

/** The window and the size the storefront has always asked the route for. */
const DAYS = 30;
const LIMIT = 10;
/** Width of the fallback thumbnail, as the route signs it. */
const FALLBACK_THUMB_WIDTH = 200;

export interface FrequentlyOrderedEntry {
  itemId: string;
  /** Order requests in the last 30 days that included the item. */
  count: number;
  /** Only when the catalog row has no photo URL of its own; null otherwise. */
  fallbackImageUrl: string | null;
}

interface CatalogForFrequentlyOrdered {
  items: ReadonlyArray<{ id: string; imageUrl: string | null }>;
}

export async function loadFrequentlyOrdered(
  warehouseId: string,
  catalog: Promise<CatalogForFrequentlyOrdered>,
): Promise<FrequentlyOrderedEntry[]> {
  try {
    const supabase = await createClient();
    const [top, bundle] = await Promise.all([
      supabase.rpc('order_request_top_skus_for_warehouse', {
        p_warehouse_id: warehouseId,
        p_days: DAYS,
        p_limit: LIMIT,
      }),
      catalog,
    ]);
    if (top.error) {
      // A SHORT LABEL ONLY: a message can quote request details. `code` is the
      // database's own SQLSTATE for a refusal, but the client sets it to the
      // EMPTY STRING for a transport fault (timeout, DNS, reset, abort) and
      // leaves it undefined for a gateway error with a non-JSON body — so `??`
      // alone logged a blank, and the most likely production fault was the one
      // that said least. `status` is 0 for a transport fault.
      const why = top.error.code || (top.status === 0 ? 'network' : `http-${top.status}`);
      console.warn('[frequently-ordered] top-SKUs call failed:', why);
      return [];
    }
    const photoByItem = new Map(bundle.items.map((item) => [item.id, item.imageUrl]));
    const rows = ((top.data ?? []) as Array<{ item_id: string; request_count: number }>).filter(
      (row) => photoByItem.has(row.item_id),
    );
    if (rows.length === 0) return [];

    // Rare: the catalog's photo map is allowed to miss a few URLs. Sign a small
    // thumbnail for exactly those, so an item WITH a photo never shows a glyph.
    const missing = rows.filter((row) => !photoByItem.get(row.item_id)).map((row) => row.item_id);
    let fallback = new Map<string, string | null>();
    if (missing.length > 0) {
      try {
        const images = await ItemImagesService.forCurrentUser();
        fallback = await images.primaryImagesForBrowserDisplay(missing, FALLBACK_THUMB_WIDTH);
      } catch {
        // No fallback photo is not a reason to drop the strip.
      }
    }
    return rows.map((row) => ({
      itemId: row.item_id,
      count: Number(row.request_count),
      fallbackImageUrl: fallback.get(row.item_id) ?? null,
    }));
  } catch {
    // A fixed string, never the error: it can quote request details.
    console.warn('[frequently-ordered] could not be loaded; the strip stays hidden');
    return [];
  }
}
