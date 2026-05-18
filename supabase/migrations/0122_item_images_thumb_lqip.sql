-- ============================================================================
-- 0122_item_images_thumb_lqip.sql
-- ============================================================================
-- Two new nullable columns on item_images to support faster perceived
-- thumbnail rendering on the inventory + books list pages:
--
--   • thumb_path text — storage path of a pre-resized ~200px WebP
--     generated alongside the full image at upload time. The list
--     pages reference THIS path instead of the 2048px master so the
--     Vercel Image Optimizer doesn't have to re-encode a giant
--     source down to a 28×28 thumb on every cold cache hit (which is
--     the 200-500ms per-thumb tax users were feeling on revisits).
--
--   • lqip text — base64 data URL of a tiny 16×16 WebP blur
--     placeholder, embedded directly in the page HTML so the row
--     paints a hint of the image immediately. Bounded at 2000 chars
--     so a malformed client can't stash a full image in this column.
--
-- Both are nullable + backward compatible:
--   • Rows without thumb_path render the full image (existing behavior).
--   • Rows without lqip render a plain background (existing behavior).
-- Existing item_images rows pre-dating this migration simply keep
-- using the master image with no placeholder — no backfill required.
-- New uploads populate both columns going forward.
-- ============================================================================

alter table public.item_images
  add column if not exists thumb_path text;

alter table public.item_images
  add column if not exists lqip text;

-- Hard cap on the LQIP column to keep page payloads sane. A real
-- 16×16 WebP base64 is ~200-500 bytes; 2000 leaves ample headroom
-- for AVIF / PNG / minor toolchain variations without letting a
-- hostile client poison the column with a full-resolution data URL.
alter table public.item_images
  drop constraint if exists item_images_lqip_size_chk;

alter table public.item_images
  add constraint item_images_lqip_size_chk
  check (lqip is null or length(lqip) <= 2000);

comment on column public.item_images.thumb_path is
  'Storage path (relative to the item-images bucket) of a pre-resized '
  '~200px WebP generated at upload time. List-page thumbnails reference '
  'this instead of the 2048px master so Vercel Image Optimization '
  'transforms a small source. NULL for rows uploaded before migration 0122 '
  '— callers fall back to storage_path (the master).';

comment on column public.item_images.lqip is
  'Base64 data URL of a tiny 16x16 WebP blur placeholder embedded in '
  'page HTML so list rows can paint a hint of the photo immediately. '
  'Hard-capped at 2000 chars by item_images_lqip_size_chk. NULL for rows '
  'uploaded before migration 0122 — callers omit the blur placeholder.';
