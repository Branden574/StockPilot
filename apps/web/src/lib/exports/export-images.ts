import 'server-only';

import { ItemImagesService } from '@/server/services/item-images';
import type { ServiceContext } from '@/server/services/context';

import type { InventoryExportSourceRow } from './source-row';

/**
 * Export image pipeline (Brief sections 18 and 24).
 *
 * EVERY path here goes through ItemImagesService.primaryImagesForPdfRendering,
 * which already implements the exact priority chain the brief asks for —
 * stored 200px thumb_path, else an on-the-fly Supabase transform of the master
 * at the target width, else the legacy custom_fields.thumbnail_url that the
 * ISBN bulk importer writes for book covers — in ONE batched query plus one
 * batched signing call.
 *
 * NEVER use primaryMasterUrlsForItems here. That resolver returns the 2048px
 * master for the public catalog's next/image pipeline; fetching hundreds of
 * masters server-side to build one PDF is the exact landmine the public-catalog
 * work already stepped on once.
 *
 * Nothing in this module is called unless the request selected the Image field.
 */

/** Requested thumbnail width per size tier. 200 matches the stored thumb. */
export const EXPORT_IMAGE_TARGET_WIDTH_PX = {
  small: 120,
  medium: 200,
  large: 320,
} as const;

/** Per-image ceiling. A ~200px WebP is 20-50KB; 512KB is a generous outlier. */
export const MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024;
/** Whole-export ceiling. Keeps one workbook inside the 60s / memory budget. */
export const MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 24 * 1024 * 1024;
/** Hard count ceiling regardless of size. */
export const MAX_EMBEDDED_IMAGES = 2_000;
export const IMAGE_FETCH_TIMEOUT_MS = 6_000;
export const IMAGE_FETCH_CONCURRENCY = 6;

/** Brief section 24, verbatim. */
export const EXPORT_TOO_MANY_IMAGES_MESSAGE =
  'This export contains too many embedded images. Reduce the number of records, choose smaller images, or export without images.';

/** Content types we will embed. SVG is excluded deliberately: it is a script
 *  carrier, and neither exceljs nor react-pdf needs it. */
const ALLOWED_CONTENT_TYPES: ReadonlyMap<string, 'png' | 'jpeg'> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/jpg', 'jpeg'],
  // WebP is DELIBERATELY absent. exceljs accepts only png/jpeg/gif, and older
  // Excel builds cannot decode WebP at all, so embedding a mislabelled WebP
  // produces a broken picture rather than an error. Supabase-stored thumbs are
  // WebP; externally-sourced book covers (the ISBN importer's Google Books /
  // Open Library URLs) are JPEG, which is the case that matters most for a
  // books catalog. WebP rows are counted as skipped and keep their URL instead.
  // This is a documented limitation in the section 31 report.
]);

export interface EmbeddedImage {
  data: Uint8Array;
  extension: 'png' | 'jpeg';
}

/**
 * Resolve a thumbnail URL for each row that has one, in ONE batched call, and
 * attach it to the row. Fail-closed: any error leaves every row imageless and
 * the export continues with placeholders (Brief section 3.3).
 */
export async function attachExportImages(
  ctx: ServiceContext,
  rows: InventoryExportSourceRow[],
  opts: { imageSize: keyof typeof EXPORT_IMAGE_TARGET_WIDTH_PX },
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const service = new ItemImagesService(ctx);
    const urls = await service.primaryImagesForPdfRendering(
      rows.map((r) => r.id),
      EXPORT_IMAGE_TARGET_WIDTH_PX[opts.imageSize],
    );
    for (const row of rows) {
      const url = urls.get(row.id);
      row.image = url ? { thumbnailUrl: url } : null;
    }
  } catch {
    // Swallow and blank, exactly like buildInventoryExportRows' safe() wrapper.
    // Never log: the message can carry a signed URL.
    for (const row of rows) row.image = null;
  }
}

/**
 * How many of these items have a usable image, WITHOUT signing anything.
 *
 * Readiness ("84 of 111 have a cover") only needs presence, and signing is the
 * expensive half of the resolver — so this is two plain selects and no Storage
 * round trip at all.
 */
export async function countRowsWithImages(
  ctx: ServiceContext,
  itemIds: string[],
): Promise<number> {
  if (itemIds.length === 0) return 0;
  try {
    const withRow = new Set<string>();
    const { data } = await ctx.supabase
      .from('item_images')
      .select('item_id')
      .eq('organization_id', ctx.organizationId)
      .in('item_id', itemIds);
    for (const row of (data ?? []) as Array<{ item_id: string }>) withRow.add(row.item_id);

    const rest = itemIds.filter((id) => !withRow.has(id));
    if (rest.length > 0) {
      const { data: cfRows } = await ctx.supabase
        .from('inventory_items')
        .select('id, custom_fields')
        .eq('organization_id', ctx.organizationId)
        .in('id', rest);
      for (const row of (cfRows ?? []) as Array<{
        id: string;
        custom_fields: Record<string, unknown> | null;
      }>) {
        const url = row.custom_fields?.thumbnail_url;
        if (typeof url === 'string' && url.length > 0) withRow.add(row.id);
      }
    }
    return withRow.size;
  } catch {
    return 0;
  }
}

async function fetchOne(
  url: string,
  fetchImpl: typeof fetch,
): Promise<EmbeddedImage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extension = ALLOWED_CONTENT_TYPES.get(contentType);
    if (!extension) return null;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_EMBEDDED_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_EMBEDDED_IMAGE_BYTES) return null;
    return { data: buf, extension };
  } catch {
    // Timeout, DNS, reset, abort. Never log — the URL carries a signed token.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch image bytes for embedding, bounded on every axis: per-image size,
 * total size, image count, per-request timeout and parallelism. A failure
 * never propagates — the caller draws a placeholder for the missing id.
 */
export async function fetchExportImageBytes(
  urls: ReadonlyMap<string, string>,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ images: Map<string, EmbeddedImage>; skipped: number; truncated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const entries = [...urls.entries()].slice(0, MAX_EMBEDDED_IMAGES);
  const truncatedByCount = urls.size > MAX_EMBEDDED_IMAGES;

  const images = new Map<string, EmbeddedImage>();
  let skipped = 0;
  let totalBytes = 0;
  let budgetSpent = false;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length || budgetSpent) return;
      const [id, url] = entries[index]!;
      const image = await fetchOne(url, fetchImpl);
      if (!image) {
        skipped++;
        continue;
      }
      if (totalBytes + image.data.byteLength > MAX_TOTAL_EMBEDDED_IMAGE_BYTES) {
        budgetSpent = true;
        return;
      }
      totalBytes += image.data.byteLength;
      images.set(id, image);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, entries.length) }, () => worker()),
  );

  return { images, skipped, truncated: truncatedByCount || budgetSpent };
}
