import 'server-only';

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
 *     id, name, item_type, image_url, category_name (descriptive only),
 *     book metadata from custom_fields (author/publisher/date/grade)
 *
 * What's NEVER exposed:
 *     quantities, costs, prices, supplier, location, internal notes,
 *     SKU, barcode, audit metadata, organization/warehouse ids,
 *     custom_fields keys other than the explicit allowlist below.
 */

export const PUBLIC_ITEM_FIELDS = [
  'id',
  'name',
  'item_type',
  'image_url',
  'category_name',
  'custom_fields',
] as const;

export type PublicItemType = 'product' | 'book' | 'asset' | 'consumable';

export interface PublicItem {
  id: string;
  name: string;
  itemType: PublicItemType;
  imageUrl: string | null;
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

  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' ? raw.name : '',
    itemType,
    imageUrl: pickString(raw.image_url),
    category: pickString(raw.category_name),
    bookAuthor: pickString(customFields.author),
    bookPublisher: pickString(customFields.publisher),
    bookPublishedDate: pickString(customFields.published_date),
    bookGrade: pickString(customFields.book_grade),
  };
}

/**
 * Loads one item by id from Supabase via the service-role client and
 * returns its public projection. Returns null when the row doesn't
 * exist, is soft-deleted, or isn't active. The caller (route handler)
 * decides whether to 404.
 */
export async function getPublicItem(itemId: string): Promise<PublicItem | null> {
  if (!itemId) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('inventory_items')
    .select('id, name, item_type, custom_fields, status, deleted_at, category:categories!category_id (name)')
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

  // We could also resolve a primary image here; left null for v1
  // since the inventory list-thumbnails service is org-scoped and
  // requires more wiring to call from public context. Items that
  // surface their image via custom_fields.thumbnail_url (books) get
  // it through that pathway already.
  const customFields = (data as Record<string, unknown>).custom_fields as
    | Record<string, unknown>
    | null
    | undefined;
  const thumbnailUrl =
    customFields && typeof customFields === 'object'
      ? (customFields.thumbnail_url as string | undefined)
      : undefined;

  return toPublicItem({
    id: (data as { id: string }).id,
    name: (data as { name: string }).name,
    item_type: (data as { item_type: string }).item_type,
    image_url: thumbnailUrl ?? null,
    category_name: categoryName,
    custom_fields: customFields ?? null,
  });
}
