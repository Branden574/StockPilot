import 'server-only';

import { unstable_cache } from 'next/cache';

import { isValidStoragePath, itemImageAnyPathShape } from '@/lib/storage-path';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Public read-only item lookup. Powers the QR-code-scannable
 * /p/items/[id] page that anyone (no account required) can land on.
 *
 * SECURITY MODEL
 *   - Uses the service-role client (bypasses RLS) because the caller
 *     is unauthenticated by definition.
 *   - The shaping function (toPublicItem) is the ONLY thing that
 *     decides what a stranger sees. It's tested in
 *     public-items.test.ts — every column we don't expose has an
 *     explicit "NEVER leaks X" test.
 *   - Only items with status='active' and deleted_at IS NULL are
 *     served. Archived/discontinued/deleted items 404 publicly.
 *
 * What's exposed:
 *     id, name, item_type, image_url, quantity_on_hand, category_name
 *     (descriptive only), book metadata from custom_fields
 *     (author/publisher/date/grade).
 *
 *     quantity_on_hand is INTENTIONALLY public per product call —
 *     warehouse staff scanning a label want immediate "is this in
 *     stock?" feedback, and physical access to a labeled item
 *     already implies presence in the building. Re-evaluate this if
 *     the threat model ever changes (e.g. customer-visible labels
 *     in a retail context where competitors could enumerate stock).
 *
 * What's NEVER exposed:
 *     costs, prices, suppliers, locations, internal notes, SKU,
 *     barcode, audit metadata, organization/warehouse ids,
 *     reorder points, tracking type, custom_fields keys other than
 *     the explicit allowlist below.
 */

export const PUBLIC_ITEM_FIELDS = [
  'id',
  'name',
  'item_type',
  'image_url',
  'quantity_on_hand',
  'category_name',
  'custom_fields',
] as const;

export type PublicItemType = 'product' | 'book' | 'asset' | 'consumable';

export interface PublicItem {
  id: string;
  name: string;
  itemType: PublicItemType;
  imageUrl: string | null;
  /** Defaults to 0 if column missing or non-numeric — never NaN/undefined. */
  quantityOnHand: number;
  category: string | null;
  bookAuthor: string | null;
  bookPublisher: string | null;
  bookPublishedDate: string | null;
  bookGrade: string | null;
}

const KNOWN_ITEM_TYPES = new Set<PublicItemType>([
  'product',
  'book',
  'asset',
  'consumable',
]);

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pure shaping function — given a raw DB row (or anything roughly
 * shaped like one), produce the safe public projection. Tested
 * exhaustively in public-items.test.ts for what it must NOT leak.
 */
export function toPublicItem(raw: Record<string, unknown>): PublicItem {
  const rawType = typeof raw.item_type === 'string' ? raw.item_type : '';
  const itemType: PublicItemType = KNOWN_ITEM_TYPES.has(rawType as PublicItemType)
    ? (rawType as PublicItemType)
    : 'product';

  const customFields =
    raw.custom_fields && typeof raw.custom_fields === 'object'
      ? (raw.custom_fields as Record<string, unknown>)
      : {};

  const rawQty = raw.quantity_on_hand;
  const qty =
    typeof rawQty === 'number' && Number.isFinite(rawQty)
      ? rawQty
      : typeof rawQty === 'string' && Number.isFinite(Number(rawQty))
        ? Number(rawQty)
        : 0;

  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : '',
    itemType,
    imageUrl: pickString(raw.image_url),
    quantityOnHand: qty,
    category: pickString(raw.category_name),
    bookAuthor: pickString(customFields.author),
    bookPublisher: pickString(customFields.publisher),
    bookPublishedDate: pickString(customFields.published_date),
    bookGrade: pickString(customFields.book_grade),
  };
}

/**
 * Resolve the best available image URL for a public item view.
 *
 * Priority order:
 *   1. The item's primary uploaded photo from the `item_images` table
 *      (signed URL, 1h TTL — long enough to render after a scan, short
 *      enough that link sharing past the session is bounded).
 *   2. The first uploaded photo (any sort order) if no primary flag.
 *   3. custom_fields.thumbnail_url — populated for books that came in
 *      via the ISBN import pipeline (Google Books / OpenLibrary cover).
 *   4. null — placeholder will render on the page.
 *
 * Uses the admin client so it works without an authenticated session.
 */
async function resolvePublicImageUrl(
  admin: ReturnType<typeof createAdminClient>,
  itemId: string,
  customFields: Record<string, unknown> | null | undefined,
): Promise<string | null> {
  // 1 + 2: uploaded photo. Order so primary wins, then earliest sort.
  const { data: imgRows } = await admin
    .from('item_images')
    .select('storage_path, is_primary, sort_order')
    .eq('item_id', itemId)
    .order('is_primary', { ascending: false })
    .order('sort_order', { ascending: true })
    .limit(1);
  const imgRow = (imgRows ?? [])[0] as { storage_path?: string } | undefined;
  // HI-8: this is a SERVICE-ROLE read on an UNAUTHENTICATED page, and it does
  // not know (or check) which org owns the item — the whole point of the
  // public item view. So the path it signs is structurally validated before
  // it reaches the storage client: `..`/`%2e%2e` segments in a stored path
  // would be resolved by the WHATWG URL parser inside @supabase/storage-js
  // and could mint a service-role-signed URL for an object in a DIFFERENT
  // bucket entirely, served to an anonymous visitor.
  //
  // `itemImageAnyPathShape` is structural rather than id-pinned because the
  // owning org id is exactly what is unknown here; item-level pinning is
  // enforced on the WRITE side by `ItemImagesService.record()`. A row that
  // fails the shape falls through to the custom_fields cover / placeholder
  // below, which is the same outcome as a failed signing call.
  if (imgRow?.storage_path && isValidStoragePath(imgRow.storage_path, itemImageAnyPathShape())) {
    // M5: 1h TTL. The /p/items/[id] page is server-rendered per
    // request, so the signed URL is freshly minted on each load —
    // there's no SSG cache that depends on a long TTL. A 7-day window
    // means a leaked signed URL stays viewable for a week; 1h tracks
    // the actual session length and removes that exposure.
    const { data: signed } = await admin.storage
      .from('item-images')
      .createSignedUrl(imgRow.storage_path, 60 * 60); // 1 hour
    if (signed?.signedUrl) return signed.signedUrl;
  }

  // 3: book cover from the ISBN import pipeline.
  if (customFields && typeof customFields === 'object') {
    const thumbnail = customFields.thumbnail_url;
    if (typeof thumbnail === 'string' && thumbnail.length > 0) return thumbnail;
  }

  return null;
}

/**
 * Loads one item by id from Supabase via the service-role client and
 * returns its public projection. Returns null when the row doesn't
 * exist, is soft-deleted, or isn't active. The caller (route handler)
 * decides whether to 404.
 *
 * Wrapped in unstable_cache with a 60s revalidate so repeat QR-scan
 * visits within the window don't re-hit Supabase + re-sign the image
 * URL. 60s is bounded by the image signed-URL TTL (1h) — never
 * extend past that without restructuring resolvePublicImageUrl.
 *
 * Cache tag enables future invalidation from item-update flows
 * via revalidateTag(`public-item:${itemId}`) when behavior becomes
 * cache-sensitive enough to justify the wiring across every mutation
 * path. For now, 60s drift on stock counts is acceptable for the
 * "scan an item label" use case.
 */
export async function getPublicItem(itemId: string): Promise<PublicItem | null> {
  if (!itemId) return null;
  return getPublicItemCached(itemId);
}

const getPublicItemCached = unstable_cache(
  async (itemId: string): Promise<PublicItem | null> => {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('inventory_items')
      .select(
        'id, name, item_type, quantity_on_hand, custom_fields, status, deleted_at, category:categories!category_id (name)',
      )
      .eq('id', itemId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .maybeSingle();
    if (error || !data) return null;

    // PostgREST returns embedded relations as either an object or array
    // depending on cardinality. Flatten to the name string.
    const cat = (data as Record<string, unknown>).category as
      | { name?: string }
      | { name?: string }[]
      | null
      | undefined;
    const categoryName = Array.isArray(cat)
      ? cat[0]?.name ?? null
      : cat?.name ?? null;

    const customFields = (data as Record<string, unknown>).custom_fields as
      | Record<string, unknown>
      | null
      | undefined;

    const imageUrl = await resolvePublicImageUrl(admin, itemId, customFields);

    return toPublicItem({
      id: (data as { id: string }).id,
      name: (data as { name: string }).name,
      item_type: (data as { item_type: string }).item_type,
      image_url: imageUrl,
      quantity_on_hand: (data as { quantity_on_hand?: number }).quantity_on_hand ?? 0,
      category_name: categoryName,
      custom_fields: customFields ?? null,
    });
  },
  ['public-item-v1'],
  {
    revalidate: 60,
    tags: ['public-item'],
  },
);
