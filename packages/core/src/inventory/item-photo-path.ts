/**
 * Object paths in the `item-images` storage bucket, built in ONE place for
 * every writer: the web's presigned uploads (ItemImagesService), the phone's
 * direct uploads (new item, replace photo, scan capture) and the books
 * import's cover rehost.
 *
 * Since migration 0381 the database decides which paths a caller may write,
 * with one anchored parser (public.item_image_path_item_id):
 *
 *   {org}/items/{item}/{file}   photos (web and phone)
 *   {org}/{item}/{file}         books import covers
 *
 * where {org} and {item} are LOWERCASE uuids (as Postgres and
 * crypto.randomUUID() write them) and {file} is word characters then one or
 * more `.extension`s, the whole name at most 400 characters. Anything else is
 * refused at upload time with a 403, so a builder here must never produce
 * another shape: item-photo-path.test.ts reads that parser out of the
 * migrations and runs every builder's output through it.
 */

/** `{org}/items/{item}/{fileName}` — a photo (master) of an item. */
export function itemPhotoPath(organizationId: string, itemId: string, fileName: string): string {
  return `${organizationId}/items/${itemId}/${fileName}`;
}

/** `{org}/items/{item}/{uuid}-thumb.webp` — the web uploader's thumbnail,
 *  stored next to its `{uuid}.{ext}` master. */
export function itemPhotoThumbPath(organizationId: string, itemId: string, uuid: string): string {
  return itemPhotoPath(organizationId, itemId, `${uuid}-thumb.webp`);
}

/** `{org}/{item}/cover.{ext}` — the books import's rehosted cover (the one
 *  writer of the shorter shape; it overwrites the same name in place). */
export function bookCoverPath(
  organizationId: string,
  itemId: string,
  ext: 'jpg' | 'png' | 'webp',
): string {
  return `${organizationId}/${itemId}/cover.${ext}`;
}

/**
 * The phone's random file base: up to 12 base36 characters, never empty
 * (an empty base would make `.jpg` the whole file name, which the database
 * refuses). Not a secret and not an id; it only keeps two photos of one
 * item from sharing a name.
 */
export function randomPhotoFileBase(): string {
  const base = Math.random().toString(36).slice(2, 14);
  return base.length > 0 ? base : Date.now().toString(36);
}
